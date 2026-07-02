// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression for the post-accept recovery classifier. recoverChannelAfterKeyChange
 * only escalates to the DESTRUCTIVE resetStranded1to1Group (which drops ratchet state
 * on both sides + fans mls-group-reset to the peer) when isTransientRecoveryError
 * returns false. A transient network blip must therefore read as TRANSIENT.
 *
 * apiClient (services/api/core.ts) re-wraps a fetch TypeError into a PLAIN Error
 * ("Can't reach the server...") carrying { cause: TypeError } and no .status. Across
 * the SharedWorker boundary (the desktop default) mlsWorkerHost reconstructs it as a
 * plain Error that preserves name/message/status but DROPS cause. Both shapes must be
 * classified transient — the original bug misclassified them as definitive because the
 * classifier only knew `instanceof TypeError` + a regex missing that message.
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { isTransientRecoveryError } from '../services/mls/mlsCoordinatorCore';

// Exactly what services/api/core.ts throws for a fetch network failure (in-process path).
const apiClientNetworkError = () =>
  new Error("Can't reach the server. Check your connection and that the API is available.", {
    cause: new TypeError('Failed to fetch'),
  });

// The same error after crossing the SharedWorker boundary: reconstructed as a plain
// Error preserving name/message/status but NOT cause (mlsWorkerHost).
const workerReconstructedNetworkError = () =>
  Object.assign(
    new Error("Can't reach the server. Check your connection and that the API is available."),
    { name: 'Error' },
  );

describe('isTransientRecoveryError', () => {
  it('classifies the apiClient-wrapped fetch network failure as transient (in-process path)', () => {
    expect(isTransientRecoveryError(apiClientNetworkError())).toBe(true);
  });

  it('classifies the worker-reconstructed network failure (cause dropped) as transient', () => {
    expect(isTransientRecoveryError(workerReconstructedNetworkError())).toBe(true);
  });

  it('classifies a raw fetch TypeError as transient (in-process, unwrapped)', () => {
    expect(isTransientRecoveryError(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('classifies an AbortError-derived timeout message as transient', () => {
    expect(
      isTransientRecoveryError(new Error('Request timed out. Please check your connection and try again.')),
    ).toBe(true);
  });

  it('classifies 429 and 5xx as transient', () => {
    expect(isTransientRecoveryError(Object.assign(new Error('rate limited'), { status: 429 }))).toBe(true);
    expect(isTransientRecoveryError(Object.assign(new Error('server error'), { status: 503 }))).toBe(true);
  });

  it('classifies a definitive HTTP status and a definitive protocol error as NOT transient', () => {
    expect(isTransientRecoveryError(Object.assign(new Error('bad request'), { status: 400 }))).toBe(false);
    expect(isTransientRecoveryError(new Error('Could not validate credential'))).toBe(false);
  });
});
