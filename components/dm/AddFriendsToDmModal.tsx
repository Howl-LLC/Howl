// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatUsername } from '../../types';
import { UserAvatar } from '../UserAvatar';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface AddFriendsToDmModalProps {
  isOpen: boolean;
  dmChannelId: string;
  existingMemberIds: string[];
  maxMembers: number;
  onClose: () => void;
  onAddMembers: (dmChannelId: string, memberIds: string[]) => Promise<void>;
  getFriends: () => Promise<Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>>;
  isExistingGroup?: boolean;
  friendListVersion?: number;
}

export const AddFriendsToDmModal: React.FC<AddFriendsToDmModalProps> = ({
  isOpen,
  dmChannelId,
  existingMemberIds,
  maxMembers,
  onClose,
  onAddMembers,
  getFriends,
  isExistingGroup = false,
  friendListVersion,
}) => {
  const { t } = useTranslation();
  const [friends, setFriends] = useState<Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    if (!isOpen) return;
    setSelected(new Set());
    setError(null);
    getFriends()
      .then(setFriends)
      .catch(() => setFriends([]));
  }, [isOpen, getFriends, friendListVersion]);

  if (!isOpen) return null;

  const currentCount = existingMemberIds.length + 1; // +1 for current user

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !creating && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-friends-dm-title"
        className="rounded-2xl border border-[var(--glass-border)] p-6 w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <span id="add-friends-dm-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.addFriendsToChat')}</span>
          <button type="button" onClick={() => !creating && onClose()} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <p className="text-[11px] mb-3 shrink-0" style={{ color: 'var(--text-secondary)' }}>{t('dm.selectFriendsNewGroup')}</p>
        <div className="flex-1 overflow-y-auto min-h-0 space-y-1 mb-4">
          {friends.length === 0 ? (
            <p className="text-[11px] py-4" style={{ color: 'var(--text-secondary)' }}>{t('dm.noFriendsToAdd')}</p>
          ) : (
            friends.map((friend) => {
              const alreadyInChat = existingMemberIds.includes(friend.id);
              return (
                <button
                  key={friend.id}
                  type="button"
                  disabled={alreadyInChat}
                  onClick={() => {
                    if (alreadyInChat) return;
                    setSelected((prev) => {
                      if (prev.has(friend.id)) return new Set([...prev].filter((id) => id !== friend.id));
                      if (currentCount + prev.size >= maxMembers) return prev;
                      return new Set([...prev, friend.id]);
                    });
                  }}
                  className={`w-full flex items-center p-3 rounded-xl transition-all text-left ${alreadyInChat ? 'opacity-50 cursor-not-allowed' : selected.has(friend.id) ? 'bg-[var(--cyan-accent)]/20 border border-[var(--cyan-accent)]/40' : 'hover:bg-fill-hover border border-transparent'}`}
                  style={{ color: 'var(--text-primary)' }}
                >
                  <UserAvatar user={{ ...friend, username: formatUsername(friend) }} size={32} className="mr-3" />
                  <span className="text-[13px] font-black tracking-tight truncate flex-1">{formatUsername(friend)}</span>
                  {alreadyInChat && <span className="text-[10px] text-t-secondary shrink-0">{t('dm.inChat')}</span>}
                  {!alreadyInChat && (
                    <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center shrink-0 ${selected.has(friend.id) ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)]' : 'border-[var(--border-strong)]'}`}>
                      {selected.has(friend.id) && <span className="text-white text-xs">&#10003;</span>}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
        {(() => {
          const newTotal = currentCount + selected.size;
          return newTotal > 1 ? <p className="text-[10px] font-medium" style={{ color: newTotal > maxMembers ? '#f87171' : 'var(--text-secondary)' }}>{newTotal}/{maxMembers} members</p> : null;
        })()}
        {error && <p className="text-xs text-red-400">{error}</p>}
        <div className="flex justify-end gap-2 shrink-0">
          <button type="button" onClick={() => !creating && onClose()} className="px-4 py-2 rounded-lg text-[11px] font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
          <button
            type="button"
            disabled={creating || selected.size === 0 || currentCount + selected.size > maxMembers}
            onClick={async () => {
              const memberIds = [...new Set([...existingMemberIds, ...Array.from(selected)])];
              setCreating(true);
              setError(null);
              try {
                await onAddMembers(dmChannelId, memberIds);
                onClose();
              } catch (e) {
                if ((e as { reason?: string }).reason === 'peer-unprovisioned') {
                  // Map the typed rejection to friendly copy instead of the
                  // raw "member <UUID> has no available KeyPackages" message.
                  const offenderId = (e as { unprovisionedUserId?: string }).unprovisionedUserId;
                  const name = friends.find((f) => f.id === offenderId)?.username ?? 'a member';
                  setError(t('encryption.peerUnprovisionedComposer', { name, defaultValue: 'Waiting for {{name}} to enable encryption' }));
                } else {
                  setError(e instanceof Error ? e.message : 'Failed to add members.');
                }
              } finally {
                setCreating(false);
              }
            }}
            className="btn-cta px-4 py-2 rounded-lg text-[11px] uppercase flex items-center gap-2"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {isExistingGroup ? t('dm.addMembers', 'Add Members') : t('dm.createGroup')}
          </button>
        </div>
      </div>
    </div>
  );
};
