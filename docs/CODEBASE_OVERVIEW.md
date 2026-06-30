# Howl Codebase Overview

This document orients a new contributor to the Howl codebase: what the project is, how the three packages fit together, where the major systems live, and how data flows between the frontend, backend, real-time layer, voice/video, and end-to-end encryption. Read it after the [README](../README.md) and before diving into a specific area.

For step-by-step local setup (prerequisites, environment variables, running the dev servers), see the [README](../README.md). For the end-to-end encryption design, see the [DM encryption spec](howl-dm-encryption-spec.md). For the rules that govern changing any wire protocol, see [PROTOCOL_CHANGES.md](PROTOCOL_CHANGES.md).

---

## 1. What Howl is

Howl is a real-time messaging platform in the same family as Discord: servers with text and voice channels, direct messages and group DMs, friends and social presence, voice/video calls and live stages, file attachments, search, and a desktop app. Two things define the architecture and set Howl apart:

- **Direct messages and group DMs are end-to-end encrypted by default** using MLS (RFC 9420) with a post-quantum hybrid ciphersuite. For users on the default recovery mode, Howl's servers relay ciphertext they cannot read.
- **Voice, video, and stages run on a LiveKit SFU** (Selective Forwarding Unit), not a peer-to-peer WebRTC mesh, and the media is end-to-end encrypted with SFrame.

Both systems are covered in detail below.

---

## 2. Repository layout: three packages

The repository holds three separate Node packages, each with its own `package.json`. It is not managed by a monorepo tool; you install and build each package independently.

| Package | Path | What it is |
|---------|------|------------|
| **Frontend + desktop** | `/` (root) | React 19 + TypeScript + Vite single-page app, plus the Electron desktop shell (`main.js`, `preload.js`). Tailwind CSS for styling, i18next for localization. |
| **Backend** | `/backend` | Node.js + Express 5 + Socket.IO API server. Prisma ORM over PostgreSQL. BullMQ job queues backed by Redis. |
| **Admin dashboard** | `/admin` | A separate React + Vite app for platform administration, served independently from the main frontend. |

The root and backend packages share a few conventions (TypeScript, Vitest, ESLint, Zod for validation) but are built and deployed separately.

### Root (frontend + Electron)

| Path | Purpose |
|------|---------|
| `index.html`, `index.tsx` | Entry point; mounts the React app inside an error boundary. |
| `App.tsx` | Root shell: auth bootstrap, routing, global modals, top-level socket wiring. |
| `config.ts` | Resolves the backend API and WebSocket URLs from environment variables and `window.location`. |
| `components/` | React UI. Large views (`AppLayout`, `ChatArea`, `DMView`, voice/call overlays) use `React.lazy` + Suspense for code splitting. |
| `stores/` | Zustand stores, one per application domain (see [§6](#6-frontend-state-zustand-stores)). |
| `services/` | API client, Socket.IO client, the MLS encryption engine, call/voice E2EE, and other client services (see [§7](#7-key-client-services)). |
| `hooks/` | Custom React hooks, including the per-domain socket-event hooks that bridge Socket.IO events into the stores. |
| `utils/`, `contexts/` | Action helpers and React context providers. |
| `main.js`, `preload.js`, `electron/` | Electron main process, the whitelisted preload bridge, and desktop-only integrations. |

### Backend

| Path | Purpose |
|------|---------|
| `backend/src/server.ts` | Builds the Express app and Socket.IO server: middleware, route mounting, the Helmet CSP, and Socket.IO handler wiring. |
| `backend/src/routes/` | The REST surface. Around 80 route files mounted under `/api/v1/` (see [§5](#5-rest-api)). |
| `backend/src/socketHandlers/` | Socket.IO event handlers grouped by domain (connection, channels, voice, stages, DM calls, threads, forum, viewers). |
| `backend/src/middleware/` | `auth` (JWT verification), `validate` (Zod middleware), admin auth, rate limiting. |
| `backend/src/schemas.ts` | Centralized Zod validation schemas for all request input. |
| `backend/src/services/` | Business logic: email, push notifications, MFA crypto, LiveKit admin, server-side escrow, S3/R2 client, and more. |
| `backend/src/queues/` | BullMQ queues and workers (see [§9](#9-background-jobs-bullmq--redis)). |
| `backend/src/mls/` | Server-side MLS delivery service and authentication-server logic (KeyPackage validation, commit authorization). |
| `backend/prisma/schema.prisma` | The database schema (around 100 models). |
| `backend/tests/` | Vitest + Supertest suites. |

---

## 3. High-level data flow

```
+-------------------------------------------------------------------+
|  Frontend (React + Vite, dev port 3000) / Electron desktop        |
|  - services/api.ts      REST client                               |
|  - services/socket/     Socket.IO client                          |
|  - services/mls/        MLS engine (DM E2E encryption)            |
|  - services/call/, voiceE2ee, stageE2ee  LiveKit + SFrame E2EE   |
|  - stores/ (Zustand)    per-domain application state              |
+-------------------------------------------------------------------+
        |                      |                        |
        | REST (HTTPS)         | Socket.IO (WS)         | WebRTC media (DTLS-SRTP)
        | /api/v1/*            | /socket.io/*           | to LiveKit SFU
        v                      v                        v
+--------------------------------------+      +-----------------------+
|  Backend (Express + Socket.IO)       |      |  LiveKit SFU          |
|  - routes/  REST handlers            |      |  (voice/video/stage   |
|  - socketHandlers/  realtime events  |<---->|   media forwarding;    |
|  - mls/     MLS delivery service     | mint |   SFrame E2EE means    |
|  - queues/  BullMQ workers           | token|   the SFU sees only     |
|  - Prisma -> PostgreSQL              |      |   encrypted frames)     |
|  - Redis (adapter + queues + state)  |      +-----------------------+
+--------------------------------------+
```

- The frontend talks to the backend over REST for request/response operations and over Socket.IO for real-time events (new messages, typing, presence, voice participant lists, call signaling).
- Voice/video/stage **media** does not flow through the Express backend. Clients connect directly to the LiveKit SFU; the backend only mints LiveKit access tokens and handles signaling/coordination over Socket.IO.
- DM message **content** is encrypted on the client before it reaches the backend; the backend stores and relays opaque ciphertext.

In development, Vite proxies `/api` and `/socket.io` to the backend (default port 5000), so the browser sees a single origin.

---

## 4. Authentication

Auth combines several mechanisms; the relevant routes live in `backend/src/routes/auth.ts`, `mfa.ts`, `sso.ts`, `adminPasskey.ts`, and `sessions.ts`.

- **JWT sessions.** Login returns a short-lived access token (held in memory / localStorage by the client) plus an HttpOnly, SameSite refresh cookie. Every REST request carries `Authorization: Bearer <token>`; the `authenticateToken` middleware verifies it and sets the user id on the request. The Socket.IO handshake passes the same token, which the server verifies on connect and revalidates periodically.
- **Passwords.** bcrypt hashing with a constant-time dummy-hash comparison to avoid user enumeration. Per-account brute-force lockout after repeated failures.
- **MFA.** TOTP, SMS, and WebAuthn/passkey support. TOTP secrets are encrypted at rest.
- **SSO.** OAuth-based single sign-on; SSO-only accounts have no password hash.
- **Email at rest.** User emails are encrypted at rest and looked up via HMAC hashes, so plaintext email never sits in the database.
- **Sessions.** Only a token hash is stored, never the raw token. Sessions are revocable, and a password change invalidates existing sessions.

Sensitive fields (password hashes, MFA secrets and recovery codes) are never returned in any API response.

---

## 5. REST API

The REST surface is large: roughly 80 route files in `backend/src/routes/`, mounted under a versioned `/api/v1/` router in `backend/src/server.ts`. For backward compatibility, `/api/` is aliased to the same router, so clients that omit the version prefix still work. All input is validated by Zod schemas through a shared `validate()` middleware; responses are gzip/brotli compressed.

Broadly, the routes cover:

- **Core messaging:** `auth`, `users`, `messages`, `servers`, `invites`, `friends`, `dms`, `dmMessages`, `threads`, `polls`, `reports`, `search`, `notifications`.
- **Encryption:** `dmKeys` (the key-vault/recovery routes), `mls` (the MLS delivery service: KeyPackage publish/fetch, group create, commit relay), `dmHistoryArchive` (the cross-device encrypted history archive).
- **Voice/video:** `livekit` (mint access tokens, room admin), `livekitWebhook`, `stages`.
- **Servers and community:** roles, permissions, settings, categories/channels, welcome screens, applications, vanity URLs, insights, folders, forums, custom emoji/stickers/soundboard, Discord import, age gates.
- **Accounts and billing:** `billing` (Stripe), `powerUps`, `sessions`, `mfa`, `sso`, `passkeys`, `family`, `connectedApps`, `gameAccounts`, `userPreferences`, `settings`, `securityEvents`.
- **Discovery and public surfaces:** `discover`, `publicDiscover`, `publicServer`, `publicConfig`, `showcase`, `seo`, `linkPreview`, GIF search.
- **Compliance:** `gdpr` (data export and full account deletion), `push` (Web Push subscriptions).
- **Admin:** a family of `admin*` routes for the admin dashboard, gated behind a dedicated admin auth layer (admin JWT plus an access-proxy assertion).

Health checks: `GET /health` (basic liveness) and `GET /api/health` (includes database connectivity).

---

## 6. Frontend state (Zustand stores)

Application state is split into per-domain Zustand stores in `stores/`, re-exported from `stores/index.ts`. Each store owns one slice of UI/data state and is updated either by user actions (via the REST client) or by incoming socket events (via the per-domain socket-event hooks in `hooks/`).

Notable stores include `authStore`, `appStore`, `serverStore`, `messageStore`, `dmStore`, `notificationStore`, `voiceStore`, `socialStore`, `navigationStore`, `uiStore`, `typingStore`, `viewerStore`, `threadPollStore`, `calendarStore`, `communityStore`, `discoveryStore`, `serverFolderStore`, and `updateStore`.

---

## 7. Key client services

The `services/` directory holds the singletons and engines that the UI builds on:

- **`services/api/`** - the REST client, with token management, short-lived response caching, and silent token refresh on 401.
- **`services/socket/`** - the Socket.IO client, organized into per-domain modules (channels, DM messages, DM calls, voice, stages, threads, polls, social, notifications, viewers, and so on) plus reconnection logic.
- **`services/mls/`** - the MLS engine for DM/group-DM end-to-end encryption (see [§8](#8-end-to-end-encryption-mls)).
- **`services/dmKeyManager.ts`, `services/dmCrypto.ts`** - the client-side key vault: deriving keys from the user's password, sealing/opening the recovery blob, and managing the roaming identity used for voice/stage keying.
- **`services/call/`, `services/voiceE2ee.ts`, `services/stageE2ee.ts`** - LiveKit integration and SFrame end-to-end encryption for DM calls, server voice channels, and stages (see [§10](#10-voicevideo-and-stages-livekit-sfu)).
- **`services/fileCrypto.ts`** - per-file AES-256-GCM encryption for DM attachments.

---

## 8. End-to-end encryption (MLS)

Every DM and group DM is end-to-end encrypted with **MLS (Messaging Layer Security, RFC 9420)** via the `ts-mls` library. One MLS group backs each DM channel. This is the only DM content crypto and the only DM key-distribution mechanism; there is no plaintext fallback and no separate "secure" toggle. The full design is in the [DM encryption spec](howl-dm-encryption-spec.md); the essentials:

- **Ciphersuite.** Codepoint 83, `MLS_256_XWING_AES256GCM_SHA512_Ed25519` - a post-quantum **hybrid** suite (X-Wing KEM = X25519 + ML-KEM-768, AES-256-GCM, SHA-512, Ed25519 signatures). Confidentiality is post-quantum hybrid (protecting against harvest-now-decrypt-later); message authentication is classical Ed25519, with a migration to a PQ signature scheme tracked.
- **Where group state lives.** MLS group/ratchet state is stored client-side in an IndexedDB database (`howl_mls`), encrypted at rest. To avoid two browser tabs corrupting the single-use message ratchet, exactly one tab holds a writer lease (`navigator.locks`) and runs MLS in a SharedWorker; other tabs read through it. The server never holds MLS group state for a default-mode user.
- **Per-device identity.** Each device has its own MLS leaf identity (an Ed25519 signing keypair plus credential bytes), persisted only on that device and never roamed. This is what lets one account participate from multiple devices without leaf collisions.
- **Key distribution.** New members join a group via an MLS `Welcome` produced against their published KeyPackages, or self-join an existing group via an External Commit. KeyPackages are published to the MLS directory service (`backend/src/routes/mls.ts`).
- **Server as delivery service.** The backend stores opaque MLS ciphertext and relays commits/messages over Socket.IO. It enforces membership authority: only a group owner can authorize removing a member (a two-phase "mark, then commit" kick), so a member cannot evict an arbitrary peer.
- **Recovery models.** Secrets live in a client-sealed recovery blob. Under the default **Self recovery** mode the server holds no key that can read the user's DM content. A user may opt into **Server recovery**, which uploads a server-readable escrow copy of their key material so they can recover after losing their password; for those users (and only those) the server can decrypt their DM content out of band. The trust boundary is documented in full in the spec.
- **Cross-device history.** Because MLS messages are decryptable only by the device that processed the relevant ratchet step, a per-account encrypted archive (`services/mls/mlsHistoryArchiveSync.ts`, `backend/src/routes/dmHistoryArchive.ts`) converges a user's own readable history across their devices without exposing plaintext to the server.

Server text channels are not end-to-end encrypted, because server moderators need visibility into their channels. The E2E guarantees described here apply to DMs, group DMs, and call media.

---

## 9. Real-time (Socket.IO)

Real-time events flow over Socket.IO, authenticated by the same JWT used for REST. Handlers are organized by domain in `backend/src/socketHandlers/`, and on the client the per-domain hooks in `hooks/` translate incoming events into store updates.

- **Rooms.** The server places each socket into rooms for the resources it can see: per-server, per-channel, per-DM, and per-voice/stage. On connect, the server batch-loads the user's memberships and joins the appropriate rooms in one pass (rather than relying on the client to emit a join per resource), applying the same permission checks the REST routes apply.
- **Event classes.** New and edited/deleted messages, typing indicators, presence/status changes, voice and stage participant lists, DM call ring/accept/decline/end signaling, MLS commit/welcome delivery, and more.
- **Scaling.** When Redis is configured, Socket.IO uses the Redis adapter so multiple backend instances share one pub/sub bus and shared state (online users, voice participants). Without Redis, the backend runs single-instance with an in-memory fallback - fine for local development.

Any change to a socket event, REST payload, or E2EE crypto must follow the additive evolution rules in [PROTOCOL_CHANGES.md](PROTOCOL_CHANGES.md).

---

## 10. Voice/video and stages (LiveKit SFU)

Voice channels, video, and live stages run on a **LiveKit SFU**, not a peer-to-peer mesh. Clients publish and subscribe to media tracks through the SFU, which forwards them; this scales to many participants without the N-squared connection cost of a mesh. The backend's role is signaling and authorization: it mints LiveKit access tokens (`backend/src/routes/livekit.ts`) and coordinates participant state over Socket.IO. Media never transits the Express server.

All call media is **end-to-end encrypted with SFrame** (LiveKit's `ExternalE2EEKeyProvider`) over the DTLS-SRTP transport, so the SFU forwards frames it cannot decrypt. The three call surfaces key SFrame differently:

- **DM calls** derive their SFrame base key from the DM channel's live MLS group via the RFC 9420 exporter (`hooks/useDMCall.ts`, `services/call/`). The call therefore inherits MLS forward secrecy and post-compromise security. If no MLS key is available (for example, a call placed before the group is ready), the call is blocked and carries no media rather than silently downgrading to plaintext.
- **Server voice channels and stages** have no MLS group. They use a key-holder scheme: the oldest verified participant generates the SFrame session key and wraps it to each peer's public key, distributing it over dedicated socket events (`services/voiceE2ee.ts`, `services/stageE2ee.ts`). The key rotates when a participant leaves, for forward secrecy.

For local development, run a LiveKit server via Docker and set `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` in `backend/.env` (see the README).

---

## 11. Database (Prisma + PostgreSQL)

The data model is defined in `backend/prisma/schema.prisma` (around 100 models) and accessed through Prisma over PostgreSQL. Central models include `User`, `Server`, `ServerMember`, `ServerRole`, `Channel`, `Message`, `DMChannel`, `DMParticipant`, `DMMessage`, and `Session`, alongside models for MLS state delivery, history archive, billing, MFA/passkeys, moderation, forums, events/polls, and admin auditing.

- **Migrations** are applied with `npx prisma migrate dev` in development. Migrations must be additive; destructive schema changes require explicit approval and a two-phase deploy (see [PROTOCOL_CHANGES.md](PROTOCOL_CHANGES.md)).
- **Full-text search** uses PostgreSQL `tsvector` columns with GIN indexes on `Message` and `DMMessage`, exposed through the `search` routes and a Ctrl+K search modal in the UI.

---

## 12. Background jobs (BullMQ + Redis)

Heavy or asynchronous work is offloaded to BullMQ workers in `backend/src/queues/workers/` when Redis is available. Queues cover email delivery, image processing (compression, EXIF stripping, thumbnails), data import/export, notification fan-out, recurring cleanup (expired invites, stale sessions, retention, orphaned attachments), and periodic activity refreshes for connected-app integrations. Without Redis, these operations run inline (synchronous fallback), so the app still works single-instance in development.

---

## 13. Object storage (S3 / R2)

User uploads (avatars, banners, message attachments, custom emoji, stickers, soundboard sounds) go to S3-compatible object storage when configured; the production deployment uses Cloudflare R2. In development with no bucket configured, files are written to local disk under `backend/uploads/`. The upload pipeline applies a MIME allowlist with magic-byte verification, EXIF/metadata stripping, decompression-bomb protection, image compression, and thumbnail generation. Encrypted DM attachments are an exception to content inspection: they arrive as ciphertext bound to a DM context and are stored opaquely.

---

## 14. Observability and operations

- **Logging.** Structured JSON logging via Pino (`backend/src/logger.ts`), pretty-printed in development and raw JSON in production, with per-request IDs.
- **Error tracking.** Sentry on both backend (`@sentry/node`) and frontend (`@sentry/react`), enabled by setting the relevant DSN. Authorization and cookie headers are stripped from events before they leave the process.
- **Graceful shutdown.** On SIGTERM/SIGINT the backend stops accepting connections, drains in-flight jobs, and closes Redis/Prisma cleanly (`backend/src/shutdown.ts`).
- **Security hardening.** Helmet enforces a strict Content-Security-Policy in production; production startup refuses to boot with default/weak secrets for the JWT and LiveKit keys.

---

## 15. Desktop app (Electron)

The same Vite-built frontend ships as an Electron desktop app for Windows, macOS, and Linux. The Electron main process (`main.js`) manages the window, auto-updates, and OS integration; a preload script (`preload.js`) exposes only a whitelisted API to the renderer. Build commands (`npm run dist`, `dist:mac`, `dist:linux`) are documented in the README.

---

## 16. Where to look first

| You want to... | Start here |
|----------------|-----------|
| Add or change a REST endpoint | `backend/src/routes/`, schemas in `backend/src/schemas.ts`, mounted in `backend/src/server.ts` |
| Add or change a real-time event | `backend/src/socketHandlers/`, client hooks in `hooks/`, and [PROTOCOL_CHANGES.md](PROTOCOL_CHANGES.md) |
| Understand DM encryption | [DM encryption spec](howl-dm-encryption-spec.md), then `services/mls/` and `backend/src/mls/` |
| Work on voice/video/stages | `services/call/`, `services/voiceE2ee.ts`, `services/stageE2ee.ts`, `hooks/useDMCall.ts`, `backend/src/routes/livekit.ts` |
| Change frontend state | `stores/` and the per-domain socket hooks in `hooks/` |
| Change the data model | `backend/prisma/schema.prisma` (additive migrations only) |
| Add a background job | `backend/src/queues/` and `backend/src/queues/workers/` |

When in doubt, the source of truth for what exists is the code itself: `backend/src/routes/`, `backend/src/socketHandlers/`, `backend/prisma/schema.prisma`, `services/`, and `stores/`.
