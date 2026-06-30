// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import type { GameActivity } from '../types';
import { socketService } from '../services/socket';
import { isAppVisible, onVisibilityChange } from './useAppVisible';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useSocialStore } from '../stores/socialStore';
import { useDmStore } from '../stores/dmStore';

export interface UseActivityUpdatesOpts {
  currentUserId: string | undefined;
}

interface ActivityUpdate {
  activity: GameActivity | null;
  secondaryActivity?: GameActivity | null;
}

/**
 * Buffers activity-update events and flushes every 2 seconds to coalesce
 * rapid activity changes and prevent re-render storms.
 * Mirrors the usePresenceUpdates pattern.
 */
export function useActivityUpdates(opts: UseActivityUpdatesOpts): void {
  const {
    currentUserId,
  } = opts;

  const activityBufferRef = useRef<Map<string, ActivityUpdate>>(new Map());
  const activityIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!currentUserId) return;

    const flushActivity = () => {
      const updates = activityBufferRef.current;
      if (updates.size === 0) return;
      const batch = new Map(updates);
      updates.clear();

      deferStoreUpdate(() => {
        for (const [userId, { activity, secondaryActivity }] of batch) {
          const act = activity ?? null;
          const sec = secondaryActivity ?? null;

          if (userId === currentUserId) {
            useAuthStore.getState().updateCurrentUser({ activity: act, secondaryActivity: sec });
          }

          useServerStore.getState().updateMemberActivity(userId, act, sec);
          useSocialStore.getState().updateFriendActivity(userId, act, sec);
          useDmStore.getState().updateDmChannelActivity(userId, act, sec);
        }
      });
    };

    const VISIBLE_FLUSH_MS = 2000;
    const HIDDEN_FLUSH_MS = 30000;

    function resetFlushInterval() {
      if (activityIntervalRef.current) clearInterval(activityIntervalRef.current);
      activityIntervalRef.current = setInterval(flushActivity, isAppVisible() ? VISIBLE_FLUSH_MS : HIDDEN_FLUSH_MS);
    }

    const unsubVisibility = onVisibilityChange((visible) => {
      if (visible) flushActivity(); // catch up immediately
      resetFlushInterval();
    });

    resetFlushInterval(); // initial setup

    socketService.onActivityUpdate(({ userId, activity, secondaryActivity }) => {
      if (typeof userId !== 'string' || !userId) return;
      activityBufferRef.current.set(userId, { activity: activity ?? null, secondaryActivity: secondaryActivity ?? null });
    });

    return () => {
      unsubVisibility();
      socketService.offActivityUpdate();
      if (activityIntervalRef.current) clearInterval(activityIntervalRef.current);
      activityBufferRef.current.clear();
    };
  }, [currentUserId]);
}
