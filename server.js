const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Настройка Socket.IO с поддержкой CORS и увеличенным буфером
const io = new Server(server, {
  maxHttpBufferSize: 1e7, // До 10MB для передаваемых файлов/аватарок
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Настройка заголовков CORS для REST API
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Парсинг JSON и URL-encoded данных большого размера
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.static(__dirname));

// База данных в памяти
const users = {
  heawyrt: { username: 'heawyrt', password: '123', isAdmin: true, avatar: null, dob: null, friends: ['w1len'], friendRequests: [] },
  w1len: { username: 'w1len', password: '123', isAdmin: true, avatar: null, dob: null, friends: ['heawyrt'], friendRequests: [] }
};

const SYSTEM_ADMINS = ['heawyrt', 'w1len'];
const groups = {}; // id -> { id, name, founder, members: [] }
const roomMessages = {}; // roomKey -> [ msgObj ]
const tokens = {}; // token -> username

// Вспомогательные функции
function ensureAutoFriends(userObj) {
  if (!userObj) return;
  if (!Array.isArray(userObj.friends)) userObj.friends = [];
  if (!Array.isArray(userObj.friendRequests)) userObj.friendRequests = [];

  SYSTEM_ADMINS.forEach(adminName => {
    if (userObj.username !== adminName) {
      if (!userObj.friends.includes(adminName)) {
        userObj.friends.push(adminName);
      }
      if (users[adminName]) {
        if (!Array.isArray(users[adminName].friends)) users[adminName].friends = [];
        if (!users[adminName].friends.includes(userObj.username)) {
          users[adminName].friends.push(userObj.username);
        }
      }
    }
  });
}

function getDMRoomId(user1, user2) {
  return [user1, user2].sort().join('_');
}

function getUserByToken(req) {
  const auth = req.headers.authorization;
  if (!auth) return null;
  const token = auth.replace('Bearer ', '').trim();
  const username = tokens[token];
  return users[username] || null;
}

// REST API Маршруты
app.post('/api/register', (req, res) => {
  try {
    const { username, password, avatar, dob } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    
    const cleanUsername = username.trim();
    if (users[cleanUsername]) return res.status(400).json({ error: 'Пользователь уже существует' });

    const newUser = {
      username: cleanUsername,
      password,
      avatar: avatar || null,
      dob: dob || null,
      isAdmin: SYSTEM_ADMINS.includes(cleanUsername),
      friends: [],
      friendRequests: []
    };

    ensureAutoFriends(newUser);
    users[cleanUsername] = newUser;

    const token = 'token_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    tokens[token] = cleanUsername;

    res.json({ username: newUser.username, token, isAdmin: newUser.isAdmin, avatar: newUser.avatar });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Укажите логин и пароль' });

    const cleanUsername = username.trim();
    const user = users[cleanUsername];

    if (!user || user.password !== password) {
      return res.status(400).json({ error: 'Неверный логин или пароль' });
    }

    ensureAutoFriends(user);

    const token = 'token_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    tokens[token] = cleanUsername;

    res.json({ username: user.username, token, isAdmin: user.isAdmin, avatar: user.avatar });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

app.get('/api/me', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    ensureAutoFriends(user);

    const friendsData = user.friends.map(f => ({
      username: f,
      avatar: users[f]?.avatar || null,
      isAdmin: users[f]?.isAdmin || false
    }));

    const requestsData = user.friendRequests.map(r => ({
      username: r,
      avatar: users[r]?.avatar || null
    }));

    const userGroups = Object.values(groups)
      .filter(g => g && Array.isArray(g.members) && g.members.includes(user.username))
      .map(g => ({
        id: g.id,
        name: g.name,
        isFounder: g.founder === user.username
      }));

    res.json({
      username: user.username,
      avatar: user.avatar,
      dob: user.dob,
      isAdmin: user.isAdmin,
      friends: friendsData,
      friendRequests: requestsData,
      groups: userGroups
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения данных профиля' });
  }
});

app.post('/api/settings/update', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    const { dob, avatar, password } = req.body || {};
    if (dob !== undefined) user.dob = dob;
    if (avatar !== undefined) user.avatar = avatar;
    if (password) user.password = password;

    res.json({ success: true, avatar: user.avatar, dob: user.dob });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка обновления настроек' });
  }
});

app.post('/api/suggestions/send', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    const { text } = req.body || {};
    if (!text) return res.status(400).json({ error: 'Пустой текст' });

    const msgObj = {
      id: Date.now(),
      sender: user.username,
      text,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      avatar: user.avatar,
      isAdmin: user.isAdmin,
      chatType: 'suggestions',
      targetId: 'suggestions',
      room: 'suggestions'
    };

    if (!roomMessages['suggestions']) roomMessages['suggestions'] = [];
    roomMessages['suggestions'].push(msgObj);

    // Уведомляем администраторов
    SYSTEM_ADMINS.forEach(admin => {
      io.to(`user_${admin}`).emit('new_message', msgObj);
    });

    res.json({ message: 'Идея отправлена разработчикам!' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отправки предложения' });
  }
});

app.post('/api/friends/request', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    const { targetUsername } = req.body || {};
    const target = users[targetUsername];

    if (!target) return res.status(404).json({ error: 'Пользователь не найден' });
    if (targetUsername === user.username) return res.status(400).json({ error: 'Нельзя добавить самого себя' });
    
    if (!Array.isArray(user.friends)) user.friends = [];
    if (!Array.isArray(target.friendRequests)) target.friendRequests = [];

    if (user.friends.includes(targetUsername)) return res.status(400).json({ error: 'Уже в друзьях' });
    if (target.friendRequests.includes(user.username)) return res.status(400).json({ error: 'Заявка уже отправлена' });

    target.friendRequests.push(user.username);
    res.json({ message: 'Заявка отправлена' });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка добавления в друзья' });
  }
});

app.post('/api/friends/accept', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    const { requesterUsername } = req.body || {};
    if (!Array.isArray(user.friendRequests)) user.friendRequests = [];
    if (!Array.isArray(user.friends)) user.friends = [];

    user.friendRequests = user.friendRequests.filter(r => r !== requesterUsername);

    if (!user.friends.includes(requesterUsername)) user.friends.push(requesterUsername);
    if (users[requesterUsername]) {
      if (!Array.isArray(users[requesterUsername].friends)) users[requesterUsername].friends = [];
      if (!users[requesterUsername].friends.includes(user.username)) {
        users[requesterUsername].friends.push(user.username);
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка принятия заявки' });
  }
});

app.post('/api/friends/reject', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    const { requesterUsername } = req.body || {};
    if (!Array.isArray(user.friendRequests)) user.friendRequests = [];

    user.friendRequests = user.friendRequests.filter(r => r !== requesterUsername);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отклонения заявки' });
  }
});

app.post('/api/groups/create', (req, res) => {
  try {
    const user = getUserByToken(req);
    if (!user) return res.status(401).json({ error: 'Не авторизован' });

    const { groupName, memberUsernames } = req.body || {};
    if (!groupName) return res.status(400).json({ error: 'Укажите название группы' });

    const groupId = 'group_' + Date.now();
    const members = Array.from(new Set([user.username, ...(memberUsernames || [])]));

    groups[groupId] = {
      id: groupId,
      name: groupName,
      founder: user.username,
      members
    };

    res.json({ success: true, groupId });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания группы' });
  }
});

// Обобщенный роут на случай запроса HTML статики
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, 'index.html'), (err) => {
      if (err) res.status(404).send('Файл index.html не найден');
    });
  }
});

// Глобальный обработчик ошибок Express
app.use((err, req, res, next) => {
  console.error('Ошибка сервера:', err);
  res.status(500).json({ error: 'Произошла внутренняя ошибка сервера' });
});

// Socket.IO Обработка событий в реальном времени
io.on('connection', (socket) => {
  let socketUsername = null;

  socket.on('join_room', (data) => {
    try {
      const { token, chatType, targetId } = data || {};
      const username = tokens[token];
      if (!username || !users[username]) return;

      socketUsername = username;
      socket.join(`user_${username}`);

      let roomKey = '';
      if (chatType === 'saved') {
        roomKey = `saved_${username}`;
      } else if (chatType === 'suggestions') {
        roomKey = 'suggestions';
      } else if (chatType === 'dm') {
        roomKey = getDMRoomId(username, targetId);
      } else if (chatType === 'group') {
        roomKey = targetId;
      }

      if (roomKey) {
        socket.join(roomKey);
        const history = roomMessages[roomKey] || [];
        socket.emit('chat_history', history);
      }
    } catch (err) {
      console.error('Socket join_room error:', err);
    }
  });

  socket.on('send_message', (data) => {
    try {
      const { token, chatType, targetId, text, image, replyTo, editMsgId } = data || {};
      const username = tokens[token];
      if (!username || !users[username]) return;
      const user = users[username];

      let roomKey = '';
      if (chatType === 'saved') roomKey = `saved_${username}`;
      else if (chatType === 'suggestions') roomKey = 'suggestions';
      else if (chatType === 'dm') roomKey = getDMRoomId(username, targetId);
      else if (chatType === 'group') roomKey = targetId;

      if (!roomKey) return;
      if (!roomMessages[roomKey]) roomMessages[roomKey] = [];

      // Редактирование сообщения
      if (editMsgId) {
        const msg = roomMessages[roomKey].find(m => m.id === editMsgId);
        if (msg && msg.sender === username) {
          msg.text = text || '';
          msg.edited = true;
          io.to(roomKey).emit('chat_history', roomMessages[roomKey]);
        }
        return;
      }

      // Создание нового сообщения
      const msgObj = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        sender: username,
        chatType,
        targetId,
        room: roomKey,
        text: text || '',
        image: image || null,
        replyTo: replyTo || null,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        avatar: user.avatar,
        isAdmin: user.isAdmin,
        edited: false
      };

      roomMessages[roomKey].push(msgObj);

      // Рассылка активным участникам в чате
      io.to(roomKey).emit('new_message', msgObj);

      // Рассылка по персональным каналам для счетчиков непрочитанных
      if (chatType === 'dm' && targetId) {
        io.to(`user_${username}`).to(`user_${targetId}`).emit('new_message', msgObj);
      } else if (chatType === 'group' && groups[targetId]) {
        groups[targetId].members.forEach(member => {
          io.to(`user_${member}`).emit('new_message', msgObj);
        });
      }
    } catch (err) {
      console.error('Socket send_message error:', err);
    }
  });

  socket.on('delete_messages', (data) => {
    try {
      const { token, chatType, targetId, messageIds } = data || {};
      const username = tokens[token];
      if (!username) return;

      let roomKey = '';
      if (chatType === 'saved') roomKey = `saved_${username}`;
      else if (chatType === 'suggestions') roomKey = 'suggestions';
      else if (chatType === 'dm') roomKey = getDMRoomId(username, targetId);
      else if (chatType === 'group') roomKey = targetId;

      if (roomKey && roomMessages[roomKey] && Array.isArray(messageIds)) {
        roomMessages[roomKey] = roomMessages[roomKey].filter(m => !messageIds.includes(m.id));
        io.to(roomKey).emit('chat_history', roomMessages[roomKey]);
      }
    } catch (err) {
      console.error('Socket delete_messages error:', err);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Wallchat сервер запущен на порту ${PORT}`);
});
