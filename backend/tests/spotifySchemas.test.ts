// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for the Spotify playback schema wrapping.
 *
 * Pre-fix, the four Spotify playback schemas were declared as
 * `z.object({...}).strict()` without the outer `body:` wrapper that
 * `validate()` middleware expects. `validate()` calls
 * `schema.safeParse({ body, query, params })`, so the top-level `.strict()`
 * rejected `body` / `query` / `params` as unknown keys and every PUT to
 * `/spotify/listen-along`, `/spotify/playback/{play-pause,shuffle,repeat}`
 * returned 400.
 *
 * Post-fix each schema is `z.object({ body: <inner>.strict() })`, matching
 * every other REST body schema in `schemas.ts`.
 */

import { describe, it, expect } from 'vitest';
import {
  listenAlongSchema,
  spotifyPlayPauseSchema,
  spotifyShuffleSchema,
  spotifyRepeatSchema,
} from '../src/schemas.js';

const UUID = '00000000-0000-0000-0000-000000000000';

describe('Spotify playback schemas', () => {
  describe('listenAlongSchema', () => {
    it('accepts wrapped body with valid uuid', () => {
      expect(listenAlongSchema.safeParse({ body: { targetUserId: UUID } }).success).toBe(true);
    });
    it('rejects unwrapped body (pre-fix shape)', () => {
      expect(listenAlongSchema.safeParse({ targetUserId: UUID }).success).toBe(false);
    });
    it('rejects non-uuid target', () => {
      expect(listenAlongSchema.safeParse({ body: { targetUserId: 'not-a-uuid' } }).success).toBe(false);
    });
    it('rejects unknown keys inside body (strict)', () => {
      expect(listenAlongSchema.safeParse({ body: { targetUserId: UUID, extra: 1 } }).success).toBe(false);
    });
  });

  describe('spotifyPlayPauseSchema', () => {
    it.each(['play', 'pause'] as const)('accepts wrapped body with action=%s', (action) => {
      expect(spotifyPlayPauseSchema.safeParse({ body: { action } }).success).toBe(true);
    });
    it('rejects unwrapped body', () => {
      expect(spotifyPlayPauseSchema.safeParse({ action: 'play' }).success).toBe(false);
    });
    it('rejects invalid action', () => {
      expect(spotifyPlayPauseSchema.safeParse({ body: { action: 'stop' } }).success).toBe(false);
    });
  });

  describe('spotifyShuffleSchema', () => {
    it.each([true, false])('accepts wrapped body with state=%s', (state) => {
      expect(spotifyShuffleSchema.safeParse({ body: { state } }).success).toBe(true);
    });
    it('rejects unwrapped body', () => {
      expect(spotifyShuffleSchema.safeParse({ state: true }).success).toBe(false);
    });
    it('rejects non-boolean state', () => {
      expect(spotifyShuffleSchema.safeParse({ body: { state: 'on' } }).success).toBe(false);
    });
  });

  describe('spotifyRepeatSchema', () => {
    it.each(['off', 'track', 'context'] as const)('accepts wrapped body with state=%s', (state) => {
      expect(spotifyRepeatSchema.safeParse({ body: { state } }).success).toBe(true);
    });
    it('rejects unwrapped body', () => {
      expect(spotifyRepeatSchema.safeParse({ state: 'off' }).success).toBe(false);
    });
    it('rejects invalid enum value', () => {
      expect(spotifyRepeatSchema.safeParse({ body: { state: 'all' } }).success).toBe(false);
    });
  });
});
