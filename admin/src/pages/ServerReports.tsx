// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Flag, Eye, AlertTriangle, Check, X as XIcon, RefreshCw, MessageSquare,
} from 'lucide-react';
import {
  adminApi,
  type AdminServerReport,
} from '../api';
import { BTN_GHOST, CARD, INPUT_CLS, SELECT_CLS, TABLE_HEAD } from '../components/styles';
import { AdminAvatar, PageHeader, Pagination } from '../components';
import { formatRelative } from '../utils';

const STATUS_CHIPS: Array<{ v: string; l: string }> = [
  { v: '', l: 'All' },
  { v: 'pending', l: 'Pending' },
  { v: 'reviewed', l: 'Reviewed' },
  { v: 'actioned', l: 'Actioned' },
  { v: 'dismissed', l: 'Dismissed' },
];

const REASON_STYLES: Record<string, string> = {
  csam: 'bg-red-500/15 text-red-300 border-red-500/25',
  harassment: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
  spam: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/25',
  violence: 'bg-rose-500/15 text-rose-300 border-rose-500/25',
  policy_violation: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  illegal_content: 'bg-red-500/15 text-red-300 border-red-500/25',
  other: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
};

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  reviewed: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
  actioned: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  dismissed: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
};

const ServerReports: React.FC = () => {
  const navigate = useNavigate();
  const [reports, setReports] = useState<AdminServerReport[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AdminServerReport | null>(null);
  const [editStatus, setEditStatus] = useState('');
  const [editAction, setEditAction] = useState('');
  const [editNote, setEditNote] = useState('');
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = useCallback(async (p: number, status?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await adminApi.adminServerReportsList(p, status || undefined);
      setReports(data.reports);
      setTotal(data.total);
      setPage(data.page);
      setPages(data.pages);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load server reports';
      setLoadError(msg);
      setReports([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(page, statusFilter); }, [page, statusFilter, load]);

  const openReport = useCallback((r: AdminServerReport) => {
    setSelected(r);
    setEditStatus(r.status);
    setEditAction(r.actionTaken ?? '');
    setEditNote(r.reviewNote ?? '');
  }, []);

  const submitUpdate = useCallback(async (override?: { status?: string }) => {
    if (!selected) return;
    try {
      await adminApi.adminServerReportPatch(selected.id, {
        status: override?.status ?? editStatus,
        actionTaken: editAction || undefined,
        reviewNote: editNote || undefined,
      });
      setActionResult({ type: 'success', message: `Report ${override?.status ?? editStatus}` });
      setSelected(null);
      load(page, statusFilter);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to update report';
      setActionResult({ type: 'error', message: msg });
    }
  }, [selected, editStatus, editAction, editNote, load, page, statusFilter]);

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader
        title="Server Reports"
        subtitle="Reports filed against entire community servers — review and update statuses."
      >
        <button onClick={() => load(page, statusFilter)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </PageHeader>

      <div className="flex gap-2 mb-5 items-center">
        <div className="flex gap-1">
          {STATUS_CHIPS.map((f) => (
            <FilterChip key={f.v} label={f.l} active={statusFilter === f.v} onClick={() => { setStatusFilter(f.v); setPage(1); }} />
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2"><Flag size={13} /> {total.toLocaleString()} report{total !== 1 ? 's' : ''}</span>
      </div>

      {loadError ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <AlertTriangle size={20} className="text-red-400 mb-3" />
          <p className="text-sm text-slate-300 mb-1">Server reports unavailable</p>
          <p className="text-xs text-slate-500 mb-4">{loadError}</p>
          <button onClick={() => load(page, statusFilter)} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-xs font-bold hover:bg-cyan-500/25">Retry</button>
        </div>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead><tr className={TABLE_HEAD}>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Server</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Reporter</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Reason</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Submitted</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider w-12"></th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><RefreshCw size={16} className="inline animate-spin mr-2" /> Loading...</td></tr>
              ) : reports.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><Flag size={20} className="mx-auto mb-2 opacity-40" />No server reports found</td></tr>
              ) : reports.map((r) => (
                <tr key={r.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-all duration-150 cursor-pointer" onClick={() => openReport(r)}>
                  <td className="px-5 py-3.5">
                    {r.server ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); navigate(`/discovery/${r.server!.id}`); }}
                        className="flex items-center gap-2 hover:opacity-80 transition-opacity"
                      >
                        <AdminAvatar src={r.server.icon} name={r.server.name} size={28} rounded={8} />
                        <span className="text-white text-[13px] font-medium truncate">{r.server.name}</span>
                      </button>
                    ) : <span className="text-slate-500 text-xs font-mono">{r.serverId.slice(0, 8)}...</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    {r.reporter ? (
                      <div className="flex items-center gap-2">
                        <AdminAvatar src={r.reporter.avatar} name={r.reporter.username} size={24} />
                        <span className="text-slate-300 text-xs">{r.reporter.username}<span className="text-slate-500">#{r.reporter.discriminator}</span></span>
                      </div>
                    ) : <span className="text-slate-500 text-xs">{r.reporterId.slice(0, 8)}...</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${REASON_STYLES[r.reason] || 'bg-white/5 text-slate-300 border-white/10'}`}>
                      {r.reason.replace(/_/g, ' ')}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${STATUS_STYLES[r.status]}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="text-slate-300 text-xs">{formatRelative(r.createdAt)}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{new Date(r.createdAt).toLocaleString()}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={(e) => { e.stopPropagation(); openReport(r); }}
                      className="p-2 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-all"
                      title="Review report"
                    >
                      <Eye size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pages={pages} total={total} onPageChange={setPage} label="reports" />

      {actionResult && (
        <div className={`mt-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100"><XIcon size={14} /></button>
        </div>
      )}

      {/* Detail modal */}
      {selected && (
        <div className="fixed inset-0 z-[998] flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={() => setSelected(null)}>
          <div className="bg-[#0c1225] rounded-2xl border border-white/[0.08] p-7 max-w-2xl w-full mx-4 shadow-2xl shadow-black/40 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Flag size={18} className="text-cyan-400" /> Server Report
                </h3>
                <p className="text-xs text-slate-500 mt-1">ID: {selected.id}</p>
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all"><XIcon size={16} /></button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-5">
              <div className={`${CARD} p-4`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Server</div>
                {selected.server ? (
                  <button
                    onClick={() => { setSelected(null); navigate(`/discovery/${selected.server!.id}`); }}
                    className="flex items-center gap-2.5 hover:opacity-80 transition-opacity text-left"
                  >
                    <AdminAvatar src={selected.server.icon} name={selected.server.name} size={36} rounded={10} />
                    <div>
                      <div className="text-white font-medium text-sm">{selected.server.name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">{selected.server.id}</div>
                    </div>
                  </button>
                ) : <span className="text-slate-500 text-xs font-mono">{selected.serverId}</span>}
              </div>
              <div className={`${CARD} p-4`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Reporter</div>
                {selected.reporter ? (
                  <button
                    onClick={() => { setSelected(null); navigate(`/users/${selected.reporter!.id}`); }}
                    className="flex items-center gap-2.5 hover:opacity-80 transition-opacity text-left"
                  >
                    <AdminAvatar src={selected.reporter.avatar} name={selected.reporter.username} size={36} />
                    <div>
                      <div className="text-white font-medium text-sm">{selected.reporter.username}<span className="text-slate-500">#{selected.reporter.discriminator}</span></div>
                      <div className="text-[10px] text-slate-500 font-mono">{selected.reporter.id}</div>
                    </div>
                  </button>
                ) : <span className="text-slate-500 text-xs font-mono">{selected.reporterId}</span>}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-5">
              <div className={`${CARD} p-3`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">Reason</div>
                <span className={`inline-block px-2.5 py-1 text-xs font-semibold rounded-lg border capitalize ${REASON_STYLES[selected.reason] || 'bg-slate-500/15 text-slate-400 border-slate-500/25'}`}>
                  {selected.reason.replace(/_/g, ' ')}
                </span>
              </div>
              <div className={`${CARD} p-3`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">Current Status</div>
                <span className={`inline-block px-2.5 py-1 text-xs font-semibold rounded-lg border capitalize ${STATUS_STYLES[selected.status]}`}>{selected.status}</span>
              </div>
            </div>

            {selected.details && (
              <div className={`${CARD} p-4 mb-5`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2 flex items-center gap-1.5">
                  <MessageSquare size={11} /> Reporter's Notes
                </div>
                <div className="text-sm text-slate-200 leading-relaxed bg-white/[0.03] rounded-xl p-3 border border-white/[0.06] whitespace-pre-wrap break-words">
                  {selected.details}
                </div>
              </div>
            )}

            <div className={`${CARD} p-4 mb-5`}>
              <div className="text-xs text-slate-500 mb-3 font-bold uppercase tracking-wider">Admin Review</div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">Status</label>
                  <select value={editStatus} onChange={(e) => setEditStatus(e.target.value)} className={SELECT_CLS + ' w-full'}>
                    <option value="pending">Pending</option>
                    <option value="reviewed">Reviewed</option>
                    <option value="actioned">Actioned</option>
                    <option value="dismissed">Dismissed</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">Action Taken</label>
                  <select value={editAction} onChange={(e) => setEditAction(e.target.value)} className={SELECT_CLS + ' w-full'}>
                    <option value="">No action selected</option>
                    <option value="none">None</option>
                    <option value="warn_owner">Warn Owner</option>
                    <option value="hide_from_discovery">Hide from Discovery</option>
                    <option value="suspend_server">Suspend Server</option>
                    <option value="ban_owner">Ban Owner</option>
                    <option value="ncmec_report">NCMEC Report</option>
                  </select>
                </div>
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">Review Note</label>
                  <textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} rows={3} className={INPUT_CLS + ' resize-none'} placeholder="Internal notes..." />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button onClick={() => setSelected(null)} className="px-4 py-2.5 rounded-xl bg-white/5 text-slate-300 text-sm font-medium hover:bg-white/10">Cancel</button>
              <button
                onClick={() => submitUpdate({ status: 'dismissed' })}
                className="px-4 py-2.5 rounded-xl bg-slate-500/15 text-slate-300 border border-slate-500/25 text-sm font-semibold hover:bg-slate-500/25"
              >Dismiss</button>
              <button
                onClick={() => submitUpdate()}
                className="px-5 py-2.5 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-bold hover:bg-cyan-500/25 hover:border-cyan-500/40"
              >Save Changes</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ServerReports;
