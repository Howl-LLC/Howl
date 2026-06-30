// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw, Filter, FileText, ChevronDown, X,
} from 'lucide-react';
import { adminApi, type AdminAuditEntry, type AuditLogFilters } from '../api';
import { INPUT_CLS, BTN_PRIMARY, BTN_GHOST, CARD, TABLE_HEAD, SELECT_CLS } from '../components/styles';
import { Pagination, AdminAvatar } from '../components';
import { formatRelative, actionLabel, actionColor, AUDIT_ACTIONS } from '../utils';

const AuditLogPage: React.FC = () => {
  const navigate = useNavigate();

  const [auditEntries, setAuditEntries] = useState<AdminAuditEntry[]>([]);
  const [auditPage, setAuditPage] = useState(1);
  const [auditPages, setAuditPages] = useState(1);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditFilters, setAuditFilters] = useState<AuditLogFilters>({});
  const [showAuditFilters, setShowAuditFilters] = useState(false);
  const [auditAdminInput, setAuditAdminInput] = useState('');
  const [auditTargetIdInput, setAuditTargetIdInput] = useState('');
  const [auditTargetNameInput, setAuditTargetNameInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const loadAudit = useCallback(async (page: number, filters: AuditLogFilters) => {
    setError(null);
    try {
      const data = await adminApi.getAuditLog(page, Object.values(filters).some(Boolean) ? filters : undefined);
      setAuditEntries(data.entries);
      setAuditPage(data.page);
      setAuditPages(data.pages);
      setAuditTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    }
  }, []);

  useEffect(() => { loadAudit(auditPage, auditFilters); }, [auditPage, auditFilters, loadAudit]);

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Audit Log</h2>
          <p className="text-sm text-slate-500 mt-1">Track all administrative actions</p>
        </div>
        <button onClick={() => loadAudit(auditPage, auditFilters)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap items-center">
        <div className="relative">
          <select value={auditFilters.action || ''} onChange={(e) => { setAuditFilters(f => ({ ...f, action: e.target.value || undefined })); setAuditPage(1); }}
            className={`${SELECT_CLS} pl-4 pr-8 min-w-[180px]`}>
            {AUDIT_ACTIONS.map(a => <option key={a.value} value={a.value}>{a.label}</option>)}
          </select>
          <ChevronDown size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
        </div>
        <button type="button" onClick={() => setShowAuditFilters(!showAuditFilters)} className={`${BTN_GHOST} relative flex items-center gap-1.5 text-xs font-medium ${showAuditFilters || auditFilters.adminId || auditFilters.targetUserId || auditFilters.targetName ? 'text-cyan-300' : ''}`}>
          <Filter size={14} /> More Filters
          {(auditFilters.adminId || auditFilters.targetUserId || auditFilters.targetName) && (
            <span className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-cyan-500/30 text-[9px] text-cyan-300 flex items-center justify-center border border-cyan-500/30">
              {[auditFilters.adminId, auditFilters.targetUserId, auditFilters.targetName].filter(Boolean).length}
            </span>
          )}
        </button>
        {Object.values(auditFilters).some(Boolean) && (
          <button onClick={() => { setAuditFilters({}); setAuditAdminInput(''); setAuditTargetIdInput(''); setAuditTargetNameInput(''); setAuditPage(1); }} className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs text-red-400 hover:text-red-300 border border-red-500/20 hover:bg-red-500/10 transition-all duration-200">
            <X size={12} /> Clear all filters
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2 self-center"><FileText size={13} /> {auditTotal.toLocaleString()} entries</span>
      </div>

      {showAuditFilters && (
        <div className={`${CARD} p-4 mb-4`}>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 block">Admin ID</label>
              <form onSubmit={(ev) => { ev.preventDefault(); setAuditFilters(f => ({ ...f, adminId: auditAdminInput.trim() || undefined })); setAuditPage(1); }}>
                <input type="text" value={auditAdminInput} onChange={(e) => setAuditAdminInput(e.target.value)} placeholder="Admin ID (UUID)..."
                  className={`${INPUT_CLS} text-xs`} />
              </form>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 block">Target User ID</label>
              <form onSubmit={(ev) => { ev.preventDefault(); setAuditFilters(f => ({ ...f, targetUserId: auditTargetIdInput.trim() || undefined })); setAuditPage(1); }}>
                <input type="text" value={auditTargetIdInput} onChange={(e) => setAuditTargetIdInput(e.target.value)} placeholder="Target User ID (UUID)..."
                  className={`${INPUT_CLS} text-xs`} />
              </form>
            </div>
            <div>
              <label className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1 block">Target Username</label>
              <form onSubmit={(ev) => { ev.preventDefault(); setAuditFilters(f => ({ ...f, targetName: auditTargetNameInput.trim() || undefined })); setAuditPage(1); }}>
                <input type="text" value={auditTargetNameInput} onChange={(e) => setAuditTargetNameInput(e.target.value)} placeholder="Search by target username..."
                  className={`${INPUT_CLS} text-xs`} />
              </form>
            </div>
          </div>
          <div className="flex justify-end mt-3">
            <button onClick={() => { setAuditFilters(f => ({ ...f, adminId: auditAdminInput.trim() || undefined, targetUserId: auditTargetIdInput.trim() || undefined, targetName: auditTargetNameInput.trim() || undefined })); setAuditPage(1); }} className={`${BTN_PRIMARY} text-xs py-2`}>Apply Filters</button>
          </div>
        </div>
      )}

      {error ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button onClick={() => loadAudit(auditPage, auditFilters)} className={BTN_PRIMARY}>Retry</button>
        </div>
      ) : (
      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Time</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Admin</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Action</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Target</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Details</th>
          </tr></thead>
          <tbody>
            {auditEntries.map((e) => (
              <tr key={e.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-all duration-150">
                <td className="px-5 py-3.5">
                  <div className="text-slate-300 text-xs font-medium">{formatRelative(e.createdAt)}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{new Date(e.createdAt).toLocaleString()}</div>
                </td>
                <td className="px-5 py-3.5">
                  <span className="text-slate-300 font-medium text-[13px]">{e.admin.username}</span>
                </td>
                <td className="px-5 py-3.5">
                  <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border ${actionColor(e.action)}`}>{actionLabel(e.action)}</span>
                </td>
                <td className="px-5 py-3.5">
                  {e.targetUserId ? (
                    <button onClick={() => navigate(`/users/${e.targetUserId}`)} className="text-left hover:bg-white/[0.04] rounded-lg px-2 py-1 -mx-2 transition-all duration-150">
                      {e.targetUser ? (
                        <div className="flex items-center gap-2">
                          <AdminAvatar src={e.targetUser.avatar} name={e.targetUser.username} size={28} />
                          <div>
                            <span className="text-white font-medium text-[13px]">{e.targetUser.username}</span>
                            <span className="text-slate-500 text-[11px]">#{e.targetUser.discriminator}</span>
                            <div className="text-[10px] text-slate-500 font-mono mt-0.5">{e.targetUserId.slice(0, 12)}...</div>
                          </div>
                        </div>
                      ) : (
                        <span className="text-cyan-400 text-xs font-mono">{e.targetUserId.slice(0, 12)}...</span>
                      )}
                    </button>
                  ) : (
                    <span className="text-slate-600">&mdash;</span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-xs text-slate-500 max-w-xs">
                  {e.details ? (
                    <span className="truncate block" title={JSON.stringify(e.details, null, 2)}>{JSON.stringify(e.details)}</span>
                  ) : (
                    <span className="text-slate-600">&mdash;</span>
                  )}
                </td>
              </tr>
            ))}
            {auditEntries.length === 0 && <tr><td colSpan={5} className="px-5 py-16 text-center text-slate-500"><FileText size={20} className="mx-auto mb-2 opacity-40" />No audit log entries</td></tr>}
          </tbody>
        </table>
      </div>
      )}
      <Pagination page={auditPage} pages={auditPages} total={auditTotal} onPageChange={setAuditPage} label="entries" />
    </div>
  );
};

export default AuditLogPage;
