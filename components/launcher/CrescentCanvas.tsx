// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, X, Grid3x3, MoreHorizontal, Pencil, Trash2, Users, MessageSquare, Compass, Bell, User as UserIcon } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { NavigationTarget } from '../../types';
import { assetPath } from '../../utils/assetPath';
import { ServerIcon } from '../ServerIcon';
import { useServerStore } from '../../stores/serverStore';
import { useServerFolderStore } from '../../stores/serverFolderStore';
import { useNavigationStore } from '../../stores/navigationStore';
import { useNotificationStore } from '../../stores/notificationStore';
import { useAuthStore } from '../../stores/authStore';
import { STATUS_COLORS } from '../../shared/statusColors';
import {
  getNavigatorLayout, setNavigatorLayout, NAV_SECTION_PRESETS,
  NAV_SECTION_DEFAULT_OUTLINE, NAV_SECTION_DEFAULT_FILL,
  type NavigatorLayout, type NavSection,
} from '../../utils/navigatorLayoutStorage';

// Geometry (layout constants; values are cosmetic)
const S = 64;                 // loose tile size (matches --hn-tile-size)
const CW = 96, CH = 116;      // grid cell w/h (snap + auto-layout)
const OX = 20, OY = 16;
const TOPBASE = OY + CH / 2 - S / 2;
const MINI = 44, MGAP = 10, CELLI = MINI + MGAP, PADc = 10;
// The world is effectively infinite: its size is derived dynamically from the
// current content extent (see `world` useMemo below) so it always grows to fit
// wherever tiles/sections are placed. These are only the minimum dimensions.
const WORLD_MIN_W = 4200, WORLD_MIN_H = 3000;
const BASEX = 1450, BASEY = 1080;
const SEC_OH = 53;

// Built-in "howl" nav section — a normal (movable/editable/deletable) section,
// seeded onto the canvas, whose grid renders the app's primary destinations
// instead of server tiles. Identified by this sentinel id.
const HOWL_SECTION_ID = '__howl__';
const HOWL_NAV: ReadonlyArray<{
  id: string; label: string; target: NavigationTarget; Icon?: LucideIcon; logo?: boolean;
  badge?: 'messages' | 'friends' | 'notifications'; status?: boolean;
}> = [
  // Home renders the Howl logo (the brand mark), not a generic house glyph.
  { id: 'home', label: 'Home', target: 'home', logo: true },
  { id: 'friends', label: 'Friends', target: 'friends', Icon: Users, badge: 'friends' },
  { id: 'account', label: 'You', target: 'account', Icon: UserIcon, status: true },
  { id: 'dm', label: 'Messages', target: 'dm', Icon: MessageSquare, badge: 'messages' },
  { id: 'discover', label: 'Discover', target: 'discover', Icon: Compass },
  { id: 'notifications', label: 'Activity', target: 'notifications', Icon: Bell, badge: 'notifications' },
];
const HOWL_NAV_MAP = new Map(HOWL_NAV.map(n => [n.id, n] as const));

const secW = (cols: number) => cols * MINI + (cols - 1) * MGAP + PADc * 2;
const gridMinH = (rows: number) => rows * MINI + (rows - 1) * MGAP;
const secH = (rows: number) => SEC_OH + gridMinH(rows);
const colsFromW = (w: number) => Math.max(2, Math.min(6, Math.round((w - 10) / CELLI)));
const rowsFromH = (h: number) => Math.max(1, Math.min(6, Math.round((h - 43) / CELLI)));
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// A position is only usable if it has finite x/y. Persisted layouts from older
// builds (or partial writes) can leave malformed/empty entries; every consumer
// of `positions[id]` goes through this so a bad entry degrades to "skip" rather
// than throwing `Cannot read properties of undefined (reading 'x')` mid-render.
const validPos = (p?: { x: number; y: number }): p is { x: number; y: number } =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.y);

// Render-time fill for a section card. Sections store an explicit per-section
// fill (`fc`); the legacy/default fill is an opaque black that ignores the app
// theme, so resolve it to a theme surface token instead. User-chosen explicit
// fills (anything other than the legacy default) are rendered as-is.
const sectionFill = (fc: string): string =>
  fc === NAV_SECTION_DEFAULT_FILL ? 'var(--bg-elevated)' : fc;

// Inject the built-in "howl" section once (then it's a normal user-owned
// section: movable, renamable, recolorable, resizable, deletable — and once
// deleted it stays gone, because `howlSeeded` is sticky).
function seedHowlSection(l: NavigatorLayout): NavigatorLayout {
  if (l.howlSeeded) return l;
  if (l.sections.some(s => s.id === HOWL_SECTION_ID)) return { ...l, howlSeeded: true };
  const howl: NavSection = {
    id: HOWL_SECTION_ID, title: 'howl', x: BASEX - 4, y: BASEY - 210,
    w: secW(3), h: secH(2), oc: '#102C49', fc: '#000000', expanded: false,
    items: HOWL_NAV.map(n => n.id),
  };
  return { ...l, howlSeeded: true, sections: [howl, ...l.sections] };
}

interface Gesture {
  kind: 'loose' | 'sec' | 'resize';
  id: string;
  vpLeft: number; vpTop: number; panX: number; panY: number; scale: number;
  offX: number; offY: number;
  lastX: number; lastY: number;
  startX: number; startY: number;
  w: number; h: number;
  moved: boolean;
}

interface CrescentCanvasProps {
  /** Navigate to a server/target (parent routes + closes the overlay). */
  onNavigate: (target: NavigationTarget) => void;
  /** Open the create/join-server modal (reuses the app's existing modal). */
  onAddServer: () => void;
  /** Close the whole navigator overlay (the toolbar ✕). */
  onClose: () => void;
  /** Drives the corner-fan reveal: true = fly in from the corner, false = fly back (reverse). */
  open: boolean;
}

export const CrescentCanvas: React.FC<CrescentCanvasProps> = ({ onNavigate, onAddServer, onClose, open }) => {
  const servers = useServerStore(s => s.servers);
  const folders = useServerFolderStore(s => s.folders);
  const activeServerId = useNavigationStore(s => s.activeServerId);
  const serverMentionCounts = useNotificationStore(s => s.serverMentionCounts);
  const serverUnreadIds = useNotificationStore(s => s.serverUnreadIds);
  // Badges + status for the built-in "howl" nav section.
  const messagesBadge = useNotificationStore(s => { let n = 0; for (const id of s.unreadDmChannelIds) n += s.dmUnreadCounts[id] || 0; return n; });
  const friendsBadge = useNotificationStore(s => s.pendingFriendRequestCount);
  const notificationsBadge = useNotificationStore(s => s.notificationCounts.total);
  const userStatus = useAuthStore(s => s.currentUserStatus);

  // Only folders that contain at least one server the user is actually in.
  const foldersWithServers = useMemo(() => {
    const ids = new Set(servers.map(s => s.id));
    return folders.filter(f => f.serverIds.some(id => ids.has(id)));
  }, [folders, servers]);

  const serverById = useMemo(() => new Map(servers.map(s => [s.id, s])), [servers]);
  const folderById = useMemo(() => new Map(foldersWithServers.map(f => [f.id, f])), [foldersWithServers]);
  const allTileIds = useMemo(() => {
    // Folder-member servers render only inside their folder tile — exclude them
    // from the loose/top-level set (mirrors the Sidebar's uncategorized split),
    // otherwise every foldered server would also appear as a standalone tile.
    const inFolder = new Set(foldersWithServers.flatMap(f => f.serverIds));
    const looseServerIds = servers.filter(s => !inFolder.has(s.id)).map(s => s.id);
    return [...looseServerIds, ...foldersWithServers.map(f => f.id)];
  }, [servers, foldersWithServers]);
  const tilesKey = allTileIds.join('|');

  const nameOf = useCallback((id: string) => HOWL_NAV_MAP.get(id)?.label ?? folderById.get(id)?.name ?? serverById.get(id)?.name ?? '', [folderById, serverById]);

  // Persisted layout (client-only, per-device)
  const [layout, setLayout] = useState<NavigatorLayout>(() => seedHowlSection(getNavigatorLayout()));
  const { positions, sections, snap } = layout;
  const setPositions = useCallback((upd: (p: NavigatorLayout['positions']) => NavigatorLayout['positions']) =>
    setLayout(l => ({ ...l, positions: upd(l.positions) })), []);
  const setSections = useCallback((upd: (s: NavSection[]) => NavSection[]) =>
    setLayout(l => ({ ...l, sections: upd(l.sections) })), []);

  // Debounced persistence — keeps localStorage writes off the drag hot path.
  useEffect(() => {
    const t = setTimeout(() => setNavigatorLayout(layout), 300);
    return () => clearTimeout(t);
  }, [layout]);

  // Flush the final layout on unmount. Close-on-select / Escape / ✕ unmount the
  // overlay synchronously, so a pending debounced write above would otherwise be
  // dropped and the last drag/edit silently lost.
  const latestLayoutRef = useRef(layout);
  latestLayoutRef.current = layout;
  useEffect(() => () => setNavigatorLayout(latestLayoutRef.current), []);

  // Seed positions for any tile not yet placed and not already in a section,
  // and prune orphaned positions for servers/folders the user no longer has.
  useEffect(() => {
    setLayout(prev => {
      const inSection = new Set(prev.sections.flatMap(s => s.items));
      const live = new Set(allTileIds);
      const loose = allTileIds.filter(id => !inSection.has(id));
      const positions = { ...prev.positions };
      let changed = false;
      for (const id of Object.keys(positions)) {
        // Drop malformed/corrupt position entries outright (legacy data).
        if (!validPos(positions[id])) { delete positions[id]; changed = true; continue; }
        // Keep loose nav destinations (dragged out of the howl section) — they
        // aren't in allTileIds (servers/folders) but are valid loose tiles.
        if (!live.has(id) && !inSection.has(id) && !HOWL_NAV_MAP.has(id)) { delete positions[id]; changed = true; }
      }
      // Prune stale section items referencing servers/folders the user no longer
      // has (built-in nav ids + live server/folder ids are kept). Without this a
      // deleted server lingering in a section item renders as a broken tile.
      let sections = prev.sections;
      const pruned = sections.map(s => {
        const keep = s.items.filter(id => HOWL_NAV_MAP.has(id) || live.has(id));
        return keep.length === s.items.length ? s : { ...s, items: keep };
      });
      if (pruned.some((s, i) => s !== sections[i])) { sections = pruned; changed = true; }
      let n = loose.filter(id => positions[id]).length;
      for (const id of loose) {
        if (!positions[id]) {
          const col = n % 8, row = Math.floor(n / 8);
          positions[id] = { x: BASEX + col * CW, y: BASEY + row * CH };
          n++; changed = true;
        }
      }
      return changed ? { ...prev, positions, sections } : prev;
    });
  }, [tilesKey]);

  // View transform (ephemeral — opens centered, never persisted)
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const [dragKind, setDragKind] = useState<Gesture['kind'] | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const act = useRef<Gesture | null>(null);
  const panRef = useRef<{ sx: number; sy: number; px: number; py: number; vw: number; vh: number } | null>(null);
  const inited = useRef(false);
  const miniCleanup = useRef<(() => void) | null>(null);
  // Tear down any in-flight window-level mini-drag listeners if we unmount mid-gesture.
  useEffect(() => () => { miniCleanup.current?.(); }, []);

  const contentBounds = useCallback(() => {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    const live = new Set(allTileIds);
    for (const id in positions) { if (!live.has(id) && !HOWL_NAV_MAP.has(id)) continue; const q = positions[id]; if (!validPos(q)) continue; a = Math.min(a, q.x); b = Math.min(b, q.y); c = Math.max(c, q.x + CW); d = Math.max(d, q.y + S + 30); }
    for (const s of sections) { a = Math.min(a, s.x); b = Math.min(b, s.y); c = Math.max(c, s.x + s.w); d = Math.max(d, s.y + s.h); }
    if (!Number.isFinite(a)) { a = BASEX; b = BASEY; c = BASEX + CW; d = BASEY + CH; }
    return { minX: a, minY: b, maxX: c, maxY: d };
  }, [positions, sections, allTileIds]);

  // Effectively-infinite world: grow the canvas to fit the current content
  // extent plus generous padding so placement is never clamped smaller than
  // where items already are. Pan already follows contentBounds(), so a growing
  // world + pan = an unbounded surface in every direction.
  const world = useMemo(() => {
    const b = contentBounds();
    return {
      w: Math.max(WORLD_MIN_W, b.maxX + 1200),
      h: Math.max(WORLD_MIN_H, b.maxY + 1200),
    };
  }, [contentBounds]);

  // Center on content the first time the viewport has a size, then reveal.
  useLayoutEffect(() => {
    if (inited.current) return;
    const el = viewportRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width) return;
    const bnd = contentBounds();
    setPan({ x: r.width / 2 - (bnd.minX + bnd.maxX) / 2, y: r.height / 2 - (bnd.minY + bnd.maxY) / 2 });
    inited.current = true;
  });

  // Snap helpers
  const cellOf = (p: { x: number; y: number }): [number, number] => [Math.round((p.x - OX) / CW), Math.round((p.y - TOPBASE) / CH)];
  const findFreeCell = (c: number, r: number, occ: Set<string>): [number, number] => {
    if (!occ.has(c + ',' + r)) return [c, r];
    for (let rad = 1; rad < 14; rad++)
      for (let dc = -rad; dc <= rad; dc++)
        for (let dr = -rad; dr <= rad; dr++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== rad) continue;
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nr < 0) continue;
          if (!occ.has(nc + ',' + nr)) return [nc, nr];
        }
    return [c, r];
  };
  // When snap turns ON, tidy loose tiles onto free cells (no overlaps).
  const prevSnap = useRef(snap);
  useEffect(() => {
    if (snap && !prevSnap.current) {
      setPositions(p => {
        const occ = new Set<string>(); const o: typeof p = {};
        for (const k of Object.keys(p)) {
          let [c, r] = cellOf(p[k]); c = Math.max(0, c); r = Math.max(0, r);
          [c, r] = findFreeCell(c, r, occ); occ.add(c + ',' + r);
          o[k] = { x: OX + c * CW, y: TOPBASE + r * CH };
        }
        return o;
      });
    }
    prevSnap.current = snap;
  }, [snap, setPositions]);

  // Pan (grab empty canvas)
  const panDown = (e: React.PointerEvent) => {
    const el = e.target as HTMLElement;
    if (el.closest('.hn-item') || el.closest('.hn-section-card') || el.closest('.hn-menu-backdrop')) return;
    const vp = e.currentTarget.getBoundingClientRect();
    panRef.current = { sx: e.clientX, sy: e.clientY, px: pan.x, py: pan.y, vw: vp.width, vh: vp.height };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    setPanning(true); setOpenMenu(null);
  };
  const panMove = (e: React.PointerEvent) => {
    const p = panRef.current; if (!p) return;
    const M = 110, bnd = contentBounds();
    const loX = M - bnd.maxX * scale, hiX = p.vw - M - bnd.minX * scale;
    const loY = M - bnd.maxY * scale, hiY = p.vh - M - bnd.minY * scale;
    setPan({
      x: clamp(p.px + (e.clientX - p.sx), Math.min(loX, hiX), Math.max(loX, hiX)),
      y: clamp(p.py + (e.clientY - p.sy), Math.min(loY, hiY), Math.max(loY, hiY)),
    });
  };
  const panUp = () => { panRef.current = null; setPanning(false); };

  // Zoom
  const zoomAt = (factor: number, clientX: number, clientY: number) => {
    const vp = viewportRef.current?.getBoundingClientRect(); if (!vp) return;
    const s2 = clamp(scale * factor, 0.55, 1.8);
    if (s2 === scale) return;
    const wx = (clientX - vp.left - pan.x) / scale, wy = (clientY - vp.top - pan.y) / scale;
    setScale(s2);
    setPan({ x: clientX - vp.left - wx * s2, y: clientY - vp.top - wy * s2 });
  };
  const zoomCenter = (f: number) => { const vp = viewportRef.current?.getBoundingClientRect(); if (vp) zoomAt(f, vp.left + vp.width / 2, vp.top + vp.height / 2); };
  const onWheel = (e: React.WheelEvent) => { zoomAt(e.deltaY < 0 ? 1.12 : 1 / 1.12, e.clientX, e.clientY); };

  // Section helpers
  const sectionAtPoint = (sx: number, sy: number): string | null => {
    const nodes = canvasRef.current?.querySelectorAll('[data-sec]'); if (!nodes) return null;
    for (const n of Array.from(nodes)) {
      const r = (n as HTMLElement).getBoundingClientRect();
      if (sx >= r.left && sx <= r.right && sy >= r.top && sy <= r.bottom) return (n as HTMLElement).dataset.sec ?? null;
    }
    return null;
  };
  const updateSec = (id: string, patch: Partial<NavSection>) =>
    setSections(secs => secs.map(s => (s.id === id ? { ...s, ...patch } : s)));

  // Loose tile drag
  const looseDown = (e: React.PointerEvent, id: string) => {
    const vp = viewportRef.current?.getBoundingClientRect(); if (!vp) return;
    const cur = positions[id] ?? { x: BASEX, y: BASEY };
    act.current = {
      kind: 'loose', id, vpLeft: vp.left, vpTop: vp.top, panX: pan.x, panY: pan.y, scale,
      offX: (e.clientX - vp.left - pan.x) / scale - cur.x,
      offY: (e.clientY - vp.top - pan.y) / scale - cur.y,
      lastX: cur.x, lastY: cur.y, startX: e.clientX, startY: e.clientY, w: S, h: S, moved: false,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    setDragKind('loose'); setActiveId(id);
  };
  const looseMove = (e: React.PointerEvent) => {
    const a = act.current; if (!a || a.kind !== 'loose') return;
    if (Math.hypot(e.clientX - a.startX, e.clientY - a.startY) > 4) a.moved = true;
    let nx = (e.clientX - a.vpLeft - a.panX) / a.scale - a.offX;
    let ny = (e.clientY - a.vpTop - a.panY) / a.scale - a.offY;
    setDropTarget(sectionAtPoint(e.clientX, e.clientY));
    if (snap) {
      const maxCol = Math.max(0, Math.floor((world.w - OX - CW) / CW));
      const maxRow = Math.max(0, Math.floor((world.h - TOPBASE - CH) / CH));
      const col = clamp(Math.round((nx - OX) / CW), 0, maxCol);
      const row = clamp(Math.round((ny - TOPBASE) / CH), 0, maxRow);
      const cx = OX + col * CW, cy = TOPBASE + row * CH;
      const blocked = Object.keys(positions).some(k => k !== a.id && Math.round((positions[k].x - OX) / CW) === col && Math.round((positions[k].y - TOPBASE) / CH) === row);
      if (!blocked) { a.lastX = cx; a.lastY = cy; setPositions(p => ({ ...p, [a.id]: { x: cx, y: cy } })); }
      return;
    }
    nx = clamp(nx, 0, world.w - CW); ny = clamp(ny, 0, world.h - (S + 34));
    a.lastX = nx; a.lastY = ny;
    setPositions(p => ({ ...p, [a.id]: { x: nx, y: ny } }));
  };
  const looseUp = (e: React.PointerEvent) => {
    const a = act.current;
    if (a && a.kind === 'loose') {
      if (!a.moved) {
        activateTile(a.id, e.clientX, e.clientY);
      } else {
        const tgt = sectionAtPoint(e.clientX, e.clientY);
        if (tgt) {
          setLayout(l => ({
            ...l,
            sections: l.sections.map(s => (s.id === tgt && !s.items.includes(a.id) ? { ...s, items: [...s.items, a.id] } : s)),
            positions: (() => { const o = { ...l.positions }; delete o[a.id]; return o; })(),
          }));
        }
      }
    }
    act.current = null; setDragKind(null); setActiveId(null); setDropTarget(null);
  };

  // Section move
  const secDown = (e: React.PointerEvent, sec: NavSection) => {
    const el = e.target as HTMLElement;
    if (el.closest('.hn-sec-title') || el.closest('.hn-sec-resize') || el.closest('.hn-sec-menu-btn')) return;
    const vp = viewportRef.current?.getBoundingClientRect(); if (!vp) return;
    const node = (e.currentTarget as HTMLElement).closest('.hn-section-card') as HTMLElement | null;
    act.current = {
      kind: 'sec', id: sec.id, vpLeft: vp.left, vpTop: vp.top, panX: pan.x, panY: pan.y, scale,
      offX: (e.clientX - vp.left - pan.x) / scale - sec.x, offY: (e.clientY - vp.top - pan.y) / scale - sec.y,
      lastX: sec.x, lastY: sec.y, startX: e.clientX, startY: e.clientY,
      w: node?.offsetWidth ?? sec.w, h: node?.offsetHeight ?? sec.h, moved: false,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    setDragKind('sec'); setActiveId(sec.id);
  };
  const secMove = (e: React.PointerEvent) => {
    const a = act.current; if (!a || a.kind !== 'sec') return;
    const nx = clamp((e.clientX - a.vpLeft - a.panX) / a.scale - a.offX, 0, Math.max(0, world.w - a.w));
    const ny = clamp((e.clientY - a.vpTop - a.panY) / a.scale - a.offY, 0, Math.max(0, world.h - a.h));
    updateSec(a.id, { x: nx, y: ny });
  };
  const secUp = () => { act.current = null; setDragKind(null); setActiveId(null); };

  // Section resize
  const resizeDown = (e: React.PointerEvent, sec: NavSection) => {
    e.stopPropagation();
    const vp = viewportRef.current?.getBoundingClientRect();
    act.current = {
      kind: 'resize', id: sec.id, vpLeft: vp?.left ?? 0, vpTop: vp?.top ?? 0, panX: pan.x, panY: pan.y, scale,
      offX: 0, offY: 0, lastX: 0, lastY: 0, startX: e.clientX, startY: e.clientY, w: sec.w, h: sec.h, moved: false,
    };
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* noop */ }
    setDragKind('resize'); setActiveId(sec.id);
  };
  const resizeMove = (e: React.PointerEvent) => {
    const a = act.current; if (!a || a.kind !== 'resize') return;
    let w = clamp(a.w + (e.clientX - a.startX) / a.scale, secW(2), secW(6));
    let h = clamp(a.h + (e.clientY - a.startY) / a.scale, secH(1), secH(6));
    if (snap) { w = secW(colsFromW(w)); h = secH(rowsFromH(h)); }
    updateSec(a.id, { w, h });
  };
  const resizeUp = () => { act.current = null; setDragKind(null); setActiveId(null); };

  // Drag a tile OUT of a section (or into another) — window-level pointer
  const miniDown = (e: React.PointerEvent, secId: string, id: string) => {
    e.stopPropagation();
    const vp = viewportRef.current?.getBoundingClientRect(); if (!vp) return;
    const start = { x: e.clientX, y: e.clientY };
    let popped = false;
    const move = (ev: PointerEvent) => {
      if (!popped) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        popped = true;
        setSections(secs => secs.map(s => (s.id === secId ? { ...s, items: s.items.filter(x => x !== id) } : s)));
      }
      const wx = clamp((ev.clientX - vp.left - pan.x) / scale - S / 2, 0, world.w - CW);
      const wy = clamp((ev.clientY - vp.top - pan.y) / scale - S / 2, 0, world.h - (S + 34));
      setPositions(p => ({ ...p, [id]: { x: wx, y: wy } }));
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      miniCleanup.current = null;
    };
    const up = (ev: PointerEvent) => {
      cleanup();
      if (!popped) { activateTile(id, ev.clientX, ev.clientY); return; }
      const tgt = sectionAtPoint(ev.clientX, ev.clientY);
      if (tgt) {
        setLayout(l => ({
          ...l,
          sections: l.sections.map(s => (s.id === tgt && !s.items.includes(id) ? { ...s, items: [...s.items, id] } : s)),
          positions: (() => { const o = { ...l.positions }; delete o[id]; return o; })(),
        }));
      }
    };
    miniCleanup.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // Menu actions
  const focusTitle = (id: string) => requestAnimationFrame(() => {
    const el = canvasRef.current?.querySelector(`[data-sec="${id}"] .hn-sec-title`) as HTMLElement | null;
    if (el) { el.focus(); const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
  });
  const startRename = (id: string) => { setOpenMenu(null); focusTitle(id); };
  const deleteSection = (id: string) => {
    setLayout(l => {
      const s = l.sections.find(x => x.id === id);
      const positions = { ...l.positions };
      if (s) s.items.forEach((iid, i) => { positions[iid] = { x: clamp(s.x + (i % 4) * CW, 0, world.w - CW), y: s.y + Math.floor(i / 4) * CH }; });
      return { ...l, positions, sections: l.sections.filter(x => x.id !== id) };
    });
    setOpenMenu(null);
  };
  const addSection = () => {
    const id = 'n' + Math.round(performance.now()) + Math.round(Math.random() * 1e6);
    const b = contentBounds();
    setSections(secs => [...secs, {
      id, title: 'New section',
      x: clamp(b.minX, 0, world.w - secW(2)), y: clamp(b.maxY + 40, 0, world.h - secH(1)),
      w: secW(2), h: secH(1), items: [], oc: NAV_SECTION_DEFAULT_OUTLINE, fc: NAV_SECTION_DEFAULT_FILL, expanded: false,
    }]);
    focusTitle(id);
  };

  // A server tile navigates directly. A folder tile opens a popover listing its
  // member servers (a folder with a single member just navigates to it).
  const [folderPopover, setFolderPopover] = useState<{ id: string; x: number; y: number } | null>(null);
  useEffect(() => { if (!open) setFolderPopover(null); }, [open]);
  const activateTile = useCallback((id: string, clientX: number, clientY: number) => {
    const folder = folderById.get(id);
    if (folder) {
      const members = folder.serverIds.filter(sid => serverById.has(sid));
      if (members.length === 1) { onNavigate(members[0] as NavigationTarget); return; }
      setFolderPopover({ id, x: clientX, y: clientY });
    } else {
      onNavigate(id as NavigationTarget);
    }
  }, [folderById, serverById, onNavigate]);

  // Reveal (fan from the top-left corner, distance-staggered)
  const q = search.trim().toLowerCase();
  const matches = (id: string) => !q || nameOf(id).toLowerCase().includes(q);
  const inSection = useMemo(() => new Set(sections.flatMap(s => s.items)), [sections]);
  const looseIds = useMemo(() => {
    const base = allTileIds.filter(id => !inSection.has(id) && validPos(positions[id]));
    // Nav destinations the user has dragged out of the howl section onto the canvas.
    const navLoose = HOWL_NAV.filter(n => !inSection.has(n.id) && validPos(positions[n.id])).map(n => n.id);
    return [...base, ...navLoose];
  }, [allTileIds, inSection, positions]);

  const cwx = -pan.x / scale, cwy = -pan.y / scale;
  const maxDist = useMemo(() => {
    let m = 1;
    for (const id of looseIds) { const p = positions[id]; if (validPos(p)) m = Math.max(m, Math.hypot(p.x - cwx, p.y - cwy)); }
    for (const s of sections) m = Math.max(m, Math.hypot(s.x - cwx, s.y - cwy));
    return m;
  }, [looseIds, positions, sections, cwx, cwy]);

  const everOpenedRef = useRef(false);
  if (open) everOpenedRef.current = true;
  const revealStyle = (wx: number, wy: number, extra: string): React.CSSProperties => {
    const dx = cwx - wx, dy = cwy - wy;
    if (!open) {
      // Collapsed toward the logo corner. Instant on first mount (the start
      // frame); animated on close so the reveal plays in reverse.
      const closing = everOpenedRef.current;
      const delay = closing ? (Math.hypot(dx, dy) / maxDist) * 180 : 0;
      return {
        opacity: 0,
        transform: `translate(${dx}px, ${dy}px) scale(0.12)`,
        transition: closing ? `transform 420ms cubic-bezier(.4, 0, .7, .6) ${delay}ms, opacity 300ms ease ${delay}ms` : 'none',
      };
    }
    const delay = (Math.hypot(dx, dy) / maxDist) * 240;
    return {
      opacity: 1, transform: 'none',
      transition: `transform 620ms cubic-bezier(.18,.9,.24,1.05) ${delay}ms, opacity 360ms ease ${delay}ms${extra ? ', ' + extra : ''}`,
    };
  };

  // Renderers
  const renderTileInner = (id: string) => {
    // A nav destination dragged loose out of the "howl" section (it's a normal
    // section now) — render its icon so it isn't an empty tile; click navigates.
    const nav = HOWL_NAV_MAP.get(id);
    if (nav) {
      const NavIcon = nav.Icon;
      const count = nav.badge === 'messages' ? messagesBadge : nav.badge === 'friends' ? friendsBadge : nav.badge === 'notifications' ? notificationsBadge : 0;
      return (
        <div className={`hn-tile hn-nav-tile ${nav.logo ? 'hn-logo-tile' : ''} ${activeServerId === nav.target ? 'hn-active' : ''}`}>
          {nav.logo
            ? <img className="hn-nav-logo" src={assetPath('/howl-logo.png')} alt="" decoding="async" />
            : NavIcon ? <NavIcon className="hn-nav-ic" strokeWidth={2} /> : null}
          {count > 0 && <span className="hn-mention-badge">{count > 99 ? '99+' : count}</span>}
          {nav.status && <span className="hn-status" style={{ background: STATUS_COLORS[userStatus] ?? STATUS_COLORS.offline }} />}
        </div>
      );
    }
    const folder = folderById.get(id);
    if (folder) {
      const members = folder.serverIds.map(sid => serverById.get(sid)).filter(Boolean).slice(0, 4);
      return (
        <div className="hn-tile hn-folder">
          {members.map((m, i) => <span key={i} className="hn-mini"><ServerIcon icon={m!.icon} name={m!.name} active /></span>)}
          {Array.from({ length: Math.max(0, 4 - members.length) }).map((_, i) => <span key={`e${i}`} className="hn-mini" style={{ background: 'var(--hn-tile)' }} />)}
        </div>
      );
    }
    const server = serverById.get(id);
    if (!server) return null;
    const isActive = activeServerId === id;
    const mentions = serverMentionCounts[id] ?? 0;
    return (
      <div className={`hn-tile ${isActive ? 'hn-active' : ''}`}>
        <ServerIcon icon={server.icon} name={server.name} active={isActive} />
        {mentions > 0 && <span className="hn-mention-badge">{mentions > 99 ? '99+' : mentions}</span>}
        {mentions === 0 && serverUnreadIds.has(id) && <span className="hn-unread-dot" />}
      </div>
    );
  };

  const renderMini = (id: string, secId: string) => {
    // Built-in "howl" section items are nav destinations, not servers.
    const nav = HOWL_NAV_MAP.get(id);
    if (nav) {
      const NavIcon = nav.Icon;
      const count = nav.badge === 'messages' ? messagesBadge : nav.badge === 'friends' ? friendsBadge : nav.badge === 'notifications' ? notificationsBadge : 0;
      return (
        <div
          key={id}
          className={`hn-mini-tile hn-nav-mini ${nav.logo ? 'hn-logo-tile' : ''} ${activeServerId === nav.target ? 'hn-active' : ''}`}
          title={nav.label}
          aria-label={nav.label}
          onPointerDown={(e) => miniDown(e, secId, id)}
          onClick={(e) => e.stopPropagation()}
        >
          {nav.logo
            ? <img className="hn-nav-logo" src={assetPath('/howl-logo.png')} alt="" decoding="async" />
            : NavIcon ? <NavIcon className="hn-nav-ic" strokeWidth={2} /> : null}
          {count > 0 && <span className="hn-mention-badge">{count > 99 ? '99+' : count}</span>}
          {nav.status && <span className="hn-status" style={{ background: STATUS_COLORS[userStatus] ?? STATUS_COLORS.offline }} />}
        </div>
      );
    }
    const folder = folderById.get(id);
    if (folder) {
      const members = folder.serverIds.map(sid => serverById.get(sid)).filter(Boolean).slice(0, 4);
      return (
        <div key={id} className="hn-mini-tile hn-folder" onPointerDown={(e) => miniDown(e, secId, id)} onClick={(e) => e.stopPropagation()} title={folder.name}>
          {members.map((m, i) => <span key={i} className="hn-m"><ServerIcon icon={m!.icon} name={m!.name} active /></span>)}
        </div>
      );
    }
    const server = serverById.get(id);
    if (!server) return null;
    return (
      <div key={id} className="hn-mini-tile" onPointerDown={(e) => miniDown(e, secId, id)} onClick={(e) => e.stopPropagation()} title={server.name}>
        <ServerIcon icon={server.icon} name={server.name} active={activeServerId === id} />
      </div>
    );
  };

  return (
    <div className="hn-panel">
      <div className="hn-panel-head">
        <div className="hn-search">
          <Search />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search servers" aria-label="Search servers" />
        </div>
        <button className={`hn-snap-toggle ${snap ? 'hn-on' : ''}`} onClick={() => setLayout(l => ({ ...l, snap: !l.snap }))}>
          <Grid3x3 /> Snap to grid
        </button>
        <div className="hn-zoom-ctl">
          <button onClick={() => zoomCenter(1 / 1.15)} title="Zoom out">−</button>
          <span className="hn-zsep" />
          <button onClick={() => zoomCenter(1.15)} title="Zoom in">+</button>
        </div>
        <button className="hn-ghost-btn" onClick={addSection}><Plus /> New section</button>
        <button className="hn-ghost-btn" onClick={onAddServer}><Plus /> Add server</button>
        <button className="hn-close" onClick={onClose} title="Close (Esc)" aria-label="Close navigator"><X /></button>
      </div>

      <div
        className={`hn-viewport ${panning ? 'hn-panning' : ''}`}
        ref={viewportRef}
        onWheel={onWheel}
        onPointerDown={panDown}
        onPointerMove={panMove}
        onPointerUp={panUp}
      >
        <div
          className={`hn-canvas ${snap ? 'hn-snapping' : ''}`}
          ref={canvasRef}
          data-drag={dragKind ? 'true' : 'false'}
          style={{ width: world.w, height: world.h, transformOrigin: '0 0', transform: `translate(${pan.x}px, ${pan.y}px) scale(${scale})`, backgroundSize: `${CW}px ${CH}px`, backgroundPosition: `${OX}px ${OY}px` }}
        >
          {openMenu && <div className="hn-menu-backdrop" onPointerDown={() => setOpenMenu(null)} />}

          {sections.map((sec) => {
            const cols = colsFromW(sec.w), rows = rowsFromH(sec.h);
            const vis = cols * rows;
            const visibleItems = sec.items.filter(matches);
            const over = (!sec.expanded && visibleItems.length > vis) ? visibleItems.length - (vis - 1) : 0;
            const shown = sec.expanded ? visibleItems : (over ? visibleItems.slice(0, vis - 1) : visibleItems);
            const gridH = sec.expanded ? gridMinH(Math.max(1, Math.ceil(visibleItems.length / cols))) : (sec.h - SEC_OH);
            const z = openMenu === sec.id ? 60 : sec.expanded ? 40 : activeId === sec.id ? 30 : 1;
            return (
              <div
                key={sec.id} data-sec={sec.id}
                className={`hn-section-card ${activeId === sec.id && dragKind === 'sec' ? 'hn-dragging' : ''} ${dropTarget === sec.id ? 'hn-drop-target' : ''} ${sec.expanded ? 'hn-expanded' : ''}`}
                style={{ left: sec.x, top: sec.y, width: sec.w, background: sectionFill(sec.fc), borderColor: sec.oc, zIndex: z, ...revealStyle(sec.x, sec.y, 'box-shadow 160ms ease, border-color 160ms ease, background 160ms ease') }}
              >
                <div className="hn-sec-header" onPointerDown={(e) => secDown(e, sec)} onPointerMove={secMove} onPointerUp={secUp}>
                  <button className="hn-sec-menu-btn" onPointerDown={(e) => e.stopPropagation()} onClick={() => setOpenMenu(openMenu === sec.id ? null : sec.id)} aria-label="Section menu"><MoreHorizontal /></button>
                  <span
                    className="hn-sec-title" contentEditable suppressContentEditableWarning spellCheck={false}
                    onPointerDown={(e) => e.stopPropagation()}
                    onBlur={(e) => updateSec(sec.id, { title: e.currentTarget.textContent?.trim() || 'Untitled' })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.currentTarget as HTMLElement).blur(); } }}
                  >{sec.title}</span>
                  <span className="hn-sec-count">{sec.items.length}</span>
                </div>

                {openMenu === sec.id && (
                  <div className="hn-sec-menu" onPointerDown={(e) => e.stopPropagation()}>
                    <div className="hn-sec-menu-label">Color</div>
                    <div className="hn-sec-swatches">
                      {NAV_SECTION_PRESETS.map((p, i) => (
                        <button key={i} className={`hn-swatch ${sec.oc === p.oc && sec.fc === p.fc ? 'hn-active' : ''}`}
                          style={{ background: sectionFill(p.fc), border: `2px solid ${p.oc}` }}
                          onClick={() => updateSec(sec.id, { oc: p.oc, fc: p.fc })} aria-label={`Color ${i + 1}`} />
                      ))}
                    </div>
                    <div className="hn-sec-menu-sep" />
                    <button className="hn-sec-menu-item" onClick={() => startRename(sec.id)}><Pencil /> Rename</button>
                    <button className="hn-sec-menu-item hn-danger" onClick={() => deleteSection(sec.id)}><Trash2 /> Delete section</button>
                  </div>
                )}

                <div className="hn-sec-grid" onClick={() => updateSec(sec.id, { expanded: !sec.expanded })}
                  style={{ gridTemplateColumns: `repeat(${cols}, ${MINI}px)`, gridAutoRows: `${MINI}px`, minHeight: gridH }}>
                  {sec.items.length === 0 && <span className="hn-sec-empty">Drag servers here</span>}
                  {shown.map((id) => renderMini(id, sec.id))}
                  {over > 0 && <div className="hn-sec-more">+{over}</div>}
                </div>
                <span className="hn-sec-resize" onPointerDown={(e) => resizeDown(e, sec)} onPointerMove={resizeMove} onPointerUp={resizeUp}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ width: '100%', height: '100%' }}><path d="M20 10v10H10" /><path d="M20 20 12 12" /></svg>
                </span>
              </div>
            );
          })}

          {looseIds.filter(matches).map((id) => {
            const isDragging = activeId === id && dragKind === 'loose';
            const pos = positions[id];
            if (!validPos(pos)) return null;
            return (
              <div
                key={id}
                className={`hn-item ${isDragging ? 'hn-dragging' : ''}`}
                style={isDragging
                  ? { left: pos.x, top: pos.y, transition: snap ? 'left 110ms ease, top 110ms ease' : 'none' }
                  : { left: pos.x, top: pos.y, ...revealStyle(pos.x, pos.y, 'left 150ms cubic-bezier(.2,.8,.2,1), top 150ms cubic-bezier(.2,.8,.2,1)') }}
                onPointerDown={(e) => looseDown(e, id)} onPointerMove={looseMove} onPointerUp={looseUp}
              >
                {renderTileInner(id)}
                <span className="hn-tile-name">{nameOf(id)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {folderPopover && (() => {
        const folder = folderById.get(folderPopover.id);
        if (!folder) return null;
        const members = folder.serverIds.map(sid => serverById.get(sid)).filter((s): s is NonNullable<typeof s> => Boolean(s));
        return (
          <>
            <div className="hn-folder-pop-backdrop" onPointerDown={() => setFolderPopover(null)} />
            <div className="hn-folder-pop" style={{ left: folderPopover.x, top: folderPopover.y }} role="menu">
              <div className="hn-folder-pop-title">{folder.name}</div>
              {members.length === 0 && <div className="hn-folder-pop-empty">No servers</div>}
              {members.map(s => (
                <button key={s.id} className="hn-folder-pop-item" role="menuitem" onClick={() => { setFolderPopover(null); onNavigate(s.id as NavigationTarget); }}>
                  <span className="hn-folder-pop-icon"><ServerIcon icon={s.icon} name={s.name} active /></span>
                  <span className="hn-folder-pop-name">{s.name}</span>
                </button>
              ))}
            </div>
          </>
        );
      })()}
    </div>
  );
};
