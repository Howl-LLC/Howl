// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { getCiphersuiteImpl, getCiphersuiteFromName, defaultCapabilities, type Capabilities, type CiphersuiteImpl } from 'ts-mls';

/** PQC hybrid suite: X-Wing KEM (X25519 + ML-KEM-768) + Ed25519 (codepoint 83). */
export const MLS_CIPHERSUITE_NAME = 'MLS_256_XWING_AES256GCM_SHA512_Ed25519' as const;

/** Numeric ciphersuite id, mirrored from backend/src/mls/ciphersuite.ts. */
export const MLS_CIPHERSUITE_ID = 83;

let cached: Promise<CiphersuiteImpl> | undefined;

/**
 * Lazily-memoized CiphersuiteImpl. getCiphersuiteImpl is async; the impl is
 * reusable across every ts-mls call, so we instantiate it once per page.
 */
export function getImpl(): Promise<CiphersuiteImpl> {
  if (!cached) {
    cached = getCiphersuiteImpl(getCiphersuiteFromName(MLS_CIPHERSUITE_NAME));
  }
  return cached;
}

/**
 * Capabilities advertising the active suite (codepoint 83) plus GREASE. We install
 * the X-Wing peer dep for this one suite only, so we must NOT advertise the other
 * real (MLS_*) suites ts-mls defaultCapabilities() lists (deps not installed). But
 * we KEEP the GREASE ciphersuite codepoints (the numeric-string entries ts-mls
 * appends) so peers stay exercised on ignoring unknown suites. We also
 * drop the 'x509' credential type — the credential validator only honors 'basic',
 * so advertising x509 is a spec-accuracy gap. GREASE on
 * versions/extensions/proposals and the GREASE credential values are preserved.
 */
/**
 * Keep ONLY our installed real suite among the MLS_* suites, while retaining the
 * GREASE ciphersuite codepoints (numeric-string entries ts-mls appends). Exported
 * so the GREASE-retention behavior can be tested deterministically — GREASE in
 * defaultCapabilities() is probabilistic, so a public-function test can't reliably
 * assert it.
 */
export function filterAdvertisedCiphersuites(
  ciphersuites: Capabilities['ciphersuites'],
): Capabilities['ciphersuites'] {
  return ciphersuites.filter((cs) => cs === MLS_CIPHERSUITE_NAME || !String(cs).startsWith('MLS_'));
}

export function supportedCapabilities(): Capabilities {
  const base = defaultCapabilities();
  return {
    ...base,
    ciphersuites: filterAdvertisedCiphersuites(base.ciphersuites),
    credentials: base.credentials.filter((c) => c !== 'x509'),
  };
}
