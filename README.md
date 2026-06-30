# Howl

A real-time messaging platform: servers, text and voice channels, direct messages,
friends, and voice/video calls. Think of it as a self-hostable alternative to Discord,
with end-to-end encrypted DMs and a desktop app.

**Direct messages and group DMs are end-to-end encrypted by default** using MLS
(RFC 9420) with a post-quantum hybrid ciphersuite (X25519 + ML-KEM-768). On the default
recovery mode, Howl's servers only relay ciphertext they can't read. Voice, video, and
stage calls are end-to-end encrypted with SFrame. See the
[DM encryption spec](docs/howl-dm-encryption-spec.md) for the design and trust boundary.

> **Just want to run your own private Howl?** This README covers running from source for
> **development**. To deploy a self-hosted instance with Docker (your own server, your own
> users, all Pro features free), follow the **[Self-hosting guide](docs/self-hosting.md)** instead.

---

## Features

- **Servers & channels**: text and voice channels, roles and permissions, invites, threads, search.
- **Direct messages**: 1:1 and group DMs, end-to-end encrypted by default.
- **Voice & video**: calls and live stages over a [LiveKit](https://livekit.io) SFU (scales past peer-to-peer), end-to-end encrypted with SFrame.
- **Social**: friends, presence (online / away / Do Not Disturb / invisible), profiles and badges.
- **Cross-platform**: web app plus a desktop app (Electron) for Windows, macOS, and Linux.
- **Notifications**: Web Push, plus an installable PWA for mobile.

## Tech stack

| Layer | Stack |
|-------|-------|
| **Frontend** | React 19 + TypeScript + Vite + Tailwind CSS (also packaged as an Electron desktop app) |
| **Backend** | Node.js + Express 5 + Socket.IO, Prisma ORM over PostgreSQL |
| **Real-time** | Socket.IO (Redis adapter for scaling) |
| **Voice/Video** | LiveKit SFU with SFrame end-to-end encryption |
| **Jobs** | BullMQ + Redis |
| **Encryption** | MLS (`ts-mls`) for DMs, X-Wing post-quantum hybrid key exchange |

The repo holds three packages, each with its own `package.json`: the frontend + desktop app
(root), the `backend` API server, and a separate `admin` dashboard. For a full tour of the
architecture, read **[docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md)**.

---

## Prerequisites

| Requirement | Purpose |
|-------------|---------|
| **Node.js** (LTS, 20.x or 22.x) | Frontend and backend runtime |
| **npm** | Install dependencies |
| **PostgreSQL** | Database for users, servers, messages, DMs, friends |
| **Redis** *(optional in dev)* | Required in production for Socket.IO scaling and the job queue. Without it, the app runs single-instance with an in-memory fallback. |
| **LiveKit** *(optional in dev)* | SFU for voice/video. Run via Docker locally; see [Voice and video](#voice-and-video) below. |
| **Docker** *(optional in dev)* | Only needed to run LiveKit locally for voice/video. |

Check your versions:

```bash
node -v    # v20.x or v22.x
npm -v
psql --version
```

Install Node.js from [nodejs.org](https://nodejs.org). PostgreSQL is required: auth and
most API routes won't work without a database.

---

## Quick start

From a fresh clone:

```bash
# 1. Install dependencies (root + backend)
npm install
cd backend && npm install && cd ..

# 2. Configure the backend
cp backend/.env.example backend/.env
# Edit backend/.env: at minimum set DATABASE_URL and JWT_SECRET (see Configuration below)

# 3. Create the database tables
cd backend && npx prisma migrate dev && cd ..

# 4. Start the backend (Terminal 1)
cd backend && npm run dev

# 5. Start the frontend (Terminal 2, from the project root)
npm run dev
```

Open **http://localhost:3000** and register a user.

> **Verifying your email in dev:** with no email provider configured, Howl doesn't send a
> real email; it prints the 6-digit verification code to the **backend terminal** (look for
> a `DEV email verification code` log line, with the code in the `code` field). Enter that
> code to finish signing up, then log in.

If `npx prisma migrate dev` can't find the database, create it first
(e.g. `CREATE DATABASE howl;`) and re-run the migration in step 3.

---

## Configuration

Only two variables are required to run locally. Copy the example and edit:

```bash
cp backend/.env.example backend/.env
```

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | **Yes** | PostgreSQL connection string, e.g. `postgresql://postgres:postgres@localhost:5432/howl?schema=public` |
| `JWT_SECRET` | **Yes** | Long random string used to sign login tokens. Use a strong value in production. |
| `PORT` | No | Backend port (default `5000`). |
| `NODE_ENV` | No | `development` or `production`. |

A minimal `backend/.env`:

```env
NODE_ENV=development
PORT=5000
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/howl?schema=public"
JWT_SECRET=change-me-to-a-long-random-string
```

Everything else is **optional** and only needed for specific features or production:
Redis (scaling + job queue), S3-compatible object storage (uploads), LiveKit (voice/video),
Sentry (error tracking), email, and billing. Each is documented inline in
[`backend/.env.example`](backend/.env.example). The frontend has its own optional
[`.env.example`](.env.example), which isn't needed for local dev since Vite proxies the API to the backend.

---

## Running on your local network (LAN)

To open the app from another device (phone, another PC) on the same network:

1. The backend already listens on `0.0.0.0`, so it's reachable on your LAN. Start the **frontend** with the host exposed by running `VITE_HOST=0.0.0.0 npm run dev` (or `npm run dev -- --host`), since Vite binds to `localhost` by default.
2. On the other device, open `http://<your-machine-ip>:3000` (find your IP with `ipconfig` on Windows, or `ip addr` / `ifconfig` on macOS/Linux).
3. If the backend runs on a non-default port, set `VITE_BACKEND_PORT` in the project root `.env`.

**Note:** browsers only allow microphone access over **HTTPS** or **localhost**. Over plain
HTTP from a LAN IP the app loads, but voice may be blocked. This isn't an issue in production (HTTPS).

---

## Voice and video

Voice/video runs on a **LiveKit SFU**. For local development, run it via Docker:

```bash
docker run --rm -p 7880:7880 -p 7881:7881 -p 50000-50060:50000-50060/udp \
  -e LIVEKIT_KEYS="devkey: secret" livekit/livekit-server
```

Then set the matching values in `backend/.env`:

```env
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_API_KEY=devkey
LIVEKIT_API_SECRET=secret
```

For production, deploy LiveKit on any server with TURN configured; see
[`livekit.yaml.example`](livekit.yaml.example) for an annotated config.

---

## Common scripts

**Project root** (frontend + desktop):

| Script | Description |
|--------|-------------|
| `npm run dev` | Start the Vite dev server (port 3000). |
| `npm run dev:backend` | Start the backend from the root. |
| `npm run build:frontend` | Production frontend build to `dist/`. |
| `npm run dev:electron` | Launch the Electron desktop app in dev. |
| `npm run dist` / `dist:mac` / `dist:linux` | Package the desktop app for Windows / macOS / Linux. |
| `npm run lint` | Run ESLint. |

**Backend** (`cd backend`):

| Script | Description |
|--------|-------------|
| `npm run dev` | Start the backend (port 5000). |
| `npm test` | Run the test suite (Vitest). Requires a running PostgreSQL. |
| `npx prisma migrate dev` | Apply database migrations. |
| `npm run prisma:seed` | Seed the database. |
| `npm run prisma:studio` | Open Prisma Studio (database GUI). |

---

## Verify it's working

- **Backend health:** http://localhost:5000/health → `{ "status": "ok", ... }`
- **Backend + database:** http://localhost:5000/api/health → `{ "status": "ok", "pdq": "...", ... }`. A `503` with `{ "status": "degraded" }` means PostgreSQL isn't reachable; check `DATABASE_URL`.
- **App:** http://localhost:3000 → register, log in, and you should land in the main UI.

---

## Desktop app

Howl ships as an Electron desktop app for Windows, macOS, and Linux, built from the same
frontend as the web app.

```bash
# Dev: run the backend and frontend first, then launch Electron pointed at the dev server
npm run dev:electron

# Package for distribution. Set the backend URL first, then build for your platform:

# Windows (PowerShell)
$env:BACKEND_URL="https://your-backend.example.com"; npm run dist

# macOS (must run on a Mac) or Linux
export BACKEND_URL=https://your-backend.example.com
npm run dist:mac     # or: npm run dist:linux
```

Output goes to the `release/` directory. macOS builds must run on a Mac; Windows and Linux
builds work from any OS.

---

## Security & privacy

- **End-to-end encryption** for all DMs and group DMs (MLS / RFC 9420), and for voice, video, and stage calls (SFrame). A channel that isn't encryption-ready fails the send closed, never silently plaintext.
- **Passwords** hashed with bcrypt; per-account brute-force lockout.
- **MFA** via TOTP and WebAuthn/passkeys.
- **Emails encrypted at rest**; looked up by HMAC hash, never stored in plaintext.
- **Uploads** are checked by MIME allowlist + magic bytes, stripped of EXIF metadata, and protected against decompression bombs.
- **Strict Content-Security-Policy** in production, Zod validation on every API input, and structured audit logging.

Found a vulnerability? Please follow [SECURITY.md](SECURITY.md) instead of opening a public issue.

---

## Troubleshooting

| Problem | What to check |
|---------|---------------|
| **500 on login/API** | Is PostgreSQL running? Is `DATABASE_URL` correct? Run `cd backend && npx prisma migrate dev`. Check http://localhost:5000/api/health. |
| **"API not found" (404)** | Backend not running or on the wrong port. The frontend expects port 5000 unless `VITE_BACKEND_PORT` is set. |
| **Messages not sending/updating live** | Socket.IO may be disconnected. Check the browser Network tab and backend logs. |
| **Voice/video not working** | Is LiveKit running (see [Voice and video](#voice-and-video))? Are `LIVEKIT_*` vars set? Browsers also require HTTPS or localhost for the mic. |
| **Uploads disappear on restart** | You're on local-disk storage. Configure S3-compatible object storage in `backend/.env` for persistence. |
| **Redis connection errors** | If you don't need scaling, leave `REDIS_URL` empty; the app falls back to in-memory. |
| **Tests failing** | Tests need a running PostgreSQL. Run `cd backend && npx prisma migrate dev` first. |

For deeper architecture and debugging notes, see [docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md).

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) to get started.
Contributions are accepted under the [Contributor License Agreement](CLA.md).

## License and docs

- **License:** [AGPL-3.0-only](LICENSE).
- **Security:** report vulnerabilities per [SECURITY.md](SECURITY.md).
- **Architecture:** [docs/CODEBASE_OVERVIEW.md](docs/CODEBASE_OVERVIEW.md)
- **DM encryption design:** [docs/howl-dm-encryption-spec.md](docs/howl-dm-encryption-spec.md)
- **Self-hosting:** [docs/self-hosting.md](docs/self-hosting.md)
- **Theming:** [docs/CREATING_THEMES.md](docs/CREATING_THEMES.md)
