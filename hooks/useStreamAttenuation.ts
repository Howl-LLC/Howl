// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';

const ATTENUATION_TARGETS = new Set<HTMLAudioElement | HTMLVideoElement>();

/** Register an audio/video element for stream attenuation. Returns cleanup function. */
export function registerAttenuationTarget(el: HTMLAudioElement | HTMLVideoElement): () => void {
  ATTENUATION_TARGETS.add(el);
  return () => { ATTENUATION_TARGETS.delete(el); };
}

/**
 * Attenuates registered audio elements (notification sounds, soundboard, etc.)
 * when the user is in a voice channel.
 */
export function useStreamAttenuation(
  enabled: boolean,
  strength: number,
  isInVoice: boolean,
) {
  const prevVolumes = useRef(new Map<HTMLAudioElement | HTMLVideoElement, number>());

  useEffect(() => {
    if (!enabled || !isInVoice) {
      // Restore original volumes
      for (const [el, vol] of prevVolumes.current) {
        try { el.volume = vol; } catch { /* element may be detached */ }
      }
      prevVolumes.current.clear();
      return;
    }

    const multiplier = 1 - (strength / 100);
    for (const el of ATTENUATION_TARGETS) {
      if (!prevVolumes.current.has(el)) prevVolumes.current.set(el, el.volume);
      try { el.volume = (prevVolumes.current.get(el) ?? 1) * multiplier; } catch { /* element may be detached */ }
    }
  }, [enabled, strength, isInVoice]);
}
