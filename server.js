'use strict';
// 사내 메신저 서버.
// 구성: Express(REST API와 화면 제공) + Socket.IO(실시간 메시지) + 내장 SQLite(저장)
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

try { process.loadEnvFile(path.join(__dirname, '.env')); } catch { /* .env 파일이 없으면 기본값 사용 */ }

// ───────────────────────── 설정 ─────────────────────────
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const SIGNUP_CODE = process.env.SIGNUP_CODE || '';
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 20);
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 14);
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';
const MAX_MESSAGE_LENGTH = 4000;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Seoul';
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const db = require('./src/db').open(DATA_DIR);
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const scrypt = promisify(crypto.scrypt);
const now = () => new Date().toISOString();

// ───────────────────────── 공통 도우미 ─────────────────────────
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (status, message) => { throw new HttpError(status, message); };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function userFromCookieHeader(header) {
  const token = parseCookies(header).sid;
  if (!token) return null;
  return db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ? AND u.active = 1
  `).get(sha256(token), now()) || null;
}
function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400000);
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
    .run(sha256(token), userId, expires.toISOString());
  res.cookie('sid', token, { httpOnly: true, sameSite: 'lax', secure: COOKIE_SECURE, expires, path: '/' });
}

const cleanText = (value, max) => String(value ?? '').trim().slice(0, max);
const toId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fail(400, '잘못된 요청입니다.');
};
function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
    fail(400, '비밀번호는 8자 이상이어야 합니다.');
  }
}

const publicUser = (u) => ({
  id: u.id, username: u.username, name: u.name, department: u.department,
  position: u.position, role: u.role, active: !!u.active, online: online.has(u.id),
});

// ───────────────────────── 대화방과 메시지 도우미 ─────────────────────────
const online = new Map(); // 사용자 번호별 접속 중인 연결 수

const membership = (roomId, userId) =>
  db.prepare('SELECT * FROM room_members WHERE room_id = ? AND user_id = ?').get(roomId, userId);
const requireMember = (roomId, userId) =>
  membership(roomId, userId) || fail(403, '참여하지 않은 대화방입니다.');
const memberIds = (roomId) =>
  db.prepare('SELECT user_id FROM room_members WHERE room_id = ?').all(roomId).map((r) => r.user_id);

function messagePayload(m) {
  const payload = {
    id: m.id, roomId: m.room_id, userId: m.user_id, type: m.type,
    content: m.content, createdAt: m.created_at, file: null,
  };
  if (m.file_id) {
    const f = db.prepare('SELECT * FROM files WHERE id = ?').get(m.file_id);
    if (f) payload.file = { id: f.id, name: f.original_name, size: f.size, isImage: INLINE_IMAGE_TYPES.has(f.mime) };
  }
  return payload;
}

function roomPayload(roomId, forUserId) {
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  const me = membership(roomId, forUserId);
  if (!room || !me) return null;
  const members = db.prepare('SELECT user_id, last_read_id FROM room_members WHERE room_id = ?').all(roomId)
    .map((r) => ({ userId: r.user_id, lastReadId: r.last_read_id }));
  const last = db.prepare('SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT 1').get(roomId);
  const unread = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE room_id = ? AND id > ? AND user_id != ? AND type != 'system'
  `).get(roomId, me.last_read_id, forUserId).n;
  return {
    id: room.id, type: room.type, name: room.name, createdAt: room.created_at,
    members, unread, lastMessage: last ? messagePayload(last) : null,
  };
}

function insertMessage({ roomId, userId, type = 'text', content = '', fileId = null }) {
  const info = db.prepare(`
    INSERT INTO messages (room_id, user_id, type, content, file_id, created_at) VALUES (?, ?, ?, ?, ?, ?)
  `).run(roomId, userId, type, content, fileId, now());
  const id = Number(info.lastInsertRowid);
  if (type !== 'system') {
    db.prepare('UPDATE room_members SET last_read_id = ? WHERE room_id = ? AND user_id = ?').run(id, roomId, userId);
  }
  return messagePayload(db.prepare('SELECT * FROM messages WHERE id = ?').get(id));
}

// 실시간 전달: 사용자마다 'user:번호' 채널을 두고, 대화방 참여자 채널로 각각 전송한다.
let io;
const emitToUser = (userId, event, data) => io.to(`user:${userId}`).emit(event, data);
const emitToRoom = (roomId, event, data) => memberIds(roomId).forEach((id) => emitToUser(id, event, data));
const pushRoom = (roomId) => memberIds(roomId).forEach((id) => emitToUser(id, 'room:upsert', roomPayload(roomId, id)));
function broadcastMessage(message) {
  emitToRoom(message.roomId, 'message:new', message);
  if (message.type !== 'system') {
    emitToRoom(message.roomId, 'room:read', { roomId: message.roomId, userId: message.userId, lastReadId: message.id });
  }
}

function sendText(user, roomIdRaw, contentRaw) {
  const roomId = toId(roomIdRaw);
  requireMember(roomId, user.id);
  const content = String(contentRaw ?? '').trim();
  if (!content) fail(400, '메시지 내용을 입력해 주세요.');
  if (content.length > MAX_MESSAGE_LENGTH) fail(400, `메시지는 ${MAX_MESSAGE_LENGTH}자까지 보낼 수 있습니다.`);
  const message = insertMessage({ roomId, userId: user.id, content });
  broadcastMessage(message);
  return message;
}

function markRead(user, roomIdRaw, lastIdRaw) {
  const roomId = toId(roomIdRaw);
  const me = requireMember(roomId, user.id);
  const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE room_id = ?').get(roomId).id;
  const lastReadId = Math.max(me.last_read_id, Math.min(Number(lastIdRaw) || 0, max));
  if (lastReadId === me.last_read_id) return;
  db.prepare('UPDATE room_members SET last_read_id = ? WHERE room_id = ? AND user_id = ?').run(lastReadId, roomId, user.id);
  emitToRoom(roomId, 'room:read', { roomId, userId: user.id, lastReadId });
}

function activeUsersByIds(ids) {
  const unique = [...new Set((Array.isArray(ids) ? ids : []).map(Number))].filter((n) => Number.isInteger(n) && n > 0);
  return unique.map((id) => db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(id)).filter(Boolean);
}

// ───────────────────────── 웹 서버 ─────────────────────────
const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });

// 다른 사이트에서 보낸 위조 요청을 막기 위해, 변경 요청에는 전용 헤더를 요구한다.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'fetch') return next(new HttpError(403, '허용되지 않은 요청입니다.'));
  next();
});

const auth = (req, res, next) => {
  req.user = userFromCookieHeader(req.headers.cookie);
  next(req.user ? undefined : new HttpError(401, '로그인이 필요합니다.'));
};
const adminOnly = (req, res, next) =>
  next(req.user.role === 'admin' ? undefined : new HttpError(403, '관리자만 사용할 수 있습니다.'));

// 로그인 시도 횟수 제한 (10분 동안 10회 실패 시 차단)
const loginFailures = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
function checkLoginLimit(key) {
  const entry = loginFailures.get(key);
  if (entry && Date.now() - entry.first > LOGIN_WINDOW_MS) loginFailures.delete(key);
  else if (entry && entry.count >= 10) fail(429, '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도해 주세요.');
}
function recordLoginFailure(key) {
  const entry = loginFailures.get(key) || { count: 0, first: Date.now() };
  entry.count += 1;
  loginFailures.set(key, entry);
}

// ── 계정 ──
app.get('/api/config', (req, res) => {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  res.json({ signupCodeRequired: !!SIGNUP_CODE && userCount > 0, firstUser: userCount === 0, maxFileMb: MAX_FILE_MB });
});

app.post('/api/signup', async (req, res) => {
  const username = cleanText(req.body.username, 30).toLowerCase();
  const name = cleanText(req.body.name, 30);
  const department = cleanText(req.body.department, 40);
  const position = cleanText(req.body.position, 40);
  if (!/^[a-z0-9._-]{3,30}$/.test(username)) fail(400, '아이디는 영문 소문자, 숫자, 점, 밑줄, 하이픈 3~30자로 입력해 주세요.');
  if (!name) fail(400, '이름을 입력해 주세요.');
  validatePassword(req.body.password);
  const passwordHash = await hashPassword(req.body.password);

  const user = db.tx(() => {
    const isFirst = db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;
    // 첫 번째 가입자는 관리자가 되며, 이후 가입자는 가입 코드가 설정된 경우 코드를 입력해야 한다.
    if (!isFirst && SIGNUP_CODE && req.body.signupCode !== SIGNUP_CODE) fail(403, '가입 코드가 올바르지 않습니다.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) fail(409, '이미 사용 중인 아이디입니다.');
    const info = db.prepare(`
      INSERT INTO users (username, password_hash, name, department, position, role, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(username, passwordHash, name, department, position, isFirst ? 'admin' : 'user', now());
    return db.prepare('SELECT * FROM users WHERE id = ?').get(Number(info.lastInsertRowid));
  });
  createSession(res, user.id);
  io.emit('user:upsert', publicUser(user));
  res.json({ user: publicUser(user) });
});

app.post('/api/login', async (req, res) => {
  const username = cleanText(req.body.username, 30).toLowerCase();
  const key = `${req.ip}|${username}`;
  checkLoginLimit(key);
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = user && typeof req.body.password === 'string' && await verifyPassword(req.body.password, user.password_hash);
  if (!ok) { recordLoginFailure(key); fail(401, '아이디 또는 비밀번호가 올바르지 않습니다.'); }
  if (!user.active) fail(403, '사용이 중지된 계정입니다. 관리자에게 문의해 주세요.');
  loginFailures.delete(key);
  createSession(res, user.id);
  res.json({ user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie).sid;
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.clearCookie('sid', { path: '/' });
  res.json({ ok: true });
});

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user) }));

app.patch('/api/me', auth, (req, res) => {
  const name = cleanText(req.body.name, 30);
  if (!name) fail(400, '이름을 입력해 주세요.');
  db.prepare('UPDATE users SET name = ?, department = ?, position = ? WHERE id = ?')
    .run(name, cleanText(req.body.department, 40), cleanText(req.body.position, 40), req.user.id);
  const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id));
  io.emit('user:upsert', user);
  res.json({ user });
});

app.post('/api/me/password', auth, async (req, res) => {
  if (typeof req.body.currentPassword !== 'string' || !await verifyPassword(req.body.currentPassword, req.user.password_hash)) {
    fail(400, '현재 비밀번호가 올바르지 않습니다.');
  }
  validatePassword(req.body.newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.newPassword), req.user.id);
  // 비밀번호를 바꾸면 현재 접속을 제외한 다른 로그인은 모두 해제한다.
  const current = sha256(parseCookies(req.headers.cookie).sid);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(req.user.id, current);
  res.json({ ok: true });
});

app.get('/api/users', auth, (req, res) => {
  res.json({ users: db.prepare('SELECT * FROM users ORDER BY department, name').all().map(publicUser) });
});

// ── 관리자 ──
app.patch('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  const id = toId(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id) || fail(404, '사용자를 찾을 수 없습니다.');
  const role = req.body.role === undefined ? target.role : req.body.role;
  const active = req.body.active === undefined ? target.active : (req.body.active ? 1 : 0);
  if (!['admin', 'user'].includes(role)) fail(400, '잘못된 권한입니다.');
  if (id === req.user.id && (role !== 'admin' || !active)) fail(400, '본인의 관리자 권한이나 계정 상태는 변경할 수 없습니다.');
  db.prepare('UPDATE users SET role = ?, active = ? WHERE id = ?').run(role, active, id);
  if (!active) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    io.in(`user:${id}`).disconnectSockets(true);
  }
  const user = publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
  io.emit('user:upsert', user);
  res.json({ user });
});

app.post('/api/admin/users/:id/password', auth, adminOnly, async (req, res) => {
  const id = toId(req.params.id);
  if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) fail(404, '사용자를 찾을 수 없습니다.');
  validatePassword(req.body.newPassword);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(req.body.newPassword), id);
  if (id !== req.user.id) {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    io.in(`user:${id}`).disconnectSockets(true);
  }
  res.json({ ok: true });
});

// ── 대화방 ──
app.get('/api/rooms', auth, (req, res) => {
  const ids = db.prepare('SELECT room_id FROM room_members WHERE user_id = ?').all(req.user.id);
  res.json({ rooms: ids.map((r) => roomPayload(r.room_id, req.user.id)) });
});

app.post('/api/rooms/direct', auth, (req, res) => {
  const otherId = toId(req.body.userId);
  if (otherId === req.user.id) fail(400, '본인과의 대화방은 만들 수 없습니다.');
  if (!db.prepare('SELECT 1 FROM users WHERE id = ? AND active = 1').get(otherId)) fail(404, '사용자를 찾을 수 없습니다.');
  const key = [req.user.id, otherId].sort((a, b) => a - b).join(':');
  let created = false;
  const roomId = db.tx(() => {
    const existing = db.prepare('SELECT id FROM rooms WHERE direct_key = ?').get(key);
    if (existing) return existing.id;
    created = true;
    const t = now();
    const id = Number(db.prepare("INSERT INTO rooms (type, direct_key, created_by, created_at) VALUES ('direct', ?, ?, ?)")
      .run(key, req.user.id, t).lastInsertRowid);
    const add = db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)');
    add.run(id, req.user.id, t);
    add.run(id, otherId, t);
    return id;
  });
  if (created) pushRoom(roomId);
  res.json({ room: roomPayload(roomId, req.user.id) });
});

app.post('/api/rooms/group', auth, (req, res) => {
  const name = cleanText(req.body.name, 50);
  if (!name) fail(400, '대화방 이름을 입력해 주세요.');
  const others = activeUsersByIds(req.body.memberIds).filter((u) => u.id !== req.user.id);
  if (others.length === 0) fail(400, '대화 상대를 한 명 이상 선택해 주세요.');
  const roomId = db.tx(() => {
    const t = now();
    const id = Number(db.prepare("INSERT INTO rooms (type, name, created_by, created_at) VALUES ('group', ?, ?, ?)")
      .run(name, req.user.id, t).lastInsertRowid);
    const add = db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)');
    [req.user, ...others].forEach((u) => add.run(id, u.id, t));
    insertMessage({ roomId: id, userId: req.user.id, type: 'system', content: `${req.user.name}님이 대화방을 만들었습니다.` });
    return id;
  });
  pushRoom(roomId);
  res.json({ room: roomPayload(roomId, req.user.id) });
});

app.post('/api/rooms/:id/invite', auth, (req, res) => {
  const roomId = toId(req.params.id);
  requireMember(roomId, req.user.id);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (room.type !== 'group') fail(400, '그룹 대화방에서만 초대할 수 있습니다.');
  const current = new Set(memberIds(roomId));
  const invited = activeUsersByIds(req.body.memberIds).filter((u) => !current.has(u.id));
  if (invited.length === 0) fail(400, '초대할 사람을 선택해 주세요.');
  const message = db.tx(() => {
    const add = db.prepare('INSERT INTO room_members (room_id, user_id, joined_at) VALUES (?, ?, ?)');
    invited.forEach((u) => add.run(roomId, u.id, now()));
    return insertMessage({
      roomId, userId: req.user.id, type: 'system',
      content: `${req.user.name}님이 ${invited.map((u) => `${u.name}님`).join(', ')}을 초대했습니다.`,
    });
  });
  pushRoom(roomId);
  broadcastMessage(message);
  res.json({ room: roomPayload(roomId, req.user.id) });
});

app.post('/api/rooms/:id/leave', auth, (req, res) => {
  const roomId = toId(req.params.id);
  requireMember(roomId, req.user.id);
  const room = db.prepare('SELECT * FROM rooms WHERE id = ?').get(roomId);
  if (room.type !== 'group') fail(400, '1대1 대화방은 나갈 수 없습니다.');
  const message = db.tx(() => {
    db.prepare('DELETE FROM room_members WHERE room_id = ? AND user_id = ?').run(roomId, req.user.id);
    return insertMessage({ roomId, userId: req.user.id, type: 'system', content: `${req.user.name}님이 나갔습니다.` });
  });
  emitToUser(req.user.id, 'room:removed', { roomId });
  pushRoom(roomId);
  broadcastMessage(message);
  res.json({ ok: true });
});

app.get('/api/rooms/:id/messages', auth, (req, res) => {
  const roomId = toId(req.params.id);
  requireMember(roomId, req.user.id);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = Number(req.query.before) || Number.MAX_SAFE_INTEGER;
  const rows = db.prepare('SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
    .all(roomId, before, limit + 1);
  const hasMore = rows.length > limit;
  res.json({ messages: rows.slice(0, limit).reverse().map(messagePayload), hasMore });
});

app.post('/api/rooms/:id/messages', auth, (req, res) => {
  res.json({ message: sendText(req.user, req.params.id, req.body.content) });
});

// ── 파일 ──
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')), // 원래 파일명은 저장 경로에 쓰지 않는다
  }),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: 1 },
});

app.post('/api/rooms/:id/files', auth,
  (req, res, next) => { req.roomId = toId(req.params.id); requireMember(req.roomId, req.user.id); next(); },
  upload.single('file'),
  (req, res) => {
    if (!req.file) fail(400, '파일을 선택해 주세요.');
    // 브라우저가 보낸 한글 파일명이 깨지지 않도록 문자 인코딩을 복원한다.
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8')
      .replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file';
    const message = db.tx(() => {
      const fileId = Number(db.prepare(`
        INSERT INTO files (room_id, user_id, original_name, stored_name, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(req.roomId, req.user.id, originalName, req.file.filename, req.file.size, req.file.mimetype, now()).lastInsertRowid);
      return insertMessage({ roomId: req.roomId, userId: req.user.id, type: 'file', content: originalName, fileId });
    });
    broadcastMessage(message);
    res.json({ message });
  });

app.get('/api/files/:id', auth, (req, res) => {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(toId(req.params.id)) || fail(404, '파일을 찾을 수 없습니다.');
  requireMember(file.room_id, req.user.id);
  const filePath = path.join(UPLOAD_DIR, path.basename(file.stored_name));
  if (!fs.existsSync(filePath)) fail(404, '파일을 찾을 수 없습니다.');
  // 안전한 이미지 형식만 화면에 바로 표시하고, 나머지는 항상 내려받기로 처리한다.
  const inline = req.query.inline === '1' && INLINE_IMAGE_TYPES.has(file.mime);
  res.setHeader('Content-Type', inline ? file.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.original_name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(filePath).pipe(res);
});

// ── 검색 ──
app.get('/api/search', auth, (req, res) => {
  const q = cleanText(req.query.q, 100);
  if (q.length < 2) return res.json({ results: [] });
  const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const rows = db.prepare(`
    SELECT m.* FROM messages m
    JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = ?
    WHERE m.type != 'system' AND m.content LIKE ? ESCAPE '\\'
    ORDER BY m.id DESC LIMIT 50
  `).all(req.user.id, pattern);
  res.json({ results: rows.map(messagePayload) });
});

// ── 알림 ──
function notify(userIds, { type, title, body = '', link = '' }) {
  const insert = db.prepare('INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (const userId of new Set(userIds)) {
    const createdAt = now();
    const id = Number(insert.run(userId, type, title, body, link, createdAt).lastInsertRowid);
    emitToUser(userId, 'notify', { id, type, title, body, link, read: false, createdAt });
  }
}

app.get('/api/notifications', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50').all(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(req.user.id).n;
  res.json({
    unread,
    notifications: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.is_read, createdAt: n.created_at })),
  });
});

app.post('/api/notifications/read', auth, (req, res) => {
  if (req.body.id) db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(toId(req.body.id), req.user.id);
  else db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.user.id);
  res.json({ ok: true });
});

// ── ERP 모듈 (게시판, 전자결재, 근태·휴가, 일정) ──
// 모든 모듈은 메신저와 같은 계정, 조직도, 알림 기능을 공유한다.
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const ctx = {
  app, db, auth, adminOnly, fail, toId, cleanText, now, notify, activeUsersByIds,
  today: () => dateFormatter.format(new Date()),                         // 회사 기준 시간대의 오늘 날짜
  isDate: (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value,
  allActiveUserIds: () => db.prepare('SELECT id FROM users WHERE active = 1').all().map((u) => u.id),
  hooks: { approvalChanged: [] },
};
require('./src/modules/board')(ctx);
require('./src/modules/approval')(ctx);
require('./src/modules/attendance')(ctx);
require('./src/modules/calendar')(ctx);

// ── 오류 처리 ──
app.use('/api', (req, res) => res.status(404).json({ error: '존재하지 않는 주소입니다.' }));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (req.file) fs.unlink(req.file.path, () => {});
  if (err instanceof multer.MulterError) {
    const message = err.code === 'LIMIT_FILE_SIZE' ? `파일은 ${MAX_FILE_MB}MB까지 올릴 수 있습니다.` : '파일 업로드에 실패했습니다.';
    return res.status(400).json({ error: message });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: '잘못된 요청입니다.' });
  console.error(err);
  res.status(500).json({ error: '서버 오류가 발생했습니다.' });
});

// ───────────────────────── 실시간 통신 ─────────────────────────
const server = http.createServer(app);
io = new Server(server, {
  maxHttpBufferSize: 100 * 1024,
  // 다른 사이트의 페이지가 이 서버로 실시간 연결을 여는 것을 차단한다.
  allowRequest: (req, callback) => {
    const origin = req.headers.origin;
    if (!origin) return callback(null, true);
    let sameHost = false;
    try { sameHost = new URL(origin).host === req.headers.host; } catch { /* 잘못된 값은 거부 */ }
    callback(null, sameHost);
  },
});

io.use((socket, next) => {
  const user = userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  const userId = socket.data.userId;
  socket.join(`user:${userId}`);
  online.set(userId, (online.get(userId) || 0) + 1);
  if (online.get(userId) === 1) io.emit('presence', { userId, online: true });

  // 매 요청마다 계정 상태를 다시 확인하여, 중지된 계정의 열린 연결이 동작하지 않도록 한다.
  const handle = (fn) => (payload, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    try {
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(userId) || fail(401, '로그인이 필요합니다.');
      reply({ ok: true, ...(fn(user, payload || {}) || {}) });
    } catch (err) {
      if (!(err instanceof HttpError)) console.error(err);
      reply({ ok: false, error: err instanceof HttpError ? err.message : '서버 오류가 발생했습니다.' });
    }
  };
  socket.on('message:send', handle((user, p) => ({ message: sendText(user, p.roomId, p.content) })));
  socket.on('room:read', handle((user, p) => { markRead(user, p.roomId, p.lastId); }));

  socket.on('disconnect', () => {
    const count = (online.get(userId) || 1) - 1;
    if (count <= 0) { online.delete(userId); io.emit('presence', { userId, online: false }); }
    else online.set(userId, count);
  });
});

// 만료된 로그인 정보 정리 (1시간마다)
setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now()), 3600000).unref();

server.listen(PORT, () => {
  console.log(`사내 메신저가 실행되었습니다: http://localhost:${PORT}`);
  if (!SIGNUP_CODE) console.log('안내: SIGNUP_CODE가 설정되지 않아, 접속 가능한 누구나 가입할 수 있습니다.');
});
