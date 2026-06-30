// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldCheck, Eye, AlertTriangle, Check, X as XIcon, RefreshCw, ExternalLink,
} from 'lucide-react';
import { adminApi, type AdminVerificationRequest } from '../api';
import { BTN_GHOST, CARD, TABLE_HEAD } from '../components/styles';
import { AdminAvatar, PageHeader, Pagination } from '../components';
import { formatRelative } from '../utils';

const STATUS_CHIPS: Array<{ v: string; l: string }> = [
  { v: 'pending', l: 'Pending' },
  { v: 'approved', l: 'Approved' },
  { v: 'rejected', l: 'Rejected' },
  { v: 'withdrawn', l: 'Withdrawn' },
];

const STATUS_STYLES: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
  approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
  rejected: 'bg-red-500/15 text-red-300 border-red-500/25',
  withdrawn: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
};

const VerificationRequests: React.FC = () => {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<AdminVerificationRequest[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [statusFilter, setStatusFilter] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [selected, setSelected] = useState<AdminVerificationRequest | null>(null);
  const [decisionNote, setDecisionNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const load = useCallback(async (p: number, status: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await adminApi.adminVerificationRequestsList(p, status);
      setRequests(data.requests);
      setTotal(data.total);
      setPage(data.page);
      setPages(data.pages);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to load verification requests';
      setLoadError(msg);
      setRequests([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => { load(page, statusFilter); }, [page, statusFilter, load]);

  const openRequest = useCallback((r: AdminVerificationRequest) => {
    setSelected(r);
    setDecisionNote(r.decisionNote ?? '');
  }, []);

  const handleApprove = useCallback(async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await adminApi.adminVerificationRequestApprove(selected.id, decisionNote.trim() || undefined);
      setActionResult({ type: 'success', message: `Approved — ${selected.server.name} now has the verified badge.` });
      setSelected(null);
      load(page, statusFilter);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to approve';
      setActionResult({ type: 'error', message: msg });
    }
    setSubmitting(false);
  }, [selected, decisionNote, load, page, statusFilter]);

  const handleReject = useCallback(async () => {
    if (!selected) return;
    if (!decisionNote.trim()) {
      setActionResult({ type: 'error', message: 'Decision note is required when rejecting.' });
      return;
    }
    setSubmitting(true);
    try {
      await adminApi.adminVerificationRequestReject(selected.id, decisionNote.trim());
      setActionResult({ type: 'success', message: `Rejected — ${selected.server.name} owner notified.` });
      setSelected(null);
      load(page, statusFilter);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to reject';
      setActionResult({ type: 'error', message: msg });
    }
    setSubmitting(false);
  }, [selected, decisionNote, load, page, statusFilter]);

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader
        title="Verification Requests"
        subtitle="Server owner applications for the 'Verified by Howl' badge — review and decide."
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
        <span className="text-xs text-slate-500 flex items-center gap-2"><ShieldCheck size={13} /> {total.toLocaleString()} request{total !== 1 ? 's' : ''}</span>
      </div>

      {loadError ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <AlertTriangle size={20} className="text-red-400 mb-3" />
          <p className="text-sm text-slate-300 mb-1">Verification requests unavailable</p>
          <p className="text-xs text-slate-500 mb-4">{loadError}</p>
          <button onClick={() => load(page, statusFilter)} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-xs font-bold hover:bg-cyan-500/25">Retry</button>
        </div>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead><tr className={TABLE_HEAD}>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Server</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Organization</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Submitted by</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Submitted</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider w-12"></th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><RefreshCw size={16} className="inline animate-spin mr-2" /> Loading...</td></tr>
              ) : requests.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><ShieldCheck size={20} className="mx-auto mb-2 opacity-40" />No {statusFilter} verification requests</td></tr>
              ) : requests.map((r) => (
                <tr key={r.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-all duration-150 cursor-pointer" onClick={() => openRequest(r)}>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <AdminAvatar src={r.server.icon} name={r.server.name} size={28} rounded={8} />
                      <div className="flex flex-col">
                        <span className="text-white text-[13px] font-medium truncate">{r.server.name}</span>
                        <span className="text-[10px] text-slate-500">{r.server.memberCount.toLocaleString()} members</span>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-slate-300 text-xs">{r.organizationName}</td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-2">
                      <AdminAvatar src={r.submitter.avatar} name={r.submitter.username} size={24} />
                      <span className="text-slate-300 text-xs">{r.submitter.username}<span className="text-slate-500">#{r.submitter.discriminator}</span></span>
                    </div>
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
                      onClick={(e) => { e.stopPropagation(); openRequest(r); }}
                      className="p-2 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-all"
                      title="Review request"
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

      <Pagination page={page} pages={pages} total={total} onPageChange={setPage} label="requests" />

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
                  <ShieldCheck size={18} className="text-sky-400" /> Verification Request
                </h3>
                <p className="text-xs text-slate-500 mt-1">ID: {selected.id}</p>
              </div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all"><XIcon size={16} /></button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-5">
              <div className={`${CARD} p-4`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Server</div>
                <button
                  onClick={() => { setSelected(null); navigate(`/discovery/${selected.server.id}`); }}
                  className="flex items-center gap-2.5 hover:opacity-80 transition-opacity text-left"
                >
                  <AdminAvatar src={selected.server.icon} name={selected.server.name} size={36} rounded={10} />
                  <div>
                    <div className="text-white font-medium text-sm flex items-center gap-1.5">
                      {selected.server.name}
                      {selected.server.alreadyVerified && <ShieldCheck size={12} className="text-sky-400" />}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {selected.server.memberCount.toLocaleString()} members · created {new Date(selected.server.createdAt).toLocaleDateString()}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">{selected.server.id}</div>
                  </div>
                </button>
              </div>
              <div className={`${CARD} p-4`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Submitted by</div>
                <button
                  onClick={() => { setSelected(null); navigate(`/users/${selected.submitter.id}`); }}
                  className="flex items-center gap-2.5 hover:opacity-80 transition-opacity text-left"
                >
                  <AdminAvatar src={selected.submitter.avatar} name={selected.submitter.username} size={36} />
                  <div>
                    <div className="text-white font-medium text-sm">
                      {selected.submitter.username}<span className="text-slate-500">#{selected.submitter.discriminator}</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">{selected.submitter.id}</div>
                  </div>
                </button>
              </div>
            </div>

            <div className={`${CARD} p-4 mb-4`}>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Organization name</div>
              <div className="text-sm text-slate-200">{selected.organizationName}</div>
            </div>

            <div className={`${CARD} p-4 mb-4`}>
              <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Website</div>
              <a
                href={selected.websiteUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-cyan-300 hover:text-cyan-200 inline-flex items-center gap-1.5 break-all"
              >
                {selected.websiteUrl} <ExternalLink size={12} />
              </a>
              <div className="text-[10px] text-slate-500 mt-2">
                Visit the website and verify it represents a real organization that owns this community before approving.
              </div>
            </div>

            {selected.additionalNotes && (
              <div className={`${CARD} p-4 mb-5`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-2">Owner's notes</div>
                <div className="text-sm text-slate-200 leading-relaxed bg-white/[0.03] rounded-xl p-3 border border-white/[0.06] whitespace-pre-wrap break-words">
                  {selected.additionalNotes}
                </div>
              </div>
            )}

            {selected.status === 'pending' ? (
              <>
                <div className={`${CARD} p-4 mb-5`}>
                  <div className="text-xs text-slate-500 mb-3 font-bold uppercase tracking-wider">Decision</div>
                  <textarea
                    value={decisionNote}
                    onChange={(e) => setDecisionNote(e.target.value)}
                    rows={4}
                    maxLength={2048}
                    placeholder="Optional for approval. Required for rejection — explain why so the owner can address it."
                    className="w-full px-3 py-2.5 rounded-xl bg-white/[0.03] border border-white/[0.08] text-sm text-slate-200 placeholder-slate-600 outline-none focus:border-cyan-500/30 transition-colors resize-y"
                  />
                </div>
                <div className="flex gap-3 justify-end">
                  <button
                    onClick={handleReject}
                    disabled={submitting}
                    className="px-5 py-2.5 rounded-xl bg-red-500/15 text-red-300 border border-red-500/25 text-xs font-bold hover:bg-red-500/25 transition-all disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {submitting ? <RefreshCw size={14} className="animate-spin" /> : <XIcon size={14} />}
                    Reject
                  </button>
                  <button
                    onClick={handleApprove}
                    disabled={submitting}
                    className="px-5 py-2.5 rounded-xl bg-emerald-500/15 text-emerald-300 border border-emerald-500/25 text-xs font-bold hover:bg-emerald-500/25 transition-all disabled:opacity-50 inline-flex items-center gap-2"
                  >
                    {submitting ? <RefreshCw size={14} className="animate-spin" /> : <Check size={14} />}
                    Approve & verify server
                  </button>
                </div>
              </>
            ) : (
              <div className={`${CARD} p-4`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-bold mb-1">Decision recorded</div>
                <div className="text-xs text-slate-300">
                  {selected.status} on {selected.decidedAt ? new Date(selected.decidedAt).toLocaleString() : '—'}
                </div>
                {selected.decisionNote && (
                  <div className="mt-2 text-xs text-slate-200 bg-white/[0.03] rounded-xl p-3 border border-white/[0.06] whitespace-pre-wrap">
                    {selected.decisionNote}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default VerificationRequests;
