// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft, AlertTriangle, Check,
  X as XIcon, RefreshCw, Users, BarChart3, Flag,
  TrendingUp, Eye, MessageSquare, Sparkles,
} from 'lucide-react';
import {
  adminApi,
  type AdminServerDetail,
  type AdminServerSettings,
  type AdminServerInsights,
  type AdminServerReport,
} from '../api';
import { BTN_PRIMARY, CARD } from '../components/styles';
import {
  AdminAvatar,
  PageHeader,
  ServerAdminActionButtons,
  ServerAdminStatusBadges,
  hydrateFlagsFromServer,
  type ServerAdminFlagsState,
} from '../components';
import { formatDate, formatRelative } from '../utils';

const ServerActions: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const [server, setServer] = useState<AdminServerDetail | null>(null);
  const [settings, setSettings] = useState<AdminServerSettings | null>(null);
  const [insights, setInsights] = useState<AdminServerInsights | null>(null);
  const [recentReports, setRecentReports] = useState<AdminServerReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  // Live admin-moderation flag snapshot. Hydrated from the server detail
  // payload on load and updated in place by ServerAdminActionButtons after
  // each successful action so the badges + button labels track without
  // a round-trip refetch.
  const [flags, setFlags] = useState<ServerAdminFlagsState>({
    featured: false, verified: false, hidden: false, suspended: false, discoveryOverride: false,
  });

  const fetchAll = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [serverRes, settingsRes, insightsRes, reportsRes] = await Promise.allSettled([
        adminApi.getServer(id),
        adminApi.getServerSettings(id),
        adminApi.adminServerInsights(id),
        adminApi.adminServerReportsList(1, undefined),
      ]);

      if (serverRes.status === 'fulfilled') {
        setServer(serverRes.value);
        setFlags(hydrateFlagsFromServer(serverRes.value));
      }
      else throw new Error('Failed to load server');

      if (settingsRes.status === 'fulfilled') setSettings(settingsRes.value.settings);
      if (insightsRes.status === 'fulfilled') setInsights(insightsRes.value);
      if (reportsRes.status === 'fulfilled') {
        // Filter to reports against this server only.
        setRecentReports(reportsRes.value.reports.filter((r) => r.serverId === id).slice(0, 10));
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load server';
      setError(msg);
    }
    setLoading(false);
  }, [id]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20 text-slate-500 text-sm">
        <RefreshCw size={16} className="animate-spin mr-2" /> Loading server actions...
      </div>
    );
  }

  if (error || !server) {
    return (
      <div className="text-center py-20">
        <div className="mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center justify-center gap-2.5 bg-red-500/10 border-red-500/25 text-red-300 max-w-md mx-auto">
          <AlertTriangle size={16} /> {error ?? 'Server not found'}
        </div>
        <button onClick={() => navigate('/discovery')} className="text-sm text-slate-400 hover:text-white flex items-center gap-2 mx-auto">
          <ChevronLeft size={16} /> Back to discovery queue
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '64rem', margin: '0 auto' }}>
      <button
        onClick={() => navigate('/discovery')}
        className="flex items-center gap-2 text-sm text-slate-400 hover:text-white mb-5 -ml-1 transition-colors"
      >
        <ChevronLeft size={16} /> Back to discovery queue
      </button>

      <PageHeader title={`Trust & Safety actions: ${server.name}`} subtitle="Review activity, recent reports, and apply moderation actions." />

      {actionResult && (
        <div className={`mb-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100"><XIcon size={14} /></button>
        </div>
      )}

      {/* Server header card */}
      <div className={`${CARD} p-6 mb-5`}>
        <div className="flex items-start gap-5">
          <AdminAvatar src={server.icon} name={server.name} size={72} rounded={16} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap mb-2">
              <h2 className="text-xl font-bold text-white tracking-tight">{server.name}</h2>
              <ServerAdminStatusBadges flags={flags} />
            </div>
            <div className="text-xs text-slate-500">
              ID: <code className="bg-white/5 px-2 py-0.5 rounded font-mono text-slate-400">{server.id}</code>
              <span className="mx-2 text-slate-700">·</span>
              Created {formatDate(server.createdAt)}
              <span className="mx-2 text-slate-700">·</span>
              <Users size={11} className="inline -mt-0.5 mr-1" />{server.memberCount.toLocaleString()} members
            </div>
            {settings?.description && (
              <p className="text-sm text-slate-300 mt-3 line-clamp-3">{settings.description}</p>
            )}
          </div>
        </div>
      </div>

      <ServerAdminActionButtons
        serverId={server.id}
        serverName={server.name}
        flags={flags}
        onFlagsChange={setFlags}
        onActionResult={(r) => { setActionResult(r); if (r.type === 'success') fetchAll(); }}
      />

      {/* Insights snapshot */}
      <div className={`${CARD} p-5 mb-5`}>
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-violet-500/15 flex items-center justify-center"><BarChart3 size={14} className="text-violet-400" /></div>
          Insights snapshot
          {insights && <span className="text-[10px] text-slate-500 font-normal ml-auto">Last {insights.windowDays} days · generated {formatRelative(insights.generatedAt)}</span>}
        </h3>
        {!insights ? (
          <p className="text-xs text-slate-500 italic py-2">No insights data available.</p>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <InsightStat label="Active members" value={insights.activeMembers} icon={<Users size={13} />} />
            <InsightStat label="New joins" value={insights.newJoins} icon={<TrendingUp size={13} />} />
            <InsightStat label="Messages sent" value={insights.messagesSent} icon={<MessageSquare size={13} />} />
            <InsightStat label="Retention rate" value={`${(insights.retentionRate * 100).toFixed(1)}%`} icon={<TrendingUp size={13} />} />
            <InsightStat label="Profile visits" value={insights.publicProfileVisits} icon={<Eye size={13} />} />
            <InsightStat label="Community features" value={insights.communityFeaturesActive} icon={<Sparkles size={13} />} />
          </div>
        )}
      </div>

      {/* Recent reports */}
      <div className={`${CARD} p-5 mb-5`}>
        <h3 className="text-sm font-bold text-white mb-4 flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-amber-500/15 flex items-center justify-center"><Flag size={14} className="text-amber-400" /></div>
          Recent Server Reports ({recentReports.length})
        </h3>
        {recentReports.length === 0 ? (
          <p className="text-xs text-slate-500 italic py-2">No recent reports against this server.</p>
        ) : (
          <ul className="divide-y divide-white/[0.04]">
            {recentReports.map((r) => (
              <li key={r.id} className="py-3 flex items-start gap-3">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-lg border capitalize shrink-0 ${
                  r.status === 'pending' ? 'bg-amber-500/15 text-amber-300 border-amber-500/25' :
                  r.status === 'reviewed' ? 'bg-blue-500/15 text-blue-300 border-blue-500/25' :
                  r.status === 'actioned' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' :
                  'bg-slate-500/15 text-slate-400 border-slate-500/25'
                }`}>{r.status}</span>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-slate-300">
                    <span className="text-white font-semibold capitalize">{r.reason}</span>
                    {r.details && <span className="text-slate-500"> — {r.details}</span>}
                  </div>
                  <div className="text-[10px] text-slate-600 mt-0.5">{formatRelative(r.createdAt)}{r.reporter ? ` · by ${r.reporter.username}#${r.reporter.discriminator}` : ''}</div>
                </div>
              </li>
            ))}
          </ul>
        )}
        <button
          onClick={() => navigate('/server-reports')}
          className={`${BTN_PRIMARY} mt-4 w-full justify-center`}
        >
          View all server reports
        </button>
      </div>

    </div>
  );
};

const InsightStat: React.FC<{ label: string; value: number | string; icon: React.ReactNode }> = ({ label, value, icon }) => (
  <div className="rounded-xl border border-white/[0.06] bg-white/[0.02] p-4">
    <div className="flex items-center gap-1.5 text-[10px] text-slate-500 font-bold uppercase tracking-wider mb-1">
      {icon} {label}
    </div>
    <div className="text-xl font-bold text-white">{typeof value === 'number' ? value.toLocaleString() : value}</div>
  </div>
);

export default ServerActions;
