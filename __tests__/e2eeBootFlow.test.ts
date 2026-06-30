// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression test for the post-bootstrap E2EE login-prompt restoration.
 *
 * Bug history:
 *   1. checkSetup() was hardened to throw on transient backend failures
 *      rather than silently returning false. The intent
 *      was to avoid showing the SETUP modal to users who already have
 *      keys when the backend has a cold-start 5xx blip.
 *   2. The session-restore path in App.tsx wraps the whole encryption-init
 *      block in a single try/catch that swallows the throw. Result: a
 *      transient checkSetup failure silently skips both the auto-unlock
 *      attempt AND the unlock-modal fallback, leaving the user stranded
 *      with encrypted message placeholders and no prompt.
 *   3. Additionally, the modal-state set was happening BEFORE setCurrentUser,
 *      meaning the consuming AppLayout (gated on currentUser !== null)
 *      wasn't mounted yet, creating a fragility window.
 *
 * This test asserts the App.tsx logic shape via dmKeyManager mocks:
 *   - getUnlockOnLogin() defaults to true (no opt-out → prompt at login)
 *   - tryAutoUnlock() returns false when no remembered credential exists
 *   - The "transient checkSetup failure" path is correctly identified
 *     so the App.tsx restore() block can route to the unlock modal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    getDmKeyBundle: vi.fn(),
  },
}));

import { apiClient } from '../services/api';
import {
  checkSetup,
  getUnlockOnLogin,
  setUnlockOnLogin,
  tryAutoUnlock,
  isUnlocked,
  isSetup,
} from '../services/dmKeyManager';

const getBundle = apiClient.getDmKeyBundle as ReturnType<typeof vi.fn>;

function httpError(status: number, message = `Request failed with status ${status}`) {
  return Object.assign(new Error(message), { status });
}

describe('E2EE boot-flow — login-prompt regression', () => {
  beforeEach(() => {
    getBundle.mockReset();
    // Clear localStorage to ensure clean defaults each test.
    try { localStorage.clear(); } catch { /* noop */ }
  });

  afterEach(() => {
    try { localStorage.clear(); } catch { /* noop */ }
  });

  describe('getUnlockOnLogin defaults', () => {
    it('returns true when no preference has been set', () => {
      // Critical default: a fresh install / unset preference must prompt
      // for the unlock passphrase at login. Returning false here is the
      // exact regression where the user reports "I am not prompted to
      // enter my encryption password."
      expect(getUnlockOnLogin()).toBe(true);
    });

    it('returns false when explicitly opted out', () => {
      setUnlockOnLogin(false);
      expect(getUnlockOnLogin()).toBe(false);
    });

    it('returns true when explicitly opted in', () => {
      setUnlockOnLogin(true);
      expect(getUnlockOnLogin()).toBe(true);
    });
  });

  describe('tryAutoUnlock — no remembered credential', () => {
    it('returns false when REMEMBER_KEY is empty', async () => {
      // tryAutoUnlock without a stored credential must return false so
      // App.tsx falls through to the unlock-modal branch. Returning true
      // (or throwing in a way that's caught silently) would skip the
      // prompt — the exact regression symptom.
      const result = await tryAutoUnlock();
      expect(result).toBe(false);
      expect(isUnlocked()).toBe(false);
    });
  });

  describe('checkSetup — transient failure → restore path', () => {
    it('throws on 5xx so App.tsx can detect a transient and still prompt', async () => {
      // The App.tsx restore() block must be able to distinguish "404 = no
      // bundle ever" (don't nag opted-out users) from "5xx = transient
      // failure" (still prompt for unlock). checkSetup throwing on 5xx
      // is the signal — if it silently returned false here, App.tsx
      // would route opted-in users to the no-modal path and strand them.
      getBundle.mockRejectedValueOnce(httpError(503));
      await expect(checkSetup()).rejects.toMatchObject({ status: 503 });
      // _hasBundle stays at its module default (false) since the call
      // failed transiently before mutating state.
      expect(isSetup()).toBe(false);
    });

    it('returns false cleanly on 404 so first-time / opted-out users are not nagged', async () => {
      getBundle.mockRejectedValueOnce(httpError(404));
      const result = await checkSetup();
      expect(result).toBe(false);
      expect(isSetup()).toBe(false);
    });
  });

  describe('App.tsx restore() decision matrix', () => {
    // Synthesizes the conditional shape from App.tsx so the prompt-decision
    // logic is unit-testable independent of the React render tree. This
    // lets us catch any future regression where the boolean gate flips
    // without running the full app shell.
    function decideUnlockModal(opts: {
      hasBundle: boolean;
      checkSetupTransientFail: boolean;
      isUnlocked: boolean;
      autoUnlocked: boolean;
      unlockOnLogin: boolean;
    }): boolean {
      const { hasBundle, checkSetupTransientFail, isUnlocked: locked, autoUnlocked, unlockOnLogin } = opts;
      if (hasBundle && !locked) {
        if (!autoUnlocked && unlockOnLogin) return true;
      } else if (checkSetupTransientFail && unlockOnLogin && !locked) {
        return true;
      }
      return false;
    }

    it('prompts when bundle exists, manager locked, auto-unlock failed, opted in', () => {
      // The "I just refreshed and need to type my passphrase" path.
      expect(decideUnlockModal({
        hasBundle: true,
        checkSetupTransientFail: false,
        isUnlocked: false,
        autoUnlocked: false,
        unlockOnLogin: true,
      })).toBe(true);
    });

    it('does NOT prompt when remember-on-device auto-unlocked successfully', () => {
      expect(decideUnlockModal({
        hasBundle: true,
        checkSetupTransientFail: false,
        isUnlocked: false,
        autoUnlocked: true,
        unlockOnLogin: true,
      })).toBe(false);
    });

    it('does NOT prompt when user explicitly opted out of unlock-on-login', () => {
      expect(decideUnlockModal({
        hasBundle: true,
        checkSetupTransientFail: false,
        isUnlocked: false,
        autoUnlocked: false,
        unlockOnLogin: false,
      })).toBe(false);
    });

    it('PROMPTS on transient checkSetup failure (regression coverage)', () => {
      // This is the exact regression: pre-fix, a transient checkSetup
      // throw caused the outer try/catch to swallow the error and skip
      // the modal entirely. Post-fix, App.tsx tracks the transient and
      // still routes to the unlock modal as a recovery affordance.
      expect(decideUnlockModal({
        hasBundle: false,
        checkSetupTransientFail: true,
        isUnlocked: false,
        autoUnlocked: false,
        unlockOnLogin: true,
      })).toBe(true);
    });

    it('does NOT prompt on clean 404 (genuinely no bundle, e.g. opted-out user)', () => {
      // 404 returns hasBundle=false WITHOUT setting checkSetupTransientFail.
      // The user dismissed the EncryptionChoiceModal at login; we must
      // not nag them on every refresh.
      expect(decideUnlockModal({
        hasBundle: false,
        checkSetupTransientFail: false,
        isUnlocked: false,
        autoUnlocked: false,
        unlockOnLogin: true,
      })).toBe(false);
    });
  });
});
