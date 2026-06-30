// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { resolveMessageAuthor } from '../utils/messageAuthor';

/**
 * In a 1:1 DM the users map holds ONLY the peer (the current user is never added
 * to it). An own message's authorId is the current user, so resolving via
 * `usersById.get(authorId) ?? users[0]` falls through to `users[0]` = the peer,
 * rendering own messages with the RECIPIENT's name/avatar. Server-sent messages
 * carry denormalized author fields that mask this, but OTR / optimistic messages
 * don't — so an own OTR message appears as if sent by the person you're sending
 * it to. resolveMessageAuthor must resolve own messages to currentUser.
 */
const me = { id: 'me', username: 'me' };
const peer = { id: 'u1', username: 'alice' };

describe('resolveMessageAuthor', () => {
  it('returns the mapped user when the author is in the map', () => {
    const byId = new Map([[peer.id, peer]]);
    expect(resolveMessageAuthor(byId, [peer], peer.id, me, 'me')).toBe(peer);
  });

  it('resolves an own message to currentUser even when the map omits self (1:1 DM)', () => {
    const byId = new Map([[peer.id, peer]]); // DM map excludes the current user
    // Pre-fix this returned `peer` (the bug); must be `me`.
    expect(resolveMessageAuthor(byId, [peer], 'me', me, 'me')).toBe(me);
  });

  it('falls back to users[0] for an unknown, non-own author', () => {
    const byId = new Map([[peer.id, peer]]);
    expect(resolveMessageAuthor(byId, [peer], 'ghost', me, 'me')).toBe(peer);
  });

  it('falls back to users[0] for an own message when currentUser is null', () => {
    const byId = new Map([[peer.id, peer]]);
    expect(resolveMessageAuthor(byId, [peer], 'me', null, 'me')).toBe(peer);
  });
});
