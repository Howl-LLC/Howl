// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Resolve the display author (name/avatar source) for a message in the chat list.
 *
 * In a 1:1 DM the users map is built from `[headerUser]` (the peer only) — the
 * current user is never added. So an own message, whose `authorId` is the current
 * user, misses the map and the previous `?? users[0]` fallback resolved it to the
 * PEER, rendering your own message with the recipient's name and avatar. Durable
 * (server-sent) messages carry denormalized `authorUsername`/`authorAvatar` that
 * happen to mask this, but OTR and optimistic messages don't set those fields, so
 * an own OTR message appeared as if sent by the account you're sending it to.
 *
 * Fix: resolve an own message to `currentUser` before the `users[0]` fallback.
 * Server channels are unaffected (their users map already contains the member).
 */
export function resolveMessageAuthor<T extends { id: string }>(
  usersById: Map<string, T>,
  users: T[],
  authorId: string,
  currentUser: T | null,
  currentUserId: string,
): T | undefined {
  const mapped = usersById.get(authorId);
  if (mapped) return mapped;
  if (authorId === currentUserId && currentUser) return currentUser;
  return users[0];
}
