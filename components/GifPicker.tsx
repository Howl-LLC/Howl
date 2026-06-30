// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import { Search, ImagePlay, Star, Clock, TrendingUp } from 'lucide-react';
import { searchGifs, getTrendingGifs, getRecentGifs, triggerGifShare, getGifFavorites, addGifFavorite, removeGifFavorite, getPreviewUrl, getFullUrl, getFullDimensions, type KlipyGif, type KlipyGifResult, type GifFavorite } from '../services/klipyGif';
import { usePickerSize, PICKER_GLASS_STYLE, PICKER_GLASS_CLASS, PICKER_HEADER_STYLE, PICKER_FOOTER_STYLE, PICKER_INPUT_STYLE } from '../utils/pickerScale';
import { useTranslation } from 'react-i18next';

interface GifPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (gifUrl: string, previewUrl: string, width?: number, height?: number) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  /** App zoom level (100 = normal). When set, anchor rect is treated as zoomed layout coords for viewport positioning. */
  zoomLevel?: number;
}

type GifTab = 'trending' | 'recents' | 'favorites';

export const GifPicker: React.FC<GifPickerProps> = ({ open, onClose, onSelect, anchorRef, zoomLevel = 100 }) => {
  const { t } = useTranslation();
  const { width: pw, height: ph } = usePickerSize(420, 460);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom?: number; top?: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<KlipyGif[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [page, setPage] = useState(1);
  const [hasNext, setHasNext] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  const [activeTab, setActiveTab] = useState<GifTab>('trending');
  const [favorites, setFavorites] = useState<GifFavorite[]>([]);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoriteUrls, setFavoriteUrls] = useState<Set<string>>(new Set());

  const doFetch = useCallback(async (q: string, pg: number, append: boolean, tab: GifTab = activeTab) => {
    const reqId = ++requestIdRef.current;
    if (!append) setLoading(true);
    else setLoadingMore(true);
    try {
      let result: KlipyGifResult;
      if (q.trim()) {
        result = await searchGifs(q.trim(), pg);
      } else if (tab === 'recents') {
        result = await getRecentGifs(pg);
      } else {
        result = await getTrendingGifs(pg);
      }
      if (reqId !== requestIdRef.current) return;
      setGifs(prev => append ? [...prev, ...result.items] : result.items);
      setHasNext(result.hasNext);
      setPage(result.page);
      setError(false);
    } catch {
      if (reqId !== requestIdRef.current) return;
      if (!append) { setGifs([]); setError(true); }
    } finally {
      if (reqId === requestIdRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [activeTab]);

  // Load favorites when picker opens
  useEffect(() => {
    if (!open) return;
    setFavoritesLoading(true);
    getGifFavorites(1, 200).then(data => {
      setFavorites(data.favorites);
      setFavoriteUrls(new Set(data.favorites.map(f => f.gifUrl)));
    }).catch(() => {}).finally(() => setFavoritesLoading(false));
  }, [open]);

  // Reset state when picker opens/closes
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setGifs([]);
    setPage(1);
    setHasNext(false);
    setError(false);
    setActiveTab('trending');
  }, [open]);

  // Fetch on query change (debounced)
  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setPage(1);
      doFetch(query, 1, false);
    }, 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, open, doFetch]);

  // Refetch when tab changes
  useEffect(() => {
    if (!open || query.trim()) return;
    setPage(1);
    doFetch('', 1, false, activeTab);
  }, [activeTab]);

  const handleLoadMore = useCallback(() => {
    if (loadingMore || !hasNext) return;
    doFetch(query, page + 1, true);
  }, [loadingMore, hasNext, query, page, doFetch]);

  useEffect(() => {
    if (!open || !hasNext || loadingMore) return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
        handleLoadMore();
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [open, hasNext, loadingMore, handleLoadMore]);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      const el = e.target as Node;
      if (panelRef.current?.contains(el) || anchorRef.current?.contains(el)) return;
      onClose();
    };
    const handleEscape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => { document.removeEventListener('mousedown', handleClickOutside); document.removeEventListener('keydown', handleEscape); };
  }, [open, onClose, anchorRef]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setPosition(null);
      return;
    }
    const rect = anchorRef.current.getBoundingClientRect();
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

  const toggleFavorite = useCallback(async (gifUrl: string, previewUrl: string, title: string) => {
    const isFav = favoriteUrls.has(gifUrl);
    if (isFav) {
      setFavoriteUrls(prev => { const next = new Set(prev); next.delete(gifUrl); return next; });
      setFavorites(prev => prev.filter(f => f.gifUrl !== gifUrl));
      await removeGifFavorite(gifUrl);
    } else {
      setFavoriteUrls(prev => new Set(prev).add(gifUrl));
      setFavorites(prev => [{ gifUrl, previewUrl, title, createdAt: new Date().toISOString() }, ...prev]);
      await addGifFavorite(gifUrl, previewUrl, title);
    }
  }, [favoriteUrls]);

  if (!open) return null;

  const style: React.CSSProperties = position
    ? { position: 'fixed', left: position.left, zIndex: 100, ...(position.bottom != null ? { bottom: position.bottom } : { top: position.top }) }
    : {};

  return (
    <div ref={panelRef} className={`flex flex-col overflow-hidden ${PICKER_GLASS_CLASS}`} style={{ ...style, ...PICKER_GLASS_STYLE, width: pw, height: ph }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b" style={PICKER_HEADER_STYLE}>
        <ImagePlay size={16} style={{ color: 'var(--cyan-accent)' }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('gif.title')}</span>
        <span className="ml-auto text-[9px] font-medium" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>{t('gif.poweredByKlipy')}</span>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-secondary)' }} />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('gif.searchPlaceholder')}
            autoFocus
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-sm border outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/50"
            style={PICKER_INPUT_STYLE}
          />
        </div>
      </div>

      {/* Tabs — only show when not searching */}
      {!query.trim() && (
        <div className="flex items-center gap-1 px-2 pb-1 shrink-0">
          {([
            { key: 'trending' as GifTab, icon: TrendingUp, label: t('gif.trending') },
            { key: 'recents' as GifTab, icon: Clock, label: t('gif.recents') },
            { key: 'favorites' as GifTab, icon: Star, label: t('gif.favorites') },
          ]).map(tab => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[10px] font-semibold transition-all duration-150 ${
                activeTab === tab.key
                  ? 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)]'
                  : 'hover:bg-fill-hover'
              }`}
              style={activeTab !== tab.key ? { color: 'var(--text-secondary)' } : undefined}
            >
              <tab.icon size={12} />
              {tab.label}
            </button>
          ))}
        </div>
      )}

      {/* GIF grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1">
        {activeTab === 'favorites' && !query.trim() ? (
          favoritesLoading ? (
            <div className="flex items-center justify-center h-32">
              <div className="w-6 h-6 border-2 border-[var(--cyan-accent)]/30 border-t-[var(--cyan-accent)] rounded-full animate-spin" />
            </div>
          ) : favorites.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 gap-2">
              <Star size={32} style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('gif.noFavorites')}</span>
            </div>
          ) : (
            <div className="columns-2 gap-1.5" style={{ columnFill: 'balance' }}>
              {favorites.map((fav) => (
                <div key={fav.gifUrl} className="relative mb-1.5 break-inside-avoid group/gif">
                  <button
                    type="button"
                    onClick={() => onSelect(fav.gifUrl, fav.previewUrl)}
                    className="block w-full rounded-lg overflow-hidden hover:ring-2 hover:ring-[var(--cyan-accent)]/60 transition-all duration-150 cursor-pointer active:scale-[0.97]"
                  >
                    <img
                      src={fav.previewUrl}
                      alt={fav.title || 'GIF'}
                      loading="lazy"
                      className="w-full h-auto object-cover rounded-lg"
                      style={{ minHeight: 60, backgroundColor: 'var(--fill-hover)' }}
                    />
                  </button>
                  <button
                    type="button"
                    onClick={() => toggleFavorite(fav.gifUrl, fav.previewUrl, fav.title)}
                    className="absolute top-1 right-1 p-1 rounded-md bg-black/50 opacity-0 group-hover/gif:opacity-100 transition-opacity hover:bg-black/70"
                    title={t('gif.removeFavorite')}
                  >
                    <Star size={12} className="text-yellow-400 fill-yellow-400" />
                  </button>
                </div>
              ))}
            </div>
          )
        ) : loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-[var(--cyan-accent)]/30 border-t-[var(--cyan-accent)] rounded-full animate-spin" />
          </div>
        ) : !loading && error ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <ImagePlay size={32} style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('gif.loadError', "Couldn't load GIFs")}</span>
            <button
              type="button"
              onClick={() => { setError(false); doFetch(query, 1, false); }}
              className="text-xs px-3 py-1 rounded-lg hover:bg-fill-active"
              style={{ color: 'var(--cyan-accent)' }}
            >
              {t('gif.retry', 'Try again')}
            </button>
          </div>
        ) : gifs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <ImagePlay size={32} style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
              {query.trim() ? t('gif.noGifsFound') : activeTab === 'recents' ? t('gif.noRecents') : t('gif.noTrendingGifs')}
            </span>
          </div>
        ) : (
          <>
            <div className="columns-2 gap-1.5" style={{ columnFill: 'balance' }}>
              {gifs.map((gif) => {
                const preview = getPreviewUrl(gif);
                const full = getFullUrl(gif);
                if (!preview || !preview.startsWith('https://')) return null;
                if (!full.startsWith('https://')) return null;
                return (
                  <div key={gif.id} className="relative mb-1.5 break-inside-avoid group/gif">
                    <button
                      type="button"
                      onClick={() => { const dims = getFullDimensions(gif); onSelect(full, preview, dims.width, dims.height); triggerGifShare(gif.id); }}
                      className="block w-full rounded-lg overflow-hidden hover:ring-2 hover:ring-[var(--cyan-accent)]/60 transition-all duration-150 cursor-pointer active:scale-[0.97]"
                    >
                      <img
                        src={preview}
                        alt={gif.title || 'GIF'}
                        loading="lazy"
                        className="w-full h-auto object-cover rounded-lg"
                        style={{ minHeight: 60, backgroundColor: 'var(--fill-hover)' }}
                      />
                    </button>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); toggleFavorite(full, preview, gif.title || ''); }}
                      className="absolute top-1 right-1 p-1 rounded-md bg-black/50 opacity-0 group-hover/gif:opacity-100 transition-opacity hover:bg-black/70"
                      title={favoriteUrls.has(full) ? t('gif.removeFavorite') : t('gif.addFavorite')}
                    >
                      <Star size={12} className={favoriteUrls.has(full) ? 'text-yellow-400 fill-yellow-400' : 'text-white/60'} />
                    </button>
                  </div>
                );
              })}
            </div>
            {loadingMore && (
              <div className="flex items-center justify-center py-3">
                <div className="w-5 h-5 border-2 border-[var(--cyan-accent)]/30 border-t-[var(--cyan-accent)] rounded-full animate-spin" />
              </div>
            )}
          </>
        )}
      </div>

      {/* Footer with Klipy attribution */}
      <div className="flex items-center justify-between px-3 h-8 shrink-0 border-t" style={PICKER_FOOTER_STYLE}>
        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('gif.clickToSend')}</span>
        <a href="https://klipy.com" target="_blank" rel="noopener noreferrer" className="flex items-center gap-1.5 text-[10px] hover:underline" style={{ color: 'var(--text-secondary)' }}>
          {t('gif.poweredByKlipy')}
        </a>
      </div>
    </div>
  );
};
