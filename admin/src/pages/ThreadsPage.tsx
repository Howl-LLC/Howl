// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, MessageSquare, RefreshCw, Archive, Trash2, Check, AlertTriangle, X } from 'lucide-react';
import { adminApi, type AdminThread } from '../api';
import { SEARCH_INPUT_CLS, BTN_PRIMARY, BTN_GHOST, CARD, TABLE_HEAD } from '../components/styles';
import { PageHeader, Pagination, ConfirmModal, FilterChips, AdminAvatar } from '../components';
import { formatRelative } from '../utils';

interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void;
  danger?: boolean;
}

const ARCHIVED_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'false', label: 'Active' },
  { value: 'true', label: 'Archived' },
];

const ThreadsPage: React.FC = () => {
  const navigate = useNavigate();

  const [threads, setThreads] = useState<AdminThread[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [archivedFilter, setArchivedFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmState | null>(null);

  const load = useCallback(async (q: string, p: number, archived: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getThreads(q || undefined, p, undefined, archived || undefined);
      setThreads(data.threads);
      setTotal(data.total);
      setPage(data.page);
      setPages(data.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load threads');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(searchQuery, page, archivedFilter); }, [searchQuery, page, archivedFilter, load]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(searchInput); setPage(1); };

  const handleArchive = (thread: AdminThread) => {
    setConfirmModal({
      title: 'Archive Thread',
      message: `Are you sure you want to archive "${thread.name}"?\n\nThe thread will be moved to the archived state and no new messages can be posted.`,
      confirmLabel: 'Archive',
      onConfirm: async () => {
        try {
          await adminApi.archiveThread(thread.id);
          setActionResult({ type: 'success', message: `Thread "${thread.name}" archived` });
          load(searchQuery, page, archivedFilter);
        } catch {
          setActionResult({ type: 'error', message: 'Failed to archive thread' });
        }
      },
    });
  };

  const handleDelete = (thread: AdminThread) => {
    setConfirmModal({
      title: 'Delete Thread',
      message: `Are you sure you want to delete "${thread.name}"?\n\nThis will remove the thread and all its messages. This action cannot be undone.`,
      confirmLabel: 'Delete Thread',
      danger: true,
      onConfirm: async () => {
        try {
          await adminApi.deleteThread(thread.id);
          setActionResult({ type: 'success', message: `Thread "${thread.name}" deleted` });
          load(searchQuery, page, archivedFilter);
        } catch {
          setActionResult({ type: 'error', message: 'Failed to delete thread' });
        }
      },
    });
  };

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader title="Threads" subtitle="Thread moderation">
        <button onClick={() => load(searchQuery, page, archivedFilter)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </PageHeader>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
          <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search by thread name..."
            className={SEARCH_INPUT_CLS} />
        </div>
        <button type="submit" className={BTN_PRIMARY}>Search</button>
      </form>

      <div className="flex items-center gap-4 mb-4">
        <FilterChips
          options={ARCHIVED_FILTER_OPTIONS}
          value={archivedFilter}
          onChange={(v) => { setArchivedFilter(v); setPage(1); }}
        />
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2"><MessageSquare size={13} /> {total.toLocaleString()} thread{total !== 1 ? 's' : ''}</span>
      </div>

      {error ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button onClick={() => load(searchQuery, page, archivedFilter)} className={BTN_PRIMARY}>Retry</button>
        </div>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead><tr className={TABLE_HEAD}>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Name</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Server</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Channel</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Author</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Messages</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Created</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Actions</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-5 py-16 text-center text-slate-500"><RefreshCw size={16} className="animate-spin inline mr-2" />Loading...</td></tr>
              ) : threads.length === 0 ? (
                <tr><td colSpan={8} className="px-5 py-16 text-center text-slate-500"><MessageSquare size={20} className="mx-auto mb-2 opacity-40" />No threads found</td></tr>
              ) : threads.map((thread) => (
                <tr key={thread.id} className="border-t border-white/[0.04] hover:bg-white/[0.03] transition-all duration-150">
                  <td className="px-5 py-3.5">
                    <span className="text-white font-medium text-[13px]">{thread.name}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => navigate(`/servers/${thread.server.id}`)}
                      className="text-white text-[13px] font-medium hover:text-cyan-300 transition-colors"
                    >
                      {thread.server.name}
                    </button>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-slate-300 text-[13px]">#{thread.channel.name}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    {thread.author ? (
                      <button
                        onClick={() => navigate(`/users/${thread.author!.id}`)}
                        className="flex items-center gap-2.5 group/user"
                      >
                        <AdminAvatar src={thread.author.avatar} name={thread.author.username} size={28} />
                        <span className="text-white text-[13px] font-medium group-hover/user:text-cyan-300 transition-colors">
                          {thread.author.username}<span className="text-slate-500">#{thread.author.discriminator}</span>
                        </span>
                      </button>
                    ) : (
                      <span className="text-slate-600 text-xs">Deleted user</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-slate-300 font-medium">{thread.messageCount}</span>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-500">{formatRelative(thread.createdAt)}</td>
                  <td className="px-5 py-3.5">
                    {thread.archived ? (
                      <span className="inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border bg-slate-500/15 text-slate-400 border-slate-500/25">Archived</span>
                    ) : (
                      <span className="inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border bg-emerald-500/15 text-emerald-300 border-emerald-500/25">Active</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-1">
                      {!thread.archived && (
                        <button
                          onClick={() => handleArchive(thread)}
                          className="p-2 rounded-lg text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 transition-all duration-200"
                          title="Archive thread"
                        >
                          <Archive size={14} />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(thread)}
                        className="p-2 rounded-lg text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200"
                        title="Delete thread"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pages={pages} total={total} onPageChange={setPage} label="threads" />

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

export default ThreadsPage;
