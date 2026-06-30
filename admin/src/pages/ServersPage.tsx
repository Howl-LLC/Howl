// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Filter, RefreshCw, Globe, Server, X, AlertCircle,
} from 'lucide-react';
import { adminApi, type AdminServerSummary } from '../api';
import { SEARCH_INPUT_CLS, BTN_PRIMARY, BTN_GHOST, CARD, TABLE_HEAD } from '../components/styles';
import { Pagination, AdminAvatar } from '../components';
import { formatRelative } from '../utils';

const ServersPage: React.FC = () => {
  const navigate = useNavigate();

  const [servers, setServers] = useState<AdminServerSummary[]>([]);
  const [serverTotal, setServerTotal] = useState(0);
  const [serverPage, setServerPage] = useState(1);
  const [serverPages, setServerPages] = useState(1);
  const [serverSearchInput, setServerSearchInput] = useState('');
  const [serverSearchQuery, setServerSearchQuery] = useState('');
  const [serverPowerUpTierFilter, setServerPowerUpTierFilter] = useState('');
  const [showServerFilters, setShowServerFilters] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadServers = useCallback(async (q: string, page: number, powerUpTier?: string) => {
    setError(null);
    try {
      const data = await adminApi.getServersFiltered(q || undefined, page, powerUpTier ? { powerUpTier } : undefined);
      setServers(data.servers);
      setServerTotal(data.total);
      setServerPage(data.page);
      setServerPages(data.pages);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load data'); }
  }, []);

  useEffect(() => { loadServers(serverSearchQuery, serverPage, serverPowerUpTierFilter); }, [serverSearchQuery, serverPage, serverPowerUpTierFilter, loadServers]);

  const handleServerSearch = (e: React.FormEvent) => { e.preventDefault(); setServerSearchQuery(serverSearchInput); setServerPage(1); };

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Server Management</h2>
          <p className="text-sm text-slate-500 mt-1">Manage servers, power-up tiers, and permissions</p>
        </div>
        <button onClick={() => loadServers(serverSearchQuery, serverPage, serverPowerUpTierFilter)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </div>

      <form onSubmit={handleServerSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
          <input type="text" value={serverSearchInput} onChange={(e) => setServerSearchInput(e.target.value)} placeholder="Search by server name or ID..."
            className={SEARCH_INPUT_CLS} />
        </div>
        <button type="submit" className={BTN_PRIMARY}>Search</button>
        <button type="button" onClick={() => setShowServerFilters(!showServerFilters)} className={`${BTN_GHOST} relative flex items-center gap-1.5 text-xs font-medium ${showServerFilters || serverPowerUpTierFilter ? 'text-cyan-300' : ''}`}>
          <Filter size={14} /> Filters
          {serverPowerUpTierFilter && <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500/30 text-[9px] text-cyan-300 flex items-center justify-center border border-cyan-500/30">1</span>}
        </button>
      </form>

      {showServerFilters && (
        <div className={`${CARD} p-4 mb-4`}>
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Power-up Tier</span>
            {['', '0', '1', '2', '3'].map((v) => (
              <FilterChip key={v} label={v === '' ? 'All' : `Tier ${v}`} active={serverPowerUpTierFilter === v} onClick={() => { setServerPowerUpTierFilter(v); setServerPage(1); }} />
            ))}
            {serverPowerUpTierFilter && (
              <button onClick={() => { setServerPowerUpTierFilter(''); setServerPage(1); }} className="text-xs text-red-400 hover:text-red-300 ml-auto flex items-center gap-1"><X size={12} /> Clear</button>
            )}
          </div>
        </div>
      )}

      <div className="text-xs text-slate-500 mb-3 flex items-center gap-2">
        <Globe size={13} /> {serverTotal.toLocaleString()} server{serverTotal !== 1 ? 's' : ''}
      </div>

      {error && (
        <div className="flex flex-col items-center justify-center py-16 text-sm">
          <AlertCircle size={24} className="text-red-400 mb-3" />
          <p className="text-red-300 mb-4">{error}</p>
          <button onClick={() => loadServers(serverSearchQuery, serverPage, serverPowerUpTierFilter)} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-medium hover:bg-cyan-500/25">
            Retry
          </button>
        </div>
      )}

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Server</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Members</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Channels</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Power-ups</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Power-up Tier</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Created</th>
          </tr></thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} onClick={() => navigate(`/servers/${s.id}`)} className="border-t border-white/[0.04] hover:bg-white/[0.03] cursor-pointer transition-all duration-150 group">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <AdminAvatar src={s.icon} name={s.name} size={36} rounded={12} fallback={<div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center text-indigo-300 text-xs font-bold">{s.name.charAt(0).toUpperCase()}</div>} />
                    <div>
                      <div className="text-white font-medium group-hover:text-cyan-300 transition-colors">{s.name}</div>
                      <div className="text-[11px] text-slate-500 font-mono">{s.id.slice(0, 12)}...</div>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3.5"><span className="text-slate-300 font-medium">{s.memberCount}</span></td>
                <td className="px-5 py-3.5"><span className="text-slate-300 font-medium">{s.channelCount}</span></td>
                <td className="px-5 py-3.5">
                  <span className={`font-medium ${s.powerUpCount > 0 ? 'text-cyan-300' : 'text-slate-500'}`}>{s.powerUpCount}</span>
                </td>
                <td className="px-5 py-3.5">
                  <span className={`text-[11px] font-bold px-3 py-1.5 rounded-lg border ${
                    s.powerUpTier >= 3 ? 'border-violet-500/40 bg-violet-500/20 text-violet-300' :
                    s.powerUpTier >= 2 ? 'border-cyan-500/40 bg-cyan-500/20 text-cyan-300' :
                    s.powerUpTier >= 1 ? 'border-blue-500/40 bg-blue-500/20 text-blue-300' :
                    'border-white/[0.06] bg-white/[0.03] text-slate-500'
                  }`}>Tier {s.powerUpTier}</span>
                </td>
                <td className="px-5 py-3.5 text-xs text-slate-500">{formatRelative(s.createdAt)}</td>
              </tr>
            ))}
            {servers.length === 0 && (
              <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><Server size={20} className="mx-auto mb-2 opacity-40" />No servers found</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={serverPage} pages={serverPages} total={serverTotal} onPageChange={setServerPage} label="servers" />
    </div>
  );
};

export default ServersPage;
