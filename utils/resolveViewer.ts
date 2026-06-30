// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useSocialStore } from '../stores/socialStore';
import { useServerStore } from '../stores/serverStore';
import { useDmStore } from '../stores/dmStore';

export interface ResolvedViewer {
  id: string;
  username: string;
  avatar?: string;
}

/**
 * Resolve a user ID to a display entry using local stores.
 * Looks up (in order): home friends, server members, DM participants.
 * Falls back to a short ID prefix if nothing matches.
 */
export function resolveViewer(userId: string): ResolvedViewer {
  const friend = useSocialStore.getState().homeFriends.find(f => f.id === userId);
  if (friend) return { id: userId, username: friend.username, avatar: friend.avatar ?? undefined };

  const member = useServerStore.getState().serverMembers.find(m => m.id === userId);
  if (member) return { id: userId, username: member.username, avatar: member.avatar ?? undefined };

  const dmChannels = useDmStore.getState().dmChannels;
  for (const ch of dmChannels) {
    if (ch.otherUser?.id === userId) {
      return { id: userId, username: ch.otherUser.username, avatar: ch.otherUser.avatar ?? undefined };
    }
    const groupUser = ch.otherUsers?.find(u => u.id === userId);
    if (groupUser) {
      return { id: userId, username: groupUser.username, avatar: groupUser.avatar ?? undefined };
    }
  }

  return { id: userId, username: userId.slice(0, 6) };
}

/**
 * Batch-resolve many user IDs in a single pass.
 * Builds one combined lookup Map from homeFriends, serverMembers, and
 * DM participants, then resolves all IDs against it — O(sources + ids)
 * instead of O(ids × sources).
 */
export function resolveViewers(userIds: string[]): ResolvedViewer[] {
  const lookup = new Map<string, ResolvedViewer>();

  for (const f of useSocialStore.getState().homeFriends) {
    lookup.set(f.id, { id: f.id, username: f.username, avatar: f.avatar ?? undefined });
  }
  for (const m of useServerStore.getState().serverMembers) {
    if (!lookup.has(m.id)) {
      lookup.set(m.id, { id: m.id, username: m.username, avatar: m.avatar ?? undefined });
    }
  }
  for (const dm of useDmStore.getState().dmChannels) {
    if (dm.otherUser && !lookup.has(dm.otherUser.id)) {
      lookup.set(dm.otherUser.id, {
        id: dm.otherUser.id,
        username: dm.otherUser.username,
        avatar: dm.otherUser.avatar ?? undefined,
      });
    }
    if (dm.otherUsers) {
      for (const u of dm.otherUsers) {
        if (!lookup.has(u.id)) {
          lookup.set(u.id, { id: u.id, username: u.username, avatar: u.avatar ?? undefined });
        }
      }
    }
  }

  return userIds.map((id) => lookup.get(id) ?? { id, username: id.slice(0, 6) });
}
