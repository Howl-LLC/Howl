// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useMemo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Check, Settings } from 'lucide-react';
import type { Poll } from '../types';
import { apiClient } from '../services/api';

export interface PollEmbedProps {
  poll: Poll;
  onVote: (pollId: string, optionId: string) => void;
  onRemoveVote: (pollId: string, optionId: string) => void;
  onClose?: (pollId: string) => void;
  onDelete?: (pollId: string) => void;
  currentUserId: string;
  canManage: boolean;
  serverId?: string;
  channelId?: string;
  dmChannelId?: string;
}

/** Deterministic height: header ~56px + option ~52px each + footer ~40px + padding */
export function getPollHeight(optionCount: number): number {
  return 56 + optionCount * 52 + 40 + 24;
}

export const PollEmbed: React.FC<PollEmbedProps> = ({ poll, onVote, onRemoveVote, onClose, onDelete, currentUserId, canManage, serverId, channelId, dmChannelId }) => {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [voterPopup, setVoterPopup] = useState<{ optionId: string; voters: Array<{ id: string; username: string; avatar?: string | null }>; total: number } | null>(null);
  const [voterLoading, setVoterLoading] = useState(false);
  const voterPopupRef = useRef<HTMLDivElement>(null);
  const [now, setNow] = useState(Date.now());

  const isClosed = useMemo(() => {
    if (poll.closedAt) return true;
    if (poll.expiresAt && new Date(poll.expiresAt).getTime() <= now) return true;
    return false;
  }, [poll.closedAt, poll.expiresAt, now]);

  const myVoteSet = useMemo(() => new Set(poll.myVotes ?? []), [poll.myVotes]);
  const hasVoted = myVoteSet.size > 0;
  const showResults = hasVoted || isClosed;
  const isCreator = poll.authorId === currentUserId;
  const showManage = canManage || isCreator;

  // Live countdown timer — update every 60s
  useEffect(() => {
    if (isClosed || !poll.expiresAt) return;
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, [isClosed, poll.expiresAt]);

  const timeLabel = useMemo(() => {
    if (isClosed) return t('polls.ended');
    if (!poll.expiresAt) return t('polls.noExpiry');
    const diff = new Date(poll.expiresAt).getTime() - now;
    if (diff <= 0) return t('polls.ended');
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return t('polls.endsIn', { time: `${mins}m` });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('polls.endsIn', { time: `${hours}h` });
    const days = Math.floor(hours / 24);
    return t('polls.endsIn', { time: `${days}d` });
  }, [poll.expiresAt, isClosed, now, t]);

  const handleVoteClick = (optionId: string) => {
    if (isClosed) return;
    if (myVoteSet.has(optionId)) {
      onRemoveVote(poll.id, optionId);
    } else {
      onVote(poll.id, optionId);
    }
  };

  const fetchVoters = useCallback(async (optionId: string) => {
    if (poll.anonymous || voterLoading) return;
    setVoterLoading(true);
    try {
      const result = serverId && channelId
        ? await apiClient.getPollVoters(poll.id, optionId, serverId, channelId)
        : dmChannelId
        ? await apiClient.getDmPollVoters(poll.id, optionId, dmChannelId)
        : null;
      if (result) {
        setVoterPopup({ optionId, voters: result.voters, total: result.total });
      }
    } catch { /* silent */ }
    finally { setVoterLoading(false); }
  }, [poll.id, poll.anonymous, serverId, channelId, dmChannelId, voterLoading]);

  // Close voter popup on outside click
  useEffect(() => {
    if (!voterPopup) return;
    const handler = (e: MouseEvent) => {
      if (voterPopupRef.current && !voterPopupRef.current.contains(e.target as Node)) {
        setVoterPopup(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [voterPopup]);

  const minHeight = getPollHeight(poll.options.length);

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        backgroundColor: 'var(--fill-hover)',
        border: '1px solid var(--border-subtle)',
        minHeight,
        opacity: isClosed ? 0.65 : 1,
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3.5 py-2.5">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <BarChart3 size={16} style={{ color: 'var(--cyan-accent)' }} className="shrink-0" />
          <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>{poll.question}</span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          {poll.allowMultiple && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}>MULTI</span>
          )}
          {poll.anonymous && (
            <span className="text-[8px] font-bold px-1.5 py-0.5 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>ANON</span>
          )}
          {showManage && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setMenuOpen((o) => !o)}
                className="p-1 rounded-lg hover:bg-fill-active"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <Settings size={14} />
              </button>
              {menuOpen && (
                <div
                  className="absolute right-0 top-full mt-1 w-40 py-1 rounded-xl border shadow-xl z-50"
                  style={{ backgroundColor: 'var(--bg-floating)', borderColor: 'var(--border-subtle)' }}
                >
                  {!isClosed && onClose && (
                    <button
                      type="button"
                      onClick={() => { onClose(poll.id); setMenuOpen(false); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-fill-active"
                      style={{ color: 'var(--text-primary)' }}
                    >
                      {t('polls.closePoll')}
                    </button>
                  )}
                  {onDelete && (
                    <button
                      type="button"
                      onClick={() => { onDelete(poll.id); setMenuOpen(false); }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-fill-active"
                      style={{ color: 'var(--danger)' }}
                    >
                      {t('polls.deletePoll')}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Options */}
      <div className="px-2.5 pb-2.5 flex flex-col gap-1.5">
        {poll.options.map((opt) => {
          const pct = poll.totalVotes > 0 ? Math.round((opt.voteCount / poll.totalVotes) * 100) : 0;
          const isMyVote = myVoteSet.has(opt.id);
          const optionVoters = voterPopup?.optionId === opt.id ? voterPopup : null;

          return (
            <div key={opt.id} className="relative">
              <button
                type="button"
                onClick={() => handleVoteClick(opt.id)}
                disabled={isClosed}
                className="w-full relative rounded-lg overflow-hidden text-left transition-all disabled:cursor-default group"
                style={{
                  border: isMyVote
                    ? '1px solid color-mix(in srgb, var(--cyan-accent) 25%, transparent)'
                    : '1px solid var(--glass-border)',
                  backgroundColor: 'var(--fill-hover)',
                  padding: '10px 12px',
                }}
              >
                {/* Progress bar fill */}
                {showResults && (
                  <div
                    className="absolute inset-y-0 left-0 transition-all duration-500 ease-out rounded-lg"
                    style={{
                      width: `${pct}%`,
                      backgroundColor: isMyVote
                        ? 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)'
                        : 'var(--fill-hover)',
                    }}
                  />
                )}
                <div className="relative flex items-center gap-2.5">
                  {opt.emoji && (
                    <span className="text-base w-5 text-center shrink-0">{opt.emoji}</span>
                  )}
                  <span
                    className="text-[13px] font-medium flex-1 truncate"
                    style={{ color: isMyVote ? 'var(--cyan-accent)' : 'var(--text-primary)' }}
                  >
                    {opt.text}
                  </span>
                  {showResults && !poll.anonymous && opt.voteCount > 0 && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); fetchVoters(opt.id); }}
                      className="flex items-center shrink-0 hover:brightness-125 transition-all"
                      title={`${opt.voteCount} voter${opt.voteCount !== 1 ? 's' : ''}`}
                    >
                      <div
                        className="w-[18px] h-[18px] rounded-full flex items-center justify-center text-[7px] font-bold border-[1.5px]"
                        style={{
                          borderColor: 'var(--bg-panel)',
                          backgroundColor: 'var(--accent-muted)',
                          color: 'var(--cyan-accent)',
                        }}
                      >
                        {opt.voteCount}
                      </div>
                    </button>
                  )}
                  {showResults && (
                    <div className="flex items-center gap-1 shrink-0">
                      {isMyVote && <Check size={12} style={{ color: 'var(--cyan-accent)' }} />}
                      <span
                        className="text-xs font-semibold"
                        style={{ color: isMyVote ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
                      >
                        {pct}%
                      </span>
                    </div>
                  )}
                </div>
                {!isClosed && !showResults && (
                  <div
                    className="absolute inset-0 rounded-lg opacity-0 group-hover:opacity-100 transition-opacity"
                    style={{ backgroundColor: 'var(--fill-hover)' }}
                  />
                )}
              </button>

              {/* Voter popup */}
              {optionVoters && (
                <div
                  ref={voterPopupRef}
                  className="absolute left-0 right-0 top-full mt-1 z-50 rounded-xl border p-2 shadow-xl"
                  style={{ backgroundColor: 'var(--bg-panel)', borderColor: 'var(--glass-border)', backdropFilter: 'blur(16px)' }}
                >
                  {optionVoters.voters.length === 0 ? (
                    <p className="text-[10px] text-center py-2" style={{ color: 'var(--text-secondary)' }}>{t('polls.noVotes')}</p>
                  ) : (
                    <div className="flex flex-col gap-1 max-h-32 overflow-y-auto">
                      {optionVoters.voters.map((voter) => (
                        <div key={voter.id} className="flex items-center gap-2 px-1.5 py-1 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                          <div
                            className="w-5 h-5 rounded-full flex items-center justify-center text-[8px] font-bold shrink-0"
                            style={{ backgroundColor: 'var(--accent-muted)', color: 'var(--cyan-accent)' }}
                          >
                            {voter.username?.[0]?.toUpperCase() ?? '?'}
                          </div>
                          <span className="text-[11px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{voter.username}</span>
                        </div>
                      ))}
                      {optionVoters.total > optionVoters.voters.length && (
                        <p className="text-[9px] text-center py-1" style={{ color: 'var(--text-secondary)' }}>
                          +{optionVoters.total - optionVoters.voters.length} more
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3.5 py-2 border-t" style={{ borderColor: 'var(--glass-border)' }}>
        <div className="flex items-center gap-1.5">
          <span className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>
            {poll.totalVotes} {poll.totalVotes === 1 ? t('polls.voteSingle', { count: 1 }) : t('polls.votes', { count: poll.totalVotes })}
          </span>
          {hasVoted && (
            <>
              <span className="text-[11px]" style={{ color: 'var(--text-secondary)', opacity: 0.3 }}>/</span>
              <span className="text-[11px] font-medium" style={{ color: 'var(--cyan-accent)' }}>{t('polls.youVoted')}</span>
            </>
          )}
        </div>
        <span className="text-[11px]" style={{ color: isClosed ? 'var(--danger)' : 'var(--text-secondary)' }}>
          {timeLabel}
        </span>
      </div>
    </div>
  );
};
