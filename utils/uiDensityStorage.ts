// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export type UiDensity = 'compact' | 'default' | 'spacious';

const STORAGE_KEY = 'howl_ui_density';

export function getStoredUiDensity(): UiDensity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'compact' || raw === 'default' || raw === 'spacious') return raw;
    return null;
  } catch {
    return null;
  }
}

export function setStoredUiDensity(density: UiDensity): void {
  try {
    localStorage.setItem(STORAGE_KEY, density);
  } catch { /* storage unavailable */ }
}

export type ChatMessageDisplay = 'compact' | 'default';

const CHAT_MESSAGE_DISPLAY_KEY = 'howl_chat_message_display';

export function getStoredChatMessageDisplay(): ChatMessageDisplay | null {
  try {
    const raw = localStorage.getItem(CHAT_MESSAGE_DISPLAY_KEY);
    if (raw === 'compact' || raw === 'default') return raw;
    return null;
  } catch {
    return null;
  }
}

export function setStoredChatMessageDisplay(value: ChatMessageDisplay): void {
  try {
    localStorage.setItem(CHAT_MESSAGE_DISPLAY_KEY, value);
  } catch { /* storage unavailable */ }
}

const MESSAGE_GROUP_SPACING_KEY = 'howl_message_group_spacing';
const CHAT_FONT_SIZE_KEY = 'howl_chat_font_size';
const ZOOM_LEVEL_KEY = 'howl_zoom_level';

export function getStoredMessageGroupSpacing(): number | null {
  try {
    const raw = localStorage.getItem(MESSAGE_GROUP_SPACING_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0 && n <= 24) return n;
    return null;
  } catch {
    return null;
  }
}

export function setStoredMessageGroupSpacing(px: number): void {
  try {
    localStorage.setItem(MESSAGE_GROUP_SPACING_KEY, String(Math.max(0, Math.min(24, px))));
  } catch { /* storage unavailable */ }
}

export function getStoredChatFontSize(): number | null {
  try {
    const raw = localStorage.getItem(CHAT_FONT_SIZE_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 12 && n <= 24) return n;
    return null;
  } catch {
    return null;
  }
}

export function setStoredChatFontSize(px: number): void {
  try {
    localStorage.setItem(CHAT_FONT_SIZE_KEY, String(Math.max(12, Math.min(24, px))));
  } catch { /* storage unavailable */ }
}

export function getStoredZoomLevel(): number | null {
  try {
    const raw = localStorage.getItem(ZOOM_LEVEL_KEY);
    if (raw == null) return null;
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 50 && n <= 200) return n;
    return null;
  } catch {
    return null;
  }
}

export function setStoredZoomLevel(pct: number): void {
  try {
    localStorage.setItem(ZOOM_LEVEL_KEY, String(Math.max(50, Math.min(200, pct))));
  } catch { /* storage unavailable */ }
}

// Mention Highlight Color
export type MentionHighlightColor = 'cyan' | 'purple' | 'amber' | 'indigo' | 'pink' | 'green' | 'white';

export const MENTION_HIGHLIGHT_PRESETS: Record<MentionHighlightColor, { rgb: string; hex: string }> = {
  cyan:   { rgb: '34,211,238',  hex: '#22d3ee' },
  purple: { rgb: '168,85,247',  hex: '#a855f7' },
  amber:  { rgb: '251,191,36',  hex: '#fbbf24' },
  indigo: { rgb: '129,140,248', hex: '#818cf8' },
  pink:   { rgb: '244,114,182', hex: '#f472b6' },
  green:  { rgb: '74,222,128',  hex: '#4ade80' },
  white:  { rgb: '255,255,255', hex: '#ffffff' },
};

const MENTION_HIGHLIGHT_COLOR_KEY = 'howl_mention_highlight_color';
const VALID_MENTION_COLORS: MentionHighlightColor[] = ['cyan', 'purple', 'amber', 'indigo', 'pink', 'green', 'white'];

export function getStoredMentionHighlightColor(): MentionHighlightColor {
  try {
    const raw = localStorage.getItem(MENTION_HIGHLIGHT_COLOR_KEY);
    if (raw && VALID_MENTION_COLORS.includes(raw as MentionHighlightColor)) return raw as MentionHighlightColor;
    return 'cyan';
  } catch {
    return 'cyan';
  }
}

export function setStoredMentionHighlightColor(color: MentionHighlightColor): void {
  try {
    if (VALID_MENTION_COLORS.includes(color)) {
      localStorage.setItem(MENTION_HIGHLIGHT_COLOR_KEY, color);
    }
  } catch { /* storage unavailable */ }
}

// Server Layout (Default / Classic)
//
// 'default' — current Howl layout: ChannelPanelAside renders activity / voice
//             / text / pinned tabs, chat has its own header strip.
// 'classic' — Discord-style: extended subheader bubble (banner + channel),
//             ClassicChannelTree (categories + channels + voice users inline),
//             actions-bubble + members-bubble in members column, no chat
//             header strip.
//
// Returns 'default' on missing / invalid / storage-blocked so callers don't
// have to repeat the fallback at every read site.
export type ServerLayout = 'default' | 'classic';

const SERVER_LAYOUT_KEY = 'howl_server_layout';

export function getStoredServerLayout(): ServerLayout {
  try {
    const raw = localStorage.getItem(SERVER_LAYOUT_KEY);
    if (raw === 'default' || raw === 'classic') return raw;
  } catch { /* storage blocked */ }
  return 'default';
}

export function setStoredServerLayout(value: ServerLayout): void {
  try {
    if (value === 'default' || value === 'classic') {
      localStorage.setItem(SERVER_LAYOUT_KEY, value);
    }
  } catch { /* storage unavailable */ }
}
