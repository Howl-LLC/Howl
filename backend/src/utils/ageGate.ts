// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-channel age-gate enforcement.
 *
 * A channel is age-gated when its own `ageRestricted` flag is set. The
 * server is the source of truth: the user's `dateOfBirth` is consulted
 * directly, never client-supplied. DM channels are out of scope —
 * their content is E2E-encrypted and the server must not inspect it.
 *
 * Forward-only: existing minor members are NOT retroactively removed
 * from age-gated channels. The gate runs at the next read/send/join
 * touch. The matching server-side socket eviction lives in the channel
 * PATCH handler (`routes/servers.ts`) and fires when ageRestricted is
 * flipped from false → true so that already-connected minors lose the
 * `channel:${id}` room subscription.
 */

import { prisma } from '../db.js';
import { isUnderEighteen } from './discoveryFilters.js';

export type ChannelAgeGateInfo = {
  ageRestricted: boolean;
};

export const AGE_GATE_RESPONSE = {
  error: 'age_restricted' as const,
  message:
    'This channel is age-restricted. You must be 18 or older with your date of birth on file to access it.',
};

export function channelRequiresAgeGate(channel: ChannelAgeGateInfo): boolean {
  return channel.ageRestricted;
}

/**
 * Returns the 403 body the caller should send, or null when the user
 * may proceed. Issues one Prisma query per call; for batched filtering
 * (auto-subscribe, search, mentions fan-out) prefer `loadIsMinor` +
 * `applyAgeGate`.
 */
export async function denyIfAgeGated(
  channel: ChannelAgeGateInfo,
  userId: string,
): Promise<typeof AGE_GATE_RESPONSE | null> {
  if (!channelRequiresAgeGate(channel)) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dateOfBirth: true },
  });
  if (!user || isUnderEighteen(user.dateOfBirth)) return AGE_GATE_RESPONSE;
  return null;
}

/**
 * Single Prisma round trip variant for batch flows that have already
 * loaded the user — pass the `dateOfBirth` directly.
 */
export function applyAgeGate(
  channel: ChannelAgeGateInfo,
  isMinor: boolean,
): typeof AGE_GATE_RESPONSE | null {
  if (!channelRequiresAgeGate(channel)) return null;
  return isMinor ? AGE_GATE_RESPONSE : null;
}

/** Convenience wrapper: fetches the user's DOB and returns true when
 *  they are under 18 (or missing DOB — fail-closed per discovery
 *  filter convention). */
export async function loadIsMinor(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { dateOfBirth: true },
  });
  return !user || isUnderEighteen(user.dateOfBirth);
}
