// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { Channel } from '../types';
import { User as UserIcon, AtSign, MessageCircle, Phone, FileText, ChevronRight, UserMinus, Shield, Volume2, UserCircle, MicOff, VolumeX, ArrowRightLeft, Headphones } from 'lucide-react';
import type { UserWithRole } from './UserProfilePopup';
import { useContextMenuPosition, getSubmenuPosition, GLASS_MENU_CLASS } from '../utils/contextMenuStyles';
import VolumePopup from './VolumePopup';
import { useUiStore } from '../stores/uiStore';
import { useAuthStore } from '../stores/authStore';

interface UserContextMenuProps {
  canKick?: boolean;
  isTargetOwner?: boolean;
  onClose: () => void;
  onProfile: (userId: string) => void;
  onMention: (userId: string) => void;
  onCreateDM: (userId: string) => void;
  onInviteToServer?: () => void;
  onOpenModView?: (userId: string) => void;
  onKick?: (userId: string) => void;
  onBan?: (userId: string) => void;
  onBlock?: (userId: string) => void;
  /** When true, show Unblock instead of Block; requires onUnblock. */
  isBlocked?: boolean;
  onUnblock?: (userId: string) => void;
  onIgnore?: (userId: string) => void;
  onRemoveFriend?: (userId: string) => void;
  /** Navigate to User Settings > Profiles for the given server (only when in a server context) */
  onEditServerProfile?: (serverId: string) => void;
  /** Active server ID, used to show "Edit Server Profile" for self */
  serverId?: string;
  /** User IDs of people we're currently in a voice chat with (show Volume row only for them). */
  inVoiceWithUserIds?: string[];
  participantVolumes?: Record<string, number>;
  onParticipantVolumeChange?: (userId: string, volume: number) => void;
  canMuteMembers?: boolean;
  isTargetServerMuted?: boolean;
  isTargetServerDeafened?: boolean;
  onServerMute?: (userId: string, muted: boolean) => void;
  onServerDeafen?: (userId: string, deafened: boolean) => void;
  canMoveMembers?: boolean;
  voiceChannels?: Channel[];
  currentVoiceChannelId?: string | null;
  onMoveToVoiceChannel?: (userId: string, toChannelId: string) => void;
  /** Self mute/deafen state and toggles – shown when right-clicking yourself in voice */
  isMuted?: boolean;
  isDeafened?: boolean;
  onToggleMute?: () => void;
  onToggleDeafen?: () => void;
  /** Open the change-nickname modal for the target user. The handler is
   *  given the user id; AppLayout decides whether the menu item is shown
   *  by passing `canChangeNickname` based on permissions. */
  onChangeNickname?: (userId: string) => void;
  /** True when the target user can have their nickname changed by the
   *  current user — either it's themselves with the changeNickname perm,
   *  or someone else with manageNicknames + role hierarchy. */
  canChangeNickname?: boolean;
}

export const UserContextMenu: React.FC<UserContextMenuProps> = ({
  canKick,
  isTargetOwner,
  onClose,
  onProfile,
  onMention,
  onCreateDM,
  onInviteToServer,
  onOpenModView,
  onKick,
  onBan,
  onBlock,
  isBlocked,
  onUnblock,
  onIgnore,
  onRemoveFriend,
  onEditServerProfile,
  serverId,
  inVoiceWithUserIds = [],
  participantVolumes = {},
  onParticipantVolumeChange,
  canMuteMembers,
  isTargetServerMuted,
  isTargetServerDeafened,
  onServerMute,
  onServerDeafen,
  canMoveMembers,
  voiceChannels = [],
  currentVoiceChannelId,
  onMoveToVoiceChannel,
  isMuted,
  isDeafened,
  onToggleMute,
  onToggleDeafen,
  onChangeNickname,
  canChangeNickname,
}) => {
  const contextTarget = useUiStore(s => s.userContextMenuTarget);
  const currentUserId = useAuthStore(s => s.currentUser)?.id ?? '';
  // target is guaranteed non-null by the parent's conditional render guard
  const user = contextTarget?.user as UserWithRole;
  const x = contextTarget?.x ?? 0;
  const y = contextTarget?.y ?? 0;
  const { t } = useTranslation();
  const isSelf = user.id === currentUserId;
  const isInVoice = inVoiceWithUserIds.includes(user.id);
  const showModActions = !!canKick && !isTargetOwner && !isSelf;
  const showVolumeRow = !isSelf && isInVoice && onParticipantVolumeChange;
  const [moveToOpen, setMoveToOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const moveToTargetChannels = voiceChannels.filter(c => c.id !== currentVoiceChannelId);
  const showMoveTo = canMoveMembers && isInVoice && onMoveToVoiceChannel && moveToTargetChannels.length > 0;

  const { menuRef, style: posStyle } = useContextMenuPosition(x, y);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const item = (label: string, onClick: () => void, icon?: React.ReactNode, red?: boolean, arrow?: boolean) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => { onClick(); onClose(); }}
      className={`w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight transition-colors ${red ? 'text-red-400 hover:bg-red-500/10' : 'hover:bg-fill-hover'}`}
      style={{ color: red ? undefined : 'var(--text-primary)' }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      {arrow && <ChevronRight size={14} className="opacity-60" />}
    </button>
  );

  const checkItem = (label: string, checked: boolean, onClick: () => void, icon?: React.ReactNode) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => { onClick(); }}
      className="w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
      style={{ color: 'var(--text-primary)' }}
    >
      {icon}
      <span className="flex-1">{label}</span>
      <div className={`w-[18px] h-[18px] rounded-[5px] border flex items-center justify-center ${checked ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)]' : 'border-[var(--border-strong)]'}`}>
        {checked && <span className="text-white text-[10px] leading-none font-bold">✓</span>}
      </div>
    </button>
  );

  const sep = () => <div className="h-px my-1 mx-3" style={{ backgroundColor: 'var(--border-subtle)' }} />;

  const moveToTriggerRef = useRef<HTMLDivElement>(null);
  const [moveToSubPos, setMoveToSubPos] = useState<{ left: number; top: number } | null>(null);

  const handleMoveToEnter = () => {
    setMoveToOpen(true);
    requestAnimationFrame(() => {
      if (moveToTriggerRef.current) {
        const rect = moveToTriggerRef.current.getBoundingClientRect();
        setMoveToSubPos(getSubmenuPosition(rect, 200, Math.min(moveToTargetChannels.length * 36 + 8, 248)));
      }
    });
  };

  return createPortal(
    <>
      <div className="fixed inset-0 z-[var(--z-popover)]" onClick={onClose} aria-hidden />
      <div
        ref={menuRef}
        role="menu"
        className={`fixed z-[var(--z-popover)] py-1.5 min-w-[220px] glass ${GLASS_MENU_CLASS}`}
        style={posStyle}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {item(t('userMenu.profile'), () => onProfile(user.id), <UserIcon size={16} className="opacity-70 shrink-0" />)}
        {item(t('userMenu.mention'), () => onMention(user.id), <AtSign size={16} className="opacity-70 shrink-0" />)}
        {!isSelf && item(t('userMenu.message'), () => onCreateDM(user.id), <MessageCircle size={16} className="opacity-70 shrink-0" />)}
        {!isSelf && item(t('userMenu.call'), () => {}, <Phone size={16} className="opacity-70 shrink-0" />)}
        {isInVoice && onToggleMute && checkItem(t('userMenu.mute'), !!isMuted, onToggleMute, <MicOff size={16} className="opacity-70 shrink-0" />)}
        {isInVoice && onToggleDeafen && checkItem(t('userMenu.deafen'), !!isDeafened, onToggleDeafen, <Headphones size={16} className="opacity-70 shrink-0" />)}
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
                <span className="flex-1">{t('userMenu.volume')}</span>
                <span className="text-[10px] font-bold tabular-nums text-[var(--cyan-accent)]">{Math.round((participantVolumes[user.id] ?? 0.5) * 100)}%</span>
              </button>
              {volumeOpen && (
                <div className="absolute left-full ml-1 top-0 z-20">
                  <VolumePopup
                    userId={user.id}
                    username={user.username}
                    volume={participantVolumes[user.id] ?? 0.5}
                    onChange={onParticipantVolumeChange!}
                    onClose={() => setVolumeOpen(false)}
                  />
                </div>
              )}
            </div>
          </>
        )}
        {serverId && onEditServerProfile && item(t('userMenu.editServerProfile'), () => { onEditServerProfile(serverId); onClose(); }, <UserCircle size={16} className="opacity-70 shrink-0" />)}
        {item(t('userMenu.apps'), () => {}, null, false, true)}
        {showMoveTo && (
          <div
            ref={moveToTriggerRef}
            className="relative"
            onMouseEnter={handleMoveToEnter}
            onMouseLeave={() => setMoveToOpen(false)}
          >
            <button
              type="button"
              className="w-full flex items-center gap-3 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onClick={() => setMoveToOpen(prev => !prev)}
            >
              <ArrowRightLeft size={16} className="opacity-70 shrink-0" />
              <span className="flex-1">{t('userMenu.moveTo')}</span>
              <ChevronRight size={14} className="opacity-60" />
            </button>
          </div>
        )}
        {canMuteMembers && isInVoice && onServerMute && (
          <>
            {sep()}
            {checkItem(
              t('userMenu.serverMute'),
              !!isTargetServerMuted,
              () => onServerMute(user.id, !isTargetServerMuted),
              <MicOff size={16} className="opacity-70 shrink-0 text-red-400" />,
            )}
            {onServerDeafen && checkItem(
              t('userMenu.serverDeafen'),
              !!isTargetServerDeafened,
              () => onServerDeafen(user.id, !isTargetServerDeafened),
              <VolumeX size={16} className="opacity-70 shrink-0 text-red-400" />,
            )}
          </>
        )}
        {onOpenModView && item(t('userMenu.openInModView'), () => onOpenModView(user.id), <Shield size={16} className="opacity-70 shrink-0" />)}
        {sep()}
        {item(t('userMenu.addNote'), () => {}, <FileText size={16} className="opacity-70 shrink-0" />)}
        {!isSelf && item(t('userMenu.addFriendNickname'), () => {}, null)}
        {canChangeNickname && onChangeNickname && item(t('userMenu.changeNickname'), () => onChangeNickname(user.id), null)}
        {!isSelf && onInviteToServer && item(t('userMenu.inviteToServer'), onInviteToServer, null, false, true)}
        {!isSelf && onRemoveFriend && item(t('userMenu.removeFriend'), () => onRemoveFriend(user.id), <UserMinus size={16} className="opacity-70 shrink-0" />)}
        {!isSelf && onIgnore && item(t('userMenu.ignore'), () => onIgnore(user.id), null)}
        {!isSelf && isBlocked && onUnblock ? item(t('common.unblock'), () => onUnblock(user.id), null) : !isSelf && onBlock ? item(t('common.block'), () => onBlock(user.id), null, true) : null}
        {showModActions && (
          <>
            {sep()}
            {item(t('userMenu.roles'), () => {}, <Shield size={16} className="opacity-70 shrink-0" />, false, true)}
            {onKick && item(t('userMenu.kickUser', { username: user.username }), () => onKick(user.id), null, true)}
            {onBan && item(t('userMenu.banUser', { username: user.username }), () => onBan(user.id), null, true)}
          </>
        )}
      </div>
      {showMoveTo && moveToOpen && moveToSubPos && (
        <div
          className={`fixed z-[var(--z-popover)] py-1 min-w-[180px] max-h-[240px] overflow-y-auto glass ${GLASS_MENU_CLASS}`}
          style={{ left: moveToSubPos.left, top: moveToSubPos.top }}
          onMouseEnter={() => setMoveToOpen(true)}
          onMouseLeave={() => setMoveToOpen(false)}
        >
          {moveToTargetChannels.map(ch => (
            <button
              key={ch.id}
              type="button"
              onClick={() => { onMoveToVoiceChannel!(user.id, ch.id); onClose(); }}
              className="w-full flex items-center gap-2 px-3 py-2 mx-1.5 rounded-lg text-left text-[13px] font-medium tracking-tight hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-primary)' }}
            >
              <Volume2 size={14} className="opacity-50 shrink-0" />
              <span className="truncate">{ch.name}</span>
            </button>
          ))}
        </div>
      )}
    </>,
    document.body
  );
};
