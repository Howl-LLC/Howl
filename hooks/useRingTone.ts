// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import { allSoundsDisabled, incomingRingEnabled } from '../utils/notificationSoundRef';

/**
 * Plays a looping ringtone from an audio file.
 * @param play     - start/stop playback
 * @param kind     - 'ring' (incoming, full volume) or 'ringback' (caller waiting, quieter)
 * @param suppress - when true, mutes all sound (e.g. DND mode)
 */
export function useRingTone(play: boolean, kind: 'ringback' | 'ring' = 'ring', suppress = false): void {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    // Respect user prefs: master "disable all sounds" and per-"incoming ring" toggle
    const muted = allSoundsDisabled.current || (kind === 'ring' && !incomingRingEnabled.current);
    if (!play || suppress || muted) {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.currentTime = 0;
        audioRef.current = null;
      }
      return;
    }

    const audio = new Audio('/sounds/ringtone.mp3');
    audio.loop = true;
    audio.volume = kind === 'ring' ? 0.6 : 0.3;
    audioRef.current = audio;
    audio.play().catch((err) => {
      console.warn('[ringtone] autoplay blocked by browser — user gesture required before audio can play', err);
    });

    return () => {
      audio.pause();
      audio.currentTime = 0;
      audioRef.current = null;
    };
  }, [play, kind, suppress]);
}
