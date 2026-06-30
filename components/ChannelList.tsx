// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { Server, Channel, ChannelCategory, serverHasPerm } from '../types';
import type { ServerInvite } from '../types/server';
import type { SettingsSection } from './ServerSettingsPopup';
const ServerSettingsPopup = React.lazy(() => import('./ServerSettingsPopup').then(m => ({ default: m.ServerSettingsPopup })));
import { ServerIcon } from './ServerIcon';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { powerUpTier } from '../utils/powerUpTier';
import type { ServerContextAction } from './Sidebar';
import { useRenderLoopDetector } from '../hooks/useRenderLoopDetector';
import {
  Hash, Volume2, ChevronDown, ChevronRight, Bell, BellOff, Plus, Users,
  UserPlus, Settings, FolderPlus, FolderOpen, Calendar, EyeOff, VolumeX,
  LogOut, UserCircle, ShieldAlert, Check, X, Pin, Pencil, Trash2, MessageCirclePlus, Radio,
  MoreHorizontal, Monitor, Link2, Tag
} from 'lucide-react';
import { getSubmenuPosition, GLASS_MENU_CLASS, GLASS_DROPDOWN_STYLE, ContextMenuContainer } from '../utils/contextMenuStyles';
import { longPressBindings } from '../hooks/useLongPress';
import { RoleNameStyle } from './RoleNameStyle';
import { useIsMobile } from '../hooks/useIsMobile';

import { getServerNotificationSettings, setServerNotificationSettings, type ServerNotificationSettings, type ServerNotificationLevel } from '../utils/serverNotificationStorage';
import { isChannelMuted, setChannelMutedForDuration, unmuteChannel, type ChannelMuteDuration } from '../utils/mutedChannelStorage';
import { getChannelNotificationLevel, setChannelNotificationLevel, type ChannelNotificationLevel } from '../utils/channelNotificationStorage';
import { LetterAvatar } from './LetterAvatar';
import { useTranslation } from 'react-i18next';
import { CreateChannelModal } from './channel/CreateChannelModal';
import { InviteModal } from './channel/InviteModal';
import { LeaveServerModal } from './channel/LeaveServerModal';
import ChannelSettingsModal from './channel/ChannelSettingsModal';
import CategorySettingsModal from './channel/CategorySettingsModal';
// ForumIcon used when rendering forum channels in channel lists
import { ForumIcon } from './channel/ForumIcon';
import { apiClient } from '../services/api';
import { getWebOrigin } from '../config';
import { preconnectAll as preconnectLiveKit } from '../services/livekitPreconnect';
import { useNavigationStore } from '../stores/navigationStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useThreadPollStore } from '../stores/threadPollStore';
import { useSocialStore } from '../stores/socialStore';
import { useUiStore } from '../stores/uiStore';

const PINNED_CHANNELS_STORAGE_KEY = 'howl_pinned_channels';

const CHANNEL_MUTE_OPTIONS: { value: ChannelMuteDuration; labelKey: string }[] = [
  { value: '15m', labelKey: 'sidebar.for15Min' },
  { value: '1h', labelKey: 'sidebar.for1Hour' },
  { value: '3h', labelKey: 'sidebar.for3Hours' },
  { value: '8h', labelKey: 'sidebar.for8Hours' },
  { value: '24h', labelKey: 'sidebar.for24Hours' },
  { value: 'forever', labelKey: 'sidebar.untilTurnBack' },
];

export type { ServerNotificationLevel, ServerNotificationSettings };

export function getPinnedForServer(serverId: string): string[] {
  try {
    const raw = localStorage.getItem(PINNED_CHANNELS_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    return data[serverId] ?? [];
  } catch {
    return [];
  }
}

export function setPinnedForServer(serverId: string, channelIds: string[]) {
  try {
    const raw = localStorage.getItem(PINNED_CHANNELS_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    data[serverId] = channelIds;
    localStorage.setItem(PINNED_CHANNELS_STORAGE_KEY, JSON.stringify(data));
  } catch (err) { console.error('Failed to save pinned channels', err); }
}

const COLLAPSED_CATEGORIES_STORAGE_KEY = 'howl_collapsed_categories';

function getCollapsedCategories(serverId: string): Set<string> {
  try {
    const raw = localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    return new Set(data[serverId] ?? []);
  } catch {
    return new Set();
  }
}

function setCollapsedCategories(serverId: string, collapsed: Set<string>) {
  try {
    const raw = localStorage.getItem(COLLAPSED_CATEGORIES_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    data[serverId] = [...collapsed];
    localStorage.setItem(COLLAPSED_CATEGORIES_STORAGE_KEY, JSON.stringify(data));
  } catch (err) { console.error('Failed to save collapsed categories', err); }
}

const PINNED_CATEGORIES_STORAGE_KEY = 'howl_pinned_categories';

export function getPinnedCategoriesForServer(serverId: string): string[] {
  try {
    const raw = localStorage.getItem(PINNED_CATEGORIES_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    return data[serverId] ?? [];
  } catch { return []; }
}

export function setPinnedCategoriesForServer(serverId: string, categoryIds: string[]) {
  try {
    const raw = localStorage.getItem(PINNED_CATEGORIES_STORAGE_KEY);
    const data = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    data[serverId] = categoryIds;
    localStorage.setItem(PINNED_CATEGORIES_STORAGE_KEY, JSON.stringify(data));
  } catch (err) { console.error('Failed to save pinned categories', err); }
}

/** Remove per-server localStorage entries when leaving/deleting/kicked from a server */
export function clearServerChannelListStorage(serverId: string): void {
  try {
    for (const key of [PINNED_CHANNELS_STORAGE_KEY, COLLAPSED_CATEGORIES_STORAGE_KEY, PINNED_CATEGORIES_STORAGE_KEY]) {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const data = JSON.parse(raw) as Record<string, unknown>;
      if (serverId in data) {
        delete data[serverId];
        localStorage.setItem(key, JSON.stringify(data));
      }
    }
  } catch { /* storage error — ignore */ }
}

/** Participants currently in the connected voice channel (so we can show names under that channel) */
export interface VoiceChannelParticipant {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  roleColor?: string;
  roleStyle?: string;
  /** Backend sets this when the participant is actively publishing a screen
   *  track. Used to render a clickable "watch stream" icon. */
  isScreenSharing?: boolean;
}

const EMPTY_VOICE_PARTICIPANTS: Record<string, VoiceChannelParticipant[]> = {};
const EMPTY_THREADS: Record<string, import('../types').Thread[]> = {};
const EMPTY_STAGE_SESSIONS: Record<string, import('../types').StageSession> = {};
const EMPTY_THREAD_ARRAY: import('../types').Thread[] = [];
const EMPTY_PARTICIPANT_ARRAY: VoiceChannelParticipant[] = [];

interface ChannelListProps {
  server: Server;
  onChannelSelect: (id: string) => void;
  onUpdateServer?: (server: Server) => void;
  onCreateChannel?: (serverId: string, name: string, type: Channel['type'], categoryId?: string | null, isPrivate?: boolean) => Promise<Channel>;
  onCreateCategory?: (serverId: string, name: string) => Promise<ChannelCategory>;
  onDeleteCategory?: (serverId: string, categoryId: string) => Promise<void>;
  onUpdateCategory?: (serverId: string, categoryId: string, data: { name?: string }) => Promise<ChannelCategory>;
  onCreateInvite?: (serverId: string, options?: { expireAfter?: number | null; maxUses?: number | null; temporary?: boolean; label?: string; shareable?: boolean }) => Promise<{ id: string; code: string; link: string; label?: string; shareable: boolean }>;
  onDeleteInvite?: (serverId: string, inviteId: string) => Promise<void>;
  onUpdateInvite?: (serverId: string, inviteId: string, data: { label?: string | null; shareable?: boolean }) => Promise<ServerInvite>;
  onLeaveServer?: (serverId: string) => void | Promise<void>;
  onTransferOwnershipAndLeave?: (serverId: string, newOwnerId: string) => void | Promise<void>;
  onDeleteServer?: (serverId: string) => void | Promise<void>;
  otherServerMembers?: Array<{ id: string; username: string; discriminator?: string }>;
  serverMembers?: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; status?: string; role?: string }>;
  getServerInvites?: (serverId: string) => Promise<Array<ServerInvite>>;
  getServerRoles?: (serverId: string) => Promise<Array<{ id: string; name: string; color: string; style: string; icon?: string; position: number; locked: boolean; permissions: Record<string, boolean>; displaySeparately: boolean; allowMention: boolean; memberCount: number }>>;
  onUpdateRole?: (serverId: string, roleId: string, data: Record<string, unknown>) => Promise<void>;
  onCreateRole?: (serverId: string, data: Record<string, unknown>) => Promise<{ id: string; name: string; color: string; style: string; icon?: string; position: number; locked: boolean; permissions: Record<string, boolean>; displaySeparately: boolean; allowMention: boolean; memberCount: number }>;
  onDeleteRole?: (serverId: string, roleId: string) => Promise<void>;
  onAddMemberToRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRemoveMemberFromRole?: (serverId: string, roleId: string, userId: string) => Promise<void>;
  onRolesUpdated?: () => void;
  onKickMember?: (serverId: string, userId: string) => Promise<void>;
  getMemberModView?: (serverId: string, userId: string) => Promise<import('./ModViewPopup').ModViewData>;
  serverContextAction?: { serverId: string; action: ServerContextAction } | null;
  onClearContextAction?: () => void;
  /** 'sidebar' = classic vertical channel list; 'deck' = horizontal top bar (server + channel tabs + add) */
  layout?: 'sidebar' | 'deck';
  /** When layout=deck, toggle a right-side members column (state and column live in parent) */
  deckMembersColumnOpen?: boolean;
  onDeckMembersColumnToggle?: () => void;
  deckMembersCount?: number;
  /** UI density for server deck/channel list spacing */
  uiDensity?: 'compact' | 'default' | 'spacious';
  /** When user right-clicks a channel and chooses "Mark as read" (text channels only). */
  onMarkChannelRead?: (channelId: string) => void;
  /** When user right-clicks a channel and chooses "Delete channel". */
  onDeleteChannel?: (channel: Channel) => void;
  /** External trigger to open ChannelSettingsModal for a specific channel ID */
  openChannelSettingsId?: string | null;
  /** Called after consuming openChannelSettingsId to clear the external trigger */
  onClearOpenChannelSettings?: () => void;
  /** Mirrors openChannelSettingsId, but for categories. Used by Classic-mode
   *  ClassicChannelTree to ask ChannelList to open the CategorySettingsModal
   *  for the right-clicked category. */
  openCategorySettingsId?: string | null;
  onClearOpenCategorySettings?: () => void;
  /** Navigate to User Settings > Profiles for the current server */
  onEditServerProfile?: (serverId: string) => void;
  /** Notify parent when pinned channels for this server change (so other panels can refresh). */
  onPinnedChannelsChange?: (serverId: string, channelIds: string[]) => void;
  onPinnedCategoriesChange?: (serverId: string, categoryIds: string[]) => void;
  /** Toggle calendar view */
  onToggleCalendar?: () => void;
  onUpdateChannel?: (serverId: string, channelId: string, data: { name?: string; description?: string | null }) => Promise<Channel>;
  onReorderChannels?: (serverId: string, channels: Array<{ id: string; position: number; categoryId: string | null }>) => Promise<void>;
  onReorderCategories?: (serverId: string, categories: Array<{ id: string; position: number }>) => Promise<void>;
  onThreadSelect?: (thread: import('../types').Thread) => void;
  onStageChannelSelect?: (channelId: string) => void;
  isThreadBrowserActive?: boolean;
  onToggleThreadBrowser?: () => void;
  threadBrowserBtnRef?: React.RefObject<HTMLDivElement | null>;
}

type ModalType = 'invite' | 'settings' | 'createChannel' | 'createCategory' | 'renameCategory' | 'deleteCategory' | 'notifications' | 'leave' | null;

const MobileOverflowMenu: React.FC<{
  onToggleThreadBrowser?: () => void;
  onToggleCalendar?: () => void;
  isThreadBrowserActive?: boolean;
  isCalendarActive?: boolean;
  calendarDotType?: string | null;
  canManageChannels?: boolean;
  onCreateChannel?: () => void;
  onCreateCategory?: () => void;
  t: (key: string) => string;
}> = ({ onToggleThreadBrowser, onToggleCalendar, isThreadBrowserActive, isCalendarActive, calendarDotType, canManageChannels, onCreateChannel, onCreateCategory, t }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`w-8 h-8 rounded-xl flex items-center justify-center transition-colors border border-[var(--glass-border)] ${open ? 'bg-fill-active text-t-accent' : 'hover:bg-fill-hover text-t-secondary'}`}
        aria-label="More options">
        <MoreHorizontal size={16} />
      </button>
      {open && createPortal(
        <div style={{ position: 'fixed', top: (ref.current?.getBoundingClientRect().bottom ?? 0) + 6, right: window.innerWidth - (ref.current?.getBoundingClientRect().right ?? 0), zIndex: 'var(--z-popover)' as unknown as number, ...GLASS_DROPDOWN_STYLE }}
          className="min-w-[180px] rounded-xl border shadow-xl py-1 animate-in slide-in-from-top-2 fade-in duration-200">
          {onToggleThreadBrowser && (
            <button type="button" onClick={() => { onToggleThreadBrowser(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-fill-hover ${isThreadBrowserActive ? 'text-t-accent' : 'text-t-primary'}`}>
              <MessageCirclePlus size={15} className="text-t-secondary" /> {t('threads.threadBrowser')}
            </button>
          )}
          {onToggleCalendar && (
            <button type="button" onClick={() => { onToggleCalendar(); setOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-fill-hover ${isCalendarActive ? 'text-t-accent' : 'text-t-primary'} relative`}>
              <Calendar size={15} className="text-t-secondary" /> {t('channels.calendar')}
              {calendarDotType === 'live' && <div className="w-2 h-2 rounded-full bg-red-500 ml-auto" />}
              {calendarDotType === 'soon' && !isCalendarActive && <div className="w-2 h-2 rounded-full bg-amber-400 ml-auto" />}
            </button>
          )}
          {canManageChannels && (
            <>
              <div className="h-px my-1 bg-[var(--border-subtle)]" />
              <button type="button" onClick={() => { onCreateChannel?.(); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-fill-hover text-t-primary">
                <Plus size={15} className="text-t-secondary" /> {t('sidebar.createChannel')}
              </button>
              <button type="button" onClick={() => { onCreateCategory?.(); setOpen(false); }}
                className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-fill-hover text-t-primary">
                <FolderOpen size={15} className="text-t-secondary" /> {t('sidebar.createCategory')}
              </button>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );
};

/* ── Memoized sidebar channel items ── */

const SidebarTextChannelItem = React.memo(function SidebarTextChannelItem({
  channel,
  isActive,
  onSelect,
}: {
  channel: Channel;
  isActive: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      key={channel.id}
      onClick={() => onSelect(channel.id)}
      className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left ${
        isActive
          ? 'shadow-md bg-[color-mix(in_srgb,var(--cyan-accent)_12%,transparent)] border-l-3 border-l-[var(--cyan-accent)] text-t-accent'
          : 'hover:bg-fill-hover border-l-3 border-l-transparent text-t-secondary'
      }`}
    >
      {channel.type === 'forum' ? <ForumIcon size={16} className="shrink-0 opacity-70" /> : <Hash size={16} className="shrink-0 opacity-70" />}
      <span className="truncate text-sm font-medium">{channel.name}</span>
    </button>
  );
});

const SidebarVoiceChannelItem = React.memo(function SidebarVoiceChannelItem({
  channel,
  isActive,
  participants,
  onSelect,
  onWatchScreen,
}: {
  channel: Channel;
  isActive: boolean;
  participants: VoiceChannelParticipant[];
  onSelect: (id: string) => void;
  onWatchScreen: (channelId: string, userId: string) => void;
}) {
  return (
    <div className="space-y-1">
      <button
        onClick={() => onSelect(channel.id)}
        onMouseEnter={preconnectLiveKit}
        onFocus={preconnectLiveKit}
        className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl transition-all text-left ${
          isActive ? 'shadow-md bg-emerald-500/12 border-l-3 border-l-emerald-500 text-emerald-400' : 'hover:bg-fill-hover border-l-3 border-l-transparent text-t-secondary'
        }`}
      >
        <Volume2 size={16} className="shrink-0 opacity-70" />
        <span className="truncate text-sm font-medium flex-1">{channel.name}</span>
        {participants.length > 0 && (
          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400">{participants.length}</span>
        )}
      </button>
      {participants.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pl-9 pr-1">
          {participants.slice(0, 5).map((p) => (
            <div key={p.id} className="flex items-center gap-1.5 py-1 px-2 rounded-lg bg-fill-hover" title={p.username}>
              <LetterAvatar avatar={p.avatar} username={p.username} size={20} className="rounded-full" />
              <span className="text-[11px] font-medium truncate max-w-[80px] text-t-primary">{p.username}</span>
              {p.isScreenSharing && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onWatchScreen(channel.id, p.id); }}
                  className="p-1 rounded-md text-emerald-400 hover:bg-emerald-500/20 transition-colors"
                  title={`Watch ${p.username}'s stream`}
                  aria-label={`Watch ${p.username}'s stream`}
                >
                  <Monitor size={12} />
                </button>
              )}
            </div>
          ))}
          {participants.length > 5 && <span className="text-[10px] text-t-secondary">+{participants.length - 5}</span>}
        </div>
      )}
    </div>
  );
});

export const ChannelList: React.FC<ChannelListProps> = React.memo(({
  server,
  onChannelSelect,
  onUpdateServer,
  onCreateChannel,
  onCreateInvite,
  onDeleteInvite,
  onUpdateInvite,
  onLeaveServer,
  onTransferOwnershipAndLeave,
  onDeleteServer,
  otherServerMembers = [],
  serverMembers = [],
  getServerInvites,
  getServerRoles,
  onUpdateRole,
  onCreateRole,
  onDeleteRole,
  onAddMemberToRole,
  onRemoveMemberFromRole,
  onRolesUpdated,
  onKickMember,
  getMemberModView,
  serverContextAction,
  onClearContextAction,
  layout = 'sidebar',
  deckMembersColumnOpen,
  onDeckMembersColumnToggle,
  deckMembersCount = 0,
  uiDensity = 'default',
  onMarkChannelRead,
  onDeleteChannel,
  openChannelSettingsId,
  onClearOpenChannelSettings,
  openCategorySettingsId,
  onClearOpenCategorySettings,
  onEditServerProfile,
  onPinnedChannelsChange,
  onCreateCategory,
  onDeleteCategory,
  onUpdateCategory,
  onPinnedCategoriesChange,
  onUpdateChannel,
  onReorderChannels,
  onReorderCategories,
  onToggleCalendar,
  onThreadSelect,
  onStageChannelSelect,
  isThreadBrowserActive,
  onToggleThreadBrowser,
  threadBrowserBtnRef,
}) => {
  useRenderLoopDetector('ChannelList');
  // Store selectors
  const activeChannelId = useNavigationStore(s => s.activeChannelId);
  const isCalendarActive = useNavigationStore(s => s.calendarActive);
  const connectedVoiceChannelId = useVoiceStore(s => s.connectedVoiceChannelId);
  const connectedStageChannelId = useVoiceStore(s => s.connectedStageChannelId);
  const voiceParticipantsByChannel = useVoiceStore(s => s.allVoiceChannelParticipants) ?? EMPTY_VOICE_PARTICIPANTS;
  const activeStageSessions = useVoiceStore(s => s.activeStageSessions) ?? EMPTY_STAGE_SESSIONS;
  const currentUser = useAuthStore(s => s.currentUser)!;
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);
  const textChannelMentionCounts = useNotificationStore(s => s.channelMentionCounts);
  const threadMentionCounts = useNotificationStore(s => s.threadMentionCounts);
  const calendarDotState = useNotificationStore(s => s.calendarDotState);
  const calendarDotType = calendarDotState[server.id] ?? null;
  const channelThreads = useThreadPollStore(s => s.channelThreads) ?? EMPTY_THREADS;
  const activeThread = useThreadPollStore(s => s.activeThread);
  const activeThreadId = activeThread?.id ?? null;
  const unreadThreadIds = useThreadPollStore(s => s.unreadThreadIds);
  const unreadThreadCounts = useThreadPollStore(s => s.unreadThreadCounts);
  const homeFriends = useSocialStore(s => s.homeFriends);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const d = uiDensity;
  const deckBtn = d === 'compact' ? 'px-2.5 py-1.5 gap-1' : d === 'spacious' ? 'px-4 py-2.5 gap-2' : 'px-3 py-2 gap-1.5';
  const deckDropdownPy = d === 'compact' ? 'py-1.5' : d === 'spacious' ? 'py-3' : 'py-2';
  const deckItemPy = d === 'compact' ? 'py-1.5' : d === 'spacious' ? 'py-2.5' : 'py-2';
  const deckPinnedGap = d === 'compact' ? 'gap-1' : d === 'spacious' ? 'gap-2' : 'gap-1.5';
  const deckPinnedPill = d === 'compact' ? 'px-2 py-1' : d === 'spacious' ? 'px-3 py-2' : 'px-2.5 py-1.5';
  const deckAddBtn = d === 'compact' ? 'w-8 h-8' : d === 'spacious' ? 'w-10 h-10' : 'w-9 h-9';
  const deckVoiceParticipantGap = d === 'compact' ? 'gap-1' : d === 'spacious' ? 'gap-2' : 'gap-1.5';

  const [width, setWidth] = useState(256);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [modalType, setModalType] = useState<ModalType>(null);
  const [initialSettingsSection, setInitialSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [createChannelInitialType, setCreateChannelInitialType] = useState<'text' | 'voice' | 'stage' | 'forum' | 'role_picker'>('text');

  // Settings State
  const [_tempServerName, setTempServerName] = useState(server.name);

  // Notification settings (per-server, synced when notifications modal opens)
  const [notificationPrefs, setNotificationPrefs] = useState<ServerNotificationSettings>(() => getServerNotificationSettings(server.id, currentUser?.id));

  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuPortalRef = useRef<HTMLDivElement>(null);
  const textDropdownRef = useRef<HTMLDivElement>(null);
  const textDropdownPortalRef = useRef<HTMLDivElement>(null);
  const voiceDropdownRef = useRef<HTMLDivElement>(null);
  const voiceDropdownPortalRef = useRef<HTMLDivElement>(null);
  const pinContextMenuRef = useRef<HTMLDivElement>(null);
  const channelMuteTriggerRef = useRef<HTMLButtonElement>(null);
  const channelNotificationTriggerRef = useRef<HTMLButtonElement>(null);
  const channelSubmenuRef = useRef<HTMLDivElement>(null);
  const channelSubmenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [textDropdownOpen, setTextDropdownOpen] = useState(false);
  const [voiceDropdownOpen, setVoiceDropdownOpen] = useState(false);
  const [pinContextMenu, setPinContextMenu] = useState<{ x: number; y: number; channel: Channel } | null>(null);
  const [channelSubmenu, setChannelSubmenu] = useState<{ type: 'mute' | 'notification'; left: number; top: number } | null>(null);

  const [pinnedChannelIds, setPinnedChannelIds] = useState<string[]>(() => getPinnedForServer(server.id));
  const [pinnedCategoryIds, setPinnedCategoryIds] = useState<string[]>(() => getPinnedCategoriesForServer(server.id));
  const [categoryContextMenu, setCategoryContextMenu] = useState<{ x: number; y: number; category: ChannelCategory } | null>(null);
  const categoryContextMenuRef = useRef<HTMLDivElement>(null);
  const [createChannelCategoryId, setCreateChannelCategoryId] = useState<string | null>(null);
  const [createChannelCategoryName, setCreateChannelCategoryName] = useState<string | null>(null);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [categoryCreateError, setCategoryCreateError] = useState<string | null>(null);
  const [renamingCategory, setRenamingCategory] = useState<ChannelCategory | null>(null);
  const [renameCategoryName, setRenameCategoryName] = useState('');
  const [renameCategoryError, setRenameCategoryError] = useState<string | null>(null);
  const [expandedPinnedCategory, setExpandedPinnedCategory] = useState<string | null>(null);
  const [pinnedCatPillRect, setPinnedCatPillRect] = useState<DOMRect | null>(null);
  const [deletingCategory, setDeletingCategory] = useState<ChannelCategory | null>(null);
  const [deleteCategoryError, setDeleteCategoryError] = useState<string | null>(null);
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [channelSettingsTarget, setChannelSettingsTarget] = useState<Channel | null>(null);
  const [categorySettingsTarget, setCategorySettingsTarget] = useState<ChannelCategory | null>(null);
  const [settingsRoles, setSettingsRoles] = useState<Array<{ id: string; name: string; color: string }>>([]);

  // Fetch roles when opening channel or category settings
  useEffect(() => {
    if (!channelSettingsTarget && !categorySettingsTarget) {
      setSettingsRoles([]);
      return;
    }
    if (getServerRoles) {
      getServerRoles(server.id).then((roles) => {
        setSettingsRoles(roles.map((r) => ({ id: r.id, name: r.name, color: r.color })));
      }).catch(() => {});
    }
  }, [channelSettingsTarget, categorySettingsTarget, getServerRoles, server.id]);

  /** Close all open dropdowns/menus so modals render on top */
  const closeAllOverlays = useCallback(() => {
    setTextDropdownOpen(false);
    setVoiceDropdownOpen(false);
    setPinContextMenu(null);
    setChannelSubmenu(null);
    setCategoryContextMenu(null);
    setExpandedPinnedCategory(null);
    setAddMenuOpen(false);
  }, []);

  // External trigger to open channel settings (e.g. from header click)
  useEffect(() => {
    if (!openChannelSettingsId) return;
    const ch = server.channels.find((c) => c.id === openChannelSettingsId);
    if (ch) {
      closeAllOverlays();
      setChannelSettingsTarget(ch);
    }
    onClearOpenChannelSettings?.();
  }, [openChannelSettingsId, server.channels, onClearOpenChannelSettings, closeAllOverlays]);

  // External trigger to open category settings (Classic-mode right-click).
  useEffect(() => {
    if (!openCategorySettingsId) return;
    const cat = (server.categories ?? []).find((c) => c.id === openCategorySettingsId);
    if (cat) {
      closeAllOverlays();
      setCategorySettingsTarget(cat);
    }
    onClearOpenCategorySettings?.();
  }, [openCategorySettingsId, server.categories, onClearOpenCategorySettings, closeAllOverlays]);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuButtonRef = useRef<HTMLButtonElement>(null);
  const [draggingPinnedId, setDraggingPinnedId] = useState<string | null>(null);
  const [dragOverPinnedIndex, setDragOverPinnedIndex] = useState<number | null>(null);
  const dragGhostRef = useRef<HTMLDivElement | null>(null);

  const isAdmin = serverHasPerm(server, 'manageServer');
  const canManageChannels = serverHasPerm(server, 'manageChannels') || isAdmin;
  const canCreateInvite = serverHasPerm(server, 'createInvite') || isAdmin;

  const serverMemberIdSet = useMemo(() => {
    const set = new Set<string>();
    for (const m of serverMembers) set.add(m.id);
    return set;
  }, [serverMembers]);

  useEffect(() => {
    return () => {
      if (channelSubmenuCloseTimeoutRef.current) clearTimeout(channelSubmenuCloseTimeoutRef.current);
    };
  }, []);

  const isPinned = useCallback((channelId: string) => pinnedChannelIds.includes(channelId), [pinnedChannelIds]);
  const togglePin = useCallback((channelId: string) => {
    const next = isPinned(channelId) ? pinnedChannelIds.filter((id) => id !== channelId) : [...pinnedChannelIds, channelId];
    setPinnedChannelIds(next);
    setPinnedForServer(server.id, next);
    onPinnedChannelsChange?.(server.id, next);
    setPinContextMenu(null);
  }, [pinnedChannelIds, server.id, isPinned, onPinnedChannelsChange]);

  const isCategoryPinned = useCallback((categoryId: string) => pinnedCategoryIds.includes(categoryId), [pinnedCategoryIds]);
  const toggleCategoryPin = useCallback((categoryId: string) => {
    const next = isCategoryPinned(categoryId) ? pinnedCategoryIds.filter(id => id !== categoryId) : [...pinnedCategoryIds, categoryId];
    setPinnedCategoryIds(next);
    setPinnedCategoriesForServer(server.id, next);
    onPinnedCategoriesChange?.(server.id, next);
  }, [pinnedCategoryIds, server.id, isCategoryPinned, onPinnedCategoriesChange]);

  const handleCategoryCreate = useCallback(async () => {
    const name = newCategoryName.trim();
    if (!name || !onCreateCategory) return;
    setCategoryCreateError(null);
    try {
      await onCreateCategory(server.id, name);
      setNewCategoryName('');
      closeModal();
    } catch (e) {
      setCategoryCreateError(e instanceof Error ? e.message : 'Failed to create category.');
    }
  }, [newCategoryName, onCreateCategory, server.id]);

  const handleCategoryRename = useCallback(async () => {
    if (!renamingCategory || !onUpdateCategory) return;
    const name = renameCategoryName.trim();
    if (!name || name === renamingCategory.name) return;
    setRenameCategoryError(null);
    try {
      const updated = await onUpdateCategory(server.id, renamingCategory.id, { name });
      if (onUpdateServer) {
        onUpdateServer({
          ...server,
          categories: (server.categories ?? []).map(c => c.id === updated.id ? updated : c),
        });
      }
      setRenamingCategory(null);
      setRenameCategoryName('');
      closeModal();
    } catch (e) {
      setRenameCategoryError(e instanceof Error ? e.message : 'Failed to rename category.');
    }
  }, [renamingCategory, renameCategoryName, onUpdateCategory, server, onUpdateServer]);

  const reorderPinned = useCallback((draggedId: string, dropIndex: number) => {
    const from = pinnedChannelIds.indexOf(draggedId);
    if (from === -1) return;
    if (from === dropIndex) return;
    const next = [...pinnedChannelIds];
    next.splice(from, 1);
    const insertIndex = dropIndex > from ? dropIndex - 1 : dropIndex;
    next.splice(insertIndex, 0, draggedId);
    setPinnedChannelIds(next);
    setPinnedForServer(server.id, next);
    setDraggingPinnedId(null);
    setDragOverPinnedIndex(null);
    onPinnedChannelsChange?.(server.id, next);
  }, [pinnedChannelIds, server.id, onPinnedChannelsChange]);

  // text-like channels share the chat pane / channel tree on the left:
  // text, forum, and role_picker (which renders its own pane like forum).
  const textChannels = useMemo(() => server.channels.filter((c) => c.type === 'text' || c.type === 'forum' || c.type === 'role_picker'), [server.channels]);
  const voiceChannels = useMemo(() => server.channels.filter((c) => c.type === 'voice'), [server.channels]);
  const stageChannels = useMemo(() => server.channels.filter((c) => c.type === 'stage'), [server.channels]);

  // Category collapse state (persisted per-server in localStorage)
  const [collapsedCategories, setCollapsedCategoriesState] = useState<Set<string>>(() => getCollapsedCategories(server.id));

  const toggleCategoryCollapse = useCallback((categoryId: string) => {
    setCollapsedCategoriesState(prev => {
      const next = new Set(prev);
      if (next.has(categoryId)) next.delete(categoryId);
      else next.add(categoryId);
      setCollapsedCategories(server.id, next);
      return next;
    });
  }, [server.id]);

  useEffect(() => {
    setCollapsedCategoriesState(getCollapsedCategories(server.id));
  }, [server.id]);

  const categories = useMemo(() => server.categories ?? [], [server.categories]);

  const textChannelsByCategory = useMemo(() => {
    const text = server.channels.filter(c => c.type === 'text' || c.type === 'forum' || c.type === 'role_picker').sort((a, b) => a.position - b.position);
    const catMap = new Map<string | null, typeof text>();
    for (const ch of text) {
      const key = ch.categoryId;
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key)!.push(ch);
    }
    const grouped: Array<{ category: ChannelCategory | null; channels: typeof text }> = [];
    const uncategorized = catMap.get(null) ?? [];
    if (uncategorized.length > 0) grouped.push({ category: null, channels: uncategorized });
    for (const cat of categories) grouped.push({ category: cat, channels: catMap.get(cat.id) ?? [] });
    return grouped;
  }, [server.channels, categories]);

  const voiceChannelsByCategory = useMemo(() => {
    const voice = server.channels.filter(c => c.type === 'voice').sort((a, b) => a.position - b.position);
    const catMap = new Map<string | null, typeof voice>();
    for (const ch of voice) {
      const key = ch.categoryId;
      if (!catMap.has(key)) catMap.set(key, []);
      catMap.get(key)!.push(ch);
    }
    const grouped: Array<{ category: ChannelCategory | null; channels: typeof voice }> = [];
    const uncategorized = catMap.get(null) ?? [];
    if (uncategorized.length > 0) grouped.push({ category: null, channels: uncategorized });
    for (const cat of categories) grouped.push({ category: cat, channels: catMap.get(cat.id) ?? [] });
    return grouped;
  }, [server.channels, categories]);

  const textNotificationCount = useMemo(() => textChannels.filter((ch) => channelUnreadIds.has(ch.id) || textChannelMentionCounts[ch.id] > 0).length, [textChannels, channelUnreadIds, textChannelMentionCounts]);
  const totalVoiceParticipants = useMemo(() => voiceChannels.reduce((sum, ch) => sum + (voiceParticipantsByChannel[ch.id]?.length ?? 0), 0), [voiceChannels, voiceParticipantsByChannel]);
  const channelById = useMemo(() => Object.fromEntries(server.channels.map((c) => [c.id, c])), [server.channels]);
  const pinnedChannelsOrdered = useMemo(() => pinnedChannelIds.map((id) => channelById[id]).filter((c): c is Channel => c != null), [pinnedChannelIds, channelById]);
  // Extracted handlers from .map() loops to reduce re-render overhead

  /** Handler for selecting a text channel from the deck dropdown */
  const handleTextDropdownSelect = useCallback((channelId: string) => {
    onChannelSelect(channelId);
    setTextDropdownOpen(false);
  }, [onChannelSelect]);

  /** Handler for selecting a voice channel from the deck dropdown */
  const handleVoiceDropdownSelect = useCallback((channelId: string) => {
    onChannelSelect(channelId);
    setVoiceDropdownOpen(false);
  }, [onChannelSelect]);

  /** Handler for selecting a stage channel — navigates AND joins */
  const handleStageChannelSelect = useCallback((channelId: string) => {
    onStageChannelSelect?.(channelId);
    onChannelSelect(channelId);
  }, [onStageChannelSelect, onChannelSelect]);

  /** Handler for selecting a channel (sidebar text/voice + pinned pills) */
  const handleChannelSelect = useCallback((channelId: string) => {
    onChannelSelect(channelId);
  }, [onChannelSelect]);

  /** Sidebar "watch stream" click: flag the user-to-auto-watch in voiceStore
   *  and navigate to the voice channel. VoiceChannel consumes the flag on
   *  mount/connect and calls enableRemoteScreen. */
  const handleWatchScreen = useCallback((channelId: string, userId: string) => {
    useVoiceStore.getState().setAutoWatchScreenUserId(userId);
    onChannelSelect(channelId);
  }, [onChannelSelect]);

  /** Handler for pinned channel drag start */
  const handlePinnedDragStart = useCallback((e: React.DragEvent, channelId: string) => {
    setDraggingPinnedId(channelId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', channelId);
    e.dataTransfer.setData('application/x-pinned-channel-id', channelId);
  }, []);

  /** Handler for pinned channel drag end */
  const handlePinnedDragEnd = useCallback(() => {
    if (dragGhostRef.current && document.body.contains(dragGhostRef.current)) {
      document.body.removeChild(dragGhostRef.current);
      dragGhostRef.current = null;
    }
    setDraggingPinnedId(null);
    setDragOverPinnedIndex(null);
  }, []);

  /** Handler for pinned channel drag over */
  const handlePinnedDragOver = useCallback((e: React.DragEvent, channelId: string, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (draggingPinnedId && draggingPinnedId !== channelId) setDragOverPinnedIndex(index);
  }, [draggingPinnedId]);

  /** Handler for pinned channel drag leave */
  const handlePinnedDragLeave = useCallback(() => {
    setDragOverPinnedIndex(null);
  }, []);

  /** Handler for pinned channel drop */
  const handlePinnedDrop = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    const draggedId = e.dataTransfer.getData('application/x-pinned-channel-id') || e.dataTransfer.getData('text/plain');
    if (draggedId) reorderPinned(draggedId, index);
    setDragOverPinnedIndex(null);
  }, [reorderPinned]);

  /** Handler for channel mute option selection */
  const handleMuteOptionSelect = useCallback((channelId: string, duration: ChannelMuteDuration) => {
    setChannelMutedForDuration(channelId, duration);
    setPinContextMenu(null);
    setChannelSubmenu(null);
  }, []);

  /** Handler for channel notification level selection */
  const handleNotificationLevelSelect = useCallback((channelId: string, level: ChannelNotificationLevel) => {
    setChannelNotificationLevel(channelId, level, currentUser?.id);
    setChannelSubmenu(null);
  }, [currentUser?.id]);

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
    const newWidth = Math.min(Math.max(e.clientX - sidebarLeft, 180), 400);
    setWidth(newWidth);
  }, []);

  // Open modal when sidebar context menu requested an action for this server
  useEffect(() => {
    if (!serverContextAction || serverContextAction.serverId !== server.id) return;
    setModalType(serverContextAction.action);
    onClearContextAction?.();
  }, [serverContextAction?.serverId, serverContextAction?.action, server.id, onClearContextAction]);

  // Classic-mode: when ClassicChannelTree's "+" was clicked next to a
  // category, the request is dispatched to uiStore. Open the create-channel
  // modal pre-filled with that category, then clear the request.
  const createChannelRequest = useUiStore(s => s.createChannelRequest);
  useEffect(() => {
    if (!createChannelRequest || createChannelRequest.serverId !== server.id) return;
    setCreateChannelCategoryId(createChannelRequest.categoryId);
    setCreateChannelCategoryName(createChannelRequest.categoryName);
    if (createChannelRequest.initialType) setCreateChannelInitialType(createChannelRequest.initialType === 'forum' ? 'text' : createChannelRequest.initialType);
    setModalType('createChannel');
    useUiStore.getState().setCreateChannelRequest(null);
  }, [createChannelRequest, server.id]);

  // When notifications modal opens, load current prefs from storage
  useEffect(() => {
    if (modalType === 'notifications') setNotificationPrefs(getServerNotificationSettings(server.id, currentUser?.id));
  }, [modalType, server.id]);

  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  useEffect(() => {
    setPinnedChannelIds(getPinnedForServer(server.id));
  }, [server.id]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current && !menuRef.current.contains(target) && !menuPortalRef.current?.contains(target)) setIsMenuOpen(false);
      if (textDropdownRef.current && !textDropdownRef.current.contains(target) && !textDropdownPortalRef.current?.contains(target)) setTextDropdownOpen(false);
      if (voiceDropdownRef.current && !voiceDropdownRef.current.contains(target) && !voiceDropdownPortalRef.current?.contains(target)) setVoiceDropdownOpen(false);
      if (pinContextMenu && pinContextMenuRef.current && !pinContextMenuRef.current.contains(target) && !channelSubmenuRef.current?.contains(target)) {
        setPinContextMenu(null);
        setChannelSubmenu(null);
      }
      if (categoryContextMenu && categoryContextMenuRef.current && !categoryContextMenuRef.current.contains(target)) {
        setCategoryContextMenu(null);
      }
      if (expandedPinnedCategory) { setExpandedPinnedCategory(null); setPinnedCatPillRect(null); }
      if (addMenuOpen && addMenuRef.current && !addMenuRef.current.contains(target) && !addMenuButtonRef.current?.contains(target)) setAddMenuOpen(false);
    };
    if (isMenuOpen || textDropdownOpen || voiceDropdownOpen || pinContextMenu || channelSubmenu || categoryContextMenu || expandedPinnedCategory || addMenuOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen, textDropdownOpen, voiceDropdownOpen, pinContextMenu, channelSubmenu, categoryContextMenu, expandedPinnedCategory]);

  // Classic-mode signal: open the server menu anchored to the supplied rect
  // (the chevron in ChannelPanelAside's extended pill, since the deck bar is
  // hidden in Classic). Only the deck layout consumes this so the sidebar
  // variants in DM/home contexts aren't affected.
  const serverMenuOpenAnchor = useUiStore(s => s.serverMenuOpenAnchor);
  const lastSeenAnchorRef = useRef(serverMenuOpenAnchor);
  const wasMenuOpenRef = useRef(false);
  useEffect(() => {
    if (layout !== 'deck') return;
    const prev = lastSeenAnchorRef.current;
    if (serverMenuOpenAnchor && !prev) setIsMenuOpen(true);
    if (!serverMenuOpenAnchor && prev) setIsMenuOpen(false);
    lastSeenAnchorRef.current = serverMenuOpenAnchor;
  }, [layout, serverMenuOpenAnchor]);
  useEffect(() => {
    if (layout !== 'deck') return;
    if (wasMenuOpenRef.current && !isMenuOpen && useUiStore.getState().serverMenuOpenAnchor) {
      useUiStore.getState().setServerMenuOpenAnchor(null);
    }
    wasMenuOpenRef.current = isMenuOpen;
  }, [layout, isMenuOpen]);

  const closeModal = () => {
    setModalType(null);
    setTempServerName(server.name);
    setNewCategoryName('');
    setCategoryCreateError(null);
    setCreateChannelCategoryId(null);
    setCreateChannelCategoryName(null);
    setRenamingCategory(null);
    setRenameCategoryName('');
    setRenameCategoryError(null);
    setDeletingCategory(null);
    setDeleteCategoryError(null);
    // Refetch members when closing settings so the right-hand member list shows latest role colors/styles
    onRolesUpdated?.();
  };

  const MenuItem = ({ icon: Icon, label, colorClass = "text-t-secondary", onClick }: { icon: React.ComponentType<{ size?: number; className?: string }>, label: string, colorClass?: string, onClick?: () => void }) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
        setIsMenuOpen(false);
      }}
      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-fill-hover transition-all group/item ${colorClass}`}
    >
      <span className="text-[12px] font-medium group-hover/item:translate-x-1 transition-transform">{label}</span>
      <Icon size={14} className="opacity-40 group-hover/item:opacity-100 transition-opacity" />
    </button>
  );

  const renderModal = () => {
    if (!modalType) return null;

    if (modalType === 'settings') {
      return createPortal(
        <Suspense fallback={null}>
        <ServerSettingsPopup
          server={server}
          memberCount={serverMembers.length || otherServerMembers.length + 1}
          serverMembers={serverMembers}
          onClose={() => { setInitialSettingsSection(undefined); closeModal(); }}
          initialSection={initialSettingsSection}
          onUpdateServer={onUpdateServer}
          onCreateInvite={onCreateInvite}
          onDeleteInvite={onDeleteInvite}
          onUpdateInvite={onUpdateInvite}
          getServerInvites={getServerInvites}
          getServerRoles={getServerRoles}
          onUpdateRole={onUpdateRole}
          onCreateRole={onCreateRole}
          onDeleteRole={onDeleteRole}
          onAddMemberToRole={onAddMemberToRole}
          onRemoveMemberFromRole={onRemoveMemberFromRole}
          onRolesUpdated={onRolesUpdated}
          onKickMember={onKickMember}
          getMemberModView={getMemberModView}
          onLeaveServer={onLeaveServer}
          onTransferOwnershipAndLeave={onTransferOwnershipAndLeave}
          onDeleteServer={onDeleteServer}
          otherServerMembers={otherServerMembers}
          currentUserId={currentUser?.id}
          onCreateChannel={onCreateChannel}
          onUpdateChannel={onUpdateChannel}
          onDeleteChannel={onDeleteChannel ? async (_sid: string, chId: string) => { const ch = server.channels.find(c => c.id === chId); if (ch) onDeleteChannel(ch); } : undefined}
          onCreateCategory={onCreateCategory}
          onUpdateCategory={onUpdateCategory}
          onDeleteCategory={onDeleteCategory}
          onReorderChannels={onReorderChannels}
          onReorderCategories={onReorderCategories}
        />
        </Suspense>,
        document.body
      );
    }

    if (modalType === 'createChannel') {
      const defaultCatId = createChannelCategoryId ?? categories[0]?.id ?? '';
      const defaultCatName = createChannelCategoryName ?? categories[0]?.name ?? '';
      return (
        <CreateChannelModal
          isOpen
          onClose={closeModal}
          initialType={createChannelInitialType}
          categoryId={defaultCatId}
          categoryName={defaultCatName}
          categories={categories}
          hasRolePicker={server.channels.some((c) => c.type === 'role_picker')}
          onCreateChannel={async (name, type, categoryId, isPrivate) => {
            if (onCreateChannel) {
              // createChannel applies its own optimistic store update;
              // no onUpdateServer(...) PATCH round-trip needed here.
              await onCreateChannel(server.id, name, type, categoryId, isPrivate);
              closeModal();
              return;
            }
            if (!onUpdateServer) return;
            const newChannel: Channel = {
              id: crypto.randomUUID(),
              name: name.toLowerCase().replace(/\s+/g, '-'),
              type,
              categoryId: categoryId ?? null,
              position: 0,
            };
            onUpdateServer({ ...server, channels: [...server.channels, newChannel] });
            closeModal();
          }}
        />
      );
    }

    if (modalType === 'createCategory') {
      const title = t('sidebar.createCategory');
      const content = (
        <div className="space-y-6">
          <div>
            <label className="text-[11px] font-medium text-t-secondary mb-2 block">{t('categories.categoryName')}</label>
            <input
              autoFocus
              type="text"
              value={newCategoryName}
              onChange={e => setNewCategoryName(e.target.value)}
              placeholder={t('categories.newCategoryPlaceholder')}
              className="w-full bg-black/40 border border-[var(--glass-border)] rounded-xl px-5 py-3 text-sm text-t-primary focus:border-[var(--cyan-accent)]/50 outline-none mono"
              onKeyDown={e => { if (e.key === 'Enter' && newCategoryName.trim()) handleCategoryCreate(); }}
            />
          </div>
          {categoryCreateError && <p className="text-xs text-red-400 -mt-1 mb-1">{categoryCreateError}</p>}
          <button
            type="button"
            disabled={!newCategoryName.trim()}
            onClick={(e) => { e.stopPropagation(); handleCategoryCreate(); }}
            className="btn-cta w-full py-3 font-semibold text-sm rounded-xl transition-all disabled:opacity-30"
          >
            {t('categories.createCategory')}
          </button>
        </div>
      );
      return createPortal(
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={closeModal} />
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl relative spring-pop-in bg-panel border-default" onClick={(e) => e.stopPropagation()}>
             <div className="p-6 pb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-tight text-t-primary">{title}</h2>
                <button onClick={closeModal} className="p-2 hover:bg-fill-hover transition-colors rounded-lg text-t-secondary"><X size={18} /></button>
             </div>
             <div className="p-6 pt-2">{content}</div>
          </div>
        </div>,
        document.body
      );
    }

    if (modalType === 'renameCategory' && renamingCategory) {
      const title = t('categories.renameCategory');
      const content = (
        <div className="space-y-6">
          <div>
            <label className="text-[11px] font-medium text-t-secondary mb-2 block">{t('categories.categoryName')}</label>
            <input
              autoFocus
              type="text"
              value={renameCategoryName}
              onChange={e => setRenameCategoryName(e.target.value)}
              placeholder={renamingCategory.name}
              className="w-full bg-black/40 border border-[var(--glass-border)] rounded-xl px-5 py-3 text-sm text-t-primary focus:border-[var(--cyan-accent)]/50 outline-none mono"
              onKeyDown={e => { if (e.key === 'Enter' && renameCategoryName.trim() && renameCategoryName.trim() !== renamingCategory.name) handleCategoryRename(); }}
            />
          </div>
          {renameCategoryError && <p className="text-xs text-red-400 -mt-1 mb-1">{renameCategoryError}</p>}
          <button
            type="button"
            disabled={!renameCategoryName.trim() || renameCategoryName.trim() === renamingCategory.name}
            onClick={(e) => { e.stopPropagation(); handleCategoryRename(); }}
            className="btn-cta w-full py-3 font-semibold text-sm rounded-xl transition-all disabled:opacity-30"
          >
            {t('categories.renameCategory')}
          </button>
        </div>
      );
      return createPortal(
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={closeModal} />
          <div className="w-full max-w-lg max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl relative spring-pop-in bg-panel border-default" onClick={(e) => e.stopPropagation()}>
             <div className="p-6 pb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold tracking-tight text-t-primary">{title}</h2>
                <button onClick={closeModal} className="p-2 hover:bg-fill-hover transition-colors rounded-lg text-t-secondary"><X size={18} /></button>
             </div>
             <div className="p-6 pt-2">{content}</div>
          </div>
        </div>,
        document.body
      );
    }

    if (modalType === 'deleteCategory' && deletingCategory) {
      const channelsInCategory = server.channels.filter(c => c.categoryId === deletingCategory.id);
      return createPortal(
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={closeModal} />
          <div className="w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl border shadow-2xl relative spring-pop-in bg-panel border-default" onClick={(e) => e.stopPropagation()}>
            <div className="p-6 pb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-t-primary">{t('categories.deleteTitle', { name: deletingCategory.name })}</h2>
              <button onClick={closeModal} className="p-2 hover:bg-fill-hover transition-colors rounded-lg text-t-secondary"><X size={18} /></button>
            </div>
            <div className="p-6 pt-2 space-y-5">
              <p className="text-sm text-t-secondary">
                {channelsInCategory.length > 0
                  ? t('categories.deleteConfirmWithChannels', { count: channelsInCategory.length })
                  : t('categories.deleteEmpty')}
              </p>
              {deleteCategoryError && <p className="text-xs text-red-400">{deleteCategoryError}</p>}
              <div className="flex gap-3">
                <button type="button" onClick={closeModal}
                  className="flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors hover:bg-fill-hover text-t-secondary bg-fill-hover">
                  {t('common.cancel')}
                </button>
                <button type="button"
                  onClick={async () => {
                    try {
                      setDeleteCategoryError(null);
                      await onDeleteCategory?.(server.id, deletingCategory.id);
                      setDeletingCategory(null);
                      closeModal();
                    } catch (e) {
                      setDeleteCategoryError(e instanceof Error ? e.message : 'Failed to delete category.');
                    }
                  }}
                  className="btn-cta-danger flex-1 py-2.5 rounded-xl text-sm font-semibold transition-colors">
                  {t('categories.deleteCategory')}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      );
    }

    if (modalType === 'invite') {
      const activeChannel = activeChannelId ? server.channels.find(c => c.id === activeChannelId) : null;
      return (
        <InviteModal
          isOpen
          onClose={closeModal}
          serverId={server.id}
          serverName={server.name}
          channelName={activeChannel?.name ?? server.channels.find(c => c.type === 'text')?.name ?? 'general'}
          friends={homeFriends}
          serverMemberIds={serverMemberIdSet}
          hasCreateInvitePermission={canCreateInvite}
          hasManageServerPermission={serverHasPerm(server, 'manageServer')}
          onOpenServerSettings={() => {
            closeModal();
            setInitialSettingsSection('invites');
            setModalType('settings');
          }}
        />
      );
    }

    if (modalType === 'leave') {
      return (
        <LeaveServerModal
          isOpen
          onClose={closeModal}
          server={server}
          isAdmin={isAdmin}
          otherServerMembers={otherServerMembers}
          onLeaveServer={onLeaveServer}
          onTransferOwnershipAndLeave={onTransferOwnershipAndLeave}
          onDeleteServer={onDeleteServer}
        />
      );
    }

    let content: React.ReactNode;
    let title: string;
    switch (modalType) {
      case 'notifications':
        title = t('sidebar.notificationSettings');
        content = (
          <div className="space-y-6">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider mb-3 text-t-secondary">{t('channels.notificationLevel')}</p>
              <div className="space-y-2">
                {(['all', 'mentions', 'none'] as const).map((level) => (
                  <label key={level} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover cursor-pointer border border-transparent hover:border-[var(--glass-border)]">
                    <span className="text-sm text-t-primary">
                      {level === 'all' ? t('sidebar.allMessages') : level === 'mentions' ? t('sidebar.onlyMentions') : t('sidebar.nothing')}
                    </span>
                    <input
                      type="radio"
                      name="notification-level"
                      checked={notificationPrefs.level === level}
                      onChange={() => {
                        const next = { ...notificationPrefs, level };
                        setNotificationPrefs(next);
                        setServerNotificationSettings(server.id, next, currentUser?.id);
                      }}
                      className="w-4 h-4 rounded-full border-2 border-[var(--cyan-accent)]/50 text-[var(--cyan-accent)] focus:ring-[var(--cyan-accent)]/30"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="h-px bg-[var(--glass-border)]" />
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider mb-3 text-t-secondary">{t('channels.suppression')}</p>
              <div className="space-y-2">
                {[
                  { key: 'suppressEveryone' as const, label: t('channels.suppressEveryone') },
                  { key: 'suppressRoleMentions' as const, label: t('channels.suppressAllRoles') },
                  { key: 'suppressHighlights' as const, label: t('channels.suppressHighlights') },
                  { key: 'muteNewEvents' as const, label: t('channels.muteNewEvents') },
                ].map(({ key, label }) => (
                  <label key={key} className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover cursor-pointer">
                    <span className="text-sm text-t-primary">{label}</span>
                    <input
                      type="checkbox"
                      checked={notificationPrefs[key]}
                      onChange={(e) => {
                        const next = { ...notificationPrefs, [key]: e.target.checked };
                        setNotificationPrefs(next);
                        setServerNotificationSettings(server.id, next, currentUser?.id);
                      }}
                      className="w-4 h-4 rounded-lg border-[var(--border-strong)] text-[var(--cyan-accent)] focus:ring-[var(--cyan-accent)]/30"
                    />
                  </label>
                ))}
              </div>
            </div>
            <div className="h-px bg-[var(--glass-border)]" />
            <div>
              <label className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover cursor-pointer">
                <span className="text-sm text-t-primary">{t('channels.mobilePush')}</span>
                <input
                  type="checkbox"
                  checked={notificationPrefs.mobilePush}
                  onChange={(e) => {
                    const next = { ...notificationPrefs, mobilePush: e.target.checked };
                    setNotificationPrefs(next);
                    setServerNotificationSettings(server.id, next, currentUser?.id);
                  }}
                  className="w-4 h-4 rounded-lg border-[var(--border-strong)] text-[var(--cyan-accent)] focus:ring-[var(--cyan-accent)]/30"
                />
              </label>
            </div>
            <button type="button" onClick={closeModal} className="w-full py-2.5 bg-fill-hover font-semibold text-sm rounded-xl hover:bg-fill-active transition-colors text-t-secondary">
              {t('common.done')}
            </button>
          </div>
        );
        break;
      default:
        title = t('channels.systemMessage');
        content = <div className="text-center py-8 text-sm text-t-secondary">{t('channels.moduleUnderMaintenance')}</div>;
    }

    return createPortal(
      <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 modal-safe-area">
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={closeModal} />
        <div className="modal-responsive rounded-2xl border shadow-2xl relative overflow-hidden spring-pop-in bg-panel border-default" style={{ ['--modal-max-w' as string]: '32rem' }} onClick={(e) => e.stopPropagation()}>
           <div className="p-6 pb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold tracking-tight text-t-primary">{title}</h2>
              <button onClick={closeModal} className="p-2 hover:bg-fill-hover transition-colors rounded-lg text-t-secondary"><X size={18} /></button>
           </div>
           <div className="p-6 pt-2">{content}</div>
        </div>
      </div>,
      document.body
    );
  };

  // Deck layout: single horizontal bar (server + channel tabs + add)
  if (layout === 'deck') {
    return (
      <>
        <div
          className="perf-glass-layer flex items-center flex-1 min-w-0 h-14 px-1 sm:px-4 gap-2 sm:gap-3 border-b"
          style={{
            backgroundColor: 'var(--bg-chat)',
            borderColor: 'var(--border-subtle)',
            boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)',
          }}
        >
          <div className="relative shrink-0" ref={menuRef}>
            <button
              onClick={() => setIsMenuOpen(!isMenuOpen)}
              className={`flex items-center gap-2 px-3 py-2 rounded-xl transition-all ${isMenuOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
            >
              <div className="w-8 h-8 rounded-lg overflow-hidden shrink-0">
                <ServerIcon icon={server.icon} name={server.name} className="rounded-lg" />
              </div>
              <span className="font-semibold text-sm truncate max-w-[140px] text-t-primary">{server.name}</span>
              <ChevronDown size={14} className={`shrink-0 transition-transform ${isMenuOpen ? 'rotate-180' : ''} text-t-secondary`} />
            </button>
            {isMenuOpen && createPortal(
              <div
                ref={(el) => {
                  menuPortalRef.current = el;
                  if (!el) return;
                  // Prefer the Classic-mode chevron anchor if set, else fall
                  // back to the deck button's own rect.
                  if (serverMenuOpenAnchor) {
                    el.style.left = `${serverMenuOpenAnchor.left}px`;
                    el.style.top = `${serverMenuOpenAnchor.bottom + 8}px`;
                  } else if (menuRef.current) {
                    const r = menuRef.current.getBoundingClientRect();
                    el.style.left = `${r.left}px`;
                    el.style.top = `${r.bottom + 8}px`;
                  }
                }}
                className={`fixed z-[var(--z-popover)] py-2 min-w-[200px] animate-in slide-in-from-top-2 fade-in duration-200 ${GLASS_MENU_CLASS} glass`}
              >
                <div className="space-y-0.5 px-1 group">
                  <MenuItem label={t('channels.invitePeople')} icon={UserPlus} colorClass="text-[var(--cyan-accent)]" onClick={() => setModalType('invite')} />
                  <div className="h-px my-2 bg-[var(--border-subtle)]" />
                  {isAdmin && (
                    <MenuItem label={t('sidebar.serverSettings')} icon={Settings} onClick={() => setModalType('settings')} />
                  )}
                  {canManageChannels && (
                    <>
                      <MenuItem label={t('sidebar.createChannel')} icon={Plus} onClick={() => setModalType('createChannel')} />
                      <MenuItem label={t('sidebar.createCategory')} icon={FolderPlus} onClick={() => setModalType('createCategory')} />
                    </>
                  )}
                  <MenuItem label={t('sidebar.createEvent')} icon={Calendar} onClick={() => setModalType('notifications')} />
                  <div className="h-px my-2 bg-[var(--border-subtle)]" />
                  <MenuItem label={t('sidebar.notificationSettings')} icon={Bell} onClick={() => setModalType('notifications')} />
                  <MenuItem label={t('sidebar.privacySettings')} icon={ShieldAlert} onClick={() => setModalType('settings')} />
                  <MenuItem label={t('sidebar.editServerProfile')} icon={UserCircle} onClick={() => { setIsMenuOpen(false); onEditServerProfile?.(server.id); }} />
                  <div className="h-px my-2 bg-[var(--border-subtle)]" />
                  <MenuItem label={t('sidebar.hideMutedChannels')} icon={EyeOff} />
                  <div className="h-px my-2 bg-[var(--border-subtle)]" />
                  <MenuItem label={t('sidebar.leaveServer')} icon={LogOut} colorClass="text-red-500" onClick={() => setModalType('leave')} />
                </div>
              </div>,
              document.body,
            )}
          </div>
          <div className="flex-1 flex items-center gap-2 min-w-0">
            {/* Text channels dropdown - outside overflow so panel is not clipped */}
            <div className="relative shrink-0" ref={textDropdownRef}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setTextDropdownOpen((o) => !o); setVoiceDropdownOpen(false); }}
                className={`flex items-center ${deckBtn} rounded-xl text-sm font-medium transition-all border border-default text-t-primary ${textDropdownOpen ? 'bg-[var(--cyan-accent)]/10' : 'hover:bg-fill-hover'}`}
              >
                <Hash size={14} />
                <span>{t('channels.text')}</span>
                {textNotificationCount > 0 && <span className="text-[10px] opacity-70">({textNotificationCount > 10 ? '10+' : textNotificationCount})</span>}
                <ChevronDown size={12} className={`transition-transform ${textDropdownOpen ? 'rotate-180' : ''} text-t-secondary`} />
              </button>
              {textDropdownOpen && createPortal(
                <div
                  ref={(el) => { textDropdownPortalRef.current = el; if (el && textDropdownRef.current) { const r = textDropdownRef.current.getBoundingClientRect(); const l = Math.min(r.left, window.innerWidth - 248); const t = Math.min(r.bottom + 8, window.innerHeight - 288); el.style.left = `${Math.max(8, l)}px`; el.style.top = `${Math.max(8, t)}px`; }}}
                  className={`fixed z-[var(--z-popover)] w-[240px] max-h-[280px] overflow-y-auto no-scrollbar rounded-2xl border shadow-2xl animate-in slide-in-from-top-2 fade-in duration-200 ${deckDropdownPy}`}
                  style={GLASS_DROPDOWN_STYLE}
                >
                  {textChannelsByCategory.length === 0 || textChannelsByCategory.every(g => g.channels.length === 0) ? (
                    <div className="px-3 py-4 text-sm text-t-secondary">{t('channels.noTextChannels')}</div>
                  ) : (
                    textChannelsByCategory.map((group) => {
                      const isCollapsed = group.category ? collapsedCategories.has(group.category.id) : false;
                      const hasChannels = group.channels.length > 0;
                      if (!hasChannels) return null;
                      return (
                        <div key={group.category?.id ?? '__uncategorized'}>
                          {group.category && (
                          <div className="flex items-center gap-1 px-2.5 py-1.5 group/cat"
                            {...(canManageChannels ? longPressBindings((e) => { e.preventDefault(); e.stopPropagation(); setCategoryContextMenu({ x: e.clientX, y: e.clientY, category: group.category! }); }) : {})}
                          >
                            <button type="button" onClick={(e) => { e.stopPropagation(); toggleCategoryCollapse(group.category!.id); }}
                              className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                              <ChevronDown size={10} className={`shrink-0 transition-transform duration-150 text-t-quaternary ${isCollapsed ? '-rotate-90' : ''}`} />
                              <span className="text-[10px] font-bold uppercase tracking-wider truncate text-t-quaternary">{group.category!.name}</span>
                              {isCollapsed && hasChannels && (() => {
                                const totalMentions = group.channels.reduce((sum, c) => sum + (textChannelMentionCounts[c.id] ?? 0), 0);
                                const hasChildUnread = group.channels.some(c => channelUnreadIds.has(c.id));
                                if (totalMentions > 0) return <span className="ml-auto min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.3)]">{totalMentions > 99 ? '99+' : totalMentions}</span>;
                                if (hasChildUnread) return <div className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--text-primary)] shrink-0 shadow-[0_0_4px_var(--text-primary)]" />;
                                return <span className="text-[9px] shrink-0 text-t-quaternary">{group.channels.length}</span>;
                              })()}
                            </button>
                            {canManageChannels && (
                              <button type="button"
                                onClick={(e) => { e.stopPropagation(); setCreateChannelCategoryId(group.category!.id); setCreateChannelCategoryName(group.category!.name); setCreateChannelInitialType('text'); setModalType('createChannel'); setTextDropdownOpen(false); }}
                                className="p-1.5 rounded-lg hover:bg-fill-hover transition-all shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center text-t-quaternary">
                                <Plus size={14} />
                              </button>
                            )}
                          </div>
                          )}
                          {!isCollapsed && group.channels.map((ch) => {
                            const muted = isChannelMuted(ch.id);
                            const mentionCount = muted ? 0 : (textChannelMentionCounts[ch.id] ?? 0);
                            const hasMention = mentionCount > 0;
                            const hasUnread = !muted && channelUnreadIds.has(ch.id);
                            const threads = (channelThreads[ch.id] ?? EMPTY_THREAD_ARRAY).slice(0, 5);
                            return (
                              <React.Fragment key={ch.id}>
                              <button
                                type="button"
                                className={`group w-full flex items-center gap-2 ${group.category ? 'pl-5 pr-3' : 'px-3'} ${deckItemPy} text-left text-sm rounded-lg transition-colors ${activeChannelId === ch.id ? 'bg-[var(--cyan-accent)]/15 text-t-accent' : 'hover:bg-fill-active text-t-primary'}`}
                                style={{ fontWeight: (hasMention || hasUnread) ? 600 : 400, opacity: muted && activeChannelId !== ch.id ? 0.5 : 1 }}
                                onClick={() => handleTextDropdownSelect(ch.id)}
                                {...longPressBindings((e) => { e.preventDefault(); e.stopPropagation(); setPinContextMenu({ x: e.clientX, y: e.clientY, channel: ch }); })}
                              >
                                {ch.type === 'forum' ? <ForumIcon size={14} className="shrink-0 opacity-70" /> : ch.type === 'role_picker' ? <Tag size={14} className="shrink-0 opacity-70" /> : <Hash size={14} className="shrink-0 opacity-70" />}
                                <span className="truncate flex-1">{ch.name}</span>
                                {isPinned(ch.id) && <Pin size={12} className="shrink-0 opacity-60" />}
                                {hasMention ? (
                                  <span className="min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.3)]">{mentionCount > 99 ? '99+' : mentionCount}</span>
                                ) : hasUnread ? (
                                  <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)] shrink-0 shadow-[0_0_4px_var(--text-primary)]" />
                                ) : null}
                                {serverHasPerm(server, 'manageChannels') && (
                                  <div
                                    role="button"
                                    tabIndex={0}
                                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); closeAllOverlays(); setChannelSettingsTarget(ch); }}
                                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); closeAllOverlays(); setChannelSettingsTarget(ch); } }}
                                    className="opacity-0 group-hover:opacity-100 ml-auto p-1 rounded-lg hover:bg-fill-hover transition-all cursor-pointer"
                                    title={t('channels.editChannel')}
                                  >
                                    <Settings size={12} className="text-t-quaternary" />
                                  </div>
                                )}
                              </button>
                              {threads.map((thread) => {
                                const threadUnread = unreadThreadIds?.has(thread.id);
                                const threadCount = unreadThreadCounts[thread.id] ?? 0;
                                const tMentionCount = threadMentionCounts[thread.id] ?? 0;
                                return (
                                  <button
                                    key={thread.id}
                                    type="button"
                                    className={`w-full flex items-center gap-2 ${group.category ? 'pl-8' : 'pl-6'} pr-3 py-1.5 text-left text-sm rounded-lg transition-colors ${activeThreadId === thread.id ? 'bg-[var(--cyan-accent)]/15 text-t-accent' : 'hover:bg-fill-active text-t-secondary'}`}
                                    onClick={() => { onThreadSelect?.(thread); setTextDropdownOpen(false); }}
                                  >
                                    <MessageCirclePlus size={12} className="shrink-0 opacity-60" />
                                    <span className="truncate flex-1">{thread.name}</span>
                                    {tMentionCount > 0 ? (
                                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full shrink-0 bg-red-500 text-white shadow-[0_0_6px_rgba(239,68,68,0.3)]">{tMentionCount > 99 ? '99+' : tMentionCount}</span>
                                    ) : threadUnread && threadCount > 0 ? (
                                      <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full shrink-0 bg-fill-strong text-t-primary">{threadCount > 99 ? '99+' : threadCount}</span>
                                    ) : null}
                                  </button>
                                );
                              })}
                              </React.Fragment>
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                  {canManageChannels && (
                    <>
                      <div className="h-px my-1 mx-2 bg-[var(--border-subtle)]" />
                      <div className="flex gap-1 px-1.5 pb-1">
                        <button type="button" onClick={() => { setCreateChannelInitialType('text'); setCreateChannelCategoryId(null); setCreateChannelCategoryName(null); setModalType('createChannel'); setTextDropdownOpen(false); }}
                          className="btn-secondary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] min-h-[36px]">
                          <Hash size={11} /> {t('channels.text')}
                        </button>
                        <button type="button" onClick={() => { setModalType('createCategory'); setTextDropdownOpen(false); }}
                          className="btn-secondary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] min-h-[36px]">
                          <FolderOpen size={11} /> {t('sidebar.createCategory')}
                        </button>
                      </div>
                    </>
                  )}
                </div>,
                document.body,
              )}
            </div>
            {/* Voice channels dropdown */}
            <div className="relative shrink-0" ref={voiceDropdownRef}>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setVoiceDropdownOpen((o) => !o); setTextDropdownOpen(false); }}
                className={`flex items-center ${deckBtn} rounded-xl text-sm font-medium transition-all border border-default text-t-primary ${voiceDropdownOpen ? 'bg-emerald-500/10' : 'hover:bg-fill-hover'}`}
              >
                <Volume2 size={14} />
                <span>{t('channels.voice')}</span>
                {connectedVoiceChannelId && (
                  <div className="w-2 h-2 rounded-full bg-emerald-400 shrink-0" style={{ boxShadow: '0 0 6px rgba(52,211,153,0.5)' }} />
                )}
                {totalVoiceParticipants > 0 && <span className="text-[10px] opacity-70">({totalVoiceParticipants > 10 ? '10+' : totalVoiceParticipants})</span>}
                <ChevronDown size={12} className={`transition-transform ${voiceDropdownOpen ? 'rotate-180' : ''} text-t-secondary`} />
              </button>
              {voiceDropdownOpen && createPortal(
                <div
                  ref={(el) => { voiceDropdownPortalRef.current = el; if (el && voiceDropdownRef.current) { const r = voiceDropdownRef.current.getBoundingClientRect(); const l = Math.min(r.left, window.innerWidth - 268); const t = Math.min(r.bottom + 8, window.innerHeight - 368); el.style.left = `${Math.max(8, l)}px`; el.style.top = `${Math.max(8, t)}px`; }}}
                  className={`fixed z-[var(--z-popover)] w-[260px] max-h-[360px] overflow-y-auto no-scrollbar rounded-2xl border shadow-2xl animate-in slide-in-from-top-2 fade-in duration-200 ${deckDropdownPy}`}
                  style={GLASS_DROPDOWN_STYLE}
                >
                  {voiceChannelsByCategory.length === 0 || voiceChannelsByCategory.every(g => g.channels.length === 0) ? (
                    <div className="px-3 py-4 text-sm text-t-secondary">{t('channels.noVoiceChannels')}</div>
                  ) : (
                    voiceChannelsByCategory.map((group) => {
                      const isCollapsed = group.category ? collapsedCategories.has(group.category.id) : false;
                      const hasChannels = group.channels.length > 0;
                      if (!hasChannels) return null;
                      return (
                        <div key={group.category?.id ?? '__uncategorized_voice'}>
                          {group.category && (
                          <div className="flex items-center gap-1 px-2.5 py-1.5 group/cat"
                            {...(canManageChannels ? longPressBindings((e) => { e.preventDefault(); e.stopPropagation(); setCategoryContextMenu({ x: e.clientX, y: e.clientY, category: group.category! }); }) : {})}
                          >
                            <button type="button" onClick={(e) => { e.stopPropagation(); toggleCategoryCollapse(group.category!.id); }}
                              className="flex items-center gap-1.5 flex-1 min-w-0 text-left">
                              <ChevronDown size={10} className={`shrink-0 transition-transform duration-150 text-t-quaternary ${isCollapsed ? '-rotate-90' : ''}`} />
                              <span className="text-[10px] font-bold uppercase tracking-wider truncate text-t-quaternary">{group.category!.name}</span>
                              {isCollapsed && hasChannels && (() => {
                                const totalMentions = group.channels.reduce((sum, c) => sum + (textChannelMentionCounts[c.id] ?? 0), 0);
                                const hasChildUnread = group.channels.some(c => channelUnreadIds.has(c.id));
                                if (totalMentions > 0) return <span className="ml-auto min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.3)]">{totalMentions > 99 ? '99+' : totalMentions}</span>;
                                if (hasChildUnread) return <div className="ml-auto w-1.5 h-1.5 rounded-full bg-[var(--text-primary)] shrink-0 shadow-[0_0_4px_var(--text-primary)]" />;
                                return <span className="text-[9px] shrink-0 text-t-quaternary">{group.channels.length}</span>;
                              })()}
                            </button>
                            {canManageChannels && (
                              <button type="button"
                                onClick={(e) => { e.stopPropagation(); setCreateChannelCategoryId(group.category!.id); setCreateChannelCategoryName(group.category!.name); setCreateChannelInitialType('voice'); setModalType('createChannel'); setVoiceDropdownOpen(false); }}
                                className="p-1.5 rounded-lg hover:bg-fill-hover transition-all shrink-0 min-w-[28px] min-h-[28px] flex items-center justify-center text-t-quaternary">
                                <Plus size={14} />
                              </button>
                            )}
                          </div>
                          )}
                          {!isCollapsed && group.channels.map((ch) => {
                            const participants = voiceParticipantsByChannel[ch.id] ?? EMPTY_PARTICIPANT_ARRAY;
                            const muted = isChannelMuted(ch.id);
                            const mentionCount = muted ? 0 : (textChannelMentionCounts[ch.id] ?? 0);
                            const hasMention = mentionCount > 0;
                            const hasUnread = !muted && channelUnreadIds.has(ch.id);
                            return (
                              <button
                                key={ch.id}
                                type="button"
                                className={`group w-full flex flex-col items-stretch ${deckVoiceParticipantGap} ${group.category ? 'pl-5 pr-3' : 'px-3'} ${deckItemPy} text-left rounded-lg transition-colors ${activeChannelId === ch.id ? 'bg-emerald-500/15 text-emerald-400' : 'hover:bg-fill-active text-t-primary'}`}
                                style={{ fontWeight: (hasMention || hasUnread) ? 600 : 400, opacity: muted && activeChannelId !== ch.id ? 0.5 : 1 }}
                                onClick={() => handleVoiceDropdownSelect(ch.id)}
                                {...longPressBindings((e) => { e.preventDefault(); e.stopPropagation(); setPinContextMenu({ x: e.clientX, y: e.clientY, channel: ch }); })}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <Volume2 size={14} className="shrink-0 opacity-70" />
                                  <span className="truncate flex-1 text-sm">{ch.name}</span>
                                  {ch.id === connectedVoiceChannelId && (
                                    <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-lg shrink-0" style={{ backgroundColor: 'rgba(52,211,153,0.12)', color: '#34d399' }}>
                                      {t('voice.connected', 'Connected')}
                                    </span>
                                  )}
                                  {participants.length > 0 && <span className="text-[10px] opacity-80 shrink-0">{participants.length}</span>}
                                  {hasMention ? (
                                    <span className="min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0 shadow-[0_0_8px_rgba(239,68,68,0.3)]">{mentionCount > 99 ? '99+' : mentionCount}</span>
                                  ) : hasUnread ? (
                                    <div className="w-1.5 h-1.5 rounded-full bg-[var(--text-primary)] shrink-0 shadow-[0_0_4px_var(--text-primary)]" />
                                  ) : null}
                                  {isPinned(ch.id) && <Pin size={12} className="shrink-0 opacity-60" />}
                                  {serverHasPerm(server, 'manageChannels') && (
                                    <div
                                      role="button"
                                      tabIndex={0}
                                      onClick={(e) => { e.stopPropagation(); e.preventDefault(); closeAllOverlays(); setChannelSettingsTarget(ch); }}
                                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); closeAllOverlays(); setChannelSettingsTarget(ch); } }}
                                      className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-fill-hover transition-all shrink-0 cursor-pointer"
                                      title={t('channels.editChannel')}
                                    >
                                      <Settings size={12} className="text-t-quaternary" />
                                    </div>
                                  )}
                                </div>
                                {participants.length > 0 && (
                                  <div className={`flex flex-col ${deckVoiceParticipantGap} pl-8`}>
                                    {participants.map((p) => {
                                      const isPro = p.effectivePlan === 'pro' || p.effectivePlan === 'essential';
                                      const hasProStyle = isPro && (p.nameColor || p.nameFont || p.nameEffect);
                                      return (
                                      <div key={p.id} className="flex items-center gap-1.5 min-w-0">
                                        <LetterAvatar avatar={p.avatar} username={p.username} size={16} className="rounded-full" />
                                        {hasProStyle ? (
                                          <RoleNameStyle name={p.username} overrideColor={p.nameColor} overrideFont={p.nameFont} nameEffect={p.nameEffect} className="text-[11px] truncate" />
                                        ) : (
                                          <span className="text-[11px] truncate opacity-90">{p.username}</span>
                                        )}
                                        {p.isScreenSharing && (
                                          <button
                                            type="button"
                                            onClick={(e) => { e.stopPropagation(); handleWatchScreen(ch.id, p.id); }}
                                            className="ml-auto p-0.5 rounded-lg text-emerald-400 hover:bg-emerald-500/20 transition-colors shrink-0"
                                            title={`Watch ${p.username}'s stream`}
                                            aria-label={`Watch ${p.username}'s stream`}
                                          >
                                            <Monitor size={11} />
                                          </button>
                                        )}
                                      </div>
                                      );
                                    })}
                                  </div>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })
                  )}
                  {/* Stage channels */}
                  {stageChannels.length > 0 && (
                    <>
                      <div className="h-px my-1 mx-2 bg-[var(--border-subtle)]" />
                      <div className="px-2.5 py-1">
                        <span className="text-[9px] font-bold uppercase tracking-wider text-t-quaternary">{t('stages.stage')}</span>
                      </div>
                      {stageChannels.map((ch) => {
                        const stageSession = activeStageSessions[ch.id];
                        const isConnected = connectedStageChannelId === ch.id;
                        return (
                          <button
                            key={ch.id}
                            type="button"
                            className={`group w-full flex items-center gap-2 px-3 ${deckItemPy} text-left text-sm rounded-lg transition-colors ${isConnected ? 'bg-[var(--cyan-accent)]/15 text-t-accent' : 'hover:bg-fill-active text-t-primary'}`}
                            onClick={() => { handleStageChannelSelect(ch.id); setVoiceDropdownOpen(false); }}
                            onMouseEnter={preconnectLiveKit}
                            onFocus={preconnectLiveKit}
                            {...longPressBindings((e) => { e.preventDefault(); e.stopPropagation(); setPinContextMenu({ x: e.clientX, y: e.clientY, channel: ch }); })}
                          >
                            <Radio size={14} className="shrink-0 opacity-70" />
                            <span className="truncate flex-1">{ch.name}</span>
                            {stageSession && (
                              <span className="flex items-center gap-1 shrink-0">
                                <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
                                <span className="text-[10px] text-[var(--text-tertiary)]">{stageSession.speakers.length}/{stageSession.maxSpeakers}</span>
                              </span>
                            )}
                            {serverHasPerm(server, 'manageChannels') && (
                              <div
                                role="button"
                                tabIndex={0}
                                onClick={(e) => { e.stopPropagation(); e.preventDefault(); closeAllOverlays(); setChannelSettingsTarget(ch); }}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); closeAllOverlays(); setChannelSettingsTarget(ch); } }}
                                className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-fill-hover transition-all shrink-0 cursor-pointer"
                                title={t('channels.editChannel')}
                              >
                                <Settings size={12} className="text-t-quaternary" />
                              </div>
                            )}
                          </button>
                        );
                      })}
                    </>
                  )}
                  {canManageChannels && (
                    <>
                      <div className="h-px my-1 mx-2 bg-[var(--border-subtle)]" />
                      <div className="flex gap-1 px-1.5 pb-1">
                        <button type="button" onClick={() => { setCreateChannelInitialType('voice'); setCreateChannelCategoryId(null); setCreateChannelCategoryName(null); setModalType('createChannel'); setVoiceDropdownOpen(false); }}
                          className="btn-secondary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] min-h-[36px]">
                          <Volume2 size={11} /> {t('channels.voice')}
                        </button>
                        <button type="button" onClick={() => { setModalType('createCategory'); setVoiceDropdownOpen(false); }}
                          className="btn-secondary flex-1 flex items-center justify-center gap-1.5 py-2.5 text-[11px] min-h-[36px]">
                          <FolderOpen size={11} /> {t('sidebar.createCategory')}
                        </button>
                      </div>
                    </>
                  )}
                </div>,
                document.body,
              )}
            </div>
            {/* Pinned categories + channels: to the right of Text and Voice dropdowns */}
            {!isMobile && (
            <div className={`flex items-center overflow-x-auto no-scrollbar min-w-0 shrink flex-1 ${deckPinnedGap}`}>
              {/* Pinned category folder pills */}
              {pinnedCategoryIds.map(catId => {
                const cat = categories.find(c => c.id === catId);
                if (!cat) return null;
                const catChannels = server.channels.filter(ch => ch.categoryId === cat.id).sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
                return (
                  <div key={`cat-${cat.id}`} className="relative shrink-0">
                    <button
                      type="button"
                      onClick={(e) => { const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); setPinnedCatPillRect(rect); setExpandedPinnedCategory(prev => prev === cat.id ? null : cat.id); }}
                      className={`flex items-center gap-1.5 ${deckPinnedPill} rounded-lg text-sm font-medium cursor-pointer select-none border transition-colors text-t-primary ${expandedPinnedCategory === cat.id ? 'bg-fill-active border-[var(--glass-border)]' : 'hover:bg-fill-hover border-[var(--border-subtle)]'}`}
                      {...(canManageChannels ? longPressBindings((e) => { e.preventDefault(); setCategoryContextMenu({ x: e.clientX, y: e.clientY, category: cat }); }) : {})}
                    >
                      <FolderOpen size={12} className="shrink-0 opacity-60" />
                      <span className="truncate max-w-[100px]">{cat.name}</span>
                      <ChevronDown size={10} className={`shrink-0 opacity-40 transition-transform ${expandedPinnedCategory === cat.id ? 'rotate-180' : ''}`} />
                    </button>
                    {expandedPinnedCategory === cat.id && pinnedCatPillRect && createPortal(
                      <div
                        className={`fixed z-[var(--z-popover)] w-[200px] max-h-[240px] overflow-y-auto no-scrollbar rounded-xl border shadow-xl ${deckDropdownPy}`}
                        style={{ ...GLASS_DROPDOWN_STYLE, left: Math.max(8, Math.min(pinnedCatPillRect.left, window.innerWidth - 208)), top: pinnedCatPillRect.bottom + 6 }}
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        {catChannels.map(ch => {
                          const isText = ch.type === 'text' || ch.type === 'forum' || ch.type === 'role_picker';
                          const isActive = activeChannelId === ch.id;
                          return (
                            <button
                              key={ch.id}
                              type="button"
                              onClick={() => { if (ch.type === 'stage') { handleStageChannelSelect(ch.id); } else if (isText) { handleTextDropdownSelect(ch.id); } else { handleVoiceDropdownSelect(ch.id); } setExpandedPinnedCategory(null); setPinnedCatPillRect(null); }}
                              className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm rounded-lg transition-colors ${isActive ? (isText ? 'bg-[var(--cyan-accent)]/15 text-t-accent' : 'bg-emerald-500/15 text-emerald-400') : 'hover:bg-fill-active text-t-secondary'}`}
                            >
                              {ch.type === 'forum' ? <ForumIcon size={12} /> : ch.type === 'stage' ? <Radio size={12} /> : ch.type === 'role_picker' ? <Tag size={12} /> : isText ? <Hash size={12} /> : <Volume2 size={12} />}
                              <span className="truncate">{ch.name}</span>
                            </button>
                          );
                        })}
                        {catChannels.length === 0 && (
                          <div className="px-3 py-2 text-xs text-t-secondary">{t('categories.emptyCategory')}</div>
                        )}
                      </div>,
                      document.body
                    )}
                  </div>
                );
              })}
              {/* Pinned channel pills */}
              {pinnedChannelsOrdered.map((ch, index) => {
                const isText = ch.type === 'text' || ch.type === 'forum' || ch.type === 'role_picker';
                const participants = isText ? EMPTY_PARTICIPANT_ARRAY : (voiceParticipantsByChannel[ch.id] ?? EMPTY_PARTICIPANT_ARRAY);
                const isDragging = draggingPinnedId === ch.id;
                const isDropTarget = dragOverPinnedIndex === index;
                const setDragGhost = (ev: React.DragEvent, channel: Channel, isTextChannel: boolean) => {
                  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
                  const ghost = document.createElement('div');
                  ghost.setAttribute('data-drag-ghost', 'true');
                  ghost.style.cssText = [
                    'position:absolute; left:-9999px; top:0;',
                    'display:flex; align-items:center; gap:6px;',
                    'padding:6px 10px; border-radius:8px; font-size:14px; font-weight:500;',
                    'white-space:nowrap; max-width:140px; overflow:hidden; text-overflow:ellipsis;',
                    'box-shadow:0 12px 28px rgba(0,0,0,0.35), 0 0 0 1px var(--border-subtle);',
                    'transform:scale(1.05); opacity:0.98;',
                    'pointer-events:none;',
                    isTextChannel ? 'background:color-mix(in srgb, var(--cyan-accent) 18%, transparent); color:var(--cyan-accent);' : 'background:rgba(16, 185, 129, 0.18); color:rgb(52, 211, 153);',
                  ].join(' ');
                  const svgNS = 'http://www.w3.org/2000/svg';
                  const svg = document.createElementNS(svgNS, 'svg');
                  svg.setAttribute('width', '12');
                  svg.setAttribute('height', '12');
                  svg.setAttribute('viewBox', '0 0 24 24');
                  svg.setAttribute('fill', 'none');
                  svg.setAttribute('stroke', 'currentColor');
                  svg.setAttribute('stroke-width', '2');
                  if (isTextChannel) {
                    const p1 = document.createElementNS(svgNS, 'path');
                    p1.setAttribute('d', 'M5 3v18h14V3H5z');
                    const p2 = document.createElementNS(svgNS, 'path');
                    p2.setAttribute('d', 'M9 8h6M9 12h6M9 16h4');
                    svg.appendChild(p1);
                    svg.appendChild(p2);
                  } else {
                    const poly = document.createElementNS(svgNS, 'polygon');
                    poly.setAttribute('points', '11 5 6 9 2 9 2 15 6 15 11 19 11 5');
                    const p1 = document.createElementNS(svgNS, 'path');
                    p1.setAttribute('d', 'M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14');
                    svg.appendChild(poly);
                    svg.appendChild(p1);
                  }
                  const icon = document.createElement('span');
                  icon.appendChild(svg);
                  ghost.appendChild(icon);
                  const nameSpan = document.createElement('span');
                  nameSpan.textContent = channel.name;
                  ghost.appendChild(nameSpan);
                  if (!isTextChannel && participants.length > 0) {
                    const countSpan = document.createElement('span');
                    countSpan.style.fontSize = '10px';
                    countSpan.style.opacity = '0.8';
                    countSpan.textContent = `(${participants.length})`;
                    ghost.appendChild(countSpan);
                  }
                  document.body.appendChild(ghost);
                  dragGhostRef.current = ghost;
                  ev.dataTransfer.setDragImage(ghost, Math.round(rect.width / 2), Math.round(rect.height / 2));
                };
                return (
                  <div
                    key={ch.id}
                    draggable
                    onDragStart={(e) => { handlePinnedDragStart(e, ch.id); setDragGhost(e, ch, isText); }}
                    onDragEnd={handlePinnedDragEnd}
                    onDragOver={(e) => handlePinnedDragOver(e, ch.id, index)}
                    onDragLeave={handlePinnedDragLeave}
                    onDrop={(e) => handlePinnedDrop(e, index)}
                    className={`shrink-0 flex items-center gap-1.5 ${deckPinnedPill} rounded-lg text-sm font-medium cursor-grab active:cursor-grabbing select-none transition-[transform,opacity,box-shadow] duration-200 ease-out ${isDragging ? 'opacity-0 scale-95 origin-center' : 'opacity-100 scale-100'} ${isDropTarget ? 'ring-2 ring-[var(--cyan-accent)]/60 ring-offset-2 ring-offset-[var(--bg-panel)] scale-[1.02] transition-all duration-150' : ''} ${isText ? (activeChannelId === ch.id ? 'bg-[var(--cyan-accent)]/20 text-t-accent' : 'hover:bg-fill-active text-t-primary') : (activeChannelId === ch.id ? 'bg-emerald-500/20 text-emerald-400' : 'hover:bg-fill-active text-t-primary')}`}
                    onClick={() => ch.type === 'stage' ? handleStageChannelSelect(ch.id) : handleChannelSelect(ch.id)}
                    {...longPressBindings((e) => { e.preventDefault(); setPinContextMenu({ x: e.clientX, y: e.clientY, channel: ch }); })}
                  >
                    {ch.type === 'forum' ? <ForumIcon size={12} className="shrink-0" /> : ch.type === 'stage' ? <Radio size={12} className="shrink-0" /> : ch.type === 'role_picker' ? <Tag size={12} className="shrink-0" /> : isText ? <Hash size={12} className="shrink-0" /> : <Volume2 size={12} className="shrink-0" />}
                    <span className="truncate max-w-[100px]">{ch.name}</span>
                    {!isText && participants.length > 0 && <span className="text-[10px] opacity-80 shrink-0">({participants.length})</span>}
                    {!isText && (ch.id === connectedVoiceChannelId || ch.id === connectedStageChannelId) && (
                      <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 shrink-0" style={{ boxShadow: '0 0 4px rgba(52,211,153,0.5)' }} />
                    )}
                  </div>
                );
              })}
            </div>
            )}
            <div className={`flex items-center gap-1.5 ${isMobile ? 'ml-auto' : ''}`}>
              {!isMobile && (
              <div className="relative shrink-0">
                <button ref={addMenuButtonRef} type="button"
                  onClick={() => { setAddMenuOpen(o => !o); setTextDropdownOpen(false); setVoiceDropdownOpen(false); }}
                  className={`shrink-0 ${deckAddBtn} rounded-xl flex items-center justify-center hover:bg-fill-hover transition-colors text-t-secondary ${addMenuOpen ? 'bg-fill-active' : ''}`}
                  aria-label={t('channels.addChannel')}>
                  <Plus size={18} />
                </button>
                {addMenuOpen && createPortal(
                  <div ref={addMenuRef}
                    style={{ position: 'fixed', top: (addMenuButtonRef.current?.getBoundingClientRect().bottom ?? 0) + 8, right: window.innerWidth - (addMenuButtonRef.current?.getBoundingClientRect().right ?? 0), zIndex: 'var(--z-popover)' as unknown as number, ...GLASS_DROPDOWN_STYLE }}
                    className="min-w-[180px] rounded-xl border shadow-xl py-1 animate-in slide-in-from-top-2 fade-in duration-200">
                    <button type="button"
                      onClick={() => { setCreateChannelInitialType('text'); setCreateChannelCategoryId(null); setCreateChannelCategoryName(null); setModalType('createChannel'); setAddMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-fill-hover text-t-primary">
                      <Hash size={15} className="text-t-secondary" /> {t('sidebar.createChannel')}
                    </button>
                    <button type="button"
                      onClick={() => { setModalType('createCategory'); setAddMenuOpen(false); }}
                      className="w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left text-sm font-medium transition-colors hover:bg-fill-hover text-t-primary">
                      <FolderOpen size={15} className="text-t-secondary" /> {t('sidebar.createCategory')}
                    </button>
                  </div>,
                  document.body
                )}
              </div>
              )}
              {!isMobile && onToggleThreadBrowser && (
                <div ref={(el) => { if (threadBrowserBtnRef) (threadBrowserBtnRef as React.MutableRefObject<HTMLDivElement | null>).current = el; }} className="shrink-0">
                <button
                  type="button"
                  onClick={onToggleThreadBrowser}
                  className="shrink-0 rounded-xl flex items-center justify-center transition-colors px-2 py-1.5"
                  style={{ color: isThreadBrowserActive ? 'var(--text-accent)' : 'var(--text-secondary)', backgroundColor: isThreadBrowserActive ? 'var(--fill-active)' : undefined }}
                  aria-pressed={isThreadBrowserActive}
                  aria-label={t('threads.threadBrowser')}
                >
                  <MessageCirclePlus size={14} />
                </button>
                </div>
              )}
              {!isMobile && onToggleCalendar && serverHasPerm(server, 'viewCalendar') && (
                <button
                  type="button"
                  onClick={onToggleCalendar}
                  className="relative shrink-0 rounded-xl flex items-center justify-center transition-colors px-2 py-1.5"
                  style={{ color: isCalendarActive ? 'var(--text-accent)' : 'var(--text-secondary)', backgroundColor: isCalendarActive ? 'var(--fill-active)' : undefined }}
                  aria-pressed={isCalendarActive}
                  aria-label={t('channels.calendar')}
                >
                  <Calendar size={14} />
                  {calendarDotType === 'live' && <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-[0_0_6px_rgba(239,68,68,0.5)]" />}
                  {calendarDotType === 'soon' && !isCalendarActive && <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(245,158,11,0.5)]" />}
                  {calendarDotType === 'change' && !isCalendarActive && <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--text-primary)] shadow-[0_0_4px_var(--text-primary)]" />}
                </button>
              )}
              {isMobile && (onToggleThreadBrowser || (onToggleCalendar && serverHasPerm(server, 'viewCalendar'))) && (
                <MobileOverflowMenu
                  onToggleThreadBrowser={onToggleThreadBrowser}
                  onToggleCalendar={onToggleCalendar && serverHasPerm(server, 'viewCalendar') ? onToggleCalendar : undefined}
                  isThreadBrowserActive={isThreadBrowserActive}
                  isCalendarActive={isCalendarActive}
                  calendarDotType={calendarDotType}
                  canManageChannels={canManageChannels}
                  onCreateChannel={() => { setCreateChannelInitialType('text'); setCreateChannelCategoryId(null); setCreateChannelCategoryName(null); setModalType('createChannel'); }}
                  onCreateCategory={() => setModalType('createCategory')}
                  t={t}
                />
              )}
              {onDeckMembersColumnToggle && (
                <button
                  type="button"
                  onClick={onDeckMembersColumnToggle}
                  className={`flex items-center gap-1.5 rounded-xl text-sm font-medium transition-colors shrink-0 ${
                    deckMembersColumnOpen
                      ? 'bg-fill-active text-t-accent'
                      : 'bg-transparent hover:bg-fill-hover text-t-primary'
                  } ${isMobile ? 'px-2.5 py-2 border border-[var(--glass-border)]' : 'px-2.5 py-1.5'}`}
                  aria-pressed={deckMembersColumnOpen}
                  aria-label={deckMembersColumnOpen ? t('channels.hideMembers') : t('channels.showMembers')}
                >
                  <Users size={isMobile ? 16 : 14} />
                  <span className="text-[10px] font-semibold tabular-nums opacity-70">{deckMembersCount}</span>
                </button>
              )}
            </div>
          </div>
        </div>
        {/* Category context menu */}
        {categoryContextMenu && createPortal(
          <>
            <div className="fixed inset-0 z-[var(--z-popover)]" onClick={() => setCategoryContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCategoryContextMenu(null); }} />
            <ContextMenuContainer
              ref={categoryContextMenuRef}
              x={categoryContextMenu.x}
              y={categoryContextMenu.y}
              estWidth={220}
              estHeight={300}
              className={`fixed z-[var(--z-popover)] py-2 min-w-[200px] ${GLASS_MENU_CLASS} glass`}
            >
              <button
                type="button"
                onClick={() => { toggleCategoryPin(categoryContextMenu.category.id); setCategoryContextMenu(null); }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
              >
                <Pin size={14} />
                {isCategoryPinned(categoryContextMenu.category.id) ? t('categories.unpinFromBar') : t('categories.pinToBar')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCreateChannelInitialType('text');
                  setCreateChannelCategoryId(categoryContextMenu.category.id);
                  setCreateChannelCategoryName(categoryContextMenu.category.name);
                  setModalType('createChannel');
                  setCategoryContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
              >
                <Plus size={14} />
                {t('categories.createChannelInCategory')}
              </button>
              <div className="h-px my-2 mx-2 bg-[var(--border-subtle)]" />
              <button
                type="button"
                onClick={() => { closeAllOverlays(); setCategorySettingsTarget(categoryContextMenu.category); }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
              >
                <Settings size={14} />
                {t('categories.editCategory', 'Edit Category')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setRenamingCategory(categoryContextMenu.category);
                  setRenameCategoryName(categoryContextMenu.category.name);
                  setRenameCategoryError(null);
                  setModalType('renameCategory');
                  setCategoryContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
              >
                <Pencil size={14} />
                {t('categories.renameCategory')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDeletingCategory(categoryContextMenu.category);
                  setDeleteCategoryError(null);
                  setModalType('deleteCategory');
                  setCategoryContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-red-400"
              >
                <Trash2 size={14} />
                {t('categories.deleteCategory')}
              </button>
            </ContextMenuContainer>
          </>,
          document.body
        )}
        {pinContextMenu && createPortal(
          (() => {
            const ch = pinContextMenu.channel;
            const isText = ch.type === 'text' || ch.type === 'forum' || ch.type === 'role_picker';
            const muted = isChannelMuted(ch.id);
            const menuItemClass = 'w-full flex items-center gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary';
            return (
          <>
          <ContextMenuContainer ref={pinContextMenuRef} x={pinContextMenu.x} y={pinContextMenu.y} estWidth={200} estHeight={320} className={`fixed z-[var(--z-popover)] py-2 min-w-[200px] ${GLASS_MENU_CLASS} glass`}>
            <button type="button" onClick={() => { togglePin(ch.id); setPinContextMenu(null); setChannelSubmenu(null); }} className={menuItemClass}>
              <Pin size={14} />
              {isPinned(ch.id) ? t('channels.unpinFromBar') : t('channels.pinToBar')}
            </button>
            {isText && onMarkChannelRead && (
              <button type="button" onClick={() => { onMarkChannelRead(ch.id); setPinContextMenu(null); setChannelSubmenu(null); }} className={menuItemClass}>
                <Check size={14} />
                {t('channels.markAsRead')}
              </button>
            )}
            {isText && (
              muted ? (
                <button type="button" onClick={() => { unmuteChannel(ch.id); setPinContextMenu(null); setChannelSubmenu(null); }} className={menuItemClass}>
                  <VolumeX size={14} />
                  {t('channels.unmuteChannel')}
                </button>
              ) : (
                <div className="px-2 relative">
                  <button
                    ref={channelMuteTriggerRef}
                    type="button"
                    className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
                    onClick={() => {
                      if (channelSubmenu?.type === 'mute') { setChannelSubmenu(null); return; }
                      const el = channelMuteTriggerRef.current;
                      if (el) {
                        const rect = el.getBoundingClientRect();
                        const pos = getSubmenuPosition(rect, 240, 280);
                        setChannelSubmenu({ type: 'mute', left: pos.left, top: pos.top });
                      }
                    }}
                    onMouseEnter={() => {
                      if (channelSubmenuCloseTimeoutRef.current) {
                        clearTimeout(channelSubmenuCloseTimeoutRef.current);
                        channelSubmenuCloseTimeoutRef.current = null;
                      }
                      const el = channelMuteTriggerRef.current;
                      if (el) {
                        const rect = el.getBoundingClientRect();
                        const pos = getSubmenuPosition(rect, 240, 280);
                        setChannelSubmenu({ type: 'mute', left: pos.left, top: pos.top });
                      }
                    }}
                    onMouseLeave={() => {
                      if (channelSubmenuCloseTimeoutRef.current) clearTimeout(channelSubmenuCloseTimeoutRef.current);
                      channelSubmenuCloseTimeoutRef.current = setTimeout(() => setChannelSubmenu(null), 150);
                    }}
                  >
                    <span className="flex items-center gap-2">
                      <BellOff size={14} />
                      {t('channels.muteChannel')}
                    </span>
                    <ChevronRight size={14} className="shrink-0 opacity-60" />
                  </button>
                </div>
              )
            )}
            {isText && (
              <div className="px-2 relative">
                <button
                  ref={channelNotificationTriggerRef}
                  type="button"
                  className="w-full flex items-center justify-between gap-2 px-4 py-2.5 text-left text-sm rounded-lg hover:bg-fill-hover transition-colors text-t-primary"
                  onClick={() => {
                    if (channelSubmenu?.type === 'notification') { setChannelSubmenu(null); return; }
                    const el = channelNotificationTriggerRef.current;
                    if (el) {
                      const rect = el.getBoundingClientRect();
                      const pos = getSubmenuPosition(rect, 240, 140);
                      setChannelSubmenu({ type: 'notification', left: pos.left, top: pos.top });
                    }
                  }}
                  onMouseEnter={() => {
                    if (channelSubmenuCloseTimeoutRef.current) {
                      clearTimeout(channelSubmenuCloseTimeoutRef.current);
                      channelSubmenuCloseTimeoutRef.current = null;
                    }
                    const el = channelNotificationTriggerRef.current;
                    if (el) {
                      const rect = el.getBoundingClientRect();
                      const pos = getSubmenuPosition(rect, 240, 140);
                      setChannelSubmenu({ type: 'notification', left: pos.left, top: pos.top });
                    }
                  }}
                  onMouseLeave={() => {
                    if (channelSubmenuCloseTimeoutRef.current) clearTimeout(channelSubmenuCloseTimeoutRef.current);
                    channelSubmenuCloseTimeoutRef.current = setTimeout(() => setChannelSubmenu(null), 150);
                  }}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    <Bell size={14} />
                    <span>{t('channels.notificationSettings')}</span>
                  </span>
                  <ChevronRight size={14} className="shrink-0 opacity-60" />
                </button>
              </div>
            )}
            <button
              type="button"
              onClick={() => {
                const url = `${getWebOrigin()}/channels/${server.id}/${ch.id}`;
                navigator.clipboard?.writeText(url).catch(() => { /* clipboard blocked */ });
                setPinContextMenu(null);
                setChannelSubmenu(null);
              }}
              className={menuItemClass}
            >
              <Link2 size={14} />
              {t('channels.copyChannelLink', { defaultValue: 'Copy Channel Link' })}
            </button>
            {serverHasPerm(server, 'manageChannels') && (
              <button type="button" onClick={() => { closeAllOverlays(); setChannelSettingsTarget(ch); }} className={menuItemClass}>
                <Pencil size={14} />
                {t('channels.editChannel')}
              </button>
            )}
            {onDeleteChannel && (
              <button type="button" onClick={() => { onDeleteChannel(ch); setPinContextMenu(null); setChannelSubmenu(null); }} className={`${menuItemClass} text-red-400 hover:text-red-300 hover:bg-red-500/10`}>
                <Trash2 size={14} />
                {t('channels.deleteChannel')}
              </button>
            )}
          </ContextMenuContainer>

          {/* Mute channel submenu (text channels only) */}
          {channelSubmenu?.type === 'mute' && (
            <div
              ref={channelSubmenuRef}
              className={`fixed z-[var(--z-popover)] py-2 min-w-[240px] ${GLASS_MENU_CLASS} glass`}
              style={{ left: channelSubmenu.left, top: channelSubmenu.top }}
              onMouseEnter={() => {
                if (channelSubmenuCloseTimeoutRef.current) {
                  clearTimeout(channelSubmenuCloseTimeoutRef.current);
                  channelSubmenuCloseTimeoutRef.current = null;
                }
              }}
              onMouseLeave={() => setChannelSubmenu(null)}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-2">
                {CHANNEL_MUTE_OPTIONS.map(({ value, labelKey }) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => handleMuteOptionSelect(ch.id, value)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors text-t-primary"
                  >
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Notification settings submenu (text channels only) */}
          {channelSubmenu?.type === 'notification' && (() => {
            const level = getChannelNotificationLevel(ch.id, currentUser?.id);
            const levels: { value: ChannelNotificationLevel; label: string }[] = [
              { value: 'all', label: t('sidebar.allMessages') },
              { value: 'mentions', label: t('sidebar.onlyMentions') },
              { value: 'none', label: t('sidebar.nothing') },
            ];
            return (
              <div
                ref={channelSubmenuRef}
                className={`fixed z-[var(--z-popover)] py-2 min-w-[240px] ${GLASS_MENU_CLASS} glass`}
                style={{ left: channelSubmenu.left, top: channelSubmenu.top }}
                onMouseEnter={() => {
                  if (channelSubmenuCloseTimeoutRef.current) {
                    clearTimeout(channelSubmenuCloseTimeoutRef.current);
                    channelSubmenuCloseTimeoutRef.current = null;
                  }
                }}
                onMouseLeave={() => setChannelSubmenu(null)}
                onClick={(e) => e.stopPropagation()}
              >
                <div className="px-2">
                  {levels.map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => handleNotificationLevelSelect(ch.id, value)}
                      className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors text-t-primary"
                    >
                      {label}
                      {level === value && <Check size={14} className="shrink-0 text-[var(--cyan-accent)]" />}
                    </button>
                  ))}
                </div>
              </div>
            );
          })()}
          </>
            );
          })(),
          document.body
        )}
        {renderModal()}
        {channelSettingsTarget && (
          <ChannelSettingsModal
            isOpen={!!channelSettingsTarget}
            onClose={() => setChannelSettingsTarget(null)}
            channel={channelSettingsTarget}
            serverId={server.id}
            onUpdateChannel={async (sid, cid, data) => {
              // Modal auto-saves on every keystroke (debounced). Closing here
              // would slam the modal shut mid-edit — leave it open and let
              // the user dismiss explicitly.
              return apiClient.updateChannel(sid, cid, data);
            }}
            onDeleteChannel={async (sid, cid) => {
              await apiClient.deleteChannel(sid, cid);
              setChannelSettingsTarget(null);
            }}
            serverMembers={serverMembers}
            serverRoles={settingsRoles}
          />
        )}
        {categorySettingsTarget && (
          <CategorySettingsModal
            isOpen={!!categorySettingsTarget}
            onClose={() => setCategorySettingsTarget(null)}
            category={categorySettingsTarget}
            serverId={server.id}
            onUpdateCategory={async (sid, catId, data) => {
              return apiClient.updateCategory(sid, catId, data);
            }}
            onDeleteCategory={async (sid, catId) => {
              await apiClient.deleteCategory(sid, catId);
              setCategorySettingsTarget(null);
            }}
            serverMembers={serverMembers}
            serverRoles={settingsRoles}
          />
        )}
      </>
    );
  }

  return (
    <div
      ref={sidebarRef}
      style={{ contain: 'layout style paint', width: `${width}px`, backgroundColor: 'var(--bg-chat)', borderColor: 'var(--border-subtle)', boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)' } as React.CSSProperties}
      className="perf-glass-layer relative flex flex-col shrink-0 border-r-2 transition-[width,background-color] duration-75 ease-out rounded-r-2xl overflow-hidden"
    >
      {/* Server header — banner + compact pill / workspace badge */}
      <div className="relative" ref={menuRef}>
        {server.banner ? (
          <>
            {/* Banner image/color area */}
            <div className="relative w-full h-[120px] overflow-hidden" style={server.banner.startsWith('#') ? { backgroundColor: server.banner } : { backgroundColor: '#0a0f1a' }}>
              {!server.banner.startsWith('#') && <LazyGif
                src={server.banner}
                frameSrc={getFrameUrl(server.banner)}
                forceStatic={!!server.banner.match(/\.gif(\?|$)/i) && powerUpTier(server.powerUpCount ?? 0) < 3}
                alt=""
                className="absolute top-0 left-0 w-full h-full object-cover"
                style={{ objectPosition: `center ${server.bannerPositionY ?? 50}%` }}
                draggable={false}
              />}
              {/* Gradient overlay for text readability */}
              <div className="absolute inset-0" style={{ background: 'linear-gradient(to bottom, transparent 30%, var(--overlay-backdrop) 100%)' }} />
              {/* Server name + chevron overlaid at bottom */}
              <button
                onClick={() => setIsMenuOpen(!isMenuOpen)}
                className={`absolute inset-x-0 bottom-0 w-full flex items-center justify-between gap-2 px-4 py-2.5 transition-all group ${isMenuOpen ? 'bg-black/20' : 'hover:bg-black/10'}`}
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 rounded-lg overflow-hidden shrink-0 ring-2 ring-black/30">
                    <ServerIcon icon={server.icon} name={server.name} className="rounded-lg" freezeAnimation={!!server.icon?.match(/\.gif(\?|$)/i) && powerUpTier(server.powerUpCount ?? 0) < 1} />
                  </div>
                  <span className="font-semibold text-sm truncate tracking-tight text-white drop-shadow-md">{server.name}</span>
                </div>
                <ChevronDown size={16} className={`shrink-0 transition-transform duration-200 text-white/80 drop-shadow-md ${isMenuOpen ? 'rotate-180' : ''}`} />
              </button>
            </div>
          </>
        ) : (
          <button
            onClick={() => setIsMenuOpen(!isMenuOpen)}
            className={`w-full flex items-center justify-between gap-2 px-4 py-3.5 transition-all group ${isMenuOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
          >
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="w-9 h-9 rounded-xl overflow-hidden shrink-0">
                <ServerIcon icon={server.icon} name={server.name} className="rounded-xl" freezeAnimation={!!server.icon?.match(/\.gif(\?|$)/i) && powerUpTier(server.powerUpCount ?? 0) < 1} />
              </div>
              <span className="font-semibold text-sm truncate tracking-tight text-t-primary">{server.name}</span>
            </div>
            <ChevronDown size={16} className={`shrink-0 transition-transform duration-200 text-t-secondary ${isMenuOpen ? 'rotate-180' : ''}`} />
          </button>
        )}

        {/* Server dropdown — card overlay */}
        {isMenuOpen && (
          <div
            className="absolute top-full left-3 right-3 mt-2 z-[100] py-2 rounded-2xl shadow-xl animate-in slide-in-from-top-2 fade-in duration-200 bg-floating border border-default"
          >
            <div className="space-y-0.5 px-1 group">
              <MenuItem label={t('channels.invitePeople')} icon={UserPlus} colorClass="text-[var(--cyan-accent)]" onClick={() => setModalType('invite')} />
              <div className="h-px my-2 bg-[var(--border-subtle)]" />
              {isAdmin && (
                <MenuItem label={t('sidebar.serverSettings')} icon={Settings} onClick={() => setModalType('settings')} />
              )}
              {canManageChannels && (
                <>
                  <MenuItem label={t('sidebar.createChannel')} icon={Plus} onClick={() => setModalType('createChannel')} />
                  <MenuItem label={t('sidebar.createCategory')} icon={FolderPlus} onClick={() => setModalType('createCategory')} />
                </>
              )}
              <MenuItem label={t('sidebar.createEvent')} icon={Calendar} onClick={() => setModalType('notifications')} />
              <div className="h-px my-2 bg-[var(--border-subtle)]" />
              <MenuItem label={t('sidebar.notificationSettings')} icon={Bell} onClick={() => setModalType('notifications')} />
              <MenuItem label={t('sidebar.privacySettings')} icon={ShieldAlert} onClick={() => setModalType('settings')} />
              <MenuItem label={t('sidebar.editServerProfile')} icon={UserCircle} onClick={() => { onEditServerProfile?.(server.id); }} />
              <div className="h-px my-2 bg-[var(--border-subtle)]" />
              <MenuItem label={t('sidebar.hideMutedChannels')} icon={EyeOff} />
              <div className="h-px my-2 bg-[var(--border-subtle)]" />
              <MenuItem label={t('sidebar.leaveServer')} icon={LogOut} colorClass="text-red-500" onClick={() => setModalType('leave')} />
            </div>
          </div>
        )}
      </div>

      {/* Channels — bento-style sections */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-6 pb-24">
        {/* Text channels */}
        <section>
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-t-quaternary">{t('channels.text')}</span>
            <button type="button" onClick={() => { setCreateChannelInitialType('text'); setModalType('createChannel'); }} className="p-1 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary" aria-label={t('channels.createTextChannel')}>
              <Plus size={14} />
            </button>
          </div>
          <div className="space-y-1.5">
            {server.channels.filter(c => c.type === 'text' || c.type === 'forum' || c.type === 'role_picker').map((channel) => (
              <SidebarTextChannelItem
                key={channel.id}
                channel={channel}
                isActive={activeChannelId === channel.id}
                onSelect={handleChannelSelect}
              />
            ))}
          </div>
        </section>

        {/* Voice channels */}
        <section>
          <div className="flex items-center justify-between px-2 mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-t-quaternary">{t('channels.voice')}</span>
            <button type="button" onClick={() => { setCreateChannelInitialType('voice'); setModalType('createChannel'); }} className="p-1 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary" aria-label={t('channels.createVoiceChannel')}>
              <Plus size={14} />
            </button>
          </div>
          <div className="space-y-2">
            {server.channels.filter(c => c.type === 'voice').map((channel) => (
              <SidebarVoiceChannelItem
                key={channel.id}
                channel={channel}
                isActive={activeChannelId === channel.id}
                participants={voiceParticipantsByChannel[channel.id] ?? EMPTY_PARTICIPANT_ARRAY}
                onSelect={handleChannelSelect}
                onWatchScreen={handleWatchScreen}
              />
            ))}
          </div>
        </section>
      </div>

      <div 
        onMouseDown={startResizing}
        className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-[var(--cyan-accent)]/20 active:bg-[var(--cyan-accent)]/30 transition-colors z-50 rounded-r"
      />

      {renderModal()}
      {channelSettingsTarget && (
        <ChannelSettingsModal
          isOpen={!!channelSettingsTarget}
          onClose={() => setChannelSettingsTarget(null)}
          channel={channelSettingsTarget}
          serverId={server.id}
          onUpdateChannel={async (sid, cid, data) => {
            // Modal auto-saves on every keystroke (debounced). Closing here
            // would slam the modal shut mid-edit — leave it open and let
            // the user dismiss explicitly.
            return apiClient.updateChannel(sid, cid, data);
          }}
          onDeleteChannel={async (sid, cid) => {
            await apiClient.deleteChannel(sid, cid);
            setChannelSettingsTarget(null);
          }}
          serverMembers={serverMembers}
          serverRoles={settingsRoles}
        />
      )}
      {categorySettingsTarget && (
        <CategorySettingsModal
          isOpen={!!categorySettingsTarget}
          onClose={() => setCategorySettingsTarget(null)}
          category={categorySettingsTarget}
          serverId={server.id}
          onUpdateCategory={async (sid, catId, data) => {
            return apiClient.updateCategory(sid, catId, data);
          }}
          onDeleteCategory={async (sid, catId) => {
            await apiClient.deleteCategory(sid, catId);
            setCategorySettingsTarget(null);
          }}
          serverMembers={serverMembers}
          serverRoles={settingsRoles}
        />
      )}
    </div>
  );
});
