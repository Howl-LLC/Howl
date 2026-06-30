// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search, Link, RefreshCw } from 'lucide-react';
import { adminApi, type AdminInvite } from '../api';
import { SEARCH_INPUT_CLS, BTN_PRIMARY, BTN_GHOST, CARD, TABLE_HEAD } from '../components/styles';
import { PageHeader, Pagination, AdminAvatar } from '../components';
import { formatRelative } from '../utils';

const InvitesPage: React.FC = () => {
  const navigate = useNavigate();

  const [invites, setInvites] = useState<AdminInvite[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (q: string, p: number) => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminApi.getInvites(q || undefined, p);
      setInvites(data.invites);
      setTotal(data.total);
      setPage(data.page);
      setPages(data.pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load invites');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(searchQuery, page); }, [searchQuery, page, load]);

  const handleSearch = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(searchInput); setPage(1); };

  const formatExpiry = (invite: AdminInvite) => {
    if (!invite.expiresAt) return 'Never';
    const expiry = new Date(invite.expiresAt);
    if (expiry.getTime() < Date.now()) return 'Expired';
    return formatRelative(invite.expiresAt);
  };

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <PageHeader title="Invites" subtitle="Global invite oversight">
        <button onClick={() => load(searchQuery, page)} className={BTN_GHOST} title="Refresh"><RefreshCw size={16} /></button>
      </PageHeader>

      <form onSubmit={handleSearch} className="flex gap-2 mb-4">
        <div className="relative flex-1">
          <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
          <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search by invite code or server name..."
            className={SEARCH_INPUT_CLS} />
        </div>
        <button type="submit" className={BTN_PRIMARY}>Search</button>
      </form>

      <div className="text-xs text-slate-500 mb-3 flex items-center gap-2">
        <Link size={13} /> {total.toLocaleString()} invite{total !== 1 ? 's' : ''}
      </div>

      {error ? (
        <div className={`${CARD} p-12 flex flex-col items-center justify-center text-center`}>
          <p className="text-sm text-red-400 mb-4">{error}</p>
          <button onClick={() => load(searchQuery, page)} className={BTN_PRIMARY}>Retry</button>
        </div>
      ) : (
        <div className={`${CARD} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead><tr className={TABLE_HEAD}>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Code</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Server</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Creator</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Uses / Max</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Expires</th>
              <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Created</th>
            </tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><RefreshCw size={16} className="animate-spin inline mr-2" />Loading...</td></tr>
              ) : invites.length === 0 ? (
                <tr><td colSpan={6} className="px-5 py-16 text-center text-slate-500"><Link size={20} className="mx-auto mb-2 opacity-40" />No invites found</td></tr>
              ) : invites.map((inv) => (
                <tr key={inv.id} className="border-t border-white/[0.04] hover:bg-white/[0.03] transition-all duration-150">
                  <td className="px-5 py-3.5">
                    <span className="font-mono text-cyan-300 text-[13px]">{inv.code}</span>
                  </td>
                  <td className="px-5 py-3.5">
                    <button
                      onClick={() => navigate(`/servers/${inv.server.id}`)}
                      className="flex items-center gap-2.5 group/server"
                    >
                      <AdminAvatar src={inv.server.icon} name={inv.server.name} size={28} fallback={
                        <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500/20 to-violet-500/20 border border-indigo-500/20 flex items-center justify-center text-indigo-300 text-[10px] font-bold">{inv.server.name.charAt(0).toUpperCase()}</div>
                      } />
                      <span className="text-white text-[13px] font-medium group-hover/server:text-cyan-300 transition-colors">{inv.server.name}</span>
                    </button>
                  </td>
                  <td className="px-5 py-3.5">
                    {inv.inviter ? (
                      <button
                        onClick={() => navigate(`/users/${inv.inviter!.id}`)}
                        className="flex items-center gap-2.5 group/user"
                      >
                        <AdminAvatar src={inv.inviter.avatar} name={inv.inviter.username} size={28} />
                        <span className="text-white text-[13px] font-medium group-hover/user:text-cyan-300 transition-colors">
                          {inv.inviter.username}<span className="text-slate-500">#{inv.inviter.discriminator}</span>
                        </span>
                      </button>
                    ) : (
                      <span className="text-slate-600 text-xs">Unknown</span>
                    )}
                  </td>
                  <td className="px-5 py-3.5">
                    <span className="text-slate-300 text-[13px]">
                      {inv.useCount} / {inv.maxUses != null ? inv.maxUses : '\u221E'}
                    </span>
                  </td>
                  <td className="px-5 py-3.5">
                    <span className={`text-xs ${formatExpiry(inv) === 'Expired' ? 'text-red-400' : formatExpiry(inv) === 'Never' ? 'text-slate-500' : 'text-slate-300'}`}>
                      {formatExpiry(inv)}
                    </span>
                  </td>
                  <td className="px-5 py-3.5 text-xs text-slate-500">{formatRelative(inv.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination page={page} pages={pages} total={total} onPageChange={setPage} label="invites" />
    </div>
  );
};

export default InvitesPage;
