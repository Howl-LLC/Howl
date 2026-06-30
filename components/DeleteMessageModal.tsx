// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { createPortal } from 'react-dom';
import { Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LetterAvatar } from './LetterAvatar';
import { useMessageStore } from '../stores/messageStore';

interface DeleteMessageModalProps {
  onClose: () => void;
  onConfirm: () => void;
}

export const DeleteMessageModal: React.FC<DeleteMessageModalProps> = ({ onClose, onConfirm }) => {
  const pending = useMessageStore(s => s.deleteMessagePending);
  const isOpen = !!pending;
  const message = pending ?? { id: '', content: '', authorUsername: '', authorAvatar: null as string | null | undefined, createdAt: '' };
  const { t } = useTranslation();

  if (!isOpen) return null;

  const timestamp = (() => {
    try {
      const d = new Date(message.createdAt);
      return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    } catch {
      return '';
    }
  })();

  return createPortal(
    <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose} />
      <div
        className="w-full max-w-md rounded-2xl border shadow-2xl relative spring-pop-in"
        style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--border-subtle)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="p-6 pb-3 flex items-start justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-red-500/10 border border-red-500/20 flex items-center justify-center shrink-0">
              <Trash2 size={20} className="text-red-400" />
            </div>
            <div>
              <h3 className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>
                {t('chat.deleteMessage', 'Delete Message')}
              </h3>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                {t('chat.deleteMessageWarning', 'This action cannot be undone.')}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-fill-active transition-colors"
            style={{ color: 'var(--text-secondary)' }}
          >
            <X size={16} />
          </button>
        </div>

        {/* Message preview */}
        <div className="mx-6 mb-5 rounded-xl border p-3" style={{ borderColor: 'var(--border-subtle)', backgroundColor: 'var(--fill-hover)' }}>
          <div className="flex items-start gap-2.5">
            <div className="w-8 h-8 rounded-[var(--radius-lg)] overflow-hidden shrink-0">
              <LetterAvatar avatar={message.authorAvatar} username={message.authorUsername} size={32} className="rounded-[var(--radius-lg)]" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="text-xs font-bold" style={{ color: 'var(--text-primary)' }}>{message.authorUsername}</span>
                <span className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{timestamp}</span>
              </div>
              <p className="text-xs mt-0.5 line-clamp-3 break-words" style={{ color: 'var(--text-secondary)' }}>
                {message.content || '(attachment)'}
              </p>
            </div>
          </div>
        </div>

        {/* Actions */}
        <div className="px-6 pb-6 flex gap-3">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary flex-1 text-[10px] uppercase tracking-widest py-2.5"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="btn-cta-danger flex-1 text-[10px] font-bold uppercase tracking-widest py-2.5 rounded-xl transition-all"
          >
            {t('common.delete', 'Delete')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
