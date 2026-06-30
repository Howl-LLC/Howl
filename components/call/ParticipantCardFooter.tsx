// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import * as React from 'react';
import { MicOff, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LetterAvatar } from '../LetterAvatar';
import { AudioLevelMeter } from '../AudioLevelMeter';
import { SpeakingHighlight } from '../SpeakingHighlight';
import { DeafenedIcon } from './DeafenedIcon';
import { getAvatarEffectClass, type PlanTier } from '../../shared/planPerks';

export type ParticipantConnectionState =
  | 'connected'
  | 'connecting'
  | 'failed'
  | 'calling'
  | 'ringing';

export interface ParticipantCardFooterProps {
  avatar: string | null | undefined;
  username: string;
  /** Rendered name node (caller supplies RoleNameStyle or plain text). */
  nameNode: React.ReactNode;
  /** Audio stream used for live meter + speaking highlight. Null for remote before connect / self when muted. */
  stream: MediaStream | null;
  effectivePlan?: PlanTier | null;
  avatarEffect?: string | null;
  isMuted?: boolean;
  isDeafened?: boolean;
  /** Server-enforced mute (moderator action). Shown as a shield icon. */
  serverMuted?: boolean;
  /** Server-enforced deafen. Shown as a shield icon. */
  serverDeafened?: boolean;
  connectionState?: ParticipantConnectionState;
  /** Show a "SCREEN" badge next to the name when the participant is sharing. */
  isScreenSharing?: boolean;
  /** Slot for per-card action buttons (volume, watch, screen-settings, etc.). */
  rightActions?: React.ReactNode;
  /** Add iOS safe-area bottom inset — used in mobile DM call view. */
  mobileSafeArea?: boolean;
  /** Optional className appended to the outer footer div. */
  className?: string;
}

export const ParticipantCardFooter: React.FC<ParticipantCardFooterProps> = ({
  avatar,
  username,
  nameNode,
  stream,
  effectivePlan,
  avatarEffect,
  isMuted = false,
  isDeafened = false,
  serverMuted = false,
  serverDeafened = false,
  connectionState = 'connected',
  isScreenSharing = false,
  rightActions,
  mobileSafeArea = false,
  className,
}) => {
  const { t } = useTranslation();
  const effectClass = (effectivePlan === 'pro' || effectivePlan === 'essential')
    ? getAvatarEffectClass(avatarEffect)
    : '';
  const dimAvatar = isMuted || isDeafened || serverMuted || serverDeafened;
  const activeStream = isMuted ? null : stream;
  const showMeter = connectionState === 'connected';

  let statusText: string | null = null;
  let statusClass = 'text-[var(--text-secondary)]';
  switch (connectionState) {
    case 'connecting':
      statusText = t('voice.connecting');
      statusClass = 'text-[var(--warning)] animate-pulse';
      break;
    case 'failed':
      statusText = t('voice.failedState');
      statusClass = 'text-[var(--danger)]';
      break;
  }

  return (
    <div
      className={`absolute bottom-0 left-0 right-0 px-3 py-2.5 flex items-center justify-between gap-2 bg-[var(--glass-bg)] backdrop-blur-sm z-10${className ? ` ${className}` : ''}`}
      style={mobileSafeArea ? { paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.625rem)' } : undefined}
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        <div className={`w-10 h-10 rounded-[var(--radius-lg)] overflow-visible ring-2 ring-[var(--glass-border)] shrink-0 relative ${effectClass} ${connectionState === 'ringing' ? 'howl-ringing-avatar' : ''}`}>
          <LetterAvatar
            avatar={avatar ?? undefined}
            username={username}
            size={40}
            className={`rounded-full ${dimAvatar ? 'opacity-60' : 'opacity-95'}`}
          />
          {serverDeafened && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-[var(--radius-lg)] text-[var(--danger)]"
              title={t('userMenu.serverDeafen')}
            >
              <ShieldAlert size={18} />
            </div>
          )}
          {!serverDeafened && serverMuted && (
            <div
              className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-[var(--radius-lg)] text-[var(--danger)]"
              title={t('userMenu.serverMute')}
            >
              <ShieldAlert size={16} />
            </div>
          )}
          {!serverDeafened && !serverMuted && isDeafened && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-[var(--radius-lg)] text-[var(--danger)]">
              <DeafenedIcon size={18} />
            </div>
          )}
          {!serverDeafened && !serverMuted && !isDeafened && isMuted && (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-[var(--radius-lg)]">
              <MicOff size={18} className="text-[var(--danger)]" />
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {showMeter && <AudioLevelMeter stream={activeStream} size="md" />}
          <SpeakingHighlight
            stream={activeStream}
            className="text-xs text-[var(--text-primary)] font-bold truncate min-w-0"
          >
            {nameNode}
          </SpeakingHighlight>
          {statusText && (
            <span className={`text-[9px] shrink-0 ${statusClass}`}>{statusText}</span>
          )}
          {isScreenSharing && connectionState === 'connected' && (
            <span className="px-1.5 py-0.5 rounded-lg text-[8px] font-bold bg-[var(--success)] text-[var(--text-primary)] uppercase shrink-0">
              {t('voice.screenLabel')}
            </span>
          )}
        </div>
      </div>

      {rightActions && (
        <div className="flex items-center gap-1 shrink-0">
          {rightActions}
        </div>
      )}
    </div>
  );
};
