// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * the shared channel-content read gate applied by
 * search / threads / polls / forum / forumTags / stages. These are pure-function
 * unit tests over `assertChannelVisible` / `assertChannelReadable`; the live
 * per-route 404/403 matrix is exercised by the prodlike authz-regression harness.
 *
 * Locks the landmines the map surfaced:
 *  - THE requireOverride LANDMINE: on a private channel the @everyone server
 *    baseline granting viewChannels must NOT admit a member with no override.
 *    This is the single most likely way the fix ships as a silent no-op.
 *  - the private half returns 404 (existence must not leak); the
 *    readMessageHistory half returns 403 (mirrors routes/messages.ts:703-708).
 *  - assertChannelVisible (write paths) omits readMessageHistory, matching the
 *    send/react handlers (messages.ts:957-963 / :1253-1256); a public channel
 *    that denies readMessageHistory is still VISIBLE (writable) but not READABLE.
 *  - owner and administrator bypass; null context fails closed.
 */
import { describe, it, expect } from 'vitest';
import {
  assertChannelVisible,
  assertChannelReadable,
} from '../src/utils/permissions.js';
import type { PermissionContext, PermissionOverride, RoleLike } from '../src/utils/permissions.js';

const EVERYONE_ID = 'everyone-role-id';
const STAFF_ID = 'staff-role-id';

const everyoneRole: RoleLike = {
  id: EVERYONE_ID,
  position: 0,
  permissions: { viewChannels: true, readMessageHistory: true, sendMessages: true },
  isEveryone: true,
};

/** A no-role member: only the @everyone baseline applies. */
const memberCtx: PermissionContext = {
  member: { userId: 'member-user', role: 'member' },
  roles: [],
  everyoneRole,
};

/** A member holding the Staff role (used with per-channel Staff overrides). */
const staffCtx: PermissionContext = {
  member: { userId: 'staff-user', role: 'member' },
  roles: [{ id: STAFF_ID, position: 1, permissions: {}, isEveryone: false }],
  everyoneRole,
};

const ownerCtx: PermissionContext = {
  member: { userId: 'owner-user', role: 'owner' },
  roles: [],
  everyoneRole,
};

const adminCtx: PermissionContext = {
  member: { userId: 'admin-user', role: 'member' },
  roles: [{ id: 'admin-role', position: 1, permissions: { administrator: true }, isEveryone: false }],
  everyoneRole,
};

const publicChannel = { isPrivate: false };
const privateChannel = { isPrivate: true };

const staffViewGrant: PermissionOverride = {
  targetType: 'role',
  targetId: STAFF_ID,
  permissions: { viewChannels: true, readMessageHistory: true },
};
const staffViewOnlyGrant: PermissionOverride = {
  targetType: 'role',
  targetId: STAFF_ID,
  permissions: { viewChannels: true },
};
const everyoneReadDeny: PermissionOverride = {
  targetType: 'role',
  targetId: EVERYONE_ID,
  permissions: { readMessageHistory: false },
};

describe('assertChannelReadable / assertChannelVisible', () => {
  it('public channel, plain member: readable and visible', () => {
    expect(assertChannelVisible(memberCtx, publicChannel, [], [])).toEqual({ ok: true });
    expect(assertChannelReadable(memberCtx, publicChannel, [], [])).toEqual({ ok: true });
  });

  it('THE requireOverride landmine: private channel + @everyone baseline viewChannels does NOT admit a member with no override', () => {
    // everyoneRole grants viewChannels server-wide; without requireOverride this
    // would pass and the gate would be a silent no-op.
    expect(assertChannelVisible(memberCtx, privateChannel, [], [])).toEqual({
      ok: false,
      status: 404,
      error: 'Channel not found',
    });
    expect(assertChannelReadable(memberCtx, privateChannel, [], [])).toEqual({
      ok: false,
      status: 404,
      error: 'Channel not found',
    });
  });

  it('private channel: a member holding an explicit viewChannels override passes', () => {
    expect(assertChannelVisible(staffCtx, privateChannel, [staffViewGrant], [])).toEqual({ ok: true });
    expect(assertChannelReadable(staffCtx, privateChannel, [staffViewGrant], [])).toEqual({ ok: true });
  });

  it('private channel: the SAME override does NOT admit a member without the Staff role', () => {
    expect(assertChannelVisible(memberCtx, privateChannel, [staffViewGrant], [])).toEqual({
      ok: false,
      status: 404,
      error: 'Channel not found',
    });
  });

  it('write-vs-read split: public channel with @everyone readMessageHistory denied is VISIBLE but not READABLE', () => {
    // Mirrors the `denied-text` fixture. A write path (assertChannelVisible)
    // proceeds; a read path (assertChannelReadable) returns 403.
    expect(assertChannelVisible(memberCtx, publicChannel, [everyoneReadDeny], [])).toEqual({ ok: true });
    expect(assertChannelReadable(memberCtx, publicChannel, [everyoneReadDeny], [])).toEqual({
      ok: false,
      status: 403,
      error: 'You do not have permission to read message history in this server.',
    });
  });

  it('private channel: visible via override but readMessageHistory denied → 403 (visible half still passes)', () => {
    const overrides = [staffViewOnlyGrant, everyoneReadDeny];
    expect(assertChannelVisible(staffCtx, privateChannel, overrides, [])).toEqual({ ok: true });
    expect(assertChannelReadable(staffCtx, privateChannel, overrides, [])).toEqual({
      ok: false,
      status: 403,
      error: 'You do not have permission to read message history in this server.',
    });
  });

  it('category-tier viewChannels override admits a member (override chain walks category)', () => {
    const catGrant: PermissionOverride = {
      targetType: 'role',
      targetId: STAFF_ID,
      permissions: { viewChannels: true, readMessageHistory: true },
    };
    expect(assertChannelReadable(staffCtx, privateChannel, [], [catGrant])).toEqual({ ok: true });
  });

  it('owner bypass: readable on a private channel with no overrides', () => {
    expect(assertChannelVisible(ownerCtx, privateChannel, [], [])).toEqual({ ok: true });
    expect(assertChannelReadable(ownerCtx, privateChannel, [], [])).toEqual({ ok: true });
  });

  it('administrator bypass: readable on a private channel with no overrides', () => {
    expect(assertChannelReadable(adminCtx, privateChannel, [], [])).toEqual({ ok: true });
  });

  it('null / undefined context fails closed', () => {
    expect(assertChannelVisible(null, privateChannel, [], [])).toEqual({
      ok: false,
      status: 404,
      error: 'Channel not found',
    });
    // Public channel is visible even for a null ctx, but not readable.
    expect(assertChannelReadable(null, publicChannel, [], [])).toEqual({
      ok: false,
      status: 403,
      error: 'You do not have permission to read message history in this server.',
    });
    expect(assertChannelReadable(undefined, privateChannel, [], [])).toEqual({
      ok: false,
      status: 404,
      error: 'Channel not found',
    });
  });
});
