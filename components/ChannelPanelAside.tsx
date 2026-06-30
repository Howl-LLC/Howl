// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useCallback, useRef, useMemo, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { PanelView, loadPanelLayout, savePanelLayout, PanelTextContent, PanelPinnedContent, PanelVoiceContent } from './ChatPanelViews';
import type { Channel, ChannelCategory, Server, ServerNotification, Thread } from '../types';
import { Activity, Volume2, X, ChevronDown, ChevronUp, ChevronLeft, Hash, Bell, BellOff, Check, Pin, Settings, Trash2 } from 'lucide-react';
import { GLASS_DROPDOWN_STYLE, GLASS_MENU_CLASS } from '../utils/contextMenuStyles';
import { useIsMobile } from '../hooks/useIsMobile';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { powerUpTier } from '../utils/powerUpTier';
import { isValidCssColor } from '../utils/securityUtils';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { useSettings } from '../contexts/SettingsContext';
import { useVoiceStore } from '../stores/voiceStore';
import { useAppStore } from '../stores/appStore';
import { useUiStore } from '../stores/uiStore';
import { useMessageStore } from '../stores/messageStore';
import { useNotificationStore } from '../stores/notificationStore';
import type { UserWithRole } from './UserProfilePopup';
import { ClassicChannelTree } from './server/ClassicChannelTree';
import { ServerIcon } from './ServerIcon';
import { isChannelMuted, setChannelMutedForDuration, unmuteChannel } from '../utils/mutedChannelStorage';
import { getPinnedForServer, setPinnedForServer, getPinnedCategoriesForServer, setPinnedCategoriesForServer } from './ChannelList';

const ACTIVITY_COLUMN_MIN_WIDTH = 180;
const ACTIVITY_COLUMN_MAX_WIDTH = 500;
const ACTIVITY_COLUMN_DEFAULT_WIDTH = 240;
const ACTIVITY_VOICE_SPLIT_MIN = 0.15;
const ACTIVITY_VOICE_SPLIT_MAX = 0.85;
const RESIZE_HANDLE_SPLIT_HEIGHT = 6;

export interface ChannelPanelAsideProps {
  // Channel data
  channels: Channel[];
  categories: ChannelCategory[];
  activeChannelId?: string;
  onSelectChannel?: (id: string) => void;

  // Voice
  connectedVoiceChannel?: { id: string; name: string; type: string } | null;
  connectedVoiceServerName?: string | null;
  voiceChannelParticipants?: Array<{
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string | null;
    nameColor?: string;
    nameFont?: string;
    nameEffect?: string;
    avatarEffect?: string;
    effectivePlan?: string;
    roleColor?: string;
    roleStyle?: string;
    // Mute/deafen state — surfaced on the avatar in the side panel.
    isMuted?: boolean;
    isDeafened?: boolean;
    serverMuted?: boolean;
    serverDeafened?: boolean;
  }>;
  onLeaveVoiceChannel?: () => void;
  onSwitchVoiceChannel?: (channelId: string) => void;
  /** @deprecated Read from voiceStore directly inside the component */
  allVoiceParticipants?: Record<string, Array<{ id: string; username: string; discriminator?: string; avatar?: string }>>;
  servers?: Server[];

  // Pinned
  pinnedChannelIds?: string[];
  pinnedCategoryIds?: string[];

  // Activity/Notifications
  serverNotifications?: ServerNotification[];
  onDismissNotification?: (id: string) => void;
  onClearAllNotifications?: () => void;

  // Threads
  channelThreads?: Record<string, Thread[]>;
  activeThreadId?: string | null;
  onThreadSelect?: (thread: Thread) => void;
  unreadThreadIds?: Set<string>;
  unreadThreadCounts?: Record<string, number>;

  // Settings
  onOpenChannelSettings?: (channelId: string) => void;
  /** Classic-mode category right-click → "Edit Category" menu item.
   *  When omitted, the menu item is hidden. */
  onOpenCategorySettings?: (categoryId: string) => void;
  /** Classic-mode channel right-click → "Mark as Read" menu item. */
  onMarkChannelRead?: (channelId: string) => void;
  /** Classic-mode channel right-click → "Delete Channel" menu item.
   *  Should typically open a confirmation modal rather than deleting
   *  immediately. */
  onRequestDeleteChannel?: (channel: Channel) => void;
  /** Classic-mode: shows a "+" next to each category header. */
  canManageChannels?: boolean;
  /** Classic-mode: invoked by the "+" button to open the create-channel
   *  modal pre-filled with the given category. */
  onCreateChannelInCategory?: (categoryId: string, categoryName: string) => void;
  /** Classic-mode: reorder channels (cross-category aware). Wired to the
   *  same API as Server Settings → Channels & Categories so a drag in
   *  either view broadcasts the same `channels-reordered` socket event. */
  onReorderChannels?: (serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>) => Promise<void>;
  /** Classic-mode: reorder categories. */
  onReorderCategories?: (serverId: string, categories: Array<{ id: string; position: number }>) => Promise<void>;

  // Active server
  activeServerId?: string;

  // User interaction
  onUserClick?: (user: UserWithRole, e: React.MouseEvent) => void;
  onUserRightClick?: (user: UserWithRole, e: React.MouseEvent) => void;

  // Channel header info (rendered in server sub-header above the panel)
  channelName?: string;
  channelDescription?: string | null;
  channelType?: string;
  onTextChannelHeaderClick?: () => void;

  // Server banner
  serverBanner?: string | null;
  serverPowerUpCount?: number;

  // Current user
  currentUserId?: string;
}

const ChannelPanelAside = memo(function ChannelPanelAside(props: ChannelPanelAsideProps) {
  const {
    channels = [],
    categories = [],
    activeChannelId,
    onSelectChannel,
    connectedVoiceChannel = null,
    connectedVoiceServerName = null,
    voiceChannelParticipants = [],
    onLeaveVoiceChannel,
    onSwitchVoiceChannel,
    allVoiceParticipants: _allVoiceParticipantsProp = {},
    servers = [],
    pinnedChannelIds = [],
    pinnedCategoryIds = [],
    serverNotifications = [],
    onDismissNotification,
    onClearAllNotifications,
    channelThreads = {},
    activeThreadId,
    onThreadSelect,
    unreadThreadIds,
    unreadThreadCounts = {},
    onOpenChannelSettings,
    onOpenCategorySettings,
    onMarkChannelRead,
    onRequestDeleteChannel,
    canManageChannels,
    onCreateChannelInCategory,
    onReorderChannels,
    onReorderCategories,
    activeServerId,
    onUserClick,
    onUserRightClick,
    channelName,
    channelDescription: _channelDescription,
    onTextChannelHeaderClick,
    serverBanner,
    serverPowerUpCount = 0,
    currentUserId,
    channelType,
  } = props;

  const allVoiceParticipants = useVoiceStore(s => s.allVoiceChannelParticipants);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const { uiDensity, serverLayout } = useSettings();
  const d = uiDensity;
  const statusBarDocked = useAppStore(s => s.floatingBarDocked);
  // Drives chevron rotation in the Classic-mode server header row.
  const serverMenuOpen = useUiStore(s => !!s.serverMenuOpenAnchor);

  const activityPanelPadding = d === 'compact' ? 'pl-3 pr-1 pt-1 pb-3' : d === 'spacious' ? 'pl-5 pr-2 pt-2 pb-5' : 'pl-4 pr-1 pt-1.5 pb-4';
  const activityHeaderPy = d === 'compact' ? 'py-1.5' : d === 'spacious' ? 'py-2.5' : 'py-2';
  const activityListP = d === 'compact' ? 'p-1.5' : d === 'spacious' ? 'p-3' : 'p-2';
  const activityItemSpace = d === 'compact' ? 'space-y-1' : d === 'spacious' ? 'space-y-2' : 'space-y-1.5';
  const activityItemPy = d === 'compact' ? 'py-1.5' : d === 'spacious' ? 'py-2.5' : 'py-2';
  const _headerGap = d === 'compact' ? 'gap-2' : d === 'spacious' ? 'gap-3' : 'gap-2.5';

  const [voiceSwitcherOpen, setVoiceSwitcherOpen] = useState(false);
  const [switcherServerId, setSwitcherServerId] = useState<string | null>(null);
  const voiceSwitcherRef = useRef<HTMLDivElement>(null);
  const voiceSwitcherTriggerRef = useRef<HTMLDivElement>(null);

  const [activityColumnWidth, setActivityColumnWidth] = useState(ACTIVITY_COLUMN_DEFAULT_WIDTH);
  const [activityVoiceSplit, setActivityVoiceSplit] = useState(0.5);
  const [topView, setTopViewRaw] = useState<PanelView>(() => loadPanelLayout().top);
  const [bottomView, setBottomViewRaw] = useState<PanelView>(() => loadPanelLayout().bottom);
  const topViewRef = useRef(topView);
  topViewRef.current = topView;
  const bottomViewRef = useRef(bottomView);
  bottomViewRef.current = bottomView;
  const setTopView = useCallback((v: PanelView) => { setTopViewRaw(v); savePanelLayout(v, bottomViewRef.current); }, []);
  const setBottomView = useCallback((v: PanelView) => { setBottomViewRaw(v); savePanelLayout(topViewRef.current, v); }, []);
  const [topCollapsed, setTopCollapsed] = useState(false);
  const [bottomCollapsed, setBottomCollapsed] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState<'top' | 'bottom' | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Context menu (right-click) for channel/category rows in the Text and
  // Pinned views. Mirrors the menu used by ClassicChannelTree in the
  // default-layout main column so right-click gives a menu instead of
  // jumping straight into the settings modal.
  type CtxState =
    | { kind: 'channel'; channel: Channel; x: number; y: number }
    | { kind: 'category'; category: ChannelCategory; x: number; y: number }
    | null;
  const [ctx, setCtx] = useState<CtxState>(null);
  // isChannelMuted reads localStorage; bumping this state forces a re-render
  // when the menu toggles mute, so the muted-row dimming updates immediately
  // instead of waiting for the next unrelated render. Value itself is
  // unused; the setter call is what matters.
  const [, setMuteTick] = useState(0);
  const channelMentionCounts = useNotificationStore(s => s.channelMentionCounts);
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);
  const ctxMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ctx) return;
    const handler = (e: MouseEvent) => {
      if (ctxMenuRef.current && !ctxMenuRef.current.contains(e.target as Node)) setCtx(null);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [ctx]);

  const openChannelCtx = useCallback((ch: Channel, e: React.MouseEvent) => {
    setCtx({ kind: 'channel', channel: ch, x: e.clientX, y: e.clientY });
  }, []);
  const openCategoryCtx = useCallback((cat: ChannelCategory, e: React.MouseEvent) => {
    setCtx({ kind: 'category', category: cat, x: e.clientX, y: e.clientY });
  }, []);

  const togglePinChannel = useCallback((channelId: string) => {
    if (!activeServerId) return;
    const current = getPinnedForServer(activeServerId);
    const next = current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId];
    setPinnedForServer(activeServerId, next);
    // Bump the same revision counters ChannelList uses (one in messageStore
    // for pinned channels, one in appStore for pinned categories) so other
    // views — pinned bar, classic deck — re-read pinned state immediately.
    useMessageStore.getState().bumpPinnedRevision();
  }, [activeServerId]);

  const togglePinCategory = useCallback((categoryId: string) => {
    if (!activeServerId) return;
    const current = getPinnedCategoriesForServer(activeServerId);
    const next = current.includes(categoryId) ? current.filter((id) => id !== categoryId) : [...current, categoryId];
    setPinnedCategoriesForServer(activeServerId, next);
    useAppStore.getState().bumpPinnedCatRevision();
  }, [activeServerId]);

  // Aliases for backward-compat with existing collapse logic
  const activityCollapsed = topCollapsed;
  const setActivityCollapsed = setTopCollapsed;
  const voiceCollapsed = bottomCollapsed;
  const setVoiceCollapsed = setBottomCollapsed;

  // Close panel-view dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  // Resolve channels for the active server (used by Text / Pinned views)
  const activeServerChannels = useMemo(() => {
    if (channels.length > 0) return channels;
    if (!activeServerId) return [];
    const server = servers.find((s) => s.id === activeServerId);
    return server?.channels ?? [];
  }, [channels, activeServerId, servers]);

  const activeServerCategories = useMemo(() => {
    if (categories.length > 0) return categories;
    if (!activeServerId) return [];
    const server = servers.find((s) => s.id === activeServerId);
    return server?.categories ?? [];
  }, [categories, activeServerId, servers]);

  const activeServer = useMemo(
    () => (activeServerId ? servers.find((s) => s.id === activeServerId) : undefined),
    [servers, activeServerId],
  );

  const [isDraggingSplit, setIsDraggingSplit] = useState(false);
  const [isDraggingWidth, setIsDraggingWidth] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const lastPointerRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    if (!voiceSwitcherOpen) {
      setSwitcherServerId(null);
      return;
    }
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = voiceSwitcherTriggerRef.current?.contains(target);
      const inPortal = document.getElementById('voice-switcher-portal')?.contains(target);
      if (!inTrigger && !inPortal) {
        setVoiceSwitcherOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [voiceSwitcherOpen]);

  useEffect(() => {
    if (!isDraggingSplit && !isDraggingWidth) return;
    const onMove = (e: MouseEvent) => {
      if (isDraggingSplit && asideRef.current) {
        const deltaY = e.clientY - lastPointerRef.current.y;
        lastPointerRef.current.y = e.clientY;
        const h = asideRef.current.clientHeight;
        if (h > 0) {
          setActivityVoiceSplit((f) => Math.max(ACTIVITY_VOICE_SPLIT_MIN, Math.min(ACTIVITY_VOICE_SPLIT_MAX, f + deltaY / h)));
        }
      }
      if (isDraggingWidth) {
        const deltaX = e.clientX - lastPointerRef.current.x;
        lastPointerRef.current.x = e.clientX;
        setActivityColumnWidth((w) => Math.max(ACTIVITY_COLUMN_MIN_WIDTH, Math.min(ACTIVITY_COLUMN_MAX_WIDTH, w + deltaX)));
      }
    };
    const onUp = () => {
      setIsDraggingSplit(false);
      setIsDraggingWidth(false);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
  }, [isDraggingSplit, isDraggingWidth]);

  useEffect(() => {
    if (isDraggingSplit || isDraggingWidth) {
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isDraggingSplit ? 'ns-resize' : 'col-resize';
    } else {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    }
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDraggingSplit, isDraggingWidth]);

  if (isMobile) return null;

  return (
    <div
      className="shrink-0 self-stretch flex flex-col relative overflow-hidden"
      style={{
        width: activityCollapsed && voiceCollapsed ? 14 : activityColumnWidth + 20,
        transition: 'width 0.25s ease-out',
        paddingBottom: statusBarDocked
          ? (d === 'compact' ? 78 : d === 'spacious' ? 92 : 85)
          : 4,
      }}
    >
      {/* Channel name sub-header — glass pill in paddingTop space.
          In Classic mode the pill is extended to also include the server icon
          + name + chevron above the channel name (one combined bubble).
          The standalone server banner above and the channel-tree aside below
          remain identical in both layouts. */}
      {channelName && !(activityCollapsed && voiceCollapsed) && (
        <div
          className="absolute top-0 left-0 z-20 pointer-events-auto"
          style={{
            paddingTop: d === 'compact' ? 10 : d === 'spacious' ? 18 : 14,
            paddingLeft: d === 'compact' ? 12 : d === 'spacious' ? 20 : 16,
            paddingRight: d === 'compact' ? 4 : d === 'spacious' ? 8 : 4,
            width: activityColumnWidth + 20,
            transition: 'width 0.25s ease-out',
          }}
        >
          <div
            className="rounded-2xl flex flex-col transition-colors duration-200 flex-1 min-w-0 overflow-hidden"
            style={{
              backgroundColor: 'var(--bg-chat)',
              backdropFilter: 'blur(24px) saturate(1.1)',
              WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
              border: '2px solid var(--border-subtle)',
              boxShadow: 'var(--shadow-lg)',
            } as React.CSSProperties}
          >
            {/* Classic-only server header row — clicking it toggles the same
                server menu the deck bar shows in Default, anchored to this
                row via useUiStore.serverMenuOpenAnchor. */}
            {serverLayout === 'classic' && activeServer && (
              <button
                type="button"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  const current = useUiStore.getState().serverMenuOpenAnchor;
                  if (current) {
                    useUiStore.getState().setServerMenuOpenAnchor(null);
                  } else {
                    const r = e.currentTarget.getBoundingClientRect();
                    useUiStore.getState().setServerMenuOpenAnchor({ left: r.left, bottom: r.bottom });
                  }
                }}
                className="w-full flex items-center gap-2 hover:bg-fill-hover transition-colors text-left border-b border-default"
                style={{
                  padding: d === 'compact' ? '5px 10px' : d === 'spacious' ? '8px 14px' : '6px 12px',
                }}
              >
                <div className="w-5 h-5 rounded-md overflow-hidden shrink-0">
                  <ServerIcon icon={activeServer.icon} name={activeServer.name} className="rounded-md" />
                </div>
                <span className="text-sm font-semibold tracking-tight truncate flex-1" style={{ color: 'var(--text-primary)' }}>
                  {activeServer.name}
                </span>
                <ChevronDown
                  size={12}
                  className={`transition-transform duration-150 ${serverMenuOpen ? 'rotate-180' : ''}`}
                  style={{ color: 'var(--text-secondary)' }}
                />
              </button>
            )}
            {/* Channel name row */}
            <div
              className={`flex items-center ${d === 'compact' ? 'gap-2' : d === 'spacious' ? 'gap-3' : 'gap-2.5'} min-w-0`}
              style={{
                padding: d === 'compact' ? '5px 10px' : d === 'spacious' ? '8px 14px' : '6px 12px',
              }}
            >
              <div className="w-4 h-4 rounded-lg flex items-center justify-center shrink-0" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)' }}>
                {channelType === 'voice' ? (
                  <Volume2 size={10} style={{ color: 'var(--cyan-accent)' }} />
                ) : (
                  <Hash size={10} style={{ color: 'var(--cyan-accent)' }} />
                )}
              </div>
              <div
                className={`flex items-center gap-2 min-w-0 flex-1 rounded-md transition-[background-color] duration-150 ${onTextChannelHeaderClick ? 'cursor-pointer hover:bg-fill-hover px-1.5 py-0.5 -mx-1.5 -my-0.5' : ''}`}
                onClick={onTextChannelHeaderClick}
                role={onTextChannelHeaderClick ? 'button' : undefined}
                tabIndex={onTextChannelHeaderClick ? 0 : undefined}
              >
                <span className="text-sm font-semibold tracking-tight capitalize truncate" style={{ color: 'var(--text-primary)' }}>
                  {channelName}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}
      <div
        className={`${activityPanelPadding} h-full flex flex-col shrink-0`}
        style={{
          opacity: activityCollapsed && voiceCollapsed ? 0 : 1,
          pointerEvents: activityCollapsed && voiceCollapsed ? 'none' : 'auto',
          transition: 'opacity 0.2s ease-out',
          width: activityColumnWidth + 20,
          // The floating pill above us is taller in Classic (extra server row),
          // so reserve more paddingTop to keep the aside from sliding under it.
          paddingTop: serverLayout === 'classic'
            ? (d === 'compact' ? 84 : d === 'spacious' ? 100 : 92)
            : (d === 'compact' ? 54 : d === 'spacious' ? 66 : 60),
        }}
      >
      {/* Server banner strip -- floats above the activity panel in BOTH
          layouts. */}
      {(() => {
        if (!serverBanner) return null;
        const bannerIsColor = isValidCssColor(serverBanner);
        return (
          <div
            className="relative w-full overflow-hidden rounded-2xl shrink-0 mb-3"
            style={{
              width: activityColumnWidth,
              minWidth: ACTIVITY_COLUMN_MIN_WIDTH,
              maxWidth: ACTIVITY_COLUMN_MAX_WIDTH,
              height: 180,
              border: '1px solid var(--border-subtle)',
              ...(bannerIsColor ? { backgroundColor: serverBanner } : { backgroundColor: '#0a0f1a' }),
            }}
          >
            {!bannerIsColor && <LazyGif src={sanitizeImgSrc(serverBanner)} frameSrc={getFrameUrl(serverBanner)} forceStatic={!!serverBanner.match(/\.gif(\?|$)/i) && powerUpTier(serverPowerUpCount) < 3} alt="" className="absolute inset-0 w-full h-full object-cover" draggable={false} />}
          </div>
        );
      })()}
      <aside
        ref={asideRef}
        data-notification-strip
        className="flex flex-col overflow-hidden relative rounded-2xl flex-1 min-h-0 max-h-full group/aside"
        style={{
          width: activityColumnWidth,
          minWidth: ACTIVITY_COLUMN_MIN_WIDTH,
          maxWidth: ACTIVITY_COLUMN_MAX_WIDTH,
          backgroundColor: 'var(--bg-chat)',
          backdropFilter: 'blur(24px) saturate(1.1)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
          boxShadow: 'var(--shadow-lg)',
          border: '1px solid var(--border-subtle)',
        }}
      >
      {serverLayout === 'classic' ? (
        <>
          <div className="flex-1 min-h-0 overflow-hidden">
            <ClassicChannelTree
              channels={activeServerChannels}
              categories={activeServerCategories}
              activeChannelId={activeChannelId}
              onSelectChannel={(id) => onSelectChannel?.(id)}
              onJoinVoiceChannel={onSwitchVoiceChannel}
              connectedVoiceChannelId={connectedVoiceChannel?.id ?? null}
              voiceParticipantsByChannel={allVoiceParticipants}
              pinnedChannelIds={pinnedChannelIds}
              serverId={activeServerId}
              channelThreads={channelThreads}
              activeThreadId={activeThreadId}
              onThreadSelect={onThreadSelect}
              unreadThreadIds={unreadThreadIds}
              unreadThreadCounts={unreadThreadCounts}
              onUserClick={onUserClick}
              onUserRightClick={onUserRightClick}
              onOpenChannelSettings={onOpenChannelSettings}
              onOpenCategorySettings={onOpenCategorySettings}
              onMarkChannelRead={onMarkChannelRead}
              onRequestDeleteChannel={onRequestDeleteChannel}
              canManageChannels={canManageChannels}
              onCreateChannelInCategory={onCreateChannelInCategory}
              onReorderChannels={onReorderChannels}
              onReorderCategories={onReorderCategories}
              reorderServerId={activeServerId}
            />
          </div>
        </>
      ) : (<>
      {/* Top half: Activity (collapsible) -- grid-template-rows for smooth collapse */}
      <div
        className="flex flex-col min-h-0 shrink-0 border-default"
        style={{
          flex: activityCollapsed ? '0 0 auto' : (voiceCollapsed ? '1 1 0' : `0 0 ${activityVoiceSplit * 100}%`),
        }}
      >
        {/* Section header with dropdown */}
        <div className={`w-full px-3 ${activityHeaderPy} shrink-0 flex items-center justify-between gap-2 border-default`}>
          <div className="relative" ref={dropdownOpen === 'top' ? dropdownRef : undefined}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDropdownOpen((o) => o === 'top' ? null : 'top'); }}
              className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider hover:bg-fill-hover rounded-lg px-1.5 py-0.5 transition-colors text-t-secondary"
            >
              {topView === 'activity' ? t('chat.activity') : topView === 'voice' ? t('chat.voice') : topView === 'text' ? 'Text' : 'Pinned'}
              <ChevronDown size={11} className={`transition-transform duration-150 ${dropdownOpen === 'top' ? 'rotate-180' : ''}`} />
            </button>
            {dropdownOpen === 'top' && (
              <div className="absolute left-0 top-full mt-1 z-30 min-w-[120px] rounded-xl border py-1" style={{ ...GLASS_DROPDOWN_STYLE }}>
                {(['activity', 'voice', 'text', 'pinned'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setTopView(view); setDropdownOpen(null); if (topCollapsed) setTopCollapsed(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs font-medium transition-colors ${topView === view ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                    style={{ color: topView === view ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
                  >
                    {view === 'activity' ? t('chat.activity') : view === 'voice' ? t('chat.voice') : view === 'text' ? 'Text' : 'Pinned'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="flex items-center gap-1">
            {topView === 'activity' && serverNotifications.length > 0 && onClearAllNotifications && !topCollapsed && (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onClearAllNotifications(); }}
                className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1 rounded-lg hover:bg-fill-active transition-colors text-t-secondary"
              >
                {t('common.clearAll')}
              </button>
            )}
            <button type="button" onClick={() => setTopCollapsed((c) => !c)} className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary">
              {topCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </span>
        </div>
        {/* Collapsible content */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-out min-h-0"
          style={{ gridTemplateRows: topCollapsed ? '0fr' : '1fr' }}
        >
          <div className="min-h-0 overflow-hidden">
          <div className={`h-full min-h-0 overflow-y-auto ${activityListP}`}>
            {/* Activity view */}
            {topView === 'activity' && (
              serverNotifications.length > 0 ? (
                <ul className={activityItemSpace}>
                  {[...serverNotifications].reverse().map((n) => (
                    <li key={n.id}>
                      <div
                        className={`flex items-start gap-2 px-2.5 ${activityItemPy} rounded-lg text-sm border border-default text-t-primary`}
                        style={{
                          backgroundColor: 'var(--bg-chat)',
                        }}
                      >
                        <span className="shrink-0 mt-0.5">
                          {n.type === 'voice_join' || n.type === 'voice_leave' ? (
                            <Volume2 size={14} className="opacity-80" style={{ color: n.type === 'voice_join' ? '#34d399' : 'var(--text-secondary)' }} />
                          ) : (
                            <Activity size={14} className="opacity-80 text-t-accent" />
                          )}
                        </span>
                        <span className="flex-1 min-w-0 break-words">{n.message}</span>
                        {(n.count ?? 1) > 1 && (
                          <span className="text-[9px] font-bold tabular-nums px-1.5 py-0.5 rounded-md shrink-0 text-t-secondary" style={{ backgroundColor: 'var(--glass-border)' }}>
                            x{n.count}
                          </span>
                        )}
                        {onDismissNotification && (
                          <button
                            type="button"
                            onClick={() => onDismissNotification(n.id)}
                            className="p-0.5 rounded-lg shrink-0 hover:bg-fill-active transition-colors text-t-secondary"
                            aria-label={t('common.dismiss')}
                          >
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-2 py-4 text-sm text-t-secondary">
                  {t('chat.activityFromServer')}
                </p>
              )
            )}
            {/* Voice view (rendered in top section if selected) */}
            {topView === 'voice' && (
              <PanelVoiceContent
                connectedVoiceChannel={connectedVoiceChannel}
                connectedVoiceServerName={connectedVoiceServerName}
                voiceChannelParticipants={voiceChannelParticipants}
                onLeaveVoiceChannel={onLeaveVoiceChannel}
                onSwitchVoiceChannel={onSwitchVoiceChannel}
                voiceSwitcherOpen={voiceSwitcherOpen}
                setVoiceSwitcherOpen={setVoiceSwitcherOpen}
                voiceSwitcherRef={voiceSwitcherRef}
                voiceSwitcherTriggerRef={voiceSwitcherTriggerRef}
                switcherServerId={switcherServerId}
                setSwitcherServerId={setSwitcherServerId}
                servers={servers}
                allVoiceParticipants={allVoiceParticipants}
                onUserClick={onUserClick}
                onUserRightClick={onUserRightClick}
                currentUserId={currentUserId}
                t={t}
              />
            )}
            {/* Text view */}
            {topView === 'text' && (
              <PanelTextContent channels={activeServerChannels} categories={activeServerCategories} activeChannelId={activeChannelId} onSelectChannel={onSelectChannel} channelThreads={channelThreads} activeThreadId={activeThreadId} onThreadSelect={onThreadSelect} unreadThreadIds={unreadThreadIds} unreadThreadCounts={unreadThreadCounts} onChannelContextMenu={openChannelCtx} onCategoryContextMenu={openCategoryCtx} />
            )}
            {/* Pinned view */}
            {topView === 'pinned' && (
              <PanelPinnedContent channels={activeServerChannels} categories={activeServerCategories} pinnedChannelIds={pinnedChannelIds} pinnedCategoryIds={pinnedCategoryIds} activeChannelId={activeChannelId} onSelectChannel={onSelectChannel} onJoinVoiceChannel={onSwitchVoiceChannel} connectedVoiceChannelId={connectedVoiceChannel?.id} channelThreads={channelThreads} activeThreadId={activeThreadId} onThreadSelect={onThreadSelect} onChannelContextMenu={openChannelCtx} onCategoryContextMenu={openCategoryCtx} />
            )}
          </div>
          </div>
        </div>
      </div>

      {/* Draggable divider between Activity and Voice (only when both expanded) */}
      <div
        role="separator"
        aria-label={t('voice.resizeActivityVoice')}
        className="shrink-0 flex items-center justify-center cursor-ns-resize hover:bg-[var(--cyan-accent)]/30 transition-all duration-200 ease-out overflow-hidden relative z-10 group/split"
        style={{
          height: !activityCollapsed && !voiceCollapsed ? RESIZE_HANDLE_SPLIT_HEIGHT : 0,
          minHeight: !activityCollapsed && !voiceCollapsed ? RESIZE_HANDLE_SPLIT_HEIGHT : 0,
        }}
        onMouseDown={(e) => {
          if (activityCollapsed || voiceCollapsed) return;
          e.preventDefault();
          lastPointerRef.current = { x: e.clientX, y: e.clientY };
          setIsDraggingSplit(true);
        }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-0.5 w-8 rounded-full bg-[var(--cyan-accent)]/0 group-hover/split:bg-[var(--cyan-accent)]/40 transition-colors" />
      </div>

      {/* Bottom half (collapsible) -- view switchable via dropdown */}
      <div
        className="flex flex-col min-h-0 min-w-0 overflow-hidden transition-[flex] duration-200 ease-out"
        style={{ flex: bottomCollapsed ? '0 0 auto' : (topCollapsed ? '1 1 0' : '1 1 0') }}
      >
        {/* Section header with dropdown */}
        <div className={`w-full px-3 ${activityHeaderPy} shrink-0 flex items-center justify-between gap-2 border-default`}>
          <div className="relative" ref={dropdownOpen === 'bottom' ? dropdownRef : undefined}>
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); setDropdownOpen((o) => o === 'bottom' ? null : 'bottom'); }}
              className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider hover:bg-fill-hover rounded-lg px-1.5 py-0.5 transition-colors text-t-secondary"
            >
              {bottomView === 'activity' ? t('chat.activity') : bottomView === 'voice' ? t('chat.voice') : bottomView === 'text' ? 'Text' : 'Pinned'}
              <ChevronDown size={11} className={`transition-transform duration-150 ${dropdownOpen === 'bottom' ? 'rotate-180' : ''}`} />
            </button>
            {dropdownOpen === 'bottom' && (
              <div className="absolute left-0 top-full mt-1 z-30 min-w-[120px] rounded-xl border py-1" style={{ ...GLASS_DROPDOWN_STYLE }}>
                {(['activity', 'voice', 'text', 'pinned'] as const).map((view) => (
                  <button
                    key={view}
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setBottomView(view); setDropdownOpen(null); if (bottomCollapsed) setBottomCollapsed(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs font-medium transition-colors ${bottomView === view ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                    style={{ color: bottomView === view ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
                  >
                    {view === 'activity' ? t('chat.activity') : view === 'voice' ? t('chat.voice') : view === 'text' ? 'Text' : 'Pinned'}
                  </button>
                ))}
              </div>
            )}
          </div>
          <span className="flex items-center gap-1">
            <button type="button" onClick={() => setBottomCollapsed((c) => !c)} className="p-0.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary">
              {bottomCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
            </button>
          </span>
        </div>
        <div
          className="flex-1 min-h-0 overflow-hidden transition-[max-height] duration-200 ease-out"
          style={{ maxHeight: bottomCollapsed ? 0 : 2000 }}
        >
        <div className={`h-full min-h-0 overflow-y-auto ${activityListP}`}>
          {/* Voice view (default for bottom) */}
          {bottomView === 'voice' && (
            <PanelVoiceContent
              connectedVoiceChannel={connectedVoiceChannel}
              connectedVoiceServerName={connectedVoiceServerName}
              voiceChannelParticipants={voiceChannelParticipants}
              onLeaveVoiceChannel={onLeaveVoiceChannel}
              onSwitchVoiceChannel={onSwitchVoiceChannel}
              voiceSwitcherOpen={voiceSwitcherOpen}
              setVoiceSwitcherOpen={setVoiceSwitcherOpen}
              voiceSwitcherRef={voiceSwitcherRef}
              voiceSwitcherTriggerRef={voiceSwitcherTriggerRef}
              switcherServerId={switcherServerId}
              setSwitcherServerId={setSwitcherServerId}
              servers={servers}
              allVoiceParticipants={allVoiceParticipants}
              onUserClick={onUserClick}
              onUserRightClick={onUserRightClick}
              currentUserId={currentUserId}
              t={t}
            />
          )}
          {/* Activity view (in bottom section if selected) */}
          {bottomView === 'activity' && (
            serverNotifications.length > 0 ? (
              <ul className={activityItemSpace}>
                {[...serverNotifications].reverse().map((n) => (
                  <li key={n.id}>
                    <div
                      className={`flex items-start gap-2 px-2.5 ${activityItemPy} rounded-lg text-sm border border-default text-t-primary`}
                      style={{ backgroundColor: 'var(--bg-chat)' }}
                    >
                      <span className="shrink-0 mt-0.5">
                        {n.type === 'voice_join' || n.type === 'voice_leave' ? (
                          <Volume2 size={14} className="opacity-80" style={{ color: n.type === 'voice_join' ? '#34d399' : 'var(--text-secondary)' }} />
                        ) : (
                          <Activity size={14} className="opacity-80 text-t-accent" />
                        )}
                      </span>
                      <span className="flex-1 min-w-0 break-words">{n.message}</span>
                      {(n.count ?? 1) > 1 && (
                        <span className="text-[9px] font-bold tabular-nums px-1.5 py-0.5 rounded-md shrink-0 text-t-secondary" style={{ backgroundColor: 'var(--glass-border)' }}>
                          x{n.count}
                        </span>
                      )}
                      {onDismissNotification && (
                        <button type="button" onClick={() => onDismissNotification(n.id)} className="p-0.5 rounded-lg shrink-0 hover:bg-fill-active transition-colors text-t-secondary" aria-label={t('common.dismiss')}>
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-2 py-4 text-sm text-t-secondary">{t('chat.activityFromServer')}</p>
            )
          )}
          {/* Text view */}
          {bottomView === 'text' && (
            <PanelTextContent channels={activeServerChannels} categories={activeServerCategories} activeChannelId={activeChannelId} onSelectChannel={onSelectChannel} channelThreads={channelThreads} activeThreadId={activeThreadId} onThreadSelect={onThreadSelect} unreadThreadIds={unreadThreadIds} unreadThreadCounts={unreadThreadCounts} onChannelContextMenu={openChannelCtx} onCategoryContextMenu={openCategoryCtx} />
          )}
          {/* Pinned view */}
          {bottomView === 'pinned' && (
            <PanelPinnedContent channels={activeServerChannels} categories={activeServerCategories} pinnedChannelIds={pinnedChannelIds} pinnedCategoryIds={pinnedCategoryIds} activeChannelId={activeChannelId} onSelectChannel={onSelectChannel} onJoinVoiceChannel={onSwitchVoiceChannel} connectedVoiceChannelId={connectedVoiceChannel?.id} channelThreads={channelThreads} activeThreadId={activeThreadId} onThreadSelect={onThreadSelect} onChannelContextMenu={openChannelCtx} onCategoryContextMenu={openCategoryCtx} />
          )}
        </div>
        </div>
      </div>

      </>)}
      {/* Single hide-panel button -- vertically centered on the right edge, visible on panel hover */}
      <button
        type="button"
        onClick={() => { setActivityCollapsed(true); setVoiceCollapsed(true); }}
        className="absolute top-1/2 -translate-y-1/2 right-1.5 z-20 p-1 rounded-md hover:bg-fill-active transition-colors text-t-secondary"
        title={t('chat.hidePanel')}
      >
        <ChevronLeft size={14} />
      </button>

      {/* Right-edge resize handle for column width (matches left sidebar grab style) */}
      <div
        role="separator"
        aria-label={t('voice.resizeActivityColumn')}
        className="absolute top-0 right-0 bottom-0 w-1.5 flex items-center justify-center cursor-col-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-10 group/handle"
        onMouseDown={(e) => {
          e.preventDefault();
          lastPointerRef.current = { x: e.clientX, y: e.clientY };
          setIsDraggingWidth(true);
        }}
      >
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-[var(--cyan-accent)]/0 group-hover/handle:bg-[var(--cyan-accent)]/40 transition-colors" />
      </div>
    </aside>
      </div>
      <button
        type="button"
        onClick={() => { setActivityCollapsed(false); setVoiceCollapsed(false); }}
        className="absolute right-0 top-0 bottom-0 w-3.5 flex flex-col items-center justify-center rounded-r-md hover:bg-fill-active transition-all duration-200 ease-out border border-l-0 border-[var(--glass-border)] z-10 bg-panel"
        style={{
          opacity: activityCollapsed && voiceCollapsed ? 1 : 0,
          pointerEvents: activityCollapsed && voiceCollapsed ? 'auto' : 'none',
        }}
        title={t('chat.showActivityVoice')}
      >
        <div className="w-0.5 h-8 rounded-full bg-[var(--cyan-accent)]" />
      </button>
      {ctx && createPortal(
        (() => {
          const items: React.ReactNode[] = [];
          const itemClass = 'w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary';
          if (ctx.kind === 'channel') {
            const c = ctx.channel;
            const muted = isChannelMuted(c.id);
            const pinned = pinnedChannelIds.includes(c.id);
            const hasUnread = channelUnreadIds.has(c.id) || (channelMentionCounts[c.id] ?? 0) > 0;
            const isText = c.type === 'text' || c.type === 'forum';
            items.push(
              <button key="pin" type="button" onClick={() => { togglePinChannel(c.id); setCtx(null); }} className={itemClass}>
                <Pin size={14} className="shrink-0" />
                <span className="flex-1 truncate">{pinned ? t('channels.unpinFromBar') : t('channels.pinToBar')}</span>
              </button>,
            );
            if (isText && onMarkChannelRead && hasUnread) {
              items.push(
                <button key="mark-read" type="button" onClick={() => { onMarkChannelRead(c.id); setCtx(null); }} className={itemClass}>
                  <Check size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t('channels.markAsRead')}</span>
                </button>,
              );
            }
            if (isText) {
              items.push(
                <button key="mute" type="button" onClick={() => {
                  if (muted) unmuteChannel(c.id); else setChannelMutedForDuration(c.id, 'forever');
                  setMuteTick((t2) => t2 + 1);
                  setCtx(null);
                }} className={itemClass}>
                  {muted ? <Bell size={14} className="shrink-0" /> : <BellOff size={14} className="shrink-0" />}
                  <span className="flex-1 truncate">{muted ? t('channels.unmuteChannel') : t('channels.muteChannel')}</span>
                </button>,
              );
            }
            if (onOpenChannelSettings) {
              items.push(
                <button key="edit" type="button" onClick={() => { onOpenChannelSettings(c.id); setCtx(null); }} className={itemClass}>
                  <Settings size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t('channels.editChannel')}</span>
                </button>,
              );
            }
            if (onRequestDeleteChannel) {
              items.push(<div key="div" className="h-px my-1 mx-2 bg-[var(--border-subtle)]" />);
              items.push(
                <button key="delete" type="button" onClick={() => { onRequestDeleteChannel(c); setCtx(null); }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm rounded-lg hover:bg-red-500/10 transition-colors text-red-400">
                  <Trash2 size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t('channels.deleteChannel')}</span>
                </button>,
              );
            }
          } else if (ctx.kind === 'category') {
            const cat = ctx.category;
            const pinned = pinnedCategoryIds.includes(cat.id);
            items.push(
              <button key="pin-cat" type="button" onClick={() => { togglePinCategory(cat.id); setCtx(null); }} className={itemClass}>
                <Pin size={14} className="shrink-0" />
                <span className="flex-1 truncate">{pinned ? t('categories.unpinFromBar') : t('categories.pinToBar')}</span>
              </button>,
            );
            if (canManageChannels && onCreateChannelInCategory) {
              items.push(
                <button key="create-ch" type="button" onClick={() => { onCreateChannelInCategory(cat.id, cat.name); setCtx(null); }} className={itemClass}>
                  <Hash size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t('categories.createChannelInCategory')}</span>
                </button>,
              );
            }
            if (onOpenCategorySettings) {
              items.push(
                <button key="edit-cat" type="button" onClick={() => { onOpenCategorySettings(cat.id); setCtx(null); }} className={itemClass}>
                  <Settings size={14} className="shrink-0" />
                  <span className="flex-1 truncate">{t('categories.editCategory', 'Edit Category')}</span>
                </button>,
              );
            }
          }
          if (items.length === 0) return null;
          const winW = typeof window !== 'undefined' ? window.innerWidth : 9999;
          const winH = typeof window !== 'undefined' ? window.innerHeight : 9999;
          return (
            <>
              <div className="fixed inset-0 z-[var(--z-popover)]" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null); }} />
              <div ref={ctxMenuRef} className={`fixed z-[var(--z-popover)] py-1.5 min-w-[200px] rounded-2xl border shadow-2xl ${GLASS_MENU_CLASS} glass`}
                style={{
                  left: Math.min(ctx.x, winW - 220),
                  top: Math.min(ctx.y, winH - (Math.max(items.length, 1) * 40 + 16)),
                }}
              >
                {items}
              </div>
            </>
          );
        })(),
        document.body,
      )}
    </div>
  );
});

export default ChannelPanelAside;
