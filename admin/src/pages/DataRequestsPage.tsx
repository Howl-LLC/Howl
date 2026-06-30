// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Download, PlayCircle, Trash2, Check, AlertTriangle, X, AlertCircle,
} from 'lucide-react';
import { adminApi, type AdminDataRequest } from '../api';
import { BTN_GHOST, CARD, TABLE_HEAD } from '../components/styles';
import { Pagination, ConfirmModal, AdminAvatar } from '../components';
import { formatRelative } from '../utils';

interface ConfirmModalState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}

const DataRequestsPage: React.FC = () => {
  const [dataRequests, setDataRequests] = useState<AdminDataRequest[]>([]);
  const [dataRequestsTotal, setDataRequestsTotal] = useState(0);
  const [dataRequestsPage, setDataRequestsPage] = useState(1);
  const [dataRequestsPages, setDataRequestsPages] = useState(1);
  const [dataRequestsStatusFilter, setDataRequestsStatusFilter] = useState('');
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadDataRequests = useCallback(async (page: number, status?: string) => {
    setError(null);
    try {
      const data = await adminApi.getDataRequests(page, status || undefined);
      setDataRequests(data.requests);
      setDataRequestsTotal(data.total);
      setDataRequestsPage(data.page);
      setDataRequestsPages(data.pages);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load data'); }
  }, []);

  useEffect(() => { loadDataRequests(dataRequestsPage, dataRequestsStatusFilter); }, [dataRequestsPage, dataRequestsStatusFilter, loadDataRequests]);

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Data Requests</h2>
          <p className="text-sm text-slate-500 mt-1">User data export requests and their status</p>
        </div>
        <button onClick={() => loadDataRequests(dataRequestsPage, dataRequestsStatusFilter)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </div>

      <div className="flex gap-2 mb-5 items-center">
        <div className="flex gap-1">
          {[
            { v: '', l: 'All' },
            { v: 'pending', l: 'Pending' },
            { v: 'processing', l: 'Processing' },
            { v: 'ready', l: 'Ready' },
            { v: 'expired', l: 'Expired' },
            { v: 'failed', l: 'Failed' },
          ].map(f => (
            <FilterChip key={f.v} label={f.l} active={dataRequestsStatusFilter === f.v} onClick={() => { setDataRequestsStatusFilter(f.v); setDataRequestsPage(1); }} />
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2"><Download size={13} /> {dataRequestsTotal.toLocaleString()} request{dataRequestsTotal !== 1 ? 's' : ''}</span>
      </div>

      {error && (
        <div className="flex flex-col items-center justify-center py-16 text-sm">
          <AlertCircle size={24} className="text-red-400 mb-3" />
          <p className="text-red-300 mb-4">{error}</p>
          <button onClick={() => loadDataRequests(dataRequestsPage, dataRequestsStatusFilter)} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-medium hover:bg-cyan-500/25">
            Retry
          </button>
        </div>
      )}

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">User</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Requested</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Expires</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Actions</th>
          </tr></thead>
          <tbody>
            {dataRequests.map((r) => {
              const statusStyles: Record<string, string> = {
                pending: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
                processing: 'bg-blue-500/15 text-blue-300 border-blue-500/25',
                ready: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
                expired: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
                failed: 'bg-red-500/15 text-red-300 border-red-500/25',
              };
              return (
                <tr key={r.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-all duration-150">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <AdminAvatar src={r.user.avatar} name={r.user.username} size={32} />
                      <div>
                        <span className="text-white font-medium text-[13px]">{r.user.username}<span className="text-slate-500">#{r.user.discriminator}</span></span>
                        <div className="text-[11px] text-slate-500">{r.user.email}</div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${statusStyles[r.status] || 'bg-white/5 text-slate-300 border-white/10'}`}>
                      {r.status}
                    </span>
                    {r.error && <div className="text-[10px] text-red-400 mt-1 max-w-[200px] truncate" title={r.error}>{r.error}</div>}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="text-slate-300 text-xs">{formatRelative(r.createdAt)}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{new Date(r.createdAt).toLocaleString()}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    {r.expiresAt ? (
                      <div>
                        <div className="text-slate-300 text-xs">{formatRelative(r.expiresAt)}</div>
                        <div className="text-[10px] text-slate-500 mt-0.5">{new Date(r.expiresAt).toLocaleString()}</div>
                      </div>
                    ) : (
                      <span className="text-slate-600 text-xs">&mdash;</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1">
                      {(r.status === 'pending' || r.status === 'failed' || r.status === 'expired') && (
                        <button
                          onClick={() => setConfirmModal({
                            title: 'Approve Export',
                            message: `Manually approve and process the data export for ${r.user.username}? This will bypass the cooldown and queue the export immediately.`,
                            confirmLabel: 'Approve & Process',
                            onConfirm: async () => {
                              try {
                                await adminApi.approveDataRequest(r.id);
                                setActionResult({ type: 'success', message: `Export approved for ${r.user.username}` });
                                loadDataRequests(dataRequestsPage, dataRequestsStatusFilter);
                              } catch {
                                setActionResult({ type: 'error', message: 'Failed to approve export request' });
                              }
                            },
                          })}
                          className="p-2 rounded-lg text-slate-400 hover:text-emerald-300 hover:bg-emerald-500/10 transition-all duration-200"
                          title="Approve & process export"
                        >
                          <PlayCircle size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => setConfirmModal({
                          title: 'Delete Export Request',
                          message: `Delete data export request for ${r.user.username}? This will also remove the export file if it exists.`,
                          confirmLabel: 'Delete',
                          danger: true,
                          onConfirm: async () => {
                            try {
                              await adminApi.deleteDataRequest(r.id);
                              setActionResult({ type: 'success', message: 'Export request deleted' });
                              loadDataRequests(dataRequestsPage, dataRequestsStatusFilter);
                            } catch {
                              setActionResult({ type: 'error', message: 'Failed to delete export request' });
                            }
                          },
                        })}
                        className="p-2 rounded-lg text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200"
                        title="Delete request"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {dataRequests.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-16 text-center text-slate-500"><Download size={20} className="mx-auto mb-2 opacity-40" />No data export requests</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={dataRequestsPage} pages={dataRequestsPages} total={dataRequestsTotal} onPageChange={setDataRequestsPage} label="requests" />

      {actionResult && (
        <div className={`mt-5 px-5 py-3.5 rounded-xl border text-sm flex items-center gap-2.5 ${actionResult.type === 'success' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300' : 'bg-red-500/10 border-red-500/25 text-red-300'}`}>
          {actionResult.type === 'success' ? <Check size={16} /> : <AlertTriangle size={16} />} {actionResult.message}
          <button onClick={() => setActionResult(null)} className="ml-auto opacity-60 hover:opacity-100 transition-opacity"><X size={14} /></button>
        </div>
      )}

      <ConfirmModal
        open={!!confirmModal}
        onClose={() => setConfirmModal(null)}
        onConfirm={() => { if (confirmModal) confirmModal.onConfirm(); }}
        title={confirmModal?.title || ''}
        message={confirmModal?.message || ''}
        confirmText={confirmModal?.confirmLabel}
        danger={confirmModal?.danger}
      />
    </div>
  );
};

export default DataRequestsPage;
