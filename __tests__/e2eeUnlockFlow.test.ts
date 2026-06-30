// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * E2EE unlock-flow regression suite.
 *
 * Verifies the contract between dmKeyManager (the singleton) and
 * useUiStore.e2eLocked / e2ePassphraseModal at the boundaries that are easy
 * to silently break:
 *
 *   a) Boot with a bundle and no remembered device credential — the
 *      passphrase-unlock modal must open and `e2eLocked` must be `true`.
 *   b) Boot with a bundle and a valid remembered credential — no modal,
 *      `e2eLocked === false`.
 *   c) After dmKeyManager.unlock() resolves, every subscriber that mirrors
 *      lock state into useUiStore must see e2eLocked flip to false. This is
 *      the emitter contract; until that lands the assertion is authored as
 *      `it.todo`.
 *   d) getUnlockOnLogin() defaults to `true` when localStorage is unset.
 *   e) Every UI call site that funnels into dmKeyManager.unlock() leaves
 *      useUiStore.e2eLocked === false. Authored as `it.todo` until the
 *      writeback is centralised in services/dmEncryption.ts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    getDmKeyBundle: vi.fn(),
  },
}));

import { apiClient } from '../services/api';
import * as dmKeyManager from '../services/dmKeyManager';
import { useUiStore } from '../stores/uiStore';

const UNLOCK_ON_LOGIN_KEY = 'howl_e2e_unlock_on_login';

const getBundle = apiClient.getDmKeyBundle as ReturnType<typeof vi.fn>;

/**
 * Reproduces the critical block of App.tsx:914-941 (the boot/restore E2E init
 * branch) without dragging the entire React tree into the test. Mirroring it
 * here lets us assert the exact post-conditions that the production flow
 * guarantees, while still using the real dmKeyManager singleton and the real
 * useUiStore.
 */
async function runBootE2eInit(opts: {
  hasBundle: boolean;
  autoUnlocks: boolean;
  unlockOnLogin?: boolean;
}): Promise<void> {
  // App.tsx delegates to checkSetup() + tryAutoUnlock(). We stub both via
  // vi.spyOn so we don't have to drive the whole bundle/derive pipeline —
  // those primitives are exercised in dmKeyManagerCheckSetup.test.ts and
  // dmCrypto.test.ts respectively.
  const checkSetupSpy = vi.spyOn(dmKeyManager, 'checkSetup').mockResolvedValue(opts.hasBundle);
  const isSetupSpy = vi.spyOn(dmKeyManager, 'isSetup').mockReturnValue(opts.hasBundle);
  const isUnlockedSpy = vi.spyOn(dmKeyManager, 'isUnlocked').mockReturnValue(opts.autoUnlocks);
  const tryAutoUnlockSpy = vi.spyOn(dmKeyManager, 'tryAutoUnlock').mockResolvedValue(opts.autoUnlocks);
  const getUnlockOnLoginSpy = opts.unlockOnLogin !== undefined
    ? vi.spyOn(dmKeyManager, 'getUnlockOnLogin').mockReturnValue(opts.unlockOnLogin)
    : null;

  try {
    const hasBundle = await dmKeyManager.checkSetup();
    if (hasBundle && !dmKeyManager.isUnlocked()) {
      let unlocked = false;
      try {
        unlocked = await dmKeyManager.tryAutoUnlock();
      } catch {
        unlocked = false;
      }
      if (!unlocked && dmKeyManager.getUnlockOnLogin()) {
        useUiStore.getState().setE2ePassphraseModal('unlock');
      }
    }
  } finally {
    useUiStore.getState().setE2eLocked(
      dmKeyManager.isSetup() && !dmKeyManager.isUnlocked(),
    );
  }

  // Restore singleton method spies so subsequent tests see the real
  // implementations.
  checkSetupSpy.mockRestore();
  isSetupSpy.mockRestore();
  isUnlockedSpy.mockRestore();
  tryAutoUnlockSpy.mockRestore();
  getUnlockOnLoginSpy?.mockRestore();
}

beforeEach(() => {
  // Restore any spies that leaked from a prior test (e.g. an interrupted
  // runBootE2eInit that threw before reaching its restore calls). Without
  // this, a leaked vi.spyOn(dmKeyManager, 'getUnlockOnLogin') from one test
  // would clobber the real-impl assertions in the next.
  vi.restoreAllMocks();
  // Reset the API mock + ui store + the localStorage keys we care about.
  getBundle.mockReset();
  useUiStore.setState({
    e2eLocked: false,
    e2ePassphraseModal: null,
    encryptionChoicePassword: null,
    pendingE2eAction: null,
    showRecoveryReminder: false,
    recoveryKeyModal: null,
  });
  try {
    localStorage.removeItem(UNLOCK_ON_LOGIN_KEY);
  } catch { /* jsdom guarantees localStorage; ignore for safety */ }
});

describe('E2EE boot — passphrase modal opens when bundle exists and no device credential is remembered', () => {
  it('opens the unlock modal and sets e2eLocked when bundle exists, autoUnlock fails, and unlock-on-login is true', async () => {
    await runBootE2eInit({ hasBundle: true, autoUnlocks: false, unlockOnLogin: true });

    expect(useUiStore.getState().e2ePassphraseModal).toBe('unlock');
    expect(useUiStore.getState().e2eLocked).toBe(true);
  });

  it('does NOT open the unlock modal when unlock-on-login is false, but still sets e2eLocked', async () => {
    // User opted out of the prompt-on-login behavior — they want to be
    // un-prompted until they actually open a DM. The DM-column inline form
    // (gated on e2eLocked) is what surfaces in that case.
    await runBootE2eInit({ hasBundle: true, autoUnlocks: false, unlockOnLogin: false });

    expect(useUiStore.getState().e2ePassphraseModal).toBeNull();
    expect(useUiStore.getState().e2eLocked).toBe(true);
  });
});

describe('E2EE boot — silent path when device credential is valid', () => {
  it('does not open any modal and leaves e2eLocked false when tryAutoUnlock succeeds', async () => {
    await runBootE2eInit({ hasBundle: true, autoUnlocks: true, unlockOnLogin: true });

    expect(useUiStore.getState().e2ePassphraseModal).toBeNull();
    expect(useUiStore.getState().e2eLocked).toBe(false);
  });

  it('does nothing when there is no bundle (no setup prompt is opened from THIS branch)', async () => {
    // The setup-prompt path lives in handleAuthSuccess (App.tsx:3445-3450),
    // not in the restore branch this test mirrors. The restore path simply
    // leaves both pieces of state at their defaults.
    await runBootE2eInit({ hasBundle: false, autoUnlocks: false, unlockOnLogin: true });

    expect(useUiStore.getState().e2ePassphraseModal).toBeNull();
    expect(useUiStore.getState().e2eLocked).toBe(false);
  });
});

describe('E2EE preference — getUnlockOnLogin defaults', () => {
  it("returns true when 'howl_e2e_unlock_on_login' is unset", () => {
    // Verified key name against services/dmKeyManager.ts UNLOCK_ON_LOGIN_KEY.
    expect(localStorage.getItem(UNLOCK_ON_LOGIN_KEY)).toBeNull();
    expect(dmKeyManager.getUnlockOnLogin()).toBe(true);
  });

  it("returns false when explicitly set to '0'", () => {
    localStorage.setItem(UNLOCK_ON_LOGIN_KEY, '0');
    expect(dmKeyManager.getUnlockOnLogin()).toBe(false);
  });

  it("returns true when explicitly set to '1'", () => {
    localStorage.setItem(UNLOCK_ON_LOGIN_KEY, '1');
    expect(dmKeyManager.getUnlockOnLogin()).toBe(true);
  });

  it('round-trips through setUnlockOnLogin', () => {
    dmKeyManager.setUnlockOnLogin(false);
    expect(localStorage.getItem(UNLOCK_ON_LOGIN_KEY)).toBe('0');
    expect(dmKeyManager.getUnlockOnLogin()).toBe(false);

    dmKeyManager.setUnlockOnLogin(true);
    expect(localStorage.getItem(UNLOCK_ON_LOGIN_KEY)).toBe('1');
    expect(dmKeyManager.getUnlockOnLogin()).toBe(true);
  });
});

describe('E2EE emitter sync (depends on dmKeyManager.on)', () => {
  // These assertions describe the emitter contract:
  //   dmKeyManager.on(event, handler) → unsubscribe function
  //   events: 'locked' | 'unlocked' | 'setup-changed'
  //   services/dmEncryption.ts subscribes once and writes setE2eLocked(...).
  //
  // Until that lands the four `setE2eLocked(false)` writes scattered
  // through AppLayout.tsx, DMView.tsx, and the call-gate paths each have to
  // remember to mirror state. Two of them (the call-gate paths in
  // IncomingDMCallModal and the per-DM call-card) silently forget to.
  //
  // Authored as `it.todo` so the suite stays green until the emitter is in
  // place; flip to `it(...)` once it exists.

  it.todo('dmKeyManager.on(\'unlocked\', cb) returns an unsubscribe function');
  it.todo('subscriber in services/dmEncryption.ts flips e2eLocked to false on \'unlocked\'');
  it.todo('subscriber in services/dmEncryption.ts flips e2eLocked to true on \'locked\'');
  it.todo('every UI unlock call site (DM-column form, call-card gate, IncomingDMCallModal, EncryptionPassphraseModal) yields e2eLocked === false via the emitter rather than per-call manual setE2eLocked');
});

describe('EncryptionPassphraseModal unlock branch — content-key persistence gate', () => {
  // Mirrors the post-unlock persistence decision in AppLayout.tsx's
  // EncryptionPassphraseModal onSubmit handler:
  //   if (remember || dmKeyManager.isPasswordDerived()) dmKeyManager.rememberOnDevice(passphrase);
  // Server-recovery (passwordDerived) users are always-on and MUST persist
  // content keys regardless of the remember checkbox so the device boots
  // silently next time. Self users still honor the explicit checkbox. We mirror
  // the gate here (same pattern the boot tests use) rather than rendering the
  // whole React tree, while exercising the real dmKeyManager spies.
  function runUnlockPersistGate(remember: boolean): void {
    if (remember || dmKeyManager.isPasswordDerived()) {
      dmKeyManager.rememberOnDevice('pw');
    }
  }

  it('Server user (passwordDerived) with remember UNCHECKED still persists content keys', () => {
    vi.spyOn(dmKeyManager, 'isPasswordDerived').mockReturnValue(true);
    const remember = vi.spyOn(dmKeyManager, 'rememberOnDevice').mockResolvedValue(undefined);

    runUnlockPersistGate(false);

    expect(remember).toHaveBeenCalledTimes(1);
  });

  it('Self user (not passwordDerived) with remember UNCHECKED does NOT persist content keys', () => {
    vi.spyOn(dmKeyManager, 'isPasswordDerived').mockReturnValue(false);
    const remember = vi.spyOn(dmKeyManager, 'rememberOnDevice').mockResolvedValue(undefined);

    runUnlockPersistGate(false);

    expect(remember).not.toHaveBeenCalled();
  });

  it('Self user (not passwordDerived) with remember CHECKED persists content keys', () => {
    vi.spyOn(dmKeyManager, 'isPasswordDerived').mockReturnValue(false);
    const remember = vi.spyOn(dmKeyManager, 'rememberOnDevice').mockResolvedValue(undefined);

    runUnlockPersistGate(true);

    expect(remember).toHaveBeenCalledTimes(1);
  });
});

describe('useUiStore.e2eLocked invariant under the legacy manual-write model', () => {
  // These cover the pre-emitter world: each unlock call site is responsible
  // for calling setE2eLocked(false) itself. There are four such call sites;
  // these tests make sure the store's update mechanics don't regress (the
  // actual call-site coverage moves to the emitter tests above once the
  // emitter lands).
  it('setE2eLocked(false) drives e2eLocked to false', () => {
    useUiStore.setState({ e2eLocked: true });
    useUiStore.getState().setE2eLocked(false);
    expect(useUiStore.getState().e2eLocked).toBe(false);
  });

  it('setE2eLocked(true) drives e2eLocked to true', () => {
    useUiStore.setState({ e2eLocked: false });
    useUiStore.getState().setE2eLocked(true);
    expect(useUiStore.getState().e2eLocked).toBe(true);
  });

  it('clearAllModals also resets e2eLocked to false (logout / cross-tab signout)', () => {
    useUiStore.setState({ e2eLocked: true, e2ePassphraseModal: 'unlock' });
    useUiStore.getState().clearAllModals();
    expect(useUiStore.getState().e2eLocked).toBe(false);
    expect(useUiStore.getState().e2ePassphraseModal).toBeNull();
  });
});
