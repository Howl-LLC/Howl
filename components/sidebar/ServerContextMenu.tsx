// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, UserPlus, Folder, FolderPlus, ChevronRight, VolumeX, Volume2, Bell, EyeOff, Settings, Plus, Shield, UserCircle, Calendar, LogOut } from 'lucide-react';
import { getSubmenuPosition, GLASS_MENU_CLASS, ContextMenuContainer } from '../../utils/contextMenuStyles';
import { getServerNotificationSettings, setServerNotificationLevel, type ServerNotificationLevel } from '../../utils/serverNotificationStorage';
import { useServerFolderStore } from '../../stores/serverFolderStore';
import type { Server } from '../../types';
import type { ServerFolder } from '../../services/api/serverFolders';
import type { MuteDuration } from '../GroupChatContextMenu';
import type { ServerContextAction } from '../Sidebar';

const SERVER_MUTE_OPTIONS: { value: MuteDuration; labelKey: string }[] = [
  { value: '15m', labelKey: 'sidebar.for15Min' },
  { value: '1h', labelKey: 'sidebar.for1Hour' },
  { value: '3h', labelKey: 'sidebar.for3Hours' },
  { value: '8h', labelKey: 'sidebar.for8Hours' },
  { value: '24h', labelKey: 'sidebar.for24Hours' },
  { value: 'forever', labelKey: 'sidebar.untilTurnBack' },
];

export interface ServerContextMenuProps {
  menu: { x: number; y: number; server: Server };
  onClose: () => void;
  mutedServersMap: Record<string, { until: number | null }>;
  hideMutedChannels: boolean;
  serverFolders: ServerFolder[];
  currentUserId?: string;
  hasManagePermission: boolean;
  onMuteOption: (duration: MuteDuration) => void;
  onUnmute: () => void;
  onToggleHideMuted: () => void;
  onRemoveFromFolder: () => void;
  onAddToFolder: (folderId: string) => void;
  onCreateFolderAndAdd: () => void;
  onMarkServerRead: () => void;
  onServerAction: (action: ServerContextAction) => void;
  onEditServerProfile: () => void;
}

export const ServerContextMenu: React.FC<ServerContextMenuProps> = ({
  menu,
  onClose,
  mutedServersMap,
  hideMutedChannels,
  serverFolders,
  currentUserId,
  hasManagePermission,
  onMuteOption,
  onUnmute,
  onToggleHideMuted,
  onRemoveFromFolder,
  onAddToFolder,
  onCreateFolderAndAdd,
  onMarkServerRead,
  onServerAction,
  onEditServerProfile,
}) => {
  const { t } = useTranslation();
  const sid = menu.server.id;

  // Submenu state (internal)
  const [muteSubmenu, setMuteSubmenu] = useState<{ left: number; top: number } | null>(null);
  const [notificationSubmenu, setNotificationSubmenu] = useState<{ left: number; top: number } | null>(null);
  const [folderSubmenu, setFolderSubmenu] = useState<{ left: number; top: number } | null>(null);

  const muteTriggerRef = useRef<HTMLDivElement>(null);
  const notificationTriggerRef = useRef<HTMLDivElement>(null);
  const folderTriggerRef = useRef<HTMLDivElement>(null);
  const muteSubmenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notificationSubmenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const folderSubmenuCloseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const muteEntry = mutedServersMap[sid];
  const isMuted = !!muteEntry && (muteEntry.until === null || muteEntry.until > Date.now());
  const isInFolder = !!useServerFolderStore.getState().getFolderForServer(sid);

  const closeAll = () => {
    if (muteSubmenuCloseTimeoutRef.current) clearTimeout(muteSubmenuCloseTimeoutRef.current);
    if (notificationSubmenuCloseTimeoutRef.current) clearTimeout(notificationSubmenuCloseTimeoutRef.current);
    if (folderSubmenuCloseTimeoutRef.current) clearTimeout(folderSubmenuCloseTimeoutRef.current);
    onClose();
    setMuteSubmenu(null);
    setNotificationSubmenu(null);
    setFolderSubmenu(null);
  };

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[var(--z-popover)]"
        aria-hidden
        onClick={closeAll}
        onContextMenu={(e) => { e.preventDefault(); closeAll(); }}
      />
      <ContextMenuContainer
        x={menu.x}
        y={menu.y}
        estWidth={240}
        estHeight={520}
        className={`fixed z-[var(--z-popover)] py-2 min-w-[240px] glass ${GLASS_MENU_CLASS}`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-2">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => { onMarkServerRead(); onClose(); }}
          >
            <Check size={16} className="shrink-0 opacity-80" />
            {t('sidebar.markAsRead')}
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => onServerAction('invite')}
          >
            <UserPlus size={16} className="shrink-0 text-[var(--cyan-accent)]" />
            {t('sidebar.inviteToServer')}
          </button>
        </div>
        <div className="h-px bg-fill-active my-2" />

        {/* Folder section */}
        <div ref={folderTriggerRef} className="px-2 relative">
          {isInFolder ? (
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onClick={onRemoveFromFolder}
            >
              <Folder size={16} className="shrink-0 opacity-80" />
              {t('sidebar.removeFromFolder')}
            </button>
          ) : (
            <button
              type="button"
              className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={() => {
                if (folderSubmenuCloseTimeoutRef.current) {
                  clearTimeout(folderSubmenuCloseTimeoutRef.current);
                  folderSubmenuCloseTimeoutRef.current = null;
                }
                const el = folderTriggerRef.current;
                if (el) {
                  const rect = el.getBoundingClientRect();
                  const pos = getSubmenuPosition(rect, 200, 220);
                  setFolderSubmenu(pos);
                }
              }}
              onMouseLeave={() => {
                folderSubmenuCloseTimeoutRef.current = setTimeout(() => setFolderSubmenu(null), 150);
              }}
            >
              <span className="flex items-center gap-3">
                <Folder size={16} className="shrink-0 opacity-80" />
                {t('sidebar.addToFolder')}
              </span>
              <ChevronRight size={14} className="shrink-0 opacity-60" />
            </button>
          )}
        </div>
        <div className="h-px bg-fill-active my-2" />

        {/* Mute section */}
        <div ref={muteTriggerRef} className="px-2 relative">
          {isMuted ? (
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onClick={onUnmute}
            >
              <Volume2 size={16} className="shrink-0 opacity-80" />
              {t('sidebar.unmuteServer')}
            </button>
          ) : (
            <button
              type="button"
              className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={() => {
                if (muteSubmenuCloseTimeoutRef.current) {
                  clearTimeout(muteSubmenuCloseTimeoutRef.current);
                  muteSubmenuCloseTimeoutRef.current = null;
                }
                const el = muteTriggerRef.current;
                if (el) {
                  const rect = el.getBoundingClientRect();
                  const pos = getSubmenuPosition(rect, 240, 280);
                  setMuteSubmenu(pos);
                }
              }}
              onMouseLeave={() => {
                muteSubmenuCloseTimeoutRef.current = setTimeout(() => setMuteSubmenu(null), 150);
              }}
            >
              <span className="flex items-center gap-3">
                <VolumeX size={16} className="shrink-0 opacity-80" />
                {t('sidebar.muteServer')}
              </span>
              <ChevronRight size={14} className="shrink-0 opacity-60" />
            </button>
          )}
        </div>

        {/* Notification settings trigger */}
        <div ref={notificationTriggerRef} className="px-2 relative">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onMouseEnter={() => {
              if (notificationSubmenuCloseTimeoutRef.current) {
                clearTimeout(notificationSubmenuCloseTimeoutRef.current);
                notificationSubmenuCloseTimeoutRef.current = null;
              }
              const el = notificationTriggerRef.current;
              if (el) {
                const rect = el.getBoundingClientRect();
                const pos = getSubmenuPosition(rect, 240, 140);
                setNotificationSubmenu(pos);
              }
            }}
            onMouseLeave={() => {
              notificationSubmenuCloseTimeoutRef.current = setTimeout(() => setNotificationSubmenu(null), 150);
            }}
          >
            <span className="flex items-center gap-3 min-w-0">
              <Bell size={16} className="shrink-0 opacity-80" />
              <span>{t('sidebar.notificationSettings')}</span>
            </span>
            <ChevronRight size={14} className="shrink-0 opacity-60" />
          </button>
        </div>

        {/* Hide muted channels toggle */}
        <div className="px-2">
          <button
            type="button"
            className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={onToggleHideMuted}
          >
            <span className="flex items-center gap-3">
              <EyeOff size={16} className="shrink-0 opacity-80" />
              {t('sidebar.hideMutedChannels')}
            </span>
            <div className={`w-4 h-4 rounded-lg border shrink-0 flex items-center justify-center ${hideMutedChannels ? 'bg-[var(--cyan-accent)]/30 border-[var(--cyan-accent)]' : 'border-[var(--border-strong)]'}`}>
              {hideMutedChannels && <Check size={12} className="text-[var(--cyan-accent)]" />}
            </div>
          </button>
        </div>
        <div className="h-px bg-fill-active my-2" />

        {/* Admin actions */}
        {hasManagePermission && (
          <>
            <div className="px-2">
              <button
                type="button"
                className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-primary)' }}
                onClick={() => onServerAction('settings')}
              >
                <span className="flex items-center gap-3">
                  <Settings size={16} className="shrink-0 opacity-80" />
                  {t('sidebar.serverSettings')}
                </span>
                <ChevronRight size={14} className="shrink-0 opacity-60" />
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-primary)' }}
                onClick={() => onServerAction('createChannel')}
              >
                <Plus size={16} className="shrink-0 opacity-80" />
                {t('sidebar.createChannel')}
              </button>
            </div>
            <div className="h-px bg-fill-active my-2" />
          </>
        )}

        {/* Bottom actions */}
        <div className="px-2">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => onServerAction('settings')}
          >
            <Shield size={16} className="shrink-0 opacity-80" />
            {t('sidebar.privacySettings')}
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => { onClose(); onEditServerProfile(); }}
          >
            <UserCircle size={16} className="shrink-0 opacity-80" />
            {t('sidebar.editServerProfile')}
          </button>
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
            onClick={() => onServerAction('notifications')}
          >
            <Calendar size={16} className="shrink-0 opacity-80" />
            {t('sidebar.createEvent')}
          </button>
        </div>
        <div className="h-px bg-fill-active my-2" />
        <div className="px-2">
          <button
            type="button"
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors text-red-400 hover:text-red-300 hover:bg-red-500/10"
            onClick={() => onServerAction('leave')}
          >
            <LogOut size={16} className="shrink-0" />
            {t('sidebar.leaveServer')}
          </button>
        </div>
      </ContextMenuContainer>

      {/* Mute Server submenu */}
      {muteSubmenu && (
        <div
          className={`fixed z-[var(--z-popover)] py-2 min-w-[240px] glass ${GLASS_MENU_CLASS}`}
          style={{ left: muteSubmenu.left, top: muteSubmenu.top }}
          onMouseEnter={() => {
            if (muteSubmenuCloseTimeoutRef.current) {
              clearTimeout(muteSubmenuCloseTimeoutRef.current);
              muteSubmenuCloseTimeoutRef.current = null;
            }
          }}
          onMouseLeave={() => setMuteSubmenu(null)}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2">
            {SERVER_MUTE_OPTIONS.map(({ value, labelKey }) => (
              <button
                key={value}
                type="button"
                onClick={() => onMuteOption(value)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
                style={{ color: 'var(--text-primary)' }}
              >
                {t(labelKey)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Notification Settings submenu */}
      {notificationSubmenu && (() => {
        const notifPrefs = getServerNotificationSettings(sid, currentUserId);
        const levels: { value: ServerNotificationLevel; labelKey: string }[] = [
          { value: 'all', labelKey: 'sidebar.allMessages' },
          { value: 'mentions', labelKey: 'sidebar.onlyMentions' },
          { value: 'none', labelKey: 'sidebar.nothing' },
        ];
        return (
          <div
            className={`fixed z-[var(--z-popover)] py-2 min-w-[240px] glass ${GLASS_MENU_CLASS}`}
            style={{ left: notificationSubmenu.left, top: notificationSubmenu.top }}
            onMouseEnter={() => {
              if (notificationSubmenuCloseTimeoutRef.current) {
                clearTimeout(notificationSubmenuCloseTimeoutRef.current);
                notificationSubmenuCloseTimeoutRef.current = null;
              }
            }}
            onMouseLeave={() => setNotificationSubmenu(null)}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-2">
              {levels.map(({ value, labelKey }) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => {
                    setServerNotificationLevel(sid, value, currentUserId);
                    setNotificationSubmenu(null);
                    onClose();
                  }}
                  className="w-full flex items-center justify-between gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {t(labelKey)}
                  {notifPrefs.level === value && <Check size={14} className="shrink-0 text-[var(--cyan-accent)]" />}
                </button>
              ))}
            </div>
          </div>
        );
      })()}

      {/* Folder submenu */}
      {folderSubmenu && (
        <div
          className={`fixed z-[var(--z-popover)] py-2 min-w-[200px] glass ${GLASS_MENU_CLASS}`}
          style={{ left: folderSubmenu.left, top: folderSubmenu.top }}
          onMouseEnter={() => {
            if (folderSubmenuCloseTimeoutRef.current) {
              clearTimeout(folderSubmenuCloseTimeoutRef.current);
              folderSubmenuCloseTimeoutRef.current = null;
            }
          }}
          onMouseLeave={() => setFolderSubmenu(null)}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2">
            {serverFolders.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => onAddToFolder(f.id)}
                className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors truncate"
                style={{ color: 'var(--text-primary)' }}
              >
                {f.name}
              </button>
            ))}
            <button
              type="button"
              onClick={onCreateFolderAndAdd}
              className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left text-sm hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--cyan-accent)' }}
            >
              <FolderPlus size={16} className="shrink-0" />
              {t('sidebar.newFolder')}
            </button>
          </div>
        </div>
      )}
    </>,
    document.body
  );
};
