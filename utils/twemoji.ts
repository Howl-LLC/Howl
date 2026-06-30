// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Twemoji (Twitter Emoji) CDN URLs for consistent, colorful emoji in chat.
 * @see https://github.com/twitter/twemoji
 */

const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.0.3/assets/svg';

/** Convert a single emoji string (one or more codepoints) to Twemoji codepoint hex (e.g. "1f525" or "1f1fa-1f1f8"). */
export function emojiToCodePoint(emoji: string): string {
  const points: number[] = [];
  for (let i = 0; i < emoji.length; i++) {
    const code = emoji.codePointAt(i);
    if (code !== undefined) points.push(code);
    if (code !== undefined && code > 0xffff) i++;
  }
  // Strip FE0F (variation selector-16) unless preceded by ZWJ (200D),
  // matching upstream Twemoji toCodePoint behavior for CDN compatibility
  const filtered = points.filter((p, i) => {
    if (p !== 0xfe0f) return true;
    return i > 0 && points[i - 1] === 0x200d;
  });
  return filtered.map((p) => p.toString(16).toLowerCase()).join('-');
}

/** Return the Twemoji SVG URL for an emoji character (or sequence). Returns undefined if we can't build a valid URL. */
export function getTwemojiUrl(emoji: string): string {
  const codePoint = emojiToCodePoint(emoji);
  return codePoint ? `${TWEMOJI_BASE}/${codePoint}.svg` : '';
}
