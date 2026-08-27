const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 }); // Лимит 100MB для передачи изображений

const SECRET_KEY = 'wallchat_secret_key_change_me';
const ADMINS = ['heawyrt', 'w1len']; // Администраторы

// Базы данных в памяти
const users = new Map();   // username -> { username, password, avatar, friends: Set, friendRequests: Set }
const groups = new Map();  // groupId -> { id, name, members: Set, createdBy }
const messagesStore = new Map(); // chatRoomId -> Array of messages

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

function isAdmin(username) {
  return !!username && ADMINS.includes(username.toLowerCase());
}

// Middleware аутентификации
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
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  const cleanName = username.trim();
  if (users.has(cleanName)) return res.status(400).json({ error: 'Пользователь уже существует' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    username: cleanName,
    password: hashedPassword,
    avatar: avatar || null,
    friends: new Set(),
    friendRequests: new Set()
  };
  users.set(cleanName, user);

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

// Получение данных текущего пользователя (друзья, заявки, группы)
app.get('/api/me', authenticateToken, (req, res) => {
  const user = users.get(req.user.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  const friendsList = Array.from(user.friends).map(fName => {
    const fUser = users.get(fName);
    return {
      username: fName,
      avatar: fUser ? fUser.avatar : null,
      isAdmin: isAdmin(fName)
    };
  });

  const requestsList = Array.from(user.friendRequests).map(rName => {
    const rUser = users.get(rName);
    return {
      username: rName,
      avatar: rUser ? rUser.avatar : null,
      isAdmin: isAdmin(rName)
    };
  });

  const userGroups = [];
  for (const [gId, group] of groups.entries()) {
    if (group.members.has(req.user.username)) {
      userGroups.push({
        id: group.id,
        name: group.name,
        members: Array.from(group.members)
      });
    }
  }

  res.json({
    username: user.username,
    avatar: user.avatar,
    isAdmin: isAdmin(user.username),
    friends: friendsList,
    friendRequests: requestsList,
    groups: userGroups
  });
});

// Заявка в друзья
app.post('/api/friends/request', authenticateToken, (req, res) => {
  const { targetUsername } = req.body;
  const senderName = req.user.username;
  const targetName = (targetUsername || '').trim();

  if (senderName === targetName) {
    return res.status(400).json({ error: 'Нельзя добавить самого себя' });
  }

  const targetUser = users.get(targetName);
  if (!targetUser) {
    return res.status(404).json({ error: 'Пользователь не найден' });
  }

  const senderUser = users.get(senderName);
  if (senderUser.friends.has(targetName)) {
    return res.status(400).json({ error: 'Вы уже в друзья' });
  }

  if (targetUser.friendRequests.has(senderName)) {
    return res.status(400).json({ error: 'Заявка уже отправлена' });
  }

  targetUser.friendRequests.add(senderName);
  res.json({ success: true, message: `Заявка отправлена пользователю ${targetName}` });
});

// Принять заявку в друзья
app.post('/api/friends/accept', authenticateToken, (req, res) => {
  const { requesterUsername } = req.body;
  const userName = req.user.username;
  const requesterName = (requesterUsername || '').trim();

  const user = users.get(userName);
  const requester = users.get(requesterName);

  if (!user || !requester) return res.status(404).json({ error: 'Пользователь не найден' });

  if (!user.friendRequests.has(requesterName)) {
    return res.status(400).json({ error: 'Заявка не найдена' });
  }

  user.friendRequests.delete(requesterName);
  user.friends.add(requesterName);
  requester.friends.add(userName);

  res.json({ success: true, message: `Теперь вы друзья с ${requesterName}` });
});

// Отклонить заявку
app.post('/api/friends/reject', authenticateToken, (req, res) => {
  const { requesterUsername } = req.body;
  const user = users.get(req.user.username);
  if (user) user.friendRequests.delete(requesterUsername);
  res.json({ success: true });
});

// Создать группу
app.post('/api/groups/create', authenticateToken, (req, res) => {
  const { groupName, memberUsernames } = req.body;
  const creator = req.user.username;

  if (!groupName || !groupName.trim()) {
    return res.status(400).json({ error: 'Укажите название группы' });
  }

  const creatorUser = users.get(creator);
  const validMembers = new Set([creator]);

  // Можно добавлять только друзей
  if (Array.isArray(memberUsernames)) {
    for (const m of memberUsernames) {
      if (creatorUser.friends.has(m)) validMembers.add(m);
    }
  }

  const groupId = 'group_' + Date.now();
  const group = { id: groupId, name: groupName.trim(), members: validMembers, createdBy: creator };
  groups.set(groupId, group);

  res.json({
    success: true,
    group: { id: group.id, name: group.name, members: Array.from(group.members) }
  });
});

// Настройки (смена аватара/пароля)
app.post('/api/settings', authenticateToken, async (req, res) => {
  const { avatar, newPassword } = req.body;
  const user = users.get(req.user.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (avatar !== undefined) user.avatar = avatar;
  if (newPassword) user.password = await bcrypt.hash(newPassword, 10);

  res.json({ success: true, avatar: user.avatar });
});

// Socket.io (Подключение к чатам и пересылка сообщений)
io.on('connection', (socket) => {
  socket.on('join_room', ({ token, chatType, targetId }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;
      const user = users.get(username);
      if (!user) return;

      let room = null;
      if (chatType === 'dm') {
        // Доступ только если в друзьях
        if (user.friends.has(targetId)) {
          room = [username, targetId].sort().join('_');
        }
      } else if (chatType === 'group') {
        const group = groups.get(targetId);
        if (group && group.members.has(username)) {
          room = targetId;
        }
      }

      if (room) {
        if (socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(room);
        socket.currentRoom = room;

        // Отправить историю
        const history = messagesStore.get(room) || [];
        socket.emit('chat_history', history);
      }
    } catch (e) {
      console.error('Socket error:', e);
    }
  });

  socket.on('send_message', ({ token, chatType, targetId, text, image }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const senderName = decoded.username;
      const senderUser = users.get(senderName);
      if (!senderUser) return;

      let room = null;
      if (chatType === 'dm') {
        if (!senderUser.friends.has(targetId)) {
          return socket.emit('error_msg', { error: 'Пользователя нет в друзьях. Писать нельзя.' });
        }
        room = [senderName, targetId].sort().join('_');
      } else if (chatType === 'group') {
        const group = groups.get(targetId);
        if (!group || !group.members.has(senderName)) {
          return socket.emit('error_msg', { error: 'Вы не состоите в группе.' });
        }
        room = targetId;
      }

      if (room) {
        const msgData = {
          id: Date.now(),
          sender: senderName,
          avatar: senderUser.avatar,
          isAdmin: isAdmin(senderName),
          text: text || '',
          image: image || null,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        if (!messagesStore.has(room)) messagesStore.set(room, []);
        messagesStore.get(room).push(msgData);

        io.to(room).emit('new_message', msgData);
      }
    } catch (e) {
      console.error('Send error:', e);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wallchat запущен на порту ${PORT}`));
