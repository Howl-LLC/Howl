// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';
import { prisma } from '../src/db.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..', '..');

afterAll(async () => { await cleanupTestData(); });

describe('Validation error sanitization', () => {
  it('validation errors do not expose body/query/params prefixes', async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const channelId = server.channels[0].id;

    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({});

    expect(res.status).toBe(400);
    const body = res.body;
    expect(body.error).toBe('Validation failed');
    if (body.fields) {
      for (const key of Object.keys(body.fields)) {
        expect(key).not.toMatch(/^body\./);
        expect(key).not.toMatch(/^query\./);
        expect(key).not.toMatch(/^params\./);
      }
    }
  });

  it('password validation returns joined string, not Zod flattenError object', async () => {
    const res = await request(app)
      .post('/api/auth/reset-password')
      .send({ email: 'test@example.com', code: '000000', newPassword: 'weak', captchaToken: 'skip' });

    if (res.status === 400 && res.body.error) {
      expect(typeof res.body.error).toBe('string');
      expect(res.body.error).not.toHaveProperty('formErrors');
      expect(res.body.error).not.toHaveProperty('fieldErrors');
    }
  });
});

describe('API response data exposure', () => {
  it('message response uses explicit fields, not raw Prisma spread', async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);
    const channelId = server.channels[0].id;

    await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', `Bearer ${user.token}`)
      .send({ content: 'test message for field check' });

    const res = await request(app)
      .get(`/api/messages/channels/${channelId}`)
      .set('Authorization', `Bearer ${user.token}`);

    expect(res.status).toBe(200);
    const msg = res.body.messages?.[0];
    if (msg) {
      const allowedFields = new Set([
        'id', 'channelId', 'authorId', 'content', 'type', 'systemPayload',
        'replyToMessageId', 'attachmentUrl', 'attachmentName', 'attachmentContentType', 'attachmentWidth', 'attachmentHeight',
        'attachmentIsSpoiler', 'attachmentAlt',
        'forwarded', 'createdAt', 'editedAt',
        'authorUsername', 'authorDiscriminator', 'authorAvatar',
        'authorRoleColor', 'authorRoleStyle', 'authorStripePlan',
        'authorNameColor', 'authorNameFont', 'authorNameEffect',
        'authorAvatarEffect', 'authorBadges', 'replyTo', 'reactions',
      ]);
      for (const key of Object.keys(msg)) {
        expect(allowedFields.has(key)).toBe(true);
      }
    }
  });

  it('key bundle upload does not return internal database id', async () => {
    const user = await createTestUser();

    const res = await request(app)
      .post('/api/keys/bundle')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        identityPubKey: 'dGVzdGtleQ==',
        signedPreKey: 'dGVzdGtleQ==',
        preKeySignature: 'dGVzdHNpZw==',
        oneTimePreKeys: ['a2V5MQ==', 'a2V5Mg=='],
      });

    if (res.status === 200) {
      expect(res.body).not.toHaveProperty('id');
      expect(res.body).toHaveProperty('success');
    }
  });

  it('server error message does not expose internal data model', async () => {
    const user = await createTestUser();
    const server = await createTestServer(user.id);

    const res = await request(app)
      .get(`/api/servers/${server.id}`)
      .set('Authorization', `Bearer ${user.token}`);

    if (res.status === 200 || res.status === 500) {
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('Member role');
      expect(text).not.toContain('Prisma');
      expect(text).not.toContain('prisma');
    }
  });
});

describe('Error response sanitization', () => {
  it('500 errors return generic message, not stack traces', async () => {
    const res = await request(app)
      .get('/api/nonexistent-endpoint-for-testing')
      .set('Authorization', 'Bearer invalid');

    const body = res.body;
    const text = JSON.stringify(body);
    expect(text).not.toContain('node_modules');
    expect(text).not.toContain('at Function');
    expect(text).not.toContain('at Object');
    expect(text).not.toContain('.ts:');
  });

  it('auth error messages are generic (no user enumeration)', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nonexistent@example.com', password: 'WrongPass123!', captchaToken: 'skip' });

    expect([400, 401, 429]).toContain(res.status);
    if (res.body.error) {
      expect(res.body.error).not.toContain('not found');
      expect(res.body.error).not.toContain('does not exist');
      expect(res.body.error).not.toContain('PostgreSQL');
    }
  });
});

describe('Security headers', () => {
  it('does not expose x-powered-by header', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('sets permissions-policy header', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['permissions-policy']).toBeDefined();
    expect(res.headers['permissions-policy']).toContain('camera=(self)');
  });
});

describe('Build configuration hardening', () => {
  it('vite.config uses Vite mode parameter, not process.env.NODE_ENV', () => {
    const config = fs.readFileSync(path.join(rootDir, 'vite.config.ts'), 'utf8');
    expect(config).toContain('defineConfig(({ mode })');
    expect(config).toContain('mode === \'production\'');
    expect(config).not.toMatch(/process\.env\.NODE_ENV\s*===\s*'production'\s*\?\s*\['console'/);
    expect(config).not.toMatch(/process\.env\.NODE_ENV\s*===\s*'production'\s*\?\s*false\s*:\s*true/);
  });

  it('index.html CSP does not allow localhost wildcards', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    expect(html).not.toContain('http://localhost:*');
    expect(html).not.toContain('ws://localhost:*');
    expect(html).not.toContain('wss://localhost:*');
  });

  it('index.html does not contain import map with dependency versions', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    expect(html).not.toContain('importmap');
    expect(html).not.toContain('esm.sh');
  });

  it('index.html does not contain build tooling references outside comments', () => {
    const html = fs.readFileSync(path.join(rootDir, 'index.html'), 'utf8');
    // Strip HTML comments — they're removed in production builds
    const withoutComments = html.replace(/<!--[\s\S]*?-->/g, '');
    expect(withoutComments).not.toMatch(/vite/i);
    expect(withoutComments).not.toMatch(/esbuild/i);
  });

  it('ErrorBoundary never shows raw error messages to users', () => {
    const eb = fs.readFileSync(path.join(rootDir, 'components', 'ErrorBoundary.tsx'), 'utf8');
    expect(eb).not.toContain('this.state.error.message');
    // Generic error message via i18n key (resolves to "An unexpected error occurred")
    expect(eb).toContain('errors.unexpectedError');
  });

  it('ErrorBoundary only logs to console in dev mode', () => {
    const eb = fs.readFileSync(path.join(rootDir, 'components', 'ErrorBoundary.tsx'), 'utf8');
    expect(eb).toContain('import.meta.env.DEV');
    const lines = eb.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("console.error('ErrorBoundary")) {
        const preceding = lines.slice(Math.max(0, i - 3), i).join('\n');
        expect(preceding).toContain('import.meta.env.DEV');
      }
    }
  });

  it('React DevTools are disabled in production', () => {
    const entry = fs.readFileSync(path.join(rootDir, 'index.tsx'), 'utf8');
    expect(entry).toContain('__REACT_DEVTOOLS_GLOBAL_HOOK__');
    expect(entry).toContain('import.meta.env.PROD');
  });

  it('Electron production CSP does not allow localhost wildcards', () => {
    const main = fs.readFileSync(path.join(rootDir, 'main.js'), 'utf8');
    const cspMatch = main.match(/Content-Security-Policy.*?(?=\])/s);
    if (cspMatch) {
      expect(cspMatch[0]).not.toContain('ws://localhost:*');
      expect(cspMatch[0]).not.toContain('http://localhost:*');
    }
  });

  it('api client error messages do not reference infrastructure details', () => {
    const api = fs.readFileSync(path.join(rootDir, 'services', 'api', 'core.ts'), 'utf8');
    expect(api).not.toContain('port 5000');
    expect(api).not.toContain('PostgreSQL');
  });
});
