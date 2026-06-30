// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * File attachments round-trip on an MLS channel; the wire carries only the v4
 * MLS envelope, never the plaintext file key or caption.
 *
 * Verifies:
 *   - encryptAndUploadFile works on an mls channel (no per-channel AES key) and
 *     the uploaded object is ciphertext (fileCrypto HWL3 chunked output, longer
 *     than the plaintext), and fetchAndDecryptFile(url, key) recovers the bytes.
 *   - encryptDMContent of a {text,file:{...,key}} plaintext on an mls channel
 *     yields a v4 envelope whose wire string contains NEITHER the plaintext file
 *     key NOR the caption (only {v,m}).
 *   - receive: a v4-sealed file envelope through decryptSingleDMMessage surfaces
 *     content=caption, attachmentUrl, _encryptedFileKey.
 *   - receive: a v4-sealed file envelope with EMPTY caption through
 *     decryptDMMessages surfaces content='' AND attachmentUrl/_encryptedFileKey
 *     (the attachment is surfaced via fields, not lost).
 *
 * mlsCoordinator is mocked to seal the plaintext into a v4 envelope by base64ing
 * it inside `m` (the point is that the plaintext key is not a top-level wire
 * field and the legacy AES key path is bypassed). dmKeyManager returns NO
 * per-channel key for the mls channel. encryptionFlags is the REAL module so the
 * 'mls' ratchet drives protocol selection. fileCrypto is REAL.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Message } from '../types';

// capture uploaded ciphertext
let uploadedBlob: Blob | null = null;
let uploadCounter = 0;
vi.mock('../services/api', () => ({
  apiClient: {
    uploadEncryptedFile: vi.fn(async (blob: Blob, _name: string) => {
      uploadedBlob = blob;
      uploadCounter += 1;
      return { url: `/api/uploads/enc-${uploadCounter}.enc` };
    }),
  },
}));

// MLS coordinator: seal {text,file} into a v4 envelope; decrypt reverses
const sealedPlaintexts: string[] = [];
vi.mock('../services/mls/mlsCoordinator', () => ({
  encrypt: vi.fn(async (_id: string, plaintext: string) => {
    sealedPlaintexts.push(plaintext);
    return JSON.stringify({ v: 4, m: btoa(plaintext) });
  }),
  decrypt: vi.fn(async (_id: string, envelope: string) => {
    const { m } = JSON.parse(envelope) as { m: string };
    return atob(m);
  }),
  isReadyForChannel: vi.fn(() => true),
  isActive: vi.fn(() => true),
  activate: vi.fn(),
  deactivate: vi.fn(),
}));

// dmKeyManager: MLS channel has NO per-channel AES key
vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: () => true,
  getChannelKey: () => null, // mls channels never have one
  getChannelKeyEntries: () => [],
  on: vi.fn(),
  isSetup: () => true,
}));

import {
  encryptAndUploadFile,
  fetchAndDecryptFile,
  parseE2eeFileEnvelope,
  encryptDMContent,
  decryptSingleDMMessage,
  decryptDMMessages,
  initializeEncryption,
} from '../services/dmEncryption';
import { setChannelProtocol } from '../services/encryptionFlags';

function mkMsg(content: string, overrides: Partial<Message> = {}): Message {
  return {
    id: 'm1',
    content,
    authorId: 'bob',
    type: 'message',
    timestamp: new Date(),
    ...overrides,
  } as Message;
}

beforeEach(() => {
  uploadedBlob = null;
  uploadCounter = 0;
  sealedPlaintexts.length = 0;
  localStorage.clear();
  vi.clearAllMocks();
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    // jsdom lacks WebCrypto — fileCrypto needs it.
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
  initializeEncryption('me');
});

describe('dmEncryption — MLS file attachments', () => {
  it('encrypts + uploads a file on an mls channel; object is ciphertext, round-trips', async () => {
    setChannelProtocol('mls-file', 'mls');

    const plaintextBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const file = new File([plaintextBytes], 'secret.bin', { type: 'application/octet-stream' });

    const meta = await encryptAndUploadFile(file, 'mls-file');
    expect(meta.url).toMatch(/\.enc$/);
    expect(typeof meta.key).toBe('string');
    expect(meta.key.length).toBeGreaterThan(0);

    // The uploaded object must NOT be the plaintext bytes.
    expect(uploadedBlob).not.toBeNull();
    const uploaded = new Uint8Array(await uploadedBlob!.arrayBuffer());
    // chunked-AES (HWL4) output: magic header + longer than the 8 plaintext bytes.
    expect(uploaded.length).toBeGreaterThan(plaintextBytes.length);
    expect(String.fromCharCode(uploaded[0], uploaded[1], uploaded[2], uploaded[3])).toBe('HWL4');

    // fetchAndDecryptFile recovers the plaintext (sender-local cache stashed the File).
    const recovered = await fetchAndDecryptFile(meta.url, meta.key);
    expect(recovered).not.toBeNull();
    const recoveredBytes = new Uint8Array(await recovered!.arrayBuffer());
    expect(Array.from(recoveredBytes)).toEqual(Array.from(plaintextBytes));
  });

  it('the v4 wire envelope contains no plaintext file key or caption', async () => {
    setChannelProtocol('mls-file2', 'mls');

    // This is the exact plaintext sendEncryptedDmMessage builds for a file msg.
    const fileEnvelopePlaintext = JSON.stringify({
      text: 'here is a file',
      file: { url: '/api/uploads/enc-1.enc', key: 'PLAINTEXT_FILE_KEY_BASE64', name: 'secret.bin', type: 'application/octet-stream', size: 8 },
    });

    const { content, encrypted } = await encryptDMContent('mls-file2', fileEnvelopePlaintext);
    expect(encrypted).toBe(true);

    const env = JSON.parse(content);
    expect(env.v).toBe(4);
    expect(Object.keys(env).sort()).toEqual(['m', 'v']); // only v + m, nothing else
    // Neither the plaintext file key nor the caption appears anywhere in the wire string.
    expect(content).not.toContain('PLAINTEXT_FILE_KEY_BASE64');
    expect(content).not.toContain('here is a file');
  });

  it('receive: a v4-sealed file envelope surfaces caption + attachment fields (single)', async () => {
    setChannelProtocol('mls-file3', 'mls');

    const fileEnvelopePlaintext = JSON.stringify({
      text: 'caption',
      file: { url: '/api/uploads/enc-9.enc', key: 'k9', name: 'a.png', type: 'image/png', size: 3 },
    });
    const { content } = await encryptDMContent('mls-file3', fileEnvelopePlaintext);

    const out = await decryptSingleDMMessage('mls-file3', mkMsg(content));

    expect(out.content).toBe('caption');
    expect(out.attachmentUrl).toBe('/api/uploads/enc-9.enc');
    expect(out.attachmentName).toBe('a.png');
    expect(out.attachmentContentType).toBe('image/png');
    expect((out as Message & { _encryptedFileKey?: string })._encryptedFileKey).toBe('k9');

    // sanity: parseE2eeFileEnvelope on the decrypted plaintext finds the file
    const plain = atob(JSON.parse(content).m);
    const parsed = parseE2eeFileEnvelope(plain);
    expect(parsed?.file.key).toBe('k9');
  });

  it('receive: an EMPTY-caption file envelope surfaces content="" + attachment fields (batch)', async () => {
    setChannelProtocol('mls-file4', 'mls');

    const fileEnvelopePlaintext = JSON.stringify({
      text: '',
      file: { url: '/api/uploads/enc-10.enc', key: 'k10', name: 'b.bin', type: 'application/octet-stream', size: 4 },
    });
    const { content } = await encryptDMContent('mls-file4', fileEnvelopePlaintext);

    const out = await decryptDMMessages('mls-file4', [mkMsg(content, { id: 'm2' })], true);

    // Empty caption is correct: the attachment is surfaced via fields, not lost.
    expect(out[0].content).toBe('');
    expect(out[0].attachmentUrl).toBe('/api/uploads/enc-10.enc');
    expect(out[0].attachmentName).toBe('b.bin');
    expect(out[0].attachmentContentType).toBe('application/octet-stream');
    expect((out[0] as Message & { _encryptedFileKey?: string })._encryptedFileKey).toBe('k10');
  });
});
