// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Route-level tests for the proof-carrying admin enrollment flow
 *: factor-auth-first login branches, ceremony marker writes,
 * needs-scoping, and the mfa/disable step-up. WebAuthn crypto and TOTP
 * verification are mocked; these tests exercise the wiring around them.
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import express from 'express';
import request from 'supertest';

const ADMIN_JWT_SECRET = 'test-admin-jwt-secret-for-vitest';
process.env.ADMIN_JWT_SECRET = ADMIN_JWT_SECRET;
process.env.JWT_SECRET = 'test-jwt-secret-for-vitest';
process.env.NODE_ENV = 'test';

const ADMIN_ID = '00000000-0000-0000-0000-00000000bbbb';
const PASSWORD = 'CorrectHorse-Battery1!';

let passwordHash = '';

// Mutable per-test admin state. passkeyCount drives prisma.adminPasskey.count.
const baseAdminRow = {
  id: ADMIN_ID,
  email: 'matt@howlpro.com',
  username: 'matt',
  role: 'owner',
  forcePasswordChange: false,
  mfaEnabled: true,
  mfaTotpSecret: 'enc:PLAINSECRET',
  _count: { passkeys: 1 },
  passkeys: [] as any[], // register/begin reads admin.passkeys.length
};
let adminRowOverride: Partial<typeof baseAdminRow & { passwordHash: string }> = {};
let passkeyCount = 1;
let adminSessionRow: { id: string } | null = null;
let storedPasskeyRow: any = null;

vi.mock('../src/db.js', () => ({
  prisma: {
    adminUser: {
      findUnique: vi.fn(async () => ({ ...baseAdminRow, passwordHash, ...adminRowOverride })),
      findFirst: vi.fn(async () => ({ ...baseAdminRow, passwordHash, ...adminRowOverride })),
      update: vi.fn(async () => ({})),
    },
    adminPasskey: {
      count: vi.fn(async () => passkeyCount),
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(async () => storedPasskeyRow),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
    adminSession: {
      create: vi.fn(async () => ({})),
      findUnique: vi.fn(async () => adminSessionRow),
      deleteMany: vi.fn(async () => ({ count: 0 })),
      update: vi.fn(async () => ({})),
      // authenticateAdminToken's debounced lastActiveAt write. Without it the
      // middleware throws inside its try block and every authenticated request
      // 401s as 'Invalid or expired token'.
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
  },
}));

vi.mock('../src/redis.js', () => ({
  redis: null,
  getLoginLockout: async () => null,
  setLoginLockout: async () => {},
  deleteLoginLockout: async () => {},
}));

vi.mock('../src/logger.js', () => ({
  logger: {
    child: () => ({ info: () => {}, warn: () => {}, error: () => {}, fatal: () => {}, debug: () => {} }),
  },
}));

vi.mock('../src/services/mfaCrypto.js', () => ({
  hashEmail: (e: string) => `hash:${e}`,
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ''),
}));

vi.mock('../src/rateLimitStore.js', () => ({
  createRateLimitStore: () => undefined,
  RATE_LIMIT_DEFAULTS: {},
}));

// Delegating spy: setEnrollCeremonyMarker keeps its real implementation (so the
// positive marker assertions below read back real values) while recording calls,
// which lets the session-JWT cases assert that no marker was written at all.
vi.mock('../src/utils/adminEnrollment.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/adminEnrollment.js')>();
  return { ...actual, setEnrollCeremonyMarker: vi.fn(actual.setEnrollCeremonyMarker) };
});

vi.mock('otplib', () => ({
  generateSecret: () => 'PLAINSECRET',
  generateURI: () => 'otpauth://totp/test',
  verifySync: ({ token }: { token: string }) => ({ valid: token === '123456' }),
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: async () => 'data:image/png;base64,x' },
  toDataURL: async () => 'data:image/png;base64,x',
}));

vi.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: async () => ({ challenge: 'reg-challenge' }),
  verifyRegistrationResponse: async () => ({
    verified: true,
    registrationInfo: {
      credential: { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0 },
      credentialDeviceType: 'singleDevice',
      credentialBackedUp: false,
    },
  }),
  generateAuthenticationOptions: async () => ({ challenge: 'auth-challenge' }),
  verifyAuthenticationResponse: async () => ({
    verified: true,
    authenticationInfo: { newCounter: 1 },
  }),
}));

async function makeApp() {
  const adminAuthRouter = (await import('../src/routes/adminAuth.js')).default;
  const adminPasskeyRouter = (await import('../src/routes/adminPasskey.js')).default;
  const app = express();
  app.use(express.json());
  app.use('/admin/auth', adminAuthRouter);
  app.use('/admin/auth', adminPasskeyRouter);
  return app;
}

function enrollmentToken(opts: { jti?: string; needs?: unknown } = {}): string {
  const claims: Record<string, unknown> = { adminId: ADMIN_ID, scope: 'admin-enrollment' };
  if (opts.jti !== undefined) claims.jti = opts.jti;
  if (opts.needs !== undefined) claims.needs = opts.needs;
  return jwt.sign(claims, ADMIN_JWT_SECRET, { expiresIn: '15m' });
}

const DUMMY_CREDENTIAL = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  response: { clientDataJSON: 'x' },
};

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
});

beforeEach(async () => {
  adminRowOverride = {};
  passkeyCount = 1;
  adminSessionRow = null;
  storedPasskeyRow = null;
  vi.clearAllMocks();
  const single = await import('../src/utils/singleUseToken.js');
  single._resetSingleUseFallbackForTests();
  const markers = await import('../src/utils/adminEnrollment.js');
  markers._resetEnrollMarkersForTests();
  const stepUp = await import('../src/utils/adminStepUp.js');
  await stepUp.clearAdminStepUp(ADMIN_ID);
});

describe('authenticateAdminOrEnrollment (token format)', () => {
  it('rejects an enrollment token without jti', async () => {
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/passkey/register/begin')
      .set('Authorization', `Bearer ${enrollmentToken({ needs: ['passkey'] })}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('rejects an enrollment token without needs (old format)', async () => {
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/passkey/register/begin')
      .set('Authorization', `Bearer ${enrollmentToken({ jti: crypto.randomUUID() })}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('rejects an enrollment token with an invalid needs entry', async () => {
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/passkey/register/begin')
      .set('Authorization', `Bearer ${enrollmentToken({ jti: crypto.randomUUID(), needs: ['passkey', 'sms'] })}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('accepts a well-formed enrollment token', async () => {
    const app = await makeApp();
    passkeyCount = 0;
    const res = await request(app)
      .post('/admin/auth/passkey/register/begin')
      .set('Authorization', `Bearer ${enrollmentToken({ jti: crypto.randomUUID(), needs: ['totp', 'passkey'] })}`);
    expect(res.status).toBe(200);
    expect(res.body.challengeToken).toBeTypeOf('string');
  });
});

describe('ceremony endpoints: needs-scoping + markers', () => {
  it('refuses /passkey/register/begin for a needs:[totp] token', async () => {
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/passkey/register/begin')
      .set('Authorization', `Bearer ${enrollmentToken({ jti: crypto.randomUUID(), needs: ['totp'] })}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('refuses /mfa/setup for a needs:[passkey] token', async () => {
    const app = await makeApp();
    const res = await request(app)
      .post('/admin/auth/mfa/setup')
      .set('Authorization', `Bearer ${enrollmentToken({ jti: crypto.randomUUID(), needs: ['passkey'] })}`);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Invalid token scope');
  });

  it('still serves /mfa/setup to a full admin session JWT (no needs check)', async () => {
    const app = await makeApp();
    adminRowOverride = { mfaEnabled: false, mfaTotpSecret: null };
    adminSessionRow = { id: 'sess-1' };
    const sessionJwt = jwt.sign({ adminId: ADMIN_ID, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '15m' });
    const res = await request(app)
      .post('/admin/auth/mfa/setup')
      .set('Authorization', `Bearer ${sessionJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.setupToken).toBeTypeOf('string');
  });

  it('/mfa/enable under an enrollment token writes the totp marker for its jti', async () => {
    const app = await makeApp();
    adminRowOverride = { mfaEnabled: false, mfaTotpSecret: null };
    const jti = crypto.randomUUID();
    const setupToken = jwt.sign(
      { adminId: ADMIN_ID, totpSecret: 'enc:PLAINSECRET', scope: 'admin-mfa-setup' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app)
      .post('/admin/auth/mfa/enable')
      .set('Authorization', `Bearer ${enrollmentToken({ jti, needs: ['totp', 'passkey'] })}`)
      .send({ setupToken, code: '123456' });
    expect(res.status).toBe(200);
    const { getEnrollCeremonyMarker } = await import('../src/utils/adminEnrollment.js');
    expect(await getEnrollCeremonyMarker(jti, 'totp')).toBe(ADMIN_ID);
    expect(await getEnrollCeremonyMarker(jti, 'passkey')).toBeNull();
  });

  it('/mfa/enable under a session JWT writes no marker', async () => {
    const app = await makeApp();
    adminRowOverride = { mfaEnabled: false, mfaTotpSecret: null };
    adminSessionRow = { id: 'sess-1' };
    const sessionJwt = jwt.sign({ adminId: ADMIN_ID, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '15m' });
    const setupToken = jwt.sign(
      { adminId: ADMIN_ID, totpSecret: 'enc:PLAINSECRET', scope: 'admin-mfa-setup' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app)
      .post('/admin/auth/mfa/enable')
      .set('Authorization', `Bearer ${sessionJwt}`)
      .send({ setupToken, code: '123456' });
    expect(res.status).toBe(200);
    // A session JWT sets no req.enrollment, so there is no jti to look a marker
    // up under. Assert on the spy instead: the ceremony succeeded and wrote
    // nothing. (The enrollment-path test above is the positive.)
    const { setEnrollCeremonyMarker } = await import('../src/utils/adminEnrollment.js');
    expect(vi.mocked(setEnrollCeremonyMarker)).not.toHaveBeenCalled();
  });

  it('/passkey/register/finish under an enrollment token writes the passkey marker', async () => {
    const app = await makeApp();
    passkeyCount = 0;
    const jti = crypto.randomUUID();
    const challengeToken = jwt.sign(
      { challenge: 'reg-challenge', adminId: ADMIN_ID, scope: 'admin-passkey-register' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app)
      .post('/admin/auth/passkey/register/finish')
      .set('Authorization', `Bearer ${enrollmentToken({ jti, needs: ['passkey'] })}`)
      .send({ challengeToken, credential: DUMMY_CREDENTIAL, friendlyName: 'Test Key' });
    expect(res.status).toBe(200);
    const { getEnrollCeremonyMarker } = await import('../src/utils/adminEnrollment.js');
    expect(await getEnrollCeremonyMarker(jti, 'passkey')).toBe(ADMIN_ID);
  });
});

describe('factor-auth-first login branches', () => {
  const LOGIN = { email: 'matt@howlpro.com', password: PASSWORD };

  it('fresh account (no factors): password-only enrollment token with both needs', async () => {
    const app = await makeApp();
    adminRowOverride = { mfaEnabled: false, mfaTotpSecret: null };
    passkeyCount = 0;
    const res = await request(app).post('/admin/auth/login').send(LOGIN);
    expect(res.status).toBe(200);
    expect(res.body.enrollmentRequired).toBe(true);
    expect(res.body.needs).toEqual(['totp', 'passkey']);
    const decoded = jwt.verify(res.body.enrollmentToken, ADMIN_JWT_SECRET) as any;
    expect(decoded.scope).toBe('admin-enrollment');
    expect(decoded.needs).toEqual(['totp', 'passkey']);
    expect(typeof decoded.jti).toBe('string');
  });

  it('TOTP-only account: response is byte-shape identical to a fully enrolled login', async () => {
    const app = await makeApp();
    passkeyCount = 0; // TOTP on (base row), no passkeys
    const partial = await request(app).post('/admin/auth/login').send(LOGIN);
    passkeyCount = 1;
    const full = await request(app).post('/admin/auth/login').send(LOGIN);
    expect(partial.status).toBe(200);
    expect(partial.body.mfaRequired).toBe(true);
    expect(partial.body.mfaToken).toBeTypeOf('string');
    // No enrollment-state leak on password alone:
    expect(Object.keys(partial.body).sort()).toEqual(Object.keys(full.body).sort());
    expect(partial.body.enrollmentRequired).toBeUndefined();
    expect(partial.body.mfaEnabled).toBeUndefined();
    expect(partial.body.passkeyCount).toBeUndefined();
  });

  it('passkey-only account: passkeyRequired with a totpVerified:false login token', async () => {
    const app = await makeApp();
    adminRowOverride = { mfaEnabled: false, mfaTotpSecret: null };
    passkeyCount = 2;
    const res = await request(app).post('/admin/auth/login').send(LOGIN);
    expect(res.status).toBe(200);
    expect(res.body.passkeyRequired).toBe(true);
    const decoded = jwt.verify(res.body.passkeyToken, ADMIN_JWT_SECRET) as any;
    expect(decoded.scope).toBe('admin-passkey-login');
    expect(decoded.totpVerified).toBe(false);
    expect(res.body.enrollmentRequired).toBeUndefined();
  });

  it('/mfa/verify on a TOTP-only account mints a needs:[passkey] enrollment token', async () => {
    const app = await makeApp();
    passkeyCount = 0;
    const mfaToken = jwt.sign(
      { adminId: ADMIN_ID, scope: 'admin-mfa-login', jti: crypto.randomUUID() },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app).post('/admin/auth/mfa/verify').send({ mfaToken, code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.enrollmentRequired).toBe(true);
    expect(res.body.needs).toEqual(['passkey']);
    const decoded = jwt.verify(res.body.enrollmentToken, ADMIN_JWT_SECRET) as any;
    expect(decoded.needs).toEqual(['passkey']);
    expect(res.body.passkeyRequired).toBeUndefined();
  });

  it('/mfa/verify with passkeys mints a totpVerified:true passkey token (unchanged path)', async () => {
    const app = await makeApp();
    passkeyCount = 1;
    const mfaToken = jwt.sign(
      { adminId: ADMIN_ID, scope: 'admin-mfa-login', jti: crypto.randomUUID() },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app).post('/admin/auth/mfa/verify').send({ mfaToken, code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.passkeyRequired).toBe(true);
    const decoded = jwt.verify(res.body.passkeyToken, ADMIN_JWT_SECRET) as any;
    expect(decoded.totpVerified).toBe(true);
  });

  it('/passkey/login/begin threads totpVerified into the challenge token', async () => {
    const app = await makeApp();
    storedPasskeyRow = { id: 'pk-1', adminUserId: ADMIN_ID, credentialId: 'cred-1', publicKey: Buffer.from([1]).toString('base64'), counter: 0, transports: null };
    const { prisma } = await import('../src/db.js');
    (prisma.adminPasskey.findMany as any).mockResolvedValueOnce([{ credentialId: 'cred-1', transports: null }]);
    const passkeyToken = jwt.sign(
      { adminId: ADMIN_ID, scope: 'admin-passkey-login', totpVerified: false, jti: crypto.randomUUID() },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app).post('/admin/auth/passkey/login/begin').send({ passkeyToken });
    expect(res.status).toBe(200);
    const decoded = jwt.verify(res.body.challengeToken, ADMIN_JWT_SECRET) as any;
    expect(decoded.scope).toBe('admin-passkey-auth');
    expect(decoded.totpVerified).toBe(false);
  });

  function authChallengeToken(totpVerified: boolean): string {
    return jwt.sign(
      { challenge: `auth-challenge-${crypto.randomUUID()}`, adminId: ADMIN_ID, scope: 'admin-passkey-auth', totpVerified },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
  }

  it('/passkey/login/finish with totpVerified:false on a no-TOTP account mints needs:[totp]', async () => {
    const app = await makeApp();
    adminRowOverride = { mfaEnabled: false, mfaTotpSecret: null };
    storedPasskeyRow = { id: 'pk-1', adminUserId: ADMIN_ID, credentialId: 'cred-1', publicKey: Buffer.from([1]).toString('base64'), counter: 0, transports: null };
    const res = await request(app)
      .post('/admin/auth/passkey/login/finish')
      .send({ challengeToken: authChallengeToken(false), credential: DUMMY_CREDENTIAL });
    expect(res.status).toBe(200);
    expect(res.body.enrollmentRequired).toBe(true);
    expect(res.body.needs).toEqual(['totp']);
    expect(res.body.token).toBeUndefined();
  });

  it('/passkey/login/finish with totpVerified:false refuses a session when TOTP appeared mid-flight', async () => {
    const app = await makeApp();
    // base row has TOTP enabled: the raced case
    storedPasskeyRow = { id: 'pk-1', adminUserId: ADMIN_ID, credentialId: 'cred-1', publicKey: Buffer.from([1]).toString('base64'), counter: 0, transports: null };
    const res = await request(app)
      .post('/admin/auth/passkey/login/finish')
      .send({ challengeToken: authChallengeToken(false), credential: DUMMY_CREDENTIAL });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Please log in again');
    expect(res.body.token).toBeUndefined();
  });

  it('/passkey/login/finish with totpVerified:true issues the session (unchanged path)', async () => {
    const app = await makeApp();
    storedPasskeyRow = { id: 'pk-1', adminUserId: ADMIN_ID, credentialId: 'cred-1', publicKey: Buffer.from([1]).toString('base64'), counter: 0, transports: null };
    const res = await request(app)
      .post('/admin/auth/passkey/login/finish')
      .send({ challengeToken: authChallengeToken(true), credential: DUMMY_CREDENTIAL });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTypeOf('string');
    expect(res.body.user.id).toBe(ADMIN_ID);
    expect(JSON.stringify(res.body)).not.toContain('PLAINSECRET');
  });

  it('/passkey/login/finish treats a missing totpVerified claim as false (fail closed)', async () => {
    const app = await makeApp();
    storedPasskeyRow = { id: 'pk-1', adminUserId: ADMIN_ID, credentialId: 'cred-1', publicKey: Buffer.from([1]).toString('base64'), counter: 0, transports: null };
    const legacyChallenge = jwt.sign(
      { challenge: `auth-challenge-${crypto.randomUUID()}`, adminId: ADMIN_ID, scope: 'admin-passkey-auth' },
      ADMIN_JWT_SECRET,
      { expiresIn: '5m' },
    );
    const res = await request(app)
      .post('/admin/auth/passkey/login/finish')
      .send({ challengeToken: legacyChallenge, credential: DUMMY_CREDENTIAL });
    // base row has TOTP: raced-case refusal, NOT a session
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Please log in again');
  });
});

// Step-up state is cleared per-test by the top-level beforeEach
// (clearAdminStepUp), so these two are independent. Refusal stays first as
// hygiene: it proves the gate denies before any test grants step-up.
describe('POST /mfa/disable step-up', () => {
  it('refuses without fresh step-up', async () => {
    const app = await makeApp();
    adminSessionRow = { id: 'sess-1' };
    const sessionJwt = jwt.sign({ adminId: ADMIN_ID, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '15m' });
    const res = await request(app)
      .post('/admin/auth/mfa/disable')
      .set('Authorization', `Bearer ${sessionJwt}`)
      .send({ password: PASSWORD, code: '123456' });
    expect(res.status).toBe(401);
    expect(res.body.requiresStepUp).toBe(true);
  });

  it('succeeds with step-up + password + TOTP code', async () => {
    const app = await makeApp();
    adminSessionRow = { id: 'sess-1' };
    const { setAdminStepUp } = await import('../src/utils/adminStepUp.js');
    await setAdminStepUp(ADMIN_ID);
    const sessionJwt = jwt.sign({ adminId: ADMIN_ID, scope: 'admin' }, ADMIN_JWT_SECRET, { expiresIn: '15m' });
    const res = await request(app)
      .post('/admin/auth/mfa/disable')
      .set('Authorization', `Bearer ${sessionJwt}`)
      .send({ password: PASSWORD, code: '123456' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { prisma } = await import('../src/db.js');
    expect(prisma.adminUser.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { mfaEnabled: false, mfaTotpSecret: null } }),
    );
  });
});
