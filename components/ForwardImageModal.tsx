// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import { X, Users, Hash, ChevronDown, ChevronRight, Loader2, User, MessageCircle, Globe, ArrowLeft, Search, ShieldAlert } from 'lucide-react';
import type { Channel, Server } from '../types';
import type { User as UserType } from '../types';
import { formatUsername } from '../types';
import { ServerIcon } from './ServerIcon';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { useFocusTrap } from '../hooks/useFocusTrap';

export interface DMChannelItem {
  id: string;
  otherUser?: { id: string; username: string; discriminator?: string; avatar?: string; avatarEffect?: string | null; effectivePlan?: string | null; stripePlan?: string | null } | null;
  isGroup?: boolean;
  name?: string;
  icon?: string;
}

export interface ForwardPayload {
  attachment?: { url: string; name: string; contentType?: string };
  text?: string;
  /** True when the message originates from an E2E-encrypted DM conversation */
  sourceEncryptedDm?: boolean;
}

export interface ForwardImageModalProps {
  open: boolean;
  onClose: () => void;
  /** At least one of attachment or text when open. */
  attachment?: { url: string; name: string; contentType?: string } | null;
  text?: string;
  /** Optional: fetch friends to show a "Friends" section (forward to friend = get/create DM and send) */
  getFriends?: () => Promise<UserType[]>;
  dmChannels: DMChannelItem[];
  servers: Server[];
  onSendToFriend?: (friendUserId: string, payload: ForwardPayload) => void | Promise<void>;
  onSendToDM: (dmChannelId: string, payload: ForwardPayload) => void | Promise<void>;
  onSendToChannel: (channelId: string, payload: ForwardPayload) => void | Promise<void>;
  /** Whether the source message comes from an encrypted DM */
  sourceEncryptedDm?: boolean;
}

import { UserAvatar } from './UserAvatar';
const defaultGroupIcon = 'https://api.dicebear.com/9.x/identicon/svg?seed=group';

const FRIEND_PREFIX = 'friend:';

export const ForwardImageModal: React.FC<ForwardImageModalProps> = ({
  open,
  onClose,
  attachment,
  text,
  getFriends,
  dmChannels,
  servers,
  onSendToFriend,
  onSendToDM,
  onSendToChannel,
  sourceEncryptedDm,
}) => {
  const { t } = useTranslation();
  const [step, setStep] = useState<'choose' | 'friends' | 'dms' | 'servers'>('choose');
  const [searchQuery, setSearchQuery] = useState('');
  const [sendingTo, setSendingTo] = useState<string | null>(null);
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null);
  const [friends, setFriends] = useState<UserType[]>([]);
  const [friendsLoading, setFriendsLoading] = useState(false);
  const [encryptionWarningChannelId, setEncryptionWarningChannelId] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  const payload: ForwardPayload = { attachment: attachment ?? undefined, text, sourceEncryptedDm };

  const searchNorm = searchQuery.trim().toLowerCase();

  useEffect(() => {
    if (open) {
      setStep('choose');
      setSearchQuery('');
    }
  }, [open]);

  useEffect(() => {
    if (!open || !getFriends) return;
    setFriendsLoading(true);
    getFriends()
      .then(setFriends)
      .catch(() => setFriends([]))
      .finally(() => setFriendsLoading(false));
  }, [open, getFriends]);

  const handleSendToFriend = async (friendUserId: string) => {
    if (!onSendToFriend) return;
    setSendingTo(FRIEND_PREFIX + friendUserId);
    try {
      await onSendToFriend(friendUserId, payload);
      onClose();
    } catch {
      // keep modal open
    } finally {
      setSendingTo(null);
    }
  };

  const handleSendDM = async (dmChannelId: string) => {
    setSendingTo(dmChannelId);
    try {
      await onSendToDM(dmChannelId, payload);
      onClose();
    } catch {
      // keep modal open
    } finally {
      setSendingTo(null);
    }
  };

  const handleSendChannel = async (channelId: string) => {
    if (payload.sourceEncryptedDm && !encryptionWarningChannelId) {
      setEncryptionWarningChannelId(channelId);
      return;
    }
    setEncryptionWarningChannelId(null);
    setSendingTo(channelId);
    try {
      await onSendToChannel(channelId, payload);
      onClose();
    } catch {
      // keep modal open
    } finally {
      setSendingTo(null);
    }
  };

  if (!open) return null;

  const textChannels = (server: Server) => server.channels.filter((c) => c.type === 'text');

  const content = (
    <div
      className="fixed inset-0 flex items-center justify-center p-4"
      style={{ zIndex: 'var(--z-max)' as unknown as number, backgroundColor: 'var(--overlay-backdrop)' }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="forward-modal-title"
        className="w-full max-w-md max-h-[85vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden bg-panel border-default"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b shrink-0 border-default">
          {step !== 'choose' && (
            <button
              type="button"
              onClick={() => setStep('choose')}
              className="p-2 rounded-lg hover:bg-fill-hover flex items-center justify-center text-t-secondary"
              aria-label={t('common.back')}
            >
              <ArrowLeft size={20} />
            </button>
          )}
          <h2 id="forward-modal-title" className="text-base font-semibold flex-1 text-t-primary">
            {step === 'choose' ? t('forward.forwardTo') : step === 'friends' ? t('forward.friends') : step === 'dms' ? t('forward.directMessages') : t('forward.servers')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-2 rounded-lg hover:bg-fill-hover text-t-secondary"
              aria-label={t('common.close')}
          >
            <X size={20} />
          </button>
        </div>

        {(payload.text || payload.attachment) && (
          <div className="px-4 py-2 border-b shrink-0 max-h-20 overflow-y-auto border-default">
            {payload.text && <p className="text-sm truncate line-clamp-2 text-t-secondary">{payload.text}</p>}
            {payload.attachment && <p className="text-xs mt-1" style={{ color: 'var(--text-tertiary)' }}>📎 {payload.attachment.name}</p>}
          </div>
        )}

        <div className="px-4 py-2 border-b shrink-0 border-default">
          <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-input-surface">
            <Search size={18} className="shrink-0 opacity-60 text-t-secondary" />
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={step === 'choose' ? t('forward.searchAll') : step === 'friends' ? t('forward.searchFriends') : step === 'dms' ? t('forward.searchConversations') : t('forward.searchServers')}
              className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm placeholder:opacity-70 text-t-primary"
              aria-label={t('common.search')}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0 p-4">
          {step === 'choose' && (
            <div className="flex flex-col gap-3">
              {searchNorm ? (
                <>
                  {getFriends && onSendToFriend && (
                    <>
                      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider text-t-secondary">{t('forward.friends')}</div>
                      {friendsLoading ? (
                        <div className="flex items-center justify-center py-4 text-t-secondary">
                          <Loader2 size={22} className="animate-spin" />
                        </div>
                      ) : (() => {
                        const filtered = friends.filter((f) => formatUsername(f).toLowerCase().includes(searchNorm));
                        return filtered.length === 0 ? (
                          <p className="px-3 py-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('forward.noFriendsMatch')}</p>
                        ) : (
                          filtered.map((friend) => {
                            const isSending = sendingTo === FRIEND_PREFIX + friend.id;
                            return (
                              <button
                                key={friend.id}
                                type="button"
                                onClick={() => handleSendToFriend(friend.id)}
                                disabled={!!sendingTo}
                                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover disabled:opacity-50 text-left text-t-primary"
                              >
                                <UserAvatar user={{ ...friend, username: formatUsername(friend) }} size={40} />
                                <span className="flex-1 truncate font-medium">{formatUsername(friend)}</span>
                                {isSending && <Loader2 size={18} className="animate-spin shrink-0 text-t-accent" />}
                              </button>
                            );
                          })
                        );
                      })()}
                    </>
                  )}
                  <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider mt-1 text-t-secondary">{t('forward.directMessages')}</div>
                  {(() => {
                    const filtered = dmChannels.filter((dm) => {
                      const label = dm.isGroup ? (dm.name ?? t('forward.groupChat')) : (dm.otherUser ? formatUsername(dm.otherUser) : dm.name ?? dm.id);
                      return label.toLowerCase().includes(searchNorm);
                    });
                    return filtered.length === 0 ? (
                      <p className="px-3 py-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('forward.noConversationsMatch')}</p>
                    ) : (
                      filtered.map((dm) => {
                        const label = dm.isGroup ? (dm.name ?? t('forward.groupChat')) : (dm.otherUser ? formatUsername(dm.otherUser) : dm.name ?? dm.id);
                        const dmUsername = dm.otherUser?.username ?? dm.name ?? 'User';
                        const isSending = sendingTo === dm.id;
                        return (
                          <button
                            key={dm.id}
                            type="button"
                            onClick={() => handleSendDM(dm.id)}
                            disabled={!!sendingTo}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover disabled:opacity-50 text-left text-t-primary"
                          >
                            {dm.isGroup ? (
                              <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
                                <LazyGif src={dm.icon ?? defaultGroupIcon} frameSrc={getFrameUrl(dm.icon)} alt="" className="w-full h-full object-cover" />
                              </div>
                            ) : (
                              <UserAvatar user={{ ...(dm.otherUser ?? { avatar: null }), username: dmUsername }} size={40} />
                            )}
                            <span className="flex-1 truncate font-medium">{label}</span>
                            {dm.isGroup && <Users size={14} className="text-t-secondary" />}
                            {isSending && <Loader2 size={18} className="animate-spin shrink-0 text-t-accent" />}
                          </button>
                        );
                      })
                    );
                  })()}
                  <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wider mt-1 text-t-secondary">{t('forward.servers')}</div>
                  {(() => {
                    const serversWithChannels = servers.filter((s) => textChannels(s).length > 0);
                    const filteredServers = serversWithChannels.filter((server) => {
                      const nameMatch = (server.name || '').toLowerCase().includes(searchNorm);
                      const channelMatch = textChannels(server).some((ch) => ch.name.toLowerCase().includes(searchNorm));
                      return nameMatch || channelMatch;
                    });
                    if (filteredServers.length === 0) {
                      return <p className="px-3 py-2 text-sm" style={{ color: 'var(--text-tertiary)' }}>{t('forward.noServersMatch')}</p>;
                    }
                    return filteredServers.map((server) => {
                      const channels = textChannels(server);
                      const filteredChannels = channels.filter((ch) => ch.name.toLowerCase().includes(searchNorm));
                      const serverMatches = (server.name || '').toLowerCase().includes(searchNorm);
                      const channelsToShow = filteredChannels.length > 0 ? filteredChannels : serverMatches ? channels : [];
                      return (
                        <div key={server.id} className="rounded-xl overflow-hidden bg-fill-hover">
                          <div className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-t-primary">
                            <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
                              <ServerIcon icon={server.icon} name={server.name} size={40} className="w-full h-full rounded-full" />
                            </div>
                            <span className="flex-1 truncate font-medium">{server.name}</span>
                          </div>
                          {channelsToShow.map((ch: Channel) => {
                            const isSending = sendingTo === ch.id;
                            return (
                              <button
                                key={ch.id}
                                type="button"
                                onClick={() => handleSendChannel(ch.id)}
                                disabled={!!sendingTo}
                                className="w-full flex items-center gap-3 pl-4 pr-3 py-2 rounded-lg hover:bg-fill-hover disabled:opacity-50 text-left text-t-primary"
                              >
                                <Hash size={18} className="shrink-0 opacity-60 text-t-secondary" />
                                <span className="flex-1 truncate">{ch.name}</span>
                                {isSending && <Loader2 size={16} className="animate-spin shrink-0 text-t-accent" />}
                              </button>
                            );
                          })}
                        </div>
                      );
                    });
                  })()}
                </>
              ) : (
                <>
                  {getFriends && onSendToFriend && (
                    <button
                      type="button"
                      onClick={() => setStep('friends')}
                      className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-fill-hover text-left border transition-colors text-t-primary border-default"
                    >
                      <div className="w-12 h-12 rounded-full shrink-0 flex items-center justify-center bg-input-surface">
                        <User size={24} className="text-t-secondary" />
                      </div>
                      <span className="font-medium">{t('forward.friends')}</span>
                      <ChevronRight size={20} className="ml-auto shrink-0 opacity-60 text-t-secondary" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setStep('dms')}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-fill-hover text-left border transition-colors text-t-primary border-default"
                  >
                    <div className="w-12 h-12 rounded-full shrink-0 flex items-center justify-center bg-input-surface">
                      <MessageCircle size={24} className="text-t-secondary" />
                    </div>
                    <span className="font-medium">{t('forward.directMessages')}</span>
                    <ChevronRight size={20} className="ml-auto shrink-0 opacity-60 text-t-secondary" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setStep('servers')}
                    className="w-full flex items-center gap-3 px-4 py-3 rounded-xl hover:bg-fill-hover text-left border transition-colors text-t-primary border-default"
                  >
                    <div className="w-12 h-12 rounded-full shrink-0 flex items-center justify-center bg-input-surface">
                      <Globe size={24} className="text-t-secondary" />
                    </div>
                    <span className="font-medium">{t('forward.servers')}</span>
                    <ChevronRight size={20} className="ml-auto shrink-0 opacity-60 text-t-secondary" />
                  </button>
                  {(!getFriends || !onSendToFriend) && dmChannels.length === 0 && servers.filter((s) => textChannels(s).length > 0).length === 0 && (
                    <p className="px-2 py-4 text-sm text-t-secondary">{t('forward.noDestinations')}</p>
                  )}
                </>
              )}
            </div>
          )}

          {step === 'friends' && getFriends && onSendToFriend && (
            <div className="space-y-1">
              {friendsLoading ? (
                <div className="flex items-center justify-center py-8 text-t-secondary">
                  <Loader2 size={28} className="animate-spin" />
                </div>
              ) : (() => {
                const filtered = searchNorm
                  ? friends.filter((f) => formatUsername(f).toLowerCase().includes(searchNorm))
                  : friends;
                return (
                  <>
                    {filtered.map((friend) => {
                      const isSending = sendingTo === FRIEND_PREFIX + friend.id;
                      return (
                        <button
                          key={friend.id}
                          type="button"
                          onClick={() => handleSendToFriend(friend.id)}
                          disabled={!!sendingTo}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover disabled:opacity-50 text-left text-t-primary"
                        >
                          <UserAvatar user={{ ...friend, username: formatUsername(friend) }} size={40} />
                          <span className="flex-1 truncate font-medium">{formatUsername(friend)}</span>
                          <User size={14} className="text-t-secondary" />
                          {isSending && <Loader2 size={18} className="animate-spin shrink-0 text-t-accent" />}
                        </button>
                      );
                    })}
                    {!friendsLoading && friends.length === 0 && (
                      <p className="px-3 py-4 text-sm text-t-secondary">{t('forward.noFriendsYet')}</p>
                    )}
                    {!friendsLoading && friends.length > 0 && filtered.length === 0 && (
                      <p className="px-3 py-4 text-sm text-t-secondary">{t('forward.noFriendsMatchSearch')}</p>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {step === 'dms' && (
            <div className="space-y-1">
              {dmChannels.length === 0 ? (
                <p className="px-3 py-4 text-sm text-t-secondary">{t('forward.noDirectMessagesYet')}</p>
              ) : (() => {
                const filtered = searchNorm
                  ? dmChannels.filter((dm) => {
                      const label = dm.isGroup ? (dm.name ?? t('forward.groupChat')) : (dm.otherUser ? formatUsername(dm.otherUser) : dm.name ?? dm.id);
                      return label.toLowerCase().includes(searchNorm);
                    })
                  : dmChannels;
                return (
                  <>
                    {filtered.map((dm) => {
                      const label = dm.isGroup ? (dm.name ?? t('forward.groupChat')) : (dm.otherUser ? formatUsername(dm.otherUser) : dm.name ?? dm.id);
                      const dmUsername = dm.otherUser?.username ?? dm.name ?? 'User';
                      const isSending = sendingTo === dm.id;
                      return (
                        <button
                          key={dm.id}
                          type="button"
                          onClick={() => handleSendDM(dm.id)}
                          disabled={!!sendingTo}
                          className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover disabled:opacity-50 text-left text-t-primary"
                        >
                          {dm.isGroup ? (
                            <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
                              <LazyGif src={dm.icon ?? defaultGroupIcon} frameSrc={getFrameUrl(dm.icon)} alt="" className="w-full h-full object-cover" />
                            </div>
                          ) : (
                            <UserAvatar user={{ ...(dm.otherUser ?? { avatar: null }), username: dmUsername }} size={40} />
                          )}
                          <span className="flex-1 truncate font-medium">{label}</span>
                          {dm.isGroup && <Users size={14} className="text-t-secondary" />}
                          {isSending && <Loader2 size={18} className="animate-spin shrink-0 text-t-accent" />}
                        </button>
                      );
                    })}
                    {filtered.length === 0 && (
                      <p className="px-3 py-4 text-sm text-t-secondary">{t('forward.noConversationsMatchSearch')}</p>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {step === 'servers' && (
            <div className="space-y-1">
              {servers.filter((s) => textChannels(s).length > 0).length === 0 ? (
                <p className="px-3 py-4 text-sm text-t-secondary">{t('forward.noServersWithChannels')}</p>
              ) : (() => {
                const serversWithChannels = servers.filter((s) => textChannels(s).length > 0);
                const filteredServers = searchNorm
                  ? serversWithChannels.filter((server) => {
                      const nameMatch = (server.name || '').toLowerCase().includes(searchNorm);
                      const channelMatch = textChannels(server).some((ch) => ch.name.toLowerCase().includes(searchNorm));
                      return nameMatch || channelMatch;
                    })
                  : serversWithChannels;
                return (
                  <>
                    {filteredServers.map((server) => {
                      const channels = textChannels(server);
                      const filteredChannels = searchNorm
                        ? channels.filter((ch) => ch.name.toLowerCase().includes(searchNorm))
                        : channels;
                      const isExpanded = expandedServerId === server.id;
                      const serverMatchesSearch = searchNorm && (server.name || '').toLowerCase().includes(searchNorm);
                      const autoExpandWithSearch = !!searchNorm && (filteredChannels.length > 0 || serverMatchesSearch);
                      const showChannels = (isExpanded || autoExpandWithSearch) && (filteredChannels.length > 0 || serverMatchesSearch);
                      return (
                        <div key={server.id} className="rounded-xl overflow-hidden bg-fill-hover">
                          <button
                            type="button"
                            onClick={() => setExpandedServerId((id) => (id === server.id ? null : server.id))}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-fill-hover text-left text-t-primary"
                          >
                            <div className="w-10 h-10 rounded-full overflow-hidden shrink-0">
                              <ServerIcon icon={server.icon} name={server.name} size={40} className="w-full h-full rounded-full" />
                            </div>
                            <span className="flex-1 truncate font-medium">{server.name}</span>
                            {isExpanded ? <ChevronDown size={18} className="text-t-secondary" /> : <ChevronRight size={18} className="text-t-secondary" />}
                          </button>
                          {showChannels &&
                            (searchNorm ? filteredChannels : channels).map((ch: Channel) => {
                              const isSending = sendingTo === ch.id;
                              return (
                                <button
                                  key={ch.id}
                                  type="button"
                                  onClick={() => handleSendChannel(ch.id)}
                                  disabled={!!sendingTo}
                                  className="w-full flex items-center gap-3 pl-4 pr-3 py-2 rounded-lg hover:bg-fill-hover disabled:opacity-50 text-left text-t-primary"
                                >
                                  <Hash size={18} className="shrink-0 opacity-60 text-t-secondary" />
                                  <span className="flex-1 truncate">{ch.name}</span>
                                  {isSending && <Loader2 size={16} className="animate-spin shrink-0 text-t-accent" />}
                                </button>
                              );
                            })}
                        </div>
                      );
                    })}
                    {filteredServers.length === 0 && (
                      <p className="px-3 py-4 text-sm text-t-secondary">{t('forward.noServersMatchSearch')}</p>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </div>
      </div>

      {/* Encryption warning when forwarding from encrypted DM to server channel */}
      {encryptionWarningChannelId && (
        <div className="fixed inset-0 flex items-center justify-center p-4" style={{ zIndex: 'var(--z-max)' as unknown as number, backgroundColor: 'var(--overlay-backdrop)' }} onClick={() => setEncryptionWarningChannelId(null)}>
          <div className="w-full max-w-sm rounded-xl border shadow-2xl p-5 flex flex-col gap-4 bg-panel border-default" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-2">
              <ShieldAlert size={20} style={{ color: 'var(--warning)' }} />
              <h3 className="text-base font-semibold text-t-primary">{t('forward.encryptionWarningTitle', 'Unencrypted forward')}</h3>
            </div>
            <p className="text-sm text-t-secondary">
              {t('forward.encryptionWarningBody', 'This message is from an encrypted conversation. Forwarding to a server channel will share it without encryption. Continue?')}
            </p>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setEncryptionWarningChannelId(null)} className="px-4 py-2 rounded-lg text-sm font-medium hover:bg-fill-hover transition-colors text-t-secondary">
                {t('common.cancel', 'Cancel')}
              </button>
              <button type="button" onClick={() => handleSendChannel(encryptionWarningChannelId)} className="px-4 py-2 rounded-lg text-sm font-medium transition-colors" style={{ backgroundColor: 'var(--warning)', color: 'var(--text-on-accent)' }}>
                {t('forward.forwardAnyway', 'Forward')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return createPortal(content, document.body);
};
