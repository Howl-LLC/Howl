// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import type { User } from '../types';
import { socketService } from '../services/socket';
import { isAppVisible, onVisibilityChange } from './useAppVisible';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useServerStore } from '../stores/serverStore';
import { useSocialStore } from '../stores/socialStore';
import { useDmStore } from '../stores/dmStore';
import { retryMlsEstablishForUser } from '../utils/mlsRetry';

const VALID_STATUSES: ReadonlySet<string> = new Set(['online', 'offline', 'idle', 'dnd']);

export interface UsePresenceUpdatesOpts {
  currentUserId: string | undefined;
}

/**
 * Buffers presence (online/offline/idle/dnd) updates and flushes every 2 seconds
 * to coalesce rapid status changes and prevent re-render storms.
 */
export function usePresenceUpdates(opts: UsePresenceUpdatesOpts): void {
  const {
    currentUserId,
  } = opts;

  const presenceBufferRef = useRef<Map<string, User['status']>>(new Map());
  const presenceIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!currentUserId) return;

    const flushPresence = () => {
      const updates = presenceBufferRef.current;
      if (updates.size === 0) return;
      const batch = new Map(updates);
      updates.clear();

      // Each store applies the whole patch in a single walk + single notify,
      // instead of N walks/notifies for N pending users.
      deferStoreUpdate(() => {
        useServerStore.getState().applyMemberPresencePatch(batch);
        useSocialStore.getState().applyFriendPresencePatch(batch);
        useDmStore.getState().applyDmChannelPresencePatch(batch);
        // A peer flipping to ANY connected status (online/idle/dnd) is a retry
        // trigger for a DM stranded on peer-unprovisioned (their KeyPackages
        // may now be published). The backend's deferred presence reconcile can
        // restore a reconnecting peer straight to idle/dnd without ever
        // broadcasting 'online', so gating on 'online' alone would miss those
        // reconnects. Bounded: retryMlsEstablishForUser no-ops unless that
        // channel explicitly failed.
        for (const [userId, status] of batch) {
          if (status !== 'offline') retryMlsEstablishForUser(userId);
        }
      });
    };

    const VISIBLE_FLUSH_MS = 2000;
    const HIDDEN_FLUSH_MS = 30000;

    function resetFlushInterval() {
      if (presenceIntervalRef.current) clearInterval(presenceIntervalRef.current);
      presenceIntervalRef.current = setInterval(flushPresence, isAppVisible() ? VISIBLE_FLUSH_MS : HIDDEN_FLUSH_MS);
    }

    const unsubVisibility = onVisibilityChange((visible) => {
      if (visible) flushPresence(); // catch up immediately
      resetFlushInterval();
    });

    resetFlushInterval(); // initial setup

    socketService.onPresenceUpdate(({ userId, status }) => {
      if (typeof userId !== 'string' || !userId || !VALID_STATUSES.has(status)) return;
      presenceBufferRef.current.set(userId, status as User['status']);
    });

    return () => {
      unsubVisibility();
      socketService.offPresenceUpdate();
      if (presenceIntervalRef.current) clearInterval(presenceIntervalRef.current);
      presenceBufferRef.current.clear();
    };
  }, [currentUserId]);
}
