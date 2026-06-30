// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BarChart3, Users, MessageSquare, UserPlus, UserMinus, TrendingUp } from 'lucide-react';
import { Server, serverHasPerm } from '../../types';
import { apiClient } from '../../services/api';
import type { InsightsTimeSeriesPoint, ServerInsights } from '../../services/api/community';
import { SectionHeader, Card, EmptyState } from '../settings/SettingsWidgets';

type Range = '7d' | '30d' | '90d';

export interface InsightsSectionProps {
  server: Server;
  showToast: (message: string, type?: 'success' | 'error') => void;
}

// Inline SVG charts (no external chart lib in this codebase)

interface ChartProps {
  points: number[];
  labels: string[];
  height?: number;
  color?: string;
  fillOpacity?: number;
}

const LineChart: React.FC<ChartProps> = ({ points, labels, height = 80, color = 'var(--cyan-accent)', fillOpacity = 0.18 }) => {
  if (points.length === 0) return <div className="h-20 flex items-center justify-center text-[11px] text-t-secondary">—</div>;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, 0);
  const range = Math.max(1, max - min);
  const w = 100; // viewBox width in arbitrary units
  const stepX = points.length > 1 ? w / (points.length - 1) : 0;
  const path = points
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 4) - 2;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  const areaPath = points.length > 1
    ? `${path} L${(w).toFixed(2)},${height} L0,${height} Z`
    : '';
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={`${labels.length} point chart`}>
      {areaPath && <path d={areaPath} fill={color} fillOpacity={fillOpacity} />}
      <path d={path} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
};

interface StackedBarProps {
  series: { label: string; values: number[]; color: string }[];
  height?: number;
}

const StackedBars: React.FC<StackedBarProps> = ({ series, height = 80 }) => {
  if (series.length === 0 || series[0].values.length === 0) {
    return <div className="h-20 flex items-center justify-center text-[11px] text-t-secondary">—</div>;
  }
  const n = series[0].values.length;
  const totals: number[] = [];
  for (let i = 0; i < n; i++) {
    totals[i] = series.reduce((acc, s) => acc + Math.max(0, s.values[i] ?? 0), 0);
  }
  const max = Math.max(...totals, 1);
  const w = 100;
  const barW = w / n;
  const gap = Math.min(0.6, barW * 0.2);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img">
      {Array.from({ length: n }).map((_, i) => {
        let yCursor = height;
        return (
          <g key={i}>
            {series.map((s) => {
              const v = Math.max(0, s.values[i] ?? 0);
              const h = (v / max) * (height - 2);
              yCursor -= h;
              return (
                <rect
                  key={s.label}
                  x={i * barW + gap / 2}
                  y={yCursor}
                  width={barW - gap}
                  height={h}
                  fill={s.color}
                  rx={0.5}
                />
              );
            })}
          </g>
        );
      })}
    </svg>
  );
};

interface BarChartProps {
  values: number[];
  color?: string;
  height?: number;
}

const BarChart: React.FC<BarChartProps> = ({ values, color = 'var(--cyan-accent)', height = 80 }) => {
  if (values.length === 0) return <div className="h-20 flex items-center justify-center text-[11px] text-t-secondary">—</div>;
  const max = Math.max(...values, 1);
  const w = 100;
  const barW = w / values.length;
  const gap = Math.min(0.6, barW * 0.2);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img">
      {values.map((v, i) => {
        const h = (Math.max(0, v) / max) * (height - 2);
        return <rect key={i} x={i * barW + gap / 2} y={height - h} width={barW - gap} height={h} fill={color} rx={0.5} />;
      })}
    </svg>
  );
};

// Section

function totalsFor(points: InsightsTimeSeriesPoint[]) {
  return points.reduce(
    (acc, p) => ({
      members: p.members, // last value snapshot, not sum
      joins: acc.joins + (p.joins ?? 0),
      leaves: acc.leaves + (p.leaves ?? 0),
      messages: acc.messages + (p.messages ?? 0),
      retainedAfter7d: p.retainedAfter7d ?? acc.retainedAfter7d,
    }),
    { members: 0, joins: 0, leaves: 0, messages: 0, retainedAfter7d: 0 },
  );
}

export const InsightsSection: React.FC<InsightsSectionProps> = ({ server, showToast }) => {
  const { t } = useTranslation();
  const canManage = serverHasPerm(server, 'manageServer');

  const [range, setRange] = useState<Range>('7d');
  const [data, setData] = useState<ServerInsights | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (r: Range) => {
    setLoading(true);
    try {
      const next = await apiClient.serverInsights(server.id, r);
      setData(next);
    } catch (e) {
      showToast(e instanceof Error ? e.message : t('insights.loadFailed', { defaultValue: 'Failed to load insights' }), 'error');
    } finally {
      setLoading(false);
    }
  }, [server.id, showToast, t]);

  useEffect(() => { if (canManage) refresh(range); }, [canManage, range, refresh]);

  const points = useMemo(() => data?.points ?? [], [data]);
  const totals = useMemo(() => totalsFor(points), [points]);

  if (!canManage) {
    return (
      <div className="max-w-3xl">
        <SectionHeader title={t('insights.title', { defaultValue: 'Insights' })} icon={<BarChart3 size={24} />} />
        <EmptyState icon={<BarChart3 size={40} />}
          title={t('insights.noPermission', { defaultValue: 'You don\'t have permission to view insights.' })}
          desc={t('insights.noPermissionDesc', { defaultValue: 'Ask a server admin with the Manage Server permission.' })} />
      </div>
    );
  }

  return (
    <div className="max-w-3xl space-y-6">
      <SectionHeader
        title={t('insights.title', { defaultValue: 'Insights' })}
        desc={t('insights.headerDesc', { defaultValue: 'See how your server is growing.' })}
        icon={<BarChart3 size={24} />}
      />

      {/* Range tabs */}
      <div className="inline-flex rounded-xl border border-default p-1 bg-floating">
        {(['7d', '30d', '90d'] as Range[]).map((r) => {
          const isActive = range === r;
          return (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${isActive ? 'bg-[var(--cyan-accent)] text-black' : 'text-t-secondary hover:text-t-primary'}`}
            >
              {t(`insights.range.${r}`, { defaultValue: r === '7d' ? 'Last 7 days' : r === '30d' ? 'Last 30 days' : 'Last 90 days' })}
            </button>
          );
        })}
      </div>

      {loading ? (
        <Card>
          <div className="py-10 text-center text-[12px] text-t-secondary">{t('serverSettings.loading')}</div>
        </Card>
      ) : points.length === 0 ? (
        <Card>
          <EmptyState icon={<TrendingUp size={40} />}
            title={t('insights.noData', { defaultValue: 'No data yet' })}
            desc={t('insights.noDataDesc', { defaultValue: 'Insights are computed nightly. Come back tomorrow once the worker has a snapshot.' })} />
        </Card>
      ) : (
        <>
          {/* Summary tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <SummaryTile icon={<Users size={16} />} label={t('insights.tileMembers', { defaultValue: 'Members' })} value={totals.members} />
            <SummaryTile icon={<UserPlus size={16} />} label={t('insights.tileJoins', { defaultValue: 'Joins' })} value={totals.joins} />
            <SummaryTile icon={<UserMinus size={16} />} label={t('insights.tileLeaves', { defaultValue: 'Leaves' })} value={totals.leaves} />
            <SummaryTile icon={<MessageSquare size={16} />} label={t('insights.tileMessages', { defaultValue: 'Messages' })} value={totals.messages} />
          </div>

          {/* Members line chart */}
          <Card>
            <ChartHeader
              icon={<Users size={14} />}
              title={t('insights.chartMembersTitle', { defaultValue: 'Members over time' })}
            />
            <LineChart
              points={points.map((p) => p.members)}
              labels={points.map((p) => p.date)}
              height={120}
            />
          </Card>

          {/* Joins/leaves stacked */}
          <Card>
            <ChartHeader
              icon={<UserPlus size={14} />}
              title={t('insights.chartJoinsLeavesTitle', { defaultValue: 'Joins vs leaves' })}
            />
            <StackedBars
              series={[
                { label: 'joins', values: points.map((p) => p.joins ?? 0), color: 'var(--cyan-accent)' },
                { label: 'leaves', values: points.map((p) => p.leaves ?? 0), color: 'rgba(248, 113, 113, 0.8)' },
              ]}
              height={120}
            />
            <div className="mt-3 flex items-center gap-4 text-[11px] text-t-secondary">
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: 'var(--cyan-accent)' }} /> {t('insights.legendJoins', { defaultValue: 'Joins' })}</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: 'rgba(248, 113, 113, 0.8)' }} /> {t('insights.legendLeaves', { defaultValue: 'Leaves' })}</span>
            </div>
          </Card>

          {/* Messages bars */}
          <Card>
            <ChartHeader
              icon={<MessageSquare size={14} />}
              title={t('insights.chartMessagesTitle', { defaultValue: 'Messages per day' })}
            />
            <BarChart values={points.map((p) => p.messages ?? 0)} height={120} />
          </Card>

          {/* Retention line */}
          <Card>
            <ChartHeader
              icon={<TrendingUp size={14} />}
              title={t('insights.chartRetentionTitle', { defaultValue: '7-day retention' })}
            />
            <LineChart
              points={points.map((p) => p.retainedAfter7d ?? 0)}
              labels={points.map((p) => p.date)}
              color="rgba(34, 197, 94, 0.9)"
              height={120}
            />
          </Card>
        </>
      )}
    </div>
  );
};

interface SummaryTileProps {
  icon: React.ReactNode;
  label: string;
  value: number;
}

const SummaryTile: React.FC<SummaryTileProps> = ({ icon, label, value }) => (
  <div className="rounded-2xl border border-default bg-floating p-4">
    <div className="flex items-center gap-2 text-t-secondary mb-1">
      {icon}
      <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
    </div>
    <p className="text-xl font-semibold tabular-nums text-t-primary">{value.toLocaleString()}</p>
  </div>
);

const ChartHeader: React.FC<{ icon: React.ReactNode; title: string }> = ({ icon, title }) => (
  <div className="flex items-center gap-2 mb-3">
    <span className="opacity-60 text-t-secondary">{icon}</span>
    <p className="text-sm font-semibold text-t-primary">{title}</p>
  </div>
);

export default InsightsSection;
