// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Per-(channel, tier) key derivation. A DM channel can hold two MLS groups:
 * tier='saved' (durable archive) and tier='otr' (ephemeral). Saved keeps the
 * bare dmChannelId so every existing persisted record stays addressable with
 * ZERO migration; only OTR gets a namespaced key.
 *
 * Leaf module: imports nothing from services/mls/* to avoid an import cycle.
 */
export type MlsTier = 'saved' | 'otr';

const OTR_SUFFIX = '#otr';

export function roomKey(dmChannelId: string, tier: MlsTier): string {
  return tier === 'otr' ? `${dmChannelId}${OTR_SUFFIX}` : dmChannelId;
}

export function isOtrRoomKey(key: string): boolean {
  return key.endsWith(OTR_SUFFIX);
}

/**
 * Inverse of `roomKey`: strip the OTR namespace back to the bare dmChannelId.
 * Unread/notification state and the sidebar are keyed by the bare id, so the
 * read-path must un-namespace an OTR roomId before clearing those. Identity on
 * a Saved (bare) key, so the Saved path stays byte-identical.
 */
export function bareChannelId(key: string): string {
  return key.endsWith(OTR_SUFFIX) ? key.slice(0, -OTR_SUFFIX.length) : key;
}
