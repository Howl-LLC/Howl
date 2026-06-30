// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect } from 'react';
import { useVoiceStore } from '../../stores/voiceStore';
import { type BoostEntry, cleanupBoost, applyVolume } from '../../utils/audioBoost';
import { ViewerIndicator } from './ViewerIndicator';
import { ViewerAvatarStack } from './ViewerAvatarStack';
import type { StreamContext } from '../../stores/types';

interface ScreenShareCardProps {
  stream: MediaStream;
  /** Screen share audio stream (separate from the video stream). */
  screenShareAudioStream?: MediaStream | null;
  /** userId of the remote participant sharing their screen. Required for volume persistence. */
  userId?: string;
  /** @deprecated No longer used — volume controls moved into the card's
   *  footer via `ScreenShareVolumeControls`. Kept so existing callers compile. */
  username?: string;
  /** Whether the current user is deafened (mutes all audio). */
  isDeafened?: boolean;
  /** Global speaker volume multiplier (0-1, from settings). */
  speakerVolume?: number;
  /** Target speaker device ID for setSinkId. */
  speakerId?: string;
  /** Viewer tracking context; required to render the viewer indicator. */
  streamContext?: StreamContext;
  /** Current user ID, used to exclude self from the viewer count. */
  selfUserId?: string;
}

/** Inline screen share card: renders a remote screen share stream inside a
 *  participant-like card. Volume/mute controls are rendered separately by the
 *  parent in the card's footer (see `ScreenShareVolumeControls`) so they
 *  don't overlay the video. */
export const ScreenShareCard = React.memo(({
  stream,
  screenShareAudioStream,
  userId,
  isDeafened = false,
  speakerVolume = 1,
  speakerId,
  streamContext,
  selfUserId,
}: ScreenShareCardProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const boosts = useRef<Map<string, BoostEntry>>(new Map());
  const [ready, setReady] = useState(false);

  const screenShareVolumes = useVoiceStore(s => s.screenShareVolumes);

  const hasAudio = !!(screenShareAudioStream && screenShareAudioStream.getAudioTracks().length > 0);
  const volumeKey = userId ?? 'unknown';
  const currentVolume = screenShareVolumes[volumeKey] ?? 0.5;

  // Video setup
  // Track the last assigned stream to avoid redundant srcObject assignments
  const lastScreenStreamRef = useRef<MediaStream | null>(null);
  useEffect(() => {
    const el = videoRef.current;
    if (!el || !stream) return;
    // Only reassign srcObject when stream identity actually changes
    if (lastScreenStreamRef.current !== stream) {
      setReady(false);
      el.srcObject = stream;
      lastScreenStreamRef.current = stream;
    }
    el.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const onReady = () => setReady(true);
    const onUnmute = () => { el.play().catch(() => {}); setReady(true); };
    if (track) {
      track.addEventListener('unmute', onUnmute);
      if (track.readyState === 'live' && !track.muted) onReady();
    }
    const t1 = setTimeout(onReady, 800);
    const t2 = setTimeout(onReady, 2500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
      if (track) track.removeEventListener('unmute', onUnmute);
    };
  }, [stream]);

  // Screen share audio playback + volume control
  useEffect(() => {
    const el = audioRef.current;
    if (!el || !hasAudio || !screenShareAudioStream) return;

    if (isDeafened) {
      el.muted = true;
      el.volume = 0;
      const existing = boosts.current.get(volumeKey);
      if (existing) { cleanupBoost(existing); boosts.current.delete(volumeKey); }
      return;
    }

    const vol = currentVolume * speakerVolume;
    applyVolume(el, boosts.current, volumeKey, screenShareAudioStream, vol, speakerId);

    if (el.paused) {
      el.play().catch(() => {});
    }
  }, [screenShareAudioStream, hasAudio, currentVolume, isDeafened, speakerVolume, speakerId, volumeKey]);

  // Cleanup boosts on unmount
  useEffect(() => () => {
    boosts.current.forEach((e) => cleanupBoost(e));
    boosts.current.clear();
  }, []);

  return (
    <>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        className="absolute inset-0 w-full h-full object-contain"
        style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.2s ease-out' }}
        onLoadedData={() => setReady(true)}
        onCanPlay={() => setReady(true)}
        onPlaying={() => setReady(true)}
      />
      {hasAudio && (
        <audio
          ref={audioRef}
          autoPlay
          playsInline
          className="sr-only"
        />
      )}
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center text-emerald-400/80 text-xs font-bold uppercase tracking-wider">
          Loading…
        </div>
      )}
      {streamContext && userId && (
        <>
          <div className="absolute top-2 right-2 z-10 pointer-events-auto">
            <ViewerIndicator context={streamContext} ownerId={userId} selfUserId={selfUserId} />
          </div>
          <div className="absolute bottom-2 left-2 z-10 pointer-events-auto">
            <ViewerAvatarStack context={streamContext} ownerId={userId} selfUserId={selfUserId} />
          </div>
        </>
      )}
    </>
  );
});
