// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Single-use token / challenge enforcement.
 *
 * Used by MFA, device-verify, admin MFA, and admin passkey flows to mark a
 * token / WebAuthn challenge as consumed exactly once. In multi-replica
 * deployments, an in-memory `Map<fingerprint, ts>` only enforces single-use
 * per replica — a leaked token replayed against a different replica would be
 * accepted. We migrate the mark-or-fail to Redis `SET NX EX` so the
 * enforcement is global and atomic (no TOCTOU between check and write).
 *
 * Production hard-fails at boot (see server.ts) when `REDIS_URL` is unset, so
 * the in-memory fallback below is only ever used in dev/test. The fallback
 * is preserved so local work without Redis still works; it uses
 * `cappedMapSet` to bound memory usage.
 */
import { redis } from '../redis.js';
import { cappedMapSet } from '../socketHandlers/infrastructure.js';

/** Distinct namespaces per flow so e.g. an MFA token fingerprint can't
 *  collide with a webauthn challenge fingerprint. */
export type SingleUseNamespace =
  | 'mfa:used-challenge'
  | 'auth:used-device-verify'
  | 'admin:used-mfa-token'
  | 'admin-passkey:used-token';

const MAX_FALLBACK_ENTRIES = 50_000;

/** One per namespace so eviction in one flow can't starve another. */
const fallbackStores = new Map<SingleUseNamespace, Map<string, number>>();

function getFallback(ns: SingleUseNamespace): Map<string, number> {
  let store = fallbackStores.get(ns);
  if (!store) {
    store = new Map();
    fallbackStores.set(ns, store);
  }
  return store;
}

function buildKey(ns: SingleUseNamespace, fingerprint: string): string {
  return `${ns}:${fingerprint}`;
}

/**
 * Atomically mark `fingerprint` as used inside `ns`. Returns `true` if this
 * caller is the first to mark it (allowed to proceed), `false` if it was
 * already marked (replay — caller must reject).
 *
 * Redis `SET NX EX` is the authoritative path: the command only succeeds when
 * the key does not exist, so two concurrent callers from different replicas
 * can't both observe "not-yet-used". The dev/test fallback approximates the
 * same semantics within a single process via Map.has.
 */
export async function markTokenUsedOnce(
  ns: SingleUseNamespace,
  fingerprint: string,
  ttlSeconds: number,
): Promise<boolean> {
  const key = buildKey(ns, fingerprint);
  if (redis) {
    const result = await redis.set(key, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }
  const store = getFallback(ns);
  const now = Date.now();
  const existing = store.get(fingerprint);
  if (existing !== undefined && existing > now) return false;
  cappedMapSet(store, fingerprint, now + ttlSeconds * 1000, MAX_FALLBACK_ENTRIES);
  return true;
}

/**
 * Read-only check whether `fingerprint` has already been claimed in `ns`. Use
 * to short-circuit expensive verification work (e.g. crypto / DB) when the
 * token is already obviously spent. The atomic enforcement is still
 * `markTokenUsedOnce` — this is a best-effort pre-check, not a gate.
 */
export async function isTokenAlreadyUsed(
  ns: SingleUseNamespace,
  fingerprint: string,
): Promise<boolean> {
  const key = buildKey(ns, fingerprint);
  if (redis) {
    return (await redis.exists(key)) === 1;
  }
  const store = getFallback(ns);
  const expiresAt = store.get(fingerprint);
  if (expiresAt === undefined) return false;
  if (Date.now() > expiresAt) {
    store.delete(fingerprint);
    return false;
  }
  return true;
}

/**
 * Test-only helper: clear every fallback store. Lets tests re-run the same
 * fingerprint cleanly across cases without spinning up Redis.
 */
export function _resetSingleUseFallbackForTests(): void {
  for (const store of fallbackStores.values()) store.clear();
}
