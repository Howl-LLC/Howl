// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Search, Filter, UserCheck, AlertCircle,
} from 'lucide-react';
import { adminApi, type AdminUserSummary, type UserFilters } from '../api';
import { INPUT_CLS, SEARCH_INPUT_CLS, BTN_PRIMARY, CARD, TABLE_HEAD } from '../components/styles';
import { Pagination, AdminAvatar } from '../components';
import { planBadge, statusDot, formatRelative } from '../utils';

const UsersPage: React.FC = () => {
  const navigate = useNavigate();

  const [users, setUsers] = useState<AdminUserSummary[]>([]);
  const [userTotal, setUserTotal] = useState(0);
  const [userPage, setUserPage] = useState(1);
  const [userPages, setUserPages] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [userFilters, setUserFilters] = useState<UserFilters>({});
  const [showUserFilters, setShowUserFilters] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeFiltersCount = Object.values(userFilters).filter(Boolean).length;

  const loadUsers = useCallback(async (q: string, page: number, filters: UserFilters) => {
    setError(null);
    try {
      const data = await adminApi.searchUsers(q, page, filters);
      setUsers(data.users);
      setUserTotal(data.total);
      setUserPage(data.page);
      setUserPages(data.pages);
    } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load data'); }
  }, []);

  useEffect(() => { loadUsers(searchQuery, userPage, userFilters); }, [searchQuery, userPage, userFilters, loadUsers]);

  const handleUserSearch = (e: React.FormEvent) => { e.preventDefault(); setSearchQuery(searchInput); setUserPage(1); };

  const FilterChip: React.FC<{ label: string; active: boolean; onClick: () => void }> = ({ label, active, onClick }) => (
    <button onClick={onClick} className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all duration-200 border ${active ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' : 'text-slate-400 border-white/[0.06] hover:bg-white/5 hover:text-white'}`}>{label}</button>
  );

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">User Management</h2>
          <p className="text-sm text-slate-500 mt-1">Search, filter, and manage platform users</p>
        </div>
      </div>

      <div className="flex flex-col gap-3 mb-5">
        <form onSubmit={handleUserSearch} className="flex gap-2">
          <div className="relative flex-1">
            <Search size={16} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-500" />
            <input type="text" value={searchInput} onChange={(e) => setSearchInput(e.target.value)} placeholder="Search by username, email, ID, or discriminator..."
              className={SEARCH_INPUT_CLS} />
          </div>
          <button type="submit" className={BTN_PRIMARY}>Search</button>
          <button type="button" onClick={() => setShowUserFilters(!showUserFilters)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl border text-sm font-medium transition-all duration-200 ${showUserFilters || activeFiltersCount > 0 ? 'bg-cyan-500/15 text-cyan-300 border-cyan-500/25' : 'bg-white/[0.04] text-slate-400 border-white/[0.08] hover:text-white hover:bg-white/[0.06]'}`}>
            <Filter size={14} />
            Filters
            {activeFiltersCount > 0 && <span className="ml-1 w-5 h-5 rounded-full bg-cyan-500/30 text-cyan-200 text-[10px] font-bold flex items-center justify-center">{activeFiltersCount}</span>}
          </button>
        </form>

        {showUserFilters && (
          <div className={`${CARD} p-4 flex flex-wrap items-center gap-3`}>
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Plan</span>
              <div className="flex gap-1">
                {[{ v: '', l: 'All' }, { v: 'free', l: 'Free' }, { v: 'essential', l: 'Essential' }, { v: 'pro', l: 'Pro' }].map(r => (
                  <FilterChip key={r.v} label={r.l} active={(userFilters.plan || '') === r.v} onClick={() => { setUserFilters(p => ({ ...p, plan: r.v || undefined })); setUserPage(1); }} />
                ))}
              </div>
            </div>
            <div className="h-5 w-px bg-white/[0.08]" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Status</span>
              <div className="flex gap-1">
                {[{ v: '', l: 'All' }, { v: 'online', l: 'Online' }, { v: 'offline', l: 'Offline' }].map(r => (
                  <FilterChip key={r.v} label={r.l} active={(userFilters.status || '') === r.v} onClick={() => { setUserFilters(p => ({ ...p, status: r.v || undefined })); setUserPage(1); }} />
                ))}
              </div>
            </div>
            <div className="h-5 w-px bg-white/[0.08]" />
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-500 font-medium uppercase tracking-wider">Verified</span>
              <div className="flex gap-1">
                {[{ v: '', l: 'All' }, { v: 'true', l: 'Yes' }, { v: 'false', l: 'No' }].map(r => (
                  <FilterChip key={r.v} label={r.l} active={(userFilters.verified || '') === r.v} onClick={() => { setUserFilters(p => ({ ...p, verified: r.v || undefined })); setUserPage(1); }} />
                ))}
              </div>
            </div>
            {activeFiltersCount > 0 && (
              <>
                <div className="h-5 w-px bg-white/[0.08]" />
                <button onClick={() => { setUserFilters({}); setUserPage(1); }} className="text-xs text-red-400 hover:text-red-300 font-medium transition-colors">Clear all</button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="text-xs text-slate-500 mb-3 flex items-center gap-2">
        <UserCheck size={13} /> {userTotal.toLocaleString()} user{userTotal !== 1 ? 's' : ''} found
      </div>

      {error && (
        <div className="flex flex-col items-center justify-center py-16 text-sm">
          <AlertCircle size={24} className="text-red-400 mb-3" />
          <p className="text-red-300 mb-4">{error}</p>
          <button onClick={() => loadUsers(searchQuery, userPage, userFilters)} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-medium hover:bg-cyan-500/25">
            Retry
          </button>
        </div>
      )}

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-sm">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">User</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Email</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Plan</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Status</th>
            <th className="px-5 py-3.5 text-slate-400 font-semibold text-xs uppercase tracking-wider">Joined</th>
          </tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} onClick={() => navigate(`/users/${u.id}`)} className="border-t border-white/[0.04] hover:bg-white/[0.03] cursor-pointer transition-all duration-150 group">
                <td className="px-5 py-3.5">
                  <div className="flex items-center gap-3">
                    <AdminAvatar src={u.avatar} name={u.username} size={36} />
                    <div>
                      <span className="text-white font-medium group-hover:text-cyan-300 transition-colors">{u.username}</span>
                      <span className="text-slate-500">#{u.discriminator}</span>
                    </div>
                  </div>
                </td>
                <td className="px-5 py-3.5 text-slate-400 text-[13px]">{u.email}</td>
                <td className="px-5 py-3.5">{planBadge(u.stripePlan)}</td>
                <td className="px-5 py-3.5"><div className="flex items-center gap-2">{statusDot(u.status)}<span className="text-slate-400 text-xs capitalize">{u.status}</span></div></td>
                <td className="px-5 py-3.5 text-slate-500 text-xs">{formatRelative(u.createdAt)}</td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={5} className="px-5 py-16 text-center text-slate-500"><Search size={20} className="mx-auto mb-2 opacity-40" />No users found</td></tr>}
          </tbody>
        </table>
      </div>
      <Pagination page={userPage} pages={userPages} total={userTotal} onPageChange={setUserPage} label="users" />
    </div>
  );
};

export default UsersPage;
