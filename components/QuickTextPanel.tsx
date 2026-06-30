// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { MessageSquare, ChevronDown, X } from 'lucide-react';
import { GLASS_MENU_CLASS } from '../utils/contextMenuStyles';
import type { Channel } from '../types';

const QT_MIN_WIDTH = 280;
const QT_MAX_WIDTH = 960;
const QT_MIN_HEIGHT = 320;
const QT_MAX_HEIGHT = 900;
const QT_MOBILE_HEIGHT = 340;

interface QuickTextPanelProps {
  isOpen: boolean;
  onToggle: (open: boolean) => void;
  channels: Channel[];
  selectedChannelId: string | null;
  onChannelSelect: (channelId: string) => void;
  isMobile: boolean;
  isFullscreen?: boolean;
  children: React.ReactNode;
}

export const QuickTextPanel: React.FC<QuickTextPanelProps> = ({
  isOpen,
  onToggle,
  channels,
  selectedChannelId,
  onChannelSelect,
  isMobile,
  isFullscreen,
  children,
}) => {
  const { t } = useTranslation();
  const selectedChannel = selectedChannelId
    ? (channels.find((c) => c.id === selectedChannelId) ?? channels[0])
    : channels[0];

  // Resize state
  const [panelWidth, setPanelWidth] = useState(420);
  const [panelHeight, setPanelHeight] = useState(480);
  const [isDraggingWidth, setIsDraggingWidth] = useState(false);
  const [isDraggingHeight, setIsDraggingHeight] = useState(false);
  const [isDraggingDiagonal, setIsDraggingDiagonal] = useState(false);
  const lastResizeRef = useRef({ x: 0, y: 0 });
  const justResizedRef = useRef(false);

  // Channel dropdown
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const dropdownPortalRef = useRef<HTMLDivElement>(null);

  // Resize drag handlers
  useEffect(() => {
    if (!isDraggingWidth && !isDraggingHeight && !isDraggingDiagonal) return;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - lastResizeRef.current.x;
      const dy = e.clientY - lastResizeRef.current.y;
      lastResizeRef.current = { x: e.clientX, y: e.clientY };
      if (isDraggingWidth || isDraggingDiagonal) {
        setPanelWidth((w) => Math.max(QT_MIN_WIDTH, Math.min(QT_MAX_WIDTH, w - dx)));
      }
      if (isDraggingHeight || isDraggingDiagonal) {
        setPanelHeight((h) => Math.max(QT_MIN_HEIGHT, Math.min(QT_MAX_HEIGHT, h - dy)));
      }
    };
    const onUp = () => {
      if (isDraggingWidth || isDraggingHeight || isDraggingDiagonal) {
        justResizedRef.current = true;
      }
      setIsDraggingWidth(false);
      setIsDraggingHeight(false);
      setIsDraggingDiagonal(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingWidth, isDraggingHeight, isDraggingDiagonal]);

  // Cursor override during drag
  useEffect(() => {
    if (isDraggingWidth || isDraggingHeight || isDraggingDiagonal) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isDraggingDiagonal ? 'nwse-resize' : isDraggingHeight ? 'ns-resize' : 'col-resize';
    } else {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDraggingWidth, isDraggingHeight, isDraggingDiagonal]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (dropdownRef.current?.contains(target)) return;
      if (dropdownPortalRef.current?.contains(target)) return;
      setDropdownOpen(false);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [dropdownOpen]);

  const handleToggleClick = useCallback(() => {
    if (justResizedRef.current) {
      justResizedRef.current = false;
      return;
    }
    onToggle(!isOpen);
  }, [isOpen, onToggle]);

  if (!selectedChannel) return null;

  return (
    <div
      className={`absolute z-[100] ${isMobile ? 'left-2 right-2 flex flex-col items-stretch' : isFullscreen ? 'bottom-20 right-6 flex flex-col items-end' : 'bottom-6 right-6 flex flex-col items-end'}`}
      style={isMobile ? { bottom: 'max(env(safe-area-inset-bottom, 0px), 8px)' } : undefined}
    >
      <div
        role={isOpen ? undefined : 'button'}
        tabIndex={isOpen ? undefined : 0}
        onClick={isOpen ? undefined : handleToggleClick}
        onKeyDown={isOpen ? undefined : (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(true); }
        }}
        className={`quick-text-morph glass flex flex-col overflow-hidden ${isOpen ? 'quick-text-morph-open shadow-2xl' : 'justify-center items-center hover:scale-110 active:scale-95 cursor-pointer shadow-lg'} flex-shrink-0 border backdrop-blur-xl`}
        style={{
          width: isMobile ? (isOpen ? '100%' : 44) : (isOpen ? panelWidth : 44),
          height: isMobile ? (isOpen ? QT_MOBILE_HEIGHT : 44) : (isOpen ? panelHeight : 44),
          borderRadius: isOpen ? 18 : 22,
          boxShadow: isOpen
            ? '0 0 0 1px var(--glass-border) inset, var(--shadow-lg)'
            : '0 0 0 1px var(--glass-border) inset, var(--shadow-lg), 0 0 12px var(--accent-glow)',
        }}
        aria-label={isOpen ? t('voice.closeTextChat') : t('voice.openTextChat')}
      >
        {/* Button state: icon only */}
        {!isOpen && (
          <MessageSquare size={18} className="shrink-0 absolute" style={{ color: 'var(--cyan-accent)', filter: 'drop-shadow(0 0 4px var(--accent-glow))' }} />
        )}

        {/* Panel state */}
        <div className="quick-text-panel-inner absolute inset-0 flex flex-col" style={{ minHeight: 0, height: '100%' }}>
          {/* Resize handles — desktop only */}
          {!isMobile && isOpen && (
            <>
              <div
                role="separator"
                aria-label="Resize panel diagonally"
                className="absolute left-0 top-0 w-6 h-6 cursor-nwse-resize hover:bg-[var(--cyan-accent)]/20 transition-colors z-30 rounded-tl-2xl"
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); lastResizeRef.current = { x: e.clientX, y: e.clientY }; setIsDraggingDiagonal(true); }}
                onClick={(e) => e.stopPropagation()}
              />
              <div
                role="separator"
                aria-label="Resize panel height"
                className="absolute left-6 right-0 top-0 h-1.5 flex items-center justify-center cursor-ns-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-20 group/qtHeight"
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); lastResizeRef.current = { x: e.clientX, y: e.clientY }; setIsDraggingHeight(true); }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-0.5 rounded-full bg-[var(--cyan-accent)]/0 group-hover/qtHeight:bg-[var(--cyan-accent)]/40 transition-colors" />
              </div>
              <div
                role="separator"
                aria-label="Resize panel width"
                className="absolute left-0 top-6 bottom-0 w-1.5 flex items-center justify-center cursor-col-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-20 group/qtWidth"
                onMouseDown={(e) => { e.stopPropagation(); e.preventDefault(); lastResizeRef.current = { x: e.clientX, y: e.clientY }; setIsDraggingWidth(true); }}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-[var(--cyan-accent)]/0 group-hover/qtWidth:bg-[var(--cyan-accent)]/40 transition-colors" />
              </div>
            </>
          )}

          {/* Header: channel selector + close */}
          <div data-header className="shrink-0 flex items-center justify-between gap-3 px-4 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            {channels.length > 1 ? (
              <div ref={dropdownRef} className="flex-1 min-w-0">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setDropdownOpen((o) => !o); }}
                  className="w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2 text-left transition-colors border hover:brightness-125 focus:outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]/50 focus:border-[var(--cyan-accent)]/30"
                  style={{
                    backgroundColor: 'color-mix(in srgb, var(--bg-input) 50%, transparent)',
                    borderColor: 'var(--glass-border)',
                  }}
                >
                  <span className="text-xs font-bold uppercase tracking-wider truncate" style={{ color: 'var(--text-primary)' }}>#{selectedChannel.name}</span>
                  <ChevronDown size={14} className={`shrink-0 transition-transform duration-200 ${dropdownOpen ? 'rotate-180' : ''}`} style={{ color: 'var(--cyan-accent)', opacity: 0.9 }} />
                </button>
                {dropdownOpen && createPortal(
                  <div
                    ref={dropdownPortalRef}
                    className={`fixed py-1 z-[9001] min-w-[120px] glass ${GLASS_MENU_CLASS}`}
                    style={{
                      top: (dropdownRef.current?.getBoundingClientRect().bottom ?? 0) + 4,
                      left: dropdownRef.current?.getBoundingClientRect().left ?? 0,
                      width: dropdownRef.current?.getBoundingClientRect().width ?? 200,
                    }}
                  >
                    {channels.map((ch) => (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onChannelSelect(ch.id);
                          setDropdownOpen(false);
                        }}
                        className={`w-full px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider transition-colors ${ch.id === selectedChannel.id ? '' : 'hover:brightness-125'}`}
                        style={{ color: ch.id === selectedChannel.id ? 'var(--cyan-accent)' : 'var(--text-primary)', ...(ch.id !== selectedChannel.id ? { opacity: 0.85 } : {}) }}
                      >
                        #{ch.name}
                      </button>
                    ))}
                  </div>,
                  document.body
                )}
              </div>
            ) : (
              <span className="text-xs font-bold uppercase tracking-wider truncate" style={{ color: 'var(--text-primary)', opacity: 0.9 }}>#{selectedChannel.name}</span>
            )}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onToggle(false); }}
              className="p-1.5 rounded-xl transition-all duration-[120ms] shrink-0 hover:bg-[var(--text-primary)]/[0.08] active:scale-90"
              style={{ color: 'var(--text-secondary)' }}
              aria-label={t('common.close')}
            >
              <X size={16} />
            </button>
          </div>

          {/* ChatArea content fills the rest — only mount when open so Virtuoso measures correctly */}
          {isOpen && (
            <div className="flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden" style={{ overscrollBehavior: 'contain' }}>
              {children}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
