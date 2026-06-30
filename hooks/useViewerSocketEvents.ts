// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import { socketService } from '../services/socket';
import { useViewerStore } from '../stores/viewerStore';
import { makeStreamKey } from '../stores/types';

/**
 * Registers global listeners for `viewer:changed` / `viewer:cleared` and pipes
 * them into `viewerStore`. Mount once, at the same layer as the other
 * per-domain `use*SocketEvents` hooks (App.tsx).
 */
export function useViewerSocketEvents(): void {
  useEffect(() => {
    socketService.onViewerChanged((p) => {
      const key = makeStreamKey(p.context, p.streamOwnerId, p.streamType);
      if (p.add?.length) useViewerStore.getState().addViewers(key, p.add);
      if (p.remove?.length) useViewerStore.getState().removeViewers(key, p.remove);
    });
    socketService.onViewerCleared((p) => {
      const key = makeStreamKey(p.context, p.streamOwnerId, p.streamType);
      useViewerStore.getState().clearStream(key);
    });
    return () => {
      socketService.offViewerChanged();
      socketService.offViewerCleared();
    };
  }, []);
}
