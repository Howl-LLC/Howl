// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from 'recharts';
import { Layers, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import type { ProtocolDistributionResponse } from '../api';
import { PageHeader } from '../components';
import { CARD } from '../components/styles';

type Range = '24h' | '7d' | '14d' | '30d' | '60d';

const RANGES: { label: string; value: Range }[] = [
  { label: '24h', value: '24h' },
  { label: '7d', value: '7d' },
  { label: '14d', value: '14d' },
  { label: '30d', value: '30d' },
  { label: '60d', value: '60d' },
];

const PLATFORM_ORDER: Array<'web' | 'electron' | 'unknown'> = ['web', 'electron', 'unknown'];
const PLATFORM_LABEL: Record<string, string> = {
  web: 'Web',
  electron: 'Electron',
  unknown: 'Unknown',
};
const PLATFORM_COLOR: Record<string, string> = {
  web: '#22d3ee',
  electron: '#8b5cf6',
  unknown: '#64748b',
};

const BUILDDATE_COLORS = ['#22c55e', '#3b82f6', '#f59e0b', '#ec4899', '#14b8a6', '#a855f7', '#ef4444'];

const GLASS_CARD = 'rounded-2xl border border-white/[0.06] bg-[rgba(10,15,30,0.72)] backdrop-blur-md p-6';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
}

function buildChartDataForPlatform(
  snapshots: ProtocolDistributionResponse['snapshots'],
  platform: string,
): Array<Record<string, string | number>> {
  const byTs = new Map<string, Record<string, number>>();
  for (const snap of snapshots) {
    if (snap.platform !== platform) continue;
    const ts = snap.date || snap.timestamp;
    if (!byTs.has(ts)) byTs.set(ts, {});
    const entry = byTs.get(ts)!;
    const key = snap.buildDate ?? 'unknown';
    entry[key] = (entry[key] || 0) + snap.count;
  }
  return Array.from(byTs.entries())
    .map(([timestamp, buildDates]) => ({ timestamp, ...buildDates }))
    .sort((a, b) => new Date(a.timestamp as string).getTime() - new Date(b.timestamp as string).getTime());
}

function uniqueBuildDatesForPlatform(
  snapshots: ProtocolDistributionResponse['snapshots'],
  platform: string,
): string[] {
  const set = new Set<string>();
  for (const snap of snapshots) {
    if (snap.platform !== platform) continue;
    set.add(snap.buildDate ?? 'unknown');
  }
  return Array.from(set).sort();
}

const ProtocolDistributionPage: React.FC = () => {
  const [range, setRange] = useState<Range>('14d');
  const [threshold, setThreshold] = useState<string>(daysAgoIso(45));
  const [data, setData] = useState<ProtocolDistributionResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getProtocolDistribution(range, threshold);
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [range, threshold]);

  useEffect(() => { load(); }, [load]);

  const webChart = useMemo(() => data ? buildChartDataForPlatform(data.snapshots, 'web') : [], [data]);
  const electronChart = useMemo(() => data ? buildChartDataForPlatform(data.snapshots, 'electron') : [], [data]);
  const webBuildDates = useMemo(() => data ? uniqueBuildDatesForPlatform(data.snapshots, 'web') : [], [data]);
  const electronBuildDates = useMemo(() => data ? uniqueBuildDatesForPlatform(data.snapshots, 'electron') : [], [data]);

  // Loading state

  if (loading) {
    return (
      <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
        <PageHeader title="Protocol Distribution" subtitle="Client buildDate / platform / protocolVersion distribution" />
        <div className={`${GLASS_CARD} flex items-center justify-center`} style={{ minHeight: 320 }}>
          <div className="flex items-center gap-3 text-slate-400">
            <RefreshCw size={18} className="animate-spin" />
            <span className="text-sm">Loading protocol distribution...</span>
          </div>
        </div>
      </div>
    );
  }

  // Error state

  if (error) {
    return (
      <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
        <PageHeader title="Protocol Distribution" subtitle="Client buildDate / platform / protocolVersion distribution" />
        <div className={`${GLASS_CARD} flex flex-col items-center justify-center text-center`} style={{ minHeight: 320 }}>
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button onClick={load} className="px-4 py-2 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-semibold hover:bg-cyan-500/25 transition-all">
            Retry
          </button>
        </div>
      </div>
    );
  }

  const hasSnapshots = data && data.snapshots.length > 0;

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader title="Protocol Distribution" subtitle="Use to decide when to flip ENFORCE_VERSION_GATE">
        {/* Range selector — matches AnalyticsPage pattern */}
        <div className="flex gap-0.5 bg-white/[0.03] border border-white/[0.08] rounded-xl p-0.5">
          {RANGES.map(r => (
            <button
              key={r.value}
              onClick={() => setRange(r.value)}
              className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all duration-200 ${
                range === r.value
                  ? 'bg-[rgba(34,211,238,0.12)] text-cyan-400 border border-cyan-500/20'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] border border-transparent'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200 inline-flex items-center gap-2 hover:bg-white/[0.07] transition-all"
        >
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      </PageHeader>

      {/* Threshold date selector */}
      <div className={`${GLASS_CARD} mb-5`}>
        <div className="flex items-center gap-3 flex-wrap">
          <label className="text-sm text-slate-400">Target threshold buildDate:</label>
          <input
            type="date"
            value={threshold}
            min={daysAgoIso(60)}
            max={todayIso()}
            onChange={(e) => setThreshold(e.target.value)}
            className="px-3 py-2 rounded-xl bg-white/[0.04] border border-white/[0.08] text-sm text-slate-200"
          />
          <span className="text-xs text-slate-500">(today: {todayIso()})</span>
        </div>
      </div>

      {!hasSnapshots ? (
        /* ── Empty State ──────────────────────────────────────────────── */
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <div className="w-16 h-16 rounded-2xl bg-cyan-500/15 border border-cyan-500/20 flex items-center justify-center mb-5">
            <Layers size={28} className="text-cyan-400" />
          </div>
          <h3 className="text-lg font-bold text-white mb-2">No Snapshot Data Yet</h3>
          <p className="text-sm text-slate-500 max-w-md">
            Snapshots write every hour. Check back soon.
          </p>
        </div>
      ) : (
        <div className="space-y-5">
          {/* ── Threshold stat cards ────────────────────────────────── */}
          {data?.current.atOrAboveThreshold && (
            <div className="grid grid-cols-3 gap-3.5">
              {PLATFORM_ORDER.map(platform => {
                const slot = data.current.atOrAboveThreshold![platform];
                const pct = slot?.pct ?? 0;
                const good = pct >= 95;
                return (
                  <div key={platform} className={GLASS_CARD}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: PLATFORM_COLOR[platform] }} />
                        <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{PLATFORM_LABEL[platform]}</span>
                      </div>
                    </div>
                    <p className={`text-3xl font-bold mb-3 ${good ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {pct.toFixed(1)}%
                    </p>
                    <div className="w-full h-1 rounded-full bg-white/[0.06] mb-2">
                      <div
                        className="h-full rounded-full transition-all duration-500"
                        style={{ width: `${Math.min(pct, 100)}%`, backgroundColor: good ? '#34d399' : '#fbbf24' }}
                      />
                    </div>
                    <p className="text-[11px] text-slate-500">
                      {slot?.meeting ?? 0} / {slot?.total ?? 0} connected &ge; {threshold}
                    </p>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── Web chart ──────────────────────────────────────────── */}
          {webChart.length > 0 && (
            <div className={GLASS_CARD}>
              <div className="mb-5">
                <h3 className="text-sm font-semibold text-white">Web &mdash; adoption over time</h3>
                <p className="text-xs text-slate-500 mt-0.5">Stacked by buildDate</p>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={webChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    {webBuildDates.map((bd, i) => (
                      <linearGradient key={bd} id={`webGradient-${bd}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={BUILDDATE_COLORS[i % BUILDDATE_COLORS.length]} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={BUILDDATE_COLORS[i % BUILDDATE_COLORS.length]} stopOpacity={0.05} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" stroke="#64748b" fontSize={11}
                    tickFormatter={(ts: string) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis stroke="#64748b" fontSize={11} axisLine={false} tickLine={false} width={48} />
                  <Tooltip contentStyle={{ background: 'rgba(10,15,30,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem' }} />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ paddingBottom: 8, fontSize: 11 }}
                    formatter={(value: string) => <span className="text-slate-400 ml-1">{value}</span>}
                  />
                  {webBuildDates.map((bd, i) => (
                    <Area key={bd} type="monotone" dataKey={bd} stackId="1"
                      stroke={BUILDDATE_COLORS[i % BUILDDATE_COLORS.length]}
                      fill={`url(#webGradient-${bd})`}
                      fillOpacity={1}
                      dot={false}
                      activeDot={{ r: 3, fill: BUILDDATE_COLORS[i % BUILDDATE_COLORS.length], stroke: 'rgba(10,15,30,0.8)', strokeWidth: 2 }}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* ── Electron chart ─────────────────────────────────────── */}
          {electronChart.length > 0 && (
            <div className={GLASS_CARD}>
              <div className="mb-5">
                <h3 className="text-sm font-semibold text-white">Electron &mdash; adoption over time</h3>
                <p className="text-xs text-slate-500 mt-0.5">Stacked by buildDate</p>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <AreaChart data={electronChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                  <defs>
                    {electronBuildDates.map((bd, i) => (
                      <linearGradient key={bd} id={`electronGradient-${bd}`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={BUILDDATE_COLORS[i % BUILDDATE_COLORS.length]} stopOpacity={0.3} />
                        <stop offset="100%" stopColor={BUILDDATE_COLORS[i % BUILDDATE_COLORS.length]} stopOpacity={0.05} />
                      </linearGradient>
                    ))}
                  </defs>
                  <CartesianGrid stroke="rgba(255,255,255,0.04)" strokeDasharray="3 3" />
                  <XAxis dataKey="timestamp" stroke="#64748b" fontSize={11}
                    tickFormatter={(ts: string) => new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
                    tickLine={false}
                    minTickGap={40}
                  />
                  <YAxis stroke="#64748b" fontSize={11} axisLine={false} tickLine={false} width={48} />
                  <Tooltip contentStyle={{ background: 'rgba(10,15,30,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '0.75rem' }} />
                  <Legend
                    verticalAlign="top"
                    align="right"
                    iconType="circle"
                    iconSize={8}
                    wrapperStyle={{ paddingBottom: 8, fontSize: 11 }}
                    formatter={(value: string) => <span className="text-slate-400 ml-1">{value}</span>}
                  />
                  {electronBuildDates.map((bd, i) => (
                    <Area key={bd} type="monotone" dataKey={bd} stackId="1"
                      stroke={BUILDDATE_COLORS[i % BUILDDATE_COLORS.length]}
                      fill={`url(#electronGradient-${bd})`}
                      fillOpacity={1}
                      dot={false}
                      activeDot={{ r: 3, fill: BUILDDATE_COLORS[i % BUILDDATE_COLORS.length], stroke: 'rgba(10,15,30,0.8)', strokeWidth: 2 }}
                    />
                  ))}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ProtocolDistributionPage;
