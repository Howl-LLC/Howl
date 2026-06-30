// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * DeepFilterNet 3 AudioWorklet helper.
 *
 * Lazily creates and initializes a `DeepFilterNet3Core` per AudioContext and
 * returns the `AudioWorkletNode` it produces — drop-in replacement for
 * `rnnoiseNode.ts` in the voice mic-processing chain. Used when
 * `noiseEngine === 'dfn3-light'` or `'dfn3-max'`.
 *
 * Architecture:
 *
 *   `deepfilternet3-noise-filter` (Apache-2.0 OR MIT) wraps the Rust
 *   `deep_filter` crate compiled to WASM. It ships a pre-built
 *   AudioWorkletProcessor inlined in the bundle as a blob URL — no worklet
 *   file to host. The WASM binary + ONNX model archive are fetched from the
 *   configured CDN at init time. We self-host them under `/models/dfn3/` so
 *   the browser doesn't call out to a third-party CDN at runtime (policy:
 *   no silent third-party CDN deps).
 *
 * Variants map to suppression aggressiveness, not to separate models — the
 * underlying DFN3 network is the same. Users pick based on how aggressive
 * they want noise removal to be:
 *   - 'light' → atten_lim ≈ 60 dB  — natural voice, pleasant background cut
 *   - 'max'   → atten_lim ≈ 100 dB — aggressive, cuts everything non-speech
 *
 * Per-context cores are cached: re-enabling DFN3 within the same call
 * reuses the already-initialized WASM + model (~17 MB combined download
 * only happens once per session).
 */

import { DeepFilterNet3Core } from 'deepfilternet3-noise-filter';

export type Dfn3Variant = 'light' | 'max';

/** Hosted model root. The package appends `v2/pkg/df_bg.wasm` +
 *  `v2/models/DeepFilterNet3_onnx.tar.gz` to this base. Files live under
 *  `public/models/dfn3/v2/…` and ship in the dist bundle. */
const DFN3_CDN_URL = '/models/dfn3';

/** Suppression level (0-100) per variant. Maps to the WASM's `atten_lim`
 *  parameter in dB — higher = more aggressive noise reduction. */
function suppressionLevelFor(variant: Dfn3Variant): number {
  return variant === 'max' ? 100 : 60;
}

interface CoreSlot {
  core: DeepFilterNet3Core;
  initPromise: Promise<void>;
  variant: Dfn3Variant;
}

/** One initialized core per AudioContext. The core loads WASM + model on
 *  first use; subsequent variant changes within the same context just
 *  update the suppression level in-place without reloading. */
const coreSlots = new WeakMap<AudioContext, CoreSlot>();

/** Returns true if the environment can host DFN3 — AudioWorklet + WASM +
 *  fetch for the asset download. */
export function dfn3Supported(): boolean {
  try {
    return (
      typeof AudioWorkletNode !== 'undefined' &&
      typeof WebAssembly !== 'undefined' &&
      typeof fetch === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * Create an `AudioWorkletNode` running DFN3. 1-in/1-out mono, 48 kHz. The
 * returned node is owned by the caller — `destroyDfn3Node(node)` releases
 * the WASM state.
 *
 * Throws if initialization fails (WASM fetch error, model parse error,
 * worklet registration error). Callers should fall back to the non-denoised
 * path on error.
 */
export async function createDfn3Node(
  ctx: AudioContext,
  variant: Dfn3Variant,
): Promise<AudioWorkletNode> {
  let slot = coreSlots.get(ctx);
  if (!slot) {
    const core = new DeepFilterNet3Core({
      sampleRate: ctx.sampleRate || 48000,
      noiseReductionLevel: suppressionLevelFor(variant),
      assetConfig: { cdnUrl: DFN3_CDN_URL },
    });
    const initPromise = core.initialize().catch((err) => {
      // Invalidate the slot on failure so a retry (e.g. user toggles off
      // then on) gets a fresh initialization attempt instead of a cached
      // rejected promise.
      coreSlots.delete(ctx);
      throw err;
    });
    slot = { core, initPromise, variant };
    coreSlots.set(ctx, slot);
  } else if (slot.variant !== variant) {
    // Same context, variant changed — adjust suppression in place once
    // init finishes. Cheaper than rebuilding the worklet.
    slot.variant = variant;
    slot.initPromise.then(() => {
      try { slot!.core.setSuppressionLevel(suppressionLevelFor(variant)); } catch { /* */ }
    });
  }

  await slot.initPromise;
  return slot.core.createAudioWorkletNode(ctx);
}

/** Tear down the DFN3 worklet + WASM state. Idempotent. */
export function destroyDfn3Node(node: AudioWorkletNode): void {
  // Disconnect first — the AudioContext's graph holds a reference, and we
  // want playback to stop before freeing WASM memory.
  try { node.disconnect(); } catch { /* already disconnected */ }
  // Find the core that owns this node via the shared context. The package
  // tracks one worklet per core, so destroying the core releases it.
  const ctx = node.context as AudioContext;
  const slot = coreSlots.get(ctx);
  if (slot) {
    coreSlots.delete(ctx);
    try { slot.core.destroy(); } catch { /* best-effort */ }
  }
}
