// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Bluetooth audio quality detector.
 *
 * Classifies mic input into a three-tier quality ladder based on the
 * combination of device label heuristics and the sample rate of the resolved
 * MediaStream. Drives the UX that routes around Classic Bluetooth's HFP/A2DP
 * codec downgrade while getting out of the way when LE Audio / LC3 is active.
 *
 * This module is pure logic — no React, no DOM writes, no side effects beyond
 * a thin `devicechange` subscription helper. Consumers (the React hook and
 * the call engine) are responsible for wiring probes into their lifecycles.
 */

export type QualityTier = 'good' | 'medium' | 'bad';

export type Platform =
  | 'windows'
  | 'mac'
  | 'linux'
  | 'android'
  | 'ios'
  | 'unknown';

export interface BtQualityStatus {
  tier: QualityTier;
  deviceId: string;
  deviceLabel: string;
  sampleRate: number | null;
  /** Best-guess from label heuristic. LE Audio devices still return true. */
  isBluetooth: boolean;
  platform: Platform;
  /** True if a programmatic split is feasible on this platform + given current enumeration. */
  canAutoSplit: boolean;
}

// Patterns cover: Windows "... (Bluetooth Hands-Free)", Linux PulseAudio/PipeWire
// bluez_* names (underscore-prefixed suffix required), generic "Bluetooth" / "HFP"
// / "HSP" / "hands-free" / "A2DP", and common BT headset brand families on macOS
// Chrome where the OS-reported label lacks profile annotation. Brand patterns use
// \w* trailers to match model-number suffixes (e.g., "WH-1000XM5", "QC35", "NC700").
const BT_LABEL_RE =
  /\b(?:bluetooth|hands[-\s]?free|hfp|hsp|bluez_(?:output|source|sink|input)|a2dp|airpods|galaxy\s?buds|wh-1000\w*|wf-1000\w*|buds\s?pro|buds\s?live|bose\s?(?:qc|nc)\w*)\b/i;

export function matchesBluetoothLabel(label: string): boolean {
  if (!label) return false;
  return BT_LABEL_RE.test(label);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

export function classifyTier(input: {
  sampleRate: number | null;
  label: string;
}): QualityTier {
  const { sampleRate, label } = input;
  if (!isFiniteNumber(sampleRate)) {
    return matchesBluetoothLabel(label) ? 'medium' : 'good';
  }
  if (sampleRate >= 20000) return 'good';
  if (sampleRate > 8000 && sampleRate < 20000) return 'medium';
  return 'bad';
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent || '';
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/Windows/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

/**
 * Platforms where we can programmatically switch the mic input device
 * without OS cooperation. iOS Safari restricts `enumerateDevices` and
 * device selection; Android mobile Chrome's support is inconsistent —
 * callers should verify against actual enumerated device count.
 */
function platformSupportsAutoSplit(platform: Platform): boolean {
  switch (platform) {
    case 'windows':
    case 'mac':
    case 'linux':
      return true;
    case 'android':
      return true;
    case 'ios':
      return false;
    default:
      return false;
  }
}

/**
 * Probe the first audio track on the given stream. Returns null if the stream
 * has no audio tracks (callers should treat that as "do nothing").
 */
export function probeStream(
  stream: MediaStream,
  deviceInfo: MediaDeviceInfo | null,
): BtQualityStatus | null {
  const tracks = stream.getAudioTracks();
  if (tracks.length === 0) return null;
  const track = tracks[0];
  let sampleRate: number | null = null;
  try {
    const settings = track.getSettings();
    if (isFiniteNumber(settings.sampleRate)) sampleRate = settings.sampleRate;
  } catch { /* older browsers */ }
  const label = (deviceInfo?.label ?? track.label ?? '').toString();
  const deviceId = deviceInfo?.deviceId ?? '';
  const tier = classifyTier({ sampleRate, label });
  const isBluetooth = matchesBluetoothLabel(label);
  const platform = detectPlatform();
  return {
    tier,
    deviceId,
    deviceLabel: label,
    sampleRate,
    isBluetooth,
    platform,
    canAutoSplit: platformSupportsAutoSplit(platform),
  };
}

export function subscribeDeviceChange(cb: () => void): () => void {
  const md = navigator.mediaDevices;
  if (!md || typeof md.addEventListener !== 'function') {
    return () => { /* noop */ };
  }
  md.addEventListener('devicechange', cb);
  return () => {
    try { md.removeEventListener('devicechange', cb); } catch { /* already gone */ }
  };
}
