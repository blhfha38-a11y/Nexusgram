// ╔══════════════════════════════════════════════════════════╗
// ║            NEXUSGRAM - МЕССЕНДЖЕР СЕРВЕР                ║
// ║            Version 3.0 - Production Ready               ║
// ╚══════════════════════════════════════════════════════════╝

const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

// ==================== КОНФИГУРАЦИЯ ====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG = {
    PORT: process.env.PORT || 10000,
    JWT_SECRET: process.env.JWT_SECRET || 'nexusgram-super-mega-ultra-secret-key-2024',
    JWT_EXPIRES_IN: '7d',
    MAX_MESSAGE_LENGTH: 5000,
    MAX_FILE_SIZE: 50 * 1024 * 1024,
    UPLOAD_DIR: path.join(__dirname, 'uploads'),
    CLEANUP_INTERVAL: 300000,
    BACKUP_INTERVAL: 3600000
};

// Создаем папку для загрузок
if (!fs.existsSync(CONFIG.UPLOAD_DIR)) {
    fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });
}

// ==================== MIDDLEWARE ====================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(CONFIG.UPLOAD_DIR));

// Логирование
app.use((req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        console.log(`${req.method} ${req.url} ${res.statusCode} ${duration}ms`);
    });
    next();
});

// Rate limiting
const rateLimit = new Map();
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    if (!rateLimit.has(ip)) rateLimit.set(ip, []);
    const requests = rateLimit.get(ip).filter(time => now - time < 60000);
    if (requests.length >= 200) {
        return res.status(429).json({ error: 'Слишком много запросов' });
    }
    requests.push(now);
    rateLimit.set(ip, requests);
    next();
});

// ==================== ХРАНИЛИЩЕ ДАННЫХ ====================
class DataStore {
    constructor() {
        this.users = new Map();
        this.messages = [];
        this.groups = new Map();
        this.channels = new Map();
        this.files = new Map();
        this.blockedUsers = new Map();
        this.polls = new Map();
        this.stickers = new Map();
        this.sessions = new Map();
        this.initializeDefaults();
        this.restore();
    }

    initializeDefaults() {
        // Админ
        this.users.set('admin', {
            username: 'admin',
            password: bcrypt.hashSync('admin123', 10),
            avatar: '👑',
            status: 'offline',
            bio: '🌟 Администратор NexusGram',
            phone: null,
            email: 'admin@nexusgram.com',
            createdAt: new Date().toISOString(),
            lastSeen: null,
            isVerified: true,
            isPremium: true,
            role: 'admin',
            settings: { notifications: true, theme: 'dark', language: 'ru', privacy: 'everyone' }
        });

        // Тестовые пользователи
        const testUsers = [
            { username: 'alice', password: 'alice123', avatar: '🌸', bio: 'Люблю котиков и программирование' },
            { username: 'bob', password: 'bob123', avatar: '🚀', bio: 'Космический разработчик' },
            { username: 'charlie', password: 'charlie123', avatar: '🎸', bio: 'Музыкант и дизайнер' }
        ];

        testUsers.forEach(user => {
            this.users.set(user.username, {
                ...user,
                password: bcrypt.hashSync(user.password, 10),
                status: 'offline',
                phone: null,
                email: `${user.username}@nexusgram.com`,
                createdAt: new Date().toISOString(),
                lastSeen: null,
                isVerified: true,
                isPremium: false,
                role: 'user',
                settings: { notifications: true, theme: 'dark', language: 'ru', privacy: 'everyone' }
            });
        });

        // Каналы
        this.channels.set('news', {
            id: uuidv4(),
            name: '📢 Новости NexusGram',
            admin: 'admin',
            subscribers: new Set(['admin', 'alice', 'bob']),
            description: 'Официальный канал новостей',
            createdAt: new Date().toISOString(),
            avatar: '📰',
            isVerified: true
        });

        this.channels.set('tech', {
            id: uuidv4(),
            name: '💻 Технологии',
            admin: 'admin',
            subscribers: new Set(['admin', 'bob', 'charlie']),
            description: 'Новости технологий и AI',
            createdAt: new Date().toISOString(),
            avatar: '🔧',
            isVerified: true
        });

        // Группы
        this.groups.set('general', {
            id: uuidv4(),
            name: '💬 Общий чат',
            members: new Set(['admin', 'alice', 'bob', 'charlie']),
            admins: new Set(['admin']),
            description: 'Общий чат для всех',
            createdAt: new Date().toISOString(),
            avatar: '👥',
            isPublic: true
        });

        this.groups.set('developers', {
            id: uuidv4(),
            name: '👨‍💻 Разработчики',
            members: new Set(['admin', 'bob']),
            admins: new Set(['bob']),
            description: 'Разработка NexusGram',
            createdAt: new Date().toISOString(),
            avatar: '⚡',
            isPublic: true
        });

        // Стикеры
        this.stickers.set('default', {
            id: 'default',
            name: 'Стандартные',
            stickers: ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉', '💩', '🔥', '💯']
        });
    }

    backup() {
        try {
            const data = {
                users: Array.from(this.users.entries()),
                messages: this.messages.slice(-10000),
                groups: Array.from(this.groups.entries()),
                channels: Array.from(this.channels.entries()),
                timestamp: new Date().toISOString()
            };
            fs.writeFileSync(path.join(__dirname, 'backup.json'), JSON.stringify(data, (key, value) => {
                if (value instanceof Set) return Array.from(value);
                if (value instanceof Map) return Array.from(value.entries());
                return value;
            }, 2));
            console.log('✅ Бэкап создан');
        } catch (error) {
            console.error('❌ Ошибка бэкапа:', error);
        }
    }

    restore() {
        try {
            if (fs.existsSync(path.join(__dirname, 'backup.json'))) {
                const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'backup.json'), 'utf8'));
                this.users = new Map(data.users);
                this.groups = new Map(data.groups);
                this.channels = new Map(data.channels);
                this.groups.forEach(group => {
                    group.members = new Set(group.members);
                    group.admins = new Set(group.admins || []);
                });
                this.channels.forEach(channel => {
                    channel.subscribers = new Set(channel.subscribers);
                });
                console.log('✅ Данные восстановлены из бэкапа');
            }
        } catch (error) {
            console.error('❌ Ошибка восстановления:', error);
        }
    }
}

const db = new DataStore();

// Периодический бэкап и очистка
setInterval(() => db.backup(), CONFIG.BACKUP_INTERVAL);
setInterval(() => {
    if (db.messages.length > 5000) db.messages = db.messages.slice(-5000);
    rateLimit.forEach((requests, ip) => {
        const recent = requests.filter(time => Date.now() - time < 60000);
        if (recent.length === 0) rateLimit.delete(ip);
        else rateLimit.set(ip, recent);
    });
}, CONFIG.CLEANUP_INTERVAL);

// ==================== УТИЛИТЫ ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Токен не предоставлен' });
    jwt.verify(token, CONFIG.JWT_SECRET, (err, decoded) => {
        if (err) return res.status(403).json({ error: 'Недействительный токен' });
        if (!db.users.has(decoded.username)) return res.status(404).json({ error: 'Пользователь не найден' });
        req.user = decoded;
        next();
    });
};

const isAdmin = (req, res, next) => {
    const user = db.users.get(req.user.username);
    if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Доступ запрещен' });
    next();
};

function sanitizeUser(user) {
    if (!user) return null;
    return {
        username: user.username,
        avatar: user.avatar,
        status: user.status,
        bio: user.bio,
        lastSeen: user.lastSeen,
        isVerified: user.isVerified,
        isPremium: user.isPremium,
        role: user.role,
        createdAt: user.createdAt
    };
}

function generateToken(username) {
    return jwt.sign({ username }, CONFIG.JWT_SECRET, { expiresIn: CONFIG.JWT_EXPIRES_IN });
}

function escapeHtml(text) {
    if (!text) return '';
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ==================== ЗАГРУЗКА ФАЙЛОВ ====================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const subDir = file.mimetype.startsWith('image/') ? 'images' :
                       file.mimetype.startsWith('audio/') ? 'audio' :
                       file.mimetype.startsWith('video/') ? 'video' : 'other';
        const dir = path.join(CONFIG.UPLOAD_DIR, subDir);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname);
        cb(null, `${uuidv4()}${ext}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: CONFIG.MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/png', 'image/gif', 'image/webp',
            'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm',
            'video/mp4', 'video/webm',
            'application/pdf', 'application/zip',
            'text/plain'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Неподдерживаемый тип файла'), false);
        }
    }
});

// ==================== REST API ====================

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Статус сервера
app.get('/api/status', (req, res) => {
    const onlineUsers = Array.from(db.users.values()).filter(u => u.status === 'online').length;
    res.json({
        name: 'NexusGram API',
        version: '3.0.0',
        status: 'online',
        uptime: process.uptime(),
        users: db.users.size,
        online: onlineUsers,
        messages: db.messages.length,
        groups: db.groups.size,
        channels: db.channels.size,
        timestamp: new Date().toISOString()
    });
});

// ==================== АВТОРИЗАЦИЯ ====================

// Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, avatar, bio } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });
        if (username.length < 3 || username.length > 30) return res.status(400).json({ error: 'Логин должен быть от 3 до 30 символов' });
        if (password.length < 6) return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
        if (!/^[a-zA-Z0-9_]+$/.test(username)) return res.status(400).json({ error: 'Логин может содержать только буквы, цифры и подчеркивания' });
        if (db.users.has(username)) return res.status(400).json({ error: 'Пользователь уже существует' });

        const hash = await bcrypt.hash(password, 10);
        const newUser = {
            username,
            password: hash,
            avatar: avatar || ['😊', '😎', '🤓', '🦊', '🐱', '🐶', '🦄', '🐙'][Math.floor(Math.random() * 8)],
            status: 'offline',
            bio: bio || '',
            phone: null,
            email: null,
            createdAt: new Date().toISOString(),
            lastSeen: null,
            isVerified: false,
            isPremium: false,
            role: 'user',
            settings: { notifications: true, theme: 'dark', language: 'ru', privacy: 'everyone' }
        };

        db.users.set(username, newUser);
        if (db.groups.has('general')) db.groups.get('general').members.add(username);

        const token = generateToken(username);
        console.log(`✅ Новый пользователь: ${username}`);

        res.status(201).json({
            success: true,
            message: 'Регистрация успешна! Добро пожаловать в NexusGram!',
            token,
            user: sanitizeUser(newUser)
        });
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Логин и пароль обязательны' });

        const user = db.users.get(username);
        if (!user) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(401).json({ error: 'Неверный логин или пароль' });

        const token = generateToken(username);
        console.log(`🔑 Вход: ${username}`);

        res.json({
            success: true,
            message: 'Вход выполнен успешно!',
            token,
            user: sanitizeUser(user)
        });
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// ==================== ПРОФИЛЬ ====================

app.get('/api/profile/me', authenticateToken, (req, res) => {
    const user = db.users.get(req.user.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(sanitizeUser(user));
});

app.get('/api/profile/:username', authenticateToken, (req, res) => {
    const user = db.users.get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(sanitizeUser(user));
});

app.put('/api/profile', authenticateToken, (req, res) => {
    const user = db.users.get(req.user.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });

    const { bio, avatar, phone, email } = req.body;
    if (bio !== undefined) user.bio = escapeHtml(bio);
    if (avatar !== undefined) user.avatar = avatar;
    if (phone !== undefined) user.phone = phone;
    if (email !== undefined) user.email = email;

    console.log(`✏️ Профиль обновлен: ${req.user.username}`);

    broadcastToAll({
        type: 'profile_updated',
        username: req.user.username,
        user: sanitizeUser(user)
    });

    res.json({ success: true, message: 'Профиль обновлен', user: sanitizeUser(user) });
});

// ==================== ПОИСК ====================

app.get('/api/search', authenticateToken, (req, res) => {
    const query = req.query.q?.toLowerCase().trim();
    if (!query || query.length < 2) return res.json({ users: [], messages: [], groups: [], channels: [] });

    const foundUsers = [];
    db.users.forEach((user, username) => {
        if (username !== req.user.username) {
            const searchStr = `${username} ${user.bio || ''}`.toLowerCase();
            if (searchStr.includes(query)) foundUsers.push(sanitizeUser(user));
        }
    });

    const foundMessages = db.messages.filter(msg => {
        const isRelevant = msg.to === 'global' || msg.to === req.user.username || msg.from === req.user.username;
        return isRelevant && msg.text && msg.text.toLowerCase().includes(query);
    }).slice(-50);

    const foundGroups = [];
    db.groups.forEach((group, name) => {
        if (group.name.toLowerCase().includes(query) || group.description?.toLowerCase().includes(query)) {
            foundGroups.push({
                name,
                description: group.description,
                members: Array.from(group.members),
                memberCount: group.members.size
            });
        }
    });

    const foundChannels = [];
    db.channels.forEach((channel, name) => {
        if (channel.name.toLowerCase().includes(query) || channel.description?.toLowerCase().includes(query)) {
            foundChannels.push({
                name,
                description: channel.description,
                subscribers: Array.from(channel.subscribers),
                subscriberCount: channel.subscribers.size
            });
        }
    });

    res.json({
        query,
        users: foundUsers.slice(0, 20),
        messages: foundMessages,
        groups: foundGroups.slice(0, 10),
        channels: foundChannels.slice(0, 10)
    });
});

// ==================== ГРУППЫ ====================

app.post('/api/groups', authenticateToken, (req, res) => {
    const { name, description } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Название группы должно быть минимум 2 символа' });
    if (db.groups.has(name)) return res.status(400).json({ error: 'Группа уже существует' });

    const newGroup = {
        id: uuidv4(),
        name: name.trim(),
        members: new Set([req.user.username]),
        admins: new Set([req.user.username]),
        description: description || '',
        avatar: '👥',
        createdAt: new Date().toISOString(),
        isPublic: true
    };

    db.groups.set(name, newGroup);
    console.log(`👥 Группа создана: ${name}`);

    res.status(201).json({
        success: true,
        group: {
            name,
            description: newGroup.description,
            members: Array.from(newGroup.members),
            memberCount: 1
        }
    });
});

app.get('/api/groups', authenticateToken, (req, res) => {
    const userGroups = [];
    db.groups.forEach((group, name) => {
        if (group.members.has(req.user.username)) {
            userGroups.push({
                name,
                description: group.description,
                members: Array.from(group.members),
                memberCount: group.members.size
            });
        }
    });
    res.json({ groups: userGroups });
});

app.post('/api/groups/:name/join', authenticateToken, (req, res) => {
    const group = db.groups.get(req.params.name);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    group.members.add(req.user.username);

    broadcastToRoom(req.params.name, {
        type: 'user_joined',
        username: req.user.username,
        room: req.params.name,
        timestamp: Date.now()
    });

    res.json({ success: true, message: 'Вы присоединились к группе' });
});

app.post('/api/groups/:name/leave', authenticateToken, (req, res) => {
    const group = db.groups.get(req.params.name);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    group.members.delete(req.user.username);
    if (group.admins.has(req.user.username)) {
        group.admins.delete(req.user.username);
        if (group.members.size > 0) {
            group.admins.add(Array.from(group.members)[0]);
        }
    }

    broadcastToRoom(req.params.name, {
        type: 'user_left',
        username: req.user.username,
        room: req.params.name,
        timestamp: Date.now()
    });

    res.json({ success: true, message: 'Вы покинули группу' });
});

// ==================== КАНАЛЫ ====================

app.post('/api/channels', authenticateToken, (req, res) => {
    const { name, description } = req.body;
    if (!name || name.trim().length < 2) return res.status(400).json({ error: 'Название канала должно быть минимум 2 символа' });
    if (db.channels.has(name)) return res.status(400).json({ error: 'Канал уже существует' });

    const newChannel = {
        id: uuidv4(),
        name: name.trim(),
        admin: req.user.username,
        subscribers: new Set([req.user.username]),
        description: description || '',
        avatar: '📢',
        createdAt: new Date().toISOString(),
        isVerified: false
    };

    db.channels.set(name, newChannel);
    console.log(`📢 Канал создан: ${name}`);

    res.status(201).json({
        success: true,
        channel: {
            name,
            description: newChannel.description,
            subscribers: Array.from(newChannel.subscribers),
            subscriberCount: 1
        }
    });
});

app.get('/api/channels', authenticateToken, (req, res) => {
    const allChannels = [];
    db.channels.forEach((channel, name) => {
        allChannels.push({
            name,
            description: channel.description,
            admin: channel.admin,
            subscribers: Array.from(channel.subscribers),
            subscriberCount: channel.subscribers.size
        });
    });
    res.json({ channels: allChannels });
});

app.post('/api/channels/:name/subscribe', authenticateToken, (req, res) => {
    const channel = db.channels.get(req.params.name);
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    channel.subscribers.add(req.user.username);
    res.json({ success: true, message: 'Вы подписались на канал' });
});

app.post('/api/channels/:name/unsubscribe', authenticateToken, (req, res) => {
    const channel = db.channels.get(req.params.name);
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    channel.subscribers.delete(req.user.username);
    res.json({ success: true, message: 'Вы отписались от канала' });
});

// ==================== ЗАГРУЗКА ФАЙЛОВ ====================

app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    const fileUrl = `/uploads/${req.file.mimetype.split('/')[0]}s/${req.file.filename}`;

    db.files.set(req.file.filename, {
        id: req.file.filename,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
        size: req.file.size,
        url: fileUrl,
        uploadedBy: req.user.username,
        uploadedAt: new Date().toISOString()
    });

    console.log(`📁 Файл загружен: ${req.file.originalname}`);

    res.json({
        success: true,
        file: {
            id: req.file.filename,
            name: req.file.originalname,
            type: req.file.mimetype,
            size: req.file.size,
            url: fileUrl
        }
    });
});

// ==================== СООБЩЕНИЯ ====================

app.get('/api/messages/:room', authenticateToken, (req, res) => {
    const { room } = req.params;
    const limit = parseInt(req.query.limit) || 100;
    const roomMessages = db.messages.filter(msg => msg.to === room).slice(-limit);
    res.json({ room, messages: roomMessages });
});

app.post('/api/messages', authenticateToken, (req, res) => {
    const { text, to, replyTo, file } = req.body;
    if (!text && !file) return res.status(400).json({ error: 'Сообщение не может быть пустым' });
    if (text && text.length > CONFIG.MAX_MESSAGE_LENGTH) return res.status(400).json({ error: 'Сообщение слишком длинное' });

    const message = {
        id: uuidv4(),
        type: 'message',
        from: req.user.username,
        to: to || 'global',
        text: text ? escapeHtml(text) : null,
        file: file || null,
        replyTo: replyTo || null,
        timestamp: Date.now(),
        avatar: db.users.get(req.user.username)?.avatar || '😊',
        edited: false,
        reactions: []
    };

    db.messages.push(message);
    deliverMessage(message);

    console.log(`💬 ${req.user.username} -> ${message.to}`);

    res.status(201).json({ success: true, message });
});

app.put('/api/messages/:id', authenticateToken, (req, res) => {
    const message = db.messages.find(m => m.id === req.params.id);
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (message.from !== req.user.username) return res.status(403).json({ error: 'Нельзя редактировать чужие сообщения' });

    message.text = escapeHtml(req.body.text);
    message.edited = true;
    message.editedAt = Date.now();

    broadcastToRoom(message.to, {
        type: 'message_edited',
        messageId: message.id,
        newText: message.text,
        editedAt: message.editedAt
    });

    res.json({ success: true, message: 'Сообщение отредактировано' });
});

app.delete('/api/messages/:id', authenticateToken, (req, res) => {
    const message = db.messages.find(m => m.id === req.params.id);
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (message.from !== req.user.username && db.users.get(req.user.username)?.role !== 'admin') {
        return res.status(403).json({ error: 'Нельзя удалить это сообщение' });
    }

    message.deleted = true;
    message.deletedAt = Date.now();

    broadcastToRoom(message.to, {
        type: 'message_deleted',
        messageId: message.id
    });

    res.json({ success: true, message: 'Сообщение удалено' });
});

// ==================== БЛОКИРОВКА ====================

app.post('/api/users/:username/block', authenticateToken, (req, res) => {
    if (req.params.username === req.user.username) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
    if (!db.users.has(req.params.username)) return res.status(404).json({ error: 'Пользователь не найден' });

    if (!db.blockedUsers.has(req.user.username)) db.blockedUsers.set(req.user.username, new Set());
    db.blockedUsers.get(req.user.username).add(req.params.username);

    res.json({ success: true, message: `Пользователь ${req.params.username} заблокирован` });
});

app.delete('/api/users/:username/block', authenticateToken, (req, res) => {
    const blocked = db.blockedUsers.get(req.user.username);
    if (blocked) blocked.delete(req.params.username);
    res.json({ success: true, message: `Пользователь ${req.params.username} разблокирован` });
});

// ==================== АДМИН ====================

app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
    const allUsers = Array.from(db.users.values()).map(sanitizeUser);
    res.json({ users: allUsers, total: allUsers.length });
});

app.get('/api/admin/stats', authenticateToken, isAdmin, (req, res) => {
    res.json({
        totalUsers: db.users.size,
        onlineUsers: Array.from(db.users.values()).filter(u => u.status === 'online').length,
        totalMessages: db.messages.length,
        totalGroups: db.groups.size,
        totalChannels: db.channels.size,
        totalFiles: db.files.size,
        uptime: process.uptime(),
        memory: process.memoryUsage()
    });
});

// ==================== WEBSOCKET СЕРВЕР ====================
const clients = new Map();

wss.on('connection', (ws) => {
    let username = null;
    let rooms = new Set(['global']);
    const clientId = uuidv4();

    console.log(`🔌 Новое подключение: ${clientId}`);

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'Подключено к NexusGram',
        timestamp: Date.now()
    }));

    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            switch (msg.type) {
                case 'auth':
                    jwt.verify(msg.token, CONFIG.JWT_SECRET, (err, decoded) => {
                        if (err) {
                            ws.send(JSON.stringify({ type: 'error', text: 'Ошибка авторизации' }));
                            return;
                        }
                        if (!db.users.has(decoded.username)) {
                            ws.send(JSON.stringify({ type: 'error', text: 'Пользователь не найден' }));
                            return;
                        }

                        username = decoded.username;
                        const user = db.users.get(username);
                        user.status = 'online';
                        user.lastSeen = null;

                        clients.set(ws, { username, rooms, clientId, lastActivity: Date.now() });

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            username,
                            user: sanitizeUser(user),
                            timestamp: Date.now()
                        }));

                        // Непрочитанные сообщения
                        const unreadMessages = db.messages
                            .filter(msg => {
                                const isRelevant = msg.to === 'global' || msg.to === username || msg.from === username;
                                return isRelevant && !msg.readBy?.has(username);
                            })
                            .slice(-50);

                        if (unreadMessages.length > 0) {
                            ws.send(JSON.stringify({
                                type: 'unread_messages',
                                messages: unreadMessages,
                                count: unreadMessages.length
                            }));
                        }

                        broadcastToAll({
                            type: 'user_status',
                            username,
                            status: 'online'
                        });

                        console.log(`✅ WebSocket авторизация: ${username}`);
                    });
                    break;

                case 'message':
                    if (!username) return;

                    const user = db.users.get(username);
                    if (!user) return;

                    const message = {
                        id: uuidv4(),
                        type: msg.file ? 'file' : 'message',
                        from: username,
                        to: msg.to || 'global',
                        text: msg.text ? escapeHtml(msg.text) : null,
                        file: msg.file || null,
                        replyTo: msg.replyTo || null,
                        timestamp: Date.now(),
                        avatar: user.avatar,
                        edited: false,
                        reactions: []
                    };

                    db.messages.push(message);
                    deliverMessage(message);

                    if (clients.has(ws)) {
                        clients.get(ws).lastActivity = Date.now();
                    }
                    break;

                case 'typing':
                    if (!username) return;
                    broadcastToRoom(msg.to || 'global', {
                        type: 'typing',
                        from: username,
                        to: msg.to || 'global',
                        timestamp: Date.now()
                    }, username);
                    break;

                case 'join_room':
                    if (!username) return;
                    rooms.add(msg.room);
                    break;

                case 'leave_room':
                    if (!username) return;
                    rooms.delete(msg.room);
                    break;

                case 'call_offer':
                case 'call_answer':
                case 'ice_candidate':
                case 'call_end':
                    if (!username) return;
                    sendToUser(msg.target, { ...msg, from: username });
                    break;

                default:
                    console.log(`❓ Неизвестный тип: ${msg.type}`);
            }
        } catch (error) {
            console.error('❌ Ошибка WebSocket:', error);
        }
    });

    ws.on('close', () => {
        if (username) {
            const user = db.users.get(username);
            if (user) {
                user.status = 'offline';
                user.lastSeen = new Date().toISOString();
            }
            clients.delete(ws);

            broadcastToAll({
                type: 'user_status',
                username,
                status: 'offline',
                lastSeen: user?.lastSeen
            });

            console.log(`👋 ${username} отключился`);
        }
    });

    ws.on('error', (error) => {
        console.error(`❌ Ошибка WebSocket для ${username || clientId}:`, error);
    });
});

// Пинг-понг
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ====================

function deliverMessage(message) {
    const payload = JSON.stringify(message);
    clients.forEach((client, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            const shouldReceive = message.to === 'global' ||
                                  message.to === client.username ||
                                  message.from === client.username ||
                                  client.rooms.has(message.to);
            if (shouldReceive) ws.send(payload);
        }
    });
}

function broadcastToRoom(room, data, excludeUsername = null) {
    const payload = JSON.stringify(data);
    clients.forEach((client, ws) => {
        if (ws.readyState === WebSocket.OPEN &&
            client.username !== excludeUsername &&
            client.rooms.has(room)) {
            ws.send(payload);
        }
    });
}

function broadcastToAll(data, excludeUsername = null) {
    const payload = JSON.stringify(data);
    clients.forEach((client, ws) => {
        if (ws.readyState === WebSocket.OPEN && client.username !== excludeUsername) {
            ws.send(payload);
        }
    });
}

function sendToUser(username, data) {
    const payload = JSON.stringify(data);
    clients.forEach((client, ws) => {
        if (ws.readyState === WebSocket.OPEN && client.username === username) {
            ws.send(payload);
        }
    });
}

// ==================== ЗАПУСК СЕРВЕРА ====================
server.listen(CONFIG.PORT, () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║        🚀 NEXUSGRAM СЕРВЕР ЗАПУЩЕН          ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Порт:          ${CONFIG.PORT}                        ║`);
    console.log(`║  Время:         ${new Date().toISOString()} ║`);
    console.log('║  Статус:        ✅ Онлайн                    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`\n📊 Пользователей: ${db.users.size}`);
    console.log(`💬 Групп: ${db.groups.size}`);
    console.log(`📢 Каналов: ${db.channels.size}`);
    console.log(`\n👑 Тестовые аккаунты:`);
    console.log('   admin / admin123');
    console.log('   alice / alice123');
    console.log('   bob / bob123');
    console.log('   charlie / charlie123\n');
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Завершение работы...');
    db.backup();
    server.close(() => process.exit(0));
});

process.on('SIGINT', () => {
    console.log('🛑 Завершение работы...');
    db.backup();
    server.close(() => process.exit(0));
});

module.exports = { app, server, db, CONFIG };
