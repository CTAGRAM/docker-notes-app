# 📝 Docker Notes

A Dockerized notes app with personalized, secure authentication.

**Repository:** https://github.com/CTAGRAM/docker-notes-app

## Quick start: one command

Copy and paste **one** line into your terminal. You don't need to install anything first.

**macOS or Linux** (open the Terminal app):

```bash
curl -fsSL https://raw.githubusercontent.com/CTAGRAM/docker-notes-app/main/install.sh | bash
```

**Windows** (open PowerShell from the Start menu):

```powershell
irm https://raw.githubusercontent.com/CTAGRAM/docker-notes-app/main/install.ps1 | iex
```

The app opens in your browser when it's ready. Click **Create account** and start writing notes.

### What the installer does

1. **Installs Git** if it's missing (Homebrew or Apple's Command Line Tools on macOS, your package manager on Linux, `winget` on Windows). If Git can't be installed, it downloads the app without Git.
2. **Installs Docker** if it's missing (Docker Desktop on macOS and Windows, Docker Engine on Linux).
3. **Starts Docker** if it isn't running, and waits until it's ready.
4. **Downloads the app** to `~/docker-notes-app`, or updates it if it's already there.
5. **Picks a free port**: 3000, or the next free one if 3000 is taken. It remembers the choice for next time.
6. **Builds and starts the app**, checks that it responds, and opens it in your browser.

Run the same command again at any time to start the app after a reboot or to update to the latest version. Your notes are kept.

**The first time, you may need to:**
- enter your computer password (to install software),
- click **Install** if macOS asks to install the Command Line Tools,
- accept Docker Desktop's terms when it opens for the first time,
- on Windows, approve the admin prompt, and restart your PC if Docker asks (it may need to set up WSL). Then run the command again.

Optional settings: `NOTES_DIR` sets where the app is installed and `HOST_PORT` sets the port. For example:

```bash
curl -fsSL https://raw.githubusercontent.com/CTAGRAM/docker-notes-app/main/install.sh | HOST_PORT=8080 bash
```

## Manual install

If you already have [Git](https://git-scm.com/downloads) and [Docker Desktop](https://www.docker.com/products/docker-desktop/) running:

```bash
git clone https://github.com/CTAGRAM/docker-notes-app.git
cd docker-notes-app
docker compose up -d --build
```

Then open **http://localhost:3000**.

Notes are stored in SQLite on the `notes-data` Docker volume, so they survive restarts and rebuilds.

### Everyday commands

Run these inside the `docker-notes-app` folder (on Linux, you may need to put `sudo` in front):

```bash
docker compose ps                   # check it's running (STATUS should say "healthy")
docker compose logs -f              # view logs (Ctrl+C to exit)
docker compose down                 # stop the app (keeps your notes)
docker compose up -d                # start it again
git pull && docker compose up -d --build   # update to the latest version
docker compose down -v              # stop and DELETE all notes and accounts
```

### Troubleshooting

- **"port is already allocated" / port 3000 in use:** the installer handles this for you. Manually, run it on another port, then open http://localhost:8080:
  ```bash
  HOST_PORT=8080 docker compose up -d --build
  ```
  On Windows PowerShell, use `$env:HOST_PORT=8080; docker compose up -d --build` instead.
- **"Cannot connect to the Docker daemon":** Docker isn't running. Start Docker Desktop, wait until it says "Engine running", and try again (or just run the installer, which starts Docker for you).
- **`docker: command not found` on macOS:** open Docker Desktop → Settings → Advanced and install the CLI tools. The installer works even without this.
- **Windows says running scripts is disabled:** use the `irm ... | iex` command above exactly as written. It doesn't need to change your execution policy.

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
| `HOST_PORT`       | `3000`           | Port on your computer (Docker Compose only)             |
| `PORT`            | `3000`           | Port inside the container / for `npm start`             |
| `DB_PATH`         | `/data/notes.db` | SQLite file location                                    |
| `COOKIE_SECURE`   | `false`          | Set `true` when served over HTTPS (also enables HSTS)   |
| `TRUST_PROXY`     | `false`          | Set `true` behind a reverse proxy, so client IPs are correct |
| `AUTH_RATE_LIMIT` | `30`             | Max auth requests per IP per 15 minutes                 |

## Local development (without Docker)

Requires Node.js 22.13 or later (it uses the built-in `node:sqlite`). Run these inside the cloned `docker-notes-app` folder:

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
