// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Virtuoso } from 'react-virtuoso';

import { User } from '../types';
import { useAuthStore, useServerStore } from '../stores';
import { useSocialStore } from '../stores/socialStore';
import { useVoiceStore } from '../stores/voiceStore';
import { MessageCircle, X, Loader2, UserMinus, Ban, Gamepad2, Music, Activity } from 'lucide-react';
import { ServerActivityPanel } from './ServerActivityPanel';
import { formatActivityElapsed } from '../utils/activityUtils';
import { apiClient } from '../services/api';
import { useIsMobile } from '../hooks/useIsMobile';
import { useTypingStore } from '../stores/typingStore';
import { TypingStatusDot } from './TypingStatusDot';

function ActivityIcon({ type, size }: { type: string; size: number }) {
  switch (type) {
    case 'spotify':
    case 'listening':
      return <Music size={size} />;
    case 'bio':
      return null;
    case 'twitch_live':
    case 'youtube_live':
      return <span className="inline-block rounded-full bg-red-500 animate-pulse" style={{ width: size, height: size }} />;
    case 'steam_game':
    case 'detected_game':
    case 'custom':
      return <Gamepad2 size={size} />;
    default:
      return <Activity size={size} />;
  }
}

import { UserAvatar } from './UserAvatar';
import { RoleNameStyle } from './RoleNameStyle';

type PendingItem = { id: string; createdAt: string; user: User };

export function FriendNameLabel({ user, className }: { user: User; className: string }) {
  const plan = user.effectivePlan || user.stripePlan;
  const hasCustomStyle = plan === 'pro' && (user.nameColor || user.nameFont || user.nameEffect);
  if (hasCustomStyle) {
    return (
      <div className={className}>
        <RoleNameStyle name={user.username} overrideColor={user.nameColor} overrideFont={user.nameFont} nameEffect={user.nameEffect} />
      </div>
    );
  }
  return <div className={`${className} text-t-primary`}>{user.username}</div>;
}

// Stable empty references to avoid new object/function creation on every render
const EMPTY_STAGE_SUMMARY: Record<string, Record<string, Array<{ userId: string; username: string; avatar?: string }>>> = {};
const NOOP_SERVER = (_serverId: string) => {};
const NOOP_USER_EVENT = (_user: User, _e: React.MouseEvent) => {};

/* ── Memoized list-item components ── */

const FriendListItem = React.memo(function FriendListItem({
  friend,
  actionLoading,
  onMessage,
  onRemoveConfirm,
  onRightClick,
}: {
  friend: User;
  actionLoading: string | null;
  onMessage: (user: User) => void;
  onRemoveConfirm: (info: { userId: string; username: string }) => void;
  onRightClick: (user: User, e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  const isFriendTyping = useTypingStore(
    useCallback(
      (s: { typingDmUsers: Record<string, number> }) => s.typingDmUsers[friend.id] !== undefined,
      [friend.id]
    )
  );

  return (
    <div className="group flex items-center justify-between p-4 bg-panel border border-default rounded-xl hover:bg-fill-hover transition-all duration-150 mb-4" onContextMenu={(e) => { e.preventDefault(); onRightClick(friend, e); }}>
      <div className="flex items-center">
        <UserAvatar user={friend} size={48} className="mr-5">
          <TypingStatusDot
            status={friend.status}
            isTyping={isFriendTyping}
            size={16}
            className="absolute -bottom-1 -right-1"
          />
        </UserAvatar>
        <div>
          <FriendNameLabel user={friend} className="font-black text-base tracking-tight" />
          {friend.activity && (
            <div className="flex items-center gap-1.5 mt-1">
              {friend.activity.type !== 'bio' && (
                <span className="shrink-0 text-t-accent opacity-70">
                  <ActivityIcon type={friend.activity.type} size={11} />
                </span>
              )}
              <span className="text-[11px] font-medium truncate text-t-secondary">
                {friend.activity.type === 'spotify' && friend.activity.details
                  ? <>{friend.activity.details} — {friend.activity.name}</>
                  : (friend.activity.type === 'twitch_live' || friend.activity.type === 'youtube_live') && friend.activity.state
                  ? <>{friend.activity.name} — {friend.activity.state}</>
                  : friend.activity.name}
              </span>
              <span className="text-[10px] shrink-0 text-t-secondary opacity-50">
                {formatActivityElapsed(friend.activity.startedAt)}
              </span>
            </div>
          )}
        </div>
      </div>
      <div className="flex items-center space-x-3 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          onClick={() => onMessage(friend)}
          className="p-2.5 rounded-full bg-fill-hover text-t-secondary hover:text-t-accent border border-default hover:border-[var(--accent-muted)] transition-all duration-150"
          title={t('friends.message')}
        >
          <MessageCircle size={18} />
        </button>
        <button
          onClick={() => onRemoveConfirm({ userId: friend.id, username: friend.username })}
          disabled={actionLoading === friend.id}
          className="p-2.5 rounded-full bg-fill-hover text-t-secondary hover:text-[var(--danger)] border border-default hover:border-[var(--danger-muted)] transition-all duration-150 disabled:opacity-50"
          title={t('friends.removeFriend')}
        >
          {actionLoading === friend.id ? <Loader2 size={18} className="animate-spin" /> : <UserMinus size={18} />}
        </button>
      </div>
    </div>
  );
});

const PendingIncomingItem = React.memo(function PendingIncomingItem({
  id,
  user,
  actionLoading,
  onAccept,
  onDecline,
  onRightClick,
}: {
  id: string;
  user: User;
  actionLoading: string | null;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onRightClick: (user: User, e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center justify-between p-4 bg-panel border border-default rounded-xl hover:bg-fill-hover transition-all duration-150 mb-4" onContextMenu={(e) => { e.preventDefault(); onRightClick(user, e); }}>
      <div className="flex items-center">
        <UserAvatar user={user} size={48} className="mr-5" />
        <div>
          <FriendNameLabel user={user} className="font-black text-base tracking-tight" />
          <div className="text-[10px] font-semibold uppercase tracking-widest mt-0.5 text-t-secondary">{t('friends.incomingRequest')}</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => onAccept(id)}
          disabled={actionLoading === id}
          className="btn-cta font-semibold rounded-xl px-3 py-1.5 text-xs disabled:opacity-50 flex items-center gap-1 transition-all duration-150"
        >
          {actionLoading === id ? <Loader2 size={12} className="animate-spin" /> : null}
          {t('common.accept')}
        </button>
        <button
          onClick={() => onDecline(id)}
          disabled={actionLoading === id}
          className="bg-transparent text-t-secondary hover:text-[var(--danger)] hover:bg-[var(--danger-subtle)] rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50 transition-colors duration-150"
        >
          {t('common.decline')}
        </button>
      </div>
    </div>
  );
});

const PendingOutgoingItem = React.memo(function PendingOutgoingItem({
  id,
  user,
  actionLoading,
  onCancel,
  onRightClick,
}: {
  id: string;
  user: User;
  actionLoading: string | null;
  onCancel: (id: string) => void;
  onRightClick: (user: User, e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center justify-between p-4 bg-panel border border-default rounded-xl hover:bg-fill-hover transition-all duration-150 mb-4" onContextMenu={(e) => { e.preventDefault(); onRightClick(user, e); }}>
      <div className="flex items-center">
        <UserAvatar user={user} size={48} className="mr-5" />
        <div>
          <FriendNameLabel user={user} className="font-black text-base tracking-tight" />
          <div className="text-[10px] font-semibold uppercase tracking-widest mt-0.5 text-t-secondary">{t('friends.pendingLabel')}</div>
        </div>
      </div>
      <button
        onClick={() => onCancel(id)}
        disabled={actionLoading === id}
        className="btn-secondary sm:opacity-0 sm:group-hover:opacity-100 px-3 py-2 text-[11px] uppercase"
      >
        {actionLoading === id ? <Loader2 size={12} className="animate-spin" /> : t('common.cancel')}
      </button>
    </div>
  );
});

const BlockedUserItem = React.memo(function BlockedUserItem({
  user,
  actionLoading,
  onUnblock,
  onRightClick,
}: {
  user: User;
  actionLoading: string | null;
  onUnblock: (userId: string) => void;
  onRightClick: (user: User, e: React.MouseEvent) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="group flex items-center justify-between p-4 bg-panel border border-default rounded-xl hover:bg-fill-hover transition-all duration-150 mb-4" onContextMenu={(e) => { e.preventDefault(); onRightClick(user, e); }}>
      <div className="flex items-center">
        <UserAvatar user={user} size={48} className="mr-5" innerClassName="opacity-70" />
        <div>
          <FriendNameLabel user={user} className="font-black text-base tracking-tight" />
          <div className="text-[10px] font-semibold uppercase tracking-widest mt-0.5 text-t-secondary">{t('friends.blockedLabel')}</div>
        </div>
      </div>
      <button
        onClick={() => onUnblock(user.id)}
        disabled={actionLoading === user.id}
        className="btn-secondary px-3 py-1.5 text-[10px] uppercase flex items-center gap-1"
      >
        {actionLoading === user.id ? <Loader2 size={12} className="animate-spin" /> : <Ban size={12} />}
        {t('common.unblock')}
      </button>
    </div>
  );
});

interface FriendsViewProps {
  onCreateOrSelectDM?: (otherUserId: string) => Promise<void>;
  onOpenDMView?: () => void;
  /** Called when pending incoming count is known (e.g. for sidebar badge) */
  onPendingCountChange?: (incomingCount: number) => void;
  /** When provided, called on Unblock so DM state updates immediately (no refresh). */
  onUnblock?: (userId: string) => void | Promise<void>;
  /** @deprecated Read from voiceStore directly inside the component */
  serverVoiceSummary?: Record<string, Record<string, Array<{ userId: string; username: string; avatar?: string }>>>;
  /** @deprecated Read from voiceStore directly inside the component */
  serverStageSummary?: Record<string, Record<string, Array<{ userId: string; username: string; avatar?: string }>>>;
  onServerClick?: (serverId: string) => void;
  onUserClick?: (user: User, e: React.MouseEvent) => void;
  onUserRightClick?: (user: User, e: React.MouseEvent) => void;
}

export const FriendsView: React.FC<FriendsViewProps> = React.memo(({ onCreateOrSelectDM, onOpenDMView: _onOpenDMView, onPendingCountChange, onUnblock, serverVoiceSummary: _svsProp, serverStageSummary: _sssProp, onServerClick, onUserClick, onUserRightClick }) => {
  const serverVoiceSummary = useVoiceStore(s => s.serverVoiceSummary);
  const serverStageSummary = useVoiceStore(s => s.serverStageSummary);
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const currentUser = useAuthStore(s => s.currentUser);
  const servers = useServerStore(s => s.servers);
  const friends = useSocialStore(s => s.homeFriends);
  const friendListVersion = useSocialStore(s => s.friendListVersion);
  const [filter, setFilter] = useState<'all' | 'online' | 'pending' | 'blocked'>('online');
  const [incoming, setIncoming] = useState<PendingItem[]>([]);
  const [outgoing, setOutgoing] = useState<PendingItem[]>([]);
  const [blockedUsers, setBlockedUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [addInput, setAddInput] = useState('');
  const [addSending, setAddSending] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [removeFriendConfirm, setRemoveFriendConfirm] = useState<{ userId: string; username: string } | null>(null);

  const tabLabels: Record<string, string> = {
    online: t('friends.onlineTab'),
    all: t('friends.allTab'),
    pending: t('friends.pendingTab'),
    blocked: t('friends.blockedTab'),
  };

  const fetchFriendsAndRequests = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      const [friendsList, requests] = await Promise.all([
        apiClient.getFriends(),
        apiClient.getFriendRequests(),
      ]);
      useSocialStore.getState().setHomeFriends(friendsList);
      setIncoming(requests.incoming);
      setOutgoing(requests.outgoing);
      onPendingCountChange?.(requests.incoming.length);
    } catch (e) {
      console.error('Failed to fetch friends:', e);
      setIncoming([]);
      setOutgoing([]);
    } finally {
      setLoading(false);
    }
  }, [currentUser, onPendingCountChange]);

  const fetchBlocked = useCallback(async () => {
    if (!currentUser) return;
    setLoading(true);
    try {
      const list = await apiClient.getBlocked();
      setBlockedUsers(list);
    } catch {
      setBlockedUsers([]);
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => {
    fetchFriendsAndRequests();
  }, [fetchFriendsAndRequests, friendListVersion]);

  useEffect(() => {
    if (filter === 'blocked') fetchBlocked();
  }, [filter, fetchBlocked]);

  const filteredFriends = useMemo(() => friends.filter((f) => {
    if (filter === 'online') return f.status !== 'offline' && f.status !== 'invisible';
    return true;
  }), [friends, filter]);

  const handleSendRequest = async () => {
    const value = addInput.trim();
    if (!value) {
      setAddError(t('friends.usernameError'));
      return;
    }
    setAddSending(true);
    setAddError(null);
    try {
      await apiClient.sendFriendRequest(value);
      setAddInput('');
      setAddModalOpen(false);
      await fetchFriendsAndRequests();
    } catch (e: unknown) {
      setAddError(e instanceof Error ? e.message : t('friends.failedToSendRequest'));
    } finally {
      setAddSending(false);
    }
  };

  const handleAccept = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await apiClient.acceptFriendRequest(requestId);
      await fetchFriendsAndRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handleDecline = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await apiClient.declineFriendRequest(requestId);
      await fetchFriendsAndRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handleCancelOutgoing = async (requestId: string) => {
    setActionLoading(requestId);
    try {
      await apiClient.cancelFriendRequest(requestId);
      await fetchFriendsAndRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveFriend = async (userId: string) => {
    setActionLoading(userId);
    try {
      await apiClient.removeFriend(userId);
      await fetchFriendsAndRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnblock = async (userId: string) => {
    setActionLoading(userId);
    try {
      await (onUnblock ?? apiClient.unblockUser)(userId);
      await fetchBlocked();
      await fetchFriendsAndRequests();
    } finally {
      setActionLoading(null);
    }
  };

  const handleMessage = async (user: User) => {
    if (!onCreateOrSelectDM) return;
    try {
      // createOrSelectDM already navigates to /channels/@me/<dmId>.
      // Calling onOpenDMView() afterwards re-navigated to the previous activeDmChannelId
      // (stale React state at this point), which is why clicking Message landed on
      // the prior DM. Trust the navigation that createOrSelectDM performed.
      await onCreateOrSelectDM(user.id);
    } catch (e) {
      console.error('Failed to open DM:', e);
    }
  };

  if (!currentUser) {
    return (
      <div className="flex-1 flex items-center justify-center bg-app text-t-secondary">
        {t('friends.signInToUse')}
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-app overflow-hidden">
      {/* Header */}
      <div className={`flex items-center border-b border-default bg-app ${isMobile ? 'h-12 px-3 gap-2' : 'h-16 px-8 justify-between'}`}>
        {isMobile ? (
          <>
            <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto no-scrollbar">
              {(['online', 'all', 'pending', 'blocked'] as const).map((f) => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`relative px-3 py-1.5 rounded-lg text-[12px] font-semibold capitalize transition-all duration-150 whitespace-nowrap shrink-0 ${
                    filter === f
                      ? 'bg-fill-hover text-t-primary'
                      : 'text-t-secondary hover:text-t-primary hover:bg-fill-hover'
                  }`}
                >
                  {tabLabels[f]}
                  {f === 'pending' && incoming.length > 0 && (
                    <div
                      className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[var(--danger)]"
                      style={{ boxShadow: '0 0 6px var(--danger-muted)' }}
                    />
                  )}
                </button>
              ))}
            </div>
            <button
              onClick={() => { setAddModalOpen(true); setAddError(null); setAddInput(''); }}
              className="shrink-0 px-3 py-1.5 rounded-lg text-[12px] font-bold transition-all duration-150 bg-[var(--accent-subtle)] text-t-accent border border-[var(--accent-muted)] hover:bg-[var(--accent-muted)]"
            >
              + {t('friends.add', 'Add')}
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center space-x-6">
              <div className="flex items-center text-t-secondary text-[11px] font-semibold uppercase tracking-wider">
                {t('friends.title', 'Friends')}
              </div>
              <div className="h-4 w-[1px] bg-fill-hover" />
              <nav className="flex space-x-2">
                {(['online', 'all', 'pending', 'blocked'] as const).map((f) => (
                  <button
                    key={f}
                    onClick={() => setFilter(f)}
                    className={`relative px-3 py-1.5 rounded-lg text-[11px] font-semibold capitalize transition-all duration-150 ${
                      filter === f
                        ? 'bg-fill-hover text-t-primary'
                        : 'text-t-secondary hover:text-t-primary hover:bg-fill-hover'
                    }`}
                  >
                    {tabLabels[f]}
                    {f === 'pending' && incoming.length > 0 && (
                      <span className="badge-pop absolute -top-0.5 -right-0.5 min-w-[16px] h-4 flex items-center justify-center rounded-full bg-[var(--danger)] text-white text-[9px] font-black px-1">
                        {incoming.length > 99 ? '99+' : incoming.length}
                      </span>
                    )}
                  </button>
                ))}
              </nav>
            </div>
            <button
              onClick={() => { setAddModalOpen(true); setAddError(null); setAddInput(''); }}
              className="bg-[var(--accent-subtle)] text-t-accent border border-[var(--accent-muted)] hover:bg-[var(--accent-muted)] px-4 py-1.5 rounded-lg text-xs font-semibold transition-all duration-150"
            >
              {t('friends.addFriend')}
            </button>
          </>
        )}
      </div>

      {/* Add Friend Modal */}
      {addModalOpen && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--overlay-backdrop)] backdrop-blur-sm" onClick={() => !addSending && setAddModalOpen(false)}>
          <div
            className="glass rounded-2xl border border-default p-6 w-full max-w-md max-h-[90vh] overflow-y-auto shadow-2xl mx-4 animate-[spring-pop-in_180ms_ease-out]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4">
              <span className="text-sm font-semibold text-t-primary">{t('friends.addFriend')}</span>
              <button onClick={() => !addSending && setAddModalOpen(false)} className="p-1.5 rounded-lg text-t-secondary hover:bg-fill-hover hover:text-t-primary transition-colors duration-150">
                <X size={18} />
              </button>
            </div>
            <p className="text-[11px] mb-3 text-t-secondary">{t('friends.addFriendDescription')}</p>
            <input
              type="text"
              value={addInput}
              onChange={(e) => setAddInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSendRequest()}
              placeholder={t('friends.usernamePlaceholder')}
              className="w-full px-4 py-3 rounded-xl border border-default bg-input-surface text-sm font-mono mb-3 text-t-primary outline-none focus:border-accent-muted focus:shadow-[0_0_0_3px_var(--accent-subtle)] transition-all duration-150"
              autoFocus
            />
            {addError && <p className="text-[var(--danger)] text-[11px] mb-3">{addError}</p>}
            <div className="flex justify-end gap-2">
              <button onClick={() => !addSending && setAddModalOpen(false)} className="px-4 py-2 rounded-lg text-[11px] font-bold uppercase text-t-secondary hover:text-t-primary hover:bg-fill-hover transition-colors duration-150">{t('common.cancel')}</button>
              <button onClick={handleSendRequest} disabled={addSending} className="btn-cta disabled:opacity-50 px-4 py-2 rounded-xl text-[11px] font-black uppercase flex items-center gap-2 transition-all duration-150">
                {addSending ? <Loader2 size={14} className="animate-spin" /> : null}
                {t('friends.sendRequest')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Main content row */}
      <div className="flex-1 flex overflow-hidden">
      {/* Main List */}
      <div className={`flex-1 flex flex-col overflow-hidden ${isMobile ? 'p-3' : 'p-10'}`}>
        <div className="max-w-5xl mx-auto w-full flex-1 flex flex-col min-h-0">
          {loading ? (
            <div className="flex items-center justify-center py-20 text-t-secondary">
              <Loader2 size={28} className="animate-spin" />
            </div>
          ) : filter === 'pending' ? (
            <>
              {incoming.length > 0 && (
                <div className="mb-4 flex-1 flex flex-col min-h-0">
                  <div className="mb-6 flex items-center text-t-secondary text-[11px] font-semibold uppercase tracking-wider">{t('friends.incoming')}</div>
                  <Virtuoso
                    data={incoming}
                    itemContent={(_index, item) => (
                      <PendingIncomingItem
                        key={item.id}
                        id={item.id}
                        user={item.user}
                        actionLoading={actionLoading}
                        onAccept={handleAccept}
                        onDecline={handleDecline}
                        onRightClick={onUserRightClick ?? NOOP_USER_EVENT}
                      />
                    )}
                    defaultItemHeight={80}
                    overscan={400}
                    style={{ flex: 1 }}
                  />
                </div>
              )}
              {outgoing.length > 0 && (
                <div className="flex-1 flex flex-col min-h-0">
                  <div className="mb-6 flex items-center text-t-secondary text-[11px] font-semibold uppercase tracking-wider">{t('friends.outgoing')}</div>
                  <Virtuoso
                    data={outgoing}
                    itemContent={(_index, item) => (
                      <PendingOutgoingItem
                        key={item.id}
                        id={item.id}
                        user={item.user}
                        actionLoading={actionLoading}
                        onCancel={handleCancelOutgoing}
                        onRightClick={onUserRightClick ?? NOOP_USER_EVENT}
                      />
                    )}
                    defaultItemHeight={80}
                    overscan={400}
                    style={{ flex: 1 }}
                  />
                </div>
              )}
              {incoming.length === 0 && outgoing.length === 0 && (
                <div className="py-20 text-center text-[11px] text-t-secondary">{t('friends.noPendingRequests')}</div>
              )}
            </>
          ) : filter === 'blocked' ? (
            <>
              <div className="mb-6 flex items-center text-t-secondary text-[11px] font-semibold uppercase tracking-wider">
                {t('friends.blockedCount', { count: blockedUsers.length })}
              </div>
              {blockedUsers.length === 0 ? (
                <div className="py-20 text-center text-[11px] text-t-secondary">{t('friends.noBlockedUsers')}</div>
              ) : (
                <Virtuoso
                  data={blockedUsers}
                  itemContent={(_index, user) => (
                    <BlockedUserItem
                      key={user.id}
                      user={user}
                      actionLoading={actionLoading}
                      onUnblock={handleUnblock}
                      onRightClick={onUserRightClick ?? NOOP_USER_EVENT}
                    />
                  )}
                  defaultItemHeight={80}
                  overscan={400}
                  style={{ flex: 1 }}
                />
              )}
            </>
          ) : (
            <>
              <div className="mb-6 flex items-center text-t-secondary text-[11px] font-semibold uppercase tracking-wider">
                {filter === 'online' ? t('friends.onlineCount', { count: filteredFriends.length }) : t('friends.friendsCount', { count: filteredFriends.length })}
              </div>
              {filteredFriends.length === 0 ? (
                <div className="py-20 text-center text-sm text-t-secondary">
                  {friends.length === 0 ? t('friends.noFriendsYet') : t('friends.noOneOnline')}
                </div>
              ) : (
                <Virtuoso
                  data={filteredFriends}
                  itemContent={(_index, friend) => (
                    <FriendListItem
                      key={friend.id}
                      friend={friend}
                      actionLoading={actionLoading}
                      onMessage={handleMessage}
                      onRemoveConfirm={setRemoveFriendConfirm}
                      onRightClick={onUserRightClick ?? NOOP_USER_EVENT}
                    />
                  )}
                  defaultItemHeight={80}
                  overscan={400}
                  style={{ flex: 1 }}
                />
              )}
            </>
          )}
        </div>
      </div>

      {/* Server Activity Panel */}
      {!isMobile && servers && serverVoiceSummary && (
        <ServerActivityPanel
          servers={servers}
          friends={friends}
          serverVoiceSummary={serverVoiceSummary}
          serverStageSummary={serverStageSummary ?? EMPTY_STAGE_SUMMARY}
          onServerClick={onServerClick ?? NOOP_SERVER}
          onUserClick={onUserClick ?? NOOP_USER_EVENT}
          onUserRightClick={onUserRightClick ?? NOOP_USER_EVENT}
        />
      )}
      </div>

      {/* Remove Friend Confirmation */}
      {removeFriendConfirm && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-[var(--overlay-backdrop)] backdrop-blur-sm">
          <div className="glass rounded-2xl border border-default p-6 max-w-sm w-full mx-4 animate-[spring-pop-in_180ms_ease-out]">
            <h3 className="text-lg font-semibold mb-2 text-t-primary">{t('friends.removeFriendTitle', 'Remove Friend')}</h3>
            <p className="text-sm mb-6 text-t-secondary">
              {t('friends.removeFriendConfirm', { username: removeFriendConfirm.username, defaultValue: `Are you sure you want to remove ${removeFriendConfirm.username} as a friend? You'll need to send a new request to add them back.` })}
            </p>
            <div className="flex gap-3 justify-end">
              <button type="button" onClick={() => setRemoveFriendConfirm(null)} className="px-4 py-2 text-sm rounded-lg bg-fill-hover hover:bg-fill-active text-t-secondary hover:text-t-primary transition-colors duration-150">{t('common.cancel')}</button>
              <button type="button" onClick={() => { handleRemoveFriend(removeFriendConfirm.userId); setRemoveFriendConfirm(null); }} className="btn-cta-danger px-4 py-2 text-sm rounded-xl transition-all duration-150">{t('friends.removeFriend')}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
});
