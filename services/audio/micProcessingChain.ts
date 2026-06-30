// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { createRnnoiseNode, destroyRnnoiseNode, rnnoiseSupported } from '../call/rnnoiseNode';
import { createDfn3Node, destroyDfn3Node, dfn3Supported } from '../call/dfn3Node';
import type { NoiseEngine } from '../../utils/settingsStorage';

// HPF + compressor shape per user-facing NS level
export const NS_HPF_FREQ: Record<string, number> = { none: 0, low: 60, medium: 80, high: 120 };
export const NS_COMP_RATIO: Record<string, number> = { none: 1, low: 2, medium: 4, high: 8 };
export const NS_COMP_THRESH: Record<string, number> = { none: 0, low: -20, medium: -24, high: -30 };

// Look-ahead peak limiter (post-gain)
export const LIMITER_THRESHOLD = -3;
export const LIMITER_KNEE = 6;
export const LIMITER_RATIO = 20;
export const LIMITER_ATTACK = 0.001;
export const LIMITER_RELEASE = 0.05;

// Noise gate smoothing
export const GATE_ATTACK = 0.6;
export const GATE_RELEASE = 0.04;

// Adaptive VAD (auto-sensitivity)
export const NS_FLOOR_UPDATE = 0.995;
export const NS_FLOOR_DECAY = 0.99995;
export const NS_MIN_FLOOR = 0.0003;
export const NS_OPEN_RATIO = 2.82;
export const NS_CLOSE_RATIO = 2.0;
export const INITIAL_NOISE_FLOOR = 0.005;

/** Map 0-100 UI sensitivity to RMS gate threshold.
 *  0% -> -60 dBFS, 50% -> -40 dBFS, 100% -> -20 dBFS (log/dBFS curve). */
export function sensitivityPctToThreshold(pct: number): number {
  const clamped = Math.max(0, Math.min(100, pct));
  const dbfs = -60 + (clamped / 100) * 40;
  return Math.pow(10, dbfs / 20);
}

/** Inverse: map a measured RMS back to 0-100% on the same log curve.
 *  Below -60 dBFS -> 0%. Above -20 dBFS -> 100%. */
export function thresholdToSensitivityPct(rms: number): number {
  if (rms <= 0) return 0;
  const dbfs = 20 * Math.log10(rms);
  if (dbfs <= -60) return 0;
  if (dbfs >= -20) return 100;
  return ((dbfs + 60) / 40) * 100;
}

export interface MicProcessingNodes {
  sourceNode: MediaStreamAudioSourceNode;
  hpf: BiquadFilterNode;
  compressor: DynamicsCompressorNode;
  analyser: AnalyserNode;
  gainNode: GainNode;
  limiter: DynamicsCompressorNode;
  destination: MediaStreamAudioDestinationNode;
  /** Mutates hpf.frequency + compressor.threshold/ratio per noise-suppression
   *  level string. Safe to call whenever settings change. */
  applyNodeParams: (noiseSuppressionLevel: string) => void;
}

export function buildMicProcessingChain(
  ctx: AudioContext,
  rawStream: MediaStream,
  initialNoiseSuppressionLevel: string,
): MicProcessingNodes | null {
  if (rawStream.getAudioTracks().length === 0) return null;
  try {
    const sourceNode = ctx.createMediaStreamSource(rawStream);
    const hpf = ctx.createBiquadFilter();
    hpf.Q.value = 0.7;
    const compressor = ctx.createDynamicsCompressor();
    compressor.knee.value = 30;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.25;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    const gainNode = ctx.createGain();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = LIMITER_THRESHOLD;
    limiter.knee.value = LIMITER_KNEE;
    limiter.ratio.value = LIMITER_RATIO;
    limiter.attack.value = LIMITER_ATTACK;
    limiter.release.value = LIMITER_RELEASE;
    const destination = ctx.createMediaStreamDestination();
    sourceNode.connect(hpf);
    hpf.connect(compressor);
    compressor.connect(analyser);
    analyser.connect(gainNode);
    gainNode.connect(limiter);
    limiter.connect(destination);

    const applyNodeParams = (noiseSuppressionLevel: string): void => {
      const freq = NS_HPF_FREQ[noiseSuppressionLevel] ?? 80;
      hpf.type = freq > 0 ? 'highpass' : 'allpass';
      hpf.frequency.value = freq > 0 ? freq : 10;
      compressor.threshold.value = NS_COMP_THRESH[noiseSuppressionLevel] ?? -24;
      compressor.ratio.value = NS_COMP_RATIO[noiseSuppressionLevel] ?? 4;
    };

    applyNodeParams(initialNoiseSuppressionLevel);

    return { sourceNode, hpf, compressor, analyser, gainNode, limiter, destination, applyNodeParams };
  } catch {
    return null;
  }
}

/** Lazy-load the denoiser worklet for the given engine. Returns null for 'off'
 *  or on load failure. */
export async function createDenoiserNode(
  ctx: AudioContext,
  engine: NoiseEngine,
): Promise<AudioWorkletNode | null> {
  if (engine === 'off') return null;
  if (engine === 'rnnoise' && rnnoiseSupported()) {
    return createRnnoiseNode(ctx);
  }
  if ((engine === 'dfn3-light' || engine === 'dfn3-max') && dfn3Supported()) {
    return createDfn3Node(ctx, engine === 'dfn3-max' ? 'max' : 'light');
  }
  return null;
}

/** Tear down a denoiser node, dispatching to the correct destroy function. */
export function destroyDenoiserNode(node: AudioWorkletNode, engine: NoiseEngine): void {
  if (engine === 'rnnoise') destroyRnnoiseNode(node);
  else destroyDfn3Node(node);
}
