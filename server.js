const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // Лимит 100MB

const SECRET_KEY = 'wallchat_global_secret';
const ADMINS = ['heawyrt', 'w1len'];

// Базы данных в памяти
const users = new Map();   // username -> { ..., birthday, friends, requests }
const groups = new Map();  // groupId -> { id, name, members: Set, founder: string }
const messagesStore = new Map(); // chatRoomId -> Messages[]

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

function isAdmin(username) {
  return !!username && ADMINS.includes(username.toLowerCase());
}

// Middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Токен отсутствует' });

  jwt.verify(token, SECRET_KEY, (err, user) => {
    if (err) return res.status(403).json({ error: 'Недействительный токен' });
    req.user = user;
    next();
  });
}

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password, avatar, birthday } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  const cleanName = username.trim();
  if (users.has(cleanName)) return res.status(400).json({ error: 'Пользователь уже существует' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    username: cleanName,
    password: hashedPassword,
    avatar: avatar || null,
    birthday: birthday || null, // Новое: Дата рождения
    friends: new Set(),
    friendRequests: new Set()
  };
  users.set(cleanName, user);

  // Инициализация Избранного (Self-DM roomID: wallchat_saved_username)
  const savedMessagesRoomId = `wallchat_saved_${cleanName}`;
  if (!messagesStore.has(savedMessagesRoomId)) {
    messagesStore.set(savedMessagesRoomId, [{
      id: 0, sender: 'Wallchat Бот', avatar: null, isAdmin: false, time: '',
      text: 'Добро пожаловать в мессенджер Wallchat! Это ваш личный чат "Избранное". Сюда нельзя никого добавить.', image: null
    }]);
  }

  const token = jwt.sign({ username: cleanName }, SECRET_KEY);
  res.json({ token, username: cleanName, avatar: user.avatar, isAdmin: isAdmin(cleanName) });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const cleanName = (username || '').trim();
  const user = users.get(cleanName);

  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Неверное имя или пароль' });
  }

  const token = jwt.sign({ username: cleanName }, SECRET_KEY);
  res.json({ token, username: cleanName, avatar: user.avatar, isAdmin: isAdmin(cleanName) });
});

// Настройки (обновление аватара, пароля, даты рождения)
app.post('/api/settings', authenticateToken, async (req, res) => {
  const { avatar, newPassword, birthday } = req.body;
  const user = users.get(req.user.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (avatar !== undefined) user.avatar = avatar;
  if (birthday !== undefined) user.birthday = birthday; // Обновление даты
  if (newPassword) user.password = await bcrypt.hash(newPassword, 10);

  res.json({ success: true, avatar: user.avatar, birthday: user.birthday });
});

// Группы: Получение полной информации
app.get('/api/groups/:groupId', authenticateToken, (req, res) => {
  const group = groups.get(req.params.groupId);
  if (!group || !group.members.has(req.user.username)) {
    return res.status(404).json({ error: 'Группа не найдена' });
  }

  const membersInfo = Array.from(group.members).map(mName => {
    const mUser = users.get(mName);
    return {
      username: mName,
      avatar: mUser ? mUser.avatar : null,
      isAdmin: isAdmin(mName),
      status: group.founder === mName ? 'founder' : 'member' // Новое: Статус
    };
  });

  res.json({
    id: group.id,
    name: group.name,
    founder: group.founder,
    members: membersInfo,
    isFounder: group.founder === req.user.username // Флаг для UI
  });
});

// Группы: Создать
app.post('/api/groups/create', authenticateToken, (req, res) => {
  const { groupName, memberUsernames } = req.body;
  const creator = req.user.username;

  if (!groupName || !groupName.trim()) return res.status(400).json({ error: 'Укажите название' });

  const creatorUser = users.get(creator);
  const validMembers = new Set([creator]);

  if (Array.isArray(memberUsernames)) {
    for (const m of memberUsernames) {
      if (creatorUser.friends.has(m)) validMembers.add(m);
    }
  }

  const groupId = 'group_' + Date.now();
  const group = {
    id: groupId, name: groupName.trim(), members: validMembers,
    founder: creator // Основатель
  };
  groups.set(groupId, group);

  res.json({ success: true, group: { id: group.id, name: group.name, members: Array.from(group.members) } });
});

// Настройки Группы (Founder only)
app.post('/api/groups/settings', authenticateToken, (req, res) => {
  const { groupId, name, removeMembers, addMembers } = req.body;
  const group = groups.get(groupId);

  if (!group || group.founder !== req.user.username) {
    return res.status(403).json({ error: 'Нет прав управления' });
  }

  if (name && name.trim()) group.name = name.trim();

  // Удаление участников
  if (Array.isArray(removeMembers)) {
    removeMembers.forEach(m => {
      if (m !== group.founder) group.members.delete(m); // Founder не может удалить себя так
    });
  }

  // Новое: Добавление участников (только друзей Founder)
  const creatorUser = users.get(req.user.username);
  if (Array.isArray(addMembers)) {
    addMembers.forEach(m => {
      if (creatorUser.friends.has(m)) group.members.add(m);
    });
  }

  res.json({ success: true, message: 'Настройки группы обновлены' });
});

// Покинуть группу
app.post('/api/groups/leave', authenticateToken, (req, res) => {
  const { groupId } = req.body;
  const group = groups.get(groupId);

  if (!group || !group.members.has(req.user.username)) {
    return res.status(404).json({ error: 'Группа не найдена' });
  }

  if (group.founder === req.user.username) {
    return res.status(400).json({ error: 'Founder не может покинуть группу. Только удалить.' });
  }

  group.members.delete(req.user.username);
  res.json({ success: true });
});

// Удалить группу (Founder only)
app.post('/api/groups/delete', authenticateToken, (req, res) => {
  const { groupId } = req.body;
  const group = groups.get(groupId);

  if (!group || group.founder !== req.user.username) {
    return res.status(403).json({ error: 'Нет прав удаления' });
  }

  groups.delete(groupId);
  messagesStore.delete(groupId);
  res.json({ success: true });
});

// ... (Остальной API code из прошлых версий: me, friends, socket.io) ...
// Socket join_room logic must handle `wallchat_saved_${cleanName}` room specifically.

// Socket.io (Пересылка сообщений)
io.on('connection', (socket) => {
  socket.on('join_room', ({ token, chatType, targetId }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;
      const user = users.get(username);
      if (!user) return;

      let room = null;
      if (chatType === 'saved') {
        room = `wallchat_saved_${username}`; // Только моя комната Избранного
      } else if (chatType === 'dm') {
        if (user.friends.has(targetId)) room = [username, targetId].sort().join('_');
      } else if (chatType === 'group') {
        const group = groups.get(targetId);
        if (group && group.members.has(username)) room = targetId;
      }

      if (room) {
        if (socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(room);
        socket.currentRoom = room;
        socket.emit('chat_history', messagesStore.get(room) || []);
      }
    } catch (e) {}
  });

  socket.on('send_message', ({ token, chatType, targetId, text, image }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const senderName = decoded.username;
      const senderUser = users.get(senderName);
      if (!senderUser) return;

      let room = null;
      if (chatType === 'saved') {
        room = `wallchat_saved_${senderName}`;
      } else if (chatType === 'dm') {
        if (!senderUser.friends.has(targetId)) return;
        room = [senderName, targetId].sort().join('_');
      } else if (chatType === 'group') {
        const group = groups.get(targetId);
        if (!group || !group.members.has(senderName)) return;
        room = targetId;
      }

      if (room) {
        const msgData = {
          id: Date.now(), sender: senderName, avatar: senderUser.avatar, isAdmin: isAdmin(senderName),
          text: text || '', image: image || null,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        if (!messagesStore.has(room)) messagesStore.set(room, []);
        messagesStore.get(room).push(msgData);
        io.to(room).emit('new_message', msgData);
      }
    } catch (e) {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wallchat запущен на порту ${PORT}`));
