// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { DiscoverCategory } from '../../services/api';

interface CategoryRailProps {
  categories: DiscoverCategory[];
  activeCategory: string | null;
  onSelect(key: string | null): void;
  loading?: boolean;
}

export const CategoryRail: React.FC<CategoryRailProps> = ({ categories, activeCategory, onSelect, loading }) => {
  const { t } = useTranslation();
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  const scrollBy = (dx: number) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollBy({ left: dx, behavior: 'smooth' });
  };

  return (
    <div className="flex items-center gap-2">
      {/* Left scroll arrow — sits inside flow, no overlap with pinned items */}
      <button
        type="button"
        onClick={() => scrollBy(-240)}
        className="hidden md:flex shrink-0 h-8 w-8 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--cyan-accent)_22%,transparent)] bg-[color-mix(in_srgb,var(--cyan-accent)_8%,transparent)] text-[var(--cyan-accent)] hover:bg-[color-mix(in_srgb,var(--cyan-accent)_18%,transparent)] transition-colors"
        aria-label={t('discover.scrollLeft', 'Scroll categories left')}
      >
        <ChevronLeft size={16} />
      </button>

      <div
        ref={scrollerRef}
        className="flex flex-1 gap-2 overflow-x-auto pb-1 scrollbar-thin scrollbar-track-transparent scroll-smooth"
        style={{ scrollbarWidth: 'thin' }}
        role="tablist"
        aria-label={t('discover.categoriesLabel', 'Server categories')}
      >
        <button
          type="button"
          onClick={() => onSelect(null)}
          role="tab"
          aria-selected={activeCategory === null}
          className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium border transition-all ${
            activeCategory === null
              ? 'btn-cta-selected'
              : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] hover:text-[var(--text-primary)]'
          }`}
        >
          {t('discover.allCategories', 'All')}
        </button>
        {loading && categories.length === 0 && (
          Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className="shrink-0 px-3.5 py-1.5 rounded-full border border-[var(--border-subtle)] animate-pulse" style={{ width: 80, height: 28 }} />
          ))
        )}
        {categories.map((cat) => {
          const active = cat.key === activeCategory;
          return (
            <button
              key={cat.key}
              type="button"
              onClick={() => onSelect(active ? null : cat.key)}
              role="tab"
              aria-selected={active}
              className={`shrink-0 px-3.5 py-1.5 rounded-full text-xs font-medium border transition-all ${
                active
                  ? 'btn-cta-selected'
                  : 'border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--fill-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {cat.label}
              {typeof cat.count === 'number' && (
                <span className="ml-1.5 text-[10px] opacity-70">{cat.count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Right scroll arrow — sits inside flow, no overlap with last pill */}
      <button
        type="button"
        onClick={() => scrollBy(240)}
        className="hidden md:flex shrink-0 h-8 w-8 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--cyan-accent)_22%,transparent)] bg-[color-mix(in_srgb,var(--cyan-accent)_8%,transparent)] text-[var(--cyan-accent)] hover:bg-[color-mix(in_srgb,var(--cyan-accent)_18%,transparent)] transition-colors"
        aria-label={t('discover.scrollRight', 'Scroll categories right')}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
};

export default CategoryRail;
