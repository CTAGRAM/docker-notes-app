const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const { rateLimit } = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const db = require('./db');
const auth = require('./auth');

const APP_NAME = 'Docker Notes';
const NOTE_COLORS = ['default', 'yellow', 'green', 'blue', 'purple', 'pink', 'orange'];

const app = express();
if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// HSTS / upgrade-insecure-requests only make sense when served over HTTPS.
const httpsOnly = process.env.COOKIE_SECURE === 'true';
app.use(helmet({
  strictTransportSecurity: httpsOnly,
  contentSecurityPolicy: { directives: { upgradeInsecureRequests: httpsOnly ? [] : null } },
}));
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));
app.use('/api', auth.csrfGuard);

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 30),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many attempts, please try again later' },
});

// ---------- helpers ----------

const getUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    email: u.email,
    displayName: u.display_name,
    theme: u.theme,
    accent: u.accent,
    totpEnabled: !!u.totp_enabled,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

function noteOut(n) {
  return {
    id: n.id,
    title: n.title,
    content: n.content,
    color: n.color,
    tags: n.tags ? n.tags.split(',') : [],
    pinned: !!n.pinned,
    archived: !!n.archived,
    createdAt: n.created_at,
    updatedAt: n.updated_at,
  };
}

function normalizeTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const tags = list.map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24)).filter(Boolean);
  return [...new Set(tags)].slice(0, 10).join(',');
}

const bad = (res, error, status = 400) => res.status(status).json({ error });

// ---------- auth ----------

app.post('/api/auth/register', authLimiter, async (req, res) => {
  const { username = '', email = '', password = '', displayName = '' } = req.body || {};
  const uname = String(username).trim();
  const mail = String(email).trim().toLowerCase();

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(uname)) return bad(res, 'User ID must be 3–32 characters: letters, numbers, _ . -');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail) || mail.length > 254) return bad(res, 'Please enter a valid email');
  const problem = auth.passwordProblem(password, uname);
  if (problem) return bad(res, problem);
  if (db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(uname, mail)) {
    return bad(res, 'That user ID or email is already registered', 409);
  }

  const now = Date.now();
  const hash = await auth.hashPassword(password);
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO users (username, email, password_hash, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(uname, mail, hash, String(displayName).trim().slice(0, 50) || uname, now, now);

  const userId = Number(lastInsertRowid);
  auth.logLoginEvent(userId, true, req);
  auth.createSession(req, res, userId);
  res.status(201).json({ user: publicUser(getUser(userId)) });
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const { login = '', password = '', totp } = req.body || {};
  const id = String(login).trim();
  const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(id, id.toLowerCase());
  const now = Date.now();

  if (user && user.locked_until && user.locked_until > now) {
    const mins = Math.ceil((user.locked_until - now) / 60000);
    return bad(res, `Too many failed attempts. Account locked for ${mins} more minute(s).`, 423);
  }

  const ok = await auth.verifyPassword(String(password), user ? user.password_hash : await auth.dummyHash);
  if (!user || !ok) {
    if (user) auth.recordFailedLogin(user, req);
    return bad(res, 'Invalid user ID or password', 401);
  }

  if (user.totp_enabled) {
    if (!totp) return res.status(401).json({ twoFactorRequired: true, error: 'Enter the 6-digit code from your authenticator app' });
    if (!authenticator.check(String(totp).replace(/\s/g, ''), user.totp_secret)) {
      auth.recordFailedLogin(user, req);
      return res.status(401).json({ twoFactorRequired: true, error: 'Invalid 2FA code' });
    }
  }

  db.prepare('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?').run(now, user.id);
  auth.logLoginEvent(user.id, true, req);
  auth.createSession(req, res, user.id);
  res.json({ user: publicUser(user), previousLoginAt: user.last_login_at });
});

app.post('/api/auth/logout', auth.requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(req.sessionId);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

app.post('/api/auth/logout-all', auth.requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(req.user.id);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- profile & security ----------

app.get('/api/me', auth.requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

app.patch('/api/me', auth.requireAuth, (req, res) => {
  const { displayName, theme, accent } = req.body || {};
  const u = req.user;
  const next = {
    display_name: displayName === undefined ? u.display_name : String(displayName).trim().slice(0, 50),
    theme: theme === undefined ? u.theme : theme,
    accent: accent === undefined ? u.accent : accent,
  };
  if (!next.display_name) return bad(res, 'Display name cannot be empty');
  if (!['light', 'dark'].includes(next.theme)) return bad(res, 'Theme must be light or dark');
  if (!/^#[0-9a-f]{6}$/i.test(next.accent)) return bad(res, 'Accent must be a hex color like #6366f1');
  db.prepare('UPDATE users SET display_name = ?, theme = ?, accent = ? WHERE id = ?')
    .run(next.display_name, next.theme, next.accent, u.id);
  res.json({ user: publicUser(getUser(u.id)) });
});

app.post('/api/me/password', auth.requireAuth, async (req, res) => {
  const { currentPassword = '', newPassword = '' } = req.body || {};
  if (!(await auth.verifyPassword(String(currentPassword), req.user.password_hash))) return bad(res, 'Current password is incorrect', 401);
  const problem = auth.passwordProblem(newPassword, req.user.username);
  if (problem) return bad(res, problem);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await auth.hashPassword(newPassword), req.user.id);
  // Sign out every other device after a password change.
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, req.sessionId);
  res.json({ ok: true });
});

app.post('/api/me/2fa/setup', auth.requireAuth, async (req, res) => {
  if (req.user.totp_enabled) return bad(res, '2FA is already enabled');
  const secret = authenticator.generateSecret();
  db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(secret, req.user.id);
  const otpauth = authenticator.keyuri(req.user.username, APP_NAME, secret);
  res.json({ secret, qr: await QRCode.toDataURL(otpauth) });
});

app.post('/api/me/2fa/enable', auth.requireAuth, (req, res) => {
  const code = String((req.body || {}).code || '').replace(/\s/g, '');
  if (req.user.totp_enabled) return bad(res, '2FA is already enabled');
  if (!req.user.totp_secret) return bad(res, 'Start 2FA setup first');
  if (!authenticator.check(code, req.user.totp_secret)) return bad(res, 'Invalid code — check your authenticator app');
  db.prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

app.post('/api/me/2fa/disable', auth.requireAuth, async (req, res) => {
  const { password = '', code = '' } = req.body || {};
  if (!req.user.totp_enabled) return bad(res, '2FA is not enabled');
  if (!(await auth.verifyPassword(String(password), req.user.password_hash))) return bad(res, 'Password is incorrect', 401);
  if (!authenticator.check(String(code).replace(/\s/g, ''), req.user.totp_secret)) return bad(res, 'Invalid 2FA code', 401);
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(req.user.id);
  res.json({ user: publicUser(getUser(req.user.id)) });
});

app.get('/api/me/sessions', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, created_at, expires_at, user_agent, ip FROM sessions WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json({
    sessions: rows.map((s) => ({ createdAt: s.created_at, expiresAt: s.expires_at, userAgent: s.user_agent, ip: s.ip, current: s.id === req.sessionId })),
  });
});

app.get('/api/me/activity', auth.requireAuth, (req, res) => {
  const rows = db.prepare('SELECT success, ip, user_agent, created_at FROM login_events WHERE user_id = ? ORDER BY id DESC LIMIT 15').all(req.user.id);
  res.json({ events: rows.map((e) => ({ success: !!e.success, ip: e.ip, userAgent: e.user_agent, createdAt: e.created_at })) });
});

app.delete('/api/me', auth.requireAuth, async (req, res) => {
  if (!(await auth.verifyPassword(String((req.body || {}).password || ''), req.user.password_hash))) return bad(res, 'Password is incorrect', 401);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// ---------- notes ----------

app.get('/api/notes', auth.requireAuth, (req, res) => {
  const { q = '', tag = '', archived = '0' } = req.query;
  let sql = 'SELECT * FROM notes WHERE user_id = ? AND archived = ?';
  const params = [req.user.id, archived === '1' ? 1 : 0];
  if (q) {
    const like = `%${String(q)}%`;
    sql += ' AND (title LIKE ? OR content LIKE ? OR tags LIKE ?)';
    params.push(like, like, like);
  }
  if (tag) {
    sql += " AND (',' || tags || ',') LIKE ?";
    params.push(`%,${String(tag)},%`);
  }
  sql += ' ORDER BY pinned DESC, updated_at DESC';
  const notes = db.prepare(sql).all(...params).map(noteOut);
  const allTags = new Set();
  for (const row of db.prepare('SELECT tags FROM notes WHERE user_id = ? AND tags != ?').all(req.user.id, '')) {
    row.tags.split(',').forEach((t) => allTags.add(t));
  }
  res.json({ notes, tags: [...allTags].sort() });
});

app.get('/api/notes/export', auth.requireAuth, (req, res) => {
  const notes = db.prepare('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at').all(req.user.id).map(noteOut);
  res.setHeader('Content-Disposition', `attachment; filename="notes-${req.user.username}.json"`);
  res.json({ exportedAt: new Date().toISOString(), user: req.user.username, notes });
});

function readNoteInput(body, existing) {
  const b = body || {};
  const n = {
    title: b.title === undefined ? existing.title : String(b.title).slice(0, 200),
    content: b.content === undefined ? existing.content : String(b.content).slice(0, 20000),
    color: b.color === undefined ? existing.color : b.color,
    tags: b.tags === undefined ? existing.tags : normalizeTags(b.tags),
    pinned: b.pinned === undefined ? existing.pinned : b.pinned ? 1 : 0,
    archived: b.archived === undefined ? existing.archived : b.archived ? 1 : 0,
  };
  if (!NOTE_COLORS.includes(n.color)) return { error: `Color must be one of: ${NOTE_COLORS.join(', ')}` };
  if (!n.title.trim() && !n.content.trim()) return { error: 'A note needs a title or some content' };
  return { note: n };
}

app.post('/api/notes', auth.requireAuth, (req, res) => {
  const { note, error } = readNoteInput(req.body, { title: '', content: '', color: 'default', tags: '', pinned: 0, archived: 0 });
  if (error) return bad(res, error);
  const now = Date.now();
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO notes (user_id, title, content, color, tags, pinned, archived, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(req.user.id, note.title, note.content, note.color, note.tags, note.pinned, note.archived, now, now);
  res.status(201).json({ note: noteOut(db.prepare('SELECT * FROM notes WHERE id = ?').get(lastInsertRowid)) });
});

app.patch('/api/notes/:id', auth.requireAuth, (req, res) => {
  const existing = db.prepare('SELECT * FROM notes WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!existing) return bad(res, 'Note not found', 404);
  const { note, error } = readNoteInput(req.body, existing);
  if (error) return bad(res, error);
  db.prepare('UPDATE notes SET title = ?, content = ?, color = ?, tags = ?, pinned = ?, archived = ?, updated_at = ? WHERE id = ?')
    .run(note.title, note.content, note.color, note.tags, note.pinned, note.archived, Date.now(), existing.id);
  res.json({ note: noteOut(db.prepare('SELECT * FROM notes WHERE id = ?').get(existing.id)) });
});

app.delete('/api/notes/:id', auth.requireAuth, (req, res) => {
  const { changes } = db.prepare('DELETE FROM notes WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
  if (!changes) return bad(res, 'Note not found', 404);
  res.json({ ok: true });
});

app.use('/api', (req, res) => bad(res, 'Not found', 404));

app.use((err, req, res, next) => {
  const status = err.status && err.status < 500 ? err.status : 500;
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 500 ? 'Something went wrong' : err.message });
});

if (require.main === module) {
  const port = Number(process.env.PORT || 3000);
  setInterval(auth.purgeExpiredSessions, 60 * 60 * 1000).unref();
  app.listen(port, () => console.log(`${APP_NAME} listening on http://localhost:${port}`));
}

module.exports = app;
