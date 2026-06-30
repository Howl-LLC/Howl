// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Channel, User } from '../types';
import type { Server } from '../types';
import type { VoiceParticipant as BaseVoiceParticipant } from '../hooks/useVoiceChannel';
import { RoleNameStyle } from './RoleNameStyle';
import { Monitor, MonitorUp, X, ChevronDown, ChevronUp, Volume2, Maximize2, ExternalLink, Settings, ShieldCheck, ShieldAlert } from 'lucide-react';
import { useIsMobile } from '../hooks/useIsMobile';
import { longPressBindings } from '../hooks/useLongPress';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { useTranslation } from 'react-i18next';
import VolumePopup from './VolumePopup';
import { requestAppFullscreen, onAppFullscreenChange } from '../utils/fullscreen';
import { LetterAvatar } from './LetterAvatar';
import type { UserWithRole } from './UserProfilePopup';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { usePopoutWindow } from '../hooks/usePopoutWindow';
import { useCardResize } from '../hooks/useCardResize';
import { loadVoiceState, saveVoiceState } from '../utils/voiceStateStorage';
import { ParticipantCardFooter } from './call/ParticipantCardFooter';
import { ScreenShareCard } from './call/ScreenShareCard';
import { ViewerIndicator } from './call/ViewerIndicator';
import { ViewerAvatarStack } from './call/ViewerAvatarStack';
import { ScreenShareVolumeControls } from './call/ScreenShareVolumeControls';
import { RemoteCameraVideo } from './call/RemoteCameraVideo';
import { FocusedScreenOverlay } from './call/FocusedScreenOverlay';
import { CallControlBar } from './call/CallControlBar';
import { ImmersiveCallSurface } from './call/ImmersiveCallSurface';
import { useSettings } from '../contexts/SettingsContext';
import { useVoiceStore } from '../stores/voiceStore';
import { useMicSilenceDetection } from '../hooks/useMicSilenceDetection';
import { useRemoteSpokeRecently } from '../hooks/useRemoteSpokeRecently';
import { MicSilenceBanner } from './call/MicSilenceBanner';

/** Build UserWithRole for context menu from voice participant + socket list entry */
function toUserWithRole(
  userId: string,
  remote: { username?: string; avatar?: string; banner?: string } | null,
  socketP: { userId: string; username?: string; nickname?: string; avatar?: string; discriminator?: string; banner?: string; bannerPositionY?: number; bannerZoom?: number; roleColor?: string; roleStyle?: string; role?: string; nameColor?: string; nameFont?: string; nameEffect?: string; avatarEffect?: string; effectivePlan?: string } | null
): UserWithRole {
  return {
    id: userId,
    username: remote?.username ?? socketP?.username ?? 'Unknown',
    discriminator: socketP?.discriminator,
    avatar: remote?.avatar ?? socketP?.avatar ?? null,
    banner: (remote as { banner?: string })?.banner ?? socketP?.banner,
    status: 'online',
    role: socketP?.role,
    roleColor: (remote as { roleColor?: string })?.roleColor ?? socketP?.roleColor,
    roleStyle: ((remote as { roleStyle?: string })?.roleStyle ?? socketP?.roleStyle) as import('./RoleNameStyle').RoleStyle | undefined,
  };
}

/** useVoiceChannel participant — BaseVoiceParticipant (CallParticipant) now includes pro/role fields */
type VoiceParticipant = BaseVoiceParticipant;

/** Only show video UI when we have at least one live, unmuted, enabled video track (camera on). Disabled/muted = show banner. */
function _hasLiveVideo(stream: MediaStream | null | undefined): boolean {
  if (!stream) return false;
  const tracks = stream.getVideoTracks();
  return tracks.length > 0 && tracks.some((t) => t.readyState === 'live' && !t.muted && t.enabled);
}

/** Treat as connected when we have a stream with tracks (audio/video) or connectionState is connected (avoids stuck "Connecting…") */
function isParticipantConnected(p: { connectionState?: string; stream?: MediaStream | null }): boolean {
  if (p.connectionState === 'connected') return true;
  if (!p.stream) return false;
  const tracks = p.stream.getTracks();
  return tracks.length > 0;
}

// SpeakingHighlight imported from shared module


interface VoiceChannelProps {
  channel: Channel;
  currentUser: User;
  participants?: VoiceParticipant[];
  onTerminate?: () => void;
  isMuted: boolean;
  isDeafened: boolean;
  isScreenSharing: boolean;
  isCameraOn: boolean;
  screenStream: MediaStream | null;
  cameraStream: MediaStream | null;
  onToggleMute?: () => void;
  /** Local mic stream (for audio level meter) */
  localStream?: MediaStream | null;
  remoteParticipants?: VoiceParticipant[];
  voiceError?: string | null;
  /** Per-participant volume (userId -> 0..1) */
  participantVolumes?: Record<string, number>;
  onParticipantVolumeChange?: (userId: string, volume: number) => void;
  /** All servers the user is in, for the channel-switcher dropdown */
  servers?: Server[];
  /** Called when user picks a different voice channel from the dropdown */
  onSwitchVoiceChannel?: (channelId: string) => void;
  /** When provided, right-clicking a participant's name opens the same user context menu as elsewhere. */
  onParticipantRightClick?: (user: UserWithRole, e: React.MouseEvent) => void;
  /** Enable a remote user's screen track (opt-in to watch). */
  enableRemoteScreen?: (userId: string) => void;
  /** Disable a remote user's screen track (stop watching, save resources). */
  disableRemoteScreen?: (userId: string) => void;
  /** Show stream preview thumbnails in the participant list. */
  showStreamPreviews?: boolean;
  /** Show advanced stream quality picker when sharing screen. */
  showAdvancedStream?: boolean;
  onToggleDeafen?: () => void;
  onToggleScreenShare?: () => void;
  onToggleCamera?: () => void;
  onOpenScreenShareSettings?: () => void;
  /** Whether the ScreenSharePicker modal is open (for fullscreen portal) */
  screenSharePickerOpen?: boolean;
  /** Render function for the ScreenSharePicker (portaled inside fullscreen container) */
  renderScreenSharePicker?: () => React.ReactNode;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  onOpenChannelSettings?: (channelId: string) => void;
  /** Green shield: SFrame E2EE key active for this voice session. */
  isE2ee?: boolean;
  /** Amber shield: E2EE expected but the session key could not be obtained. */
  isE2eeFailed?: boolean;
}

export const VoiceChannel: React.FC<VoiceChannelProps> = ({ 
  channel, 
  currentUser, 
  participants = [], 
  onTerminate, 
  isMuted, 
  isDeafened,
  isScreenSharing,
  isCameraOn,
  screenStream,
  cameraStream,
  onToggleMute,
  localStream = null,
  remoteParticipants = [],
  voiceError: _voiceError,
  participantVolumes = {},
  onParticipantVolumeChange,
  servers: _servers = [],
  onSwitchVoiceChannel: _onSwitchVoiceChannel,
  onParticipantRightClick,
  enableRemoteScreen,
  disableRemoteScreen,
  showStreamPreviews = true,
  showAdvancedStream: _showAdvancedStream = false,
  onToggleDeafen,
  onToggleScreenShare,
  onToggleCamera,
  onOpenScreenShareSettings,
  screenSharePickerOpen,
  renderScreenSharePicker,
  serverMuted = false,
  serverDeafened = false,
  onOpenChannelSettings: _onOpenChannelSettings,
  isE2ee = false,
  isE2eeFailed = false,
}) => {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const { voiceSettings } = useSettings();

  // Mic silence detection — purely informational UI indicators
  const voiceSilenceMs = useVoiceStore(s => s.voiceSilenceMs);
  const remoteSpokeRecently = useRemoteSpokeRecently(remoteParticipants);
  // Track when the local mic stream first appeared for the grace period
  const micPublishedAtRef = useRef<number | null>(null);
  if (localStream && !micPublishedAtRef.current) micPublishedAtRef.current = Date.now();
  if (!localStream) micPublishedAtRef.current = null;
  const micSilence = useMicSilenceDetection({
    silenceMs: voiceSilenceMs,
    isMuted,
    isDeafened,
    remoteParticipantCount: remoteParticipants.length,
    remoteSpokeRecently,
    enabled: voiceSettings.notifyOnNoMicAudio ?? true,
    micPublishedAt: micPublishedAtRef.current,
  });

  // Silence Howl's participant-audio playback while the local user is sharing
  // with system audio, so the share doesn't capture and re-transmit others'
  // voices back to viewers. Gated by the voice setting (default on).
  const audioDeafened = isDeafened || (
    voiceSettings.muteHowlAudioWhileSharing !== false &&
    !!screenStream &&
    screenStream.getAudioTracks().some((t) => t.readyState === 'live')
  );
  // Set of participant IDs currently being watched — users can watch multiple
  // simultaneous screen shares (Discord-parity).
  const [watchingScreenShareUserId, setWatchingScreenShareUserId] = useState<Set<string>>(() => new Set());
  const startWatching = useCallback((id: string) => {
    setWatchingScreenShareUserId((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev); next.add(id); return next;
    });
  }, []);
  const stopWatching = useCallback((id: string) => {
    setWatchingScreenShareUserId((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev); next.delete(id); return next;
    });
  }, []);
  const [showSelfScreenPreview, setShowSelfScreenPreview] = useState(() => loadVoiceState().showSelfScreenPreview);
  const [focusedScreenKey, setFocusedScreenKey] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [controlBarHidden, setControlBarHidden] = useState(false);
  const [showMobileScreenShareHint, setShowMobileScreenShareHint] = useState(false);
  const voiceContainerRef = useRef<HTMLDivElement>(null);

  // Auto-dismiss the mobile screen-share "desktop only" hint after a few seconds.
  useEffect(() => {
    if (!showMobileScreenShareHint) return;
    const tid = setTimeout(() => setShowMobileScreenShareHint(false), 3500);
    return () => clearTimeout(tid);
  }, [showMobileScreenShareHint]);

  // Auto-close focused screen overlay when stream disappears
  useEffect(() => {
    if (!focusedScreenKey) return;
    if (focusedScreenKey === 'self-screen') {
      if (!screenStream) setFocusedScreenKey(null);
    } else {
      const uid = focusedScreenKey.replace('screen-', '');
      const p = remoteParticipants.find((r) => String(r.userId) === uid);
      if (!p?.screenStream) setFocusedScreenKey(null);
    }
  }, [focusedScreenKey, screenStream, remoteParticipants]);

  // Fullscreen — platform-split behaviour:
  //   Web: local state flip. ImmersiveCallSurface portals to document.body with
  //        z-[var(--z-pip)] so it covers the rest of the app. No browser
  //        Fullscreen API (users can still hit F11 if they want real fullscreen).
  //   Electron: local state flip + IPC to put the native window into
  //        fullscreen — matches Discord Desktop's immersive behavior.
  const toggleFullscreen = useCallback(() => {
    setIsFullscreen((cur) => {
      const next = !cur;
      requestAppFullscreen(next);
      return next;
    });
  }, []);

  // Sync local state when the OS / user exits fullscreen via F11 or window
  // chrome (Electron). On web this subscription never fires.
  useEffect(() => {
    return onAppFullscreenChange((enabled) => setIsFullscreen(enabled));
  }, []);

  // Popout window — renders via portal into a detached browser window
  const { isPoppedOut, popoutContainerRef, openPopout, closePopout } = usePopoutWindow({
    windowName: 'howl-voice-popout',
    title: `Voice | ${channel.name}`,
    containerId: 'voice-popout-root',
  });

  /** userId for which the volume slider is expanded (null = all hidden) */
  const [volumeOpenUserId, setVolumeOpenUserId] = useState<string | null>(null);
  /** userId shown in enlarged/focus video overlay (null = none) */
  const [focusedParticipantUserId, setFocusedParticipantUserId] = useState<string | null>(null);

  const screenVideoRef = useRef<HTMLVideoElement>(null);
  const cameraVideoRef = useRef<HTMLVideoElement>(null);

  // Set the screen stream. isPoppedOut in deps forces re-apply after the
  // popout-mode transition remounts the <video> into a different React tree.
  useEffect(() => {
    const el = screenVideoRef.current;
    if (el && screenStream && el.srcObject !== screenStream) {
      el.srcObject = screenStream;
      el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [screenStream, isScreenSharing, isPoppedOut]);

  // Reset self-screen preview toggle when screen sharing stops
  useEffect(() => {
    if (!isScreenSharing) setShowSelfScreenPreview(true);
  }, [isScreenSharing]);

  // Persist showSelfScreenPreview to localStorage
  useEffect(() => {
    saveVoiceState({ showSelfScreenPreview });
  }, [showSelfScreenPreview]);

  // Set the camera stream. isPoppedOut in deps forces re-apply after the
  // popout-mode transition remounts the <video> into a different React tree.
  useEffect(() => {
    const el = cameraVideoRef.current;
    if (el && cameraStream && el.srcObject !== cameraStream) {
      el.srcObject = cameraStream;
      el.play().catch(() => {});
    }
    return () => {
      if (el) el.srcObject = null;
    };
  }, [cameraStream, isCameraOn, isPoppedOut]);

  // Sidebar "watch stream" button flow: when the user clicks the Monitor
  // icon next to a screensharing user in the sidebar, that handler sets
  // `autoWatchScreenUserId` in voiceStore and navigates here. Once we've
  // connected and the target user's screen track actually becomes available,
  // auto-call enableRemoteScreen + startWatching, then clear the flag so a
  // reconnect doesn't re-trigger it.
  useEffect(() => {
    const targetUserId = useVoiceStore.getState().autoWatchScreenUserId;
    if (!targetUserId) return;
    const target = remoteParticipants.find((r) => r.userId === targetUserId);
    if (!target?.screenShareAvailable) return;
    enableRemoteScreen?.(targetUserId);
    setWatchingScreenShareUserId((prev) => {
      if (prev.has(targetUserId)) return prev;
      const next = new Set(prev);
      next.add(targetUserId);
      return next;
    });
    useVoiceStore.getState().setAutoWatchScreenUserId(null);
  }, [remoteParticipants, enableRemoteScreen]);

  // Clear auto-watch flag on unmount so a fresh join starts clean.
  useEffect(() => {
    return () => { useVoiceStore.getState().setAutoWatchScreenUserId(null); };
  }, []);

  // Auto-stop watching any screen shares that become unavailable.
  useEffect(() => {
    if (watchingScreenShareUserId.size === 0) return;
    const stale: string[] = [];
    for (const id of watchingScreenShareUserId) {
      const p = remoteParticipants.find((r) => r.userId === id);
      if (!p?.screenShareAvailable) stale.push(id);
    }
    if (stale.length === 0) return;
    for (const id of stale) disableRemoteScreen?.(id);
    setWatchingScreenShareUserId((prev) => {
      const next = new Set(prev);
      for (const id of stale) next.delete(id);
      return next;
    });
  }, [watchingScreenShareUserId, remoteParticipants, disableRemoteScreen]);

  // Close enlarged view if that participant leaves (skip for self)
  useEffect(() => {
    const self = String(currentUser?.id ?? '');
    if (focusedParticipantUserId && focusedParticipantUserId !== self && !remoteParticipants.some((r) => r.userId === focusedParticipantUserId)) {
      setFocusedParticipantUserId(null);
    }
  }, [focusedParticipantUserId, remoteParticipants, currentUser?.id]);

  // Compute total participant count for card sizing
  const selfId = String(currentUser?.id ?? '');
  const othersInChannelIds = new Set(participants.filter((p) => String(p.userId) !== selfId).map((p) => String(p.userId)));
  const remoteIds = new Set(remoteParticipants.map((r) => String(r.userId)));
  const totalParticipantCount = 1 + new Set([...othersInChannelIds, ...remoteIds].filter((id) => id && id !== selfId)).size;

  // Compact mode: reduce per-card DOM complexity when participant count is high
  // to avoid massive DOM causing layout/paint bottlenecks with 25+ participants
  const compactMode = isMobile ? totalParticipantCount > 4 : totalParticipantCount > 25;

  const persistedVoiceState = useMemo(() => loadVoiceState(), []);

  const { getCardSize, startResize, draggingCardRef, CARD_MIN_W, CARD_MIN_H } = useCardResize({
    participantCount: totalParticipantCount,
    isMobile,
    initialSizes: persistedVoiceState.cardSizes,
    onSizeChange: (sizes) => saveVoiceState({ cardSizes: sizes }),
  });

  const terminateConnection = () => {
    if (onTerminate) onTerminate();
    closePopout();
  };

  // Shared card grid renderer
  // Produces the participant card grid + focused-participant spotlight
  // + focused-screen overlay. Re-used across default, fullscreen, and
  // popout surfaces so there is zero duplication.
  const renderCardGrid = () => {
    const othersInChannel = participants.filter((p) => String(p.userId) !== String(currentUser?.id));
    const selfParticipant = participants.find((p) => String(p.userId) === String(currentUser?.id));
    const selfDisplayName = selfParticipant?.nickname ?? currentUser.username;
    const selfId_ = String(currentUser?.id ?? '');
    const serverIds = new Set(othersInChannel.map((p) => String(p.userId)));
    const remoteIds_ = new Set(remoteParticipants.map((r) => String(r.userId)));
    const mergedIds = new Set<string>([...serverIds, ...remoteIds_].filter((id) => id && id !== selfId_));
    const allOtherIds = [...mergedIds];
    const totalParticipants = 1 + allOtherIds.length;
    const gridGap = isMobile ? 'gap-2' : (totalParticipants <= 2 ? 'gap-4' : totalParticipants <= 4 ? 'gap-3' : 'gap-2');

    return (
      <>
        <div className={`w-full ${isMobile ? (totalParticipants <= 4 ? 'grid grid-cols-2' : 'flex flex-col') : 'flex flex-wrap justify-center'} ${gridGap}`}>
          {/* Self: camera on = full-bleed video; camera off = banner + overlapping circular avatar */}
          <div
            data-card-resize-wrapper
            className={`relative flex-shrink-0 ${draggingCardRef.current?.key === 'self' ? '' : 'transition-all duration-300'}`}
            style={isMobile ? { width: totalParticipants <= 4 ? 'auto' : '100%', height: getCardSize('self').h } : { width: getCardSize('self').w, height: getCardSize('self').h, minWidth: CARD_MIN_W, minHeight: CARD_MIN_H }}
            {...(onParticipantRightClick ? longPressBindings((e) => { e.preventDefault(); onParticipantRightClick({ id: currentUser.id, username: currentUser.username, avatar: currentUser.avatar, banner: (currentUser as { banner?: string }).banner, status: 'online' as const }, e); }) : {})}
          >
            <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
            {isCameraOn ? (
              /* Video fills entire card */
              <>
              <div className="flex-1 min-h-0 relative overflow-hidden" onClick={isMobile ? () => setFocusedParticipantUserId(selfId_) : undefined}>
                <video
                  ref={(el) => {
                    cameraVideoRef.current = el;
                    if (el && cameraStream && el.srcObject !== cameraStream) {
                      el.srcObject = cameraStream;
                      el.play().catch(() => {});
                    }
                  }}
                  autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />
                {!isMobile && (
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5]" onClick={() => setFocusedParticipantUserId(selfId_)}>
                    <div className="w-12 h-12 rounded-full bg-fill-strong backdrop-blur-sm flex items-center justify-center">
                      <Maximize2 size={20} className="text-white/90" />
                    </div>
                  </div>
                )}
              </div>
              <ParticipantCardFooter
                avatar={currentUser.avatar}
                username={currentUser.username}
                effectivePlan={(currentUser.effectivePlan ?? currentUser.stripePlan) as any}
                avatarEffect={currentUser.avatarEffect}
                nameNode={(() => {
                  const plan = currentUser.effectivePlan || currentUser.stripePlan;
                  return plan === 'pro' && (currentUser.nameColor || currentUser.nameFont || currentUser.nameEffect)
                    ? <RoleNameStyle name={selfDisplayName} overrideColor={currentUser.nameColor} overrideFont={currentUser.nameFont} nameEffect={currentUser.nameEffect} />
                    : <>{selfDisplayName}</>;
                })()}
                stream={isMuted ? null : localStream ?? null}
                isMuted={isMuted}
                isDeafened={isDeafened}
                isScreenSharing={isScreenSharing}
                rightActions={
                  <>
                    {isScreenSharing && onOpenScreenShareSettings && (
                      <button
                        type="button"
                        onClick={onOpenScreenShareSettings}
                        className="p-1 rounded-full hover:bg-[var(--fill-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
                        title={t('screenShare.settingsTitle', 'Screen Share Settings')}
                        aria-label={t('screenShare.settingsTitle', 'Screen Share Settings')}
                      >
                        <Settings size={13} />
                      </button>
                    )}
                    {isScreenSharing && (
                      showSelfScreenPreview ? (
                        <button type="button" onClick={() => setShowSelfScreenPreview(false)} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-red-500/20 text-[var(--danger)] hover:bg-red-500/30 hover:text-[var(--danger)] border border-red-500/30 transition-all" title={t('voice.hidePreview')}>
                          <X size={11} /> {t('voice.hideLabel')}
                        </button>
                      ) : (
                        <button type="button" onClick={() => setShowSelfScreenPreview(true)} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-muted)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.showPreview')}>
                          <Monitor size={11} /> {t('voice.watch')}
                        </button>
                      )
                    )}
                  </>
                }
              />
              </>
            ) : (
              /* Voice-only: banner IS the card — full-bleed banner with overlay bar at bottom */
              <div className="absolute inset-0 rounded-2xl overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                  {currentUser.banner ? (
                    <LazyGif src={sanitizeImgSrc(currentUser.banner)} frameSrc={getFrameUrl(currentUser.banner)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${currentUser.bannerPositionY ?? 50}%`, ...(currentUser.bannerZoom && currentUser.bannerZoom > 100 ? { transform: `scale(${currentUser.bannerZoom / 100})`, transformOrigin: `center ${currentUser.bannerPositionY ?? 50}%` } : {}) }} />
                  ) : null}
                </div>
                <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)]/70 via-transparent to-transparent pointer-events-none" />
                <ParticipantCardFooter
                  avatar={currentUser.avatar}
                  username={currentUser.username}
                  effectivePlan={(currentUser.effectivePlan ?? currentUser.stripePlan) as any}
                  avatarEffect={currentUser.avatarEffect}
                  nameNode={(() => {
                    const plan = currentUser.effectivePlan || currentUser.stripePlan;
                    return plan === 'pro' && (currentUser.nameColor || currentUser.nameFont || currentUser.nameEffect)
                      ? <RoleNameStyle name={selfDisplayName} overrideColor={currentUser.nameColor} overrideFont={currentUser.nameFont} nameEffect={currentUser.nameEffect} />
                      : <>{selfDisplayName}</>;
                  })()}
                  stream={isMuted ? null : localStream ?? null}
                  isMuted={isMuted}
                  isDeafened={isDeafened}
                  isScreenSharing={isScreenSharing}
                  rightActions={
                    <>
                      {isScreenSharing && onOpenScreenShareSettings && (
                        <button
                          type="button"
                          onClick={onOpenScreenShareSettings}
                          className="p-1 rounded-full hover:bg-[var(--fill-hover)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all"
                          title={t('screenShare.settingsTitle', 'Screen Share Settings')}
                          aria-label={t('screenShare.settingsTitle', 'Screen Share Settings')}
                        >
                          <Settings size={13} />
                        </button>
                      )}
                      {isScreenSharing && (
                        showSelfScreenPreview ? (
                          <button type="button" onClick={() => setShowSelfScreenPreview(false)} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-red-500/20 text-[var(--danger)] hover:bg-red-500/30 hover:text-[var(--danger)] border border-red-500/30 transition-all" title={t('voice.hidePreview')}>
                            <X size={11} /> {t('voice.hideLabel')}
                          </button>
                        ) : (
                          <button type="button" onClick={() => setShowSelfScreenPreview(true)} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-muted)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.showPreview')}>
                            <Monitor size={11} /> {t('voice.watch')}
                          </button>
                        )
                      )}
                    </>
                  }
                />
              </div>
            )}
            </div>
            {!isMobile && <div
              role="button"
              tabIndex={0}
              onMouseDown={(e) => startResize('self', e)}
              className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--cyan-accent)]/20 border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30"
              aria-label={t('voiceCall.resizeCard')}
            >
              <span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span>
            </div>}
          </div>

          {/* Self screen share card — inline in the grid (hidden when user toggles off to save resources) */}
          {isScreenSharing && screenStream && showSelfScreenPreview && (
            <div
              data-card-resize-wrapper
              className={`relative flex-shrink-0 ${draggingCardRef.current?.key === 'self-screen' ? '' : 'transition-all duration-300'}`}
              style={isMobile ? { width: totalParticipants <= 4 ? 'auto' : '100%', height: getCardSize('self-screen').h } : { width: getCardSize('self-screen').w, height: getCardSize('self-screen').h, minWidth: CARD_MIN_W, minHeight: CARD_MIN_H }}
            >
              <div className="w-full h-full relative bg-[var(--bg-app)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
                <div className="flex-1 min-h-0 relative">
                  <video
                    ref={(el) => {
                      screenVideoRef.current = el;
                      if (el && screenStream && el.srcObject !== screenStream) {
                        el.srcObject = screenStream;
                        el.play().catch(() => {});
                      }
                    }}
                    autoPlay playsInline muted className="absolute inset-0 w-full h-full object-contain"
                  />
                  {currentUser?.id && (
                    <>
                      <div className="absolute top-2 right-2 z-10 pointer-events-auto">
                        <ViewerIndicator context={{ kind: 'voice', scopeId: channel.id }} ownerId={currentUser.id} selfUserId={currentUser.id} />
                      </div>
                      <div className="absolute bottom-2 left-2 z-10 pointer-events-auto">
                        <ViewerAvatarStack context={{ kind: 'voice', scopeId: channel.id }} ownerId={currentUser.id} selfUserId={currentUser.id} />
                      </div>
                    </>
                  )}
                  <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5] rounded-t-2xl" onClick={() => setFocusedScreenKey('self-screen')}>
                    <div className="w-10 h-10 rounded-full bg-fill-strong backdrop-blur-sm flex items-center justify-center">
                      <Maximize2 size={18} className="text-white/90" />
                    </div>
                  </div>
                </div>
                <div className="px-3 py-2.5 min-h-[60px] flex items-center justify-between gap-2 bg-[var(--glass-bg)] backdrop-blur-sm shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-6 h-6 rounded-lg bg-[var(--success)] flex items-center justify-center shrink-0">
                      <Monitor size={13} className="text-black" />
                    </div>
                    <span className="text-xs text-[var(--text-primary)] font-bold truncate">{t('voice.yourScreen')}</span>
                    <div className="w-1.5 h-1.5 bg-[var(--success)] rounded-full animate-pulse shrink-0" />
                  </div>
                </div>
              </div>
              {!isMobile && <div
                role="button"
                tabIndex={0}
                onMouseDown={(e) => startResize('self-screen', e)}
                className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--success-subtle)] border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30"
                aria-label={t('voiceCall.resizeCard')}
              >
                <span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span>
              </div>}
            </div>
          )}

          {/* Remote participants: unified list (socket + WebRTC) so we always use stream/Connected when we have it */}
          {allOtherIds.length > 0 && allOtherIds.map((id) => {
              const remote = remoteParticipants.find((r) => String(r.userId) === id);
              const socketP = othersInChannel.find((p) => String(p.userId) === id);
              const name = socketP?.nickname ?? remote?.nickname ?? remote?.username ?? socketP?.username ?? id;
              const avatar = remote?.avatar ?? socketP?.avatar;
              if (remote) {
                const bannerUrl = socketP?.banner ?? remote?.banner ?? null;
                const bannerPositionY = socketP?.bannerPositionY ?? remote?.bannerPositionY;
                const bannerZoom = socketP?.bannerZoom ?? remote?.bannerZoom;
                const showCamera = !!remote.cameraStream;
                const videoStream = remote.cameraStream ?? null;
                const isWatchingThisScreen = watchingScreenShareUserId.has(id) && remote.screenStream;
                return (
                  <React.Fragment key={`participant-group-${id}`}>
                  <div
                    key={`participant-${id}`}
                    data-card-resize-wrapper
                    className={`relative flex-shrink-0 ${draggingCardRef.current?.key === id ? '' : 'transition-all duration-300'}`}
                    style={isMobile ? { width: totalParticipants <= 4 ? 'auto' : '100%', height: compactMode ? 60 : getCardSize(id).h } : { width: compactMode ? 'min(180px, 45vw)' : getCardSize(id).w, height: compactMode ? 60 : getCardSize(id).h, minWidth: compactMode ? 'min(140px, 40vw)' : CARD_MIN_W, minHeight: compactMode ? 50 : CARD_MIN_H, contain: compactMode ? 'content' : undefined }}
                    {...(onParticipantRightClick ? longPressBindings((e) => { e.preventDefault(); onParticipantRightClick(toUserWithRole(id, remote, socketP ?? null), e); }) : {})}
                  >
                    <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
                      {/* Banner only – always visible (hidden in compact mode to reduce DOM) */}
                      {!compactMode && <div className="absolute inset-0 rounded-2xl overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                          {bannerUrl ? (
                            <LazyGif src={sanitizeImgSrc(bannerUrl)} frameSrc={getFrameUrl(bannerUrl)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${bannerPositionY ?? 50}%`, ...(bannerZoom && bannerZoom > 100 ? { transform: `scale(${bannerZoom / 100})`, transformOrigin: `center ${bannerPositionY ?? 50}%` } : {}) }} />
                          ) : null}
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)]/70 via-transparent to-transparent pointer-events-none" />
                      </div>}
                      {/* Camera + overlay wrapper */}
                      <div className="flex-1 min-h-0 relative z-[1]" onClick={isMobile && !compactMode && (remote.cameraStream || remote.screenStream) ? () => setFocusedParticipantUserId(remote.userId) : undefined}>
                        {/* Camera overlay – only when remote has active video (hidden in compact mode) */}
                        {!compactMode && showCamera && videoStream ? (
                          <div className="absolute inset-0 overflow-hidden">
                            <RemoteCameraVideo stream={videoStream} />
                          </div>
                        ) : null}
                        {/* Maximize hover overlay — scoped above banner/camera */}
                        {!isMobile && !compactMode && (remote.cameraStream || remote.screenStream) && (
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5]" onClick={() => setFocusedParticipantUserId(remote.userId)}>
                            <div className="w-12 h-12 rounded-full bg-fill-strong backdrop-blur-sm flex items-center justify-center">
                              <Maximize2 size={20} className="text-white/90" />
                            </div>
                          </div>
                        )}
                      </div>
                      {/* Bottom bar */}
                      <ParticipantCardFooter
                        avatar={avatar}
                        username={name}
                        effectivePlan={(socketP?.effectivePlan ?? remote?.effectivePlan) as any}
                        avatarEffect={socketP?.avatarEffect ?? remote?.avatarEffect}
                        nameNode={(() => {
                          const nc = socketP?.nameColor ?? remote?.nameColor;
                          const nf = socketP?.nameFont ?? remote?.nameFont;
                          const ne = socketP?.nameEffect ?? remote?.nameEffect;
                          const rc = socketP?.roleColor ?? remote?.roleColor;
                          const rs = (socketP?.roleStyle ?? remote?.roleStyle) as import('./RoleNameStyle').RoleStyle | undefined;
                          const inner = (rc || nc || nf || ne)
                            ? <RoleNameStyle name={name} color={rc} style={rs ?? 'solid'} overrideColor={nc} overrideFont={nf} nameEffect={ne} />
                            : name;
                          return onParticipantRightClick ? (
                            <span
                              className="cursor-context-menu rounded-md pl-3 pr-2 py-1 -mx-2 -my-1 hover:bg-[var(--fill-hover)] transition-colors"
                              {...longPressBindings((e) => { e.preventDefault(); onParticipantRightClick(toUserWithRole(id, remote, socketP ?? null), e); })}
                            >
                              {inner}
                            </span>
                          ) : inner;
                        })()}
                        stream={remote.stream}
                        isMuted={remote.isMuted}
                        isDeafened={remote.isDeafened}
                        serverMuted={remote.serverMuted}
                        serverDeafened={remote.serverDeafened}
                        connectionState={isParticipantConnected(remote) ? 'connected' : remote.connectionState === 'failed' ? 'failed' : 'connecting'}
                        rightActions={
                          <>
                            {onParticipantVolumeChange && (
                              <button type="button" onClick={() => setVolumeOpenUserId((v) => (v === remote.userId ? null : remote.userId))} className="p-1.5 rounded-full hover:bg-[var(--fill-hover)] transition-colors" title={t('profile.volume')} aria-label={t('voiceCall.volumeFor', { username: name })}>
                                <Volume2 size={14} className="text-[var(--text-secondary)]" />
                              </button>
                            )}
                            {remote.screenShareAvailable && showStreamPreviews && (
                              watchingScreenShareUserId.has(remote.userId) ? (
                                <button type="button" onClick={() => { disableRemoteScreen?.(remote.userId); stopWatching(remote.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-red-500/20 text-[var(--danger)] hover:bg-red-500/30 hover:text-[var(--danger)] border border-red-500/30 transition-all" title={t('voice.stopWatching')}>
                                  <X size={11} /> {t('voice.stop')}
                                </button>
                              ) : (
                                <button type="button" onClick={() => { enableRemoteScreen?.(remote.userId); startWatching(remote.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-muted)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.watchScreenShare')}>
                                  <Monitor size={11} /> {t('voice.watch')}
                                </button>
                              )
                            )}
                          </>
                        }
                      />
                    </div>
                    {/* VolumePopup rendered outside card overflow-hidden so it doesn't get clipped */}
                    {!compactMode && onParticipantVolumeChange && volumeOpenUserId === remote.userId && (
                      <div className="absolute bottom-12 right-2 z-40">
                        <VolumePopup
                          userId={remote.userId}
                          username={name}
                          volume={participantVolumes[remote.userId] ?? 0.5}
                          onChange={onParticipantVolumeChange}
                          onClose={() => setVolumeOpenUserId(null)}
                        />
                      </div>
                    )}
                    {!compactMode && !isMobile && <div
                      role="button"
                      tabIndex={0}
                      onMouseDown={(e) => startResize(id, e)}
                      className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--cyan-accent)]/20 border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30"
                      aria-label={t('voiceCall.resizeCard')}
                    >
                      <span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span>
                    </div>}
                  </div>
                  {isWatchingThisScreen && (
                    <div
                      key={`screen-${id}`}
                      data-card-resize-wrapper
                      className={`relative flex-shrink-0 ${draggingCardRef.current?.key === `screen-${id}` ? '' : 'transition-all duration-300'}`}
                      style={isMobile ? { width: totalParticipants <= 4 ? 'auto' : '100%', height: getCardSize(`screen-${id}`).h } : { width: `min(${getCardSize(`screen-${id}`).w}px, 90vw)`, height: getCardSize(`screen-${id}`).h, minWidth: `min(${CARD_MIN_W}px, 45vw)`, minHeight: CARD_MIN_H }}
                    >
                      <div className="w-full h-full relative bg-[var(--bg-app)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
                        <div className="flex-1 min-h-0 relative">
                          <ScreenShareCard
                            stream={remote.screenStream!}
                            screenShareAudioStream={remote.screenShareAudioStream}
                            userId={id}
                            username={name}
                            isDeafened={audioDeafened}
                            streamContext={{ kind: 'voice', scopeId: channel.id }}
                            selfUserId={currentUser?.id}
                          />
                          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5] rounded-t-2xl" onClick={() => setFocusedScreenKey(`screen-${id}`)}>
                            <div className="w-10 h-10 rounded-full bg-fill-strong backdrop-blur-sm flex items-center justify-center">
                              <Maximize2 size={18} className="text-white/90" />
                            </div>
                          </div>
                        </div>
                        <div className="px-3 py-2.5 min-h-[60px] flex items-center justify-between gap-2 bg-[var(--glass-bg)] backdrop-blur-sm shrink-0">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-6 h-6 rounded-lg bg-[var(--success)] flex items-center justify-center shrink-0">
                              <Monitor size={13} className="text-black" />
                            </div>
                            <span className="text-xs text-[var(--text-primary)] font-bold truncate">{t('voice.usernameScreen', { username: name })}</span>
                          </div>
                          <div className="flex items-center gap-1.5">
                            {remote.screenShareAudioStream && remote.screenShareAudioStream.getAudioTracks().length > 0 && (
                              <ScreenShareVolumeControls
                                userId={id}
                                username={name}
                                hasAudio
                              />
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                disableRemoteScreen?.(id);
                                stopWatching(id);
                              }}
                              className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-red-500/20 text-[var(--danger)] hover:bg-red-500/30 hover:text-[var(--danger)] border border-red-500/30 transition-all"
                            >
                              <X size={10} /> {t('voice.stop')}
                            </button>
                          </div>
                        </div>
                      </div>
                      {!isMobile && <div
                        role="button"
                        tabIndex={0}
                        onMouseDown={(e) => startResize(`screen-${id}`, e)}
                        className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--success-subtle)] border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30"
                        aria-label={t('voiceCall.resizeCard')}
                      >
                        <span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span>
                      </div>}
                    </div>
                  )}
                  </React.Fragment>
                );
              }
              const connectingBannerUrl = socketP?.banner ?? null;
              const connectingBannerPositionY = socketP?.bannerPositionY;
              const connectingBannerZoom = socketP?.bannerZoom;
              return (
                <div
                  key={`participant-${id}`}
                  className="relative flex-shrink-0"
                  style={isMobile ? { width: totalParticipants <= 4 ? 'auto' : '100%', height: compactMode ? 60 : getCardSize(id).h } : { width: compactMode ? 'min(180px, 45vw)' : getCardSize(id).w, height: compactMode ? 60 : getCardSize(id).h, minWidth: compactMode ? 'min(140px, 40vw)' : CARD_MIN_W, minHeight: compactMode ? 50 : CARD_MIN_H, contain: compactMode ? 'content' : undefined }}
                  {...(onParticipantRightClick ? longPressBindings((e) => { e.preventDefault(); onParticipantRightClick(toUserWithRole(id, null, socketP ?? null), e); }) : {})}
                >
                  <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden">
                    {!compactMode && <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                      {connectingBannerUrl ? (
                        <LazyGif src={sanitizeImgSrc(connectingBannerUrl)} frameSrc={getFrameUrl(connectingBannerUrl)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${connectingBannerPositionY ?? 50}%`, ...(connectingBannerZoom && connectingBannerZoom > 100 ? { transform: `scale(${connectingBannerZoom / 100})`, transformOrigin: `center ${connectingBannerPositionY ?? 50}%` } : {}) }} />
                      ) : null}
                    </div>}
                    {!compactMode && <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)]/70 via-transparent to-transparent pointer-events-none" />}
                    <ParticipantCardFooter
                      avatar={avatar}
                      username={name}
                      effectivePlan={socketP?.effectivePlan as any}
                      avatarEffect={socketP?.avatarEffect}
                      nameNode={(() => {
                        const nc = socketP?.nameColor;
                        const nf = socketP?.nameFont;
                        const ne = socketP?.nameEffect;
                        const rc = socketP?.roleColor;
                        const rs = socketP?.roleStyle as import('./RoleNameStyle').RoleStyle | undefined;
                        const inner = (rc || nc || nf || ne)
                          ? <RoleNameStyle name={name} color={rc} style={rs ?? 'solid'} overrideColor={nc} overrideFont={nf} nameEffect={ne} />
                          : name;
                        return onParticipantRightClick ? (
                          <span
                            className="cursor-context-menu rounded-md pl-3 pr-2 py-1 -mx-2 -my-1 hover:bg-[var(--fill-hover)] transition-colors"
                            {...longPressBindings((e) => { e.preventDefault(); onParticipantRightClick(toUserWithRole(id, null, socketP ?? null), e); })}
                          >
                            {inner}
                          </span>
                        ) : inner;
                      })()}
                      stream={null}
                      connectionState={'connecting'}
                    />
                  </div>
                  {!compactMode && !isMobile && <div
                    role="button"
                    tabIndex={0}
                    onMouseDown={(e) => startResize(id, e)}
                    className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--cyan-accent)]/20 border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30"
                    aria-label={t('voiceCall.resizeCard')}
                  >
                    <span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span>
                  </div>}
                </div>
              );
              })}

          {/* Self screen share is now shown inline as a card in the participant grid above */}
        </div>

        {/* Spotlight view — enlarged participant with side strip */}
        {focusedParticipantUserId && (() => {
          /* Close spotlight — top right */
          const closeBtn = (
            <button
              type="button"
              onClick={() => setFocusedParticipantUserId(null)}
              className="absolute top-4 right-4 z-50 p-2.5 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white transition-all backdrop-blur-sm"
              aria-label={t('common.close')}
            >
              <X size={20} />
            </button>
          );
          const isSelfFocused = focusedParticipantUserId === selfId;
          const focusedRemote = isSelfFocused ? null : remoteParticipants.find((r) => r.userId === focusedParticipantUserId);
          if (!isSelfFocused && !focusedRemote) return null;

          const focusedName = isSelfFocused ? currentUser.username : (focusedRemote!.username ?? 'Unknown');
          const focusedAvatar = isSelfFocused ? currentUser.avatar : (focusedRemote!.avatar ?? null);
          const focusedStream = isSelfFocused ? (cameraStream ?? screenStream) : (focusedRemote!.cameraStream ?? focusedRemote!.screenStream ?? null);
          const focusedSocketP = isSelfFocused ? null : participants.find((p) => String(p.userId) === focusedRemote!.userId);
          const focusedBannerUrl = isSelfFocused
            ? ((currentUser as { banner?: string | null }).banner ?? null)
            : ((focusedSocketP as { banner?: string | null })?.banner ?? (focusedRemote as { banner?: string | null })?.banner ?? null);
          const focusedBannerPositionY = isSelfFocused ? undefined : (focusedSocketP?.bannerPositionY ?? focusedRemote?.bannerPositionY);
          const focusedBannerZoom = isSelfFocused ? undefined : (focusedSocketP?.bannerZoom ?? focusedRemote?.bannerZoom);

          const sideEntries: Array<{ id: string; name: string; avatar: string | null; stream: MediaStream | null; isSelf: boolean }> = [];
          sideEntries.push({ id: selfId, name: currentUser.username, avatar: currentUser.avatar, stream: cameraStream ?? null, isSelf: true });
          for (const r of remoteParticipants) {
            sideEntries.push({ id: r.userId, name: r.username, avatar: r.avatar ?? null, stream: r.cameraStream ?? r.screenStream ?? null, isSelf: false });
          }

          return (
            <div className="absolute inset-0 z-[var(--z-modal)] flex gap-2 p-3 bg-[var(--bg-app)]/95 backdrop-blur-xl animate-in fade-in duration-200">
              {closeBtn}
              {/* Main spotlight */}
              <div className="flex-1 min-w-0 rounded-xl overflow-hidden relative bg-[var(--bg-panel)] border border-[var(--cyan-accent)]/20">
                {focusedStream ? (
                  <RemoteCameraVideo stream={focusedStream} className="w-full h-full object-cover" />
                ) : (
                  <div className="absolute inset-0 rounded-xl overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
                      {focusedBannerUrl ? (
                        <LazyGif src={sanitizeImgSrc(focusedBannerUrl)} frameSrc={getFrameUrl(focusedBannerUrl)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${focusedBannerPositionY ?? 50}%`, ...(focusedBannerZoom && focusedBannerZoom > 100 ? { transform: `scale(${focusedBannerZoom / 100})`, transformOrigin: `center ${focusedBannerPositionY ?? 50}%` } : {}) }} />
                      ) : null}
                    </div>
                    <div className="absolute inset-0 bg-gradient-to-t from-[var(--bg-app)]/70 via-transparent to-transparent pointer-events-none" />
                  </div>
                )}
                <div className="absolute bottom-0 left-0 right-0 px-4 py-3 flex items-center gap-3 bg-[var(--glass-bg)] backdrop-blur-sm z-10">
                  <LetterAvatar avatar={focusedAvatar} username={focusedName} size={28} className="rounded-full shrink-0" />
                  <span className="font-bold text-sm text-t-primary truncate">{focusedName}</span>
                  <button type="button" onClick={() => setFocusedParticipantUserId(null)} className="ml-auto p-2 rounded-full hover:bg-fill-active text-t-secondary transition-colors" aria-label={t('common.close')}>
                    <X size={18} />
                  </button>
                </div>
              </div>

              {/* Side strip — thumbnails */}
              {!isMobile && sideEntries.length > 1 && (
                <div className="w-[min(110px,28vw)] shrink-0 flex flex-col gap-2 overflow-y-auto">
                  {sideEntries.filter(e => e.id !== focusedParticipantUserId).map((e) => (
                    <button
                      key={e.id}
                      type="button"
                      onClick={() => setFocusedParticipantUserId(e.id)}
                      className="w-full aspect-[16/10] rounded-lg overflow-hidden relative border border-default hover:border-[var(--cyan-accent)]/30 transition-colors shrink-0"
                    >
                      {e.stream ? (
                        <RemoteCameraVideo stream={e.stream} className="w-full h-full object-cover" />
                      ) : (
                        <div className="w-full h-full bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]" />
                      )}
                      <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-black/60 flex items-center gap-1">
                        <LetterAvatar avatar={e.avatar} username={e.name} size={14} className="rounded-full shrink-0" />
                        <span className="text-[8px] font-bold truncate text-white/80">{e.name}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })()}

        {/* Focused screen share overlay — fills voice area like Discord */}
        {focusedScreenKey && (
          <FocusedScreenOverlay
            focusedScreenKey={focusedScreenKey}
            screenStream={screenStream}
            remoteParticipants={remoteParticipants}
            socketParticipants={participants}
            onClose={() => setFocusedScreenKey(null)}
            isMobile={isMobile}
            isDeafened={audioDeafened}
            streamContext={{ kind: 'voice', scopeId: channel.id }}
            selfUserId={currentUser?.id}
          />
        )}
      </>
    );
  };

  // Shared control bar (with hide/show toggle + mobile hints)
  const renderControlBar = () => (
    <>
      <button
        type="button"
        onClick={() => setControlBarHidden((h) => !h)}
        className="p-1 rounded-full text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] transition-colors"
        title={controlBarHidden ? t('voice.showControls', 'Show controls') : t('voice.hideControls', 'Hide controls')}
        aria-label={controlBarHidden ? t('voice.showControls', 'Show controls') : t('voice.hideControls', 'Hide controls')}
      >
        {controlBarHidden ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {!controlBarHidden && (
        <>
        {/* E2EE indicator — server voice runs SFrame E2EE (mirrors StageView/DMCallView) */}
        {isE2ee && (
          <span className="flex items-center gap-1 px-2 py-1 text-emerald-400" title={t('voiceCall.e2eeActive', 'End-to-end encrypted')}>
            <ShieldCheck size={14} />
          </span>
        )}
        {isE2eeFailed && (
          <span className="flex items-center gap-1 px-2 py-1 text-amber-400" title={t('voiceCall.e2eeFailed', 'Not end-to-end encrypted — key exchange failed')}>
            <ShieldAlert size={14} />
          </span>
        )}
        {isMobile && showMobileScreenShareHint && (
          <div className="text-[11px] text-[var(--text-secondary)] bg-[var(--glass-bg)] backdrop-blur-sm border border-[var(--border-subtle)] rounded-full px-3 py-1" role="status" aria-live="polite">
            {t('voice.screenShareDesktopOnly', 'Screen sharing requires desktop')}
          </div>
        )}
        {isMobile && onToggleScreenShare && (
          <button
            type="button"
            onClick={() => setShowMobileScreenShareHint(true)}
            aria-disabled="true"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[11px] font-semibold text-[var(--text-secondary)] bg-[var(--fill-subtle)] border border-[var(--border-subtle)] opacity-60 cursor-not-allowed"
            title={t('voice.screenShareDesktopOnly', 'Screen sharing requires desktop')}
            aria-label={t('voice.screenShareDesktopOnly', 'Screen sharing requires desktop')}
          >
            <MonitorUp size={14} />
            {t('voice.screenShareDesktopOnlyShort', 'Share — desktop only')}
          </button>
        )}
        <CallControlBar
          isMuted={isMuted}
          isDeafened={isDeafened}
          isCameraOn={isCameraOn}
          isScreenSharing={isScreenSharing}
          isFullscreen={isFullscreen}
          isPoppedOut={isPoppedOut}
          onToggleMute={() => onToggleMute?.()}
          onToggleDeafen={onToggleDeafen}
          onToggleCamera={() => onToggleCamera?.()}
          onToggleScreenShare={() => onToggleScreenShare?.()}
          onOpenScreenShareSettings={onOpenScreenShareSettings}
          onToggleFullscreen={toggleFullscreen}
          onClosePopout={isPoppedOut ? closePopout : undefined}
          onOpenPopout={!isPoppedOut && !isFullscreen ? openPopout : undefined}
          onExpandOrCollapse={!isPoppedOut && !isFullscreen ? toggleFullscreen : undefined}
          onLeave={terminateConnection}
          leaveLabel={t('voice.leave')}
          isMobile={isMobile}
          serverMuted={serverMuted}
          serverDeafened={serverDeafened}
          micSilenceState={micSilence.state}
        />
        </>
      )}
    </>
  );

  // Immersive controls element (passed to ImmersiveCallSurface)
  const immersiveControls = (
    <div className="flex flex-col items-center gap-1">
      {renderControlBar()}
    </div>
  );

  // Mic silence banner (shared across all rendering modes)
  const micSilenceBannerNode = micSilence.state === 'banner' ? <MicSilenceBanner onDismiss={micSilence.dismiss} /> : null;

  // Immersive children: card grid + screen share picker overlay
  const immersiveChildren = (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center p-6 pb-4">
      <div className="flex flex-col items-stretch w-full max-w-[1280px] mx-auto gap-6">
        {micSilenceBannerNode}
        {renderCardGrid()}
      </div>
      {/* Fullscreen: render ScreenSharePicker inside the fullscreen container so it's not behind it */}
      {isFullscreen && screenSharePickerOpen && renderScreenSharePicker?.()}
    </div>
  );

  // Fullscreen branch: render via ImmersiveCallSurface
  if (isFullscreen) {
    return (
      <div ref={voiceContainerRef} className="flex-1 flex flex-col min-h-0 w-full relative overflow-hidden">
        <ImmersiveCallSurface mode="fullscreen" controls={immersiveControls}>
          {immersiveChildren}
        </ImmersiveCallSurface>
      </div>
    );
  }

  // Popout branch: portal via ImmersiveCallSurface into popup window
  if (isPoppedOut && popoutContainerRef.current) {
    return (
      <>
        <div className="flex-1 flex flex-col items-center justify-center min-h-0 w-full bg-[var(--bg-panel)] relative overflow-hidden animate-in fade-in duration-300">
          <div className="flex flex-col items-center gap-4 text-center">
            <div className="w-16 h-16 rounded-2xl bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20 flex items-center justify-center">
              <ExternalLink size={28} className="text-[var(--cyan-accent)]" />
            </div>
            <div>
              <p className="text-[var(--text-primary)] font-bold text-sm">{t('voice.poppedOut')}</p>
              <p className="text-[var(--text-secondary)] text-xs mt-1">{t('voice.poppedOutDesc', { channelName: channel.name })}</p>
            </div>
            <button
              type="button"
              onClick={closePopout}
              className="btn-cta px-4 py-2 rounded-xl text-xs transition-all"
            >
              {t('voice.bringBack')}
            </button>
          </div>
        </div>
        {createPortal(
          <ImmersiveCallSurface mode="popout" controls={immersiveControls}>
            {immersiveChildren}
          </ImmersiveCallSurface>,
          popoutContainerRef.current,
        )}
      </>
    );
  }

  // Default in-panel rendering (unchanged layout)
  return (
    <div ref={voiceContainerRef} className="flex-1 flex flex-col min-h-0 w-full relative overflow-hidden animate-in fade-in duration-700">
      {/* Content: centered block (max 1280px) so cards and button are centered */}
      <div className={`flex-1 min-h-0 overflow-y-auto flex flex-col items-center justify-center ${isMobile ? 'p-2' : 'p-6'}`}>
        <div className={`flex flex-col items-stretch w-full max-w-[1280px] mx-auto ${isMobile ? 'gap-3' : 'gap-6'}`}>
          {micSilenceBannerNode}
          {renderCardGrid()}
        </div>
      </div>

      {/* Unified control bar — pinned to bottom */}
      <div className="w-full shrink-0 mt-auto flex flex-col items-center gap-1" style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}>
        {renderControlBar()}
      </div>

      {/* Screen share is now shown inline as a card in the participant grid */}
    </div>
  );
};

export default VoiceChannel;
