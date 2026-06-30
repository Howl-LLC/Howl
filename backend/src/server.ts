// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import './loadEnv.js';
import './instrument.js';
import crypto from 'crypto';
import { hashToken } from './utils/sessionUtils.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import http from 'http';
import express from 'express';
import { Server as SocketServer } from 'socket.io';
import { setIO } from './socketIO.js';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import pinoHttp from 'pino-http';
import { prisma } from './db.js';
import { logger, generateRequestId } from './logger.js';
import { sanitizeLogString } from './utils/sanitizeLogString.js';
import { Sentry, sentryEnabled } from './instrument.js';
import { registerShutdownDeps } from './shutdown.js';
import authRoutes from './routes/auth.js';
import profileRoutes from './routes/profile.js';
import messageRoutes from './routes/messages.js';
import serverRoutes from './routes/servers.js';
import inviteRoutes from './routes/invites.js';
import dmRoutes from './routes/dms.js';
import userRoutes from './routes/users.js';
import userPreferenceRoutes from './routes/userPreferences.js';
import friendRoutes from './routes/friends.js';
import uploadRoutes, { getPdqInitState } from './routes/upload.js';
import serverSettingsRoutes from './routes/serverSettings.js';
import serverCommunityRoutes from './routes/serverCommunity.js';
import serverVerificationRoutes from './routes/serverVerificationRequests.js';
import serverWelcomeRoutes from './routes/serverWelcome.js';
import serverApplicationRoutes from './routes/serverApplications.js';
import rolePickersRoutes from './routes/rolePickers.js';
import serverInsightsRoutes from './routes/serverInsights.js';
import billingRoutes from './routes/billing.js';
import sessionRoutes from './routes/sessions.js';
import familyRoutes from './routes/family.js';
import ssoRoutes from './routes/sso.js';
import mfaRoutes from './routes/mfa.js';
import adminRoutes from './routes/admin.js';
import adminAuthRoutes from './routes/adminAuth.js';
import adminPasskeyRoutes from './routes/adminPasskey.js';
import adminAccountRoutes from './routes/adminAccounts.js';
import adminServerRoutes from './routes/adminServers.js';
import adminVerificationRequestRoutes from './routes/adminVerificationRequests.js';
import { ADMIN_JWT_SECRET, authenticateAdminToken as adminAuthMiddleware, requireSuperAdmin, enforcePasswordChange } from './middleware/adminAuth.js';
import { cfAccessAuth } from './middleware/cfAccessAuth.js';
import powerUpRoutes from './routes/powerUps.js';
import discordImportRoutes from './routes/discordImport.js';
import livekitRoutes from './routes/livekit.js';
import livekitWebhookRoutes from './routes/livekitWebhook.js';
import searchRoutes from './routes/search.js';
import gdprRoutes from './routes/gdpr.js';
import settingsRoutes from './routes/settings.js';
import reportRoutes from './routes/reports.js';
import serverReportRoutes from './routes/serverReports.js';
import klipyRoutes from './routes/klipy.js';
import pushRoutes from './routes/push.js';
import activityRoutes from './routes/activity.js';
import instanceAdminRoutes from './routes/instanceAdmin.js';
import connectedAppsRoutes from './routes/connectedApps.js';
import eventRoutes from './routes/events.js';
import dmKeysRoutes from './routes/dmKeys.js';
import dmHistoryArchiveRoutes from './routes/dmHistoryArchive.js';
import mlsRoutes from './routes/mls.js';
import pollRoutes from './routes/polls.js';
import dmPollRoutes from './routes/dmPolls.js';
import threadRoutes from './routes/threads.js';
import stageRoutes from './routes/stages.js';
import channelPermissionRoutes from './routes/channelPermissions.js';
import channelAgeGateRoutes from './routes/channelAgeGate.js';
import forumRoutes from './routes/forum.js';
import forumTagRoutes from './routes/forumTags.js';
import notificationRoutes from './routes/notifications.js';
import gameAccountRoutes from './routes/gameAccounts.js';
import showcaseRoutes from './routes/showcase.js';
import linkPreviewRoutes from './routes/linkPreview.js';
import serverFolderRoutes from './routes/serverFolders.js';
import securityEventsRoutes from './routes/securityEvents.js';
import { serverVanityRouter, vanityCheckRouter } from './routes/serverVanity.js';
import discoverRoutes from './routes/discover.js';
import publicConfigRoutes from './routes/publicConfig.js';
import publicDiscoverRoutes from './routes/publicDiscover.js';
import publicServerRoutes from './routes/publicServer.js';
import seoRoutes from './routes/seo.js';
import bootstrapRoutes from './routes/bootstrap.js';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS, logRateLimitStoreChoice, isLoadTestBypass } from './rateLimitStore.js';
import { JWT_SECRET } from './middleware/auth.js';
import { getClientIp } from './utils/clientIp.js';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { createAdapter } from '@socket.io/redis-adapter';
import { scheduleRecurringCleanup, scheduleSteamActivityPolling, scheduleSpotifyActivityPolling, scheduleEventReminderPolling, scheduleThreadArchivePolling, scheduleShowcaseRefreshPolling, scheduleTwitchActivityPolling, scheduleYouTubeActivityPolling, scheduleAnalyticsJobs, scheduleServerStatsJobs, scheduleDiscoveryEligibilityJobs } from './queues/producers.js';
import { queuesEnabled } from './queues/connection.js';
import { startAllWorkers } from './queues/workers/index.js';
import { setNotificationIO } from './queues/workers/notification.worker.js';
import { setEventReminderIO } from './queues/workers/eventReminder.worker.js';
import { setThreadArchiveIO } from './queues/workers/threadArchive.worker.js';
import { setImportIO } from './queues/workers/import.worker.js';
import { setCalendarIO } from './queues/workers/calendar.worker.js';
import { setCleanupIO } from './queues/workers/cleanup.worker.js';
import { cloudflareGuard } from './middleware/cloudflareGuard.js';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { allQueues } from './queues/index.js';
import {
  pub as redisPub, sub as redisSub, redisEnabled,
  isUserConnected as redisIsUserConnected,
} from './redis.js';
import { registerSocketHandlers } from './socketHandlers/index.js';
import { broadcastPresenceChange, isUserConnectedSync } from './socketHandlers/infrastructure.js';
import { requireOnboarding } from './middleware/requireOnboarding.js';
import { requireVerifiedEmail } from './middleware/requireVerifiedEmail.js';
import { attachProtocolContextHttp, enforceVersionGateHttp } from './middleware/versionGate.js';
import { CDN_BASE_URL, CDN_SIGNING_SECRET } from './services/s3.js';
import { isValidHexKey32 } from './services/keyValidation.js';

const app = express();
const httpServer = http.createServer(app);
export { app, httpServer };

// Use PORT from environment (most PaaS hosts inject it); default 5000 for local dev / proxy
const rawPort = Number(process.env.PORT) || 5000;
const PORT = Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 5000;

if (!process.env.NODE_ENV) {
  logger.fatal('NODE_ENV is not set. Set NODE_ENV to "development", "test", or "production". Refusing to start with undefined NODE_ENV.');
  process.exit(1);
}
if (process.env.NODE_ENV === 'production') {
  if (!process.env.JWT_SECRET) {
    logger.fatal('JWT_SECRET must be set in production. Set it in backend/.env or environment.');
    process.exit(1);
  }
  const WEAK_JWT_DEFAULTS = new Set(['dev-secret-change-in-production', 'your-super-secret-jwt-key-change-this']);
  if (WEAK_JWT_DEFAULTS.has(process.env.JWT_SECRET)) {
    logger.fatal('JWT_SECRET is still a placeholder/default value. Change it for production.');
    process.exit(1);
  }
  if (process.env.JWT_SECRET.length < 32) {
    logger.fatal('JWT_SECRET must be at least 32 characters for adequate entropy.');
    process.exit(1);
  }
  if (!process.env.FRONTEND_ORIGIN) {
    logger.fatal('FRONTEND_ORIGIN must be set in production (e.g., https://app.howlpro.com). CORS will reject all requests without it.');
    process.exit(1);
  }
  if (!process.env.ADMIN_JWT_SECRET) {
    logger.fatal('ADMIN_JWT_SECRET must be set in production. Without it, admin tokens fall back to an insecure default.');
    process.exit(1);
  }
  if (process.env.ADMIN_JWT_SECRET.length < 32) {
    logger.fatal('ADMIN_JWT_SECRET must be at least 32 characters for adequate entropy.');
    process.exit(1);
  }
  if (process.env.ADMIN_JWT_SECRET === process.env.JWT_SECRET) {
    logger.fatal('ADMIN_JWT_SECRET must differ from JWT_SECRET. Identical secrets allow user tokens to be used as admin tokens.');
    process.exit(1);
  }
  if (process.env.BACKUP_SERVER_SECRET && process.env.BACKUP_SERVER_SECRET.length < 32) {
    logger.fatal('BACKUP_SERVER_SECRET must be at least 32 characters for adequate entropy. Either set a strong secret or remove it to disable key backup.');
    process.exit(1);
  }
  if (process.env.SELF_HOST !== 'true') {
    if (!process.env.LIVEKIT_API_SECRET || process.env.LIVEKIT_API_SECRET === 'secret') {
      logger.fatal('LIVEKIT_API_SECRET must be set to a strong random value in production. The default "secret" allows anyone to forge voice tokens.');
      process.exit(1);
    }
    if (!process.env.LIVEKIT_API_KEY || process.env.LIVEKIT_API_KEY === 'devkey') {
      logger.fatal('LIVEKIT_API_KEY must be set in production. The default "devkey" is insecure.');
      process.exit(1);
    }
  }
  if (!process.env.WEBAUTHN_RP_ID || !process.env.WEBAUTHN_ORIGIN) {
    logger.warn('WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN should be set in production for passkey authentication. Defaulting to localhost values.');
  }
  // Cloudflare Access — required once CF_ACCESS_ENFORCE=true. While unenforced
  // these can be unset (middleware runs in permissive mode).
  // Once enforced, admin routes reject all requests without a valid JWT.
  if (process.env.CF_ACCESS_ENFORCE === 'true') {
    if (!process.env.CF_ACCESS_TEAM_DOMAIN) {
      logger.fatal('CF_ACCESS_TEAM_DOMAIN must be set when CF_ACCESS_ENFORCE=true. Without it, the JWT issuer cannot be validated.');
      process.exit(1);
    }
    if (!process.env.CF_ACCESS_AUD) {
      logger.fatal('CF_ACCESS_AUD must be set when CF_ACCESS_ENFORCE=true. Without it, JWTs from any CF Access tenant would be accepted.');
      process.exit(1);
    }
  } else {
    logger.warn('CF_ACCESS_ENFORCE is not "true" — admin routes run in permissive mode. Flip to true once your admins have enrolled.');
  }
  if (!process.env.TURNSTILE_SECRET_KEY) {
    logger.warn('TURNSTILE_SECRET_KEY not set in production — CAPTCHA verification will reject all requests, blocking registration and login.');
  }
  if (CDN_BASE_URL && !CDN_SIGNING_SECRET) {
    logger.fatal('CDN_SIGNING_SECRET must be set when CDN_BASE_URL is set in production. Unsigned CDN URLs are a security risk.');
    process.exit(1);
  }
  if (CDN_SIGNING_SECRET && CDN_SIGNING_SECRET.length < 32) {
    logger.fatal('CDN_SIGNING_SECRET must be at least 32 characters.');
    process.exit(1);
  }
}
// Warn about missing optional service keys (don't crash — some may be intentionally skipped in dev/test)
if (!process.env.STRIPE_SECRET_KEY) logger.warn('STRIPE_SECRET_KEY is not set — billing and subscription features will be unavailable.');
if (!process.env.RESEND_API_KEY) logger.warn('RESEND_API_KEY is not set — transactional emails will not be sent.');
if (!process.env.S3_BUCKET) logger.warn('S3_BUCKET is not set — file uploads will use local disk storage only.');
if (!process.env.LIVEKIT_API_KEY && process.env.NODE_ENV !== 'production') logger.warn('LIVEKIT_API_KEY is not set — voice/video features will be unavailable.');

// Validate MFA_ENCRYPTION_KEY in all environments — email encryption fails without it
if (!isValidHexKey32(process.env.MFA_ENCRYPTION_KEY)) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('MFA_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). Email encryption will fail without it.');
    process.exit(1);
  } else {
    logger.warn('MFA_ENCRYPTION_KEY is missing or too short (need 64 hex chars). Registration and login will fail.');
  }
}

// Validate EMAIL_HMAC_KEY — required for every email lookup (login, register, password reset, SSO link, email change).
// Without this, `hashEmail()` throws on first invocation and every auth request 500s while /health stays green.
// Length floor matches services/mfaCrypto.ts:getEmailHmacKey() (≥32 chars).
if (!process.env.EMAIL_HMAC_KEY || process.env.EMAIL_HMAC_KEY.length < 32) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('EMAIL_HMAC_KEY must be set (min 32 chars). Email lookup (login, register, password reset) will fail without it.');
    process.exit(1);
  } else {
    logger.warn('EMAIL_HMAC_KEY is missing or too short (need ≥32 chars). Email lookup will fail.');
  }
}

// REDIS_URL is required in production. Single-use token / challenge
// stores (MFA `usedChallenges`, device-verify, admin MFA, admin passkey) and
// rate limiters all degrade to per-replica enforcement when Redis is missing,
// which means a leaked MFA token can be replayed against a different replica.
// Mirror the createRateLimitStore guard (rateLimitStore.ts:39-43): hard-fail
// at boot in prod so the platform restarts the replica, leaving the in-memory
// fallbacks active only in dev/test.
if (!redisEnabled && process.env.NODE_ENV === 'production') {
  logger.fatal({ event: 'startup_redis_required' }, 'REDIS_URL must be set in production. Single-use token enforcement and rate limiters degrade to per-replica state without Redis.');
  process.exit(1);
}

// Validate DM_ENCRYPTION_KEY — DM messages are encrypted at rest with this key.
// Strict 32-byte hex check, matching MFA/escrow keys above
// (the old length-only check accepted a 64-char non-hex value as a weak key).
if (!isValidHexKey32(process.env.DM_ENCRYPTION_KEY)) {
  if (process.env.NODE_ENV === 'production') {
    logger.fatal('DM_ENCRYPTION_KEY must be a 32-byte hex string (64 hex chars). DM message encryption will fail without it.');
    process.exit(1);
  } else {
    logger.warn('DM_ENCRYPTION_KEY is missing or not 64 hex chars. Using test fallback key for DM encryption.');
  }
}

// Validate SERVER_E2E_MASTER_KEY — used for password-derived E2E escrow.
// A present-but-malformed key is fatal in production (silent degradation to a
// weak AES key); an absent key only disables password-derived mode (opt-in).
if (process.env.SERVER_E2E_MASTER_KEY) {
  if (!isValidHexKey32(process.env.SERVER_E2E_MASTER_KEY)) {
    if (process.env.NODE_ENV === 'production') {
      logger.fatal('SERVER_E2E_MASTER_KEY is present but malformed — must be a 32-byte hex string (64 hex chars).');
      process.exit(1);
    } else {
      logger.warn('SERVER_E2E_MASTER_KEY is present but malformed (need 64 hex chars).');
    }
  }
} else if (process.env.NODE_ENV === 'production') {
  logger.warn('SERVER_E2E_MASTER_KEY is not set — password-derived E2E mode will be unavailable.');
}
const isDev = process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test';

// Production: restrict CORS to frontend origin(s). Dev: allow all.
// Electron desktop sends requests with null origin (file:// protocol), so we use
// a callback to allow listed origins + null for Electron.
const isProd = process.env.NODE_ENV === 'production';
const allowedOrigins =
  isProd && process.env.FRONTEND_ORIGIN
    ? [
        ...process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim()),
        ...(process.env.ADMIN_ORIGIN
          ? process.env.ADMIN_ORIGIN.split(',').map((o) => o.trim())
          : (logger.warn('ADMIN_ORIGIN not set in production — admin panel CORS will be rejected'), [])),
      ]
    : [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:5173',
        ...(process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim()) : []),
      ];

const corsOrigin = (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
  if (!origin) {
    // Legacy Electron (file:// protocol) sends null origin
    // TODO: Remove ALLOW_NULL_ORIGIN after all Electron clients update to howl-app:// protocol
    const allowNull = isDev || process.env.ALLOW_NULL_ORIGIN === 'true';
    return callback(null, allowNull);
  }
  // Electron custom protocol origin (hardcoded — part of app architecture, not deployment config)
  if (origin === 'howl-app://app') {
    return callback(null, true);
  }
  if (allowedOrigins.includes(origin)) {
    callback(null, true);
  } else if (!isProd && origin.endsWith('.trycloudflare.com')) {
    callback(null, true);
  } else {
    callback(new Error(`CORS: origin ${origin} not allowed`));
  }
};

if (process.env.NODE_ENV === 'production' && process.env.ALLOW_NULL_ORIGIN === 'true') {
  logger.warn('ALLOW_NULL_ORIGIN is enabled in production — only use this for Electron desktop clients, not web-only deployments.');
}
const io = new SocketServer(httpServer, {
  cors: { origin: corsOrigin as any, methods: ['GET', 'POST'], credentials: true },
  transports: ['websocket'],
  // Faster heartbeat cadence — 10s ping / 20s pong timeout. Dead connections
  // (laptop sleep, network tunnel change, phone losing cell) are detected
  // within ~20s instead of ~85s previously. Pairs with the in-call auto-
  // rejoin in useCallSession so transient drops recover transparently.
  pingTimeout: 20000,
  pingInterval: 10000,
  // Inbound accept-size guard: Socket.IO maxHttpBufferSize caps the size of
  // packets the server RECEIVES, not what it emits. No inbound event payload
  // exceeds this. MLS commits/GroupInfo/Welcomes are submitted over REST
  // (POST /mls/groups/...), never the socket, and the outbound mls-commit relay
  // (routes/mls.ts) is bounded by the client receive buffer, not this cap, so the
  // X-Wing PQC size growth does not affect this value. The OTR ephemeral send
  // (otr-message, socketHandlers/otr.ts) is the one inbound application-message
  // send path on the socket: opaque MLS application ciphertext only, bounded to
  // ≤32KB by otrMessagePayload, so 50KB remains adequate.
  maxHttpBufferSize: 50_000,
});
setIO(io);

// Wire Redis adapter for multi-instance Socket.IO when Redis is available
if (redisEnabled && redisPub && redisSub) {
  io.adapter(createAdapter(redisPub, redisSub));
  logger.info({ module: 'socket.io' }, 'Redis adapter attached — multi-instance mode');
} else {
  logger.info({ module: 'socket.io' }, 'Using default in-memory adapter (single-instance)');
}

// So routes can broadcast and check presence
app.set('io', io);
app.set('isUserConnected', isUserConnectedSync);
app.set('isUserConnectedAsync', redisIsUserConnected);
app.set('broadcastPresenceChange', broadcastPresenceChange);

// Behind a reverse proxy (Cloudflare, a PaaS load balancer, etc.) X-Forwarded-For is set; express-rate-limit needs this.
// NOTE: a typical deployment has multiple proxy hops (a CDN in front of one or more internal proxies),
// so `req.ip` is NOT the real client. Rate limiters use `getClientIp(req)` from
// utils/clientIp.ts instead, which reads CF-Connecting-IP first.
app.set('trust proxy', 1);

// Reject direct-to-origin connections that bypass Cloudflare (controlled by env REQUIRE_CLOUDFLARE).
// When enabled this prevents an attacker from spoofing CF-Connecting-IP by hitting the origin
// host directly. Off by default so dev/test still work.
app.use(cloudflareGuard);

app.disable('x-powered-by');

// HTTPS redirect in production
// Behind a load-balancer the original protocol arrives via X-Forwarded-Proto.
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http') {
      return res.redirect(301, `https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

app.use(compression({ threshold: 1024 /* bytes — skip compression for tiny responses */, level: 1 /* zlib level 1-9; 1 = fastest for high-throughput servers */ }));
app.use(cookieParser());
app.use(cors({ origin: corsOrigin, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], credentials: true }));

const frontendOrigins = process.env.FRONTEND_ORIGIN ? process.env.FRONTEND_ORIGIN.split(',').map((o) => o.trim()) : ["'self'"];
const livekitWs = process.env.LIVEKIT_URL?.replace(/^http/, 'ws') || '';

app.use(helmet({
  hsts: isProd ? { maxAge: 63072000 /* 2 years in seconds */, includeSubDomains: true, preload: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  crossOriginOpenerPolicy: isProd ? { policy: 'same-origin' } : false,
  contentSecurityPolicy: isProd ? {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "https://challenges.cloudflare.com", "https://static.cloudflareinsights.com"],
      // TODO: remove 'unsafe-inline' once a CSP nonce strategy is implemented for inline styles (Tailwind/React inject them)
      styleSrc: ["'self'", "'unsafe-inline'"],
      fontSrc: ["'self'", "data:"],
      imgSrc: [
        "'self'", "data:", "blob:", "https:",
        "https://cdn.jsdelivr.net", "https://api.dicebear.com", "https://api.klipy.com", "https://static.klipy.com",
        process.env.S3_CSP_DOMAIN || undefined,
        process.env.CF_CSP_DOMAIN || undefined,
        "https://i.imgur.com", "https://media.tenor.com", "https://c.tenor.com",
        "https://media.giphy.com", "https://media0.giphy.com", "https://i.giphy.com", "https://media1.giphy.com", "https://media2.giphy.com", "https://media3.giphy.com", "https://media4.giphy.com",
        "https://pbs.twimg.com", "https://cdn.discordapp.com", "https://media.discordapp.net", "https://img.youtube.com",
        "https://*.google.com", "https://cdn.cloudflare.steamstatic.com", "https://i.scdn.co",
      ].filter(Boolean) as string[],
      connectSrc: ["'self'", ...frontendOrigins, livekitWs, "https://api.klipy.com", "https://challenges.cloudflare.com", "https://*.ingest.sentry.io", "https://*.ingest.us.sentry.io", "https://*.google.com"].filter(Boolean),
      frameSrc: ["'self'", "https://www.youtube-nocookie.com", "https://challenges.cloudflare.com", "https://open.spotify.com", "https://store.steampowered.com", "https://player.twitch.tv", "https://clips.twitch.tv", "https://www.tiktok.com", "https://platform.twitter.com", "https://embed.reddit.com", "https://player.kick.com"],
      mediaSrc: ["'self'", "blob:", "https://api.klipy.com", "https://static.klipy.com", "https://*.r2.cloudflarestorage.com", "https://*.howlpro.com"],
      workerSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: [],
    },
  } : false,
}));
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=(), usb=()');
  next();
});
// Stripe webhook needs the raw body for signature verification — mount before JSON parser
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use('/api/v1/billing/webhook', express.raw({ type: 'application/json' }));
// LiveKit webhook signs the body with a JWT in the Authorization header —
// WebhookReceiver needs the unparsed string. LiveKit sends Content-Type
// `application/webhook+json`; use `*/*` to be tolerant of variants.
app.use('/api/livekit/webhook', express.raw({ type: '*/*', limit: '64kb' }));
app.use('/api/v1/livekit/webhook', express.raw({ type: '*/*', limit: '64kb' }));

// The history-archive batch POST can carry up to 50 sealed rows
// (~1.6 MB); give it a larger JSON limit than the global 256kb. Mounted BEFORE
// the global parser so the global one sees req._body already set and skips.
app.use('/api/v1/dms/history-archive', express.json({ limit: '2mb' }));
app.use('/api/dms/history-archive', express.json({ limit: '2mb' }));

// The MLS batched submit-commit (POST /mls/groups/:groupId/commits) carries a
// commit + GroupInfo + up to 14 per-recipient X-Wing Welcome copies; the worst
// case at the 15-member ceiling is ~840KB. Scope a 2mb parser to the MLS group
// routes (mirroring the history-archive pattern above) rather than widening the
// global JSON cap.
app.use('/api/v1/mls/groups', express.json({ limit: '2mb' }));
app.use('/api/mls/groups', express.json({ limit: '2mb' }));

const JSON_LIMIT = '256kb';
app.use(express.json({ limit: JSON_LIMIT }));
app.use(attachProtocolContextHttp);

// Structured HTTP request logging (pino-http)
app.use(pinoHttp({
  logger,
  genReqId: () => generateRequestId(),
  autoLogging: {
    ignore: (req) => {
      const url = req.url ?? '';
      return url === '/health' || url === '/api/health';
    },
  },
  customSuccessMessage: (req, res) => `${req.method} ${sanitizeLogString(req.url ?? '')} ${res.statusCode}`,
  customErrorMessage: (req, _res, err) => `${req.method} ${sanitizeLogString(req.url ?? '')} failed: ${sanitizeLogString(err.message)}`,
  serializers: {
    req: (req) => ({
      method: req.method,
      // Scrub OAuth `code`/`state`/etc. from structured `url` field,
      // not just the human success/error message.
      url: sanitizeLogString(req.url ?? ''),
      remoteAddress: req.remoteAddress,
    }),
    res: (res) => ({
      statusCode: res.statusCode,
    }),
  },
}));

// Health check (no DB)
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const healthWithDb: express.RequestHandler = async (_req, res) => {
  const pdq = getPdqInitState();
  try {
    await prisma.$queryRaw`SELECT 1`;
    // pdq=failed means CSAM upload-blocking is offline. Surface it on the
    // shared health endpoint so monitoring can alert without us inventing
    // a separate /pdq probe. We still return 200 because non-image uploads
    // and reads are unaffected — but the `pdq` field flips to 'failed'.
    res.json({ status: 'ok', pdq, timestamp: new Date().toISOString() });
  } catch (err) {
    logger.error({ err }, 'Health check DB error');
    res.status(503).json({ status: 'degraded', pdq });
  }
};
app.get('/api/v1/health', healthWithDb);
app.get('/api/health', healthWithDb);
// Per-(userId || IP) keying so a shared NAT (campus / corporate / CGNAT) doesn't
// starve every Howl user behind a single IP bucket on launch day. The JWT verify
// here is intentionally cheap (HS256 sig check, no DB / Redis touch); the result
// is cached on req for downstream `authenticateToken` to avoid a second decode.
function globalLimiterKey(req: express.Request): string {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    try {
      const decoded = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as { userId?: string; purpose?: string };
      // MFA-purpose tokens are not session tokens — fall through to IP keying.
      if (decoded.userId && !decoded.purpose) {
        (req as any)._jwtPayload = decoded;
        return 'u:' + decoded.userId;
      }
    } catch {
      // Malformed / expired — fall through to IP keying.
    }
  }
  return getClientIp(req) ?? 'anonymous';
}

const globalLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:global:'),
  windowMs: 60 * 1000, // 1-minute sliding window
  // Authenticated users get a higher cap (1000/min) than anonymous IPs (600/min)
  // so a shared NAT with many logged-in clients doesn't share a 600-budget.
  max: (req) => (req as any)._jwtPayload ? 1000 : 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
  keyGenerator: globalLimiterKey,
  skip: (req) => req.method === 'OPTIONS' || req.path === '/v1/health' || req.path === '/health'
    || req.path === '/billing/webhook' || req.path === '/v1/billing/webhook'
    || req.path === '/livekit/webhook' || req.path === '/v1/livekit/webhook'
    || isLoadTestBypass(req),
});
app.use('/api', globalLimiter);

// Safe cache defaults for all API responses — prevents sensitive data caching by browsers/CDNs/proxies
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.setHeader('Pragma', 'no-cache');
  next();
});

// LiveKit webhook — mounted directly on app so it bypasses the v1 onboarding
// gate and version gate. Body has been pre-parsed as Buffer above (line ~376).
// Auth is the LiveKit-signed JWT in the Authorization header, verified inside
// the route handler.
app.use('/api/v1/livekit/webhook', livekitWebhookRoutes);
app.use('/api/livekit/webhook', livekitWebhookRoutes);

// API v1 routes
const v1 = express.Router();

// Block unonboarded / DOB-less users from non-auth endpoints (C1 + M1).
// The E2E encryption-choice modal is part of the mandatory setup flow that runs
// right after onboarding/password-setup, so /dms/keys/bundle + /dms/keys/setup
// must be callable during that window too — otherwise the user hits
// "Please complete account setup before using Howl" from inside the setup flow.
// `/public/` covers the anonymous discovery surface — the routes
// below the prefix authenticate themselves where needed; the onboarding +
// email-verify gates would falsely 403 anonymous traffic without a carve-out.
const onboardingExemptPrefixes = ['/auth/', '/billing/webhook', '/health', '/public/'];
const onboardingExemptPaths = new Set(['/dms/keys/bundle', '/dms/keys/setup']);
v1.use((req, res, next) => {
  if (onboardingExemptPrefixes.some(p => req.path.startsWith(p))) return next();
  if (onboardingExemptPaths.has(req.path)) return next();
  requireOnboarding(req as any, res, next);
});

// Block unverified-email users from non-auth endpoints — same carve-out as above
// so the encryption-choice modal can complete before the email-verify gate.
v1.use((req, res, next) => {
  if (onboardingExemptPrefixes.some(p => req.path.startsWith(p))) return next();
  if (onboardingExemptPaths.has(req.path)) return next();
  requireVerifiedEmail(req as any, res, next);
});

v1.use('/', uploadRoutes);
v1.use('/auth', authRoutes);
v1.use('/auth', profileRoutes);
v1.use('/bootstrap', bootstrapRoutes);
v1.use('/messages', messageRoutes);
v1.use('/servers', serverRoutes);
v1.use('/servers/:serverId', serverSettingsRoutes);
v1.use('/servers/:serverId/community', serverCommunityRoutes);
v1.use('/servers/:serverId/verification', serverVerificationRoutes);
v1.use('/servers/:serverId/welcome', serverWelcomeRoutes);
v1.use('/servers/:serverId/applications', serverApplicationRoutes);
v1.use('/servers/:serverId/role-pickers', rolePickersRoutes);
v1.use('/servers/:serverId/insights', serverInsightsRoutes);
v1.use('/invites', inviteRoutes);
// Gate just the LiveKit token endpoint in the first rollout. This is the
// mid-call endpoint per spec. Socket.IO auth is the primary gate; REST
// gating on /livekit/token is a belt-and-suspenders check. Widen later
// only if enforcement proves reliable. /dms/keys is intentionally NOT
// gated — that prefix includes account-setup and recovery routes that
// an old-build user must still be able to use.
v1.use('/dms/keys', dmKeysRoutes);
v1.use('/dms/history-archive', dmHistoryArchiveRoutes);
v1.use('/mls', mlsRoutes);
v1.use('/dms', dmRoutes);
// Content-prefs router mounted BEFORE userRoutes so /me/preferences wins.
v1.use('/users', userPreferenceRoutes);
v1.use('/users', userRoutes);
v1.use('/friends', friendRoutes);
v1.use('/billing', billingRoutes);
v1.use('/sessions', sessionRoutes);
v1.use('/family', familyRoutes);
v1.use('/auth/sso', ssoRoutes);
v1.use('/auth/mfa', mfaRoutes);
// Admin routes: Cloudflare Access JWT is the sole network-layer gate.
// Identity + password + TOTP + passkey is enforced by the admin auth chain.
v1.use('/admin/auth', cfAccessAuth, adminAuthRoutes);
v1.use('/admin/auth', cfAccessAuth, adminPasskeyRoutes);
v1.use('/admin/accounts', cfAccessAuth, adminAuthMiddleware, enforcePasswordChange, requireSuperAdmin, adminAccountRoutes);
// Admin server T&S router — mounted BEFORE the /admin catch-all so its
// literal-path GETs (e.g. `/discovery-queue`) win over admin.ts's
// `/servers/:serverId` wildcard. With the previous order, a request to
// `/admin/servers/discovery-queue` got matched by `/servers/:serverId`
// with `serverId='discovery-queue'`, which validateUuidParam rejected
// and returned 400 "Invalid serverId format" — never reaching the real
// queue handler. Routes that legitimately need /servers/:serverId in
// admin.ts (settings/bans/audit-log/automod-rules) keep working: when
// adminServerRoutes has no match (no GET /:serverId there), Express
// falls through to /admin and matches there. The full admin chain
// (cfAccessAuth + admin JWT + force-password-change) runs once on each
// branch — there's a small middleware-replay cost on the fall-through
// path, but every middleware is idempotent so it's harmless.
v1.use('/admin/servers', cfAccessAuth, adminAuthMiddleware, enforcePasswordChange, adminServerRoutes);
v1.use('/admin', cfAccessAuth, adminRoutes);
v1.use('/admin/verification-requests', cfAccessAuth, adminAuthMiddleware, enforcePasswordChange, adminVerificationRequestRoutes);
v1.use('/power-ups', powerUpRoutes);
v1.use('/servers', discordImportRoutes);
v1.use('/livekit', enforceVersionGateHttp);
v1.use('/livekit', livekitRoutes);
v1.use('/search', searchRoutes);
v1.use('/gdpr', gdprRoutes);
v1.use('/push', pushRoutes);
v1.use('/klipy', klipyRoutes);
v1.use('/settings', settingsRoutes);
v1.use('/', linkPreviewRoutes);
v1.use('/reports', reportRoutes);
v1.use('/servers', serverReportRoutes);
v1.use('/activity', activityRoutes);
v1.use('/instance', instanceAdminRoutes);
v1.use('/connected-apps', connectedAppsRoutes);
v1.use('/servers', eventRoutes);
v1.use('/servers', pollRoutes);
v1.use('/dms', dmPollRoutes);
v1.use('/servers', threadRoutes);
v1.use('/servers', stageRoutes);
v1.use('/servers', channelPermissionRoutes);
v1.use('/servers', forumRoutes);
v1.use('/servers', forumTagRoutes);
v1.use('/channels', channelAgeGateRoutes);
v1.use('/notifications', notificationRoutes);
v1.use('/game-accounts', gameAccountRoutes);
v1.use('/showcase', showcaseRoutes);
v1.use('/server-folders', serverFolderRoutes);
v1.use('/me/security-events', securityEventsRoutes);
// Vanity URL: owner mutations under /servers/:serverId/vanity (manageServer perm),
// public availability check under /vanity/check (anonymous, IP-rate-limited).
v1.use('/servers/:serverId/vanity', serverVanityRouter);
v1.use('/vanity', vanityCheckRouter);
// Public, unauthenticated server profile JSON. Mounted on the v1 router so
// `/api/v1/public/server/:vanityOrId` and `/api/public/server/:vanityOrId`
// (legacy alias) both work. The `/public/` prefix is in `onboardingExemptPrefixes`
// above so anonymous + non-onboarded users can still hit it.
// Instance-capabilities config — mounted before the broader `/public` router so
// `/public/config` resolves to its own handler rather than depending on
// fall-through past the publicServer sub-router. Same `/public/` gate carve-out.
v1.use('/public/config', publicConfigRoutes);
v1.use('/public', publicServerRoutes);
// Discovery directory (part of the Community Servers feature). The
// authenticated route lives under /api/v1/discover; the anonymous mirror
// under /api/v1/public/discover with stricter NSFW filtering, no member
// list exposure, and CDN cache headers. Both share the underlying query in
// services/discoveryQuery.ts so they cannot drift apart. The `/public/`
// prefix is exempt from the onboarding/email-verify gates below.
v1.use('/discover', discoverRoutes);
v1.use('/public/discover', publicDiscoverRoutes);

app.use('/api/v1', v1);
app.use('/api', v1); // backward-compat alias — old clients without /v1 still work

// Public SEO + unauth preview HTML (mounted at root)
// `/robots.txt`, `/sitemap.xml`, `/s/:vanity` ship from the backend even on
// CDN deployments where the SPA is served by Cloudflare Pages — the CDN
// origin-routes those three paths to this backend. Must be registered AFTER
// the `/api/*` mounts so the `/api/...` JSON-404 boundary above doesn't
// intercept them, and BEFORE the SPA `app.get('*', …)` fallback so the
// fallback doesn't shadow them.
app.use('/', seoRoutes);

// Bull Board admin dashboard
if (allQueues.length > 0) {
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath('/admin/queues');
  createBullBoard({
    queues: allQueues.map((q) => new BullMQAdapter(q)),
    serverAdapter,
  });
  app.use('/admin/queues', cfAccessAuth, async (req, res, next) => {
    const adminKey = process.env.ADMIN_DASHBOARD_KEY;
    if (!adminKey) return res.status(404).send('Not found');
    // Require static key AND a valid admin JWT so a leaked static key alone is not sufficient.
    const provided = typeof req.headers['x-admin-key'] === 'string' ? req.headers['x-admin-key'] : '';
    const keyHash = crypto.createHash('sha256').update(adminKey).digest();
    const providedHash = crypto.createHash('sha256').update(provided).digest();
    if (!crypto.timingSafeEqual(keyHash, providedHash)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    const authHeader = req.headers['authorization'];
    const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) return res.status(403).json({ error: 'Admin token required' });
    try {
      const decoded = jwt.verify(token, ADMIN_JWT_SECRET, { algorithms: ['HS256'] }) as { adminId: string; scope?: string };
      if (decoded.scope !== 'admin') {
        return res.status(403).json({ error: 'Invalid token scope' });
      }
      // Verify session still exists (not revoked)
      const tHash = hashToken(token);
      const session = await prisma.adminSession.findUnique({ where: { tokenHash: tHash }, select: { id: true } });
      if (!session) {
        return res.status(403).json({ error: 'Session revoked' });
      }
    } catch (e: any) {
      if (e.message === 'Session revoked' || e.message === 'Invalid token scope') {
        return res.status(403).json({ error: e.message });
      }
      return res.status(403).json({ error: 'Invalid admin token' });
    }
    next();
  }, serverAdapter.getRouter());
  logger.info('Bull Board mounted at /admin/queues');
}

// Sentry error handler — must be before the custom error handler
if (sentryEnabled) {
  Sentry.setupExpressErrorHandler(app);
}

// API error handler (for errors passed to next() or thrown in async routes if using a wrapper)
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const payloadTooLarge =
    err && typeof err === 'object' &&
    ((err as { type?: string }).type === 'entity.too.large' || (err as { status?: number }).status === 413);
  let message: string;
  let status: number;
  if (payloadTooLarge) {
    message = 'Request body too large';
    status = 413;
  } else if (isProd) {
    message = 'Internal server error';
    status = 500;
  } else {
    message = err instanceof Error ? err.message : 'Internal server error';
    status = 500;
  }
  logger.error({ err: err instanceof Error ? err : undefined, detail: err instanceof Error ? undefined : err }, 'API error');
  res.status(status).json({ error: message });
});

// JSON 404 for API/socket/admin surfaces so Express's default HTML 404 (which
// discloses the stack) never ships in production or any deployment where the
// backend isn't also serving the SPA.
app.use(['/api', '/socket.io', '/admin/queues'], (_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// SPA fallback — serve index.html for non-API routes (production)
// Enables direct URL access (e.g., /channels/abc/def) when the backend serves
// the frontend. CDN deployments (Cloudflare Pages, Vercel) handle SPA routing natively.
const __server_dirname = path.dirname(fileURLToPath(import.meta.url));
const spaIndexPath = path.resolve(__server_dirname, '..', '..', 'dist', 'index.html');
if (process.env.NODE_ENV === 'production' && fs.existsSync(spaIndexPath)) {
  app.get('*', (_req: express.Request, res: express.Response) => {
    res.sendFile(spaIndexPath);
  });
}

// Socket.IO handlers
registerSocketHandlers(io);

// Batch status reset to avoid locking the entire User table on restart
async function batchResetUserStatuses() {
  let updatedTotal = 0;
  while (true) {
    const batch = await prisma.user.findMany({
      where: { status: { notIn: ['offline', 'invisible'] } },
      select: { id: true },
      take: 1000,
    });
    if (batch.length === 0) break;
    await prisma.user.updateMany({
      where: { id: { in: batch.map(u => u.id) } },
      data: { status: 'offline' },
    });
    updatedTotal += batch.length;
  }
  return updatedTotal;
}

// On startup, reset all non-invisible users to 'offline' (no sockets are connected yet)
batchResetUserStatuses().then((count) => {
  if (count > 0) logger.info({ count }, 'Reset stale online statuses to offline');
}).catch(() => {});

// Start BullMQ workers and scheduled jobs
setNotificationIO(io);
setEventReminderIO(io);
setThreadArchiveIO(io);
setImportIO(io);
setCalendarIO(io);
setCleanupIO(io);

// Only start workers if not running as a separate worker service
let workers: import('bullmq').Worker[] = [];
if (process.env.DISABLE_WORKERS !== 'true') {
  workers = startAllWorkers();
  scheduleRecurringCleanup().catch(() => {});
  scheduleSteamActivityPolling().catch(() => {});
  scheduleSpotifyActivityPolling().catch(() => {});
  scheduleEventReminderPolling().catch(() => {});
  scheduleThreadArchivePolling().catch(() => {});
  scheduleShowcaseRefreshPolling().catch(() => {});
  scheduleTwitchActivityPolling().catch(() => {});
  scheduleYouTubeActivityPolling().catch(() => {});
  scheduleAnalyticsJobs().catch(() => {});
  scheduleServerStatsJobs().catch(() => {});
  scheduleDiscoveryEligibilityJobs().catch(() => {});
} else {
  logger.info('Workers disabled — running as web-only service');
}

// Register graceful shutdown dependencies
registerShutdownDeps({
  httpServer,
  io,
  workers,
  queues: process.env.DISABLE_WORKERS !== 'true' ? allQueues : [],
  redisClients: [redisPub, redisSub],
});

const HOST = process.env.HOST || '0.0.0.0';
if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(Number(PORT), HOST, () => {
    logRateLimitStoreChoice();
    logger.info({
      host: HOST === '0.0.0.0' ? 'localhost' : HOST,
      port: PORT,
      health: `/health`,
      ws: 'Socket.io attached',
      lan: HOST === '0.0.0.0',
      queues: queuesEnabled ? `${workers.length} workers` : 'disabled (inline)',
      sentry: sentryEnabled ? 'enabled' : 'disabled',
    }, `Howl backend running on port ${PORT}`);
  });
}
