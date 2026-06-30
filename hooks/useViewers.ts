// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useMemo } from 'react';
import { useViewerStore } from '../stores/viewerStore';
import { makeStreamKey, type StreamContext, type StreamKey } from '../stores/types';
import { socketService } from '../services/socket';

/** First-observation bootstrap: when an indicator mounts for a stream key we
 *  have never asked about, fetch the current viewer list from the server so
 *  late joiners see correct counts even when no `viewer:changed` arrives
 *  during the indicator's lifetime. Module-scoped Set dedupes across remounts
 *  and component churn. */
const bootstrappedKeys = new Set<StreamKey>();

/**
 * Reads the viewer set for a single stream. Does NOT manage subscription —
 * subscription happens via `enableRemoteScreen` / `disableRemoteScreen` on the
 * call session, which are wired to emit socket events via `CallTransport`.
 *
 * Use this in UI components (ViewerIndicator, PipChrome) to read the current
 * viewer list + count.
 */
export function useViewers(ctx: StreamContext | null, ownerId: string | null, selfUserId?: string): {
  viewers: string[];
  count: number;
  hasStream: boolean;
} {
  const key = ctx && ownerId ? makeStreamKey(ctx, ownerId, 'screen') : null;
  const viewersState = useViewerStore(s => (key ? s.viewers.get(key) : null));

  useEffect(() => {
    if (!ctx || !ownerId || !key) return;
    if (bootstrappedKeys.has(key)) return;
    bootstrappedKeys.add(key);
    let cancelled = false;
    void socketService.requestViewerList({ context: ctx, streamOwnerId: ownerId, streamType: 'screen' })
      .then((res) => {
        if (cancelled) return;
        if (res.ok && res.viewers && res.viewers.length > 0) {
          useViewerStore.getState().addViewers(key, res.viewers);
        }
      })
      .catch(() => {
        bootstrappedKeys.delete(key);
      });
    return () => { cancelled = true; };
  }, [ctx, ownerId, key]);
  const count = useMemo(() => {
    if (!viewersState) return 0;
    if (selfUserId && viewersState.has(selfUserId)) return viewersState.size - 1;
    return viewersState.size;
  }, [viewersState, selfUserId]);

  const viewers = useMemo(() => {
    if (!viewersState) return [];
    const arr = Array.from(viewersState);
    return selfUserId ? arr.filter(id => id !== selfUserId) : arr;
  }, [viewersState, selfUserId]);

  return { viewers, count, hasStream: !!viewersState && viewersState.size > 0 };
}
