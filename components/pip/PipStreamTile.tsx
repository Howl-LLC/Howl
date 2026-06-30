// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef, useState } from 'react';
import { PipWatchPlaceholder } from './PipWatchPlaceholder';

interface Props {
  stream: MediaStream | null;
  /** True when the user hasn't subscribed yet; render the Watch placeholder. */
  awaitingWatch?: boolean;
  isSelf?: boolean;
  presenterAvatar?: string;
  presenterName: string;
  onWatch?: () => void;
}

/** Renders the video element. Two display modes:
 *  - Watch placeholder (unsubscribed remote screenshare).
 *  - Live stream — always mounted; pauses/resumes on tab visibility so the
 *    last decoded frame stays on screen instead of going black on return.
 *    For self streams, an overlay badge shows "You (paused)" when hidden.
 */
export const PipStreamTile = React.memo(({
  stream, awaitingWatch, isSelf, presenterAvatar, presenterName, onWatch,
}: Props) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [windowHidden, setWindowHidden] = useState(
    typeof document !== 'undefined' && document.visibilityState === 'hidden',
  );

  // Track document visibility for the self-paused overlay AND drive
  // pause/resume on the video element itself. Pausing keeps the last
  // decoded frame on screen — Discord-style — instead of going black.
  useEffect(() => {
    const onVis = () => {
      const hidden = document.visibilityState === 'hidden';
      setWindowHidden(hidden);
      const el = videoRef.current;
      if (!el) return;
      if (hidden) {
        // Best-effort pause. If the browser already paused us due to
        // backgrounding, this is a no-op.
        try { el.pause(); } catch { /* element detached */ }
      } else {
        // Resume from the current live stream. play() may reject if the
        // user agent blocks autoplay — swallow it; the video element
        // will catch up on the next user interaction.
        el.play().catch(() => { /* autoplay blocked — best effort */ });
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Attach MediaStream to the video element.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (el.srcObject !== stream) {
      el.srcObject = stream;
    }
    if (stream) el.play().catch(() => { /* autoplay blocked — best effort */ });
    return () => {
      // Clear srcObject on unmount / stream change to promptly release tracks.
      if (el) el.srcObject = null;
    };
  }, [stream]);

  // Mode 1: Watch placeholder (unsubscribed screenshare).
  if (awaitingWatch && onWatch) {
    return (
      <PipWatchPlaceholder
        presenterAvatar={presenterAvatar}
        presenterName={presenterName}
        onWatch={onWatch}
      />
    );
  }

  // Mode 2: Live stream.
  //
  // Attribute tuning for hot-path playback:
  //   - decoding="async" keeps frame decode off the main thread so the PIP
  //     never blocks the app when a new track is attached.
  //   - disablePictureInPicture disables the browser's system-level PiP on
  //     this element — we have our own in-app PIP and the OS PiP would
  //     double-float on top.
  //   - preload="auto" hints the browser to start decode as soon as the
  //     srcObject is set (default for MediaStream, explicit for clarity).
  //
  // The video element stays mounted across visibility changes — pause/resume
  // is handled in the visibility effect above. This means tabbing away and
  // back leaves the last decoded frame on screen instead of remounting and
  // showing black until the next keyframe arrives.
  return (
    <div className="relative w-full h-full">
      <video
        ref={videoRef}
        playsInline
        muted={isSelf}
        disablePictureInPicture
        preload="auto"
        // @ts-expect-error - `decoding` is valid HTML but the React types
        // only list it on `<img>`. Browsers accept it on <video> too.
        decoding="async"
        className="w-full h-full object-contain bg-black"
      />
      {/* Self-paused indicator. Overlays the (paused) video instead of
          replacing it, so the user sees their own last frame faded
          underneath the badge — matches the Discord behavior of "your
          stream is paused while this tab is hidden". */}
      {isSelf && windowHidden && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/55 backdrop-blur-sm pointer-events-none">
          {presenterAvatar ? (
            <img src={presenterAvatar} alt="" className="w-10 h-10 rounded-[var(--radius-lg)] opacity-90" />
          ) : (
            <div className="w-10 h-10 rounded-[var(--radius-lg)] bg-white/20" />
          )}
          <div className="text-white/90 text-[11px] font-medium">You (paused)</div>
        </div>
      )}
    </div>
  );
}, (prev, next) => {
  // Custom prop comparator — the default React.memo shallow compare already
  // works here, but being explicit prevents subtle regressions if an object
  // prop gets added later. Comparing by value for primitives + identity for
  // MediaStream (new MediaStream = re-render) covers every legitimate re-render.
  return (
    prev.stream === next.stream &&
    prev.awaitingWatch === next.awaitingWatch &&
    prev.isSelf === next.isSelf &&
    prev.presenterAvatar === next.presenterAvatar &&
    prev.presenterName === next.presenterName &&
    prev.onWatch === next.onWatch
  );
});

PipStreamTile.displayName = 'PipStreamTile';
