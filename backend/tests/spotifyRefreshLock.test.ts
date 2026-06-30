// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for the Redis-backed Spotify refresh mutex.
 *
 * Pre-fix, the per-process `refreshLocks` Map only deduplicated concurrent
 * `refreshSpotifyToken` calls within a SINGLE replica. Across multiple
 * replicas two concurrent refreshes can both POST `grant_type=refresh_token`
 * to Spotify; Spotify rotates the refresh_token on each call, so the loser
 * receives `invalid_grant` and `doRefresh` deletes the ConnectedApp — the
 * user is silently disconnected from Spotify on the next activity tick.
 *
 * Post-fix the in-flight refresh is gated by a Redis distributed lock
 * (`SET refresh:spotify:${appId} 1 NX EX 10`). The winner runs the HTTP
 * refresh + DB write; the loser polls until the lock clears, then re-reads
 * the DB row to pick up the rotated tokens the winner persisted.
 *
 * The cross-replica scenario is simulated by importing `spotifyTokens.ts`
 * TWICE through `vi.resetModules()` so each "replica" gets its own
 * per-process Map but they share the mocked Redis fake.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.SPOTIFY_CLIENT_ID = 'test-client-id';
process.env.SPOTIFY_CLIENT_SECRET = 'test-client-secret';

const APP_ID = 'connected-app-id-1';

// Redis fake
// Minimal SET/EXISTS/GET/DEL covering the ioredis subset spotifyTokens.ts uses.
// `set(k, v, 'EX', sec, 'NX')` returns 'OK' if the key was absent, null otherwise.
const redisStore = new Map<string, { value: string; expiresAt: number }>();

function redisGetActive(key: string): string | null {
  const entry = redisStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    redisStore.delete(key);
    return null;
  }
  return entry.value;
}

const redisMock = {
  set: vi.fn(async (
    key: string,
    value: string,
    _exFlag: 'EX',
    seconds: number,
    nxFlag?: 'NX',
  ): Promise<'OK' | null> => {
    if (nxFlag === 'NX' && redisGetActive(key) !== null) return null;
    redisStore.set(key, { value, expiresAt: Date.now() + seconds * 1000 });
    return 'OK';
  }),
  exists: vi.fn(async (key: string): Promise<number> => (redisGetActive(key) !== null ? 1 : 0)),
  get: vi.fn(async (key: string): Promise<string | null> => redisGetActive(key)),
  del: vi.fn(async (key: string): Promise<number> => {
    const had = redisStore.has(key);
    redisStore.delete(key);
    return had ? 1 : 0;
  }),
};

vi.mock('../src/redis.js', () => ({ redis: redisMock, redisEnabled: true }));

// Prisma fake
// `connectedApp.update` records the latest persisted state so the loser-branch
// `findUnique` can return the rotated row the winner wrote.
const dbState: { accessToken: string; refreshToken: string; tokenExpiresAt: Date | null } = {
  accessToken: 'enc:initial-access',
  refreshToken: 'enc:initial-refresh',
  tokenExpiresAt: new Date(Date.now() - 60_000),
};

const prismaStub = {
  connectedApp: {
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const data = args.data;
      if (typeof data.accessToken === 'string') dbState.accessToken = data.accessToken;
      if (typeof data.refreshToken === 'string') dbState.refreshToken = data.refreshToken;
      if (data.tokenExpiresAt instanceof Date) dbState.tokenExpiresAt = data.tokenExpiresAt;
      return { id: args.where.id, ...dbState };
    }),
    findUnique: vi.fn(async (_args: { where: { id: string }; select?: Record<string, boolean> }) => ({
      accessToken: dbState.accessToken,
      tokenExpiresAt: dbState.tokenExpiresAt,
    })),
    delete: vi.fn(async () => ({})),
  },
};

vi.mock('../src/db.js', () => ({ prisma: prismaStub }));

vi.mock('../src/services/mfaCrypto.js', () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {} }),
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, fatal: () => {},
  },
}));

vi.mock('../src/socketHandlers/infrastructure.js', () => ({
  cappedMapSet: (map: Map<unknown, unknown>, key: unknown, value: unknown) => {
    map.set(key, value);
  },
}));

// Spotify HTTP fake
// Counts how many real refresh POSTs fire across both replicas and rotates the
// refresh_token to mirror Spotify's production behavior. The 50 ms delay holds
// the winner's lock long enough for the loser-replica to arrive at the lock.
let spotifyHttpCalls = 0;
const ROTATED_ACCESS_TOKEN = 'rotated-access-token';
const ROTATED_REFRESH_TOKEN = 'rotated-refresh-token';
const SPOTIFY_HTTP_DELAY_MS = 50;

const fetchMock = vi.fn(async (url: string | URL | Request): Promise<Response> => {
  const u = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
  if (u !== 'https://accounts.spotify.com/api/token') {
    throw new Error(`unexpected fetch in test: ${u}`);
  }
  spotifyHttpCalls++;
  await new Promise((resolve) => setTimeout(resolve, SPOTIFY_HTTP_DELAY_MS));
  return new Response(
    JSON.stringify({
      access_token: ROTATED_ACCESS_TOKEN,
      refresh_token: ROTATED_REFRESH_TOKEN,
      expires_in: 3600,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
});

/**
 * Load the module fresh so the `refreshLocks` Map is empty — simulating a
 * separate replica's instance of `spotifyTokens.ts`. Each call returns a
 * distinct module exports object whose per-process Map is isolated, while
 * all modules share the file-scope `redisMock` / `prismaStub` (as two real
 * replicas would share Redis + Postgres).
 */
async function loadReplicaModule(): Promise<typeof import('../src/services/spotifyTokens.js')> {
  vi.resetModules();
  return import('../src/services/spotifyTokens.js');
}

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  spotifyHttpCalls = 0;
  dbState.accessToken = 'enc:initial-access';
  dbState.refreshToken = 'enc:initial-refresh';
  dbState.tokenExpiresAt = new Date(Date.now() - 60_000);
  vi.stubGlobal('fetch', fetchMock);
});

describe('refreshSpotifyToken — cross-replica mutex', () => {
  it('two replicas refreshing the same app fire only ONE Spotify HTTP refresh; both observe the rotated token', async () => {
    const replicaA = await loadReplicaModule();
    const replicaB = await loadReplicaModule();

    const refreshArg = { id: APP_ID, refreshToken: 'enc:initial-refresh' };
    const [resA, resB] = await Promise.all([
      replicaA.refreshSpotifyToken(refreshArg),
      replicaB.refreshSpotifyToken(refreshArg),
    ]);

    // Exactly ONE HTTP POST across both replicas — the Redis SET NX EX wins
    // for the winner; the loser's `refreshWithRedisLock` polls + re-reads DB.
    expect(spotifyHttpCalls).toBe(1);

    // Both callers receive a usable accessToken — winner from the HTTP body,
    // loser from re-reading the DB row the winner persisted.
    expect(resA?.accessToken).toBe(ROTATED_ACCESS_TOKEN);
    expect(resB?.accessToken).toBe(ROTATED_ACCESS_TOKEN);

    // Lock must be DEL'd after the winner finishes (not just expire by TTL).
    expect(redisStore.has(`refresh:spotify:${APP_ID}`)).toBe(false);

    // The DB holds the rotated refresh_token — confirms the winner wrote
    // before the loser read.
    expect(dbState.refreshToken).toBe(`enc:${ROTATED_REFRESH_TOKEN}`);

    // The loser must have re-read the DB row (one findUnique on the loser path).
    expect(prismaStub.connectedApp.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaStub.connectedApp.findUnique).toHaveBeenCalledWith({
      where: { id: APP_ID },
      select: { accessToken: true, tokenExpiresAt: true },
    });
  });

  it('lock is released after a successful refresh — a later replica refreshes again, no leftover state', async () => {
    const replicaA = await loadReplicaModule();
    const first = await replicaA.refreshSpotifyToken({ id: APP_ID, refreshToken: 'enc:initial-refresh' });
    expect(first?.accessToken).toBe(ROTATED_ACCESS_TOKEN);
    expect(spotifyHttpCalls).toBe(1);
    expect(redisStore.has(`refresh:spotify:${APP_ID}`)).toBe(false);

    const replicaB = await loadReplicaModule();
    const second = await replicaB.refreshSpotifyToken({ id: APP_ID, refreshToken: dbState.refreshToken });
    expect(second?.accessToken).toBe(ROTATED_ACCESS_TOKEN);
    expect(spotifyHttpCalls).toBe(2); // sequential refresh — lock cleanup confirmed
  });

  it('falls back to direct refresh when redis is unavailable (single-replica mode)', async () => {
    vi.resetModules();
    vi.doMock('../src/redis.js', () => ({ redis: null, redisEnabled: false }));
    const mod = await import('../src/services/spotifyTokens.js');

    const result = await mod.refreshSpotifyToken({ id: APP_ID, refreshToken: 'enc:initial-refresh' });

    expect(result?.accessToken).toBe(ROTATED_ACCESS_TOKEN);
    expect(spotifyHttpCalls).toBe(1);
    expect(redisStore.size).toBe(0); // never touched Redis
    vi.doUnmock('../src/redis.js');
  });
});
