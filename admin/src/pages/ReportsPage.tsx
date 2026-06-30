// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Flag, Eye, Hash, Lock, MessageSquare,
  Check, AlertTriangle, X, ShieldAlert,
} from 'lucide-react';
import { adminApi, resolveUrl, type AdminReport, type ReportStats } from '../api';
import { INPUT_CLS, BTN_GHOST, BTN_PRIMARY, CARD, TABLE_HEAD, SELECT_CLS } from '../components/styles';
import { Pagination, AdminAvatar } from '../components';
import { formatRelative } from '../utils';

const STAT_COLORS: Record<string, { text: string; bg: string; border: string }> = {
  amber: { text: 'text-amber-400', bg: 'bg-amber-500/15', border: 'border-amber-500/25' },
  blue: { text: 'text-blue-400', bg: 'bg-blue-500/15', border: 'border-blue-500/25' },
  emerald: { text: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/25' },
  slate: { text: 'text-slate-400', bg: 'bg-slate-500/15', border: 'border-slate-500/25' },
  cyan: { text: 'text-cyan-400', bg: 'bg-cyan-500/15', border: 'border-cyan-500/25' },
  red: { text: 'text-red-400', bg: 'bg-red-500/15', border: 'border-red-500/25' },
};

const ReportsPage: React.FC = () => {
  const [reports, setReports] = useState<AdminReport[]>([]);
  const [reportsTotal, setReportsTotal] = useState(0);
  const [reportsPage, setReportsPage] = useState(1);
  const [reportsPages, setReportsPages] = useState(1);
  const [reportsStatusFilter, setReportsStatusFilter] = useState('');
  const [reportStats, setReportStats] = useState<ReportStats | null>(null);
  const [selectedReport, setSelectedReport] = useState<AdminReport | null>(null);
  const [reportReviewNotes, setReportReviewNotes] = useState('');
  const [reportActionTaken, setReportActionTaken] = useState('');
  const [reportNcmecId, setReportNcmecId] = useState('');
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadReports = useCallback(async (page: number, status?: string) => {
    setLoadError(null);
    try {
      const data = await adminApi.getReports(page, status || undefined);
      setReports(data.reports);
      setReportsTotal(data.total);
      setReportsPage(data.page);
      setReportsPages(data.pages);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load reports');
    }
  }, []);

  const loadReportStats = useCallback(async () => {
    try { setReportStats(await adminApi.getReportStats()); } catch { /* stats are non-critical */ }
  }, []);

  useEffect(() => { loadReports(reportsPage, reportsStatusFilter); loadReportStats(); }, [reportsPage, reportsStatusFilter, loadReports, loadReportStats]);

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Message Reports</h2>
          <p className="text-sm text-slate-500 mt-1">User-submitted reports for review and moderation</p>
        </div>
        <button onClick={() => { loadReports(reportsPage, reportsStatusFilter); loadReportStats(); }} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </div>

      {reportStats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          {[
            { label: 'Pending', value: reportStats.pending, color: 'amber' },
            { label: 'Reviewed', value: reportStats.reviewed, color: 'blue' },
            { label: 'Actioned', value: reportStats.actioned, color: 'emerald' },
            { label: 'Dismissed', value: reportStats.dismissed, color: 'slate' },
            { label: 'Total', value: reportStats.total, color: 'cyan' },
            { label: 'CSAM Pending', value: reportStats.csamPending, color: 'red' },
          ].map(s => (
            <div key={s.label} className={`${CARD} p-4`}>
              <div className={`text-xs font-semibold uppercase tracking-wider ${STAT_COLORS[s.color]?.text ?? 'text-slate-400'} mb-1`}>{s.label}</div>
              <div className="text-2xl font-bold text-white">{s.value}</div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 mb-5 items-center">
        <div className="flex gap-1">
          {[
            { v: '', l: 'All' },
            { v: 'pending', l: 'Pending' },
            { v: 'reviewed', l: 'Reviewed' },
            { v: 'actioned', l: 'Actioned' },
            { v: 'dismissed', l: 'Dismissed' },
          ].map(f => (
            <FilterChip key={f.v} label={f.l} active={reportsStatusFilter === f.v} onClick={() => { setReportsStatusFilter(f.v); setReportsPage(1); }} />
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2"><Flag size={13} /> {reportsTotal.toLocaleString()} report{reportsTotal !== 1 ? 's' : ''}</span>
      </div>

      {loadError ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <p className="text-sm text-red-400 mb-4">{loadError}</p>
          <button onClick={() => { loadReports(reportsPage, reportsStatusFilter); loadReportStats(); }} className={BTN_PRIMARY}>Retry</button>
        </div>
      ) : (
      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Reporter</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Reported User</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Type</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Reason</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Submitted</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Actions</th>
          </tr></thead>
          <tbody>
            {reports.map((r) => {
              const statusStyles: Record<string, string> = {
                pending: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
                reviewed: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
                actioned: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
                dismissed: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
              };
              const reasonStyles: Record<string, string> = {
                csam: 'bg-red-500/15 text-red-300 border-red-500/25',
                harassment: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
                spam: 'bg-yellow-500/15 text-yellow-300 border-yellow-500/25',
                violence: 'bg-rose-500/15 text-rose-300 border-rose-500/25',
                other: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
              };
              return (
                <tr key={r.id} className={`border-t border-white/[0.04] hover:bg-white/[0.02] transition-all duration-150 ${r.reason === 'csam' && r.status === 'pending' ? 'bg-red-500/[0.03]' : ''}`}>
                  <td className="px-5 py-3.5">
                    {r.reporter ? (
                      <div className="flex items-center gap-2">
                        <AdminAvatar src={r.reporter.avatar} name={r.reporter.username} size={28} />
                        <span className="text-white text-[13px] font-medium">{r.reporter.username}<span className="text-slate-500">#{r.reporter.discriminator}</span></span>
                      </div>
                    ) : <span className="text-slate-500 text-xs italic">{r.reporterId ? `${r.reporterId.slice(0, 8)}...` : 'system'}</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    {r.author ? (
                      <div className="flex items-center gap-2">
                        <AdminAvatar src={r.author.avatar} name={r.author.username} size={28} />
                        <span className="text-white text-[13px] font-medium">{r.author.username}<span className="text-slate-500">#{r.author.discriminator}</span></span>
                      </div>
                    ) : r.authorId ? (
                      <span className="text-slate-500 text-xs">{r.authorId.slice(0, 8)}...</span>
                    ) : r.authorUsernameSnapshot ? (
                      <span className="text-slate-400 text-xs italic">{r.authorUsernameSnapshot}<span className="text-slate-600">#{r.authorDiscriminatorSnapshot}</span> (deleted)</span>
                    ) : <span className="text-slate-500 text-xs italic">—</span>}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="inline-flex items-center gap-1.5 text-xs text-slate-300">
                      {r.messageType === 'dm' ? <Lock size={12} className="text-emerald-400" /> : <Hash size={12} className="text-slate-400" />}
                      {r.messageType === 'dm' ? 'DM' : 'Channel'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${reasonStyles[r.reason] || 'bg-white/5 text-slate-300 border-white/10'}`}>
                      {r.reason}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${statusStyles[r.status] || 'bg-white/5 text-slate-300 border-white/10'}`}>
                      {r.status}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="text-slate-300 text-xs">{formatRelative(r.createdAt)}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{new Date(r.createdAt).toLocaleString()}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => { setSelectedReport(r); setReportReviewNotes(r.reviewNotes || ''); setReportActionTaken(r.actionTaken || ''); setReportNcmecId(r.ncmecReportId || ''); }}
                      className="p-2 rounded-lg text-slate-400 hover:text-cyan-300 hover:bg-cyan-500/10 transition-all duration-200"
                      title="Review report"
                    >
                      <Eye size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {reports.length === 0 && (
              <tr><td colSpan={7} className="px-5 py-16 text-center text-slate-500"><Flag size={20} className="mx-auto mb-2 opacity-40" />No reports found</td></tr>
            )}
          </tbody>
        </table>
      </div>
      )}
      <Pagination page={reportsPage} pages={reportsPages} total={reportsTotal} onPageChange={setReportsPage} label="reports" />

      {actionResult && (
        <div className={`mt-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100 transition-opacity"><X size={14} /></button>
        </div>
      )}

      {/* Report Detail Modal */}
      {selectedReport && (
        <div className="fixed inset-0 z-[998] flex items-center justify-center bg-black/70 backdrop-blur-md" onClick={() => setSelectedReport(null)}>
          <div className="bg-[#0c1225] rounded-2xl border border-white/[0.08] p-7 max-w-2xl w-full mx-4 shadow-2xl shadow-black/40 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-6">
              <div>
                <h3 className="text-lg font-bold text-white flex items-center gap-2">
                  <Flag size={18} className="text-cyan-400" /> Report Details
                </h3>
                <p className="text-xs text-slate-500 mt-1">ID: {selectedReport.id}</p>
              </div>
              <button onClick={() => setSelectedReport(null)} className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-white/10 transition-all"><X size={16} /></button>
            </div>

            <div className="grid grid-cols-2 gap-4 mb-6">
              <div className={`${CARD} p-4`}>
                <div className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Reporter</div>
                {selectedReport.reporter ? (
                  <div className="flex items-center gap-2.5">
                    <AdminAvatar src={selectedReport.reporter.avatar} name={selectedReport.reporter.username} size={36} />
                    <div>
                      <div className="text-white font-medium text-sm">{selectedReport.reporter.username}<span className="text-slate-500">#{selectedReport.reporter.discriminator}</span></div>
                      <div className="text-[10px] text-slate-500 font-mono">{selectedReport.reporterId}</div>
                    </div>
                  </div>
                ) : <span className="text-slate-500 text-xs italic">{selectedReport.reporterId ? <span className="font-mono">{selectedReport.reporterId}</span> : 'system (auto-flagged upload)'}</span>}
              </div>
              <div className={`${CARD} p-4`}>
                <div className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider">Reported Author</div>
                {selectedReport.author ? (
                  <div className="flex items-center gap-2.5">
                    <AdminAvatar src={selectedReport.author.avatar} name={selectedReport.author.username} size={36} />
                    <div>
                      <div className="text-white font-medium text-sm">{selectedReport.author.username}<span className="text-slate-500">#{selectedReport.author.discriminator}</span></div>
                      <div className="text-[10px] text-slate-500 font-mono">{selectedReport.authorId}</div>
                    </div>
                  </div>
                ) : <span className="text-slate-500 text-xs font-mono">{selectedReport.authorId}</span>}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3 mb-6">
              <div className={`${CARD} p-3`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1">Type</div>
                <span className="inline-flex items-center gap-1.5 text-sm text-white">
                  {selectedReport.messageType === 'dm' ? <Lock size={13} className="text-emerald-400" /> : <Hash size={13} className="text-slate-400" />}
                  {selectedReport.messageType === 'dm' ? 'Direct Message' : 'Channel Message'}
                </span>
              </div>
              <div className={`${CARD} p-3`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1">Reason</div>
                <span className={`inline-block px-2.5 py-1 text-xs font-semibold rounded-lg border capitalize ${
                  selectedReport.reason === 'csam' ? 'bg-red-500/15 text-red-300 border-red-500/25' :
                  selectedReport.reason === 'harassment' ? 'bg-orange-500/15 text-orange-300 border-orange-500/25' :
                  selectedReport.reason === 'violence' ? 'bg-rose-500/15 text-rose-300 border-rose-500/25' :
                  selectedReport.reason === 'spam' ? 'bg-yellow-500/15 text-yellow-300 border-yellow-500/25' :
                  'bg-slate-500/15 text-slate-400 border-slate-500/25'
                }`}>{selectedReport.reason}</span>
              </div>
              <div className={`${CARD} p-3`}>
                <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1">Status</div>
                <span className={`inline-block px-2.5 py-1 text-xs font-semibold rounded-lg border capitalize ${
                  selectedReport.status === 'pending' ? 'bg-amber-500/15 text-amber-300 border-amber-500/25' :
                  selectedReport.status === 'reviewed' ? 'bg-blue-500/15 text-blue-300 border-blue-500/25' :
                  selectedReport.status === 'actioned' ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25' :
                  'bg-slate-500/15 text-slate-400 border-slate-500/25'
                }`}>{selectedReport.status}</span>
              </div>
            </div>

            <div className={`${CARD} p-4 mb-6`}>
              <div className="text-xs text-slate-500 mb-2 font-semibold uppercase tracking-wider flex items-center gap-1.5">
                <MessageSquare size={12} /> Reported Message Content
                {(selectedReport.contentSource === 'unavailable' || (selectedReport.contentSource === 'server' && selectedReport.messageType === 'dm' && selectedReport.content && /^\{.*"v"\s*:\s*[12]/.test(selectedReport.content))) && (
                  <span className="ml-auto text-[11px] font-semibold text-slate-400 bg-slate-500/10 border border-slate-500/25 rounded-lg px-2 py-0.5 normal-case tracking-normal inline-flex items-center gap-1">
                    <Lock size={11} /> Legacy — content not disclosed at report time
                  </span>
                )}
                {selectedReport.contentSource === 'reporter_disclosed' && (
                  <span className="ml-auto text-[11px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2 py-0.5 normal-case tracking-normal inline-flex items-center gap-1">
                    <AlertTriangle size={11} /> Reporter-disclosed (unverified)
                  </span>
                )}
              </div>
              <div className="text-sm text-slate-200 leading-relaxed bg-white/[0.03] rounded-xl p-4 border border-white/[0.06] whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {selectedReport.content || <span className="text-slate-500 italic">No text content</span>}
              </div>
              {selectedReport.attachmentUrl && (
                <div className="mt-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1">Attachment</div>
                  {/^(https?:\/\/|\/api\/|data:|blob:)/i.test(selectedReport.attachmentUrl) ? (
                    <a href={resolveUrl(selectedReport.attachmentUrl)} target="_blank" rel="noopener noreferrer" className="text-cyan-400 text-xs hover:underline break-all">{selectedReport.attachmentUrl}</a>
                  ) : (
                    <span className="text-red-400 text-xs break-all">[blocked: unsafe protocol] {selectedReport.attachmentUrl}</span>
                  )}
                </div>
              )}
              {selectedReport.details && (
                <div className="mt-3">
                  <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-1">Reporter's Notes</div>
                  <div className="text-sm text-slate-300 bg-white/[0.03] rounded-lg p-3 border border-white/[0.06]">{selectedReport.details}</div>
                </div>
              )}
            </div>

            {selectedReport.reason === 'csam' && (
              <div className={`${CARD} p-4 mb-6`}>
                <div className="text-xs text-slate-500 mb-3 font-semibold uppercase tracking-wider flex items-center gap-1.5">
                  <ShieldAlert size={12} /> §2258A Evidence
                  {selectedReport.evidenceSource === 'upload-block' && (
                    <span className="ml-auto text-[11px] font-semibold text-emerald-300 bg-emerald-500/10 border border-emerald-500/25 rounded-lg px-2 py-0.5 normal-case tracking-normal inline-flex items-center gap-1">
                      <Check size={11} /> Upload-time evidence (gold standard)
                    </span>
                  )}
                  {selectedReport.evidenceSource === 'action-time-lookup' && (
                    <span className="ml-auto text-[11px] font-semibold text-amber-300 bg-amber-500/10 border border-amber-500/25 rounded-lg px-2 py-0.5 normal-case tracking-normal inline-flex items-center gap-1">
                      <AlertTriangle size={11} /> Action-time snapshot (best-effort)
                    </span>
                  )}
                  {selectedReport.evidenceSource === 'action-time-unavailable' && (
                    <span className="ml-auto text-[11px] font-semibold text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-2 py-0.5 normal-case tracking-normal inline-flex items-center gap-1">
                      <AlertTriangle size={11} /> Session expired — IP/UA unrecoverable
                    </span>
                  )}
                  {selectedReport.evidenceSource === null && (
                    <span className="ml-auto text-[11px] font-semibold text-slate-400 bg-slate-500/10 border border-slate-500/25 rounded-lg px-2 py-0.5 normal-case tracking-normal">
                      Pending — captured when actioned as CSAM
                    </span>
                  )}
                </div>
                {selectedReport.evidenceSource === 'action-time-unavailable' && (
                  <div className="text-[11px] text-red-300/80 bg-red-500/[0.05] border border-red-500/20 rounded-lg p-3 mb-3">
                    The 90-day session retention window had expired by the time this report was confirmed. The original upload IP and user-agent are not in our records. Other evidence (file, hashes, account snapshot, channel context) is still preserved and reportable to NCMEC.
                  </div>
                )}
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">Uploader IP</div>
                    <div className="text-slate-200 font-mono">{selectedReport.uploaderIp ?? <span className="text-slate-500 italic font-sans">unavailable</span>}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">User-Agent</div>
                    <div className="text-slate-200 font-mono break-all">{selectedReport.uploaderUserAgent ?? <span className="text-slate-500 italic font-sans">unavailable</span>}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">SHA-256</div>
                    <div className="text-slate-200 font-mono break-all">{selectedReport.sha256 ?? <span className="text-slate-500 italic font-sans">—</span>}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">Intended Target</div>
                    <div className="text-slate-200">{selectedReport.intendedSource ?? <span className="text-slate-500 italic">—</span>}{selectedReport.intendedSourceId ? <span className="text-slate-500 font-mono ml-1">/ {selectedReport.intendedSourceId.slice(0, 8)}…</span> : null}</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">Author Snapshot</div>
                    <div className="text-slate-200">
                      {selectedReport.authorUsernameSnapshot ? (
                        <>{selectedReport.authorUsernameSnapshot}<span className="text-slate-500">#{selectedReport.authorDiscriminatorSnapshot}</span></>
                      ) : <span className="text-slate-500 italic">—</span>}
                    </div>
                  </div>
                  <div>
                    <div className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-0.5">Preservation Began</div>
                    <div className="text-slate-200">{selectedReport.preservedAt ? new Date(selectedReport.preservedAt).toLocaleString() : <span className="text-slate-500 italic">not yet preserved</span>}</div>
                  </div>
                </div>
              </div>
            )}

            <div className={`${CARD} p-4 mb-6`}>
              <div className="text-xs text-slate-500 mb-3 font-semibold uppercase tracking-wider">Admin Review</div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">Action Taken</label>
                  <select value={reportActionTaken} onChange={(e) => setReportActionTaken(e.target.value)} className={SELECT_CLS + ' w-full'}>
                    <option value="">No action selected</option>
                    <option value="none">None</option>
                    <option value="warn">Warn User</option>
                    <option value="delete">Delete Message</option>
                    <option value="ban">Ban User</option>
                    <option value="ncmec_report">NCMEC Report</option>
                  </select>
                </div>
                {reportActionTaken === 'ncmec_report' && (
                  <div>
                    <label className="text-xs text-slate-400 block mb-1.5">NCMEC Report ID</label>
                    <input value={reportNcmecId} onChange={(e) => setReportNcmecId(e.target.value)} className={INPUT_CLS} placeholder="Enter NCMEC report ID..." />
                  </div>
                )}
                <div>
                  <label className="text-xs text-slate-400 block mb-1.5">Review Notes</label>
                  <textarea value={reportReviewNotes} onChange={(e) => setReportReviewNotes(e.target.value)} rows={3} className={INPUT_CLS + ' resize-none'} placeholder="Internal notes about this report..." />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2">
              <button
                onClick={async () => {
                  try {
                    await adminApi.flagHashFromReport(selectedReport.id, 'csam');
                    setActionResult({ type: 'success', message: 'Hash flagged from report' });
                  } catch (err: any) {
                    setActionResult({ type: 'error', message: err.message || 'Failed to flag hash' });
                  }
                }}
                className="px-4 py-2.5 rounded-xl bg-red-500/15 text-red-300 border border-red-500/25 text-sm font-semibold hover:bg-red-500/25 hover:border-red-500/40 transition-all duration-200 mr-auto flex items-center gap-1.5"
                title="Flag the image hash from this report"
              ><ShieldAlert size={14} /> Flag Hash</button>
              <button
                onClick={() => setSelectedReport(null)}
                className="px-4 py-2.5 rounded-xl bg-white/5 text-slate-300 text-sm font-medium hover:bg-white/10 transition-all duration-200"
              >Cancel</button>
              <button
                onClick={async () => {
                  try {
                    await adminApi.updateReport(selectedReport.id, { status: 'dismissed', reviewNotes: reportReviewNotes, actionTaken: reportActionTaken || 'none', ncmecReportId: reportNcmecId || undefined });
                    setActionResult({ type: 'success', message: 'Report dismissed' });
                    setSelectedReport(null);
                    loadReports(reportsPage, reportsStatusFilter);
                    loadReportStats();
                  } catch { setActionResult({ type: 'error', message: 'Failed to dismiss report' }); }
                }}
                className="px-4 py-2.5 rounded-xl bg-slate-500/15 text-slate-300 border border-slate-500/25 text-sm font-semibold hover:bg-slate-500/25 transition-all duration-200"
              >Dismiss</button>
              <button
                onClick={async () => {
                  try {
                    await adminApi.updateReport(selectedReport.id, { status: 'actioned', reviewNotes: reportReviewNotes, actionTaken: reportActionTaken || undefined, ncmecReportId: reportNcmecId || undefined });
                    setActionResult({ type: 'success', message: 'Report actioned' });
                    setSelectedReport(null);
                    loadReports(reportsPage, reportsStatusFilter);
                    loadReportStats();
                  } catch { setActionResult({ type: 'error', message: 'Failed to action report' }); }
                }}
                className="px-5 py-2.5 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-bold hover:bg-cyan-500/25 hover:border-cyan-500/40 transition-all duration-200"
              >Mark Actioned</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ReportsPage;
