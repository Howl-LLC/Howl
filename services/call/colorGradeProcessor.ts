// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { TrackProcessor, ProcessorOptions, Track } from 'livekit-client';

type VideoProcessorOptions = ProcessorOptions<Track.Kind.Video>;

export const COLOR_GRADES = {
  none: 'none',
  warm: 'saturate(1.1) sepia(0.15) brightness(1.05)',
  cool: 'saturate(0.9) hue-rotate(10deg) brightness(1.05)',
  noir: 'grayscale(1) contrast(1.2) brightness(0.95)',
  vivid: 'saturate(1.4) contrast(1.08)',
  faded: 'saturate(0.6) brightness(1.1) contrast(0.9)',
} as const;

export type GradeId = keyof typeof COLOR_GRADES;

/** Check if canvas-based video processing is supported (Safari lacks captureStream). */
function supportsCanvasProcessing(): boolean {
  return typeof HTMLCanvasElement.prototype.captureStream === 'function'
    && typeof CanvasRenderingContext2D.prototype.filter !== 'undefined';
}

export function createColorGradeProcessor(initialGrade: GradeId): TrackProcessor<Track.Kind.Video, VideoProcessorOptions> & { setGrade(g: GradeId): void } {
  const state = { grade: initialGrade, running: false };
  let videoEl: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  // See autoFrameProcessor.ts for the rationale — rAF pauses on hidden tabs,
  // which freezes canvas.captureStream output, so fall back to setTimeout
  // while the tab is hidden.
  let timerId = 0;
  let onVisibility: (() => void) | null = null;
  let _processedTrack: MediaStreamTrack | undefined;
  let sourceTrack: MediaStreamTrack | null = null;
  const HIDDEN_FRAME_MS = 33;

  function onSourceEnded() {
    processor.destroy();
  }

  function cancelScheduled() {
    if (timerId) {
      cancelAnimationFrame(timerId);
      clearTimeout(timerId);
      timerId = 0;
    }
  }

  function scheduleNext() {
    cancelScheduled();
    if (!state.running) return;
    if (typeof document !== 'undefined' && document.hidden) {
      timerId = window.setTimeout(runFrame, HIDDEN_FRAME_MS) as unknown as number;
    } else {
      timerId = requestAnimationFrame(runFrame);
    }
  }

  function runFrame() {
    timerId = 0;
    if (!state.running) return;
    processLoop();
    scheduleNext();
  }

  function processLoop() {
    if (!state.running || !videoEl || !canvas || !ctx) return;
    const vw = videoEl.videoWidth;
    const vh = videoEl.videoHeight;
    if (vw === 0 || vh === 0) return;
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
    ctx.filter = COLOR_GRADES[state.grade] || 'none';
    ctx.drawImage(videoEl, 0, 0, vw, vh);
  }

  function cleanup() {
    state.running = false;
    cancelScheduled();
    if (onVisibility && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
      onVisibility = null;
    }
    if (sourceTrack) {
      sourceTrack.removeEventListener('ended', onSourceEnded);
      sourceTrack = null;
    }
    if (videoEl) { videoEl.srcObject = null; videoEl = null; }
    _processedTrack?.stop();
    _processedTrack = undefined;
    canvas = null;
    ctx = null;
  }

  const processor: TrackProcessor<Track.Kind.Video, VideoProcessorOptions> & { setGrade(g: GradeId): void } = {
    name: 'color-grade',
    get processedTrack() { return _processedTrack; },
    setGrade(g: GradeId) { state.grade = g; },

    async init(opts: VideoProcessorOptions) {
      // Clean up any previous state (handles reentrant init)
      cleanup();

      if (!supportsCanvasProcessing()) {
        throw new Error('Canvas video processing not supported in this browser');
      }

      sourceTrack = opts.track;
      sourceTrack.addEventListener('ended', onSourceEnded);

      videoEl = document.createElement('video');
      videoEl.srcObject = new MediaStream([opts.track]);
      videoEl.muted = true;
      videoEl.playsInline = true;
      try {
        await videoEl.play();
      } catch (err) {
        cleanup();
        throw err;
      }

      canvas = document.createElement('canvas');
      canvas.width = videoEl.videoWidth || 640;
      canvas.height = videoEl.videoHeight || 480;
      ctx = canvas.getContext('2d');
      if (!ctx) {
        cleanup();
        throw new Error('Failed to get canvas 2D context');
      }

      // captureStream(30) emits frames automatically. captureStream(0) requires
      // explicit requestFrame() calls per frame, which the processLoop() below
      // does not do — would produce a zero-frame (frozen) output track.
      const outputStream = canvas.captureStream(30);
      _processedTrack = outputStream.getVideoTracks()[0];
      if (!_processedTrack) {
        cleanup();
        throw new Error('Failed to capture video track from canvas');
      }

      state.running = true;
      if (typeof document !== 'undefined') {
        onVisibility = () => { if (state.running) scheduleNext(); };
        document.addEventListener('visibilitychange', onVisibility);
      }
      scheduleNext();
    },

    async restart(opts: VideoProcessorOptions) {
      cleanup();
      await this.init(opts);
    },

    async destroy() {
      cleanup();
    },
  };
  return processor;
}
