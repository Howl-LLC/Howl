// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Server, ServerSticker } from '../types';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { Search, Sticker, Crown } from 'lucide-react';
import { usePickerSize, PICKER_GLASS_STYLE, PICKER_GLASS_CLASS, PICKER_HEADER_STYLE, PICKER_FOOTER_STYLE, PICKER_INPUT_STYLE, PICKER_STICKY_BG } from '../utils/pickerScale';
import { useTranslation } from 'react-i18next';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';

interface StickerPickerProps {
  open: boolean;
  onClose: () => void;
  onSelect: (sticker: ServerSticker) => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  activeServerId?: string;
  servers: Server[];
  /** App zoom level (100 = normal). When set, anchor rect is treated as zoomed layout coords for viewport positioning. */
  zoomLevel?: number;
  userPlan?: string | null;
}

// Cache server sticker results to avoid re-fetching on every picker open
let _stickerCacheServerIds = '';
let _stickerCacheResult: Record<string, ServerSticker[]> = {};
let _stickerCacheTime = 0;
const STICKER_CACHE_TTL = 120_000; // 2 minutes

const isRealServer = (id?: string) => !!id && !['home', 'account', 'friends', 'dm'].includes(id);

export const StickerPicker: React.FC<StickerPickerProps> = ({ open, onClose, onSelect, anchorRef, activeServerId, servers, zoomLevel = 100, userPlan }) => {
  const { t } = useTranslation();
  const { width: pw, height: ph } = usePickerSize(380, 420);
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ left: number; bottom?: number; top?: number } | null>(null);
  const [search, setSearch] = useState('');
  const [stickersByServer, setStickersByServer] = useState<Record<string, ServerSticker[]>>({});
  const [loading, setLoading] = useState(false);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!open || servers.length === 0) return;
    setSearch('');
    const serverKey = servers.map(s => s.id).sort().join(',');
    const now = Date.now();
    if (serverKey === _stickerCacheServerIds && now - _stickerCacheTime < STICKER_CACHE_TTL) {
      setStickersByServer(_stickerCacheResult);
      return;
    }
    const reqId = ++requestIdRef.current;
    setLoading(true);
    Promise.all(
      servers.map((s) =>
        apiClient.getServerStickers(s.id).then((stickers) => ({ serverId: s.id, stickers })).catch(() => ({ serverId: s.id, stickers: [] as ServerSticker[] }))
      )
    ).then((results) => {
      if (reqId !== requestIdRef.current) return;
      const map: Record<string, ServerSticker[]> = {};
      for (const r of results) if (r.stickers.length > 0) map[r.serverId] = r.stickers;
      _stickerCacheServerIds = serverKey;
      _stickerCacheResult = map;
      _stickerCacheTime = Date.now();
      setStickersByServer(map);
      setLoading(false);
    });
  }, [open, servers]);

  // Real-time sticker updates via socket
  useEffect(() => {
    const socket = socketService.getSocket();
    if (!socket) return;
    const handler = ({ serverId }: { serverId: string }) => {
      _stickerCacheServerIds = '';
      apiClient.getServerStickers(serverId).then((fresh) => {
        setStickersByServer((prev) => {
          const next = fresh.length > 0 ? { ...prev, [serverId]: fresh } : { ...prev };
          if (fresh.length === 0) delete next[serverId];
          return next;
        });
      }).catch(() => {});
    };
    socket.on('server-sticker-created', handler);
    socket.on('server-sticker-deleted', handler);
    return () => {
      socket.off('server-sticker-created', handler);
      socket.off('server-sticker-deleted', handler);
    };
  }, []);

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

  if (!open) return null;

  const style: React.CSSProperties = position
    ? { position: 'fixed', left: position.left, zIndex: 100, ...(position.bottom != null ? { bottom: position.bottom } : { top: position.top }) }
    : {};

  const q = search.toLowerCase().trim();
  const serversWithStickers = servers.filter((s) => stickersByServer[s.id]?.length);

  return (
    <div ref={panelRef} className={`flex flex-col overflow-hidden ${PICKER_GLASS_CLASS}`} style={{ ...style, ...PICKER_GLASS_STYLE, width: pw, height: ph }}>
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2.5 shrink-0 border-b" style={PICKER_HEADER_STYLE}>
        <Sticker size={16} style={{ color: 'var(--cyan-accent)' }} />
        <span className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>{t('sticker.title')}</span>
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-secondary)' }} />
          <input
            type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('sticker.searchPlaceholder')}
            className="w-full pl-8 pr-3 py-1.5 rounded-lg text-sm border outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/50"
            style={PICKER_INPUT_STYLE}
          />
        </div>
      </div>

      {/* Sticker grid */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-2 py-1">
        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-2 border-[var(--cyan-accent)]/30 border-t-[var(--cyan-accent)] rounded-full animate-spin" />
          </div>
        ) : serversWithStickers.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-32 gap-2">
            <Sticker size={32} style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('sticker.noStickersInServer')}</span>
          </div>
        ) : (
          (() => {
            const rendered = serversWithStickers.map((srv) => {
              const hasUniversalStickers = userPlan === 'essential' || userPlan === 'pro';
              const canUse = hasUniversalStickers || (isRealServer(activeServerId) && activeServerId === srv.id);
              const stickers = stickersByServer[srv.id].filter((st) => !q || st.name.toLowerCase().includes(q) || st.description?.toLowerCase().includes(q));
              if (stickers.length === 0) return null;
              return (
                <div key={srv.id} className="mb-3 last:mb-0">
                  <div className="flex items-center gap-2 py-1 sticky top-0 z-10" style={{ backgroundColor: PICKER_STICKY_BG, backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)' }}>
                    {srv.icon ? (
                      <img src={sanitizeImgSrc(srv.icon)} alt="" className="w-4 h-4 rounded-full object-cover" loading="lazy" decoding="async" width={16} height={16} data-original-src={toOriginalUploadPath(srv.icon)} onError={retryOnExpired} />
                    ) : (
                      <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold" style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-secondary)' }}>
                        {srv.name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="text-[11px] font-semibold uppercase tracking-wider truncate" style={{ color: canUse ? 'var(--text-secondary)' : 'var(--text-secondary)' }}>
                      {srv.name}
                    </span>
                    {!canUse && <span className="pro-shimmer-badge flex items-center gap-0.5 shrink-0 px-1.5 py-0.5 rounded-md border border-[var(--cyan-accent)]/25" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)' }}><Crown size={8} className="text-[var(--cyan-accent)]" /><span className="text-[8px] font-bold text-[var(--cyan-accent)]">Essential+</span></span>}
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {stickers.map((sticker) => (
                      <button
                        key={sticker.id} type="button" disabled={!canUse}
                        onClick={() => canUse && onSelect(sticker)}
                        className={`group relative flex flex-col items-center gap-1 p-2 rounded-xl transition-all ${canUse ? 'hover:bg-fill-active active:scale-[0.95] cursor-pointer' : 'opacity-30 cursor-not-allowed'}`}
                      >
                        <img src={sanitizeImgSrc(sticker.imageUrl)} alt={sticker.name} className="w-16 h-16 object-contain" loading="lazy" decoding="async" width={64} height={64} draggable={false} data-original-src={toOriginalUploadPath(sticker.imageUrl)} onError={(e) => { if (!retryOnExpired(e)) e.currentTarget.style.display = 'none'; }} />
                        <span className="text-[10px] truncate w-full text-center" style={{ color: 'var(--text-secondary)' }}>{sticker.name}</span>
                      </button>
                    ))}
                  </div>
                </div>
              );
            });
            if (q && rendered.every(r => r === null)) {
              return (
                <div className="flex flex-col items-center justify-center h-32 gap-2">
                  <Sticker size={32} style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
                  <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('sticker.noStickersFound', 'No stickers found')}</span>
                </div>
              );
            }
            return rendered;
          })()
        )}
      </div>

      {/* Footer hint */}
      <div className="flex items-center px-3 h-9 shrink-0 border-t" style={PICKER_FOOTER_STYLE}>
        <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>
          {isRealServer(activeServerId) ? t('sticker.clickToSend') : t('sticker.navigateToSend')}
        </span>
      </div>
    </div>
  );
};
