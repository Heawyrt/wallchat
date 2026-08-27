const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const SECRET_KEY = 'wallchat_secret_key_change_me';
const ADMINS = ['heawyrt', 'w1len'];

const PASSWORD_REGEX = /^[a-zA-Zа-яА-ЯёЁ1-9]+$/;

const users = new Map();   // username -> { username, password, avatar, dob, friends: Set, friendRequests: Set }
const groups = new Map();  // groupId -> { id, name, members: Set, createdBy }
const messagesStore = new Map(); // room -> Array of messages

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

function isAdmin(username) {
  return !!username && ADMINS.includes(username.toLowerCase());
}

function crossFriendAdmins(newUser) {
  const newNameLC = newUser.username.toLowerCase();
  if (ADMINS.includes(newNameLC)) {
    const otherAdminName = ADMINS.find(name => name !== newNameLC);
    if (otherAdminName) {
      for (let user of users.values()) {
        if (user.username.toLowerCase() === otherAdminName) {
          newUser.friends.add(user.username);
          user.friends.add(newUser.username);
          break;
        }
      }
    }
  }
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

// Регистрация
app.post('/api/register', async (req, res) => {
  const { username, password, avatar, dob } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Заполните все поля' });
  
  if (password.length < 4 || password.length > 20) {
    return res.status(400).json({ error: 'Длина пароля должна быть от 4 до 20 символов' });
  }

  if (!PASSWORD_REGEX.test(password)) {
    return res.status(400).json({ error: 'Пароль содержит недопустимые символы' });
  }

  const cleanName = username.trim();
  if (users.has(cleanName)) return res.status(400).json({ error: 'Пользователь уже существует' });

  const hashedPassword = await bcrypt.hash(password, 10);
  const user = {
    username: cleanName,
    password: hashedPassword,
    avatar: avatar || null,
    dob: dob || null,
    friends: new Set(),
    friendRequests: new Set()
  };
  users.set(cleanName, user);

  crossFriendAdmins(user);

  const token = jwt.sign({ username: cleanName }, SECRET_KEY);
  res.json({ token, username: cleanName, avatar: user.avatar, dob: user.dob, isAdmin: isAdmin(cleanName) });
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
  res.json({ token, username: cleanName, avatar: user.avatar, dob: user.dob, isAdmin: isAdmin(cleanName) });
});

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
      const membersList = Array.from(group.members).map(mName => {
        const mUser = users.get(mName);
        return {
          username: mName,
          avatar: mUser ? mUser.avatar : null,
          isFounder: mName === group.createdBy,
          isAdmin: isAdmin(mName)
        };
      });

      userGroups.push({
        id: group.id,
        name: group.name,
        createdBy: group.createdBy,
        isFounder: group.createdBy === req.user.username,
        members: membersList
      });
    }
  }

  res.json({
    username: user.username,
    avatar: user.avatar,
    dob: user.dob,
    isAdmin: isAdmin(user.username),
    friends: friendsList,
    friendRequests: requestsList,
    groups: userGroups
  });
});

app.post('/api/friends/request', authenticateToken, (req, res) => {
  const { targetUsername } = req.body;
  const senderName = req.user.username;
  const targetName = (targetUsername || '').trim();

  if (senderName === targetName) return res.status(400).json({ error: 'Нельзя добавить самого себя' });
  const targetUser = users.get(targetName);
  if (!targetUser) return res.status(404).json({ error: 'Пользователь не найден' });

  const senderUser = users.get(senderName);
  if (senderUser.friends.has(targetName)) return res.status(400).json({ error: 'Вы уже в друзья' });
  if (targetUser.friendRequests.has(senderName)) return res.status(400).json({ error: 'Заявка уже отправлена' });

  targetUser.friendRequests.add(senderName);
  res.json({ success: true, message: `Заявка отправлена пользователю ${targetName}` });
});

app.post('/api/friends/accept', authenticateToken, (req, res) => {
  const { requesterUsername } = req.body;
  const user = users.get(req.user.username);
  const requester = users.get(requesterUsername);

  if (!user || !requester) return res.status(404).json({ error: 'Пользователь не найден' });

  user.friendRequests.delete(requesterUsername);
  user.friends.add(requesterUsername);
  requester.friends.add(req.user.username);

  res.json({ success: true });
});

app.post('/api/friends/reject', authenticateToken, (req, res) => {
  const user = users.get(req.user.username);
  if (user) user.friendRequests.delete(req.body.requesterUsername);
  res.json({ success: true });
});

app.post('/api/suggestions/send', authenticateToken, (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'Введите текст предложения' });

  const senderName = req.user.username;
  const senderUser = users.get(senderName);

  const room = 'suggestions_room';
  if (!messagesStore.has(room)) messagesStore.set(room, []);

  const msgData = {
    id: Date.now() + Math.random(),
    sender: senderName,
    avatar: senderUser ? senderUser.avatar : null,
    isAdmin: isAdmin(senderName),
    text: text.trim(),
    image: null,
    time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    reactions: {}
  };

  messagesStore.get(room).push(msgData);
  io.to(room).emit('new_message', msgData);

  res.json({ success: true, message: 'Предложение отправлено!' });
});

// Группы
app.post('/api/groups/create', authenticateToken, (req, res) => {
  const { groupName, memberUsernames } = req.body;
  const creator = req.user.username;
  if (!groupName || !groupName.trim()) return res.status(400).json({ error: 'Укажите название группы' });

  const creatorUser = users.get(creator);
  const validMembers = new Set([creator]);
  if (Array.isArray(memberUsernames)) {
    for (const m of memberUsernames) {
      if (creatorUser.friends.has(m)) validMembers.add(m);
    }
  }

  const groupId = 'group_' + Date.now();
  const group = { id: groupId, name: groupName.trim(), members: validMembers, createdBy: creator };
  groups.set(groupId, group);
  res.json({ success: true, group });
});

app.post('/api/groups/rename', authenticateToken, (req, res) => {
  const { groupId, newName } = req.body;
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (group.createdBy !== req.user.username) return res.status(403).json({ error: 'Только Founder может изменять название' });

  group.name = newName.trim();
  res.json({ success: true });
});

app.post('/api/groups/add-member', authenticateToken, (req, res) => {
  const { groupId, targetUsername } = req.body;
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });

  group.members.add(targetUsername);
  res.json({ success: true });
});

app.post('/api/groups/remove-member', authenticateToken, (req, res) => {
  const { groupId, targetUsername } = req.body;
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (group.createdBy !== req.user.username) return res.status(403).json({ error: 'Только Founder может удалять участников' });
  if (targetUsername === group.createdBy) return res.status(400).json({ error: 'Основатель не может быть удален' });

  group.members.delete(targetUsername);
  res.json({ success: true });
});

app.post('/api/groups/leave', authenticateToken, (req, res) => {
  const { groupId } = req.body;
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (group.createdBy === req.user.username) {
    return res.status(400).json({ error: 'Founder не может покинуть группу.' });
  }

  group.members.delete(req.user.username);
  res.json({ success: true });
});

app.post('/api/groups/delete', authenticateToken, (req, res) => {
  const { groupId } = req.body;
  const group = groups.get(groupId);
  if (!group) return res.status(404).json({ error: 'Группа не найдена' });
  if (group.createdBy !== req.user.username) return res.status(403).json({ error: 'Только Founder может удалить группу' });

  groups.delete(groupId);
  res.json({ success: true });
});

app.post('/api/settings', authenticateToken, async (req, res) => {
  const { avatar, newPassword, dob } = req.body;
  const user = users.get(req.user.username);
  if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

  if (avatar !== undefined) user.avatar = avatar;
  if (dob !== undefined) user.dob = dob;
  if (newPassword) {
    if (newPassword.length < 4 || newPassword.length > 20) {
      return res.status(400).json({ error: 'Длина пароля должна быть от 4 до 20 символов' });
    }
    if (!PASSWORD_REGEX.test(newPassword)) {
      return res.status(400).json({ error: 'Пароль содержит недопустимые символы' });
    }
    user.password = await bcrypt.hash(newPassword, 10);
  }

  res.json({ success: true, avatar: user.avatar, dob: user.dob });
});

// Helper функции комнат
function getRoomId(chatType, targetId, username) {
  if (chatType === 'saved') return 'saved_' + username;
  if (chatType === 'suggestions' && isAdmin(username)) return 'suggestions_room';
  if (chatType === 'dm') return [username, targetId].sort().join('_');
  if (chatType === 'group') return targetId;
  return null;
}

// Socket.io
io.on('connection', (socket) => {
  socket.on('join_room', ({ token, chatType, targetId }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;
      const room = getRoomId(chatType, targetId, username);

      if (room) {
        if (socket.currentRoom) socket.leave(socket.currentRoom);
        socket.join(room);
        socket.currentRoom = room;

        const history = messagesStore.get(room) || [];
        socket.emit('chat_history', history);
      }
    } catch (e) {
      console.error('Socket error:', e);
    }
  });

  socket.on('send_message', ({ token, chatType, targetId, text, image, replyTo }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const senderName = decoded.username;
      const senderUser = users.get(senderName);
      if (!senderUser) return;

      const room = getRoomId(chatType, targetId, senderName);
      if (room) {
        const msgData = {
          id: Date.now() + Math.random(),
          sender: senderName,
          avatar: senderUser.avatar,
          isAdmin: isAdmin(senderName),
          text: text || '',
          image: image || null,
          time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          replyTo: replyTo || null,
          reactions: {},
          edited: false
        };

        if (!messagesStore.has(room)) messagesStore.set(room, []);
        messagesStore.get(room).push(msgData);

        io.to(room).emit('new_message', msgData);
      }
    } catch (e) {
      console.error('Send error:', e);
    }
  });

  // Удаление сообщений
  socket.on('delete_messages', ({ token, chatType, targetId, messageIds }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;
      const room = getRoomId(chatType, targetId, username);
      if (!room || !messagesStore.has(room)) return;

      let list = messagesStore.get(room);
      const idSet = new Set(messageIds);

      // Изменение 1: Удалять можно только свои сообщения (Проверка isAdmin убрана из условия удаления чужого)
      messagesStore.set(room, list.filter(m => !(idSet.has(m.id) && m.sender === username)));
      io.to(room).emit('chat_history', messagesStore.get(room));
    } catch (e) {
      console.error('Delete error:', e);
    }
  });

  // Редактирование
  socket.on('edit_message', ({ token, chatType, targetId, messageId, newText }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;
      const room = getRoomId(chatType, targetId, username);
      if (!room || !messagesStore.has(room)) return;

      const list = messagesStore.get(room);
      const msg = list.find(m => m.id === messageId);
      if (msg && msg.sender === username) {
        msg.text = newText;
        msg.edited = true;
        io.to(room).emit('chat_history', list);
      }
    } catch (e) {
      console.error('Edit error:', e);
    }
  });

  // Реакции
  socket.on('toggle_reaction', ({ token, chatType, targetId, messageId, emoji }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const username = decoded.username;
      const room = getRoomId(chatType, targetId, username);
      if (!room || !messagesStore.has(room)) return;

      const list = messagesStore.get(room);
      const msg = list.find(m => m.id === messageId);
      if (msg) {
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];

        const index = msg.reactions[emoji].indexOf(username);
        if (index > -1) {
          msg.reactions[emoji].splice(index, 1);
          if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
        } else {
          msg.reactions[emoji].push(username);
        }
        io.to(room).emit('chat_history', list);
      }
    } catch (e) {
      console.error('Reaction error:', e);
    }
  });

  // Пересылка
  socket.on('forward_messages', ({ token, destChatType, destTargetId, messages }) => {
    try {
      const decoded = jwt.verify(token, SECRET_KEY);
      const senderName = decoded.username;
      const senderUser = users.get(senderName);
      if (!senderUser) return;

      const destRoom = getRoomId(destChatType, destTargetId, senderName);
      if (destRoom) {
        if (!messagesStore.has(destRoom)) messagesStore.set(destRoom, []);
        const roomList = messagesStore.get(destRoom);

        messages.forEach(m => {
          const fwdData = {
            id: Date.now() + Math.random(),
            sender: senderName,
            avatar: senderUser.avatar,
            isAdmin: isAdmin(senderName),
            text: `[Переслано от ${m.sender}]: ${m.text}`,
            image: m.image || null,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            reactions: {}
          };
          roomList.push(fwdData);
          io.to(destRoom).emit('new_message', fwdData);
        });
      }
    } catch (e) {
      console.error('Forward error:', e);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Wallchat запущен на порту ${PORT}`));
