// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard, ToggleRow } from './SettingsWidgets';
import { useSettings } from '../../contexts/SettingsContext';
import type { StreamerSettings } from '../../utils/settingsStorage';

export interface StreamerModeTabProps {}

export const StreamerModeTab: React.FC<StreamerModeTabProps> = () => {
  const { streamerSettings, updateStreamer: onStreamerChange } = useSettings();
  const { t } = useTranslation();

  const sm = streamerSettings ?? { enabled: false, autoDetectOBS: true, hidePersonalInfo: true, hideInviteLinks: true, disableSounds: true, disableNotifications: true, hideFromCapture: false };
  const setSM = (patch: Partial<StreamerSettings>) => onStreamerChange?.(patch);

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.broadcastMode')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.autoHidePersonalDetails')}</p>

      <SectionCard>
        <div id="setting-enable-broadcast-mode"><ToggleRow label={t('settings.enableBroadcastMode')} checked={sm.enabled} onChange={v => setSM({ enabled: v })} /></div>
        <div id="setting-auto-enable-obs"><ToggleRow label={t('settings.autoEnableOBS')} checked={sm.autoDetectOBS} onChange={v => setSM({ autoDetectOBS: v })} /></div>
      </SectionCard>

      {sm.enabled && (
        <SectionCard title={t('settings.whileBroadcasting')}>
          <div id="setting-mask-personal-info"><ToggleRow label={t('settings.maskPersonalInfo')} description={t('settings.maskPersonalInfoDesc')} checked={sm.hidePersonalInfo} onChange={v => setSM({ hidePersonalInfo: v })} /></div>
          <div id="setting-mask-invite-links"><ToggleRow label={t('settings.maskInviteLinks')} checked={sm.hideInviteLinks} onChange={v => setSM({ hideInviteLinks: v })} /></div>
          <div id="setting-mute-all-sound-effects"><ToggleRow label={t('settings.muteAllSoundEffects')} checked={sm.disableSounds} onChange={v => setSM({ disableSounds: v })} /></div>
          <div id="setting-suppress-notifications"><ToggleRow label={t('settings.suppressNotifications')} checked={sm.disableNotifications} onChange={v => setSM({ disableNotifications: v })} /></div>
          <div id="setting-exclude-from-capture"><ToggleRow label={t('settings.excludeFromCapture')} checked={sm.hideFromCapture} onChange={v => setSM({ hideFromCapture: v })} /></div>
        </SectionCard>
      )}
    </div>
  );
};

export default StreamerModeTab;
