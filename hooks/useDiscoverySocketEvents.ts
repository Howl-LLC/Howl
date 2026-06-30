// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import { socketService } from '../services/socket';
import { useDiscoveryStore } from '../stores/discoveryStore';

/**
 * Registers socket events that should trigger the Discover page to refetch:
 * - server-community-updated: a server toggled community/discovery on or off,
 *   or edited its discovery metadata. The discoverable set may have changed.
 *
 * The store's `invalidate()` no-ops when a fetch is already in-flight, so a
 * burst of toggles won't thrash the API.
 */
export function useDiscoverySocketEvents(opts: {
  currentUserId: string | undefined;
}): void {
  const { currentUserId } = opts;

  useEffect(() => {
    if (!currentUserId) return;

    socketService.onServerCommunityUpdated(() => {
      useDiscoveryStore.getState().invalidate();
    });

    return () => {
      socketService.offServerCommunityUpdated();
    };
  }, [currentUserId]);
}
