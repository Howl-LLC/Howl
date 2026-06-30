// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Enforce the E2E vault is unlocked before joining any call (voice channel,
 * stage, DM/group call). All calls use LiveKit SFrame E2EE — if a participant
 * joins with their vault locked, their Room is created without a keyProvider,
 * they publish plaintext, and symmetric participants can't decode their
 * frames. The result is a silent "call" where nobody can see or hear anyone.
 *
 * Call `ensureE2eUnlockedForCall(retry)` BEFORE setting the connected channel
 * ID or entering the LiveKit room. If it returns false, abort the join — the
 * unlock/setup modal has been shown, and the `retry` callback (if provided)
 * will be invoked automatically after the user successfully unlocks the vault.
 */
import * as dmKeyManager from '../services/dmKeyManager';
import { useUiStore } from '../stores/uiStore';

export function ensureE2eUnlockedForCall(retry?: () => void): boolean {
  if (dmKeyManager.isUnlocked()) return true;
  const hasSetup = dmKeyManager.isSetup();
  const ui = useUiStore.getState();
  if (retry) ui.setPendingE2eAction(retry);
  ui.setE2ePassphraseModal(hasSetup ? 'unlock' : 'setup');
  return false;
}
