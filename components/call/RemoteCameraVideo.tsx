// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';

/** Displays a remote participant's camera stream with ready-state detection and opacity transition. */
export const RemoteCameraVideo = React.memo(({ stream, className }: { stream: MediaStream; className?: string }) => {
  const { t } = useTranslation();
  const ref = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  // Track the last assigned stream to avoid redundant srcObject assignments
  // that cause brief video flicker during participant list changes.
  const lastStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const video = ref.current;
    if (video && stream) {
      // Only reassign srcObject when the stream identity actually changes.
      // Reassigning the same stream causes browsers to reinitialize the
      // video pipeline, producing a brief black frame / flicker.
      if (lastStreamRef.current !== stream) {
        video.srcObject = stream;
        lastStreamRef.current = stream;
      }
      video.play().catch(() => {});
    }
    const track = stream.getVideoTracks()[0];
    const onReady = () => setReady(true);
    const onUnmute = () => { if (ref.current) ref.current.play().catch(() => {}); setReady(true); };
    if (track) {
      track.addEventListener('unmute', onUnmute);
      if (track.readyState === 'live' && !track.muted) setReady(true);
    }
    const readyTimer = setTimeout(onReady, 1200);
    return () => { clearTimeout(readyTimer); if (track) track.removeEventListener('unmute', onUnmute); };
  }, [stream]);

  // Stable ref callback — only assigns srcObject on mount or when stream
  // identity changes. Avoids the per-render reassign that inline ref
  // callbacks cause (React calls them with null then el on every render
  // when the function identity changes).
  const setRef = useCallback((el: HTMLVideoElement | null) => {
    ref.current = el;
    if (el && stream && lastStreamRef.current !== stream) {
      el.srcObject = stream;
      lastStreamRef.current = stream;
      el.play().catch(() => {});
    }
  }, [stream]);

  return (
    <>
      <video
        ref={setRef}
        autoPlay playsInline
        className={className ?? 'absolute inset-0 w-full h-full object-cover'}
        style={{ opacity: ready ? 1 : 0, transition: 'opacity 0.2s ease-out' }}
        onLoadedData={() => setReady(true)}
        onCanPlay={() => setReady(true)}
      />
      {!ready && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <span className="text-white/40 text-xs">{t('common.loading')}</span>
        </div>
      )}
    </>
  );
});
