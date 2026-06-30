// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/tests/captcha.selfhost.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { verifyCaptcha } from '../src/services/captcha.js';

const savedNodeEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = savedNodeEnv; delete process.env.SELF_HOST; delete process.env.TURNSTILE_SECRET_KEY; });

describe('verifyCaptcha self-host bypass', () => {
  it('returns true with no Turnstile secret when self-host, even in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SELF_HOST = 'true';
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await verifyCaptcha(undefined)).toBe(true);
  });
  it('still rejects in production when not self-host and no secret', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.SELF_HOST;
    delete process.env.TURNSTILE_SECRET_KEY;
    expect(await verifyCaptcha(undefined)).toBe(false);
  });
});
