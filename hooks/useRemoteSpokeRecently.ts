// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useEffect, useRef } from 'react';
import { subscribeStreamAudioLevel } from './useAudioLevel';

const WINDOW_MS = 30_000;
const THRESHOLD = 0.06;

interface ParticipantWithStream {
  userId: string;
  stream: MediaStream | null;
}

/**
 * Returns true if any remote participant has produced audible audio
 * within the last 30 seconds.
 *
 * Subscribes via the shared AudioContext in useAudioLevel — never spawns
 * its own contexts (Chrome caps ~6 per page; with N participants we'd
 * trip the limit and starve the existing speaking-highlight UI).
 */
export function useRemoteSpokeRecently(
  participants: ParticipantWithStream[],
): boolean {
  const [spokeRecently, setSpokeRecently] = useState(false);
  const lastSpokeAtRef = useRef(0);

  useEffect(() => {
    if (participants.length === 0) {
      setSpokeRecently(false);
      return;
    }

    const cleanups: Array<() => void> = [];
    for (const p of participants) {
      if (!p.stream) continue;
      const cleanup = subscribeStreamAudioLevel(p.stream, (level) => {
        if (level > THRESHOLD) {
          lastSpokeAtRef.current = Date.now();
          setSpokeRecently(true);
        }
      });
      cleanups.push(cleanup);
    }

    const interval = setInterval(() => {
      if (Date.now() - lastSpokeAtRef.current >= WINDOW_MS) {
        setSpokeRecently(false);
      }
    }, 1000);

    return () => {
      for (const fn of cleanups) fn();
      clearInterval(interval);
    };
  }, [participants]);

  return spokeRecently;
}
