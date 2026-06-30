// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Bundled SVG icons as data URLs.
 * Based on Lucide icon paths (MIT license) — simple 24x24 stroked icons.
 * Each icon is white (#fff) on transparent, designed for the key renderer.
 */

function svgDataUrl(paths: string, filled = false): string {
  const attrs = filled
    ? 'fill="#fff" stroke="none"'
    : 'fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${attrs}>${paths}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// Microphone (lucide: mic)
export const ICON_MIC = svgDataUrl(
  '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>' +
  '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
  '<line x1="12" x2="12" y1="19" y2="22"/>'
);

// Microphone off (lucide: mic-off)
export const ICON_MIC_OFF = svgDataUrl(
  '<line x1="2" x2="22" y1="2" y2="22"/>' +
  '<path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"/>' +
  '<path d="M5 10v2a7 7 0 0 0 12 5"/>' +
  '<path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"/>' +
  '<path d="M9 9v3a3 3 0 0 0 5.12 2.12"/>' +
  '<line x1="12" x2="12" y1="19" y2="22"/>'
);

// Headphones (lucide: headphones)
export const ICON_HEADPHONES = svgDataUrl(
  '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'
);

// Headphones off (custom: headphones + slash)
export const ICON_HEADPHONES_OFF = svgDataUrl(
  '<line x1="2" x2="22" y1="2" y2="22"/>' +
  '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'
);

// Camera (lucide: video)
export const ICON_CAMERA = svgDataUrl(
  '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/>' +
  '<rect x="2" y="6" width="14" height="12" rx="2"/>'
);

// Camera off (lucide: video-off)
export const ICON_CAMERA_OFF = svgDataUrl(
  '<path d="M10.66 6H14a2 2 0 0 1 2 2v2.5l5.248-3.062A.5.5 0 0 1 22 7.87v8.196"/>' +
  '<path d="M16 16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2"/>' +
  '<line x1="2" x2="22" y1="2" y2="22"/>'
);

// Phone down / hangup (lucide: phone-off)
export const ICON_PHONE_DOWN = svgDataUrl(
  '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/>' +
  '<line x1="23" x2="1" y1="1" y2="23"/>'
);

// Phone pickup / answer (lucide: phone)
export const ICON_PHONE_PICKUP = svgDataUrl(
  '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'
);

// X (lucide: x)
export const ICON_X = svgDataUrl(
  '<line x1="18" x2="6" y1="6" y2="18"/>' +
  '<line x1="6" x2="18" y1="6" y2="18"/>'
);

// Switch / arrow-right-left (lucide: arrow-right-left)
export const ICON_SWITCH = svgDataUrl(
  '<path d="m16 3 4 4-4 4"/>' +
  '<path d="M20 7H4"/>' +
  '<path d="m8 21-4-4 4-4"/>' +
  '<path d="M4 17h16"/>'
);

// Headset / audio device (lucide: settings-2 simplified to speaker icon)
export const ICON_HEADSET = svgDataUrl(
  '<path d="M2 10v3a2 2 0 0 0 2 2h2V8H4a2 2 0 0 0-2 2Z"/>' +
  '<path d="M22 10v3a2 2 0 0 1-2 2h-2V8h2a2 2 0 0 1 2 2Z"/>' +
  '<path d="M4 12a8 8 0 0 1 16 0"/>' +
  '<path d="M18 15v2a4 4 0 0 1-4 4h-4"/>'
);

// User / caller avatar placeholder (lucide: user)
export const ICON_USER = svgDataUrl(
  '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>' +
  '<circle cx="12" cy="7" r="4"/>'
);

// -- Presence dots (filled colored circles) --

function dotSvgDataUrl(color: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${color}" stroke="${color}" stroke-width="1"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export const ICON_DOT_ONLINE = dotSvgDataUrl('#2ecc71');
export const ICON_DOT_IDLE = dotSvgDataUrl('#f1c40f');
export const ICON_DOT_DND = dotSvgDataUrl('#e74c3c');
export const ICON_DOT_INVISIBLE = dotSvgDataUrl('#555b63');

// Refresh / rotate (lucide: refresh-cw)
export const ICON_REFRESH = svgDataUrl(
  '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>' +
  '<path d="M21 3v5h-5"/>' +
  '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>' +
  '<path d="M3 21v-5h5"/>'
);

// Hash (lucide: hash — channel icon)
export const ICON_HASH = svgDataUrl(
  '<line x1="4" x2="20" y1="9" y2="9"/>' +
  '<line x1="4" x2="20" y1="15" y2="15"/>' +
  '<line x1="10" x2="8" y1="3" y2="21"/>' +
  '<line x1="16" x2="14" y1="3" y2="21"/>'
);

// Message circle (lucide: message-circle — thread icon)
export const ICON_MESSAGE_CIRCLE = svgDataUrl(
  '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'
);

// Lock (lucide: lock)
export const ICON_LOCK = svgDataUrl(
  '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
  '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
);

// Lock open (lucide: lock-open)
export const ICON_LOCK_OPEN = svgDataUrl(
  '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
  '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>'
);

// Stage / broadcast (lucide: radio)
export const ICON_STAGE = svgDataUrl(
  '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/>' +
  '<path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4"/>' +
  '<path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4"/>' +
  '<path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>' +
  '<circle cx="12" cy="12" r="2"/>'
);

// User minus (lucide: user-minus — remove speaker)
export const ICON_USER_MINUS = svgDataUrl(
  '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
  '<circle cx="9" cy="7" r="4"/>' +
  '<line x1="22" x2="16" y1="11" y2="11"/>'
);

// Bell (lucide: bell)
export const ICON_BELL = svgDataUrl(
  '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
  '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'
);

// Padlock small overlay (for E2EE indicator) — smaller viewBox for overlay use
export const ICON_PADLOCK_SMALL = svgDataUrl(
  '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
  '<path d="M7 11V7a5 5 0 0 1 10 0v4"/>'
);
