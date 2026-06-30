// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { selectSframeDialect, intersectSframeDialects, isSupportedKeyFormat } from '../services/peerDialects';

describe('selectSframeDialect', () => {
  it('returns sframe.v1 when both sides only support v1', () => {
    expect(selectSframeDialect(['sframe.v1'], ['sframe.v1'])).toBe('sframe.v1');
  });
  it('returns highest mutually supported version', () => {
    expect(selectSframeDialect(['sframe.v1', 'sframe.v2'], ['sframe.v1', 'sframe.v2'])).toBe('sframe.v2');
  });
  it('falls back to v1 when peer has no sframe caps', () => {
    expect(selectSframeDialect(['sframe.v1', 'sframe.v2'], [])).toBe('sframe.v1');
  });
  it('falls back to v1 when peer is null/undefined', () => {
    expect(selectSframeDialect(['sframe.v1'], undefined)).toBe('sframe.v1');
    expect(selectSframeDialect(['sframe.v1'], null)).toBe('sframe.v1');
  });
  it('picks highest common when self has v2+ but peer only v1', () => {
    expect(selectSframeDialect(['sframe.v1', 'sframe.v2'], ['sframe.v1'])).toBe('sframe.v1');
  });
  it('rejects zero, negative, and malformed sframe versions (falls back to v1)', () => {
    expect(selectSframeDialect(['sframe.v0'], ['sframe.v0'])).toBe('sframe.v1');
    expect(selectSframeDialect(['sframe.v-1'], ['sframe.v-1'])).toBe('sframe.v1');
    expect(selectSframeDialect(['sframe.vABC'], ['sframe.vABC'])).toBe('sframe.v1');
    expect(selectSframeDialect(['sframe.v'], ['sframe.v'])).toBe('sframe.v1');
  });
});

describe('intersectSframeDialects', () => {
  it('returns v1 for single participant with v1 only', () => {
    expect(intersectSframeDialects([['sframe.v1']])).toBe('sframe.v1');
  });
  it('returns highest common across all participants', () => {
    expect(intersectSframeDialects([
      ['sframe.v1', 'sframe.v2'],
      ['sframe.v1', 'sframe.v2'],
      ['sframe.v1'],
    ])).toBe('sframe.v1');
  });
  it('falls back to v1 when no overlap', () => {
    expect(intersectSframeDialects([['sframe.v2'], ['sframe.v3']])).toBe('sframe.v1');
  });
  it('rejects zero/negative versions', () => {
    expect(intersectSframeDialects([['sframe.v0'], ['sframe.v0']])).toBe('sframe.v1');
    expect(intersectSframeDialects([['sframe.v-1'], ['sframe.v-1']])).toBe('sframe.v1');
  });
});

describe('isSupportedKeyFormat', () => {
  it('accepts sframe.v1', () => {
    expect(isSupportedKeyFormat('sframe.v1')).toBe(true);
  });
  it('accepts undefined (legacy default)', () => {
    expect(isSupportedKeyFormat(undefined)).toBe(true);
  });
  it('rejects unknown dialect', () => {
    expect(isSupportedKeyFormat('sframe.v2')).toBe(false);
    expect(isSupportedKeyFormat('sframe.v99')).toBe(false);
    expect(isSupportedKeyFormat('aes-gcm.v1')).toBe(false);
    expect(isSupportedKeyFormat('')).toBe(false);
  });
});
