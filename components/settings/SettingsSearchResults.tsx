// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingSearchResult } from '../../hooks/useSettingsSearch';
import type { SettingEntry } from '../../utils/settingsRegistry';

interface SettingsSearchResultsProps {
  results: SettingSearchResult[];
  onSelect: (entry: SettingEntry) => void;
  onClose: () => void;
}

export const SettingsSearchResults: React.FC<SettingsSearchResultsProps> = ({ results, onSelect, onClose }) => {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    setActiveIndex(0);
  }, [results]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (results.length === 0) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex(prev => (prev + 1) % results.length);
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        setActiveIndex(prev => (prev - 1 + results.length) % results.length);
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        onSelect(results[activeIndex].entry);
        break;
      case 'Escape':
        e.stopPropagation();
        onClose();
        break;
    }
  }, [results, activeIndex, onSelect, onClose]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleKeyDown]);

  return (
    <div
      ref={listRef}
      className="absolute left-0 right-0 top-full mt-1 rounded-xl border border-default overflow-hidden shadow-xl z-50"
      style={{ backgroundColor: 'var(--bg-floating)', maxHeight: 400 }}
    >
      <div className="overflow-y-auto" style={{ maxHeight: 400 }}>
        {results.length === 0 ? (
          <div className="px-4 py-6 text-center text-xs" style={{ color: 'var(--text-secondary)' }}>
            {t('settings.search.noResults', 'No settings match.')}
          </div>
        ) : (
          results.map((result, i) => (
            <button
              key={result.entry.id}
              ref={el => { itemRefs.current[i] = el; }}
              type="button"
              onClick={() => onSelect(result.entry)}
              onMouseEnter={() => setActiveIndex(i)}
              className="w-full text-left px-4 py-2.5 flex flex-col gap-0.5 transition-colors"
              style={{
                backgroundColor: i === activeIndex ? 'var(--fill-hover)' : 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              <div className="flex items-center gap-2 min-w-0">
                <span className="text-xs font-semibold truncate">{
                  result.entry.labelKey
                    ? t(result.entry.labelKey, { defaultValue: result.entry.label })
                    : result.entry.label
                }</span>
                <span className="text-[10px] shrink-0" style={{ color: 'var(--cyan-accent)', opacity: 0.8 }}>
                  in {result.tabLabel}
                </span>
              </div>
              {result.entry.description && (
                <p className="text-[10px] truncate" style={{ color: 'var(--text-secondary)' }}>
                  {result.entry.descriptionKey
                    ? t(result.entry.descriptionKey, { defaultValue: result.entry.description })
                    : result.entry.description}
                </p>
              )}
            </button>
          ))
        )}
      </div>
    </div>
  );
};
