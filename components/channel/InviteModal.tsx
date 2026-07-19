// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Check, Copy, X, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { UserAvatar } from '../UserAvatar';
import { apiClient } from '../../services/api';
import { socketService } from '../../services/socket';
import { getOrCreateEncryptedDM, sendDmMessage } from '../../utils/dmActions';
import type { ServerInvite } from '../../types/server';

interface InviteFriend {
  id: string;
  username: string;
  discriminator?: string;
  avatar: string | null;
  status?: string;
}

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  serverId: string;
  serverName: string;
  channelName: string;
  friends: InviteFriend[];
  serverMemberIds: Set<string>;
  hasCreateInvitePermission: boolean;
  hasManageServerPermission: boolean;
  onOpenServerSettings: () => void;
}

function formatExpiry(expiresAt: string | undefined): string {
  if (!expiresAt) return 'Never';
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return 'Expired';
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 1) {
    const mins = Math.max(1, Math.floor(diff / 60_000));
    return `${mins}m`;
  }
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

function pickPreferredInvite(invites: ServerInvite[]): ServerInvite | null {
  if (invites.length === 0) return null;
  const sorted = [...invites].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return sorted.find((i) => i.shareable) ?? sorted[0] ?? null;
}

function invitesShallowEqual(a: ServerInvite, b: ServerInvite): boolean {
  return a.id === b.id
    && a.label === b.label
    && a.shareable === b.shareable
    && a.useCount === b.useCount
    && a.maxUses === b.maxUses
    && a.expiresAt === b.expiresAt;
}

export const InviteModal: React.FC<InviteModalProps> = ({
  isOpen,
  onClose,
  serverId,
  serverName,
  channelName,
  friends,
  serverMemberIds,
  hasCreateInvitePermission,
  hasManageServerPermission,
  onOpenServerSettings,
}) => {
  const { t } = useTranslation();

  // State
  const [invites, setInvites] = useState<ServerInvite[]>([]);
  const [invitesLoading, setInvitesLoading] = useState(false);
  const [selectedInviteId, setSelectedInviteId] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sentFriendIds, setSentFriendIds] = useState<Set<string>>(new Set());
  const [sendingFriendIds, setSendingFriendIds] = useState<Set<string>>(new Set());
  const [copyFeedbackId, setCopyFeedbackId] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Derived
  const eligibleFriends = useMemo(() => {
    return friends
      .filter(f => !serverMemberIds.has(f.id))
      .filter(f => !searchQuery || f.username.toLowerCase().includes(searchQuery.toLowerCase()));
  }, [friends, serverMemberIds, searchQuery]);

  // Reset on close
  useEffect(() => {
    if (!isOpen) {
      setInvites([]);
      setInvitesLoading(false);
      setSelectedInviteId(null);
      setInviteError(null);
      setSearchQuery('');
      setSentFriendIds(new Set());
      setSendingFriendIds(new Set());
      setCopyFeedbackId(null);
    }
  }, [isOpen]);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setInvitesLoading(true);
    apiClient.getServerInvites(serverId)
      .then(async (list) => {
        if (cancelled) return;
        // Empty server + admin with create permission: auto-create a default
        // 24h-unlimited invite so the friend "Invite" buttons aren't dead on
        // arrival. Without this, an owner opening the modal sees a misleading
        // "Ask an admin to set up an invite link" message and the per-friend
        // buttons silently do nothing because they're gated on selectedInvite.
        if (list.length === 0 && hasCreateInvitePermission) {
          try {
            const created = await apiClient.createServerInvite(serverId, {
              expireAfter: 86400,
              maxUses: null,
              shareable: false,
            });
            if (cancelled) return;
            const asInvite: ServerInvite = {
              id: created.id,
              code: created.code,
              link: created.link,
              useCount: 0,
              maxUses: created.maxUses,
              expiresAt: created.expiresAt,
              temporary: created.temporary,
              label: created.label,
              shareable: created.shareable,
              createdAt: new Date().toISOString(),
            };
            setInvites([asInvite]);
            setSelectedInviteId(asInvite.id);
            return;
          } catch (e) {
            // Fall through and render the empty state — surface why so an
            // admin who's hit a rate-limit or perms quirk knows to retry.
            setInviteError(e instanceof Error ? e.message : t('channels.failedToCreateInvite', { defaultValue: 'Failed to create invite' }));
            setTimeout(() => setInviteError(null), 5000);
          }
        }
        setInvites(list);
        const preferred = pickPreferredInvite(list);
        if (preferred) setSelectedInviteId(preferred.id);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setInvitesLoading(false); });
    return () => { cancelled = true; };
  }, [isOpen, serverId, hasCreateInvitePermission, t]);

  useEffect(() => {
    if (!isOpen) return;
    const sock = socketService.getSocket();
    if (!sock) return;
    const handleUpdated = (payload: { serverId: string; invite: ServerInvite }) => {
      if (payload.serverId !== serverId) return;
      setInvites((prev) => {
        const idx = prev.findIndex((i) => i.id === payload.invite.id);
        if (idx === -1) return [payload.invite, ...prev];
        if (invitesShallowEqual(prev[idx]!, payload.invite)) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], ...payload.invite };
        return next;
      });
    };
    const handleCreated = (payload: { serverId: string; invite: ServerInvite }) => {
      if (payload.serverId !== serverId) return;
      setInvites((prev) => prev.some((i) => i.id === payload.invite.id) ? prev : [payload.invite, ...prev]);
    };
    const handleDeleted = (payload: { serverId: string; inviteId: string }) => {
      if (payload.serverId !== serverId) return;
      setInvites((prev) => prev.filter((i) => i.id !== payload.inviteId));
      setSelectedInviteId((sel) => sel === payload.inviteId ? null : sel);
    };
    sock.on('server-invite-updated', handleUpdated);
    sock.on('server-invite-created', handleCreated);
    sock.on('server-invite-deleted', handleDeleted);
    return () => {
      sock.off('server-invite-updated', handleUpdated);
      sock.off('server-invite-created', handleCreated);
      sock.off('server-invite-deleted', handleDeleted);
    };
  }, [isOpen, serverId]);

  useEffect(() => {
    if (selectedInviteId && invites.some((i) => i.id === selectedInviteId)) return;
    setSelectedInviteId(pickPreferredInvite(invites)?.id ?? null);
  }, [invites, selectedInviteId]);

  // Selected invite resolver
  const selectedInvite = useMemo(
    () => invites.find((i) => i.id === selectedInviteId) ?? null,
    [invites, selectedInviteId],
  );

  // Copy handler
  const handleCopy = useCallback((link: string, id: string) => {
    navigator.clipboard?.writeText(link).catch(() => {});
    setCopyFeedbackId(id);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => setCopyFeedbackId(null), 2000);
  }, []);

  // Send invite to friend
  const handleInviteFriend = useCallback(async (friendId: string) => {
    if (sentFriendIds.has(friendId) || sendingFriendIds.has(friendId)) return;
    if (!selectedInvite) return;
    setSendingFriendIds(prev => new Set(prev).add(friendId));
    try {
      const dm = await getOrCreateEncryptedDM(friendId);
      await sendDmMessage(dm.id, selectedInvite.link);
      setSentFriendIds(prev => new Set(prev).add(friendId));
    } catch (e) {
      setInviteError(e instanceof Error ? e.message : t('channels.failedToSendInvite', { defaultValue: 'Failed to send invite' }));
      setTimeout(() => setInviteError(null), 5000);
    } finally {
      setSendingFriendIds(prev => {
        const next = new Set(prev);
        next.delete(friendId);
        return next;
      });
    }
  }, [sentFriendIds, sendingFriendIds, selectedInvite, t]);

  if (!isOpen) return null;

  const allFriendsInServer = friends.length > 0 && friends.every(f => serverMemberIds.has(f.id));
  const noFriends = friends.length === 0;

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />
      <div
        className="w-full max-w-3xl max-h-[85vh] rounded-2xl border shadow-2xl relative spring-pop-in flex flex-col"
        style={{ backgroundColor: 'var(--bg-floating)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ── */}
        <div className="px-6 pt-5 pb-3 flex items-start justify-between shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight" style={{ color: 'var(--text-primary)' }}>
              {t('channels.inviteTo', { name: serverName, defaultValue: `Invite to ${serverName}` })}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>
              {t('channels.inviteSubtitle', { channel: channelName, defaultValue: `Recipients will land in #${channelName}` })}
            </p>
          </div>
          <button onClick={onClose} className="p-2 hover:bg-fill-active transition-colors rounded-lg shrink-0" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>

        {/* ── Body: two columns ── */}
        <div className="flex flex-col sm:flex-row flex-1 min-h-0 overflow-hidden">
          {/* Left column — Invite Friends */}
          <div className="flex-1 flex flex-col min-h-0 px-5 pb-4 sm:pr-0">
            <p className="text-[11px] font-semibold uppercase tracking-wider mb-2 px-1" style={{ color: 'var(--text-secondary)' }}>
              {t('channels.inviteFriends', { defaultValue: 'Invite Friends' })}
            </p>

            {/* Search */}
            <div className="relative mb-2">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: 'var(--text-tertiary)' }} />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder={t('common.search', { defaultValue: 'Search' })}
                className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border-0 outline-none"
                style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
              />
            </div>

            {/* Friend list */}
            <div className="flex-1 overflow-y-auto min-h-0 space-y-0.5">
              {(noFriends || allFriendsInServer || (searchQuery && eligibleFriends.length === 0)) ? (
                <div className="flex items-center justify-center h-full">
                  <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                    {t('channels.noFriendsToInvite', { defaultValue: 'No friends to invite' })}
                  </p>
                </div>
              ) : (
                eligibleFriends.map(friend => {
                  const isSent = sentFriendIds.has(friend.id);
                  const isSending = sendingFriendIds.has(friend.id);
                  return (
                    <div
                      key={friend.id}
                      className="flex items-center gap-3 px-2 py-2 rounded-lg transition-colors"
                      style={{ backgroundColor: 'transparent' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--fill-hover)'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.backgroundColor = 'transparent'; }}
                    >
                      <UserAvatar user={friend} size={30} />
                      <div className="flex-1 min-w-0">
                        <span className="text-sm font-medium truncate block" style={{ color: 'var(--text-primary)' }}>
                          {friend.username}
                        </span>
                        {friend.discriminator && (
                          <span className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                            #{friend.discriminator}
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={isSent || isSending || !selectedInvite}
                        onClick={() => handleInviteFriend(friend.id)}
                        title={!selectedInvite ? t('channels.noInviteSelected', { defaultValue: 'No invite link available. Create one first' }) : undefined}
                        className="btn-cta px-3 py-1 text-xs rounded-md shrink-0"
                        style={isSent ? { backgroundColor: 'rgba(34,197,94,0.15)', color: '#22c55e' } : undefined}
                      >
                        {isSent
                          ? t('channels.inviteSent', { defaultValue: 'Sent' })
                          : isSending
                            ? t('channels.inviteSending', { defaultValue: 'Sending...' })
                            : t('channels.invite', { defaultValue: 'Invite' })
                        }
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Divider */}
          <div className="sm:w-px sm:my-2 h-px sm:h-auto mx-5 sm:mx-0 shrink-0" style={{ backgroundColor: 'var(--border-subtle)' }} />

          {/* Right column — Invite Links picker */}
          <div className="flex-1 flex flex-col min-h-0 px-5 pb-4 sm:pl-5">
            <div className="flex items-center justify-between mb-2 px-1">
              <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-secondary)' }}>
                {t('channels.inviteLinks', { defaultValue: 'Invite Links' })}
              </p>
              {(hasCreateInvitePermission || hasManageServerPermission) && (
                <button
                  type="button"
                  onClick={onOpenServerSettings}
                  className="text-[11px] font-medium underline-offset-2 hover:underline"
                  style={{ color: 'var(--cyan-accent)' }}
                >
                  {t('channels.configureInvites', { defaultValue: 'Configure invites' })}
                </button>
              )}
            </div>

            <div className="flex-1 overflow-y-auto min-h-0 space-y-2">
              {invitesLoading ? (
                <div className="flex items-center justify-center h-20">
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>{t('channels.generating', { defaultValue: 'Loading...' })}</p>
                </div>
              ) : invites.length === 0 ? (
                <div className="flex items-center justify-center h-32 px-2 text-center">
                  <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('channels.noInvitesAvailable', { defaultValue: 'Ask an admin to set up an invite link.' })}
                  </p>
                </div>
              ) : (
                invites.map((inv) => {
                  const isSelected = inv.id === selectedInviteId;
                  return (
                    <button
                      key={inv.id}
                      type="button"
                      onClick={() => setSelectedInviteId(inv.id)}
                      className="w-full text-left rounded-lg p-3 transition-colors"
                      style={{
                        backgroundColor: isSelected ? 'var(--accent-subtle)' : 'var(--fill-hover)',
                        border: `1px solid ${isSelected ? 'var(--accent-emphasis)' : 'var(--border-subtle)'}`,
                      }}
                    >
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <span className="text-xs font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                          {inv.label ?? inv.code}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleCopy(inv.link, inv.id); }}
                          className="btn-cta flex items-center gap-1 px-2 py-1 text-[11px] rounded-md shrink-0"
                        >
                          {copyFeedbackId === inv.id
                            ? <><Check size={11} /> {t('channels.copied', { defaultValue: 'Copied' })}</>
                            : <><Copy size={11} /> {t('common.copy', { defaultValue: 'Copy' })}</>
                          }
                        </button>
                      </div>
                      <p className="text-[10px] font-mono break-all" style={{ color: 'var(--text-secondary)' }}>{inv.link}</p>
                      <p className="text-[10px] mt-1" style={{ color: 'var(--text-tertiary)' }}>
                        {inv.useCount}{inv.maxUses ? `/${inv.maxUses}` : ''} {t('channels.inviteUses', { defaultValue: 'uses' })} · {formatExpiry(inv.expiresAt)}
                        {inv.shareable && <> · <span style={{ color: 'var(--cyan-accent)' }}>{t('channels.inviteShareableBadge', { defaultValue: 'Shareable' })}</span></>}
                      </p>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* ── Error banner ── */}
        {inviteError && (
          <div className="mx-6 mb-2 px-3 py-2 rounded-lg text-xs font-medium" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171' }}>
            {inviteError}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
