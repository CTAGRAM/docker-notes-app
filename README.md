# 📝 Docker Notes

A Dockerized notes app with personalized, secure authentication.

## Quick start

```bash
docker compose up -d --build
```

Open http://localhost:3000, create an account and start writing notes.
Data is stored in SQLite on the `notes-data` Docker volume, so it survives restarts and rebuilds.

```bash
docker compose logs -f     # view logs
docker compose down        # stop (keeps data)
docker compose down -v     # stop and delete all data
```

## Features

### Authentication & security
- **User ID + password login.** Sign in with your user ID or your email.
- **scrypt password hashing** with a per-user salt and constant-time comparison.
- **Password policy:** 8–128 characters, must contain a letter and a number, and must not contain the user ID. The sign-up form shows a strength meter.
- **Two-factor authentication (TOTP):** scan a QR code with Google Authenticator, Authy, 1Password and similar apps.
- **Account lockout** for 15 minutes after 5 failed attempts.
- **Rate limiting** on the auth endpoints.
- **Server-side sessions:** a random token sits in an `HttpOnly`, `SameSite=Strict` cookie and only its SHA-256 hash is stored. Sessions expire after 7 days.
- **Session management:** see your active sessions and sign out of every device at once. A password change signs out all other devices.
- **Sign-in activity log** showing successful and failed attempts with IP and browser.
- **CSRF protection** through a required custom header, plus helmet security headers (a strict CSP and more).
- **No user enumeration:** the error message and response timing are the same whether or not a user exists.
- The container runs as a non-root user on a read-only filesystem with `no-new-privileges`.

### Personalization
- Time-of-day greeting with your display name, and an initials avatar.
- Light or dark theme and a custom accent color, saved to your account.

### Notes
- Create, edit and delete notes.
- Pin, archive, color labels and tags (filter by clicking a tag).
- Live search across titles, content and tags.
- Export all your notes as JSON.
- Delete your account and all its data (requires your password).

## Configuration

| Variable          | Default          | Description                                             |
|-------------------|------------------|---------------------------------------------------------|
| `PORT`            | `3000`           | HTTP port                                               |
| `DB_PATH`         | `/data/notes.db` | SQLite file location                                    |
| `COOKIE_SECURE`   | `false`          | Set `true` when served over HTTPS (also enables HSTS)   |
| `TRUST_PROXY`     | `false`          | Set `true` behind a reverse proxy, so client IPs are correct |
| `AUTH_RATE_LIMIT` | `30`             | Max auth requests per IP per 15 minutes                 |

## Local development (without Docker)

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`).

```bash
npm install
npm run dev     # http://localhost:3000
npm test        # 12 API tests: auth, 2FA, lockout, sessions, notes isolation
```

## Stack

Node.js 24 · Express 5 · SQLite (`node:sqlite`) · helmet · express-rate-limit · otplib · vanilla JS frontend (no build step)

## API overview

| Method | Path                     | Description                          |
|--------|--------------------------|--------------------------------------|
| POST   | `/api/auth/register`     | Create an account                    |
| POST   | `/api/auth/login`        | Sign in (`login`, `password`, `totp`)|
| POST   | `/api/auth/logout`       | Sign out of this device              |
| POST   | `/api/auth/logout-all`   | Sign out of all devices              |
| GET/PATCH/DELETE | `/api/me`      | Profile, preferences, delete account |
| POST   | `/api/me/password`       | Change password                      |
| POST   | `/api/me/2fa/setup` · `enable` · `disable` | Manage 2FA         |
| GET    | `/api/me/sessions` · `/api/me/activity` | Security overview     |
| GET/POST | `/api/notes`           | List (`q`, `tag`, `archived`) / create |
| PATCH/DELETE | `/api/notes/:id`   | Update / delete a note               |
| GET    | `/api/notes/export`      | Download notes as JSON               |

Every non-GET request must send the `X-Requested-With: notes-app` header.
