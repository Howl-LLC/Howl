// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/tests/selfHost.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  isSelfHost, isAllPro, getRegistrationMode, getInstanceName,
  isEmailEnabled, emailVerificationDisabled, isVoiceEnabled, isBillingEnabled,
} from '../src/selfHost.js';

const ENV_KEYS = [
  'SELF_HOST', 'SELF_HOST_ALL_PRO', 'REGISTRATION_MODE', 'INSTANCE_NAME',
  'RESEND_API_KEY', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET', 'LIVEKIT_WS_URL', 'LIVEKIT_URL', 'STRIPE_SECRET_KEY',
] as const;
const saved: Record<string, string | undefined> = {};
function setEnv(patch: Record<string, string | undefined>) {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('selfHost helpers', () => {
  it('isSelfHost reflects SELF_HOST=true', () => {
    setEnv({ SELF_HOST: 'true' }); expect(isSelfHost()).toBe(true);
    setEnv({}); expect(isSelfHost()).toBe(false);
  });
  it('isAllPro is on under self-host unless explicitly disabled', () => {
    setEnv({ SELF_HOST: 'true' }); expect(isAllPro()).toBe(true);
    setEnv({ SELF_HOST: 'true', SELF_HOST_ALL_PRO: 'false' }); expect(isAllPro()).toBe(false);
    setEnv({}); expect(isAllPro()).toBe(false);
  });
  it('getRegistrationMode defaults to closed under self-host, open otherwise', () => {
    setEnv({ SELF_HOST: 'true' }); expect(getRegistrationMode()).toBe('closed');
    setEnv({ SELF_HOST: 'true', REGISTRATION_MODE: 'open' }); expect(getRegistrationMode()).toBe('open');
    setEnv({}); expect(getRegistrationMode()).toBe('open');
  });
  it('getInstanceName falls back to Howl', () => {
    setEnv({ INSTANCE_NAME: 'My Island' }); expect(getInstanceName()).toBe('My Island');
    setEnv({}); expect(getInstanceName()).toBe('Howl');
  });
  it('emailVerificationDisabled only when self-host AND no email provider', () => {
    setEnv({ SELF_HOST: 'true' }); expect(emailVerificationDisabled()).toBe(true);
    setEnv({ SELF_HOST: 'true', RESEND_API_KEY: 're_x' }); expect(emailVerificationDisabled()).toBe(false);
    setEnv({}); expect(emailVerificationDisabled()).toBe(false);
  });
  it('isVoiceEnabled requires real LiveKit creds (not the dev defaults)', () => {
    setEnv({ LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret', LIVEKIT_WS_URL: 'wss://lk.example.com' });
    expect(isVoiceEnabled()).toBe(false);
    setEnv({ LIVEKIT_API_KEY: 'APIxxx', LIVEKIT_API_SECRET: 'realsecret', LIVEKIT_WS_URL: 'wss://lk.example.com' });
    expect(isVoiceEnabled()).toBe(true);
    setEnv({ LIVEKIT_API_KEY: 'APIxxx', LIVEKIT_API_SECRET: 'realsecret' });
    expect(isVoiceEnabled()).toBe(false);
  });
  it('isBillingEnabled is off under self-host, on for hosted with Stripe', () => {
    setEnv({ SELF_HOST: 'true', STRIPE_SECRET_KEY: 'sk_x' }); expect(isBillingEnabled()).toBe(false);
    setEnv({ STRIPE_SECRET_KEY: 'sk_x' }); expect(isBillingEnabled()).toBe(true);
    setEnv({}); expect(isBillingEnabled()).toBe(false);
  });
});

import { getEffectivePlan } from '../src/utils.js';

describe('getEffectivePlan under self-host', () => {
  afterEach(() => { delete process.env.SELF_HOST; delete process.env.SELF_HOST_ALL_PRO; });
  it('returns pro for any user when self-host all-pro is on', () => {
    process.env.SELF_HOST = 'true';
    expect(getEffectivePlan({ stripePlan: null })).toBe('pro');
    expect(getEffectivePlan({ stripePlan: 'free', stripeStatus: 'disputed' })).toBe('pro');
  });
  it('keeps normal plan logic when not self-host', () => {
    expect(getEffectivePlan({ stripePlan: null })).toBe('free');
  });
});
