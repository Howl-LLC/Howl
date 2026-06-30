// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import {
  Flag, Activity, Users, UserPlus, Star, Zap, Clock,
  Server, ShieldCheck, AlertCircle, Ban, Lock, RefreshCw,
} from 'lucide-react';
import { adminApi, type AdminStats } from '../api';
import { StatCard } from '../components/StatCard';
import { PageHeader } from '../components/PageHeader';
import { BTN_GHOST } from '../components/styles';

interface AttentionData {
  csamPending: number;
  exportsPending: number;
  lastAuditAgo: string | null;
}

function relativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const SECTION_LABEL = 'text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-3 mt-1';

const OverviewPage: React.FC = () => {
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState(false);
  const [attention, setAttention] = useState<AttentionData | null>(null);

  const loadStats = useCallback(async () => {
    try { setStatsError(false); setStats(await adminApi.getStats()); } catch { setStatsError(true); }
  }, []);

  const loadAttention = useCallback(async () => {
    try {
      const [reportStats, dataReqs, auditLog] = await Promise.allSettled([
        adminApi.getReportStats(),
        adminApi.getDataRequests(1, 'pending'),
        adminApi.getAuditLog(1),
      ]);

      setAttention({
        csamPending: reportStats.status === 'fulfilled' ? reportStats.value.csamPending : 0,
        exportsPending: dataReqs.status === 'fulfilled' ? dataReqs.value.total : 0,
        lastAuditAgo:
          auditLog.status === 'fulfilled' && auditLog.value.entries.length > 0
            ? relativeTime(new Date(auditLog.value.entries[0].createdAt))
            : null,
      });
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadStats();
    loadAttention();
  }, [loadStats, loadAttention]);

  const refresh = useCallback(() => {
    loadStats();
    loadAttention();
  }, [loadStats, loadAttention]);

  return (
    <div className="animate-in fade-in" style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader title="Platform Overview" subtitle="Real-time platform health and statistics">
        <button onClick={refresh} className={BTN_GHOST} title="Refresh">
          <RefreshCw size={16} />
        </button>
      </PageHeader>

      {statsError ? (
        <div className="flex flex-col items-center justify-center py-20 text-sm">
          <AlertCircle size={28} className="text-red-400 mb-3" />
          <p className="text-slate-400 mb-4">Failed to load statistics</p>
          <button onClick={refresh} className={BTN_GHOST + ' flex items-center gap-2 text-cyan-400 hover:text-cyan-300'}>
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      ) : stats ? (
        <div className="space-y-5">
          {/* Row 1: Key Metrics */}
          <div>
            <div className={SECTION_LABEL}>Key Metrics</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
              <StatCard label="Pending Reports" value={stats.pendingReports} icon={Flag} color="red" accent />
              <StatCard label="Online Now" value={stats.onlineUsers} icon={Activity} color="green" accent />
              <StatCard label="Total Users" value={stats.totalUsers} icon={Users} color="cyan" accent />
              <StatCard label="New Users (24h)" value={stats.newUsers24h} icon={UserPlus} color="blue" accent />
            </div>
          </div>

          {/* Row 2: Revenue */}
          <div>
            <div className={SECTION_LABEL}>Revenue</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
              <StatCard label="Pro Users" value={stats.proUsers} icon={Star} color="violet" />
              <StatCard label="Essential Users" value={stats.essentialUsers} icon={Zap} color="emerald" />
              <StatCard label="Active Trials" value={stats.trialUsers} icon={Clock} color="amber" />
              <StatCard label="Total Servers" value={stats.totalServers} icon={Server} color="slate" />
            </div>
          </div>

          {/* Row 3: Platform Health */}
          <div>
            <div className={SECTION_LABEL}>Platform Health</div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3.5">
              <StatCard label="MFA Enabled" value={stats.mfaUsers} icon={ShieldCheck} color="cyan" />
              <StatCard label="Unverified" value={stats.unverifiedUsers} icon={AlertCircle} color="amber" />
              <StatCard label="Deactivated" value={stats.deactivatedUsers} icon={Ban} color="slate" />
              <StatCard label="Suspended" value={stats.suspendedUsers} icon={Lock} color="red" />
            </div>
          </div>

          {/* Needs Attention Bar */}
          {attention && (
            <div className="rounded-xl border border-white/[0.06] bg-[rgba(10,15,30,0.72)] backdrop-blur-md p-3.5 px-5">
              <div className="flex items-center gap-6 text-sm text-slate-400">
                <span className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mr-1">
                  Needs Attention
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500" />
                  {attention.csamPending} CSAM report{attention.csamPending !== 1 ? 's' : ''} pending
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                  {attention.exportsPending} data export{attention.exportsPending !== 1 ? 's' : ''} waiting
                </span>
                <span className="flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-slate-500" />
                  Last audit: {attention.lastAuditAgo ?? 'never'}
                </span>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="flex items-center justify-center py-20 text-slate-500 text-sm">
          <RefreshCw size={16} className="animate-spin mr-2" /> Loading statistics...
        </div>
      )}
    </div>
  );
};

export default OverviewPage;
