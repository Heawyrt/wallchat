const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 1e7
});

const DB_FILE = path.join(__dirname, 'database.json');

// Загрузка или инициализация базы данных
function loadData() {
  const defaultData = {
    users: {
      'heawyrt': { username: 'heawyrt', password: 'adminpassword', isAdmin: true, avatar: null, dob: null, friends: ['w1len'], friendRequests: [] },
      'w1len': { username: 'w1len', password: 'adminpassword', isAdmin: true, avatar: null, dob: null, friends: ['heawyrt'], friendRequests: [] }
    },
    groups: {},
    chatHistories: {}
  };

  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(defaultData, null, 2));
    return defaultData;
  }

  try {
    const raw = fs.readFileSync(DB_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Ошибка чтения database.json, создаем заново:', err);
    return defaultData;
  }
}

function saveData() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify({ users, groups, chatHistories }, null, 2));
  } catch (err) {
    console.error('Ошибка сохранения данных:', err);
  }
}

const db = loadData();
const users = db.users;
const groups = db.groups;
const chatHistories = db.chatHistories;
const sessions = {}; // Токены сессий хранятся в памяти во время работы
const userSockets = {};

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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

// REST API

// Регистрация
app.post('/api/register', (req, res) => {
  const { username, password, avatar, dob } = req.body;
  
  if (!username || !password) {
    return res.status(400).json({ error: 'Заполните все поля' });
  }

  const cleanUsername = username.trim();
  const lowerKey = cleanUsername.toLowerCase();

  // Проверка существующего пользователя без учета регистра
  const existingUserKey = Object.keys(users).find(u => u.toLowerCase() === lowerKey);
  if (existingUserKey) {
    return res.status(400).json({ error: 'Пользователь с таким именем уже существует' });
  }

  if (password.length < 4 || password.length > 20) {
    return res.status(400).json({ error: 'Пароль должен быть от 4 до 20 символов' });
  }

  users[cleanUsername] = {
    username: cleanUsername,
    password,
    isAdmin: false,
    avatar: avatar || null,
    dob: dob || null,
    friends: ['heawyrt', 'w1len'],
    friendRequests: []
  };

  if (users['heawyrt'] && !users['heawyrt'].friends.includes(cleanUsername)) {
    users['heawyrt'].friends.push(cleanUsername);
  }
  if (users['w1len'] && !users['w1len'].friends.includes(cleanUsername)) {
    users['w1len'].friends.push(cleanUsername);
  }

  saveData();

  const token = generateToken();
  sessions[token] = cleanUsername;

  res.json({ username: cleanUsername, token, isAdmin: false, avatar: avatar || null });
});

// Авторизация
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'Введите имя пользователя и пароль' });
  }

  const cleanUsername = username.trim();
  // Поиск пользователя без учета регистра имени
  const userKey = Object.keys(users).find(u => u.toLowerCase() === cleanUsername.toLowerCase());
  const user = users[userKey];

  if (!user || user.password !== password) {
    return res.status(400).json({ error: 'Неверное имя пользователя или пароль' });
  }

  const token = generateToken();
  sessions[token] = user.username;

  res.json({
    username: user.username,
    token,
    isAdmin: user.isAdmin,
    avatar: user.avatar
  });
});

// Данные пользователя
app.get('/api/me', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];

  if (!username || !users[username]) {
    return res.status(401).json({ error: 'Необходима повторная авторизация' });
  }

  const u = users[username];

  const friendsDetailed = u.friends.map(fName => {
    const fObj = users[fName];
    return {
      username: fName,
      avatar: fObj ? fObj.avatar : null,
      isAdmin: fObj ? fObj.isAdmin : false
    };
  });

  const friendReqsDetailed = (u.friendRequests || []).map(rName => ({ username: rName }));

  const myGroups = Object.values(groups)
    .filter(g => g.members && g.members.includes(username))
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

// Обновление профиля
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

  saveData();
  res.json({ message: 'Настройки обновлены' });
});

// Предложения администраторам
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
  saveData();

  io.to(roomKey).emit('new_message', { ...msg, room: roomKey, chatType: 'suggestions', targetId: 'suggestions' });
  res.json({ message: 'Предложение отправлено!' });
});

// Друзья
app.post('/api/friends/request', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];
  const { targetUsername } = req.body;

  if (!username || !users[username]) return res.status(401).json({ error: 'Неавторизован' });
  if (!users[targetUsername]) return res.status(404).json({ error: 'Пользователь не найден' });

  const target = users[targetUsername];
  if (target.friends.includes(username)) return res.status(400).json({ error: 'Уже в друзьях' });
  if (target.friendRequests.includes(username)) return res.status(400).json({ error: 'Заявка уже отправлена' });

  target.friendRequests.push(username);
  saveData();
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

  saveData();
  res.json({ message: 'Заявка принята' });
});

app.post('/api/friends/reject', (req, res) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  const username = sessions[token];
  const { requesterUsername } = req.body;

  if (!username || !users[username]) return res.status(401).json({ error: 'Неавторизован' });

  users[username].friendRequests = users[username].friendRequests.filter(r => r !== requesterUsername);
  saveData();
  res.json({ message: 'Заявка отклонена' });
});

// Группы
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

  saveData();
  res.json({ message: 'Группа создана', groupId });
});

// Socket.IO
io.on('connection', (socket) => {
  socket.on('join_room', ({ token, chatType, targetId }) => {
    const username = sessions[token];
    if (!username) return;

    userSockets[username] = socket.id;
    const roomKey = getRoomKey(chatType, username, targetId);
    if (!roomKey) return;

    socket.join(roomKey);
    if (!chatHistories[roomKey]) chatHistories[roomKey] = [];

    socket.emit('chat_history', chatHistories[roomKey]);
  });

  socket.on('send_message', ({ token, chatType, targetId, text, image, replyTo, editMsgId }) => {
    const username = sessions[token];
    if (!username || !users[username]) return;

    const roomKey = getRoomKey(chatType, username, targetId);
    if (!roomKey) return;

    if (!chatHistories[roomKey]) chatHistories[roomKey] = [];

    if (editMsgId) {
      const msg = chatHistories[roomKey].find(m => m.id === editMsgId);
      if (msg && msg.sender === username) {
        msg.text = text;
        msg.edited = true;
        saveData();
        io.to(roomKey).emit('chat_history', chatHistories[roomKey]);
      }
      return;
    }

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
    saveData();

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
    saveData();
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Сервер запущен на порту ${PORT}`);
});
