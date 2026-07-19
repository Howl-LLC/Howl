// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { PhoneOff, Volume2, Monitor, X, Maximize2, ExternalLink, ShieldCheck, ShieldAlert, ShieldEllipsis, ShieldX } from 'lucide-react';
import { CameraPreviewModal } from './CameraPreviewModal';
import { useSettings } from '../contexts/SettingsContext';
import { useNavigationStore } from '../stores/navigationStore';
import { useUiStore } from '../stores/uiStore';
import { useDmStore } from '../stores/dmStore';
import { useVoiceStore } from '../stores/voiceStore';
import type { User } from '../types';
import type { DMCallParticipant } from '../hooks/useDMCall';
import { useRingTone } from '../hooks/useRingTone';
import { getVideoConstraintsForCamera, getVideoConstraintsForDisplay, type ScreenShareQuality } from '../utils/videoConstraints';
import { getPlanPerks, resolveProNameStyle, type PlanTier, type NameCustomizable } from '../shared/planPerks';
import { ScreenSharePicker } from './ScreenSharePicker';
import { useTranslation } from 'react-i18next';
import { UserAvatar } from './UserAvatar';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { LazyGif } from './LazyGif';
import { getFrameUrl } from '../utils/getFrameUrl';
import { requestAppFullscreen, onAppFullscreenChange } from '../utils/fullscreen';
import { type BoostEntry, cleanupBoost, applyVolume } from '../utils/audioBoost';
import { usePopoutWindow } from '../hooks/usePopoutWindow';
import { useCardResize } from '../hooks/useCardResize';
import { ParticipantCardFooter } from './call/ParticipantCardFooter';
import { ScreenShareCard } from './call/ScreenShareCard';
import { ScreenShareVolumeControls } from './call/ScreenShareVolumeControls';
import { RemoteCameraVideo } from './call/RemoteCameraVideo';
import { FocusedScreenOverlay } from './call/FocusedScreenOverlay';
import { CallControlBar } from './call/CallControlBar';
import { InlineCallSurface } from './call/InlineCallSurface';
import { ImmersiveCallSurface } from './call/ImmersiveCallSurface';
import { useBreakpoint } from '../hooks/useIsMobile';
import { RoleNameStyle, type RoleStyle } from './RoleNameStyle';
import { InCallBluetoothBanner } from './audio/InCallBluetoothBanner';
import { useMicSilenceDetection } from '../hooks/useMicSilenceDetection';
import { useRemoteSpokeRecently } from '../hooks/useRemoteSpokeRecently';
import { MicSilenceBanner } from './call/MicSilenceBanner';

type CallMode = 'inline' | 'panel-fullscreen' | 'fullscreen' | 'popout';

interface DMCallViewProps {
  dmChannelId: string;
  currentUser: User;
  displayName: string;
  withVideo?: boolean;
  onEndCall: () => void;
  participantVolumes?: Record<string, number>;
  onParticipantVolumeChange?: (userId: string, volume: number) => void;
  isDeafened?: boolean;
  onToggleDeafen?: () => void;
  isMutedFromParent?: boolean;
  onToggleMuteFromParent?: () => void;
  speakerVolume?: number;
  speakerId?: string;
  userPlan?: string | null;
  onToggleScreenShare?: () => void;
  onToggleCamera?: () => void;
  inlinePortalTargetId?: string;
  otherUsers?: Array<{
    id: string;
    username: string;
    avatar?: string;
    banner?: string | null;
    bannerPositionY?: number;
    bannerZoom?: number;
    nameColor?: string | null;
    nameFont?: string | null;
    nameEffect?: string | null;
    avatarEffect?: string | null;
    effectivePlan?: string | null;
  }>;
  declinedUserIds?: string[];
  screenShareCodec?: 'auto' | 'h264' | 'vp9' | 'av1';
  onCodecChange?: (codec: 'auto' | 'h264' | 'vp9' | 'av1') => void;

  // Session outputs from useDMCall (lifted to App.tsx)
  localStream: MediaStream | null;
  remoteParticipants: DMCallParticipant[];
  leave: () => void;
  error: string | null;
  disconnectedByInactivity: boolean;
  enableRemoteScreen: ((userId: string) => void) | undefined;
  disableRemoteScreen: ((userId: string) => void) | undefined;
  switchMicDevice: (deviceId: string) => Promise<void>;
  isE2ee: boolean;
  isE2eeFailed: boolean;
  /** E2EE is expected and our leg is encrypting, but a peer has not yet
   *  confirmed E2EE on their side — distinct from outright failure. */
  isE2eeEstablishing?: boolean;
  /** E2EE was expected but neither MLS nor the legacy key yielded one;
   *  the session never started. Drives the red blocked shield. */
  isE2eeBlocked?: boolean;
  /** Which scheme keys the call; varies the green badge tooltip
   *  ('mls' = forward secret). Null when none/blocked. */
  callKeyMode?: 'mls' | null;
  /** Epoch ms when the local user joined the call, or null pre-connect. */
  startedAt: number | null;
}

export const DMCallView: React.FC<DMCallViewProps> = ({
  dmChannelId,
  currentUser,
  displayName,
  withVideo = false,
  onEndCall,
  participantVolumes = {},
  onParticipantVolumeChange,
  isDeafened = false,
  onToggleDeafen,
  isMutedFromParent,
  onToggleMuteFromParent,
  speakerVolume = 1,
  speakerId,
  userPlan,
  inlinePortalTargetId,
  otherUsers = [],
  declinedUserIds = [],
  screenShareCodec = 'auto',
  onCodecChange,
  localStream,
  remoteParticipants,
  leave,
  error,
  disconnectedByInactivity: dmInactivityDisconnect,
  enableRemoteScreen,
  disableRemoteScreen,
  switchMicDevice,
  isE2ee,
  isE2eeFailed,
  isE2eeEstablishing = false,
  isE2eeBlocked = false,
  callKeyMode = null,
  startedAt,
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { voiceSettings, updateVoice } = useSettings();
  const breakpoint = useBreakpoint();
  const isMobile = breakpoint === 'mobile';
  const isTablet = breakpoint === 'tablet';
  const [showCameraPreview, setShowCameraPreview] = useState(false);
  const [internalMuted, setInternalMuted] = useState(false);
  const isMuted = onToggleMuteFromParent != null ? (isMutedFromParent ?? false) : internalMuted;
  const handleToggleMute = useCallback(() => {
    if (onToggleMuteFromParent) onToggleMuteFromParent();
    else setInternalMuted((m) => !m);
  }, [onToggleMuteFromParent]);
  const [isCameraOn, setIsCameraOn] = useState(withVideo);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);
  // When the local user is sharing a screen with system audio, silence Howl's
  // own participant audio playback so the screen-audio capture doesn't pick
  // up and re-transmit everyone else's voices (would cause an echo loop for
  // viewers). Gated by the voice setting (default on).
  const audioDeafened = isDeafened || (
    voiceSettings.muteHowlAudioWhileSharing !== false &&
    !!screenStream &&
    screenStream.getAudioTracks().some((t) => t.readyState === 'live')
  );
  // Mirror App.tsx's toggleCamera flow — respect the "always preview" setting
  // before acquiring the stream, so DM/group calls get the same device-select
  // + background modal as voice channels.
  const handleToggleCamera = useCallback(() => {
    if (isCameraOn) {
      setIsCameraOn(false);
    } else if (voiceSettings.cameraPreviewModal) {
      setShowCameraPreview(true);
    } else {
      setIsCameraOn(true);
    }
  }, [isCameraOn, voiceSettings.cameraPreviewModal]);
  const [showScreenSharePicker, setShowScreenSharePicker] = useState(false);
  const [screenShareQuality, setScreenShareQuality] = useState<ScreenShareQuality>(() => {
    try {
      const saved = localStorage.getItem('howl_screenshare_quality');
      if (saved) return JSON.parse(saved) as ScreenShareQuality;
    } catch { /* storage unavailable */ }
    return { resolution: '1080p' as const, fps: 30 as const };
  });
  const cameraVideoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRefs = useRef<Map<string, HTMLAudioElement>>(new Map());
  const dmBoosts = useRef<Map<string, BoostEntry>>(new Map());

  // Live call duration — ticks once per second while the local user is
  // connected. `startedAt` is set by useCallSession when our media stream
  // first goes live, so the timer reflects THIS participant's join time
  // (matches the intuitive "how long have I been on this call" meaning).
  const [durationLabel, setDurationLabel] = useState<string | null>(null);
  useEffect(() => {
    if (!startedAt) { setDurationLabel(null); return; }
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
      const h = Math.floor(secs / 3600);
      const m = Math.floor((secs % 3600) / 60);
      const s = secs % 60;
      const pad = (n: number) => n.toString().padStart(2, '0');
      setDurationLabel(h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Mic silence detection — purely informational UI indicators
  const dmSilenceMs = useVoiceStore(s => s.dmSilenceMs);
  const remoteSpokeRecently = useRemoteSpokeRecently(remoteParticipants);
  const micSilence = useMicSilenceDetection({
    silenceMs: dmSilenceMs,
    isMuted,
    isDeafened,
    remoteParticipantCount: remoteParticipants.length,
    remoteSpokeRecently,
    enabled: voiceSettings.notifyOnNoMicAudio ?? true,
    micPublishedAt: startedAt,
  });

  // Unified call mode state machine
  const [callMode, setCallMode] = useState<CallMode>('inline');
  const prevNonImmersiveModeRef = useRef<CallMode>('inline');
  const setDmCallPanelFullscreen = useUiStore((s) => s.setDmCallPanelFullscreen);
  const peerUnprovisionedCall = useUiStore((s) => s.establishFailureReasons[dmChannelId]?.reason === 'peer-unprovisioned');
  // Group-aware shield name. Resolve the RECORDED unprovisioned member the
  // same way DMView's composer placeholder does; a 1:1 names the only peer.
  const callPeerFailureUserId = useUiStore((s) => s.establishFailureReasons[dmChannelId]?.userId);
  const callPeerName = useDmStore((s) => {
    const ch = s.dmChannels.find((c) => c.id === dmChannelId);
    return ch?.isGroup
      ? (ch.otherUsers?.find((u) => u.id === callPeerFailureUserId)?.username ?? 'a member')
      : (ch?.otherUser?.username ?? 'this user');
  });

  // Sync panel-fullscreen flag to uiStore so DMView can hide its message list
  useEffect(() => {
    setDmCallPanelFullscreen(callMode === 'panel-fullscreen');
    return () => { setDmCallPanelFullscreen(false); };
  }, [callMode, setDmCallPanelFullscreen]);

  // App-level fullscreen — Electron triggers native window fullscreen via IPC,
  // web is a no-op (ImmersiveCallSurface portals to document.body with a
  // dedicated z-index so it covers the rest of the app).
  useEffect(() => {
    requestAppFullscreen(callMode === 'fullscreen');
  }, [callMode]);

  // Ensure we release native window fullscreen if the component unmounts
  // mid-fullscreen (e.g. the call ends).
  useEffect(() => {
    return () => { requestAppFullscreen(false); };
  }, []);

  // Sync local state when the OS / user exits native fullscreen via F11 or
  // window chrome. On web this subscription never fires.
  useEffect(() => {
    return onAppFullscreenChange((enabled) => {
      if (!enabled && callMode === 'fullscreen') {
        setCallMode(prevNonImmersiveModeRef.current);
      }
    });
  }, [callMode]);

  const { isPoppedOut, popoutContainerRef, openPopout: rawOpenPopout, closePopout } = usePopoutWindow({
    windowName: 'howl-dm-call-popout',
    title: 'Howl | DM Call',
    containerId: 'dm-call-popout-root',
  });

  // Wrap openPopout to capture previous mode
  const openPopout = useCallback(() => {
    prevNonImmersiveModeRef.current = callMode === 'fullscreen' || callMode === 'popout' ? prevNonImmersiveModeRef.current : callMode;
    setCallMode('popout');
    rawOpenPopout();
  }, [callMode, rawOpenPopout]);

  // Sync popout hook's isPoppedOut state back to callMode (handles window close detection)
  useEffect(() => {
    if (!isPoppedOut && callMode === 'popout') {
      setCallMode(prevNonImmersiveModeRef.current);
    }
  }, [isPoppedOut, callMode]);

  // Screen share inline card state — set of participant IDs currently being
  // watched. Users can watch multiple simultaneous shares (Discord-parity).
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
  const [showSelfScreenPreview, setShowSelfScreenPreview] = useState(true);
  const [focusedScreenKey, setFocusedScreenKey] = useState<string | null>(null);
  const [focusedParticipantUserId, setFocusedParticipantUserId] = useState<string | null>(null);

  useEffect(() => {
    if (!isScreenSharing) setShowSelfScreenPreview(true);
  }, [isScreenSharing]);

  // Publish camera/screen streams to voiceStore so App.tsx's useDMCall can read them
  useEffect(() => {
    useVoiceStore.getState().setDmCameraStream(cameraStream);
    return () => { useVoiceStore.getState().setDmCameraStream(null); };
  }, [cameraStream]);
  useEffect(() => {
    useVoiceStore.getState().setDmScreenStream(screenStream);
    return () => { useVoiceStore.getState().setDmScreenStream(null); };
  }, [screenStream]);

  // Track whether any remote participant has ever connected in this call session.
  // Once someone joins and then leaves, you're "in a call alone" — no ringback.
  const hasEverConnectedRef = useRef(false);
  useEffect(() => {
    if (remoteParticipants.length > 0) {
      hasEverConnectedRef.current = true;
    }
  }, [remoteParticipants.length]);

  const isCalling = remoteParticipants.length === 0 && !hasEverConnectedRef.current;
  useRingTone(isCalling, 'ringback');

  /** Release camera effect pipeline (worker + processors) + raw device track + processed stream. */
  const cleanupCameraResources = useCallback(() => {
    dmEffectCleanupRef.current?.();
    dmEffectCleanupRef.current = null;
    dmPipelineRef.current = null;
    rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop());
    rawCameraStreamRef.current = null;
    cameraStream?.getTracks().forEach((t) => t.stop());
    setCameraStream(null);
  }, [cameraStream]);

  const terminateConnection = useCallback(() => {
    leave();
    cleanupCameraResources();
    screenStream?.getTracks().forEach((t) => t.stop());
    setScreenStream(null);
    closePopout();
    onEndCall();
  }, [leave, cleanupCameraResources, screenStream, onEndCall]);

  useEffect(() => {
    if (dmInactivityDisconnect) {
      cleanupCameraResources();
      screenStream?.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      closePopout();
      onEndCall();
    }
  }, [dmInactivityDisconnect, cleanupCameraResources, screenStream]);

  useEffect(() => {
    if (error) {
      leave();
      cleanupCameraResources();
      screenStream?.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      closePopout();
      const timer = setTimeout(() => onEndCall(), 3000);
      return () => clearTimeout(timer);
    }
  }, [error, cleanupCameraResources, screenStream]);

  // Raw getUserMedia stream + effect pipeline cleanup tracked separately so
  // the OS camera device is released even when cameraStream points at a
  // processed canvas/background-effect track.
  const rawCameraStreamRef = useRef<MediaStream | null>(null);
  const dmEffectCleanupRef = useRef<(() => void) | null>(null);
  const dmPipelineRef = useRef<import('../services/call/CameraPipeline').CameraPipelineHandle | null>(null);
  const cameraRetryRef = useRef(0);
  const cleanupTrackListenerRef = useRef<(() => void) | null>(null);
  useEffect(() => {
    if (!isCameraOn) {
      dmEffectCleanupRef.current?.();
      dmEffectCleanupRef.current = null;
      dmPipelineRef.current = null;
      rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      rawCameraStreamRef.current = null;
      setCameraStream(null);
      cameraRetryRef.current = 0;
      return;
    }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) return;
    let cancelled = false;

    function acquire() {
      const perks = getPlanPerks((userPlan as PlanTier) ?? null);
      const constraints = getVideoConstraintsForCamera(remoteParticipants.length || 1, perks.maxCameraRes, perks.maxCameraBitrate);
      navigator.mediaDevices.getUserMedia(constraints).then(async (stream) => {
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        // Clean up any prior effect pipeline + raw stream
        dmEffectCleanupRef.current?.();
        dmEffectCleanupRef.current = null;
        dmPipelineRef.current = null;
        rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop());
        rawCameraStreamRef.current = stream;
        cameraRetryRef.current = 0;

        // Apply the full video effect pipeline (autoframe, color grade,
        // background blur / virtual background) via CameraPipeline. The
        // pipeline handle exposes live-update methods for mid-call changes.
        let finalStream = stream;
        try {
          const { buildProcessedCameraStream } = await import('../services/call/buildProcessedCameraStream');
          const { getStoredVoice } = await import('../utils/settingsStorage');
          const vs = getStoredVoice();
          const { stream: processed, cleanup, pipeline } = await buildProcessedCameraStream(stream, {
            autoFrameMode: vs.autoFrameMode,
            autoFrameZoom: vs.autoFrameZoom,
            autoFrameZoomAuto: vs.autoFrameZoomAuto,
            videoColorGradeEnabled: vs.videoColorGradeEnabled,
            videoColorGrade: vs.videoColorGrade,
            videoBackgroundMode: vs.videoBackgroundMode,
            videoBackgroundBlurRadius: vs.videoBackgroundBlurRadius,
            videoBackgroundImageUrl: vs.videoBackgroundImageUrl,
          });
          if (cancelled) { cleanup(); stream.getTracks().forEach((t) => t.stop()); return; }
          dmEffectCleanupRef.current = cleanup;
          dmPipelineRef.current = pipeline;
          finalStream = processed;
        } catch (err) {
          // Effect pipeline is best-effort — publish raw stream on failure
          console.warn('[DM call] video effect pipeline failed, using raw camera:', err);
        }

        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        setCameraStream(finalStream);
        const videoTrack = finalStream.getVideoTracks()[0];
        if (videoTrack) {
          const onEnded = () => {
            if (cancelled) return;
            dmEffectCleanupRef.current?.();
            dmEffectCleanupRef.current = null;
            dmPipelineRef.current = null;
            rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop());
            rawCameraStreamRef.current = null;
            setCameraStream(null);
            if (cameraRetryRef.current < 3) {
              cameraRetryRef.current++;
              acquire();
            }
          };
          videoTrack.addEventListener('ended', onEnded);
          cleanupTrackListenerRef.current = () => videoTrack.removeEventListener('ended', onEnded);
        }
      }).catch(() => { if (!cancelled) setIsCameraOn(false); });
    }

    acquire();
    return () => {
      cancelled = true;
      cleanupTrackListenerRef.current?.();
      cleanupTrackListenerRef.current = null;
      dmEffectCleanupRef.current?.();
      dmEffectCleanupRef.current = null;
      dmPipelineRef.current = null;
      rawCameraStreamRef.current?.getTracks().forEach((t) => t.stop());
      rawCameraStreamRef.current = null;
    };
  }, [isCameraOn]);

  // Live-update video effects when settings change mid-call without
  // requiring a camera toggle. The pipeline mutates its internal state.
  useEffect(() => {
    const p = dmPipelineRef.current;
    if (!p || !isCameraOn) return;
    p.updateAutoFrame(voiceSettings.autoFrameMode ?? 'off');
    p.updateZoom(voiceSettings.autoFrameZoom ?? 1, voiceSettings.autoFrameZoomAuto);
    p.updateColorGrade(
      !!voiceSettings.videoColorGradeEnabled,
      (voiceSettings.videoColorGrade ?? 'none') as import('../services/call/colorGradeProcessor').GradeId,
    );
    p.updateBackground(voiceSettings.videoBackgroundMode ?? 'off', {
      blurRadius: voiceSettings.videoBackgroundBlurRadius,
      imageUrl: voiceSettings.videoBackgroundImageUrl,
    });
  }, [
    isCameraOn,
    voiceSettings.autoFrameMode,
    voiceSettings.autoFrameZoom,
    voiceSettings.autoFrameZoomAuto,
    voiceSettings.videoColorGradeEnabled,
    voiceSettings.videoColorGrade,
    voiceSettings.videoBackgroundMode,
    voiceSettings.videoBackgroundBlurRadius,
    voiceSettings.videoBackgroundImageUrl,
  ]);

  const startScreenShareWithQuality = useCallback((quality: ScreenShareQuality) => {
    setShowScreenSharePicker(false);
    setScreenShareQuality(quality);
    // Sync to voiceStore so App.tsx's useDMCall sees the updated fps/bitrate.
    useVoiceStore.getState().setScreenShareQuality(quality);
    try { localStorage.setItem('howl_screenshare_quality', JSON.stringify(quality)); } catch { /* storage unavailable */ }
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getDisplayMedia) return;
    const getStream = () => {
      if (quality.sourceId && window.electron) {
        // Electron: use getUserMedia with chromeMediaSourceId
        return navigator.mediaDevices.getUserMedia({
          audio: quality.audio !== false ? { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: quality.sourceId } } as any : false,
          video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: quality.sourceId, ...(() => { const c = getVideoConstraintsForDisplay(quality); const v = c.video; return typeof v === 'object' ? { minWidth: (v as any).width?.ideal, minHeight: (v as any).height?.ideal, maxFrameRate: (v as any).frameRate?.ideal } : {}; })() } } as any,
        });
      }
      const constraints = getVideoConstraintsForDisplay(quality);
      return navigator.mediaDevices.getDisplayMedia(constraints);
    };
    getStream().then((stream) => {
      setScreenStream(stream);
      setIsScreenSharing(true);
      stream.getVideoTracks()[0].onended = () => { setIsScreenSharing(false); setScreenStream(null); };
      window.focus();
      setTimeout(() => window.focus(), 200);
      setTimeout(() => window.focus(), 600);
    }).catch(() => {});
  }, []);
  const toggleScreenShareDM = useCallback(() => {
    if (isScreenSharing) {
      screenStream?.getTracks().forEach((t) => t.stop());
      setScreenStream(null);
      setIsScreenSharing(false);
    } else {
      // Open the source + quality picker instead of going straight to
      // getDisplayMedia with the last-saved quality — matches voice channels.
      setShowScreenSharePicker(true);
    }
  }, [isScreenSharing, screenStream]);
  const openScreenShareSettings = useCallback(() => setShowScreenSharePicker(true), []);

  const setCameraVideoRef = useCallback((el: HTMLVideoElement | null) => {
    (cameraVideoRef as React.MutableRefObject<HTMLVideoElement | null>).current = el;
    if (el && cameraStream && el.srcObject !== cameraStream) {
      el.srcObject = cameraStream;
      el.play().catch(() => {});
    }
  }, [cameraStream]);

  // Re-apply srcObject on view-mode / popout transitions (element may remount
  // in a different React tree — inline -> popout -> fullscreen etc.) and on
  // stream identity changes. callMode/isPoppedOut in deps guarantees we
  // refresh after the new <video> is mounted.
  useEffect(() => {
    const el = cameraVideoRef.current;
    if (el && cameraStream && el.srcObject !== cameraStream) {
      el.srcObject = cameraStream;
      el.play().catch(() => {});
    } else if (el && !cameraStream) {
      el.srcObject = null;
    }
  }, [cameraStream, callMode, isPoppedOut]);

  useEffect(() => {
    const activeIds = new Set(remoteParticipants.map((p) => p.userId));
    dmBoosts.current.forEach((e, uid) => {
      if (!activeIds.has(uid)) { cleanupBoost(e); dmBoosts.current.delete(uid); }
    });

    const timeouts: ReturnType<typeof setTimeout>[] = [];
    remoteParticipants.forEach((p) => {
      const el = remoteAudioRefs.current.get(p.userId);
      if (!el) return;

      if (audioDeafened) {
        el.muted = true;
        el.volume = 0;
        const existing = dmBoosts.current.get(p.userId);
        if (existing) { cleanupBoost(existing); dmBoosts.current.delete(p.userId); }
        return;
      }

      const vol = (participantVolumes[p.userId] ?? 0.5) * speakerVolume;
      applyVolume(el, dmBoosts.current, p.userId, p.stream ?? null, vol, speakerId);

      if (p.stream && p.stream.getAudioTracks().length > 0 && el.paused) {
        el.play().catch(() => {});
        timeouts.push(setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 200));
        timeouts.push(setTimeout(() => { if (el.paused) el.play().catch(() => {}); }, 1000));
      }
    });
    return () => timeouts.forEach((t) => clearTimeout(t));
  // isPoppedOut: view-mode transitions can remount audio elements, so re-apply srcObject
  }, [remoteParticipants, participantVolumes, audioDeafened, speakerVolume, speakerId, isPoppedOut]);

  // Re-apply srcObject after view-mode transitions that remount audio elements.
  // The main effect above won't re-run if remoteParticipants hasn't changed, but
  // the audio DOM elements may be new (different tree position in React).
  useLayoutEffect(() => {
    remoteParticipants.forEach((p) => {
      const el = remoteAudioRefs.current.get(p.userId);
      if (el && p.stream && el.srcObject !== p.stream) {
        el.srcObject = p.stream;
        el.play().catch(() => {});
      }
    });
  });

  useEffect(() => () => {
    dmBoosts.current.forEach((e) => cleanupBoost(e));
    dmBoosts.current.clear();
  }, []);

  // Auto-stop watching any screen shares that become unavailable.
  useEffect(() => {
    if (watchingScreenShareUserId.size === 0) return;
    const stale: string[] = [];
    for (const id of watchingScreenShareUserId) {
      const p = remoteParticipants.find((r) => r.userId === id);
      if (!p?.screenShareAvailable && !p?.screenStream) stale.push(id);
    }
    if (stale.length === 0) return;
    for (const id of stale) disableRemoteScreen?.(id);
    setWatchingScreenShareUserId((prev) => {
      const next = new Set(prev);
      for (const id of stale) next.delete(id);
      return next;
    });
  }, [watchingScreenShareUserId, remoteParticipants, disableRemoteScreen]);

  // Auto-close focused screen overlay when stream disappears
  useEffect(() => {
    if (!focusedScreenKey) return;
    if (focusedScreenKey === 'self-screen') {
      if (!screenStream) setFocusedScreenKey(null);
    } else {
      const uid = focusedScreenKey.replace('screen-', '');
      const p = remoteParticipants.find((r) => r.userId === uid);
      if (!p?.screenStream) setFocusedScreenKey(null);
    }
  }, [focusedScreenKey, screenStream, remoteParticipants]);

  // Auto-clear focused participant when they leave
  useEffect(() => {
    if (focusedParticipantUserId && focusedParticipantUserId !== 'self' && !remoteParticipants.some(r => r.userId === focusedParticipantUserId)) {
      setFocusedParticipantUserId(null);
    }
  }, [focusedParticipantUserId, remoteParticipants]);

  // Card sizing helpers
  const totalParticipants = 1 + remoteParticipants.length;
  const { getCardSize, startResize, draggingCardRef, CARD_MIN_W, CARD_MIN_H } = useCardResize({ participantCount: totalParticipants, isMobile, isTablet });

  const gridGap = isMobile ? 'gap-2' : isTablet ? 'gap-3' : (totalParticipants <= 2 ? 'gap-4' : totalParticipants <= 4 ? 'gap-3' : 'gap-2');

  /** Card sizing style — stretched to grid cell width on mobile/tablet, explicit dimensions on desktop. */
  const cardStyle = useCallback((key: string): React.CSSProperties => {
    const size = getCardSize(key);
    if (isMobile || isTablet) return { width: '100%', height: size.h };
    return { width: size.w, height: size.h, minWidth: CARD_MIN_W, minHeight: CARD_MIN_H };
  }, [getCardSize, isMobile, isTablet, CARD_MIN_W, CARD_MIN_H]);

  const showInline = callMode === 'inline' || callMode === 'panel-fullscreen';
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!showInline || !inlinePortalTargetId) { setPortalTarget(null); return; }
    const tryFind = () => document.getElementById(inlinePortalTargetId!) || null;
    setPortalTarget(tryFind());
    const raf = requestAnimationFrame(() => setPortalTarget(tryFind()));
    return () => cancelAnimationFrame(raf);
  }, [showInline, inlinePortalTargetId]);

  const declinedIds = new Set(declinedUserIds);
  const [animatingDeclineIds, setAnimatingDeclineIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (declinedUserIds.length === 0) return;
    const newAnimating = new Set(declinedUserIds);
    setAnimatingDeclineIds(newAnimating);
    const t = setTimeout(() => setAnimatingDeclineIds(new Set()), 600);
    return () => clearTimeout(t);
  }, [declinedUserIds]);

  // Inline uses the same getCardSize / startResize / cardSizes as expanded view
  const inlineGridGap = isMobile ? 'gap-2' : isTablet ? 'gap-2' : (totalParticipants <= 2 ? 'gap-3' : totalParticipants <= 4 ? 'gap-2' : 'gap-2');

  /** Responsive layout class for the participant grid:
   *  mobile → single column; tablet → 2 columns for ≤4, stack otherwise; desktop → flex-wrap. */
  const participantGridLayout = (gap: string, padding: string): string => {
    const stack = `flex flex-col items-stretch ${gap} ${padding}`;
    if (isMobile) return stack;
    if (isTablet) return totalParticipants <= 4 ? `grid grid-cols-2 ${gap} ${padding}` : stack;
    return `flex flex-wrap ${gap} ${padding}`;
  };

  /** Render a participant's username with role color + Pro-only name styling, mirroring ChatArea/VoiceChannel usage. */
  const renderParticipantName = (p: DMCallParticipant, className: string) => {
    const isPro = p.effectivePlan === 'pro';
    const hasStyling = p.roleColor || (isPro && (p.nameColor || p.nameFont || p.nameEffect));
    if (!hasStyling) return p.username;
    return (
      <RoleNameStyle
        name={p.username}
        color={p.roleColor}
        style={(p.roleStyle as RoleStyle | undefined) ?? 'solid'}
        overrideColor={isPro ? p.nameColor : undefined}
        overrideFont={isPro ? p.nameFont : undefined}
        nameEffect={isPro ? p.nameEffect : undefined}
        className={className}
      />
    );
  };

  /** Mobile-only corner button that maximizes a tile — replaces desktop hover overlay. */
  const renderMobileMaximizeButton = (onMaximize: () => void) => (
    <button type="button" onClick={(e) => { e.stopPropagation(); onMaximize(); }} className="absolute top-2 right-2 w-9 h-9 rounded-full bg-black/50 backdrop-blur-sm flex items-center justify-center z-[6]" aria-label={t('voiceCall.maximize', 'Maximize')}>
      <Maximize2 size={16} className="text-white/90" />
    </button>
  );

  const focusedScreenOverlay = focusedScreenKey ? (
    <FocusedScreenOverlay
      focusedScreenKey={focusedScreenKey}
      screenStream={screenStream}
      remoteParticipants={remoteParticipants}
      onClose={() => setFocusedScreenKey(null)}
      isDeafened={audioDeafened}
      speakerVolume={speakerVolume}
      speakerId={speakerId}
      streamContext={{ kind: 'dm', scopeId: dmChannelId }}
      selfUserId={currentUser?.id}
    />
  ) : null;

  const focusedParticipantOverlay = focusedParticipantUserId ? (() => {
    const isSelfFocused = focusedParticipantUserId === 'self';
    const focusedRemote = isSelfFocused ? null : remoteParticipants.find(r => r.userId === focusedParticipantUserId);
    if (!isSelfFocused && !focusedRemote) return null;

    const focusedName = isSelfFocused ? currentUser.username : (focusedRemote!.username ?? 'Unknown');
    const focusedAvatar = isSelfFocused ? (currentUser.avatar ?? null) : (focusedRemote!.avatar ?? null);
    const focusedAvatarEffect = isSelfFocused ? (currentUser as { avatarEffect?: string | null }).avatarEffect : (focusedRemote as { avatarEffect?: string | null } | null)?.avatarEffect;
    const focusedEffectivePlan = isSelfFocused ? (currentUser as { effectivePlan?: string | null }).effectivePlan : (focusedRemote as { effectivePlan?: string | null } | null)?.effectivePlan;
    const focusedStream = isSelfFocused ? (cameraStream ?? screenStream) : (focusedRemote!.cameraStream ?? focusedRemote!.screenStream ?? null);
    const focusedBannerUrl = isSelfFocused ? ((currentUser as any).banner ?? null) : (focusedRemote!.banner ?? null);
    const focusedBannerPositionY = isSelfFocused ? (currentUser as any).bannerPositionY : focusedRemote?.bannerPositionY;
    const focusedBannerZoom = isSelfFocused ? (currentUser as any).bannerZoom : focusedRemote?.bannerZoom;

    const sideEntries: Array<{ id: string; name: string; avatar: string | null; avatarEffect?: string | null; effectivePlan?: string | null; stream: MediaStream | null; isSelf: boolean }> = [];
    sideEntries.push({ id: 'self', name: currentUser.username, avatar: currentUser.avatar ?? null, avatarEffect: (currentUser as { avatarEffect?: string | null }).avatarEffect, effectivePlan: (currentUser as { effectivePlan?: string | null }).effectivePlan, stream: cameraStream ?? null, isSelf: true });
    for (const r of remoteParticipants) {
      sideEntries.push({ id: r.userId, name: r.username, avatar: r.avatar ?? null, avatarEffect: (r as { avatarEffect?: string | null }).avatarEffect, effectivePlan: (r as { effectivePlan?: string | null }).effectivePlan, stream: r.cameraStream ?? r.screenStream ?? null, isSelf: false });
    }

    const closeBtn = (
      <button type="button" onClick={() => setFocusedParticipantUserId(null)} className="absolute top-4 right-4 z-50 p-2.5 rounded-full bg-black/50 hover:bg-black/70 text-white/80 hover:text-white transition-all backdrop-blur-sm" aria-label={t('common.close')}>
        <X size={20} />
      </button>
    );

    return (
      <div className="absolute inset-0 z-[var(--z-modal)] flex gap-2 p-3 bg-[var(--bg-app)]/95 backdrop-blur-xl animate-in fade-in duration-200">
        {closeBtn}
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
          <div className="absolute bottom-0 left-0 right-0 px-4 pt-3 flex items-center gap-3 bg-[var(--glass-bg)] backdrop-blur-sm z-10" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}>
            <UserAvatar user={{ avatar: focusedAvatar, username: focusedName, avatarEffect: focusedAvatarEffect, effectivePlan: focusedEffectivePlan }} size={28} />
            <span className="font-bold text-sm text-[var(--text-primary)] truncate">{focusedName}</span>
            <button type="button" onClick={() => setFocusedParticipantUserId(null)} className="ml-auto p-2 rounded-full hover:bg-[var(--fill-hover)] text-[var(--text-secondary)] transition-colors" aria-label={t('common.close')}>
              <X size={18} />
            </button>
          </div>
        </div>
        {!isMobile && sideEntries.length > 1 && (
          <div className="w-20 md:w-28 shrink-0 flex flex-col gap-2 overflow-y-auto">
            {sideEntries.filter(e => e.id !== focusedParticipantUserId).map((e) => (
              <button key={e.id} type="button" onClick={() => setFocusedParticipantUserId(e.id)} className="w-full aspect-[16/10] rounded-lg overflow-hidden relative border border-default hover:border-[var(--cyan-accent)]/30 transition-colors shrink-0">
                {e.stream ? (
                  <RemoteCameraVideo stream={e.stream} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]" />
                )}
                <div className="absolute bottom-0 left-0 right-0 px-1.5 py-1 bg-black/60 flex items-center gap-1">
                  <UserAvatar user={{ avatar: e.avatar, username: e.name, avatarEffect: e.avatarEffect, effectivePlan: e.effectivePlan }} size={14} />
                  <span className="text-[10px] font-bold truncate text-white/80">{e.name}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  })() : null;

  // Own Pro name styling for the self card — uses the effectivePlan→stripePlan
  // fallback via the shared resolver (previously gated on effectivePlan only).
  const selfProNameStyle = resolveProNameStyle(currentUser as unknown as NameCustomizable);

  /** Render self participant card — 'calling' for pre-connect, 'in-call' for connected */
  const renderSelfCard = (mode: 'calling' | 'in-call') => (
    <div data-card-resize-wrapper className={`relative flex-shrink-0 ${draggingCardRef.current?.key === 'self' ? '' : 'transition-all duration-300'}`} style={cardStyle('self')}>
      <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
        {isCameraOn && cameraStream ? (
          <>
          <div className="flex-1 min-h-0 relative overflow-hidden" onClick={isMobile ? () => setFocusedParticipantUserId('self') : undefined}>
            <video ref={setCameraVideoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />
            {!isMobile && (
              <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5]" onClick={() => setFocusedParticipantUserId('self')}>
                <div className="w-12 h-12 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center">
                  <Maximize2 size={20} className="text-white/90" />
                </div>
              </div>
            )}
            {isMobile && renderMobileMaximizeButton(() => setFocusedParticipantUserId('self'))}
          </div>
            <ParticipantCardFooter
              avatar={currentUser.avatar}
              username={currentUser.username}
              effectivePlan={(currentUser as any).effectivePlan}
              avatarEffect={(currentUser as any).avatarEffect}
              nameNode={selfProNameStyle
                ? <RoleNameStyle name={currentUser.username} {...selfProNameStyle} />
                : currentUser.username}
              stream={isMuted ? null : localStream}
              isMuted={isMuted}
              isDeafened={isDeafened}
              connectionState={mode === 'calling' ? 'calling' : 'connected'}
              isScreenSharing={isScreenSharing}
              mobileSafeArea
              rightActions={isScreenSharing ? (
                showSelfScreenPreview
                  ? <button type="button" onClick={() => setShowSelfScreenPreview(false)} className="flex items-center justify-center gap-1 px-2 py-0.5 max-md:min-w-[44px] max-md:min-h-[44px] rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--danger-muted)] text-[var(--danger)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] border border-[var(--danger)]/30 transition-all" title={t('voice.hidePreview')}><X size={11} /> {t('voice.hideLabel')}</button>
                  : <button type="button" onClick={() => setShowSelfScreenPreview(true)} className="flex items-center justify-center gap-1 px-2 py-0.5 max-md:min-w-[44px] max-md:min-h-[44px] rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-subtle)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.showPreview')}><Monitor size={11} /> {t('voice.watch')}</button>
              ) : undefined}
            />
          </>
        ) : (
          <div className="absolute inset-0 rounded-2xl overflow-hidden">
            <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">{currentUser.banner && <LazyGif src={sanitizeImgSrc(currentUser.banner)} frameSrc={getFrameUrl(currentUser.banner)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${(currentUser as any).bannerPositionY ?? 50}%`, ...((currentUser as any).bannerZoom && (currentUser as any).bannerZoom > 100 ? { transform: `scale(${(currentUser as any).bannerZoom / 100})`, transformOrigin: `center ${(currentUser as any).bannerPositionY ?? 50}%` } : {}) }} />}</div>
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
            <ParticipantCardFooter
              avatar={currentUser.avatar}
              username={currentUser.username}
              effectivePlan={(currentUser as any).effectivePlan}
              avatarEffect={(currentUser as any).avatarEffect}
              nameNode={selfProNameStyle
                ? <RoleNameStyle name={currentUser.username} {...selfProNameStyle} />
                : currentUser.username}
              stream={isMuted ? null : localStream}
              isMuted={isMuted}
              isDeafened={isDeafened}
              connectionState={mode === 'calling' ? 'calling' : 'connected'}
              isScreenSharing={isScreenSharing}
              mobileSafeArea
              rightActions={isScreenSharing ? (
                showSelfScreenPreview
                  ? <button type="button" onClick={() => setShowSelfScreenPreview(false)} className="flex items-center justify-center gap-1 px-2 py-0.5 max-md:min-w-[44px] max-md:min-h-[44px] rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--danger-muted)] text-[var(--danger)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] border border-[var(--danger)]/30 transition-all" title={t('voice.hidePreview')}><X size={11} /> {t('voice.hideLabel')}</button>
                  : <button type="button" onClick={() => setShowSelfScreenPreview(true)} className="flex items-center justify-center gap-1 px-2 py-0.5 max-md:min-w-[44px] max-md:min-h-[44px] rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-subtle)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.showPreview')}><Monitor size={11} /> {t('voice.watch')}</button>
              ) : undefined}
            />
          </div>
        )}
      </div>
      <div role="button" tabIndex={0} onMouseDown={(e) => startResize('self', e)} className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--cyan-accent)]/20 border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30" aria-label={t('voiceCall.resizeCard')}><span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span></div>
    </div>
  );

  /** Render a remote participant card + optional screen share card */
  const renderRemoteCard = (p: DMCallParticipant) => {
    const hasCamera = p.cameraStream?.getVideoTracks().some((t) => t.readyState === 'live');
    const vol = participantVolumes[p.userId] ?? 0.5;
    const isWatchingThisScreen = watchingScreenShareUserId.has(p.userId) && p.screenStream;
    return (
      <>
        <div data-card-resize-wrapper className={`relative flex-shrink-0 ${draggingCardRef.current?.key === p.userId ? '' : 'transition-all duration-300'}`} style={cardStyle(p.userId)}>
          <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
            {hasCamera ? (
              <>
              <div className="flex-1 min-h-0 relative overflow-hidden" onClick={isMobile ? () => setFocusedParticipantUserId(p.userId) : undefined}>
                <RemoteCameraVideo stream={p.cameraStream!} />
                <div className="absolute inset-0 bg-gradient-to-t from-black/50 to-transparent pointer-events-none" />
                {!isMobile && (
                <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5]" onClick={() => setFocusedParticipantUserId(p.userId)}>
                  <div className="w-12 h-12 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center">
                    <Maximize2 size={20} className="text-white/90" />
                  </div>
                </div>
                )}
                {isMobile && renderMobileMaximizeButton(() => setFocusedParticipantUserId(p.userId))}
              </div>
                <ParticipantCardFooter
                  avatar={p.avatar}
                  username={p.username}
                  effectivePlan={p.effectivePlan as any}
                  avatarEffect={p.avatarEffect}
                  nameNode={renderParticipantName(p, 'text-xs font-bold truncate')}
                  stream={p.stream}
                  isMuted={p.isMuted}
                  isDeafened={p.isDeafened}
                  connectionState={p.stream ? 'connected' : 'connecting'}
                  mobileSafeArea
                  rightActions={
                    <>
                      {onParticipantVolumeChange && (
                        <VolumeControl userId={p.userId} username={p.username} volume={vol} onChange={onParticipantVolumeChange} />
                      )}
                      {p.screenShareAvailable && (
                        watchingScreenShareUserId.has(p.userId)
                          ? <button type="button" onClick={() => { disableRemoteScreen?.(p.userId); stopWatching(p.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--danger-muted)] text-[var(--danger)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] border border-[var(--danger)]/30 transition-all" title={t('voice.stopWatching')}><X size={11} /> {t('voice.stop')}</button>
                          : <button type="button" onClick={() => { enableRemoteScreen?.(p.userId); startWatching(p.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-subtle)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.watchScreenShare')}><Monitor size={11} /> {t('voice.watch')}</button>
                      )}
                    </>
                  }
                />
              </>
            ) : (
              <div className="absolute inset-0 rounded-2xl overflow-hidden">
                <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">{p.banner ? <LazyGif src={sanitizeImgSrc(p.banner!)} frameSrc={getFrameUrl(p.banner)} alt="" className="absolute inset-0 w-full h-full object-cover opacity-95" style={{ objectPosition: `center ${p.bannerPositionY ?? 50}%`, ...(p.bannerZoom && p.bannerZoom > 100 ? { transform: `scale(${p.bannerZoom / 100})`, transformOrigin: `center ${p.bannerPositionY ?? 50}%` } : {}) }} /> : null}</div>
                <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                <ParticipantCardFooter
                  avatar={p.avatar}
                  username={p.username}
                  effectivePlan={p.effectivePlan as any}
                  avatarEffect={p.avatarEffect}
                  nameNode={renderParticipantName(p, 'text-xs font-bold truncate')}
                  stream={p.stream}
                  isMuted={p.isMuted}
                  isDeafened={p.isDeafened}
                  connectionState={p.stream ? 'connected' : 'connecting'}
                  mobileSafeArea
                  rightActions={
                    <>
                      {onParticipantVolumeChange && (
                        <VolumeControl userId={p.userId} username={p.username} volume={vol} onChange={onParticipantVolumeChange} />
                      )}
                      {p.screenShareAvailable && (
                        watchingScreenShareUserId.has(p.userId)
                          ? <button type="button" onClick={() => { disableRemoteScreen?.(p.userId); stopWatching(p.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--danger-muted)] text-[var(--danger)] hover:bg-[var(--danger-muted)] hover:text-[var(--danger)] border border-[var(--danger)]/30 transition-all" title={t('voice.stopWatching')}><X size={11} /> {t('voice.stop')}</button>
                          : <button type="button" onClick={() => { enableRemoteScreen?.(p.userId); startWatching(p.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--success-subtle)] text-[var(--success)] hover:bg-[var(--success-subtle)] hover:text-[var(--success)] border border-[var(--success)]/30 transition-all" title={t('voice.watchScreenShare')}><Monitor size={11} /> {t('voice.watch')}</button>
                      )}
                    </>
                  }
                />
              </div>
            )}
          </div>
          <div role="button" tabIndex={0} onMouseDown={(e) => startResize(p.userId, e)} className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--cyan-accent)]/20 border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30" aria-label={t('voiceCall.resizeCard')}><span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span></div>
        </div>
        {/* Remote screen share card */}
        {isWatchingThisScreen && renderScreenShareCard(
          `screen-${p.userId}`,
          p.screenStream!,
          t('voice.usernameScreen', { username: p.username }),
          () => setFocusedScreenKey(`screen-${p.userId}`),
          <button type="button" onClick={() => { disableRemoteScreen?.(p.userId); stopWatching(p.userId); }} className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-[var(--danger-muted)] text-[var(--danger)] hover:bg-[var(--danger-muted)] border border-[var(--danger)]/30 transition-all" title={t('voice.stopWatching')}><X size={11} /> {t('voice.stop')}</button>,
          { screenShareAudioStream: p.screenShareAudioStream, userId: p.userId, username: p.username },
        )}
      </>
    );
  };

  /** Render a screen share card with ScreenShareCard component */
  const renderScreenShareCard = (key: string, stream: MediaStream, label: string, onMaximize: () => void, extraButtons?: React.ReactNode, audioProps?: { screenShareAudioStream?: MediaStream | null; userId?: string; username?: string }) => (
    <div data-card-resize-wrapper className={`relative flex-shrink-0 ${draggingCardRef.current?.key === key ? '' : 'transition-all duration-300'}`} style={cardStyle(key)}>
      <div className="w-full h-full relative bg-black border border-[var(--glass-border)] rounded-2xl overflow-hidden group/card flex flex-col">
        <div className="flex-1 min-h-0 relative" onClick={isMobile ? onMaximize : undefined}>
          <ScreenShareCard
            stream={stream}
            screenShareAudioStream={audioProps?.screenShareAudioStream}
            userId={audioProps?.userId}
            username={audioProps?.username}
            isDeafened={audioDeafened}
            speakerVolume={speakerVolume}
            speakerId={speakerId}
            streamContext={{ kind: 'dm', scopeId: dmChannelId }}
            selfUserId={currentUser?.id}
          />
          {!isMobile && (
          <div className="absolute inset-0 bg-black/40 opacity-0 group-hover/card:opacity-100 transition-opacity duration-200 cursor-pointer flex items-center justify-center z-[5] rounded-t-2xl" onClick={onMaximize}>
            <div className="w-10 h-10 rounded-full bg-white/15 backdrop-blur-sm flex items-center justify-center">
              <Maximize2 size={18} className="text-white/90" />
            </div>
          </div>
          )}
          {isMobile && renderMobileMaximizeButton(onMaximize)}
        </div>
        <div className="px-3 py-2.5 flex items-center justify-between gap-2 bg-[var(--glass-bg)] backdrop-blur-sm shrink-0 min-h-[60px]">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-6 h-6 rounded-lg bg-[var(--success)] flex items-center justify-center shrink-0"><Monitor size={13} className="text-black" /></div>
            <span className="text-xs text-[var(--text-primary)] font-bold truncate">{label}</span>
            <div className="w-1.5 h-1.5 bg-[var(--success)] rounded-full animate-pulse shrink-0" />
          </div>
          <div className="flex items-center gap-1.5">
            {audioProps?.userId && audioProps?.screenShareAudioStream && (
              <ScreenShareVolumeControls
                userId={audioProps.userId}
                username={audioProps.username ?? 'user'}
                hasAudio={!!(audioProps.screenShareAudioStream.getAudioTracks().length > 0)}
              />
            )}
            {extraButtons}
          </div>
        </div>
      </div>
      <div role="button" tabIndex={0} onMouseDown={(e) => startResize(key, e)} className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--success-subtle)] border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30" aria-label={t('voiceCall.resizeCard')}><span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span></div>
    </div>
  );

  /** Render the card grid content — shared across all surfaces */
  const renderCardGrid = (layoutMode: 'compact' | 'immersive') => {
    const gap = layoutMode === 'compact' ? inlineGridGap : gridGap;
    return (
      <div className="relative h-full w-full">
        {isCalling ? (
          <div className="flex flex-col items-center gap-3 py-4">
            <div className={`${participantGridLayout(gap, 'px-4')} justify-center`}>
              {renderSelfCard('calling')}
              {otherUsers.filter((u) => !declinedIds.has(u.id)).map((u) => {
                const uIsPro = u.effectivePlan === 'pro';
                const uHasStyling = uIsPro && (u.nameColor || u.nameFont || u.nameEffect);
                const uNameNode = uHasStyling ? (
                  <RoleNameStyle
                    name={u.username}
                    overrideColor={u.nameColor ?? undefined}
                    overrideFont={u.nameFont ?? undefined}
                    nameEffect={u.nameEffect ?? undefined}
                    className="text-xs font-bold truncate"
                  />
                ) : u.username;
                return (
                <div key={`calling-${u.id}`} data-card-resize-wrapper className={`relative flex-shrink-0 ${draggingCardRef.current?.key === u.id ? '' : 'transition-all duration-300'}`} style={cardStyle(u.id)}>
                  <div className="w-full h-full relative bg-[var(--bg-panel)] border border-[var(--glass-border)] rounded-2xl overflow-hidden">
                    <div className="absolute inset-0 rounded-2xl overflow-hidden">
                      <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]" />
                      {u.banner ? (
                        <LazyGif
                          src={sanitizeImgSrc(u.banner)}
                          frameSrc={getFrameUrl(u.banner)}
                          alt=""
                          className="absolute inset-0 w-full h-full object-cover opacity-95"
                          style={{
                            objectPosition: `center ${u.bannerPositionY ?? 50}%`,
                            ...(u.bannerZoom && u.bannerZoom > 100
                              ? { transform: `scale(${u.bannerZoom / 100})`, transformOrigin: `center ${u.bannerPositionY ?? 50}%` }
                              : {}),
                          }}
                        />
                      ) : null}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
                    </div>
                    <ParticipantCardFooter
                      avatar={u.avatar ?? null}
                      username={u.username}
                      effectivePlan={(u.effectivePlan ?? undefined) as PlanTier | undefined}
                      avatarEffect={u.avatarEffect}
                      nameNode={uNameNode}
                      stream={null}
                      connectionState="ringing"
                      mobileSafeArea
                    />
                  </div>
                  <div role="button" tabIndex={0} onMouseDown={(e) => startResize(u.id, e)} className="absolute bottom-0 right-0 w-6 h-6 cursor-se-resize rounded-tl-lg bg-[var(--fill-hover)] hover:bg-[var(--cyan-accent)]/20 border border-[var(--glass-border)] border-b-0 border-r-0 flex items-end justify-end p-0.5 z-30" aria-label={t('voiceCall.resizeCard')}><span className="text-[var(--text-secondary)] text-[10px] leading-none">⋰</span></div>
                </div>
                );
              })}
              {otherUsers.filter((u) => animatingDeclineIds.has(u.id)).map((u) => (
                <div key={`declined-${u.id}`} className="relative flex-shrink-0 transition-all duration-500 ease-in-out opacity-0 scale-75 pointer-events-none" style={{ width: getCardSize(u.id).w, height: getCardSize(u.id).h, minWidth: 0, minHeight: 0 }}>
                  <div className="w-full h-full relative bg-[var(--danger-muted)] border border-[var(--danger)]/20 rounded-2xl overflow-hidden">
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
                      <PhoneOff size={20} className="text-[var(--danger)]/60" />
                      <span className="text-[10px] text-[var(--danger)]/60 font-bold">{t('voiceCall.declined')}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <span className="text-[var(--text-primary)]/30 text-[10px] uppercase tracking-wider font-bold">{t('voiceCall.calling', { displayName })}</span>
          </div>
        ) : (
          <div className={`${participantGridLayout(gap, layoutMode === 'compact' ? 'px-4 py-3' : '')} content-start justify-center`}>
            {renderSelfCard('in-call')}
            {isScreenSharing && screenStream && showSelfScreenPreview && renderScreenShareCard('self-screen', screenStream, t('voice.yourScreen'), () => setFocusedScreenKey('self-screen'), undefined, { userId: currentUser?.id })}
            {remoteParticipants.map((p) => <React.Fragment key={`grid-${p.userId}`}>{renderRemoteCard(p)}</React.Fragment>)}
            {Array.from(animatingDeclineIds).map((uid) => {
              const u = otherUsers.find((ou) => ou.id === uid) || remoteParticipants.find((rp) => rp.userId === uid);
              if (!u) return null;
              const name = 'username' in u ? u.username : '';
              return (
                <div key={`declined-${uid}`} className="relative flex-shrink-0 transition-all duration-500 ease-in-out opacity-0 scale-75 pointer-events-none" style={{ width: getCardSize(uid).w, height: getCardSize(uid).h }}>
                  <div className="w-full h-full relative bg-[var(--danger-muted)] border border-[var(--danger)]/20 rounded-2xl overflow-hidden flex flex-col items-center justify-center gap-1">
                    <PhoneOff size={20} className="text-[var(--danger)]/60" />
                    <span className="text-[10px] text-[var(--danger)]/60 font-bold">{t('voiceCall.nameLeft', { name })}</span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
        {/* Focused overlays sit inside the grid container */}
        {focusedScreenOverlay}
        {focusedParticipantOverlay}
      </div>
    );
  };

  /** E2EE status badges + live call duration timer. Rendered in every control
   *  bar (inline, fullscreen, popout) so the duration is always visible. */
  const e2eeBadges = (
    <>
      {isE2ee && (
        <span className="flex items-center gap-1 text-emerald-400 mr-1" title={callKeyMode === 'mls'
          ? t('voiceCall.e2eeActiveMls', 'End-to-end encrypted with forward secrecy (MLS)')
          : t('voiceCall.e2eeActive', 'End-to-end encrypted')}>
          <ShieldCheck size={14} />
        </span>
      )}
      {isE2eeEstablishing && (
        <span className="flex items-center gap-1 text-amber-400 mr-1" title={t('voiceCall.e2eeEstablishing', 'Establishing end-to-end encryption. Waiting for the other side to confirm')}>
          <ShieldEllipsis size={14} />
        </span>
      )}
      {isE2eeFailed && (
        <span className="flex items-center gap-1 text-amber-400 mr-1" title={t('voiceCall.e2eeFailed', 'Not end-to-end encrypted. Key exchange failed')}>
          <ShieldAlert size={14} />
        </span>
      )}
      {isE2eeBlocked && (
        <span className="flex items-center gap-1 text-red-400 mr-1" title={peerUnprovisionedCall
          ? t('voiceCall.peerUnprovisioned', { name: callPeerName, defaultValue: 'Waiting for {{name}} to enable encryption' })
          : t('voiceCall.e2eeBlocked', 'Call blocked: end-to-end encryption could not be established')}>
          <ShieldX size={14} />
        </span>
      )}
      {durationLabel && (
        <span
          className="text-[11px] font-semibold tabular-nums text-[var(--text-secondary)] mr-1"
          aria-label={t('voiceCall.callDuration', 'Call duration')}
        >
          {durationLabel}
        </span>
      )}
    </>
  );

  /** Inline / panel-fullscreen control bar */
  const inlineControls = (
    <div className="flex items-center justify-center gap-1.5 px-4 pb-3 pt-1">
      {e2eeBadges}
      <CallControlBar
        isMuted={isMuted}
        isDeafened={isDeafened}
        isCameraOn={isCameraOn}
        isScreenSharing={isScreenSharing}
        isMobile={isMobile}
        onToggleMute={handleToggleMute}
        onToggleDeafen={onToggleDeafen}
        onToggleCamera={handleToggleCamera}
        onToggleScreenShare={toggleScreenShareDM}
        onOpenScreenShareSettings={openScreenShareSettings}
        onExpandOrCollapse={() => {
          prevNonImmersiveModeRef.current = callMode;
          setCallMode('fullscreen');
        }}
        onOpenPopout={openPopout}
        onLeave={terminateConnection}
        micSilenceState={micSilence.state}
      />
    </div>
  );

  /** Fullscreen control bar */
  const fullscreenControls = (
    <div className="w-full shrink-0 mt-4">
      {e2eeBadges}
      <CallControlBar
        isMuted={isMuted}
        isDeafened={isDeafened}
        isCameraOn={isCameraOn}
        isScreenSharing={isScreenSharing}
        isFullscreen={true}
        isMobile={isMobile}
        onToggleMute={handleToggleMute}
        onToggleDeafen={onToggleDeafen}
        onToggleCamera={handleToggleCamera}
        onToggleScreenShare={toggleScreenShareDM}
        onOpenScreenShareSettings={openScreenShareSettings}
        onToggleFullscreen={() => setCallMode(prevNonImmersiveModeRef.current)}
        onOpenPopout={openPopout}
        onLeave={terminateConnection}
        micSilenceState={micSilence.state}
      />
    </div>
  );

  /** Popout control bar */
  const popoutControls = (
    <div className="w-full shrink-0 mt-4">
      {e2eeBadges}
      <CallControlBar
        isMuted={isMuted}
        isDeafened={isDeafened}
        isCameraOn={isCameraOn}
        isScreenSharing={isScreenSharing}
        isPoppedOut={true}
        isMobile={isMobile}
        onToggleMute={handleToggleMute}
        onToggleDeafen={onToggleDeafen}
        onToggleCamera={handleToggleCamera}
        onToggleScreenShare={toggleScreenShareDM}
        onOpenScreenShareSettings={openScreenShareSettings}
        onClosePopout={() => { closePopout(); setCallMode(prevNonImmersiveModeRef.current); }}
        onLeave={terminateConnection}
        micSilenceState={micSilence.state}
      />
    </div>
  );

  const screenSharePickerNode = !isMobile && showScreenSharePicker ? (
    <ScreenSharePicker
      onConfirm={(q) => {
        if (isScreenSharing) {
          screenStream?.getTracks().forEach((t) => t.stop());
          setScreenStream(null);
          setIsScreenSharing(false);
          setTimeout(() => startScreenShareWithQuality(q), 100);
        } else {
          startScreenShareWithQuality(q);
        }
      }}
      onChangeSource={(q) => {
        screenStream?.getTracks().forEach((t) => t.stop());
        setScreenStream(null);
        setIsScreenSharing(false);
        setShowScreenSharePicker(false);
        setTimeout(() => startScreenShareWithQuality(q), 100);
      }}
      onCancel={() => setShowScreenSharePicker(false)}
      userPlan={userPlan}
      currentQuality={screenShareQuality}
      isSharing={isScreenSharing}
      screenShareCodec={screenShareCodec}
      onCodecChange={onCodecChange}
    />
  ) : null;

  // Persistent audio elements — always rendered so they survive view-mode transitions
  // (inline ↔ expanded ↔ popout ↔ navigated-away). Mirrors VoiceRemoteAudio pattern.
  const persistentAudio = (
    <div className="sr-only" aria-hidden>
      {remoteParticipants.map((p) => (
        <audio
          key={`audio-${p.userId}`}
          ref={(el) => { if (el) remoteAudioRefs.current.set(p.userId, el); else remoteAudioRefs.current.delete(p.userId); }}
          autoPlay playsInline
        />
      ))}
    </div>
  );

  if (error) {
    return (
      <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center" style={{ backgroundColor: 'var(--bg-app)' }}>
        <div className="flex flex-col items-center gap-4 p-8 rounded-2xl bg-[var(--danger-muted)] border border-[var(--danger)]/20 max-w-sm text-center spring-pop-in">
          <div className="w-12 h-12 rounded-full bg-[var(--danger-muted)] flex items-center justify-center">
            <PhoneOff size={24} className="text-[var(--danger)]" />
          </div>
          <p className="text-[var(--danger)] text-sm font-semibold">{error}</p>
          <div className="w-24 h-1 rounded-full bg-fill-active overflow-hidden">
            <div className="h-full bg-red-400/60 rounded-full animate-[shrink_3s_linear_forwards]" style={{ animation: 'shrink 3s linear forwards' }} />
          </div>
        </div>
        <style>{`@keyframes shrink { from { width: 100%; } to { width: 0%; } }`}</style>
      </div>
    );
  }

  const cameraPreviewModal = (
    <CameraPreviewModal
      open={showCameraPreview}
      selectedDeviceId={voiceSettings.selectedCameraId}
      alwaysPreview={voiceSettings.cameraPreviewModal}
      videoBackgroundMode={voiceSettings.videoBackgroundMode}
      onClose={() => setShowCameraPreview(false)}
      onConfirm={() => {
        setShowCameraPreview(false);
        setIsCameraOn(true);
      }}
      onDeviceChange={(id) => updateVoice({ selectedCameraId: id })}
      onAlwaysPreviewChange={(v) => updateVoice({ cameraPreviewModal: v })}
      onVideoBackgroundModeChange={(mode) => updateVoice({ videoBackgroundMode: mode })}
      onOpenVideoSettings={() => {
        setShowCameraPreview(false);
        useNavigationStore.getState().setAccountDeepLink({ page: 'voice-video' });
        navigate('/settings');
      }}
    />
  );

  // RENDERING
  // Inline + panel-fullscreen: portal into #dm-call-inline-target via InlineCallSurface
  if (showInline) {
    const inlineSurface = (
      <InlineCallSurface
        mode={callMode as 'inline' | 'panel-fullscreen'}
        onChevronToggle={() => setCallMode(callMode === 'inline' ? 'panel-fullscreen' : 'inline')}
        controls={inlineControls}
        isMobile={isMobile}
      >
        <InCallBluetoothBanner onRequestMicSwitch={switchMicDevice} />
        {micSilence.state === 'banner' && <MicSilenceBanner onDismiss={micSilence.dismiss} />}
        {renderCardGrid('compact')}
        {screenSharePickerNode}
      </InlineCallSurface>
    );
    if (portalTarget) return <>{createPortal(inlineSurface, portalTarget)}{persistentAudio}{cameraPreviewModal}</>;
    return <>{persistentAudio}{cameraPreviewModal}</>;
  }

  // Fullscreen: render ImmersiveCallSurface directly (it is fixed inset-0)
  if (callMode === 'fullscreen') {
    return (
      <>
        <ImmersiveCallSurface mode="fullscreen" controls={fullscreenControls}>
          <InCallBluetoothBanner onRequestMicSwitch={switchMicDevice} />
          {micSilence.state === 'banner' && <MicSilenceBanner onDismiss={micSilence.dismiss} />}
          {renderCardGrid('immersive')}
          {screenSharePickerNode}
        </ImmersiveCallSurface>
        {persistentAudio}
        {cameraPreviewModal}
      </>
    );
  }

  // Popout: portal ImmersiveCallSurface into popout container; show placeholder in-panel
  if (callMode === 'popout' && popoutContainerRef.current) {
    const poppedOutPlaceholder = (
      <div className="shrink-0 border-b border-[var(--cyan-accent)]/10 bg-[var(--glass-bg)]">
        <div className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <ExternalLink size={14} className="text-[var(--cyan-accent)] shrink-0" />
            <span className="text-xs text-[var(--text-primary)]/60 font-medium truncate">{t('voiceCall.poppedOutDesc', { displayName })}</span>
          </div>
          <button type="button" onClick={() => { closePopout(); setCallMode(prevNonImmersiveModeRef.current); }} className="px-3 py-1.5 rounded-lg text-[11px] font-semibold bg-[var(--cyan-accent)]/15 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)]/25 transition-all">
            {t('voiceCall.bringBack')}
          </button>
        </div>
      </div>
    );
    const popTarget = inlinePortalTargetId ? document.getElementById(inlinePortalTargetId) : null;
    const popoutContent = (
      <ImmersiveCallSurface mode="popout" controls={popoutControls}>
        <InCallBluetoothBanner onRequestMicSwitch={switchMicDevice} />
        {renderCardGrid('immersive')}
        {screenSharePickerNode}
      </ImmersiveCallSurface>
    );
    return (
      <>
        {popTarget ? createPortal(poppedOutPlaceholder, popTarget) : null}
        {createPortal(popoutContent, popoutContainerRef.current)}
        {persistentAudio}
        {cameraPreviewModal}
      </>
    );
  }

  // Fallback (shouldn't reach here normally)
  return <>{persistentAudio}{cameraPreviewModal}</>;
};

function VolumeControl({ userId, username, volume, onChange }: { userId: string; username: string; volume: number; onChange: (userId: string, vol: number) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 px-1.5 py-0.5 rounded-lg bg-[var(--glass-bg)] hover:bg-black/60 transition-colors" title={t('profile.volume')} aria-label={t('profile.volume')}>
        <Volume2 size={11} className="text-[var(--text-secondary)] shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 mb-2 flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-black/80 backdrop-blur-xl border border-[var(--glass-border)] z-50">
          <Volume2 size={12} className="text-[var(--text-secondary)] shrink-0" />
          <input
            type="range" min={0} max={2} step={0.01} value={volume}
            onChange={(e) => onChange(userId, e.target.valueAsNumber)}
            className="w-20 h-1.5 rounded-full appearance-none bg-fill-stronger accent-[var(--cyan-accent)]"
            title={t('voiceCall.volumeFor', { username })}
          />
          <span className="text-[10px] font-bold tabular-nums w-8 text-right text-[var(--text-secondary)]">{Math.round(volume * 100)}%</span>
        </div>
      )}
    </div>
  );
}

export default DMCallView;
