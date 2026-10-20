const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-test-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.AUTH_RATE_LIMIT = '1000';

const { authenticator } = require('otplib');
const app = require('../src/server');

let server;
let base;

before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// Tiny client that keeps its own session cookie.
function client() {
  let cookie = '';
  return async (method, url, body, { csrf = true } = {}) => {
    const headers = { 'Content-Type': 'application/json' };
    if (csrf) headers['X-Requested-With'] = 'notes-app';
    if (cookie) headers.Cookie = cookie;
    const res = await fetch(base + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0].endsWith('=') ? '' : setCookie.split(';')[0];
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data, setCookie };
  };
}

const alice = client();
const bob = client();

test('rejects weak passwords and bad user IDs', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/register', { username: 'al', email: 'a@x.io', password: 'abc12345' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { username: 'weak', email: 'w@x.io', password: 'short1' })).status, 400);
  assert.equal((await c('POST', '/api/auth/register', { username: 'weak', email: 'w@x.io', password: 'nodigitshere' })).status, 400);
});

test('register sets a secure httpOnly session cookie', async () => {
  const r = await alice('POST', '/api/auth/register', { username: 'alice', email: 'Alice@Example.com', password: 'Sup3rSecret!', displayName: 'Alice' });
  assert.equal(r.status, 201);
  assert.equal(r.data.user.displayName, 'Alice');
  assert.equal(r.data.user.email, 'alice@example.com');
  assert.equal(r.data.user.password_hash, undefined);
  assert.match(r.setCookie, /HttpOnly/i);
  assert.match(r.setCookie, /SameSite=Strict/i);
  assert.equal((await alice('GET', '/api/me')).data.user.username, 'alice');
});

test('duplicate user ID or email is rejected', async () => {
  const r = await client()('POST', '/api/auth/register', { username: 'ALICE', email: 'other@example.com', password: 'Sup3rSecret!' });
  assert.equal(r.status, 409);
});

test('CSRF header is required for state-changing requests', async () => {
  const r = await alice('POST', '/api/notes', { title: 'x' }, { csrf: false });
  assert.equal(r.status, 403);
});

test('notes CRUD, tags, pin, search, archive', async () => {
  const created = await alice('POST', '/api/notes', { title: 'Groceries', content: 'milk, eggs', tags: 'Home, todo', color: 'yellow' });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.note.tags, ['home', 'todo']);
  await alice('POST', '/api/notes', { title: 'Ideas', content: 'docker all the things' });

  const id = created.data.note.id;
  const pinned = await alice('PATCH', `/api/notes/${id}`, { pinned: true });
  assert.equal(pinned.data.note.pinned, true);

  const list = await alice('GET', '/api/notes');
  assert.equal(list.data.notes.length, 2);
  assert.equal(list.data.notes[0].id, id, 'pinned note comes first');
  assert.deepEqual(list.data.tags, ['home', 'todo']);

  assert.equal((await alice('GET', '/api/notes?q=docker')).data.notes.length, 1);
  assert.equal((await alice('GET', '/api/notes?tag=todo')).data.notes.length, 1);

  await alice('PATCH', `/api/notes/${id}`, { archived: true });
  assert.equal((await alice('GET', '/api/notes')).data.notes.length, 1);
  assert.equal((await alice('GET', '/api/notes?archived=1')).data.notes.length, 1);

  assert.equal((await alice('POST', '/api/notes', { title: '', content: '' })).status, 400);
  assert.equal((await alice('POST', '/api/notes', { title: 'x', color: 'neon' })).status, 400);

  const exp = await alice('GET', '/api/notes/export');
  assert.equal(exp.data.notes.length, 2);
});

test("users cannot see or modify each other's notes", async () => {
  await bob('POST', '/api/auth/register', { username: 'bob', email: 'bob@example.com', password: 'B0bPassword' });
  assert.equal((await bob('GET', '/api/notes?archived=1')).data.notes.length, 0);
  const aliceNoteId = (await alice('GET', '/api/notes')).data.notes[0].id;
  assert.equal((await bob('PATCH', `/api/notes/${aliceNoteId}`, { title: 'hacked' })).status, 404);
  assert.equal((await bob('DELETE', `/api/notes/${aliceNoteId}`)).status, 404);
});

test('personalization: display name, theme, accent', async () => {
  const r = await alice('PATCH', '/api/me', { displayName: 'Alice W.', theme: 'dark', accent: '#ff5500' });
  assert.equal(r.data.user.theme, 'dark');
  assert.equal(r.data.user.accent, '#ff5500');
  assert.equal((await alice('PATCH', '/api/me', { theme: 'neon' })).status, 400);
  assert.equal((await alice('PATCH', '/api/me', { accent: 'red' })).status, 400);
});

test('login by user ID or email; wrong password is rejected', async () => {
  const c = client();
  assert.equal((await c('POST', '/api/auth/login', { login: 'bob', password: 'wrong-pass1' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { login: 'nobody', password: 'wrong-pass1' })).status, 401);
  assert.equal((await c('POST', '/api/auth/login', { login: 'BOB@example.com', password: 'B0bPassword' })).status, 200);
  assert.equal((await c('GET', '/api/me')).data.user.username, 'bob');
});

test('2FA: setup, enforce on login, disable', async () => {
  const setup = await alice('POST', '/api/me/2fa/setup');
  assert.ok(setup.data.qr.startsWith('data:image/png;base64,'));
  assert.equal((await alice('POST', '/api/me/2fa/enable', { code: '000000' })).status, 400);
  const enabled = await alice('POST', '/api/me/2fa/enable', { code: authenticator.generate(setup.data.secret) });
  assert.equal(enabled.data.user.totpEnabled, true);

  const c = client();
  const noCode = await c('POST', '/api/auth/login', { login: 'alice', password: 'Sup3rSecret!' });
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.twoFactorRequired, true);
  assert.equal((await c('GET', '/api/me')).status, 401, 'no session without 2FA code');
  const ok = await c('POST', '/api/auth/login', { login: 'alice', password: 'Sup3rSecret!', totp: authenticator.generate(setup.data.secret) });
  assert.equal(ok.status, 200);

  const off = await alice('POST', '/api/me/2fa/disable', { password: 'Sup3rSecret!', code: authenticator.generate(setup.data.secret) });
  assert.equal(off.data.user.totpEnabled, false);
});

test('account locks after 5 failed attempts', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { username: 'carol', email: 'carol@example.com', password: 'Car0lPassword' });
  for (let i = 0; i < 5; i++) await client()('POST', '/api/auth/login', { login: 'carol', password: 'nope-nope1' });
  const locked = await client()('POST', '/api/auth/login', { login: 'carol', password: 'Car0lPassword' });
  assert.equal(locked.status, 423);
  const activity = await c('GET', '/api/me/activity');
  assert.equal(activity.data.events.filter((e) => !e.success).length, 5);
});

test('password change signs out other sessions; logout-all revokes everything', async () => {
  const other = client();
  await other('POST', '/api/auth/login', { login: 'bob', password: 'B0bPassword' });
  assert.equal((await bob('POST', '/api/me/password', { currentPassword: 'wrong', newPassword: 'N3wPassword' })).status, 401);
  assert.equal((await bob('POST', '/api/me/password', { currentPassword: 'B0bPassword', newPassword: 'N3wPassword' })).status, 200);
  assert.equal((await other('GET', '/api/me')).status, 401, 'other device signed out');
  assert.equal((await bob('GET', '/api/me')).status, 200, 'current device kept');

  await bob('POST', '/api/auth/logout-all');
  assert.equal((await bob('GET', '/api/me')).status, 401);
});

test('delete account requires password and removes data', async () => {
  const c = client();
  await c('POST', '/api/auth/register', { username: 'dave', email: 'dave@example.com', password: 'D4vePassword' });
  assert.equal((await c('DELETE', '/api/me', { password: 'wrong' })).status, 401);
  assert.equal((await c('DELETE', '/api/me', { password: 'D4vePassword' })).status, 200);
  assert.equal((await client()('POST', '/api/auth/login', { login: 'dave', password: 'D4vePassword' })).status, 401);
});
