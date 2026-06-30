// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight } from 'lucide-react';
import type { Thread } from '../types';
import { LetterAvatar } from './LetterAvatar';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';

export interface ThreadBarProps {
  thread: Thread;
  onClick: () => void;
}

export const ThreadBar: React.FC<ThreadBarProps> = ({ thread, onClick }) => {
  const { t } = useTranslation();
  const participants = thread.participants ?? [];
  const displayParticipants = participants.slice(0, 3);
  const messageCount = thread.messageCount ?? 0;

  const lastActivityAgo = (() => {
    const diff = Date.now() - new Date(thread.lastActivityAt).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  })();

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 mt-1.5 px-2 py-1.5 rounded-lg hover:bg-fill-hover transition-colors group w-fit max-w-full"
    >
      {/* Avatar stack */}
      {displayParticipants.length > 0 && (
        <div className="flex -space-x-1.5 shrink-0">
          {displayParticipants.map((p) => (
            <div key={p.id} className="w-5 h-5 rounded-[var(--radius-lg)] overflow-hidden border border-[var(--bg-primary)]">
              {p.avatar ? (
                <LazyGif src={p.avatar} frameSrc={getFrameUrl(p.avatar)} alt="" className="w-full h-full object-cover" />
              ) : (
                <LetterAvatar username={p.username} size={20} />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reply count */}
      <span className="text-xs font-semibold shrink-0" style={{ color: 'var(--cyan-accent)' }}>
        {messageCount === 1 ? t('threads.replySingle', { count: 1 }) : t('threads.replies', { count: messageCount })}
      </span>

      {/* Last reply time */}
      <span className="text-[11px] opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: 'var(--text-tertiary)' }}>
        {t('threads.lastReply', { time: lastActivityAgo })}
      </span>

      <ChevronRight size={14} className="shrink-0 opacity-0 group-hover:opacity-60 transition-opacity" style={{ color: 'var(--text-tertiary)' }} />
    </button>
  );
};
