// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, AlertTriangle, ShieldCheck, X, Lock,
  Trash2, Eye, EyeOff, Copy, Check, UserPlus, AlertCircle,
} from 'lucide-react';
import { adminApi, type AdminAccount, type AuthUser } from '../api';
import { INPUT_CLS, BTN_PRIMARY, CARD, TABLE_HEAD } from '../components/styles';
import {
  formatRelativeTime, ROLE_BADGE, PW_RULES, generateClientTempPassword,
} from '../utils';

interface AccountsPageProps {
  user: AuthUser;
}

const AccountsPage: React.FC<AccountsPageProps> = ({ user }) => {
  const myId = user.id;
  const myRole = user.role || 'admin';

  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionSuccess, setActionSuccess] = useState('');

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  const [createEmail, setCreateEmail] = useState('');
  const [createUsername, setCreateUsername] = useState('');
  const [createPassword, setCreatePassword] = useState('');
  const [createRole, setCreateRole] = useState<'admin' | 'superadmin'>('admin');
  const [createLoading, setCreateLoading] = useState(false);
  const [createError, setCreateError] = useState('');
  const [showCreatePw, setShowCreatePw] = useState(false);
  const [copiedPw, setCopiedPw] = useState(false);

  // Temp password modal
  const [tempPwModal, setTempPwModal] = useState<{ username: string; password: string } | null>(null);
  const [copiedTemp, setCopiedTemp] = useState(false);

  // Confirm delete
  const [deleteTarget, setDeleteTarget] = useState<AdminAccount | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Confirm role change
  const [roleTarget, setRoleTarget] = useState<AdminAccount | null>(null);
  const [roleNewValue, setRoleNewValue] = useState<'admin' | 'superadmin'>('admin');
  const [roleLoading, setRoleLoading] = useState(false);

  const fetchAccounts = useCallback(async () => {
    setError(null);
    try { const data = await adminApi.getAdminAccounts(); setAccounts(data); } catch (err) { setError(err instanceof Error ? err.message : 'Failed to load data'); }
    setLoading(false);
  }, []);
  useEffect(() => { fetchAccounts(); }, [fetchAccounts]);

  const handleCreate = async () => {
    setCreateError(''); setCreateLoading(true);
    try {
      await adminApi.createAdminAccount(createEmail, createUsername, createPassword, createRole);
      setShowCreate(false); setCreateEmail(''); setCreateUsername(''); setCreatePassword(''); setCreateRole('admin');
      setActionSuccess('Account created. They will be required to change their password on first login.');
      fetchAccounts();
    } catch (err: any) {
      setCreateError(err.message || 'Failed to create account');
    } finally { setCreateLoading(false); }
  };

  const handleResetPassword = async (acct: AdminAccount) => {
    setActionError(''); setActionSuccess('');
    try {
      const { temporaryPassword } = await adminApi.resetAdminPassword(acct.id);
      setTempPwModal({ username: acct.username, password: temporaryPassword });
      fetchAccounts();
    } catch (err: any) { setActionError(err.message || 'Failed to reset password'); }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleteLoading(true);
    try {
      await adminApi.deleteAdminAccount(deleteTarget.id);
      setDeleteTarget(null); setDeleteConfirmText('');
      setActionSuccess(`Account "${deleteTarget.username}" deleted.`);
      fetchAccounts();
    } catch (err: any) { setActionError(err.message || 'Failed to delete account'); }
    finally { setDeleteLoading(false); }
  };

  const handleRoleChange = async () => {
    if (!roleTarget) return;
    setRoleLoading(true);
    try {
      await adminApi.changeAdminRole(roleTarget.id, roleNewValue);
      setRoleTarget(null);
      setActionSuccess(`Role updated.`);
      fetchAccounts();
    } catch (err: any) { setActionError(err.message || 'Failed to change role'); }
    finally { setRoleLoading(false); }
  };

  const canActOn = (target: AdminAccount) => {
    if (target.id === myId) return false;
    if (target.role === 'owner') return false;
    if (target.role === 'superadmin' && myRole !== 'owner') return false;
    return true;
  };

  const canChangeRole = (target: AdminAccount) => myRole === 'owner' && target.id !== myId && target.role !== 'owner';

  return (
    <div style={{ maxWidth: '72rem', margin: '0 auto' }}>
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-bold text-white tracking-tight">Admin Accounts</h2>
          <p className="text-sm text-slate-500 mt-1">Manage administrator accounts and permissions</p>
        </div>
        <button onClick={() => { setShowCreate(true); setCreateError(''); }} className={BTN_PRIMARY + ' flex items-center gap-2'}>
          <UserPlus size={14} /> Create Account
        </button>
      </div>

      {actionError && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2.5 mb-4"><AlertTriangle size={15} className="shrink-0" /> {actionError} <button onClick={() => setActionError('')} className="ml-auto opacity-60 hover:opacity-100"><X size={14} /></button></div>}
      {actionSuccess && <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm flex items-center gap-2.5 mb-4"><ShieldCheck size={15} className="shrink-0" /> {actionSuccess} <button onClick={() => setActionSuccess('')} className="ml-auto opacity-60 hover:opacity-100"><X size={14} /></button></div>}

      {error && (
        <div className="flex flex-col items-center justify-center py-16 text-sm">
          <AlertCircle size={24} className="text-red-400 mb-3" />
          <p className="text-red-300 mb-4">{error}</p>
          <button onClick={() => fetchAccounts()} className="px-4 py-2 rounded-xl bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 text-sm font-medium hover:bg-cyan-500/25">
            Retry
          </button>
        </div>
      )}

      <div className={`${CARD} overflow-x-auto`}>
        <table className="w-full text-xs">
          <thead><tr className={TABLE_HEAD}>
            <th className="px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Username</th>
            <th className="px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Email</th>
            <th className="px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Role</th>
            <th className="px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">MFA</th>
            <th className="px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Last Login</th>
            <th className="px-5 py-3 text-slate-400 font-semibold uppercase tracking-wider text-[10px]">Actions</th>
          </tr></thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-500"><RefreshCw size={16} className="animate-spin inline mr-2" />Loading...</td></tr>
            ) : accounts.length === 0 ? (
              <tr><td colSpan={6} className="px-5 py-12 text-center text-slate-500">No accounts found</td></tr>
            ) : accounts.map((a) => (
              <tr key={a.id} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                <td className="px-5 py-3.5">
                  <span className="text-white font-semibold">{a.username}</span>
                  {a.forcePasswordChange && <span className="ml-2 text-[9px] font-semibold px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">PW Reset</span>}
                </td>
                <td className="px-5 py-3.5 text-slate-400">{a.email}</td>
                <td className="px-5 py-3.5">
                  <span className={`text-[9px] font-semibold px-2 py-0.5 rounded border ${ROLE_BADGE[a.role]?.cls || ROLE_BADGE.admin.cls}`}>
                    {ROLE_BADGE[a.role]?.label || a.role}
                  </span>
                </td>
                <td className="px-5 py-3.5">
                  <span className={`text-[9px] font-semibold px-2 py-0.5 rounded ${a.mfaEnabled ? 'bg-emerald-500/20 text-emerald-400' : 'bg-slate-500/15 text-slate-500'}`}>
                    {a.mfaEnabled ? 'Enabled' : 'Disabled'}
                  </span>
                </td>
                <td className="px-5 py-3.5 text-slate-400">{formatRelativeTime(a.lastLoginAt)}</td>
                <td className="px-5 py-3.5">
                  {a.id === myId ? (
                    <span className="text-[10px] text-slate-500 italic">You</span>
                  ) : a.role === 'owner' ? (
                    <span className="text-[10px] text-slate-600 flex items-center gap-1"><Lock size={10} /> Protected</span>
                  ) : !canActOn(a) ? (
                    <span className="text-[10px] text-slate-600">&mdash;</span>
                  ) : (
                    <div className="flex items-center gap-1.5">
                      <button onClick={() => handleResetPassword(a)} className="text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 transition-all">Reset PW</button>
                      {canChangeRole(a) && (
                        <button onClick={() => { setRoleTarget(a); setRoleNewValue(a.role === 'admin' ? 'superadmin' : 'admin'); }}
                          className="text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-violet-500/10 text-violet-400 hover:bg-violet-500/20 transition-all">
                          {a.role === 'admin' ? 'Promote' : 'Demote'}
                        </button>
                      )}
                      <button onClick={() => { setDeleteTarget(a); setDeleteConfirmText(''); setActionError(''); }}
                        className="text-[10px] font-semibold px-2.5 py-1 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition-all">
                        <Trash2 size={11} />
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Create Account Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setShowCreate(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md rounded-2xl border border-white/10 p-6" style={{ backgroundColor: 'var(--bg-panel, #0c1225)' }} onClick={(e) => e.stopPropagation()}>
            <button onClick={() => setShowCreate(false)} className="absolute top-4 right-4 text-white/40 hover:text-white/70"><X size={16} /></button>
            <h3 className="text-base font-bold text-white mb-5 flex items-center gap-2"><UserPlus size={18} className="text-cyan-400" /> Create Admin Account</h3>
            {createError && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm mb-4 flex items-center gap-2"><AlertTriangle size={14} /> {createError}</div>}
            <div className="space-y-3">
              <div>
                <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block mb-1.5">Email</label>
                <input type="email" value={createEmail} onChange={(e) => setCreateEmail(e.target.value)} className={INPUT_CLS} />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block mb-1.5">Username</label>
                <input type="text" value={createUsername} onChange={(e) => setCreateUsername(e.target.value)} className={INPUT_CLS} placeholder="alphanumeric + underscores" />
              </div>
              <div>
                <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block mb-1.5">Password</label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <input type={showCreatePw ? 'text' : 'password'} value={createPassword} onChange={(e) => setCreatePassword(e.target.value)} className={`${INPUT_CLS} pr-9`} />
                    <button type="button" onClick={() => setShowCreatePw(!showCreatePw)} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300">{showCreatePw ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                  </div>
                  <button type="button" onClick={() => { const pw = generateClientTempPassword(); setCreatePassword(pw); setShowCreatePw(true); setCopiedPw(false); }}
                    className="text-[10px] font-semibold px-3 rounded-xl bg-white/[0.06] border border-white/[0.08] text-slate-300 hover:bg-white/[0.1] transition-all whitespace-nowrap">
                    Generate
                  </button>
                  {showCreatePw && createPassword && (
                    <button type="button" onClick={() => { navigator.clipboard.writeText(createPassword); setCopiedPw(true); setTimeout(() => setCopiedPw(false), 2000); }}
                      className="text-[10px] font-semibold px-2.5 rounded-xl bg-white/[0.06] border border-white/[0.08] text-slate-300 hover:bg-white/[0.1] transition-all">
                      {copiedPw ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                    </button>
                  )}
                </div>
                {createPassword.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mt-2">
                    {PW_RULES.map((r) => (
                      <span key={r.label} className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${r.test(createPassword) ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] text-slate-500'}`}>
                        {r.test(createPassword) ? '\u2713' : '\u2717'} {r.label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {myRole === 'owner' && (
                <div>
                  <label className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider block mb-1.5">Role</label>
                  <div className="flex gap-2">
                    {(['admin', 'superadmin'] as const).map((r) => (
                      <button key={r} type="button" onClick={() => setCreateRole(r)}
                        className={`flex-1 text-xs font-semibold py-2 rounded-xl border transition-all ${createRole === r ? 'bg-cyan-500/20 border-cyan-500/40 text-cyan-300' : 'bg-white/5 border-white/10 text-slate-400 hover:bg-white/10'}`}>
                        {r === 'admin' ? 'Admin' : 'Super Admin'}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <button onClick={handleCreate} disabled={createLoading || !createEmail || !createUsername || !createPassword || !PW_RULES.every((r) => r.test(createPassword))}
                className={`w-full mt-2 ${BTN_PRIMARY} disabled:opacity-40`}>
                {createLoading ? <span className="flex items-center justify-center gap-2"><RefreshCw size={14} className="animate-spin" /> Creating...</span> : 'Create Account'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Temp Password Modal */}
      {tempPwModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-md rounded-2xl border border-white/10 p-6" style={{ backgroundColor: 'var(--bg-panel, #0c1225)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-white mb-1">Temporary Password for {tempPwModal.username}</h3>
            <p className="text-xs text-slate-400 mb-5">This password will not be shown again.</p>
            <div className="flex items-center gap-3 p-4 rounded-xl bg-white/[0.04] border border-white/[0.08] mb-4">
              <code className="flex-1 text-base font-mono text-white tracking-wider select-all">{tempPwModal.password}</code>
              <button onClick={() => { navigator.clipboard.writeText(tempPwModal.password); setCopiedTemp(true); setTimeout(() => setCopiedTemp(false), 2000); }}
                className="text-[10px] font-semibold px-3 py-1.5 rounded-lg bg-cyan-500/15 text-cyan-300 border border-cyan-500/25 hover:bg-cyan-500/25 transition-all">
                {copiedTemp ? <><Check size={12} className="inline mr-1" />Copied</> : <><Copy size={12} className="inline mr-1" />Copy</>}
              </button>
            </div>
            <div className="px-4 py-3 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs mb-5">
              Share this password securely. They will be required to change it on first login.
            </div>
            <button onClick={() => { setTempPwModal(null); setCopiedTemp(false); }} className={BTN_PRIMARY + ' w-full'}>Close</button>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setDeleteTarget(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-sm rounded-2xl border border-red-500/20 p-6" style={{ backgroundColor: 'var(--bg-panel, #0c1225)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-white mb-2">Delete {deleteTarget.role === 'superadmin' ? 'Super Admin' : 'Admin'} Account</h3>
            {deleteTarget.role === 'superadmin' ? (
              <>
                <p className="text-xs text-slate-400 mb-4">You are deleting a Super Admin account. Type their username to confirm:</p>
                <input type="text" value={deleteConfirmText} onChange={(e) => setDeleteConfirmText(e.target.value)} placeholder={deleteTarget.username} className={INPUT_CLS + ' mb-4'} autoFocus />
              </>
            ) : (
              <p className="text-xs text-slate-400 mb-5">Delete admin account <strong className="text-white">{deleteTarget.username}</strong>? This will permanently remove their account and invalidate all sessions. This action cannot be undone.</p>
            )}
            <div className="flex gap-3">
              <button onClick={handleDelete}
                disabled={deleteLoading || (deleteTarget.role === 'superadmin' && deleteConfirmText !== deleteTarget.username)}
                className="px-5 py-2.5 rounded-xl bg-red-500/15 text-red-300 border border-red-500/25 text-sm font-semibold hover:bg-red-500/25 disabled:opacity-40 transition-all">
                {deleteLoading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Deleting...</span> : 'Delete Account'}
              </button>
              <button onClick={() => setDeleteTarget(null)} className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* Role Change Confirmation Modal */}
      {roleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" onClick={() => setRoleTarget(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div className="relative w-full max-w-sm rounded-2xl border border-white/10 p-6" style={{ backgroundColor: 'var(--bg-panel, #0c1225)' }} onClick={(e) => e.stopPropagation()}>
            <h3 className="text-base font-bold text-white mb-2">{roleNewValue === 'superadmin' ? 'Promote' : 'Demote'} {roleTarget.username}</h3>
            <p className="text-xs text-slate-400 mb-5">
              {roleNewValue === 'superadmin'
                ? `Promote ${roleTarget.username} to Super Admin? They will be able to create and manage Admin accounts.`
                : `Demote ${roleTarget.username} to Admin? They will lose the ability to manage other accounts.`}
            </p>
            <div className="flex gap-3">
              <button onClick={handleRoleChange} disabled={roleLoading}
                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all disabled:opacity-40 ${roleNewValue === 'superadmin' ? 'bg-violet-500/15 text-violet-300 border border-violet-500/25 hover:bg-violet-500/25' : 'bg-amber-500/15 text-amber-300 border border-amber-500/25 hover:bg-amber-500/25'}`}>
                {roleLoading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Updating...</span> : (roleNewValue === 'superadmin' ? 'Promote' : 'Demote')}
              </button>
              <button onClick={() => setRoleTarget(null)} className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AccountsPage;
