// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Monitor, X, Crown, RefreshCw, Volume2 } from 'lucide-react';
import type { ScreenShareResolution, ScreenShareFps, ScreenShareQuality, ScreenShareCodec } from '../utils/videoConstraints';
import { CODEC_LABELS, detectSupportedCodecs } from '../utils/videoConstraints';
import { useTranslation } from 'react-i18next';
import { getPlanPerks, type PlanTier } from '../shared/planPerks';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useIsMobile } from '../hooks/useIsMobile';

interface DesktopSource {
  id: string;
  name: string;
  thumbnail: string;
  appIcon: string | null;
  display_id: string;
}

interface ScreenSharePickerProps {
  onConfirm: (quality: ScreenShareQuality) => void;
  onCancel: () => void;
  onChangeSource?: (quality: ScreenShareQuality) => void;
  userPlan?: string | null;
  serverPowerUpTier?: number;
  currentQuality?: ScreenShareQuality;
  isSharing?: boolean;
  screenShareCodec?: ScreenShareCodec;
  onCodecChange?: (codec: ScreenShareCodec) => void;
  /** When provided, the selected source ID is passed to onConfirm for Electron getUserMedia */
  selectedSourceId?: string;
  onSourceSelect?: (sourceId: string) => void;
}

const RESOLUTIONS: { value: ScreenShareResolution; label: string; sub: string }[] = [
  { value: '720p', label: '720p', sub: '1280 × 720' },
  { value: '1080p', label: '1080p', sub: '1920 × 1080' },
  { value: '1440p', label: '1440p', sub: '2560 × 1440' },
];

const FPS_OPTIONS: { value: ScreenShareFps; label: string }[] = [
  { value: 30, label: '30 FPS' },
  { value: 60, label: '60 FPS' },
];

const TIER_MAX_RES: Record<number, ScreenShareResolution> = { 0: '720p', 1: '1080p', 2: '1440p', 3: '1440p' };
const TIER_MAX_FPS: Record<number, ScreenShareFps> = { 0: 30, 1: 60, 2: 30, 3: 60 };
const RES_ORDER: ScreenShareResolution[] = ['720p', '1080p', '1440p'];

const CODEC_OPTIONS: ScreenShareCodec[] = ['auto', 'h264', 'vp9', 'av1'];

export function ScreenSharePicker({ onConfirm, onCancel, onChangeSource, userPlan, serverPowerUpTier, currentQuality, isSharing, screenShareCodec = 'auto', onCodecChange }: ScreenSharePickerProps) {
  const isMobile = useIsMobile();
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef);

  // Screen sharing is not supported on mobile browsers
  if (isMobile) return null;
  const perks = getPlanPerks((userPlan ?? null) as PlanTier);

  const planRes = perks.maxScreenShareRes as ScreenShareResolution;
  const planFps = perks.maxScreenShareFps;
  const tierRes = serverPowerUpTier !== undefined ? (TIER_MAX_RES[serverPowerUpTier] ?? '720p') : '720p';
  const tierFps = serverPowerUpTier !== undefined ? (TIER_MAX_FPS[serverPowerUpTier] ?? 30) : 30;

  const maxRes: ScreenShareResolution =
    RES_ORDER.indexOf(planRes) >= RES_ORDER.indexOf(tierRes) ? planRes : tierRes;
  const maxFps: ScreenShareFps = Math.max(planFps, tierFps) as ScreenShareFps;

  const maxResIdx = RES_ORDER.indexOf(maxRes);

  const [resolution, setResolution] = useState<ScreenShareResolution>(() => currentQuality?.resolution ?? '1080p');
  const [fps, setFps] = useState<ScreenShareFps>(() => currentQuality?.fps ?? 30);
  const [shareAudio, setShareAudio] = useState(() => currentQuality?.audio !== false);
  const [codec, setCodec] = useState<ScreenShareCodec>(screenShareCodec);
  const supportedCodecs = useMemo(() => new Set(detectSupportedCodecs()), []);

  const isElectron = typeof window !== 'undefined' && !!window.electron?.getDesktopSources;
  const [desktopSources, setDesktopSources] = useState<DesktopSource[]>([]);
  const [sourceTab, setSourceTab] = useState<'screens' | 'windows'>('screens');
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [sourcesLoading, setSourcesLoading] = useState(false);

  useEffect(() => {
    if (!isElectron) return;
    setSourcesLoading(true);
    window.electron!.getDesktopSources!().then((sources) => {
      setDesktopSources(sources);
      // Auto-select first screen
      const firstScreen = sources.find(s => s.id.startsWith('screen:'));
      if (firstScreen) setSelectedSource(firstScreen.id);
      setSourcesLoading(false);
    }).catch(() => setSourcesLoading(false));
  }, [isElectron]);

  const screens = useMemo(() => desktopSources.filter(s => s.id.startsWith('screen:')), [desktopSources]);
  const windows = useMemo(() => desktopSources.filter(s => s.id.startsWith('window:')), [desktopSources]);
  const visibleSources = sourceTab === 'screens' ? screens : windows;

  const clampedRes = RES_ORDER.indexOf(resolution) > maxResIdx ? maxRes : resolution;
  const clampedFps = fps > maxFps ? maxFps : fps;

  useEffect(() => {
    if (clampedRes !== resolution) setResolution(clampedRes);
    if (clampedFps !== fps) setFps(clampedFps);
  }, [clampedRes, clampedFps, resolution, fps]);

  return (
    <div
      className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4"
      style={{ backgroundColor: 'var(--overlay-backdrop)' }}
      onClick={onCancel}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-share-title"
        className="w-full max-w-sm rounded-2xl border border-[var(--glass-border)] p-6 shadow-2xl spring-pop-in"
        style={{ backgroundColor: 'var(--bg-panel)', backdropFilter: 'blur(24px)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl border border-emerald-500/30 bg-emerald-500/10 flex items-center justify-center">
              <Monitor size={18} className="text-emerald-400" />
            </div>
            <div>
              <h3 id="screen-share-title" className="text-sm font-bold" style={{ color: 'var(--text-primary)' }}>{isSharing ? t('screenShare.settingsTitle', 'Screen Share Settings') : t('screenShare.title')}</h3>
              <p className="text-[11px]" style={{ color: 'var(--text-secondary)' }}>{isSharing ? t('screenShare.changeQuality', 'Change quality for your active screen share') : t('screenShare.chooseQuality')}</p>
            </div>
          </div>
          <button type="button" onClick={onCancel} className="p-1.5 rounded-lg hover:bg-fill-active transition-colors" style={{ color: 'var(--text-secondary)' }}>
            <X size={16} />
          </button>
        </div>

        {/* Electron source picker */}
        {isElectron && (
          <>
            <div className="flex gap-1 mb-3">
              <button type="button" onClick={() => setSourceTab('screens')} className={`flex-1 text-[10px] font-bold uppercase tracking-widest py-1.5 rounded-lg transition-all ${sourceTab === 'screens' ? 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/30' : 'text-white/50 hover:text-white/70 border border-transparent'}`}>
                {t('screenShare.screens', 'Screens')} ({screens.length})
              </button>
              <button type="button" onClick={() => setSourceTab('windows')} className={`flex-1 text-[10px] font-bold uppercase tracking-widest py-1.5 rounded-lg transition-all ${sourceTab === 'windows' ? 'bg-[var(--cyan-accent)]/10 text-[var(--cyan-accent)] border border-[var(--cyan-accent)]/30' : 'text-white/50 hover:text-white/70 border border-transparent'}`}>
                {t('screenShare.windows', 'Windows')} ({windows.length})
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 mb-4 max-h-[240px] overflow-y-auto pr-1">
              {sourcesLoading ? (
                <div className="col-span-2 flex items-center justify-center py-8">
                  <div className="animate-spin w-5 h-5 border-2 border-[var(--cyan-accent)] border-t-transparent rounded-full" />
                </div>
              ) : visibleSources.map((src) => (
                <button
                  key={src.id}
                  type="button"
                  onClick={() => setSelectedSource(src.id)}
                  className={`rounded-xl border overflow-hidden transition-all hover:brightness-110 ${selectedSource === src.id ? 'border-[var(--cyan-accent)] ring-1 ring-[var(--cyan-accent)]/30' : 'border-[var(--glass-border)] hover:border-[var(--border-strong)]'}`}
                >
                  <img src={src.thumbnail} alt={src.name} className="w-full aspect-video object-cover" loading="lazy" decoding="async" draggable={false} />
                  <div className="flex items-center gap-1.5 px-2 py-1.5" style={{ backgroundColor: 'var(--fill-selected)' }}>
                    {src.appIcon && <img src={src.appIcon} alt="" className="w-3.5 h-3.5 rounded-sm" loading="lazy" decoding="async" width={14} height={14} draggable={false} />}
                    <span className="text-[10px] font-medium truncate" style={{ color: 'var(--text-primary)' }}>{src.name}</span>
                  </div>
                </button>
              ))}
              {!sourcesLoading && visibleSources.length === 0 && (
                <p className="col-span-2 text-center text-[11px] py-4" style={{ color: 'var(--text-secondary)' }}>
                  {t('screenShare.noSources', 'No sources found')}
                </p>
              )}
            </div>
          </>
        )}

        {/* Resolution */}
        <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('screenShare.resolution')}</p>
        <div className="flex gap-2 mb-4">
          {RESOLUTIONS.map((r) => {
            const locked = RES_ORDER.indexOf(r.value) > maxResIdx;
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => !locked && setResolution(r.value)}
                className={`flex-1 rounded-xl border py-2.5 px-2 text-center transition-all relative ${
                  locked
                    ? 'border-default opacity-40 cursor-not-allowed'
                    : resolution === r.value
                      ? 'btn-cta-selected'
                      : 'border-[var(--glass-border)] hover:border-[var(--border-strong)] hover:bg-fill-hover'
                }`}
              >
                <p className="text-xs font-bold" style={{ color: !locked && resolution === r.value ? '#fff' : 'var(--text-primary)' }}>
                  {r.label}
                </p>
                <p className="text-[10px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>{r.sub}</p>
                {locked && (
                  <span className="pro-shimmer-badge absolute -top-1.5 -right-1.5 text-[8px] font-black border border-[var(--cyan-accent)]/30 text-[var(--cyan-accent)] px-1.5 py-0.5 rounded-full flex items-center gap-0.5" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)' }}>
                    <Crown size={8} />{t('screenShare.upgrade')}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Frame rate */}
        <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('screenShare.frameRate')}</p>
        <div className="flex gap-2 mb-6">
          {FPS_OPTIONS.map((f) => {
            const locked = f.value > maxFps;
            return (
              <button
                key={f.value}
                type="button"
                onClick={() => !locked && setFps(f.value)}
                className={`flex-1 rounded-xl border py-2.5 px-3 text-center transition-all relative ${
                  locked
                    ? 'border-default opacity-40 cursor-not-allowed'
                    : fps === f.value
                      ? 'btn-cta-selected'
                      : 'border-[var(--glass-border)] hover:border-[var(--border-strong)] hover:bg-fill-hover'
                }`}
              >
                <p className="text-xs font-bold" style={{ color: !locked && fps === f.value ? '#fff' : 'var(--text-primary)' }}>
                  {f.label}
                </p>
                {locked && (
                  <span className="pro-shimmer-badge absolute -top-1.5 -right-1.5 text-[8px] font-black border border-[var(--cyan-accent)]/30 text-[var(--cyan-accent)] px-1.5 py-0.5 rounded-full flex items-center gap-0.5" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 18%, transparent)' }}>
                    <Crown size={8} />{t('screenShare.upgrade')}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Codec */}
        <p className="text-[10px] font-bold uppercase tracking-widest mb-2" style={{ color: 'var(--text-secondary)' }}>{t('settings.voice.codec')}</p>
        <div className="flex gap-2 mb-4">
          {CODEC_OPTIONS.map((c) => {
            const unsupported = c !== 'auto' && !supportedCodecs.has(c);
            return (
              <button
                key={c}
                type="button"
                onClick={() => {
                  if (unsupported) return;
                  setCodec(c);
                  onCodecChange?.(c);
                }}
                className={`flex-1 rounded-xl border py-2 px-2 text-center transition-all ${
                  unsupported
                    ? 'border-default opacity-30 cursor-not-allowed'
                    : codec === c
                      ? 'btn-cta-selected'
                      : 'border-[var(--glass-border)] hover:border-[var(--border-strong)] hover:bg-fill-hover'
                }`}
              >
                <p className="text-[11px] font-bold" style={{ color: !unsupported && codec === c ? '#fff' : 'var(--text-primary)' }}>
                  {CODEC_LABELS[c]}
                </p>
              </button>
            );
          })}
        </div>

        {/* Share audio */}
        <button
          type="button"
          onClick={() => setShareAudio(!shareAudio)}
          className="w-full flex items-center gap-3 mb-4 px-3 py-2.5 rounded-xl border transition-all"
          style={{
            borderColor: shareAudio ? 'var(--accent-glow)' : 'var(--glass-border)',
            backgroundColor: shareAudio ? 'var(--accent-subtle)' : 'var(--fill-hover)',
          }}
        >
          <Volume2 size={14} style={{ color: shareAudio ? 'var(--cyan-accent)' : 'var(--text-secondary)' }} className="shrink-0" />
          <div className="flex-1 text-left">
            <p className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{t('screenShare.shareAudio', 'Share audio')}</p>
            <p className="text-[10px]" style={{ color: 'var(--text-secondary)' }}>{t('screenShare.shareAudioDesc', 'Include system audio with your screen')}</p>
          </div>
          <div className={`w-8 h-[18px] rounded-full transition-colors relative ${shareAudio ? 'bg-[var(--cyan-accent)]' : 'bg-fill-strong'}`}>
            <div className={`absolute top-[2px] w-[14px] h-[14px] rounded-full bg-white shadow transition-transform ${shareAudio ? 'translate-x-[16px]' : 'translate-x-[2px]'}`} />
          </div>
        </button>

        {/* Change source (only when already sharing) */}
        {isSharing && onChangeSource && (
          <button
            type="button"
            onClick={() => onChangeSource({ resolution, fps, audio: shareAudio, codec, ...(selectedSource ? { sourceId: selectedSource } : {}) })}
            className="btn-secondary w-full flex items-center justify-center gap-2 text-[10px] uppercase tracking-widest py-2.5 mb-4"
          >
            <RefreshCw size={12} />
            {t('screenShare.changeSource', 'Change Window / Screen')}
          </button>
        )}

        {/* Actions */}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onCancel}
            className="btn-secondary flex-1 text-[10px] uppercase tracking-widest py-2.5"
          >
            {t('common.cancel')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ resolution, fps, audio: shareAudio, codec, ...(selectedSource ? { sourceId: selectedSource } : {}) })}
            className="btn-cta flex-1 text-[10px] uppercase tracking-widest py-2.5 rounded-xl transition-all"
          >
            {isSharing ? t('screenShare.applySettings', 'Apply Quality') : t('screenShare.startSharing')}
          </button>
        </div>
      </div>
    </div>
  );
}
