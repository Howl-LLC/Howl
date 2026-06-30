// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Decorative fonts that power the Pro 'nameFont' feature.
// Loaded on demand via @font-face injection the first time a name using that
// font is rendered. Loading is idempotent; repeated calls for the same font
// are a no-op.

const loaded = new Set<string>();

const WEIGHT_LABEL: Record<number, string> = { 400: 'Regular', 700: 'Bold' };

const DECORATIVE_FONTS: Record<string, { weights: number[]; family: string; urlBase: string }> = {
  pacifico:           { weights: [400],      family: 'Pacifico',          urlBase: '/fonts/pacifico/Pacifico' },
  nunito:             { weights: [400, 700], family: 'Nunito',            urlBase: '/fonts/nunito/Nunito' },
  'press-start-2p':   { weights: [400],      family: 'Press Start 2P',   urlBase: '/fonts/press-start-2p/PressStart2P' },
  'playfair-display': { weights: [400, 700], family: 'Playfair Display', urlBase: '/fonts/playfair-display/PlayfairDisplay' },
  orbitron:           { weights: [400, 700], family: 'Orbitron',          urlBase: '/fonts/orbitron/Orbitron' },
  caveat:             { weights: [400, 700], family: 'Caveat',            urlBase: '/fonts/caveat/Caveat' },
};

// Map NAME_FONTS keys (from shared/planPerks.ts) to the decorative font slug
// that should be lazy-loaded when that key is used.
const KEY_TO_SLUG: Record<string, string> = {
  handwritten: 'pacifico',
  rounded:     'nunito',
  pixel:       'press-start-2p',
  elegant:     'playfair-display',
  futuristic:  'orbitron',
  script:      'caveat',
};

/**
 * Lazily inject @font-face declarations for a decorative Pro nameFont.
 * Accepts either the planPerks key (e.g. 'handwritten') or the font slug
 * (e.g. 'pacifico'). Safe to call repeatedly; only injects once per font.
 */
export function loadFont(nameOrKey: string): void {
  const slug = KEY_TO_SLUG[nameOrKey] ?? nameOrKey;
  if (loaded.has(slug)) return;
  const def = DECORATIVE_FONTS[slug];
  if (!def) return;
  loaded.add(slug);

  const style = document.createElement('style');
  style.textContent = def.weights
    .map(
      (w) => `
@font-face {
  font-family: '${def.family}';
  font-weight: ${w};
  font-style: normal;
  font-display: swap;
  src: url('${def.urlBase}-${WEIGHT_LABEL[w] ?? 'Regular'}.woff2') format('woff2');
}`,
    )
    .join('\n');
  document.head.appendChild(style);
}
