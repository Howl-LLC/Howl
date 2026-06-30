// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * RNNoise AudioWorklet helper.
 *
 * Lazily loads the RNNoise AudioWorklet module and exposes a factory for
 * `AudioWorkletNode` instances backed by the worklet. Used by the voice
 * mic-processing chain when "Advanced noise suppression" is enabled.
 *
 * Loading only happens on the first call — module add is cached per
 * `AudioContext`. If the load fails (WASM error, network error, unsupported
 * environment), subsequent calls throw immediately so callers can fall back
 * to the non-denoised path.
 */

const WORKLET_URL = '/rnnoise-worklet.js';

const loadedContexts = new WeakMap<AudioContext, Promise<void>>();

/** Add the RNNoise worklet module to the given context exactly once. */
function ensureWorkletLoaded(ctx: AudioContext): Promise<void> {
  const existing = loadedContexts.get(ctx);
  if (existing) return existing;
  const p = ctx.audioWorklet.addModule(WORKLET_URL).catch((err) => {
    loadedContexts.delete(ctx);
    throw err;
  });
  loadedContexts.set(ctx, p);
  return p;
}

/** Returns true if the browser supports AudioWorklet + WebAssembly at all. */
export function rnnoiseSupported(): boolean {
  try {
    return typeof AudioWorkletNode !== 'undefined' && typeof WebAssembly !== 'undefined';
  } catch {
    return false;
  }
}

/**
 * Create an `AudioWorkletNode` running RNNoise. The node is a 1-in/1-out
 * mono processor that expects 48 kHz input and outputs denoised audio at
 * the same rate. For best quality make sure the upstream `AudioContext`
 * is at 48 kHz (it is by default on Chromium in a voice getUserMedia
 * session).
 *
 * Throws if the worklet fails to load. Callers should fall back to the
 * non-denoised path on error.
 */
export async function createRnnoiseNode(ctx: AudioContext): Promise<AudioWorkletNode> {
  await ensureWorkletLoaded(ctx);
  return new AudioWorkletNode(ctx, 'rnnoise-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
  });
}

/** Tell the worklet to free its RNNoise state. Always safe to call. */
export function destroyRnnoiseNode(node: AudioWorkletNode): void {
  try { node.port.postMessage({ cmd: 'destroy' }); } catch { /* node already gone */ }
  try { node.disconnect(); } catch { /* already disconnected */ }
}
