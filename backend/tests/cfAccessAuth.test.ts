// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * cfAccessAuth middleware — verifies the Cf-Access-Jwt-Assertion header
 * against Cloudflare's JWKS. Replaces the old IP-allowlist middleware.
 *
 * Tests mock the remote JWKS with a locally-generated keypair so we can
 * sign test JWTs and exercise every rejection path without network I/O.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPair, SignJWT, exportJWK, createLocalJWKSet } from 'jose';
import type { Request, Response } from 'express';

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'test-audience-aaa111';
const ISS = `https://${TEAM}`;
const ADMIN_ID = '00000000-0000-0000-0000-000000000001';
const ADMIN_EMAIL = 'admin@example.com';

// Test keypair generated once, shared across tests
let privateKey: CryptoKey;
let jwksPayload: { keys: any[] };

async function setupKeys() {
  const { privateKey: priv, publicKey: pub } = await generateKeyPair('RS256');
  privateKey = priv;
  const jwk = await exportJWK(pub);
  jwksPayload = { keys: [{ ...jwk, alg: 'RS256', kid: 'k1' }] };
}

async function signJwt(opts: {
  email?: string;
  aud?: string;
  iss?: string;
  expIn?: string;
  kid?: string;
  key?: CryptoKey;
}): Promise<string> {
  const jwt = new SignJWT({ email: opts.email ?? ADMIN_EMAIL })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'k1' })
    .setIssuedAt()
    .setAudience(opts.aud ?? AUD)
    .setIssuer(opts.iss ?? ISS)
    .setExpirationTime(opts.expIn ?? '5m');
  return jwt.sign(opts.key ?? privateKey);
}

function mockRequest(headers: Record<string, string> = {}): Request {
  return {
    method: 'GET',
    originalUrl: '/api/v1/admin/test',
    headers,
  } as unknown as Request;
}

function mockResponse(): Response & { _status: number; _body: unknown } {
  const res: any = {};
  res._status = 0;
  res._body = undefined;
  res.status = (s: number) => { res._status = s; return res; };
  res.json = (b: unknown) => { res._body = b; return res; };
  return res;
}

// Fresh admin lookup mock per test so we can flip it between "exists" / "missing"
let adminExistsResult: { id: string } | null = { id: ADMIN_ID };

vi.mock('../src/db.js', () => ({
  prisma: {
    adminUser: {
      findUnique: vi.fn(async () => adminExistsResult),
    },
  },
}));

// The middleware imports logger — silence it for tests
vi.mock('../src/logger.js', () => ({
  logger: {
    child: () => ({
      info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {},
    }),
  },
}));

// hashEmail is deterministic; real impl is fine but we don't need MFA_ENCRYPTION_KEY
vi.mock('../src/services/mfaCrypto.js', () => ({
  hashEmail: (email: string) => `hash:${email}`,
}));

// Swap createRemoteJWKSet → createLocalJWKSet(jwksPayload) so verification
// runs fully in-memory.
vi.mock('jose', async (orig) => {
  const actual = (await orig()) as typeof import('jose');
  return {
    ...actual,
    createRemoteJWKSet: () => actual.createLocalJWKSet(jwksPayload),
  };
});

beforeEach(async () => {
  await setupKeys();
  adminExistsResult = { id: ADMIN_ID };
  process.env.CF_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.CF_ACCESS_AUD = AUD;
  process.env.CF_ACCESS_ENFORCE = 'true';
  process.env.NODE_ENV = 'test';
  vi.resetModules();
});

afterEach(() => {
  delete process.env.CF_ACCESS_TEAM_DOMAIN;
  delete process.env.CF_ACCESS_AUD;
  delete process.env.CF_ACCESS_ENFORCE;
});

describe('cfAccessAuth', () => {
  it('rejects missing header when enforcement is on', async () => {
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest();
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_required');
  });

  it('passes a valid JWT from a known admin', async () => {
    const token = await signJwt({ email: ADMIN_EMAIL });
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': token });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0); // no error response
    expect((req as any).cfAccessEmail).toBe(ADMIN_EMAIL);
  });

  it('rejects a valid JWT when email is not a known admin', async () => {
    adminExistsResult = null;
    const token = await signJwt({ email: 'stranger@example.com' });
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': token });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_email_not_admin');
  });

  it('rejects a JWT with wrong audience', async () => {
    const token = await signJwt({ aud: 'different-aud' });
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': token });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_invalid');
  });

  it('rejects a JWT with wrong issuer', async () => {
    const token = await signJwt({ iss: 'https://evil.cloudflareaccess.com' });
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': token });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_invalid');
  });

  it('rejects a JWT signed by an unrelated key', async () => {
    // Sign with a freshly-generated key that is NOT in the JWKS we advertise
    const { privateKey: rogue } = await generateKeyPair('RS256');
    const token = await signJwt({ key: rogue, kid: 'unknown' });
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': token });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_invalid');
  });

  it('rejects an expired JWT', async () => {
    const token = await signJwt({ expIn: '-1s' });
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': token });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_invalid');
  });

  it('allows OPTIONS preflight through unchecked', async () => {
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = { method: 'OPTIONS', headers: {}, originalUrl: '/' } as unknown as Request;
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0);
  });

  it('runs in permissive mode when enforcement is off and header is missing', async () => {
    process.env.CF_ACCESS_ENFORCE = 'false';
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest();
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0);
  });

  it('still rejects a malformed header even in permissive mode', async () => {
    process.env.CF_ACCESS_ENFORCE = 'false';
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest({ 'cf-access-jwt-assertion': 'garbage.not.a.jwt' });
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._status).toBe(403);
    expect((res._body as any).error).toBe('cf_access_invalid');
  });

  it('is a no-op in dev when CF_ACCESS_TEAM_DOMAIN is unset', async () => {
    delete process.env.CF_ACCESS_TEAM_DOMAIN;
    process.env.NODE_ENV = 'development';
    const { cfAccessAuth } = await import('../src/middleware/cfAccessAuth.js');
    const req = mockRequest();
    const res = mockResponse();
    const next = vi.fn();
    await cfAccessAuth(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(res._status).toBe(0);
  });
});
