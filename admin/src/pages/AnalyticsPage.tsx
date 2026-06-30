// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { BarChart3, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import type { AnalyticsResponse } from '../api';
import { PageHeader } from '../components';
import { CARD } from '../components/styles';

// Constants

type TimeRange = '24h' | '7d' | '30d' | '3mo' | '6mo';

const TIME_RANGES: { label: string; value: TimeRange }[] = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '30d', value: '30d' },
  { label: '3mo', value: '3mo' },
  { label: '6mo', value: '6mo' },
];

const REGIONS = [
  { key: 'NA', label: 'North America', color: '#22d3ee' },
  { key: 'EU', label: 'Europe', color: '#8b5cf6' },
  { key: 'ASIA', label: 'Asia', color: '#f59e0b' },
  { key: 'SA', label: 'South America', color: '#22c55e' },
  { key: 'OCE', label: 'Oceania', color: '#6366f1' },
  { key: 'AF', label: 'Africa', color: '#64748b' },
];

const GLASS_CARD = 'rounded-2xl border border-white/[0.06] bg-[rgba(10,15,30,0.72)] backdrop-blur-md p-6';

// Helpers

function formatTimeLabel(ts: string, range: TimeRange): string {
  const d = new Date(ts);
  if (range === '24h') {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  }
  if (range === '7d') {
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function formatTooltipTime(ts: string, range: TimeRange): string {
  const d = new Date(ts);
  if (range === '24h') {
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  }
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

// Data transformation

interface GlobalDataPoint {
  timestamp: string;
  total: number;
}

interface RegionalDataPoint {
  timestamp: string;
  [region: string]: string | number;
}

function buildGlobalData(snapshots: AnalyticsResponse['snapshots']): GlobalDataPoint[] {
  const byTs = new Map<string, number>();
  for (const snap of snapshots) {
    const key = snap.date || snap.timestamp;
    byTs.set(key, (byTs.get(key) || 0) + snap.onlineCount);
  }
  return Array.from(byTs.entries())
    .map(([timestamp, total]) => ({ timestamp, total }))
    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function buildRegionalData(snapshots: AnalyticsResponse['snapshots']): RegionalDataPoint[] {
  const byTs = new Map<string, Record<string, number>>();
  for (const snap of snapshots) {
    const key = snap.date || snap.timestamp;
    if (!byTs.has(key)) byTs.set(key, {});
    const entry = byTs.get(key)!;
    entry[snap.region] = (entry[snap.region] || 0) + snap.onlineCount;
  }
  return Array.from(byTs.entries())
    .map(([timestamp, regions]) => ({ timestamp, ...regions }))
    .sort((a, b) => new Date(a.timestamp as string).getTime() - new Date(b.timestamp as string).getTime());
}

// Custom Tooltip

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ name: string; value: number; color: string }>;
  label?: string;
  range: TimeRange;
  isGlobal?: boolean;
}

const CustomTooltip: React.FC<CustomTooltipProps> = ({ active, payload, label, range, isGlobal }) => {
  if (!active || !payload?.length || !label) return null;
  return (
    <div className="rounded-xl border border-white/[0.1] bg-[rgba(10,15,30,0.95)] backdrop-blur-md px-4 py-3 shadow-xl">
      <p className="text-xs text-slate-400 mb-2">{formatTooltipTime(label, range)}</p>
      {payload.map((entry) => (
        <div key={entry.name} className="flex items-center justify-between gap-4 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
            <span className="text-slate-300">{isGlobal ? 'Online' : entry.name}</span>
          </div>
          <span className="font-semibold text-white">{entry.value.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
};

// Component

const AnalyticsPage: React.FC = () => {
  const [range, setRange] = useState<TimeRange>('24h');
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (r: TimeRange) => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getAnalytics(r);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(range);
  }, [range, fetchData]);

  const globalData = useMemo(() => (data ? buildGlobalData(data.snapshots) : []), [data]);
  const regionalData = useMemo(() => (data ? buildRegionalData(data.snapshots) : []), [data]);

  const totalOnline = data?.totalOnline ?? 0;
  const currentByRegion = data?.currentByRegion ?? {};
  const regionTotal = Object.values(currentByRegion).reduce((s, v) => s + v, 0) || 1;

  // Empty / Error / Loading states

  if (loading) {
    return (
      <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
        <PageHeader title="Analytics" subtitle="Platform analytics and insights" />
        <div className={`${GLASS_CARD} flex items-center justify-center`} style={{ minHeight: 320 }}>
          <div className="flex items-center gap-3 text-slate-400">
            <RefreshCw size={18} className="animate-spin" />
            <span className="text-sm">Loading analytics...</span>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
        <PageHeader title="Analytics" subtitle="Platform analytics and insights" />
        <div className={`${GLASS_CARD} flex flex-col items-center justify-center text-center`} style={{ minHeight: 320 }}>
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button onClick={() => fetchData(range)} className="px-4 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-semibold hover:bg-cyan-500/25 transition-all">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const hasSnapshots = data && data.snapshots.length > 0;

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader title="Analytics" subtitle="Platform analytics and insights">
        {/* Time Range Selector */}
        <div className="flex gap-0.5 bg-white/[0.03] border border-white/[0.08] rounded-xl p-0.5">
          {TIME_RANGES.map((tr) => (
            <button
              key={tr.value}
              onClick={() => setRange(tr.value)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                range === tr.value
                  ? 'bg-[rgba(34,211,238,0.12)] text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              {tr.label}
            </button>
          ))}
        </div>
      </PageHeader>

      {!hasSnapshots ? (
        /* ── Empty State ──────────────────────────────────────────────── */
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/15 border border-cyan-500/20 flex items-center justify-center mb-5">
            <BarChart3 size={28} className="text-cyan-400" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">No Analytics Data Yet</h3>
          <p className="text-sm text-slate-500 max-w-md">
            Analytics data will appear after the first hourly snapshot. Check back soon.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* ── Global Online Chart ─────────────────────────────────── */}
          <div className={GLASS_CARD}>
            <div className="flex items-center justify-between mb-5">
              <div>
                <h3 className="text-sm font-semibold text-white">Users Online &mdash; Global</h3>
                <p className="text-xs text-slate-500 mt-0.5">Across all regions</p>
              </div>
              <div className="text-right">
                <p className="text-2xl font-bold text-cyan-400">{totalOnline.toLocaleString()}</p>
                <p className="text-xs text-slate-500">currently online</p>
              </div>
            </div>
            <ResponsiveContainer width="100%" height={280}>
              <AreaChart data={globalData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="globalGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="rgba(34,211,238,0.2)" />
                    <stop offset="100%" stopColor="rgba(34,211,238,0)" />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(ts: string) => formatTimeLabel(ts, range)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={formatNumber}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  content={<CustomTooltip range={range} isGlobal />}
                  cursor={{ stroke: 'rgba(34,211,238,0.2)', strokeWidth: 1 }}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#22d3ee"
                  strokeWidth={2}
                  fill="url(#globalGradient)"
                  fillOpacity={1}
                  dot={false}
                  activeDot={{ r: 4, fill: '#22d3ee', stroke: 'rgba(10,15,30,0.8)', strokeWidth: 2 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* ── Regional Stacked Area Chart ─────────────────────────── */}
          <div className={GLASS_CARD}>
            <div className="mb-5">
              <h3 className="text-sm font-semibold text-white">Users Online &mdash; By Region</h3>
              <p className="text-xs text-slate-500 mt-0.5">Stacked breakdown by geographic region</p>
            </div>
            <ResponsiveContainer width="100%" height={260}>
              <AreaChart data={regionalData} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <defs>
                  {REGIONS.map((r) => (
                    <linearGradient key={r.key} id={`regionGradient-${r.key}`} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={r.color} stopOpacity={0.3} />
                      <stop offset="100%" stopColor={r.color} stopOpacity={0.05} />
                    </linearGradient>
                  ))}
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(ts: string) => formatTimeLabel(ts, range)}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                  tickLine={false}
                  minTickGap={40}
                />
                <YAxis
                  tickFormatter={formatNumber}
                  tick={{ fill: '#64748b', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  width={48}
                />
                <Tooltip
                  content={<CustomTooltip range={range} />}
                  cursor={{ stroke: 'rgba(255,255,255,0.08)', strokeWidth: 1 }}
                />
                <Legend
                  verticalAlign="top"
                  align="right"
                  iconType="circle"
                  iconSize={8}
                  wrapperStyle={{ paddingBottom: 8, fontSize: 11 }}
                  formatter={(value: string) => <span className="text-slate-400 ml-1">{value}</span>}
                />
                {REGIONS.map((r) => (
                  <Area
                    key={r.key}
                    type="monotone"
                    dataKey={r.key}
                    name={r.label}
                    stackId="regions"
                    stroke={r.color}
                    strokeWidth={1.5}
                    fill={`url(#regionGradient-${r.key})`}
                    fillOpacity={1}
                    dot={false}
                    activeDot={{ r: 3, fill: r.color, stroke: 'rgba(10,15,30,0.8)', strokeWidth: 2 }}
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* ── Region Breakdown Cards ──────────────────────────────── */}
          <div className="grid grid-cols-3 gap-3.5">
            {REGIONS.map((r) => {
              const count = currentByRegion[r.key] ?? 0;
              const pct = regionTotal > 0 ? (count / regionTotal) * 100 : 0;
              return (
                <div key={r.key} className={GLASS_CARD}>
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: r.color }} />
                      <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{r.key}</span>
                    </div>
                    <span className="text-xs text-slate-500">{pct.toFixed(1)}%</span>
                  </div>
                  <p className="text-xl font-bold mb-3" style={{ color: r.color }}>
                    {count.toLocaleString()}
                  </p>
                  <div className="w-full h-1 rounded-full bg-white/[0.06]">
                    <div
                      className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: r.color }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-500 mt-2">{r.label}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};

export default AnalyticsPage;
