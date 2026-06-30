// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * generate-icons.mjs
 *
 * Auto-generates all required PNG icon assets for the Elgato Stream Deck plugin
 * from the Lucide SVG data URLs defined in src/actions/shared/icons.ts and the
 * Howl logo at public/howl-logo.png.
 *
 * Output structure (under com.howlpro.streamdeck.sdPlugin/imgs/):
 *   actions/<slug>/icon.png      — 20x20  (action list thumbnail, transparent bg)
 *   actions/<slug>/icon@2x.png   — 40x40  (HiDPI action list thumbnail)
 *   actions/<slug>/key.png       — 72x72  (default key image with dark bg)
 *   actions/<slug>/key@2x.png    — 144x144 (HiDPI default key image)
 *   plugin.png                   — 28x28  (plugin list icon)
 *   plugin@2x.png                — 56x56  (HiDPI plugin list icon)
 *   category.png                 — 28x28  (category sidebar icon)
 *   category@2x.png              — 56x56  (HiDPI category sidebar icon)
 *
 * Usage: node scripts/generate-icons.mjs
 */

import { createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, '..');
const repoRoot = resolve(projectRoot, '..');
const imgsDir = resolve(projectRoot, 'com.howlpro.streamdeck.sdPlugin', 'imgs');

// SVG icon builders (mirroring src/actions/shared/icons.ts)

function svgDataUrl(paths, filled = false) {
  const attrs = filled
    ? 'fill="#fff" stroke="none"'
    : 'fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ${attrs}>${paths}</svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

function dotSvgDataUrl(color) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="8" fill="${color}" stroke="${color}" stroke-width="1"/></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

// All icons from icons.ts, duplicated here so the script is self-contained.
const ICONS = {
  ICON_MIC: svgDataUrl(
    '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>' +
    '<path d="M19 10v2a7 7 0 0 1-14 0v-2"/>' +
    '<line x1="12" x2="12" y1="19" y2="22"/>'
  ),
  ICON_HEADPHONES: svgDataUrl(
    '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>'
  ),
  ICON_CAMERA: svgDataUrl(
    '<path d="m16 13 5.223 3.482a.5.5 0 0 0 .777-.416V7.87a.5.5 0 0 0-.752-.432L16 10.5"/>' +
    '<rect x="2" y="6" width="14" height="12" rx="2"/>'
  ),
  ICON_PHONE_DOWN: svgDataUrl(
    '<path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"/>' +
    '<line x1="23" x2="1" y1="1" y2="23"/>'
  ),
  ICON_PHONE_PICKUP: svgDataUrl(
    '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>'
  ),
  ICON_X: svgDataUrl(
    '<line x1="18" x2="6" y1="6" y2="18"/>' +
    '<line x1="6" x2="18" y1="6" y2="18"/>'
  ),
  ICON_SWITCH: svgDataUrl(
    '<path d="m16 3 4 4-4 4"/>' +
    '<path d="M20 7H4"/>' +
    '<path d="m8 21-4-4 4-4"/>' +
    '<path d="M4 17h16"/>'
  ),
  ICON_HEADSET: svgDataUrl(
    '<path d="M2 10v3a2 2 0 0 0 2 2h2V8H4a2 2 0 0 0-2 2Z"/>' +
    '<path d="M22 10v3a2 2 0 0 1-2 2h-2V8h2a2 2 0 0 1 2 2Z"/>' +
    '<path d="M4 12a8 8 0 0 1 16 0"/>' +
    '<path d="M18 15v2a4 4 0 0 1-4 4h-4"/>'
  ),
  ICON_USER: svgDataUrl(
    '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="12" cy="7" r="4"/>'
  ),
  ICON_DOT_ONLINE: dotSvgDataUrl('#2ecc71'),
  ICON_REFRESH: svgDataUrl(
    '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>' +
    '<path d="M21 3v5h-5"/>' +
    '<path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>' +
    '<path d="M3 21v-5h5"/>'
  ),
  ICON_HASH: svgDataUrl(
    '<line x1="4" x2="20" y1="9" y2="9"/>' +
    '<line x1="4" x2="20" y1="15" y2="15"/>' +
    '<line x1="10" x2="8" y1="3" y2="21"/>' +
    '<line x1="16" x2="14" y1="3" y2="21"/>'
  ),
  ICON_MESSAGE_CIRCLE: svgDataUrl(
    '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>'
  ),
  ICON_LOCK_OPEN: svgDataUrl(
    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/>' +
    '<path d="M7 11V7a5 5 0 0 1 9.9-1"/>'
  ),
  ICON_STAGE: svgDataUrl(
    '<path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/>' +
    '<path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.4"/>' +
    '<path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.4"/>' +
    '<path d="M19.1 4.9C23 8.8 23 15.1 19.1 19"/>' +
    '<circle cx="12" cy="12" r="2"/>'
  ),
  ICON_USER_MINUS: svgDataUrl(
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/>' +
    '<circle cx="9" cy="7" r="4"/>' +
    '<line x1="22" x2="16" y1="11" y2="11"/>'
  ),
  ICON_BELL: svgDataUrl(
    '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/>' +
    '<path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>'
  ),
  // Smile icon (lucide: smile) — for react-focused action list icon
  ICON_SMILE: svgDataUrl(
    '<circle cx="12" cy="12" r="10"/>' +
    '<path d="M8 14s1.5 2 4 2 4-2 4-2"/>' +
    '<line x1="9" x2="9.01" y1="9" y2="9"/>' +
    '<line x1="15" x2="15.01" y1="9" y2="9"/>'
  ),
};

// Action slug → default-state icon mapping
// Derived from reading each action file's render() method's resting state.

const ACTION_ICON_MAP = {
  'voice-mute':                ICONS.ICON_MIC,
  'voice-deafen':              ICONS.ICON_HEADPHONES,
  'voice-ptt':                 ICONS.ICON_MIC,
  'voice-camera':              ICONS.ICON_CAMERA,
  'voice-hangup':              ICONS.ICON_PHONE_DOWN,
  'voice-switch-channel':      ICONS.ICON_SWITCH,
  'voice-device-switcher':     ICONS.ICON_HEADSET,
  'call-answer':               ICONS.ICON_PHONE_PICKUP,
  'call-decline':              ICONS.ICON_X,
  'call-end':                  ICONS.ICON_PHONE_DOWN,
  'presence-rotate':           ICONS.ICON_REFRESH,
  'presence-set':              ICONS.ICON_DOT_ONLINE,
  'reaction-react-focused':    ICONS.ICON_SMILE,
  'channel-switch':            ICONS.ICON_HASH,
  'dm-open-pinned':            ICONS.ICON_USER,
  'thread-start-from-focused': ICONS.ICON_MESSAGE_CIRCLE,
  'thread-lock-toggle':        ICONS.ICON_LOCK_OPEN,
  'stage-start-end':           ICONS.ICON_STAGE,
  'stage-remove-speaker':      ICONS.ICON_USER_MINUS,
  'indicator-unread-summary':  ICONS.ICON_BELL,
};

const BG_DEFAULT = '#1e2228';

// Rendering helpers

/**
 * Render a transparent-background icon (for action list thumbnails).
 * White icon on transparent, centered.
 */
async function renderIcon(svgDataUrl, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  // Transparent background — no fill.

  try {
    const img = await loadImage(svgDataUrl);
    // Use ~80% of size for icon to leave some padding
    const iconSize = Math.floor(size * 0.8);
    const offset = (size - iconSize) / 2;
    ctx.drawImage(img, offset, offset, iconSize, iconSize);
  } catch (e) {
    console.warn(`  Warning: failed to rasterize icon SVG at ${size}px: ${e.message}`);
  }

  return canvas.toBuffer('image/png');
}

/**
 * Render a key image with dark background + centered icon (matches runtime renderKey).
 */
async function renderKeyImage(svgDataUrl, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Dark background
  ctx.fillStyle = BG_DEFAULT;
  ctx.fillRect(0, 0, size, size);

  // Centered icon at ~50% of key size (matches render.ts: size * 0.5)
  if (svgDataUrl) {
    try {
      const img = await loadImage(svgDataUrl);
      const iconSize = Math.floor(size * 0.5);
      const offset = (size - iconSize) / 2;
      ctx.drawImage(img, offset, offset, iconSize, iconSize);
    } catch (e) {
      console.warn(`  Warning: failed to rasterize key icon SVG at ${size}px: ${e.message}`);
    }
  }

  return canvas.toBuffer('image/png');
}

/**
 * Resize the Howl logo to a given size with transparent background.
 */
async function renderLogo(logoBuf, size) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  // Transparent background.

  const img = await loadImage(logoBuf);
  ctx.drawImage(img, 0, 0, size, size);

  return canvas.toBuffer('image/png');
}

// Main

async function main() {
  console.log('Generating Stream Deck plugin icons...\n');
  let fileCount = 0;

  // Load the Howl logo
  const logoPath = resolve(repoRoot, 'public', 'howl-logo.png');
  let logoBuf;
  try {
    logoBuf = readFileSync(logoPath);
    console.log(`  Loaded Howl logo: ${logoPath} (${logoBuf.length} bytes)`);
  } catch (e) {
    console.error(`  ERROR: Could not load Howl logo at ${logoPath}: ${e.message}`);
    process.exit(1);
  }

  // 1. Action icons
  const slugs = Object.keys(ACTION_ICON_MAP);
  console.log(`  Generating icons for ${slugs.length} actions...`);

  for (const slug of slugs) {
    const svgUrl = ACTION_ICON_MAP[slug];
    const actionDir = resolve(imgsDir, 'actions', slug);
    mkdirSync(actionDir, { recursive: true });

    // icon.png (20x20) — transparent bg, action list
    const icon20 = await renderIcon(svgUrl, 20);
    writeFileSync(resolve(actionDir, 'icon.png'), icon20);
    fileCount++;

    // icon@2x.png (40x40)
    const icon40 = await renderIcon(svgUrl, 40);
    writeFileSync(resolve(actionDir, 'icon@2x.png'), icon40);
    fileCount++;

    // key.png (72x72) — dark bg, default key image
    const key72 = await renderKeyImage(svgUrl, 72);
    writeFileSync(resolve(actionDir, 'key.png'), key72);
    fileCount++;

    // key@2x.png (144x144)
    const key144 = await renderKeyImage(svgUrl, 144);
    writeFileSync(resolve(actionDir, 'key@2x.png'), key144);
    fileCount++;

    console.log(`    ${slug}: 4 files`);
  }

  // 2. Plugin-level icons
  console.log('  Generating plugin and category icons...');

  // plugin.png (28x28) + plugin@2x.png (56x56)
  const plugin28 = await renderLogo(logoBuf, 28);
  writeFileSync(resolve(imgsDir, 'plugin.png'), plugin28);
  fileCount++;

  const plugin56 = await renderLogo(logoBuf, 56);
  writeFileSync(resolve(imgsDir, 'plugin@2x.png'), plugin56);
  fileCount++;

  // category.png (28x28) + category@2x.png (56x56)
  const cat28 = await renderLogo(logoBuf, 28);
  writeFileSync(resolve(imgsDir, 'category.png'), cat28);
  fileCount++;

  const cat56 = await renderLogo(logoBuf, 56);
  writeFileSync(resolve(imgsDir, 'category@2x.png'), cat56);
  fileCount++;

  console.log(`    plugin.png, plugin@2x.png, category.png, category@2x.png`);

  // Summary
  console.log(`\n  Done. Generated ${fileCount} PNG files.`);
}

main().catch((err) => {
  console.error('Icon generation failed:', err);
  process.exit(1);
});
