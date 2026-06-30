// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import { socketService } from '../services/socket';
import { apiClient } from '../services/api';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useNotificationStore } from '../stores/notificationStore';
import { useSocialStore } from '../stores/socialStore';

export interface UseSocialSocketEventsOpts {
  currentUserId: string | undefined;
  showGlobalToast: (message: string, type?: 'info' | 'warning', duration?: number) => void;
}

/**
 * Registers friend-list and report-reviewed socket events.
 */
export function useSocialSocketEvents(opts: UseSocialSocketEventsOpts): void {
  const {
    currentUserId,
    showGlobalToast,
  } = opts;

  // Report reviewed
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onReportReviewed(({ status }) => {
      const label = status === 'actioned' ? 'action was taken' : status === 'dismissed' ? 'been reviewed' : 'been reviewed';
      showGlobalToast(`Your report has ${label}. Thank you for helping keep Howl safe.`, 'info', 10000);
    });
    return () => { socketService.offReportReviewed(); };
  }, [currentUserId, showGlobalToast]);

  // Seed homeFriends on mount — previously this store only filled when
  // the user visited FriendsView or a friend-list socket event fired, so
  // HomeView showed "No friends online" on fresh login even when friends
  // were online. Fetch once on first auth so the home presence list is
  // correct before any navigation.
  useEffect(() => {
    if (!currentUserId) return;
    let cancelled = false;
    apiClient.getFriends().then((friends) => {
      if (cancelled) return;
      deferStoreUpdate(() => useSocialStore.getState().setHomeFriends(friends));
    }).catch(() => { /* surfaced elsewhere; Home will simply stay empty */ });
    return () => { cancelled = true; };
  }, [currentUserId]);

  // Friend list real-time updates
  useEffect(() => {
    if (!currentUserId) return;
    const bump = () => useSocialStore.getState().incrementFriendListVersion();

    socketService.onFriendRequestReceived(({ user }) => {
      if (!user?.id || typeof user.id !== 'string') return;
      const name = (typeof user.username === 'string' ? user.username : 'Someone').slice(0, 32);
      deferStoreUpdate(() => {
        useNotificationStore.getState().incrementPendingFriendRequests();
        bump();
      });
      showGlobalToast(`${name} sent you a friend request`, 'info', 5000);
    });
    socketService.onFriendRequestAccepted(({ user }) => {
      if (!user?.id || typeof user.id !== 'string') return;
      const name = (typeof user.username === 'string' ? user.username : 'Someone').slice(0, 32);
      apiClient.invalidateCache('friends');
      apiClient.getFriends().then((friends) => {
        deferStoreUpdate(() => useSocialStore.getState().setHomeFriends(friends));
      }).catch(() => {});
      showGlobalToast(`${name} accepted your friend request`, 'info', 5000);
      deferStoreUpdate(() => bump());
    });
    socketService.onFriendRequestDeclined(() => deferStoreUpdate(() => bump()));
    socketService.onFriendRequestCancelled(() => {
      deferStoreUpdate(() => {
        useNotificationStore.getState().decrementPendingFriendRequests();
        bump();
      });
    });
    socketService.onFriendRemoved((data) => {
      if (typeof data?.userId !== 'string' || !data.userId) return;
      deferStoreUpdate(() => {
        useSocialStore.getState().removeFriend(data.userId);
        bump();
      });
    });
    socketService.onFriendListUpdate(() => {
      apiClient.invalidateCache('friends');
      apiClient.invalidateCache('friendRequests');
      apiClient.getFriends().then((friends) => {
        deferStoreUpdate(() => useSocialStore.getState().setHomeFriends(friends));
      }).catch(() => {});
      apiClient.getFriendRequests().then((r) => {
        deferStoreUpdate(() => useNotificationStore.getState().setPendingFriendRequestCount(r.incoming.length));
      }).catch(() => {});
      deferStoreUpdate(() => bump());
    });

    return () => { socketService.offAllFriendEvents(); };
  }, [currentUserId, showGlobalToast]);
}
