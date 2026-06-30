// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared key image renderer for Stream Deck actions.
 * Uses @napi-rs/canvas to generate 144x144 PNG key images.
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';

export interface RenderOpts {
  /** SVG data URL or path of icon to center on the key. */
  icon?: string;
  /** Background color (hex). Default: '#1e2228'. */
  bgColor?: string;
  /** State overlay tint color (e.g., '#e74c3c' for red when muted). */
  stateColor?: string;
  /** Optional badge in the top-right corner. */
  badge?: { text: string; color: string };
  /** Text label at the bottom of the key. */
  label?: string;
  /** Key image size. Default: 144. */
  size?: 72 | 144;
}

/**
 * Render a key image as a base64-encoded data URL string ready for `KeyAction.setImage()`.
 */
export async function renderKey(opts: RenderOpts): Promise<string> {
  const size = opts.size ?? 144;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background fill
  ctx.fillStyle = opts.bgColor ?? '#1e2228';
  ctx.fillRect(0, 0, size, size);

  // Icon (centered, with optional vertical offset when there's a label)
  if (opts.icon) {
    try {
      const img = await loadImage(opts.icon);
      const iconSize = Math.floor(size * 0.5);
      const x = (size - iconSize) / 2;
      const y = (size - iconSize) / 2 - (opts.label ? size * 0.06 : 0);
      ctx.drawImage(img, x, y, iconSize, iconSize);
    } catch {
      // Icon failed to load — render without it.
    }
  }

  // State color overlay (tints the entire key, e.g. red when muted)
  if (opts.stateColor) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = opts.stateColor;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
  }

  // Badge (top-right rounded rect with text)
  if (opts.badge) {
    const badgeH = Math.floor(size * 0.16);
    const fontSize = Math.floor(size * 0.1);
    ctx.font = `bold ${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(opts.badge.text).width;
    const badgeW = Math.max(textWidth + size * 0.08, badgeH);
    const bx = size - badgeW - size * 0.04;
    const by = size * 0.04;
    const radius = badgeH / 2;

    ctx.fillStyle = opts.badge.color;
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeW, badgeH, radius);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.badge.text, bx + badgeW / 2, by + badgeH / 2);
  }

  // Label (bottom strip)
  if (opts.label) {
    const fontSize = Math.floor(size * 0.09);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label.slice(0, 14), size / 2, size * 0.95);
  }

  const buf = canvas.toBuffer('image/png');
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** Colors used across action renderers. */
export const COLORS = {
  BG_DEFAULT: '#1e2228',
  BG_INACTIVE: '#2a2d32',
  RED: '#e74c3c',
  GREEN: '#2ecc71',
  GREY: '#555b63',
  BLUE: '#3498db',
  ORANGE: '#e67e22',
  YELLOW: '#f1c40f',
  CYAN: '#076FA0',
} as const;

/**
 * Render the pair-prompt screen shown on every Howl action key while the
 * plugin is connected but the user has not yet allowed pairing. Tells the
 * user to open Howl on this computer and approve the consent modal there.
 */
export async function renderPairPrompt(): Promise<string> {
  const size = 144;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background: deep slate to match Howl
  ctx.fillStyle = '#020617';
  ctx.fillRect(0, 0, size, size);

  // Cyan accent: a small horizontal bar near the top
  ctx.fillStyle = COLORS.CYAN;
  ctx.fillRect(size * 0.4, size * 0.18, size * 0.2, 2);

  // Headline: "OPEN HOWL"
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 17px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('OPEN HOWL', size / 2, size * 0.42);

  // Subhead: "TO PAIR"
  ctx.fillStyle = COLORS.CYAN;
  ctx.font = 'bold 13px sans-serif';
  ctx.fillText('TO PAIR', size / 2, size * 0.6);

  // Hint: "tap to retry"
  ctx.fillStyle = '#94a3b8';
  ctx.font = '10px sans-serif';
  ctx.textBaseline = 'bottom';
  ctx.fillText('tap to retry', size / 2, size - 10);

  const buf = canvas.toBuffer('image/png');
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** Map presence status to a color. */
export const PRESENCE_COLORS: Record<string, string> = {
  online: COLORS.GREEN,
  idle: COLORS.YELLOW,
  dnd: COLORS.RED,
  invisible: COLORS.GREY,
  offline: COLORS.GREY,
};

/**
 * Render a key image with an emoji character as the main graphic.
 * Uses Canvas text rendering to draw a large emoji centered on the key.
 */
export async function renderEmojiKey(opts: {
  emoji: string;
  bgColor?: string;
  label?: string;
  badge?: { text: string; color: string };
  stateColor?: string;
  greyed?: boolean;
  size?: 72 | 144;
}): Promise<string> {
  const size = opts.size ?? 144;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background fill
  ctx.fillStyle = opts.bgColor ?? '#1e2228';
  ctx.fillRect(0, 0, size, size);

  // Emoji centered
  const emojiFontSize = Math.floor(size * 0.45);
  ctx.font = `${emojiFontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  const yOffset = opts.label ? -size * 0.06 : 0;
  ctx.fillText(opts.emoji, size / 2, size / 2 + yOffset);

  // State color overlay (greyed out)
  if (opts.stateColor || opts.greyed) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = opts.stateColor ?? COLORS.GREY;
    ctx.globalAlpha = opts.greyed ? 0.6 : 0.45;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
  }

  // Badge (top-right rounded rect with text)
  if (opts.badge) {
    const badgeH = Math.floor(size * 0.16);
    const fontSize = Math.floor(size * 0.1);
    ctx.font = `bold ${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(opts.badge.text).width;
    const badgeW = Math.max(textWidth + size * 0.08, badgeH);
    const bx = size - badgeW - size * 0.04;
    const by = size * 0.04;
    const radius = badgeH / 2;

    ctx.fillStyle = opts.badge.color;
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeW, badgeH, radius);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.badge.text, bx + badgeW / 2, by + badgeH / 2);
  }

  // Label (bottom strip)
  if (opts.label) {
    const fontSize = Math.floor(size * 0.09);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label.slice(0, 14), size / 2, size * 0.95);
  }

  const buf = canvas.toBuffer('image/png');
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/**
 * Render a key image with a circular avatar as the main graphic.
 * Optionally draws a status ring around the avatar.
 */
export async function renderAvatarKey(opts: {
  avatarUrl?: string;
  fallbackIcon: string;
  statusColor?: string;
  bgColor?: string;
  label?: string;
  badge?: { text: string; color: string };
  stateColor?: string;
  overlayIcon?: string;
  size?: 72 | 144;
}): Promise<string> {
  const size = opts.size ?? 144;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Background fill
  ctx.fillStyle = opts.bgColor ?? '#1e2228';
  ctx.fillRect(0, 0, size, size);

  const avatarSize = Math.floor(size * 0.55);
  const cx = size / 2;
  const cy = size / 2 - (opts.label ? size * 0.06 : 0);

  // Status ring (drawn behind avatar)
  if (opts.statusColor) {
    const ringRadius = avatarSize / 2 + size * 0.04;
    ctx.beginPath();
    ctx.arc(cx, cy, ringRadius, 0, Math.PI * 2);
    ctx.fillStyle = opts.statusColor;
    ctx.fill();
  }

  // Avatar (circular clip)
  if (opts.avatarUrl) {
    try {
      const { loadImage: loadImg } = await import('@napi-rs/canvas');
      const { getCachedAvatar } = await import('./avatar-cache.js');
      const avatarBuf = await getCachedAvatar(opts.avatarUrl);
      const img = avatarBuf ? await loadImg(avatarBuf) : await loadImg(opts.avatarUrl);

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, avatarSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, cx - avatarSize / 2, cy - avatarSize / 2, avatarSize, avatarSize);
      ctx.restore();
    } catch {
      // Avatar load failed — fall through to fallback icon.
      await drawFallbackIcon(ctx, opts.fallbackIcon, cx, cy, avatarSize);
    }
  } else {
    await drawFallbackIcon(ctx, opts.fallbackIcon, cx, cy, avatarSize);
  }

  // Overlay icon (small, bottom-right of the avatar)
  if (opts.overlayIcon) {
    try {
      const overlaySize = Math.floor(size * 0.22);
      const ox = cx + avatarSize / 2 - overlaySize / 2;
      const oy = cy + avatarSize / 2 - overlaySize / 2;
      const img = await loadImage(opts.overlayIcon);
      ctx.drawImage(img, ox, oy, overlaySize, overlaySize);
    } catch {
      // Overlay icon failed to load — skip.
    }
  }

  // State color overlay
  if (opts.stateColor) {
    ctx.globalCompositeOperation = 'source-atop';
    ctx.fillStyle = opts.stateColor;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1.0;
  }

  // Badge (top-right rounded rect with text)
  if (opts.badge) {
    const badgeH = Math.floor(size * 0.16);
    const fontSize = Math.floor(size * 0.1);
    ctx.font = `bold ${fontSize}px sans-serif`;
    const textWidth = ctx.measureText(opts.badge.text).width;
    const badgeW = Math.max(textWidth + size * 0.08, badgeH);
    const bx = size - badgeW - size * 0.04;
    const by = size * 0.04;
    const radius = badgeH / 2;

    ctx.fillStyle = opts.badge.color;
    ctx.beginPath();
    ctx.roundRect(bx, by, badgeW, badgeH, radius);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.badge.text, bx + badgeW / 2, by + badgeH / 2);
  }

  // Label (bottom strip)
  if (opts.label) {
    const fontSize = Math.floor(size * 0.09);
    ctx.fillStyle = '#ffffff';
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(opts.label.slice(0, 14), size / 2, size * 0.95);
  }

  const buf = canvas.toBuffer('image/png');
  return `data:image/png;base64,${buf.toString('base64')}`;
}

/** Draw a fallback SVG icon within a circular region. */
async function drawFallbackIcon(
  ctx: ReturnType<ReturnType<typeof createCanvas>['getContext']>,
  icon: string,
  cx: number,
  cy: number,
  diameter: number,
): Promise<void> {
  try {
    const img = await loadImage(icon);
    const iconSize = Math.floor(diameter * 0.7);
    ctx.drawImage(img, cx - iconSize / 2, cy - iconSize / 2, iconSize, iconSize);
  } catch {
    // Icon failed to load — leave blank.
  }
}

/**
 * Render a small icon overlay in the top-right corner of a key.
 * Useful for padlock overlay on E2EE-locked channels.
 */
export async function renderOverlayIcon(opts: {
  baseImage: string;
  overlayIcon: string;
  size?: 72 | 144;
}): Promise<string> {
  const size = opts.size ?? 144;
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Draw the base image
  const baseImg = await loadImage(Buffer.from(opts.baseImage.replace(/^data:image\/png;base64,/, ''), 'base64'));
  ctx.drawImage(baseImg, 0, 0, size, size);

  // Draw overlay icon in top-right corner
  try {
    const overlaySize = Math.floor(size * 0.25);
    const ox = size - overlaySize - size * 0.04;
    const oy = size * 0.04;
    const img = await loadImage(opts.overlayIcon);

    // Draw a dark circle behind the overlay for contrast
    ctx.fillStyle = '#000000';
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.arc(ox + overlaySize / 2, oy + overlaySize / 2, overlaySize / 2 + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    ctx.drawImage(img, ox, oy, overlaySize, overlaySize);
  } catch {
    // Overlay icon failed to load — skip.
  }

  const buf = canvas.toBuffer('image/png');
  return `data:image/png;base64,${buf.toString('base64')}`;
}
