// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// services/logger.ts
//
// Thin frontend logger that survives Vite's prod tree-shaking.
//
// Why this exists: vite.config.ts marks console.log/debug/info/warn as pure
// (esbuild `pure` option) which strips them from production builds. Crypto
// dialect-mismatch warnings in useVoiceE2ee, useStageE2ee, and useDMCall
// must survive in prod for forensics. This module delegates to console.error
// (which is NOT stripped) so warning-level messages always reach the console.
//
// Usage:
//   import { logger } from '../services/logger';
//   logger.warn('[voice-e2ee] unknown keyFormat', { format: data.keyFormat });
//   logger.error('[dm-call] decryption failed', { channelId });
//
// Rules:
//   - Never log full crypto envelopes, keys, or error objects.
//   - Log only redacted structured metadata: { channelId, format, error: err.message }.

/** Structured metadata bag for log entries. */
export type LogMeta = Record<string, unknown>;

export const logger = {
  /**
   * Warning-level log that survives Vite prod tree-shaking.
   * Delegates to `console.error` (not stripped) with a `[WARN]` prefix
   * so the entry is distinguishable from true errors in browser DevTools.
   */
  warn(msg: string, meta?: LogMeta): void {
    console.error(`[WARN] ${msg}`, meta ?? '');
  },

  /**
   * Error-level log. Delegates to `console.error` (same as warn, but
   * without the [WARN] prefix for parity with standard error semantics).
   */
  error(msg: string, meta?: LogMeta): void {
    console.error(msg, meta ?? '');
  },
} as const;
