// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { formatUsername } from '../../types';
import { UserAvatar } from '../UserAvatar';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface CreateGroupDmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateGroup: (memberIds: string[]) => Promise<void>;
  getFriends: () => Promise<Array<{ id: string; username: string; discriminator?: string; avatar?: string | null }>>;
  /** Bumps when the friend list changes — triggers re-fetch while modal is open */
  friendListVersion?: number;
}

export const CreateGroupDmModal: React.FC<CreateGroupDmModalProps> = ({
  isOpen,
  onClose,
  onCreateGroup,
  getFriends,
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

  const toggleFriend = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else if (next.size < 14) next.add(userId);
      return next;
    });
  };

  const handleCreate = async () => {
    const ids = [...selected];
    if (ids.length < 1) return;
    setCreating(true);
    setError(null);
    try {
      await onCreateGroup(ids);
      onClose();
    } catch (e) {
      if ((e as { reason?: string }).reason === 'peer-unprovisioned') {
        // Map the typed rejection to friendly copy instead of the raw
        // "member <UUID> has no available KeyPackages" message.
        const offenderId = (e as { unprovisionedUserId?: string }).unprovisionedUserId;
        const name = friends.find((f) => f.id === offenderId)?.username ?? 'a member';
        setError(t('encryption.peerUnprovisionedComposer', { name, defaultValue: 'Waiting for {{name}} to enable encryption' }));
      } else {
        setError(e instanceof Error ? e.message : 'Failed to create group DM.');
      }
    } finally {
      setCreating(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm" onClick={() => !creating && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-group-dm-title"
        className="rounded-2xl border border-[var(--glass-border)] p-7 w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl spring-pop-in"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4 shrink-0">
          <span id="create-group-dm-title" className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.startGroupChatTitle')}</span>
          <button onClick={() => !creating && onClose()} className="p-1.5 rounded-lg hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <p className="text-xs mb-4 shrink-0" style={{ color: 'var(--text-secondary)' }}>{t('dm.selectFriendsToAdd')}</p>
        <div className="flex-1 overflow-y-auto min-h-0 space-y-1 mb-4">
          {friends.length === 0 ? (
            <p className="text-xs py-6 text-center" style={{ color: 'var(--text-secondary)' }}>{t('dm.noFriendsYet')}</p>
          ) : (
            friends.map((friend) => (
              <button
                key={friend.id}
                type="button"
                onClick={() => toggleFriend(friend.id)}
                className={`w-full flex items-center p-3 rounded-xl transition-all text-left ${
                  selected.has(friend.id) ? 'bg-[var(--cyan-accent)]/20 border border-[var(--cyan-accent)]/40' : 'hover:bg-fill-hover border border-transparent'
                }`}
                style={{ color: 'var(--text-primary)' }}
              >
                <UserAvatar user={{ ...friend, username: formatUsername(friend) }} size={36} className="mr-3" />
                <span className="text-sm font-black tracking-tight truncate flex-1">{formatUsername(friend)}</span>
                <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center shrink-0 ${selected.has(friend.id) ? 'bg-[var(--cyan-accent)] border-[var(--cyan-accent)]' : 'border-[var(--border-strong)]'}`}>
                  {selected.has(friend.id) && <span className="text-white text-xs">&#10003;</span>}
                </div>
              </button>
            ))
          )}
        </div>
        {selected.size > 0 && <p className="text-[10px] font-medium pt-1" style={{ color: selected.size >= 14 ? '#f87171' : 'var(--text-secondary)' }}>{selected.size + 1}/15 members</p>}
        {error && <p className="text-xs text-red-400 pt-1">{error}</p>}
        <div className="flex justify-end gap-3 shrink-0 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <button onClick={() => !creating && onClose()} className="px-4 py-2.5 rounded-xl text-xs font-bold uppercase hover:bg-fill-hover transition-colors" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
          <button
            onClick={handleCreate}
            disabled={creating || selected.size < 1 || selected.size >= 15}
            className="btn-cta px-5 py-2.5 rounded-xl text-xs uppercase flex items-center gap-2"
          >
            {creating ? <Loader2 size={14} className="animate-spin" /> : null}
            {t('dm.createGroup')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
