// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';

function create({ max, windowMs, clock = Date.now }) {
  const buckets = new Map(); // key → number[] of hit timestamps

  function prune(key) {
    const now = clock();
    const arr = buckets.get(key);
    if (!arr) return [];
    const cutoff = now - windowMs;
    let i = 0;
    while (i < arr.length && arr[i] < cutoff) i++;
    const kept = i === 0 ? arr : arr.slice(i);
    if (kept.length === 0) buckets.delete(key); else buckets.set(key, kept);
    return kept;
  }

  function tryHit(key) {
    const hits = prune(key);
    if (hits.length >= max) return false;
    hits.push(clock());
    buckets.set(key, hits);
    return true;
  }

  function tryHitWithRetryAfter(key) {
    const hits = prune(key);
    if (hits.length >= max) {
      const oldest = hits[0];
      const retryAfterMs = Math.max(0, windowMs - (clock() - oldest));
      return { ok: false, retryAfterMs };
    }
    hits.push(clock());
    buckets.set(key, hits);
    return { ok: true, retryAfterMs: 0 };
  }

  return { tryHit, tryHitWithRetryAfter };
}

module.exports = { create };
