// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { ExternalE2EEKeyProvider } from 'livekit-client';

/**
 * Thin LiveKit key-provider subclass adding an explicit keyring index.
 *
 * Voice channels, stages, and legacy DM calls keep calling the inherited
 * single-arg setKey (always index 0) and are byte-identical to today. The
 * MLS DM-call path installs the exporter-derived base key at
 * epochKeyIndex(epoch) so prior-epoch keys stay in the 16-slot keyring for
 * in-flight frames across a Commit (the DAVE-style overlap).
 *
 * livekit-client is lazy-loaded by CallEngine, so the subclass is produced
 * by a factory that takes the loaded class. The one-line HKDF importKey
 * mirrors livekit's exported createKeyMaterialFromBuffer; it is replicated
 * (not imported) so this module carries no value imports from the
 * lazy-loaded package. The upgrade canary test pins the real provider's
 * behavior against drift.
 */

export interface HowlSframeKeyProvider extends ExternalE2EEKeyProvider {
  setKeyAtIndex(key: ArrayBuffer, index: number): Promise<void>;
}

/** Epoch to LiveKit keyring slot; keyringSize is the LiveKit default 16. */
export function epochKeyIndex(epoch: bigint): number {
  return Number(epoch % 16n);
}

export function makeHowlSframeKeyProvider(Base: typeof ExternalE2EEKeyProvider): new () => HowlSframeKeyProvider {
  class Howl extends Base {
    async setKeyAtIndex(key: ArrayBuffer, index: number): Promise<void> {
      const material = await crypto.subtle.importKey('raw', key, 'HKDF', false, ['deriveBits', 'deriveKey']);
      // onSetEncryptionKey is protected on BaseKeyProvider; with sharedKey
      // mode (hardcoded by ExternalE2EEKeyProvider) participantIdentity is
      // omitted and the key lands at "shared-<index>".
      this.onSetEncryptionKey(material, undefined, index);
    }
  }
  return Howl;
}

/**
 * Shared install helper for CallEngine's three install sites (post-connect,
 * reconnect re-inject, runtime set). index null = the legacy/voice/stage
 * index-0 setKey path; a number = the MLS epoch-indexed path. Slices the
 * exact byte range so Uint8Array views over larger buffers install correctly.
 */
export async function installKey(provider: HowlSframeKeyProvider, key: Uint8Array, index: number | null): Promise<void> {
  const ab = (key.buffer as ArrayBuffer).slice(key.byteOffset, key.byteOffset + key.byteLength);
  if (index !== null) {
    await provider.setKeyAtIndex(ab, index);
  } else {
    await provider.setKey(ab);
  }
  // Zero the transient slice. Safe: both provider paths synchronously copy
  // the bytes via crypto.subtle.importKey('raw', ...) before returning.
  new Uint8Array(ab).fill(0);
}

/**
 * Serializes key installs so two in-flight installs cannot resolve their
 * HKDF imports out of call order (the last caller also installs last).
 * Two in-flight installs (legacy downgrade vs MLS rekey, or either racing
 * the reconnect re-inject) could otherwise leave the worker's active
 * encrypt slot behind the recorded (key, index) pair.
 */
export function makeInstallQueue(): { enqueue(provider: HowlSframeKeyProvider, key: Uint8Array, index: number | null): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    enqueue(provider, key, index) {
      const next = chain.then(() => installKey(provider, key, index));
      chain = next.catch(() => {}); // keep the chain alive past a failed install
      return next;
    },
  };
}
