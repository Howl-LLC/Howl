// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { X, Search, MessageCirclePlus, Hash, ChevronDown, Archive } from 'lucide-react';
import type { Channel, Thread } from '../types';
import { apiClient } from '../services/api';
import { useIsMobile } from '../hooks/useIsMobile';
import { useAuthStore } from '../stores/authStore';

export interface ThreadBrowserProps {
  serverId: string;
  channels: Channel[];
  open: boolean;
  onClose: () => void;
  onOpenThread: (thread: Thread) => void;
  canManageThreads: boolean;
  onUnarchiveThread?: (thread: Thread) => void;
  anchorRef?: React.RefObject<HTMLDivElement | null>;
}

export const ThreadBrowser: React.FC<ThreadBrowserProps> = ({ serverId, channels, open, onClose, onOpenThread, canManageThreads, onUnarchiveThread, anchorRef }) => {
  const _currentUserId = useAuthStore(s => s.currentUser)?.id ?? '';
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [tab, setTab] = useState<'active' | 'archived'>('active');
  const [filterChannelId, setFilterChannelId] = useState<string>('');
  const [search, setSearch] = useState('');
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [channelDropdownOpen, setChannelDropdownOpen] = useState(false);

  const loadThreads = useCallback(async () => {
    if (!serverId) return;
    setLoading(true);
    const archived = tab === 'archived';
    const channelsToFetch = filterChannelId ? [filterChannelId] : channels.map((c) => c.id);
    const results = await Promise.allSettled(
      channelsToFetch.map((chId) => apiClient.getThreads(chId, serverId, archived))
    );
    const merged: Thread[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') merged.push(...r.value);
    }
    merged.sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime());
    setThreads(merged);
    setLoading(false);
  }, [serverId, channels, filterChannelId, tab]);

  useEffect(() => { if (open) loadThreads(); }, [open, loadThreads]);

  const containerRef = useRef<HTMLDivElement>(null);

  // Outside-click to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (containerRef.current && !containerRef.current.contains(target) && !anchorRef?.current?.contains(target)) onClose();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, onClose, anchorRef]);

  const channelMap = useMemo(() => new Map(channels.map((c) => [c.id, c])), [channels]);

  const filtered = useMemo(() => {
    if (!search.trim()) return threads;
    const q = search.toLowerCase();
    return threads.filter((t) => t.name.toLowerCase().includes(q));
  }, [threads, search]);

  const filterChannelName = filterChannelId ? channelMap.get(filterChannelId)?.name ?? '' : t('threads.allChannels');

  const relativeTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  };

  if (!open) return null;

  const content = (
    <div
      ref={(el) => {
        (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
        if (el && anchorRef?.current && !isMobile) {
          const r = anchorRef.current.getBoundingClientRect();
          el.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - 340))}px`;
          el.style.top = `${Math.max(8, Math.min(r.bottom + 8, window.innerHeight - 500))}px`;
        }
      }}
      className={`fixed z-[var(--z-max)] flex flex-col rounded-2xl border shadow-2xl ${isMobile ? 'inset-2' : ''}`}
      style={{
        width: isMobile ? undefined : 320,
        maxHeight: isMobile ? undefined : 480,
        backgroundColor: 'var(--glass-bg)',
        borderColor: 'var(--glass-border)',
        backdropFilter: 'blur(24px) saturate(1.4)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
        boxShadow: '0 0 0 1px var(--border-subtle) inset, 0 25px 50px -12px rgba(0,0,0,0.4)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('threads.threadBrowser')}</h3>
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
          <X size={16} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pt-3 pb-2 space-y-2 shrink-0">
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-tertiary)' }} />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('threads.searchThreads')}
            className="w-full pl-8 pr-3 py-2 rounded-lg border text-xs outline-none focus:border-[var(--cyan-accent)]/50"
            style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
          />
        </div>

        {/* Channel filter */}
        <div className="relative">
          <button
            type="button"
            onClick={() => setChannelDropdownOpen((o) => !o)}
            className="w-full flex items-center justify-between px-3 py-1.5 rounded-lg border text-xs"
            style={{ backgroundColor: 'var(--bg-input)', borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <span className="truncate">{filterChannelName}</span>
            <ChevronDown size={12} className={`shrink-0 transition-transform ${channelDropdownOpen ? 'rotate-180' : ''}`} />
          </button>
          {channelDropdownOpen && (
            <div className="absolute left-0 right-0 top-full mt-1 z-50 rounded-lg border py-1 max-h-40 overflow-y-auto no-scrollbar" style={{ backgroundColor: 'var(--bg-floating)', borderColor: 'var(--border-subtle)' }}>
              <button
                type="button"
                onClick={() => { setFilterChannelId(''); setChannelDropdownOpen(false); }}
                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${!filterChannelId ? 'text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                style={{ color: !filterChannelId ? undefined : 'var(--text-secondary)' }}
              >
                {t('threads.allChannels')}
              </button>
              {channels.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => { setFilterChannelId(ch.id); setChannelDropdownOpen(false); }}
                  className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-1.5 transition-colors ${filterChannelId === ch.id ? 'text-[var(--cyan-accent)]' : 'hover:bg-fill-hover'}`}
                  style={{ color: filterChannelId === ch.id ? undefined : 'var(--text-secondary)' }}
                >
                  <Hash size={10} className="opacity-60 shrink-0" /> {ch.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Tabs */}
        <div className="flex gap-1 p-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
          <button
            type="button"
            onClick={() => setTab('active')}
            className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${tab === 'active' ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
            style={{ color: tab === 'active' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
          >
            {t('threads.active')}
          </button>
          <button
            type="button"
            onClick={() => setTab('archived')}
            className={`flex-1 text-xs font-medium py-1.5 rounded-md transition-colors ${tab === 'archived' ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
            style={{ color: tab === 'archived' ? 'var(--text-primary)' : 'var(--text-tertiary)' }}
          >
            {t('threads.archivedTab')}
          </button>
        </div>
      </div>

      {/* Thread list */}
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 no-scrollbar">
        {loading && (
          <div className="space-y-2 pt-2">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-14 rounded-lg animate-pulse" style={{ backgroundColor: 'var(--fill-hover)' }} />
            ))}
          </div>
        )}
        {!loading && filtered.length === 0 && (
          <div className="flex flex-col items-center justify-center py-8 gap-2">
            <MessageCirclePlus size={24} style={{ color: 'var(--text-secondary)', opacity: 0.3 }} />
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
              {tab === 'active' ? t('threads.noActiveThreads') : t('threads.noArchivedThreads')}
            </p>
          </div>
        )}
        {!loading && filtered.map((thread) => {
          const parentChannel = channelMap.get(thread.channelId);
          return (
            <button
              key={thread.id}
              type="button"
              onClick={() => onOpenThread(thread)}
              className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-fill-hover transition-colors mb-1 group"
            >
              <div className="flex items-start gap-2">
                <MessageCirclePlus size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--cyan-accent)', opacity: 0.7 }} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>{thread.name}</span>
                    {parentChannel && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full shrink-0" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-tertiary)' }}>
                        #{parentChannel.name}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>
                      {thread.messageCount === 1 ? t('threads.replySingleCount', { count: 1 }) : t('threads.repliesCount', { count: thread.messageCount ?? 0 })}
                    </span>
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)', opacity: 0.6 }}>&middot;</span>
                    <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{relativeTime(thread.lastActivityAt)}</span>
                  </div>
                </div>
              </div>
              {tab === 'archived' && canManageThreads && onUnarchiveThread && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onUnarchiveThread(thread); }}
                  className="mt-1.5 text-[10px] font-medium px-2 py-1 rounded-md opacity-0 group-hover:opacity-100 transition-opacity"
                  style={{ backgroundColor: 'var(--accent-subtle)', color: 'var(--cyan-accent)' }}
                >
                  <Archive size={10} className="inline mr-1" />{t('threads.unarchive')}
                </button>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );

  return createPortal(content, document.body);
};
