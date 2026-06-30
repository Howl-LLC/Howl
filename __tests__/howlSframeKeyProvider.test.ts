// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, vi } from 'vitest';
import {
  epochKeyIndex,
  makeHowlSframeKeyProvider,
  makeInstallQueue,
  installKey,
  type HowlSframeKeyProvider,
} from '../services/call/HowlSframeKeyProvider';
import type { ExternalE2EEKeyProvider } from 'livekit-client';
import { ExternalE2EEKeyProvider as RealExternalE2EEKeyProvider } from 'livekit-client';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});

/** Fake base capturing protected-hook calls; mirrors ExternalE2EEKeyProvider's surface.
 *  setKey snapshots BYTES at call time rather than holding the ArrayBuffer
 *  reference: installKey zeroizes its transient slice after the provider call
 *  resolves, and the real provider copies the bytes (crypto.subtle.importKey)
 *  before returning, so call-time snapshots are the faithful observation. */
class FakeBase {
  onSetCalls: Array<{ key: CryptoKey; participantIdentity?: string; keyIndex?: number }> = [];
  setKeyCalls: number[][] = [];
  protected onSetEncryptionKey(key: CryptoKey, participantIdentity?: string, keyIndex?: number): void {
    this.onSetCalls.push({ key, participantIdentity, keyIndex });
  }
  async setKey(key: string | ArrayBuffer): Promise<void> {
    this.setKeyCalls.push(Array.from(new Uint8Array(key as ArrayBuffer)));
  }
}

function makeProvider(): HowlSframeKeyProvider & FakeBase {
  const Ctor = makeHowlSframeKeyProvider(FakeBase as unknown as typeof ExternalE2EEKeyProvider);
  return new Ctor() as unknown as HowlSframeKeyProvider & FakeBase;
}

/** Spies crypto.subtle.importKey, snapshotting the raw key BYTES at call time
 *  (installKey zeroizes its slice after the provider call, so post-hoc reads
 *  of the reference would lie), then calls through. Restore via .restore(). */
function spyImportKeyBytes(): { recorded: number[][]; restore: () => void } {
  const original = crypto.subtle.importKey.bind(crypto.subtle);
  const recorded: number[][] = [];
  const spy = vi.spyOn(crypto.subtle, 'importKey').mockImplementation(((...args: Parameters<SubtleCrypto['importKey']>) => {
    const raw = args[1];
    const bytes = raw instanceof ArrayBuffer
      ? new Uint8Array(raw.slice(0))
      : new Uint8Array((raw as ArrayBufferView).buffer.slice((raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteOffset + (raw as ArrayBufferView).byteLength));
    recorded.push(Array.from(bytes));
    return original(...args);
  }) as SubtleCrypto['importKey']);
  return { recorded, restore: () => spy.mockRestore() };
}

describe('epochKeyIndex', () => {
  it('maps epoch to the 16-slot keyring (RFC 9605 5.2 low-order bits)', () => {
    expect(epochKeyIndex(0n)).toBe(0);
    expect(epochKeyIndex(5n)).toBe(5);
    expect(epochKeyIndex(15n)).toBe(15);
    expect(epochKeyIndex(16n)).toBe(0);  // wrap: same low-order bits replace the old epoch
    expect(epochKeyIndex(17n)).toBe(1);
    expect(epochKeyIndex(35n)).toBe(3);
  });
});

describe('HowlSframeKeyProvider.setKeyAtIndex', () => {
  it('derives HKDF key material and installs at the explicit index via onSetEncryptionKey', async () => {
    const p = makeProvider();
    const key = new Uint8Array(32).fill(7);
    const importSpy = spyImportKeyBytes();
    try {
      await p.setKeyAtIndex(key.buffer as ArrayBuffer, 5);
      // Key-material fidelity: the HKDF import must receive the installed
      // key's exact bytes (an all-zero or truncated import would otherwise
      // pass every structural assertion below).
      expect(importSpy.recorded).toEqual([new Array(32).fill(7)]);
    } finally {
      importSpy.restore();
    }
    expect(p.onSetCalls).toHaveLength(1);
    expect(p.onSetCalls[0].participantIdentity).toBeUndefined(); // sharedKey mode
    expect(p.onSetCalls[0].keyIndex).toBe(5);
    expect(p.onSetCalls[0].key.type).toBe('secret'); // HKDF raw import
    expect(p.setKeyCalls).toHaveLength(0); // does not route through index-0 setKey
  });

  it('inherits setKey untouched (index-0 voice/stage/legacy path is the base implementation)', async () => {
    const p = makeProvider();
    const ab = new Uint8Array(32).fill(9).buffer as ArrayBuffer;
    await p.setKey(ab);
    expect(p.setKeyCalls).toEqual([new Array(32).fill(9)]);
    expect(p.onSetCalls).toHaveLength(0);
  });
});

describe('installKey', () => {
  it('routes index null to setKey (legacy path) and a number to setKeyAtIndex, slicing the exact view', async () => {
    const p = makeProvider();
    // A view into a larger buffer: the slice must cover only the view's bytes.
    const backing = new Uint8Array(64);
    backing.set(new Uint8Array(32).fill(0xee), 16);
    const view = new Uint8Array(backing.buffer, 16, 32);

    await installKey(p, view, null);
    expect(p.setKeyCalls).toHaveLength(1);
    expect(p.setKeyCalls[0]).toEqual(new Array(32).fill(0xee));

    await installKey(p, view, 3);
    expect(p.onSetCalls).toHaveLength(1);
    expect(p.onSetCalls[0].keyIndex).toBe(3);
  });

  it('indexed install of a view over a larger buffer feeds the HKDF import the exact slice bytes', async () => {
    const p = makeProvider();
    const backing = new Uint8Array(64);
    backing.set(new Uint8Array(32).fill(0xcc), 16);
    const view = new Uint8Array(backing.buffer, 16, 32);

    const importSpy = spyImportKeyBytes();
    try {
      await installKey(p, view, 3);
      // Exact-slice fidelity on the INDEXED branch (mirrors the index-null
      // slice test above): neither the 16 leading nor 16 trailing backing
      // bytes may leak into the imported key material.
      expect(importSpy.recorded).toEqual([new Array(32).fill(0xcc)]);
    } finally {
      importSpy.restore();
    }
    expect(p.onSetCalls).toHaveLength(1);
    expect(p.onSetCalls[0].keyIndex).toBe(3);
  });
});

describe('makeInstallQueue', () => {
  function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: unknown) => void } {
    let resolve!: () => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  /** Fake provider whose install calls record invocation order and whose
   *  FIRST call is a manually-controlled deferred. Pins the serialization
   *  contract: out-of-order resolution cannot reorder installs. */
  function makeDeferredProvider() {
    const order: Array<{ index: number | null; bytes: number[] }> = [];
    const first = deferred();
    let calls = 0;
    const provider = {
      setKeyAtIndex(key: ArrayBuffer, index: number): Promise<void> {
        order.push({ index, bytes: Array.from(new Uint8Array(key)) });
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve();
      },
      setKey(key: string | ArrayBuffer): Promise<void> {
        order.push({ index: null, bytes: Array.from(new Uint8Array(key as ArrayBuffer)) });
        calls += 1;
        return calls === 1 ? first.promise : Promise.resolve();
      },
    } as unknown as HowlSframeKeyProvider;
    return { provider, order, first };
  }

  it('a slow first install cannot be overtaken by a fast second (provider sees call order)', async () => {
    const { provider, order, first } = makeDeferredProvider();
    const queue = makeInstallQueue();

    const p1 = queue.enqueue(provider, new Uint8Array(32).fill(1), 5);
    const p2 = queue.enqueue(provider, new Uint8Array(32).fill(2), 0);

    // Drain a macrotask: the second install must not have STARTED while the
    // first is still in flight, even though the second would resolve
    // immediately if it ran.
    await new Promise((r) => setTimeout(r, 0));
    expect(order).toHaveLength(1);
    expect(order[0]).toEqual({ index: 5, bytes: new Array(32).fill(1) });

    first.resolve();
    await p1;
    await p2;
    expect(order).toHaveLength(2);
    expect(order[1]).toEqual({ index: 0, bytes: new Array(32).fill(2) });
  });

  it('routes index null through the legacy setKey path in queue order too', async () => {
    const { provider, order, first } = makeDeferredProvider();
    const queue = makeInstallQueue();

    const p1 = queue.enqueue(provider, new Uint8Array(32).fill(3), 7);
    const p2 = queue.enqueue(provider, new Uint8Array(32).fill(4), null);

    await new Promise((r) => setTimeout(r, 0));
    expect(order).toHaveLength(1);

    first.resolve();
    await p1;
    await p2;
    expect(order.map((o) => o.index)).toEqual([7, null]);
  });

  it('keeps the chain alive past a failed install; the caller still observes the failure', async () => {
    const { provider, order, first } = makeDeferredProvider();
    const queue = makeInstallQueue();

    const p1 = queue.enqueue(provider, new Uint8Array(32).fill(5), 1);
    const p2 = queue.enqueue(provider, new Uint8Array(32).fill(6), 2);

    const p1Rejects = expect(p1).rejects.toThrow('install failed');
    first.reject(new Error('install failed'));
    await p1Rejects;

    await p2; // second install still runs after the first failed
    expect(order.map((o) => o.index)).toEqual([1, 2]);
  });
});

describe('upgrade canary: real ExternalE2EEKeyProvider', () => {
  // Pins the livekit-client behavior the module relies on. If an upgrade
  // changes the shared-slot semantics, the keyring default the hardcoded
  // 16n mirrors, or the protected hook's bookkeeping, this fails loudly.
  it('indexed install lands in the shared key map and ring assumptions hold', async () => {
    const Ctor = makeHowlSframeKeyProvider(RealExternalE2EEKeyProvider);
    const p = new Ctor();
    expect(p.getOptions().sharedKey).toBe(true);
    expect(p.getOptions().keyringSize).toBe(16); // epochKeyIndex's 16n
    expect(p.getOptions().ratchetWindowSize).toBe(0);
    expect(p.getOptions().failureTolerance).toBe(-1);
    await p.setKeyAtIndex(new Uint8Array(32).fill(1).buffer as ArrayBuffer, 5);
    const keys = p.getKeys();
    expect(keys.some((k) => k.keyIndex === 5 && k.participantIdentity === undefined)).toBe(true);
    expect(p.getLatestManuallySetKeyIndex()).toBe(5);
  });

  // Pins the slot-reclaim semantics CallEngine's legacy-downgrade path relies
  // on: the base setKey path emits its SetKey event WITHOUT an explicit index
  // (updateCurrentKeyIndex=false), so the e2ee worker never moves its encrypt
  // slot back; only an indexed install moves it. After an MLS epoch-indexed
  // install, the downgrade therefore claims slot 0 via setKeyAtIndex(key, 0),
  // and the prior epoch slot must survive in the keyring (DAVE-style overlap
  // for in-flight frames).
  it('an indexed install at slot 0 reclaims the latest-set index and keeps the prior slot', async () => {
    const Ctor = makeHowlSframeKeyProvider(RealExternalE2EEKeyProvider);
    const p = new Ctor();
    const k1 = new Uint8Array(32).fill(1).buffer as ArrayBuffer;
    const k2 = new Uint8Array(32).fill(2).buffer as ArrayBuffer;
    await p.setKeyAtIndex(k1, 5);
    expect(p.getLatestManuallySetKeyIndex()).toBe(5);
    await p.setKeyAtIndex(k2, 0);
    expect(p.getLatestManuallySetKeyIndex()).toBe(0);
    const keys = p.getKeys();
    expect(keys.some((k) => k.keyIndex === 5 && k.participantIdentity === undefined)).toBe(true);
    expect(keys.some((k) => k.keyIndex === 0 && k.participantIdentity === undefined)).toBe(true);
  });
});
