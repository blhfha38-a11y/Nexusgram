// ╔══════════════════════════════════════════════════════════╗
// ║            NEXUSGRAM - МЕССЕНДЖЕР СЕРВЕР                ║
// ║            Version 2.0 - Production Ready               ║
// ╚══════════════════════════════════════════════════════════╝

const express = require('express');
const http = require('http');
const https = require('https');
const { WebSocketServer, WebSocket } = require('ws');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

// ==================== КОНФИГУРАЦИЯ ====================
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const CONFIG = {
    PORT: process.env.PORT || 10000,
    JWT_SECRET: process.env.JWT_SECRET || 'nexusgram-super-mega-ultra-secret-key-2024',
    JWT_EXPIRES_IN: '7d',
    MAX_MESSAGE_LENGTH: 5000,
    MAX_FILE_SIZE: 50 * 1024 * 1024, // 50MB
    MAX_HISTORY_MESSAGES: 5000,
    MAX_ROOMS_PER_USER: 50,
    RATE_LIMIT_WINDOW: 60000, // 1 минута
    RATE_LIMIT_MAX_REQUESTS: 100,
    UPLOAD_DIR: path.join(__dirname, 'uploads'),
    AVATAR_SIZES: [64, 128, 256],
    TYPING_TIMEOUT: 3000,
    ONLINE_TIMEOUT: 60000,
    CLEANUP_INTERVAL: 300000, // 5 минут
    BACKUP_INTERVAL: 3600000, // 1 час
};

// ==================== MIDDLEWARE ====================
app.use(cors({
    origin: ['https://nexusgram-67.netlify.app', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Логирование запросов
app.use((req, res, next) => {
    const start = Date.now();
    const { method, url } = req;
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const { statusCode } = res;
        let color = '\x1b[32m'; // зеленый
        
        if (statusCode >= 400) color = '\x1b[33m'; // желтый
        if (statusCode >= 500) color = '\x1b[31m'; // красный
        
        console.log(`${color}${method} ${url} ${statusCode} ${duration}ms\x1b[0m`);
    });
    
    next();
});

// Rate limiting
const rateLimit = new Map();
app.use((req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    
    if (!rateLimit.has(ip)) {
        rateLimit.set(ip, []);
    }
    
    const requests = rateLimit.get(ip);
    const recentRequests = requests.filter(time => now - time < CONFIG.RATE_LIMIT_WINDOW);
    
    if (recentRequests.length >= CONFIG.RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({ error: 'Слишком много запросов. Попробуйте позже.' });
    }
    
    recentRequests.push(now);
    rateLimit.set(ip, recentRequests);
    next();
});

// ==================== ХРАНИЛИЩЕ ДАННЫХ ====================
class DataStore {
    constructor() {
        this.users = new Map();
        this.messages = [];
        this.groups = new Map();
        this.channels = new Map();
        this.sessions = new Map();
        this.files = new Map();
        this.blockedUsers = new Map();
        this.userReports = new Map();
        this.voiceMessages = new Map();
        this.stickers = new Map();
        this.bots = new Map();
        this.polls = new Map();
        this.reactions = new Map();
        this.readReceipts = new Map();
        this.userSettings = new Map();
        
        this.initializeDefaults();
    }
    
    initializeDefaults() {
        // Создаем админа
        const adminPassword = bcrypt.hashSync('admin123', 10);
        this.users.set('admin', {
            id: uuidv4(),
            username: 'admin',
            password: adminPassword,
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
            settings: {
                notifications: true,
                theme: 'dark',
                language: 'ru',
                privacy: 'contacts'
            }
        });
        
        // Создаем тестовых пользователей
        const testUsers = [
            { username: 'alice', password: 'alice123', avatar: '🌸', bio: 'Люблю котиков и программирование' },
            { username: 'bob', password: 'bob123', avatar: '🚀', bio: 'Космический разработчик' },
            { username: 'charlie', password: 'charlie123', avatar: '🎸', bio: 'Музыкант и дизайнер' },
        ];
        
        testUsers.forEach(user => {
            const hash = bcrypt.hashSync(user.password, 10);
            this.users.set(user.username, {
                id: uuidv4(),
                username: user.username,
                password: hash,
                avatar: user.avatar,
                status: 'offline',
                bio: user.bio,
                phone: null,
                email: `${user.username}@nexusgram.com`,
                createdAt: new Date().toISOString(),
                lastSeen: null,
                isVerified: true,
                isPremium: false,
                role: 'user',
                settings: {
                    notifications: true,
                    theme: 'dark',
                    language: 'ru',
                    privacy: 'everyone'
                }
            });
        });
        
        // Создаем каналы
        this.channels.set('news', {
            id: uuidv4(),
            name: '📢 Новости NexusGram',
            admin: 'admin',
            subscribers: new Set(['admin', 'alice', 'bob']),
            description: 'Официальный канал новостей и обновлений NexusGram',
            createdAt: new Date().toISOString(),
            avatar: '📰',
            isVerified: true,
            memberCount: 3
        });
        
        this.channels.set('tech', {
            id: uuidv4(),
            name: '💻 Технологии',
            admin: 'admin',
            subscribers: new Set(['admin', 'bob', 'charlie']),
            description: 'Новости технологий, программирование, AI',
            createdAt: new Date().toISOString(),
            avatar: '🔧',
            isVerified: true,
            memberCount: 3
        });
        
        // Создаем группы
        this.groups.set('general', {
            id: uuidv4(),
            name: '💬 Общий чат',
            members: new Set(['admin', 'alice', 'bob', 'charlie']),
            admins: new Set(['admin']),
            description: 'Общий чат для всех пользователей',
            createdAt: new Date().toISOString(),
            avatar: '👥',
            isPublic: true
        });
        
        this.groups.set('developers', {
            id: uuidv4(),
            name: '👨‍💻 Разработчики',
            members: new Set(['admin', 'bob']),
            admins: new Set(['bob']),
            description: 'Обсуждаем разработку NexusGram',
            createdAt: new Date().toISOString(),
            avatar: '⚡',
            isPublic: true
        });
        
        // Инициализируем стикеры
        this.stickers.set('default', {
            id: 'default',
            name: 'Стандартные',
            stickers: ['👍', '❤️', '😂', '😮', '😢', '😡', '🎉', '💩', '🔥', '💯']
        });
    }
    
    // Бэкап данных
    backup() {
        const data = {
            users: Array.from(this.users.entries()),
            messages: this.messages.slice(-10000),
            groups: Array.from(this.groups.entries()),
            channels: Array.from(this.channels.entries()),
            timestamp: new Date().toISOString()
        };
        
        try {
            fs.writeFileSync(
                path.join(__dirname, 'backup.json'),
                JSON.stringify(data, (key, value) => {
                    if (value instanceof Set) return Array.from(value);
                    if (value instanceof Map) return Array.from(value.entries());
                    return value;
                }, 2)
            );
            console.log('✅ Бэкап создан успешно');
        } catch (error) {
            console.error('❌ Ошибка создания бэкапа:', error);
        }
    }
    
    // Восстановление из бэкапа
    restore() {
        try {
            if (fs.existsSync(path.join(__dirname, 'backup.json'))) {
                const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'backup.json'), 'utf8'));
                
                this.users = new Map(data.users);
                this.groups = new Map(data.groups);
                this.channels = new Map(data.channels);
                
                // Восстанавливаем Set'ы
                this.groups.forEach(group => {
                    group.members = new Set(group.members);
                    group.admins = new Set(group.admins);
                });
                
                this.channels.forEach(channel => {
                    channel.subscribers = new Set(channel.subscribers);
                });
                
                console.log('✅ Данные восстановлены из бэкапа');
            }
        } catch (error) {
            console.error('❌ Ошибка восстановления из бэкапа:', error);
        }
    }
}

const db = new DataStore();

// Пытаемся восстановить данные
db.restore();

// Периодический бэкап
setInterval(() => db.backup(), CONFIG.BACKUP_INTERVAL);

// Очистка старых данных
setInterval(() => {
    // Очистка старых сообщений
    if (db.messages.length > CONFIG.MAX_HISTORY_MESSAGES) {
        db.messages = db.messages.slice(-CONFIG.MAX_HISTORY_MESSAGES);
    }
    
    // Очистка rate limit
    const now = Date.now();
    rateLimit.forEach((requests, ip) => {
        const recent = requests.filter(time => now - time < CONFIG.RATE_LIMIT_WINDOW);
        if (recent.length === 0) {
            rateLimit.delete(ip);
        } else {
            rateLimit.set(ip, recent);
        }
    });
}, CONFIG.CLEANUP_INTERVAL);

// ==================== УТИЛИТЫ ====================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ error: 'Токен не предоставлен' });
    }
    
    jwt.verify(token, CONFIG.JWT_SECRET, (err, decoded) => {
        if (err) {
            return res.status(403).json({ error: 'Недействительный или истекший токен' });
        }
        
        if (!db.users.has(decoded.username)) {
            return res.status(404).json({ error: 'Пользователь не найден' });
        }
        
        req.user = decoded;
        next();
    });
};

const isAdmin = (req, res, next) => {
    const user = db.users.get(req.user.username);
    if (!user || user.role !== 'admin') {
        return res.status(403).json({ error: 'Доступ запрещен. Требуются права администратора' });
    }
    next();
};

function generateToken(username) {
    return jwt.sign(
        { 
            username, 
            iat: Math.floor(Date.now() / 1000),
            jti: uuidv4()
        }, 
        CONFIG.JWT_SECRET, 
        { expiresIn: CONFIG.JWT_EXPIRES_IN }
    );
}

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

function escapeHtml(text) {
    if (!text) return '';
    const map = {
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    };
    return text.replace(/[&<>"']/g, m => map[m]);
}

function containsBadWords(text) {
    const badWords = ['спам', 'реклама', 'badword1', 'badword2'];
    const lowerText = text.toLowerCase();
    return badWords.some(word => lowerText.includes(word));
}

// ==================== ЗАГРУЗКА ФАЙЛОВ ====================
if (!fs.existsSync(CONFIG.UPLOAD_DIR)) {
    fs.mkdirSync(CONFIG.UPLOAD_DIR, { recursive: true });
}

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
            'application/pdf', 'application/zip', 'application/json',
            'text/plain', 'text/html'
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

// Информация о сервере
app.get('/api/status', (req, res) => {
    res.json({
        name: 'NexusGram API',
        version: '2.0.0',
        status: 'online',
        uptime: process.uptime(),
        users: db.users.size,
        online: Array.from(db.users.values()).filter(u => u.status === 'online').length,
        messages: db.messages.length,
        groups: db.groups.size,
        channels: db.channels.size,
        memory: process.memoryUsage(),
        timestamp: new Date().toISOString()
    });
});

// ==================== АВТОРИЗАЦИЯ ====================

// Регистрация
app.post('/api/register', async (req, res) => {
    try {
        const { username, password, avatar, bio } = req.body;
        
        // Валидация
        if (!username || !password) {
            return res.status(400).json({ error: 'Логин и пароль обязательны' });
        }
        
        if (username.length < 3 || username.length > 30) {
            return res.status(400).json({ error: 'Логин должен быть от 3 до 30 символов' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ error: 'Пароль должен быть минимум 6 символов' });
        }
        
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({ error: 'Логин может содержать только буквы, цифры и подчеркивания' });
        }
        
        if (db.users.has(username)) {
            return res.status(400).json({ error: 'Пользователь уже существует' });
        }
        
        const hash = await bcrypt.hash(password, 12);
        const newUser = {
            id: uuidv4(),
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
            settings: {
                notifications: true,
                theme: 'dark',
                language: 'ru',
                privacy: 'everyone'
            }
        };
        
        db.users.set(username, newUser);
        
        // Добавляем в общий чат
        if (db.groups.has('general')) {
            db.groups.get('general').members.add(username);
        }
        
        console.log(`✅ Новый пользователь: ${username}`);
        
        const token = generateToken(username);
        
        res.status(201).json({
            success: true,
            message: 'Регистрация успешна! Добро пожаловать в NexusGram!',
            token,
            user: sanitizeUser(newUser)
        });
        
    } catch (error) {
        console.error('Ошибка регистрации:', error);
        res.status(500).json({ error: 'Ошибка сервера при регистрации' });
    }
});

// Вход
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        if (!username || !password) {
            return res.status(400).json({ error: 'Логин и пароль обязательны' });
        }
        
        const user = db.users.get(username);
        
        if (!user) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            return res.status(401).json({ error: 'Неверный логин или пароль' });
        }
        
        const token = generateToken(username);
        user.lastLogin = new Date().toISOString();
        
        console.log(`🔑 Вход пользователя: ${username}`);
        
        res.json({
            success: true,
            message: 'Вход выполнен успешно!',
            token,
            user: sanitizeUser(user)
        });
        
    } catch (error) {
        console.error('Ошибка входа:', error);
        res.status(500).json({ error: 'Ошибка сервера при входе' });
    }
});

// Обновление токена
app.post('/api/refresh-token', authenticateToken, (req, res) => {
    const token = generateToken(req.user.username);
    res.json({ success: true, token });
});

// Выход
app.post('/api/logout', authenticateToken, (req, res) => {
    const user = db.users.get(req.user.username);
    if (user) {
        user.status = 'offline';
        user.lastSeen = new Date().toISOString();
    }
    
    // Отключаем WebSocket
    const client = Array.from(clients.entries()).find(([ws, info]) => info.username === req.user.username);
    if (client) {
        client[0].close();
    }
    
    res.json({ success: true, message: 'Вы вышли из системы' });
});

// ==================== ПРОФИЛЬ ====================

// Получить свой профиль
app.get('/api/profile/me', authenticateToken, (req, res) => {
    const user = db.users.get(req.user.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    res.json(sanitizeUser(user));
});

// Получить профиль пользователя
app.get('/api/profile/:username', authenticateToken, (req, res) => {
    const user = db.users.get(req.params.username);
    if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
    
    const profile = sanitizeUser(user);
    
    // Проверяем, не заблокирован ли пользователь
    if (db.blockedUsers.has(req.user.username)) {
        const blocked = db.blockedUsers.get(req.user.username);
        if (blocked.has(req.params.username)) {
            return res.status(403).json({ error: 'Вы заблокировали этого пользователя' });
        }
    }
    
    res.json(profile);
});

// Обновить профиль
app.put('/api/profile', authenticateToken, async (req, res) => {
    try {
        const user = db.users.get(req.user.username);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        
        const { bio, avatar, phone, email, settings } = req.body;
        
        if (bio !== undefined) user.bio = escapeHtml(bio);
        if (avatar !== undefined) user.avatar = avatar;
        if (phone !== undefined) user.phone = phone;
        if (email !== undefined) user.email = email;
        if (settings !== undefined) user.settings = { ...user.settings, ...settings };
        
        console.log(`✏️ Профиль обновлен: ${req.user.username}`);
        
        // Уведомляем всех об обновлении профиля
        broadcastToAll({
            type: 'profile_updated',
            username: req.user.username,
            user: sanitizeUser(user)
        });
        
        res.json({
            success: true,
            message: 'Профиль обновлен',
            user: sanitizeUser(user)
        });
        
    } catch (error) {
        console.error('Ошибка обновления профиля:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Загрузить аватар
app.post('/api/profile/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        
        const user = db.users.get(req.user.username);
        if (!user) return res.status(404).json({ error: 'Пользователь не найден' });
        
        // Создаем разные размеры аватара
        const avatarPath = req.file.path;
        const avatarUrl = `/uploads/images/${req.file.filename}`;
        
        // Сохраняем информацию о файле
        db.files.set(req.file.filename, {
            originalName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
            path: avatarPath,
            uploadedBy: req.user.username,
            uploadedAt: new Date().toISOString()
        });
        
        user.avatar = avatarUrl;
        
        res.json({
            success: true,
            avatar: avatarUrl,
            message: 'Аватар обновлен'
        });
        
    } catch (error) {
        console.error('Ошибка загрузки аватара:', error);
        res.status(500).json({ error: 'Ошибка загрузки аватара' });
    }
});

// ==================== ПОИСК ====================

// Умный поиск
app.get('/api/search', authenticateToken, (req, res) => {
    try {
        const query = req.query.q?.toLowerCase().trim();
        if (!query || query.length < 2) {
            return res.json({ users: [], messages: [], groups: [], channels: [] });
        }
        
        // Поиск пользователей
        const foundUsers = [];
        db.users.forEach((user, username) => {
            if (username === req.user.username) return;
            
            const searchStr = `${username} ${user.bio || ''} ${user.email || ''} ${user.phone || ''}`.toLowerCase();
            if (searchStr.includes(query)) {
                foundUsers.push(sanitizeUser(user));
            }
        });
        
        // Поиск сообщений
        const foundMessages = db.messages.filter(msg => {
            const isRelevant = msg.to === 'global' || 
                              msg.to === req.user.username || 
                              msg.from === req.user.username ||
                              (db.groups.has(msg.to) && db.groups.get(msg.to).members.has(req.user.username));
            
            return isRelevant && msg.text && msg.text.toLowerCase().includes(query);
        }).slice(-100);
        
        // Поиск групп
        const foundGroups = [];
        db.groups.forEach((group, name) => {
            if (group.name.toLowerCase().includes(query) || 
                group.description?.toLowerCase().includes(query)) {
                foundGroups.push({
                    name,
                    ...group,
                    members: Array.from(group.members),
                    memberCount: group.members.size
                });
            }
        });
        
        // Поиск каналов
        const foundChannels = [];
        db.channels.forEach((channel, name) => {
            if (channel.name.toLowerCase().includes(query) || 
                channel.description?.toLowerCase().includes(query)) {
                foundChannels.push({
                    name,
                    ...channel,
                    subscribers: Array.from(channel.subscribers),
                    subscriberCount: channel.subscribers.size
                });
            }
        });
        
        res.json({
            query,
            users: foundUsers.slice(0, 20),
            messages: foundMessages.slice(0, 50),
            groups: foundGroups.slice(0, 10),
            channels: foundChannels.slice(0, 10),
            total: foundUsers.length + foundMessages.length + foundGroups.length + foundChannels.length
        });
        
    } catch (error) {
        console.error('Ошибка поиска:', error);
        res.status(500).json({ error: 'Ошибка сервера при поиске' });
    }
});

// ==================== ГРУППЫ ====================

// Создать группу
app.post('/api/groups', authenticateToken, (req, res) => {
    try {
        const { name, description, avatar } = req.body;
        
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Название группы должно быть минимум 2 символа' });
        }
        
        const groupName = name.trim();
        
        if (db.groups.has(groupName)) {
            return res.status(400).json({ error: 'Группа с таким названием уже существует' });
        }
        
        const newGroup = {
            id: uuidv4(),
            name: groupName,
            members: new Set([req.user.username]),
            admins: new Set([req.user.username]),
            description: description || '',
            avatar: avatar || '👥',
            createdAt: new Date().toISOString(),
            isPublic: true,
            memberCount: 1,
            settings: {
                joinByLink: true,
                sendMessages: 'all',
                inviteUsers: 'all'
            }
        };
        
        db.groups.set(groupName, newGroup);
        
        console.log(`👥 Группа создана: ${groupName} пользователем ${req.user.username}`);
        
        // Уведомляем создателя
        sendToUser(req.user.username, {
            type: 'group_created',
            group: {
                name: groupName,
                members: Array.from(newGroup.members),
                ...newGroup
            }
        });
        
        res.status(201).json({
            success: true,
            message: 'Группа создана успешно',
            group: {
                name: groupName,
                members: Array.from(newGroup.members),
                ...newGroup
            }
        });
        
    } catch (error) {
        console.error('Ошибка создания группы:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Получить список групп
app.get('/api/groups', authenticateToken, (req, res) => {
    const userGroups = [];
    db.groups.forEach((group, name) => {
        if (group.members.has(req.user.username)) {
            userGroups.push({
                name,
                ...group,
                members: Array.from(group.members),
                memberCount: group.members.size
            });
        }
    });
    
    res.json({ groups: userGroups, total: userGroups.length });
});

// Присоединиться к группе
app.post('/api/groups/:name/join', authenticateToken, (req, res) => {
    const group = db.groups.get(req.params.name);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    
    if (!group.isPublic && !group.members.has(req.user.username)) {
        return res.status(403).json({ error: 'Группа приватная' });
    }
    
    group.members.add(req.user.username);
    group.memberCount = group.members.size;
    
    // Уведомляем участников
    broadcastToRoom(req.params.name, {
        type: 'user_joined',
        username: req.user.username,
        room: req.params.name,
        timestamp: Date.now()
    });
    
    res.json({ success: true, message: 'Вы присоединились к группе' });
});

// Покинуть группу
app.post('/api/groups/:name/leave', authenticateToken, (req, res) => {
    const group = db.groups.get(req.params.name);
    if (!group) return res.status(404).json({ error: 'Группа не найдена' });
    
    if (!group.members.has(req.user.username)) {
        return res.status(400).json({ error: 'Вы не состоите в этой группе' });
    }
    
    group.members.delete(req.user.username);
    group.memberCount = group.members.size;
    
    // Если админ покидает группу
    if (group.admins.has(req.user.username)) {
        group.admins.delete(req.user.username);
        // Назначаем нового админа, если есть другие участники
        if (group.members.size > 0) {
            const newAdmin = Array.from(group.members)[0];
            group.admins.add(newAdmin);
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

// Создать канал
app.post('/api/channels', authenticateToken, (req, res) => {
    try {
        const { name, description, avatar } = req.body;
        
        if (!name || name.trim().length < 2) {
            return res.status(400).json({ error: 'Название канала должно быть минимум 2 символа' });
        }
        
        const channelName = name.trim();
        
        if (db.channels.has(channelName)) {
            return res.status(400).json({ error: 'Канал с таким названием уже существует' });
        }
        
        const newChannel = {
            id: uuidv4(),
            name: channelName,
            admin: req.user.username,
            subscribers: new Set([req.user.username]),
            description: description || '',
            avatar: avatar || '📢',
            createdAt: new Date().toISOString(),
            isVerified: false,
            subscriberCount: 1
        };
        
        db.channels.set(channelName, newChannel);
        
        console.log(`📢 Канал создан: ${channelName}`);
        
        res.status(201).json({
            success: true,
            message: 'Канал создан успешно',
            channel: {
                name: channelName,
                ...newChannel,
                subscribers: Array.from(newChannel.subscribers)
            }
        });
        
    } catch (error) {
        console.error('Ошибка создания канала:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Подписаться на канал
app.post('/api/channels/:name/subscribe', authenticateToken, (req, res) => {
    const channel = db.channels.get(req.params.name);
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    
    channel.subscribers.add(req.user.username);
    channel.subscriberCount = channel.subscribers.size;
    
    res.json({ 
        success: true, 
        message: 'Вы подписались на канал',
        subscriberCount: channel.subscriberCount
    });
});

// Отписаться от канала
app.post('/api/channels/:name/unsubscribe', authenticateToken, (req, res) => {
    const channel = db.channels.get(req.params.name);
    if (!channel) return res.status(404).json({ error: 'Канал не найден' });
    
    channel.subscribers.delete(req.user.username);
    channel.subscriberCount = channel.subscribers.size;
    
    res.json({ 
        success: true, 
        message: 'Вы отписались от канала',
        subscriberCount: channel.subscriberCount
    });
});

// ==================== ЗАГРУЗКА ФАЙЛОВ ====================

// Загрузить файл
app.post('/api/upload', authenticateToken, upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'Файл не загружен' });
        }
        
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
        
        console.log(`📁 Файл загружен: ${req.file.originalname} (${req.file.size} байт)`);
        
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
        
    } catch (error) {
        console.error('Ошибка загрузки файла:', error);
        res.status(500).json({ error: 'Ошибка загрузки файла' });
    }
});

// Получить файл
app.get('/api/files/:id', authenticateToken, (req, res) => {
    const file = db.files.get(req.params.id);
    if (!file) return res.status(404).json({ error: 'Файл не найден' });
    
    res.json(file);
});

// Скачать файл
app.get('/uploads/:type/:filename', (req, res) => {
    const filePath = path.join(CONFIG.UPLOAD_DIR, req.params.type, req.params.filename);
    if (fs.existsSync(filePath)) {
        res.sendFile(filePath);
    } else {
        res.status(404).json({ error: 'Файл не найден' });
    }
});

// ==================== СООБЩЕНИЯ ====================

// Получить историю сообщений
app.get('/api/messages/:room', authenticateToken, (req, res) => {
    const { room } = req.params;
    const { limit = 100, before } = req.query;
    
    let roomMessages = db.messages.filter(msg => msg.to === room);
    
    if (before) {
        roomMessages = roomMessages.filter(msg => msg.timestamp < parseInt(before));
    }
    
    roomMessages = roomMessages.slice(-parseInt(limit));
    
    res.json({
        room,
        messages: roomMessages,
        hasMore: roomMessages.length === parseInt(limit)
    });
});

// Отправить сообщение через REST (альтернатива WebSocket)
app.post('/api/messages', authenticateToken, (req, res) => {
    try {
        const { text, to, replyTo, file } = req.body;
        
        if (!text && !file) {
            return res.status(400).json({ error: 'Сообщение не может быть пустым' });
        }
        
        if (text && text.length > CONFIG.MAX_MESSAGE_LENGTH) {
            return res.status(400).json({ error: 'Сообщение слишком длинное' });
        }
        
        if (containsBadWords(text)) {
            return res.status(400).json({ error: 'Сообщение содержит запрещенные слова' });
        }
        
        const message = {
            id: uuidv4(),
            type: 'message',
            from: req.user.username,
            to: to || 'global',
            text: escapeHtml(text),
            replyTo: replyTo || null,
            file: file || null,
            timestamp: Date.now(),
            avatar: db.users.get(req.user.username)?.avatar || '😊',
            edited: false,
            deleted: false,
            reactions: [],
            readBy: new Set([req.user.username])
        };
        
        db.messages.push(message);
        
        // Отправляем через WebSocket
        deliverMessage(message);
        
        console.log(`💬 Сообщение от ${req.user.username} в ${message.to}`);
        
        res.status(201).json({
            success: true,
            message
        });
        
    } catch (error) {
        console.error('Ошибка отправки сообщения:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Редактировать сообщение
app.put('/api/messages/:id', authenticateToken, (req, res) => {
    const message = db.messages.find(m => m.id === req.params.id);
    
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (message.from !== req.user.username) return res.status(403).json({ error: 'Вы не можете редактировать чужие сообщения' });
    
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

// Удалить сообщение
app.delete('/api/messages/:id', authenticateToken, (req, res) => {
    const message = db.messages.find(m => m.id === req.params.id);
    
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    if (message.from !== req.user.username && db.users.get(req.user.username)?.role !== 'admin') {
        return res.status(403).json({ error: 'Вы не можете удалить это сообщение' });
    }
    
    message.deleted = true;
    message.deletedAt = Date.now();
    
    broadcastToRoom(message.to, {
        type: 'message_deleted',
        messageId: message.id
    });
    
    res.json({ success: true, message: 'Сообщение удалено' });
});

// Реакции на сообщения
app.post('/api/messages/:id/reactions', authenticateToken, (req, res) => {
    const message = db.messages.find(m => m.id === req.params.id);
    if (!message) return res.status(404).json({ error: 'Сообщение не найдено' });
    
    const { reaction } = req.body;
    
    if (!message.reactions) message.reactions = [];
    
    // Удаляем предыдущую реакцию этого пользователя
    message.reactions = message.reactions.filter(r => r.username !== req.user.username);
    
    // Добавляем новую реакцию
    message.reactions.push({
        username: req.user.username,
        reaction,
        timestamp: Date.now()
    });
    
    broadcastToRoom(message.to, {
        type: 'message_reaction',
        messageId: message.id,
        reactions: message.reactions
    });
    
    res.json({ success: true, reactions: message.reactions });
});

// ==================== СТИКЕРЫ ====================

// Получить наборы стикеров
app.get('/api/stickers', authenticateToken, (req, res) => {
    const stickersArray = Array.from(db.stickers.values());
    res.json({ stickers: stickersArray });
});

// Получить конкретный набор
app.get('/api/stickers/:id', authenticateToken, (req, res) => {
    const pack = db.stickers.get(req.params.id);
    if (!pack) return res.status(404).json({ error: 'Набор стикеров не найден' });
    res.json(pack);
});

// ==================== ОПРОСЫ ====================

// Создать опрос
app.post('/api/polls', authenticateToken, (req, res) => {
    try {
        const { question, options, to } = req.body;
        
        if (!question || !options || options.length < 2) {
            return res.status(400).json({ error: 'Некорректные данные опроса' });
        }
        
        const poll = {
            id: uuidv4(),
            question,
            options: options.map(opt => ({ text: opt, votes: 0, voters: [] })),
            createdBy: req.user.username,
            to: to || 'global',
            createdAt: Date.now(),
            isClosed: false,
            totalVotes: 0
        };
        
        db.polls.set(poll.id, poll);
        
        // Отправляем как сообщение
        const message = {
            id: uuidv4(),
            type: 'poll',
            from: req.user.username,
            to: to || 'global',
            poll: poll,
            timestamp: Date.now(),
            avatar: db.users.get(req.user.username)?.avatar || '😊'
        };
        
        db.messages.push(message);
        deliverMessage(message);
        
        res.status(201).json({ success: true, poll, message });
        
    } catch (error) {
        console.error('Ошибка создания опроса:', error);
        res.status(500).json({ error: 'Ошибка сервера' });
    }
});

// Голосовать в опросе
app.post('/api/polls/:id/vote', authenticateToken, (req, res) => {
    const poll = db.polls.get(req.params.id);
    if (!poll) return res.status(404).json({ error: 'Опрос не найден' });
    if (poll.isClosed) return res.status(400).json({ error: 'Опрос закрыт' });
    
    const { optionIndex } = req.body;
    
    if (optionIndex < 0 || optionIndex >= poll.options.length) {
        return res.status(400).json({ error: 'Неверный вариант ответа' });
    }
    
    // Проверяем, голосовал ли уже пользователь
    const hasVoted = poll.options.some(opt => opt.voters.includes(req.user.username));
    if (hasVoted) {
        return res.status(400).json({ error: 'Вы уже проголосовали' });
    }
    
    poll.options[optionIndex].votes++;
    poll.options[optionIndex].voters.push(req.user.username);
    poll.totalVotes++;
    
    // Уведомляем о обновлении опроса
    broadcastToRoom(poll.to, {
        type: 'poll_updated',
        pollId: poll.id,
        poll: poll
    });
    
    res.json({ success: true, poll });
});

// ==================== БЛОКИРОВКА ПОЛЬЗОВАТЕЛЕЙ ====================

// Заблокировать пользователя
app.post('/api/users/:username/block', authenticateToken, (req, res) => {
    if (req.params.username === req.user.username) {
        return res.status(400).json({ error: 'Нельзя заблокировать самого себя' });
    }
    
    if (!db.users.has(req.params.username)) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    if (!db.blockedUsers.has(req.user.username)) {
        db.blockedUsers.set(req.user.username, new Set());
    }
    
    db.blockedUsers.get(req.user.username).add(req.params.username);
    
    res.json({ success: true, message: `Пользователь ${req.params.username} заблокирован` });
});

// Разблокировать пользователя
app.delete('/api/users/:username/block', authenticateToken, (req, res) => {
    const blocked = db.blockedUsers.get(req.user.username);
    if (blocked) {
        blocked.delete(req.params.username);
    }
    
    res.json({ success: true, message: `Пользователь ${req.params.username} разблокирован` });
});

// ==================== АДМИНИСТРАТИВНЫЕ ФУНКЦИИ ====================

// Получить список всех пользователей (админ)
app.get('/api/admin/users', authenticateToken, isAdmin, (req, res) => {
    const users = Array.from(db.users.values()).map(sanitizeUser);
    res.json({ users, total: users.length });
});

// Статистика сервера (админ)
app.get('/api/admin/stats', authenticateToken, isAdmin, (req, res) => {
    res.json({
        totalUsers: db.users.size,
        onlineUsers: Array.from(db.users.values()).filter(u => u.status === 'online').length,
        totalMessages: db.messages.length,
        totalGroups: db.groups.size,
        totalChannels: db.channels.size,
        totalFiles: db.files.size,
        totalPolls: db.polls.size,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage()
    });
});

// Очистить историю (админ)
app.post('/api/admin/clear-history', authenticateToken, isAdmin, (req, res) => {
    const count = db.messages.length;
    db.messages = [];
    console.log(`🗑️ История очищена администратором ${req.user.username}. Удалено ${count} сообщений`);
    res.json({ success: true, message: `Удалено ${count} сообщений` });
});

// ==================== WEBRTC СИГНАЛИНГ ====================

// Инициировать звонок
app.post('/api/call/start', authenticateToken, (req, res) => {
    const { target, type = 'audio' } = req.body;
    
    if (!db.users.has(target)) {
        return res.status(404).json({ error: 'Пользователь не найден' });
    }
    
    const targetUser = db.users.get(target);
    if (targetUser.status !== 'online') {
        return res.status(400).json({ error: 'Пользователь не в сети' });
    }
    
    const callId = uuidv4();
    
    // Отправляем приглашение целевому пользователю
    sendToUser(target, {
        type: 'incoming_call',
        callId,
        from: req.user.username,
        callType: type,
        timestamp: Date.now()
    });
    
    res.json({
        success: true,
        callId,
        message: `Звонок пользователю ${target}`
    });
});

// ==================== WebSocket СЕРВЕР ====================
const clients = new Map(); // ws -> { username, rooms, lastActivity }

wss.on('connection', (ws, req) => {
    const clientId = uuidv4();
    let username = null;
    let rooms = new Set(['global']);
    
    console.log(`🔌 Новое WebSocket подключение: ${clientId}`);
    
    // Отправляем приветствие
    ws.send(JSON.stringify({
        type: 'connected',
        clientId,
        message: 'Подключено к NexusGram',
        timestamp: Date.now()
    }));
    
    // Пинг-понг для поддержания соединения
    ws.isAlive = true;
    ws.on('pong', () => {
        ws.isAlive = true;
    });
    
    ws.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            switch (msg.type) {
                case 'auth':
                    handleAuth(ws, msg, clientId);
                    break;
                    
                case 'message':
                    if (!username) {
                        ws.send(JSON.stringify({ type: 'error', text: 'Не авторизован' }));
                        return;
                    }
                    handleChatMessage(ws, msg);
                    break;
                    
                case 'typing':
                    if (!username) return;
                    handleTyping(msg);
                    break;
                    
                case 'join_room':
                    if (!username) return;
                    rooms.add(msg.room);
                    console.log(`👤 ${username} присоединился к комнате ${msg.room}`);
                    break;
                    
                case 'leave_room':
                    if (!username) return;
                    rooms.delete(msg.room);
                    console.log(`👤 ${username} покинул комнату ${msg.room}`);
                    break;
                    
                // WebRTC сигналинг
                case 'call_offer':
                case 'call_answer':
                case 'ice_candidate':
                case 'call_end':
                    if (!username) return;
                    forwardToTarget(msg.target, {
                        ...msg,
                        from: username
                    });
                    break;
                    
                case 'read_receipt':
                    if (!username) return;
                    handleReadReceipt(msg);
                    break;
                    
                default:
                    console.log(`❓ Неизвестный тип сообщения: ${msg.type}`);
            }
            
        } catch (error) {
            console.error('❌ Ошибка обработки WebSocket сообщения:', error);
            ws.send(JSON.stringify({ 
                type: 'error', 
                text: 'Ошибка обработки сообщения',
                error: error.message 
            }));
        }
    });
    
    ws.on('close', () => {
        if (username) {
            console.log(`👋 Пользователь ${username} отключился`);
            const user = db.users.get(username);
            if (user) {
                user.status = 'offline';
                user.lastSeen = new Date().toISOString();
            }
            
            clients.delete(ws);
            
            // Уведомляем всех об оффлайн статусе
            broadcastToAll({
                type: 'user_status',
                username,
                status: 'offline',
                lastSeen: user?.lastSeen
            });
        }
    });
    
    ws.on('error', (error) => {
        console.error(`❌ WebSocket ошибка для ${username || clientId}:`, error);
    });
    
    function handleAuth(ws, msg, clientId) {
        jwt.verify(msg.token, CONFIG.JWT_SECRET, (err, decoded) => {
            if (err) {
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    text: 'Ошибка авторизации: недействительный токен' 
                }));
                return;
            }
            
            if (!db.users.has(decoded.username)) {
                ws.send(JSON.stringify({ 
                    type: 'error', 
                    text: 'Пользователь не найден' 
                }));
                return;
            }
            
            username = decoded.username;
            const user = db.users.get(username);
            user.status = 'online';
            user.lastSeen = null;
            
            clients.set(ws, { 
                username, 
                rooms, 
                clientId,
                lastActivity: Date.now() 
            });
            
            console.log(`✅ Пользователь авторизован через WebSocket: ${username}`);
            
            // Подтверждаем авторизацию
            ws.send(JSON.stringify({
                type: 'auth_success',
                username,
                user: sanitizeUser(user),
                timestamp: Date.now()
            }));
            
            // Отправляем непрочитанные сообщения
            sendUnreadMessages(ws, username);
            
            // Уведомляем всех об онлайн статусе
            broadcastToAll({
                type: 'user_status',
                username,
                status: 'online'
            });
            
            // Отправляем системное сообщение
            ws.send(JSON.stringify({
                type: 'system',
                text: `Добро пожаловать в NexusGram, ${username}! 🚀`,
                timestamp: Date.now()
            }));
        });
    }
    
    function handleChatMessage(ws, msg) {
        const user = db.users.get(username);
        if (!user) return;
        
        // Проверка на спам
        const recentMessages = db.messages.filter(
            m => m.from === username && Date.now() - m.timestamp < 1000
        );
        if (recentMessages.length > 3) {
            ws.send(JSON.stringify({ 
                type: 'warning', 
                text: 'Слишком быстро! Пожалуйста, не спамьте.' 
            }));
            return;
        }
        
        // Проверка на запрещенные слова
        if (msg.text && containsBadWords(msg.text)) {
            ws.send(JSON.stringify({ 
                type: 'warning', 
                text: 'Сообщение содержит запрещенные слова' 
            }));
            return;
        }
        
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
            deleted: false,
            reactions: [],
            readBy: new Set([username])
        };
        
        db.messages.push(message);
        
        // Доставляем сообщение
        deliverMessage(message);
        
        // Отмечаем активность
        if (clients.has(ws)) {
            clients.get(ws).lastActivity = Date.now();
        }
        
        console.log(`💬 ${username} -> ${message.to}: ${msg.text?.substring(0, 50)}...`);
    }
    
    function handleTyping(msg) {
        broadcastToRoom(msg.to || 'global', {
            type: 'typing',
            from: username,
            to: msg.to || 'global',
            timestamp: Date.now()
        }, username);
    }
    
    function handleReadReceipt(msg) {
        const message = db.messages.find(m => m.id === msg.messageId);
        if (message && !message.readBy.has(username)) {
            message.readBy.add(username);
            
            // Уведомляем отправителя
            sendToUser(message.from, {
                type: 'read_receipt',
                messageId: message.id,
                readBy: username,
                timestamp: Date.now()
            });
        }
    }
});

// ==================== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ WebSocket ====================

function deliverMessage(message) {
    const payload = JSON.stringify(message);
    
    clients.forEach((client, ws) => {
        if (ws.readyState === WebSocket.OPEN) {
            // Проверяем, должен ли клиент получить это сообщение
            const shouldReceive = 
                message.to === 'global' ||
                message.to === client.username ||
                message.from === client.username ||
                client.rooms.has(message.to);
            
            if (shouldReceive) {
                ws.send(payload);
            }
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
        if (ws.readyState === WebSocket.OPEN && 
            client.username !== excludeUsername) {
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

function forwardToTarget(targetUsername, data) {
    sendToUser(targetUsername, data);
}

function sendUnreadMessages(ws, username) {
    const unreadMessages = db.messages
        .filter(msg => {
            const isRelevant = msg.to === 'global' || 
                              msg.to === username || 
                              msg.from === username;
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
}

// Пинг-понг интервал
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            console.log('💔 Клиент не отвечает, отключаем');
            return ws.terminate();
        }
        
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => {
    clearInterval(pingInterval);
});

// ==================== ЗАПУСК СЕРВЕРА ====================
server.listen(CONFIG.PORT, () => {
    console.log('╔══════════════════════════════════════════════╗');
    console.log('║        🚀 NEXUSGRAM СЕРВЕР ЗАПУЩЕН          ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Порт:          ${CONFIG.PORT}                        ║`);
    console.log(`║  Окружение:     ${process.env.NODE_ENV || 'development'}                ║`);
    console.log(`║  Время запуска: ${new Date().toISOString()} ║`);
    console.log('║  Статус:        ✅ Онлайн                    ║');
    console.log('╚══════════════════════════════════════════════╝');
    console.log(`\n📡 REST API:      http://localhost:${CONFIG.PORT}/api`);
    console.log(`🔌 WebSocket:     ws://localhost:${CONFIG.PORT}`);
    console.log(`🌐 Веб-интерфейс: http://localhost:${CONFIG.PORT}\n`);
    
    console.log('📊 Статистика при запуске:');
    console.log(`   - Пользователей: ${db.users.size}`);
    console.log(`   - Групп: ${db.groups.size}`);
    console.log(`   - Каналов: ${db.channels.size}`);
    console.log(`   - Сообщений: ${db.messages.length}\n`);
    
    console.log('👑 Учетные записи для тестирования:');
    console.log('   - admin / admin123 (администратор)');
    console.log('   - alice / alice123');
    console.log('   - bob / bob123');
    console.log('   - charlie / charlie123\n');
});

// Обработка неожиданных ошибок
process.on('uncaughtException', (error) => {
    console.error('❌ Необработанное исключение:', error);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанный rejection:', reason);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('🛑 Получен SIGTERM. Закрываем сервер...');
    db.backup();
    server.close(() => {
        console.log('👋 Сервер остановлен');
        process.exit(0);
    });
});

process.on('SIGINT', () => {
    console.log('🛑 Получен SIGINT. Закрываем сервер...');
    db.backup();
    server.close(() => {
        console.log('👋 Сервер остановлен');
        process.exit(0);
    });
});



// ЭКСПОРТ ДЛЯ ВОЗМОЖНОГО ИСПОЛЬЗОВАНИЯ В ДРУГИХ МОДУЛ

module.exports = { app, server, db, CONFIG }
    ;channels.set('news', {
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
