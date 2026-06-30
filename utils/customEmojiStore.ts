// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { CustomEmoji } from '../types';

/**
 * Module-level store for custom server emoji.
 * The EmojiPicker writes to it when it fetches emojis;
 * MentionText reads from it to render :name: patterns as images.
 */
let emojiMap = new Map<string, string>();
const listeners = new Set<() => void>();

export function setCustomEmojis(emojis: CustomEmoji[]) {
  const next = new Map<string, string>();
  for (const e of emojis) next.set(e.name, e.imageUrl);
  emojiMap = next;
  for (const fn of listeners) fn();
}

export function mergeCustomEmojis(emojis: CustomEmoji[]) {
  const next = new Map(emojiMap);
  let changed = false;
  for (const e of emojis) {
    if (next.get(e.name) !== e.imageUrl) changed = true;
    next.set(e.name, e.imageUrl);
  }
  if (changed || next.size !== emojiMap.size) {
    emojiMap = next;
    for (const fn of listeners) fn();
  }
}

export function getCustomEmojiUrl(name: string): string | undefined {
  return emojiMap.get(name);
}

export function getCustomEmojiMap(): Map<string, string> {
  return emojiMap;
}

export function subscribeCustomEmojis(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
