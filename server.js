const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Секреты
const JWT_SECRET = process.env.JWT_SECRET || 'nexusgram-super-secret-2024';
const PORT = process.env.PORT || 10000;

// Хранилище (в реальном проекте — БД)
const users = new Map();
const messages = [];
const groups = new Map();
const channels = new Map();
const clients = new Map(); // ws -> userInfo

// Инициализация тестовых данных
users.set('admin', {
    username: 'admin',
    password: bcrypt.hashSync('admin123', 10),
    avatar: '👑',
    status: 'offline',
    bio: 'Администратор NexusGram'
});

channels.set('news', {
    name: 'Новости',
    admin: 'admin',
    subscribers: new Set(['admin']),
    isChannel: true,
    description: 'Официальный канал новостей'
});

groups.set('general', {
    name: 'Общий чат',
    members: new Set(['admin']),
    isChannel: false
});

// ============ REST API ============

// Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, avatar } = req.body;
        if (!username || !password) {
            return res.status(400).json({ error: 'Логин и пароль обязательны' });
        }
        if (users.has(username)) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        const hash = await bcrypt.hash(password, 10);
        users.set(username, {
            username,
            password: hash,
            avatar: avatar || '😊',
            status: 'offline',
            bio: '',
            lastSeen: null
        });
        // Добавляем в общий чат
        groups.get('general').members.add(username);
        res.json({ success: true, message: 'Регистрация успешна' });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Логин
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = users.get(username);
        if (!user) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        const valid = await bcrypt.compare(password, user.password);
        if (!valid) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        user.lastSeen = new Date().toISOString();
        res.json({
            token,
            user: {
                username: user.username,
                avatar: user.avatar,
                bio: user.bio,
                status: user.status
            }
        });
    } catch (error) {
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Профиль
app.get('/api/profile/:username', (req, res) => {
    const user = users.get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json({
        username: user.username,
        avatar: user.avatar,
        bio: user.bio,
        status: user.status,
        lastSeen: user.lastSeen
    });
});

// Обновление профиля
app.put('/api/profile', authenticateToken, (req, res) => {
    const user = users.get(req.user.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    if (req.body.bio) user.bio = req.body.bio;
    if (req.body.avatar) user.avatar = req.body.avatar;
    res.json({ success: true, user: { username: user.username, avatar: user.avatar, bio: user.bio } });
});

// Поиск пользователей и сообщений
app.get('/api/search', authenticateToken, (req, res) => {
    const query = req.query.q?.toLowerCase() || '';
    // Поиск пользователей
    const foundUsers = [];
    users.forEach((user, username) => {
        if (username.toLowerCase().includes(query) && username !== req.user.username) {
            foundUsers.push({ username, avatar: user.avatar, status: user.status });
        }
    });
    // Поиск в сообщениях
    const foundMessages = messages.filter(msg =>
        msg.text?.toLowerCase().includes(query) &&
        (msg.to === 'global' || msg.to === req.user.username || msg.from === req.user.username)
    ).slice(-50);
    res.json({ users: foundUsers.slice(0, 20), messages: foundMessages });
});

// Создание группы
app.post('/api/groups', authenticateToken, (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Название группы обязательно' });
    if (groups.has(name)) return res.status(400).json({ error: 'Группа уже существует' });
    groups.set(name, {
        name,
        members: new Set([req.user.username]),
        isChannel: false,
        createdBy: req.user.username
    });
    res.json({ success: true, group: { name, members: [req.user.username] } });
});

// Создание канала
app.post('/api/channels', authenticateToken, (req, res) => {
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: 'Название канала обязательно' });
    if (channels.has(name)) return res.status(400).json({ error: 'Канал уже существует' });
    channels.set(name, {
        name,
        admin: req.user.username,
        subscribers: new Set([req.user.username]),
        isChannel: true,
        description: description || ''
    });
    res.json({ success: true, channel: { name, admin: req.user.username } });
});

// Список групп и каналов
app.get('/api/rooms', authenticateToken, (req, res) => {
    const rooms = [];
    groups.forEach((group, name) => {
        rooms.push({ name, type: 'group', members: Array.from(group.members) });
    });
    channels.forEach((channel, name) => {
        rooms.push({ name, type: 'channel', admin: channel.admin, subscribers: Array.from(channel.subscribers) });
    });
    res.json(rooms);
});

// Middleware для проверки JWT
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Токен не предоставлен' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Недействительный токен' });
        req.user = user;
        next();
    });
}

// ============ WebSocket ============

wss.on('connection', (ws) => {
    let username = null;

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            switch (msg.type) {
                case 'auth':
                    jwt.verify(msg.token, JWT_SECRET, (err, decoded) => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', text: 'Ошибка авторизации WebSocket' }));
                            return;
                        }
                        username = decoded.username;
                        clients.set(ws, { username, ws });
                        const user = users.get(username);
                        if (user) {
                            user.status = 'online';
                            broadcast({ type: 'user_status', username, status: 'online' });
                        }
                        ws.send(JSON.stringify({ type: 'auth_success', username }));
                        console.log(`${username} подключился`);
                    });
                    break;

                case 'message':
                    if (!username) return;
                    const chatMessage = {
                        id: uuidv4(),
                        type: 'message',
                        from: username,
                        text: msg.text,
                        to: msg.to || 'global',
                        timestamp: Date.now(),
                        avatar: users.get(username)?.avatar || '😊'
                    };
                    messages.push(chatMessage);
                    if (messages.length > 1000) messages.shift(); // Ограничение истории
                    deliverMessage(chatMessage);
                    break;

                case 'typing':
                    if (!username) return;
                    broadcast({
                        type: 'typing',
                        from: username,
                        to: msg.to || 'global'
                    }, username);
                    break;

                // WebRTC сигналинг
                case 'call_offer':
                case 'call_answer':
                case 'ice_candidate':
                case 'call_end':
                    forwardToTarget(msg.target, { ...msg, from: username });
                    break;

                case 'join_room':
                    // Клиент сообщает, в какой комнате слушает
                    break;
            }
        } catch (e) {
            console.error('WebSocket error:', e);
        }
    });

    ws.on('close', () => {
        if (username) {
            const user = users.get(username);
            if (user) {
                user.status = 'offline';
                user.lastSeen = new Date().toISOString();
                broadcast({ type: 'user_status', username, status: 'offline' });
            }
            clients.delete(ws);
            console.log(`${username} отключился`);
        }
    });
});

function deliverMessage(message) {
    const payload = JSON.stringify(message);
    clients.forEach((client, ws) => {
        if (ws.readyState === 1) {
            // Доставляем всем, кто онлайн (упрощённо)
            ws.send(payload);
        }
    });
}

function broadcast(data, excludeUsername = null) {
    const payload = JSON.stringify(data);
    clients.forEach((client, ws) => {
        if (ws.readyState === 1 && client.username !== excludeUsername) {
            ws.send(payload);
        }
    });
}

function forwardToTarget(targetUsername, data) {
    const payload = JSON.stringify(data);
    clients.forEach((client, ws) => {
        if (ws.readyState === 1 && client.username === targetUsername) {
            ws.send(payload);
        }
    });
}

server.listen(PORT, () => {
    console.log(`NexusGram API запущен на порту ${PORT}`);
});
