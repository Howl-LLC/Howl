// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Sparkles } from 'lucide-react';
import type { ServerCardSummary } from '../../services/api';
import { ServerCard } from './ServerCard';

interface FeaturedRowProps {
  servers: ServerCardSummary[];
  loading?: boolean;
}

export const FeaturedRow: React.FC<FeaturedRowProps> = ({ servers, loading }) => {
  const { t } = useTranslation();

  if (!loading && servers.length === 0) return null;

  return (
    <section aria-labelledby="discover-featured-heading">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={16} className="text-[var(--cyan-accent)]" />
        <h2 id="discover-featured-heading" className="text-sm font-semibold uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
          {t('discover.featured', 'Featured')}
        </h2>
      </div>

      {loading && servers.length === 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--fill-hover)] animate-pulse" style={{ height: 220 }} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {servers.map((s) => (
            <ServerCard key={s.id} server={s} />
          ))}
        </div>
      )}
    </section>
  );
};

export default FeaturedRow;
