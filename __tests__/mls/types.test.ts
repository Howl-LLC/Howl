// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import {
  encodeMlsEnvelope,
  tryParseMlsEnvelope,
  isMlsEnvelopeV4,
  MLS_ENVELOPE_VERSION,
} from '../../services/mls/types';

describe('mls v4 envelope codec', () => {
  it('round-trips MLSMessage bytes through encode -> tryParse', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 42]);
    const content = encodeMlsEnvelope(bytes);
    const parsed = tryParseMlsEnvelope(content);
    expect(parsed).not.toBeNull();
    expect(Array.from(parsed!)).toEqual(Array.from(bytes));
  });

  it('produces a v:4 JSON envelope with base64 m', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const content = encodeMlsEnvelope(bytes);
    const obj = JSON.parse(content);
    expect(obj.v).toBe(MLS_ENVELOPE_VERSION);
    expect(obj.v).toBe(4);
    // btoa of [1,2,3] is 'AQID'
    expect(obj.m).toBe('AQID');
  });

  it('round-trips an empty payload', () => {
    const content = encodeMlsEnvelope(new Uint8Array(0));
    const parsed = tryParseMlsEnvelope(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(0);
  });

  it('isMlsEnvelopeV4 is true for a v4 envelope, false otherwise', () => {
    expect(isMlsEnvelopeV4(encodeMlsEnvelope(new Uint8Array([9])))).toBe(true);
    expect(isMlsEnvelopeV4(JSON.stringify({ v: 2, ct: 'x', iv: 'y' }))).toBe(false);
    expect(isMlsEnvelopeV4(JSON.stringify({ v: 3, ct: 'x', iv: 'y', mid: 'm' }))).toBe(false);
    expect(isMlsEnvelopeV4('not json at all')).toBe(false);
  });

  it('tryParseMlsEnvelope returns null for v2, v3, and garbage', () => {
    expect(tryParseMlsEnvelope(JSON.stringify({ v: 2, ct: 'x', iv: 'y' }))).toBeNull();
    expect(tryParseMlsEnvelope(JSON.stringify({ v: 3, ct: 'x', iv: 'y', mid: 'm' }))).toBeNull();
    expect(tryParseMlsEnvelope('plain text message')).toBeNull();
    expect(tryParseMlsEnvelope('')).toBeNull();
  });

  it('tryParseMlsEnvelope rejects a v:4 envelope missing or mistyped m', () => {
    expect(tryParseMlsEnvelope(JSON.stringify({ v: 4 }))).toBeNull();
    expect(tryParseMlsEnvelope(JSON.stringify({ v: 4, m: 123 }))).toBeNull();
  });

  it('tryParseMlsEnvelope rejects a v:4 envelope whose m is not valid base64', () => {
    // '!' is outside the base64 alphabet; atob throws, codec must swallow -> null.
    expect(tryParseMlsEnvelope(JSON.stringify({ v: 4, m: '!!!!' }))).toBeNull();
  });
});
