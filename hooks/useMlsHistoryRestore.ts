// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { isChannelMls } from '../services/encryptionFlags';
import { restoreChannelHistory } from '../services/mls/mlsHistoryRestore';

/**
 * Lazy per-channel MLS history restore in the tab that has the DM open.
 *
 * On open (and on retry when the channel becomes ready) pull the full sealed
 * archive for the active DM channel down into the local history store, so a
 * fresh/recovered device can read a Saved DM's full history. restoreChannelHistory
 * is idempotent (per-session dedupe + per-channel cross-tab lock) and fails closed
 * before the channel is established, so a too-early call is a harmless no-op that
 * we retry once readiness is signalled.
 */
export function useMlsHistoryRestore(opts: { currentUserId?: string; activeDmChannelId?: string | null }): void {
  const { currentUserId, activeDmChannelId } = opts;
  useEffect(() => {
    if (!currentUserId || !activeDmChannelId) return;
    const ch = activeDmChannelId;
    let cancelled = false;
    const tryRestore = (): void => {
      if (cancelled || !isChannelMls(ch) || !mlsCoordinator.isReadyForChannel(ch)) return;
      void restoreChannelHistory(currentUserId, ch);
    };
    tryRestore(); // already-ready case
    const offReady = mlsCoordinator.mlsEvents.on((e) => { if (e === 'mls-ready') tryRestore(); });
    const offEpoch = mlsCoordinator.onEpochChange((e) => { if (e.dmChannelId === ch) tryRestore(); });
    // First-join gap: on a fresh device the External-Commit self-join runs concurrently
    // with the open, so the channel becomes ready AFTER mount but fires neither mls-ready
    // nor onEpochChange(ch) here; retry on the dedicated ready-channel transition.
    const offReadyCh = mlsCoordinator.onReadyChannel((id) => { if (id === ch) tryRestore(); });
    return () => { cancelled = true; offReady(); offEpoch(); offReadyCh(); };
  }, [currentUserId, activeDmChannelId]);
}
