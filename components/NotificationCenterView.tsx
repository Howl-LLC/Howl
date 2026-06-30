// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Bell, Check, Trash2, Calendar, Mic, BarChart3 } from 'lucide-react';
import type { Server } from '../types';
import { useIsMobile } from '../hooks/useIsMobile';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';

type NotificationItem = {
  id: string;
  serverId?: string;
  channelId?: string;
  threadId?: string;
  type: string;
  title: string;
  body?: string;
  metadata?: Record<string, unknown>;
  read: boolean;
  createdAt: string;
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

interface NotificationCenterViewProps {
  notificationCounts: {
    total: number;
    byServer: Record<string, { mentionCount: number; unreadCount: number }>;
  };
  currentUserId: string;
  servers: Server[];
  onGoToChannel?: (serverId: string, channelId: string) => void;
  onGoToThread?: (serverId: string, channelId: string, threadId: string) => void;
  onCountsChange?: (counts: { total: number; byServer: Record<string, { mentionCount: number; unreadCount: number }> }) => void;
}

export const NotificationCenterView: React.FC<NotificationCenterViewProps> = React.memo(({
  notificationCounts,
  currentUserId: _currentUserId,
  servers,
  onGoToChannel,
  onGoToThread,
  onCountsChange,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'mentions'>('all');
  const [deleteConfirm, setDeleteConfirm] = useState<{ type: 'all' | 'server'; serverId?: string } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Desktop resizable sidebar
  const [width, setWidth] = useState(280);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const stopResizing = useCallback(() => {
    isResizing.current = false;
    document.body.style.cursor = 'default';
    document.body.style.userSelect = 'auto';
  }, []);

  const resize = useCallback((e: MouseEvent) => {
    if (!isResizing.current || !sidebarRef.current) return;
    const sidebarLeft = sidebarRef.current.getBoundingClientRect().left;
    const newWidth = Math.min(Math.max(e.clientX - sidebarLeft, 220), 400);
    setWidth(newWidth);
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  // Fetch notifications
  const fetchNotifications = useCallback(async (serverId: string | null, append = false, before?: string) => {
    setLoading(true);
    try {
      const params: { serverId?: string; limit?: number; before?: string; unreadOnly?: boolean } = { limit: 50, unreadOnly: false };
      if (serverId) params.serverId = serverId;
      if (before) params.before = before;
      const result = await apiClient.getNotifications(params);
      const items = result.notifications as NotificationItem[];
      setNotifications(prev => append ? [...prev, ...items] : items);
      setHasMore(result.hasMore);
    } catch {
      // Silently fail — user sees empty state
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchNotifications(selectedServerId); }, [selectedServerId, fetchNotifications]);
  useEffect(() => { fetchNotifications(selectedServerId); }, [filterMode]);

  // Real-time: prepend new notifications
  useEffect(() => {
    const mentionTypes = new Set(['mention', 'everyone', 'thread_mention']);
    socketService.onNotificationCreated((notif) => {
      if (selectedServerId && notif.serverId !== selectedServerId) return;
      if (filterMode === 'mentions' && !mentionTypes.has(notif.type)) return;
      const item: NotificationItem = {
        id: notif.id ?? `temp-${Date.now()}`,
        serverId: notif.serverId ?? undefined,
        channelId: notif.channelId ?? undefined,
        threadId: notif.threadId ?? undefined,
        type: notif.type, title: notif.title,
        body: notif.body ?? undefined,
        metadata: notif.metadata ?? undefined,
        read: false, createdAt: notif.createdAt,
      };
      setNotifications(prev => prev.some(n => n.id === item.id) ? prev : [item, ...prev]);
    });
    return () => { socketService.offNotificationCreated?.(); };
  }, [selectedServerId, filterMode]);

  // Multi-device read sync
  useEffect(() => {
    socketService.onNotificationReadSync(({ serverId, all }) => {
      if (all) setNotifications(prev => prev.map(n => ({ ...n, read: true })));
      else if (serverId) setNotifications(prev => prev.map(n => n.serverId === serverId ? { ...n, read: true } : n));
    });
    return () => { socketService.offNotificationReadSync?.(); };
  }, []);

  // Multi-device delete sync
  useEffect(() => {
    socketService.onNotificationDeleteSync(({ serverId, all }) => {
      if (all) setNotifications([]);
      else if (serverId) setNotifications(prev => prev.filter(n => n.serverId !== serverId));
    });
    return () => { socketService.offNotificationDeleteSync?.(); };
  }, []);

  // Actions
  const handleMarkRead = useCallback((notificationId: string) => {
    setNotifications(prev => prev.map(n => n.id === notificationId ? { ...n, read: true } : n));
    apiClient.markNotificationRead(notificationId).catch(() => {});
  }, []);

  const handleMarkAllRead = useCallback((serverId?: string) => {
    setNotifications(prev => prev.map(n => (!serverId || n.serverId === serverId) ? { ...n, read: true } : n));
    apiClient.markAllNotificationsRead(serverId).catch(() => {});
    if (onCountsChange) {
      if (serverId) {
        const serverCounts = notificationCounts.byServer[serverId];
        onCountsChange({
          total: Math.max(0, notificationCounts.total - (serverCounts?.unreadCount ?? 0)),
          byServer: { ...notificationCounts.byServer, [serverId]: { mentionCount: 0, unreadCount: 0 } },
        });
      } else {
        onCountsChange({ total: 0, byServer: {} });
      }
    }
  }, [notificationCounts, onCountsChange]);

  const handleJumpTo = useCallback((notif: NotificationItem) => {
    if (!notif.channelId) return;
    handleMarkRead(notif.id);
    if (notif.threadId && notif.channelId && notif.serverId) {
      onGoToThread?.(notif.serverId, notif.channelId, notif.threadId);
    } else if (notif.serverId && notif.channelId) {
      onGoToChannel?.(notif.serverId, notif.channelId);
    }
  }, [handleMarkRead, onGoToChannel, onGoToThread]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || loading || notifications.length === 0) return;
    const oldest = notifications[notifications.length - 1];
    fetchNotifications(selectedServerId, true, oldest.createdAt);
  }, [hasMore, loading, notifications, selectedServerId, fetchNotifications]);

  const handleDeleteAll = useCallback(async () => {
    setDeleteLoading(true);
    try {
      const serverId = deleteConfirm?.type === 'server' ? deleteConfirm.serverId : undefined;
      await apiClient.deleteAllNotifications(serverId);
      setNotifications(prev => serverId ? prev.filter(n => n.serverId !== serverId) : []);
      if (onCountsChange) {
        if (serverId) {
          const { [serverId]: _, ...rest } = notificationCounts.byServer;
          const removedCount = notificationCounts.byServer[serverId]?.unreadCount ?? 0;
          onCountsChange({ total: Math.max(0, notificationCounts.total - removedCount), byServer: rest });
        } else {
          onCountsChange({ total: 0, byServer: {} });
        }
      }
      setDeleteConfirm(null);
    } catch { /* silently fail */ }
    finally { setDeleteLoading(false); }
  }, [deleteConfirm, notificationCounts, onCountsChange]);

  // Server list derived from counts
  const serverList = useMemo(() =>
    Object.entries(notificationCounts.byServer)
      .filter(([, counts]) => counts.unreadCount > 0)
      .map(([serverId, counts]) => {
        const server = servers.find(s => s.id === serverId);
        return { serverId, serverName: server?.name ?? 'Unknown', serverIcon: server?.icon ?? '', mentionCount: counts.mentionCount, unreadCount: counts.unreadCount };
      })
      .sort((a, b) => b.mentionCount - a.mentionCount || b.unreadCount - a.unreadCount),
    [notificationCounts.byServer, servers],
  );

  const selectedServer = selectedServerId ? serverList.find(s => s.serverId === selectedServerId) : null;

  // Notification card
  const renderNotificationCard = useCallback((notif: NotificationItem) => {
    const meta = notif.metadata ?? {};
    const isMention = ['mention', 'everyone', 'thread_mention'].includes(notif.type);
    const isPoll = notif.type === 'poll_ended';
    const isStage = notif.type === 'stage_started';
    const isCalendar = notif.type.startsWith('calendar_');

    const avatarBg = isMention ? 'rgba(239,68,68,0.12)' : isPoll ? 'rgba(139,92,246,0.12)' : isStage ? 'rgba(34,197,94,0.12)' : isCalendar ? 'rgba(245,158,11,0.12)' : 'var(--fill-hover)';
    const avatarColor = isMention ? '#ef4444' : isPoll ? '#8b5cf6' : isStage ? '#22c55e' : isCalendar ? '#f59e0b' : 'var(--text-secondary)';
    const avatarText = isMention ? (String(meta.authorUsername ?? '@')[0]?.toUpperCase() ?? '@') : isPoll ? 'P' : isStage ? 'S' : isCalendar ? 'E' : '#';

    let typeTag: { label: string; bg: string; color: string } | null = null;
    if (notif.type === 'everyone') typeTag = { label: '@everyone', bg: 'rgba(239,68,68,0.1)', color: '#ef4444' };
    if (isPoll) typeTag = { label: 'POLL', bg: 'rgba(139,92,246,0.1)', color: '#8b5cf6' };
    if (isStage) typeTag = { label: 'LIVE', bg: 'rgba(34,197,94,0.1)', color: '#22c55e' };

    const jumpBg = isStage ? 'rgba(34,197,94,0.12)' : isCalendar ? 'rgba(245,158,11,0.12)' : 'var(--accent-muted)';
    const jumpColor = isStage ? '#22c55e' : isCalendar ? '#f59e0b' : 'var(--cyan-accent)';
    const jumpLabel = isStage ? t('notifications.join', 'Join stage') : isPoll ? t('notifications.viewResults', 'View results') : isCalendar ? t('notifications.viewEvent', 'View event') : t('notifications.goToChannel', 'Jump to');

    return (
      <div key={notif.id} className={`flex gap-2.5 p-3 rounded-xl transition-colors cursor-pointer hover:brightness-105 ${notif.read ? 'opacity-45' : ''}`} style={{ backgroundColor: 'var(--fill-hover)', border: '1px solid var(--glass-border)' }}>
        <div className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold shrink-0" style={{ backgroundColor: avatarBg, color: avatarColor }}>
          {isCalendar ? <Calendar size={15} /> : isStage ? <Mic size={14} /> : isPoll ? <BarChart3 size={14} /> : avatarText}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 mb-0.5">
            <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{notif.title}</span>
            {typeTag && <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: typeTag.bg, color: typeTag.color }}>{typeTag.label}</span>}
          </div>
          {typeof meta.channelName === 'string' && !notif.title.includes('#') && <div className="text-[10px] mb-0.5" style={{ color: 'var(--text-secondary)', opacity: 0.6 }}>#{meta.channelName}</div>}
          {notif.body && <div className="text-[11px] truncate mt-0.5" style={{ color: 'var(--text-secondary)' }}>{notif.body}</div>}
          <div className="flex gap-1.5 mt-2">
            {notif.channelId && <button type="button" onClick={(e) => { e.stopPropagation(); handleJumpTo(notif); }} className="text-[9px] font-semibold px-2 py-1 rounded-md transition-colors hover:brightness-125" style={{ backgroundColor: jumpBg, color: jumpColor }}>{jumpLabel}</button>}
            {!notif.read && <button type="button" onClick={(e) => { e.stopPropagation(); handleMarkRead(notif.id); }} className="text-[9px] font-semibold px-2 py-1 rounded-md bg-fill-hover hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>{t('notifications.markRead', 'Mark read')}</button>}
          </div>
        </div>
        <span className="text-[9px] shrink-0 pt-0.5" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>{formatTimeAgo(notif.createdAt)}</span>
      </div>
    );
  }, [t, handleJumpTo, handleMarkRead]);

  // Shared renderers
  const renderFilterTabs = () => (
    <div className="flex gap-1 px-2 mb-2">
      <button type="button" onClick={() => setFilterMode('all')} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-colors ${filterMode === 'all' ? 'bg-fill-active text-t-primary' : 'text-t-secondary hover:text-t-primary'}`}>{t('notifications.all', 'All')}</button>
      <button type="button" onClick={() => setFilterMode('mentions')} className={`px-2.5 py-1 rounded-lg text-[10px] font-bold transition-colors ${filterMode === 'mentions' ? 'bg-fill-active text-t-primary' : 'text-t-secondary hover:text-t-primary'}`}>{t('notifications.mentionsOnly', '@Mentions')}</button>
    </div>
  );

  const renderServerList = () => (
    serverList.length === 0 ? (
      <p className="text-[11px] text-t-secondary px-2 py-4">{t('notifications.noServerNotifications', 'No notifications')}</p>
    ) : (
      <>
        {serverList.map((sn) => (
          <button key={sn.serverId} type="button" onClick={() => setSelectedServerId(sn.serverId)} className={`w-full flex items-center gap-2.5 p-2.5 rounded-xl transition-all text-left mb-1 ${selectedServerId === sn.serverId ? 'bg-[var(--cyan-accent)]/8 border border-[var(--cyan-accent)]/15' : 'border border-transparent hover:bg-fill-hover'}`}>
            <div className="w-7 h-7 rounded-lg overflow-hidden border border-[var(--glass-border)] shrink-0 flex items-center justify-center bg-fill-hover text-[11px] font-bold">
              {sn.serverIcon ? <LazyGif src={sn.serverIcon} frameSrc={getFrameUrl(sn.serverIcon)} alt="" className="w-full h-full object-cover" /> : sn.serverName[0]?.toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[12px] font-bold tracking-tight truncate" style={{ color: selectedServerId === sn.serverId ? 'var(--text-primary)' : 'var(--text-secondary)' }}>{sn.serverName}</div>
              <div className="text-[9px]" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>{sn.mentionCount > 0 ? `${sn.mentionCount} mention${sn.mentionCount !== 1 ? 's' : ''}` : `${sn.unreadCount} message${sn.unreadCount !== 1 ? 's' : ''}`}</div>
            </div>
            {sn.mentionCount > 0 ? (
              <span className="min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0" style={{ boxShadow: '0 0 8px rgba(239,68,68,0.3)' }}>{sn.mentionCount > 99 ? '99+' : sn.mentionCount}</span>
            ) : (
              <div className="w-2 h-2 rounded-full bg-t-primary shrink-0" style={{ boxShadow: '0 0 4px color-mix(in srgb, var(--text-primary) 40%, transparent)' }} />
            )}
          </button>
        ))}
      </>
    )
  );

  const mentionTypes = useMemo(() => new Set(['mention', 'everyone', 'thread_mention']), []);
  const filteredNotifications = useMemo(() =>
    filterMode === 'all' ? notifications : notifications.filter(n => mentionTypes.has(n.type)),
    [notifications, filterMode, mentionTypes],
  );

  const renderNotificationDetail = () => (
    loading && notifications.length === 0 ? (
      <div className="flex-1 flex flex-col items-center justify-center py-16">
        <div className="w-6 h-6 border-2 border-[var(--border-strong)] border-t-[var(--cyan-accent)] rounded-full animate-spin mb-3" />
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('common.loading', 'Loading...')}</p>
      </div>
    ) : !selectedServerId && !isMobile ? (
      <div className="flex-1 flex flex-col items-center justify-center py-16">
        {serverList.length === 0 ? (
          <>
            <Bell size={32} className="mb-3 opacity-20" />
            <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>{t('notifications.noNotifications', 'No notifications yet')}</p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>{t('notifications.allCaughtUp', "You're all caught up")}</p>
          </>
        ) : (
          <p className="text-sm font-medium uppercase tracking-wider" style={{ color: 'var(--text-secondary)', opacity: 0.4 }}>{t('notifications.selectServerToView', 'Select a server')}</p>
        )}
      </div>
    ) : filteredNotifications.length === 0 ? (
      <div className="flex-1 flex flex-col items-center justify-center py-16">
        <Bell size={28} className="mb-3 opacity-15" />
        <p className="text-xs" style={{ color: 'var(--text-secondary)' }}>{t('notifications.noNotifications', 'No notifications')}</p>
      </div>
    ) : (
      <div className="flex-1 overflow-y-auto p-3">
        <div className="space-y-1 max-w-2xl mx-auto">
          {filteredNotifications.map(renderNotificationCard)}
          {hasMore && (
            <button type="button" onClick={handleLoadMore} className="w-full py-2 text-[10px] font-semibold rounded-lg bg-fill-hover hover:bg-fill-active transition-colors mt-2" style={{ color: 'var(--text-secondary)' }} disabled={loading}>
              {loading ? t('common.loading', 'Loading...') : t('notifications.loadMore', 'Load more')}
            </button>
          )}
        </div>
      </div>
    )
  );

  // Mobile layout
  if (isMobile) {
    return (
      <>
        <div className="flex-1 flex flex-col overflow-hidden">
          {selectedServer ? (
            <div className="flex-1 flex flex-col min-w-0 min-h-0" style={{ backgroundColor: 'var(--bg-chat)' }}>
              <div className="h-12 flex items-center px-4 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
                <button type="button" onClick={() => setSelectedServerId(null)} className="text-xs font-semibold flex items-center gap-1" style={{ color: 'var(--cyan-accent)' }}>{'\u2190'} {t('common.back', 'Back')}</button>
                <div className="flex items-center gap-2 ml-3">
                  {selectedServer.serverIcon && <LazyGif src={selectedServer.serverIcon} frameSrc={getFrameUrl(selectedServer.serverIcon)} alt="" className="w-5 h-5 rounded-lg object-cover" />}
                  <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedServer.serverName}</span>
                </div>
                <div className="flex items-center gap-2 ml-auto">
                  <button type="button" onClick={() => handleMarkAllRead(selectedServerId ?? undefined)} className="p-1 rounded-md" style={{ color: 'var(--text-secondary)' }}><Check size={14} /></button>
                  <button type="button" onClick={() => setDeleteConfirm({ type: 'server', serverId: selectedServerId! })} className="p-1 rounded-md" style={{ color: 'var(--text-secondary)' }}><Trash2 size={14} /></button>
                </div>
              </div>
              {renderNotificationDetail()}
            </div>
          ) : (
            <div className="flex-1 flex flex-col overflow-y-auto" style={{ backgroundColor: 'var(--bg-app)' }}>
              <div className="h-14 flex items-center px-4 border-b border-default gap-3 shrink-0">
                <Bell size={20} className="text-[var(--cyan-accent)] shrink-0" />
                <span className="text-sm font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>{t('notifications.serverNotifications', 'Notifications')}</span>
                <button type="button" onClick={() => handleMarkAllRead()} className="p-1 rounded-md transition-colors" style={{ color: 'var(--text-secondary)' }}><Check size={16} /></button>
                <button type="button" onClick={() => setDeleteConfirm({ type: 'all' })} className="p-1 rounded-md transition-colors" style={{ color: 'var(--text-secondary)' }}><Trash2 size={16} /></button>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                {renderFilterTabs()}
                {renderServerList()}
              </div>
            </div>
          )}
        </div>
        {deleteConfirm && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setDeleteConfirm(null)}>
            <div className="absolute inset-0 bg-[var(--overlay-backdrop)] backdrop-blur-sm" />
            <div className="relative rounded-2xl border p-6 w-full max-w-sm" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'rgba(239,68,68,0.15)' }} onClick={e => e.stopPropagation()}>
              <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3.5" style={{ backgroundColor: 'rgba(239,68,68,0.1)' }}><Trash2 size={20} style={{ color: '#ef4444' }} /></div>
              <h3 className="text-[15px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>{t('notifications.deleteAllConfirmTitle', 'Delete all notifications?')}</h3>
              <p className="text-xs mb-5" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{deleteConfirm.type === 'server' ? t('notifications.deleteServerConfirmDesc', 'This will permanently delete all notifications for this server. This action cannot be undone.') : t('notifications.deleteAllConfirmDesc', 'This will permanently delete all your notifications. This action cannot be undone.')}</p>
              <div className="flex gap-2 justify-end">
                <button type="button" onClick={() => setDeleteConfirm(null)} className="btn-secondary text-xs px-4 py-2">{t('common.cancel', 'Cancel')}</button>
                <button type="button" onClick={handleDeleteAll} disabled={deleteLoading} className="btn-cta-danger text-xs px-4 py-2 rounded-xl transition-colors disabled:opacity-50">{deleteLoading ? t('common.deleting', 'Deleting...') : t('common.delete', 'Delete')}</button>
              </div>
            </div>
          </div>
        )}
      </>
    );
  }

  // Desktop layout
  return (
    <>
      <div className="flex-1 flex overflow-hidden">
        <div ref={sidebarRef} className="relative flex flex-col shrink-0 transition-[width] duration-75 ease-out" style={{ width: `${width}px`, paddingTop: 12, paddingBottom: 12, paddingLeft: 12, paddingRight: 0, backgroundColor: 'var(--bg-chat)', backdropFilter: 'blur(24px) saturate(1.1)', WebkitBackdropFilter: 'blur(24px) saturate(1.1)' }}>
          <div className="flex flex-col flex-1 min-h-0 overflow-hidden rounded-2xl" style={{ backgroundColor: 'var(--glass-bg)', border: '1px solid var(--glass-border)', backdropFilter: 'blur(24px) saturate(1.1)' }}>
            <div className="flex items-center gap-2 px-3 pt-3 pb-2">
              <Bell size={16} style={{ color: 'var(--cyan-accent)' }} className="shrink-0" />
              <span className="text-[13px] font-semibold flex-1" style={{ color: 'var(--text-primary)' }}>{t('notifications.serverNotifications', 'Notifications')}</span>
              <button type="button" onClick={() => handleMarkAllRead()} className="p-1 rounded-md transition-colors hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }} title={t('notifications.markAllRead', 'Mark all as read')}><Check size={14} /></button>
              <button type="button" onClick={() => setDeleteConfirm({ type: 'all' })} className="p-1 rounded-md transition-colors hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }} title={t('notifications.deleteAll', 'Delete all notifications')}><Trash2 size={14} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-3 pt-1">
              {renderFilterTabs()}
              {renderServerList()}
            </div>
          </div>
          <div onMouseDown={startResizing} className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-fill-active active:bg-fill-stronger transition-colors z-50" />
        </div>
        <div className="flex-1 flex flex-col min-w-0 min-h-0" style={{ backgroundColor: 'var(--bg-chat)' }}>
          {selectedServer && (
            <div className="h-12 flex items-center px-4 border-b shrink-0" style={{ borderColor: 'var(--border-subtle)' }}>
              <div className="flex items-center gap-2 flex-1">
                {selectedServer.serverIcon && <LazyGif src={selectedServer.serverIcon} frameSrc={getFrameUrl(selectedServer.serverIcon)} alt="" className="w-5 h-5 rounded-lg object-cover" />}
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{selectedServer.serverName}</span>
              </div>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => handleMarkAllRead(selectedServerId ?? undefined)} className="flex items-center gap-1.5 text-[9px] font-semibold px-2.5 py-1.5 rounded-md border transition-colors hover:brightness-110" style={{ borderColor: 'var(--glass-border)', backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}><Check size={11} />{t('notifications.markRead', 'Mark read')}</button>
                <button type="button" onClick={() => setDeleteConfirm({ type: 'server', serverId: selectedServerId! })} className="flex items-center gap-1.5 text-[9px] font-semibold px-2.5 py-1.5 rounded-md border transition-colors hover:brightness-110" style={{ borderColor: 'rgba(239,68,68,0.15)', backgroundColor: 'rgba(239,68,68,0.06)', color: 'rgba(239,68,68,0.7)' }}><Trash2 size={11} />{t('notifications.deleteAll', 'Delete all')}</button>
              </div>
            </div>
          )}
          {renderNotificationDetail()}
        </div>
      </div>
      {deleteConfirm && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center" onClick={() => setDeleteConfirm(null)}>
          <div className="absolute inset-0 bg-[var(--overlay-backdrop)] backdrop-blur-sm" />
          <div className="relative rounded-2xl border p-6 w-full max-w-sm" style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'rgba(239,68,68,0.15)' }} onClick={e => e.stopPropagation()}>
            <div className="w-10 h-10 rounded-xl flex items-center justify-center mb-3.5" style={{ backgroundColor: 'rgba(239,68,68,0.1)' }}><Trash2 size={20} style={{ color: '#ef4444' }} /></div>
            <h3 className="text-[15px] font-semibold mb-1.5" style={{ color: 'var(--text-primary)' }}>{t('notifications.deleteAllConfirmTitle', 'Delete all notifications?')}</h3>
            <p className="text-xs mb-5" style={{ color: 'var(--text-secondary)', lineHeight: 1.5 }}>{deleteConfirm.type === 'server' ? t('notifications.deleteServerConfirmDesc', 'This will permanently delete all notifications for this server. This action cannot be undone.') : t('notifications.deleteAllConfirmDesc', 'This will permanently delete all your notifications. This action cannot be undone.')}</p>
            <div className="flex gap-2 justify-end">
              <button type="button" onClick={() => setDeleteConfirm(null)} className="btn-secondary text-xs px-4 py-2">{t('common.cancel', 'Cancel')}</button>
              <button type="button" onClick={handleDeleteAll} disabled={deleteLoading} className="btn-cta-danger text-xs px-4 py-2 rounded-xl transition-colors disabled:opacity-50">{deleteLoading ? t('common.deleting', 'Deleting...') : t('common.delete', 'Delete')}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});
