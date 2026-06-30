// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Hash, Volume2, Megaphone, ChevronDown, ChevronRight, MessageSquare, Radio, MessageCirclePlus, Bell, BellOff, Check, Settings, Trash2, Plus, Link2, Tag } from 'lucide-react';
import type { Channel, ChannelCategory, Thread } from '../../types';
import { LetterAvatar } from '../LetterAvatar';
import type { UserWithRole } from '../UserProfilePopup';
import { useNotificationStore } from '../../stores/notificationStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useAuthStore } from '../../stores/authStore';
import { isChannelMuted, setChannelMutedForDuration, unmuteChannel, type ChannelMuteDuration } from '../../utils/mutedChannelStorage';
import { getChannelNotificationLevel, setChannelNotificationLevel, type ChannelNotificationLevel } from '../../utils/channelNotificationStorage';
import { getWebOrigin } from '../../config';
import { GLASS_MENU_CLASS } from '../../utils/contextMenuStyles';
import { VoiceMuteOverlay, hasMuteState } from '../voice/VoiceMuteOverlay';
import { getAvatarEffectClass } from '../../shared/planPerks';
import { RoleNameStyle } from '../RoleNameStyle';
import { computeChannelMove, computeCategoryMove } from '../../utils/channelReorder';

const COLLAPSED_KEY = 'howl_classic_collapsed_categories';

// Same set + order the default layout (ChannelList.tsx) uses, so the two
// sidebars feel like one feature. Labels are inline strings rather than
// i18n keys because the surrounding context menu in this file uses inline
// strings too — staying consistent until/unless this whole tree gets i18n.
const CLASSIC_MUTE_OPTIONS: { value: ChannelMuteDuration; label: string }[] = [
  { value: '15m', label: 'For 15 minutes' },
  { value: '1h', label: 'For 1 hour' },
  { value: '3h', label: 'For 3 hours' },
  { value: '8h', label: 'For 8 hours' },
  { value: '24h', label: 'For 24 hours' },
  { value: 'forever', label: 'Until I turn it back on' },
];

const CLASSIC_NOTIF_LEVELS: { value: ChannelNotificationLevel; label: string }[] = [
  { value: 'all', label: 'All Messages' },
  { value: 'mentions', label: 'Only @mentions' },
  { value: 'none', label: 'Nothing' },
];

interface VoiceParticipant {
  id: string;
  username: string;
  avatar?: string | null;
  discriminator?: string;
  // Pro-tier cosmetics. Populated by `voiceStore.allVoiceChannelParticipants`
  // for every voice user on the server, so the Classic tree can show the
  // same name color / font / effect / avatar effect the user has elsewhere.
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  stripePlan?: string;
  roleColor?: string;
  roleStyle?: string;
}

export interface ClassicChannelTreeProps {
  channels: Channel[];
  categories: ChannelCategory[];
  activeChannelId?: string;
  /** Click handler for text / forum / stage channels (navigation). */
  onSelectChannel: (id: string) => void;
  /** Click handler for voice channels — must actually start the LiveKit join.
   *  When omitted, voice channel clicks fall through to onSelectChannel
   *  (useful for read-only previews like the appearance tab). */
  onJoinVoiceChannel?: (id: string) => void;
  /** Stage channels need their own join flow; falls back to onSelectChannel
   *  when not provided. */
  onJoinStage?: (id: string) => void;
  /** Voice channel the current user is currently connected to — gets the
   *  emerald "connected" dot. */
  connectedVoiceChannelId?: string | null;
  voiceParticipantsByChannel?: Record<string, VoiceParticipant[]>;
  pinnedChannelIds?: string[];
  serverId?: string;
  /** Threads grouped by parent channel id. Threads render indented below their
   *  parent channel row, capped at 5 per channel to match the regular sidebar. */
  channelThreads?: Record<string, Thread[]>;
  activeThreadId?: string | null;
  onThreadSelect?: (thread: Thread) => void;
  unreadThreadIds?: Set<string>;
  unreadThreadCounts?: Record<string, number>;
  onUserClick?: (user: UserWithRole, e: React.MouseEvent) => void;
  onUserRightClick?: (user: UserWithRole, e: React.MouseEvent) => void;
  /** "Edit Channel" menu item — when omitted, the item is hidden. */
  onOpenChannelSettings?: (channelId: string) => void;
  /** "Edit Category" menu item — when omitted, the item is hidden. */
  onOpenCategorySettings?: (categoryId: string) => void;
  /** "Mark as Read" menu item. */
  onMarkChannelRead?: (channelId: string) => void;
  /** "Delete Channel" menu item — should typically open a confirmation modal. */
  onRequestDeleteChannel?: (channel: Channel) => void;
  /** When true, a "+" button is shown next to each category header for
   *  opening the create-channel modal scoped to that category. Hidden when
   *  false / omitted (read-only previews). Also gates whether channels and
   *  categories are draggable for reorder. */
  canManageChannels?: boolean;
  /** Click handler for the per-category "+" button. Receives the category id
   *  + name so the create modal can pre-select the category. */
  onCreateChannelInCategory?: (categoryId: string, categoryName: string) => void;
  /** Reorder channels (cross-category aware). When omitted, drag-drop is
   *  disabled. Both Classic and the server-settings panel hit the same
   *  endpoint; the server broadcasts `channels-reordered` so each view
   *  reflows automatically when the other commits a change. */
  onReorderChannels?: (serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>) => Promise<void>;
  /** Reorder categories. When omitted, category drag-drop is disabled. */
  onReorderCategories?: (serverId: string, categories: Array<{ id: string; position: number }>) => Promise<void>;
  /** Server id needed to route reorder calls. Optional so callers that
   *  don't pass reorder handlers don't need it either. */
  reorderServerId?: string;
}

/** In-flight drop indicator. Mirrored in ChannelsSection — keeping the
 *  shape identical means future visual primitives can be shared. */
type DropTarget =
  | { kind: 'channel'; id: string; before: boolean }
  | { kind: 'category'; id: string; before: boolean }
  | { kind: 'category-into'; id: string };

function loadCollapsed(serverId: string | undefined): Set<string> {
  if (!serverId) return new Set();
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    return new Set(parsed[serverId] ?? []);
  } catch { return new Set(); }
}

function saveCollapsed(serverId: string | undefined, set: Set<string>): void {
  if (!serverId) return;
  try {
    const raw = localStorage.getItem(COLLAPSED_KEY);
    const parsed = raw ? JSON.parse(raw) as Record<string, string[]> : {};
    parsed[serverId] = Array.from(set);
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(parsed));
  } catch { /* quota / blocked */ }
}

function channelIcon(type: string | undefined) {
  if (type === 'voice') return Volume2;
  if (type === 'stage') return Radio;
  if (type === 'announcement') return Megaphone;
  if (type === 'forum') return MessageSquare;
  if (type === 'role_picker') return Tag;
  return Hash;
}

type ContextMenuState =
  | { kind: 'channel'; channel: Channel; x: number; y: number }
  | { kind: 'category'; category: ChannelCategory; x: number; y: number }
  | null;

export const ClassicChannelTree = React.memo(function ClassicChannelTree({
  channels, categories, activeChannelId, onSelectChannel,
  onJoinVoiceChannel, onJoinStage, connectedVoiceChannelId,
  voiceParticipantsByChannel, pinnedChannelIds, serverId,
  channelThreads, activeThreadId, onThreadSelect, unreadThreadIds, unreadThreadCounts,
  onUserClick, onUserRightClick,
  onOpenChannelSettings, onOpenCategorySettings,
  onMarkChannelRead, onRequestDeleteChannel,
  canManageChannels, onCreateChannelInCategory,
  onReorderChannels, onReorderCategories, reorderServerId,
}: ClassicChannelTreeProps) {
  // Drag-and-drop reorder. Only enabled when the user has manageChannels +
  // both reorder handlers are provided. We mirror the ChannelsSection
  // (settings) drag UX exactly so the two views feel like one feature.
  const dragEnabled = !!canManageChannels && !!onReorderChannels && !!onReorderCategories && !!reorderServerId;
  const [dragChannelId, setDragChannelId] = useState<string | null>(null);
  const [dragCategoryId, setDragCategoryId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const clearDrag = useCallback(() => {
    setDragChannelId(null);
    setDragCategoryId(null);
    setDropTarget(null);
  }, []);

  // Auto-expand a collapsed category after the user hovers a channel
  // drag over its header for ~600ms. Mirrors the long-standing Discord
  // pattern. The pending timer is held in a ref so we can cancel it
  // when the cursor leaves before the threshold.
  const expandTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelAutoExpand = useCallback(() => {
    if (expandTimerRef.current != null) {
      clearTimeout(expandTimerRef.current);
      expandTimerRef.current = null;
    }
  }, []);

  // Channel drag handlers (closed over above state).
  const handleChannelDragStart = useCallback((e: React.DragEvent, chId: string) => {
    setDragChannelId(chId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', chId);
  }, []);
  const handleChannelDragOver = useCallback((e: React.DragEvent, chId: string) => {
    if (!dragChannelId || dragChannelId === chId) return;
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    setDropTarget({ kind: 'channel', id: chId, before });
  }, [dragChannelId]);
  const handleChannelDrop = useCallback(async (e: React.DragEvent, ch: Channel, chIdx: number) => {
    e.preventDefault();
    if (!dragChannelId || !onReorderChannels || !reorderServerId) { clearDrag(); return; }
    const before = dropTarget?.kind === 'channel' ? dropTarget.before : true;
    const targetCategoryId = ch.categoryId ?? null;
    const updates = computeChannelMove({
      channels,
      draggedId: dragChannelId,
      targetCategoryId,
      targetIndex: before ? chIdx : chIdx + 1,
    });
    clearDrag();
    if (!updates) return;
    try { await onReorderChannels(reorderServerId, updates); } catch { /* surfaces via toast in caller */ }
  }, [dragChannelId, dropTarget, channels, onReorderChannels, reorderServerId, clearDrag]);

  // Category drag handlers — accept both category-on-category and
  // channel-on-category drops. The earlier ChannelsSection bug was
  // that channel-on-category never preventDefault'd; we explicitly
  // handle both branches here.
  const handleCategoryDragStart = useCallback((e: React.DragEvent, catId: string) => {
    setDragCategoryId(catId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', catId);
  }, []);
  const handleCategoryDragOver = useCallback((e: React.DragEvent, catId: string, isCollapsed: boolean) => {
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
      // Auto-expand collapsed category after hover threshold so the user
      // can drop into specific positions inside it.
      if (isCollapsed && expandTimerRef.current == null) {
        const target = catId;
        expandTimerRef.current = setTimeout(() => {
          expandTimerRef.current = null;
          setCollapsed(prev => {
            if (!prev.has(target)) return prev;
            const next = new Set(prev);
            next.delete(target);
            return next;
          });
        }, 600);
      }
    }
  }, [dragCategoryId, dragChannelId]);
  const handleCategoryDragLeave = useCallback(() => {
    cancelAutoExpand();
  }, [cancelAutoExpand]);
  const handleCategoryDrop = useCallback(async (e: React.DragEvent, targetCatId: string) => {
    e.preventDefault();
    cancelAutoExpand();
    // Branch 1: reorder categories.
    if (dragCategoryId && onReorderCategories && reorderServerId) {
      const targetIdx = categories.findIndex(c => c.id === targetCatId);
      if (targetIdx === -1) { clearDrag(); return; }
      const before = dropTarget?.kind === 'category' && dropTarget.id === targetCatId ? dropTarget.before : true;
      const updates = computeCategoryMove({
        categories,
        draggedId: dragCategoryId,
        targetIndex: before ? targetIdx : targetIdx + 1,
      });
      clearDrag();
      if (!updates) return;
      try { await onReorderCategories(reorderServerId, updates); } catch { /* */ }
      return;
    }
    // Branch 2: drop a channel into this category at start.
    if (dragChannelId && onReorderChannels && reorderServerId) {
      const updates = computeChannelMove({
        channels,
        draggedId: dragChannelId,
        targetCategoryId: targetCatId,
        targetIndex: 0,
      });
      clearDrag();
      if (!updates) return;
      try { await onReorderChannels(reorderServerId, updates); } catch { /* */ }
      return;
    }
    clearDrag();
  }, [dragCategoryId, dragChannelId, dropTarget, categories, channels, onReorderChannels, onReorderCategories, reorderServerId, clearDrag, cancelAutoExpand]);

  const [collapsed, setCollapsed] = useState<Set<string>>(() => loadCollapsed(serverId));
  const channelMentionCounts = useNotificationStore(s => s.channelMentionCounts);
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);
  // Mute/deafen state for the user's currently-connected voice channel.
  // Side-panel participant payloads from `server-voice-participants` events
  // don't carry mute state — only `voice-state-update` events do, and those
  // are processed only for the connected channel via useCallSession. So the
  // overlay only renders for users in the same channel as the local user;
  // for participants in other voice channels the avatar stays plain.
  const connectedVoiceParticipants = useVoiceStore(s => s.voiceChannelParticipants);
  const muteByUserId = useMemo(() => {
    const m = new Map<string, { isMuted?: boolean; isDeafened?: boolean; serverMuted?: boolean; serverDeafened?: boolean }>();
    for (const p of connectedVoiceParticipants) {
      m.set(p.userId, {
        isMuted: p.isMuted,
        isDeafened: p.isDeafened,
        serverMuted: p.serverMuted,
        serverDeafened: p.serverDeafened,
      });
    }
    return m;
  }, [connectedVoiceParticipants]);

  // Single context-menu slot — either channel or category at any time. Right-
  // clicking elsewhere opens a new menu and replaces the previous; clicking
  // the backdrop closes it; Escape also closes.
  const [ctx, setCtx] = useState<ContextMenuState>(null);
  // Track muted state via tick: isChannelMuted() reads localStorage, which
  // doesn't itself trigger re-renders. The mute toggle bumps this counter so
  // the open menu re-renders with the new label.
  const [, setMuteTick] = useState(0);
  // Position of the mute-duration / notification-level submenus, anchored to
  // the right edge of the trigger. Null when closed. Mute and notif are
  // mutually exclusive — opening one closes the other.
  const [muteSubmenu, setMuteSubmenu] = useState<{ left: number; top: number } | null>(null);
  const [notifSubmenu, setNotifSubmenu] = useState<{ left: number; top: number } | null>(null);
  const muteCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const muteTriggerRef = useRef<HTMLButtonElement>(null);
  const notifTriggerRef = useRef<HTMLButtonElement>(null);
  const muteSubmenuRef = useRef<HTMLDivElement>(null);
  const notifSubmenuRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const currentUserId = useAuthStore((s) => s.currentUser?.id);
  useEffect(() => {
    if (!ctx) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setCtx(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [ctx]);

  // Always close any open submenu when the parent context menu disappears
  // — otherwise the submenu would orphan in mid-air.
  useEffect(() => {
    if (!ctx) {
      setMuteSubmenu(null);
      setNotifSubmenu(null);
      if (muteCloseTimerRef.current) {
        clearTimeout(muteCloseTimerRef.current);
        muteCloseTimerRef.current = null;
      }
      if (notifCloseTimerRef.current) {
        clearTimeout(notifCloseTimerRef.current);
        notifCloseTimerRef.current = null;
      }
    }
  }, [ctx]);

  const groups = useMemo(() => {
    const sortedCats = [...categories].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    const byCategory = new Map<string | null, Channel[]>();
    for (const c of channels) {
      const key = c.categoryId ?? null;
      const arr = byCategory.get(key) ?? [];
      arr.push(c);
      byCategory.set(key, arr);
    }
    for (const arr of byCategory.values()) {
      arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
    return {
      uncategorized: byCategory.get(null) ?? [],
      categorized: sortedCats.map(cat => ({ cat, items: byCategory.get(cat.id) ?? [] })),
    };
  }, [channels, categories]);

  const toggleCollapse = useCallback((catId: string) => {
    setCollapsed(prev => {
      const next = new Set(prev);
      if (next.has(catId)) next.delete(catId);
      else next.add(catId);
      saveCollapsed(serverId, next);
      return next;
    });
  }, [serverId]);

  const renderChannel = useCallback((c: Channel, chIdx: number) => {
    const isActive = c.id === activeChannelId;
    const Icon = channelIcon(c.type);
    const isVoice = c.type === 'voice';
    const isStage = c.type === 'stage';
    const isConnectedVoice = isVoice && connectedVoiceChannelId === c.id;
    const participants = isVoice ? (voiceParticipantsByChannel?.[c.id] ?? []) : [];
    const isPinned = pinnedChannelIds?.includes(c.id) ?? false;
    const muted = isChannelMuted(c.id);
    const mentionCount = muted ? 0 : (channelMentionCounts[c.id] ?? 0);
    const hasUnread = !muted && channelUnreadIds.has(c.id);
    // Drag-state derived flags. Insertion line shows above/below the
    // button only — the participants/threads rendered below the button
    // are visual children of the channel and stay in flow.
    const isDraggingThis = dragChannelId === c.id;
    const showLineBefore = dropTarget?.kind === 'channel' && dropTarget.id === c.id && dropTarget.before;
    const showLineAfter = dropTarget?.kind === 'channel' && dropTarget.id === c.id && !dropTarget.before;
    const handleClick = () => {
      // Voice/stage clicks: join the call AND navigate to the channel view so
      // the voice/stage UI appears in the chat area (matches Default mode).
      // Clicking a text channel while connected leaves voice/stage running but
      // switches the view; clicking the same voice channel again re-shows it.
      if (isVoice && onJoinVoiceChannel) onJoinVoiceChannel(c.id);
      else if (isStage && onJoinStage) onJoinStage(c.id);
      onSelectChannel(c.id);
    };
    return (
      <React.Fragment key={c.id}>
        <div className="relative">
          {showLineBefore && (
            <div className="absolute left-1 right-1 -top-px h-0.5 rounded-full pointer-events-none z-10" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
          )}
          <button
            type="button"
            data-channel-name={c.name}
            draggable={dragEnabled}
            onDragStart={dragEnabled ? (e) => handleChannelDragStart(e, c.id) : undefined}
            onDragOver={dragEnabled ? (e) => handleChannelDragOver(e, c.id) : undefined}
            onDrop={dragEnabled ? (e) => handleChannelDrop(e, c, chIdx) : undefined}
            onDragEnd={dragEnabled ? clearDrag : undefined}
            onClick={handleClick}
            onContextMenu={(e) => { e.preventDefault(); setCtx({ kind: 'channel', channel: c, x: e.clientX, y: e.clientY }); }}
            className={`w-full flex items-center gap-1.5 px-2 py-1 rounded-md transition-all text-left ${
              isActive
                ? 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)]'
                : (mentionCount > 0 || hasUnread)
                  ? 'hover:bg-fill-hover text-t-primary'
                  : 'hover:bg-fill-hover text-t-secondary hover:text-t-primary'
            }`}
            style={{ fontWeight: (mentionCount > 0 || hasUnread) ? 600 : 400, opacity: isDraggingThis ? 0.4 : (muted && !isActive ? 0.5 : 1) }}
          >
          <Icon size={14} className="shrink-0 opacity-70" />
          <span className="truncate text-sm flex-1 min-w-0">{c.name}</span>
          {isConnectedVoice && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0"
              style={{ boxShadow: '0 0 4px rgba(52,211,153,0.5)' }}
              aria-label="Connected"
            />
          )}
          {mentionCount > 0 ? (
            <span className="min-w-[16px] h-[16px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0 shadow-[0_0_6px_rgba(239,68,68,0.3)]">
              {mentionCount > 99 ? '99+' : mentionCount}
            </span>
          ) : hasUnread ? (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)] shrink-0 shadow-[0_0_4px_var(--text-primary)]" aria-label="Unread" />
          ) : null}
          {isPinned && !mentionCount && !hasUnread && (
            <span className="w-1.5 h-1.5 rounded-full bg-[var(--cyan-accent)]/50 shrink-0" aria-label="Pinned" />
          )}
          </button>
          {showLineAfter && (
            <div className="absolute left-1 right-1 -bottom-px h-0.5 rounded-full pointer-events-none z-10" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
          )}
        </div>
        {isVoice && participants.length > 0 && (
          // Sized to match Discord's voice-channel sublist: avatar 24px,
          // name text-xs (12px), with enough vertical padding that
          // mute/deafen overlay icons read clearly without crowding the
          // row. Indent (ml-6) aligns the avatar's left edge under the
          // channel name's text content above.
          <div className="ml-6 flex flex-col gap-0.5 mt-1 mb-1.5">
            {participants.map(p => {
              // Mute/deafen state is only known for users in the channel the
              // local user is connected to — the side-panel feed for other
              // channels doesn't carry it. Lookup is keyed by userId so it
              // works regardless of which channel the participant is in.
              const ms = muteByUserId.get(p.id);
              const muted = ms ? hasMuteState(ms) : false;
              // Pro-tier cosmetics: avatar effect ring + custom name styling.
              // `effectivePlan` reflects active subscription (admin grants
              // included); fall back to stripePlan if the side-panel feed
              // didn't populate effectivePlan for this user.
              const isPro = (p.effectivePlan ?? p.stripePlan) === 'pro';
              return (
                <button
                  type="button"
                  key={p.id}
                  onClick={(e) => onUserClick?.(p as unknown as UserWithRole, e)}
                  onContextMenu={(e) => { e.preventDefault(); onUserRightClick?.(p as unknown as UserWithRole, e); }}
                  className="flex items-center gap-2 px-2 py-1 rounded-md hover:bg-fill-hover transition-colors text-left"
                >
                  <div className={`relative shrink-0 rounded-full overflow-visible ${isPro ? getAvatarEffectClass(p.avatarEffect) : ''}`} style={{ width: 24, height: 24 }}>
                    <LetterAvatar avatar={p.avatar ?? null} username={p.username} size={24} className={`rounded-full ${muted ? 'opacity-60' : ''}`} />
                    {ms && (
                      <VoiceMuteOverlay
                        isMuted={ms.isMuted}
                        isDeafened={ms.isDeafened}
                        serverMuted={ms.serverMuted}
                        serverDeafened={ms.serverDeafened}
                        size={12}
                      />
                    )}
                  </div>
                  <span className="truncate min-w-0 flex-1">
                    <RoleNameStyle
                      name={p.username}
                      color={p.roleColor ?? 'var(--text-secondary)'}
                      style={(p.roleStyle as 'solid' | 'gradient' | 'holographic') ?? 'solid'}
                      className="text-xs truncate"
                      overrideFont={isPro ? p.nameFont : undefined}
                      nameEffect={isPro ? p.nameEffect : undefined}
                      overrideColor={isPro ? p.nameColor : undefined}
                    />
                  </span>
                </button>
              );
            })}
          </div>
        )}
        {/* Threads under this channel — capped at 5 to match the regular
            sidebar. Active thread highlighted, unread threads bolded. */}
        {(() => {
          const threads = (channelThreads?.[c.id] ?? []).slice(0, 5);
          if (threads.length === 0) return null;
          return (
            <div className="flex flex-col gap-0.5 mt-0.5 mb-1">
              {threads.map((t) => {
                const isThreadActive = activeThreadId === t.id;
                const threadUnread = !!unreadThreadIds?.has(t.id);
                const threadMentions = unreadThreadCounts?.[t.id] ?? 0;
                return (
                  <button
                    type="button"
                    key={t.id}
                    onClick={() => onThreadSelect?.(t)}
                    className={`flex items-center gap-1.5 pl-7 pr-2 py-0.5 rounded-md transition-colors text-left ${
                      isThreadActive ? 'bg-fill-active text-t-primary' : 'hover:bg-fill-hover text-t-secondary hover:text-t-primary'
                    }`}
                    style={{ fontWeight: (threadUnread || threadMentions > 0) ? 600 : 400 }}
                  >
                    <MessageCirclePlus size={10} className="shrink-0 opacity-60" />
                    <span className="truncate text-xs flex-1 min-w-0">{t.name}</span>
                    {threadMentions > 0 && (
                      <span className="min-w-[14px] h-[14px] rounded-full bg-red-500 text-white text-[8px] font-black px-1 flex items-center justify-center shrink-0">
                        {threadMentions > 99 ? '99+' : threadMentions}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          );
        })()}
      </React.Fragment>
    );
  }, [activeChannelId, onSelectChannel, onJoinVoiceChannel, onJoinStage, connectedVoiceChannelId, voiceParticipantsByChannel, pinnedChannelIds, onUserClick, onUserRightClick, channelMentionCounts, channelUnreadIds, channelThreads, activeThreadId, onThreadSelect, unreadThreadIds, unreadThreadCounts, muteByUserId, dragEnabled, dragChannelId, dropTarget, handleChannelDragStart, handleChannelDragOver, handleChannelDrop, clearDrag]);

  // Compute the active context-menu items (memoized at render time — small list).
  const renderContextMenu = () => {
    if (!ctx) return null;
    const items: React.ReactNode[] = [];
    if (ctx.kind === 'channel') {
      const c = ctx.channel;
      const muted = isChannelMuted(c.id);
      if (onMarkChannelRead && (channelUnreadIds.has(c.id) || (channelMentionCounts[c.id] ?? 0) > 0)) {
        items.push(
          <MenuItem key="mark-read" icon={Check} label="Mark as read" onClick={() => { onMarkChannelRead(c.id); setCtx(null); }} />,
        );
      }
      if (muted) {
        items.push(
          <MenuItem
            key="mute"
            icon={Bell}
            label="Unmute Channel"
            onClick={() => {
              unmuteChannel(c.id);
              setMuteTick((t) => t + 1);
              setCtx(null);
            }}
          />,
        );
      } else {
        // Hover-or-click trigger that opens a side submenu with duration
        // options. Mirrors the default layout (ChannelList.tsx) so the
        // two sidebars feel like one feature.
        const openSubmenu = () => {
          const el = muteTriggerRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          // Anchor to the right edge of the trigger; clamp to viewport so
          // the submenu doesn't disappear off-screen on a narrow window.
          const submenuWidth = 220;
          const submenuHeight = CLASSIC_MUTE_OPTIONS.length * 36 + 16;
          const vw = typeof window !== 'undefined' ? window.innerWidth : 9999;
          const vh = typeof window !== 'undefined' ? window.innerHeight : 9999;
          const left = rect.right + 4 + submenuWidth > vw ? rect.left - submenuWidth - 4 : rect.right + 4;
          const top = Math.min(rect.top, vh - submenuHeight - 8);
          setMuteSubmenu({ left, top });
          setNotifSubmenu(null);
        };
        items.push(
          <button
            key="mute"
            ref={muteTriggerRef}
            type="button"
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
            onClick={() => {
              if (muteSubmenu) setMuteSubmenu(null);
              else openSubmenu();
            }}
            onMouseEnter={() => {
              if (muteCloseTimerRef.current) {
                clearTimeout(muteCloseTimerRef.current);
                muteCloseTimerRef.current = null;
              }
              openSubmenu();
            }}
            onMouseLeave={() => {
              if (muteCloseTimerRef.current) clearTimeout(muteCloseTimerRef.current);
              muteCloseTimerRef.current = setTimeout(() => setMuteSubmenu(null), 150);
            }}
          >
            <span className="flex items-center gap-2">
              <BellOff size={14} className="shrink-0" />
              <span className="flex-1 truncate">Mute Channel</span>
            </span>
            <ChevronRight size={14} className="shrink-0 opacity-60" />
          </button>,
        );
      }
      // Notification Settings — text/forum only. Voice & stage channels
      // don't surface text-style notifications, so we skip them. Matches
      // the default layout's `isText` gate in ChannelList.tsx.
      const isTextLike = c.type === 'text' || c.type === 'forum';
      if (isTextLike) {
        const openNotifSubmenu = () => {
          const el = notifTriggerRef.current;
          if (!el) return;
          const rect = el.getBoundingClientRect();
          const submenuWidth = 220;
          const submenuHeight = CLASSIC_NOTIF_LEVELS.length * 36 + 16;
          const vw = typeof window !== 'undefined' ? window.innerWidth : 9999;
          const vh = typeof window !== 'undefined' ? window.innerHeight : 9999;
          const left = rect.right + 4 + submenuWidth > vw ? rect.left - submenuWidth - 4 : rect.right + 4;
          const top = Math.min(rect.top, vh - submenuHeight - 8);
          setNotifSubmenu({ left, top });
          setMuteSubmenu(null);
        };
        items.push(
          <button
            key="notif"
            ref={notifTriggerRef}
            type="button"
            className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
            onClick={() => {
              if (notifSubmenu) setNotifSubmenu(null);
              else openNotifSubmenu();
            }}
            onMouseEnter={() => {
              if (notifCloseTimerRef.current) {
                clearTimeout(notifCloseTimerRef.current);
                notifCloseTimerRef.current = null;
              }
              openNotifSubmenu();
            }}
            onMouseLeave={() => {
              if (notifCloseTimerRef.current) clearTimeout(notifCloseTimerRef.current);
              notifCloseTimerRef.current = setTimeout(() => setNotifSubmenu(null), 150);
            }}
          >
            <span className="flex items-center gap-2">
              <Bell size={14} className="shrink-0" />
              <span className="flex-1 truncate">Notification Settings</span>
            </span>
            <ChevronRight size={14} className="shrink-0 opacity-60" />
          </button>,
        );
      }
      // Copy Channel Link — clipboard write of the canonical web URL. We use
      // getWebOrigin() so Electron (whose location.origin is howl-app://app)
      // still produces a shareable https://app.howlpro.com link.
      if (serverId) {
        items.push(
          <MenuItem
            key="copy-link"
            icon={Link2}
            label="Copy Channel Link"
            onClick={() => {
              const url = `${getWebOrigin()}/channels/${serverId}/${c.id}`;
              navigator.clipboard?.writeText(url).catch(() => { /* clipboard blocked */ });
              setCtx(null);
            }}
          />,
        );
      }
      if (onOpenChannelSettings) {
        items.push(
          <MenuItem
            key="edit"
            icon={Settings}
            label="Edit Channel"
            onClick={() => { onOpenChannelSettings(c.id); setCtx(null); }}
          />,
        );
      }
      if (onRequestDeleteChannel) {
        items.push(<div key="div" className="h-px my-1 mx-2 bg-[var(--border-subtle)]" />);
        items.push(
          <MenuItem
            key="delete"
            icon={Trash2}
            label="Delete Channel"
            danger
            onClick={() => { onRequestDeleteChannel(c); setCtx(null); }}
          />,
        );
      }
    } else if (ctx.kind === 'category') {
      const cat = ctx.category;
      if (onOpenCategorySettings) {
        items.push(
          <MenuItem
            key="edit-cat"
            icon={Settings}
            label="Edit Category"
            onClick={() => { onOpenCategorySettings(cat.id); setCtx(null); }}
          />,
        );
      }
      if (items.length === 0) {
        items.push(
          <div key="empty" className="px-3 py-2 text-xs text-t-secondary">
            No actions available
          </div>,
        );
      }
    }
    if (items.length === 0) return null;
    const channelIdForMute = ctx.kind === 'channel' ? ctx.channel.id : null;
    return createPortal(
      <>
        <div
          className="fixed inset-0 z-[var(--z-popover)]"
          onClick={() => setCtx(null)}
          onContextMenu={(e) => { e.preventDefault(); setCtx(null); }}
        />
        <div
          ref={menuRef}
          className={`fixed z-[var(--z-popover)] py-1.5 min-w-[180px] rounded-2xl border shadow-2xl ${GLASS_MENU_CLASS} glass`}
          style={{
            left: Math.min(ctx.x, (typeof window !== 'undefined' ? window.innerWidth : 9999) - 220),
            top: Math.min(ctx.y, (typeof window !== 'undefined' ? window.innerHeight : 9999) - (Math.max(items.length, 1) * 40 + 16)),
          }}
        >
          {items}
        </div>
        {muteSubmenu && channelIdForMute && (
          <div
            ref={muteSubmenuRef}
            className={`fixed z-[var(--z-popover)] py-1.5 min-w-[200px] rounded-2xl border shadow-2xl ${GLASS_MENU_CLASS} glass`}
            style={{ left: muteSubmenu.left, top: muteSubmenu.top }}
            onMouseEnter={() => {
              if (muteCloseTimerRef.current) {
                clearTimeout(muteCloseTimerRef.current);
                muteCloseTimerRef.current = null;
              }
            }}
            onMouseLeave={() => setMuteSubmenu(null)}
          >
            {CLASSIC_MUTE_OPTIONS.map(({ value, label }) => (
              <button
                key={value}
                type="button"
                onClick={() => {
                  setChannelMutedForDuration(channelIdForMute, value);
                  setMuteTick((t) => t + 1);
                  setMuteSubmenu(null);
                  setCtx(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
              >
                <span className="flex-1 truncate">{label}</span>
              </button>
            ))}
          </div>
        )}
        {notifSubmenu && channelIdForMute && (() => {
          // Pull the current level once so the row check mark matches what
          // localStorage holds at render time.
          const current = getChannelNotificationLevel(channelIdForMute, currentUserId);
          return (
            <div
              ref={notifSubmenuRef}
              className={`fixed z-[var(--z-popover)] py-1.5 min-w-[200px] rounded-2xl border shadow-2xl ${GLASS_MENU_CLASS} glass`}
              style={{ left: notifSubmenu.left, top: notifSubmenu.top }}
              onMouseEnter={() => {
                if (notifCloseTimerRef.current) {
                  clearTimeout(notifCloseTimerRef.current);
                  notifCloseTimerRef.current = null;
                }
              }}
              onMouseLeave={() => setNotifSubmenu(null)}
            >
              {CLASSIC_NOTIF_LEVELS.map(({ value, label }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setChannelNotificationLevel(channelIdForMute, value, currentUserId);
                    setNotifSubmenu(null);
                    setCtx(null);
                  }}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
                >
                  <span className="flex-1 truncate">{label}</span>
                  {current === value && <Check size={14} className="shrink-0 text-[var(--cyan-accent)]" />}
                </button>
              ))}
            </div>
          );
        })()}
      </>,
      document.body,
    );
  };

  return (
    <div className="flex flex-col gap-0.5 px-1.5 py-2 overflow-y-auto h-full">
      {groups.uncategorized.length > 0 && (
        <div className="flex flex-col gap-0.5">
          {groups.uncategorized.map((c, i) => renderChannel(c, i))}
        </div>
      )}
      {groups.categorized.map(({ cat, items }) => {
        const isCollapsed = collapsed.has(cat.id);
        const isDraggingThisCat = dragCategoryId === cat.id;
        const showCatLineBefore = dropTarget?.kind === 'category' && dropTarget.id === cat.id && dropTarget.before;
        const showCatLineAfter = dropTarget?.kind === 'category' && dropTarget.id === cat.id && !dropTarget.before;
        const showCatIntoRing = dropTarget?.kind === 'category-into' && dropTarget.id === cat.id;
        return (
          <div key={cat.id} className="mt-2 relative" style={{ opacity: isDraggingThisCat ? 0.4 : 1 }}>
            {showCatLineBefore && (
              <div className="absolute left-1 right-1 -top-1 h-0.5 rounded-full pointer-events-none z-10" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
            )}
            <div
              className={`flex items-center group/cat rounded-md transition-all ${showCatIntoRing ? 'ring-1 ring-[var(--cyan-accent)]/50' : ''}`}
              draggable={dragEnabled}
              onDragStart={dragEnabled ? (e) => handleCategoryDragStart(e, cat.id) : undefined}
              onDragOver={dragEnabled ? (e) => handleCategoryDragOver(e, cat.id, isCollapsed) : undefined}
              onDragLeave={dragEnabled ? handleCategoryDragLeave : undefined}
              onDrop={dragEnabled ? (e) => handleCategoryDrop(e, cat.id) : undefined}
              onDragEnd={dragEnabled ? clearDrag : undefined}
            >
              <button
                type="button"
                data-cat-label
                onClick={() => toggleCollapse(cat.id)}
                onContextMenu={(e) => { e.preventDefault(); setCtx({ kind: 'category', category: cat, x: e.clientX, y: e.clientY }); }}
                className="flex-1 min-w-0 flex items-center gap-1 px-1 py-0.5 text-[10px] font-bold uppercase tracking-wider text-t-secondary hover:text-t-primary transition-colors"
              >
                {isCollapsed ? <ChevronRight size={10} className="shrink-0" /> : <ChevronDown size={10} className="shrink-0" />}
                <span className="truncate">{cat.name}</span>
              </button>
              {canManageChannels && onCreateChannelInCategory && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onCreateChannelInCategory(cat.id, cat.name); }}
                  className="shrink-0 p-1 rounded-lg hover:bg-fill-hover text-t-quaternary hover:text-t-primary opacity-0 group-hover/cat:opacity-100 focus:opacity-100 transition-opacity"
                  aria-label={`Create channel in ${cat.name}`}
                  title={`Create channel in ${cat.name}`}
                >
                  <Plus size={12} />
                </button>
              )}
            </div>
            {!isCollapsed && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {items.map((c, i) => renderChannel(c, i))}
              </div>
            )}
            {showCatLineAfter && (
              <div className="absolute left-1 right-1 -bottom-1 h-0.5 rounded-full pointer-events-none z-10" style={{ backgroundColor: 'var(--cyan-accent)', boxShadow: '0 0 6px var(--cyan-accent)' }} />
            )}
          </div>
        );
      })}
      {renderContextMenu()}
    </div>
  );
});

interface MenuItemProps {
  icon: React.ComponentType<{ size?: number; className?: string }>;
  label: string;
  onClick: () => void;
  danger?: boolean;
}

function MenuItem({ icon: Icon, label, onClick, danger }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors ${danger ? 'text-red-400' : 'text-t-primary'}`}
    >
      <Icon size={14} className="shrink-0" />
      <span className="flex-1 truncate">{label}</span>
    </button>
  );
}
