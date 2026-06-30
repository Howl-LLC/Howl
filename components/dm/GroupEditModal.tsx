// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect } from 'react';
import { X, Users, Loader2, Crown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../../services/api';
import { sanitizeImgSrc } from '../../utils/sanitizeImgSrc';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';
import { useFocusTrap } from '../../hooks/useFocusTrap';

interface GroupEditModalProps {
  isOpen: boolean;
  dmChannelId: string;
  currentName: string;
  currentIcon?: string;
  onClose: () => void;
  onSave: (dmChannelId: string, data: { name?: string; icon?: string }) => void;
  ownerId?: string | null;
  currentUserId: string;
  members: Array<{ id: string; username: string; avatar?: string | null }>;
  onKickMember: (userId: string) => void | Promise<void>;
}

export const GroupEditModal: React.FC<GroupEditModalProps> = ({
  isOpen,
  dmChannelId,
  currentName,
  currentIcon,
  onClose,
  onSave,
  ownerId,
  currentUserId,
  members,
  onKickMember,
}) => {
  const { t } = useTranslation();
  const [groupEditName, setGroupEditName] = useState(currentName);
  const [groupEditIcon, setGroupEditIcon] = useState(currentIcon ?? '');
  const [groupEditSaving, setGroupEditSaving] = useState(false);
  const [kicking, setKicking] = useState<string | null>(null);
  const groupEditIconInputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  useEffect(() => {
    if (isOpen) {
      setGroupEditName(currentName);
      setGroupEditIcon(currentIcon ?? '');
    }
  }, [isOpen, currentName, currentIcon]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => !groupEditSaving && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-edit-title"
        className="rounded-2xl border border-[var(--glass-border)] p-6 w-full max-w-md max-h-[90vh] overflow-y-auto flex flex-col shadow-2xl"
        style={{ backgroundColor: 'var(--bg-panel)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <span id="group-edit-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('dm.editGroup')}</span>
          <button type="button" onClick={() => !groupEditSaving && onClose()} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
            <X size={18} />
          </button>
        </div>
        <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>{t('dm.groupNamePlaceholder')}</label>
        <input
          type="text"
          value={groupEditName}
          onChange={(e) => setGroupEditName(e.target.value)}
          maxLength={100}
          placeholder={t('dm.groupNamePlaceholder')}
          className="w-full px-4 py-3 rounded-xl border mb-4 bg-black/20 outline-none focus:border-[var(--cyan-accent)]/50"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--text-primary)' }}
        />
        <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>{t('dm.groupIcon')}</label>
        <input
          ref={groupEditIconInputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,.png,.jpg,.jpeg,.gif"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (!file || !['image/png', 'image/jpeg', 'image/gif'].includes(file.type)) return;
            const reader = new FileReader();
            reader.onload = () => { const data = reader.result; if (typeof data === 'string') setGroupEditIcon(data); };
            reader.readAsDataURL(file);
            e.target.value = '';
          }}
        />
        <div className="flex items-center gap-4 mb-6">
          <button
            type="button"
            onClick={() => groupEditIconInputRef.current?.click()}
            className="w-16 h-16 rounded-xl border-2 border-dashed flex items-center justify-center overflow-hidden shrink-0 focus:outline-none focus:ring-2 focus:ring-[var(--cyan-accent)]/50"
            style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--bg-input)' }}
          >
            {groupEditIcon ? (
              <LazyGif src={sanitizeImgSrc(groupEditIcon)} frameSrc={getFrameUrl(groupEditIcon)} alt="" className="w-full h-full object-cover" />
            ) : (
              <Users size={24} style={{ color: 'var(--text-secondary)' }} />
            )}
          </button>
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => groupEditIconInputRef.current?.click()}
              className="text-[11px] font-bold uppercase text-[var(--cyan-accent)] hover:brightness-125"
            >
              {groupEditIcon ? t('dm.changeImage') : t('dm.uploadImage')}
            </button>
            {groupEditIcon && (
              <button
                type="button"
                onClick={() => setGroupEditIcon('')}
                className="text-[11px] font-bold uppercase text-t-secondary hover:text-red-400"
              >
                {t('dm.removeIcon')}
              </button>
            )}
          </div>
        </div>
        <div className="mb-4">
          <label className="text-[11px] font-medium mb-1 block" style={{ color: 'var(--text-secondary)' }}>{t('dm.members')}</label>
          <ul className="flex flex-col gap-1 max-h-48 overflow-y-auto">
            {members.map((m) => {
              const isOwner = m.id === ownerId;
              const canKick = currentUserId === ownerId && m.id !== ownerId;
              return (
                <li key={m.id} className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg hover:bg-fill-hover">
                  <span className="flex items-center gap-2 min-w-0">
                    <span className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>{m.username}</span>
                    {isOwner && <Crown size={12} className="shrink-0 text-amber-400" aria-label={t('dm.owner')} />}
                  </span>
                  {canKick && (
                    <button
                      type="button"
                      disabled={kicking === m.id}
                      onClick={async () => { setKicking(m.id); try { await onKickMember(m.id); } finally { setKicking(null); } }}
                      className="text-[11px] font-bold uppercase text-t-secondary hover:text-red-400 shrink-0 disabled:opacity-50"
                    >
                      {t('dm.removeMember')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={() => !groupEditSaving && onClose()} className="px-4 py-2 rounded-lg text-[11px] font-bold uppercase" style={{ color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
          <button
            type="button"
            disabled={groupEditSaving}
            onClick={async () => {
              const name = groupEditName.trim() || undefined;
              const icon = groupEditIcon.trim() || undefined;
              // Nothing changed (e.g. SAVE after only removing a member, or an
              // auto-named group with no name/icon edits): the PATCH route 400s on
              // an empty body, which would leave the modal hanging open. Just close.
              if (name === (currentName.trim() || undefined) && icon === ((currentIcon ?? '').trim() || undefined)) {
                onClose();
                return;
              }
              setGroupEditSaving(true);
              try {
                await apiClient.updateGroupDM(dmChannelId, { name, icon });
                onSave(dmChannelId, { name, icon });
                onClose();
              } finally {
                setGroupEditSaving(false);
              }
            }}
            className="btn-cta px-4 py-2 rounded-lg text-[11px] uppercase flex items-center gap-2"
          >
            {groupEditSaving ? <Loader2 size={14} className="animate-spin" /> : null}
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
};
