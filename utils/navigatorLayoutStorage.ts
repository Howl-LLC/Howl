// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Client-only persistence for the Howl Navigator overlay (the `default`-layout
 * rail-less server launcher).
 *
 * This is deliberately PER-DEVICE and NOT backend-synced — it stores where the
 * user has dragged each server tile on the free canvas, the user-made "section"
 * note-cards (titles, colors, geometry, membership), and the snap-to-grid pref.
 * Server *folders* remain backend-synced via serverFolderStore; sections only
 * ever *reference* server/folder ids, so deleting a folder server-side simply
 * drops a stale reference here (handled gracefully at render time).
 *
 * Mirrors the defensive get/set style of utils/uiDensityStorage.ts: every read
 * is wrapped in try/catch (storage may be blocked), malformed blobs fall back
 * to a fresh default, and unknown shapes are normalized rather than trusted.
 */

const NAVIGATOR_LAYOUT_KEY = 'howl_navigator_layout';
const LAYOUT_VERSION = 1;

/** A loose tile's free position on the canvas (top-left corner, world coords). */
export interface NavTilePos {
  x: number;
  y: number;
}

/** A free-floating, user-made "note" section card on the canvas. `items` holds
 *  server/folder ids; their type is resolved at render time against the live
 *  server/folder stores (ids are distinct UUIDs, so no collision). */
export interface NavSection {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** outline (border) color */
  oc: string;
  /** fill (background) color */
  fc: string;
  expanded: boolean;
  items: string[];
}

export interface NavigatorLayout {
  version: number;
  /** loose-tile id -> position. Tiles not present here are auto-seeded by the canvas. */
  positions: Record<string, NavTilePos>;
  sections: NavSection[];
  /** macOS-style snap-to-grid toggle (off by default → free placement). */
  snap: boolean;
  /** Whether the built-in "howl" nav section has been seeded yet. Seeded once,
   *  then it's a normal user-editable/deletable section (deletion sticks). */
  howlSeeded: boolean;
}

/**
 * Section look: a BLACK card with a faint white hairline OUTLINE. Choosing a
 * colour tints the hairline outline only — the fill stays black (a "tiny
 * visible difference", per the design). `oc` = outline colour, `fc` = fill.
 */
export const NAV_SECTION_DEFAULT_OUTLINE = 'rgba(255,255,255,0.85)';
export const NAV_SECTION_DEFAULT_FILL = '#000000';

/** Outline-colour presets offered in the section menu — the swatch tints the
 *  hairline; the fill stays black. "Blue" is the deep Howl-logo navy. */
export const NAV_SECTION_PRESETS: ReadonlyArray<{ oc: string; fc: string }> = [
  { oc: NAV_SECTION_DEFAULT_OUTLINE, fc: NAV_SECTION_DEFAULT_FILL },
  { oc: '#102C49', fc: '#000000' },
  { oc: '#2bc46a', fc: '#000000' },
  { oc: '#e0654b', fc: '#000000' },
  { oc: '#8a6cf0', fc: '#000000' },
];

/** Normalise any previously-persisted section colours to the current black-fill
 *  + coloured-hairline scheme. Handles BOTH the original palette (coloured
 *  outline over a near-black tinted fill) and the short-lived solid-fill palette
 *  (oc === fc) that shipped briefly in between, so no section renders invisibly
 *  or as a solid block after this revert. */
export function canonicalizeSectionColors(oc: string, fc: string): { oc: string; fc: string } {
  const BLACK = '#000000';
  switch (oc) {
    // Short-lived solid-fill palette → coloured hairline + black fill.
    case '#076FA0': return { oc: '#102C49', fc: BLACK };
    case '#0f7a45': return { oc: '#2bc46a', fc: BLACK };
    case '#a83a2a': return { oc: '#e0654b', fc: BLACK };
    case '#5a45b0': return { oc: '#8a6cf0', fc: BLACK };
    case '#16181f':
    case '#2a2d36': return { oc: NAV_SECTION_DEFAULT_OUTLINE, fc: NAV_SECTION_DEFAULT_FILL };
    // Original palette + default outline: keep the outline colour, force black fill.
    case '#2bc46a':
    case '#e0654b':
    case '#8a6cf0':
    case 'rgba(255,255,255,0.85)': return { oc, fc: BLACK };
    default: return { oc, fc };
  }
}

function emptyLayout(): NavigatorLayout {
  return { version: LAYOUT_VERSION, positions: {}, sections: [], snap: false, howlSeeded: false };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function normalizePos(v: unknown): NavTilePos | null {
  if (!v || typeof v !== 'object') return null;
  const p = v as Record<string, unknown>;
  if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return null;
  return { x: p.x, y: p.y };
}

function normalizeSection(v: unknown): NavSection | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== 'string' || !s.id) return null;
  if (!isFiniteNumber(s.x) || !isFiniteNumber(s.y) || !isFiniteNumber(s.w) || !isFiniteNumber(s.h)) return null;
  const items = Array.isArray(s.items) ? s.items.filter((i): i is string => typeof i === 'string') : [];
  const { oc, fc } = canonicalizeSectionColors(
    typeof s.oc === 'string' ? s.oc : NAV_SECTION_DEFAULT_OUTLINE,
    typeof s.fc === 'string' ? s.fc : NAV_SECTION_DEFAULT_FILL,
  );
  return {
    id: s.id,
    title: typeof s.title === 'string' ? s.title : 'Section',
    x: s.x,
    y: s.y,
    w: s.w,
    h: s.h,
    oc,
    fc,
    expanded: s.expanded === true,
    items,
  };
}

/** Read the persisted layout, normalizing/repairing any malformed shape. Never throws. */
export function getNavigatorLayout(): NavigatorLayout {
  try {
    const raw = localStorage.getItem(NAVIGATOR_LAYOUT_KEY);
    if (!raw) return emptyLayout();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return emptyLayout();

    const positions: Record<string, NavTilePos> = {};
    const rawPos = parsed.positions;
    if (rawPos && typeof rawPos === 'object') {
      for (const [id, val] of Object.entries(rawPos as Record<string, unknown>)) {
        const p = normalizePos(val);
        if (p) positions[id] = p;
      }
    }

    const sections: NavSection[] = [];
    if (Array.isArray(parsed.sections)) {
      const seen = new Set<string>();
      for (const sv of parsed.sections) {
        const s = normalizeSection(sv);
        if (s && !seen.has(s.id)) { seen.add(s.id); sections.push(s); }
      }
    }

    return {
      version: LAYOUT_VERSION,
      positions,
      sections,
      snap: parsed.snap === true,
      howlSeeded: parsed.howlSeeded === true,
    };
  } catch {
    return emptyLayout();
  }
}

/** Persist the layout. Silently no-ops if storage is blocked. */
export function setNavigatorLayout(layout: NavigatorLayout): void {
  try {
    localStorage.setItem(NAVIGATOR_LAYOUT_KEY, JSON.stringify({ ...layout, version: LAYOUT_VERSION }));
  } catch {
    /* storage blocked / quota — non-fatal, layout just won't persist this device */
  }
}
