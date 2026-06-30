// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { PhoneOff, Mic, MicOff, Camera, CameraOff, MonitorUp, MonitorOff, Headphones, HeadphoneOff, ExternalLink, Minimize2, Maximize2, Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// 44px minimum touch target; no-op at desktop since existing `p-3` + 20px icon already ≥44px.
const ICON_BTN = 'min-w-[44px] min-h-[44px] flex items-center justify-center';
// Bottom safe-area inset: 0 everywhere except iOS/Android full-bleed, so this is a no-op at desktop.
const SAFE_AREA_STYLE: React.CSSProperties = { paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' };

import type { MicSilenceState } from '../../hooks/useMicSilenceDetection';

interface CallControlBarProps {
  isMuted: boolean;
  isDeafened: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  isFullscreen?: boolean;
  isPoppedOut?: boolean;
  isMobile?: boolean;
  onToggleMute: () => void;
  onToggleDeafen?: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onOpenScreenShareSettings?: () => void;
  onToggleFullscreen?: () => void;
  onClosePopout?: () => void;
  onOpenPopout?: () => void;
  onExpandOrCollapse?: () => void;
  onLeave: () => void;
  leaveLabel?: string;
  serverMuted?: boolean;
  serverDeafened?: boolean;
  /** When 'icon' or 'banner', show a warning dot on the mic button. */
  micSilenceState?: MicSilenceState;
}

/**
 * Shared control bar for voice channels and DM calls.
 * Renders mute, deafen, camera, screen share, layout, and leave buttons.
 */
export const CallControlBar: React.FC<CallControlBarProps> = ({
  isMuted,
  isDeafened,
  isCameraOn,
  isScreenSharing,
  isFullscreen = false,
  isPoppedOut = false,
  isMobile = false,
  onToggleMute,
  onToggleDeafen,
  onToggleCamera,
  onToggleScreenShare,
  onOpenScreenShareSettings,
  onToggleFullscreen,
  onClosePopout,
  onOpenPopout,
  onExpandOrCollapse,
  onLeave,
  leaveLabel,
  serverMuted = false,
  serverDeafened = false,
  micSilenceState,
}) => {
  const { t } = useTranslation();
  const label = leaveLabel ?? t('voiceCall.leave');
  const showMicWarningDot = micSilenceState === 'icon' || micSilenceState === 'banner';

  return (
    <div
      className="flex items-center justify-center gap-2 px-4 py-3 rounded-2xl bg-[var(--glass-bg)] backdrop-blur-xl border border-[var(--border-subtle)] mx-auto max-w-[min(32rem,calc(100vw-16px))]"
      style={SAFE_AREA_STYLE}
    >
      <button
        type="button"
        onClick={onToggleMute}
        className={`${ICON_BTN} relative p-3 rounded-xl transition-all ${serverMuted ? 'text-[var(--danger)] bg-[var(--danger-muted)] border border-[var(--danger)]/50 cursor-not-allowed opacity-75' : isMuted ? 'text-[var(--danger)] bg-[var(--danger-subtle)] border border-[var(--danger)]/30' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-hover)]'}`}
        title={showMicWarningDot
          ? t('voiceCall.micSilence.tooltip', 'No audio detected from your mic. Check your input device.')
          : serverMuted ? t('userMenu.serverMute') : isMuted ? t('voiceCall.unmute') : t('voiceCall.mute')}
        aria-label={serverMuted ? t('userMenu.serverMute') : isMuted ? t('voiceCall.unmute') : t('voiceCall.mute')}
        disabled={serverMuted}
      >
        {isMuted ? <MicOff size={20} /> : <Mic size={20} />}
        {showMicWarningDot && (
          <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-amber-500 border-2 border-[var(--glass-bg)]" />
        )}
      </button>

      {onToggleDeafen && (
        <button
          type="button"
          onClick={onToggleDeafen}
          className={`${ICON_BTN} p-3 rounded-xl transition-all ${serverDeafened ? 'text-[var(--danger)] bg-[var(--danger-muted)] border border-[var(--danger)]/50 cursor-not-allowed opacity-75' : isDeafened ? 'text-[var(--danger)] bg-[var(--danger-subtle)] border border-[var(--danger)]/30' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-hover)]'}`}
          title={serverDeafened ? t('userMenu.serverDeafen') : isDeafened ? t('voiceCall.undeafen') : t('voiceCall.deafen')}
          aria-label={serverDeafened ? t('userMenu.serverDeafen') : isDeafened ? t('voiceCall.undeafen') : t('voiceCall.deafen')}
          disabled={serverDeafened}
        >
          {isDeafened ? <HeadphoneOff size={20} /> : <Headphones size={20} />}
        </button>
      )}

      <button
        type="button"
        onClick={onToggleCamera}
        className={`${ICON_BTN} p-3 rounded-xl transition-all ${isCameraOn ? 'text-[var(--cyan-accent)] bg-[var(--accent-muted)] border border-[var(--cyan-accent)]/30' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-hover)]'}`}
        title={isCameraOn ? t('voiceCall.turnOffCamera') : t('voiceCall.turnOnCamera')}
        aria-label={isCameraOn ? t('voiceCall.turnOffCamera') : t('voiceCall.turnOnCamera')}
      >
        {isCameraOn ? <Camera size={20} /> : <CameraOff size={20} />}
      </button>

      {!isMobile && (
        <button
          type="button"
          onClick={onToggleScreenShare}
          className={`${ICON_BTN} p-3 rounded-xl transition-all ${isScreenSharing ? 'text-[var(--success)] bg-[var(--success-subtle)] border border-[var(--success)]/30' : 'text-[var(--text-secondary)] hover:bg-[var(--fill-hover)]'}`}
          title={isScreenSharing ? t('voiceCall.stopSharing') : t('voiceCall.shareScreen')}
          aria-label={isScreenSharing ? t('voiceCall.stopSharing') : t('voiceCall.shareScreen')}
        >
          {isScreenSharing ? <MonitorOff size={20} /> : <MonitorUp size={20} />}
        </button>
      )}

      {!isMobile && isScreenSharing && onOpenScreenShareSettings && (
        <button type="button" onClick={onOpenScreenShareSettings} className={`${ICON_BTN} p-3 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] transition-all`} title={t('screenShare.settingsTitle')} aria-label={t('screenShare.settingsTitle')}>
          <Settings size={20} />
        </button>
      )}

      <div className="w-px h-8 bg-[var(--border-subtle)] mx-1" />

      {!isMobile && onExpandOrCollapse && (
        <button type="button" onClick={onExpandOrCollapse} className={`${ICON_BTN} p-3 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] transition-all`} title={t('voiceCall.fullscreen')} aria-label={t('voiceCall.fullscreen')}>
          <Maximize2 size={20} />
        </button>
      )}

      {!isMobile && onOpenPopout && (
        <button type="button" onClick={onOpenPopout} className={`${ICON_BTN} p-3 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] transition-all`} title={t('voiceCall.popOut')} aria-label={t('voiceCall.popOut')}>
          <ExternalLink size={20} />
        </button>
      )}

      {!isMobile && isFullscreen && onToggleFullscreen && (
        <button type="button" onClick={onToggleFullscreen} className={`${ICON_BTN} p-3 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] transition-all`} title={t('voice.exitFullscreen')} aria-label={t('voice.exitFullscreen')}>
          <Minimize2 size={20} />
        </button>
      )}

      {isPoppedOut && onClosePopout && (
        <button type="button" onClick={onClosePopout} className={`${ICON_BTN} p-3 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] transition-all`} title={t('voice.popBackIn')} aria-label={t('voice.popBackIn')}>
          <ExternalLink size={20} />
        </button>
      )}

      <button
        type="button"
        onClick={onLeave}
        className="btn-cta-danger min-w-[44px] min-h-[44px] px-5 py-3 rounded-xl transition-all flex items-center justify-center gap-2"
      >
        <PhoneOff size={18} className="shrink-0" />
        {label}
      </button>
    </div>
  );
};
