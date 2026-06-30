// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef, useState, useEffect } from 'react';
import { Phone, PhoneOff, Video, GripVertical, Loader2, KeyRound, Shield, AlertTriangle } from 'lucide-react';
import { useRingTone } from '../hooks/useRingTone';
import { LazyGif } from './LazyGif';
import { RoleNameStyle } from './RoleNameStyle';
import { useTranslation } from 'react-i18next';
import { GLASS_MENU_CLASS } from '../utils/contextMenuStyles';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useIsMobile } from '../hooks/useIsMobile';
import { sanitizeImgSrc } from '../utils/sanitizeImgSrc';
import { getFrameUrl } from '../utils/getFrameUrl';
import * as dmKeyManager from '../services/dmKeyManager';
import { ParticipantCardFooter } from './call/ParticipantCardFooter';
import type { PlanTier } from '../shared/planPerks';

interface IncomingDMCallModalProps {
  fromUsername: string;
  fromAvatar?: string;
  fromAvatarEffect?: string | null;
  fromEffectivePlan?: string | null;
  fromBanner?: string | null;
  fromBannerPositionY?: number;
  fromBannerZoom?: number;
  fromNameColor?: string | null;
  fromNameFont?: string | null;
  fromNameEffect?: string | null;
  withVideo?: boolean;
  suppressSound?: boolean;
  needsUnlock?: boolean;
  onAccept: (joinWithVideo: boolean) => void;
  onDecline: () => void;
}

const MODAL_WIDTH = 380;
const CARD_HEIGHT = 200;

export const IncomingDMCallModal: React.FC<IncomingDMCallModalProps> = ({
  fromUsername,
  fromAvatar,
  fromAvatarEffect,
  fromEffectivePlan,
  fromBanner,
  fromBannerPositionY,
  fromBannerZoom,
  fromNameColor,
  fromNameFont,
  fromNameEffect,
  withVideo = false,
  suppressSound = false,
  needsUnlock = false,
  onAccept,
  onDecline,
}) => {
  useRingTone(true, 'ring', suppressSound);
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);
  const isMobile = useIsMobile();

  // Vibrate on mobile for incoming call noticeability
  useEffect(() => {
    if (!isMobile || !navigator.vibrate) return;
    const interval = setInterval(() => {
      navigator.vibrate([200, 100, 200]);
    }, 1500);
    return () => {
      clearInterval(interval);
      navigator.vibrate(0);
    };
  }, [isMobile]);

  // DM encryption unlock state for E2EE calls
  const [unlockPassword, setUnlockPassword] = useState('');
  const [unlockLoading, setUnlockLoading] = useState(false);
  const [unlockError, setUnlockError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [unlockOnLogin] = useState(() => dmKeyManager.getUnlockOnLogin());
  const [acceptAttempted, setAcceptAttempted] = useState(false);
  const [pendingVideo, setPendingVideo] = useState(false);
  const showUnlock = needsUnlock && !unlocked && (unlockOnLogin || acceptAttempted);

  const handleUnlock = async () => {
    if (!unlockPassword) return;
    setUnlockLoading(true);
    setUnlockError(null);
    try {
      await dmKeyManager.unlock(unlockPassword);
      setUnlockPassword('');
      setUnlocked(true);
      if (acceptAttempted) onAccept(pendingVideo);
    } catch {
      setUnlockError(t('dm.secureUnlockFailed'));
    } finally {
      setUnlockLoading(false);
    }
  };

  const handleAcceptClick = (withVideo: boolean) => {
    if (needsUnlock && !unlocked) {
      setPendingVideo(withVideo);
      setAcceptAttempted(true);
    } else {
      onAccept(withVideo);
    }
  };

  const [position, setPosition] = useState(() => ({
    x: Math.round(((typeof window !== 'undefined' ? window.innerWidth : 800) - MODAL_WIDTH) / 2),
    y: Math.round(((typeof window !== 'undefined' ? window.innerHeight : 600) - 380) / 2),
  }));
  const dragRef = useRef<{ startX: number; startY: number; posX: number; posY: number } | null>(null);

  const handleDragStart = (e: React.MouseEvent) => {
    if (isMobile) return; // No dragging on mobile — modal is centered
    e.preventDefault();
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      posX: position.x,
      posY: position.y,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const rawX = d.posX + (e.clientX - d.startX);
      const rawY = d.posY + (e.clientY - d.startY);
      setPosition({
        x: Math.max(0, Math.min(rawX, window.innerWidth - MODAL_WIDTH)),
        y: Math.max(0, Math.min(rawY, window.innerHeight - 380)),
      });
    };
    const onUp = () => { dragRef.current = null; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const unlockForm = (
    <div className="space-y-2.5 mt-1">
      <div className="flex items-center justify-center gap-1.5 text-[var(--cyan-accent)]/80">
        <Shield size={14} />
        <span className="text-[11px] font-medium">{t('incomingCall.e2eeUnlockPrompt', 'Unlock encryption to answer this encrypted call')}</span>
      </div>
      <div className={unlockError ? 'animate-[shake_0.35s_ease-in-out]' : ''}>
        <input
          type="password"
          placeholder={t('dm.securePasswordPlaceholder')}
          value={unlockPassword}
          onChange={(e) => { setUnlockPassword(e.target.value); if (unlockError) setUnlockError(null); }}
          onKeyDown={(e) => e.key === 'Enter' && handleUnlock()}
          className={`w-full px-3 py-2 rounded-lg bg-black/30 border text-sm text-white placeholder-white/30 outline-none transition-colors ${unlockError ? 'border-red-500/70 focus:border-red-500' : 'border-[var(--glass-border)] focus:border-[var(--cyan-accent)]/50'}`}
          autoFocus
          aria-invalid={!!unlockError}
        />
      </div>
      {unlockError && (
        <div role="alert" className="flex items-start gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
          <AlertTriangle size={13} className="text-red-400 shrink-0 mt-0.5" />
          <p className="text-[12px] text-red-300 leading-snug">{unlockError}</p>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onDecline}
          className="flex-1 py-2 rounded-lg bg-red-500/20 text-red-400 hover:bg-red-500/30 text-[11px] font-semibold border border-red-500/30 transition-colors flex items-center justify-center gap-1.5"
        >
          <PhoneOff size={12} /> {t('incomingCall.decline')}
        </button>
        <button
          type="button"
          onClick={handleUnlock}
          disabled={unlockLoading || !unlockPassword}
          className="btn-cta flex-1 py-2 rounded-xl disabled:opacity-50 text-[11px] font-semibold transition-colors flex items-center justify-center gap-1.5"
        >
          {unlockLoading ? <Loader2 size={12} className="animate-spin" /> : <KeyRound size={12} />}
          {t('dm.secureUnlockButton')}
        </button>
      </div>
    </div>
  );

  const acceptButtons = (
    <div className="flex flex-col sm:flex-row gap-2 justify-center sm:flex-wrap">
      <button
        type="button"
        onClick={onDecline}
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 font-medium text-sm border border-red-500/30 transition-colors"
      >
        <PhoneOff size={18} /> {t('incomingCall.decline')}
      </button>
      <button
        type="button"
        onClick={() => handleAcceptClick(false)}
        className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 font-medium text-sm border border-emerald-500/30 transition-colors"
      >
        <Phone size={18} /> {withVideo ? t('incomingCall.joinVoice') : t('incomingCall.accept')}
      </button>
      {withVideo && (
        <button
          type="button"
          onClick={() => handleAcceptClick(true)}
          className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--cyan-accent)]/20 text-[var(--cyan-accent)] hover:bg-[var(--cyan-accent)]/30 font-medium text-sm border border-[var(--cyan-accent)]/30 transition-colors"
        >
          <Video size={18} /> {t('incomingCall.joinVideo')}
        </button>
      )}
    </div>
  );

  const hasStyledName = !!(fromNameColor || fromNameFont || fromNameEffect);
  const styledName = hasStyledName ? (
    <RoleNameStyle
      name={fromUsername}
      overrideColor={fromNameColor ?? undefined}
      overrideFont={fromNameFont ?? undefined}
      nameEffect={fromNameEffect ?? undefined}
    />
  ) : (
    <>{fromUsername}</>
  );

  // Single-card preview — mirrors the active-call participant card layout
  // (banner background + ParticipantCardFooter overlay) so incoming calls feel
  // like a preview of what you're about to join. The avatar gets its ringing
  // pulse via connectionState='ringing'.
  const callerCard = (
    <div className="relative w-full rounded-2xl overflow-hidden border border-[var(--glass-border)] bg-[var(--bg-panel)]" style={{ height: CARD_HEIGHT }}>
      <div className="absolute inset-0 rounded-2xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-br from-[var(--bg-panel)] to-[var(--bg-app)]">
          {fromBanner ? (
            <LazyGif
              src={sanitizeImgSrc(fromBanner)}
              frameSrc={getFrameUrl(fromBanner)}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-95"
              style={{
                objectPosition: `center ${fromBannerPositionY ?? 50}%`,
                ...(fromBannerZoom && fromBannerZoom > 100
                  ? { transform: `scale(${fromBannerZoom / 100})`, transformOrigin: `center ${fromBannerPositionY ?? 50}%` }
                  : {}),
              }}
            />
          ) : fromAvatar ? (
            <img
              src={sanitizeImgSrc(fromAvatar)}
              alt=""
              className="absolute inset-0 w-full h-full object-cover opacity-50"
              style={{ filter: 'blur(24px) saturate(1.3)', transform: 'scale(1.2)' }}
            />
          ) : null}
        </div>
        <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
      </div>
      <div className="absolute bottom-0 left-0 right-0 z-10">
        <ParticipantCardFooter
          avatar={fromAvatar ?? null}
          username={fromUsername}
          nameNode={styledName}
          stream={null}
          connectionState="ringing"
          effectivePlan={(fromEffectivePlan as PlanTier | null | undefined) ?? null}
          avatarEffect={fromAvatarEffect}
        />
      </div>
    </div>
  );

  const eyebrow = (
    <p id="incoming-call-title" className="text-[10px] font-bold uppercase tracking-[0.18em] text-[var(--cyan-accent)] text-center">
      {withVideo ? t('incomingCall.incomingVideoCall') : t('incomingCall.incomingCallFrom')}
    </p>
  );

  // Mobile: centered overlay with safe areas. Desktop: draggable fixed position.
  if (isMobile) {
    return (
      <div
        className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center bg-black/40 modal-safe-area p-4"
        style={{
          paddingLeft: 'max(1rem, env(safe-area-inset-left))',
          paddingRight: 'max(1rem, env(safe-area-inset-right))',
          paddingBottom: 'max(1rem, env(safe-area-inset-bottom))',
        }}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="incoming-call-title"
          className={`${GLASS_MENU_CLASS} glass relative isolate p-4 w-[min(380px,calc(100vw-24px))] spring-pop-in cursor-default select-none safe-area-bottom flex flex-col gap-3`}
        >
          {eyebrow}
          {callerCard}
          {showUnlock ? unlockForm : acceptButtons}
        </div>
      </div>
    );
  }

  // Desktop: draggable floating modal
  return (
    <div className="fixed inset-0 z-[var(--z-modal)] pointer-events-none">
      <div
        className="fixed z-[var(--z-modal)] pointer-events-auto"
        style={{ left: position.x, top: position.y }}
      >
        <div
          ref={dialogRef}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="incoming-call-title"
          className={`${GLASS_MENU_CLASS} glass relative isolate p-4 spring-pop-in cursor-default select-none flex flex-col gap-3`}
          style={{
            width: MODAL_WIDTH,
          }}
        >
          <div
            className="flex items-center justify-center gap-1.5 -mt-1 cursor-grab active:cursor-grabbing text-white/40 hover:text-white/70 transition-colors"
            onMouseDown={handleDragStart}
            title={t('incomingCall.dragToMove')}
            role="button"
            tabIndex={0}
            aria-label={t('incomingCall.dragToMove')}
          >
            <GripVertical size={14} />
            <span className="text-[9px] font-bold uppercase tracking-wider">{t('incomingCall.dragToMove')}</span>
          </div>
          {eyebrow}
          {callerCard}
          {showUnlock ? unlockForm : acceptButtons}
        </div>
      </div>
    </div>
  );
};
