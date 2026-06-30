// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Dropdown } from '../ui/dropdown';

const COMMON_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any language' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'de', label: 'Deutsch' },
  { value: 'pt', label: 'Português' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'zh', label: '中文' },
  { value: 'ru', label: 'Русский' },
];

interface DiscoverFiltersProps {
  language: string | null;
  tag: string | null;
  onLanguageChange(lang: string | null): void;
  onTagChange(tag: string | null): void;
}

export const DiscoverFilters: React.FC<DiscoverFiltersProps> = ({
  language,
  tag,
  onLanguageChange,
  onTagChange,
}) => {
  const { t } = useTranslation();

  const localizedLanguages = COMMON_LANGUAGES.map((l) =>
    l.value === ''
      ? { ...l, label: t('discover.languageAny', 'Any language') }
      : l,
  );

  return (
    <aside className="space-y-5 text-sm" aria-label={t('discover.filtersLabel', 'Filters')}>
      <div>
        <label className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {t('discover.filterLanguage', 'Language')}
        </label>
        <Dropdown
          options={localizedLanguages}
          value={language ?? ''}
          onChange={(v) => onLanguageChange(v ? String(v) : null)}
          size="md"
          className="w-full"
        />
      </div>

      <div>
        <label htmlFor="discover-tag" className="block text-[11px] font-semibold uppercase tracking-wide mb-1.5" style={{ color: 'var(--text-secondary)' }}>
          {t('discover.filterTag', 'Tag')}
        </label>
        <input
          id="discover-tag"
          type="text"
          value={tag ?? ''}
          onChange={(e) => onTagChange(e.target.value || null)}
          placeholder={t('discover.tagPlaceholder', 'e.g. fps, art, music')}
          maxLength={32}
          className="w-full px-3 py-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--fill-hover)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--cyan-accent)]"
        />
      </div>

    </aside>
  );
};

export default DiscoverFilters;
