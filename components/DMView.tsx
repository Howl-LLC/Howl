// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { ChatArea } from './ChatArea';
import type { ForwardPayload } from './ForwardImageModal';
import { MemberList } from './MemberList';
import { GroupChatContextMenu } from './GroupChatContextMenu';
import { User, Message, GameActivity } from '../types';
import { Users, MessageCircle, X, Loader2, Pin, ArrowLeft, Phone, PhoneOff, Video, BellOff, Gamepad2, Music, Activity, Shield, KeyRound, Eye, EyeOff, AlertTriangle, RotateCw } from 'lucide-react';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { navigateToMessage } from '../utils/navigateToMessage';
import { useIsMobile } from '../hooks/useIsMobile';
import { useRenderLoopDetector } from '../hooks/useRenderLoopDetector';
import { longPressBindings } from '../hooks/useLongPress';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { GroupAvatarComposite } from './GroupAvatarComposite';
import { RoleNameStyle } from './RoleNameStyle';
import { isDmChannelMuted } from '../utils/dmMuteStorage';
import { getOtrFirstSwipeSeen, setOtrFirstSwipeSeen } from '../utils/otrFirstSwipeStorage';
import { kickFromGroupDM } from '../utils/dmActions';
import { useSwipeGesture } from '../hooks/useSwipeGesture';
import { useSettings } from '../contexts/SettingsContext';
import * as dmKeyManager from '../services/dmKeyManager';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { roomKey, type MlsTier } from '../services/mls/roomKey';
import { routeEstablishOutcome } from '../utils/mlsRetry';
import { isChannelMls } from '../services/encryptionFlags';
import { resolveRecoverabilityState } from '../utils/recoverabilityState';
import { useAuthStore } from '../stores/authStore';
import { useDmStore } from '../stores/dmStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useMessageStore } from '../stores/messageStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useAppStore } from '../stores/appStore';
import { useTypingStore } from '../stores/typingStore';
import { useUiStore } from '../stores/uiStore';
import { useSocialStore } from '../stores/socialStore';
import { TypingStatusDot } from './TypingStatusDot';

import { EMPTY_ARRAY } from '../stores/types';
const DMProfilePanel = React.lazy(() => import('./DMProfilePanel').then(m => ({ default: m.DMProfilePanel })));
import { getProfilePanelOpen, setProfilePanelOpen as savePanelOpen, getProfilePanelWidth, setProfilePanelWidth as savePanelWidth, clampProfilePanelWidth } from '../utils/dmProfilePanelStorage';
function ActivityIcon({ type, size }: { type: string; size: number }) {
  switch (type) {
    case 'spotify':
    case 'listening':
      return <Music size={size} />;
    case 'bio':
      return null;
    case 'steam_game':
    case 'detected_game':
    case 'custom':
      return <Gamepad2 size={size} />;
    default:
      return <Activity size={size} />;
  }
}

import { GroupEditModal } from './dm/GroupEditModal';
import { AddFriendsToDmModal } from './dm/AddFriendsToDmModal';
import { CreateGroupDmModal } from './dm/CreateGroupDmModal';
import { InlineCallSurface } from './call/InlineCallSurface';
import { ParticipantCardFooter } from './call/ParticipantCardFooter';



/** Swipeable DM list item wrapper: swipe-left opens that chat's OTR room,
 *  swipe-right returns it to Saved. Mobile only; OTR-eligible 1:1 rows only.
 *  Quick actions (mute/pin/close) live in the long-press / right-click menu. */
const SwipeableDmItem: React.FC<{
  children: React.ReactNode;
  dmId: string;
  onOpenOtr: (dmId: string) => void;
  onReturnSaved: (dmId: string) => void;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
}> = React.memo(({ children, dmId, onOpenOtr, onReturnSaved, scrollContainerRef }) => {
  const contentRef = useRef<HTMLDivElement>(null);
  const MAX_DRAG = 96;

  const snapBack = useCallback(() => {
    if (contentRef.current) {
      contentRef.current.style.transition = 'transform 0.2s ease-out';
      contentRef.current.style.transform = '';
    }
  }, []);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    el.addEventListener('scroll', snapBack, { passive: true });
    return () => el.removeEventListener('scroll', snapBack);
  }, [scrollContainerRef, snapBack]);

  const swipe = useSwipeGesture({
    direction: 'horizontal',
    threshold: 56,
    velocityThreshold: 0.4,
    enabled: true,
    maxCrossAxis: 30,
    onDrag: (dx) => {
      const clamped = Math.max(-MAX_DRAG, Math.min(MAX_DRAG, dx));
      if (contentRef.current) {
        contentRef.current.style.transition = 'none';
        contentRef.current.style.transform = `translateX(${clamped}px)`;
      }
    },
    onSwipe: (dir) => {
      snapBack();
      if (dir === 'left') onOpenOtr(dmId);
      else if (dir === 'right') onReturnSaved(dmId);
    },
    onCancel: snapBack,
  });

  return (
    <div className="relative overflow-hidden rounded-lg" data-dm-swipe={dmId}>
      <div ref={contentRef} {...swipe.bind} className="relative z-[1] bg-app-surface">
        {children}
      </div>
    </div>
  );
});
SwipeableDmItem.displayName = 'SwipeableDmItem';

const GROUP_MEMBERS_COLUMN_MIN = 180;
const GROUP_MEMBERS_COLUMN_MAX = 400;
const GROUP_MEMBERS_COLUMN_DEFAULT = 280;
const GROUP_MEMBERS_OPEN_KEY = 'howl_group_dm_members_open';
const GROUP_MEMBERS_WIDTH_KEY = 'howl_group_dm_members_column_width';

export interface DMChannelItem {
  id: string;
  otherUser?: { id: string; username: string; discriminator?: string; avatar?: string | null; banner?: string | null; status?: string; activity?: GameActivity | null; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; stripePlan?: string | null; effectivePlan?: string | null; badges?: string[] } | null;
  isGroup?: boolean;
  name?: string;
  icon?: string;
  encrypted?: boolean;
  serverReadable?: boolean;
  otherUsers?: Array<{ id: string; username: string; discriminator?: string; avatar?: string; status?: string; activity?: GameActivity | null; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; stripePlan?: string | null; effectivePlan?: string | null }>;
  lastMessage?: { content: string; createdAt: string };
  pinned?: boolean;
  pinnedAt?: string;
  blockedByMe?: boolean;
  blockedByThem?: boolean;
  blockedParticipantIds?: string[];
  ownerId?: string | null;
  otrMlsGroupId?: string | null;
}

const EMPTY_OTHER_USERS: NonNullable<DMChannelItem['otherUsers']> = [];

/** Single source of truth for group chat display: custom name if set, else comma-separated names of all members (current user + others). Used in both the left bar and the chat header. */
function getGroupDisplayName(dm: DMChannelItem, currentUser?: { username: string; discriminator?: string | null }): string {
  if (dm.name && dm.name.trim()) return dm.name.trim();
  const others = dm.otherUsers ?? EMPTY_OTHER_USERS;
  const allMembers = currentUser ? [currentUser, ...others] : others;
  if (allMembers.length > 0) {
    return allMembers.map((u) => u.username).join(', ');
  }
  return 'Group';
}

interface DMViewProps {
  dmUsers: Array<{ id: string; username: string; discriminator?: string; avatar?: string; avatarEffect?: string | null; effectivePlan?: string | null; stripePlan?: string | null }>;
  onSelectDM: (dmChannelId: string | null) => void;
  onSendDMMessage: (dmChannelId: string, content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string }, tier?: MlsTier) => void;
  /** When true, show "sending too fast" banner above message input */
  rateLimitBanner?: boolean;
  /** Transient error message from automod / content filter / slow mode */
  messageSendError?: string | null;
  /** Error loading/decrypting DM messages — shown as banner with retry */
  dmLoadError?: string | null;
  /** Retry loading messages after a load error */
  onRetryLoadMessages?: () => void;
  onCreateOrSelectDM: (otherUserId: string) => void | Promise<void>;
  onCreateGroupDM: (memberIds: string[]) => Promise<void>;
  onUpdateGroupDM?: (dmChannelId: string, data: { name?: string; icon?: string }) => void;
  onMarkDmRead?: (dmChannelId: string) => void;
  onLeaveGroupDM?: (dmChannelId: string) => void;
  onPinConversation?: (dmChannelId: string) => void;
  onUnpinConversation?: (dmChannelId: string) => void;
  onPinMessage?: (dmChannelId: string, messageId: string) => void;
  onUnpinMessage?: (dmChannelId: string, messageId: string) => void;
  getDMPins?: (dmChannelId: string) => Promise<Array<Message & { pinnedAt: string; pinnedById: string }>>;
  getFriends?: () => Promise<User[]>;
  allUsers: User[];
  onUserClick?: (user: import('./UserProfilePopup').UserWithRole, e: React.MouseEvent) => void;
  onUserRightClick?: (user: import('./UserProfilePopup').UserWithRole, e: React.MouseEvent) => void;
  /** When right-clicking a direct conversation in the list, call this (so DM-specific menu with Close DM, Mark As Read, etc. can show) */
  onDirectMessageContextMenu?: (user: import('./UserProfilePopup').UserWithRole, dmChannelId: string, e: React.MouseEvent) => void;
  onDeleteDMMessage?: (dmChannelId: string, messageId: string) => void;
  onEditDMMessage?: (dmChannelId: string, messageId: string, newContent: string) => void;
  onReportDMMessage?: (dmChannelId: string, messageId: string) => void;
  onReactDMMessage?: (dmChannelId: string, messageId: string, emoji: string) => void;
  /** Start a voice call in this DM */
  onStartVoiceCall?: (dmChannelId: string) => void;
  /** Start a video call in this DM */
  onStartVideoCall?: (dmChannelId: string) => void;
  /** When user forwards an image from the lightbox, open forward modal with this attachment */
  onForwardImage?: (attachment: { url: string; name: string; contentType?: string }) => void;
  /** When user chooses Forward in message context menu, open forward modal with this payload */
  onForwardMessage?: (payload: ForwardPayload) => void;
  /** When user mutes a group DM from the context menu (persist and optionally affect unread badge) */
  onMuteDM?: (dmChannelId: string, duration: import('./GroupChatContextMenu').MuteDuration) => void;
  activeDmCallChannelId?: string | null;
  incomingDmCall?: { dmChannelId: string; fromUserId: string; username: string; avatar?: string; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; withVideo?: boolean; e2eeKey?: string; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null } | null;
  incomingCallNeedsUnlock?: boolean;
  onAcceptIncomingCall?: (joinWithVideo: boolean) => void;
  onDeclineIncomingCall?: () => void;
  onTyping?: () => void;
  /** Add members to an existing group DM */
  onAddGroupDmMembers?: (dmChannelId: string, memberIds: string[]) => Promise<void>;
  /** Load older DM messages (scroll-up pagination) */
  onLoadMoreDmMessages?: () => void;
  uiDensity?: 'compact' | 'default' | 'spacious';
  /** Top inset (px) to clear the floating Navigator logo in rail-less mode. */
  navTopInset?: number;
  /** Called after DM encryption is unlocked so App can clear stale message cache */
  onDmUnlocked?: () => void;
  /** Called when user clicks Join on an invite embed in a DM */
  onJoinInvite?: (code: string) => void;
  /** Called when user clicks View Server on an invite embed in a DM */
  onViewInviteServer?: (serverId: string) => void;
  /** Override file upload function (e.g. for E2E-encrypted file uploads in DMs) */
  uploadFile?: (file: File) => Promise<{ url: string; name: string; contentType: string; size: number; width?: number | null; height?: number | null; e2ee?: { key: string; thumbUrl?: string; thumbKey?: string; thumbWidth?: number; thumbHeight?: number } }>;
  /** Fire a global toast (threaded from App). Used for the OTR first-swipe explainer. */
  onShowToast?: (message: string, type?: 'info' | 'warning', durationMs?: number, opts?: { actionLabel?: string; onAction?: () => void }) => void;
}

import { UserAvatar } from './UserAvatar';
import { TierUnreadBadge } from './TierUnreadBadge';

/* ── Memoized DM channel item content ── */

const DmChannelItemContent = React.memo(function DmChannelItemContent({
  dm,
  isActive: _isActive,
  showActivity,
  unread,
  unreadCount,
  otrUnread,
  otrUnreadCount,
  isMuted,
}: {
  dm: DMChannelItem;
  isActive: boolean;
  showActivity: boolean;
  unread: boolean;
  unreadCount: number;
  otrUnread: boolean;
  otrUnreadCount: number;
  isMuted: boolean;
}) {
  const isOtherUserTyping = useTypingStore(
    useCallback(
      (s: { typingByChannel: Record<string, Record<string, { username: string; expires: number }>> }) =>
        dm.otherUser?.id ? !!(s.typingByChannel[dm.id]?.[dm.otherUser.id]) : false,
      [dm.id, dm.otherUser?.id]
    )
  );

  const avatarUser = dm.otherUser ?? { username: '?', avatar: null };
  return (
    <>
      <UserAvatar user={avatarUser} size={38} className="mr-3" shape="squircle">
        <TypingStatusDot
          status={dm.otherUser?.status ?? 'offline'}
          isTyping={isOtherUserTyping}
          size={13}
          className="absolute -bottom-0.5 -right-0.5"
        />
      </UserAvatar>
      <div className="min-w-0 text-left flex-1">
        <div className="flex items-center gap-1 text-[13px] font-black tracking-tight">
          <span className="truncate">{dm.otherUser ? (() => {
            const plan = dm.otherUser!.effectivePlan || dm.otherUser!.stripePlan;
            return plan === 'pro' && (dm.otherUser!.nameColor || dm.otherUser!.nameFont || dm.otherUser!.nameEffect)
              ? <RoleNameStyle name={dm.otherUser!.username} overrideColor={dm.otherUser!.nameColor} overrideFont={dm.otherUser!.nameFont} nameEffect={dm.otherUser!.nameEffect} />
              : dm.otherUser!.username;
          })() : 'Unknown'}</span>
        </div>
        {showActivity && dm.otherUser?.activity ? (
          <div className="flex items-center gap-1">
            {dm.otherUser.activity.type !== 'bio' && (
              <span className="shrink-0 text-t-accent opacity-60">
                <ActivityIcon type={dm.otherUser.activity.type} size={9} />
              </span>
            )}
            <span className="text-[9px] font-medium truncate text-t-secondary opacity-80">
              {dm.otherUser.activity.type === 'spotify' && dm.otherUser.activity.details
                ? <>{dm.otherUser.activity.details} — {dm.otherUser.activity.name}</>
                : dm.otherUser.activity.name}
            </span>
          </div>
        ) : dm.lastMessage ? (
          <div className="text-[10px] text-t-secondary truncate">{dm.lastMessage.content.startsWith('{"v":') ? '' : dm.lastMessage.content}</div>
        ) : null}
      </div>
      {isMuted && <BellOff size={12} className="shrink-0 opacity-40" />}
      {dm.pinned && <Pin size={12} className="shrink-0 opacity-40" />}
      <TierUnreadBadge savedUnread={unread} savedCount={unreadCount} otrUnread={otrUnread} otrCount={otrUnreadCount} />
    </>
  );
});

/* ── Memoized Group DM channel item content (extracted for hooks) ── */

const GroupDmChannelItemContent = React.memo(function GroupDmChannelItemContent({
  dm,
  groupLabel,
  groupIcon,
  currentUser,
  isMuted,
  isUnread,
  unreadCount,
  mentionCount,
}: {
  dm: DMChannelItem;
  groupLabel: string;
  groupIcon: string | null;
  currentUser: { avatar?: string | null; username: string };
  isMuted: boolean;
  isUnread: boolean;
  unreadCount: number;
  mentionCount: number;
}) {
  const isAnyoneTyping = useTypingStore(
    useCallback(
      (s: { typingByChannel: Record<string, Record<string, { username: string; expires: number }>> }) => {
        const channelTyping = s.typingByChannel[dm.id];
        if (!channelTyping) return false;
        for (const _ in channelTyping) return true;
        return false;
      },
      [dm.id]
    )
  );

  const best = dm.otherUsers?.some(u => u.status === 'online') ? 'online'
    : dm.otherUsers?.some(u => u.status === 'idle') ? 'idle'
    : dm.otherUsers?.some(u => u.status === 'dnd') ? 'dnd'
    : 'offline';

  return (
    <>
      <div className="relative mr-3 shrink-0">
        <div className={`flex items-center justify-center w-[38px] h-[38px] overflow-hidden ring-0 shadow-none rounded-[var(--radius-lg)] ${groupIcon ? 'bg-black/80 border border-[var(--glass-border)]' : ''}`}>
          {groupIcon ? (
            <LazyGif src={sanitizeImgSrc(groupIcon)} frameSrc={getFrameUrl(groupIcon)} alt="" className="w-full h-full object-cover" />
          ) : (
            <GroupAvatarComposite
              members={[
                { avatar: currentUser.avatar, username: currentUser.username },
                ...(dm.otherUsers ?? EMPTY_OTHER_USERS).map(u => ({ avatar: u.avatar, username: u.username })),
              ].slice(0, 4)}
              size={38}
            />
          )}
        </div>
        <TypingStatusDot
          status={best}
          isTyping={isAnyoneTyping}
          size={12}
          className="absolute -bottom-0.5 -right-0.5 z-10"
        />
      </div>
      <div className="min-w-0 text-left flex-1">
        <div className="text-[13px] font-black tracking-tight truncate">
          {groupLabel}
        </div>
        {dm.lastMessage && (
          <div className="text-[10px] text-t-secondary truncate">{dm.lastMessage.content.startsWith('{"v":') ? '' : dm.lastMessage.content}</div>
        )}
      </div>
      {isMuted && <BellOff size={12} className="shrink-0 opacity-40" />}
      {dm.pinned && <Pin size={12} className="shrink-0 opacity-40" />}
      {(() => {
        if (!isUnread && mentionCount === 0) return null;
        if (isMuted) return unreadCount > 0 ? <span className="min-w-[18px] h-[18px] rounded-full bg-fill-hover text-t-secondary text-[9px] font-black px-1 flex items-center justify-center shrink-0">{unreadCount > 99 ? '99+' : unreadCount}</span> : null;
        if (mentionCount > 0) return <span className="min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[9px] font-black px-1 flex items-center justify-center shrink-0" style={{ boxShadow: '0 0 8px rgba(239,68,68,0.3)' }}>{mentionCount > 99 ? '99+' : mentionCount}</span>;
        if (unreadCount > 0) return <span className="min-w-[18px] h-[18px] rounded-full bg-fill-active text-t-primary text-[9px] font-black px-1 flex items-center justify-center shrink-0">{unreadCount > 99 ? '99+' : unreadCount}</span>;
        return null;
      })()}
    </>
  );
});

export const DMView: React.FC<DMViewProps> = React.memo(({
  dmUsers,
  onSelectDM,
  onSendDMMessage,
  rateLimitBanner = false,
  messageSendError = null,
  dmLoadError = null,
  onRetryLoadMessages,
  onCreateOrSelectDM,
  onCreateGroupDM,
  onUpdateGroupDM,
  onMarkDmRead,
  onLeaveGroupDM,
  onPinConversation,
  onUnpinConversation,
  onPinMessage,
  onUnpinMessage,
  getDMPins,
  getFriends,
  allUsers,
  onUserClick,
  onUserRightClick,
  onDirectMessageContextMenu,
  onDeleteDMMessage,
  onEditDMMessage,
  onReportDMMessage,
  onReactDMMessage,
  onStartVoiceCall,
  onStartVideoCall,
  onForwardImage,
  onForwardMessage,
  onMuteDM,
  activeDmCallChannelId,
  incomingDmCall,
  incomingCallNeedsUnlock,
  onAcceptIncomingCall,
  onDeclineIncomingCall,
  onTyping,
  onAddGroupDmMembers,
  onLoadMoreDmMessages,
  uiDensity = 'default',
  navTopInset = 0,
  onDmUnlocked,
  onJoinInvite,
  onViewInviteServer,
  uploadFile: uploadFileProp,
  onShowToast,
}) => {
  useRenderLoopDetector('DMView');

  const { t } = useTranslation();
  const navigate = useNavigate();
  // Cross-channel jump-to-message handler — symmetric with AppLayout's. ChatArea picks up
  // pendingScrollTarget on mount and scrolls (or fetches around the message via backend).
  const handleNavigateToMessage = useCallback((channelId: string, messageId: string) => {
    navigateToMessage(channelId, messageId, navigate);
  }, [navigate]);

  // Stable identity so MessageAttachment's effect deps don't churn on every DMView
  // re-render (typing indicator, store updates) and abort in-flight attachment fetches.
  const stableGetToken = useCallback(() => apiClient.getToken(), []);

  // Store selectors
  const currentUser = useAuthStore(s => s.currentUser);
  const activeDmChannelId = useNavigationStore(s => s.activeDmChannelId);
  const activeDmTier = useNavigationStore(s => s.activeDmTier);
  const setActiveDmTier = useNavigationStore(s => s.setActiveDmTier);
  const setActiveDmChannelId = useNavigationStore(s => s.setActiveDmChannelId);
  const dmChannels = useDmStore(s => s.dmChannels) as unknown as DMChannelItem[];
  const dmBlockStatus = useDmStore(s => s.dmBlockStatus);
  const pinnedMessageIds = useMessageStore(useCallback(
    (s: { dmPinnedMessageIds: Record<string, string[]> }) => activeDmChannelId ? (s.dmPinnedMessageIds[activeDmChannelId] ?? EMPTY_ARRAY) : EMPTY_ARRAY as string[],
    [activeDmChannelId]
  ));
  const _dmPinnedVersion = useMessageStore(s => s.dmPinnedVersion);
  const unreadDmChannelIds = useNotificationStore(s => s.unreadDmChannelIds);
  const dmUnreadCounts = useNotificationStore(s => s.dmUnreadCounts);
  const dmMentionCounts = useNotificationStore(s => s.dmMentionCounts);
  const otrUnreadDmChannelIds = useNotificationStore(s => s.otrUnreadDmChannelIds);
  const otrDmUnreadCounts = useNotificationStore(s => s.otrDmUnreadCounts);
  const statusBarDocked = useAppStore(s => s.floatingBarDocked);

  const [width, setWidth] = useState(256);
  const [startDmLoading, setStartDmLoading] = useState<string | null>(null);
  const [messageMode, setMessageMode] = useState<'direct' | 'group'>(() => {
    if (activeDmChannelId) {
      const ch = dmChannels.find((d) => d.id === activeDmChannelId);
      if (ch?.isGroup) return 'group';
    }
    return 'direct';
  });
  const [groupContextMenu, setGroupContextMenu] = useState<{ x: number; y: number; dm: DMChannelItem } | null>(null);
  const [groupModalOpen, setGroupModalOpen] = useState(false);
  const [groupEditModalOpen, setGroupEditModalOpen] = useState(false);
  const [directModalOpen, setDirectModalOpen] = useState(false);
  const [directModalFriends, setDirectModalFriends] = useState<User[]>([]);
  const [directModalLoading, setDirectModalLoading] = useState<string | null>(null);
  const [addFriendsToDmModalOpen, setAddFriendsToDmModalOpen] = useState(false);
  const friendListVersion = useSocialStore(s => s.friendListVersion);

  // Invalidate friends cache when friend list changes so modals get fresh data on next open
  useEffect(() => {
    apiClient.invalidateCache('friends');
  }, [friendListVersion]);

  // Inline unlock for E2EE
  const [callUnlockPw, setCallUnlockPw] = useState('');
  const [callUnlockLoading, setCallUnlockLoading] = useState(false);
  const [callUnlockError, setCallUnlockError] = useState<string | null>(null);
  const [callAcceptAttempted, setCallAcceptAttempted] = useState(false);
  const [callPendingVideo, setCallPendingVideo] = useState(false);
  const [e2eUnlockPw, setE2eUnlockPw] = useState('');
  const [e2eUnlockShow, setE2eUnlockShow] = useState(false);
  const [e2eUnlockRemember, setE2eUnlockRemember] = useState(true);
  const [e2eUnlockLoading, setE2eUnlockLoading] = useState(false);
  const [e2eUnlockError, setE2eUnlockError] = useState<string | null>(null);
  const e2eLocked = useUiStore(s => s.e2eLocked);
  // Re-render trigger for the MLS-locked composer banner. mlsCoordinator
  // readiness is read synchronously (below); subscribing to this tick makes the
  // banner appear when a sibling tab tears MLS down and clear when it recovers.
  const mlsReadyTick = useUiStore(s => s.mlsReadyTick);
  const dmCallPanelFullscreen = useUiStore(s => s.dmCallPanelFullscreen);

  const handleE2eUnlock = useCallback(async () => {
    if (!e2eUnlockPw || e2eUnlockLoading) return;
    setE2eUnlockLoading(true);
    setE2eUnlockError(null);
    try {
      await dmKeyManager.unlock(e2eUnlockPw);
      if (e2eUnlockRemember) {
        dmKeyManager.rememberOnDevice(e2eUnlockPw).catch(() => {});
      }
      // e2eLocked is now driven by the dmKeyManager event subscriber
      // wired in initializeEncryption (unlock() emits 'unlocked').
      setE2eUnlockPw('');
      onDmUnlocked?.();
    } catch {
      setE2eUnlockError(t('encryption.incorrectPassphrase', 'Incorrect passphrase'));
    } finally {
      setE2eUnlockLoading(false);
    }
  }, [e2eUnlockPw, e2eUnlockLoading, e2eUnlockRemember, onDmUnlocked, t]);
  const [activeCallParticipants, setActiveCallParticipants] = useState<Array<{ userId: string; username: string; avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null }>>([]);


  // Reset deferred-unlock call state when the incoming call changes
  useEffect(() => {
    setCallAcceptAttempted(false);
    setCallPendingVideo(false);
    setCallUnlockPw('');
    setCallUnlockError(null);
  }, [incomingDmCall?.dmChannelId]);

  // Active call status for the current DM (Discord-style "X is in a call" preview).
  // The listener is kept subscribed for the lifetime of the DM view (not torn
  // down on call-join / re-attached on call-leave). Earlier the effect bailed
  // out when activeDmCallChannelId === activeDmChannelId, which created a
  // race window: hanging up unsubscribed the listener and the resubscribe
  // straddled the server's broadcast for our own leave (and the friend's
  // leave that often follows), leaving the preview pinned on a stale
  // participant list. The render-side guard `!activeDmCallChannelId` at the
  // preview JSX already hides the preview during a call, so we don't need a
  // duplicate guard here — keeping the listener live means
  // `activeCallParticipants` always reflects the live room.
  useEffect(() => {
    if (!activeDmChannelId) {
      setActiveCallParticipants([]);
      return;
    }

    let cancelled = false;
    // Snapshot HTTP and socket deltas use different connections; when both
    // participants leave in rapid succession the deltas can arrive (and
    // clear state) before a snapshot captured mid-leave resolves. Drop any
    // snapshot that's been superseded, otherwise the stale list pins a
    // "X is in a call" banner that no one can dismiss.
    let deltaReceived = false;

    // Socket/HTTP payloads carry raw DB paths (e.g. `/api/uploads/...`). In
    // prod the frontend is on a different origin than the backend/CDN, so
    // those relative paths have to be rewritten to absolute URLs before they
    // can render — mirrors useCallSession.ts for the active-call surfaces.
    type Participant = { userId: string; username: string; avatar: string | null; banner?: string | null; bannerPositionY?: number; bannerZoom?: number; nameColor?: string | null; nameFont?: string | null; nameEffect?: string | null; avatarEffect?: string | null; effectivePlan?: string | null };
    const resolveParticipant = (p: Participant): Participant => ({
      ...p,
      avatar: apiClient.resolveAssetUrl(p.avatar) ?? p.avatar,
      banner: apiClient.resolveAssetUrl(p.banner) ?? p.banner,
    });

    // Subscribe BEFORE the snapshot so deltas during the round-trip aren't lost.
    const handleStatusChanged = (data: { dmChannelId: string; active: boolean; participants: Participant[] }) => {
      if (data.dmChannelId !== activeDmChannelId) return;
      deltaReceived = true;
      setActiveCallParticipants(data.active ? data.participants.map(resolveParticipant) : []);
    };
    const unsubStatusChanged = socketService.onDmCallStatusChanged(handleStatusChanged);

    // The disconnect path emits `dm-call-ended` before the trailing
    // status-changed, so listen to both.
    const handleCallEnded = (data: { dmChannelId: string }) => {
      if (data.dmChannelId !== activeDmChannelId) return;
      deltaReceived = true;
      setActiveCallParticipants([]);
    };
    const unsubCallEnded = socketService.onDmCallEnded(handleCallEnded);

    const refetchSnapshot = () => {
      apiClient.getDmCallStatus(activeDmChannelId).then(status => {
        // Why: a delta arriving during the HTTP round-trip is fresher than the snapshot
        if (cancelled || deltaReceived) return;
        setActiveCallParticipants(status.active ? status.participants.map(resolveParticipant) : []);
      }).catch(() => {
        if (cancelled || deltaReceived) return;
        setActiveCallParticipants([]);
      });
    };

    // Initial snapshot: only apply if no delta arrived during the round-trip,
    // otherwise the socket handler's fresh state would be clobbered by a
    // mid-flight stale HTTP response.
    apiClient.getDmCallStatus(activeDmChannelId).then(status => {
      if (cancelled || deltaReceived) return;
      setActiveCallParticipants(status.active ? status.participants.map(resolveParticipant) : []);
    }).catch(() => {
      if (cancelled || deltaReceived) return;
      setActiveCallParticipants([]);
    });

    // Resync on reconnect: if the socket dropped briefly while someone was
    // leaving the other end's call, the `dm-call-status-changed` /
    // `dm-call-ended` deltas are lost (Socket.IO does not replay them). Without
    // this, the "X is in a call" banner can pin to a roster that's already
    // empty server-side. The delta guard is reset so the refetch always wins
    // over stale in-memory state.
    const sock = socketService.getSocket();
    const handleReconnect = () => { deltaReceived = false; refetchSnapshot(); };
    sock?.on('connect', handleReconnect);

    return () => {
      cancelled = true;
      unsubStatusChanged();
      unsubCallEnded();
      sock?.off('connect', handleReconnect);
    };
  }, [activeDmChannelId]);

  const isResizing = useRef(false);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const dmContainerRef = useRef<HTMLDivElement>(null);
  const dmListScrollRef = useRef<HTMLDivElement>(null);

  // Group chat members column (like server members, no roles)
  const [groupMembersColumnOpen, setGroupMembersColumnOpen] = useState(() => {
    try {
      if (typeof window !== 'undefined' && window.innerWidth < 480) return false;
      return localStorage.getItem(GROUP_MEMBERS_OPEN_KEY) === 'true';
    } catch { return false; }
  });
  const [groupMembersColumnWidth, setGroupMembersColumnWidth] = useState(() => {
    try {
      const s = localStorage.getItem(GROUP_MEMBERS_WIDTH_KEY);
      if (s != null) { const n = Number(s); if (n >= GROUP_MEMBERS_COLUMN_MIN && n <= GROUP_MEMBERS_COLUMN_MAX) return n; }
    } catch (err) { console.error('Failed to read group members width', err); }
    return GROUP_MEMBERS_COLUMN_DEFAULT;
  });
  const [isDraggingGroupMembersColumn, setIsDraggingGroupMembersColumn] = useState(false);
  const groupMembersColumnPointerRef = useRef({ x: 0 });
  useEffect(() => {
    try { localStorage.setItem(GROUP_MEMBERS_OPEN_KEY, groupMembersColumnOpen ? 'true' : 'false'); } catch (err) { console.error('Failed to save group members open state', err); }
  }, [groupMembersColumnOpen]);
  useEffect(() => {
    try { localStorage.setItem(GROUP_MEMBERS_WIDTH_KEY, String(groupMembersColumnWidth)); } catch (err) { console.error('Failed to save group members width', err); }
  }, [groupMembersColumnWidth]);
  useEffect(() => {
    if (!isDraggingGroupMembersColumn) return;
    const onMove = (e: MouseEvent) => {
      const deltaX = e.clientX - groupMembersColumnPointerRef.current.x;
      groupMembersColumnPointerRef.current.x = e.clientX;
      setGroupMembersColumnWidth((w) => Math.max(GROUP_MEMBERS_COLUMN_MIN, Math.min(GROUP_MEMBERS_COLUMN_MAX, w - deltaX)));
    };
    const onUp = () => setIsDraggingGroupMembersColumn(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isDraggingGroupMembersColumn]);
  useEffect(() => {
    if (isDraggingGroupMembersColumn) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    return () => { document.body.style.cursor = ''; document.body.style.userSelect = ''; };
  }, [isDraggingGroupMembersColumn]);

  // 1-on-1 DM profile panel (mirrors the group members column; defaults open)
  const [profilePanelOpen, setProfilePanelOpen] = useState(() => getProfilePanelOpen());
  const [profilePanelWidth, setProfilePanelWidth] = useState(() => getProfilePanelWidth());
  const [isDraggingProfilePanel, setIsDraggingProfilePanel] = useState(false);
  const profilePanelPointerRef = useRef({ x: 0 });
  useEffect(() => { savePanelOpen(profilePanelOpen); }, [profilePanelOpen]);
  useEffect(() => { savePanelWidth(profilePanelWidth); }, [profilePanelWidth]);
  useEffect(() => {
    if (!isDraggingProfilePanel) return;
    const onMove = (e: MouseEvent) => {
      const deltaX = e.clientX - profilePanelPointerRef.current.x;
      profilePanelPointerRef.current.x = e.clientX;
      setProfilePanelWidth((w) => clampProfilePanelWidth(w - deltaX));
    };
    const onUp = () => setIsDraggingProfilePanel(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isDraggingProfilePanel]);
  useEffect(() => {
    if (isDraggingProfilePanel) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else if (!isDraggingGroupMembersColumn) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    return () => { if (!isDraggingGroupMembersColumn) { document.body.style.cursor = ''; document.body.style.userSelect = ''; } };
  }, [isDraggingProfilePanel, isDraggingGroupMembersColumn]);
  const handleProfilePanelToggle = useCallback(() => setProfilePanelOpen((o) => !o), []);
  const handleOpenFullProfileFromPanel = useCallback((u: import('./UserProfilePopup').UserWithRole) => {
    useUiStore.getState().setFullProfileTarget({ user: u });
  }, []);

  // Group-DM: clicking a member swaps the members column to that member's profile
  const [groupSelectedMemberId, setGroupSelectedMemberId] = useState<string | null>(null);
  useEffect(() => { setGroupSelectedMemberId(null); }, [activeDmChannelId]);

  const isMobile = useIsMobile();
  const { chatSettings } = useSettings();
  const showActivityInSidebar = chatSettings.dmSidebarShowActivity;
  const directChannels = useMemo(() => {
    const filtered = dmChannels.filter((d) => !d.isGroup);
    // Deduplicate: if multiple DMs exist with the same user (legacy encrypted
    // DM created a separate encrypted channel), keep only the most recent one.
    const byUser = new Map<string, typeof filtered[0]>();
    for (const dm of filtered) {
      const otherUserId = dm.otherUser?.id;
      if (!otherUserId) { byUser.set(dm.id, dm); continue; }
      const existing = byUser.get(otherUserId);
      if (!existing) { byUser.set(otherUserId, dm); continue; }
      const existingTime = existing.lastMessage?.createdAt ? new Date(existing.lastMessage.createdAt).getTime() : 0;
      const dmTime = dm.lastMessage?.createdAt ? new Date(dm.lastMessage.createdAt).getTime() : 0;
      if (dmTime > existingTime) byUser.set(otherUserId, dm);
    }
    const deduped = [...byUser.values()];
    const pinned = deduped.filter((d) => d.pinned).sort((a, b) => new Date(a.pinnedAt ?? 0).getTime() - new Date(b.pinnedAt ?? 0).getTime());
    const unpinned = [...deduped.filter((d) => !d.pinned)].sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bTime = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    return [...pinned, ...unpinned];
  }, [dmChannels]);
  const groupChannels = useMemo(() => {
    const filtered = dmChannels.filter((d) => d.isGroup);
    const pinned = filtered.filter((d) => d.pinned).sort((a, b) => new Date(a.pinnedAt ?? 0).getTime() - new Date(b.pinnedAt ?? 0).getTime());
    const unpinned = [...filtered.filter((d) => !d.pinned)].sort((a, b) => {
      const aTime = a.lastMessage?.createdAt ? new Date(a.lastMessage.createdAt).getTime() : 0;
      const bTime = b.lastMessage?.createdAt ? new Date(b.lastMessage.createdAt).getTime() : 0;
      return bTime - aTime;
    });
    return [...pinned, ...unpinned];
  }, [dmChannels]);
  const unreadSet = unreadDmChannelIds;
  const unreadDirectCount = useMemo(() => directChannels.filter((d) => unreadSet.has(d.id)).length, [directChannels, unreadSet]);
  const unreadGroupCount = useMemo(() => groupChannels.filter((d) => unreadSet.has(d.id)).length, [groupChannels, unreadSet]);


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

  const activeDm = activeDmChannelId ? dmChannels.find((d) => d.id === activeDmChannelId) : null;

  const blockForChannel = activeDmChannelId ? (dmBlockStatus[activeDmChannelId] ?? activeDm) : null;
  const blockedByMe = blockForChannel?.blockedByMe;
  const blockedByThem = blockForChannel?.blockedByThem;
  const blockedInGroup = blockForChannel?.blockedParticipantIds && blockForChannel.blockedParticipantIds.length > 0;
  // The active channel is an MLS channel, the vault is unlocked, but the MLS
  // coordinator is NOT active at all, i.e. a sibling tab's idle-lock (or a worker
  // crash) tore the shared worker down. Gating on isActive() (the whole MLS layer
  // is down) rather than per-channel isReadyForChannel() deliberately AVOIDS a
  // false positive during NORMAL first-open establishment, where the coordinator
  // is active but a specific channel is briefly not-ready. Without this the
  // composer looks usable but every send throws "Encryption unavailable" with no
  // recovery path. isActive() is read synchronously; the useUiStore(mlsReadyTick)
  // subscription above re-renders on each MLS lock transition so it stays fresh.
  // Touch mlsReadyTick so the dependency is explicit and never tree-shaken away.
  void mlsReadyTick;
  const mlsLockedForActive = !!(
    activeDmChannelId &&
    !e2eLocked &&
    isChannelMls(activeDmChannelId) &&
    !mlsCoordinator.isActive()
  );
  const resyncNeededForActive = useUiStore((s) => activeDmChannelId ? !!s.resyncNeededChannels[activeDmChannelId] : false);
  const establishFailureForActive = useUiStore((s) => activeDmChannelId ? s.establishFailureReasons[activeDmChannelId] : undefined);
  const peerUnprovisioned = establishFailureForActive?.reason === 'peer-unprovisioned';
  const unprovisionedName = peerUnprovisioned
    ? (activeDm?.isGroup
        ? (activeDm?.otherUsers?.find((u) => u.id === establishFailureForActive?.userId)?.username ?? 'a member')
        : (activeDm?.otherUser?.username ?? 'this user'))
    : null;
  const sendDisabled = !!(blockedByMe || blockedByThem || blockedInGroup || mlsLockedForActive || peerUnprovisioned);
  // The amber full-width banner is for DM blocks only. The MLS-locked case is
  // already surfaced by the cyan locked strip (with a Restore action) in topBanner,
  // so excluding it here avoids a redundant double-banner. The composer stays
  // disabled (sendDisabled includes mlsLockedForActive); its placeholder reason
  // is carried separately via composerPlaceholder below.
  const blockBanner =
    blockedByMe
      ? t('dm.blockedUser')
      : blockedByThem
        ? t('dm.userBlockedYou')
        : blockedInGroup
          ? t('dm.cantSendInGroup')
          : null;
  const composerPlaceholder =
    blockBanner ??
    (mlsLockedForActive
      ? t('encryption.mlsLockedComposer', 'Secure messaging is locked')
      : peerUnprovisioned
        ? t('encryption.peerUnprovisionedComposer', { name: unprovisionedName, defaultValue: 'Waiting for {{name}} to enable encryption' })
        : null);
  const otherUser = activeDm?.otherUser;
  const isActiveGroup = !!activeDm?.isGroup;
  // Per-(channel, tier) room key drives the message-store bucket: 'saved' keeps
  // the bare dmChannelId (zero migration), 'otr' is namespaced with '#otr'. The
  // raw activeDmChannelId still drives header/profile/pins/calls below.
  const roomId = activeDmChannelId ? roomKey(activeDmChannelId, activeDmTier) : null;
  // Own-mode UX gate for the OTR toggle: 1:1 only, vault unlocked, Self recovery
  // (not server-escrowed). The server is authoritative on the actual establish.
  const vaultOtrReady = dmKeyManager.isUnlocked() && !dmKeyManager.isPasswordDerived();
  const otrEligible = !!otherUser && !isActiveGroup && vaultOtrReady;
  // 1:1 DM recoverability chip state: server-derived serverReadable + the local
  // user's OWN custody (read here, never sent on the wire). Null for groups / when
  // serverReadable is unknown, which hides the chip.
  const recoverabilityState = (otherUser && !isActiveGroup)
    ? resolveRecoverabilityState(activeDm?.serverReadable, dmKeyManager.isPasswordDerived())
    : null;
  const showProfileColumn = !!otherUser && !isActiveGroup && !!activeDmChannelId && !isMobile;
  const otherUserForPanel = useMemo(() => (otherUser ? ({
    id: otherUser.id,
    username: otherUser.username,
    discriminator: otherUser.discriminator,
    avatar: otherUser.avatar ?? null,
    banner: otherUser.banner ?? undefined,
    status: (otherUser.status as User['status']) ?? 'offline',
    activity: otherUser.activity,
    nameColor: otherUser.nameColor,
    nameFont: otherUser.nameFont,
    nameEffect: otherUser.nameEffect,
    avatarEffect: otherUser.avatarEffect,
    effectivePlan: otherUser.effectivePlan,
    stripePlan: otherUser.stripePlan,
    badges: otherUser.badges,
  } as import('./UserProfilePopup').UserWithRole) : null), [otherUser]);
  const displayName = isActiveGroup
    ? getGroupDisplayName(activeDm!, currentUser ?? undefined)
    : otherUser
      ? otherUser.username
      : 'DM';
  const usersForChat: User[] = useMemo(() => {
    if (!currentUser) return allUsers;
    return isActiveGroup
      ? [
          currentUser,
          ...(activeDm!.otherUsers ?? EMPTY_OTHER_USERS).map((u) => ({
            ...u,
            avatar: u.avatar ?? null,
            status: (u.status as User['status']) ?? 'offline',
          } as User)),
        ]
      : otherUser
        ? [
            currentUser,
            {
              ...otherUser,
              avatar: otherUser.avatar ?? null,
              status: (otherUser.status as User['status']) ?? 'offline',
            } as User,
          ]
        : allUsers;
  }, [isActiveGroup, activeDm, currentUser, otherUser, allUsers]);

  const groupSelectedMember = useMemo(
    () => (groupSelectedMemberId ? usersForChat.find((u) => u.id === groupSelectedMemberId) ?? null : null),
    [groupSelectedMemberId, usersForChat],
  );
  useEffect(() => {
    if (groupSelectedMemberId && !usersForChat.some((u) => u.id === groupSelectedMemberId)) {
      setGroupSelectedMemberId(null);
    }
  }, [groupSelectedMemberId, usersForChat]);

  const openGroupModal = useCallback(() => {
    setGroupModalOpen(true);
  }, []);

  const openDirectModal = useCallback(() => {
    setDirectModalOpen(true);
    apiClient.getFriends().then(setDirectModalFriends).catch(() => setDirectModalFriends([]));
  }, []);

  const handleSendDMMessage = useCallback((content: string, replyToMessageId?: string, attachment?: { url: string; name: string; contentType?: string }) => {
    if (activeDmChannelId) onSendDMMessage(activeDmChannelId, content, replyToMessageId, attachment, activeDmTier);
  }, [activeDmChannelId, onSendDMMessage, activeDmTier]);

  const handleToggleOffTheRecord = useCallback(async () => {
    if (!activeDmChannelId || !otherUser) return;
    const next = activeDmTier === 'otr' ? 'saved' : 'otr';
    if (next === 'otr') {
      try {
        const otrId = activeDm?.otrMlsGroupId ?? null;
        const groupId = await mlsCoordinator.establishChannel(activeDmChannelId, otherUser.id, otrId, 'otr');
        // Persist the resolved OTR server groupId on the existing channel so the first
        // OTR send (sendEncryptedDmMessage reads dmChannel.otrMlsGroupId fresh from the
        // store) finds it. onNewDmChannel only seeds this for brand-new channels.
        if (groupId) {
          useDmStore.getState().updateDmChannel(activeDmChannelId, (ch) => ({ ...ch, otrMlsGroupId: groupId }));
        }
      } catch (err) {
        routeEstablishOutcome(activeDmChannelId, err);
        return; // stay on Saved if establish failed
      }
    }
    setActiveDmTier(next);
  }, [activeDmChannelId, otherUser, activeDmTier, activeDm, setActiveDmTier]);

  // Deep-link the recoverability popover's "Switch to Self recovery" action to the
  // account Encryption settings (same pattern as AppLayout's encryption deep-link).
  const handleOpenRecoverySettings = useCallback(() => {
    useNavigationStore.getState().setAccountDeepLink({ page: 'encryption' });
    navigate('/channels/account');
  }, [navigate]);

  const maybeShowOtrFirstSwipeToast = useCallback((peerName: string) => {
    if (!onShowToast || getOtrFirstSwipeSeen()) return;
    onShowToast(
      t('otr.firstSwipeToast', 'These chats live only on your devices and are never saved to our servers. Your first message starts the chat and invites {{name}}. A new device will not see the history, and it cannot stop the other person from keeping copies.', { name: peerName }),
      'info',
      0, // sticky: dismiss-for-now via the X (returns next entry) or "Don't show again"
      { actionLabel: t('otr.dontShowAgain', "Don't show again"), onAction: () => setOtrFirstSwipeSeen(true) },
    );
  }, [onShowToast, t]);

  const openRowOtr = useCallback(async (dmId: string) => {
    const dm = (dmChannels as DMChannelItem[]).find((c) => c.id === dmId);
    if (!dm || dm.isGroup || !dm.otherUser) return;
    // Re-check the vault gate at gesture time (eligibility can lapse mid-gesture).
    if (!dmKeyManager.isUnlocked() || dmKeyManager.isPasswordDerived()) return;
    try {
      const groupId = await mlsCoordinator.establishChannel(dmId, dm.otherUser.id, dm.otrMlsGroupId ?? null, 'otr');
      if (groupId) {
        useDmStore.getState().updateDmChannel(dmId, (ch) => ({ ...ch, otrMlsGroupId: groupId }));
      }
    } catch (err) {
      routeEstablishOutcome(dmId, err);
      return; // establish failed → stay on Saved
    }
    // setActiveDmChannelId resets the tier to 'saved'; set the tier AFTER selecting.
    setActiveDmChannelId(dmId);
    setActiveDmTier('otr');
    maybeShowOtrFirstSwipeToast(dm.otherUser.username);
  }, [dmChannels, setActiveDmChannelId, setActiveDmTier, maybeShowOtrFirstSwipeToast]);

  const returnRowSaved = useCallback((dmId: string) => {
    setActiveDmChannelId(dmId); // selecting a channel already lands on the Saved tier
  }, [setActiveDmChannelId]);

  const handlePinMessage = useCallback((messageId: string) => {
    if (onPinMessage && activeDmChannelId) onPinMessage(activeDmChannelId, messageId);
  }, [onPinMessage, activeDmChannelId]);

  const handleUnpinMessage = useCallback((messageId: string) => {
    if (onUnpinMessage && activeDmChannelId) onUnpinMessage(activeDmChannelId, messageId);
  }, [onUnpinMessage, activeDmChannelId]);

  const handleGetChannelPins = useCallback(() => {
    if (getDMPins && activeDmChannelId) return getDMPins(activeDmChannelId);
    return Promise.resolve([]);
  }, [getDMPins, activeDmChannelId]);

  const handleOpenAddFriends = useCallback(() => setAddFriendsToDmModalOpen(true), []);

  const handleVoiceCall = useCallback(() => {
    if (activeDmChannelId) onStartVoiceCall?.(activeDmChannelId);
  }, [activeDmChannelId, onStartVoiceCall]);

  const handleVideoCall = useCallback(() => {
    if (activeDmChannelId) onStartVideoCall?.(activeDmChannelId);
  }, [activeDmChannelId, onStartVideoCall]);

  const handleDeleteMessage = useCallback((messageId: string) => {
    if (onDeleteDMMessage && activeDmChannelId) onDeleteDMMessage(activeDmChannelId, messageId);
  }, [onDeleteDMMessage, activeDmChannelId]);

  const handleEditMessage = useCallback((messageId: string, newContent: string) => {
    if (onEditDMMessage && activeDmChannelId) onEditDMMessage(activeDmChannelId, messageId, newContent);
  }, [onEditDMMessage, activeDmChannelId]);

  const handleReportMessage = useCallback((messageId: string) => {
    if (onReportDMMessage && activeDmChannelId) onReportDMMessage(activeDmChannelId, messageId);
  }, [onReportDMMessage, activeDmChannelId]);

  const handleReactMessage = useCallback((messageId: string, emoji: string) => {
    if (onReactDMMessage && activeDmChannelId) onReactDMMessage(activeDmChannelId, messageId, emoji);
  }, [onReactDMMessage, activeDmChannelId]);

  const handleGroupHeaderClick = useCallback(() => setGroupEditModalOpen(true), []);
  const handleGroupMembersToggle = useCallback(() => setGroupMembersColumnOpen((o) => !o), []);

  // Deferred E2E unlock for incoming calls
  const callUnlockOnLogin = dmKeyManager.getUnlockOnLogin();
  const showCallUnlock = !!incomingCallNeedsUnlock && (callUnlockOnLogin || callAcceptAttempted);

  const handleCallAcceptClick = useCallback((joinWithVideo: boolean) => {
    if (incomingCallNeedsUnlock) {
      setCallPendingVideo(joinWithVideo);
      setCallAcceptAttempted(true);
    } else {
      onAcceptIncomingCall?.(joinWithVideo);
    }
  }, [incomingCallNeedsUnlock, onAcceptIncomingCall]);

  // Guard: store may not have a user during logout/init
  if (!currentUser) return null;

  return (
    <div ref={dmContainerRef} className="flex-1 flex overflow-hidden min-w-0 min-h-0" style={{ contain: 'layout style' }}>
      <div
        ref={sidebarRef}
        style={{ width: isMobile ? '100%' : `${width}px`, display: isMobile && activeDmChannelId ? 'none' : undefined, paddingTop: navTopInset + (uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 18 : 14), paddingBottom: isMobile ? 8 : statusBarDocked ? (uiDensity === 'compact' ? 78 : uiDensity === 'spacious' ? 92 : 85) : (uiDensity === 'compact' ? 72 : uiDensity === 'spacious' ? 84 : 78), paddingLeft: uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 16 : 12, paddingRight: 4 } as React.CSSProperties}
        className={`perf-glass-layer relative flex flex-col transition-[width] duration-75 ease-out ${isMobile ? 'w-full' : 'shrink-0'}`}
      >
        <div
          className="perf-glass-layer flex flex-col flex-1 min-h-0 overflow-hidden rounded-2xl"
          style={{
            backgroundColor: 'var(--bg-chat)',
            backdropFilter: 'blur(24px) saturate(1.1)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
            border: '1px solid var(--border-subtle)',
            boxShadow: '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)',
          } as React.CSSProperties}
        >
        <div className="flex items-center px-2.5 pt-2.5 pb-1.5 gap-2 shrink-0">
          <button
            type="button"
            onClick={() => setMessageMode('direct')}
            className={`relative flex-1 py-1.5 rounded-lg text-[11px] font-semibold capitalize transition-all border ${
              messageMode === 'direct'
                ? 'bg-fill-active text-t-primary border-[var(--border-strong)]'
                : 'bg-transparent text-t-secondary border-transparent hover:text-t-primary hover:bg-fill-hover'
            }`}
          >
            {t('dm.direct')}
            {unreadDirectCount > 0 && (
              <span className="badge-pop absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-red-500 text-white text-[8px] font-black px-0.5">
                {unreadDirectCount > 99 ? '99+' : unreadDirectCount}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setMessageMode('group')}
            className={`relative flex-1 py-1.5 rounded-lg text-[11px] font-semibold capitalize transition-all border ${
              messageMode === 'group'
                ? 'bg-fill-active text-t-primary border-[var(--border-strong)]'
                : 'bg-transparent text-t-secondary border-transparent hover:text-t-primary hover:bg-fill-hover'
            }`}
          >
            {t('dm.group')}
            {unreadGroupCount > 0 && (
              <span className="badge-pop absolute -top-0.5 -right-0.5 min-w-[16px] h-[16px] flex items-center justify-center rounded-full bg-red-500 text-white text-[8px] font-black px-0.5">
                {unreadGroupCount > 99 ? '99+' : unreadGroupCount}
              </span>
            )}
          </button>
        </div>

        <div ref={dmListScrollRef} className="flex-1 min-h-0 overflow-y-auto px-2 pb-2 space-y-1">
          {e2eLocked && (
            <div className="mb-2 p-3.5 rounded-xl bg-[var(--cyan-accent)]/8 border border-[var(--cyan-accent)]/20 space-y-2.5">
              <div className="flex items-center gap-2 text-[var(--cyan-accent)]">
                <Shield size={16} />
                <span className="text-sm font-semibold">{t('encryption.messagesLocked')}</span>
              </div>
              <p className="text-[11px] text-t-secondary leading-snug">
                {t('encryption.enterPassphraseDesc')}
              </p>
              <div className={`relative ${e2eUnlockError ? 'animate-[shake_0.35s_ease-in-out]' : ''}`}>
                <input
                  type={e2eUnlockShow ? 'text' : 'password'}
                  placeholder={t('encryption.passphrasePlaceholder')}
                  value={e2eUnlockPw}
                  onChange={(e) => { setE2eUnlockPw(e.target.value); if (e2eUnlockError) setE2eUnlockError(null); }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && e2eUnlockPw && !e2eUnlockLoading) handleE2eUnlock();
                  }}
                  className={`w-full px-3 py-2.5 pr-9 rounded-lg bg-black/30 border text-sm text-t-primary placeholder-t-secondary outline-none transition-colors ${e2eUnlockError ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
                  aria-invalid={!!e2eUnlockError}
                />
                <button
                  type="button"
                  onClick={() => setE2eUnlockShow(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-t-secondary hover:text-t-primary p-1"
                  tabIndex={-1}
                  aria-label={e2eUnlockShow ? 'Hide passphrase' : 'Show passphrase'}
                >
                  {e2eUnlockShow ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              {e2eUnlockError && (
                <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                  <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                  <p className="text-[12px] text-red-300 leading-snug">{e2eUnlockError}</p>
                </div>
              )}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={e2eUnlockRemember}
                  onChange={(e) => setE2eUnlockRemember(e.target.checked)}
                  className="w-3.5 h-3.5 rounded-lg border-[var(--border-strong)] bg-black/30 text-[var(--cyan-accent)] focus:ring-[var(--cyan-accent)]/30"
                />
                <span className="text-[11px] text-t-secondary">{t('encryption.rememberOnDevice')}</span>
              </label>
              <button
                type="button"
                onClick={handleE2eUnlock}
                disabled={e2eUnlockLoading || !e2eUnlockPw}
                className="btn-cta w-full py-2.5 rounded-xl disabled:opacity-50 text-sm transition-colors flex items-center justify-center gap-2"
              >
                {e2eUnlockLoading ? <Loader2 size={14} className="animate-spin" /> : <Shield size={14} />}
                {t('encryption.unlock')}
              </button>
            </div>
          )}
          {messageMode === 'direct' && (
            <>
              <button
                type="button"
                onClick={openDirectModal}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-dashed border-[var(--border-subtle)] hover:border-solid text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-all text-[11px] font-medium"
              >
                <MessageCircle size={14} /> {t('dm.startDirectMessage')}
              </button>
              {directChannels.length > 0 && (
            <div>
              <span className="text-[10px] font-medium text-t-secondary px-2 block mb-2">{t('dm.conversations')}</span>
              {directChannels.map((dm) => {
                const dmButton = (
                  <button
                    key={dm.id}
                    type="button"
                    onClick={() => onSelectDM(dm.id)}
                    {...longPressBindings((e) => {
                      e.preventDefault();
                      if (!dm.otherUser) return;
                      const userForMenu: import('./UserProfilePopup').UserWithRole = {
                        id: dm.otherUser.id,
                        username: dm.otherUser.username,
                        discriminator: dm.otherUser.discriminator,
                        avatar: dm.otherUser.avatar ?? null,
                        status: (dm.otherUser.status as import('../types').User['status']) ?? 'offline',
                      };
                      if (onDirectMessageContextMenu) {
                        onDirectMessageContextMenu(userForMenu, dm.id, e);
                      } else if (onUserRightClick) {
                        onUserRightClick(userForMenu, e);
                      }
                    })}
                    className={`w-full flex items-center p-3 rounded-xl transition-all ${
                      activeDmChannelId === dm.id
                        ? 'btn-cta-selected border border-transparent'
                        : 'text-t-secondary hover:bg-fill-hover hover:text-t-primary border border-transparent'
                    }`}
                  >
                    <DmChannelItemContent
                      dm={dm}
                      isActive={activeDmChannelId === dm.id}
                      showActivity={showActivityInSidebar}
                      unread={unreadSet.has(dm.id)}
                      unreadCount={dmUnreadCounts[dm.id] ?? 0}
                      otrUnread={otrUnreadDmChannelIds.has(dm.id)}
                      otrUnreadCount={otrDmUnreadCounts[dm.id] ?? 0}
                      isMuted={isDmChannelMuted(dm.id)}
                    />
                  </button>
                );

                const rowOtrEligible = vaultOtrReady && !dm.isGroup && !!dm.otherUser;
                if (!isMobile || !rowOtrEligible) return <React.Fragment key={dm.id}>{dmButton}</React.Fragment>;

                return (
                  <SwipeableDmItem
                    key={dm.id}
                    dmId={dm.id}
                    onOpenOtr={openRowOtr}
                    onReturnSaved={returnRowSaved}
                    scrollContainerRef={dmListScrollRef}
                  >
                    {dmButton}
                  </SwipeableDmItem>
                );
              })}
            </div>
              )}
          <div>
            {dmUsers.map((user) => (
              <button
                key={user.id}
                disabled={startDmLoading === user.id}
                onClick={async () => {
                  setStartDmLoading(user.id);
                  try {
                    await onCreateOrSelectDM(user.id);
                  } finally {
                    setStartDmLoading(null);
                  }
                }}
                className="w-full flex items-center p-2.5 rounded-lg transition-all text-t-secondary hover:bg-fill-hover hover:text-t-primary disabled:opacity-50"
              >
                <UserAvatar user={user} size={30} className="mr-2.5" />
                <span className="text-[13px] font-black tracking-tight truncate">{user.username}</span>
                {startDmLoading === user.id && <span className="ml-2 text-[10px] text-t-secondary">...</span>}
              </button>
            ))}
          </div>
            </>
          )}
          {messageMode === 'group' && (
            <div className="space-y-4">
              <button
                type="button"
                onClick={openGroupModal}
                className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl border border-transparent text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-all text-[11px] font-medium"
              >
                <Users size={14} /> {t('dm.startGroupChat')}
              </button>
              {groupChannels.length > 0 && (
                <div>
                  <span className="text-[10px] font-medium text-t-secondary px-2 block mb-2">{t('dm.groupChats')}</span>
                  {groupChannels.map((dm) => {
                    const groupLabel = getGroupDisplayName(dm, currentUser);
                    const groupIcon = dm.icon || null;
                    return (
                    <button
                      key={dm.id}
                      onClick={() => onSelectDM(dm.id)}
                      {...longPressBindings((e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        setGroupContextMenu({ x: e.clientX, y: e.clientY, dm });
                      })}
                      className={`w-full flex items-center p-3 rounded-xl transition-all ${
                        activeDmChannelId === dm.id
                          ? 'btn-cta-selected border border-transparent'
                          : 'text-t-secondary hover:bg-fill-hover hover:text-t-primary border border-transparent'
                      }`}
                    >
                      <GroupDmChannelItemContent
                        dm={dm}
                        groupLabel={groupLabel}
                        groupIcon={groupIcon}
                        currentUser={currentUser}
                        isMuted={isDmChannelMuted(dm.id)}
                        isUnread={unreadSet.has(dm.id)}
                        unreadCount={dmUnreadCounts[dm.id] ?? 0}
                        mentionCount={dmMentionCounts[dm.id] ?? 0}
                      />
                    </button>
                  );})}
                </div>
              )}
              {groupChannels.length === 0 && (
                <p className="text-[11px] text-t-secondary uppercase tracking-wider px-2">{t('dm.selectFriendsAbove')}</p>
              )}
            </div>
          )}


          <CreateGroupDmModal
            isOpen={groupModalOpen}
            onClose={() => setGroupModalOpen(false)}
            onCreateGroup={onCreateGroupDM}
            getFriends={() => apiClient.getFriends()}
            friendListVersion={friendListVersion}
          />

          {directModalOpen && createPortal(
            <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-[var(--overlay-backdrop)] backdrop-blur-sm" onClick={() => setDirectModalOpen(false)}>
              <div
                className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl spring-pop-in bg-panel"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4 shrink-0">
                  <span className="text-base font-semibold text-t-primary">{t('dm.startDirectMessageTitle')}</span>
                  <button onClick={() => setDirectModalOpen(false)} className="p-1.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary">
                    <X size={18} />
                  </button>
                </div>
                <p className="text-xs mb-4 shrink-0 text-t-secondary">{t('dm.chooseFriendToMessage')}</p>
                <div className="flex-1 overflow-y-auto min-h-0 space-y-1 mb-4">
                  {directModalFriends.length === 0 ? (
                    <p className="text-xs py-6 text-center text-t-secondary">{t('dm.noFriendsYet')}</p>
                  ) : (
                    directModalFriends.map((friend) => (
                      <button
                        key={friend.id}
                        type="button"
                        disabled={directModalLoading === friend.id}
                        onClick={async () => {
                          setDirectModalLoading(friend.id);
                          try {
                            await onCreateOrSelectDM(friend.id);
                            setDirectModalOpen(false);
                          } finally {
                            setDirectModalLoading(null);
                          }
                        }}
                        className="w-full flex items-center p-3 rounded-xl transition-all text-left hover:bg-fill-hover disabled:opacity-50 border border-transparent text-t-primary"
                      >
                        <UserAvatar user={friend as User} size={36} className="mr-3" />
                        <span className="text-sm font-black tracking-tight truncate flex-1">{(() => {
                          const plan = (friend as User).effectivePlan || (friend as User).stripePlan;
                          return plan === 'pro' && ((friend as User).nameColor || (friend as User).nameFont || (friend as User).nameEffect)
                            ? <RoleNameStyle name={friend.username} overrideColor={(friend as User).nameColor} overrideFont={(friend as User).nameFont} nameEffect={(friend as User).nameEffect} />
                            : friend.username;
                        })()}</span>
                        {directModalLoading === friend.id && <Loader2 size={14} className="animate-spin shrink-0" />}
                      </button>
                    ))
                  )}
                </div>
                <div className="flex justify-end shrink-0 pt-3 border-t border-default">
                  <button onClick={() => setDirectModalOpen(false)} className="px-4 py-2.5 rounded-xl text-xs font-bold uppercase hover:bg-fill-hover transition-colors text-t-secondary">{t('common.cancel')}</button>
                </div>
              </div>
            </div>,
            document.body
          )}
        </div>
        </div>

        <div
          onMouseDown={startResizing}
          className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-fill-hover active:bg-fill-active transition-colors z-50"
        />
      </div>

      <div
        className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden w-full"
        style={{
          display: isMobile && !activeDmChannelId ? 'none'
            : (isActiveGroup && activeDmChannelId && !isMobile) ? 'grid'
            : showProfileColumn ? 'grid'
            : undefined,
          gridTemplateColumns: (isActiveGroup && activeDmChannelId && !isMobile) ? `1fr ${groupMembersColumnOpen ? groupMembersColumnWidth : 0}px`
            : showProfileColumn ? `1fr ${profilePanelOpen ? profilePanelWidth : 0}px`
            : undefined,
          transition: (isActiveGroup || showProfileColumn) ? 'grid-template-columns 0.25s ease-out' : undefined,
        }}
      >
        <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
          {isMobile && activeDmChannelId && (
            <div className="flex items-center px-2 py-1 shrink-0">
              <button
                type="button"
                onClick={() => onSelectDM(null as unknown as string)}
                className="p-1.5 rounded-lg hover:bg-fill-hover transition-colors shrink-0 text-t-secondary"
                aria-label={t('common.back')}
              >
                <ArrowLeft size={20} />
              </button>
            </div>
          )}
          {dmLoadError && (
            <div className="flex items-center justify-between gap-3 px-3 py-2 bg-red-500/10 border-b border-red-500/30 text-red-300 text-sm shrink-0">
              <span className="truncate">{dmLoadError}</span>
              {onRetryLoadMessages && (
                <button
                  type="button"
                  onClick={onRetryLoadMessages}
                  className="shrink-0 px-2 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs font-medium uppercase"
                >
                  Retry
                </button>
              )}
            </div>
          )}
          {activeDmChannelId && (otherUser || isActiveGroup) ? (
            <ChatArea
              channel={{ id: roomId!, name: displayName, type: 'text', categoryId: null, position: 0 }}
              encrypted={activeDm?.encrypted === true}
              hideHeader={false}
              chatHidden={dmCallPanelFullscreen}
              topBanner={
                <>
                  {/* Case 0: MLS torn down for this channel by a sibling tab's
                      idle-lock (or a worker crash) while the vault stays unlocked.
                      The composer is already disabled (mlsLockedForActive); this
                      strip surfaces it with a Restore action (full reload re-runs
                      unlock → activate). Reuses the cyan locked-banner pattern. */}
                  {mlsLockedForActive && (
                    <div className="px-4 py-2.5 border-b shrink-0 flex items-center gap-3 border-[var(--cyan-accent)]/20 bg-[var(--cyan-accent)]/8">
                      <Shield size={15} className="shrink-0 text-[var(--cyan-accent)]" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-[var(--cyan-accent)] leading-tight">
                          {t('encryption.mlsLockedTitle', 'Secure messaging is locked')}
                        </p>
                        <p className="text-[11px] text-t-secondary leading-snug">
                          {t('encryption.mlsLockedDesc', 'Encryption was paused on another tab. Reload to restore secure messaging.')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="btn-cta shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]"
                      >
                        <RotateCw size={13} /> {t('encryption.mlsLockedRestore', 'Restore')}
                      </button>
                    </div>
                  )}
                  {/* Per-device identity: a secure-messaging commit could not be applied
                      on THIS device (e.g. an out-of-order handshake). Non-destructive:
                      messages stay intact; self-heals when the channel's epoch next
                      advances (App.tsx onEpochChange clears the flag). Suppressed while
                      the harder mlsLockedForActive strip is showing. */}
                  {resyncNeededForActive && !mlsLockedForActive && (
                    <div className="px-4 py-2.5 border-b shrink-0 flex items-center gap-3 border-[var(--cyan-accent)]/20 bg-[var(--cyan-accent)]/8">
                      <Shield size={15} className="shrink-0 text-[var(--cyan-accent)]" />
                      <div className="flex-1 min-w-0">
                        <p className="text-[13px] font-semibold text-[var(--cyan-accent)] leading-tight">
                          {t('encryption.mlsResyncTitle', 'This conversation needs to resync')}
                        </p>
                        <p className="text-[11px] text-t-secondary leading-snug">
                          {t('encryption.mlsResyncDesc', 'A secure-messaging update could not be applied on this device. Reload to resync; your messages are safe.')}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => window.location.reload()}
                        className="btn-cta shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 text-[12px]"
                      >
                        <RotateCw size={13} /> {t('encryption.mlsResyncReload', 'Resync')}
                      </button>
                    </div>
                  )}
                  {/* Case 1: Active call — portal target for DMCallView */}
                  {activeDmCallChannelId && activeDmCallChannelId === activeDmChannelId && (
                    <div
                      id="dm-call-inline-target"
                      className={dmCallPanelFullscreen ? 'flex-1 min-h-0 flex flex-col' : 'shrink-0'}
                    />
                  )}
                  {/* Case 2: Incoming call ring — card grid + Accept/Decline (mirrors active-call layout) */}
                  {!activeDmCallChannelId && incomingDmCall && incomingDmCall.dmChannelId === activeDmChannelId && (() => {
                    const otherGroupMembers = (activeDm?.isGroup && activeDm?.otherUsers)
                      ? activeDm.otherUsers.filter((u) => u.id !== incomingDmCall.fromUserId && u.id !== currentUser.id)
                      : [];

                    type IncomingCard = {
                      key: string;
                      username: string;
                      avatar: string | null;
                      banner?: string | null;
                      bannerPositionY?: number | null;
                      bannerZoom?: number | null;
                      nameColor?: string | null;
                      nameFont?: string | null;
                      nameEffect?: string | null;
                      avatarEffect?: string | null;
                      effectivePlan?: string | null;
                      role: 'caller' | 'group' | 'self';
                    };

                    const cards: IncomingCard[] = [
                      {
                        key: incomingDmCall.fromUserId,
                        username: incomingDmCall.username,
                        avatar: incomingDmCall.avatar ?? null,
                        banner: incomingDmCall.banner ?? null,
                        bannerPositionY: incomingDmCall.bannerPositionY,
                        bannerZoom: incomingDmCall.bannerZoom,
                        nameColor: incomingDmCall.nameColor,
                        nameFont: incomingDmCall.nameFont,
                        nameEffect: incomingDmCall.nameEffect,
                        avatarEffect: incomingDmCall.avatarEffect,
                        effectivePlan: incomingDmCall.effectivePlan,
                        role: 'caller',
                      },
                      ...otherGroupMembers.map<IncomingCard>((m) => ({
                        key: m.id,
                        username: m.username,
                        avatar: m.avatar ?? null,
                        nameColor: m.nameColor,
                        nameFont: m.nameFont,
                        nameEffect: m.nameEffect,
                        avatarEffect: m.avatarEffect,
                        effectivePlan: m.effectivePlan ?? m.stripePlan ?? null,
                        role: 'group',
                      })),
                      {
                        key: currentUser.id,
                        username: currentUser.username,
                        avatar: currentUser.avatar ?? null,
                        banner: currentUser.banner ?? null,
                        bannerPositionY: currentUser.bannerPositionY,
                        bannerZoom: currentUser.bannerZoom,
                        nameColor: currentUser.nameColor,
                        nameFont: currentUser.nameFont,
                        nameEffect: currentUser.nameEffect,
                        avatarEffect: currentUser.avatarEffect,
                        effectivePlan: currentUser.effectivePlan ?? currentUser.stripePlan,
                        role: 'self',
                      },
                    ];

                    const cardSize = cards.length <= 2 ? { w: 440, h: 300 } : cards.length <= 4 ? { w: 340, h: 240 } : cards.length <= 6 ? { w: 260, h: 190 } : { w: 220, h: 160 };

                    const controls = showCallUnlock ? (
                      <div className="space-y-2 w-full max-w-xs">
                        <div className="flex items-center justify-center gap-1.5 text-[var(--cyan-accent)]/80">
                          <Shield size={14} />
                          <span className="text-[11px] font-medium">{t('incomingCall.e2eeUnlockPrompt', 'Unlock encryption to answer this encrypted call')}</span>
                        </div>
                        <div className={callUnlockError ? 'animate-[shake_0.35s_ease-in-out]' : ''}>
                          <input
                            type="password"
                            placeholder={t('dm.securePasswordPlaceholder')}
                            value={callUnlockPw}
                            onChange={(e) => { setCallUnlockPw(e.target.value); if (callUnlockError) setCallUnlockError(null); }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' && callUnlockPw) {
                                setCallUnlockLoading(true);
                                setCallUnlockError(null);
                                dmKeyManager.unlock(callUnlockPw).then(() => {
                                  setCallUnlockPw('');
                                  onDmUnlocked?.();
                                  if (callAcceptAttempted) onAcceptIncomingCall?.(callPendingVideo);
                                }).catch(() => setCallUnlockError(t('dm.secureUnlockFailed'))).finally(() => setCallUnlockLoading(false));
                              }
                            }}
                            className={`w-full px-3 py-2 rounded-lg bg-black/30 border text-sm text-white placeholder-white/30 outline-none transition-colors ${callUnlockError ? 'border-red-500/70 focus:border-red-500' : 'border-white/10 focus:border-[var(--cyan-accent)]/50'}`}
                            autoFocus
                            aria-invalid={!!callUnlockError}
                          />
                        </div>
                        {callUnlockError && (
                          <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
                            <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
                            <p className="text-[12px] text-red-300 leading-snug">{callUnlockError}</p>
                          </div>
                        )}
                        <div className="flex gap-2">
                          <button type="button" onClick={onDeclineIncomingCall} className="flex-1 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 text-[11px] font-semibold border border-red-500/30 transition-colors flex items-center justify-center gap-1.5">
                            <PhoneOff size={12} /> {t('common.decline')}
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              if (!callUnlockPw) return;
                              setCallUnlockLoading(true);
                              setCallUnlockError(null);
                              dmKeyManager.unlock(callUnlockPw).then(() => {
                                setCallUnlockPw('');
                                onDmUnlocked?.();
                                if (callAcceptAttempted) onAcceptIncomingCall?.(callPendingVideo);
                              }).catch(() => setCallUnlockError(t('dm.secureUnlockFailed'))).finally(() => setCallUnlockLoading(false));
                            }}
                            disabled={callUnlockLoading || !callUnlockPw}
                            className="btn-cta flex-1 py-2 rounded-xl disabled:opacity-50 text-[11px] transition-colors flex items-center justify-center gap-1.5"
                          >
                            {callUnlockLoading ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
                            {t('dm.secureUnlockButton')}
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[var(--glass-bg)] backdrop-blur-xl border border-[var(--border-subtle)]">
                        <button type="button" onClick={onDeclineIncomingCall} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-red-500/15 text-red-400 border border-red-500/30 hover:bg-red-500 hover:text-white transition-all">
                          <PhoneOff size={18} /> {t('common.decline')}
                        </button>
                        <button type="button" onClick={() => handleCallAcceptClick(false)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500 hover:text-white transition-all">
                          <Phone size={18} /> {incomingDmCall.withVideo ? t('incomingCall.joinVoice') : t('common.accept')}
                        </button>
                        {incomingDmCall.withVideo && (
                          <button type="button" onClick={() => handleCallAcceptClick(true)} className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)] hover:text-white transition-all">
                            <Video size={18} /> {t('incomingCall.joinVideo')}
                          </button>
                        )}
                      </div>
                    );

                    return (
                      <InlineCallSurface mode="inline" isMobile={isMobile} controls={controls}>
                        <div className="flex flex-wrap justify-center gap-3 max-w-[1280px] mx-auto px-4 py-3">
                          {cards.map((c) => {
                            const styledName = (c.effectivePlan === 'pro' || c.effectivePlan === 'essential') && (c.nameColor || c.nameFont || c.nameEffect)
                              ? <RoleNameStyle name={c.username} overrideColor={c.nameColor ?? undefined} overrideFont={c.nameFont ?? undefined} nameEffect={c.nameEffect ?? undefined} />
                              : c.username;
                            const nameNode = c.role === 'self' ? <>{styledName} <span className="text-[var(--text-secondary)] font-normal">({t('dm.you')})</span></> : styledName;
                            return (
                              <div key={c.key} data-card-resize-wrapper className="relative flex-shrink-0" style={{ width: cardSize.w, height: cardSize.h }}>
                                <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden flex flex-col">
                                  <div className="absolute inset-0 rounded-2xl overflow-hidden">
                                    <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                                      {c.banner ? (
                                        <LazyGif src={sanitizeImgSrc(c.banner)} frameSrc={getFrameUrl(c.banner)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${c.bannerPositionY ?? 50}%`, ...(c.bannerZoom && c.bannerZoom > 100 ? { transform: `scale(${c.bannerZoom / 100})`, transformOrigin: `center ${c.bannerPositionY ?? 50}%` } : {}) }} />
                                      ) : c.avatar ? (
                                        <img src={sanitizeImgSrc(c.avatar)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-50" style={{ filter: 'blur(24px) saturate(1.3)', transform: 'scale(1.2)' }} />
                                      ) : null}
                                    </div>
                                    <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                                  </div>
                                  <div className="mt-auto relative z-10">
                                    <ParticipantCardFooter
                                      avatar={c.avatar}
                                      username={c.username}
                                      nameNode={nameNode}
                                      stream={null}
                                      connectionState={c.role === 'self' ? 'connected' : 'ringing'}
                                      effectivePlan={c.effectivePlan as import('../shared/planPerks').PlanTier | null | undefined}
                                      avatarEffect={c.avatarEffect}
                                    />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </InlineCallSurface>
                    );
                  })()}
                  {/* Case 3: Others in call — preview with InlineCallSurface */}
                  {!activeDmCallChannelId && !(incomingDmCall && incomingDmCall.dmChannelId === activeDmChannelId) && activeCallParticipants.length > 0 && activeDmChannelId && (() => {
                    const others = activeCallParticipants.filter(p => p.userId !== currentUser.id);
                    if (others.length === 0) return null;
                    const visible = others.slice(0, 6);
                    const overflow = others.length - 6;
                    const cardSize = others.length <= 2 ? { w: 440, h: 300 } : others.length <= 4 ? { w: 340, h: 240 } : others.length <= 6 ? { w: 260, h: 190 } : { w: 220, h: 160 };
                    return (
                      <InlineCallSurface
                        mode="inline"
                        isMobile={isMobile}
                        controls={
                          <div className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[var(--glass-bg)] backdrop-blur-xl border border-[var(--border-subtle)]">
                            <button
                              type="button"
                              onClick={() => onStartVoiceCall?.(activeDmChannelId)}
                              className="flex items-center gap-2 px-5 py-2.5 rounded-xl text-xs font-bold uppercase tracking-wide bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500 hover:text-white transition-all"
                            >
                              <Phone size={18} /> {t('dm.joinCall', 'Join Call')}
                            </button>
                            <button
                              type="button"
                              onClick={() => onStartVideoCall?.(activeDmChannelId)}
                              className="btn-secondary flex items-center gap-2 px-5 py-2.5 text-xs uppercase tracking-wide"
                            >
                              <Video size={18} /> {t('dm.joinWithVideo', 'Join with Video')}
                            </button>
                          </div>
                        }
                      >
                        <div className="flex flex-wrap justify-center gap-3 max-w-[1280px] mx-auto px-4 py-3">
                          {visible.map(p => (
                            <div key={p.userId} data-card-resize-wrapper className="relative flex-shrink-0" style={{ width: cardSize.w, height: cardSize.h }}>
                              <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden flex flex-col">
                                <div className="absolute inset-0 rounded-2xl overflow-hidden">
                                  <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                                    {p.banner ? (
                                      <LazyGif src={sanitizeImgSrc(p.banner)} frameSrc={getFrameUrl(p.banner)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${p.bannerPositionY ?? 50}%`, ...(p.bannerZoom && p.bannerZoom > 100 ? { transform: `scale(${p.bannerZoom / 100})`, transformOrigin: `center ${p.bannerPositionY ?? 50}%` } : {}) }} />
                                    ) : p.avatar ? (
                                      <img src={sanitizeImgSrc(p.avatar)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-50" style={{ filter: 'blur(24px) saturate(1.3)', transform: 'scale(1.2)' }} />
                                    ) : null}
                                  </div>
                                  <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                                </div>
                                <div className="mt-auto relative z-10">
                                  <ParticipantCardFooter
                                    avatar={p.avatar}
                                    username={p.username}
                                    nameNode={
                                      p.effectivePlan === 'pro' && (p.nameColor || p.nameFont || p.nameEffect)
                                        ? <RoleNameStyle name={p.username} overrideColor={p.nameColor ?? undefined} overrideFont={p.nameFont ?? undefined} nameEffect={p.nameEffect ?? undefined} />
                                        : p.username
                                    }
                                    stream={null}
                                    connectionState="connected"
                                    effectivePlan={p.effectivePlan as import('../shared/planPerks').PlanTier | null | undefined}
                                    avatarEffect={p.avatarEffect}
                                  />
                                </div>
                              </div>
                            </div>
                          ))}
                          {overflow > 0 && (
                            <div className="relative flex-shrink-0 flex items-center justify-center rounded-2xl border border-[var(--glass-border)]" style={{ width: cardSize.w, height: cardSize.h, backgroundColor: 'var(--bg-panel)' }}>
                              <span className="text-sm font-bold" style={{ color: 'var(--text-secondary)' }}>+{overflow} more</span>
                            </div>
                          )}
                        </div>
                      </InlineCallSurface>
                    );
                  })()}
                </>
              }
              onSendMessage={handleSendDMMessage}
              uploadFile={uploadFileProp}
              getToken={stableGetToken}
              onForwardImage={onForwardImage}
              onForwardMessage={onForwardMessage}
              headerUser={otherUser ? { id: otherUser.id, username: otherUser.username, discriminator: otherUser.discriminator, avatar: otherUser.avatar ?? null, banner: otherUser.banner ?? undefined, status: (otherUser.status as import('../types').User['status']) ?? 'offline', nameColor: otherUser.nameColor, nameFont: otherUser.nameFont, nameEffect: otherUser.nameEffect, effectivePlan: otherUser.effectivePlan, stripePlan: otherUser.stripePlan, badges: otherUser.badges } as import('./UserProfilePopup').UserWithRole : null}
              headerGroup={isActiveGroup && activeDmChannelId ? { id: activeDmChannelId, name: displayName, icon: activeDm?.icon } : null}
              onGroupHeaderClick={isActiveGroup ? handleGroupHeaderClick : undefined}
              sendDisabled={sendDisabled}
              blockBanner={blockBanner}
              composerPlaceholder={composerPlaceholder}
              callBlockedReason={peerUnprovisioned ? t('voiceCall.peerUnprovisioned', { name: unprovisionedName, defaultValue: 'Waiting for {{name}} to enable encryption' }) : null}
              rateLimitBanner={rateLimitBanner}
              messageSendError={messageSendError}
              pinnedMessageIds={pinnedMessageIds}
              onPinMessage={onPinMessage ? handlePinMessage : undefined}
              onUnpinMessage={onUnpinMessage ? handleUnpinMessage : undefined}
              getChannelPins={activeDmTier === 'otr' ? undefined : (getDMPins ? handleGetChannelPins : undefined)}
              onAddFriendsToDm={handleOpenAddFriends}
              onVoiceCall={activeDmChannelId ? handleVoiceCall : undefined}
              onVideoCall={activeDmChannelId ? handleVideoCall : undefined}
              onUserClick={onUserClick}
              onUserRightClick={onUserRightClick}
              canDeleteAnyMessage={false}
              onDeleteMessage={activeDmTier === 'otr' ? undefined : (onDeleteDMMessage ? handleDeleteMessage : undefined)}
              onEditMessage={activeDmTier === 'otr' ? undefined : (onEditDMMessage ? handleEditMessage : undefined)}
              onReportMessage={onReportDMMessage ? handleReportMessage : undefined}
              onReactMessage={onReactDMMessage ? handleReactMessage : undefined}
              dmContainerRef={dmContainerRef}
              groupMembersColumnOpen={groupMembersColumnOpen}
              onGroupMembersColumnToggle={handleGroupMembersToggle}
              groupMembersCount={isActiveGroup ? usersForChat.length : 0}
              profilePanelOpen={profilePanelOpen}
              onProfilePanelToggle={showProfileColumn ? handleProfilePanelToggle : undefined}
              onTyping={onTyping}
              onLoadMoreMessages={activeDmTier === 'otr' ? undefined : onLoadMoreDmMessages}
              onToggleOffTheRecord={handleToggleOffTheRecord}
              offTheRecordActive={activeDmTier === 'otr'}
              otrEligible={otrEligible}
              recoverabilityState={recoverabilityState}
              onOpenRecoverySettings={handleOpenRecoverySettings}
              onJoinInvite={onJoinInvite}
              onViewServer={onViewInviteServer}
              onMarkUnread={(timestamp, channelId) => { apiClient.markDmAsRead(channelId, timestamp).catch(() => {}); }}
              onNavigateToMessage={handleNavigateToMessage}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center min-h-0" style={{ backgroundColor: 'var(--bg-chat)' }}>
              <p className="text-t-secondary text-sm font-medium uppercase tracking-wider">{t('dm.selectConversation')}</p>
            </div>
          )}
        </div>
        {/* Desktop: inline resizable members column */}
        {isActiveGroup && activeDmChannelId && !isMobile && (
          <div className="overflow-hidden min-w-0 min-h-0 flex flex-col relative z-0">
            <div
              className="perf-glass-layer relative flex flex-col h-full flex-1 min-h-0"
              style={{
                width: groupMembersColumnWidth,
                minWidth: groupMembersColumnWidth,
                backgroundColor: 'var(--bg-chat)',
                backdropFilter: 'blur(24px) saturate(1.1)',
                WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
                paddingTop: uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 18 : 14,
                paddingBottom: uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 18 : 14,
                paddingRight: uiDensity === 'compact' ? 10 : uiDensity === 'spacious' ? 16 : 12,
                paddingLeft: 4,
              } as React.CSSProperties}
            >
              <div
                role="separator"
                aria-label={t('dm.resizeMembers')}
                className="absolute left-0 top-0 bottom-0 w-2 flex items-center justify-center cursor-col-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-10"
                style={{ pointerEvents: groupMembersColumnOpen ? 'auto' : 'none' }}
                onMouseDown={(e) => {
                  if (!groupMembersColumnOpen) return;
                  e.preventDefault();
                  groupMembersColumnPointerRef.current.x = e.clientX;
                  setIsDraggingGroupMembersColumn(true);
                }}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-[var(--cyan-accent)]/0 hover:bg-[var(--cyan-accent)]/40 transition-colors" />
              </div>
              {groupSelectedMember ? (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 size={18} className="animate-spin text-t-secondary" style={{ opacity: 0.3 }} /></div>}>
                  <DMProfilePanel
                    user={groupSelectedMember as import('./UserProfilePopup').UserWithRole}
                    onViewFullProfile={handleOpenFullProfileFromPanel}
                    onBack={() => setGroupSelectedMemberId(null)}
                  />
                </Suspense>
              ) : (
                <MemberList
                  members={usersForChat}
                  onMemberClick={(member) => setGroupSelectedMemberId(member.id)}
                  onMemberRightClick={onUserRightClick ? (member, e) => onUserRightClick(member as import('./UserProfilePopup').UserWithRole, e) : undefined}
                  embedded
                  uiDensity={uiDensity}
                  typingChannelId={activeDmChannelId ?? undefined}
                />
              )}
            </div>
          </div>
        )}
        {/* Mobile: slide-over members overlay */}
        {isMobile && isActiveGroup && activeDmChannelId && groupMembersColumnOpen && (
          <>
            <div className="fixed inset-0 z-40 bg-[var(--overlay-backdrop)]" onClick={() => setGroupMembersColumnOpen(false)} />
            <div
              className="fixed top-0 right-0 bottom-0 z-50 flex flex-col w-[min(280px,80vw)] bg-panel"
              style={{ animation: 'slide-in-right 0.2s ease-out' }}
            >
              <div className="flex items-center justify-between px-4 py-3 border-b border-default">
                <span className="text-sm font-semibold text-t-primary">{t('members.title', 'Members')}</span>
                <button
                  type="button"
                  onClick={() => setGroupMembersColumnOpen(false)}
                  className="p-1.5 rounded-lg hover:bg-fill-hover transition-colors text-t-secondary"
                >
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto p-2">
                {groupSelectedMember ? (
                  <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 size={18} className="animate-spin text-t-secondary" style={{ opacity: 0.3 }} /></div>}>
                    <DMProfilePanel
                      user={groupSelectedMember as import('./UserProfilePopup').UserWithRole}
                      onViewFullProfile={handleOpenFullProfileFromPanel}
                      onBack={() => setGroupSelectedMemberId(null)}
                    />
                  </Suspense>
                ) : (
                  <MemberList
                    members={usersForChat}
                    onMemberClick={(member) => setGroupSelectedMemberId(member.id)}
                    onMemberRightClick={onUserRightClick ? (member, e) => onUserRightClick(member as import('./UserProfilePopup').UserWithRole, e) : undefined}
                    embedded
                    uiDensity={uiDensity}
                    typingChannelId={activeDmChannelId ?? undefined}
                  />
                )}
              </div>
            </div>
          </>
        )}
        {/* 1-on-1 DM: inline resizable profile panel */}
        {showProfileColumn && (
          <div className="overflow-hidden min-w-0 min-h-0 flex flex-col relative z-0">
            <div
              className="perf-glass-layer relative flex flex-col h-full flex-1 min-h-0"
              style={{ width: profilePanelWidth, minWidth: profilePanelWidth, backgroundColor: 'var(--bg-chat)' } as React.CSSProperties}
            >
              <div
                role="separator"
                aria-label={t('dm.resizeProfile', 'Resize profile')}
                className="absolute left-0 top-0 bottom-0 w-2 flex items-center justify-center cursor-col-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-10"
                style={{ pointerEvents: profilePanelOpen ? 'auto' : 'none' }}
                onMouseDown={(e) => {
                  if (!profilePanelOpen) return;
                  e.preventDefault();
                  profilePanelPointerRef.current.x = e.clientX;
                  setIsDraggingProfilePanel(true);
                }}
              >
                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 rounded-full bg-[var(--cyan-accent)]/0 hover:bg-[var(--cyan-accent)]/40 transition-colors" />
              </div>
              {profilePanelOpen && otherUserForPanel && (
                <Suspense fallback={<div className="flex-1 flex items-center justify-center"><Loader2 size={18} className="animate-spin text-t-secondary" style={{ opacity: 0.3 }} /></div>}>
                  <DMProfilePanel user={otherUserForPanel} onViewFullProfile={handleOpenFullProfileFromPanel} />
                </Suspense>
              )}
            </div>
          </div>
        )}
      </div>

      {groupEditModalOpen && activeDmChannelId && activeDm?.isGroup && (
          <GroupEditModal
            isOpen={groupEditModalOpen}
            dmChannelId={activeDmChannelId}
            currentName={activeDm.name ?? ''}
            currentIcon={activeDm.icon}
            onClose={() => setGroupEditModalOpen(false)}
            onSave={(dmChannelId, data) => {
              onUpdateGroupDM?.(dmChannelId, data);
            }}
            ownerId={activeDm.ownerId}
            currentUserId={currentUser.id}
            members={[
              { id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar ?? null },
              ...(activeDm.otherUsers ?? EMPTY_OTHER_USERS).map((u) => ({ id: u.id, username: u.username, avatar: u.avatar ?? null })),
            ]}
            onKickMember={(uid) => kickFromGroupDM(activeDmChannelId, uid)}
          />
        )}

      {addFriendsToDmModalOpen && activeDmChannelId && activeDm && getFriends && (
          <AddFriendsToDmModal
            isOpen={addFriendsToDmModalOpen}
            dmChannelId={activeDmChannelId}
            existingMemberIds={otherUser ? [otherUser.id] : (activeDm?.otherUsers?.map((u) => u.id) ?? EMPTY_ARRAY as string[])}
            maxMembers={15}
            onClose={() => setAddFriendsToDmModalOpen(false)}
            isExistingGroup={!!activeDm?.isGroup}
            onAddMembers={async (dmId, allMemberIds) => {
              if (activeDm?.isGroup && onAddGroupDmMembers) {
                const existingIds = new Set(activeDm.otherUsers?.map(u => u.id) ?? EMPTY_ARRAY as string[]);
                existingIds.add(currentUser.id);
                const newMemberIds = allMemberIds.filter(id => !existingIds.has(id));
                if (newMemberIds.length > 0) {
                  await onAddGroupDmMembers(dmId, newMemberIds);
                }
              } else {
                await onCreateGroupDM(allMemberIds);
              }
            }}
            getFriends={getFriends}
            friendListVersion={friendListVersion}
          />
        )}

      {groupContextMenu && (
          <GroupChatContextMenu
            dm={groupContextMenu.dm}
            x={groupContextMenu.x}
            y={groupContextMenu.y}
            isUnread={unreadSet.has(groupContextMenu.dm.id)}
            isPinned={groupContextMenu.dm.pinned ?? false}
            onClose={() => setGroupContextMenu(null)}
            onMarkAsRead={(id) => onMarkDmRead?.(id)}
            onEditGroup={(id) => {
              onSelectDM(id);
              setGroupEditModalOpen(true);
            }}
            onPinConversation={onPinConversation}
            onUnpinConversation={onUnpinConversation}
            onMute={onMuteDM ? (id, duration) => onMuteDM(id, duration) : undefined}
            onLeaveGroup={(id) => {
              setGroupContextMenu(null);
              try { onLeaveGroupDM?.(id); } catch (err) { console.error('Failed to leave group DM', err); }
            }}
          />
        )}
    </div>
  );
});
