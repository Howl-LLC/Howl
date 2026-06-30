// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SETTINGS_REGISTRY, TAB_LABELS, type SettingEntry } from '../utils/settingsRegistry';

export interface SettingSearchResult {
  entry: SettingEntry;
  tabLabel: string;
  score: number;
}

export function useSettingsSearch(query: string, limit = 12): SettingSearchResult[] {
  const { t } = useTranslation();

  return useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    if (!trimmed) return [];

    const tokens = trimmed.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return [];

    const scored: SettingSearchResult[] = [];

    for (const entry of SETTINGS_REGISTRY) {
      const localizedLabel = entry.labelKey
        ? (t(entry.labelKey, { defaultValue: entry.label }) as string)
        : entry.label;
      const localizedDescription = entry.descriptionKey
        ? (t(entry.descriptionKey, { defaultValue: entry.description }) as string)
        : (entry.description ?? '');

      const haystack = [
        localizedLabel.toLowerCase(),
        entry.label.toLowerCase(),
        localizedDescription.toLowerCase(),
        (entry.description ?? '').toLowerCase(),
        ...entry.keywords.map(kw => kw.toLowerCase()),
      ];

      let score = 0;
      for (const token of tokens) {
        for (const hay of haystack) {
          // eslint-disable-next-line security/detect-possible-timing-attacks -- search scoring, not auth
          if (hay === token) {
            score += 100;
          } else if (hay.startsWith(token)) {
            score += 50;
          } else if (hay.includes(token)) {
            score += 10;
          }
        }
      }

      if (score > 0) {
        const tabMeta = TAB_LABELS[entry.tab];
        const tabLabel = tabMeta
          ? (t(tabMeta.labelKey, { defaultValue: tabMeta.label }) as string)
          : entry.tab;
        scored.push({ entry, tabLabel, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit);
  }, [query, t, limit]);
}
