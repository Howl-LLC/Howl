// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { logger } from '../services/logger';

describe('services/logger', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('logger.warn delegates to console.error so it survives Vite tree-shaking', () => {
    logger.warn('test warning', { key: 'val' });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('[WARN]');
    expect(errorSpy.mock.calls[0][0]).toContain('test warning');
    expect(errorSpy.mock.calls[0][1]).toEqual({ key: 'val' });
  });

  it('logger.error delegates to console.error without [WARN] prefix', () => {
    logger.error('test error', { channelId: '123' });
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).not.toContain('[WARN]');
    expect(errorSpy.mock.calls[0][0]).toContain('test error');
    expect(errorSpy.mock.calls[0][1]).toEqual({ channelId: '123' });
  });

  it('logger.warn works without meta argument', () => {
    logger.warn('no meta');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy.mock.calls[0][0]).toContain('no meta');
  });

  it('logger.warn uses console.error (not console.warn) which Vite pure list does NOT strip', () => {
    // This test validates the fundamental design choice: logger.warn must NOT
    // call console.warn (stripped in prod). It must call console.error.
    // We verify by checking that the spy on console.error is the one that fires.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logger.warn('test');
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledOnce();
    warnSpy.mockRestore();
  });
});
