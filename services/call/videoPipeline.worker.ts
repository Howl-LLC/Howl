// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Video pipeline Web Worker — runs MediaPipe face detection, autoframe
 * cropping, color grading, and background segmentation on an
 * OffscreenCanvas so the main thread stays responsive.
 *
 * Communication protocol (main -> worker):
 *   { type: 'init', settings: PipelineSettings, canvas: OffscreenCanvas }
 *   { type: 'updateAutoFrame', mode: 'off'|'medium'|'high' }
 *   { type: 'updateZoom', zoom: number, zoomAuto?: boolean }
 *   { type: 'updateColorGrade', enabled: boolean, grade: string }
 *   { type: 'updateBackground', mode: string, blurRadius?: number, imageUrl?: string }
 *   { type: 'stop' }
 *
 * Worker -> main:
 *   { type: 'ready' }
 *   { type: 'error', message: string }
 */

/** Mirror of `AutoFrameMode` from utils/settingsStorage.ts — duplicated here
 *  because workers can't import app-level types cleanly via Vite bundling. */
type AutoFrameMode = 'off' | 'medium' | 'high';

/** Per-mode tuning. See autoFrameProcessor.ts for the same table + rationale. */
const AUTO_FRAME_TUNING = {
  medium: { lerp: 0.15, detectEvery: 2, deadZone: 0.02, spring: 0, friction: 0 },
  high:   { lerp: 0.06, detectEvery: 1, deadZone: 0.04, spring: 0.22, friction: 0.78 },
} as const;

const IDEAL_FACE_FRACTION = 0.3;
const AUTO_ZOOM_LERP = 0.08;
const AUTO_ZOOM_MIN = 1.0;
const AUTO_ZOOM_MAX = 2.5;

// TypeScript: we are in a worker context.
// Use globalThis-based typing to avoid colliding with lib.dom's `self`.
const workerScope = globalThis as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
};

interface PipelineSettings {
  autoFrameMode: AutoFrameMode;
  autoFrameZoom: number;
  autoFrameZoomAuto: boolean;
  videoColorGradeEnabled: boolean;
  videoColorGrade: string;
  videoBackgroundMode: 'off' | 'blur' | 'image';
  videoBackgroundBlurRadius: number;
  videoBackgroundImageUrl: string;
  assetBasePath: string;
  useGPU: boolean;
}

const COLOR_GRADES: Record<string, string> = {
  none: 'none',
  warm: 'saturate(1.1) sepia(0.15) brightness(1.05)',
  cool: 'saturate(0.9) hue-rotate(10deg) brightness(1.05)',
  noir: 'grayscale(1) contrast(1.2) brightness(0.95)',
  vivid: 'saturate(1.4) contrast(1.08)',
  faded: 'saturate(0.6) brightness(1.1) contrast(0.9)',
};

// Mutable settings read per-frame
let settings: PipelineSettings = {
  autoFrameMode: 'off',
  autoFrameZoom: 1,
  autoFrameZoomAuto: false,
  videoColorGradeEnabled: false,
  videoColorGrade: 'none',
  videoBackgroundMode: 'off',
  videoBackgroundBlurRadius: 10,
  videoBackgroundImageUrl: '',
  assetBasePath: '',
  useGPU: true,
};

let running = false;
let canvas: OffscreenCanvas | null = null;
let ctx: OffscreenCanvasRenderingContext2D | null = null;

// Insertable Streams handles
let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;

// MediaPipe handles (cached across settings changes)
let faceDetector: any = null;
let faceDetectorPromise: Promise<void> | null = null;
let segmenter: any = null;
let segmenterPromise: Promise<void> | null = null;

// Autoframe smoothing state
let smoothX = 0.5;
let smoothY = 0.5;
let lastTargetX = 0.5;
let lastTargetY = 0.5;
// Velocity terms for the 'high' spring-damper.
let velX = 0;
let velY = 0;
// Auto-zoom state — target derived from face bbox width, smoothZoom lerps.
let smoothZoom = 1;
let targetZoom = 1;
let frameCount = 0;
let consecutiveDetectErrors = 0;

// Background image cache
let bgImageBitmap: ImageBitmap | null = null;
let bgImageUrl = '';

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

async function ensureFaceDetector(): Promise<void> {
  if (faceDetector) return;
  if (!faceDetectorPromise) {
    faceDetectorPromise = (async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
          `${settings.assetBasePath}mediapipe/wasm`,
        );
        // FaceLandmarker: 478-point 3D landmarks. Tighter bbox than the
        // legacy FaceDetector. See autoFrameProcessor.ts for rationale.
        faceDetector = await vision.FaceLandmarker.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: `${settings.assetBasePath}mediapipe/models/face_landmarker.task`,
            delegate: settings.useGPU ? 'GPU' : 'CPU',
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
        faceDetectorPromise = null;
        throw err;
      }
    })();
  }
  await faceDetectorPromise;
}

async function ensureSegmenter(): Promise<void> {
  if (segmenter) return;
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      try {
        const vision = await import('@mediapipe/tasks-vision');
        const filesetResolver = await vision.FilesetResolver.forVisionTasks(
          `${settings.assetBasePath}mediapipe/wasm`,
        );
        // Multiclass segmenter: 6-class output (background/hair/body/face/
        // clothes/other). Our rendering treats class 0 as background and
        // all other classes as foreground — same binary interpretation as
        // the legacy selfie_segmenter, but the multiclass training gives
        // noticeably cleaner edges around hair and fingers. Model is 16MB
        // (float32-only, no quantized variant published) so it is NOT
        // prefetched on mobile — it only downloads when the user actually
        // enables background blur/image. See App.tsx desktop-only prefetch.
        segmenter = await vision.ImageSegmenter.createFromOptions(filesetResolver, {
          baseOptions: {
            modelAssetPath: `${settings.assetBasePath}mediapipe/models/selfie_multiclass_256x256.tflite`,
            delegate: settings.useGPU ? 'GPU' : 'CPU',
          },
          runningMode: 'VIDEO',
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
      } catch (err) {
        segmenterPromise = null;
        throw err;
      }
    })();
  }
  await segmenterPromise;
}

async function loadBackgroundImage(url: string): Promise<void> {
  if (bgImageUrl === url && bgImageBitmap) return;
  bgImageUrl = url;
  bgImageBitmap?.close();
  bgImageBitmap = null;
  if (!url) return;
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    bgImageBitmap = await createImageBitmap(blob);
  } catch {
    bgImageBitmap = null;
  }
}

async function processFrame(frame: VideoFrame): Promise<VideoFrame> {
  const width = frame.displayWidth;
  const height = frame.displayHeight;

  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d');
  }
  if (!ctx) {
    return frame;
  }

  // Create an ImageBitmap from the VideoFrame for drawing
  const bitmap = await createImageBitmap(frame);

  const autoFrameOn = settings.autoFrameMode !== 'off';
  const colorGradeOn = settings.videoColorGradeEnabled &&
    settings.videoColorGrade !== 'none';
  const bgMode = settings.videoBackgroundMode;
  const bgOn = bgMode === 'blur' || bgMode === 'image';

  // If no effects active, pass through
  if (!autoFrameOn && !colorGradeOn && !bgOn) {
    bitmap.close();
    return frame;
  }

  // Resolve tuning pack for this frame. 'high' uses a spring-damper instead
  // of a raw lerp and bumps detection to 60Hz. See autoFrameProcessor.ts.
  const tuning = settings.autoFrameMode === 'high'
    ? AUTO_FRAME_TUNING.high
    : AUTO_FRAME_TUNING.medium;

  // Step 1: Face detection for autoframe
  if (autoFrameOn && faceDetector && consecutiveDetectErrors < 30) {
    frameCount++;
    if (frameCount % tuning.detectEvery === 0) {
      try {
        const res = faceDetector.detectForVideo(bitmap, performance.now());
        consecutiveDetectErrors = 0;
        const landmarks = res?.faceLandmarks?.[0];
        if (landmarks && landmarks.length > 0) {
          // Reduce 478 normalized landmarks [0,1] to a bounding box —
          // drop-in replacement for the legacy FaceDetector.boundingBox.
          // See autoFrameProcessor.ts for full rationale.
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
          const faceFraction = maxX - minX; // already normalized [0,1]
          if (
            Math.abs(newX - lastTargetX) > tuning.deadZone ||
            Math.abs(newY - lastTargetY) > tuning.deadZone
          ) {
            lastTargetX = newX;
            lastTargetY = newY;
          }
          if (settings.autoFrameZoomAuto && faceFraction > 0.05) {
            const raw = IDEAL_FACE_FRACTION / faceFraction;
            targetZoom = Math.max(AUTO_ZOOM_MIN, Math.min(AUTO_ZOOM_MAX, raw));
          }
        }
      } catch {
        consecutiveDetectErrors++;
      }
    }
  }

  // Step 2: Background segmentation
  let segmentMask: any = null;
  if (bgOn && segmenter) {
    try {
      const result = segmenter.segmentForVideo(bitmap, performance.now());
      if (result?.categoryMask) {
        segmentMask = result.categoryMask;
      }
    } catch {
      // Best-effort segmentation
    }
  }

  // Step 3: Compositing
  // Apply color grade filter
  const filterStr = colorGradeOn
    ? (COLOR_GRADES[settings.videoColorGrade] || 'none')
    : 'none';

  if (autoFrameOn) {
    // Position smoothing: 'high' uses spring-damper with velocity for a
    // glide effect; 'medium' uses the faster lerp that was the legacy path.
    if (settings.autoFrameMode === 'high') {
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
    // Auto-zoom lerps every frame even though detection is throttled, so
    // zoom transitions stay smooth at 60Hz.
    const zoom = settings.autoFrameZoomAuto
      ? (smoothZoom = lerp(smoothZoom, targetZoom, AUTO_ZOOM_LERP))
      : settings.autoFrameZoom;
    const cropW = width / zoom;
    const cropH = height / zoom;
    const cropX = Math.max(0, Math.min(width - cropW, smoothX * width - cropW / 2));
    const cropY = Math.max(0, Math.min(height - cropH, smoothY * height - cropH / 2));

    ctx.filter = filterStr;

    if (bgOn && segmentMask) {
      // Draw background first, then person on top via mask
      drawWithSegmentation(ctx, bitmap, segmentMask, width, height,
        cropX, cropY, cropW, cropH);
    } else {
      ctx.drawImage(bitmap, cropX, cropY, cropW, cropH, 0, 0, width, height);
    }
  } else if (bgOn && segmentMask) {
    ctx.filter = filterStr;
    drawWithSegmentation(ctx, bitmap, segmentMask, width, height,
      0, 0, width, height);
  } else {
    // Color grade only
    ctx.filter = filterStr;
    ctx.drawImage(bitmap, 0, 0, width, height);
  }

  ctx.filter = 'none';
  bitmap.close();
  segmentMask?.close?.();

  const processedFrame = new VideoFrame(canvas, {
    timestamp: frame.timestamp ?? 0,
  });
  frame.close();
  return processedFrame;
}

function drawWithSegmentation(
  ctx: OffscreenCanvasRenderingContext2D,
  source: ImageBitmap,
  mask: any,
  width: number,
  height: number,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
): void {
  const bgMode = settings.videoBackgroundMode;

  // Draw background layer
  if (bgMode === 'blur') {
    ctx.filter = `blur(${settings.videoBackgroundBlurRadius}px)`;
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    ctx.filter = 'none';
  } else if (bgMode === 'image' && bgImageBitmap) {
    ctx.drawImage(bgImageBitmap, 0, 0, width, height);
  } else {
    // Fallback: black background
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
  }

  // Get mask data
  const maskData = mask.getAsUint8Array?.() ?? mask.getAsFloat32Array?.();
  if (!maskData) {
    // No mask data, just draw person normally
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    return;
  }

  // Create temporary canvas for masking
  const tmpCanvas = new OffscreenCanvas(width, height);
  const tmpCtx = tmpCanvas.getContext('2d');
  if (!tmpCtx) {
    ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
    return;
  }

  // Draw person
  tmpCtx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);

  // Apply mask to person layer
  const personImageData = tmpCtx.getImageData(0, 0, width, height);
  const pixels = personImageData.data;
  for (let i = 0; i < maskData.length && i < width * height; i++) {
    // mask value 0 = person, 255 = background (or float 0.0-1.0)
    const maskVal = maskData[i] > 1 ? maskData[i] / 255 : maskData[i];
    // person alpha: invert mask (0=person -> alpha=255)
    pixels[i * 4 + 3] = Math.round((1 - maskVal) * 255);
  }
  tmpCtx.putImageData(personImageData, 0, 0);

  // Composite person over background
  ctx.drawImage(tmpCanvas, 0, 0);
}

async function runPipeline(
  readable: ReadableStream<VideoFrame>,
  writable: WritableStream<VideoFrame>,
): Promise<void> {
  reader = readable.getReader();
  writer = writable.getWriter();
  running = true;

  // Initialize MediaPipe models based on initial settings
  const initPromises: Promise<void>[] = [];
  if (settings.autoFrameMode !== 'off') {
    initPromises.push(ensureFaceDetector().catch(() => {}));
  }
  if (settings.videoBackgroundMode !== 'off') {
    initPromises.push(ensureSegmenter().catch(() => {}));
    if (settings.videoBackgroundMode === 'image' && settings.videoBackgroundImageUrl) {
      initPromises.push(loadBackgroundImage(settings.videoBackgroundImageUrl));
    }
  }
  await Promise.all(initPromises);

  workerScope.postMessage({ type: 'ready' });

  try {
    while (running) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;

      try {
        const processed = await processFrame(frame);
        await writer.write(processed);
      } catch {
        // If processing fails, close the frame to avoid leaks
        frame.close();
      }
    }
  } catch {
    // Stream closed or errored — normal during cleanup
  } finally {
    reader?.releaseLock();
    writer?.releaseLock();
    reader = null;
    writer = null;
    running = false;
  }
}

function cleanup(): void {
  running = false;
  try { reader?.releaseLock(); } catch { /* ignore */ }
  try { writer?.releaseLock(); } catch { /* ignore */ }
  reader = null;
  writer = null;
  if (faceDetector) {
    try { faceDetector.close(); } catch { /* ignore */ }
    faceDetector = null;
    faceDetectorPromise = null;
  }
  if (segmenter) {
    try { segmenter.close(); } catch { /* ignore */ }
    segmenter = null;
    segmenterPromise = null;
  }
  bgImageBitmap?.close();
  bgImageBitmap = null;
  bgImageUrl = '';
  canvas = null;
  ctx = null;
}

workerScope.onmessage = async (e: MessageEvent) => {
  const msg = e.data;

  switch (msg.type) {
    case 'init': {
      settings = { ...settings, ...msg.settings };
      // readable and writable are transferred from main thread
      const readable = msg.readable as ReadableStream<VideoFrame>;
      const writable = msg.writable as WritableStream<VideoFrame>;
      runPipeline(readable, writable).catch((err: unknown) => {
        workerScope.postMessage({ type: 'error', message: err instanceof Error ? err.message : 'Pipeline error' });
      });
      break;
    }

    case 'updateAutoFrame': {
      const nextMode: AutoFrameMode = msg.mode ?? 'off';
      // Reset velocity on mode change so we don't carry a stale velocity
      // across the medium↔high boundary and kick the crop off-screen.
      if (nextMode !== settings.autoFrameMode) { velX = 0; velY = 0; }
      settings.autoFrameMode = nextMode;
      if (nextMode !== 'off' && !faceDetector) {
        ensureFaceDetector().catch(() => {});
      }
      break;
    }

    case 'updateZoom': {
      settings.autoFrameZoom = msg.zoom;
      if (msg.zoomAuto !== undefined) settings.autoFrameZoomAuto = !!msg.zoomAuto;
      // Keep smoothZoom anchored to manual value when auto is off so a
      // future toggle to auto starts from the user's last manual zoom.
      if (!settings.autoFrameZoomAuto) smoothZoom = msg.zoom;
      break;
    }

    case 'updateColorGrade': {
      settings.videoColorGradeEnabled = msg.enabled;
      settings.videoColorGrade = msg.grade;
      break;
    }

    case 'updateBackground': {
      settings.videoBackgroundMode = msg.mode;
      if (msg.blurRadius !== undefined) {
        settings.videoBackgroundBlurRadius = msg.blurRadius;
      }
      if (msg.mode === 'image' && msg.imageUrl) {
        settings.videoBackgroundImageUrl = msg.imageUrl;
        loadBackgroundImage(msg.imageUrl);
      }
      if (msg.mode !== 'off' && !segmenter) {
        ensureSegmenter().catch(() => {});
      }
      break;
    }

    case 'stop': {
      cleanup();
      break;
    }
  }
};
