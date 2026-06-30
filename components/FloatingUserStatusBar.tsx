// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { User, SoundboardSound, GameActivity } from '../types';
import { useAuthStore, useVoiceStore, useAppStore, useServerStore, useNavigationStore } from '../stores';
import { Mic, MicOff, Headphones, GripVertical, RotateCcw, MonitorUp, MonitorOff, ChevronUp, ChevronDown, Check, Camera, CameraOff, Save, X as CloseIcon, AlertTriangle, Pin, PinOff, Volume2, Play, Pause, Music, Shuffle, Repeat, SkipBack, SkipForward, Lock, PhoneOff, Signal } from 'lucide-react';
import { AppTheme } from '../App';
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { useIsMobile } from '../hooks/useIsMobile';
import { useAppVisible } from '../hooks/useAppVisible';
import { LetterAvatar } from './LetterAvatar';
import { RoleNameStyle } from './RoleNameStyle';
import { TypingStatusDot } from './TypingStatusDot';
import { GLASS_MENU_CLASS } from '../utils/contextMenuStyles';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { retryOnExpired, toOriginalUploadPath } from '../utils/signedImageRetry';
import { useSpotifyPlayback } from '../hooks/useSpotifyPlayback';

const formatMs = (ms: number | null | undefined): string => {
  if (!ms || ms < 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + (s % 60).toString().padStart(2, '0');
};

const SPOTIFY_ICON_PATH = 'M248 8C111.1 8 0 119.1 0 256s111.1 248 248 248 248-111.1 248-248S384.9 8 248 8zm100.7 364.9c-4.2 6.6-12.9 8.6-19.5 4.4-53.5-32.7-120.8-40.1-200.1-22-7.6 1.7-15.3-3-17-10.7-1.7-7.6 3-15.3 10.7-17 86.7-19.8 161.1-11.3 221.1 25.5 6.6 4.1 8.6 12.8 4.4 19.4l.4-.6zm26.8-68.9c-5.2 8.4-16.2 11-24.6 5.8-61.2-37.6-154.5-48.5-226.9-26.5-9.2 2.8-18.9-2.4-21.7-11.6-2.8-9.2 2.4-18.9 11.6-21.7 82.6-25.2 185.3-13 254.4 30.3 8.4 5.1 11 16.2 5.8 24.6l.4-1zm2.3-71.8C310.6 196.3 180.5 192 105 213.4c-11 3.4-22.7-2.8-26.1-13.8-3.4-11 2.8-22.7 13.8-26.1 86.7-24.6 230.7-19.9 321.9 30.2 9.9 5.9 13.1 18.8 7.2 28.7-5.9 9.9-18.8 13.1-28.7 7.2l-.3-.3z';
const SpotifyIcon = ({ size, color = 'currentColor' }: { size: number; color?: string }) => (
  <svg width={size} height={size} viewBox="0 0 496 512" fill={color}><path d={SPOTIFY_ICON_PATH}/></svg>
);

interface FloatingUserStatusBarProps {
  theme: AppTheme;
  onToggleMute: () => void;
  onToggleDeafen: () => void;
  onToggleScreenShare: () => void;
  onToggleCamera: () => void;
  onStatusChange: (status: User['status']) => void;
  /** Sidebar width in px when docked — bar is this wide and floats at bottom of sidebar so content scrolls under it */
  sidebarWidth?: number;
  /** Current zoom level (100 = normal). Used to adjust viewport bounds. */
  zoomLevel?: number;
  /** Volume multiplier for soundboard playback (0-100). */
  soundboardVolume?: number;
  /** Callback to persist soundboard volume changes. */
  onSoundboardVolumeChange?: (volume: number) => void;
  userPlan?: string | null;
  onLeaveVoiceChannel?: () => void;
  connectedVoiceChannelName?: string | null;
  isInStage?: boolean;
  isStageSpeaker?: boolean;
  connectedStageChannelName?: string | null;
  isInDmCall?: boolean;
  dmCallDisplayName?: string | null;
  serverRegion?: string | null;
}

type InternalStatusLabel = 'online' | 'away' | 'dnd' | 'invisible';

export const FloatingUserStatusBar: React.FC<FloatingUserStatusBarProps> = React.memo(({
  theme,
  onToggleMute,
  onToggleDeafen,
  onToggleScreenShare,
  onToggleCamera,
  onStatusChange,
  sidebarWidth: _sidebarWidth = 0,
  zoomLevel = 100,
  soundboardVolume = 100,
  onSoundboardVolumeChange,
  userPlan,
  onLeaveVoiceChannel,
  connectedVoiceChannelName: _connectedVoiceChannelName,
  isInStage = false,
  isStageSpeaker = false,
  connectedStageChannelName: _connectedStageChannelName,
  isInDmCall = false,
  dmCallDisplayName: _dmCallDisplayName = null,
  serverRegion: _serverRegion = null,
}) => {
  const { t } = useTranslation();
  const isMobile = useIsMobile();

  // Store selectors
  const currentUser = useAuthStore(s => s.currentUser);
  const isMuted = useVoiceStore(s => s.isMuted);
  const isDeafened = useVoiceStore(s => s.isDeafened);
  const isScreenSharing = useVoiceStore(s => s.isScreenSharing);
  const isCameraOn = useVoiceStore(s => s.isCameraOn);
  const serverMuted = useVoiceStore(s => s.serverMuted);
  const serverDeafened = useVoiceStore(s => s.serverDeafened);
  const voiceChannelId = useVoiceStore(s => s.connectedVoiceChannelId);
  const stageChannelId = useVoiceStore(s => s.connectedStageChannelId);
  const _voiceChannelParticipants = useVoiceStore(s => s.voiceChannelParticipants);
  const isInVoiceChannel = !!voiceChannelId || !!stageChannelId || isInDmCall;
  const docked = useAppStore(s => s.floatingBarDocked);
  const setDocked = useAppStore(s => s.setFloatingBarDocked);
  const servers = useServerStore(s => s.servers);
  const activeServerId = useNavigationStore(s => s.activeServerId);
  const _BAR_HEIGHT = 64;
  const containerRef = useRef<HTMLDivElement>(null);
  const zoomFraction = zoomLevel / 100;
  const viewW = () => window.innerWidth / zoomFraction;
  const viewH = () => window.innerHeight / zoomFraction;
  const [_windowHeight, setWindowHeight] = useState(() => typeof window !== 'undefined' ? window.innerHeight / zoomFraction : 800);
  const dockControlInSidebar = true; // always store-controlled now
  // Track the last-known viewport so resize handlers can rescale proportionally.
  const prevViewportRef = useRef({ w: viewW(), h: viewH() });

  const [position, setPosition] = useState(() => {
    const vw = window.innerWidth / (zoomLevel / 100);
    const vh = window.innerHeight / (zoomLevel / 100);
    const saved = localStorage.getItem('howl_floating_bar_pos');
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        return {
          x: Math.min(Math.max(parsed.x, 0), vw - 450),
          y: Math.min(Math.max(parsed.y, 0), vh - 80)
        };
      } catch {
        return { x: 100, y: vh - 100 };
      }
    }
    return { x: 100, y: vh - 100 };
  });

  // Rescale + clamp the bar whenever the viewport changes — window resize, the
  // OS maximize/restore, entering fullscreen, monitor DPI change, or a zoom-
  // level update.  Position is proportionally mapped from the old viewport to the
  // new one so the bar stays in the same *relative* spot, then clamped so it
  // never falls off-screen.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const rescale = () => {
      const newW = viewW();
      const newH = viewH();
      setWindowHeight(newH);
      const oldW = prevViewportRef.current.w;
      const oldH = prevViewportRef.current.h;
      prevViewportRef.current = { w: newW, h: newH };

      // Skip rescaling when viewport hasn't actually changed (initial mount,
      // duplicate events, etc.) — just clamp.
      const wChanged = Math.abs(newW - oldW) > 1;
      const hChanged = Math.abs(newH - oldH) > 1;

      setPosition((prev) => {
        let nx = prev.x;
        let ny = prev.y;

        if (wChanged && oldW > 0) {
          nx = (prev.x / oldW) * newW;
        }
        if (hChanged && oldH > 0) {
          ny = (prev.y / oldH) * newH;
        }

        // Clamp into visible area
        const barWidth = containerRef.current?.offsetWidth || 450;
        const barHeight = containerRef.current?.offsetHeight || 80;
        nx = Math.min(Math.max(nx, 0), Math.max(0, newW - barWidth));
        ny = Math.min(Math.max(ny, 0), Math.max(0, newH - barHeight));

        return nx === prev.x && ny === prev.y ? prev : { x: nx, y: ny };
      });
    };
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(rescale, 60);
    };
    rescale();
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      if (timer) clearTimeout(timer);
    };
  }, [zoomLevel]);

  const [isDragging, setIsDragging] = useState(false);
  const [justDropped, setJustDropped] = useState(false);
  const [isStatusMenuOpen, setIsStatusMenuOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [isBarHovered, setIsBarHovered] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState(false);

  // Soundboard state
  const [soundboardOpen, setSoundboardOpen] = useState(false);
  const [soundsByServer, setSoundsByServer] = useState<Record<string, SoundboardSound[]>>({});
  const [soundboardLoading, setSoundboardLoading] = useState(false);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [sbVolumeOpen, setSbVolumeOpen] = useState(false);
  const sbVolumeRef = useRef<HTMLDivElement>(null);
  const soundboardRef = useRef<HTMLDivElement>(null);
  const playingAudioRef = useRef<HTMLAudioElement | null>(null);

  const isRealServer = (id?: string) => id && !['home', 'account', 'friends', 'dm'].includes(id);

  // Spotify playback state
  const spotifyActivity = useMemo<GameActivity | null>(() => {
    if (!currentUser) return null;
    if (currentUser.activity?.type === 'spotify') return currentUser.activity;
    if (currentUser.secondaryActivity?.type === 'spotify') return currentUser.secondaryActivity;
    return null;
  }, [currentUser?.activity, currentUser?.secondaryActivity]);

  const [spotifyPlayerOpen, setSpotifyPlayerOpen] = useState(false);

  const [playbackState, playbackControls] = useSpotifyPlayback({
    isOpen: spotifyPlayerOpen,
    spotifyActivity,
  });

  const [panelRect, setPanelRect] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const spotifyPanelRef = useRef<HTMLDivElement>(null);

  const [dockedPortalTarget, setDockedPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!docked) { setDockedPortalTarget(null); return; }
    // Polling intentionally continues — MessageInput is keyed on channel.id
    // and remounts on every channel switch, replacing #docked-status-portal
    // with a new DOM node. A "stop after first find" optimization holds the
    // old detached reference forever and the createPortal target silently
    // stops rendering. setState with the same element is a no-op so the
    // 3.3/sec wakeups while docked are cheap.
    const find = () => setDockedPortalTarget(document.getElementById('docked-status-portal'));
    find();
    const frame = requestAnimationFrame(find);
    const timer = setInterval(find, 300);
    return () => { cancelAnimationFrame(frame); clearInterval(timer); };
  }, [docked]);

  // Visibility gate — skip rAF loops, latency probes, and other periodic work
  // when the app is minimized or alt-tabbed away. useAppVisible re-renders
  // this component on transition, which re-runs the effects below.
  const isAppVisibleNow = useAppVisible();

  // Square the replyBar's top-left corner when panel is open (connected look, like undocked)
  useEffect(() => {
    if (!spotifyPlayerOpen || !docked || !dockedPortalTarget?.parentElement) return;
    const replyBar = dockedPortalTarget.parentElement;
    const original = replyBar.style.borderTopLeftRadius;
    replyBar.style.borderTopLeftRadius = '0';
    return () => { replyBar.style.borderTopLeftRadius = original; };
  }, [spotifyPlayerOpen, docked, dockedPortalTarget]);

  // Measure bar position for fixed-position panel overlay
  useEffect(() => {
    if (!spotifyPlayerOpen || !containerRef.current) {
      setPanelRect(null);
      return;
    }
    // The rAF measure loop below runs at 60fps to keep the panel pinned to
    // the bar during drag and arbitrary layout shifts. Skip the entire effect
    // when the window is hidden — there's nothing for the user to see, and
    // rAF on hidden electron windows isn't always throttled.
    if (!isAppVisibleNow) return;
    let rafId = 0;
    const measure = () => {
      if (!containerRef.current) return;
      const barRect = containerRef.current.getBoundingClientRect();

      // For docked-portal: anchor panel to the replyBar container's top, not the inner content's top
      // This prevents the panel from overlapping the replyBar's padding/border area
      const anchorTop = (docked && dockedPortalTarget?.parentElement)
        ? dockedPortalTarget.parentElement.getBoundingClientRect().top
        : barRect.top;

      // Use offsetWidth — immune to CSS transforms (scale during drag)
      let panelWidth = Math.max(MIN_PANEL_WIDTH, containerRef.current.offsetWidth);
      if (docked && dockedPortalTarget) {
        // Align panel right edge with the activity panel's right edge
        const activityAside = document.querySelector<HTMLElement>('[data-notification-strip]');
        if (activityAside) {
          const asideRight = activityAside.getBoundingClientRect().right;
          const candidateWidth = asideRight - barRect.left;
          // Only use if activity panel is expanded (not collapsed to ~14px) and result is reasonable
          if (candidateWidth >= MIN_PANEL_WIDTH) {
            panelWidth = candidateWidth;
          }
        }
      }

      // During drag, bypass React state and write directly to panel DOM for zero-lag tracking
      if (isDraggingRef.current && spotifyPanelRef.current) {
        spotifyPanelRef.current.style.left = barRect.left + 'px';
        spotifyPanelRef.current.style.width = panelWidth + 'px';
        // playerAbove direction: use barRect.top vs PANEL_MAX_HEIGHT
        if (barRect.top >= PANEL_MAX_HEIGHT) {
          // above
          spotifyPanelRef.current.style.top = anchorTop + 'px';
          spotifyPanelRef.current.style.transform = 'translateY(-100%)';
        } else {
          // below
          spotifyPanelRef.current.style.top = (anchorTop + barRect.height) + 'px';
          spotifyPanelRef.current.style.transform = 'none';
        }
        return;
      }

      setPanelRect(prev => {
        if (prev && prev.left === barRect.left && prev.top === anchorTop && prev.width === panelWidth && prev.height === barRect.height) {
          return prev;
        }
        return { left: barRect.left, top: anchorTop, width: panelWidth, height: barRect.height };
      });
    };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);

    // Use rAF loop instead of setInterval — syncs with paint frames for smooth drag tracking
    const loop = () => {
      measure();
      rafId = requestAnimationFrame(loop);
    };
    rafId = requestAnimationFrame(loop);

    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      cancelAnimationFrame(rafId);
    };
  }, [spotifyPlayerOpen, docked, position.x, position.y, dockedPortalTarget, isAppVisibleNow]);

  // Latency indicator (only measured while in a voice/call session)
  // Also gated on app visibility — the latency display isn't visible when the
  // window is minimized, so the 5s socket round-trip is wasted work. We
  // intentionally don't clear `latency` on visibility hide so the bar shows
  // the last known value immediately on restore (instead of blanking for 5s
  // until the first probe completes).
  const [latency, setLatency] = useState<number | null>(null);
  useEffect(() => {
    if (!isInVoiceChannel) { setLatency(null); return; }
    if (!isAppVisibleNow) return;
    let cancelled = false;
    const measure = async () => {
      const ms = await socketService.measureLatency();
      if (!cancelled) setLatency(ms);
    };
    measure();
    const id = setInterval(measure, 5000);
    return () => { cancelled = true; clearInterval(id); };
  }, [isInVoiceChannel, isAppVisibleNow]);

  // Connection detail popover
  const [connDetailOpen, setConnDetailOpen] = useState(false);
  const connDetailRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!connDetailOpen) return;
    const onClickOutside = (e: MouseEvent) => {
      if (connDetailRef.current && !connDetailRef.current.contains(e.target as Node)) setConnDetailOpen(false);
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [connDetailOpen]);
  // Close popover when disconnecting
  useEffect(() => { if (!isInVoiceChannel) setConnDetailOpen(false); }, [isInVoiceChannel]);

  useEffect(() => {
    if (!soundboardOpen || servers.length === 0) return;
    setSoundboardLoading(true);
    Promise.all(
      servers.map((s) =>
        apiClient.getServerSounds(s.id).then((sounds) => ({ serverId: s.id, sounds })).catch(() => ({ serverId: s.id, sounds: [] as SoundboardSound[] }))
      )
    ).then((results) => {
      const map: Record<string, SoundboardSound[]> = {};
      for (const r of results) if (r.sounds.length > 0) map[r.serverId] = r.sounds;
      setSoundsByServer(map);
      setSoundboardLoading(false);
    });
  }, [soundboardOpen, servers]);

  useEffect(() => {
    if (!soundboardOpen) { setSbVolumeOpen(false); return; }
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      if (sbVolumeRef.current?.contains(target)) return;
      if (soundboardRef.current && !soundboardRef.current.contains(target)) setSoundboardOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [soundboardOpen]);

  useEffect(() => {
    if (!sbVolumeOpen) return;
    const handler = (e: MouseEvent) => {
      if (sbVolumeRef.current && !sbVolumeRef.current.contains(e.target as Node)) setSbVolumeOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sbVolumeOpen]);

  useEffect(() => {
    if (!voiceChannelId) return;
    const handler = (data: { fromUserId: string; audioUrl: string; volume: number; name: string; emoji?: string }) => {
      // Defense-in-depth: only play audio from our own upload origin.
      // Includes the Electron web hostname (cdn/api.howlpro.com) explicitly,
      // since window.location.hostname is the literal "app" under howl-app://.
      if (data.audioUrl && !data.audioUrl.startsWith('/') && !data.audioUrl.startsWith(window.location.origin)) {
        try {
          const u = new URL(data.audioUrl);
          const validHosts = [window.location.hostname, 'cdn.howlpro.com', 'api.howlpro.com', 'amazonaws.com', 's3.amazonaws.com'];
          if (!validHosts.some(h => u.hostname === h || u.hostname.endsWith('.' + h))) return;
        } catch { return; }
      }
      const audio = new Audio(data.audioUrl);
      audio.volume = Math.max(0, Math.min(1, (data.volume ?? 1) * (soundboardVolume / 100)));
      audio.play().catch(() => {});
    };
    socketService.onVoiceSoundboardPlay(handler);
    return () => { socketService.offVoiceSoundboardPlay(); };
  }, [voiceChannelId, soundboardVolume]);

  const playSound = (sound: SoundboardSound) => {
    if (playingAudioRef.current) { playingAudioRef.current.pause(); playingAudioRef.current = null; }
    const audio = new Audio(sound.audioUrl);
    audio.volume = Math.min(1, sound.volume * (soundboardVolume / 100));
    setPlayingId(sound.id);
    audio.onended = () => { setPlayingId(null); playingAudioRef.current = null; };
    audio.onerror = () => { setPlayingId(null); playingAudioRef.current = null; };
    audio.play().catch(() => setPlayingId(null));
    if (voiceChannelId) {
      socketService.sendVoiceSoundboardPlay(voiceChannelId, { audioUrl: sound.audioUrl, volume: sound.volume, name: sound.name, emoji: sound.emoji ?? undefined });
    }
    playingAudioRef.current = audio;
  };

  // localStorage persistence is handled by useAppStore.setFloatingBarDocked

  const dragOffset = useRef({ x: 0, y: 0 });
  const dragPositionRef = useRef({ x: 0, y: 0 });
  const barSizeRef = useRef({ width: 450, height: 64 });
  const isDraggingRef = useRef(false);
  const hasDragMovedRef = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const saveCurrentPosition = () => {
    localStorage.setItem('howl_floating_bar_pos', JSON.stringify(position));
    setSaveFeedback(true);
    setTimeout(() => setSaveFeedback(false), 2000);
  };

  const resetPosition = () => {
    const defaultPos = { x: 100, y: viewH() - 100 };
    setPosition(defaultPos);
    localStorage.setItem('howl_floating_bar_pos', JSON.stringify(defaultPos));
    setShowResetConfirm(false);
  };

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (docked) return;
    if (
      (e.target as HTMLElement).closest('button') ||
      (e.target as HTMLElement).closest('.status-menu') ||
      (e.target as HTMLElement).closest('.confirm-prompt')
    ) return;

    const el = containerRef.current;
    if (!el) return;

    const w = el.offsetWidth;
    const h = el.offsetHeight;
    barSizeRef.current = { width: w, height: h };

    const z = zoomLevel / 100;
    el.style.transition = 'none';
    dragOffset.current = { x: e.clientX / z - position.x, y: e.clientY / z - position.y };
    dragPositionRef.current = { x: position.x, y: position.y };
    isDraggingRef.current = true;
    hasDragMovedRef.current = false;
    document.body.style.cursor = 'grabbing';
    document.body.style.userSelect = 'none';
  }, [position, docked, zoomLevel]);

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!isDraggingRef.current) return;
    if (!hasDragMovedRef.current) {
      hasDragMovedRef.current = true;
      setIsDragging(true);
    }
    const el = containerRef.current;
    if (!el) return;

    const z = zoomLevel / 100;
    const cx = e.clientX / z;
    const cy = e.clientY / z;
    const { width: barWidth, height: barHeight } = barSizeRef.current;
    const newX = Math.max(0, Math.min(cx - dragOffset.current.x, viewW() - barWidth));
    const newY = Math.max(0, Math.min(cy - dragOffset.current.y, viewH() - barHeight));
    dragPositionRef.current = { x: newX, y: newY };
    el.style.left = newX + 'px';
    el.style.top = newY + 'px';
  }, [zoomLevel]);

  const handleMouseUp = useCallback(() => {
    const wasDragging = isDraggingRef.current;
    const wasMoved = hasDragMovedRef.current;
    isDraggingRef.current = false;
    hasDragMovedRef.current = false;
    const el = containerRef.current;
    if (wasDragging && !wasMoved) {
      // Click without drag — just clean up cursor, no scale was applied
      if (el) el.style.transition = '';
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      return;
    }
    if (wasDragging) {
      setJustDropped(true);
      if (el) el.style.transition = '';
      setPosition(dragPositionRef.current);
      setIsDragging(false);
      document.body.style.cursor = 'default';
      document.body.style.userSelect = 'auto';
      requestAnimationFrame(() => { requestAnimationFrame(() => setJustDropped(false)); });
      // Force panel to re-measure with unscaled bounds after React removes scale
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (containerRef.current) {
            const rect = containerRef.current.getBoundingClientRect();
            setPanelRect({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
          }
        });
      });
    }
  }, []);

  useEffect(() => {
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsStatusMenuOpen(false);
      }
    };
    if (isStatusMenuOpen) { document.addEventListener('mousedown', handleClickOutside); }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isStatusMenuOpen]);

  const statusToType = (label: InternalStatusLabel): User['status'] => {
    if (label === 'online') return 'online';
    if (label === 'away') return 'idle';
    if (label === 'dnd') return 'dnd';
    return 'invisible';
  };

  const typeToLabel = (type: User['status']): InternalStatusLabel => {
    if (type === 'online') return 'online';
    if (type === 'idle') return 'away';
    if (type === 'dnd') return 'dnd';
    if (type === 'invisible') return 'invisible';
    return 'online';
  };

  const getStatusColor = (type: User['status']) => {
    switch (type) {
      case 'online': return 'bg-emerald-500';
      case 'idle': return 'bg-amber-500';
      case 'dnd': return 'bg-red-500';
      case 'offline': case 'invisible': return 'bg-slate-500';
      default: return 'bg-emerald-500';
    }
  };

  // Guard: component requires an authenticated user (all hooks above, safe to early-return)
  if (!currentUser) return null;

  const currentLabel = typeToLabel(currentUser.status);
  const isVoidTheme = theme === 'void';
  const isNeuralTheme = theme === 'neural';
  const isLightTheme = theme === 'light';

  const PANEL_MAX_HEIGHT = 140;
  const MIN_PANEL_WIDTH = 300;
  const opensDownwards = docked ? false : position.y < PANEL_MAX_HEIGHT;
  const playerAbove = docked || !opensDownwards;

  const morphTransition = justDropped
    ? 'none'
    : 'left 0.45s cubic-bezier(0.34, 1.56, 0.64, 1), top 0.45s cubic-bezier(0.34, 1.56, 0.64, 1), border-radius 0.45s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.45s ease, background-color 0.45s ease, border 0.45s ease, padding-left 0.45s cubic-bezier(0.34, 1.56, 0.64, 1)';
  const barWrapperStyles: React.CSSProperties = docked
    ? {
        position: 'fixed',
        left: 10,
        bottom: 10,
        zIndex: 9000,
        minWidth: 380,
        width: 'max-content',
        transition: morphTransition,
      }
    : {
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 9000,
        minWidth: 380,
        width: 'max-content',
        transition: morphTransition,
      };

  const standardBoxShadow = '0 4px 6px -1px rgba(0,0,0,0.12), 0 24px 48px -12px rgba(0,0,0,0.2)';
  const barVisualStyles: React.CSSProperties = docked
    ? {
        backgroundColor: 'var(--bg-statusbar)',
        backdropFilter: 'blur(24px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
        border: '1px solid var(--border-subtle)',
        borderTop: spotifyPlayerOpen ? 'none' : '1px solid var(--border-subtle)',
        borderRadius: spotifyPlayerOpen ? '0 0 14px 14px' : 16,
        boxShadow: standardBoxShadow,
        paddingLeft: 6,
        transition: morphTransition,
      }
    : {
        backgroundColor: 'var(--bg-statusbar)',
        backdropFilter: 'blur(24px) saturate(1.1)',
        WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
        border: '1px solid var(--border-subtle)',
        borderTop: spotifyPlayerOpen && playerAbove ? 'none' : '1px solid var(--border-subtle)',
        borderRadius: spotifyPlayerOpen ? (playerAbove ? '0 0 14px 14px' : '14px 14px 0 0') : 16,
        ...(spotifyPlayerOpen && !playerAbove ? { borderBottom: 'none' } : {}),
        boxShadow: standardBoxShadow,
        paddingLeft: 6,
        transition: morphTransition,
      };

  // Spotify player panel (rendered via own portal to document.body)
  const greyedOut = !playbackState.isPremium && playbackState.premiumDismissed;
  const panelGlassStyles: React.CSSProperties = {
    backgroundColor: 'var(--bg-statusbar)',
    backdropFilter: 'blur(24px) saturate(1.1)',
    WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
    border: isBarHovered && !isVoidTheme
      ? '1px solid rgba(6, 182, 212, 0.15)'
      : '1px solid var(--border-subtle)',
    ...(playerAbove ? { borderBottom: 'none' } : { borderTop: 'none' }),
    borderRadius: playerAbove
      ? (docked && dockedPortalTarget ? '14px 14px 14px 0' : '14px 14px 0 0')
      : '0 0 14px 14px',
    boxShadow: standardBoxShadow,
  };

  const panelFixedStyle: React.CSSProperties | null = panelRect ? {
    position: 'fixed',
    left: panelRect.left,
    width: panelRect.width,
    // zIndex moved to portal div for conditional control
    ...(playerAbove
      ? { top: panelRect.top, transform: 'translateY(-100%)' }
      : { top: panelRect.top + panelRect.height }
    ),
  } : null;

  // Spotify panel content (shared between inline docked + body portal)
  const spotifyPanelContent = (
    <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 'inherit' }}>
      {/* Hover tint matching the bar's decorative layer */}
      {isBarHovered && !isVoidTheme && (
        <div className="absolute inset-0 pointer-events-none transition-colors" style={{ backgroundColor: 'rgba(6,182,212,0.05)', zIndex: 1 }} />
      )}
      {spotifyActivity?.largeImage ? (
        <img
          src={sanitizeImgSrc(spotifyActivity.largeImage)}
          alt=""
          aria-hidden
          loading="lazy"
          decoding="async"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(14px) brightness(0.35) saturate(1.3)', transform: 'scale(1.4)', pointerEvents: 'none' }}
        />
      ) : (
        <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(135deg, rgba(30,30,30,0.95), rgba(10,10,10,0.98))', pointerEvents: 'none' }} />
      )}

      <div style={{ position: 'relative', padding: '6px 10px 5px' }}>
        {playbackState.loading ? (
          <div className="flex items-center justify-center py-6">
            <div className="w-4 h-4 border-2 border-[#1DB954]/30 border-t-[#1DB954] rounded-full animate-spin" />
          </div>
        ) : !spotifyActivity ? (
          <div className="flex flex-col items-center justify-center py-5 gap-2">
            <SpotifyIcon size={24} color="var(--text-faint)" />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>{t('statusBar.spotify.noMusic')}</span>
            <span style={{ fontSize: 10, color: 'var(--text-faint)', textAlign: 'center', padding: '0 16px' }}>{t('statusBar.spotify.noMusicDesc')}</span>
          </div>
        ) : (
          <>
            {/* Content area: art spans full height on left, text + controls on right */}
            <div style={{ position: 'relative', minHeight: 80, opacity: greyedOut ? 0.7 : 1 }}>
              {/* Album art — absolutely positioned, spans full height */}
              <div className="shrink-0 rounded-lg overflow-hidden border border-default" style={{ position: 'absolute', top: 0, left: 0, bottom: 0, width: 80 }}>
                {spotifyActivity.largeImage ? (
                  <img src={sanitizeImgSrc(spotifyActivity.largeImage)} alt="" loading="lazy" decoding="async" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                ) : (
                  <div className="flex items-center justify-center w-full h-full bg-fill-hover">
                    <Music size={28} style={{ color: 'var(--text-faint)' }} />
                  </div>
                )}
              </div>

              {/* Text info — offset right of art */}
              <div className="flex-1 min-w-0 flex flex-col justify-center" style={{ paddingLeft: 90 }}>
                <div className="flex items-start justify-between gap-1">
                  <a
                    href={spotifyActivity.platformId ? `https://open.spotify.com/track/${encodeURIComponent(spotifyActivity.platformId)}` : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block truncate hover:underline"
                    style={{ fontSize: 13, fontWeight: 600, color: 'white', textDecoration: 'none' }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {spotifyActivity.name}
                  </a>
                  <div className="flex items-center gap-1 shrink-0">
                    {greyedOut && (
                      <span style={{ fontSize: 8, color: 'var(--text-faint)', border: '0.5px solid var(--border-subtle)', padding: '1px 6px', borderRadius: 12 }}>
                        {t('statusBar.spotify.free')}
                      </span>
                    )}
                    <SpotifyIcon size={14} color="#1DB954" />
                  </div>
                </div>
                {spotifyActivity.details && (
                  <div className="truncate" style={{ fontSize: 10.5 }}>
                    <span style={{ color: 'var(--text-secondary)' }}>by </span>
                    <a
                      href={`https://open.spotify.com/search/${encodeURIComponent(spotifyActivity.details)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      style={{ color: 'var(--text-secondary)', textDecoration: 'none' }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {spotifyActivity.details}
                    </a>
                  </div>
                )}
                {spotifyActivity.state && (
                  <div className="truncate" style={{ fontSize: 9.5 }}>
                    <span style={{ color: 'var(--text-faint)' }}>on </span>
                    <span style={{ color: 'var(--text-secondary)' }}>{spotifyActivity.state}</span>
                  </div>
                )}
              </div>

              {/* Controls — centered on full panel width (not shifted by art) */}
              <div className="flex items-center justify-center pt-1.5" style={{ gap: 12, opacity: greyedOut ? 0.2 : 1, pointerEvents: greyedOut ? 'none' : 'auto' }}>
                <button type="button" onClick={(e) => { e.stopPropagation(); playbackControls.toggleShuffle(); }} className="p-0.5 flex items-center justify-center" style={{ background: 'none', border: 'none', cursor: 'pointer', color: playbackState.shuffleOn ? '#1DB954' : '#ccc', opacity: playbackState.shuffleOn ? 1 : 0.5 }} title={t('statusBar.spotify.shuffle')}>
                  <Shuffle size={13} />
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); playbackControls.skipPrevious(); }} className="p-0.5 flex items-center justify-center" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ddd' }} title={t('statusBar.spotify.previous')}>
                  <SkipBack size={14} />
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); playbackControls.togglePlayPause(); }} className="flex items-center justify-center" style={{ width: 26, height: 26, borderRadius: '50%', backgroundColor: 'white', border: 'none', cursor: 'pointer', color: '#111' }} title={playbackState.isPlaying ? t('statusBar.spotify.pause') : t('statusBar.spotify.play')}>
                  {playbackState.isPlaying ? <Pause size={12} /> : <Play size={12} style={{ marginLeft: 1 }} />}
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); playbackControls.skipNext(); }} className="p-0.5 flex items-center justify-center" style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ddd' }} title={t('statusBar.spotify.next')}>
                  <SkipForward size={14} />
                </button>
                <button type="button" onClick={(e) => { e.stopPropagation(); playbackControls.cycleRepeat(); }} className="relative p-0.5 flex items-center justify-center" style={{ background: 'none', border: 'none', cursor: 'pointer', color: playbackState.repeatMode !== 'off' ? '#1DB954' : '#ccc', opacity: playbackState.repeatMode !== 'off' ? 1 : 0.5 }} title={playbackState.repeatMode === 'track' ? t('statusBar.spotify.repeatTrack') : playbackState.repeatMode === 'context' ? t('statusBar.spotify.repeatAll') : t('statusBar.spotify.repeat')}>
                  <Repeat size={13} />
                  {playbackState.repeatMode === 'track' && <div className="absolute -bottom-0.5 left-1/2 -translate-x-1/2 w-1 h-1 rounded-full bg-[#1DB954]" />}
                </button>
              </div>
            </div>

            {/* Progress bar — full width below everything */}
            <div className="flex items-center gap-2" style={{ marginTop: 4 }}>
              <span style={{ fontSize: 9, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', minWidth: 26 }}>{formatMs(playbackState.progressMs)}</span>
              <div className="flex-1 bg-white/[0.08]" style={{ height: 3, borderRadius: 1.5, overflow: 'hidden', opacity: greyedOut ? 0.3 : 1 }}>
                <div style={{ height: '100%', width: `${Math.min(100, (playbackState.progressMs / (spotifyActivity.durationMs || 1)) * 100)}%`, backgroundColor: greyedOut ? '#666' : '#1DB954', borderRadius: 1.5, transition: 'width 0.3s linear' }} />
              </div>
              <span style={{ fontSize: 9, color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums', minWidth: 26, textAlign: 'right' as const }}>{formatMs(spotifyActivity.durationMs)}</span>
            </div>
          </>
        )}

        {/* Premium overlay */}
        {!playbackState.isPremium && !playbackState.premiumDismissed && !playbackState.loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ backgroundColor: 'rgba(10,12,16,0.92)', borderRadius: 'inherit', zIndex: 10 }}>
            <SpotifyIcon size={24} color="#1DB954" />
            <span style={{ fontSize: 12, fontWeight: 600, color: 'white' }}>{t('statusBar.spotify.premiumRequired')}</span>
            <span style={{ fontSize: 10, color: 'var(--text-secondary)', textAlign: 'center', padding: '0 16px' }}>{t('statusBar.spotify.premiumDesc')}</span>
            <button type="button" onClick={(e) => { e.stopPropagation(); playbackControls.dismissPremium(); }} style={{ background: 'none', border: '0.5px solid var(--border-subtle)', color: 'var(--text-secondary)', fontSize: 10, padding: '4px 14px', borderRadius: 12, cursor: 'pointer', marginTop: 4 }}>
              {t('statusBar.spotify.dismiss')}
            </button>
          </div>
        )}
      </div>
    </div>
  );

  /* ── Mobile: compact bottom bar above tab bar ──────────────── */
  if (isMobile) {
    // On mobile, only show the status bar when in a voice channel
    // The user's avatar/status is already visible in the bottom tab bar (account tab)
    if (!isInVoiceChannel) return null;

    const MOBILE_TAB_BAR = 60;
    const voiceChannelName = voiceChannelId
      ? servers.flatMap(s => s.channels).find(c => c.id === voiceChannelId)?.name
      : stageChannelId
        ? servers.flatMap(s => s.channels).find(c => c.id === stageChannelId)?.name
        : isInDmCall
          ? (_dmCallDisplayName || t('incomingCall.inCall'))
          : undefined;
    return (
      <div
        className="fixed left-0 right-0 flex items-center justify-between px-2 border-t border-default safe-area-bottom"
        style={{
          bottom: `max(env(safe-area-inset-bottom), ${MOBILE_TAB_BAR}px)`,
          height: 44,
          zIndex: 9000,
          backgroundColor: 'var(--bg-statusbar)',
          backdropFilter: 'blur(24px) saturate(1.1)',
          WebkitBackdropFilter: 'blur(24px) saturate(1.1)',
        }}
      >
        {/* Voice info */}
        <div className="flex items-center gap-2">
          <div
            className="flex items-center justify-center px-1.5 py-0.5 rounded-md"
            title={latency !== null ? t('voice.latency', { latency }) : t('voice.measuringLatency')}
          >
            <Signal
              className="w-3.5 h-3.5 transition-colors"
              style={{
                color: latency === null ? 'var(--text-secondary)' : latency < 80 ? '#10b981' : latency < 200 ? 'var(--warning)' : 'var(--danger)',
                opacity: latency === null ? 0.4 : 0.85,
              }}
            />
          </div>
          <span className="text-[10px] font-semibold truncate max-w-[100px] text-t-secondary">
            {voiceChannelName || t('sidebar.inVoiceChannel')}
          </span>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-0.5">
          {(!isInStage || isStageSpeaker) && (
            <button type="button" onClick={onToggleMute} disabled={serverMuted} className={`p-1.5 rounded-lg transition-colors ${serverMuted ? 'text-red-500 bg-red-500/20 cursor-not-allowed opacity-75' : isMuted ? 'text-red-500 bg-red-500/10' : 'text-t-accent'}`} style={{ opacity: !isMuted && !serverMuted ? 0.6 : 1 }}>
              {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
            </button>
          )}
          <button type="button" onClick={onToggleDeafen} disabled={serverDeafened} className={`p-1.5 rounded-lg transition-colors ${serverDeafened ? 'text-red-500 bg-red-500/20 cursor-not-allowed opacity-75' : isDeafened ? 'text-red-500 bg-red-500/10' : 'text-t-accent'}`} style={{ opacity: !isDeafened && !serverDeafened ? 0.6 : 1 }}>
            <Headphones size={16} />
          </button>
          {(!isInStage || isStageSpeaker) && (
            <button type="button" onClick={onToggleCamera} className={`p-1.5 rounded-lg transition-colors text-t-accent ${isCameraOn ? 'bg-[var(--cyan-accent)]/10' : ''}`}>
              {isCameraOn ? <Camera size={14} /> : <CameraOff size={14} />}
            </button>
          )}
          {onLeaveVoiceChannel && (
            <button type="button" onClick={onLeaveVoiceChannel} className="p-1.5 rounded-lg transition-colors text-red-500 bg-red-500/10" title={t('voice.leaveChannel')}>
              <PhoneOff size={14} />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <>
      {/* Standalone Dock button only when dock control is not in sidebar (uncontrolled mode) */}
      {!dockControlInSidebar && !docked && (
        <button
          type="button"
          onClick={() => setDocked(true)}
          className="fixed z-[var(--z-dropdown)] flex items-center gap-2 pl-3 pr-4 py-2.5 rounded-xl border shadow-lg transition-all duration-200 hover:scale-[1.02] active:scale-[0.98] left-4 bottom-4 bg-floating border-default text-t-primary"
          style={{
            boxShadow: isLightTheme ? '0 4px 20px rgba(0,0,0,0.08)' : '0 4px 24px rgba(0,0,0,0.3)',
          }}
          title={t('statusBar.dockTooltip')}
        >
          <Pin size={16} className="text-t-accent opacity-90" />
          <span className="text-xs font-semibold">{t('statusBar.dock')}</span>
        </button>
      )}

      {/* Status bar content – portaled into reply bubble when docked, or floating when undocked */}
      {docked && dockedPortalTarget ? createPortal(
        <div ref={containerRef} className="relative" style={{ contain: 'layout style', minWidth: 380, width: 'max-content' }}>
          <div
            className="flex items-center pr-1 pl-3 shrink-0 relative group"
            data-docked-bar="true"
          >
          {/* Undock caret at top-left */}
          <button
            type="button"
            onClick={() => setDocked(false)}
            className="absolute left-1 -top-1 p-0.5 rounded-md text-t-secondary hover:text-[var(--cyan-accent)] hover:bg-fill-hover transition-all z-10 opacity-0 group-hover:opacity-100"
            title={t('statusBar.undockTooltip')}
            aria-label={t('statusBar.undock')}
            data-dock-toggle="true"
          >
            <ChevronUp size={14} />
          </button>
          {showResetConfirm && (
            <div
              className="confirm-prompt absolute inset-0 z-[var(--z-dropdown)] backdrop-blur-md flex items-center justify-between px-6 border border-red-500/50 spring-pop-in rounded-l-2xl bg-floating"
            >
              <div className="flex items-center text-red-500">
                <AlertTriangle size={18} className="mr-3 animate-pulse" />
                <span className="text-[10px] font-semibold tracking-tight">{t('statusBar.resetCoordinates')}</span>
              </div>
              <div className="flex items-center space-x-2">
                <button onClick={() => setShowResetConfirm(false)} className="p-2 text-slate-500 hover:text-red-500 transition-colors">
                  <CloseIcon size={16} />
                </button>
                <button onClick={resetPosition} className="btn-cta-danger px-4 py-1.5 rounded-xl text-[9px] font-semibold transition-all">
                  {t('common.confirm')}
                </button>
              </div>
            </div>
          )}

          <div className="relative" ref={menuRef}>
            <button onClick={() => setIsStatusMenuOpen(!isStatusMenuOpen)} className="flex items-center min-w-[120px] mr-3 hover:bg-fill-hover p-1 rounded-xl transition-all group/user text-left">
              <div className="relative shrink-0">
                <LetterAvatar avatar={currentUser.avatar} username={currentUser.username} size={36} className="rounded-full ring-2 ring-[var(--cyan-accent)]/10" />
                <TypingStatusDot
                  status={currentUser.status}
                  isTyping={false}
                  size={14}
                  className="absolute bottom-0 right-0"
                />
              </div>
              <div className="ml-2.5 truncate">
                <div className="text-[12px] font-bold truncate tracking-tight flex items-center text-t-primary" data-personal-info>
                  {(() => {
                    const plan = currentUser.effectivePlan || currentUser.stripePlan;
                    return plan === 'pro' && (currentUser.nameColor || currentUser.nameFont || currentUser.nameEffect)
                      ? <RoleNameStyle name={currentUser.username} overrideColor={currentUser.nameColor} overrideFont={currentUser.nameFont} nameEffect={currentUser.nameEffect} />
                      : currentUser.username;
                  })()}
                  <span className={`ml-1 transition-transform duration-300 text-t-accent opacity-40 ${isStatusMenuOpen ? 'rotate-180' : 'rotate-0'}`}>
                    <ChevronUp size={11} />
                  </span>
                </div>
                <div className="text-[9px] truncate font-medium capitalize text-t-secondary">
                  {currentLabel === 'dnd' ? t('statusBar.doNotDisturb') : currentLabel}
                </div>
              </div>
            </button>

            {isStatusMenuOpen && (
              <div
                className={`status-menu absolute left-0 w-48 ${GLASS_MENU_CLASS} glass p-2 overflow-hidden bottom-full mb-3`}
              >
                <div className="px-3 py-0.5 border-b border-default mb-1">
                  <span className="text-[9px] font-semibold text-t-secondary">{t('statusBar.signalPresence')}</span>
                </div>
                {(['online', 'away', 'dnd', 'invisible'] as InternalStatusLabel[]).map((label) => {
                  const type = statusToType(label);
                  const isActive = currentUser.status === type;
                  const displayName = label === 'dnd' ? t('statusBar.doNotDisturb') : label;
                  return (
                    <button
                      key={label}
                      onClick={() => { onStatusChange(type); setIsStatusMenuOpen(false); }}
                      className={`w-full flex items-center px-3 py-2.5 rounded-xl transition-all group/item ${isActive ? 'bg-[var(--cyan-accent)]/10 text-t-accent' : 'hover:bg-fill-hover text-t-primary'}`}
                    >
                      {label === 'dnd' ? (
                        <div className={`w-3 h-3 rounded-full mr-3 bg-red-500 flex items-center justify-center ${isActive ? 'shadow-[0_0_8px_currentColor]' : ''}`}>
                          <div className="w-1.5 h-0.5 rounded-full bg-white/90" />
                        </div>
                      ) : (
                        <div className={`w-3 h-3 rounded-full mr-3 ${getStatusColor(type)} ${isActive ? 'shadow-[0_0_8px_currentColor]' : ''}`} />
                      )}
                      <div className="flex-1 text-left">
                        <span className="text-xs font-bold capitalize">{displayName}</span>
                        {label === 'dnd' && <p className="text-[9px] opacity-50 leading-tight mt-0.5">{t('statusBar.dndDesc')}</p>}
                      </div>
                      {isActive && <Check size={14} className="text-[var(--cyan-accent)]" />}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="flex items-center space-x-0.5 pr-1.5 border-r border-default mr-2">
            {isInVoiceChannel && (() => {
              const latencyColor = latency === null ? 'var(--text-secondary)' : latency < 80 ? '#10b981' : latency < 200 ? 'var(--warning)' : 'var(--danger)';
              const qualityLabel = latency === null ? t('statusBar.measuring', 'Measuring…') : latency < 80 ? t('statusBar.connGood', 'Good') : latency < 200 ? t('statusBar.connFair', 'Fair') : t('statusBar.connPoor', 'Poor');
              const connName = _connectedVoiceChannelName || _connectedStageChannelName || (isInDmCall ? (_dmCallDisplayName || t('incomingCall.inCall')) : null);
              const regionLabel = _serverRegion
                ? _serverRegion.replace(/-\d+$/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
                : null;
              return (
                <div className="relative" ref={connDetailRef}>
                  <button
                    type="button"
                    onClick={() => setConnDetailOpen(v => !v)}
                    className={`flex items-center justify-center p-1.5 rounded-lg mr-0.5 transition-all ${connDetailOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                    title={latency !== null ? t('voice.latency', { latency }) : t('voice.measuringLatency')}
                    aria-label={latency !== null ? t('voice.latency', { latency }) : t('voice.measuringLatency')}
                  >
                    <Signal
                      className="w-3.5 h-3.5 transition-colors"
                      style={{
                        color: latencyColor,
                        opacity: latency === null ? 0.4 : 0.85,
                      }}
                    />
                  </button>
                  {connDetailOpen && (
                    <div className={`absolute ${GLASS_MENU_CLASS} glass w-56 bottom-full mb-3`} style={{ left: -8, zIndex: 'var(--z-overlay)' as unknown as number }}>
                      <div className="px-4 py-3 space-y-2.5">
                        {/* Connection quality */}
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.connQuality', 'Connection')}</span>
                          <div className="flex items-center gap-1.5">
                            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: latencyColor, boxShadow: `0 0 4px ${latencyColor}` }} />
                            <span className="text-[11px] font-bold" style={{ color: latencyColor }}>{qualityLabel}</span>
                          </div>
                        </div>
                        {/* Latency */}
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.latency', 'Latency')}</span>
                          <span className="text-[11px] font-bold tabular-nums text-t-primary">{latency !== null ? `${latency}ms` : '—'}</span>
                        </div>
                        {/* Server region */}
                        {regionLabel && (
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.region', 'Region')}</span>
                            <span className="text-[11px] font-bold text-t-primary">{regionLabel}</span>
                          </div>
                        )}
                        {/* Connected channel/call */}
                        {connName && (
                          <div className="flex items-center justify-between">
                            <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.connectedTo', 'Connected to')}</span>
                            <span className="text-[11px] font-bold text-t-primary truncate max-w-[120px]">{connName}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })()}
            {currentUser.hasSpotify && (
            <button
              type="button"
              onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSpotifyPlayerOpen(v => !v); }}
              className={`relative p-2 rounded-xl transition-all shrink-0 w-9 h-9 flex items-center justify-center ${spotifyPlayerOpen ? 'bg-[#1DB954]/15 border border-[#1DB954]/25 text-[#1DB954]' : 'hover:bg-fill-hover text-t-accent'}`}
              style={{ opacity: spotifyPlayerOpen ? 1 : 0.5 }}
              title={t('statusBar.spotify.listeningTo')}
            >
              <SpotifyIcon size={16} />
              {!spotifyPlayerOpen && spotifyActivity && playbackState.isPlaying && (
                <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#1DB954]" style={{ boxShadow: '0 0 4px #1DB954' }} />
              )}
            </button>
            )}
            {/* Mute/camera/screen: show for voice/DM calls or stage speakers, hide for stage audience */}
            {(!isInStage || isStageSpeaker) && (
              <>
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleMute(); }} disabled={serverMuted} className={`relative p-2 rounded-xl transition-colors shrink-0 w-9 h-9 flex items-center justify-center ${serverMuted ? 'text-red-500 bg-red-500/20 border border-red-500/30 cursor-not-allowed opacity-75' : isMuted ? 'text-red-500 bg-red-500/10 border border-red-500/20' : 'hover:bg-fill-hover text-t-accent'}`} style={{ opacity: !isMuted && !serverMuted ? 0.6 : 1 }}>
                  {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
                </button>
              </>
            )}
            <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleDeafen(); }} disabled={serverDeafened} className={`relative p-2 rounded-xl transition-colors shrink-0 w-9 h-9 flex items-center justify-center ${serverDeafened ? 'text-red-500 bg-red-500/20 border border-red-500/30 cursor-not-allowed opacity-75' : isDeafened ? 'text-red-500 bg-red-500/10 border border-red-500/20' : 'hover:bg-fill-hover text-t-accent'}`} style={{ opacity: !isDeafened && !serverDeafened ? 0.6 : 1 }} title={serverDeafened ? t('userMenu.serverDeafen') : isDeafened ? t('statusBar.undeafen') : t('statusBar.deafen')}>
              <Headphones size={16} />
              {isDeafened && (
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute pointer-events-none" style={{ width: 16, height: 16, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                  <line x1="22" y1="22" x2="2" y2="2" />
                </svg>
              )}
            </button>
            {(!isInStage || isStageSpeaker) && (
              <>
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleCamera(); }} disabled={!isInVoiceChannel} className={`p-2 rounded-xl transition-all text-t-accent ${isCameraOn ? 'bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20' : !isInVoiceChannel ? 'opacity-20' : 'hover:bg-fill-hover'}`}>
                  {isCameraOn ? <Camera size={16} /> : <CameraOff size={16} />}
                </button>
                <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleScreenShare(); }} disabled={!isInVoiceChannel} className={`p-2 rounded-xl transition-all ${isScreenSharing ? 'text-emerald-500 bg-emerald-500/10 border border-emerald-500/20' : !isInVoiceChannel ? 'opacity-20 text-t-accent' : 'hover:bg-fill-hover text-t-accent'}`}>
                  {isScreenSharing ? <MonitorOff size={16} /> : <MonitorUp size={16} />}
                </button>
              </>
            )}
            {isInVoiceChannel && onLeaveVoiceChannel && (
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLeaveVoiceChannel(); }} className="p-2 rounded-xl transition-all text-red-500 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 active:scale-95" title={t('voice.leaveChannel')}>
                <PhoneOff size={16} />
              </button>
            )}
          </div>

          <div className="relative flex items-center pr-1.5 border-r border-default mr-2" ref={soundboardRef}>
            <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSoundboardOpen((v) => !v); }} className={`p-2 rounded-xl transition-all text-t-accent ${soundboardOpen ? 'bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20' : 'hover:bg-fill-hover'}`} style={{ opacity: soundboardOpen ? 1 : 0.6 }} aria-label={t('statusBar.soundboard')}>
              <Volume2 size={16} />
            </button>
            {soundboardOpen && (
              <div className={`absolute w-72 max-h-80 ${GLASS_MENU_CLASS} glass bottom-full mb-3`} style={{ left: -8, zIndex: 'var(--z-overlay)' as unknown as number }}>
                <div className="px-4 py-2.5 border-b border-default flex items-center justify-between">
                  <span className="text-[10px] font-semibold tracking-tight text-t-secondary">{t('statusBar.soundboard')}</span>
                  <div ref={sbVolumeRef}>
                    <button type="button" onClick={(e) => { e.stopPropagation(); setSbVolumeOpen((v) => !v); }} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all ${sbVolumeOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'}`} title={t('statusBar.adjustVolume')}>
                      <Volume2 size={12} className="text-t-accent" style={{ opacity: soundboardVolume === 0 ? 0.3 : 0.8 }} />
                      <span className="text-[10px] font-bold tabular-nums text-t-secondary">{soundboardVolume}%</span>
                    </button>
                  </div>
                </div>
                {sbVolumeOpen && (
                  <div className="px-4 py-2 border-b border-default flex items-center gap-2.5" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                    <Volume2 size={13} className="text-t-secondary shrink-0" style={{ opacity: soundboardVolume === 0 ? 0.3 : 0.7 }} />
                    <input type="range" min={0} max={100} step={1} value={soundboardVolume} onChange={(e) => onSoundboardVolumeChange?.(parseInt(e.target.value, 10))} className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--cyan-accent)]" style={{ background: `linear-gradient(to right, var(--cyan-accent) ${soundboardVolume}%, var(--fill-active) ${soundboardVolume}%)` }} aria-label={t('statusBar.adjustVolume')} />
                    <span className="text-[10px] font-bold tabular-nums w-7 text-right text-t-secondary">{soundboardVolume}</span>
                  </div>
                )}
                <div className="overflow-y-auto max-h-64 p-2">
                  {soundboardLoading ? (
                    <div className="py-6 flex items-center justify-center"><div className="w-5 h-5 border-2 border-[var(--cyan-accent)]/30 border-t-[var(--cyan-accent)] rounded-full animate-spin" /></div>
                  ) : Object.keys(soundsByServer).length === 0 ? (
                    <p className="text-[11px] py-6 text-center text-t-secondary">{t('statusBar.noSounds')}</p>
                  ) : (
                    servers.filter((s) => soundsByServer[s.id]?.length).map((srv) => {
                      const hasUniversalSoundboard = userPlan === 'essential' || userPlan === 'pro';
                      const canPlay = hasUniversalSoundboard || (isRealServer(activeServerId) && activeServerId === srv.id);
                      return (
                        <div key={srv.id} className="mb-2 last:mb-0">
                          <div className="flex items-center gap-2 px-2 py-1.5">
                            {srv.icon ? <img src={sanitizeImgSrc(srv.icon)} alt="" className="w-4 h-4 rounded-full object-cover" loading="lazy" decoding="async" width={16} height={16} data-original-src={toOriginalUploadPath(srv.icon)} onError={retryOnExpired} /> : <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold bg-fill-hover text-t-secondary">{srv.name.charAt(0).toUpperCase()}</div>}
                            <span className={`text-[10px] font-semibold truncate ${canPlay ? 'text-t-primary' : 'text-t-secondary'}`}>{srv.name}</span>
                            {!canPlay && <span className="flex items-center gap-0.5 shrink-0"><Lock size={10} className="opacity-40 text-t-secondary" /><span className="text-[8px] font-bold text-[var(--cyan-accent)]/60">Essential+</span></span>}
                          </div>
                          <div className="grid grid-cols-2 gap-1 px-1">
                            {soundsByServer[srv.id].map((sound) => (
                              <button key={sound.id} type="button" disabled={!canPlay} onClick={() => canPlay && playSound(sound)} className={`flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition-all ${canPlay ? 'hover:bg-fill-hover active:scale-[0.97] cursor-pointer' : 'opacity-35 cursor-not-allowed'} ${playingId === sound.id ? 'bg-[var(--cyan-accent)]/15 ring-1 ring-[var(--cyan-accent)]/30' : ''}`}>
                                <span className="text-sm shrink-0">{sound.emoji || '\uD83D\uDD0A'}</span>
                                <span className={`text-[11px] font-medium truncate ${playingId === sound.id ? 'text-t-accent' : 'text-t-primary'}`}>{sound.name}</span>
                                {playingId === sound.id && <Play size={10} className="shrink-0 animate-pulse text-t-accent" />}
                              </button>
                            ))}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            )}
          </div>

          <div className="flex items-center space-x-0.5">
            {docked && !dockControlInSidebar ? (
              <button type="button" onClick={() => setDocked(false)} className="p-2 rounded-xl transition-all flex items-center gap-1 text-t-secondary hover:text-[var(--cyan-accent)] hover:bg-[var(--cyan-accent)]/10" title={t('statusBar.undockTooltip')}>
                <PinOff size={14} />
                <span className="text-[9px] font-semibold">{t('statusBar.undock')}</span>
              </button>
            ) : docked && dockControlInSidebar ? null : null}
          </div>
          </div>
        </div>,
        dockedPortalTarget
      ) : createPortal(
        <div
          ref={containerRef}
          style={{
            contain: 'layout style',
            ...barWrapperStyles,
            ...(isDragging ? { transform: 'scale(1.02)' } : {}),
          }}
          onMouseDown={handleMouseDown}
          onMouseEnter={() => setIsBarHovered(true)}
          onMouseLeave={() => setIsBarHovered(false)}
        >
          <div
            style={barVisualStyles}
            className={`perf-glass-layer flex items-center pr-2 group relative rounded-2xl ${docked ? 'py-1.5' : 'h-16'} ${isDragging ? 'ring-1 ring-[var(--cyan-accent)]/50' : ''}`}
            data-docked-bar={docked ? 'true' : undefined}
          >
        {docked && (
          <button
            type="button"
            onClick={() => setDocked(false)}
            className="absolute left-1 -top-1 p-0.5 rounded-md text-t-secondary hover:text-[var(--cyan-accent)] hover:bg-fill-hover transition-all z-10 opacity-0 group-hover:opacity-100"
            title={t('statusBar.undockTooltip')}
            aria-label={t('statusBar.undock')}
            data-dock-toggle="true"
          >
            <ChevronUp size={14} />
          </button>
        )}
        {showResetConfirm && (
          <div
            className="confirm-prompt absolute inset-0 z-[var(--z-dropdown)] backdrop-blur-md flex items-center justify-between px-6 border border-red-500/50 spring-pop-in rounded-2xl bg-floating"
          >
            <div className="flex items-center text-red-500">
              <AlertTriangle size={18} className="mr-3 animate-pulse" />
              <span className="text-[10px] font-semibold tracking-tight">{t('statusBar.resetCoordinates')}</span>
            </div>
            <div className="flex items-center space-x-2">
              <button onClick={() => setShowResetConfirm(false)} className="p-2 text-slate-500 hover:text-red-500 transition-colors">
                <CloseIcon size={16} />
              </button>
              <button onClick={resetPosition} className="btn-cta-danger px-4 py-1.5 rounded-xl text-[9px] font-semibold transition-all">
                {t('common.confirm')}
              </button>
            </div>
          </div>
        )}

        {!docked && (
          <div className="mr-1 cursor-grab active:cursor-grabbing px-0.5 py-1 transition-colors text-t-accent opacity-30">
            <GripVertical size={20} />
          </div>
        )}

        <div className="relative" ref={menuRef}>
          <button onClick={() => setIsStatusMenuOpen(!isStatusMenuOpen)} className={`flex items-center ${docked ? 'min-w-[120px] mr-3' : 'min-w-[140px] mr-4'} hover:bg-fill-hover p-1 rounded-xl transition-all group/user text-left`}>
            <div className="relative shrink-0">
              <LetterAvatar avatar={currentUser.avatar} username={currentUser.username} size={docked ? 36 : 40} className="rounded-full ring-2 ring-[var(--cyan-accent)]/10" />
              <TypingStatusDot
                status={currentUser.status}
                isTyping={false}
                size={14}
                className="absolute bottom-0 right-0"
              />
            </div>
            <div className={`${docked ? 'ml-2.5' : 'ml-3'} truncate`}>
              <div className={`${docked ? 'text-[12px]' : 'text-[13px]'} font-bold truncate tracking-tight flex items-center text-t-primary`} data-personal-info>
                {(() => {
                  const plan = currentUser.effectivePlan || currentUser.stripePlan;
                  return plan === 'pro' && (currentUser.nameColor || currentUser.nameFont || currentUser.nameEffect)
                    ? <RoleNameStyle name={currentUser.username} overrideColor={currentUser.nameColor} overrideFont={currentUser.nameFont} nameEffect={currentUser.nameEffect} />
                    : currentUser.username;
                })()}
                <span className={`ml-1 transition-transform duration-300 text-t-accent opacity-40 ${isStatusMenuOpen ? 'rotate-180' : 'rotate-0'}`}>
                  {opensDownwards ? <ChevronDown size={12} /> : <ChevronUp size={docked ? 11 : 12} />}
                </span>
              </div>
              <div className={`${docked ? 'text-[9px]' : 'text-[10px]'} truncate font-medium capitalize text-t-secondary`}>
                {currentLabel === 'dnd' ? t('statusBar.doNotDisturb') : currentLabel}
              </div>
            </div>
          </button>

          {isStatusMenuOpen && (
            <div
              className={`status-menu absolute left-0 w-48 ${GLASS_MENU_CLASS} glass p-2 overflow-hidden ${opensDownwards ? 'top-full mt-3' : 'bottom-full mb-3'}`}
            >
              <div className="px-3 py-0.5 border-b border-default mb-1">
                <span className="text-[9px] font-semibold text-t-secondary">{t('statusBar.signalPresence')}</span>
              </div>

              {(['online', 'away', 'dnd', 'invisible'] as InternalStatusLabel[]).map((label) => {
                const type = statusToType(label);
                const isActive = currentUser.status === type;
                const displayName = label === 'dnd' ? t('statusBar.doNotDisturb') : label;
                return (
                  <button
                    key={label}
                    onClick={() => { onStatusChange(type); setIsStatusMenuOpen(false); }}
                    className={`w-full flex items-center px-3 py-2.5 rounded-xl transition-all group/item ${isActive ? 'bg-[var(--cyan-accent)]/10 text-t-accent' : 'hover:bg-fill-hover text-t-primary'}`}
                  >
                    {label === 'dnd' ? (
                      <div className={`w-3 h-3 rounded-full mr-3 bg-red-500 flex items-center justify-center ${isActive ? 'shadow-[0_0_8px_currentColor]' : ''}`}>
                        <div className="w-1.5 h-0.5 rounded-full bg-white/90" />
                      </div>
                    ) : (
                      <div className={`w-3 h-3 rounded-full mr-3 ${getStatusColor(type)} ${isActive ? 'shadow-[0_0_8px_currentColor]' : ''}`} />
                    )}
                    <div className="flex-1 text-left">
                      <span className="text-xs font-bold capitalize">{displayName}</span>
                      {label === 'dnd' && <p className="text-[9px] opacity-50 leading-tight mt-0.5">{t('statusBar.dndDesc')}</p>}
                    </div>
                    {isActive && <Check size={14} className="text-[var(--cyan-accent)]" />}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className={`flex items-center border-default ${docked ? 'space-x-0.5 pr-1.5 border-r mr-2' : 'space-x-1 pr-2 border-r mr-3'}`}>
          {isInVoiceChannel && (() => {
            const latencyColor = latency === null ? 'var(--text-secondary)' : latency < 80 ? '#10b981' : latency < 200 ? 'var(--warning)' : 'var(--danger)';
            const qualityLabel = latency === null ? t('statusBar.measuring', 'Measuring…') : latency < 80 ? t('statusBar.connGood', 'Good') : latency < 200 ? t('statusBar.connFair', 'Fair') : t('statusBar.connPoor', 'Poor');
            const connName = _connectedVoiceChannelName || _connectedStageChannelName || (isInDmCall ? (_dmCallDisplayName || t('incomingCall.inCall')) : null);
            const regionLabel = _serverRegion
              ? _serverRegion.replace(/-\d+$/, '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
              : null;
            return (
              <div className="relative" ref={!docked ? connDetailRef : undefined}>
                <button
                  type="button"
                  onClick={() => setConnDetailOpen(v => !v)}
                  className={`flex items-center justify-center p-2 rounded-lg mr-0.5 transition-all ${connDetailOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                  title={latency !== null ? t('voice.latency', { latency }) : t('voice.measuringLatency')}
                  aria-label={latency !== null ? t('voice.latency', { latency }) : t('voice.measuringLatency')}
                >
                  <Signal
                    className="w-4 h-4 transition-colors"
                    style={{
                      color: latencyColor,
                      opacity: latency === null ? 0.4 : 0.85,
                    }}
                  />
                </button>
                {connDetailOpen && (
                  <div className={`absolute ${GLASS_MENU_CLASS} glass w-56 bottom-full mb-3`} style={{ left: -8, zIndex: 'var(--z-overlay)' as unknown as number }}>
                    <div className="px-4 py-3 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.connQuality', 'Connection')}</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: latencyColor, boxShadow: `0 0 4px ${latencyColor}` }} />
                          <span className="text-[11px] font-bold" style={{ color: latencyColor }}>{qualityLabel}</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.latency', 'Latency')}</span>
                        <span className="text-[11px] font-bold tabular-nums text-t-primary">{latency !== null ? `${latency}ms` : '—'}</span>
                      </div>
                      {regionLabel && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.region', 'Region')}</span>
                          <span className="text-[11px] font-bold text-t-primary">{regionLabel}</span>
                        </div>
                      )}
                      {connName && (
                        <div className="flex items-center justify-between">
                          <span className="text-[10px] font-semibold text-t-secondary">{t('statusBar.connectedTo', 'Connected to')}</span>
                          <span className="text-[11px] font-bold text-t-primary truncate max-w-[120px]">{connName}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })()}
          {currentUser.hasSpotify && (
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSpotifyPlayerOpen(v => !v); }}
            className={`relative ${docked ? 'p-2 w-9 h-9' : 'p-2.5 w-10 h-10'} rounded-xl transition-all shrink-0 flex items-center justify-center ${spotifyPlayerOpen ? 'bg-[#1DB954]/15 border border-[#1DB954]/25 text-[#1DB954]' : 'hover:bg-fill-hover text-t-accent'}`}
            style={{ opacity: spotifyPlayerOpen ? 1 : 0.5 }}
            title={t('statusBar.spotify.listeningTo')}
          >
            <SpotifyIcon size={docked ? 16 : 18} />
            {!spotifyPlayerOpen && spotifyActivity && playbackState.isPlaying && (
              <div className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-[#1DB954]" style={{ boxShadow: '0 0 4px #1DB954' }} />
            )}
          </button>
          )}
          {(!isInStage || isStageSpeaker) && (
            <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleMute(); }} disabled={serverMuted} className={`relative ${docked ? 'p-2 w-9 h-9' : 'p-2.5 w-10 h-10'} rounded-xl transition-colors shrink-0 flex items-center justify-center ${serverMuted ? 'text-red-500 bg-red-500/20 border border-red-500/30 cursor-not-allowed opacity-75' : isMuted ? 'text-red-500 bg-red-500/10 border border-red-500/20' : 'hover:bg-fill-hover text-t-accent'}`} style={{ opacity: !isMuted && !serverMuted ? 0.6 : 1 }}>
              {isMuted ? <MicOff size={docked ? 16 : 18} /> : <Mic size={docked ? 16 : 18} />}
            </button>
          )}
          <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleDeafen(); }} disabled={serverDeafened} className={`relative ${docked ? 'p-2 w-9 h-9' : 'p-2.5 w-10 h-10'} rounded-xl transition-colors shrink-0 flex items-center justify-center ${serverDeafened ? 'text-red-500 bg-red-500/20 border border-red-500/30 cursor-not-allowed opacity-75' : isDeafened ? 'text-red-500 bg-red-500/10 border border-red-500/20' : 'hover:bg-fill-hover text-t-accent'}`} style={{ opacity: !isDeafened && !serverDeafened ? 0.6 : 1 }} title={serverDeafened ? t('userMenu.serverDeafen') : isDeafened ? t('statusBar.undeafen') : t('statusBar.deafen')}>
            <Headphones size={docked ? 16 : 18} />
            {isDeafened && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="absolute pointer-events-none" style={{ width: docked ? 16 : 18, height: docked ? 16 : 18, top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }}>
                <line x1="22" y1="22" x2="2" y2="2" />
              </svg>
            )}
          </button>
          {(!isInStage || isStageSpeaker) && (
            <>
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleCamera(); }} disabled={!isInVoiceChannel} className={`${docked ? 'p-2' : 'p-2.5'} rounded-xl transition-all text-t-accent ${isCameraOn ? 'bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20' : !isInVoiceChannel ? 'opacity-20' : 'hover:bg-fill-hover'}`}>
                {isCameraOn ? <Camera size={docked ? 16 : 18} /> : <CameraOff size={docked ? 16 : 18} />}
              </button>
              <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggleScreenShare(); }} disabled={!isInVoiceChannel} className={`${docked ? 'p-2' : 'p-2.5'} rounded-xl transition-all ${isScreenSharing ? 'text-emerald-500 bg-emerald-500/10 border border-emerald-500/20' : !isInVoiceChannel ? 'opacity-20 text-t-accent' : 'hover:bg-fill-hover text-t-accent'}`}>
                {isScreenSharing ? <MonitorOff size={docked ? 16 : 18} /> : <MonitorUp size={docked ? 16 : 18} />}
              </button>
            </>
          )}
          {isInVoiceChannel && onLeaveVoiceChannel && (
            <button type="button" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onLeaveVoiceChannel(); }} className={`${docked ? 'p-2' : 'p-2.5'} rounded-xl transition-all text-red-500 bg-red-500/10 border border-red-500/20 hover:bg-red-500/20 active:scale-95`} title={t('voice.leaveChannel')}>
              <PhoneOff size={docked ? 16 : 18} />
            </button>
          )}
        </div>

        {/* Soundboard */}
        <div className={`relative flex items-center border-default ${docked ? 'pr-1.5 border-r mr-2' : 'pr-2 border-r mr-3'}`} ref={soundboardRef}>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setSoundboardOpen((v) => !v); }}
            className={`${docked ? 'p-2' : 'p-2.5'} rounded-xl transition-all text-t-accent ${soundboardOpen ? 'bg-[var(--cyan-accent)]/10 border border-[var(--cyan-accent)]/20' : 'hover:bg-fill-hover'}`}
            style={{ opacity: soundboardOpen ? 1 : 0.6 }}
            aria-label={t('statusBar.soundboard')}
          >
            <Volume2 size={docked ? 16 : 18} />
          </button>

          {soundboardOpen && (
            <div
              className={`absolute w-72 max-h-80 ${GLASS_MENU_CLASS} glass ${docked || position.y > viewH() * 0.4 ? 'bottom-full mb-3' : 'top-full mt-3'}`}
              style={{ left: -8, zIndex: 'var(--z-overlay)' as unknown as number }}
            >
              <div className="px-4 py-2.5 border-b border-default flex items-center justify-between">
                <span className="text-[10px] font-semibold tracking-tight text-t-secondary">{t('statusBar.soundboard')}</span>
                <div ref={sbVolumeRef}>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); setSbVolumeOpen((v) => !v); }}
                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg transition-all ${sbVolumeOpen ? 'bg-fill-active' : 'hover:bg-fill-hover'}`}
                    title={t('statusBar.adjustVolume')}
                  >
                    <Volume2 size={12} className="text-t-accent" style={{ opacity: soundboardVolume === 0 ? 0.3 : 0.8 }} />
                    <span className="text-[10px] font-bold tabular-nums text-t-secondary">{soundboardVolume}%</span>
                  </button>
                </div>
              </div>
              {sbVolumeOpen && (
                <div className="px-4 py-2 border-b border-default flex items-center gap-2.5" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
                  <Volume2 size={13} className="text-t-secondary shrink-0" style={{ opacity: soundboardVolume === 0 ? 0.3 : 0.7 }} />
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={1}
                    value={soundboardVolume}
                    onChange={(e) => onSoundboardVolumeChange?.(parseInt(e.target.value, 10))}
                    className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--cyan-accent)]"
                    style={{ background: `linear-gradient(to right, var(--cyan-accent) ${soundboardVolume}%, var(--fill-active) ${soundboardVolume}%)` }}
                    aria-label={t('statusBar.adjustVolume')}
                  />
                  <span className="text-[10px] font-bold tabular-nums w-7 text-right text-t-secondary">{soundboardVolume}</span>
                </div>
              )}
              <div className="overflow-y-auto max-h-64 p-2">
                {soundboardLoading ? (
                  <div className="py-6 flex items-center justify-center">
                    <div className="w-5 h-5 border-2 border-[var(--cyan-accent)]/30 border-t-[var(--cyan-accent)] rounded-full animate-spin" />
                  </div>
                ) : Object.keys(soundsByServer).length === 0 ? (
                  <p className="text-[11px] py-6 text-center text-t-secondary">{t('statusBar.noSounds')}</p>
                ) : (
                  servers.filter((s) => soundsByServer[s.id]?.length).map((srv) => {
                    const hasUniversalSoundboard = userPlan === 'essential' || userPlan === 'pro';
                    const canPlay = hasUniversalSoundboard || (isRealServer(activeServerId) && activeServerId === srv.id);
                    return (
                      <div key={srv.id} className="mb-2 last:mb-0">
                        <div className="flex items-center gap-2 px-2 py-1.5">
                          {srv.icon ? (
                            <img src={sanitizeImgSrc(srv.icon)} alt="" className="w-4 h-4 rounded-full object-cover" loading="lazy" decoding="async" width={16} height={16} data-original-src={toOriginalUploadPath(srv.icon)} onError={retryOnExpired} />
                          ) : (
                            <div className="w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold bg-fill-hover text-t-secondary">
                              {srv.name.charAt(0).toUpperCase()}
                            </div>
                          )}
                          <span className={`text-[10px] font-semibold truncate ${canPlay ? 'text-t-primary' : 'text-t-secondary'}`}>
                            {srv.name}
                          </span>
                          {!canPlay && <span className="flex items-center gap-0.5 shrink-0"><Lock size={10} className="opacity-40 text-t-secondary" /><span className="text-[8px] font-bold text-[var(--cyan-accent)]/60">Essential+</span></span>}
                        </div>
                        <div className="grid grid-cols-2 gap-1 px-1">
                          {soundsByServer[srv.id].map((sound) => (
                            <button
                              key={sound.id}
                              type="button"
                              disabled={!canPlay}
                              onClick={() => canPlay && playSound(sound)}
                              className={`flex items-center gap-2 px-2.5 py-2 rounded-xl text-left transition-all ${canPlay ? 'hover:bg-fill-hover active:scale-[0.97] cursor-pointer' : 'opacity-35 cursor-not-allowed'} ${playingId === sound.id ? 'bg-[var(--cyan-accent)]/15 ring-1 ring-[var(--cyan-accent)]/30' : ''}`}
                            >
                              <span className="text-sm shrink-0">{sound.emoji || '\uD83D\uDD0A'}</span>
                              <span className={`text-[11px] font-medium truncate ${playingId === sound.id ? 'text-t-accent' : 'text-t-primary'}`}>
                                {sound.name}
                              </span>
                              {playingId === sound.id && (
                                <Play size={10} className="shrink-0 animate-pulse text-t-accent" />
                              )}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center space-x-1">
          {docked && !dockControlInSidebar ? (
            <button
              type="button"
              onClick={() => setDocked(false)}
              className="p-2.5 rounded-xl transition-all flex items-center gap-1.5 text-t-secondary hover:text-[var(--cyan-accent)] hover:bg-[var(--cyan-accent)]/10"
              title={t('statusBar.undockTooltip')}
            >
              <PinOff size={16} />
              <span className="text-[10px] font-bold uppercase tracking-wider">{t('statusBar.undock')}</span>
            </button>
          ) : docked && dockControlInSidebar ? null : (
            <>
              <button onClick={saveCurrentPosition} className={`p-2.5 transition-all rounded-xl relative ${saveFeedback ? 'text-emerald-500 bg-emerald-500/10' : 'text-slate-500 hover:text-emerald-500 hover:bg-emerald-500/5'}`}>
                {saveFeedback ? <Check size={16} className="animate-in zoom-in-50" /> : <Save size={16} />}
              </button>
              <button onClick={() => setShowResetConfirm(true)} className="p-2.5 text-slate-500 hover:text-red-500 hover:bg-red-500/5 rounded-xl transition-all">
                <RotateCcw size={16} />
              </button>
            </>
          )}
        </div>

        {/* Decorative tint layer only for Neural/Light to add depth.
            Radius must mirror the bar's dynamic borderRadius so the tint
            doesn't reveal "darker corners" when Spotify panel fuses to the bar. */}
        {!isVoidTheme && (
          <div
            className={`absolute inset-0 -z-10 group-hover:bg-[var(--cyan-accent)]/5 transition-colors pointer-events-none ${isNeuralTheme ? 'bg-[var(--cyan-accent)]/[0.02]' : 'bg-transparent'}`}
            style={{
              borderRadius: spotifyPlayerOpen ? (playerAbove ? '0 0 14px 14px' : '14px 14px 0 0') : 16,
              transition: morphTransition,
            }}
          />
        )}
        </div>
      </div>,
      document.body
      )}

      {/* Spotify player panel — fixed overlay anchored to bar position */}
      {currentUser.hasSpotify && spotifyPlayerOpen && panelFixedStyle && createPortal(
        <div
          ref={spotifyPanelRef}
          onMouseEnter={() => setIsBarHovered(true)}
          onMouseLeave={() => setIsBarHovered(false)}
          style={{
            ...panelFixedStyle,
            ...panelGlassStyles,
            overflow: 'hidden',
            maxHeight: 140,
            zIndex: isStatusMenuOpen ? -1 : 9001,
            opacity: isStatusMenuOpen ? 0 : 1,
            pointerEvents: isStatusMenuOpen ? 'none' as const : 'auto' as const,
            transition: isDragging ? 'none' : isStatusMenuOpen ? 'none' : 'opacity 0.15s ease, transform 0.2s ease, box-shadow 0.2s ease',
          }}
        >
          {spotifyPanelContent}
        </div>,
        document.body
      )}
    </>
  );
});
