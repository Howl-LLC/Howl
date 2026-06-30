// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Check,
  User as UserIcon,
  Phone,
  FileText,
  ChevronRight,
  UserMinus,
  X,
  Bell,
  Volume2,
  Pin,
} from 'lucide-react';
import VolumePopup from './VolumePopup';
import { formatUsername } from '../types';
import type { UserWithRole } from './UserProfilePopup';
import type { MuteDuration } from './GroupChatContextMenu';
import { useContextMenuPosition, getSubmenuPosition, GLASS_MENU_CLASS } from '../utils/contextMenuStyles';

const MUTE_OPTION_KEYS: { value: MuteDuration; key: string }[] = [
  { value: '15m', key: 'dmMenu.for15Minutes' },
  { value: '1h', key: 'dmMenu.for1Hour' },
  { value: '3h', key: 'dmMenu.for3Hours' },
  { value: '8h', key: 'dmMenu.for8Hours' },
  { value: '24h', key: 'dmMenu.for24Hours' },
  { value: 'forever', key: 'dmMenu.untilITurnItBackOn' },
];

interface DirectMessageContextMenuProps {
  user: UserWithRole;
  dmChannelId: string;
  x: number;
  y: number;
  isUnread?: boolean;
  onClose: () => void;
  onMarkAsRead: (dmChannelId: string) => void;
  onProfile: (userId: string) => void;
  onCloseDM: (dmChannelId: string) => void;
  onInviteToServer?: () => void;
  onRemoveFriend?: (userId: string) => void;
  onIgnore?: (userId: string) => void;
  onBlock?: (userId: string) => void;
  isBlocked?: boolean;
  onUnblock?: (userId: string) => void;
  isPinned?: boolean;
  onPinConversation?: (dmChannelId: string) => void;
  onUnpinConversation?: (dmChannelId: string) => void;
  onMute?: (userId: string, duration: MuteDuration) => void;
  /** User IDs of people we're currently in a voice chat with (show Volume row only for them). */
  inVoiceWithUserIds?: string[];
  participantVolumes?: Record<string, number>;
  onParticipantVolumeChange?: (userId: string, volume: number) => void;
}

export const DirectMessageContextMenu: React.FC<DirectMessageContextMenuProps> = ({
  user,
  dmChannelId,
  x,
  y,
  isUnread,
  onClose,
  onMarkAsRead,
  onProfile,
  onCloseDM,
  onInviteToServer,
  onRemoveFriend,
  onIgnore,
  onBlock,
  isBlocked,
  onUnblock,
  isPinned,
  onPinConversation,
  onUnpinConversation,
  onMute,
  inVoiceWithUserIds = [],
  participantVolumes = {},
  onParticipantVolumeChange,
}) => {
  const { t } = useTranslation();
  const [muteSubmenu, setMuteSubmenu] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const showVolumeRow = inVoiceWithUserIds.includes(user.id) && onParticipantVolumeChange;

  const { menuRef, style: posStyle } = useContextMenuPosition(x, y);
  const muteTriggerRef = useRef<HTMLDivElement>(null);
  const [muteSubPos, setMuteSubPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const handleMuteEnter = () => {
    setMuteSubmenu(true);
    requestAnimationFrame(() => {
      if (muteTriggerRef.current) {
        const rect = muteTriggerRef.current.getBoundingClientRect();
        setMuteSubPos(getSubmenuPosition(rect, 220, MUTE_OPTION_KEYS.length * 40 + 16));
      }
    });
  };

  const item = (
    label: string,
    onClick: () => void,
    icon?: React.ReactNode,
    red?: boolean,
    arrow?: boolean
  ) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        onClick();
        onClose();
      }}
      className={`w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight transition-colors ${red ? 'text-red-400 hover:bg-red-500/10' : 'hover:bg-fill-hover'}`}
      style={{ color: red ? undefined : 'var(--text-primary)' }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {arrow && <ChevronRight size={14} className="opacity-60" />}
    </button>
  );

  const sep = () => <div className="h-px my-1 mx-3" style={{ backgroundColor: 'var(--border-subtle)' }} />;

  const displayName = formatUsername(user);

  return createPortal(
    <>
      <div className="fixed inset-0 z-[var(--z-popover)]" onClick={onClose} aria-hidden />
      <div
        ref={menuRef}
        role="menu"
        className={`fixed z-[var(--z-popover)] py-1.5 min-w-[220px] flex glass ${GLASS_MENU_CLASS}`}
        style={posStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex-1 min-w-0">
          <button
            type="button"
            role="menuitem"
            onClick={() => { if (isUnread) { onMarkAsRead(dmChannelId); onClose(); } }}
            disabled={!isUnread}
            className={`w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight transition-colors ${isUnread ? 'hover:bg-fill-hover cursor-pointer' : 'opacity-50 cursor-not-allowed'}`}
            style={{ color: 'var(--text-primary)' }}
          >
            <Check size={16} className="opacity-70 shrink-0" />
            <span className="flex-1">{t('dmMenu.markAsRead')}</span>
          </button>
          {sep()}
          {item(t('dmMenu.profile'), () => onProfile(user.id), <UserIcon size={16} className="opacity-70 shrink-0" />)}
          {item(t('dmMenu.call'), () => {}, <Phone size={16} className="opacity-70 shrink-0" />)}
          {showVolumeRow && (
            <>
              {sep()}
              <div className="relative" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => setVolumeOpen((v) => !v)}
                >
                  <Volume2 size={16} className="opacity-70 shrink-0" />
                  <span className="flex-1">{t('dmMenu.volume')}</span>
                  <span className="text-[10px] font-bold tabular-nums text-violet-400">{Math.round((participantVolumes[user.id] ?? 0.5) * 100)}%</span>
                </button>
                {volumeOpen && (
                  <div className="absolute left-full ml-1 top-0 z-20">
                    <VolumePopup
                      userId={user.id}
                      username={displayName}
                      volume={participantVolumes[user.id] ?? 0.5}
                      onChange={onParticipantVolumeChange!}
                      onClose={() => setVolumeOpen(false)}
                      accentColor="rgb(167, 139, 250)"
                    />
                  </div>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => { onClose(); }}
            className="w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
            style={{ color: 'var(--text-primary)' }}
          >
            <FileText size={16} className="opacity-70 shrink-0" />
            <div className="flex-1 text-left">
              <div>{t('dmMenu.addNote')}</div>
              <div className="text-[11px] font-normal opacity-70">{t('dmMenu.onlyVisibleToYou')}</div>
            </div>
          </button>
          {item(t('dmMenu.addFriendNickname'), () => {}, undefined)}
          {isPinned && onUnpinConversation
            ? item(t('dmMenu.unpinConversation'), () => onUnpinConversation(dmChannelId), <Pin size={16} className="opacity-70 shrink-0" />)
            : onPinConversation && item(t('dmMenu.pinConversation'), () => onPinConversation(dmChannelId), <Pin size={16} className="opacity-70 shrink-0" />)}
          {item(t('dmMenu.closeDm'), () => onCloseDM(dmChannelId), <X size={16} className="opacity-70 shrink-0" />)}
          {sep()}
          {item(t('dmMenu.apps'), () => {}, undefined, false, true)}
          {onInviteToServer && item(t('dmMenu.inviteToServer'), onInviteToServer, undefined, false, true)}
          {onRemoveFriend && item(t('dmMenu.removeFriend'), () => onRemoveFriend(user.id), <UserMinus size={16} className="opacity-70 shrink-0" />)}
          {onIgnore && item(t('dmMenu.ignore'), () => onIgnore(user.id), undefined)}
          {isBlocked && onUnblock ? item(t('common.unblock'), () => onUnblock(user.id), undefined) : onBlock ? item(t('common.block'), () => onBlock(user.id), undefined, true) : null}
          {onMute && (
            <>
              {sep()}
              <div
                ref={muteTriggerRef}
                onMouseEnter={handleMuteEnter}
                onMouseLeave={() => setMuteSubmenu(false)}
              >
                <button
                  type="button"
                  className="w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
                  style={{ color: 'var(--text-primary)' }}
                  onClick={() => setMuteSubmenu(prev => !prev)}
                >
                  <Bell size={16} className="opacity-70 shrink-0" />
                  <span className="flex-1">{t('dmMenu.muteUser', { displayName })}</span>
                  <ChevronRight size={14} className="opacity-60" />
                </button>
              </div>
            </>
          )}
        </div>
      </div>
      {onMute && muteSubmenu && muteSubPos && (
        <div
          className={`fixed z-[var(--z-popover)] py-1.5 min-w-[200px] glass ${GLASS_MENU_CLASS}`}
          style={{ left: muteSubPos.left, top: muteSubPos.top }}
          onMouseEnter={() => setMuteSubmenu(true)}
          onMouseLeave={() => setMuteSubmenu(false)}
        >
          {MUTE_OPTION_KEYS.map(({ value, key }) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                onMute!(user.id, value);
                onClose();
              }}
              className="w-full px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  );
};
