# Backend production & hosting (privacy-focused)

This doc covers what the backend needs for production and how to host it **without collecting or viewing user data**.

---

## 1. Production checklist (must-do)

### Environment (backend `.env`)

| Variable | Development | Production |
|----------|-------------|------------|
| `NODE_ENV` | `development` | **`production`** |
| `JWT_SECRET` | any / dev default | **Long random secret (e.g. 32+ chars). Never commit.** |
| `DATABASE_URL` | local PostgreSQL | **Managed Postgres URL from your host** |
| `PORT` | 5000 | Set by the host (many platforms inject `PORT`) |
| `FRONTEND_ORIGIN` | (none) | **Production:** comma-separated origins for CORS (e.g. `https://yourapp.com`). If unset, CORS allows `*`. |

- In production, the server **exits** if `JWT_SECRET` is missing (no default).
- Generate a secret once: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` and set `JWT_SECRET` to that value.

### Security

- **CORS:** The app currently uses `cors({ origin: '*' })`. For production, restrict to your frontend origin(s), e.g. `https://yourapp.com`, so only your app can call the API.
- **HTTPS:** Backend must be served over HTTPS in production (hosting platforms provide this).
- **Secrets:** Never commit `backend/.env`. Use the host’s “environment variables” or “secrets” for `JWT_SECRET` and `DATABASE_URL`.

### Build & run

- Build: `npm run build` (TypeScript → `dist/`).
- Run: `npm start` (runs `node dist/server.js`).
- After deploy, run migrations against the production DB once: `npx prisma migrate deploy` (or your host’s build/start script can run it).

### Privacy / “I don’t collect or see data”

- **No analytics:** The backend does not include analytics or tracking. Don’t add any if you want to preserve user privacy.
- **No request logging of PII:** Avoid logging request bodies, tokens, or user identifiers. Current code only logs errors (e.g. auth failures) and startup lines; keep it that way.
- **Data lives in the DB only:** You don’t need to “see” anything; all data stays in PostgreSQL. To avoid having access, use a **managed Postgres** service and don’t use Prisma Studio or DB UI in production, or restrict DB access to the backend only.
- **You don’t need to inspect traffic:** No need for request inspection or user tracking; the app works without it.

---

## 2. How to host the backend

You need: **Node process + PostgreSQL**. The backend is stateless except for the database.

### Option A: Managed platform (PaaS)

Most managed Node platforms follow the same shape:

- **Backend:** Connect your Git repo, set the root to `backend` (or deploy from the `backend` folder). Set env: `NODE_ENV=production`, `JWT_SECRET`, `DATABASE_URL`. Build: `npm install && npm run build`. Start: `npm start`.
- **Database:** Use the platform’s managed Postgres (or any external Postgres) and point `DATABASE_URL` at it. You don’t have to open a DB UI; the backend is the only consumer.
- **Migrations:** In a deploy step or one-off job: `npx prisma migrate deploy`.
- **Privacy:** No analytics by default. You don’t need to enable any logging of user data.

### Option B: Self‑hosted (VPS)

- A VPS + Node + PostgreSQL. Run the backend with `npm start` behind a reverse proxy (e.g. Nginx/Caddy) for HTTPS. The DB can stay on the same machine or a separate DB server; you can choose not to install any DB GUI to avoid “seeing” data.
- Set `DATABASE_URL` and `JWT_SECRET`; run `npx prisma migrate deploy` once.

### Summary

| Hosting          | Backend | Postgres                   | Privacy note                              |
|------------------|---------|----------------------------|-------------------------------------------|
| Managed platform | ✅      | Managed add-on or external | No analytics; don’t use a DB UI if desired |
| VPS (self-host)  | ✅      | Install yourself           | Full control; no extra services           |

---

## 3. What to do before going live

1. Set `NODE_ENV=production` and a strong `JWT_SECRET` in the host’s env.
2. Point `DATABASE_URL` to the production Postgres; run `npx prisma migrate deploy` once.
3. Restrict CORS to your frontend origin(s) in `server.ts` when `NODE_ENV === 'production'`.
4. Ensure the frontend in production uses the **production backend URL** (e.g. `VITE_BACKEND_URL=https://your-backend.example.com` or same-origin if you serve API and frontend together).
5. Don’t add analytics or request logging that captures user data; keep the backend minimal and privacy-preserving.

---

## 4. Optional: tighten CORS in code

In `backend/src/server.ts` you can do:

```ts
app.use(cors({
  origin: process.env.NODE_ENV === 'production' && process.env.FRONTEND_ORIGIN
    ? process.env.FRONTEND_ORIGIN.split(',')
    : '*',
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));
```

Then in production set `FRONTEND_ORIGIN=https://your-app.com` (or multiple origins comma-separated). Leave unset in dev to keep `*`.

---

*Goal: backend is production-ready, hostable on any managed platform or a self-hosted VPS, with no data collection and no need for you to view or inspect user data.*
