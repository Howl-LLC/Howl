// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export type RecoverabilityState = 'private' | 'recoverable-self' | 'recoverable-peer';

/**
 * Map the server-derived serverReadable boolean + the local user's own custody
 * to a UI state. Returns null when serverReadable is unknown (hide the chip).
 */
export function resolveRecoverabilityState(
  serverReadable: boolean | undefined,
  myPasswordDerived: boolean,
): RecoverabilityState | null {
  if (serverReadable === undefined) return null;
  if (serverReadable === false) return 'private';
  return myPasswordDerived ? 'recoverable-self' : 'recoverable-peer';
}
