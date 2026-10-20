const $ = (sel, el = document) => el.querySelector(sel);
const COLORS = ['default', 'yellow', 'green', 'blue', 'purple', 'pink', 'orange'];
const state = { user: null, notes: [], tags: [], tag: '', q: '', archived: false, editing: null };

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'notes-app' },
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : {};
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (ts) => (ts ? new Date(ts).toLocaleString() : '—');
const formData = (form) => Object.fromEntries(new FormData(form));

function shortAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Unknown browser';
  const os = /Mac OS/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

// ---------- personalization ----------

function applyPersonalization() {
  const u = state.user;
  document.documentElement.dataset.theme = u.theme;
  document.documentElement.style.setProperty('--accent', u.accent);
  const hour = new Date().getHours();
  const part = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  $('#greeting').textContent = `${part}, ${u.displayName} 👋`;
  const initials = u.displayName.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  $('#settings-btn').textContent = initials;
}

function renderStats() {
  const pinned = state.notes.filter((n) => n.pinned).length;
  const label = state.archived ? 'archived' : 'active';
  $('#stats').textContent = `${state.notes.length} ${label} note(s) · ${pinned} pinned · signed in as @${state.user.username}`;
}

// ---------- auth view ----------

function showAuth() {
  state.user = null;
  document.documentElement.dataset.theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

async function signedIn(user) {
  state.user = user;
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#login-form').reset();
  $('#register-form').reset();
  $('#totp-field').classList.add('hidden');
  $('#auth-error').textContent = '';
  applyPersonalization();
  await loadNotes();
}

document.querySelectorAll('.tabs button').forEach((btn) =>
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b === btn));
    $('#login-form').classList.toggle('hidden', btn.dataset.tab !== 'login');
    $('#register-form').classList.toggle('hidden', btn.dataset.tab !== 'register');
    $('#auth-error').textContent = '';
  })
);

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  if (!data.totp) delete data.totp;
  try {
    const { user } = await api('/auth/login', { method: 'POST', body: data });
    await signedIn(user);
  } catch (err) {
    if (err.data && err.data.twoFactorRequired) {
      $('#totp-field').classList.remove('hidden');
      $('#totp-field input').focus();
    }
    $('#auth-error').textContent = err.message;
  }
});

$('#register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/auth/register', { method: 'POST', body: formData(e.target) });
    await signedIn(user);
  } catch (err) {
    $('#auth-error').textContent = err.message;
  }
});

$('#register-form [name="password"]').addEventListener('input', (e) => {
  const pw = e.target.value;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score++;
  if (/\d/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  const colors = ['#dc2626', '#dc2626', '#f59e0b', '#eab308', '#22c55e', '#16a34a'];
  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Very strong'];
  $('#pw-meter').style.width = `${(score / 5) * 100}%`;
  $('#pw-meter').style.background = colors[score];
  $('#pw-hint').textContent = pw ? labels[score] : '8+ characters with a letter and a number.';
});

// ---------- notes ----------

document.querySelectorAll('.color-select').forEach((sel) => {
  sel.innerHTML = COLORS.map((c) => `<option value="${c}">${c[0].toUpperCase() + c.slice(1)}</option>`).join('');
});

async function loadNotes() {
  const params = new URLSearchParams({ q: state.q, tag: state.tag, archived: state.archived ? '1' : '0' });
  const { notes, tags } = await api('/notes?' + params);
  state.notes = notes;
  state.tags = tags;
  render();
}

function render() {
  renderStats();
  $('#tag-filter').innerHTML = state.tags.length
    ? [`<button type="button" class="chip ${state.tag ? '' : 'active'}" data-tag="">All</button>`]
        .concat(state.tags.map((t) => `<button type="button" class="chip ${state.tag === t ? 'active' : ''}" data-tag="${esc(t)}">#${esc(t)}</button>`))
        .join('')
    : '';
  $('#notes').innerHTML = state.notes
    .map(
      (n) => `
    <article class="note c-${esc(n.color)} ${n.pinned ? 'pinned' : ''}" data-id="${n.id}">
      ${n.title ? `<h4>${esc(n.title)}</h4>` : ''}
      <p class="body">${esc(n.content)}</p>
      ${n.tags.length ? `<div class="tags">${n.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>` : ''}
      <div class="meta">Edited ${fmt(n.updatedAt)}</div>
      <div class="actions">
        <button type="button" data-act="pin" title="${n.pinned ? 'Unpin' : 'Pin'}">${n.pinned ? '📌 Unpin' : '📍 Pin'}</button>
        <button type="button" data-act="edit" title="Edit">✏️</button>
        <button type="button" data-act="archive" title="${n.archived ? 'Unarchive' : 'Archive'}">${n.archived ? '📤' : '🗄️'}</button>
        <button type="button" data-act="delete" title="Delete">🗑️</button>
      </div>
    </article>`
    )
    .join('');
  $('#empty').classList.toggle('hidden', state.notes.length > 0);
}

$('#note-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const data = formData(e.target);
  try {
    await api('/notes', { method: 'POST', body: { ...data, pinned: !!data.pinned } });
    e.target.reset();
    await loadNotes();
  } catch (err) {
    alert(err.message);
  }
});

$('#notes').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = Number(btn.closest('.note').dataset.id);
  const note = state.notes.find((n) => n.id === id);
  try {
    if (btn.dataset.act === 'pin') await api(`/notes/${id}`, { method: 'PATCH', body: { pinned: !note.pinned } });
    if (btn.dataset.act === 'archive') await api(`/notes/${id}`, { method: 'PATCH', body: { archived: !note.archived } });
    if (btn.dataset.act === 'delete') {
      if (!confirm('Delete this note permanently?')) return;
      await api(`/notes/${id}`, { method: 'DELETE' });
    }
    if (btn.dataset.act === 'edit') return openEditor(note);
    await loadNotes();
  } catch (err) {
    alert(err.message);
  }
});

function openEditor(note) {
  state.editing = note;
  const f = $('#edit-form');
  f.title.value = note.title;
  f.content.value = note.content;
  f.tags.value = note.tags.join(', ');
  f.color.value = note.color;
  $('#edit-dialog').showModal();
}

$('#edit-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api(`/notes/${state.editing.id}`, { method: 'PATCH', body: formData(e.target) });
    $('#edit-dialog').close();
    await loadNotes();
  } catch (err) {
    alert(err.message);
  }
});

let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = e.target.value.trim();
    loadNotes();
  }, 250);
});

$('#tag-filter').addEventListener('click', (e) => {
  const chip = e.target.closest('[data-tag]');
  if (!chip) return;
  state.tag = chip.dataset.tag;
  loadNotes();
});

$('#show-archived').addEventListener('change', (e) => {
  state.archived = e.target.checked;
  loadNotes();
});

$('#theme-toggle').addEventListener('click', async () => {
  const { user } = await api('/me', { method: 'PATCH', body: { theme: state.user.theme === 'dark' ? 'light' : 'dark' } });
  state.user = user;
  applyPersonalization();
});

// ---------- settings ----------

document.querySelectorAll('dialog [data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close()));

const settingsMsg = (text, isError = false) => {
  const el = $('#settings-msg');
  el.textContent = text;
  el.className = isError ? 'error' : 'hint';
};

$('#settings-btn').addEventListener('click', async () => {
  const u = state.user;
  const f = $('#profile-form');
  f.displayName.value = u.displayName;
  f.theme.value = u.theme;
  f.accent.value = u.accent;
  $('#profile-meta').textContent = `@${u.username} · ${u.email} · member since ${new Date(u.createdAt).toLocaleDateString()}`;
  settingsMsg('');
  renderTwoFactor();
  $('#settings-dialog').showModal();
  const [{ sessions }, { events }] = await Promise.all([api('/me/sessions'), api('/me/activity')]);
  $('#sessions').innerHTML = sessions
    .map((s) => `<li>${esc(shortAgent(s.userAgent))} · ${esc(s.ip)} · since ${fmt(s.createdAt)} ${s.current ? '<strong>(this device)</strong>' : ''}</li>`)
    .join('');
  $('#activity').innerHTML = events
    .map((ev) => `<li><span class="${ev.success ? 'ok' : 'fail'}">${ev.success ? '✔ Success' : '✖ Failed'}</span> · ${esc(shortAgent(ev.userAgent))} · ${esc(ev.ip)} · ${fmt(ev.createdAt)}</li>`)
    .join('');
});

$('#profile-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const { user } = await api('/me', { method: 'PATCH', body: formData(e.target) });
    state.user = user;
    applyPersonalization();
    settingsMsg('Profile saved.');
  } catch (err) {
    settingsMsg(err.message, true);
  }
});

$('#password-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/me/password', { method: 'POST', body: formData(e.target) });
    e.target.reset();
    settingsMsg('Password updated. Other devices were signed out.');
  } catch (err) {
    settingsMsg(err.message, true);
  }
});

function renderTwoFactor() {
  const box = $('#twofa');
  if (state.user.totpEnabled) {
    box.innerHTML = `
      <p class="ok">✔ 2FA is enabled. You'll need a code from your authenticator app to sign in.</p>
      <form id="twofa-disable" class="row">
        <input name="password" type="password" placeholder="Password" required autocomplete="current-password">
        <input name="code" placeholder="2FA code" required inputmode="numeric" maxlength="7">
        <button class="danger-outline" type="submit">Disable 2FA</button>
      </form>`;
    $('#twofa-disable').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        state.user = (await api('/me/2fa/disable', { method: 'POST', body: formData(e.target) })).user;
        renderTwoFactor();
        settingsMsg('2FA disabled.');
      } catch (err) {
        settingsMsg(err.message, true);
      }
    });
  } else {
    box.innerHTML = `
      <p class="hint">Add a second layer of security using Google Authenticator, Authy, 1Password, etc.</p>
      <button type="button" id="twofa-start" class="primary">Set up 2FA</button>`;
    $('#twofa-start').addEventListener('click', async () => {
      const { qr, secret } = await api('/me/2fa/setup', { method: 'POST' });
      box.innerHTML = `
        <div class="stack">
          <p class="hint">Scan this QR code with your authenticator app, then enter the 6-digit code.</p>
          <img class="qr" src="${qr}" alt="2FA QR code">
          <p class="hint">Or enter this key manually: <code>${esc(secret)}</code></p>
          <form id="twofa-enable" class="row">
            <input name="code" placeholder="123456" required inputmode="numeric" maxlength="7">
            <button class="primary" type="submit">Verify &amp; enable</button>
          </form>
        </div>`;
      $('#twofa-enable').addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          state.user = (await api('/me/2fa/enable', { method: 'POST', body: formData(e.target) })).user;
          renderTwoFactor();
          settingsMsg('2FA enabled. 🎉');
        } catch (err) {
          settingsMsg(err.message, true);
        }
      });
    });
  }
}

$('#logout').addEventListener('click', async () => {
  await api('/auth/logout', { method: 'POST' });
  $('#settings-dialog').close();
  showAuth();
});

$('#logout-all').addEventListener('click', async () => {
  if (!confirm('Sign out of every device, including this one?')) return;
  await api('/auth/logout-all', { method: 'POST' });
  $('#settings-dialog').close();
  showAuth();
});

$('#delete-account').addEventListener('click', async () => {
  const password = prompt('This permanently deletes your account and all notes. Enter your password to confirm:');
  if (!password) return;
  try {
    await api('/me', { method: 'DELETE', body: { password } });
    $('#settings-dialog').close();
    showAuth();
  } catch (err) {
    settingsMsg(err.message, true);
  }
});

// ---------- boot ----------

api('/me')
  .then(({ user }) => signedIn(user))
  .catch(showAuth);
