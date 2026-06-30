// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { getCustomEmojiUrl } from './customEmojiStore';

const STORAGE_KEY_BASE = 'recent_emojis';
const MAX_RECENTS = 36;
const CUSTOM_EMOJI_RE = /^:[a-zA-Z0-9_]+:$/;

function storageKey(userId?: string): string {
  return userId ? `${userId}:${STORAGE_KEY_BASE}` : STORAGE_KEY_BASE;
}

export function getRecentEmojis(userId?: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const filtered = parsed.filter((e: unknown): e is string => {
      if (typeof e !== 'string') return false;
      if (CUSTOM_EMOJI_RE.test(e)) {
        const name = e.slice(1, -1);
        return !!getCustomEmojiUrl(name);
      }
      return true;
    }).slice(0, MAX_RECENTS);
    if (filtered.length !== parsed.length) {
      try { localStorage.setItem(storageKey(userId), JSON.stringify(filtered)); } catch { /* storage unavailable */ }
    }
    return filtered;
  } catch {
    return [];
  }
}

export function addRecentEmoji(emoji: string, userId?: string): string[] {
  const prev = getRecentEmojis(userId);
  const next = [emoji, ...prev.filter((e) => e !== emoji)].slice(0, MAX_RECENTS);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch { /* quota exceeded -- ignore */ }
  return next;
}
