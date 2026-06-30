// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Video constraints that prefer HDR / wide color gamut when the browser supports it.
 * Uses getSupportedConstraints() so unsupported keys are never passed (no errors).
 */

type VideoConstraints = boolean | MediaTrackConstraints;

let cachedSupported: Record<string, boolean> | null = null;

function getSupported(): Record<string, boolean> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getSupportedConstraints) {
    return {};
  }
  if (cachedSupported === null) {
    cachedSupported = navigator.mediaDevices.getSupportedConstraints() as Record<string, boolean>;
  }
  return cachedSupported;
}

export type CameraRes = '720p' | '1080p' | '1440p';

export interface VideoQuality {
  width: number;
  height: number;
  fps: number;
  bitrate: number;
}

const CAMERA_RES_MAP: Record<CameraRes, { width: number; height: number }> = {
  '720p':  { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
};

const RES_ORDER: CameraRes[] = ['720p', '1080p', '1440p'];
const MIN_BITRATE_FOR_RES: Record<CameraRes, number> = {
  '720p':  0,
  '1080p': 2_000_000,
  '1440p': 4_000_000,
};

function getPeerBitrateMultiplier(peerCount: number): number {
  if (peerCount <= 2) return 1;
  if (peerCount <= 4) return 0.75;
  if (peerCount <= 8) return 0.5;
  return 0.35;
}

/**
 * Compute camera quality based on peer count and plan limits.
 * Resolution steps down when scaled bitrate is too low, but never below 720p.
 * FPS is capped by the caller's plan (Pro = 60, else 30).
 */
export function getVideoQuality(
  peerCount: number,
  maxBitrate: number,
  maxRes: CameraRes = '720p',
  maxFps: 30 | 60 = 30,
): VideoQuality {
  const scaledBitrate = Math.round(maxBitrate * getPeerBitrateMultiplier(peerCount));
  const capIdx = RES_ORDER.indexOf(maxRes);

  let chosen: CameraRes = '720p';
  for (let i = capIdx; i >= 0; i--) {
    if (scaledBitrate >= MIN_BITRATE_FOR_RES[RES_ORDER[i]]) {
      chosen = RES_ORDER[i];
      break;
    }
  }

  const dim = CAMERA_RES_MAP[chosen];
  return { width: dim.width, height: dim.height, fps: maxFps, bitrate: scaledBitrate };
}

/** @deprecated Use getVideoQuality() for plan-aware quality */
export function getCameraTier(peerCount: number) {
  const q = getVideoQuality(peerCount, 2_500_000, '720p');
  return { maxPeers: Infinity, width: q.width, height: q.height, fps: q.fps };
}

export function getVideoConstraintsForCamera(
  peerCount = 1,
  maxRes: CameraRes = '720p',
  maxBitrate = 2_500_000,
  maxFps: 30 | 60 = 30,
): { video: VideoConstraints } {
  const supported = getSupported();
  const constraints: MediaTrackConstraints = {};
  const quality = getVideoQuality(peerCount, maxBitrate, maxRes, maxFps);

  if (supported.width) constraints.width = { ideal: quality.width };
  if (supported.height) constraints.height = { ideal: quality.height };
  if (supported.frameRate) constraints.frameRate = { ideal: quality.fps };

  if ((supported as Record<string, boolean>).colorGamut) {
    (constraints as Record<string, unknown>).colorGamut = { ideal: ['p3', 'srgb'] };
  }
  if ((supported as Record<string, boolean>).transferFunction) {
    (constraints as Record<string, unknown>).transferFunction = { ideal: ['pq', 'srgb'] };
  }
  if ((supported as Record<string, boolean>).dynamicRange) {
    (constraints as Record<string, unknown>).dynamicRange = { ideal: ['hlg', 'srgb'] };
  }

  return {
    video: Object.keys(constraints).length > 0 ? constraints : true,
  };
}

export type ScreenShareResolution = '720p' | '1080p' | '1440p';
export type ScreenShareFps = 30 | 60;
export type ScreenShareCodec = 'auto' | 'h264' | 'vp9' | 'av1';

export interface ScreenShareQuality {
  resolution: ScreenShareResolution;
  fps: ScreenShareFps;
  audio?: boolean;
  codec?: ScreenShareCodec;
  sourceId?: string;  // Electron desktop capturer source ID
}

const CODEC_MIME_PREFIX: Record<string, ScreenShareCodec> = {
  'video/H264': 'h264',
  'video/VP9': 'vp9',
  'video/AV1': 'av1',
};

const CODEC_LABELS: Record<ScreenShareCodec, string> = {
  auto: 'Auto',
  h264: 'H.264',
  vp9: 'VP9',
  av1: 'AV1',
};

export { CODEC_LABELS };

export function detectSupportedCodecs(): ScreenShareCodec[] {
  try {
    const caps = RTCRtpSender.getCapabilities?.('video');
    if (!caps) return ['h264', 'vp9'];
    const found = new Set<ScreenShareCodec>();
    for (const c of caps.codecs) {
      const mapped = CODEC_MIME_PREFIX[c.mimeType];
      if (mapped) found.add(mapped);
    }
    return Array.from(found);
  } catch {
    return ['h264', 'vp9'];
  }
}

const RESOLUTION_MAP: Record<ScreenShareResolution, { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
};

/**
 * Video constraints for display/screen capture (getDisplayMedia).
 * Allows HDR passthrough so viewers see the original dynamic range / wide gamut.
 * The WebRTC pipeline handles tone mapping on the viewer side if their display is SDR.
 */
// Headroom-bumped table (~+30-40%) so VP9 + content-hint 'detail' have room to look sharp.
// Values are still capped by plan in getScreenShareBitrate.
const SCREEN_SHARE_BITRATE: Record<ScreenShareResolution, Record<ScreenShareFps, number>> = {
  '720p':  { 30: 2_000_000, 60: 3_500_000 },
  '1080p': { 30: 4_000_000, 60: 7_000_000 },
  '1440p': { 30: 7_000_000, 60: 11_000_000 },
};

/** Compute an appropriate screen share bitrate for the given quality, capped by plan limit. */
export function getScreenShareBitrate(quality: ScreenShareQuality, maxBitrate: number): number {
  const table = SCREEN_SHARE_BITRATE[quality.resolution]?.[quality.fps] ?? 4_000_000;
  return Math.min(table, maxBitrate);
}

/**
 * Compensate screen-share bitrate when the captured display is wider than the chosen target.
 * Ultrawide / multi-monitor sources have far more pixels than reference 16:9 at the same
 * resolution tier — same bitrate would be spread thin and look soft. Scales bitrate by the
 * sqrt of the pixel ratio (perceptually-correct), capped at 1.6× to avoid runaway upload.
 *
 * Reference pixels = chosen tier (e.g. 1920×1080 for '1080p'). When actual ≤ 1.1× reference,
 * the original bitrate is returned unchanged (typical 16:9 displays).
 */
export function compensateForAspectRatio(
  baseBitrate: number,
  actualWidth: number,
  actualHeight: number,
  targetResolution: ScreenShareResolution,
): number {
  const ref = RESOLUTION_MAP[targetResolution];
  const refPixels = ref.width * ref.height;
  const aw = Math.max(1, actualWidth | 0);
  const ah = Math.max(1, actualHeight | 0);
  const actualPixels = aw * ah;
  if (actualPixels <= refPixels * 1.1) return baseBitrate;
  const factor = Math.min(1.6, Math.sqrt(actualPixels / refPixels));
  return Math.round(baseBitrate * factor);
}

// Hardware-aware codec selection
// Probes navigator.mediaCapabilities.encodingInfo({type:'webrtc', powerEfficient})
// to find the best codec the user's GPU can encode efficiently. Order of
// preference: AV1 → VP9 → H.264. Result is cached for the session.
//
// Respects the user's Hardware Acceleration toggle automatically: when GPU
// encode is disabled (--disable-gpu-video-encode in main.js), mediaCapabilities
// reports nothing as power-efficient and we fall back to VP9 (still better
// than H.264 even when both are software-encoded).

export type ResolvedCodec = 'h264' | 'vp9' | 'av1';

let _cachedBestCodec: ResolvedCodec | null = null;
let _detectionPromise: Promise<ResolvedCodec> | null = null;

const CODEC_PROBE_ORDER: Array<{ codec: ResolvedCodec; contentType: string }> = [
  { codec: 'av1', contentType: 'video/AV1' },
  { codec: 'vp9', contentType: 'video/VP9' },
  { codec: 'h264', contentType: 'video/H264' },
];

/**
 * Probe each codec for hardware-accelerated encode support via
 * mediaCapabilities.encodingInfo. Returns the first codec marked
 * `powerEfficient` in the AV1→VP9→H.264 order. Caches the result.
 *
 * If no codec is power-efficient (e.g. user disabled hardware acceleration on
 * older hardware), returns 'vp9' — software VP9 still has notably better
 * quality-per-bit for screen content than software H.264.
 */
export async function detectBestScreenShareCodec(): Promise<ResolvedCodec> {
  if (_cachedBestCodec) return _cachedBestCodec;
  if (_detectionPromise) return _detectionPromise;

  _detectionPromise = (async (): Promise<ResolvedCodec> => {
    if (typeof navigator === 'undefined' || !navigator.mediaCapabilities?.encodingInfo) {
      _cachedBestCodec = 'vp9';
      return 'vp9';
    }
    for (const { codec, contentType } of CODEC_PROBE_ORDER) {
      try {
        const info = await navigator.mediaCapabilities.encodingInfo({
          type: 'webrtc',
          video: {
            contentType,
            width: 1920,
            height: 1080,
            bitrate: 5_000_000,
            framerate: 60,
          },
        });
        if (info.supported && info.powerEfficient) {
          _cachedBestCodec = codec;
          return codec;
        }
      } catch { /* probe failed, try next codec */ }
    }
    // No codec was power-efficient — VP9 is the best safe fallback for screens.
    _cachedBestCodec = 'vp9';
    return 'vp9';
  })();

  return _detectionPromise;
}

/**
 * Read the cached best codec without awaiting. If the cache is empty, kicks
 * off detection in the background and returns 'vp9' as a safe default for
 * this call. Subsequent calls (after the probe resolves) will return the
 * actual best codec.
 */
export function getCachedBestCodec(): ResolvedCodec {
  if (_cachedBestCodec) return _cachedBestCodec;
  if (!_detectionPromise) {
    detectBestScreenShareCodec().catch(() => {});
  }
  return 'vp9';
}

/**
 * Resolve a user codec preference to the actual codec passed to LiveKit.
 * Explicit selections ('h264' / 'vp9' / 'av1') are honored as-is so the user
 * can always override. 'auto' uses the hardware-aware cache.
 */
export function resolveScreenShareCodec(
  preference: ScreenShareCodec,
): 'h264' | 'vp9' | 'av1' | undefined {
  if (preference !== 'auto') return preference;
  return getCachedBestCodec();
}

export function getVideoConstraintsForDisplay(quality?: ScreenShareQuality): { video: VideoConstraints; audio?: boolean } {
  const supported = getSupported();
  const constraints: MediaTrackConstraints = {};

  const res = quality ? RESOLUTION_MAP[quality.resolution] : { width: 1920, height: 1080 };
  const fps = quality?.fps ?? 30;

  if (supported.width) constraints.width = { ideal: res.width };
  if (supported.height) constraints.height = { ideal: res.height };
  if (supported.frameRate) {
    // Use `ideal` only, never `min`. `{ min: 30 }` is a hard MediaTrackConstraint:
    // if the chosen capture source can't *guarantee* continuous 30fps (idle
    // window, Wayland portal source below 30Hz, docked laptop on external
    // monitor, etc.) getDisplayMedia rejects with OverconstrainedError and the
    // share never starts. `ideal` lets the source negotiate down to whatever
    // rate it can actually sustain.
    constraints.frameRate = { ideal: fps };
  }

  if ((supported as Record<string, boolean>).colorGamut) {
    (constraints as Record<string, unknown>).colorGamut = { ideal: ['rec2100', 'p3', 'srgb'] };
  }
  if ((supported as Record<string, boolean>).transferFunction) {
    (constraints as Record<string, unknown>).transferFunction = { ideal: ['pq', 'hlg', 'srgb'] };
  }
  if ((supported as Record<string, boolean>).dynamicRange) {
    (constraints as Record<string, unknown>).dynamicRange = { ideal: ['high', 'standard'] };
  }

  const includeAudio = quality?.audio !== false;
  return {
    video: Object.keys(constraints).length > 0 ? constraints : true,
    ...(includeAudio ? { audio: true } : {}),
  };
}
