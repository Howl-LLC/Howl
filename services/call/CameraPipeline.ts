// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * CameraPipeline — manages the video processing pipeline for camera effects.
 *
 * Supports two execution paths:
 *  1. Worker path (Chromium, Electron, Safari 17.4+): Uses Insertable Streams
 *     (MediaStreamTrackProcessor / MediaStreamTrackGenerator) to pipe video
 *     frames to a Web Worker running MediaPipe on an OffscreenCanvas.
 *  2. Main-thread fallback (Firefox, older Safari): Uses the existing
 *     canvas + captureStream approach with requestAnimationFrame.
 *
 * Both paths expose the same API. Callers get back a processed MediaStream
 * and can call update*() methods at any time to change effects mid-stream
 * without rebuilding the pipeline or toggling the camera.
 */

import type { CameraEffectSettings } from './buildProcessedCameraStream';
import type { GradeId } from './colorGradeProcessor';
import type { AutoFrameMode } from '../../utils/settingsStorage';

// Capability Detection

/**
 * Probe browser capabilities. Returns true when Insertable Streams +
 * OffscreenCanvas are supported (worker pipeline available).
 */
export function supportsWorkerPipeline(): boolean {
  return (
    typeof MediaStreamTrackProcessor !== 'undefined' &&
    typeof MediaStreamTrackGenerator !== 'undefined' &&
    typeof OffscreenCanvas !== 'undefined'
  );
}

// Insertable Streams type declarations
// These APIs exist in Chromium but are not in lib.dom.d.ts. Declare minimal
// shapes so TypeScript is happy without pulling in experimental type packages.

declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack });
  readonly readable: ReadableStream<VideoFrame>;
}

declare class MediaStreamTrackGenerator {
  constructor(init: { kind: string });
  readonly writable: WritableStream<VideoFrame>;
  readonly track: MediaStreamTrack;
}

// VideoFrame is in newer lib.dom but may not be present everywhere.
// Ensure TS doesn't error if the global type is missing.
declare class VideoFrame {
  constructor(source: OffscreenCanvas | ImageBitmap, init?: { timestamp: number });
  readonly displayWidth: number;
  readonly displayHeight: number;
  readonly timestamp: number;
  close(): void;
}

// Public Types

export interface CameraPipelineHandle {
  /** The processed output stream — stable identity, never changes. */
  processedStream: MediaStream;
  /** Update autoframe mode mid-stream: 'off' / 'medium' / 'high'. */
  updateAutoFrame(mode: AutoFrameMode): void;
  /** Update autoframe zoom level mid-stream. When `auto` is true, zoom is
   *  computed dynamically from face bounding-box width and `zoom` serves
   *  as the starting point. */
  updateZoom(zoom: number, auto?: boolean): void;
  /** Update color grade mid-stream. */
  updateColorGrade(enabled: boolean, grade: GradeId): void;
  /** Update background effect mid-stream. */
  updateBackground(mode: 'off' | 'blur' | 'image', opts?: {
    blurRadius?: number;
    imageUrl?: string;
  }): void;
  /** Stop the pipeline and release all resources. Idempotent. */
  stop(): void;
}

// Worker-based Pipeline

async function createWorkerPipeline(
  rawStream: MediaStream,
  settings: CameraEffectSettings,
): Promise<CameraPipelineHandle> {
  const rawTrack = rawStream.getVideoTracks()[0];
  if (!rawTrack) {
    return createNoopHandle(rawStream);
  }

  const { getStoredAdvanced } = await import('../../utils/settingsStorage');
  const hwAccel = getStoredAdvanced().hardwareAcceleration;

  // Set up Insertable Streams
  const processor = new MediaStreamTrackProcessor({ track: rawTrack });
  const generator = new MediaStreamTrackGenerator({ kind: 'video' });

  // Create worker
  const worker = new Worker(
    new URL('./videoPipeline.worker.ts', import.meta.url),
    { type: 'module' },
  );

  let stopped = false;
  const processedStream = new MediaStream([generator.track]);

  // Wait for worker 'ready' signal before returning
  const readyPromise = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Worker init timeout')), 10000);
    const handler = (e: MessageEvent) => {
      if (e.data.type === 'ready') {
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        resolve();
      } else if (e.data.type === 'error') {
        clearTimeout(timeout);
        worker.removeEventListener('message', handler);
        reject(new Error(e.data.message || 'Worker error'));
      }
    };
    worker.addEventListener('message', handler);
  });

  // Transfer readable and writable to the worker
  worker.postMessage({
    type: 'init',
    settings: {
      autoFrameMode: settings.autoFrameMode ?? 'off',
      autoFrameZoom: settings.autoFrameZoom ?? 1,
      autoFrameZoomAuto: settings.autoFrameZoomAuto ?? false,
      videoColorGradeEnabled: settings.videoColorGradeEnabled ?? false,
      videoColorGrade: settings.videoColorGrade ?? 'none',
      videoBackgroundMode: settings.videoBackgroundMode ?? 'off',
      videoBackgroundBlurRadius: settings.videoBackgroundBlurRadius ?? 10,
      videoBackgroundImageUrl: settings.videoBackgroundImageUrl ?? '',
      assetBasePath: import.meta.env.BASE_URL ?? '/',
      useGPU: hwAccel,
    },
    readable: processor.readable,
    writable: generator.writable,
  }, [processor.readable, generator.writable] as unknown as Transferable[]);

  await readyPromise;

  if (typeof console !== 'undefined') {
    console.info('[CameraPipeline] Using worker pipeline');
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    try { worker.postMessage({ type: 'stop' }); } catch { /* ignore */ }
    // Give the worker a moment to clean up, then terminate
    setTimeout(() => {
      try { worker.terminate(); } catch { /* ignore */ }
    }, 200);
  }

  return {
    processedStream,
    updateAutoFrame(mode: AutoFrameMode): void {
      if (stopped) return;
      worker.postMessage({ type: 'updateAutoFrame', mode });
    },
    updateZoom(zoom: number, auto?: boolean): void {
      if (stopped) return;
      worker.postMessage({ type: 'updateZoom', zoom, zoomAuto: auto });
    },
    updateColorGrade(enabled: boolean, grade: GradeId): void {
      if (stopped) return;
      worker.postMessage({ type: 'updateColorGrade', enabled, grade });
    },
    updateBackground(
      mode: 'off' | 'blur' | 'image',
      opts?: { blurRadius?: number; imageUrl?: string },
    ): void {
      if (stopped) return;
      worker.postMessage({
        type: 'updateBackground',
        mode,
        blurRadius: opts?.blurRadius,
        imageUrl: opts?.imageUrl,
      });
    },
    stop,
  };
}

// Main-thread Fallback Pipeline

async function createMainThreadPipeline(
  rawStream: MediaStream,
  settings: CameraEffectSettings,
): Promise<CameraPipelineHandle> {
  // Import processors for live-updating
  const { createAutoFrameProcessor } = await import('./autoFrameProcessor');
  const { createColorGradeProcessor, COLOR_GRADES } = await import('./colorGradeProcessor');

  const rawTrack = rawStream.getVideoTracks()[0];
  if (!rawTrack) {
    return createNoopHandle(rawStream);
  }

  const autoFrameMode: AutoFrameMode = settings.autoFrameMode ?? 'off';
  const autoFrameOn = autoFrameMode !== 'off';
  const colorGradeOn = !!settings.videoColorGradeEnabled &&
    !!settings.videoColorGrade && settings.videoColorGrade !== 'none';
  const bgMode = settings.videoBackgroundMode ?? 'off';
  const bgOn = bgMode === 'blur' || bgMode === 'image';

  // If no effects needed, return a minimal handle
  if (!autoFrameOn && !colorGradeOn && !bgOn) {
    if (typeof console !== 'undefined') {
      console.info('[CameraPipeline] Using main-thread pipeline (fallback) - no effects');
    }
    return createNoopHandle(rawStream);
  }

  // Track active sub-processors for live updates
  let stage1Processor: ReturnType<typeof createAutoFrameProcessor> |
    ReturnType<typeof createColorGradeProcessor> | null = null;
  let bgProcessor: any = null;
  const cleanups: Array<() => void> = [];
  let currentTrack: MediaStreamTrack = rawTrack;
  let stopped = false;

  // Current settings (mutable for live updates)
  const liveSettings = {
    autoFrameMode,
    autoFrameZoom: settings.autoFrameZoom ?? 1,
    autoFrameZoomAuto: !!settings.autoFrameZoomAuto,
    colorGradeEnabled: colorGradeOn,
    colorGrade: (settings.videoColorGrade ?? 'none') as GradeId,
    bgMode: bgMode as 'off' | 'blur' | 'image',
    bgBlurRadius: settings.videoBackgroundBlurRadius ?? 10,
    bgImageUrl: settings.videoBackgroundImageUrl ?? '',
  };

  // Step 1: Autoframe + color grade
  if (autoFrameOn || colorGradeOn) {
    const processor = autoFrameOn
      ? createAutoFrameProcessor(
          liveSettings.autoFrameZoom,
          colorGradeOn ? COLOR_GRADES[liveSettings.colorGrade] : undefined,
          liveSettings.autoFrameMode,
          liveSettings.autoFrameZoomAuto,
        )
      : createColorGradeProcessor(liveSettings.colorGrade);

    await processor.init({ track: currentTrack } as any);
    stage1Processor = processor;

    const processedTrack = processor.processedTrack;
    if (processedTrack) {
      currentTrack = processedTrack;
      cleanups.push(() => { processor.destroy().catch(() => {}); });
    } else {
      await processor.destroy().catch(() => {});
      stage1Processor = null;
    }
  }

  // Step 2: Background blur / virtual background
  if (bgOn) {
    try {
      const { LocalVideoTrack } = await import('livekit-client');
      const { BackgroundProcessor } = await import('@livekit/track-processors');
      const { getStoredAdvanced } = await import('../../utils/settingsStorage');

      const hwAccel = getStoredAdvanced().hardwareAcceleration;
      const segmenterOpts = hwAccel ? undefined : { delegate: 'CPU' as const };

      // selfie_multiclass gives 6-class output but LiveKit's BackgroundProcessor
      // only reads "is this pixel background?" which is class 0 in both the
      // legacy binary segmenter and this one — so the drop-in swap is safe
      // and we get the cleaner-edge benefit. Size: 16MB (float32-only).
      const assetPaths = {
        tasksVisionFileSet: `${import.meta.env.BASE_URL}mediapipe/wasm`,
        modelAssetPath: `${import.meta.env.BASE_URL}mediapipe/models/selfie_multiclass_256x256.tflite`,
      };

      const config = bgMode === 'blur'
        ? { mode: 'background-blur' as const, blurRadius: liveSettings.bgBlurRadius }
        : { mode: 'virtual-background' as const, imagePath: liveSettings.bgImageUrl };

      bgProcessor = BackgroundProcessor({
        ...config,
        assetPaths,
        ...(segmenterOpts ? { segmenterOptions: segmenterOpts } : {}),
      });

      const lkTrack = new LocalVideoTrack(currentTrack);
      await lkTrack.setProcessor(bgProcessor);
      currentTrack = lkTrack.mediaStreamTrack;
      cleanups.push(() => { lkTrack.stopProcessor().catch(() => {}); });
    } catch (err) {
      console.warn('[CameraPipeline] background effect failed, continuing without it', err);
    }
  }

  const processedStream = new MediaStream([currentTrack]);

  if (typeof console !== 'undefined') {
    console.info('[CameraPipeline] Using main-thread pipeline (fallback)');
  }

  function stop(): void {
    if (stopped) return;
    stopped = true;
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* noop */ }
    }
    stage1Processor = null;
    bgProcessor = null;
  }

  return {
    processedStream,

    updateAutoFrame(mode: AutoFrameMode): void {
      if (stopped) return;
      const wasOff = liveSettings.autoFrameMode === 'off';
      const willBeOff = mode === 'off';
      liveSettings.autoFrameMode = mode;
      if (stage1Processor && 'setMode' in stage1Processor) {
        (stage1Processor as ReturnType<typeof createAutoFrameProcessor>).setMode(mode);
      }
      // Main-thread fallback: toggling on or off when no processor exists
      // (or vice versa) requires a rebuild, which only happens on next camera
      // acquisition. The worker path handles it live; this is a known
      // limitation of the fallback. Live medium↔high transitions work because
      // setMode flips a flag the process loop reads each frame.
      if (wasOff !== willBeOff && typeof console !== 'undefined') {
        console.info('[CameraPipeline] Main-thread fallback: auto-frame toggle will apply on next camera rebuild');
      }
    },

    updateZoom(zoom: number, auto?: boolean): void {
      if (stopped) return;
      liveSettings.autoFrameZoom = zoom;
      if (auto !== undefined) liveSettings.autoFrameZoomAuto = auto;
      if (stage1Processor && 'setZoom' in stage1Processor) {
        (stage1Processor as ReturnType<typeof createAutoFrameProcessor>).setZoom(zoom);
        if (auto !== undefined && 'setZoomAuto' in stage1Processor) {
          (stage1Processor as ReturnType<typeof createAutoFrameProcessor>).setZoomAuto(auto);
        }
      }
    },

    updateColorGrade(enabled: boolean, grade: GradeId): void {
      if (stopped) return;
      liveSettings.colorGradeEnabled = enabled;
      liveSettings.colorGrade = grade;
      if (stage1Processor && 'setFilter' in stage1Processor) {
        const filterStr = enabled && grade !== 'none'
          ? (COLOR_GRADES[grade] || 'none')
          : 'none';
        (stage1Processor as ReturnType<typeof createAutoFrameProcessor>).setFilter(filterStr);
      } else if (stage1Processor && 'setGrade' in stage1Processor) {
        (stage1Processor as ReturnType<typeof createColorGradeProcessor>).setGrade(grade);
      }
    },

    updateBackground(
      mode: 'off' | 'blur' | 'image',
      opts?: { blurRadius?: number; imageUrl?: string },
    ): void {
      if (stopped) return;
      liveSettings.bgMode = mode;
      if (opts?.blurRadius !== undefined) liveSettings.bgBlurRadius = opts.blurRadius;
      if (opts?.imageUrl !== undefined) liveSettings.bgImageUrl = opts.imageUrl;

      // LiveKit BackgroundProcessor supports switchTo for mode changes
      if (bgProcessor && mode !== 'off') {
        const config = mode === 'blur'
          ? { mode: 'background-blur' as const, blurRadius: liveSettings.bgBlurRadius }
          : { mode: 'virtual-background' as const, imagePath: liveSettings.bgImageUrl };
        bgProcessor.switchTo?.(config)?.catch?.(() => {});
      }
    },

    stop,
  };
}

// Noop handle for when no effects are active

function createNoopHandle(stream: MediaStream): CameraPipelineHandle {
  return {
    processedStream: stream,
    updateAutoFrame() {},
    updateZoom() {},
    updateColorGrade() {},
    updateBackground() {},
    stop() {},
  };
}

// Public Factory

/**
 * Create a CameraPipeline. Automatically selects the worker path when
 * Insertable Streams are available, falling back to the main-thread
 * canvas-based pipeline otherwise.
 *
 * Returns a handle with the processed stream and live-update methods.
 * The processed stream identity is stable — it never changes, so callers
 * do not need to call replaceTrack when effects change.
 */
export async function createCameraPipeline(
  rawStream: MediaStream,
  settings: CameraEffectSettings,
): Promise<CameraPipelineHandle> {
  // Check if any effect is actually enabled
  const anyEffect =
    (settings.autoFrameMode && settings.autoFrameMode !== 'off') ||
    (settings.videoColorGradeEnabled && settings.videoColorGrade !== 'none') ||
    (settings.videoBackgroundMode === 'blur' || settings.videoBackgroundMode === 'image');

  if (!anyEffect) {
    return createNoopHandle(rawStream);
  }

  if (supportsWorkerPipeline()) {
    try {
      return await createWorkerPipeline(rawStream, settings);
    } catch (err) {
      // Worker pipeline failed — fall back to main thread
      console.warn('[CameraPipeline] Worker pipeline init failed, falling back to main thread:', err);
      return createMainThreadPipeline(rawStream, settings);
    }
  }

  return createMainThreadPipeline(rawStream, settings);
}
