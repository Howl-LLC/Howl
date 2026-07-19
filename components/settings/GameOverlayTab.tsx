// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Monitor, Info, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SectionCard, ToggleRow, SelectRow, SliderRow } from './SettingsWidgets';
import { useSettings } from '../../contexts/SettingsContext';
import { startKeyCapture, formatComboDisplay } from '../../utils/keybindFormat';
import type { OverlayCorner, GameOverlaySettings } from '../../utils/settingsStorage';

/* ── CornerPicker ── */

const CORNER_LABEL_KEYS: Record<OverlayCorner, string> = {
  'top-left': 'settings.overlay.topLeft',
  'top-right': 'settings.overlay.topRight',
  'bottom-left': 'settings.overlay.bottomLeft',
  'bottom-right': 'settings.overlay.bottomRight',
};

function CornerPicker({ value, onChange, t }: { value: OverlayCorner; onChange: (c: OverlayCorner) => void; t: (key: string) => string }) {
  const corners: OverlayCorner[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const dotPosition: Record<OverlayCorner, string> = {
    'top-left': 'top-1 left-1',
    'top-right': 'top-1 right-1',
    'bottom-left': 'bottom-1 left-1',
    'bottom-right': 'bottom-1 right-1',
  };

  return (
    <div className="inline-grid grid-cols-2 gap-1.5" style={{ width: 100 }}>
      {corners.map(corner => {
        const selected = value === corner;
        return (
          <button
            key={corner}
            type="button"
            aria-label={t(CORNER_LABEL_KEYS[corner])}
            onClick={() => onChange(corner)}
            className="relative aspect-video rounded-md border-2 transition-colors"
            style={{
              backgroundColor: 'var(--bg-panel)',
              borderColor: selected ? 'var(--cyan-accent)' : 'var(--glass-border)',
            }}
          >
            <span
              className={`absolute w-2 h-2 rounded-full ${dotPosition[corner]}`}
              style={{ backgroundColor: selected ? 'var(--cyan-accent)' : 'var(--text-secondary)' }}
            />
          </button>
        );
      })}
    </div>
  );
}

/* ── PlatformNote ── */

const PLATFORM_NOTES: Record<string, string> = {
  win32: 'settings.overlay.platformNoteWindows',
  darwin: 'settings.overlay.platformNoteMac',
  linux: 'settings.overlay.platformNoteLinux',
};

function PlatformNote({ platform, t }: { platform: string; t: (key: string) => string }) {
  const noteKey = PLATFORM_NOTES[platform];
  if (!noteKey) return null;

  return (
    <div className="flex items-start gap-2.5 px-4 py-3 mb-4 rounded-xl" style={{ backgroundColor: 'rgba(100,116,139,0.08)', border: '1px solid rgba(100,116,139,0.12)' }}>
      <Info size={14} className="shrink-0 mt-0.5" style={{ color: 'var(--text-secondary)' }} />
      <p className="text-[11px] leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{t(noteKey)}</p>
    </div>
  );
}

/* ── Download URL for non-Electron fallback ──
   Points at the Cloudflare R2-backed release CDN, matching the landing
   page artifact names (Howl-Setup.exe / Howl-x64.dmg / Howl-amd64.deb).
   Override with VITE_DOWNLOAD_BASE_URL at build time if needed. */

const DOWNLOAD_BASE = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_DOWNLOAD_BASE_URL)
  || 'https://releases.howlpro.com';

/**
 * Returns the desktop download URL for the visitor's OS, or `null` if no
 * build is available yet. macOS is intentionally null until the signed/
 * notarised build ships — the fallback UI renders "Coming soon" instead
 * of a dead .dmg link.
 */
function getDesktopDownloadUrl(): string | null {
  if (typeof navigator === 'undefined') return `${DOWNLOAD_BASE}/Howl-Setup.exe`;
  const ua = navigator.userAgent.toLowerCase();
  const plat = (navigator.platform || '').toLowerCase();
  if (ua.includes('mac') || plat.includes('mac')) return null;
  if (ua.includes('linux') || plat.includes('linux')) return `${DOWNLOAD_BASE}/Howl-amd64.deb`;
  return `${DOWNLOAD_BASE}/Howl-Setup.exe`;
}

/* ── GameOverlayTab ── */

export interface GameOverlayTabProps {}

export const GameOverlayTab: React.FC<GameOverlayTabProps> = () => {
  const { t } = useTranslation();
  const { gameOverlaySettings, updateGameOverlay } = useSettings();

  const isElectron = !!(typeof window !== 'undefined' && (window as any).__ELECTRON_WINDOW__);
  const platform: string = (typeof window !== 'undefined' && (window as any).__ELECTRON_PLATFORM__) ?? 'unknown';

  const ov = gameOverlaySettings;
  const set = useCallback(
    (patch: Partial<GameOverlaySettings>) => updateGameOverlay(patch),
    [updateGameOverlay],
  );

  const [recording, setRecording] = useState(false);
  const captureStopRef = useRef<(() => void) | null>(null);
  useEffect(() => () => { captureStopRef.current?.(); }, []);

  const beginRecord = useCallback(() => {
    setRecording(true);
    captureStopRef.current?.();
    captureStopRef.current = startKeyCapture({
      onCapture: (combo) => {
        captureStopRef.current = null;
        setRecording(false);
        set({ lockKeybind: combo });
      },
      onCancel: () => {
        captureStopRef.current = null;
        setRecording(false);
      },
      onClear: () => {
        captureStopRef.current = null;
        setRecording(false);
        set({ lockKeybind: '' });
      },
    });
  }, [set]);

  const cancelRecord = useCallback(() => {
    captureStopRef.current?.();
    captureStopRef.current = null;
    setRecording(false);
  }, []);

  /* ── Non-Electron fallback ── */
  if (!isElectron) {
    return (
      <div className="max-w-3xl mx-auto">
        <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.overlay.title')}</h2>
        <div className="border border-default rounded-2xl px-6 py-10 text-center" style={{ backgroundColor: 'var(--bg-panel)' }}>
          <Monitor size={32} className="mx-auto mb-3 opacity-40" style={{ color: 'var(--text-secondary)' }} />
          <p className="text-sm font-medium mb-1" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.overlay.title')}
          </p>
          <p className="text-xs mb-5" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.overlay.desktopOnly')}
          </p>
          {(() => {
            const url = getDesktopDownloadUrl();
            return url ? (
              <a
                href={url}
                className="btn-cta inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all"
              >
                <Download size={14} />
                {t('settings.overlay.downloadDesktop')}
              </a>
            ) : (
              <span
                className="btn-cta inline-flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold cursor-not-allowed"
                aria-disabled="true"
              >
                {t('settings.overlay.downloadComingSoon', 'macOS app: Coming soon')}
              </span>
            );
          })()}
        </div>
      </div>
    );
  }

  /* ── Electron: full settings ── */
  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.overlay.title')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.overlay.subtitle')}</p>

      {/* ── Overlay ── */}
      <SectionCard title={t('settings.overlay.overlaySection')}>
        <PlatformNote platform={platform} t={t} />
        <div id="setting-enable-overlay"><ToggleRow label={t('settings.overlay.enableOverlay')} description={t('settings.overlay.enableOverlayDesc')} checked={ov.enabled} onChange={v => set({ enabled: v })} /></div>
        <div id="setting-overlay-clickable-regions"><ToggleRow label={t('settings.overlay.clickableRegions')} description={t('settings.overlay.clickableRegionsDesc')} checked={ov.clickableRegions} onChange={v => set({ clickableRegions: v })} /></div>
      </SectionCard>

      {/* ── Lock Keybind ── */}
      <SectionCard title={t('settings.overlay.lockKeybind')}>
        <div id="setting-overlay-lock-keybind" className="flex items-center justify-between py-3">
          <div className="flex-1 min-w-0 mr-4">
            <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.overlay.toggleLock')}</p>
            <p className="text-xs mt-0.5" style={{ color: 'var(--text-secondary)' }}>{t('settings.overlay.toggleLockDesc')}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {recording ? (
              <>
                <button type="button"
                  onClick={cancelRecord}
                  title={t('settings.shortcutCancel', { defaultValue: 'Cancel (Esc) · Backspace to clear' })}
                  className="px-3 py-1.5 rounded-lg border-2 border-[var(--cyan-accent)] text-xs font-mono animate-pulse min-w-[120px] text-center cursor-pointer"
                  style={{ backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)' }}
                >
                  {t('settings.overlay.pressKeys')}
                </button>
                <button
                  type="button"
                  onClick={cancelRecord}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  {t('common.cancel')}
                </button>
              </>
            ) : (
              <>
                <div className="flex gap-1 flex-wrap">
                  {(formatComboDisplay(ov.lockKeybind).length > 0 ? formatComboDisplay(ov.lockKeybind) : [t('settings.shortcutUnset', { defaultValue: 'Unset' })]).map((key, i) => (
                    <span
                      key={i}
                      className="inline-block px-2 py-0.5 rounded-lg bg-[var(--bg-app)] border border-[var(--glass-border)] text-xs font-mono text-[var(--text-primary)]"
                    >
                      {key}
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={beginRecord}
                  className="btn-secondary px-3 py-1.5 text-xs"
                >
                  {t('common.edit')}
                </button>
              </>
            )}
          </div>
        </div>
      </SectionCard>

      {/* ── Voice Widget ── */}
      <SectionCard title={t('settings.overlay.voiceWidget')}>
        <div id="setting-overlay-widget-mode"><SelectRow
          label={t('settings.overlay.widgetMode')}
          value={ov.widgetMode}
          options={[
            { value: 'compact', label: t('settings.overlay.compact') },
            { value: 'detailed', label: t('settings.overlay.detailed') },
          ]}
          onChange={v => set({ widgetMode: v as GameOverlaySettings['widgetMode'] })}
        /></div>

        <div id="setting-overlay-widget-position" className="flex items-center justify-between py-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.overlay.position')}</p>
          <CornerPicker value={ov.widgetCorner} onChange={c => set({ widgetCorner: c })} t={t} />
        </div>

        {ov.widgetMode === 'detailed' && (
          <div className="mt-2 pt-3 border-t border-[var(--glass-border)]">
            <p className="text-[11px] font-bold uppercase tracking-wider mb-3" style={{ color: 'var(--text-secondary)' }}>{t('settings.overlay.detailedOptions')}</p>

            <div id="setting-overlay-avatar-size"><SelectRow
              label={t('settings.overlay.avatarSize')}
              value={ov.avatarSize}
              options={[
                { value: 'small', label: t('common.small') },
                { value: 'medium', label: t('common.medium') },
                { value: 'large', label: t('common.large') },
              ]}
              onChange={v => set({ avatarSize: v as GameOverlaySettings['avatarSize'] })}
            /></div>
            <div id="setting-overlay-display-names"><SelectRow
              label={t('settings.overlay.displayNames')}
              value={ov.displayNames}
              options={[
                { value: 'always', label: t('common.always') },
                { value: 'speaking-only', label: t('settings.overlay.onlySpeaking') },
                { value: 'never', label: t('common.never') },
              ]}
              onChange={v => set({ displayNames: v as GameOverlaySettings['displayNames'] })}
            /></div>
            <div id="setting-overlay-show-users"><SelectRow
              label={t('settings.overlay.showUsers')}
              value={ov.showUsers}
              options={[
                { value: 'always', label: t('common.always') },
                { value: 'speaking-only', label: t('settings.overlay.onlySpeaking') },
                { value: 'never', label: t('common.never') },
              ]}
              onChange={v => set({ showUsers: v as GameOverlaySettings['showUsers'] })}
            /></div>
            <div id="setting-overlay-max-users"><SliderRow
              label={`${t('settings.overlay.maxUsersDisplayed')}${ov.maxUsersDisplayed === 0 ? ` (${t('common.off')})` : ''}`}
              value={ov.maxUsersDisplayed}
              min={0}
              max={25}
              step={1}
              onChange={v => set({ maxUsersDisplayed: v })}
            /></div>
          </div>
        )}
      </SectionCard>

      {/* ── Notification Toasts ── */}
      <SectionCard title={t('settings.overlay.notificationToasts')}>
        <div id="setting-overlay-toast-position" className="flex items-center justify-between py-3">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>{t('settings.overlay.position')}</p>
          <CornerPicker value={ov.toastCorner} onChange={c => set({ toastCorner: c })} t={t} />
        </div>

        <div id="setting-overlay-toast-messages"><ToggleRow label={t('settings.overlay.toastMessages')} description={t('settings.overlay.toastMessagesDesc')} checked={ov.toastMessages} onChange={v => set({ toastMessages: v })} /></div>
        <div id="setting-overlay-toast-welcome"><ToggleRow label={t('settings.overlay.toastWelcome')} description={t('settings.overlay.toastWelcomeDesc')} checked={ov.toastWelcome} onChange={v => set({ toastWelcome: v })} /></div>
        <div id="setting-overlay-toast-go-live"><ToggleRow label={t('settings.overlay.toastGoLive')} description={t('settings.overlay.toastGoLiveDesc')} checked={ov.toastGoLive} onChange={v => set({ toastGoLive: v })} /></div>
        <div id="setting-overlay-toast-game-activity"><ToggleRow label={t('settings.overlay.toastGameActivity')} description={t('settings.overlay.toastGameActivityDesc')} checked={ov.toastGameActivity} onChange={v => set({ toastGameActivity: v })} /></div>
        <div id="setting-overlay-toast-now-playing"><ToggleRow label={t('settings.overlay.toastNowPlaying')} description={t('settings.overlay.toastNowPlayingDesc')} checked={ov.toastNowPlaying} onChange={v => set({ toastNowPlaying: v })} /></div>
      </SectionCard>
    </div>
  );
};

export default GameOverlayTab;
