// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useEffect, useLayoutEffect } from 'react';
import { type BoostEntry, cleanupBoost, applyVolume } from '../utils/audioBoost';

export interface VoiceParticipantForAudio {
  userId: string;
  stream: MediaStream | null;
}

/**
 * Renders hidden <audio> elements for remote voice participants.
 * Audio keeps playing when the user navigates to a text channel.
 * Uses native <audio> playback (reliable in Chrome) with optional
 * Web Audio boost for volumes above 100%.
 */
export const VoiceRemoteAudio: React.FC<{
  participants: VoiceParticipantForAudio[];
  participantVolumes?: Record<string, number>;
  isDeafened?: boolean;
  speakerVolume?: number;
  speakerId?: string;
}> = ({ participants, participantVolumes = {}, isDeafened = false, speakerVolume = 1, speakerId }) => {
  const refs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const boosts = useRef<Map<string, BoostEntry>>(new Map());

  useEffect(() => () => {
    boosts.current.forEach((e) => cleanupBoost(e));
    boosts.current.clear();
  }, []);

  useEffect(() => {
    const activeIds = new Set(participants.map((p) => p.userId));
    boosts.current.forEach((e, uid) => {
      if (!activeIds.has(uid)) { cleanupBoost(e); boosts.current.delete(uid); }
    });

    const timeouts: ReturnType<typeof setTimeout>[] = [];
    participants.forEach((p) => {
      const el = refs.current.get(p.userId);
      if (!el) return;

      if (isDeafened) {
        el.muted = true;
        el.volume = 0;
        const existing = boosts.current.get(p.userId);
        if (existing) { cleanupBoost(existing); boosts.current.delete(p.userId); }
        return;
      }

      const vol = (participantVolumes[p.userId] ?? 0.5) * speakerVolume;
      applyVolume(el, boosts.current, p.userId, p.stream, vol, speakerId);

      if (p.stream && p.stream.getAudioTracks().length > 0 && el.paused) {
        el.play().catch(() => {});
        timeouts.push(setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 200));
        timeouts.push(setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 1000));
        timeouts.push(setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 3000));
      }
    });
    return () => timeouts.forEach((t) => clearTimeout(t));
  }, [participants, participantVolumes, isDeafened, speakerVolume, speakerId]);

  useLayoutEffect(() => {
    if (!isDeafened) return;
    refs.current.forEach((el) => { el.muted = true; el.volume = 0; });
    boosts.current.forEach((e) => { e.gain.gain.value = 0; });
  }, [isDeafened]);

  return (
    <div className="sr-only" aria-hidden>
      {participants.map((p) => (
        <audio
          key={p.userId}
          ref={(el) => {
            if (el) refs.current.set(p.userId, el);
            else refs.current.delete(p.userId);
          }}
          autoPlay
          playsInline
        />
      ))}
    </div>
  );
};
