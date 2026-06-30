// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, Plus, ShieldAlert, AlertTriangle, Trash2,
  Check, X, Search,
} from 'lucide-react';
import { adminApi } from '../api';
import { INPUT_CLS, BTN_PRIMARY, BTN_GHOST, CARD, TABLE_HEAD, SELECT_CLS } from '../components/styles';
import { Pagination, ConfirmModal, AdminAvatar } from '../components';
import { formatRelative } from '../utils';

interface ConfirmModalState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}

const ContentSafetyPage: React.FC = () => {
  const [flaggedHashes, setFlaggedHashes] = useState<any[]>([]);
  const [flaggedHashesPage, setFlaggedHashesPage] = useState(1);
  const [flaggedHashesPages, setFlaggedHashesPages] = useState(1);
  const [flaggedHashesTotal, setFlaggedHashesTotal] = useState(0);
  const [flaggedHashesReason, setFlaggedHashesReason] = useState('');
  const [hashMatches, setHashMatches] = useState<any[]>([]);
  const [hashMatchesPage, setHashMatchesPage] = useState(1);
  const [hashMatchesPages, setHashMatchesPages] = useState(1);
  const [hashMatchesTotal, setHashMatchesTotal] = useState(0);
  const [showAddHash, setShowAddHash] = useState(false);
  const [newHashValue, setNewHashValue] = useState('');
  const [newHashReason, setNewHashReason] = useState('csam');
  const [newHashNotes, setNewHashNotes] = useState('');
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmModalState | null>(null);

  const loadFlaggedHashes = useCallback(async (page: number, reason?: string) => {
    try {
      const data: any = await adminApi.getFlaggedHashes(page, reason || undefined);
      setFlaggedHashes(data.hashes || []);
      setFlaggedHashesTotal(data.total || 0);
      setFlaggedHashesPage(data.page || 1);
      setFlaggedHashesPages(data.pages || 1);
    } catch { /* ignore */ }
  }, []);

  const loadHashMatches = useCallback(async (page: number) => {
    try {
      const data: any = await adminApi.getImageHashes(page, true);
      setHashMatches(data.hashes || []);
      setHashMatchesTotal(data.total || 0);
      setHashMatchesPage(data.page || 1);
      setHashMatchesPages(data.pages || 1);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { loadFlaggedHashes(flaggedHashesPage, flaggedHashesReason); loadHashMatches(hashMatchesPage); }, [flaggedHashesPage, flaggedHashesReason, loadFlaggedHashes, hashMatchesPage, loadHashMatches]);

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Content Safety</h2>
          <p className="text-sm text-slate-500 mt-1">Flagged hash management and match monitoring</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setShowAddHash(!showAddHash)} className={BTN_PRIMARY}>
            <span className="flex items-center gap-1.5"><Plus size={14} /> Add Flagged Hash</span>
          </button>
          <button
            onClick={() => setConfirmModal({
              title: 'Run Retroactive Sweep',
              message: 'Compare every recorded ImageHash against the current flagged-hash list. New matches will appear as pending CSAM reports and in Recent Hash Matches once complete.\n\nSafe to re-run; previously matched files are skipped.',
              confirmLabel: 'Start Sweep',
              onConfirm: async () => {
                try {
                  const result = await adminApi.runHashSweep();
                  setActionResult({ type: 'success', message: result.message || 'Sweep started' });
                } catch (err: any) {
                  setActionResult({ type: 'error', message: err.message || 'Failed to start sweep' });
                }
              },
            })}
            className={BTN_GHOST}
            title="Run retroactive sweep against current flagged hashes"
          >
            <span className="flex items-center gap-1.5"><Search size={14} /> Run Sweep</span>
          </button>
          <button onClick={() => { loadFlaggedHashes(flaggedHashesPage, flaggedHashesReason); loadHashMatches(hashMatchesPage); }} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
        </div>
      </div>

      {showAddHash && (
        <div className={`${CARD} p-5 mb-6`}>
          <div className="text-sm font-semibold text-white mb-4 flex items-center gap-2"><ShieldAlert size={15} className="text-red-400" /> Add Flagged Hash</div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Hash (64 hex characters)</label>
              <input value={newHashValue} onChange={(e) => setNewHashValue(e.target.value)} className={INPUT_CLS} placeholder="Enter 64-character hex hash..." maxLength={64} />
            </div>
            <div>
              <label className="text-xs text-slate-400 block mb-1.5">Reason</label>
              <select value={newHashReason} onChange={(e) => setNewHashReason(e.target.value)} className={SELECT_CLS + ' w-full'}>
                <option value="csam">CSAM</option>
                <option value="illegal">Illegal Content</option>
                <option value="other">Other</option>
              </select>
            </div>
          </div>
          <div className="mb-4">
            <label className="text-xs text-slate-400 block mb-1.5">Notes (optional)</label>
            <textarea value={newHashNotes} onChange={(e) => setNewHashNotes(e.target.value)} rows={2} className={INPUT_CLS + ' resize-none'} placeholder="Internal notes about this hash..." />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowAddHash(false); setNewHashValue(''); setNewHashReason('csam'); setNewHashNotes(''); }} className="px-4 py-2 rounded-xl bg-white/5 text-slate-300 text-sm font-medium hover:bg-white/10 transition-all duration-200">Cancel</button>
            <button
              disabled={newHashValue.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(newHashValue)}
              onClick={async () => {
                try {
                  await adminApi.addFlaggedHash(newHashValue, newHashReason, newHashNotes || undefined);
                  setActionResult({ type: 'success', message: 'Flagged hash added successfully' });
                  setShowAddHash(false);
                  setNewHashValue('');
                  setNewHashReason('csam');
                  setNewHashNotes('');
                  loadFlaggedHashes(flaggedHashesPage, flaggedHashesReason);
                } catch (err: any) {
                  setActionResult({ type: 'error', message: err.message || 'Failed to add flagged hash' });
                }
              }}
              className={BTN_PRIMARY}
            >Add Hash</button>
          </div>
        </div>
      )}

      <div className="flex gap-2 mb-5 items-center">
        <div className="flex gap-1">
          {[
            { v: '', l: 'All' },
            { v: 'csam', l: 'CSAM' },
            { v: 'illegal', l: 'Illegal' },
            { v: 'other', l: 'Other' },
          ].map(f => (
            <FilterChip key={f.v} label={f.l} active={flaggedHashesReason === f.v} onClick={() => { setFlaggedHashesReason(f.v); setFlaggedHashesPage(1); }} />
          ))}
        </div>
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2"><ShieldAlert size={13} /> {flaggedHashesTotal.toLocaleString()} flagged hash{flaggedHashesTotal !== 1 ? 'es' : ''}</span>
      </div>

      <div className={`${CARD} overflow-x-auto mb-8`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Hash</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Reason</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Source</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Added</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Actions</th>
          </tr></thead>
          <tbody>
            {flaggedHashes.map((h: any) => {
              const reasonStyles: Record<string, string> = {
                csam: 'bg-red-500/15 text-red-300 border-red-500/25',
                illegal: 'bg-orange-500/15 text-orange-300 border-orange-500/25',
                other: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
              };
              return (
                <tr key={h.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-all duration-150">
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-xs text-slate-300" title={h.hash}>{h.hash?.slice(0, 16)}...{h.hash?.slice(-8)}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${reasonStyles[h.reason] || 'bg-white/5 text-slate-300 border-white/10'}`}>
                      {h.reason}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-slate-400 text-xs">{h.source || 'manual'}</td>
                  <td className="px-5 py-3.5">
                    <div className="text-slate-300 text-xs">{formatRelative(h.createdAt)}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{new Date(h.createdAt).toLocaleString()}</div>
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => setConfirmModal({
                        title: 'Remove Flagged Hash',
                        message: `Remove this flagged hash?\n\n${h.hash?.slice(0, 24)}...`,
                        confirmLabel: 'Remove',
                        danger: true,
                        onConfirm: async () => {
                          try {
                            await adminApi.removeFlaggedHash(h.id);
                            setActionResult({ type: 'success', message: 'Flagged hash removed' });
                            loadFlaggedHashes(flaggedHashesPage, flaggedHashesReason);
                          } catch (err: any) {
                            setActionResult({ type: 'error', message: err.message || 'Failed to remove hash' });
                          }
                        },
                      })}
                      className="p-2 rounded-lg text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200"
                      title="Remove flagged hash"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              );
            })}
            {flaggedHashes.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-16 text-center text-slate-500"><ShieldAlert size={20} className="mx-auto mb-2 opacity-40" />No flagged hashes found</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={flaggedHashesPage} pages={flaggedHashesPages} total={flaggedHashesTotal} onPageChange={setFlaggedHashesPage} label="flagged hashes" />

      <div className="mt-10 mb-6">
        <h3 className="text-lg font-bold text-white tracking-tight flex items-center gap-2"><AlertTriangle size={17} className="text-amber-400" /> Recent Hash Matches</h3>
        <p className="text-sm text-slate-500 mt-1">Uploaded images that matched a flagged hash</p>
      </div>

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Hash</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Uploader</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Source</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Filename</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Date</th>
          </tr></thead>
          <tbody>
            {hashMatches.map((m: any) => (
              <tr key={m.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] bg-red-500/[0.02] transition-all duration-150">
                <td className="px-5 py-3.5">
                  <span className="font-mono text-xs text-slate-300" title={m.hash}>{m.hash?.slice(0, 16)}...{m.hash?.slice(-8)}</span>
                </td>
                <td className="px-5 py-3.5">
                  {m.uploader ? (
                    <div className="flex items-center gap-2">
                      <AdminAvatar src={m.uploader.avatar} name={m.uploader.username || m.uploaderId} size={28} />
                      <span className="text-white text-[13px] font-medium">{m.uploader.username}<span className="text-slate-500">#{m.uploader.discriminator}</span></span>
                    </div>
                  ) : <span className="text-slate-500 text-xs font-mono">{m.uploaderId?.slice(0, 12)}...</span>}
                </td>
                <td className="px-5 py-3.5 text-slate-400 text-xs">{m.source || '\u2014'}</td>
                <td className="px-5 py-3.5 text-slate-400 text-xs font-mono">{m.fileName || '\u2014'}</td>
                <td className="px-5 py-3.5">
                  <div className="text-slate-300 text-xs">{formatRelative(m.createdAt)}</div>
                  <div className="text-[10px] text-slate-500 mt-0.5">{new Date(m.createdAt).toLocaleString()}</div>
                </td>
              </tr>
            ))}
            {hashMatches.length === 0 && (
              <tr><td colSpan={5} className="px-5 py-16 text-center text-slate-500"><AlertTriangle size={20} className="mx-auto mb-2 opacity-40" />No flagged hash matches found</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <Pagination page={hashMatchesPage} pages={hashMatchesPages} total={hashMatchesTotal} onPageChange={setHashMatchesPage} label="matches" />

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

export default ContentSafetyPage;
