// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC

import React from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard, RadioOption } from './SettingsWidgets';
import { Dropdown } from '../ui/dropdown';
import { useSettings } from '../../contexts/SettingsContext';
import type { TimeFormat } from '../../utils/settingsStorage';

const LANG_FLAGS: Record<string, string> = {
  'en-US': '\u{1F1FA}\u{1F1F8}', 'en-GB': '\u{1F1EC}\u{1F1E7}', es: '\u{1F1EA}\u{1F1F8}',
  fr: '\u{1F1EB}\u{1F1F7}', de: '\u{1F1E9}\u{1F1EA}', ja: '\u{1F1EF}\u{1F1F5}',
  ko: '\u{1F1F0}\u{1F1F7}', 'pt-BR': '\u{1F1E7}\u{1F1F7}', 'zh-CN': '\u{1F1E8}\u{1F1F3}',
};
const LANG_NAMES: Record<string, string> = {
  'en-US': 'English, US', 'en-GB': 'English, UK', es: 'Español',
  fr: 'Français', de: 'Deutsch', ja: '\u{65E5}\u{672C}\u{8A9E}',
  ko: '\u{D55C}\u{AD6D}\u{C5B4}', 'pt-BR': 'Português do Brasil', 'zh-CN': '\u{4E2D}\u{6587} (\u{7B80}\u{4F53})',
};

export interface LanguageTimeTabProps {}

export const LanguageTimeTab: React.FC<LanguageTimeTabProps> = () => {
  const { language, updateLanguage: onLanguageChange, timeFormat, updateTimeFormat: onTimeFormatChange } = useSettings();
  const { t } = useTranslation();

  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold tracking-tight mb-2" style={{ color: 'var(--text-primary)' }}>{t('settings.languageTime')}</h2>
      <p className="text-xs mb-8" style={{ color: 'var(--text-secondary)' }}>{t('settings.setPreferredLanguage')}</p>

      <SectionCard title={t('settings.selectLanguage')}>
        <p className="text-xs mb-4" style={{ color: 'var(--text-secondary)' }}>{t('settings.chooseLanguage')}</p>
        <div id="setting-select-language" className="flex items-center gap-3 px-4 py-3 rounded-xl border border-[var(--glass-border)]" style={{ backgroundColor: 'var(--bg-input)' }}>
          <span className="text-lg">{LANG_FLAGS[language ?? 'en-US'] ?? '\u{1F1FA}\u{1F1F8}'}</span>
          <span className="text-sm font-medium flex-1" style={{ color: 'var(--text-primary)' }}>{LANG_NAMES[language ?? 'en-US'] ?? 'English, US'}</span>
          <Dropdown
            options={Object.entries(LANG_NAMES).map(([code, name]) => ({ value: code, label: name }))}
            value={language ?? 'en-US'}
            onChange={v => onLanguageChange?.(v)}
            size="sm"
          />
        </div>
        <p className="text-xs mt-3 px-1" style={{ color: 'var(--text-secondary)' }}>{t('settings.languagePreferenceSaved')}</p>
      </SectionCard>

      <SectionCard title={t('settings.timeFormat')}>
        <div id="setting-time-format">
        <RadioOption label={t('settings.auto')} value="auto" selected={(timeFormat ?? 'auto') === 'auto'} onChange={v => onTimeFormatChange?.(v as TimeFormat)} />
        <RadioOption label={t('settings.12Hour')} value="12h" selected={(timeFormat ?? 'auto') === '12h'} onChange={v => onTimeFormatChange?.(v as TimeFormat)} />
        <RadioOption label={t('settings.24Hour')} value="24h" selected={(timeFormat ?? 'auto') === '24h'} onChange={v => onTimeFormatChange?.(v as TimeFormat)} />
        </div>
      </SectionCard>
    </div>
  );
};

export default LanguageTimeTab;
