# Releasing Howl for testers (no DB on their side)

To send the app to someone who doesn't have the backend or database set up:

## 1. Host the backend and database

Deploy the `backend` somewhere (e.g. Render, Fly.io, or any VPS/PaaS host) with a PostgreSQL database. Set `DATABASE_URL` and other env vars. Run migrations:

```bash
cd backend
npx prisma migrate deploy
```

## 2. Build the app with your backend URL

From the project root, set the backend URL and build the Windows exe:

**Option A – environment variable (PowerShell):**

```powershell
$env:BACKEND_URL = "https://your-backend.example.com"
npm run dist
```

**Option B – config file:**

1. Copy `release-config.example.json` to `release-config.json`.
2. Set `BACKEND_URL` in `release-config.json` to your backend URL (no trailing slash), e.g. `https://your-backend.example.com`.
3. Run:

```bash
npm run dist
```

The built exe will talk to that backend only (URL is baked into the bundle).

## 3. Share with the tester

Give them:

1. The portable exe from `release/` (e.g. **Howl 1.0.0.exe**).
2. Have them register an account through the app's registration page.

They run the exe, create an account, and use the app against your hosted backend. No database or backend setup on their side.

---

- **Local / dev builds:** Use `npm run dist` (no `BACKEND_URL`). The app will use `http://localhost:3000` and expect the backend to be running locally.
- **Release builds:** Use `npm run dist` with `BACKEND_URL` or `release-config.json` so the exe points at your hosted backend.
