// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, BarChart, RefreshCw, XCircle, Trash2, Check, AlertTriangle, X } from 'lucide-react';
import { adminApi, type AdminPoll } from '../api';
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

const STATUS_FILTER_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'closed', label: 'Closed' },
];

const PollsPage: React.FC = () => {
  const navigate = useNavigate();

  const [polls, setPolls] = useState<AdminPoll[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [confirmModal, setConfirmModal] = useState<ConfirmState | null>(null);

  const load = useCallback(async (q: string, p: number, status: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getPolls(q || undefined, p, status || undefined);
      setPolls(data.polls);
      setTotal(data.total);
      setPage(data.page);
      setPages(data.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load polls');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(searchQuery, page, statusFilter); }, [searchQuery, page, statusFilter, load]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(searchInput); setPage(1); };

  const getPollStatus = (poll: AdminPoll): 'active' | 'closed' | 'expired' => {
    if (poll.closedAt) return 'closed';
    if (poll.expiresAt && new Date(poll.expiresAt).getTime() < Date.now()) return 'expired';
    return 'active';
  };

  const handleClose = (poll: AdminPoll) => {
    setConfirmModal({
      title: 'Close Poll',
      message: `Are you sure you want to close this poll?\n\n"${poll.question.slice(0, 80)}"\n\nNo more votes will be accepted after closing.`,
      confirmLabel: 'Close Poll',
      onConfirm: async () => {
        try {
          await adminApi.closePoll(poll.id);
          setActionResult({ type: 'success', message: 'Poll closed successfully' });
          load(searchQuery, page, statusFilter);
        } catch {
          setActionResult({ type: 'error', message: 'Failed to close poll' });
        }
      },
    });
  };

  const handleDelete = (poll: AdminPoll) => {
    setConfirmModal({
      title: 'Delete Poll',
      message: `Are you sure you want to delete this poll?\n\n"${poll.question.slice(0, 80)}"\n\nThis will remove the poll and all votes. This action cannot be undone.`,
      confirmLabel: 'Delete Poll',
      danger: true,
      onConfirm: async () => {
        try {
          await adminApi.deletePoll(poll.id);
          setActionResult({ type: 'success', message: 'Poll deleted successfully' });
          load(searchQuery, page, statusFilter);
        } catch {
          setActionResult({ type: 'error', message: 'Failed to delete poll' });
        }
      },
    });
  };

  const truncate = (s: string, max: number) => s.length > max ? s.slice(0, max) + '...' : s;

  const statusBadge = (poll: AdminPoll) => {
    const status = getPollStatus(poll);
    const styles: Record<string, string> = {
      active: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/25',
      closed: 'bg-slate-500/15 text-slate-400 border-slate-500/25',
      expired: 'bg-amber-500/15 text-amber-300 border-amber-500/25',
    };
    const labels: Record<string, string> = { active: 'Active', closed: 'Closed', expired: 'Expired' };
    return (
      <span className={`inline-block px-2.5 py-1 text-[11px] font-semibold rounded-lg border capitalize ${styles[status]}`}>
        {labels[status]}
      </span>
    );
  };

  const locationLabel = (poll: AdminPoll) => {
    if (poll.location.type === 'server' && poll.location.serverName) {
      return poll.location.serverId ? (
        <button
          onClick={() => navigate(`/servers/${poll.location.serverId}`)}
          className="text-white text-[13px] font-medium hover:text-cyan-300 transition-colors"
        >
          {poll.location.serverName}
        </button>
      ) : (
        <span className="text-slate-300 text-[13px]">{poll.location.serverName}</span>
      );
    }
    if (poll.location.type === 'dm') {
      return <span className="text-slate-400 text-[13px]">DM</span>;
    }
    return <span className="text-slate-600 text-xs">Unknown</span>;
  };

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader title="Polls" subtitle="Poll management">
        <button onClick={() => load(searchQuery, page, statusFilter)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </PageHeader>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
          <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search by poll question..."
            className={SEARCH_INPUT_CLS} />
        </div>
        <button type="submit" className={BTN_PRIMARY}>Search</button>
      </form>

      <div className="flex items-center gap-4 mb-4">
        <FilterChips
          options={STATUS_FILTER_OPTIONS}
          value={statusFilter}
          onChange={(v) => { setStatusFilter(v); setPage(1); }}
        />
        <div className="flex-1" />
        <span className="text-xs text-slate-500 flex items-center gap-2"><BarChart size={13} /> {total.toLocaleString()} poll{total !== 1 ? 's' : ''}</span>
      </div>

      {error ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button onClick={() => load(searchQuery, page, statusFilter)} className={BTN_PRIMARY}>Retry</button>
        </div>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead><tr className={TABLE_HEAD}>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Question</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Location</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Creator</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Votes</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Options</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Created</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Actions</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={8} className="px-5 py-16 text-center text-slate-500"><RefreshCw size={16} className="animate-spin inline mr-2" />Loading...</td></tr>
              ) : polls.length === 0 ? (
                <tr><td colSpan={8} className="px-5 py-16 text-center text-slate-500"><BarChart size={20} className="mx-auto mb-2 opacity-40" />No polls found</td></tr>
              ) : polls.map((poll) => {
                const status = getPollStatus(poll);
                return (
                  <tr key={poll.id} className="border-t border-white/[0.04] hover:bg-white/[0.03] transition-all duration-150">
                    <td className="px-5 py-3.5">
                      <span className="text-white font-medium text-[13px]" title={poll.question}>{truncate(poll.question, 60)}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      {locationLabel(poll)}
                    </td>
                    <td className="px-5 py-3.5">
                      {poll.author ? (
                        <button
                          onClick={() => navigate(`/users/${poll.author!.id}`)}
                          className="flex items-center gap-2.5 group/user"
                        >
                          <AdminAvatar src={poll.author.avatar} name={poll.author.username} size={28} />
                          <span className="text-white text-[13px] font-medium group-hover/user:text-cyan-300 transition-colors">
                            {poll.author.username}<span className="text-slate-500">#{poll.author.discriminator}</span>
                          </span>
                        </button>
                      ) : (
                        <span className="text-slate-600 text-xs">Deleted user</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-slate-300 font-medium">{poll.voteCount}</span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="text-slate-300 font-medium">{poll.optionCount}</span>
                    </td>
                    <td className="px-5 py-3.5 text-xs text-slate-500">{formatRelative(poll.createdAt)}</td>
                    <td className="px-5 py-3.5">
                      {statusBadge(poll)}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1">
                        {status === 'active' && (
                          <button
                            onClick={() => handleClose(poll)}
                            className="p-2 rounded-lg text-slate-400 hover:text-amber-300 hover:bg-amber-500/10 transition-all duration-200"
                            title="Close poll"
                          >
                            <XCircle size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => handleDelete(poll)}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-300 hover:bg-red-500/10 transition-all duration-200"
                          title="Delete poll"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pages={pages} total={total} onPageChange={setPage} label="polls" />

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

export default PollsPage;
