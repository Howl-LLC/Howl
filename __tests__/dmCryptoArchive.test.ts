// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { sealArchiveRow, openArchiveRow } from '../services/dmCrypto';
import { fromBase64 } from '../services/cryptoHelpers';

/** v2 archive seal takes the RAW archiveKey bytes (HKDF needs the IKM); the IV is
 *  derived deterministically, and the epoch is bound into the AAD. */
function key(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}
const aad = { userId: 'u1', dmChannelId: 'c1', messageId: 'm1', envelopeHash: 'abcd', archiveEpoch: 1 };

describe('archive seal/open (v2: deterministic IV + epoch-bound AAD)', () => {
  it('round-trips plaintext', async () => {
    const k = key();
    const ct = await sealArchiveRow(k, 'hello world', aad);
    expect(await openArchiveRow(k, ct, aad)).toBe('hello world');
  });

  it('is deterministic: two seals of identical (key, plaintext, aad) are byte-identical', async () => {
    const k = key();
    expect(await sealArchiveRow(k, 'x', aad)).toBe(await sealArchiveRow(k, 'x', aad));
  });

  it('derives distinct IVs across rows: different messageId/envelopeHash → different ciphertext', async () => {
    const k = key();
    const a = await sealArchiveRow(k, 'x', aad);
    const b = await sealArchiveRow(k, 'x', { ...aad, messageId: 'm2' });
    const c = await sealArchiveRow(k, 'x', { ...aad, envelopeHash: 'ef01' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
  });

  it('stores no 12-byte IV prefix (blob == ciphertext + 16-byte GCM tag)', async () => {
    const k = key();
    const ct = await sealArchiveRow(k, 'hello', aad); // 5 plaintext bytes
    expect(fromBase64(ct).length).toBe(5 + 16);
  });

  it('rejects a mutated AAD field incl. the epoch (anti-splice + anti-downgrade)', async () => {
    const k = key();
    const ct = await sealArchiveRow(k, 'secret', aad);
    await expect(openArchiveRow(k, ct, { ...aad, messageId: 'm2' })).rejects.toThrow();
    await expect(openArchiveRow(k, ct, { ...aad, dmChannelId: 'c2' })).rejects.toThrow();
    await expect(openArchiveRow(k, ct, { ...aad, envelopeHash: 'beef' })).rejects.toThrow();
    await expect(openArchiveRow(k, ct, { ...aad, archiveEpoch: 2 })).rejects.toThrow();
  });

  it('rejects opening under a different key', async () => {
    const ct = await sealArchiveRow(key(), 'secret', aad);
    await expect(openArchiveRow(key(), ct, aad)).rejects.toThrow();
  });
});
