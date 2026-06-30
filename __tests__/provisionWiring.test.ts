// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * provisionMlsDevice() is wired into the App.tsx authenticated-session-start gate
 * (both the session-restore boot path and the handleAuthSuccess login path). It
 * fires fire-and-forget, BEFORE and independent of vault unlock, and its rejection
 * is swallowed (logged) so a failed provision never blocks login/unlock.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('provisionMlsDevice — App.tsx authenticated-session-start wiring (shape)', () => {
  async function postAuthGate(deps: {
    provisionMlsDevice: () => Promise<void>;
    checkSetup: () => Promise<boolean>;
    tryAutoUnlock: () => Promise<boolean>;
    isUnlocked: () => boolean;
    logError: (m: string) => void;
  }): Promise<void> {
    void deps.provisionMlsDevice().catch((e) => deps.logError('provision failed: ' + (e as Error)?.message));
    const hasBundle = await deps.checkSetup();
    if (hasBundle && !deps.isUnlocked()) {
      await deps.tryAutoUnlock();
    }
  }

  it('calls provisionMlsDevice exactly once, independent of unlock outcome', async () => {
    const provisionMlsDevice = vi.fn(() => Promise.resolve());
    const tryAutoUnlock = vi.fn(() => Promise.resolve(false));
    await postAuthGate({ provisionMlsDevice, checkSetup: () => Promise.resolve(true), tryAutoUnlock, isUnlocked: () => false, logError: () => {} });
    expect(provisionMlsDevice).toHaveBeenCalledTimes(1);
  });

  it('calls provisionMlsDevice even when there is NO bundle (not gated on hasBundle)', async () => {
    const provisionMlsDevice = vi.fn(() => Promise.resolve());
    await postAuthGate({ provisionMlsDevice, checkSetup: () => Promise.resolve(false), tryAutoUnlock: () => Promise.resolve(false), isUnlocked: () => false, logError: () => {} });
    expect(provisionMlsDevice).toHaveBeenCalledTimes(1);
  });

  it('swallows a provisioner rejection (login/unlock not blocked)', async () => {
    const logError = vi.fn();
    const provisionMlsDevice = vi.fn(() => Promise.reject(new Error('boom')));
    const tryAutoUnlock = vi.fn(() => Promise.resolve(true));
    await postAuthGate({ provisionMlsDevice, checkSetup: () => Promise.resolve(true), tryAutoUnlock, isUnlocked: () => false, logError });
    expect(tryAutoUnlock).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});

describe('provisionMlsDevice — wired into App.tsx (source guard)', () => {
  it('App.tsx invokes dmKeyManager.provisionMlsDevice() at both auth-start gates', () => {
    const src = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    const calls = src.match(/dmKeyManager\.provisionMlsDevice\(\)/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });
});
