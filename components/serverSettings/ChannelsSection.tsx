// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Hash, Volume2, FolderOpen, GripVertical, Pencil, Trash2, Plus, ChevronDown, ShieldAlert, X, Check, Radio, MessageSquare, Tag } from 'lucide-react';
import { Dropdown } from '../ui/dropdown';
import { Server, Channel, ChannelCategory } from '../../types';
import { SectionHeader } from '../settings/SettingsWidgets';
import { useIsMobile } from '../../hooks/useIsMobile';
import { computeChannelMove, computeCategoryMove } from '../../utils/channelReorder';
import { apiClient } from '../../services/api';

export interface ChannelsSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
  onCreateChannel?: (serverId: string, name: string, type: 'text' | 'voice' | 'stage' | 'forum' | 'role_picker', categoryId: string) => Promise<Channel>;
  onUpdateChannel?: (serverId: string, channelId: string, data: { name?: string; description?: string | null; ageRestricted?: boolean }) => Promise<Channel>;
  onDeleteChannel?: (serverId: string, channelId: string) => Promise<void>;
  onCreateCategory?: (serverId: string, name: string) => Promise<ChannelCategory>;
  onUpdateCategory?: (serverId: string, categoryId: string, data: { name?: string }) => Promise<ChannelCategory>;
  onDeleteCategory?: (serverId: string, categoryId: string) => Promise<void>;
  onReorderChannels?: (serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>) => Promise<void>;
  onReorderCategories?: (serverId: string, categories: Array<{ id: string; position: number }>) => Promise<void>;
}

export const ChannelsSection: React.FC<ChannelsSectionProps> = ({
  server, showToast,
  onCreateChannel, onUpdateChannel, onDeleteChannel,
  onCreateCategory, onUpdateCategory, onDeleteCategory,
  onReorderChannels, onReorderCategories,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // Collapse
  const [collapsedCats, setCollapsedCats] = useState<Set<string>>(new Set());

  // Inline editing
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editCategoryName, setEditCategoryName] = useState('');
  const [editingChannelId, setEditingChannelId] = useState<string | null>(null);
  const [editChannelName, setEditChannelName] = useState('');

  // Create inline forms
  const [newCategoryName, setNewCategoryName] = useState('');
  const [showNewCategory, setShowNewCategory] = useState(false);
  const [newChannelName, setNewChannelName] = useState('');
  const [newChannelType, setNewChannelType] = useState<'text' | 'voice' | 'stage' | 'forum' | 'role_picker'>('text');
  const [newChannelCategoryId, setNewChannelCategoryId] = useState<string>('');
  const [showNewChannel, setShowNewChannel] = useState(false);

  // Delete confirms
  const [deleteCategoryConfirm, setDeleteCategoryConfirm] = useState<{ category: ChannelCategory; moveToId: string } | null>(null);
  const [deleteChannelConfirm, setDeleteChannelConfirm] = useState<Channel | null>(null);

  // Whether this server is in Discovery — when true, the age-restricted
  // toggle is disabled because the two are mutually exclusive (a server
  // listed in Discovery can't have any age-restricted channels).
  const [serverDiscoveryEnabled, setServerDiscoveryEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    apiClient.getServerSettings(server.id).then((settings) => {
      if (!cancelled) setServerDiscoveryEnabled(settings.discoveryEnabled ?? false);
    }).catch(() => { /* default false */ });
    return () => { cancelled = true; };
  }, [server.id]);

  // Drag state. `dropTarget` is the in-flight drop indicator: a channel
  // row + before/after position, OR a category header (for cross-category
  // channel drops or category-on-category reorder).
  const [dragCategoryId, setDragCategoryId] = useState<string | null>(null);
  const [dragChannelId, setDragChannelId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<
    | { kind: 'channel'; id: string; before: boolean }
    | { kind: 'category'; id: string; before: boolean }
    | { kind: 'category-into'; id: string }
    | null
  >(null);
  // Auto-clear during drag-end / drop. Held in a ref so the cleanup
  // closure doesn't capture stale state.
  const clearDrag = useRef(() => {
    setDragCategoryId(null);
    setDragChannelId(null);
    setDropTarget(null);
  });

  // Computed
  const categories = useMemo(() =>
    (server.categories ?? []).slice().sort((a, b) => a.position - b.position),
    [server.categories]
  );

  const channelsByCategory = useMemo(() => {
    const map = new Map<string, Channel[]>();
    for (const cat of categories) map.set(cat.id, []);
    for (const ch of server.channels) {
      if (!ch.categoryId) continue;
      const list = map.get(ch.categoryId);
      if (list) list.push(ch);
    }
    for (const [, list] of map) list.sort((a, b) => a.position - b.position);
    return map;
  }, [server.channels, categories]);

  const defaultCategoryId = categories[0]?.id;

  // Toggle collapse
  const toggleCollapse = useCallback((catId: string) => {
    setCollapsedCats(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId); else next.add(catId);
      return next;
    });
  }, []);

  // Category drag handlers
  const handleCategoryDragStart = useCallback((e: React.DragEvent, catId: string) => {
    setDragCategoryId(catId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', catId);
  }, []);

  /** dragOver on a category header. Two valid drag types:
   *   1. Another category being reordered → before/after indicator on
   *      the header based on cursor Y.
   *   2. A channel being moved into this category → 'category-into'
   *      indicator (ring around the category section). */
  const handleCategoryDragOver = useCallback((e: React.DragEvent, catId: string) => {
    // Both branches require preventDefault — without it the browser
    // refuses the drop entirely. The earlier bug was guarding on
    // `dragCategoryId` and never calling preventDefault for channel
    // drags, which is exactly why drag "did nothing" when crossing
    // categories.
    if (dragCategoryId && dragCategoryId !== catId) {
      e.preventDefault();
      const rect = e.currentTarget.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      setDropTarget({ kind: 'category', id: catId, before });
      return;
    }
    if (dragChannelId) {
      e.preventDefault();
      setDropTarget({ kind: 'category-into', id: catId });
      return;
    }
  }, [dragCategoryId, dragChannelId]);

  const handleCategoryDrop = useCallback(async (e: React.DragEvent, targetCatId: string) => {
    e.preventDefault();
    // Branch 1: category being reordered.
    if (dragCategoryId) {
      const targetIdx = categories.findIndex(c => c.id === targetCatId);
      if (targetIdx === -1) { clearDrag.current(); return; }
      const before = dropTarget?.kind === 'category' && dropTarget.id === targetCatId ? dropTarget.before : true;
      const updates = computeCategoryMove({
        categories,
        draggedId: dragCategoryId,
        targetIndex: before ? targetIdx : targetIdx + 1,
      });
      clearDrag.current();
      if (!updates) return;
      try {
        await onReorderCategories?.(server.id, updates);
        showToast(t('categories.reordered'), 'success');
      } catch {
        showToast(t('categories.reorderFailed'), 'error');
      }
      return;
    }
    // Branch 2: channel dropped onto a category header → move to start
    // of that category's channel list.
    if (dragChannelId) {
      const updates = computeChannelMove({
        channels: server.channels,
        draggedId: dragChannelId,
        targetCategoryId: targetCatId,
        targetIndex: 0,
      });
      clearDrag.current();
      if (!updates) return;
      try {
        await onReorderChannels?.(server.id, updates);
        showToast(t('categories.channelMoved'), 'success');
      } catch {
        showToast(t('categories.reorderFailed'), 'error');
      }
      return;
    }
    clearDrag.current();
  }, [dragCategoryId, dragChannelId, dropTarget, categories, server.id, server.channels, onReorderCategories, onReorderChannels, showToast, t]);

  // Channel drag handlers
  const handleChannelDragStart = useCallback((e: React.DragEvent, chId: string) => {
    setDragChannelId(chId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chId);
  }, []);

  /** Compute before/after based on cursor Y inside the row, then set
   *  the drop indicator. Always preventDefault so the row accepts the
   *  drop — earlier the channel onDragOver was a bare preventDefault
   *  with no indicator, which is why drag had no visual feedback. */
  const handleChannelDragOver = useCallback((e: React.DragEvent, chId: string) => {
    if (!dragChannelId || dragChannelId === chId) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropTarget({ kind: 'channel', id: chId, before });
  }, [dragChannelId]);

  const handleChannelDrop = useCallback(async (e: React.DragEvent, targetCategoryId: string, targetChannelIdx: number) => {
    e.preventDefault();
    if (!dragChannelId) return;
    const before = dropTarget?.kind === 'channel' ? dropTarget.before : true;
    const updates = computeChannelMove({
      channels: server.channels,
      draggedId: dragChannelId,
      targetCategoryId,
      targetIndex: before ? targetChannelIdx : targetChannelIdx + 1,
    });
    clearDrag.current();
    if (!updates) return;
    try {
      await onReorderChannels?.(server.id, updates);
      showToast(t('categories.channelMoved'), 'success');
    } catch {
      showToast(t('categories.reorderFailed'), 'error');
    }
  }, [dragChannelId, dropTarget, server.id, server.channels, onReorderChannels, showToast, t]);

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title={t('serverSettings.channelsAndCategories')} icon={<FolderOpen size={24} />} />

      {/* Action buttons */}
      <div className="flex gap-2">
        <button type="button" onClick={() => { setShowNewChannel(true); setNewChannelCategoryId(defaultCategoryId ?? ''); }}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
          style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-primary)', border: '1px solid var(--glass-border)' }}>
          <Plus size={12} /> {t('sidebar.createChannel')}
        </button>
        <button type="button" onClick={() => setShowNewCategory(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors"
          style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-primary)', border: '1px solid var(--glass-border)' }}>
          <Plus size={12} /> {t('sidebar.createCategory')}
        </button>
      </div>

      {/* Category list */}
      <div className="space-y-3">
        {categories.map((cat, catIdx) => {
          const isDefault = cat.id === defaultCategoryId;
          const isCollapsed = collapsedCats.has(cat.id);
          const channels = channelsByCategory.get(cat.id) ?? [];
          const isEditing = editingCategoryId === cat.id;
          // New drag visual states.
          const isDraggingThisCategory = dragCategoryId === cat.id;
          const showCategoryDropLineBefore = dropTarget?.kind === 'category' && dropTarget.id === cat.id && dropTarget.before;
          const showCategoryDropLineAfter = dropTarget?.kind === 'category' && dropTarget.id === cat.id && !dropTarget.before;
          const showCategoryIntoRing = dropTarget?.kind === 'category-into' && dropTarget.id === cat.id;

          return (
            <div key={cat.id} className="relative">
              {/* Insertion line above this category. */}
              {showCategoryDropLineBefore && (
                <div className="absolute left-0 right-0 -top-1 h-0.5 rounded-full pointer-events-none" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
              )}
              {/* Category header */}
              <div
                draggable={!isMobile}
                onDragStart={!isMobile ? (e) => handleCategoryDragStart(e, cat.id) : undefined}
                onDragOver={!isMobile ? (e) => handleCategoryDragOver(e, cat.id) : undefined}
                onDrop={!isMobile ? (e) => handleCategoryDrop(e, cat.id) : undefined}
                onDragEnd={!isMobile ? () => clearDrag.current() : undefined}
                className={`flex items-center gap-2 px-3 py-2 rounded-lg transition-all ${showCategoryIntoRing ? 'ring-2 ring-[var(--cyan-accent)]/50' : ''}`}
                style={{
                  backgroundColor: 'var(--fill-hover)',
                  border: '1px solid var(--glass-border)',
                  opacity: isDraggingThisCategory ? 0.4 : 1,
                }}
              >
                {!isMobile && <GripVertical size={14} className="shrink-0 cursor-grab active:cursor-grabbing" style={{ color: 'var(--text-secondary)' }} />}
                {isMobile && (
                  <div className="flex flex-col shrink-0">
                    <button type="button" disabled={catIdx === 0}
                      onClick={async () => {
                        const reordered = categories.map((c, i) => ({ id: c.id, position: i }));
                        [reordered[catIdx], reordered[catIdx - 1]] = [reordered[catIdx - 1], reordered[catIdx]];
                        reordered.forEach((r, i) => r.position = i);
                        try { await onReorderCategories?.(server.id, reordered); } catch { /* handled */ }
                      }}
                      className="p-0.5 disabled:opacity-20" style={{ color: 'var(--text-secondary)' }}>
                      <ChevronDown size={12} className="rotate-180" />
                    </button>
                    <button type="button" disabled={catIdx === categories.length - 1}
                      onClick={async () => {
                        const reordered = categories.map((c, i) => ({ id: c.id, position: i }));
                        [reordered[catIdx], reordered[catIdx + 1]] = [reordered[catIdx + 1], reordered[catIdx]];
                        reordered.forEach((r, i) => r.position = i);
                        try { await onReorderCategories?.(server.id, reordered); } catch { /* handled */ }
                      }}
                      className="p-0.5 disabled:opacity-20" style={{ color: 'var(--text-secondary)' }}>
                      <ChevronDown size={12} />
                    </button>
                  </div>
                )}
                <button type="button" onClick={() => toggleCollapse(cat.id)} className="shrink-0">
                  <ChevronDown size={12} className={`transition-transform ${isCollapsed ? '-rotate-90' : ''}`} style={{ color: 'var(--text-secondary)' }} />
                </button>
                <FolderOpen size={14} className="shrink-0" style={{ color: 'var(--text-secondary)' }} />
                {isEditing ? (
                  <input autoFocus value={editCategoryName} onChange={e => setEditCategoryName(e.target.value)}
                    onKeyDown={async e => {
                      if (e.key === 'Enter' && editCategoryName.trim()) {
                        try { await onUpdateCategory?.(server.id, cat.id, { name: editCategoryName.trim() }); showToast(t('categories.renamed'), 'success'); } catch { showToast(t('categories.renameFailed'), 'error'); }
                        setEditingCategoryId(null);
                      }
                      if (e.key === 'Escape') setEditingCategoryId(null);
                    }}
                    onBlur={() => setEditingCategoryId(null)}
                    className="flex-1 bg-black/30 border border-[var(--glass-border)] rounded-lg px-2 py-0.5 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50" />
                ) : (
                  <span className="flex-1 text-sm font-semibold truncate text-t-primary">{cat.name}</span>
                )}
                {isDefault && <span className="text-[9px] px-2 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--cyan-accent)' }}>default</span>}
                <span className="text-[10px] shrink-0" style={{ color: 'var(--text-secondary)' }}>{channels.length}</span>
                {!isEditing && (
                  <>
                    <button type="button"
                      title={t('channels.createChannelInCategory', { defaultValue: 'Create channel in this category' })}
                      aria-label={t('channels.createChannelInCategory', { defaultValue: 'Create channel in this category' })}
                      onClick={() => {
                        setNewChannelCategoryId(cat.id);
                        setShowNewChannel(true);
                      }}
                      className="p-1 rounded-lg hover:bg-fill-active transition-colors shrink-0">
                      <Plus size={12} style={{ color: 'var(--text-secondary)' }} />
                    </button>
                    <button type="button" onClick={() => { setEditingCategoryId(cat.id); setEditCategoryName(cat.name); }} className="p-1 rounded-lg hover:bg-fill-active transition-colors shrink-0">
                      <Pencil size={12} style={{ color: 'var(--text-secondary)' }} />
                    </button>
                    {!isDefault && (
                      <button type="button" onClick={() => {
                        const others = categories.filter(c => c.id !== cat.id);
                        setDeleteCategoryConfirm({ category: cat, moveToId: others[0]?.id ?? '' });
                      }} className="p-1 rounded-lg hover:bg-red-500/20 transition-colors shrink-0">
                        <Trash2 size={12} style={{ color: 'rgba(239,68,68,0.5)' }} />
                      </button>
                    )}
                  </>
                )}
              </div>

              {/* Channels */}
              {!isCollapsed && (
                <div className="pl-5 mt-1 space-y-0.5">
                  {channels.map((ch, chIdx) => {
                    const isEditingCh = editingChannelId === ch.id;
                    const isDraggingThisChannel = dragChannelId === ch.id;
                    const showLineBefore = dropTarget?.kind === 'channel' && dropTarget.id === ch.id && dropTarget.before;
                    const showLineAfter = dropTarget?.kind === 'channel' && dropTarget.id === ch.id && !dropTarget.before;
                    return (
                      <div key={ch.id} className="relative">
                        {showLineBefore && (
                          <div className="absolute left-0 right-0 -top-0.5 h-0.5 rounded-full pointer-events-none z-10" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
                        )}
                        <div
                        draggable={!isMobile}
                        onDragStart={!isMobile ? (e) => handleChannelDragStart(e, ch.id) : undefined}
                        onDragOver={!isMobile ? (e) => handleChannelDragOver(e, ch.id) : undefined}
                        onDrop={!isMobile ? (e) => handleChannelDrop(e, cat.id, chIdx) : undefined}
                        onDragEnd={!isMobile ? () => clearDrag.current() : undefined}
                        className="flex items-center gap-2 px-2.5 py-1.5 rounded-md transition-all"
                        style={{
                          backgroundColor: 'var(--fill-hover)',
                          border: '1px solid var(--glass-border)',
                          opacity: isDraggingThisChannel ? 0.4 : 1,
                        }}
                      >
                        {!isMobile && <GripVertical size={12} className="shrink-0 cursor-grab active:cursor-grabbing" style={{ color: 'var(--text-secondary)' }} />}
                        {isMobile && (
                          <div className="flex flex-col shrink-0">
                            <button type="button" disabled={chIdx === 0}
                              onClick={async () => {
                                const reordered = channels.map((c, i) => ({ id: c.id, position: i, categoryId: c.categoryId }));
                                [reordered[chIdx], reordered[chIdx - 1]] = [reordered[chIdx - 1], reordered[chIdx]];
                                reordered.forEach((r, i) => r.position = i);
                                try { await onReorderChannels?.(server.id, reordered); } catch { /* handled */ }
                              }}
                              className="p-0.5 disabled:opacity-20" style={{ color: 'var(--text-secondary)' }}>
                              <ChevronDown size={10} className="rotate-180" />
                            </button>
                            <button type="button" disabled={chIdx === channels.length - 1}
                              onClick={async () => {
                                const reordered = channels.map((c, i) => ({ id: c.id, position: i, categoryId: c.categoryId }));
                                [reordered[chIdx], reordered[chIdx + 1]] = [reordered[chIdx + 1], reordered[chIdx]];
                                reordered.forEach((r, i) => r.position = i);
                                try { await onReorderChannels?.(server.id, reordered); } catch { /* handled */ }
                              }}
                              className="p-0.5 disabled:opacity-20" style={{ color: 'var(--text-secondary)' }}>
                              <ChevronDown size={10} />
                            </button>
                          </div>
                        )}
                        {ch.type === 'text' ? <Hash size={12} style={{ color: 'var(--text-secondary)' }} /> : <Volume2 size={12} style={{ color: 'var(--text-secondary)' }} />}
                        {isEditingCh ? (
                          <input autoFocus value={editChannelName} onChange={e => setEditChannelName(e.target.value)}
                            onKeyDown={async e => {
                              if (e.key === 'Enter' && editChannelName.trim()) {
                                try { await onUpdateChannel?.(server.id, ch.id, { name: editChannelName.trim() }); showToast(t('categories.channelRenamed'), 'success'); } catch { showToast(t('categories.renameFailed'), 'error'); }
                                setEditingChannelId(null);
                              }
                              if (e.key === 'Escape') setEditingChannelId(null);
                            }}
                            onBlur={() => setEditingChannelId(null)}
                            className="flex-1 bg-black/30 border border-[var(--glass-border)] rounded-lg px-2 py-0.5 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50" />
                        ) : (
                          <span className="flex-1 text-sm truncate text-t-primary">{ch.name}</span>
                        )}
                        <span className="text-[9px] shrink-0 uppercase" style={{ color: 'var(--text-secondary)' }}>{ch.type}</span>
                        {!isEditingCh && (
                          <>
                            <button
                              type="button"
                              disabled={serverDiscoveryEnabled}
                              title={
                                serverDiscoveryEnabled
                                  ? t('channelSettings.ageRestrictedDisabledByDiscovery', 'Remove this server from Discovery to enable age restrictions.')
                                  : ch.ageRestricted
                                    ? t('channelSettings.ageRestrictedOn', 'Age-restricted (18+). Click to remove.')
                                    : t('channelSettings.ageRestrictedOff', 'Mark this channel age-restricted (18+).')
                              }
                              onClick={async () => {
                                const next = !ch.ageRestricted;
                                try {
                                  await onUpdateChannel?.(server.id, ch.id, { ageRestricted: next });
                                  showToast(next ? t('channelSettings.ageRestrictedToastOn', 'Channel marked 18+') : t('channelSettings.ageRestrictedToastOff', 'Age restriction removed'), 'success');
                                } catch {
                                  showToast(t('categories.renameFailed'), 'error');
                                }
                              }}
                              className={`px-1 py-0.5 rounded-lg text-[9px] font-bold transition-colors shrink-0 ${serverDiscoveryEnabled ? 'cursor-not-allowed' : 'hover:brightness-110'}`}
                              style={{
                                opacity: serverDiscoveryEnabled ? 0.3 : 1,
                                backgroundColor: ch.ageRestricted ? 'var(--accent-emphasis)' : 'transparent',
                                color: ch.ageRestricted ? 'var(--cyan-accent)' : 'var(--text-secondary)',
                                border: `1px solid ${ch.ageRestricted ? 'var(--cyan-accent)' : 'var(--glass-border)'}`,
                              }}
                              aria-pressed={!!ch.ageRestricted}
                              aria-label={t('channelSettings.ageRestricted', 'Age-Restricted')}
                            >
                              <ShieldAlert size={9} className="inline -mt-0.5 mr-0.5" />18+
                            </button>
                            <button type="button" onClick={() => { setEditingChannelId(ch.id); setEditChannelName(ch.name); }} className="p-0.5 rounded-lg hover:bg-fill-active transition-colors shrink-0">
                              <Pencil size={10} style={{ color: 'var(--text-secondary)' }} />
                            </button>
                            <button type="button" onClick={() => setDeleteChannelConfirm(ch)} className="p-0.5 rounded-lg hover:bg-red-500/20 transition-colors shrink-0">
                              <Trash2 size={10} style={{ color: 'rgba(239,68,68,0.4)' }} />
                            </button>
                          </>
                        )}
                        </div>
                        {showLineAfter && (
                          <div className="absolute left-0 right-0 -bottom-0.5 h-0.5 rounded-full pointer-events-none z-10" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
                        )}
                      </div>
                    );
                  })}
                  {channels.length === 0 && <p className="text-xs px-2 py-2" style={{ color: 'var(--text-secondary)' }}>{t('categories.emptyCategory')}</p>}
                </div>
              )}
              {/* Insertion line below this category. */}
              {showCategoryDropLineAfter && (
                <div className="absolute left-0 right-0 -bottom-1 h-0.5 rounded-full pointer-events-none" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Create category inline */}
      {showNewCategory && (() => {
        const submit = async () => {
          const name = newCategoryName.trim();
          if (!name) return;
          try { await onCreateCategory?.(server.id, name); setNewCategoryName(''); setShowNewCategory(false); showToast(t('categories.created'), 'success'); }
          catch { showToast(t('categories.createFailed'), 'error'); }
        };
        const cancel = () => { setShowNewCategory(false); setNewCategoryName(''); };
        const canSubmit = newCategoryName.trim().length > 0;
        return (
          <div className="flex items-center gap-2 px-3">
            <FolderOpen size={14} style={{ color: 'var(--text-secondary)' }} />
            <input autoFocus value={newCategoryName} onChange={e => setNewCategoryName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && canSubmit) { e.preventDefault(); submit(); }
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
              }}
              placeholder={t('categories.newCategoryPlaceholder')}
              className="flex-1 bg-black/30 border border-[var(--glass-border)] rounded-lg px-3 py-1.5 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50" />
            <button type="button" onClick={cancel} title={t('common.cancel')} aria-label={t('common.cancel')}
              className="p-1.5 rounded-lg hover:bg-fill-active transition-colors shrink-0">
              <X size={14} style={{ color: 'var(--text-secondary)' }} />
            </button>
            <button type="button" onClick={submit} disabled={!canSubmit}
              className="btn-cta flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all shrink-0 disabled:opacity-40 disabled:cursor-not-allowed">
              <Check size={12} /> {t('common.create')}
            </button>
          </div>
        );
      })()}

      {/* Create channel inline */}
      {showNewChannel && (() => {
        const submit = async () => {
          const name = newChannelName.trim();
          if (!name || !newChannelCategoryId) return;
          try { await onCreateChannel?.(server.id, name, newChannelType, newChannelCategoryId); setNewChannelName(''); setShowNewChannel(false); showToast(t('categories.channelCreated', { defaultValue: 'Channel created' }), 'success'); }
          catch { showToast(t('categories.createFailed'), 'error'); }
        };
        const cancel = () => { setShowNewChannel(false); setNewChannelName(''); };
        const canSubmit = newChannelName.trim().length > 0 && !!newChannelCategoryId;
        return (
          <div className="flex items-center gap-2 px-3 flex-wrap">
            {(() => {
              const hasRolePicker = server.channels.some((c) => c.type === 'role_picker');
              const types: Array<{ value: 'text' | 'voice' | 'stage' | 'forum' | 'role_picker'; icon: React.ReactElement; activeColor: string; activeBg: string; disabled?: boolean; title: string }> = [
                { value: 'text', icon: <Hash size={14} />, activeColor: 'var(--cyan-accent)', activeBg: 'bg-[var(--cyan-accent)]/15', title: 'Text' },
                { value: 'voice', icon: <Volume2 size={14} />, activeColor: '#34d399', activeBg: 'bg-emerald-500/15', title: 'Voice' },
                { value: 'stage', icon: <Radio size={14} />, activeColor: '#a78bfa', activeBg: 'bg-purple-500/15', title: 'Stage' },
                { value: 'forum', icon: <MessageSquare size={14} />, activeColor: '#fbbf24', activeBg: 'bg-amber-500/15', title: 'Forum' },
                { value: 'role_picker', icon: <Tag size={14} />, activeColor: 'var(--cyan-accent)', activeBg: 'bg-[var(--cyan-accent)]/15', disabled: hasRolePicker, title: hasRolePicker ? 'Roles (one already exists in this server)' : 'Roles' },
              ];
              return (
                <div className="flex items-center gap-1">
                  {types.map((t) => {
                    const isActive = newChannelType === t.value;
                    const isDisabled = t.disabled === true;
                    return (
                      <button
                        key={t.value}
                        type="button"
                        disabled={isDisabled}
                        title={t.title}
                        onClick={() => !isDisabled && setNewChannelType(t.value)}
                        className={`p-1 rounded-lg transition-colors ${isActive && !isDisabled ? t.activeBg : 'bg-fill-hover'} ${isDisabled ? 'opacity-30 cursor-not-allowed' : ''}`}
                      >
                        {React.cloneElement(t.icon as React.ReactElement<{ style?: React.CSSProperties }>, { style: { color: isActive && !isDisabled ? t.activeColor : 'var(--text-secondary)' } })}
                      </button>
                    );
                  })}
                </div>
              );
            })()}
            <Dropdown
              options={categories.map(cat => ({ value: cat.id, label: cat.name }))}
              value={newChannelCategoryId || null}
              onChange={(v) => setNewChannelCategoryId(v)}
              size="sm"
              className="max-w-[120px]"
            />
            <input autoFocus value={newChannelName} onChange={e => setNewChannelName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && canSubmit) { e.preventDefault(); submit(); }
                if (e.key === 'Escape') { e.preventDefault(); cancel(); }
              }}
              placeholder={t('channels.newChannelPlaceholder')}
              className="flex-1 min-w-[120px] bg-black/30 border border-[var(--glass-border)] rounded-lg px-3 py-1.5 text-sm text-t-primary outline-none focus:border-[var(--cyan-accent)]/50" />
            <button type="button" onClick={cancel} title={t('common.cancel')} aria-label={t('common.cancel')}
              className="p-1.5 rounded-lg hover:bg-fill-active transition-colors shrink-0">
              <X size={14} style={{ color: 'var(--text-secondary)' }} />
            </button>
            <button type="button" onClick={submit} disabled={!canSubmit}
              className="btn-cta flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all shrink-0 disabled:opacity-40 disabled:cursor-not-allowed">
              <Check size={12} /> {t('common.create')}
            </button>
          </div>
        );
      })()}

      {/* Delete category confirm */}
      {deleteCategoryConfirm && (() => {
        const { category: cat, moveToId } = deleteCategoryConfirm;
        const otherCats = categories.filter(c => c.id !== cat.id);
        const channelsInCat = server.channels.filter(c => c.categoryId === cat.id);
        return (
          <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4" onClick={() => setDeleteCategoryConfirm(null)}>
            <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
            <div className="relative rounded-2xl border shadow-2xl p-6 max-w-sm w-full space-y-4 spring-pop-in"
              style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }} onClick={e => e.stopPropagation()}>
              <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('categories.deleteConfirmTitle', { name: cat.name })}</h3>
              {channelsInCat.length > 0 ? (
                <>
                  <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('categories.deleteHasChannels', { count: channelsInCat.length })}</p>
                  <Dropdown
                    options={otherCats.map(c => ({ value: c.id, label: c.name }))}
                    value={moveToId || null}
                    onChange={(v) => setDeleteCategoryConfirm({ ...deleteCategoryConfirm, moveToId: v })}
                    size="md"
                  />
                </>
              ) : (
                <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>{t('categories.deleteEmpty')}</p>
              )}
              <div className="flex gap-3">
                <button type="button" onClick={() => setDeleteCategoryConfirm(null)} className="flex-1 py-2 rounded-xl text-sm font-semibold" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
                <button type="button" onClick={async () => {
                  try {
                    await onDeleteCategory?.(server.id, cat.id);
                    setDeleteCategoryConfirm(null);
                    showToast(t('categories.categoryDeleted', { defaultValue: 'Category deleted' }), 'success');
                  } catch { showToast(t('categories.reorderFailed'), 'error'); }
                }} className="flex-1 py-2 rounded-xl text-sm font-semibold" style={{ backgroundColor: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>{t('categories.deleteCategory')}</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete channel confirm */}
      {deleteChannelConfirm && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4" onClick={() => setDeleteChannelConfirm(null)}>
          <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" />
          <div className="relative rounded-2xl border shadow-2xl p-6 max-w-sm w-full space-y-4 spring-pop-in"
            style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }} onClick={e => e.stopPropagation()}>
            <h3 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('categories.channelDeleteConfirm', { name: deleteChannelConfirm.name })}</h3>
            <div className="flex gap-3">
              <button type="button" onClick={() => setDeleteChannelConfirm(null)} className="flex-1 py-2 rounded-xl text-sm font-semibold" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
              <button type="button" onClick={async () => {
                try {
                  await onDeleteChannel?.(server.id, deleteChannelConfirm.id);
                  setDeleteChannelConfirm(null);
                  showToast(t('categories.channelDeleted'), 'success');
                } catch { showToast(t('categories.reorderFailed'), 'error'); }
              }} className="flex-1 py-2 rounded-xl text-sm font-semibold" style={{ backgroundColor: 'rgba(239,68,68,0.15)', border: '1px solid rgba(239,68,68,0.3)', color: '#f87171' }}>{t('categories.deleteCategory')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
