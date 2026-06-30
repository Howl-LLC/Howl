// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { Monitor, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ScreenShareCard } from './ScreenShareCard';
import { RoleNameStyle, type RoleStyle } from '../RoleNameStyle';
import type { StreamContext } from '../../stores/types';

const NAME_SENTINEL = '\u0001NAME\u0001';

interface StyledParticipantFields {
  username?: string;
  nameColor?: string | null;
  nameFont?: string | null;
  nameEffect?: string | null;
  roleColor?: string | null;
  roleStyle?: string | null;
  effectivePlan?: string | null;
}

interface FocusedScreenOverlayProps {
  focusedScreenKey: string;
  screenStream: MediaStream | null;
  remoteParticipants: Array<StyledParticipantFields & { userId: string; screenStream?: MediaStream | null; screenShareAudioStream?: MediaStream | null }>;
  /** Optional socket participants for username fallback (voice channel uses this) */
  socketParticipants?: Array<StyledParticipantFields & { userId: string }>;
  onClose: () => void;
  isMobile?: boolean;
  isDeafened?: boolean;
  speakerVolume?: number;
  speakerId?: string;
  /** Viewer tracking context; required to render the viewer indicator. */
  streamContext?: StreamContext;
  /** Current user ID, used to exclude self from the viewer count. */
  selfUserId?: string;
}

/**
 * Fullscreen overlay for viewing a screen share stream.
 * Used by both VoiceChannel and DMCallView when a user focuses a screen share card.
 */
export const FocusedScreenOverlay: React.FC<FocusedScreenOverlayProps> = ({
  focusedScreenKey,
  screenStream,
  remoteParticipants,
  socketParticipants,
  onClose,
  isMobile = false,
  isDeafened = false,
  speakerVolume,
  speakerId,
  streamContext,
  selfUserId,
}) => {
  const { t } = useTranslation();

  const isSelf = focusedScreenKey === 'self-screen';
  const remoteUid = isSelf ? null : focusedScreenKey.replace('screen-', '');
  const remote = remoteUid ? remoteParticipants.find((r) => String(r.userId) === remoteUid) : undefined;
  const socketP = remoteUid ? socketParticipants?.find((p) => String(p.userId) === remoteUid) : undefined;
  const stream = isSelf ? screenStream : (remote?.screenStream ?? null);

  if (!stream) return null;

  const username = remote?.username ?? socketP?.username ?? remoteUid ?? '';

  // Render the styled username inline within the translated "…'s Screen" string by
  // interpolating a sentinel and splitting around it. Preserves localization word order.
  const labelNode = isSelf
    ? <>{t('voice.yourScreen')}</>
    : (() => {
        const nc = remote?.nameColor ?? socketP?.nameColor;
        const nf = remote?.nameFont ?? socketP?.nameFont;
        const ne = remote?.nameEffect ?? socketP?.nameEffect;
        const rc = remote?.roleColor ?? socketP?.roleColor;
        const rs = (remote?.roleStyle ?? socketP?.roleStyle) as RoleStyle | undefined;
        const plan = remote?.effectivePlan ?? socketP?.effectivePlan;
        const isPro = plan === 'pro';
        const template = t('voice.usernameScreen', { username: NAME_SENTINEL });
        const [before, after = ''] = template.split(NAME_SENTINEL);
        const nameEl = (rc || (isPro && (nc || nf || ne))) ? (
          <RoleNameStyle
            name={username}
            color={rc ?? undefined}
            style={rs ?? 'solid'}
            overrideColor={isPro ? nc ?? undefined : undefined}
            overrideFont={isPro ? nf ?? undefined : undefined}
            nameEffect={isPro ? ne ?? undefined : undefined}
          />
        ) : username;
        return <>{before}{nameEl}{after}</>;
      })();

  return (
    <div className="absolute inset-0 z-[195] bg-black/95 backdrop-blur-3xl flex flex-col animate-in fade-in duration-300">
      <div className={`flex items-center justify-between border-b border-emerald-500/10 shrink-0 ${isMobile ? 'h-12 px-3' : 'h-14 px-6'}`}>
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-emerald-500 flex items-center justify-center shrink-0">
            <Monitor size={15} className="text-black" />
          </div>
          <span className="text-white font-bold text-sm uppercase tracking-wide">{labelNode}</span>
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse shrink-0" />
        </div>
        <button
          type="button"
          onClick={onClose}
          className={`bg-white/5 hover:bg-white/10 rounded-full text-white transition-all ${isMobile ? 'p-3' : 'p-2.5'}`}
          style={isMobile ? { minWidth: 44, minHeight: 44 } : undefined}
          aria-label={t('common.close')}
        >
          <Minimize2 size={20} />
        </button>
      </div>
      <div className={`flex-1 flex items-center justify-center min-h-0 ${isMobile ? 'p-1' : 'p-4'}`}>
        <div className="w-full h-full relative bg-black rounded-xl overflow-hidden border border-[var(--glass-border)]">
          <ScreenShareCard
            stream={stream}
            screenShareAudioStream={remote?.screenShareAudioStream}
            userId={remoteUid ?? undefined}
            username={username}
            isDeafened={isDeafened}
            speakerVolume={speakerVolume}
            speakerId={speakerId}
            streamContext={streamContext}
            selfUserId={selfUserId}
          />
        </div>
      </div>
    </div>
  );
};
