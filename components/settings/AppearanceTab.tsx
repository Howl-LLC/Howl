// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { User } from '../../types';
import { getBackendOrigin } from '../../config';
import {
  Monitor, Check, Crown, Upload, Trash2, Play, Pause,
  Image, Layers, AtSign, Layout
} from 'lucide-react';
import { AppTheme } from '../../App';
import { apiClient } from '../../services/api';
import {
  getStoredCustomTheme, saveCustomTheme, applyCustomTheme,
  getDefaultStatusBarHex, type CustomThemeColors
} from '../../services/themeUtils';
import type { UiDensity, ChatMessageDisplay } from '../../utils/uiDensityStorage';
import { useSettings } from '../../contexts/SettingsContext';
import { MENTION_HIGHLIGHT_PRESETS, type MentionHighlightColor } from '../../utils/uiDensityStorage';
import { getPlanPerks, type PlanTier } from '../../shared/planPerks';
import { ColorPicker } from '../ColorPicker';
import { LazyGif } from '../LazyGif';
import { getFrameUrl } from '../../utils/getFrameUrl';
import { AppearancePreview } from './AppearancePreview';

/** Zoom slider with draft-state pattern to prevent feedback loop. */
const ZoomSlider: React.FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => {
  const [draft, setDraft] = useState(value);
  const [isDragging, setIsDragging] = useState(false);

  // Sync draft with external value when not dragging
  useEffect(() => {
    if (!isDragging) setDraft(value);
  }, [value, isDragging]);

  const displayValue = isDragging ? draft : value;
  const fillPct = ((displayValue - 50) / 150) * 100;

  return (
    <input
      type="range"
      min={50}
      max={200}
      step={5}
      value={displayValue}
      onPointerDown={() => setIsDragging(true)}
      onInput={(e) => {
        if (isDragging) {
          setDraft(Number((e.target as HTMLInputElement).value));
        }
      }}
      onPointerUp={() => {
        setIsDragging(false);
        onChange(draft);
      }}
      onMouseUp={() => {
        setIsDragging(false);
        onChange(draft);
      }}
      onChange={(e) => {
        if (!isDragging) {
          onChange(Number(e.target.value));
        }
      }}
      className="appearance-none w-full h-4 rounded-full bg-transparent cursor-pointer [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--cyan-accent)] [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in_srgb,var(--cyan-accent)_40%,transparent)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:-mt-[5px] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--cyan-accent)] [&::-moz-range-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in_srgb,var(--cyan-accent)_40%,transparent)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
      style={{
        background: `linear-gradient(to right, color-mix(in srgb, var(--cyan-accent) 40%, transparent) 0%, color-mix(in srgb, var(--cyan-accent) 40%, transparent) ${fillPct}%, var(--fill-active) ${fillPct}%, var(--fill-active) 100%)`,
        borderRadius: '9999px',
        touchAction: 'none',
      }}
    />
  );
};

export interface AppearanceTabProps {
  user: User;
  isMobile?: boolean;
  currentTheme?: AppTheme;
  onThemeChange?: (theme: AppTheme) => void;
  uiDensity?: UiDensity;
  onUiDensityChange?: (d: UiDensity) => void;
  chatMessageDisplay?: ChatMessageDisplay;
  onChatMessageDisplayChange?: (v: ChatMessageDisplay) => void;
  messageGroupSpacing?: number;
  onMessageGroupSpacingChange?: (px: number) => void;
  chatFontSize?: number;
  onChatFontSizeChange?: (px: number) => void;
  zoomLevel?: number;
  onZoomLevelChange?: (pct: number) => void;
  backgroundImage?: string | null;
  onBackgroundImageChange?: (dataUrl: string | null) => void;
  backgroundOpacity?: number;
  onBackgroundOpacityChange?: (opacity: number) => void;
  backgroundBlur?: number;
  onBackgroundBlurChange?: (blur: number) => void;
  bgGifAlwaysPlay?: boolean;
  onBgGifAlwaysPlayChange?: (always: boolean) => void;
  subscription?: { plan: string | null; status: string | null; currentPeriodEnd: string | null } | null;
}

export const AppearanceTab: React.FC<AppearanceTabProps> = ({
  user: _user,
  isMobile = false,
  currentTheme,
  onThemeChange,
  uiDensity: propUiDensity = 'default',
  onUiDensityChange,
  chatMessageDisplay: propChatMessageDisplay = 'default',
  onChatMessageDisplayChange,
  messageGroupSpacing = 16,
  onMessageGroupSpacingChange,
  chatFontSize = 16,
  onChatFontSizeChange,
  zoomLevel = 100,
  onZoomLevelChange,
  backgroundImage,
  onBackgroundImageChange,
  backgroundOpacity = 0.15,
  onBackgroundOpacityChange,
  backgroundBlur = 0,
  onBackgroundBlurChange,
  bgGifAlwaysPlay = false,
  onBgGifAlwaysPlayChange,
  subscription,
}) => {
  const { t } = useTranslation();
  const { mentionHighlightColor, setMentionHighlightColor, serverLayout, setServerLayout } = useSettings();
  const [customColors, setCustomColors] = useState<CustomThemeColors>(() => getStoredCustomTheme());

  useEffect(() => {
    if (currentTheme === 'custom') setCustomColors(getStoredCustomTheme());
  }, [currentTheme]);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2 text-t-primary">{t('settings.appearanceTab')}</h2>
      <p className="text-xs mb-8 text-t-secondary">{t('settings.personalizeExperience')}</p>

      {/* Unified live preview — reflects every appearance setting (theme,
          density, font size, group spacing, mention highlight, server layout)
          in a single panel. Replaces both the previous top preview and the
          standalone mention-highlight preview that used to live inside the
          Mention Highlight card. */}
      <div className="mb-8">
        <p className="text-[10px] font-bold uppercase tracking-widest mb-3 text-t-secondary">{t('settings.preview')}</p>
        <AppearancePreview />
      </div>

      <div id="setting-theme" className="border border-[var(--glass-border)] rounded-2xl p-6 mb-8 bg-panel">
        <h3 className="font-black text-xs uppercase tracking-wider mb-5 flex items-center text-t-primary">
          <Monitor size={14} className="mr-2 text-[var(--cyan-accent)]" /> {t('settings.theme')}
        </h3>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-4">
          {/* Order: Dark (new default) → Light → Grey → Howl → Custom. */}
          {([
            { id: 'void' as AppTheme, label: t('settings.void'), bg: '#000000', border: 'border-[var(--glass-border)]', accent: '#076FA0' },
            { id: 'light' as AppTheme, label: t('settings.lumina'), bg: '#e9edf2', border: 'border-slate-200', accent: '#076FA0' },
            { id: 'matter' as AppTheme, label: t('settings.matter'), bg: '#1C1F23', border: 'border-[var(--glass-border)]', accent: '#076FA0' },
            { id: 'neural' as AppTheme, label: t('settings.howl'), bg: '#0c0e13', border: 'border-[var(--cyan-accent)]/20', accent: '#076FA0' },
            { id: 'custom' as AppTheme, label: t('settings.custom'), bg: customColors.bgApp, border: 'border-[var(--border-strong)]', accent: customColors.accent },
          ]).map((th) => (
            <button
              key={th.id}
              onClick={() => onThemeChange?.(th.id)}
              className={`flex flex-col items-center p-4 rounded-xl border transition-all ${
                currentTheme === th.id
                  ? 'btn-cta-selected'
                  : 'bg-black/20 border-[var(--glass-border)] hover:border-[var(--cyan-accent)]/20'
              }`}
            >
              <div
                className={`w-full h-14 rounded-lg ${th.border} mb-3 flex items-center justify-center relative overflow-hidden`}
                style={th.id === 'custom'
                  ? { background: `linear-gradient(135deg, ${th.bg} 50%, ${th.accent} 50%)` }
                  : { backgroundColor: th.bg }}
              >
                {currentTheme === th.id && <Check size={14} className="text-[var(--cyan-accent)] drop-shadow" />}
                <div className="absolute bottom-1.5 left-2 w-4 h-0.5 rounded-full" style={{ backgroundColor: th.accent, opacity: 0.6 }} />
              </div>
              <span className="text-[10px] font-black uppercase tracking-wider truncate max-w-full" style={{ color: currentTheme === th.id ? '#fff' : 'var(--text-secondary)' }}>{th.label}</span>
            </button>
          ))}
        </div>

        {currentTheme === 'custom' && (
          <div className="mt-6 pt-6 border-t border-[var(--glass-border)]">
            <p className="text-[10px] font-bold uppercase tracking-widest mb-4 text-t-secondary">{t('settings.customColors')}</p>
            <div className="flex flex-wrap gap-6">
              {[
                { key: 'accent' as const, label: t('settings.accent'), settingId: 'setting-custom-color-accent' },
                { key: 'bgApp' as const, label: t('settings.background'), settingId: 'setting-custom-color-background' },
                { key: 'bgStatusBar' as const, label: t('settings.statusBar'), settingId: 'setting-custom-color-status-bar' },
              ].map(({ key, label, settingId }) => (
                <div key={key} id={settingId} className="flex items-center gap-3">
                  <span className="text-[11px] uppercase tracking-wider text-t-primary">{label}</span>
                  <ColorPicker
                    value={key === 'bgStatusBar' ? (customColors.bgStatusBar ?? getDefaultStatusBarHex(customColors)) : customColors[key]}
                    onChange={(hex) => {
                      const next = { ...customColors, [key]: hex };
                      setCustomColors(next);
                      saveCustomTheme(next);
                      onThemeChange?.('custom');
                      applyCustomTheme(next);
                    }}
                  />
                  <span className="text-[10px] font-mono break-all text-t-secondary">
                    {key === 'bgStatusBar' ? (customColors.bgStatusBar ?? getDefaultStatusBarHex(customColors)) : customColors[key]}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

      </div>

      {/* Server Layout — Default vs Classic. Sits between Theme and
          Mention Highlight. */}
      <div id="setting-server-layout" className="border border-[var(--glass-border)] rounded-2xl p-6 mb-8 bg-panel">
        <h3 className="font-black text-xs uppercase tracking-wider mb-1 flex items-center text-t-primary">
          <Layout size={14} className="mr-2 text-[var(--cyan-accent)]" /> {t('settings.appearance.serverLayout')}
        </h3>
        <p className="text-[11px] mb-5 text-t-secondary">{t('settings.appearance.serverLayoutDesc')}</p>
        <div className="grid grid-cols-2 gap-4">
          {(['default', 'classic'] as const).map((opt) => {
            const isActive = serverLayout === opt;
            return (
              <button
                key={opt}
                type="button"
                onClick={() => setServerLayout(opt)}
                className={`flex flex-col items-center p-4 rounded-xl border transition-all ${
                  isActive
                    ? 'btn-cta-selected'
                    : 'bg-black/20 border-[var(--glass-border)] hover:border-[var(--cyan-accent)]/20'
                }`}
              >
                <div className="w-full h-14 rounded-lg mb-3 flex items-center justify-center bg-gradient-to-br from-blue-900/40 to-slate-950 overflow-hidden relative">
                  {opt === 'default' ? (
                    <div className="absolute inset-1">
                      {/* Navigator: rail-less — full-bleed content + a floating logo and fanned launcher tiles */}
                      <div className="absolute inset-0 rounded-sm bg-white/[0.04]" />
                      <div className="absolute top-1 left-1 w-2.5 h-2.5 rounded-[3px] bg-[var(--cyan-accent)]/70" />
                      <div className="absolute top-1.5 left-5 w-1.5 h-1.5 rounded-sm bg-white/20" />
                      <div className="absolute top-4 left-2 w-1.5 h-1.5 rounded-sm bg-white/[0.14]" />
                    </div>
                  ) : (
                    <div className="absolute inset-1 grid grid-cols-3 gap-0.5">
                      <div className="bg-white/[0.06] rounded-sm flex flex-col gap-0.5 p-0.5">
                        <div className="h-0.5 bg-white/[0.18] rounded-lg" />
                        <div className="h-0.5 bg-white/[0.10] rounded-lg" />
                        <div className="h-0.5 bg-white/[0.10] rounded-lg" />
                        <div className="h-0.5 bg-white/[0.18] rounded-lg mt-0.5" />
                        <div className="h-0.5 bg-white/[0.10] rounded-lg" />
                      </div>
                      <div className="col-span-2 bg-white/[0.04] rounded-sm" />
                    </div>
                  )}
                  {isActive && (
                    <Check size={14} className="absolute top-1 right-1 text-[var(--cyan-accent)]" />
                  )}
                </div>
                <span
                  className="text-[10px] font-black uppercase tracking-wider truncate max-w-full"
                  style={{ color: isActive ? '#fff' : 'var(--text-secondary)' }}
                >
                  {t(`settings.appearance.serverLayout.${opt}`)}
                </span>
                <span
                  className="text-[9px] mt-1 text-center leading-tight"
                  style={{ color: 'var(--text-secondary)', opacity: 0.75 }}
                >
                  {t(`settings.appearance.serverLayout.${opt}.desc`)}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Mention Highlight Color */}
      <div id="setting-mention-highlight-color" className="border border-[var(--glass-border)] rounded-2xl p-6 mb-8 bg-panel">
        <h3 className="font-black text-xs uppercase tracking-wider mb-1 flex items-center text-t-primary">
          <AtSign size={14} className="mr-2 text-[var(--cyan-accent)]" /> {t('settings.appearance.mentionHighlight')}
        </h3>
        <p className="text-[11px] mb-5 text-t-secondary">{t('settings.appearance.mentionHighlightDesc')}</p>

        {/* Color swatches */}
        <div className="flex flex-wrap gap-3 mb-6">
          {(Object.keys(MENTION_HIGHLIGHT_PRESETS) as MentionHighlightColor[]).map((colorKey) => {
            const preset = MENTION_HIGHLIGHT_PRESETS[colorKey];
            const isActive = mentionHighlightColor === colorKey;
            return (
              <button
                key={colorKey}
                type="button"
                onClick={() => setMentionHighlightColor(colorKey)}
                className="flex flex-col items-center gap-1.5 group"
              >
                <div
                  className={`w-9 h-9 rounded-full border-2 transition-all duration-150 ${
                    isActive
                      ? 'border-[var(--cyan-accent)] shadow-[0_0_10px_var(--accent-glow)] scale-110'
                      : 'border-transparent hover:border-[var(--border-strong)] hover:scale-105'
                  }`}
                  style={{ backgroundColor: preset.hex }}
                >
                  {isActive && (
                    <div className="w-full h-full flex items-center justify-center">
                      <Check size={14} className={colorKey === 'white' ? 'text-black' : 'text-white'} style={{ filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' }} />
                    </div>
                  )}
                </div>
                <span
                  className="text-[9px] font-bold uppercase tracking-wider"
                  style={{ color: isActive ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
                >
                  {t(`settings.appearance.mentionColor.${colorKey}`)}
                </span>
              </button>
            );
          })}
        </div>

        {/* The standalone mention-highlight preview that lived here is now
            part of the unified <AppearancePreview /> at the top of the tab. */}
      </div>

      {/* Background Image */}
      {(() => {
        const bgPerks = getPlanPerks((subscription?.plan ?? null) as PlanTier);
        const canBg = bgPerks.canCustomBackground;
        const isPro = subscription?.plan === 'pro';
        const acceptFormats = isPro
          ? 'image/png,image/jpeg,image/gif'
          : 'image/png,image/jpeg';
        const formatLabel = isPro ? 'PNG, JPG, or GIF' : 'PNG or JPG';
        const bgInputRef = React.createRef<HTMLInputElement>();
        const handleBgUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
          const file = e.target.files?.[0];
          if (!file) return;
          if (file.size > 10 * 1024 * 1024) return;
          const allowed = isPro
            ? ['image/png', 'image/jpeg', 'image/gif']
            : ['image/png', 'image/jpeg'];
          if (!allowed.includes(file.type)) return;
          try {
            const uploaded = await apiClient.uploadFile(file);
            const relUrl = uploaded.url.startsWith('http')
              ? new URL(uploaded.url).pathname
              : uploaded.url;
            await apiClient.updateMeProfile({ backgroundImage: relUrl });
            const fullUrl = relUrl.startsWith('/') ? getBackendOrigin() + relUrl : relUrl;
            onBackgroundImageChange?.(fullUrl);
          } catch (err) {
            console.error('Background upload failed:', err);
          }
          e.target.value = '';
        };
        return (
          <div id="setting-background-image-upload" className="border border-[var(--glass-border)] rounded-2xl mb-8 relative overflow-hidden bg-panel">
            {!canBg && (
              <div className="absolute inset-0 z-10 rounded-2xl flex flex-col items-center justify-center gap-3" style={{ background: 'linear-gradient(180deg, var(--overlay-backdrop) 0%, color-mix(in srgb, var(--overlay-backdrop) 85%, transparent) 100%)' }}>
                <div className="pro-shimmer-badge flex items-center gap-2 px-5 py-3 rounded-2xl border border-[var(--cyan-accent)]/30" style={{ backgroundColor: 'color-mix(in srgb, var(--cyan-accent) 15%, transparent)', backdropFilter: 'blur(8px)' }}>
                  <Crown size={18} className="text-[var(--cyan-accent)]" />
                  <span className="text-sm font-black uppercase tracking-wider text-[var(--cyan-accent)]">{t('settings.appearance.essentialFeature')}</span>
                </div>
                <p className="text-[10px] text-t-secondary max-w-[260px] text-center">{t('settings.appearance.bgUpgradeHint')}</p>
              </div>
            )}
            <div className={`p-6 ${!canBg ? 'opacity-30 blur-[1px] pointer-events-none select-none' : ''}`}>
            <h3 className="font-black text-xs uppercase tracking-wider mb-1 flex items-center text-t-primary">
              <Image size={14} className="mr-2 text-[var(--cyan-accent)]" /> {t('settings.appearance.backgroundImage')}
            </h3>
            <p className="text-[11px] mb-5 text-t-secondary">
              {t('settings.appearance.bgDesc')}
              {!isPro && canBg && <span className="ml-1 text-[var(--cyan-accent)]/70">{t('settings.appearance.bgUpgradeGif')}</span>}
            </p>

            {backgroundImage ? (
              <div className="space-y-4">
                <div className="flex items-start gap-5">
                  <div className="relative w-48 h-28 rounded-xl overflow-hidden border border-[var(--glass-border)] shrink-0 group">
                    <LazyGif src={backgroundImage} frameSrc={getFrameUrl(backgroundImage)} alt={t('settings.appearance.bgPreviewAlt')} className="w-full h-full object-cover" />
                    <div className="absolute inset-0 bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center gap-2">
                      <button id="setting-background-image-change" type="button" onClick={() => bgInputRef.current?.click()} className="p-2 rounded-lg bg-fill-active hover:bg-fill-stronger transition-colors" title={t('settings.appearance.changeImage')} aria-label={t('settings.appearance.changeImage')}>
                        <Upload size={14} className="text-white" />
                      </button>
                      <button id="setting-background-image-remove" type="button" onClick={() => { const prev = backgroundImage; onBackgroundImageChange?.(null); apiClient.updateMeProfile({ backgroundImage: null }).catch(() => { onBackgroundImageChange?.(prev ?? null); }); }} className="p-2 rounded-lg bg-red-500/20 hover:bg-red-500/30 transition-colors" title={t('settings.appearance.removeImage')} aria-label={t('settings.appearance.removeImage')}>
                        <Trash2 size={14} className="text-red-400" />
                      </button>
                    </div>
                  </div>
                  <div className="flex-1 min-w-0 space-y-3">
                    <div id="setting-background-opacity">
                      <label className="text-[10px] font-bold uppercase tracking-widest mb-2 block text-t-secondary">{t('settings.appearance.opacity')}</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0.05}
                          max={0.5}
                          step={0.01}
                          value={backgroundOpacity}
                          onChange={(e) => { const v = parseFloat(e.target.value); onBackgroundOpacityChange?.(v); }}
                          onMouseUp={(e) => { apiClient.updateMeProfile({ backgroundOpacity: parseFloat((e.target as HTMLInputElement).value) }).catch(() => {}); }}
                          onTouchEnd={(e) => { apiClient.updateMeProfile({ backgroundOpacity: parseFloat((e.target as HTMLInputElement).value) }).catch(() => {}); }}
                          className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--cyan-accent)]"
                          style={{ background: `linear-gradient(to right, var(--cyan-accent) ${((backgroundOpacity - 0.05) / 0.45) * 100}%, var(--fill-active) ${((backgroundOpacity - 0.05) / 0.45) * 100}%)` }}
                        />
                        <span className="text-[11px] font-bold tabular-nums w-10 text-right text-t-secondary">{Math.round(backgroundOpacity * 100)}%</span>
                      </div>
                    </div>
                    <div id="setting-background-frosted-effect">
                      <label className="text-[10px] font-bold uppercase tracking-widest mb-2 block text-t-secondary">{t('settings.appearance.frostedEffect')}</label>
                      <div className="flex items-center gap-3">
                        <input
                          type="range"
                          min={0}
                          max={20}
                          step={1}
                          value={backgroundBlur}
                          onChange={(e) => { const v = parseInt(e.target.value, 10); onBackgroundBlurChange?.(v); }}
                          onMouseUp={(e) => { apiClient.updateMeProfile({ backgroundBlur: parseInt((e.target as HTMLInputElement).value, 10) }).catch(() => {}); }}
                          onTouchEnd={(e) => { apiClient.updateMeProfile({ backgroundBlur: parseInt((e.target as HTMLInputElement).value, 10) }).catch(() => {}); }}
                          className="flex-1 h-1.5 rounded-full appearance-none cursor-pointer accent-[var(--cyan-accent)]"
                          style={{ background: `linear-gradient(to right, var(--cyan-accent) ${(backgroundBlur / 20) * 100}%, var(--fill-active) ${(backgroundBlur / 20) * 100}%)` }}
                        />
                        <span className="text-[11px] font-bold tabular-nums w-10 text-right text-t-secondary">{backgroundBlur}px</span>
                      </div>
                    </div>
                    {backgroundImage && /\.gif($|\?)/i.test(backgroundImage) && (
                      <div id="setting-gif-always-play">
                        <button
                          type="button"
                          onClick={() => { const next = !bgGifAlwaysPlay; onBgGifAlwaysPlayChange?.(next); apiClient.updateMeProfile({ bgGifAlwaysPlay: next }).catch(() => {}); }}
                          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border transition-all text-[10px] font-bold uppercase tracking-widest"
                          style={{
                            borderColor: bgGifAlwaysPlay ? 'color-mix(in srgb, var(--cyan-accent) 40%, transparent)' : 'var(--fill-active)',
                            backgroundColor: bgGifAlwaysPlay ? 'color-mix(in srgb, var(--cyan-accent) 10%, transparent)' : 'var(--fill-hover)',
                            color: bgGifAlwaysPlay ? 'rgb(34,211,238)' : 'var(--text-secondary)',
                          }}
                        >
                          {bgGifAlwaysPlay ? <Pause size={12} /> : <Play size={12} />}
                          {bgGifAlwaysPlay ? t('settings.appearance.alwaysPlaying') : t('settings.appearance.pauseWhenInactive')}
                        </button>
                        <p className="text-[10px] mt-1.5 text-t-secondary" style={{ opacity: 0.6 }}>
                          {bgGifAlwaysPlay ? t('settings.appearance.gifPlaysBackground') : t('settings.appearance.gifPausesAway')}
                        </p>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => bgInputRef.current?.click()}
                className="flex flex-col items-center justify-center w-full h-28 rounded-xl border-2 border-dashed border-[var(--glass-border)] hover:border-[var(--cyan-accent)]/30 hover:bg-[var(--cyan-accent)]/5 transition-all gap-2"
              >
                <Upload size={20} className="text-t-secondary" />
                <span className="text-[11px] font-bold uppercase tracking-wider text-t-secondary">{t('settings.appearance.uploadBgImage')}</span>
                <span className="text-[10px] text-t-secondary" style={{ opacity: 0.6 }}>{formatLabel} — max 10 MB</span>
              </button>
            )}
            <input ref={bgInputRef} type="file" accept={acceptFormats} className="hidden" onChange={handleBgUpload} />
            </div>
          </div>
        );
      })()}

      {/* UI Density */}
      <div id="setting-ui-density" className="border border-[var(--glass-border)] rounded-2xl p-6 mb-6 bg-panel">
        <h3 className="font-black text-xs uppercase tracking-wider mb-1 flex items-center text-t-primary">
          <Layers size={14} className="mr-2 text-[var(--cyan-accent)]" /> {t('settings.uiDensity')}
        </h3>
        <p className="text-[11px] mb-4 text-t-secondary">{t('settings.appearance.uiDensityDesc')}</p>
        <div className="flex flex-wrap gap-2">
          {(['compact', 'default', 'spacious'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => onUiDensityChange?.(d)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-all ${
                propUiDensity === d ? 'btn-cta-selected' : 'border-[var(--glass-border)] hover:border-[var(--cyan-accent)]/20 text-t-secondary'
              }`}
            >
              {d === 'compact' ? t('settings.compact') : d === 'spacious' ? t('settings.spacious') : t('settings.default')}
            </button>
          ))}
        </div>
      </div>

      {/* Message spacing */}
      <div className="border border-[var(--glass-border)] rounded-2xl p-6 mb-6 bg-panel">
        <h3 className="font-black text-xs uppercase tracking-wider mb-1 text-t-primary">{t('settings.appearance.messageSpacing')}</h3>
        <p className="text-[11px] mb-5 text-t-secondary">{t('settings.appearance.messageSpacingDesc')}</p>

        <div id="setting-chat-message-display" className="mb-6">
          <p className="text-[10px] font-bold uppercase tracking-widest mb-2.5 text-t-secondary">{t('settings.chatMessageDisplay')}</p>
          <div className="flex gap-1.5 p-1 rounded-xl w-fit" style={{ backgroundColor: 'var(--fill-hover)' }}>
            {(['compact', 'default'] as const).map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => onChatMessageDisplayChange?.(d)}
                className={`px-4 py-2 rounded-lg text-[11px] font-bold uppercase tracking-wider transition-all duration-200 ${
                  propChatMessageDisplay === d ? 'bg-[var(--cyan-accent)]/25 text-[var(--cyan-accent)] shadow-sm' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {d === 'compact' ? t('settings.compact') : t('settings.default')}
              </button>
            ))}
          </div>
        </div>

        <div id="setting-message-group-spacing">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-t-secondary">{t('settings.spaceBetweenGroups')}</p>
            <span className="text-xs font-semibold tabular-nums text-[var(--cyan-accent)]">{messageGroupSpacing}px</span>
          </div>
          <input
            type="range"
            min={0}
            max={24}
            step={2}
            value={messageGroupSpacing}
            onInput={(e) => onMessageGroupSpacingChange?.(Number((e.target as HTMLInputElement).value))}
            onChange={(e) => onMessageGroupSpacingChange?.(Number(e.target.value))}
            className="appearance-none w-full h-4 rounded-full bg-transparent cursor-pointer [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--cyan-accent)] [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in srgb, var(--cyan-accent) 40%, transparent)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:-mt-[5px] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--cyan-accent)] [&::-moz-range-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in srgb, var(--cyan-accent) 40%, transparent)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
            style={{ background: `linear-gradient(to right, color-mix(in srgb, var(--cyan-accent) 40%, transparent) 0%, color-mix(in srgb, var(--cyan-accent) 40%, transparent) ${(messageGroupSpacing / 24) * 100}%, var(--fill-active) ${(messageGroupSpacing / 24) * 100}%, var(--fill-active) 100%)`, borderRadius: '9999px', touchAction: 'none' }}
          />
          <div className="flex justify-between mt-2 text-[10px] tabular-nums opacity-60 text-t-secondary"><span>0px</span><span>24px</span></div>
        </div>
      </div>

      {/* Scaling */}
      <div className="border border-[var(--glass-border)] rounded-2xl p-6 mb-8 bg-panel">
        <h3 className="font-black text-xs uppercase tracking-wider mb-5 text-t-primary">{t('settings.appearance.scaling')}</h3>

        <div id="setting-chat-font-size" className="mb-6">
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-t-secondary">{t('settings.chatFontSize')}</p>
            <span className="text-xs font-semibold tabular-nums text-[var(--cyan-accent)]">{chatFontSize}px</span>
          </div>
          <p className="text-[11px] mb-3 text-t-secondary">{t('settings.appearance.chatFontSizeDesc')}</p>
          <input
            type="range"
            min={12}
            max={24}
            step={1}
            value={chatFontSize}
            onInput={(e) => onChatFontSizeChange?.(Number((e.target as HTMLInputElement).value))}
            onChange={(e) => onChatFontSizeChange?.(Number(e.target.value))}
            className="appearance-none w-full h-4 rounded-full bg-transparent cursor-pointer [&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--cyan-accent)] [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in srgb, var(--cyan-accent) 40%, transparent)] [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:-mt-[5px] [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-[var(--cyan-accent)] [&::-moz-range-thumb]:shadow-[0_0_0_3px_rgba(2,6,23,0.9),0_0_8px_color-mix(in srgb, var(--cyan-accent) 40%, transparent)] [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:border-0"
            style={{ background: `linear-gradient(to right, color-mix(in srgb, var(--cyan-accent) 40%, transparent) 0%, color-mix(in srgb, var(--cyan-accent) 40%, transparent) ${((chatFontSize - 12) / 12) * 100}%, var(--fill-active) ${((chatFontSize - 12) / 12) * 100}%, var(--fill-active) 100%)`, borderRadius: '9999px', touchAction: 'none' }}
          />
          <div className="flex justify-between mt-2 text-[10px] tabular-nums opacity-60 text-t-secondary"><span>12px</span><span>24px</span></div>
        </div>

        {!isMobile && (
        <div id="setting-zoom-level" className="relative" style={{ zIndex: 1 }}>
          <div className="flex items-center justify-between mb-2">
            <p className="text-[10px] font-bold uppercase tracking-widest text-t-secondary">{t('settings.zoomLevel')}</p>
            <div className="flex items-center gap-2">
              {zoomLevel !== 100 && (
                <button
                  id="setting-zoom-level-reset"
                  type="button"
                  onClick={() => onZoomLevelChange?.(100)}
                  className="text-[9px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md bg-fill-hover hover:bg-fill-active text-t-secondary hover:text-t-primary transition-colors duration-150"
                >
                  {t('common.reset', 'Reset')}
                </button>
              )}
              <span className="text-xs font-semibold tabular-nums text-[var(--cyan-accent)]">{zoomLevel}%</span>
            </div>
          </div>
          <p className="text-[11px] mb-3 text-t-secondary">{t('settings.appearance.zoomLevelDesc')}</p>
          <ZoomSlider value={zoomLevel} onChange={(v) => onZoomLevelChange?.(v)} />
          <div className="relative mt-2 text-[10px] tabular-nums opacity-60 text-t-secondary" style={{ height: 16 }}>
            <span className="absolute left-0">50%</span>
            <span className="absolute" style={{ left: '33.33%', transform: 'translateX(-50%)' }}>100%</span>
            <span className="absolute right-0">200%</span>
          </div>
          <p className="text-[10px] mt-2.5 opacity-70 text-t-secondary">{t('settings.useCtrlZoom')}</p>
        </div>
        )}
      </div>
    </div>
  );
};
