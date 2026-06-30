// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard, ToggleRow, RadioOption } from './SettingsWidgets';
import { Dropdown } from '../ui/dropdown';
import { useSettings } from '../../contexts/SettingsContext';
import type { AdvancedSettings } from '../../utils/settingsStorage';

const isElectron = typeof window !== 'undefined' && !!(window as any).__ELECTRON_WINDOW__;

export interface AdvancedTabProps {}

export const AdvancedTab: React.FC<AdvancedTabProps> = () => {
  const { advancedSettings, updateAdvanced: onAdvancedChange } = useSettings();
  const { t } = useTranslation();

  const adv = advancedSettings ?? { hardwareAcceleration: true, showGameLibrary: true };
  const setAdv = (patch: Partial<AdvancedSettings>) => onAdvancedChange?.(patch);

  // Electron desktop settings
  const [closeAction, setCloseAction] = useState<'ask' | 'tray' | 'quit'>('ask');
  const [startMinimized, setStartMinimized] = useState(false);

  // Autostart state (Electron only)
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [autostartHidden, setAutostartHidden] = useState(true);
  const hasAutostartApi = isElectron && !!window.electron?.getAutostart;

  useEffect(() => {
    if (!isElectron || !window.electron?.getAppSettings) return;
    window.electron.getAppSettings().then((settings: { closeAction: string; startMinimized: boolean }) => {
      setCloseAction(settings.closeAction as 'ask' | 'tray' | 'quit');
      setStartMinimized(settings.startMinimized);
    });
  }, []);

  useEffect(() => {
    if (!hasAutostartApi) return;
    window.electron!.getAutostart!().then((state) => {
      setAutostartEnabled(state.enabled);
      setAutostartHidden(state.startHidden);
    });
  }, [hasAutostartApi]);

  const handleCloseActionChange = (value: string) => {
    const v = value as 'ask' | 'tray' | 'quit';
    setCloseAction(v);
    window.electron?.setAppSettings?.({ closeAction: v });
  };

  const handleStartMinimizedChange = (value: boolean) => {
    setStartMinimized(value);
    window.electron?.setAppSettings?.({ startMinimized: value });
  };

  const handleAutostartToggle = (enabled: boolean) => {
    setAutostartEnabled(enabled);
    window.electron?.setAutostart?.({ enabled, startHidden: autostartHidden });
  };

  const handleAutostartModeChange = (mode: string) => {
    const hidden = mode === 'hidden';
    setAutostartHidden(hidden);
    window.electron?.setAutostart?.({ enabled: autostartEnabled, startHidden: hidden });
  };

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.advanced')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.performanceTuning')}</p>

      <SectionCard>
        <div id="setting-hardware-acceleration"><ToggleRow label={t('settings.hardwareAcceleration')} description={t('settings.hardwareAccelDesc')} checked={adv.hardwareAcceleration} onChange={v => setAdv({ hardwareAcceleration: v })} /></div>
        <div id="setting-activity-library"><ToggleRow label={t('settings.activityLibrary')} description={t('settings.activityLibraryDesc')} checked={adv.showGameLibrary} onChange={v => setAdv({ showGameLibrary: v })} /></div>
      </SectionCard>

      {/* Desktop section — Electron only */}
      {isElectron && (
        <div className="mt-6">
        <SectionCard>
          <p className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
            Desktop
          </p>

          <div id="setting-close-button-action" className="flex items-center justify-between py-3">
            <div>
              <p className="text-xs font-medium" style={{ color: 'var(--text-primary)' }}>
                Close Button Action
              </p>
              <p className="text-[11px] mt-0.5" style={{ color: 'var(--text-secondary)' }}>
                Choose what happens when you close the window
              </p>
            </div>
            <Dropdown
              options={[
                { value: 'ask', label: 'Ask me every time' },
                { value: 'tray', label: 'Minimize to tray' },
                { value: 'quit', label: 'Quit Howl' },
              ]}
              value={closeAction}
              onChange={v => handleCloseActionChange(v)}
              size="sm"
            />
          </div>

          <div id="setting-start-minimized"><ToggleRow
            label="Start Minimized"
            description="Launch Howl minimized to the system tray"
            checked={startMinimized}
            onChange={handleStartMinimizedChange}
          /></div>
        </SectionCard>

        {/* Startup section — autostart at login */}
        {hasAutostartApi && (
          <SectionCard>
            <p className="text-[10px] font-bold uppercase tracking-widest mb-4" style={{ color: 'var(--text-secondary)', opacity: 0.5 }}>
              Startup
            </p>

            <div id="setting-autostart-at-login"><ToggleRow
              label="Launch Howl when my system starts"
              description="Automatically start Howl at login"
              checked={autostartEnabled}
              onChange={handleAutostartToggle}
            /></div>

            {autostartEnabled && (
              <div id="setting-autostart-mode" className="pl-4 mt-1 mb-2 border-l-2" style={{ borderColor: 'var(--border-subtle)' }}>
                <RadioOption
                  label="Start in system tray (hidden)"
                  description="Howl runs silently in the background until you click the tray icon"
                  value="hidden"
                  selected={autostartHidden}
                  onChange={handleAutostartModeChange}
                />
                <RadioOption
                  label="Show main window"
                  description="Howl opens its window immediately at login"
                  value="visible"
                  selected={!autostartHidden}
                  onChange={handleAutostartModeChange}
                />
              </div>
            )}
          </SectionCard>
        )}
        </div>
      )}

      <div className="mt-10 text-center">
        <p className="text-[10px] font-mono" style={{ color: 'var(--text-secondary)', opacity: 0.4 }}>
          Howl v{typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0'}
        </p>
      </div>
    </div>
  );
};

export default AdvancedTab;
