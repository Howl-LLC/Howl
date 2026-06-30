// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { TrackProcessor, ProcessorOptions, Track } from 'livekit-client';
import type { AutoFrameMode } from '../../utils/settingsStorage';

type VideoProcessorOptions = ProcessorOptions<Track.Kind.Video>;

/**
 * Per-mode tuning for face tracking.
 *
 * MEDIUM matches the legacy on/off behavior — responsive enough for casual
 * calls but a touch steppy on fast head movement because the position lerp
 * is relatively aggressive (0.15/frame) and detection only runs every 2nd
 * frame (~30Hz).
 *
 * HIGH trades CPU for silky motion: detection every frame (~60Hz) and a
 * spring-damper that keeps a velocity term, so the crop glides rather than
 * snapping toward each target. Deadzone is slightly wider to absorb micro-
 * jitter that the faster detection loop would otherwise surface.
 */
const AUTO_FRAME_TUNING = {
  medium: { lerp: 0.15, detectEvery: 2, deadZone: 0.02, spring: 0, friction: 0 },
  high:   { lerp: 0.06, detectEvery: 1, deadZone: 0.04, spring: 0.22, friction: 0.78 },
} as const;

/** Auto-zoom: face should occupy ~this fraction of the frame width. */
const IDEAL_FACE_FRACTION = 0.3;
/** How fast zoom drifts toward the target when autoZoom is on. Slower than
 *  position lerp because zoom "twitching" is more perceptible than pan. */
const AUTO_ZOOM_LERP = 0.08;
const AUTO_ZOOM_MIN = 1.0;
const AUTO_ZOOM_MAX = 2.5;

let detector: any = null;
let detectorPromise: Promise<void> | null = null;
let detectorGPU: boolean | null = null;

async function ensureDetector(useGPU: boolean): Promise<void> {
  // Recreate if delegate changed
  if (detector && detectorGPU !== useGPU) {
    destroyDetector();
  }
  if (detector) return;
  if (!detectorPromise) {
    detectorGPU = useGPU;
    detectorPromise = (async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision');
        // WASM + model bundled locally under public/mediapipe/ so autoframe
        // works in Electron offline and avoids 3rd-party CDN dependency.
        //
        // FaceLandmarker (478-point 3D landmarks, ~3.7MB) replaces the
        // legacy FaceDetector (bbox-only, ~230KB). The upgrade gives us
        // landmark-accurate centering (oval-based bbox instead of the
        // jitter-prone device-level detection bbox) and future room for
        // head-pose / gaze features. Blendshapes + transform matrices are
        // disabled — we only need the raw landmarks.
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
          `${import.meta.env.BASE_URL}mediapipe/wasm`
        );
        detector = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: `${import.meta.env.BASE_URL}mediapipe/models/face_landmarker.task`,
            delegate: useGPU ? 'GPU' : 'CPU',
          },
          runningMode: 'VIDEO',
          numFaces: 1,
          outputFaceBlendshapes: false,
          outputFacialTransformationMatrixes: false,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.5,
          minTrackingConfidence: 0.5,
        });
      } catch (err) {
        // Reset cached state so the next enable can retry cleanly.
        // Without this, a single failure (e.g. offline WASM load) would
        // leave a rejected promise cached, poisoning every subsequent call.
        detectorPromise = null;
        detectorGPU = null;
        detector = null;
        throw err;
      }
    })();
  }
  await detectorPromise;
}

/** Clean up the MediaPipe detector to free WASM/GPU memory. */
export function destroyDetector(): void {
  if (detector) {
    try { detector.close(); } catch { /* already closed */ }
    detector = null;
    detectorPromise = null;
    detectorGPU = null;
  }
}

/** Check if auto-framing is supported without loading the model. */
export function checkAutoFrameSupport(): boolean {
  return typeof HTMLCanvasElement.prototype.captureStream === 'function';
}

export function createAutoFrameProcessor(
  initialZoom: number,
  initialFilter?: string,
  initialMode: AutoFrameMode = 'medium',
  initialZoomAuto: boolean = false,
): TrackProcessor<Track.Kind.Video, VideoProcessorOptions> & {
  setZoom(z: number): void;
  setFilter(f: string): void;
  setMode(m: AutoFrameMode): void;
  setZoomAuto(auto: boolean): void;
} {
  const state = {
    zoom: initialZoom,
    zoomAuto: initialZoomAuto,
    filter: initialFilter || 'none',
    mode: initialMode,
    running: false,
  };
  let videoEl: HTMLVideoElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  // Unified timer handle. Holds either a requestAnimationFrame ID (when the
  // tab is visible) or a setTimeout ID (when hidden). rAF is paused by the
  // browser on hidden tabs, which freezes canvas.captureStream output —
  // falling back to setTimeout keeps the canvas redrawing so the outgoing
  // track doesn't stick on the last frame. Both cancel fns tolerate unknown
  // IDs, so issuing both on cleanup is safe.
  let timerId = 0;
  let onVisibility: (() => void) | null = null;
  let _processedTrack: MediaStreamTrack | undefined;
  let sourceTrack: MediaStreamTrack | null = null;
  let smoothX = 0.5, smoothY = 0.5;
  let lastTargetX = 0.5, lastTargetY = 0.5;
  // Velocity terms for the 'high' spring-damper path. Unused in 'medium'.
  let velX = 0, velY = 0;
  // Auto-zoom smoothing state. Target zoom is derived each detection from
  // bbox width; smoothZoom lerps toward it so changes don't pop.
  let smoothZoom = initialZoom;
  let targetZoom = initialZoom;
  let frameCount = 0;
  let consecutiveErrors = 0;
  const HIDDEN_FRAME_MS = 33; // ~30fps pacing when the tab is hidden

  function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

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
    const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
    if (!vw || !vh) return;
    if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }

    // Per-mode tuning. Fall back to medium if somehow 'off' is reached —
    // the enable gate upstream should already have bypassed us entirely,
    // but we keep rendering safe by using real numbers rather than zeros.
    const tuning = state.mode === 'high' ? AUTO_FRAME_TUNING.high : AUTO_FRAME_TUNING.medium;

    // Run face detection every N frames (throttled per mode)
    frameCount++;
    if (detector && consecutiveErrors < 30 && frameCount % tuning.detectEvery === 0) {
      try {
        // performance.now() is monotonic across the page lifetime.
        // videoEl.currentTime resets to ~0 whenever the source track is swapped
        // (camera toggle, device change), which makes MediaPipe's internal
        // timestamp validator reject frames with "Packet timestamp mismatch"
        // and the processor's output canvas freezes. Using a monotonic clock
        // guarantees timestamps only ever increase, regardless of how many
        // times the source track is swapped inside the shared detector.
        const res = detector.detectForVideo(videoEl, performance.now());
        consecutiveErrors = 0;
        const landmarks = res?.faceLandmarks?.[0];
        if (landmarks && landmarks.length > 0) {
          // Reduce 478 normalized landmarks [0,1] to a bounding box. This
          // replaces the legacy boundingBox field, and gives us a tighter
          // box around the face oval (no ear/hair padding the old detector
          // included). That shifts auto-zoom framing ~10-15% tighter at
          // the same IDEAL_FACE_FRACTION — subjectively better framing.
          let minX = 1, minY = 1, maxX = 0, maxY = 0;
          for (let i = 0; i < landmarks.length; i++) {
            const lm = landmarks[i];
            if (lm.x < minX) minX = lm.x;
            if (lm.y < minY) minY = lm.y;
            if (lm.x > maxX) maxX = lm.x;
            if (lm.y > maxY) maxY = lm.y;
          }
          const newX = (minX + maxX) / 2;
          const newY = (minY + maxY) / 2;
          const faceFraction = maxX - minX; // normalized [0,1]
          // Dead zone: only update target if movement exceeds threshold
          if (Math.abs(newX - lastTargetX) > tuning.deadZone || Math.abs(newY - lastTargetY) > tuning.deadZone) {
            lastTargetX = newX;
            lastTargetY = newY;
          }
          // Auto-zoom target from face width: the subject should occupy
          // IDEAL_FACE_FRACTION of the frame. Clamp so tiny detections
          // (false positive noise) don't crank zoom to max.
          if (state.zoomAuto && faceFraction > 0.05) {
            const raw = IDEAL_FACE_FRACTION / faceFraction;
            targetZoom = Math.max(AUTO_ZOOM_MIN, Math.min(AUTO_ZOOM_MAX, raw));
          }
        }
      } catch {
        consecutiveErrors++;
        if (consecutiveErrors === 30) {
          console.warn('Auto-frame: face detection failed 30 times, disabling detection');
        }
      }
    }

    // Position smoothing: 'high' uses a spring-damper with velocity so the
    // crop glides toward the target and decelerates naturally. 'medium'
    // sticks with the original lerp for CPU-light responsiveness.
    if (state.mode === 'high') {
      const ax = (lastTargetX - smoothX) * tuning.spring;
      const ay = (lastTargetY - smoothY) * tuning.spring;
      velX = (velX + ax) * tuning.friction;
      velY = (velY + ay) * tuning.friction;
      smoothX += velX;
      smoothY += velY;
    } else {
      smoothX = lerp(smoothX, lastTargetX, tuning.lerp);
      smoothY = lerp(smoothY, lastTargetY, tuning.lerp);
    }

    // Auto-zoom lerp runs every frame so the zoom change itself is smooth
    // regardless of detection cadence. When auto is off, pin to manual zoom.
    const effectiveZoom = state.zoomAuto
      ? (smoothZoom = lerp(smoothZoom, targetZoom, AUTO_ZOOM_LERP))
      : state.zoom;
    const cropW = vw / effectiveZoom, cropH = vh / effectiveZoom;
    const cropX = Math.max(0, Math.min(vw - cropW, smoothX * vw - cropW / 2));
    const cropY = Math.max(0, Math.min(vh - cropH, smoothY * vh - cropH / 2));

    ctx.filter = state.filter;
    ctx.drawImage(videoEl, cropX, cropY, cropW, cropH, 0, 0, vw, vh);
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

  const processor = {
    name: 'auto-frame',
    get processedTrack() { return _processedTrack; },
    setZoom(z: number) {
      state.zoom = z;
      // Keep smoothZoom in sync so when the user flips auto-zoom on later
      // it starts from their last manual value rather than snapping.
      if (!state.zoomAuto) smoothZoom = z;
    },
    setFilter(f: string) { state.filter = f; },
    setMode(m: AutoFrameMode) {
      state.mode = m;
      // Reset velocity when entering 'high' so the first frame doesn't kick
      // the crop off-screen from a stale value.
      if (m === 'high') { velX = 0; velY = 0; }
    },
    setZoomAuto(auto: boolean) {
      state.zoomAuto = auto;
      if (!auto) smoothZoom = state.zoom;
    },

    async init(opts: VideoProcessorOptions) {
      // Clean up any previous state (handles reentrant init)
      cleanup();

      if (!checkAutoFrameSupport()) {
        throw new Error('Canvas captureStream not supported in this browser');
      }

      const { getStoredAdvanced } = await import('../../utils/settingsStorage');
      const hwAccel = getStoredAdvanced().hardwareAcceleration;
      await ensureDetector(hwAccel);

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
      // High-quality upscaling — reduces pixelation when the crop window is
      // smaller than the output canvas (i.e. zoom > 1).
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';

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
      frameCount = 0;
      consecutiveErrors = 0;
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
  } as TrackProcessor<Track.Kind.Video, VideoProcessorOptions> & {
    setZoom(z: number): void;
    setFilter(f: string): void;
    setMode(m: AutoFrameMode): void;
    setZoomAuto(auto: boolean): void;
  };

  return processor;
}
