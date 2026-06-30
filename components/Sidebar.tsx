// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { motion, LayoutGroup } from 'motion/react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Server, NavigationTarget, serverHasPerm } from '../types';
import { ServerIcon } from './ServerIcon';
import { longPressBindings } from '../hooks/useLongPress';
import type { MuteDuration } from './GroupChatContextMenu';
import { Plus, Users, MessageSquare, PanelLeftClose, PanelLeftOpen, Headphones, Pin, Folder, Bell, Compass } from 'lucide-react';
import { useRenderLoopDetector } from '../hooks/useRenderLoopDetector';
import { LetterAvatar } from './LetterAvatar';
import { isValidCssColor, colorWithAlpha } from '../utils/securityUtils';
import { CreateJoinServerModal } from './sidebar/CreateJoinServerModal';
import { FolderSettingsModal } from './sidebar/FolderSettingsModal';
import { ServerContextMenu } from './sidebar/ServerContextMenu';
import { FolderContextMenu } from './sidebar/FolderContextMenu';
import { ServerPreviewPopup } from './sidebar/ServerPreviewPopup';
import { MobileSidebar } from './sidebar/MobileSidebar';
import { useServerStore } from '../stores/serverStore';
import { assetPath } from '../utils/assetPath';
import { useNavigationStore } from '../stores/navigationStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useVoiceStore } from '../stores/voiceStore';
import { useAuthStore } from '../stores/authStore';
import { useAppStore } from '../stores/appStore';
import { useServerFolderStore } from '../stores/serverFolderStore';
import { apiClient } from '../services/api';
import type { ServerFolder } from '../services/api/serverFolders';
import { unreadBadgeEnabled, taskbarFlashEnabled } from '../utils/notificationSoundRef';


function muteDurationToUntil(d: MuteDuration): number | null {
  const now = Date.now();
  if (d === 'forever') return null;
  const ms = { '15m': 15 * 60 * 1000, '1h': 60 * 60 * 1000, '3h': 3 * 60 * 60 * 1000, '8h': 8 * 60 * 60 * 1000, '24h': 24 * 60 * 60 * 1000 }[d];
  return now + ms;
}

export type ServerContextAction = 'invite' | 'settings' | 'leave' | 'createChannel' | 'notifications';

type VoiceParticipantInfo = {
  userId: string;
  username: string;
  avatar?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  roleColor?: string;
  roleStyle?: string;
};

interface SidebarProps {
  onSelect: (id: NavigationTarget) => void;
  onCreateServer?: (name: string, options?: { icon?: string; template?: string; community?: boolean }) => Promise<void>;
  onJoinServer?: (code: string) => Promise<void>;
  onServerCreated?: (server: { id: string; name: string; channels: Array<{ id: string; name: string; type: string }> }) => void;
  onMarkServerRead?: (serverId: string) => void;
  onServerContextMenu?: (serverId: string, action: ServerContextAction) => void;
  /** Toggle dock state for the floating user status bar */
  onFloatingBarDockToggle?: () => void;
  /** Report sidebar width so docked status bar can form L-shape (horizontal leg starts at this offset) */
  onSidebarWidthChange?: (width: number) => void;
  /** When true, render as a horizontal bottom tab bar instead of vertical sidebar */
  isMobile?: boolean;
  /** When true, lock sidebar to icon-only width (no expand/resize) */
  isTablet?: boolean;
  /** Navigate to User Settings > Profiles for a given server */
  onEditServerProfile?: (serverId: string) => void;
  /** Lifted state: toggle the mobile server drawer */
  onMobileServerDrawerToggle?: (open: boolean) => void;
  /** Ref for the drawer panel element (swipe gesture follow-finger) */
  serverDrawerPanelRef?: React.RefObject<HTMLDivElement | null>;
  /** Ref for the drawer backdrop element (swipe gesture opacity) */
  serverBackdropRef?: React.RefObject<HTMLDivElement | null>;
  /** When truthy, user is in a DM/group call — show badge on DM nav button */
  activeDmCallChannelId?: string | null;
}

const STORAGE_KEY = 'howl_sidebar_width';
const NAV_ORDER_KEY = 'howl_nav_order';
// Legacy localStorage key for server order. Server order now persists to the
// backend via PUT /servers/me/order; we keep this constant only to migrate it
// away on first run (the cleanup useEffect below removes the stale key).
const LEGACY_SERVER_ORDER_KEY = 'howl_server_order';
const MUTED_SERVERS_KEY = 'howl_muted_servers';
const HIDE_MUTED_CHANNELS_KEY = 'howl_hide_muted_channels';
const DEFAULT_WIDTH = 72;

/** { serverId: { until: timestamp | null } } — until = when to auto-unmute (ms), null = forever. */
function getMutedServersMap(): Record<string, { until: number | null }> {
  try {
    const raw = localStorage.getItem(MUTED_SERVERS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const now = Date.now();
    const pruned: Record<string, { until: number | null }> = {};
    for (const [id, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (v && typeof v === 'object' && 'until' in v) {
        const until = (v as { until: unknown }).until;
        if (until === null || (typeof until === 'number' && until > now)) {
          pruned[id] = { until: until as number | null };
        }
      }
    }
    return pruned;
  } catch { return {}; }
}

function setMutedServersMap(map: Record<string, { until: number | null }>) {
  localStorage.setItem(MUTED_SERVERS_KEY, JSON.stringify(map));
}

function getHideMutedChannels(): boolean {
  return localStorage.getItem(HIDE_MUTED_CHANNELS_KEY) === 'true';
}

function setHideMutedChannels(hide: boolean) {
  localStorage.setItem(HIDE_MUTED_CHANNELS_KEY, hide ? 'true' : 'false');
}



const EMPTY_VOICE_SUMMARY: Record<string, Record<string, VoiceParticipantInfo[]>> = {};
const EMPTY_SERVER_IDS: string[] = [];

export const Sidebar: React.FC<SidebarProps> = React.memo(({
  onSelect, onCreateServer, onJoinServer, onServerCreated, onMarkServerRead, onServerContextMenu,
  onFloatingBarDockToggle, onSidebarWidthChange,
  isMobile = false, isTablet = false, onEditServerProfile,
  onMobileServerDrawerToggle,
  serverDrawerPanelRef, serverBackdropRef,
  activeDmCallChannelId,
}) => {
  useRenderLoopDetector('Sidebar');
  const { t } = useTranslation();

  // Store selectors
  const servers = useServerStore(s => s.servers);
  const activeId = useNavigationStore(s => s.activeServerId);
  const currentUser = useAuthStore(s => s.currentUser);
  const serverMentionCounts = useNotificationStore(s => s.serverMentionCounts);
  const serverUnreadIds = useNotificationStore(s => s.serverUnreadIds);
  const friendsBadgeCount = useNotificationStore(s => s.pendingFriendRequestCount);
  const unreadDmChannelIds = useNotificationStore(s => s.unreadDmChannelIds);
  const dmUnreadCounts = useNotificationStore(s => s.dmUnreadCounts);
  const threadMentionCounts = useNotificationStore(s => s.threadMentionCounts);
  // Show TOTAL unread DM messages, not count of conversations with any unread
  const messagesBadgeCount = useMemo(() => {
    let sum = 0;
    for (const id of unreadDmChannelIds) sum += dmUnreadCounts[id] || 0;
    return sum;
  }, [unreadDmChannelIds, dmUnreadCounts]);
  // OS taskbar badge source: total unread activity across DMs, servers, and
  // threads. Mentions bump the mention counter (which is part of this sum) and
  // every unread channel still counts once so the badge reflects "notice me"
  // activity even when the user isn't explicitly @mentioned.
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);
  const mentionCount = useMemo(() => {
    let sum = 0;
    for (const id in serverMentionCounts) sum += serverMentionCounts[id] || 0;
    for (const id of unreadDmChannelIds) sum += dmUnreadCounts[id] || 0;
    for (const id in threadMentionCounts) sum += threadMentionCounts[id] || 0;
    sum += channelUnreadIds.size;
    return sum;
  }, [serverMentionCounts, unreadDmChannelIds, dmUnreadCounts, threadMentionCounts, channelUnreadIds]);
  const calendarDotState = useNotificationStore(s => s.calendarDotState);
  const notificationTotal = useNotificationStore(s => s.notificationCounts.total);
  const serverVoiceSummary = useVoiceStore(s => s.serverVoiceSummary) ?? EMPTY_VOICE_SUMMARY;
  const connectedVoiceChannelId = useVoiceStore(s => s.connectedVoiceChannelId);
  const floatingBarDocked = useAppStore(s => s.floatingBarDocked);
  const mobileServerDrawerOpen = useNavigationStore(s => s.mobileServerDrawerOpen);

  // Derive connectedVoiceServerId from connectedVoiceChannelId + servers
  const connectedVoiceServerId = useMemo(() => {
    if (!connectedVoiceChannelId) return null;
    for (const server of servers) {
      if (server.channels.some(ch => ch.id === connectedVoiceChannelId)) return server.id;
    }
    return null;
  }, [connectedVoiceChannelId, servers]);

  // Re-run the badge effect when notification prefs change
  const [prefsVersion, setPrefsVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPrefsVersion(v => v + 1);
    window.addEventListener('howl-prefs-change', bump);
    return () => window.removeEventListener('howl-prefs-change', bump);
  }, []);

  // Electron: update tray/dock/taskbar badge count.
  // On Windows, render a circular number overlay icon at 32×32 (Windows
  // composites it into the taskbar at 16×16, but the native API accepts a
  // larger source and downscales for crispness on HiDPI displays) and pass
  // it via dataURL. When the count is 0 we explicitly clear the overlay.
  useEffect(() => {
    if (!window.electron?.setBadgeCount) return;
    if (!unreadBadgeEnabled.current) {
      window.electron.setBadgeCount(0, { overlayPng: null, taskbarFlash: false });
      return;
    }
    const n = mentionCount;
    let overlayPng: string | null = null;
    if (n > 0 && typeof document !== 'undefined') {
      const size = 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        // Cap at "9+" for anything ≥10. A 16×16 composited overlay can't
        // render multi-digit counts legibly, so single digit or "9+" is the
        // only readable format.
        const label = n > 9 ? '9+' : String(n);
        const fontSize = label.length === 2 ? 18 : 22;
        ctx.font = `bold ${fontSize}px -apple-system, "Segoe UI", system-ui, sans-serif`;
        ctx.fillText(label, size / 2, size / 2 + 1);
        try { overlayPng = canvas.toDataURL('image/png'); } catch { overlayPng = null; }
      }
    }
    window.electron.setBadgeCount(n, { overlayPng, taskbarFlash: taskbarFlashEnabled.current });
  }, [mentionCount, prefsVersion]);

  // Clear the taskbar/dock overlay when the Sidebar unmounts (logout/close)
  // so a stale badge doesn't persist across sessions.
  useEffect(() => {
    return () => {
      if (window.electron?.setBadgeCount) {
        window.electron.setBadgeCount(0, { overlayPng: null, taskbarFlash: false });
      }
    };
  }, []);

  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? parseInt(saved, 10) : DEFAULT_WIDTH;
  });
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [serverContextMenu, setServerContextMenu] = useState<{ x: number; y: number; server: Server } | null>(null);
  const [mutedServersMap, setMutedServersMapState] = useState<Record<string, { until: number | null }>>(getMutedServersMap);
  const [hideMutedChannels, setHideMutedChannelsState] = useState(getHideMutedChannels);
  const [voicePopupServerId, setVoicePopupServerId] = useState<string | null>(null);
  const [voicePopupAnchor, setVoicePopupAnchor] = useState<{ top: number; left: number } | null>(null);
  const voicePopupTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Server folders (far-left strip)
  const serverFolders = useServerFolderStore((s) => s.folders);
  const [_selectedFolderId, setSelectedFolderIdState] = useState<string | null>(null);
  const [_newFolderInput, _setNewFolderInput] = useState('');
  const [_showNewFolderInput, _setShowNewFolderInput] = useState(false);
  const [collapsedFolderIds, setCollapsedFolderIds] = useState<Set<string>>(() => new Set());
  const [folderContextMenu, setFolderContextMenu] = useState<{ x: number; y: number; folder: ServerFolder } | null>(null);
  const [folderSettingsFolderId, setFolderSettingsFolderId] = useState<string | null>(null);

  const navContainerRef = useRef<HTMLDivElement>(null);
  const serverContainerRef = useRef<HTMLDivElement>(null);
  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  /** Live width tracked during resize without triggering React re-renders */
  const liveWidthRef = useRef(width);

  // Reorderable States
  const [navOrder, setNavOrder] = useState<NavigationTarget[]>(() => {
    const defaultOrder: NavigationTarget[] = ['home', 'account', 'friends', 'dm'];
    try {
      const saved = localStorage.getItem(NAV_ORDER_KEY);
      if (!saved) return defaultOrder;
      const parsed: unknown = JSON.parse(saved);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) return defaultOrder;
      return parsed as NavigationTarget[];
    } catch { return defaultOrder; }
  });

  // Server order is now authoritative on the backend (per-user
  // ServerMember.position). The `servers` prop arrives pre-sorted from
  // GET /servers, so we just mirror it. Drag-drop calls
  // apiClient.setServerOrder which re-runs the same query the next time the
  // store refetches.
  const [sortedServers, setSortedServers] = useState<Server[]>(() => [...servers]);

  // Drag states
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null);
  const [dragType, setDragType] = useState<'nav' | 'server' | null>(null);
  /** When dragging a server: 'create-folder' = drop on target server creates folder; 'add-to-folder' = drop onto folder row to add; 'reorder' = drop inserts at dropInsertIndex */
  const [dropIntent, setDropIntent] = useState<'create-folder' | 'add-to-folder' | 'reorder' | null>(null);
  const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null);
  /** Tracks what type of row is being dragged: 'server' or 'folder' */
  const [draggedRowType, setDraggedRowType] = useState<'server' | 'folder' | null>(null);

  const navButtonSize = Math.floor(width * 0.6);
  const serverButtonSize = Math.floor(width * 0.6);
  const navItemHeight = navButtonSize + 8; // Button + margin/gap (matches space-y-2 below)
  const serverItemHeight = serverButtonSize + 8;
  const folderRowHeight = serverButtonSize + 6; // Folder icon row matches a server row
  const serverItemHeightInFolder = serverButtonSize + 6; // Tighter gap between servers inside a folder

  // CSS expressions for sizes — used in style props so the browser handles live resize
  // without React re-renders. --sidebar-w is updated directly on the DOM during drag.
  const navBtnPx = `calc(var(--sidebar-w) * 0.6px)`;
  const srvBtnPx = `calc(var(--sidebar-w) * 0.6px)`;
  const handleServerMouseEnter = useCallback((serverId: string, e: React.MouseEvent) => {
    // Always clear any pending timer first — previously the early-return for
    // the active server could leave a queued "show" timer alive that fired
    // after the corresponding leave's "hide" timer, leaving the popup stuck.
    if (voicePopupTimeoutRef.current) clearTimeout(voicePopupTimeoutRef.current);
    if (serverId === activeId) {
      setVoicePopupServerId(null);
      setVoicePopupAnchor(null);
      return;
    }
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    voicePopupTimeoutRef.current = setTimeout(() => {
      setVoicePopupAnchor({ top: rect.top, left: rect.right + 8 });
      setVoicePopupServerId(serverId);
    }, 300);
  }, [activeId]);

  const handleServerMouseLeave = useCallback(() => {
    if (voicePopupTimeoutRef.current) clearTimeout(voicePopupTimeoutRef.current);
    voicePopupTimeoutRef.current = setTimeout(() => {
      setVoicePopupServerId(null);
      setVoicePopupAnchor(null);
    }, 200);
  }, []);

  const handlePopupMouseEnter = useCallback(() => {
    if (voicePopupTimeoutRef.current) clearTimeout(voicePopupTimeoutRef.current);
  }, []);

  const handlePopupMouseLeave = useCallback(() => {
    if (voicePopupTimeoutRef.current) clearTimeout(voicePopupTimeoutRef.current);
    voicePopupTimeoutRef.current = setTimeout(() => {
      setVoicePopupServerId(null);
      setVoicePopupAnchor(null);
    }, 200);
  }, []);

  /** Clear preview when the pointer leaves the sidebar entirely — catches fast swipes
   *  that skip individual icon onMouseLeave events. */
  const handleSidebarPointerLeave = useCallback(() => {
    if (voicePopupTimeoutRef.current) clearTimeout(voicePopupTimeoutRef.current);
    voicePopupTimeoutRef.current = setTimeout(() => {
      setVoicePopupServerId(null);
      setVoicePopupAnchor(null);
    }, 100);
  }, []);

  // Extracted handlers for .map() loops to reduce re-render allocation

  /** navOrder.map / serverListRows.map — select a nav target or server by id */
  const handleSelectById = useCallback((id: NavigationTarget) => {
    onSelect(id);
  }, [onSelect]);


  /** serverListRows.map — keyboard activation for server rows */
  const handleServerKeyDown = useCallback((e: React.KeyboardEvent, id: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(id);
    }
  }, [onSelect]);

  /** SERVER_MUTE_OPTIONS.map — mute with given duration (used inside context menu portal) */
  const handleMuteOptionClick = useCallback((duration: MuteDuration) => {
    const until = muteDurationToUntil(duration);
    const next = { ...getMutedServersMap(), [serverContextMenu?.server.id ?? '']: { until } };
    setMutedServersMapState(next);
    setMutedServersMap(next);
    setServerContextMenu(null);
  }, [serverContextMenu?.server.id]);

  /** serverFolders.map (folder submenu) — add server to existing folder */
  const handleAddToFolder = useCallback((folderId: string) => {
    if (!serverContextMenu) return;
    const serverId = serverContextMenu.server.id;
    // Remove from any existing folder first
    const existingFolder = useServerFolderStore.getState().getFolderForServer(serverId);
    if (existingFolder) {
      const newIds = existingFolder.serverIds.filter((id) => id !== serverId);
      useServerFolderStore.getState().updateFolder(existingFolder.id, { serverIds: newIds });
      apiClient.updateServerFolder(existingFolder.id, { serverIds: newIds }).catch(() => {
        apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
      });
    }
    // Add to target folder
    const targetFolder = useServerFolderStore.getState().folders.find((f) => f.id === folderId);
    if (targetFolder) {
      const newIds = [...targetFolder.serverIds, serverId];
      useServerFolderStore.getState().updateFolder(folderId, { serverIds: newIds });
      apiClient.updateServerFolder(folderId, { serverIds: newIds }).catch(() => {
        apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
      });
    }
    setServerContextMenu(null);
  }, [serverContextMenu]);

  useEffect(() => {
    localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(navOrder));
  }, [navOrder]);

  // One-time cleanup of the legacy localStorage key now that order persists
  // server-side. Cheap and idempotent — running it on every mount is fine.
  useEffect(() => {
    try { localStorage.removeItem(LEGACY_SERVER_ORDER_KEY); } catch { /* ignore */ }
  }, []);

  // Prune stale server IDs and empty folders from storage on mount / server list change
  useEffect(() => {
    const currentIds = new Set(servers.map((s) => s.id));
    const folders = useServerFolderStore.getState().folders;
    let changed = false;
    const pruned = folders.reduce<ServerFolder[]>((acc, f) => {
      const live = f.serverIds.filter((id) => currentIds.has(id));
      if (live.length !== f.serverIds.length) changed = true;
      if (live.length > 0) {
        acc.push({ ...f, serverIds: live });
      } else {
        changed = true;
      }
      return acc;
    }, []);
    if (changed) {
      useServerFolderStore.getState().setFolders(pruned);
      for (const f of folders) {
        const prunedVersion = pruned.find((p) => p.id === f.id);
        if (!prunedVersion) {
          apiClient.deleteServerFolder(f.id).catch(() => {});
        } else if (prunedVersion.serverIds.length !== f.serverIds.length) {
          apiClient.updateServerFolder(f.id, { serverIds: prunedVersion.serverIds }).catch(() => {});
        }
      }
    }
  }, [servers]);

  /** Only show folders that contain at least one server the user is actually in. */
  const foldersWithServers = useMemo(() => {
    const currentIds = new Set(servers.map((s) => s.id));
    return serverFolders.filter((f) => f.serverIds.some((id) => currentIds.has(id)));
  }, [serverFolders, servers]);

  /** Grouped list: when folders exist, folder icon rows then their servers, then uncategorized. Otherwise flat server list. */
  const serverListRows = useMemo(() => {
    const uncategorizedIds = new Set(useServerFolderStore.getState().getUncategorizedServerIds(sortedServers.map((s) => s.id)));
    const uncategorized = sortedServers.filter((s) => uncategorizedIds.has(s.id));
    if (foldersWithServers.length === 0) {
      return sortedServers.map((server) => ({ type: 'server' as const, server }));
    }
    const rows: Array<{ type: 'folder'; folder: ServerFolder } | { type: 'server'; server: Server }> = [];
    for (const folder of foldersWithServers) {
      rows.push({ type: 'folder', folder });
      if (!collapsedFolderIds.has(folder.id)) {
        for (const id of folder.serverIds) {
          const s = sortedServers.find((x) => x.id === id);
          if (s) rows.push({ type: 'server', server: s });
        }
      }
    }
    for (const s of uncategorized) {
      rows.push({ type: 'server', server: s });
    }
    return rows;
  }, [sortedServers, foldersWithServers, collapsedFolderIds]);

  /** Indices of server rows that are inside a folder (rendered inside the folder wrapper). */
  const serverRowIndicesInsideFolder = useMemo(() => {
    const set = new Set<number>();
    let idx = 0;
    for (const folder of foldersWithServers) {
      idx++;
      if (!collapsedFolderIds.has(folder.id)) {
        for (let i = 0; i < folder.serverIds.length; i++) {
          set.add(idx);
          idx++;
        }
      }
    }
    return set;
  }, [foldersWithServers, collapsedFolderIds]);

  /** Cumulative top position for each server list row (for placeholder when reordering with folders). */
  const serverRowTops = useMemo(() => {
    const tops: number[] = [0];
    let y = 0;
    for (let i = 0; i < serverListRows.length; i++) {
      const row = serverListRows[i];
      const h = row!.type === 'folder' ? folderRowHeight : (serverRowIndicesInsideFolder.has(i) ? serverItemHeightInFolder : serverItemHeight);
      y += h;
      tops.push(y);
    }
    return tops;
  }, [serverListRows, folderRowHeight, serverItemHeightInFolder, serverItemHeight, serverRowIndicesInsideFolder]);

  const getServerRowHeight = useCallback(
    (index: number) => {
      const row = serverListRows[index];
      if (!row) return serverItemHeight;
      return row.type === 'folder' ? folderRowHeight : (serverRowIndicesInsideFolder.has(index) ? serverItemHeightInFolder : serverItemHeight);
    },
    [serverListRows, serverRowIndicesInsideFolder, folderRowHeight, serverItemHeightInFolder, serverItemHeight]
  );

  // Mirror the servers prop verbatim — the backend already returns it in the
  // user's chosen order via ServerMember.position. New joins / leaves /
  // refetches flow through this effect; nothing else.
  useEffect(() => {
    setSortedServers([...servers]);
  }, [servers]);

  // On tablet, lock to icon-only width (no expand/collapse)
  const effectiveWidth = isTablet ? DEFAULT_WIDTH : width;
  const effectiveSidebarWidth = isCollapsed && !isTablet ? 0 : effectiveWidth;
  useEffect(() => {
    onSidebarWidthChange?.(effectiveSidebarWidth);
  }, [effectiveSidebarWidth, onSidebarWidthChange]);

  const handleDragStart = (e: React.DragEvent, index: number, type: 'nav' | 'server', rowType?: 'server' | 'folder') => {
    setDraggedIndex(index);
    setHoveredIndex(index);
    setDragType(type);
    setDraggedRowType(rowType ?? null);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${type}-${index}`);
    document.body.classList.add('is-dragging');
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setHoveredIndex(null);
    setDragType(null);
    setDropIntent(null);
    setDropInsertIndex(null);
    setDraggedRowType(null);
    document.body.classList.remove('is-dragging');
  };

  const handleContainerDragOver = (e: React.DragEvent, type: 'nav' | 'server') => {
    e.preventDefault();
    if (dragType !== type) return;

    const container = type === 'nav' ? navContainerRef.current : serverContainerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    const relativeY = e.clientY - rect.top;
    const itemCount = type === 'nav' ? navOrder.length : serverListRows.length;
    let newIndex: number;
    let yInItem: number;
    let itemHeight: number;
    if (type === 'server' && serverListRows.some((r) => r.type === 'folder')) {
      let top = 0;
      newIndex = serverListRows.length - 1;
      yInItem = 0;
      itemHeight = serverListRows[serverListRows.length - 1]?.type === 'folder' ? folderRowHeight : (serverRowIndicesInsideFolder.has(serverListRows.length - 1) ? serverItemHeightInFolder : serverItemHeight);
      for (let i = 0; i < serverListRows.length; i++) {
        const row = serverListRows[i];
        const rowH = row.type === 'folder' ? folderRowHeight : (serverRowIndicesInsideFolder.has(i) ? serverItemHeightInFolder : serverItemHeight);
        if (relativeY < top + rowH) {
          newIndex = i;
          yInItem = relativeY - top;
          itemHeight = rowH;
          break;
        }
        top += rowH;
      }
      newIndex = Math.max(0, Math.min(newIndex, itemCount - 1));
    } else {
      itemHeight = type === 'nav' ? navItemHeight : serverItemHeight;
      newIndex = Math.floor(relativeY / itemHeight);
      newIndex = Math.max(0, Math.min(newIndex, itemCount - 1));
      yInItem = relativeY - newIndex * itemHeight;
    }

    if (type === 'server' && dragType === 'server' && draggedIndex !== null) {
      const overRow = serverListRows[newIndex];
      const draggedRow = serverListRows[draggedIndex];

      if (draggedRowType === 'folder') {
        // Dragging a folder: only reorder among top-level positions (folder rows + uncategorized servers)
        setDropIntent('reorder');
        setDropInsertIndex(yInItem < itemHeight / 2 ? newIndex : Math.min(newIndex + 1, itemCount));
      } else {
        const draggedServer = draggedRow?.type === 'server' ? draggedRow.server : null;
        const isOverServerRow = overRow?.type === 'server';
        const targetServer = isOverServerRow && overRow.type === 'server' ? overRow.server : null;
        const isDifferentServer = targetServer && draggedServer && draggedServer.id !== targetServer.id;
        const inMiddleZone = yInItem >= itemHeight * 0.35 && yInItem <= itemHeight * 0.65;

        if (overRow?.type === 'folder' && draggedServer) {
          const draggedFolder = useServerFolderStore.getState().getFolderForServer(draggedServer.id);
          if (draggedFolder && draggedFolder.id === overRow.folder.id) {
            // Dragging out of own folder: reorder (extract)
            setDropIntent('reorder');
            setDropInsertIndex(yInItem < itemHeight / 2 ? newIndex : Math.min(newIndex + 1, itemCount));
          } else {
            setDropIntent('add-to-folder');
            setDropInsertIndex(null);
          }
        } else if (isOverServerRow && isDifferentServer && inMiddleZone) {
          // If the target server is already in a folder, add to that folder — don't create a new one
          const targetFolder = targetServer ? useServerFolderStore.getState().getFolderForServer(targetServer.id) : null;
          if (targetFolder) {
            setDropIntent('add-to-folder');
            setDropInsertIndex(null);
          } else {
            setDropIntent('create-folder');
            setDropInsertIndex(null);
          }
        } else if (isOverServerRow) {
          setDropIntent('reorder');
          setDropInsertIndex(yInItem < itemHeight / 2 ? newIndex : Math.min(newIndex + 1, itemCount));
        } else {
          setDropIntent('reorder');
          setDropInsertIndex(yInItem < itemHeight / 2 ? newIndex : Math.min(newIndex + 1, itemCount));
        }
      }
    } else if (type === 'nav') {
      setDropIntent(null);
      setDropInsertIndex(null);
    }

    if (newIndex !== hoveredIndex) {
      setHoveredIndex(newIndex);
    }
  };

  const handleDrop = (e: React.DragEvent, type: 'nav' | 'server') => {
    e.preventDefault();
    if (draggedIndex === null || hoveredIndex === null || type !== dragType) return;

    if (type === 'nav') {
      if (draggedIndex === hoveredIndex) return;
      const newOrder = [...navOrder];
      const [removed] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(hoveredIndex, 0, removed);
      setNavOrder(newOrder);
    } else {
      const fromRow = serverListRows[draggedIndex];
      const toRow = serverListRows[hoveredIndex];

      // Folder reordering
      if (draggedRowType === 'folder' && fromRow?.type === 'folder') {
        if (dropIntent === 'reorder' && dropInsertIndex !== null) {
          const folders = useServerFolderStore.getState().folders;
          const fromFolderIdx = folders.findIndex((f) => f.id === fromRow.folder.id);
          if (fromFolderIdx === -1) return;
          // Determine target folder index: count how many folder rows precede the drop position
          let targetFolderIdx = 0;
          for (let i = 0; i < dropInsertIndex && i < serverListRows.length; i++) {
            if (serverListRows[i].type === 'folder') targetFolderIdx++;
          }
          if (targetFolderIdx > fromFolderIdx) targetFolderIdx--;
          targetFolderIdx = Math.max(0, Math.min(targetFolderIdx, folders.length - 1));
          if (fromFolderIdx !== targetFolderIdx) {
            const reordered = [...folders];
            const [removed] = reordered.splice(fromFolderIdx, 1);
            reordered.splice(targetFolderIdx, 0, removed);
            const folderIds = reordered.map((f) => f.id);
            useServerFolderStore.getState().reorderFolders(folderIds);
            apiClient.reorderServerFolders(folderIds).catch(() => {
              apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
            });
          }
        }
        setDropIntent(null);
        setDropInsertIndex(null);
        return;
      }

      // Server drag operations
      const fromServer = fromRow?.type === 'server' ? fromRow.server : null;
      const toServer = toRow?.type === 'server' ? toRow.server : null;
      if (!fromServer) return;

      if (dropIntent === 'add-to-folder') {
        // Target can be a folder row OR a server row that belongs to a folder
        const targetFolder = toRow?.type === 'folder'
          ? toRow.folder
          : (toServer ? useServerFolderStore.getState().getFolderForServer(toServer.id) : null);
        if (targetFolder && !targetFolder.serverIds.includes(fromServer.id)) {
          const refetch = () => apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f)).catch(() => {});
          // Remove from any existing folder first
          const existingFolder = useServerFolderStore.getState().getFolderForServer(fromServer.id);
          if (existingFolder) {
            const newExistingIds = existingFolder.serverIds.filter((id) => id !== fromServer.id);
            useServerFolderStore.getState().updateFolder(existingFolder.id, { serverIds: newExistingIds });
            apiClient.updateServerFolder(existingFolder.id, { serverIds: newExistingIds }).catch(refetch);
          }
          // Add to target folder
          const newTargetIds = [...targetFolder.serverIds, fromServer.id];
          useServerFolderStore.getState().updateFolder(targetFolder.id, { serverIds: newTargetIds });
          apiClient.updateServerFolder(targetFolder.id, { serverIds: newTargetIds }).catch(refetch);
          // Clean up any now-empty folders (not single-server — those are intentional)
          const foldersAfter = useServerFolderStore.getState().folders;
          for (const f of foldersAfter) {
            if (f.id !== targetFolder.id && f.serverIds.length === 0) {
              useServerFolderStore.getState().removeFolder(f.id);
              apiClient.deleteServerFolder(f.id).catch(refetch);
            }
          }
        }
      } else if (dropIntent === 'create-folder' && toServer && fromServer.id !== toServer.id) {
        const existingFolder = useServerFolderStore.getState().getFolderForServer(toServer.id);
        if (existingFolder && existingFolder.serverIds.includes(fromServer.id)) {
          return;
        }
        if (existingFolder) {
          const newIds = [...existingFolder.serverIds, fromServer.id];
          useServerFolderStore.getState().updateFolder(existingFolder.id, { serverIds: newIds });
          apiClient.updateServerFolder(existingFolder.id, { serverIds: newIds }).catch(() => {
            apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
          });
        } else {
          const name = t('sidebar.newFolder');
          apiClient.createServerFolder({ name, serverIds: [toServer.id, fromServer.id] }).then((f) => {
            useServerFolderStore.getState().addFolder(f);
          }).catch(() => {
            apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f)).catch(() => {});
          });
        }
      } else if (dropIntent === 'reorder' && dropInsertIndex !== null) {
        const fromSortedIdx = sortedServers.findIndex((s) => s.id === fromServer.id);
        if (fromSortedIdx === -1) return;
        const hasFolders = serverListRows.some((r) => r.type === 'folder');
        const insertIdxInSorted = hasFolders
          ? serverListRows.slice(0, dropInsertIndex).filter((r) => r.type === 'server').length
          : dropInsertIndex;
        let insertIdx = insertIdxInSorted;
        if (fromSortedIdx < insertIdx) insertIdx--;
        // Remove from any existing folder
        const refetchReorder = () => apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f)).catch(() => {});
        const existingFolder = useServerFolderStore.getState().getFolderForServer(fromServer.id);
        if (existingFolder) {
          const newIds = existingFolder.serverIds.filter((id) => id !== fromServer.id);
          useServerFolderStore.getState().updateFolder(existingFolder.id, { serverIds: newIds });
          apiClient.updateServerFolder(existingFolder.id, { serverIds: newIds }).catch(refetchReorder);
        }
        const newServers = [...sortedServers];
        const [removed] = newServers.splice(fromSortedIdx, 1);
        newServers.splice(insertIdx, 0, removed);
        setSortedServers(newServers);
        // Persist to backend so the order follows the user across devices,
        // tabs, and reinstalls. Optimistic update above; on failure we
        // refetch the canonical order from the store on next focus/reconnect.
        if (removed) {
          apiClient.setServerOrder(newServers.map((s) => s.id)).catch(() => { /* server order falls back to what it was; next refetch reconciles */ });
        }
        // Clean up empty folders (not single-server — those are intentional)
        const foldersAfter = useServerFolderStore.getState().folders;
        for (const f of foldersAfter) {
          if (f.serverIds.length === 0) {
            useServerFolderStore.getState().removeFolder(f.id);
            apiClient.deleteServerFolder(f.id).catch(refetchReorder);
          }
        }
      }
    }
    setDropIntent(null);
    setDropInsertIndex(null);
  };

  const getItemStyle = (index: number, type: 'nav' | 'server') => {
    if (dragType !== type || draggedIndex === null || hoveredIndex === null) return {};
    
    if (index === draggedIndex) return { opacity: 0.5 };
    
    if (type === 'server' && (dropIntent === 'create-folder' || dropIntent === 'add-to-folder')) {
      return {};
    }
    if (type === 'server' && dropIntent === 'reorder' && dropInsertIndex !== null) {
      const offset = serverListRows.some((r) => r.type === 'folder') ? getServerRowHeight(draggedIndex) : serverItemHeight;
      const isMovingDown = draggedIndex < dropInsertIndex;
      if (isMovingDown && index > draggedIndex && index < dropInsertIndex) {
        return { transform: `translateY(-${offset}px)`, pointerEvents: 'none' as const };
      }
      if (!isMovingDown && index >= dropInsertIndex && index < draggedIndex) {
        return { transform: `translateY(${offset}px)`, pointerEvents: 'none' as const };
      }
    }
    
    if (type === 'nav') {
      const isMovingDown = draggedIndex < hoveredIndex;
      const offset = navItemHeight;
      if (isMovingDown && index > draggedIndex && index <= hoveredIndex) {
        return { transform: `translateY(-${offset}px)`, pointerEvents: 'none' as const };
      }
      if (!isMovingDown && index < draggedIndex && index >= hoveredIndex) {
        return { transform: `translateY(${offset}px)`, pointerEvents: 'none' as const };
      }
    }
    
    return {};
  };

  const resizeRaf = useRef(0);
  const pendingX = useRef(0);

  const startResizing = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    if (isCollapsed) return;
    isResizing.current = true;
    document.body.style.cursor = 'col-resize';
    sidebarRef.current?.style.setProperty('transition', 'background-color 300ms ease-in-out');
    sidebarRef.current?.classList.add('sidebar-resizing');
  }, [isCollapsed]);

  const stopResizing = useCallback(() => {
    if (isResizing.current) {
      if (resizeRaf.current) { cancelAnimationFrame(resizeRaf.current); resizeRaf.current = 0; }
      const finalWidth = liveWidthRef.current;
      localStorage.setItem(STORAGE_KEY, finalWidth.toString());
      setWidth(finalWidth);
      const el = sidebarRef.current;
      if (el) {
        el.style.setProperty('--sidebar-w', `${finalWidth}`);
        el.style.removeProperty('transition');
        el.classList.remove('sidebar-resizing');
      }
      onSidebarWidthChange?.(finalWidth);
    }
    isResizing.current = false;
    document.body.style.cursor = 'default';
  }, [onSidebarWidthChange]);

  const resize = useCallback((e: MouseEvent) => {
    if (!isResizing.current) return;
    pendingX.current = e.clientX;
    if (resizeRaf.current) return;
    resizeRaf.current = requestAnimationFrame(() => {
      resizeRaf.current = 0;
      const next = Math.min(Math.max(pendingX.current, 64), 160);
      liveWidthRef.current = next;
      const el = sidebarRef.current;
      if (el) {
        el.style.width = `${next}px`;
        el.style.setProperty('--sidebar-w', `${next}`);
      }
    });
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', resize);
    window.addEventListener('mouseup', stopResizing);
    return () => {
      window.removeEventListener('mousemove', resize);
      window.removeEventListener('mouseup', stopResizing);
    };
  }, [resize, stopResizing]);

  const getNavIcon = (id: NavigationTarget) => {
    const lucideIconSize = Math.floor(navButtonSize * 0.45);
    switch (id) {
      case 'home': return <img src={assetPath('/howl-logo.png')} alt="Howl" className="w-full h-full object-contain pointer-events-none" decoding="async" />;
      case 'account': return <LetterAvatar avatar={currentUser?.avatar} username={currentUser?.username || '?'} className="pointer-events-none" />;
      case 'friends': return <Users size={lucideIconSize} strokeWidth={2.5} />;
      case 'dm': return <MessageSquare size={lucideIconSize} strokeWidth={2.5} />;
      default: return null;
    }
  };

  const getNavColor = (id: NavigationTarget) => {
    const colors: Record<string, string> = { home: 'bg-[var(--cyan-accent)]', account: 'bg-[var(--cyan-accent)]', friends: 'bg-[var(--cyan-accent)]', dm: 'bg-[var(--cyan-accent)]' };
    return colors[id] || 'bg-[var(--text-secondary)]';
  };


  /* ── Mobile bottom tab bar ──────────────────────────────────── */
  if (isMobile) {
    return (
      <MobileSidebar
        servers={servers}
        activeId={activeId}
        currentUser={currentUser ?? undefined}
        friendsBadgeCount={friendsBadgeCount}
        messagesBadgeCount={messagesBadgeCount}
        serverMentionCounts={serverMentionCounts}
        onNavSelect={onSelect}
        onServerSelect={onSelect}
        onOpenCreateModal={() => setIsModalOpen(true)}
        drawerOpen={mobileServerDrawerOpen ?? false}
        onDrawerOpenChange={onMobileServerDrawerToggle ?? (() => {})}
        drawerPanelRef={serverDrawerPanelRef}
        backdropRef={serverBackdropRef}
        onServerLongPress={(server, e) => {
          setServerContextMenu({ x: e.clientX, y: e.clientY, server });
        }}
      >
        <CreateJoinServerModal
          open={isModalOpen}
          onClose={() => setIsModalOpen(false)}
          onCreateServer={onCreateServer}
          onJoinServer={onJoinServer}
          onServerCreated={onServerCreated}
          userName={currentUser?.username}
        />
        {serverContextMenu && (
          <ServerContextMenu
            menu={serverContextMenu}
            onClose={() => setServerContextMenu(null)}
            mutedServersMap={mutedServersMap}
            hideMutedChannels={hideMutedChannels}
            serverFolders={serverFolders}
            currentUserId={currentUser?.id}
            hasManagePermission={serverHasPerm(serverContextMenu.server, 'manageServer')}
            onMuteOption={(duration) => handleMuteOptionClick(duration)}
            onUnmute={() => {
              const next = { ...mutedServersMap };
              delete next[serverContextMenu.server.id];
              setMutedServersMapState(next);
              setMutedServersMap(next);
              setServerContextMenu(null);
            }}
            onToggleHideMuted={() => {
              const next = !hideMutedChannels;
              setHideMutedChannelsState(next);
              setHideMutedChannels(next);
            }}
            onRemoveFromFolder={() => {
              const folder = useServerFolderStore.getState().getFolderForServer(serverContextMenu.server.id);
              if (folder) {
                const newIds = folder.serverIds.filter((id) => id !== serverContextMenu.server.id);
                useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
                apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {
                  apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
                });
              }
              setServerContextMenu(null);
            }}
            onAddToFolder={(folderId) => handleAddToFolder(folderId)}
            onCreateFolderAndAdd={() => {
              const name = t('sidebar.newFolder');
              apiClient.createServerFolder({ name, serverIds: [serverContextMenu.server.id] }).then((f) => {
                useServerFolderStore.getState().addFolder(f);
                setSelectedFolderIdState(f.id);
              }).catch(() => {});
              setServerContextMenu(null);
            }}
            onMarkServerRead={() => onMarkServerRead?.(serverContextMenu.server.id)}
            onServerAction={(action) => {
              onSelect(serverContextMenu.server.id);
              onServerContextMenu?.(serverContextMenu.server.id, action);
              setServerContextMenu(null);
            }}
            onEditServerProfile={() => onEditServerProfile?.(serverContextMenu.server.id)}
          />
        )}
      </MobileSidebar>
    );
  }

  return (
    <>
    <style>{`
      .sidebar-resizing,
      .sidebar-resizing * {
        transition-property: none !important;
        transition-duration: 0s !important;
        animation: none !important;
      }
      .sidebar-resizing,
      .sidebar-resizing *  {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        box-shadow: none !important;
        filter: none !important;
        text-shadow: none !important;
      }
      .sidebar-resizing {
        will-change: width;
        contain: layout style;
      }
    `}</style>
    <div
      ref={sidebarRef}
      onPointerLeave={handleSidebarPointerLeave}
      style={{
        contain: 'layout style',
        width: isCollapsed && !isTablet ? '0px' : `${effectiveWidth}px`,
        ['--sidebar-w' as string]: `${effectiveWidth}`,
        backgroundColor: 'var(--glass-bg)',
        borderColor: 'var(--glass-border)',
        boxShadow: '0 0 0 2px var(--glass-border) inset, 8px 0 32px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(24px) saturate(1.3)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.3)',
      }}
      className="perf-glass-layer relative flex flex-col border-r-2 shrink-0 z-50 transition-[width,background-color] duration-300 ease-in-out overflow-visible"
    >
      {!isTablet && <button
        onClick={() => setIsCollapsed(!isCollapsed)}
        className={`perf-glass-layer absolute top-1/2 -translate-y-1/2 w-5 h-10 rounded-full border text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-all z-[60] backdrop-blur-md flex items-center justify-center bg-[var(--glass-bg)] border-[var(--glass-border)] ${isCollapsed ? 'left-2' : '-right-3'}`}
      >
        {isCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>}

      <div className={`w-full h-full flex flex-col items-center pt-6 pb-0 transition-opacity duration-200 ${isCollapsed && !isTablet ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
        
        {/* Core Nav Zone - outside scroll container so badge is not clipped */}
        <LayoutGroup>
        <div
          ref={navContainerRef}
          onDragOver={(e) => handleContainerDragOver(e, 'nav')}
          onDrop={(e) => handleDrop(e, 'nav')}
          className="w-full flex flex-col items-center space-y-2 mb-4 shrink-0 relative overflow-visible"
        >
          {navOrder.map((id, idx) => (
            <div 
              key={id}
              draggable
              onDragStart={(e) => handleDragStart(e, idx, 'nav')}
              onDragEnd={handleDragEnd}
              style={getItemStyle(idx, 'nav')}
              className="w-full relative group flex items-center justify-center transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] select-none overflow-visible"
            >
              {activeId !== id && (
                <div className={`absolute left-0 w-[3px] rounded-r-full transition-all duration-200 ${getNavColor(id)} h-0 opacity-0 group-hover:h-5 group-hover:opacity-60`} />
              )}
              {activeId === id && (
                <motion.div
                  layoutId="nav-active-pill"
                  className={`absolute left-0 w-[3px] h-10 rounded-r-full ${getNavColor(id)}`}
                  style={{ boxShadow: '0 0 8px var(--cyan-accent)' }}
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
              <div className="relative shrink-0" style={{ width: navBtnPx, height: navBtnPx }}>
                <button
                  onClick={() => handleSelectById(id)}
                  style={{ width: navBtnPx, height: navBtnPx, ...(activeId !== id ? { boxShadow: 'inset 0 0 0 1px var(--border-subtle)' } : {}) }}
                  className={`squircle transition-all duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] flex items-center justify-center group/btn cursor-pointer active:cursor-grabbing border-none outline-none w-full h-full ${
                    activeId === id
                      ? `${getNavColor(id)} text-black scale-108 shadow-[0_0_20px_color-mix(in srgb, var(--cyan-accent) 25%, transparent)]`
                      : 'bg-fill-hover text-t-secondary hover:bg-fill-active hover:text-t-primary hover:scale-105 hover:-translate-y-px'
                  } ${id === 'account' ? 'overflow-hidden p-0' : id === 'home' ? 'overflow-hidden' : ''}`}
                >
                  {getNavIcon(id)}
                </button>
                {id === 'friends' && friendsBadgeCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-black px-1 z-10 badge-pop" style={{ boxShadow: '0 0 10px rgba(239,68,68,0.4)' }}>
                    {friendsBadgeCount > 99 ? '99+' : friendsBadgeCount}
                  </span>
                )}
                {id === 'dm' && messagesBadgeCount > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-black px-1 z-10 badge-pop" style={{ boxShadow: '0 0 10px rgba(239,68,68,0.4)' }}>
                    {messagesBadgeCount > 99 ? '99+' : messagesBadgeCount}
                  </span>
                )}
                {id === 'dm' && activeDmCallChannelId && (
                  <div className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-emerald-500 z-10"
                    title="In a call"
                    style={{ width: Math.max(16, Math.floor(navButtonSize * 0.36)), height: Math.max(16, Math.floor(navButtonSize * 0.36)), boxShadow: '0 0 0 2px var(--bg-base), 0 0 8px rgba(16,185,129,0.4)' }}>
                    <Headphones size={Math.max(9, Math.floor(navButtonSize * 0.2))} className="shrink-0 text-white" strokeWidth={2.5} />
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Holographic Guide (Nav) */}
          {dragType === 'nav' && hoveredIndex !== null && (
             <div 
              className="absolute w-full flex items-center justify-center pointer-events-none transition-all duration-200 ease-out z-0"
              style={{ top: `${hoveredIndex * navItemHeight}px`, height: navBtnPx }}
             >
                <div style={{ width: navBtnPx, height: navBtnPx }} className="squircle border-2 border-dashed border-[var(--cyan-accent)]/30 bg-[var(--cyan-accent)]/5" />
             </div>
          )}
        </div>
        </LayoutGroup>

        {/* Discover bar (half-height squircle, matches notifications shape) */}
        <div className="w-full flex flex-col items-center shrink-0 mb-1">
          <button
            type="button"
            onClick={() => onSelect?.('discover' as NavigationTarget)}
            className={`squircle transition-all duration-200 flex items-center justify-center border relative ${
              activeId === 'discover'
                ? 'bg-[var(--cyan-accent)]/15 border-[var(--cyan-accent)]/25 shadow-[0_0_12px_var(--accent-muted)]'
                : 'bg-fill-hover border-default hover:bg-fill-active hover:scale-105'
            }`}
            style={{ width: navBtnPx, height: `calc(${navBtnPx} * 0.5)`, borderRadius: 'min(var(--radius-lg), calc(var(--sidebar-w) * 0.1px))' }}
            title={t('sidebar.discover', 'Discover')}
          >
            <Compass
              size={14}
              strokeWidth={2}
              className={
                activeId === 'discover'
                  ? 'text-[var(--cyan-accent)]'
                  : 'text-t-secondary/70'
              }
            />
          </button>
        </div>

        <div className="w-8 h-px bg-gradient-to-r from-transparent via-white/8 to-transparent my-1 shrink-0" />

        {/* Notification bar */}
        <div className="w-full flex flex-col items-center shrink-0 mb-3">
          <button
            type="button"
            onClick={() => onSelect?.('notifications' as NavigationTarget)}
            className={`squircle transition-all duration-200 flex items-center justify-center border relative ${
              activeId === 'notifications'
                ? 'bg-[var(--cyan-accent)]/15 border-[var(--cyan-accent)]/25 shadow-[0_0_12px_var(--accent-muted)]'
                : notificationTotal > 0
                  ? 'bg-red-500/10 border-red-500/20 hover:bg-red-500/15 hover:scale-105'
                  : 'bg-fill-hover border-default hover:bg-fill-active hover:scale-105'
            }`}
            style={{ width: navBtnPx, height: `calc(${navBtnPx} * 0.5)`, borderRadius: 'min(var(--radius-lg), calc(var(--sidebar-w) * 0.1px))' }}
            title={t('sidebar.notifications')}
          >
            <Bell
              size={14}
              strokeWidth={2}
              className={
                activeId === 'notifications'
                  ? 'text-[var(--cyan-accent)]'
                  : notificationTotal > 0
                    ? 'text-t-secondary'
                    : 'text-t-secondary/50'
              }
            />
            {notificationTotal > 0 && activeId !== 'notifications' && (
              <span
                className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-red-500 text-white text-[8px] font-black px-1 z-10 badge-pop"
                style={{ boxShadow: '0 0 8px rgba(239,68,68,0.4)' }}
              >
                {notificationTotal > 99 ? '99+' : notificationTotal}
              </span>
            )}
          </button>
        </div>

        {/* Scrollable area: servers (grouped by folder when folders exist); folder = small icon only.
            scrollbarWidth:'none' inline is required because the global unlayered scrollbar rules in
            app.css (overflow:overlay→auto on modern Chromium, and the `* { scrollbar-width: thin }`
            Firefox fallback that now also matches Chromium) outrank the layered `no-scrollbar` utility
            and would otherwise reserve a right-side gutter that shifts these centered icons left of the
            nav avatars above. Inline wins over unlayered rules, reclaiming the gutter. */}
        <div style={{ scrollbarWidth: 'none' }} className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden no-scrollbar w-full flex flex-col items-center pt-2 ${floatingBarDocked ? 'pb-[72px]' : 'pb-2'}`}>
        {/* Servers Zone */}
        <LayoutGroup id="servers">
        <div
          ref={serverContainerRef}
          onDragOver={(e) => handleContainerDragOver(e, 'server')}
          onDrop={(e) => handleDrop(e, 'server')}
          className="w-full flex flex-col items-center space-y-2 shrink-0 relative"
        >
          {serverListRows.map((row, idx) =>
            row.type === 'folder' ? (
              <div
                key={row.folder.id}
                draggable
                onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, idx, 'server', 'folder'); }}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => handleDrop(e, 'server')}
                className={`w-[calc(100%-1rem)] mx-auto rounded-2xl px-1.5 py-1 space-y-0 mb-2 overflow-visible relative cursor-pointer active:cursor-grabbing transition-all duration-200 ${dropIntent === 'add-to-folder' && hoveredIndex === idx ? 'ring-2 ring-[var(--cyan-accent)] ring-offset-2 ring-offset-[var(--bg-sidebar)]' : ''}`}
                style={{
                  ...getItemStyle(idx, 'server'),
                  background: 'linear-gradient(180deg, var(--fill-active) 0%, var(--fill-hover) 100%)',
                  backdropFilter: 'blur(20px) saturate(1.2)',
                  WebkitBackdropFilter: 'blur(20px) saturate(1.2)',
                  border: `1px solid ${isValidCssColor(row.folder.color) ? colorWithAlpha(row.folder.color, '40') : 'var(--border-subtle)'}`,
                  boxShadow: isValidCssColor(row.folder.color) ? `inset 0 1px 0 0 var(--fill-active), 0 8px 32px -8px rgba(0,0,0,0.25), 0 0 24px -4px ${colorWithAlpha(row.folder.color, '30')}` : 'inset 0 1px 0 0 var(--fill-active), 0 8px 32px -8px rgba(0,0,0,0.25)',
                }}
                {...longPressBindings((e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setFolderContextMenu({ x: e.clientX, y: e.clientY, folder: row.folder });
                })}
              >
                <div className="w-full flex items-center justify-center relative" style={{ height: folderRowHeight }}>
                  {dropIntent === 'add-to-folder' && hoveredIndex === idx && draggedRowType !== 'folder' && (
                    <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-[var(--cyan-accent)]/20 pointer-events-none z-10">
                      <span className="text-[9px] font-bold text-[var(--cyan-accent)] uppercase tracking-wider">{t('sidebar.addToFolder')}</span>
                    </div>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setCollapsedFolderIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(row.folder.id)) next.delete(row.folder.id);
                        else next.add(row.folder.id);
                        return next;
                      });
                    }}
                    className="flex items-center justify-center hover:bg-fill-hover rounded-lg transition-colors outline-none shrink-0"
                    style={{ width: srvBtnPx, height: srvBtnPx }}
                    title={row.folder.name}
                  >
                    {collapsedFolderIds.has(row.folder.id) ? (
                      <div
                        className="grid grid-cols-2 grid-rows-2 gap-[2px] rounded-xl overflow-hidden"
                        style={{
                          width: srvBtnPx,
                          height: srvBtnPx,
                          padding: `${Math.floor(serverButtonSize * 0.12)}px`,
                          background: 'rgba(var(--bg-base-rgb, 0,0,0), 0.3)',
                          border: isValidCssColor(row.folder.color)
                            ? `1px solid ${colorWithAlpha(row.folder.color, '30')}`
                            : '1px solid var(--border-subtle)',
                          boxShadow: isValidCssColor(row.folder.color)
                            ? `0 0 16px -4px ${colorWithAlpha(row.folder.color, '20')}`
                            : undefined,
                          opacity: row.folder.muted ? 0.45 : 1,
                        }}
                      >
                        {row.folder.serverIds.slice(0, 4).map((sid) => {
                          const s = sortedServers.find((x) => x.id === sid);
                          return s ? (
                            <div key={sid} className="rounded-lg overflow-hidden bg-fill-hover">
                              <ServerIcon icon={s.icon} name={s.name} imgClassName="w-full h-full object-cover" />
                            </div>
                          ) : (
                            <div key={sid} className="rounded-lg bg-fill-hover" />
                          );
                        })}
                        {Array.from({ length: Math.max(0, 4 - row.folder.serverIds.length) }).map((_, i) => (
                          <div key={`empty-${i}`} className="rounded-lg bg-fill-hover" />
                        ))}
                      </div>
                    ) : (
                      <div
                        className="flex items-center justify-center rounded-xl transition-transform w-full h-full"
                        style={{
                          width: srvBtnPx,
                          height: srvBtnPx,
                          backgroundColor: isValidCssColor(row.folder.color)
                            ? colorWithAlpha(row.folder.color, '15')
                            : 'var(--fill-active)',
                          border: isValidCssColor(row.folder.color)
                            ? `1px solid ${colorWithAlpha(row.folder.color, '25')}`
                            : '1px solid var(--border-subtle)',
                          opacity: row.folder.muted ? 0.45 : 1,
                        }}
                      >
                        <Folder
                          size={Math.floor(serverButtonSize * 0.55)}
                          strokeWidth={1.5}
                          style={{
                            color: isValidCssColor(row.folder.color) ? row.folder.color! : 'var(--text-secondary)',
                          }}
                        />
                      </div>
                    )}
                  </button>
                  {/* Folder badge rollup when collapsed */}
                  {collapsedFolderIds.has(row.folder.id) && !row.folder.muted && (() => {
                    const folderServerIds = row.folder.serverIds ?? EMPTY_SERVER_IDS;
                    const folderMentionTotal = folderServerIds.reduce((sum: number, sid: string) => sum + (serverMentionCounts[sid] ?? 0), 0);
                    const folderHasUnread = folderServerIds.some((sid: string) => serverUnreadIds.has(sid));
                    if (folderMentionTotal > 0) return (
                      <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-red-500 text-white text-[8px] font-black px-1 z-10 badge-pop" style={{ boxShadow: '0 0 8px rgba(239,68,68,0.4)' }}>{folderMentionTotal > 99 ? '99+' : folderMentionTotal}</span>
                    );
                    if (folderHasUnread) return <div className="absolute top-1/2 -translate-y-1/2 -right-2 w-2 h-2 rounded-full bg-[var(--text-primary)] shrink-0 z-10" style={{ boxShadow: '0 0 6px var(--accent-glow)' }} />;
                    return null;
                  })()}
                </div>
                {!collapsedFolderIds.has(row.folder.id) &&
                  serverListRows.slice(idx + 1, idx + 1 + row.folder.serverIds.length).map((r, off) =>
                    r.type === 'server' ? (
<div
                        key={r.server.id}
                        draggable
                        onDragStart={(e) => { e.stopPropagation(); handleDragStart(e, idx + 1 + off, 'server', 'server'); }}
                        onDragEnd={handleDragEnd}
                        {...longPressBindings((e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setServerContextMenu({ x: e.clientX, y: e.clientY, server: r.server });
                        })}
                        style={{ ...getItemStyle(idx + 1 + off, 'server'), height: serverItemHeightInFolder }}
                        className={`w-full relative group flex items-center justify-center transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] select-none cursor-pointer active:cursor-grabbing rounded-lg ${(dropIntent === 'create-folder' || dropIntent === 'add-to-folder') && hoveredIndex === idx + 1 + off ? 'ring-2 ring-[var(--cyan-accent)] ring-offset-2 ring-offset-[var(--bg-sidebar)]' : ''}`}
                        onClick={() => handleSelectById(r.server.id)}
                        onMouseEnter={(e) => handleServerMouseEnter(r.server.id, e)}
                        onMouseLeave={handleServerMouseLeave}
                      >
                        {(dropIntent === 'create-folder' || dropIntent === 'add-to-folder') && hoveredIndex === idx + 1 + off && (
                          <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-[var(--cyan-accent)]/20 pointer-events-none z-10">
                            <div className="flex flex-col items-center gap-0.5">
                              <Folder size={28} className="text-[var(--cyan-accent)]" strokeWidth={2} />
                              <span className="text-[10px] font-bold text-[var(--cyan-accent)] uppercase tracking-wider">
                                {dropIntent === 'add-to-folder' ? t('sidebar.moveToFolder') : t('sidebar.createFolder')}
                              </span>
                            </div>
                          </div>
                        )}
                        {activeId !== r.server.id && (
                          <div className={`absolute left-0 w-[3px] rounded-r-full transition-all duration-200 bg-white h-0 opacity-0 group-hover:h-5 group-hover:opacity-60`} />
                        )}
                        {activeId === r.server.id && (
                          <motion.div
                            layoutId="server-active-pill"
                            className="absolute left-0 w-[3px] h-10 rounded-r-full bg-white"
                            transition={{ type: "spring", stiffness: 500, damping: 35 }}
                          />
                        )}
                        <div className={`transition-all duration-500 ease-out shrink-0 relative ${activeId === r.server.id ? 'scale-108' : 'group-hover:scale-105 group-hover:-translate-y-px'}`} style={{ width: srvBtnPx, height: srvBtnPx }}>
                          <div className="w-full h-full squircle overflow-hidden transition-all duration-300 relative" style={{ boxShadow: activeId !== r.server.id ? '0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 var(--fill-hover)' : '0 2px 12px rgba(0,0,0,0.4)' }}>
                            <ServerIcon
                              icon={r.server.icon}
                              name={r.server.name}
                              active={activeId === r.server.id}
                              freezeAnimation={!!r.server.icon?.match(/\.gif(\?|$)/i) && (r.server.powerUpCount ?? 0) < 2}
                              imgClassName={`transition-all duration-500 ${activeId === r.server.id ? 'grayscale-0' : 'grayscale group-hover:grayscale-0 opacity-40 group-hover:opacity-90'}`}
                            />
                          </div>
                          {connectedVoiceServerId === r.server.id && (
                            <div className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-emerald-500 z-10" title={t('sidebar.inVoiceChannel')} style={{ width: Math.max(16, Math.floor(serverButtonSize * 0.36)), height: Math.max(16, Math.floor(serverButtonSize * 0.36)), boxShadow: '0 0 0 2px var(--bg-base), 0 0 8px rgba(16,185,129,0.4)' }}>
                              <Headphones size={Math.max(9, Math.floor(serverButtonSize * 0.2))} className="shrink-0 text-white" strokeWidth={2.5} />
                            </div>
                          )}
                          {serverMentionCounts[r.server.id] > 0 && (
                            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-black px-1 z-10 badge-pop" title={t('sidebar.mentioned')} style={{ boxShadow: '0 0 10px rgba(239,68,68,0.4)' }}>{serverMentionCounts[r.server.id]! > 99 ? '99+' : serverMentionCounts[r.server.id]}</span>
                          )}
                          {serverUnreadIds.has(r.server.id) && (() => {
                            const entry = mutedServersMap[r.server.id];
                            const muted = !!entry && (entry.until === null || entry.until > Date.now());
                            return !muted ? <div className="absolute top-1/2 -translate-y-1/2 -right-2 w-2 h-2 rounded-full bg-[var(--text-primary)] shrink-0 z-10" title={t('sidebar.newMessages')} style={{ boxShadow: '0 0 6px var(--accent-glow)' }} /> : null;
                          })()}
                        </div>
                      </div>
                    ) : null
                  )}
              </div>
            ) : serverRowIndicesInsideFolder.has(idx) ? null : (
            <div 
              key={row.server.id} 
              role="button"
              tabIndex={0}
              aria-label={row.server.name}
              draggable
              onDragStart={(e) => handleDragStart(e, idx, 'server', 'server')}
              onDragEnd={handleDragEnd}
              {...longPressBindings((e) => {
                e.preventDefault();
                e.stopPropagation();
                setServerContextMenu({ x: e.clientX, y: e.clientY, server: row.server });
              })}
              style={getItemStyle(idx, 'server')}
              className={`w-full relative group flex items-center justify-center transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] select-none cursor-pointer active:cursor-grabbing ${(dropIntent === 'create-folder' || dropIntent === 'add-to-folder') && hoveredIndex === idx ? 'ring-2 ring-[var(--cyan-accent)] ring-offset-2 ring-offset-[var(--bg-sidebar)] rounded-xl' : ''}`}
              onClick={() => handleSelectById(row.server.id)}
              onKeyDown={(e) => handleServerKeyDown(e, row.server.id)}
              onMouseEnter={(e) => handleServerMouseEnter(row.server.id, e)}
              onMouseLeave={handleServerMouseLeave}
            >
              {(dropIntent === 'create-folder' || dropIntent === 'add-to-folder') && hoveredIndex === idx && (
                <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-[var(--cyan-accent)]/20 pointer-events-none z-10">
                  <div className="flex flex-col items-center gap-0.5">
                    <Folder size={28} className="text-[var(--cyan-accent)]" strokeWidth={2} />
                    <span className="text-[10px] font-bold text-[var(--cyan-accent)] uppercase tracking-wider">
                      {dropIntent === 'add-to-folder' ? t('sidebar.moveToFolder') : t('sidebar.createFolder')}
                    </span>
                  </div>
                </div>
              )}
              {activeId !== row.server.id && (
                <div className={`absolute left-0 w-[3px] rounded-r-full transition-all duration-200 bg-white h-0 opacity-0 group-hover:h-5 group-hover:opacity-60`} />
              )}
              {activeId === row.server.id && (
                <motion.div
                  layoutId="server-active-pill"
                  className="absolute left-0 w-[3px] h-10 rounded-r-full bg-white"
                  transition={{ type: "spring", stiffness: 500, damping: 35 }}
                />
              )}
              <div
                className={`transition-all duration-500 ease-out shrink-0 relative ${activeId === row.server.id ? 'scale-108' : 'group-hover:scale-105 group-hover:-translate-y-px'}`}
                style={{ width: srvBtnPx, height: srvBtnPx }}
              >
                <div className="w-full h-full squircle overflow-hidden transition-all duration-300 relative" style={{ boxShadow: activeId !== row.server.id ? '0 2px 8px rgba(0,0,0,0.3), inset 0 1px 0 var(--fill-hover)' : '0 2px 12px rgba(0,0,0,0.4)' }}>
                  <ServerIcon
                    icon={row.server.icon}
                    name={row.server.name}
                    active={activeId === row.server.id}
                    freezeAnimation={!!row.server.icon?.match(/\.gif(\?|$)/i) && (row.server.powerUpCount ?? 0) < 2}
                    imgClassName={`transition-all duration-500 ${activeId === row.server.id ? 'grayscale-0' : 'grayscale group-hover:grayscale-0 opacity-40 group-hover:opacity-90'}`}
                  />
                </div>
                {connectedVoiceServerId === row.server.id && (
                  <div className="absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-emerald-500 z-10" title={t('sidebar.inVoiceChannel')} style={{ width: Math.max(16, Math.floor(serverButtonSize * 0.36)), height: Math.max(16, Math.floor(serverButtonSize * 0.36)), boxShadow: '0 0 0 2px var(--bg-base), 0 0 8px rgba(16,185,129,0.4)' }}>
                    <Headphones size={Math.max(9, Math.floor(serverButtonSize * 0.2))} className="shrink-0 text-white" strokeWidth={2.5} />
                  </div>
                )}
                {serverMentionCounts[row.server.id] > 0 && (
                  <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-black px-1 z-10 badge-pop" title={t('sidebar.mentioned')} style={{ boxShadow: '0 0 10px rgba(239,68,68,0.4)' }}>
                    {serverMentionCounts[row.server.id]! > 99 ? '99+' : serverMentionCounts[row.server.id]}
                  </span>
                )}
                {!serverMentionCounts[row.server.id] && calendarDotState[row.server.id] === 'live' && (
                  <div className="absolute top-1/2 -translate-y-1/2 -right-2 w-2 h-2 rounded-full bg-red-500 shrink-0 z-10 animate-pulse" style={{ boxShadow: '0 0 6px rgba(239,68,68,0.5)' }} />
                )}
                {!serverMentionCounts[row.server.id] && calendarDotState[row.server.id] === 'soon' && !serverUnreadIds.has(row.server.id) && (
                  <div className="absolute top-1/2 -translate-y-1/2 -right-2 w-2 h-2 rounded-full bg-amber-400 shrink-0 z-10" style={{ boxShadow: '0 0 6px rgba(245,158,11,0.5)' }} />
                )}
                {serverUnreadIds.has(row.server.id) && (() => {
                  const entry = mutedServersMap[row.server.id];
                  const muted = !!entry && (entry.until === null || entry.until > Date.now());
                  return !muted ? <div className="absolute top-1/2 -translate-y-1/2 -right-2 w-2 h-2 rounded-full bg-[var(--text-primary)] shrink-0 z-10" title={t('sidebar.newMessages')} style={{ boxShadow: '0 0 6px var(--accent-glow)' }} /> : null;
                })()}
              </div>
            </div>
            )
          )}

          {/* Holographic Guide (Server): reorder placeholder at dropInsertIndex; create-folder is shown on the row itself */}
          {dragType === 'server' && dropIntent === 'reorder' && dropInsertIndex !== null && (
             <div 
              className="absolute w-full flex items-center justify-center pointer-events-none transition-all duration-200 ease-out z-0"
              style={{
                top: `${serverListRows.some((r) => r.type === 'folder') ? serverRowTops[Math.min(dropInsertIndex, serverRowTops.length - 1)] : dropInsertIndex * serverItemHeight}px`,
                height: srvBtnPx,
              }}
             >
                <div style={{ width: srvBtnPx, height: srvBtnPx }} className="squircle border-2 border-dashed border-[var(--border-strong)] bg-fill-hover" />
             </div>
          )}

          <div className="w-full relative group flex items-center justify-center shrink-0">
            <button 
              onClick={() => setIsModalOpen(true)}
              style={{ width: srvBtnPx, height: srvBtnPx }}
              className="squircle transition-all duration-300 flex items-center justify-center border-none bg-fill-hover text-t-secondary hover:bg-[var(--cyan-accent)] hover:text-black hover:scale-105 shrink-0 outline-none shadow-none"
            >
              <Plus size={Math.floor(serverButtonSize * 0.45)} strokeWidth={3} />
            </button>
          </div>
        </div>
        </LayoutGroup>
        <div className="flex-1" />
        </div>

        {/* Pin footer: always-visible dock toggle the server list can never scroll under (hidden when docked, since the status bar fills that space) */}
        {onFloatingBarDockToggle && !isCollapsed && !floatingBarDocked && (
          <div
            className="w-full shrink-0 flex flex-col items-center pt-3 pb-4 bg-[var(--bg-sidebar)] border-t border-[var(--border-subtle)]"
          >
            <button
              type="button"
              onClick={onFloatingBarDockToggle}
              className="flex items-center justify-center rounded-full transition-all duration-150 hover:scale-110 hover:brightness-125 active:scale-95 outline-none border-none focus:ring-2 focus:ring-[var(--cyan-accent)]/30 focus:ring-offset-1 focus:ring-offset-[var(--bg-sidebar)] bg-[var(--accent-subtle)] text-[var(--cyan-accent)]"
              style={{
                width: 28,
                height: 28,
              }}
              title={t('sidebar.dockStatusBar')}
              data-dock-toggle="true"
            >
              <Pin size={14} strokeWidth={2.25} />
            </button>
          </div>
        )}
      </div>

      {!isCollapsed && !isTablet && (
        <div onMouseDown={startResizing} className="absolute top-0 right-0 w-1.5 h-full cursor-col-resize hover:bg-fill-hover transition-colors z-50 group/handle">
            <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-transparent group-hover/handle:bg-fill-stronger rounded-full transition-colors" />
        </div>
      )}

      {serverContextMenu && (
        <ServerContextMenu
          menu={serverContextMenu}
          onClose={() => setServerContextMenu(null)}
          mutedServersMap={mutedServersMap}
          hideMutedChannels={hideMutedChannels}
          serverFolders={serverFolders}
          currentUserId={currentUser?.id}
          hasManagePermission={serverHasPerm(serverContextMenu.server, 'manageServer')}
          onMuteOption={(duration) => handleMuteOptionClick(duration)}
          onUnmute={() => {
            const next = { ...mutedServersMap };
            delete next[serverContextMenu.server.id];
            setMutedServersMapState(next);
            setMutedServersMap(next);
            setServerContextMenu(null);
          }}
          onToggleHideMuted={() => {
            const next = !hideMutedChannels;
            setHideMutedChannelsState(next);
            setHideMutedChannels(next);
          }}
          onRemoveFromFolder={() => {
            const folder = useServerFolderStore.getState().getFolderForServer(serverContextMenu.server.id);
            if (folder) {
              const newIds = folder.serverIds.filter((id) => id !== serverContextMenu.server.id);
              useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
              apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {
                apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
              });
            }
            setServerContextMenu(null);
          }}
          onAddToFolder={(folderId) => handleAddToFolder(folderId)}
          onCreateFolderAndAdd={() => {
            const name = t('sidebar.newFolder');
            apiClient.createServerFolder({ name, serverIds: [serverContextMenu.server.id] }).then((f) => {
              useServerFolderStore.getState().addFolder(f);
              setSelectedFolderIdState(f.id);
            }).catch(() => {});
            setServerContextMenu(null);
          }}
          onMarkServerRead={() => onMarkServerRead?.(serverContextMenu.server.id)}
          onServerAction={(action) => {
            onSelect(serverContextMenu.server.id);
            onServerContextMenu?.(serverContextMenu.server.id, action);
            setServerContextMenu(null);
          }}
          onEditServerProfile={() => onEditServerProfile?.(serverContextMenu.server.id)}
        />
      )}


      {folderContextMenu && (
        <FolderContextMenu
          menu={folderContextMenu}
          onClose={() => setFolderContextMenu(null)}
          onMarkFolderRead={() => {
            folderContextMenu.folder.serverIds.forEach((sid) => onMarkServerRead?.(sid));
            setFolderContextMenu(null);
          }}
          onOpenFolderSettings={() => {
            setFolderSettingsFolderId(folderContextMenu.folder.id);
            setFolderContextMenu(null);
          }}
          onCloseAllFolders={() => {
            setCollapsedFolderIds(new Set(serverFolders.map((f) => f.id)));
            setFolderContextMenu(null);
          }}
          onToggleMute={() => {
            const folder = folderContextMenu!.folder;
            const newMuted = !folder.muted;
            useServerFolderStore.getState().updateFolder(folder.id, { muted: newMuted });
            apiClient.updateServerFolder(folder.id, { muted: newMuted }).catch(() => {
              useServerFolderStore.getState().updateFolder(folder.id, { muted: !newMuted });
            });
            setFolderContextMenu(null);
          }}
          onDeleteFolder={() => {
            const folder = folderContextMenu!.folder;
            useServerFolderStore.getState().removeFolder(folder.id);
            apiClient.deleteServerFolder(folder.id).catch(() => {
              apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
            });
            setFolderContextMenu(null);
          }}
        />
      )}

      {folderSettingsFolderId && (() => {
        const folder = serverFolders.find((f) => f.id === folderSettingsFolderId);
        if (!folder) return null;
        return createPortal(
          <FolderSettingsModal
            folder={folder}
            onClose={() => setFolderSettingsFolderId(null)}
            onSave={(name, color) => {
              useServerFolderStore.getState().updateFolder(folder.id, { name, color: color ?? null });
              apiClient.updateServerFolder(folder.id, { name, color: color ?? null }).catch(() => {
                apiClient.getServerFolders().then((f) => useServerFolderStore.getState().setFolders(f));
              });
              setFolderSettingsFolderId(null);
            }}
          />,
          document.body
        );
      })()}

      {/* Server preview hover popup */}
      {!isMobile && voicePopupServerId && voicePopupAnchor && (() => {
        const server = servers.find(s => s.id === voicePopupServerId);
        if (!server) return null;
        return (
          <ServerPreviewPopup
            anchor={voicePopupAnchor}
            server={server}
            voiceData={serverVoiceSummary?.[voicePopupServerId]}
            onMouseEnter={handlePopupMouseEnter}
            onMouseLeave={handlePopupMouseLeave}
          />
        );
      })()}

      <CreateJoinServerModal
        open={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onCreateServer={onCreateServer}
        onJoinServer={onJoinServer}
        onServerCreated={onServerCreated}
        userName={currentUser?.username}
      />
    </div>
    </>
  );
});
