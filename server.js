const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e7 }); // Лимит 10MB для аватарок

const SECRET_KEY = 'wallchat_secret_key_change_me';
const users = new Map(); // Хранилище пользователей в памяти

app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password, avatar } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  if (users.has(username)) return res.status(400).json({ error: 'Пользователь уже существует' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = { username, password: hashedPassword, avatar: avatar || null };
  users.set(username, user);

  const token = jwt.sign({ username }, SECRET_KEY);
  res.json({ token, username, avatar: user.avatar });
});

// Вход
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = users.get(username);
  if (!user || !(await bcrypt.compare(password, user.password))) {
    return res.status(400).json({ error: 'Неверное имя или пароль' });
  }

  const token = jwt.sign({ username }, SECRET_KEY);
  res.json({ token, username, avatar: user.avatar });
});

// Обновление настроек (аватар/пароль)
app.post('/api/settings', async (req, res) => {
  const { token, avatar, newPassword } = req.body;
  try {
    const decoded = jwt.verify(token, SECRET_KEY);
    const user = users.get(decoded.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    if (avatar !== undefined) user.avatar = avatar;
    if (newPassword) user.password = await bcrypt.hash(newPassword, 10);

    users.set(decoded.username, user);
    res.json({ success: true, avatar: user.avatar });
  } catch (err) {
    res.status(401).json({ error: 'Недействительный токен' });
  }
});

// Socket.io соединения
io.on('connection', (socket) => {
  socket.on('chat message', (data) => {
    io.emit('chat message', data);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wallchat запущен на порту ${PORT}`));