// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback, useMemo, useDeferredValue } from 'react';
import { createPortal } from 'react-dom';
import { EMOJI_CATEGORIES, EMOJI_SEARCH_INDEX } from '../utils/emojiData';
import { getRecentEmojis, addRecentEmoji } from '../utils/recentEmojiStorage';
import { getTwemojiUrl } from '../utils/twemoji';
import { Search, Clock, Smile, Leaf, Coffee, Dribbble, Plane, Lightbulb, Heart, Flag, Sparkles, Crown } from 'lucide-react';
import { usePickerSize, PICKER_GLASS_STYLE, PICKER_GLASS_CLASS, PICKER_HEADER_STYLE, PICKER_FOOTER_STYLE, PICKER_INPUT_STYLE, PICKER_STICKY_BG } from '../utils/pickerScale';
import { Server, CustomEmoji } from '../types';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { setCustomEmojis as setGlobalCustomEmojis } from '../utils/customEmojiStore';
import { useTranslation } from 'react-i18next';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';

// Cache server emoji results to avoid re-fetching on every picker open
let _emojiCacheServerIds = '';
let _emojiCacheResult: Record<string, CustomEmoji[]> = {};
let _emojiCacheTime = 0;
const EMOJI_CACHE_TTL = 120_000; // 2 minutes

const CATEGORY_TAB_ICONS: Record<string, React.ReactNode> = {
  recent: <Clock size={16} />,
  custom: <Sparkles size={16} />,
  people: <Smile size={16} />,
  nature: <Leaf size={16} />,
  food: <Coffee size={16} />,
  activities: <Dribbble size={16} />,
  travel: <Plane size={16} />,
  objects: <Lightbulb size={16} />,
  symbols: <Heart size={16} />,
  flags: <Flag size={16} />,
};

const DEFAULT_COLS = 8;
const DEFAULT_BUTTON_SIZE = 36;
// Touch devices get larger cells (40px) for better tap targets
const TOUCH_BUTTON_SIZE = 40;
const GRID_GAP = 2; // gap-0.5 = 2px

/**
 * Dynamically compute emoji grid columns based on container width.
 * Uses ResizeObserver with a column-count threshold to avoid per-pixel re-renders.
 */
function useEmojiGridCols(containerRef: React.RefObject<HTMLElement | null>) {
  const isTouch = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const cellSize = isTouch ? TOUCH_BUTTON_SIZE : DEFAULT_BUTTON_SIZE;

  const [cols, setCols] = useState(() => {
    // Initial guess based on viewport
    if (typeof window === 'undefined') return DEFAULT_COLS;
    const w = window.innerWidth;
    if (w < 768) return 6;
    if (w < 1024) return 7;
    return DEFAULT_COLS;
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    let prevCols = cols;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const availableWidth = entry.contentRect.width;
      // How many cells fit: (availableWidth + gap) / (cellSize + gap), floored
      const fitCols = Math.max(4, Math.floor((availableWidth + GRID_GAP) / (cellSize + GRID_GAP)));
      const clamped = Math.min(fitCols, 10); // cap at 10
      if (clamped !== prevCols) {
        prevCols = clamped;
        setCols(clamped);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [cellSize, containerRef]);

  return { cols, cellSize };
}

const isRealServer = (id?: string) => !!id && !['home', 'account', 'friends', 'dm'].includes(id);

interface EmojiPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  activeServerId?: string;
  servers?: Server[];
  /** App zoom level (100 = normal). When set, anchor rect is treated as zoomed layout coords and converted for viewport positioning. */
  zoomLevel?: number;
  userPlan?: string | null;
  userId?: string;
}

export const EmojiPicker: React.FC<EmojiPickerProps> = ({ open, onClose, onSelect, anchorRef, activeServerId, servers = [], zoomLevel = 100, userPlan, userId }) => {
  const { t } = useTranslation();
  const { width: pw, height: ph } = usePickerSize(400, 450);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom?: number; top?: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { cols, cellSize } = useEmojiGridCols(scrollRef);
  const searchRef = useRef<HTMLInputElement>(null);
  const categoryRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const [search, setSearch] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [activeTab, setActiveTab] = useState('people');
  const [hovered, setHovered] = useState<{ emoji: string; name: string } | null>(null);
  const [recentEmojis, setRecentEmojis] = useState<string[]>([]);

  // Custom server emojis
  const [customEmojisByServer, setCustomEmojisByServer] = useState<Record<string, CustomEmoji[]>>({});

  useEffect(() => {
    if (open) {
      setRecentEmojis(getRecentEmojis(userId));
      setSearch('');
      setHovered(null);
      requestAnimationFrame(() => searchRef.current?.focus());
      if (servers.length > 0) {
        const serverIdKey = servers.map(s => s.id).sort().join(',');
        if (serverIdKey === _emojiCacheServerIds && Date.now() - _emojiCacheTime < EMOJI_CACHE_TTL) {
          setCustomEmojisByServer(_emojiCacheResult);
          const allEmojis: CustomEmoji[] = [];
          for (const emojis of Object.values(_emojiCacheResult)) allEmojis.push(...emojis);
          setGlobalCustomEmojis(allEmojis);
        } else {
          Promise.all(
            servers.map((s) =>
              apiClient.getServerEmojis(s.id).then((emojis) => ({ serverId: s.id, emojis })).catch(() => ({ serverId: s.id, emojis: [] as CustomEmoji[] }))
            )
          ).then((results) => {
            const map: Record<string, CustomEmoji[]> = {};
            const allEmojis: CustomEmoji[] = [];
            for (const r of results) {
              if (r.emojis.length > 0) { map[r.serverId] = r.emojis; allEmojis.push(...r.emojis); }
            }
            _emojiCacheServerIds = serverIdKey;
            _emojiCacheResult = map;
            _emojiCacheTime = Date.now();
            setCustomEmojisByServer(map);
            setGlobalCustomEmojis(allEmojis);
            setRecentEmojis(getRecentEmojis(userId));
          });
        }
      }
    }
  }, [open, servers]);

  // Real-time emoji updates via socket
  useEffect(() => {
    const socket = socketService.getSocket();
    if (!socket) return;
    const handler = ({ serverId }: { serverId: string }) => {
      // Invalidate module-level cache so next open fetches fresh
      _emojiCacheServerIds = '';
      // If picker is open, refetch immediately
      apiClient.getServerEmojis(serverId).then((fresh) => {
        setCustomEmojisByServer((prev) => {
          const next = fresh.length > 0 ? { ...prev, [serverId]: fresh } : { ...prev };
          if (fresh.length === 0) delete next[serverId];
          const allEmojis: CustomEmoji[] = [];
          for (const emojis of Object.values(next)) allEmojis.push(...emojis);
          setGlobalCustomEmojis(allEmojis);
          return next;
        });
      }).catch(() => {});
    };
    socket.on('server-emoji-created', handler);
    socket.on('server-emoji-deleted', handler);
    return () => {
      socket.off('server-emoji-created', handler);
      socket.off('server-emoji-deleted', handler);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = e.target as Node;
      if (panelRef.current?.contains(el) || anchorRef.current?.contains(el)) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, onClose, anchorRef]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setPosition(null);
      return;
    }
    const anchor = anchorRef.current;
    const rect = anchor.getBoundingClientRect();
    const z = zoomLevel / 100;
    const visualTop = rect.top * z;
    const visualBottom = rect.bottom * z;
    const visualLeft = rect.left * z;
    const spaceAbove = visualTop;
    const left = Math.min(Math.max(12, visualLeft), window.innerWidth - pw - 12);
    if (spaceAbove >= ph + 16) {
      setPosition({ left, bottom: window.innerHeight - visualTop + 8 });
    } else {
      setPosition({ left, top: visualBottom + 8 });
    }
  }, [open, zoomLevel, pw, ph, anchorRef]);

  const handleSelect = useCallback((emoji: string) => {
    onSelect(emoji);
    setRecentEmojis(addRecentEmoji(emoji, userId));
  }, [onSelect, userId]);

  const scrollToCategory = useCallback((catId: string) => {
    setActiveTab(catId);
    setSearch('');
    const el = categoryRefs.current[catId];
    if (el && scrollRef.current) {
      const top = el.offsetTop - scrollRef.current.offsetTop;
      scrollRef.current.scrollTo({ top, behavior: 'smooth' });
    }
  }, []);

  const filteredEmojis = useMemo(() => {
    if (!deferredSearch.trim()) return null;
    const q = deferredSearch.toLowerCase().trim();
    return EMOJI_SEARCH_INDEX
      .filter((e) => e.keywords.includes(q))
      .map((e) => e.emoji);
  }, [deferredSearch]);

  const filteredCustom = useMemo(() => {
    if (!deferredSearch.trim()) return null;
    const q = deferredSearch.toLowerCase().trim();
    const results: { emoji: CustomEmoji; serverId: string; canUse: boolean }[] = [];
    const hasUniversalEmoji = userPlan === 'essential' || userPlan === 'pro';
    for (const srv of servers) {
      const emojis = customEmojisByServer[srv.id];
      if (!emojis) continue;
      const canUse = hasUniversalEmoji || (isRealServer(activeServerId) && activeServerId === srv.id);
      for (const e of emojis) {
        if (e.name.toLowerCase().includes(q)) results.push({ emoji: e, serverId: srv.id, canUse });
      }
    }
    return results;
  }, [deferredSearch, customEmojisByServer, servers, activeServerId, userPlan]);

  const handleScroll = useCallback(() => {
    if (search.trim() || !scrollRef.current) return;
    const container = scrollRef.current;
    const scrollTop = container.scrollTop;
    const ids = recentEmojis.length > 0
      ? ['recent', ...EMOJI_CATEGORIES.map((c) => c.id)]
      : EMOJI_CATEGORIES.map((c) => c.id);
    let closest = ids[0]!;
    for (const id of ids) {
      const el = categoryRefs.current[id];
      if (el) {
        const offset = el.offsetTop - container.offsetTop;
        if (offset <= scrollTop + 8) closest = id;
      }
    }
    setActiveTab(closest);
  }, [search, recentEmojis.length]);

  if (!open) return null;

  const style: React.CSSProperties = position
    ? { position: 'fixed', left: position.left, ...(position.top != null ? { top: position.top } : { bottom: position.bottom }), zIndex: 100 }
    : {};

  const hasCustom = Object.keys(customEmojisByServer).length > 0;
  const tabIds = [
    ...(recentEmojis.length > 0 ? ['recent'] : []),
    ...(hasCustom ? ['custom'] : []),
    ...EMOJI_CATEGORIES.map((c) => c.id),
  ];

  // Portal to document.body so `position: fixed` resolves against the viewport.
  // Otherwise a transformed ancestor (will-change, filter, transform) creates a
  // new containing block and the picker anchors to that instead — which pushes
  // it partially off-screen / against the chat column.
  return createPortal(
    <div
      ref={panelRef}
      className={`flex flex-col overflow-hidden ${PICKER_GLASS_CLASS}`}
      style={{
        ...style,
        ...PICKER_GLASS_STYLE,
        width: pw,
        height: ph,
        // z-popover (400) sits above z-modal (300) — needed when the picker
        // is opened from inside a modal (channel settings, etc.) since both
        // portal to <body> and the picker would otherwise stack below.
        zIndex: 'var(--z-popover)',
      }}
    >
      {/* Tab bar */}
      <div
        className="flex items-center gap-0.5 px-2 py-1.5 shrink-0 border-b"
        style={PICKER_HEADER_STYLE}
      >
        {tabIds.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => scrollToCategory(id)}
            className="emoji-tab-btn p-1.5 rounded-lg transition-colors flex items-center justify-center"
            style={{
              color: activeTab === id ? 'var(--cyan-accent)' : 'var(--text-secondary)',
              backgroundColor: activeTab === id ? 'var(--border-subtle)' : 'transparent',
            }}
            title={t(`emoji.category.${id}`, { defaultValue: EMOJI_CATEGORIES.find((c) => c.id === id)?.label ?? id })}
          >
            {CATEGORY_TAB_ICONS[id] ?? id}
          </button>
        ))}
      </div>

      {/* Search bar */}
      <div className="px-2 py-1.5 shrink-0">
        <div className="relative">
          <Search
            size={14}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
            style={{ color: 'var(--text-secondary)' }}
          />
          <input
            ref={searchRef}
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('emoji.searchPlaceholder')}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-sm border outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/50"
            style={PICKER_INPUT_STYLE}
          />
        </div>
      </div>

      {/* Emoji grid */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1"
        role="grid"
        aria-label="Emoji grid"
        onScroll={handleScroll}
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
          const container = e.currentTarget;
          const buttons = Array.from(container.querySelectorAll<HTMLElement>('button:not([disabled])'));
          const idx = buttons.indexOf(e.target as HTMLElement);
          if (idx < 0) return;
          e.preventDefault();
          let next = idx;
          if (e.key === 'ArrowRight') next = Math.min(idx + 1, buttons.length - 1);
          else if (e.key === 'ArrowLeft') next = Math.max(idx - 1, 0);
          else if (e.key === 'ArrowDown') next = Math.min(idx + cols, buttons.length - 1);
          else if (e.key === 'ArrowUp') next = Math.max(idx - cols, 0);
          buttons[next]?.focus();
        }}
        style={{ scrollBehavior: 'auto' }}
      >
        {filteredEmojis ? (
          (filteredEmojis.length > 0 || (filteredCustom && filteredCustom.length > 0)) ? (
            <>
              {filteredCustom && filteredCustom.length > 0 && (
                <div className="grid gap-0.5 mb-1" style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}>
                  {filteredCustom.map((ce) => (
                    <button
                      key={ce.emoji.id} type="button" disabled={!ce.canUse}
                      onClick={() => ce.canUse && handleSelect(`:${ce.emoji.name}:`)}
                      onMouseEnter={() => setHovered({ emoji: ce.emoji.imageUrl, name: `:${ce.emoji.name}:` })}
                      onMouseLeave={() => setHovered(null)}
                      className={`flex items-center justify-center rounded-md transition-colors focus:outline-none ${ce.canUse ? 'hover:bg-fill-active cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
                      style={{ width: cellSize, height: cellSize }}
                      aria-label={`:${ce.emoji.name}:`}
                    >
                      <LazyGif src={sanitizeImgSrc(ce.emoji.imageUrl)} frameSrc={getFrameUrl(ce.emoji.imageUrl)} alt={ce.emoji.name} className="w-6 h-6 object-contain" draggable={false} />
                    </button>
                  ))}
                </div>
              )}
              <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}>
                {filteredEmojis.map((emoji, idx) => (
                  <EmojiButton key={`search-${idx}-${emoji}`} emoji={emoji} onSelect={handleSelect} onHover={setHovered} cellSize={cellSize} />
                ))}
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('emoji.noEmojiFound')}
            </div>
          )
        ) : (
          <>
            {/* Recently used */}
            {recentEmojis.length > 0 && (
              <div ref={(el) => { categoryRefs.current['recent'] = el; }}>
                <div
                  className="text-[11px] font-semibold uppercase tracking-wider py-1 sticky top-0 z-10"
                  style={{ color: 'var(--text-secondary)', backgroundColor: PICKER_STICKY_BG, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
                >
                  {t('emoji.recentlyUsed')}
                </div>
                <div
                  className="grid gap-0.5"
                  style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}
                >
                  {recentEmojis.map((emoji, idx) => (
                    <EmojiButton
                      key={`recent-${idx}-${emoji}`}
                      emoji={emoji}
                      onSelect={handleSelect}
                      onHover={setHovered}
                      cellSize={cellSize}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Custom server emojis */}
            {hasCustom && (
              <div ref={(el) => { categoryRefs.current['custom'] = el; }}>
                {servers.filter((s) => customEmojisByServer[s.id]?.length).map((srv) => {
                  const hasUniversalEmoji = userPlan === 'essential' || userPlan === 'pro';
                  const canUse = hasUniversalEmoji || (isRealServer(activeServerId) && activeServerId === srv.id);
                  return (
                    <div key={srv.id} className="mb-1">
                      <div className="flex items-center gap-1.5 py-1 sticky top-0 z-10" style={{ backgroundColor: PICKER_STICKY_BG, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                        {srv.icon ? (
                          <img src={sanitizeImgSrc(srv.icon)} alt="" className="w-3.5 h-3.5 rounded-full object-cover" loading="lazy" decoding="async" width={14} height={14} data-original-src={toOriginalUploadPath(srv.icon)} onError={retryOnExpired} />
                        ) : (
                          <div className="w-3.5 h-3.5 rounded-full flex items-center justify-center text-[7px] font-bold" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-secondary)' }}>
                            {srv.name.charAt(0).toUpperCase()}
                          </div>
                        )}
                        <span className="text-[11px] font-semibold uppercase tracking-wider truncate" style={{ color: 'var(--text-secondary)' }}>
                          {srv.name}
                        </span>
                        {!canUse && <span className="pro-shimmer-badge flex items-center gap-0.5 shrink-0 px-1.5 py-0.5 rounded-md border border-[var(--cyan-accent)]/25" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)' }}><Crown size={8} className="text-[var(--cyan-accent)]" /><span className="text-[8px] font-bold text-[var(--cyan-accent)]">Essential+</span></span>}
                      </div>
                      <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}>
                        {customEmojisByServer[srv.id].map((ce) => (
                          <button
                            key={ce.id} type="button"
                            disabled={!canUse}
                            onClick={() => canUse && handleSelect(`:${ce.name}:`)}
                            onMouseEnter={() => setHovered({ emoji: ce.imageUrl, name: `:${ce.name}:` })}
                            onMouseLeave={() => setHovered(null)}
                            className={`flex items-center justify-center rounded-md transition-colors focus:outline-none ${canUse ? 'hover:bg-fill-active focus:ring-1 focus:ring-[var(--cyan-accent)]/50 cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
                            style={{ width: cellSize, height: cellSize }}
                            aria-label={`:${ce.name}:`}
                          >
                            <LazyGif src={sanitizeImgSrc(ce.imageUrl)} frameSrc={getFrameUrl(ce.imageUrl)} alt={ce.name} className="w-6 h-6 object-contain" draggable={false} />
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Categories */}
            {EMOJI_CATEGORIES.map((cat) => (
              <LazyEmojiCategory
                key={cat.id}
                category={cat}
                categoryRefs={categoryRefs}
                onSelect={handleSelect}
                onHover={setHovered}
                cols={cols}
                cellSize={cellSize}
                t={t}
              />
            ))}
          </>
        )}
      </div>

      {/* Hover preview bar */}
      <div
        className="flex items-center gap-2.5 px-3 h-10 shrink-0 border-t"
        style={PICKER_FOOTER_STYLE}
      >
        {hovered ? (
          <>
            <img
              src={sanitizeImgSrc(hovered.emoji.startsWith('http') ? hovered.emoji : getTwemojiUrl(hovered.emoji))}
              alt={hovered.name}
              className="w-7 h-7 shrink-0 object-contain"
              draggable={false}
              loading="lazy"
              decoding="async"
              width={28}
              height={28}
              data-original-src={toOriginalUploadPath(hovered.emoji)}
              onError={retryOnExpired}
            />
            <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
              {hovered.name}
            </span>
          </>
        ) : (
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('emoji.hoverToPreview')}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
};

const LazyEmojiCategory: React.FC<{
  category: { id: string; label: string; emojis: string[] };
  categoryRefs: React.MutableRefObject<Record<string, HTMLDivElement | null>>;
  onSelect: (emoji: string) => void;
  onHover: (info: { emoji: string; name: string } | null) => void;
  cols: number;
  cellSize: number;
  t: (key: string, options?: Record<string, string>) => string;
}> = React.memo(({ category, categoryRefs, onSelect, onHover, cols, cellSize, t }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setIsVisible(true); },
      { rootMargin: '200px 0px' }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const estimatedHeight = Math.ceil(category.emojis.length / cols) * cellSize;

  return (
    <div ref={(el) => { ref.current = el; categoryRefs.current[category.id] = el; }}>
      <div
        className="text-[11px] font-semibold uppercase tracking-wider py-1 sticky top-0 z-10"
        style={{ color: 'var(--text-secondary)', backgroundColor: PICKER_STICKY_BG, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}
      >
        {t(`emoji.category.${category.id}`, { defaultValue: category.label })}
      </div>
      {isVisible ? (
        <div className="grid gap-0.5" style={{ gridTemplateColumns: `repeat(${cols}, ${cellSize}px)` }}>
          {category.emojis.map((emoji, idx) => (
            <EmojiButton key={`${category.id}-${idx}-${emoji}`} emoji={emoji} onSelect={onSelect} onHover={onHover} cellSize={cellSize} />
          ))}
        </div>
      ) : (
        <div style={{ height: estimatedHeight }} />
      )}
    </div>
  );
});

const EmojiButton = React.memo(({
  emoji,
  onSelect,
  onHover,
  cellSize = DEFAULT_BUTTON_SIZE,
}: {
  emoji: string;
  onSelect: (emoji: string) => void;
  onHover: (info: { emoji: string; name: string } | null) => void;
  cellSize?: number;
}) => {
  const name = useMemo(() => {
    const entry = EMOJI_SEARCH_INDEX.find((e) => e.emoji === emoji);
    return entry ? `:${entry.keywords.split(' ').slice(0, 3).join('_')}:` : emoji;
  }, [emoji]);

  return (
    <button
      type="button"
      onClick={() => onSelect(emoji)}
      onMouseEnter={() => onHover({ emoji, name })}
      onMouseLeave={() => onHover(null)}
      className="emoji-cell flex items-center justify-center rounded-md hover:bg-fill-active transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/50"
      style={{ width: cellSize, height: cellSize }}
      aria-label={name}
    >
      <img
        src={getTwemojiUrl(emoji)}
        alt={emoji}
        className="w-6 h-6"
        loading="lazy"
        decoding="async"
        width={24}
        height={24}
        draggable={false}
      />
    </button>
  );
});
