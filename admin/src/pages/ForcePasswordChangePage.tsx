// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState } from 'react';
import { Lock, AlertTriangle, RefreshCw } from 'lucide-react';
import { adminApi } from '../api';
import { INPUT_CLS, CARD } from '../components/styles';
import { PW_RULES } from '../utils';

interface ForcePasswordChangePageProps {
  onComplete: () => void;
}

const ForcePasswordChangePage: React.FC<ForcePasswordChangePageProps> = ({ onComplete }) => {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const allRulesPass = PW_RULES.every((r) => r.test(newPw));
  const confirmMatch = newPw === confirmPw && confirmPw.length > 0;
  const canSubmit = currentPw.length > 0 && allRulesPass && confirmMatch && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(''); setLoading(true);
    try {
      await adminApi.changePassword(currentPw, newPw);
      onComplete();
    } catch (err: any) {
      setError(err.message || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: 'linear-gradient(145deg, #050810 0%, #0a1628 40%, #0d0f20 100%)' }}>
      <div style={{ width: '100%', maxWidth: '28rem', margin: '0 auto' }}>
        <div style={{ textAlign: 'center', marginBottom: '2rem' }}>
          <div style={{ width: 64, height: 64, borderRadius: 16, background: 'linear-gradient(135deg, rgba(245,158,11,0.2), rgba(239,68,68,0.2))', border: '1px solid rgba(245,158,11,0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem auto' }}>
            <Lock size={28} className="text-amber-400" />
          </div>
          <h1 className="text-xl font-bold text-white tracking-tight">Password Change Required</h1>
          <p className="text-sm text-slate-400 mt-2 max-w-xs mx-auto">Your password has been reset by an administrator. Please set a new password to continue.</p>
        </div>
        <form onSubmit={handleSubmit} className={`${CARD} p-7 space-y-4`}>
          {error && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2.5"><AlertTriangle size={15} className="shrink-0" /> {error}</div>}
          <div>
            <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Temporary password</label>
            <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className={INPUT_CLS} autoComplete="current-password" autoFocus />
          </div>
          <div>
            <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">New password</label>
            <input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} className={INPUT_CLS} autoComplete="new-password" />
            {newPw.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-2">
                {PW_RULES.map((r) => (
                  <span key={r.label} className={`text-[10px] font-medium px-2 py-0.5 rounded ${r.test(newPw) ? 'bg-emerald-500/15 text-emerald-400' : 'bg-white/[0.04] text-slate-500'}`}>
                    {r.test(newPw) ? '\u2713' : '\u2717'} {r.label}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Confirm new password</label>
            <input type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)} className={INPUT_CLS} autoComplete="new-password" />
            {confirmPw.length > 0 && !confirmMatch && <p className="text-[10px] text-red-400 mt-1">Passwords do not match</p>}
          </div>
          <button type="submit" disabled={!canSubmit}
            className="w-full py-3 rounded-xl bg-gradient-to-r from-amber-500/20 to-orange-500/20 text-white border border-amber-500/20 text-sm font-bold hover:from-amber-500/30 hover:to-orange-500/30 disabled:opacity-40 transition-all duration-300">
            {loading ? <span className="flex items-center justify-center gap-2"><RefreshCw size={14} className="animate-spin" /> Setting password...</span> : 'Set New Password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ForcePasswordChangePage;
