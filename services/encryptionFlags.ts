// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Lightweight encryption status flags.
 *
 * These are separated from dmEncryption.ts so they can be eagerly imported
 * without pulling in the heavy TweetNaCl crypto bundle.
 *
 * Flags are persisted to localStorage so the ratchet survives page reloads,
 * and a `storage` event listener mirrors writes from sibling tabs into our
 * in-memory map so a Tab 2 that creates a fresh DM doesn't leave Tab 1
 * thinking the channel is unencrypted.
 */

const STORAGE_KEY = 'howl_channel_encryption_flags';

function loadFlags(): Map<string, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as [string, boolean][];
      return new Map(entries.filter(([, v]) => v === true));
    }
  } catch { /* localStorage unavailable */ }
  return new Map();
}

function persistFlags(map: Map<string, boolean>): void {
  try {
    const entries = Array.from(map.entries()).filter(([, v]) => v);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch { /* localStorage unavailable */ }
}

const MAX_ENCRYPTION_FLAGS = 2000;
const channelEncryptionStatus = loadFlags();

// Cross-tab sync: storage events fire in OTHER tabs when one tab writes.
// Without this, a fresh-DM-then-call flow opened in Tab B would not see the
// flag that Tab A set, causing Tab B to skip E2EE on the call. Listener is
// installed once at module load; merge-only (never downgrade) preserves the
// security ratchet that setChannelEncryptionStatus enforces.
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY) return;
    if (e.newValue == null) {
      // Another tab cleared the cache (e.g. clearEncryptionStatus on logout).
      // Mirror so we don't keep stale flags after a sibling-tab sign-out.
      channelEncryptionStatus.clear();
      return;
    }
    try {
      const entries = JSON.parse(e.newValue) as [string, boolean][];
      for (const [id, v] of entries) {
        if (v !== true) continue;
        // Merge-only: never overwrite an existing true with false even if
        // the sibling tab wrote false (defense in depth — should never
        // happen given the ratchet in setChannelEncryptionStatus).
        if (channelEncryptionStatus.get(id) !== true) {
          channelEncryptionStatus.set(id, true);
        }
      }
    } catch { /* corrupt payload — ignore, our existing entries remain */ }
  });
}

export function setChannelEncryptionStatus(channelId: string, encrypted: boolean): void {
  // Ratchet: once a channel is known encrypted, never downgrade.
  // A compromised server could send encrypted=false to force plaintext —
  // this prevents that attack.
  const current = channelEncryptionStatus.get(channelId);
  if (current === true && !encrypted) return;
  // No-op if already in the desired state — avoids needless localStorage
  // writes (which fan out as `storage` events to every sibling tab).
  if (current === encrypted) return;
  channelEncryptionStatus.set(channelId, encrypted);
  // Evict oldest entries if the map exceeds the cap
  if (channelEncryptionStatus.size > MAX_ENCRYPTION_FLAGS) {
    const iterator = channelEncryptionStatus.keys();
    while (channelEncryptionStatus.size > MAX_ENCRYPTION_FLAGS) {
      const oldestKey = iterator.next().value;
      if (oldestKey !== undefined) channelEncryptionStatus.delete(oldestKey);
    }
  }
  persistFlags(channelEncryptionStatus);
}

export function isChannelEncrypted(channelId: string): boolean {
  return channelEncryptionStatus.get(channelId) === true;
}

export function isChannelEncryptionKnown(channelId: string): boolean {
  return channelEncryptionStatus.has(channelId);
}

export function clearEncryptionStatus(): void {
  channelEncryptionStatus.clear();
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* localStorage unavailable */ }
}

// Channel protocol classification
// A one-way ratchet recording that a channel uses MLS E2EE. There is only one
// protocol ('mls'); the classification persists so a reload / sibling tab still
// treats the channel as MLS (the source of truth for the downgrade-resistance
// guarantee). Server-sent fields (e.g. mlsGroupId) are mapping conveniences and
// cannot drive this.
//
// Same localStorage + cross-tab merge-only pattern as the encrypted flag above.

export type ChannelProtocol = 'mls';

const PROTOCOL_STORAGE_KEY = 'howl_channel_protocol';

function loadProtocols(): Map<string, ChannelProtocol> {
  try {
    const raw = localStorage.getItem(PROTOCOL_STORAGE_KEY);
    if (raw) {
      const entries = JSON.parse(raw) as [string, ChannelProtocol][];
      return new Map(entries.filter(([, v]) => v === 'mls'));
    }
  } catch { /* localStorage unavailable */ }
  return new Map();
}

function persistProtocols(map: Map<string, ChannelProtocol>): void {
  try {
    localStorage.setItem(PROTOCOL_STORAGE_KEY, JSON.stringify(Array.from(map.entries())));
  } catch { /* localStorage unavailable */ }
}

const channelProtocol = loadProtocols();

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (e) => {
    if (e.key !== PROTOCOL_STORAGE_KEY) return;
    if (e.newValue == null) {
      channelProtocol.clear();
      return;
    }
    try {
      const entries = JSON.parse(e.newValue) as [string, ChannelProtocol][];
      for (const [id, v] of entries) {
        // Merge-only ratchet: accept an incoming 'mls' for any channel not
        // already classified.
        if (v === 'mls' && channelProtocol.get(id) !== 'mls') {
          channelProtocol.set(id, 'mls');
        }
      }
    } catch { /* corrupt payload — ignore, existing entries remain */ }
  });
}

/**
 * Classify a channel. Idempotent no-ops avoid needless localStorage writes
 * (which fan out as `storage` events to sibling tabs).
 */
export function setChannelProtocol(channelId: string, protocol: ChannelProtocol): void {
  const current = channelProtocol.get(channelId);
  if (current === protocol) return; // no-op (idempotent; avoids storage-event fanout)
  channelProtocol.set(channelId, protocol);
  // No eviction: every entry is an 'mls' classification, and dropping one
  // would be a silent downgrade (getChannelProtocol null reads as
  // never-classified, which fails closed but loses the heal). The map is
  // bounded by the user's real channel count.
  persistProtocols(channelProtocol);
}

/** The channel's classification, or null if never classified. */
export function getChannelProtocol(channelId: string): ChannelProtocol | null {
  return channelProtocol.get(channelId) ?? null;
}

/** True iff the channel is classified 'mls'. */
export function isChannelMls(channelId: string): boolean {
  return channelProtocol.get(channelId) === 'mls';
}
