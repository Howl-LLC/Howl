# Howl Backend

Express API + Socket.IO server. Uses **Prisma + PostgreSQL** for auth, servers, channels, messages, DMs, and friends. Voice/DM call state is in-memory (see root [docs/CODEBASE_OVERVIEW.md](../docs/CODEBASE_OVERVIEW.md)).

## Before you start

1. **Node.js** (LTS) — [nodejs.org](https://nodejs.org). Check: `node -v`, `npm -v`.
2. **PostgreSQL** — Required. Set `DATABASE_URL` in `backend/.env` (copy from `.env.example`).
3. **JWT_SECRET** — Set in `backend/.env` (any long random string).

## Run it

From the `backend` folder:

```bash
npm install
# Copy .env.example to .env and set DATABASE_URL, JWT_SECRET
npx prisma migrate dev   # create DB and run migrations
npm run dev
```

Server runs at **http://localhost:5000** (frontend expects 5000 unless you set `VITE_BACKEND_PORT` in root `.env`).

## Health checks

- **GET http://localhost:5000/health** — `{ "status": "ok", "timestamp": "..." }`.
- **GET http://localhost:5000/api/health** — Includes DB: `{ "status": "ok", "db": "connected" }` or 503 with a hint if DB is down.

## API (examples)

- **Register:** POST http://localhost:5000/api/auth/register  
  Body: `{ "username": "TestUser", "email": "test@example.com", "password": "password123" }`  
  Returns `user` + `token`.

- **Login:** POST http://localhost:5000/api/auth/login  
  Body: `{ "email": "test@example.com", "password": "password123" }`  
  Returns `user` + `token`.

All protected routes need `Authorization: Bearer <token>`. Socket.IO connects with the same token in `auth.token`. See [docs/CODEBASE_OVERVIEW.md](../docs/CODEBASE_OVERVIEW.md) for full API, socket events, and troubleshooting.
