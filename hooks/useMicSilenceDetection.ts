// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef, useCallback } from 'react';

export type MicSilenceState = 'none' | 'icon' | 'banner';

interface UseMicSilenceDetectionArgs {
  /** Consecutive silence duration in ms from the engine (updated ~1 Hz). */
  silenceMs: number;
  /** Whether the local user's mic is muted in Howl's UI. */
  isMuted: boolean;
  /** Whether the local user is deafened. */
  isDeafened: boolean;
  /** Number of remote participants currently in the room. */
  remoteParticipantCount: number;
  /** Whether any remote participant has spoken within the last 30 seconds. */
  remoteSpokeRecently: boolean;
  /** User preference: false disables both stages. */
  enabled: boolean;
  /** Epoch ms when the local mic was published, used for the 5s grace period. */
  micPublishedAt: number | null;
}

interface UseMicSilenceDetectionResult {
  state: MicSilenceState;
  dismiss: () => void;
}

const ICON_THRESHOLD_MS = 10_000;
const BANNER_THRESHOLD_MS = 30_000;
const GRACE_PERIOD_MS = 5_000;

export function useMicSilenceDetection({
  silenceMs,
  isMuted,
  isDeafened,
  remoteParticipantCount,
  remoteSpokeRecently,
  enabled,
  micPublishedAt,
}: UseMicSilenceDetectionArgs): UseMicSilenceDetectionResult {
  const [dismissedThisSession, setDismissedThisSession] = useState(false);
  const prevMutedRef = useRef(isMuted);

  // Reset dismiss state when user mutes — unmuting later can re-trigger
  useEffect(() => {
    if (isMuted && !prevMutedRef.current) {
      setDismissedThisSession(false);
    }
    prevMutedRef.current = isMuted;
  }, [isMuted]);

  const dismiss = useCallback(() => {
    setDismissedThisSession(true);
  }, []);

  // Derive the current state from inputs (no async, no timers — pure derivation)
  let state: MicSilenceState = 'none';

  if (!enabled) return { state: 'none', dismiss };

  // Suppression: user is muted, deafened, or alone
  if (isMuted || isDeafened || remoteParticipantCount === 0) {
    return { state: 'none', dismiss };
  }

  // Suppression: within 5s grace period after mic publish
  if (micPublishedAt !== null && Date.now() - micPublishedAt < GRACE_PERIOD_MS) {
    return { state: 'none', dismiss };
  }

  if (silenceMs >= BANNER_THRESHOLD_MS && remoteSpokeRecently && !dismissedThisSession) {
    state = 'banner';
  } else if (silenceMs >= ICON_THRESHOLD_MS) {
    state = 'icon';
  }

  return { state, dismiss };
}
