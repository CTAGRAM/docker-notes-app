const crypto = require('node:crypto');
const { promisify } = require('node:util');
const db = require('./db');

const scrypt = promisify(crypto.scrypt);
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1 };

const COOKIE_NAME = 'sid';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const LOCK_MS = 15 * 60 * 1000;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT_OPTS);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [, saltHex, keyHex] = stored.split('$');
  const expected = Buffer.from(keyHex, 'hex');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT_OPTS);
  return crypto.timingSafeEqual(key, expected);
}

// Used when the user does not exist, so response time doesn't reveal valid user IDs.
const dummyHash = hashPassword(crypto.randomBytes(16).toString('hex'));

function passwordProblem(password, username = '') {
  if (typeof password !== 'string' || password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 128) return 'Password must be at most 128 characters';
  if (!/[a-zA-Z]/.test(password) || !/\d/.test(password)) return 'Password must contain a letter and a number';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain your user ID';
  return null;
}

function createSession(req, res, userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sha256(token), userId, now, now + SESSION_TTL_MS, (req.get('user-agent') || '').slice(0, 200), req.ip || '');
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: process.env.COOKIE_SECURE === 'true',
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not signed in' });
  const sid = sha256(token);
  const row = db.prepare(
    'SELECT u.*, s.id AS session_id, s.expires_at AS session_expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?'
  ).get(sid);
  if (!row || row.session_expires_at < Date.now()) {
    if (row) db.prepare('DELETE FROM sessions WHERE id = ?').run(sid);
    clearSessionCookie(res);
    return res.status(401).json({ error: 'Session expired, please sign in again' });
  }
  req.user = row;
  req.sessionId = sid;
  next();
}

// Blocks cross-site form posts: browsers can't send custom headers cross-origin without a CORS preflight we never allow.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('x-requested-with') !== 'notes-app') return res.status(403).json({ error: 'Missing CSRF header' });
  next();
}

function logLoginEvent(userId, success, req) {
  db.prepare('INSERT INTO login_events (user_id, success, ip, user_agent, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(userId, success ? 1 : 0, req.ip || '', (req.get('user-agent') || '').slice(0, 200), Date.now());
}

function recordFailedLogin(user, req) {
  const attempts = user.failed_attempts + 1;
  const lockedUntil = attempts >= MAX_FAILED_ATTEMPTS ? Date.now() + LOCK_MS : null;
  db.prepare('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?')
    .run(lockedUntil ? 0 : attempts, lockedUntil, user.id);
  logLoginEvent(user.id, false, req);
}

function purgeExpiredSessions() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());
}

module.exports = {
  hashPassword,
  verifyPassword,
  dummyHash,
  passwordProblem,
  createSession,
  clearSessionCookie,
  requireAuth,
  csrfGuard,
  logLoginEvent,
  recordFailedLogin,
  purgeExpiredSessions,
};
