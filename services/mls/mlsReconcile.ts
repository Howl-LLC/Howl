// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Main-thread classification heal.
 * dmKeyManager.unlock awaits this BEFORE flipping _isUnlocked: once the vault
 * unlocks, the coexistence legacy keys become usable, so every established
 * (migrated) MLS channel must already be classified 'mls' or a send would
 * silently route to legacy. Reads the key-free group index from IndexedDB
 * directly (origin-scoped, no at-rest key, no worker) and writes
 * setChannelProtocol locally (localStorage, main-thread only). Idempotent
 * (setChannelProtocol is a one-way ratchet); the worker's activate reconcile is
 * the steady-state backstop for channels established after unlock.
 */
import { getGroupIdToChannelMap } from './mlsGroupStore';
import { setChannelProtocol } from '../encryptionFlags';
import { logger } from '../logger';

export async function reconcileChannelClassifications(): Promise<void> {
  try {
    const g2c = await getGroupIdToChannelMap();
    for (const [, { channelId }] of g2c) setChannelProtocol(channelId, 'mls');
  } catch (err) {
    logger.warn('[mls][reconcile] main-thread classification heal failed', { error: (err as Error)?.message });
  }
}
