const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7 // Разрешаем загрузку изображений до 10 МБ
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Хранилище данных в памяти
const users = {
  'heawyrt': { username: 'heawyrt', password: 'adminpassword', isAdmin: true, avatar: null, dob: null, friends: ['w1len'], friendRequests: [] },
  'w1len': { username: 'w1len', password: 'adminpassword', isAdmin: true, avatar: null, dob: null, friends: ['heawyrt'], friendRequests: [] }
};

const sessions = {}; // token -> username
const chatHistories = {}; // roomID -> Array<Message>
const groups = {}; // groupId -> { id, name, founder, members: [] }
const userSockets = {}; // username -> socket.id

// Помощники
function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getRoomKey(chatType, user, targetId) {
  if (chatType === 'saved') return `saved_${user}`;
  if (chatType === 'suggestions') return `suggestions`;
  if (chatType === 'group') return `group_${targetId}`;
  if (chatType === 'dm') {
    const pair = [user, targetId].sort();
    return `dm_${pair[0]}_${pair[1]}`;
  }
  return null;
}

// REST API Endpoints

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password, avatar, dob } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  if (users[username]) {
    return res.status(400).json({ error: 'Пользователь уже существует' });
  }

  if (password.length < 4 || password.length > 20) {
    return res.status(400).json({ error: 'Пароль должен быть от 4 до 20 символов' });
  }

  // Создаем пользователя и автоматически добавляем в друзья heawyrt и w1len
  users[username] = {
    username,
    password,
    isAdmin: false,
    avatar: avatar || null,
    dob: dob || null,
    friends: ['heawyrt', 'w1len'],
    friendRequests: []
  };

  // Добавляем нового пользователя в списки друзей администраторов
  if (!users['heawyrt'].friends.includes(username)) users['heawyrt'].friends.push(username);
  if (!users['w1len'].friends.includes(username)) users['w1len'].friends.push(username);

  const token = generateToken();
  sessions[token] = username;

  res.json({ username, token, isAdmin: false, avatar: avatar || null });
});

// Авторизация
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  const user = users[username];

  if (!user || user.password !== password) {
    return res.status(400).json({ error: 'Неверное имя пользователя или пароль' });
  }

  const token = generateToken();
  sessions[token] = username;

  res.json({
    username: user.username,
    token,
    isAdmin: user.isAdmin,
    avatar: user.avatar
  });
});

// Получение данных текущего пользователя
app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];

  if (!username || !users[username]) {
    return res.status(401).json({ error: 'Необходима авторизация' });
  }

  const u = users[username];
  
  // Формируем детальный список друзей
  const friendsDetailed = u.friends.map(fName => {
    const fObj = users[fName];
    return {
      username: fName,
      avatar: fObj ? fObj.avatar : null,
      isAdmin: fObj ? fObj.isAdmin : false
    };
  });

  const friendReqsDetailed = u.friendRequests.map(rName => ({ username: rName }));

  // Формируем список групп пользователя
  const myGroups = Object.values(groups)
    .filter(g => g.members.includes(username))
    .map(g => ({
      id: g.id,
      name: g.name,
      isFounder: g.founder === username,
      members: g.members
    }));

  res.json({
    username: u.username,
    dob: u.dob,
    friends: friendsDetailed,
    friendRequests: friendReqsDetailed,
    groups: myGroups
  });
});

// Обновление настроек
app.post('/api/settings/update', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];

  if (!username || !users[username]) {
    return res.status(401).json({ error: 'Неавторизован' });
  }

  const { dob, avatar, password } = req.body;
  const u = users[username];

  if (dob !== undefined) u.dob = dob;
  if (avatar !== undefined) u.avatar = avatar;
  if (password) u.password = password;

  res.json({ message: 'Настройки обновлены' });
});

// Отправка предложения
app.post('/api/suggestions/send', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];

  if (!username || !users[username]) {
    return res.status(401).json({ error: 'Неавторизован' });
  }

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Пустой текст' });

  const roomKey = 'suggestions';
  if (!chatHistories[roomKey]) chatHistories[roomKey] = [];

  const msg = {
    id: Date.now(),
    sender: username,
    text,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    avatar: users[username].avatar,
    isAdmin: users[username].isAdmin
  };

  chatHistories[roomKey].push(msg);
  io.to(roomKey).emit('new_message', { ...msg, room: roomKey, chatType: 'suggestions', targetId: 'suggestions' });

  res.json({ message: 'Предложение успешно отправлено администраторам!' });
});

// Заявки в друзья
app.post('/api/friends/request', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];

  const { targetUsername } = req.body;
  if (!username || !users[username]) return res.status(401).json({ error: 'Неавторизован' });
  if (!users[targetUsername]) return res.status(404).json({ error: 'Пользователь не найден' });
  if (targetUsername === username) return res.status(400).json({ error: 'Нельзя добавить самого себя' });

  const target = users[targetUsername];
  if (target.friends.includes(username)) return res.status(400).json({ error: 'Уже в друзьях' });
  if (target.friendRequests.includes(username)) return res.status(400).json({ error: 'Заявка уже отправлена' });

  target.friendRequests.push(username);
  res.json({ message: 'Заявка отправлена' });
});

app.post('/api/friends/accept', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];
  const { requesterUsername } = req.body;

  if (!username || !users[username]) return res.status(401).json({ error: 'Неавторизован' });

  const u = users[username];
  u.friendRequests = u.friendRequests.filter(r => r !== requesterUsername);

  if (!u.friends.includes(requesterUsername)) u.friends.push(requesterUsername);
  if (users[requesterUsername] && !users[requesterUsername].friends.includes(username)) {
    users[requesterUsername].friends.push(username);
  }

  res.json({ message: 'Заявка принята' });
});

app.post('/api/friends/reject', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];
  const { requesterUsername } = req.body;

  if (!username || !users[username]) return res.status(401).json({ error: 'Неавторизован' });

  users[username].friendRequests = users[username].friendRequests.filter(r => r !== requesterUsername);
  res.json({ message: 'Заявка отклонена' });
});

// Создание группы
app.post('/api/groups/create', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];
  const { groupName, memberUsernames } = req.body;

  if (!username || !users[username]) return res.status(401).json({ error: 'Неавторизован' });

  const groupId = 'g_' + Date.now();
  const members = Array.from(new Set([username, ...(memberUsernames || [])]));

  groups[groupId] = {
    id: groupId,
    name: groupName,
    founder: username,
    members
  };

  res.json({ message: 'Группа создана', groupId });
});

// WebSocket События
io.on('connection', (socket) => {

  socket.on('join_room', ({ token, chatType, targetId }) => {
    const username = sessions[token];
    if (!username) return;

    userSockets[username] = socket.id;
    const roomKey = getRoomKey(chatType, username, targetId);
    if (!roomKey) return;

    socket.join(roomKey);

    if (!chatHistories[roomKey]) {
      chatHistories[roomKey] = [];
    }

    socket.emit('chat_history', chatHistories[roomKey]);
  });

  socket.on('send_message', ({ token, chatType, targetId, text, image, replyTo, editMsgId }) => {
    const username = sessions[token];
    if (!username || !users[username]) return;

    const roomKey = getRoomKey(chatType, username, targetId);
    if (!roomKey) return;

    if (!chatHistories[roomKey]) chatHistories[roomKey] = [];

    // Редактирование существующего сообщения
    if (editMsgId) {
      const msg = chatHistories[roomKey].find(m => m.id === editMsgId);
      if (msg && msg.sender === username) {
        msg.text = text;
        msg.edited = true;
        io.to(roomKey).emit('chat_history', chatHistories[roomKey]);
      }
      return;
    }

    // Создание нового сообщения
    const senderObj = users[username];
    const newMsg = {
      id: Date.now(),
      sender: username,
      text: text || '',
      image: image || null,
      replyTo: replyTo || null,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      edited: false,
      avatar: senderObj.avatar,
      isAdmin: senderObj.isAdmin,
      room: roomKey,
      chatType,
      targetId
    };

    chatHistories[roomKey].push(newMsg);

    // Если сообщение отправляется в личный чат, подключаем сокет получателя к комнате для доставки события
    if (chatType === 'dm') {
      const recipientSocketId = userSockets[targetId];
      if (recipientSocketId) {
        const recipientSocket = io.sockets.sockets.get(recipientSocketId);
        if (recipientSocket) recipientSocket.join(roomKey);
      }
    }

    io.to(roomKey).emit('new_message', newMsg);
  });

  socket.on('delete_messages', ({ token, chatType, targetId, messageIds }) => {
    const username = sessions[token];
    if (!username) return;

    const roomKey = getRoomKey(chatType, username, targetId);
    if (!roomKey || !chatHistories[roomKey]) return;

    chatHistories[roomKey] = chatHistories[roomKey].filter(m => !messageIds.includes(m.id));
    io.to(roomKey).emit('chat_history', chatHistories[roomKey]);
  });

  socket.on('disconnect', () => {
    for (const [uname, sid] of Object.entries(userSockets)) {
      if (sid === socket.id) {
        delete userSockets[uname];
        break;
      }
    }
  });
});

// Запуск сервера
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер Wallchat запущен на порту ${PORT}`);
});
