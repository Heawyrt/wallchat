const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const SECRET_KEY = process.env.SECRET_KEY || 'wallchat_secret_key_change_me';
const MONGO_URI = process.env.MONGO_URI;
const ADMINS = ['heawyrt', 'w1len'];
const PASSWORD_REGEX = /^[a-zA-Zа-яА-ЯёЁ1-9]+$/;

// Подключение к MongoDB
if (MONGO_URI) {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('Подключение к MongoDB успешно'))
    .catch(err => console.error('Ошибка подключения к MongoDB:', err));
} else {
  console.error('Ошибка: Переменная MONGO_URI не задана!');
}

// Mongoose схемы
const userSchema = new mongoose.Schema({
  username: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  avatar: { type: String, default: null },
  dob: { type: String, default: null },
  friends: [{ type: String }],
  friendRequests: [{ type: String }]
});

const groupSchema = new mongoose.Schema({
  id: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  createdBy: { type: String, required: true },
  members: [{ type: String }]
});

const messageSchema = new mongoose.Schema({
  id: { type: Number, required: true },
  room: { type: String, required: true },
  sender: { type: String, required: true },
  avatar: { type: String, default: null },
  isAdmin: { type: Boolean, default: false },
  text: { type: String, default: '' },
  image: { type: String, default: null },
  time: { type: String, required: true },
  replyTo: { type: Object, default: null },
  reactions: { type: Map, of: [String], default: {} },
  edited: { type: Boolean, default: false }
});

const User = mongoose.model('User', userSchema);
const Group = mongoose.model('Group', groupSchema);
const Message = mongoose.model('Message', messageSchema);

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

function isAdmin(username) {
  return !!username && ADMINS.includes(username.toLowerCase());
}

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

// REST API Маршруты

// Регистрация с авто-добавлением в друзья ТОЛЬКО между heawyrt и w1len
app.post('/api/register', async (req, res) => {
  try {
    const { username, password, avatar, dob } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
    if (password.length < 4 || password.length > 20 || !PASSWORD_REGEX.test(password)) {
      return res.status(400).json({ error: 'Некорректный пароль' });
    }

    const cleanName = username.trim();
    const existingUser = await User.findOne({ username: cleanName });
    if (existingUser) return res.status(400).json({ error: 'Пользователь уже существует' });

    const lowerName = cleanName.toLowerCase();
    let defaultFriends = [];

    // Авто-дружба только если регистрируется heawyrt или w1len и второй уже зарегистрирован
    if (ADMINS.map(a => a.toLowerCase()).includes(lowerName)) {
      const otherAdminName = ADMINS.find(admin => admin.toLowerCase() !== lowerName);
      const otherAdmin = await User.findOne({ username: new RegExp(`^${otherAdminName}$`, 'i') });
      if (otherAdmin) {
        defaultFriends.push(otherAdmin.username);
        await User.updateOne(
          { _id: otherAdmin._id },
          { $addToSet: { friends: cleanName } }
        );
      }
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await User.create({
      username: cleanName,
      password: hashedPassword,
      avatar: avatar || null,
      dob: dob || null,
      friends: defaultFriends,
      friendRequests: []
    });

    const token = jwt.sign({ username: cleanName }, SECRET_KEY);
    res.json({ token, username: cleanName, avatar: user.avatar, dob: user.dob, isAdmin: isAdmin(cleanName) });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера при регистрации' });
  }
});

// Вход
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const cleanName = (username || '').trim();
    const user = await User.findOne({ username: cleanName });

    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(400).json({ error: 'Неверное имя или пароль' });
    }

    const token = jwt.sign({ username: cleanName }, SECRET_KEY);
    res.json({ token, username: cleanName, avatar: user.avatar, dob: user.dob, isAdmin: isAdmin(cleanName) });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера при входе' });
  }
});

// Загрузка данных пользователя и списков
app.get('/api/me', authenticateToken, async (req, res) => {
  try {
    const user = await User.findOne({ username: req.user.username });
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const friendsList = await User.find({ username: { $in: user.friends } }, 'username avatar');
    const requestsList = await User.find({ username: { $in: user.friendRequests } }, 'username avatar');
    const userGroupsRaw = await Group.find({ members: req.user.username });

    const groupsList = await Promise.all(userGroupsRaw.map(async (g) => {
      const membersData = await User.find({ username: { $in: g.members } }, 'username avatar');
      return {
        id: g.id,
        name: g.name,
        createdBy: g.createdBy,
        isFounder: g.createdBy === req.user.username,
        members: membersData.map(m => ({
          username: m.username,
          avatar: m.avatar,
          isFounder: m.username === g.createdBy,
          isAdmin: isAdmin(m.username)
        }))
      };
    }));

    res.json({
      username: user.username,
      avatar: user.avatar,
      dob: user.dob,
      isAdmin: isAdmin(user.username),
      friends: friendsList.map(f => ({ username: f.username, avatar: f.avatar, isAdmin: isAdmin(f.username) })),
      friendRequests: requestsList.map(r => ({ username: r.username, avatar: r.avatar, isAdmin: isAdmin(r.username) })),
      groups: groupsList
    });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка получения данных профиля' });
  }
});

// Отправка заявки в друзья
app.post('/api/friends/request', authenticateToken, async (req, res) => {
  try {
    const { targetUsername } = req.body;
    const senderName = req.user.username;
    const targetName = (targetUsername || '').trim();

    if (senderName === targetName) return res.status(400).json({ error: 'Нельзя добавить самого себя' });
    const targetUser = await User.findOne({ username: targetName });
    if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });

    const senderUser = await User.findOne({ username: senderName });
    if (senderUser.friends.includes(targetName)) return res.status(400).json({ error: 'Уже в друзьях' });
    if (targetUser.friendRequests.includes(senderName)) return res.status(400).json({ error: 'Заявка уже отправлена' });

    targetUser.friendRequests.push(senderName);
    await targetUser.save();
    res.json({ success: true, message: `Заявка отправлена пользователю ${targetName}` });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка отправки заявки' });
  }
});

// Принятие заявки в друзья
app.post('/api/friends/accept', authenticateToken, async (req, res) => {
  try {
    const { requesterUsername } = req.body;
    const user = await User.findOne({ username: req.user.username });
    const requester = await User.findOne({ username: requesterUsername });

    if (!user || !requester) return res.status(404).json({ error: 'Пользователь не найден' });

    user.friendRequests = user.friendRequests.filter(name => name !== requesterUsername);
    if (!user.friends.includes(requesterUsername)) user.friends.push(requesterUsername);
    if (!requester.friends.includes(req.user.username)) requester.friends.push(req.user.username);

    await user.save();
    await requester.save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка при принятии заявки' });
  }
});

// Создание группы
app.post('/api/groups/create', authenticateToken, async (req, res) => {
  try {
    const { groupName, memberUsernames } = req.body;
    const creator = req.user.username;
    if (!groupName || !groupName.trim()) return res.status(400).json({ error: 'Укажите название группы' });

    const creatorUser = await User.findOne({ username: creator });
    const membersSet = new Set([creator]);
    if (Array.isArray(memberUsernames)) {
      memberUsernames.forEach(m => { if (creatorUser.friends.includes(m)) membersSet.add(m); });
    }

    const groupId = 'group_' + Date.now();
    const group = await Group.create({ id: groupId, name: groupName.trim(), createdBy: creator, members: Array.from(membersSet) });
    res.json({ success: true, group });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка создания группы' });
  }
});

// Определение комнат для чатов
function getRoomId(chatType, targetId, username) {
  if (chatType === 'saved') return 'saved_' + username;
  if (chatType === 'suggestions' && isAdmin(username)) return 'suggestions_room';
  if (chatType === 'dm') return [username, targetId].sort().join('_');
  if (chatType === 'group') return targetId;
  return null;
}

// Socket.io работа с чатом
io.on('connection', (socket) => {
  socket.on('join_room', async ({ token, chatType, targetId }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const room = getRoomId(chatType, targetId, decoded.username);
      if (room) {
        if (socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(room);
        socket.currentRoom = room;

        const history = await Message.find({ room }).sort({ id: 1 });
        socket.emit('chat_history', history);
      }
    } catch (e) {
      console.error('Socket join_room error:', e);
    }
  });

  socket.on('send_message', async ({ token, chatType, targetId, text, image, replyTo }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const senderUser = await User.findOne({ username: decoded.username });
      if (!senderUser) return;

      const room = getRoomId(chatType, targetId, decoded.username);
      if (room) {
        const msgData = await Message.create({
          id: Date.now() + Math.random(),
          room,
          sender: decoded.username,
          avatar: senderUser.avatar,
          isAdmin: isAdmin(decoded.username),
          text: text || '',
          image: image || null,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          replyTo: replyTo || null,
          reactions: {},
          edited: false
        });

        io.to(room).emit('new_message', msgData);
      }
    } catch (e) {
      console.error('Socket send_message error:', e);
    }
  });

  socket.on('delete_messages', async ({ token, chatType, targetId, messageIds }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const room = getRoomId(chatType, targetId, decoded.username);
      if (room && Array.isArray(messageIds)) {
        // Удаляем только те сообщения, отправителем которых является сам пользователь
        await Message.deleteMany({ id: { $in: messageIds }, sender: decoded.username, room });
        const updatedHistory = await Message.find({ room }).sort({ id: 1 });
        io.to(room).emit('chat_history', updatedHistory);
      }
    } catch (e) {
      console.error('Socket delete_messages error:', e);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wallchat запущен на порту ${PORT}`));
