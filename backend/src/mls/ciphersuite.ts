// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { getCiphersuiteImpl, getCiphersuiteFromName, type CiphersuiteImpl } from 'ts-mls';

/** PQC hybrid suite: X-Wing KEM (X25519 + ML-KEM-768) + Ed25519 (codepoint 83). */
export const MLS_CIPHERSUITE_NAME = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519' as const;

/** Numeric ciphersuite id stored on MlsGroup.cipherSuite for audit/forward-compat. */
export const MLS_CIPHERSUITE_ID = 83;

let cached: Promise<CiphersuiteImpl> | undefined;

/**
 * Lazily-memoized CiphersuiteImpl. getCiphersuiteImpl is async; the impl is
 * reusable across every ts-mls call, so we instantiate it once.
 */
export function getImpl(): Promise<CiphersuiteImpl> {
  if (!cached) {
    cached = getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHERSUITE_NAME));
  }
  return cached;
}
