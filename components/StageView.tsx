// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Hand, Mic, LogOut, Settings, MessageSquare, Radio, X, Monitor, Users, Maximize2, Volume2, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { StageSession, StageSpeaker, StageAudienceMember, Channel, Message, User } from '../types';
import type { StageParticipant } from '../hooks/useStageRoom';
import { LetterAvatar } from './LetterAvatar';
import { RoleNameStyle } from './RoleNameStyle';
import { StageTextChat } from './StageTextChat';
import { ParticipantCardFooter } from './call/ParticipantCardFooter';
import { CallControlBar } from './call/CallControlBar';
import { RemoteCameraVideo } from './call/RemoteCameraVideo';
import { ScreenShareCard } from './call/ScreenShareCard';
import { FocusedScreenOverlay } from './call/FocusedScreenOverlay';
import { useIsMobile } from '../hooks/useIsMobile';
import { useSharedAudioLevel } from '../hooks/useAudioLevel';
import { useCardResize } from '../hooks/useCardResize';
import { usePopoutWindow } from '../hooks/usePopoutWindow';
import { toggleElementFullscreen, isFullscreen as isFullscreenActive, onFullscreenChange } from '../utils/fullscreen';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { getAvatarEffectClass } from '../shared/planPerks';
import VolumePopup from './VolumePopup';

// Chat Panel Resize

const STAGE_CHAT_MIN_WIDTH = 240;
const STAGE_CHAT_MAX_WIDTH = 500;
const STAGE_CHAT_DEFAULT_WIDTH = 340;
const STAGE_CHAT_WIDTH_KEY = 'howl_stage_chat_width';

const loadChatWidth = (): number => {
  try { const v = localStorage.getItem(STAGE_CHAT_WIDTH_KEY); return v ? Math.max(STAGE_CHAT_MIN_WIDTH, Math.min(STAGE_CHAT_MAX_WIDTH, Number(v))) : STAGE_CHAT_DEFAULT_WIDTH; } catch { return STAGE_CHAT_DEFAULT_WIDTH; }
};

// Types

export interface StageViewProps {
  channel: Channel;
  session: StageSession;
  currentUserId: string;
  canManage: boolean;
  canRequestToSpeak: boolean;
  hasRaisedHand: boolean;
  hasJoined: boolean;
  isSpeaker: boolean;
  onJoinAudience: () => void;
  onRaiseHand: () => void;
  onLowerHand: (targetUserId?: string) => void;
  onLeave: () => void;
  onEndStage?: () => void;
  onSettings?: () => void;
  onToggleChat?: () => void;
  onInviteToSpeak?: (userId: string) => void;
  onMoveToAudience?: (userId: string) => void;
  onJoinAsSpeaker?: () => void;
  onMoveSelfToAudience?: () => void;
  isInvited?: boolean;
  // LiveKit data
  localStream?: MediaStream | null;
  remoteParticipants?: StageParticipant[];
  // Mute/Camera/Screen controls
  isMuted?: boolean;
  isDeafened?: boolean;
  isCameraOn?: boolean;
  isScreenSharing?: boolean;
  screenStream?: MediaStream | null;
  cameraStream?: MediaStream | null;
  onToggleMute?: () => void;
  onToggleDeafen?: () => void;
  onToggleCamera?: () => void;
  onToggleScreenShare?: () => void;
  // Chat
  chatEnabled: boolean;
  stageTextMessages?: Message[];
  stageTextUsers?: User[];
  onSendStageMessage?: (content: string) => void;
  userPlan?: string | null;
  maxAttachmentMB?: number;
  // Stage chat media settings
  allowEmojis?: boolean;
  allowStickers?: boolean;
  allowGifs?: boolean;
  // E2EE status — drives the shield indicator in the control bar
  isE2ee?: boolean;
  isE2eeFailed?: boolean;
  // Error overlay (from useStageRoom)
  error?: string | null;
  disconnectedByInactivity?: boolean;
  // Per-participant volume (from voiceStore)
  participantVolumes?: Record<string, number>;
  onParticipantVolumeChange?: (userId: string, volume: number) => void;
}

// Helpers

const glassPanel: React.CSSProperties = {
  backgroundColor: 'color-mix(in srgb, var(--bg-app) 92%, transparent)',
  backdropFilter: 'blur(24px) saturate(1.4)',
  WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
  boxShadow: '0 0 0 1px var(--border-subtle) inset, 0 4px 6px -1px rgba(0,0,0,0.12)',
  border: '1px solid var(--glass-border)',
};

const isPro = (plan?: string | null) => plan === 'pro' || plan === 'essential';

// Speaker Audio Tracker (invisible — reports speaking state)

const SpeakerAudioTracker: React.FC<{
  speakerId: string;
  stream: MediaStream | null;
  muted: boolean;
  onSpeakingChange: (speakerId: string, isSpeaking: boolean) => void;
}> = React.memo(({ speakerId, stream, muted, onSpeakingChange }) => {
  const level = useSharedAudioLevel(stream);
  const isSpeaking = !muted && level > 0.06;
  const prevRef = useRef(false);
  useEffect(() => {
    if (prevRef.current !== isSpeaking) {
      prevRef.current = isSpeaking;
      onSpeakingChange(speakerId, isSpeaking);
    }
  }, [isSpeaking, speakerId, onSpeakingChange]);
  return null;
});
SpeakerAudioTracker.displayName = 'SpeakerAudioTracker';

// Join Landing

const JoinLanding: React.FC<{
  channel: Channel;
  session: StageSession;
  canManage: boolean;
  onJoinAudience: () => void;
  onJoinAsSpeaker?: () => void;
  isInvited?: boolean;
  stageFull: boolean;
}> = ({ channel, session, canManage, onJoinAudience, onJoinAsSpeaker, isInvited, stageFull }) => {
  const { t } = useTranslation();
  const totalParticipants = session.speakers.length + session.audienceCount;
  return (
    <div className="flex-1 flex items-center justify-center p-6">
      <div
        className="w-full max-w-md rounded-2xl p-6 flex flex-col items-center gap-5"
        style={glassPanel}
      >
        <span
          className="text-[9px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full animate-pulse"
          style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}
        >
          LIVE
        </span>
        <h2 className="text-lg font-semibold text-center" style={{ color: 'var(--text-primary)' }}>
          {channel.name}
        </h2>
        {session.topic && (
          <p className="text-sm text-center -mt-2" style={{ color: 'var(--text-secondary)' }}>
            {session.topic}
          </p>
        )}
        {/* Speaker avatar preview */}
        {session.speakers.length > 0 && (
          <div className="flex items-center -space-x-2">
            {session.speakers.slice(0, 5).map((s) => (
              <div key={s.userId} className="w-9 h-9 rounded-[var(--radius-lg)] ring-2 ring-[var(--bg-panel)] overflow-hidden">
                <LetterAvatar avatar={s.avatar} username={s.username} size={36} className="rounded-full" />
              </div>
            ))}
            {session.speakers.length > 5 && (
              <div className="w-9 h-9 rounded-full ring-2 ring-[var(--bg-panel)] bg-fill-active flex items-center justify-center">
                <span className="text-[10px] font-semibold" style={{ color: 'var(--text-secondary)' }}>+{session.speakers.length - 5}</span>
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-3 text-[11px]" style={{ color: 'var(--text-secondary)' }}>
          <span><Mic size={12} className="inline mr-1" />{session.speakers.length} speaker{session.speakers.length !== 1 ? 's' : ''}</span>
          <span><Users size={12} className="inline mr-1" />{session.audienceCount} listening</span>
        </div>
        {isInvited && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 10%, transparent)', color: 'var(--cyan-accent)' }}>
            <Mic size={12} /> You{'\u2019'}ve been invited to speak
          </div>
        )}
        <div className="flex flex-col gap-2 w-full">
          {canManage && onJoinAsSpeaker && (
            <button
              type="button"
              onClick={onJoinAsSpeaker}
              disabled={stageFull}
              className="btn-cta w-full px-6 py-2.5 rounded-xl text-sm font-semibold transition-opacity disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('stages.joinAsSpeaker')}
            </button>
          )}
          <button
            type="button"
            onClick={onJoinAudience}
            disabled={stageFull}
            className={`w-full px-6 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${canManage ? '' : 'btn-cta'}`}
            style={canManage ? { backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' } : undefined}
          >
            {stageFull ? t('stages.stageFull') : t('stages.joinAudience')}
          </button>
        </div>
        <p className="text-[10px] text-center" style={{ color: 'var(--text-tertiary)' }}>
          {canManage
            ? t('stages.joinHintManager')
            : t('stages.joinHintAudience')}
        </p>
        <p className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>
          {totalParticipants.toLocaleString()} / {(session.maxTotalParticipants ?? 10000).toLocaleString()} participants
        </p>
      </div>
    </div>
  );
};

// Speaker Card (VoiceChannel-style)

const StageSpeakerCard: React.FC<{
  speaker: StageSpeaker;
  canManage: boolean;
  isCurrentUser: boolean;
  onMoveToAudience?: (userId: string) => void;
  onMaximize?: () => void;
  stream: MediaStream | null;
  cameraStream: MediaStream | null;
  onOpenVolume?: () => void;
}> = React.memo(({ speaker, canManage, isCurrentUser, onMoveToAudience, onMaximize, stream, cameraStream, onOpenVolume }) => {
  const { t } = useTranslation();
  const hasCamera = !!cameraStream;
  const bannerSrc = speaker.banner ? sanitizeImgSrc(speaker.banner) : '';

  return (
    <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card">
      {/* Banner: absolute, fills entire card */}
      <div className="absolute inset-0 rounded-2xl overflow-hidden">
        {bannerSrc ? (
          <LazyGif
            src={bannerSrc}
            frameSrc={getFrameUrl(bannerSrc)}
            alt=""
            className="absolute inset-0 w-full h-full object-cover opacity-95"
            style={{
              objectPosition: `center ${speaker.bannerPositionY ?? 50}%`,
              ...(speaker.bannerZoom && speaker.bannerZoom > 100 ? { transform: `scale(${speaker.bannerZoom / 100})`, transformOrigin: `center ${speaker.bannerPositionY ?? 50}%` } : {}),
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]" />
        )}
        <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)]/70 via-transparent to-transparent pointer-events-none" />
      </div>

      {/* Camera overlay when camera on */}
      {hasCamera && (
        <div className="absolute inset-0 rounded-2xl overflow-hidden z-[5]">
          <RemoteCameraVideo stream={cameraStream} />
        </div>
      )}

      {/* HOST badge */}
      {speaker.isHost && (
        <div className="absolute top-2 right-2 z-10">
          <span
            className="text-[8px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded-lg"
            style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 20%, transparent)', color: 'var(--cyan-accent)' }}
          >
            HOST
          </span>
        </div>
      )}

      {/* Bottom bar */}
      <ParticipantCardFooter
        avatar={speaker.avatar}
        username={speaker.username}
        effectivePlan={speaker.effectivePlan as any}
        avatarEffect={speaker.avatarEffect}
        nameNode={
          <RoleNameStyle
            name={speaker.username}
            overrideColor={speaker.nameColor}
            overrideFont={speaker.nameFont}
            nameEffect={speaker.nameEffect}
          />
        }
        stream={stream}
        isMuted={speaker.isMuted}
        serverMuted={speaker.serverMuted}
        serverDeafened={speaker.serverDeafened}
        connectionState="connected"
        rightActions={
          !isCurrentUser && onOpenVolume ? (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onOpenVolume(); }}
              className="p-1 rounded-lg hover:bg-fill-hover transition-colors"
              style={{ color: 'var(--text-secondary)' }}
              title={t('volume.sliderLabel', 'Volume for {{username}}', { username: speaker.username })}
            >
              <Volume2 size={13} />
            </button>
          ) : undefined
        }
      />

      {/* Maximize hover overlay */}
      {onMaximize && (
        <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5] rounded-2xl" onClick={onMaximize}>
          <div className="w-12 h-12 rounded-full bg-fill-strong backdrop-blur-sm flex items-center justify-center">
            <Maximize2 size={20} className="text-white/90" />
          </div>
        </div>
      )}

      {/* Move to audience (moderator hover) */}
      {canManage && !isCurrentUser && onMoveToAudience && (
        <button
          type="button"
          onClick={() => onMoveToAudience(speaker.userId)}
          className="absolute top-1.5 left-1.5 opacity-0 group-hover/card:opacity-100 text-[9px] font-semibold px-2 py-0.5 rounded-full transition-opacity z-20"
          style={{ backgroundColor: 'var(--danger-muted)', color: 'var(--danger)' }}
        >
          {t('stages.moveToAudience')}
        </button>
      )}
    </div>
  );
});
StageSpeakerCard.displayName = 'StageSpeakerCard';

// Audience Row

const AudienceRow: React.FC<{
  member: StageAudienceMember;
  canManage: boolean;
  onInviteToSpeak?: (userId: string) => void;
}> = ({ member, canManage, onInviteToSpeak }) => {
  const { t } = useTranslation();
  const hasPro = isPro(member.effectivePlan);
  return (
    <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors hover:bg-fill-hover cursor-pointer group">
      <div className={`w-6 h-6 rounded-[var(--radius-lg)] overflow-visible shrink-0 ${hasPro ? getAvatarEffectClass(member.avatarEffect) : ''}`}>
        <LetterAvatar avatar={member.avatar ?? null} username={member.username} size={24} className="rounded-full" />
      </div>
      <RoleNameStyle
        name={member.username}
        overrideColor={member.nameColor}
        overrideFont={member.nameFont}
        nameEffect={member.nameEffect}
        className="text-xs font-medium flex-1 truncate"
      />
      {canManage && onInviteToSpeak && (
        <button
          type="button"
          onClick={() => onInviteToSpeak(member.userId)}
          className="opacity-0 group-hover:opacity-100 text-[9px] font-semibold px-2 py-0.5 rounded-lg transition-opacity"
          style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}
        >
          {t('stages.inviteToSpeak')}
        </button>
      )}
    </div>
  );
};

// Main StageView

export const StageView: React.FC<StageViewProps> = ({
  channel, session, currentUserId, canManage, canRequestToSpeak,
  hasRaisedHand, hasJoined, isSpeaker, onJoinAudience,
  onRaiseHand, onLowerHand, onLeave, onEndStage,
  onSettings, onToggleChat, chatEnabled: _chatEnabled, onInviteToSpeak, onMoveToAudience,
  onJoinAsSpeaker, onMoveSelfToAudience, isInvited,
  localStream, remoteParticipants,
  isMuted, isDeafened, isCameraOn, isScreenSharing,
  screenStream, cameraStream,
  onToggleMute, onToggleDeafen, onToggleCamera, onToggleScreenShare,
  stageTextMessages, stageTextUsers, onSendStageMessage, userPlan, maxAttachmentMB,
  allowEmojis, allowStickers, allowGifs,
  isE2ee = false, isE2eeFailed = false,
  error: stageError, disconnectedByInactivity,
  participantVolumes, onParticipantVolumeChange,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [isLandscape, setIsLandscape] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(orientation: landscape)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia('(orientation: landscape)');
    const onChange = () => setIsLandscape(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  const isLandscapeMobile = isMobile && isLandscape;

  // Error banner dismissal
  const [errorDismissed, setErrorDismissed] = useState(false);
  // Reset dismiss flag when the error changes
  const prevErrorRef = useRef(stageError);
  useEffect(() => {
    if (stageError !== prevErrorRef.current) {
      prevErrorRef.current = stageError;
      setErrorDismissed(false);
    }
  }, [stageError]);

  const showErrorBanner = !errorDismissed && (!!stageError || !!disconnectedByInactivity);

  // Fullscreen + Popout
  const stageContainerRef = useRef<HTMLDivElement>(null);
  const [isFullscreenState, setIsFullscreenState] = useState(false);
  const toggleFullscreen = () => toggleElementFullscreen(stageContainerRef.current);
  useEffect(() => onFullscreenChange(() => setIsFullscreenState(isFullscreenActive())), []);

  const { isPoppedOut, popoutContainerRef, openPopout, closePopout } = usePopoutWindow({
    windowName: 'howl-stage-popout',
    title: `Stage | ${channel.name}`,
    containerId: 'stage-popout-root',
  });

  // Per-participant volume popup
  const [volumeOpenUserId, setVolumeOpenUserId] = useState<string | null>(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [confirmEndStage, setConfirmEndStage] = useState(false);
  const [confirmLeaveStage, setConfirmLeaveStage] = useState(false);
  const [chatWidth, setChatWidth] = useState(loadChatWidth);
  const chatDragRef = useRef<{ startX: number; startW: number } | null>(null);

  const startChatResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    chatDragRef.current = { startX: e.clientX, startW: chatWidth };
    const onMove = (ev: MouseEvent) => {
      if (!chatDragRef.current) return;
      const delta = chatDragRef.current.startX - ev.clientX;
      const newW = Math.max(STAGE_CHAT_MIN_WIDTH, Math.min(STAGE_CHAT_MAX_WIDTH, chatDragRef.current.startW + delta));
      setChatWidth(newW);
    };
    const onUp = () => { chatDragRef.current = null; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [chatWidth]);

  useEffect(() => {
    try { localStorage.setItem(STAGE_CHAT_WIDTH_KEY, String(chatWidth)); } catch { /* localStorage unavailable */ }
  }, [chatWidth]);

  const handRaiseFull = session.handRaises.length >= (session.maxHandRaises ?? 100);
  const totalParticipants = session.speakers.length + session.audienceCount;
  const stageFull = totalParticipants >= (session.maxTotalParticipants ?? 10000);

  // Card resize (drag handles on speaker tiles)
  const { getCardSize, startResize } = useCardResize({
    participantCount: session.speakers.length,
    isMobile,
  });

  const handleToggleChat = () => {
    setChatOpen((v) => !v);
    onToggleChat?.();
  };

  // Helper: get stream data for a speaker from LiveKit remote participants
  const getSpeakerStreams = useCallback((speakerUserId: string) => {
    if (speakerUserId === currentUserId) {
      return {
        stream: localStream ?? null,
        cameraStream: (isSpeaker && isCameraOn ? cameraStream : null) ?? null,
        screenStream: (isSpeaker && isScreenSharing ? screenStream : null) ?? null,
        screenShareAudioStream: null as MediaStream | null,
      };
    }
    const remote = remoteParticipants?.find((r) => r.userId === speakerUserId);
    return {
      stream: remote?.stream ?? null,
      cameraStream: remote?.cameraStream ?? null,
      screenStream: remote?.screenStream ?? null,
      screenShareAudioStream: remote?.screenShareAudioStream ?? null,
    };
  }, [currentUserId, localStream, isSpeaker, isCameraOn, cameraStream, isScreenSharing, screenStream, remoteParticipants]);

  // Speaker ordering by audio level
  const speakingStatesRef = useRef<Map<string, { speaking: boolean; lastSpoke: number }>>(new Map());
  const [speakerOrder, setSpeakerOrder] = useState<string[]>([]);
  const [focusedSpeakerUserId, setFocusedSpeakerUserId] = useState<string | null>(null);
  const [focusedScreenKey, setFocusedScreenKey] = useState<string | null>(null);

  // Auto-clear focused speaker when they leave
  useEffect(() => {
    if (focusedSpeakerUserId && !session.speakers.some(s => s.userId === focusedSpeakerUserId)) {
      setFocusedSpeakerUserId(null);
    }
  }, [focusedSpeakerUserId, session.speakers]);

  // Auto-clear focused screen when screen sharing stops
  useEffect(() => {
    if (!focusedScreenKey) return;
    const uid = focusedScreenKey.replace('screen-', '');
    const streams = getSpeakerStreams(uid);
    if (!streams.screenStream) setFocusedScreenKey(null);
  }, [focusedScreenKey, getSpeakerStreams]);

  const onSpeakingChange = useCallback((speakerId: string, isSpeaking: boolean) => {
    const states = speakingStatesRef.current;
    const state = states.get(speakerId) ?? { speaking: false, lastSpoke: 0 };
    state.speaking = isSpeaking;
    if (isSpeaking) state.lastSpoke = Date.now();
    states.set(speakerId, state);
    setSpeakerOrder(
      [...session.speakers]
        .sort((a, b) => {
          const sa = states.get(a.userId);
          const sb = states.get(b.userId);
          if (sa?.speaking && !sb?.speaking) return -1;
          if (!sa?.speaking && sb?.speaking) return 1;
          return (sb?.lastSpoke ?? 0) - (sa?.lastSpoke ?? 0);
        })
        .map(s => s.userId),
    );
  }, [session.speakers]);

  const sortedSpeakers = useMemo(() => {
    if (speakerOrder.length === 0) return session.speakers;
    const orderMap = new Map(speakerOrder.map((id, i) => [id, i]));
    return [...session.speakers].sort((a, b) => (orderMap.get(a.userId) ?? 999) - (orderMap.get(b.userId) ?? 999));
  }, [session.speakers, speakerOrder]);

  // Join Landing
  if (!hasJoined) {
    return (
      <div className="flex h-full" style={glassPanel}>
        <JoinLanding channel={channel} session={session} canManage={canManage} onJoinAudience={onJoinAudience} onJoinAsSpeaker={onJoinAsSpeaker} isInvited={isInvited} stageFull={stageFull} />
      </div>
    );
  }

  // Active Stage
  // On landscape mobile the chat floats as a drawer so the video grid keeps
  // its full height; portrait mobile stacks it below as a 50/50 split.
  const chatVisible = chatOpen && session.textChatEnabled;

  // Popout portal: render stage content into the detached window when popped out
  const stageContent = (
    <div ref={stageContainerRef} className={`flex h-full relative ${isMobile && !isLandscapeMobile ? 'flex-col' : ''}`}>
      {/* Main stage area */}
      <div className={`${isMobile && chatVisible && !isLandscapeMobile ? 'flex-[1_1_50%]' : 'flex-1'} flex flex-col min-w-0 rounded-xl overflow-hidden`} style={glassPanel}>
        {/* ── 1. Header ──────────────────────────────────────────────────── */}
        <div className="shrink-0 px-4 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--glass-border)' }}>
          <span
            className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full animate-pulse"
            style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}
          >
            LIVE
          </span>
          <h2 className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
            {channel.name}
          </h2>
          {session.topic && (
            <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{session.topic}</span>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <span className="text-[10px] font-medium" style={{ color: 'var(--text-secondary)' }}>
              {totalParticipants} participant{totalParticipants !== 1 ? 's' : ''}
            </span>
            {canManage && onSettings && (
              <button type="button" onClick={onSettings} className="p-1.5 rounded-lg hover:bg-fill-active" style={{ color: 'var(--text-secondary)' }}>
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>

        {/* ── Error banner (10.1) ───────────────────────────────────────── */}
        {showErrorBanner && (
          <div className="shrink-0 mx-4 mt-3 flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-medium" style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}>
            <span className="flex-1 truncate">
              {disconnectedByInactivity
                ? t('voiceCall.disconnectedInactivity', 'Disconnected due to inactivity')
                : stageError}
            </span>
            <button type="button" onClick={() => setErrorDismissed(true)} className="p-0.5 rounded-lg hover:bg-[var(--danger-muted)] transition-colors shrink-0" aria-label={t('common.dismiss')}>
              <X size={14} />
            </button>
          </div>
        )}

        {/* Invisible audio trackers for speaker ordering */}
        {session.speakers.map((speaker) => {
          const streams = getSpeakerStreams(speaker.userId);
          return (
            <SpeakerAudioTracker
              key={`tracker-${speaker.userId}`}
              speakerId={speaker.userId}
              stream={streams.stream}
              muted={speaker.isMuted}
              onSpeakingChange={onSpeakingChange}
            />
          );
        })}

        {/* ── 2. Content: speakers + audience (50/50 split) ──────────────── */}
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Speakers area */}
          <div
            className="overflow-y-auto px-4 py-3"
            style={{ flex: '1 1 50%', maxHeight: '66%', minHeight: '120px' }}
          >
            <h4 className="text-[9px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>
              {t('stages.speakers')} · {session.speakers.length}
            </h4>
            {(() => {
              const screenShareCount = sortedSpeakers.filter(s => { const st = getSpeakerStreams(s.userId); return !!st.screenStream; }).length;
              const totalGridItems = sortedSpeakers.length + screenShareCount;
              const gridColumns = isMobile
                ? (totalGridItems === 1 ? '1fr' : 'repeat(2, 1fr)')
                : totalGridItems === 1 ? '1fr'
                  : totalGridItems === 2 ? 'repeat(2, 1fr)'
                  : totalGridItems <= 4 ? 'repeat(2, 1fr)'
                  : totalGridItems <= 6 ? 'repeat(3, 1fr)'
                  : 'repeat(auto-fit, minmax(280px, 1fr))';
              return (
                <div className="grid gap-3 w-full" style={{ gridTemplateColumns: gridColumns, justifyItems: totalGridItems <= 2 ? 'center' : undefined }}>
                  {sortedSpeakers.map((speaker) => {
                    const streams = getSpeakerStreams(speaker.userId);
                    const cardSize = getCardSize(speaker.userId);
                    const isCurrentUser = speaker.userId === currentUserId;
                    return (
                      <React.Fragment key={speaker.userId}>
                        <div
                          data-card-resize-wrapper
                          className="relative rounded-2xl overflow-visible"
                          style={{
                            width: isMobile ? undefined : `${cardSize.w}px`,
                            height: `${cardSize.h}px`,
                            minHeight: '120px',
                            margin: totalGridItems <= 2 ? '0 auto' : undefined,
                          }}
                        >
                          <div className="w-full h-full rounded-2xl overflow-hidden relative">
                            <StageSpeakerCard
                              speaker={speaker}
                              canManage={canManage}
                              isCurrentUser={isCurrentUser}
                              onMoveToAudience={onMoveToAudience}
                              onMaximize={() => setFocusedSpeakerUserId(speaker.userId)}
                              stream={streams.stream}
                              cameraStream={streams.cameraStream}
                              onOpenVolume={!isCurrentUser && onParticipantVolumeChange ? () => setVolumeOpenUserId(speaker.userId) : undefined}
                            />
                          </div>
                          {/* VolumePopup rendered outside card overflow-hidden */}
                          {onParticipantVolumeChange && volumeOpenUserId === speaker.userId && (
                            <div className="absolute bottom-12 right-2 z-40">
                              <VolumePopup
                                userId={speaker.userId}
                                username={speaker.username}
                                volume={participantVolumes?.[speaker.userId] ?? 0.5}
                                onChange={onParticipantVolumeChange}
                                onClose={() => setVolumeOpenUserId(null)}
                              />
                            </div>
                          )}
                          {/* Drag-to-resize handle (11.1) */}
                          {!isMobile && (
                            <div
                              role="button"
                              tabIndex={-1}
                              aria-label="Resize card"
                              onMouseDown={(e) => startResize(speaker.userId, e)}
                              className="absolute bottom-0 right-0 w-4 h-4 cursor-se-resize opacity-0 group-hover/card:opacity-70 transition-opacity z-20"
                              style={{ background: 'linear-gradient(135deg, transparent 50%, var(--text-tertiary) 50%)' }}
                            />
                          )}
                        </div>
                        {streams.screenStream && (
                          <div
                            className="relative rounded-2xl overflow-hidden border border-[var(--glass-border)] group/card"
                            style={{
                              width: isMobile ? undefined : `${cardSize.w}px`,
                              height: `${cardSize.h}px`,
                              minHeight: '120px',
                              margin: totalGridItems <= 2 ? '0 auto' : undefined,
                            }}
                          >
                            <ScreenShareCard
                              stream={streams.screenStream}
                              screenShareAudioStream={streams.screenShareAudioStream}
                              userId={speaker.userId}
                              username={speaker.username}
                              isDeafened={isDeafened}
                              streamContext={{ kind: 'stage', scopeId: channel.id }}
                              selfUserId={currentUserId}
                            />
                            <div className="absolute bottom-0 left-0 right-0 px-3 py-2.5 flex items-center justify-between gap-2 bg-[var(--glass-bg)] backdrop-blur-sm z-10 min-h-[48px] md:min-h-[60px]">
                              <div className="flex items-center gap-2 min-w-0">
                                <div className="w-6 h-6 rounded-lg bg-[var(--success)] flex items-center justify-center shrink-0">
                                  <Monitor size={13} className="text-black" />
                                </div>
                                <span className="text-xs text-[var(--text-primary)] font-bold truncate">{speaker.username}{'\u2019'}s screen</span>
                                <div className="w-1.5 h-1.5 bg-[var(--success)] rounded-full animate-pulse shrink-0" />
                              </div>
                            </div>
                            {/* Maximize hover overlay */}
                            <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5] rounded-2xl" onClick={() => setFocusedScreenKey(`screen-${speaker.userId}`)}>
                              <div className="w-12 h-12 rounded-full bg-fill-strong backdrop-blur-sm flex items-center justify-center">
                                <Maximize2 size={20} className="text-white/90" />
                              </div>
                            </div>
                          </div>
                        )}
                      </React.Fragment>
                    );
                  })}
                </div>
              );
            })()}
          </div>

          {/* Divider */}
          <div className="shrink-0 h-px mx-4" style={{ backgroundColor: 'var(--glass-border)' }} />

          {/* Audience area */}
          <div
            className="overflow-y-auto px-4 py-3"
            style={{ flex: '1 1 50%', minHeight: '80px' }}
          >
            <h4 className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('stages.audience')} · {session.audienceCount}
            </h4>
            <div className="flex flex-col gap-0.5">
              {(session.audienceMembers ?? []).map((member) => (
                <AudienceRow key={member.userId} member={member} canManage={canManage} onInviteToSpeak={onInviteToSpeak} />
              ))}
              {session.audienceCount > (session.audienceMembers?.length ?? 0) && (
                <p className="text-[10px] text-center py-2" style={{ color: 'var(--text-secondary)' }}>
                  +{session.audienceCount - (session.audienceMembers?.length ?? 0)} more
                </p>
              )}
            </div>

            {/* Hand raise queue (inside audience area) */}
            {session.handRaises.length > 0 && canManage && (
              <div
                className="mt-3 p-2.5 rounded-xl"
                style={{ backgroundColor: 'color-mix(in srgb, var(--warning) 6%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 12%, transparent)' }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Hand size={14} style={{ color: 'var(--warning)' }} />
                  <span className="text-[11px] font-semibold" style={{ color: 'var(--warning)' }}>
                    {session.handRaises.length} hand{session.handRaises.length !== 1 ? 's' : ''} raised
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {session.handRaises.map((hand) => (
                    <div key={hand.userId} className="flex items-center gap-2 px-2 py-1 rounded-lg" style={{ backgroundColor: 'var(--fill-hover)' }}>
                      <LetterAvatar avatar={hand.avatar ?? null} username={hand.username} size={20} className="rounded-full" />
                      <span className="text-xs font-medium flex-1" style={{ color: 'var(--text-primary)' }}>{hand.username}</span>
                      {onInviteToSpeak && (
                        <button
                          type="button"
                          onClick={() => onInviteToSpeak(hand.userId)}
                          className="text-[9px] font-semibold px-2 py-0.5 rounded-lg"
                          style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}
                        >
                          {t('common.accept')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onLowerHand(hand.userId)}
                        className="text-[9px] font-semibold px-2 py-0.5 rounded-lg"
                        style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}
                      >
                        {t('common.dismiss')}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* ── 5. Bottom controls (CallControlBar + Stage-specific) ──────── */}
        <div
          className="shrink-0 px-4 py-3 border-t flex items-center justify-center gap-2 flex-wrap"
          style={{
            borderColor: 'var(--border-subtle)',
            backgroundColor: 'var(--fill-hover)',
            paddingBottom: isMobile ? 'max(env(safe-area-inset-bottom, 0px), 12px)' : undefined,
          }}
        >
          {stageFull && (
            <span className="text-xs font-medium px-3 py-1.5 rounded-full" style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}>
              {t('stages.stageFull')}
            </span>
          )}

          {/* Stage-specific leading controls */}
          <div className="flex items-center gap-2 flex-wrap justify-center">
            {/* E2EE indicator */}
            {hasJoined && isE2ee && (
              <span className="flex items-center gap-1 px-2 py-1 text-emerald-400" title={t('voiceCall.e2eeActive', 'End-to-end encrypted')}>
                <ShieldCheck size={14} />
              </span>
            )}
            {hasJoined && isE2eeFailed && (
              <span className="flex items-center gap-1 px-2 py-1 text-amber-400" title={t('voiceCall.e2eeFailed', 'Not end-to-end encrypted. Key exchange failed')}>
                <ShieldAlert size={14} />
              </span>
            )}

            {/* Audience: raise/lower hand */}
            {!isSpeaker && canRequestToSpeak && (
              <button
                type="button"
                onClick={hasRaisedHand ? () => onLowerHand() : onRaiseHand}
                disabled={!hasRaisedHand && handRaiseFull}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{
                  backgroundColor: hasRaisedHand ? 'color-mix(in srgb, var(--warning) 20%, transparent)' : 'color-mix(in srgb, var(--warning) 12%, transparent)',
                  color: 'var(--warning)',
                }}
                title={!hasRaisedHand && handRaiseFull ? t('stages.handRaiseQueueFull') : undefined}
              >
                <Hand size={14} />
                {hasRaisedHand ? t('stages.lowerHand') : t('stages.raiseHand')}
              </button>
            )}

            {/* Host toggle: speaker <-> audience */}
            {canManage && isSpeaker && onMoveSelfToAudience && (
              <button
                type="button"
                onClick={onMoveSelfToAudience}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}
              >
                <Users size={14} /> {t('stages.moveToAudience')}
              </button>
            )}
            {canManage && !isSpeaker && onJoinAsSpeaker && (
              <button
                type="button"
                onClick={onJoinAsSpeaker}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 12%, transparent)', color: 'var(--cyan-accent)' }}
              >
                <Mic size={14} /> {t('stages.joinSpeakers')}
              </button>
            )}
          </div>

          {/* Shared CallControlBar (11.3): only speakers get mute/camera/screen */}
          {isSpeaker && onToggleMute && onToggleCamera && onToggleScreenShare && (
            <CallControlBar
              isMuted={!!isMuted}
              isDeafened={!!isDeafened}
              isCameraOn={!!isCameraOn}
              isScreenSharing={!!isScreenSharing}
              isFullscreen={isFullscreenState}
              isPoppedOut={isPoppedOut}
              isMobile={isMobile}
              onToggleMute={onToggleMute}
              onToggleDeafen={onToggleDeafen}
              onToggleCamera={onToggleCamera}
              onToggleScreenShare={onToggleScreenShare}
              onToggleFullscreen={!isMobile ? toggleFullscreen : undefined}
              onOpenPopout={!isMobile && !isPoppedOut ? openPopout : undefined}
              onClosePopout={isPoppedOut ? closePopout : undefined}
              onLeave={() => setConfirmLeaveStage(true)}
              leaveLabel={t('stages.leaveStage')}
            />
          )}

          {/* Audience-only deafen + leave */}
          {!isSpeaker && (
            <div className="flex items-center gap-2">
              {onToggleDeafen && (
                <button
                  type="button"
                  onClick={onToggleDeafen}
                  className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                  style={{ backgroundColor: 'var(--fill-hover)', color: isDeafened ? 'var(--danger)' : 'var(--text-secondary)' }}
                >
                  <LogOut size={14} />
                </button>
              )}
              <button
                type="button"
                onClick={() => setConfirmLeaveStage(true)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}
              >
                <LogOut size={14} /> {t('stages.leaveStage')}
              </button>
            </div>
          )}

          {/* Stage-specific trailing controls */}
          <div className="flex items-center gap-2 flex-wrap justify-center">
            {/* Chat toggle */}
            {session.textChatEnabled && (
              <button
                type="button"
                onClick={handleToggleChat}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{
                  backgroundColor: chatOpen ? 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)' : 'var(--fill-hover)',
                  color: chatOpen ? 'var(--cyan-accent)' : 'var(--text-secondary)',
                }}
              >
                <MessageSquare size={14} /> {t('stages.stageChat')}
              </button>
            )}

            {/* End stage */}
            {canManage && onEndStage && (
              <button
                type="button"
                onClick={() => setConfirmEndStage(true)}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{ backgroundColor: 'var(--danger-subtle)', color: 'var(--danger)' }}
              >
                <Radio size={14} /> {t('stages.endStage')}
              </button>
            )}

            {/* Settings (canManage) */}
            {canManage && onSettings && (
              <button
                type="button"
                onClick={onSettings}
                className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold transition-all hover:ring-1 hover:ring-[var(--glass-border)] active:scale-[0.97] ${isMobile ? 'min-h-[44px]' : ''}`}
                style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}
              >
                <Settings size={14} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── Chat panel (side on desktop, bottom on portrait mobile, drawer on landscape mobile) ── */}
      {chatOpen && session.textChatEnabled && (
        <div
          className={`${
            isLandscapeMobile
              ? 'absolute top-0 right-0 bottom-0 w-[70%] max-w-[360px] z-40 animate-in slide-in-from-right duration-200'
              : isMobile
                ? 'flex-[1_1_50%] min-h-0 mt-1'
                : 'shrink-0 ml-2'
          } rounded-xl flex flex-col overflow-hidden relative`}
          style={{
            ...(isMobile ? {} : { width: chatWidth }),
            backgroundColor: 'color-mix(in srgb, var(--bg-app) 94%, transparent)',
            backdropFilter: 'blur(24px) saturate(1.4)',
            WebkitBackdropFilter: 'blur(24px) saturate(1.4)',
            boxShadow: '0 0 0 1px var(--border-subtle) inset',
            border: '1px solid var(--glass-border)',
          }}
        >
          {/* Left-edge resize handle (desktop only) */}
          {!isMobile && (
            <div
              onMouseDown={startChatResize}
              className="absolute top-0 left-0 bottom-0 w-1.5 flex items-center justify-center cursor-col-resize hover:bg-[var(--cyan-accent)]/30 transition-colors z-10"
            />
          )}
          <div className="flex items-center justify-between px-3 py-2.5 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{t('stages.stageChat')}</span>
            <button type="button" onClick={() => setChatOpen(false)} className={`rounded-md hover:bg-fill-hover ${isMobile ? 'p-2 min-h-[44px] min-w-[44px] flex items-center justify-center' : 'p-1'}`} style={{ color: 'var(--text-secondary)' }}>
              <X size={14} />
            </button>
          </div>
          <StageTextChat
            channel={channel}
            messages={stageTextMessages ?? []}
            users={stageTextUsers ?? []}
            currentUserId={currentUserId}
            onSendMessage={onSendStageMessage ?? (() => {})}
            maxAttachmentMB={maxAttachmentMB ?? 10}
            userPlan={userPlan}
            allowEmojis={allowEmojis}
            allowStickers={allowStickers}
            allowGifs={allowGifs}
          />
        </div>
      )}

      {/* End Stage confirmation */}
      {confirmEndStage && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl p-6 max-w-sm w-full mx-4" style={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--glass-border)' }}>
            <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('stages.endStageConfirm')}</h3>
            <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>{t('stages.endStageDesc')}</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmEndStage(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
              <button type="button" onClick={() => { setConfirmEndStage(false); onEndStage?.(); }} className="btn-cta-danger flex-1 py-2.5 rounded-xl text-sm font-semibold">{t('stages.endStage')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Leave Stage confirmation */}
      {confirmLeaveStage && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center" style={{ backgroundColor: 'var(--overlay-backdrop)', backdropFilter: 'blur(4px)' }}>
          <div className="rounded-2xl p-6 max-w-sm w-full mx-4" style={{ backgroundColor: 'var(--bg-panel)', border: '1px solid var(--glass-border)' }}>
            <h3 className="text-base font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>{t('stages.leaveStageConfirm')}</h3>
            <p className="text-sm mb-5" style={{ color: 'var(--text-secondary)' }}>{isSpeaker ? t('stages.leaveSpeakerDesc') : t('stages.leaveAudienceDesc')}</p>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmLeaveStage(false)} className="flex-1 py-2.5 rounded-xl text-sm font-semibold" style={{ backgroundColor: 'var(--fill-hover)', color: 'var(--text-secondary)' }}>{t('common.cancel')}</button>
              <button type="button" onClick={() => { setConfirmLeaveStage(false); onLeave(); }} className="btn-cta-danger flex-1 py-2.5 rounded-xl text-sm font-semibold">{t('common.leave')}</button>
            </div>
          </div>
        </div>
      )}

      {/* Focused speaker overlay */}
      {focusedSpeakerUserId && (() => {
        const speaker = session.speakers.find(s => s.userId === focusedSpeakerUserId);
        if (!speaker) return null;
        const streams = getSpeakerStreams(speaker.userId);
        const focusedStream = streams.cameraStream ?? null;
        return (
          <div className="absolute inset-0 z-[195] flex flex-col bg-[var(--bg-app)]/95 backdrop-blur-xl animate-in fade-in duration-200">
            <button type="button" onClick={() => setFocusedSpeakerUserId(null)} className="absolute top-4 right-4 z-50 p-2.5 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white transition-all backdrop-blur-sm" aria-label={t('common.close')}>
              <X size={20} />
            </button>
            <div className="flex-1 min-h-0 rounded-xl overflow-hidden relative bg-[var(--bg-panel)] border border-[var(--cyan-accent)]/20 m-3">
              {focusedStream ? (
                <RemoteCameraVideo stream={focusedStream} className="w-full h-full object-cover" />
              ) : (
                <div className="absolute inset-0">
                  <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                    {speaker.banner ? (
                      <LazyGif src={sanitizeImgSrc(speaker.banner)} frameSrc={getFrameUrl(speaker.banner)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${speaker.bannerPositionY ?? 50}%`, ...(speaker.bannerZoom && speaker.bannerZoom > 100 ? { transform: `scale(${speaker.bannerZoom / 100})`, transformOrigin: `center ${speaker.bannerPositionY ?? 50}%` } : {}) }} />
                    ) : null}
                  </div>
                  <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)]/70 via-transparent to-transparent pointer-events-none" />
                  <div className="absolute inset-0 flex items-center justify-center">
                    <LetterAvatar avatar={speaker.avatar} username={speaker.username} size={96} className="rounded-full" />
                  </div>
                </div>
              )}
              <div className="absolute bottom-0 left-0 right-0 px-4 py-3 flex items-center gap-3 bg-[var(--glass-bg)] backdrop-blur-sm z-10">
                <LetterAvatar avatar={speaker.avatar} username={speaker.username} size={28} className="rounded-full shrink-0" />
                <span className="font-bold text-sm text-[var(--text-primary)] truncate">{speaker.username}</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Focused screen share overlay */}
      {focusedScreenKey && (() => {
        const uid = focusedScreenKey.replace('screen-', '');
        const streams = getSpeakerStreams(uid);
        if (!streams.screenStream) return null;
        const speaker = session.speakers.find(s => s.userId === uid);
        return (
          <FocusedScreenOverlay
            focusedScreenKey={focusedScreenKey}
            screenStream={null}
            remoteParticipants={[{ userId: uid, username: speaker?.username, screenStream: streams.screenStream, screenShareAudioStream: streams.screenShareAudioStream }]}
            onClose={() => setFocusedScreenKey(null)}
            isMobile={isMobile}
            isDeafened={isDeafened}
            streamContext={{ kind: 'stage', scopeId: channel.id }}
            selfUserId={currentUserId}
          />
        );
      })()}
    </div>
  );

  // Popout portal: when popped out, render into the detached window
  if (isPoppedOut && popoutContainerRef.current) {
    return createPortal(stageContent, popoutContainerRef.current);
  }

  return stageContent;
};
