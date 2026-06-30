// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import {
  RefreshCw, AlertTriangle, ShieldCheck, ShieldOff, Lock, Key, Trash2,
} from 'lucide-react';
import { startRegistration } from '@simplewebauthn/browser';
import { adminApi } from '../api';
import { INPUT_CLS, BTN_PRIMARY, CARD } from '../components/styles';
import { PW_RULES } from '../utils';

interface PasskeyRow {
  id: string;
  friendlyName: string;
  deviceType: string | null;
  backedUp: boolean;
  lastUsedAt: string | null;
  createdAt: string;
}

const PasskeysSection: React.FC = () => {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [friendlyName, setFriendlyName] = useState('');

  const refresh = useCallback(async () => {
    try {
      const { passkeys } = await adminApi.listPasskeys();
      setPasskeys(passkeys);
    } catch (err: any) {
      setError(err?.message || 'Failed to load passkeys');
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const addPasskey = async () => {
    setError(''); setSuccess(''); setLoading(true);
    try {
      const name = friendlyName.trim() || 'Admin Passkey';
      const { options, challengeToken } = await adminApi.passkeyRegisterBegin();
      const credential = await startRegistration({ optionsJSON: options });
      await adminApi.passkeyRegisterFinish(challengeToken, credential, name);
      setSuccess(`Passkey "${name}" registered`);
      setFriendlyName('');
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to register passkey');
    } finally {
      setLoading(false);
    }
  };

  const removePasskey = async (id: string, name: string) => {
    if (!confirm(`Remove passkey "${name}"? You'll need another to sign in.`)) return;
    setError(''); setSuccess(''); setLoading(true);
    try {
      await adminApi.deletePasskey(id);
      setSuccess(`Passkey "${name}" removed`);
      await refresh();
    } catch (err: any) {
      setError(err?.message || 'Failed to remove passkey');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`${CARD} p-6 mt-6`}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/[0.04] border border-white/[0.08]">
          <Key size={18} className="text-slate-400" />
        </div>
        <div>
          <div className="text-white font-semibold text-sm">Passkeys</div>
          <div className="text-xs text-slate-500">Phishing-resistant second factor required on every admin login</div>
        </div>
      </div>

      {error && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2.5 mb-4"><AlertTriangle size={15} className="shrink-0" /> {error}</div>}
      {success && <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm flex items-center gap-2.5 mb-4"><ShieldCheck size={15} className="shrink-0" /> {success}</div>}

      {passkeys === null ? (
        <div className="text-slate-500 text-sm flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Loading...</div>
      ) : (
        <>
          {passkeys.length === 0 ? (
            <p className="text-sm text-amber-300 mb-4">No passkeys registered. Add one below — you won't be able to log in without at least one.</p>
          ) : (
            <ul className="divide-y divide-white/[0.04] mb-4">
              {passkeys.map((p) => (
                <li key={p.id} className="flex items-center justify-between py-3">
                  <div>
                    <div className="text-sm text-white font-medium">{p.friendlyName}</div>
                    <div className="text-[11px] text-slate-500">
                      {p.deviceType ?? 'unknown'} · added {new Date(p.createdAt).toLocaleDateString()}
                      {p.lastUsedAt ? ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}` : ''}
                      {p.backedUp ? ' · synced' : ' · single-device'}
                    </div>
                  </div>
                  <button onClick={() => removePasskey(p.id, p.friendlyName)} disabled={loading || passkeys.length <= 1}
                    title={passkeys.length <= 1 ? 'Add another passkey first — removing your last one would lock you out' : undefined}
                    className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-300 border border-red-500/20 text-xs font-semibold hover:bg-red-500/20 disabled:opacity-30 disabled:cursor-not-allowed transition-all">
                    <span className="flex items-center gap-1.5"><Trash2 size={12} /> Remove</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="space-y-3">
            <div>
              <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Device name</label>
              <input type="text" value={friendlyName} onChange={(e) => setFriendlyName(e.target.value)} maxLength={100} className={INPUT_CLS} placeholder="e.g. MacBook Touch ID or YubiKey 5C" />
            </div>
            <button onClick={addPasskey} disabled={loading} className={BTN_PRIMARY}>
              {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Working...</span> : 'Add passkey'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// Change Password Section

const ChangePasswordSection: React.FC = () => {
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const allRulesPass = PW_RULES.every((r) => r.test(newPw));
  const confirmMatch = newPw === confirmPw && confirmPw.length > 0;
  const canSubmit = currentPw.length > 0 && allRulesPass && confirmMatch && !loading;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setError(''); setSuccess(''); setLoading(true);
    try {
      await adminApi.changePassword(currentPw, newPw);
      setCurrentPw(''); setNewPw(''); setConfirmPw('');
      setSuccess('Password changed successfully. All other sessions have been signed out.');
    } catch (err: any) {
      setError(err.message || 'Failed to change password');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={`${CARD} p-6 mt-6`}>
      <div className="flex items-center gap-3 mb-4">
        <div className="w-10 h-10 rounded-xl flex items-center justify-center bg-white/[0.04] border border-white/[0.08]">
          <Lock size={18} className="text-slate-400" />
        </div>
        <div>
          <div className="text-white font-semibold text-sm">Change Password</div>
          <div className="text-xs text-slate-500">Update your admin account password</div>
        </div>
      </div>

      {error && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2.5 mb-4"><AlertTriangle size={15} className="shrink-0" /> {error}</div>}
      {success && <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm flex items-center gap-2.5 mb-4"><ShieldCheck size={15} className="shrink-0" /> {success}</div>}

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Current password</label>
          <input type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)} className={INPUT_CLS} autoComplete="current-password" />
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
          {confirmPw.length > 0 && !confirmMatch && (
            <p className="text-[10px] text-red-400 mt-1">Passwords do not match</p>
          )}
        </div>
        <button type="submit" disabled={!canSubmit} className={`${BTN_PRIMARY} ${!canSubmit ? 'opacity-40' : ''}`}>
          {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Changing...</span> : 'Change Password'}
        </button>
      </form>
    </div>
  );
};

// Security Page (MFA + Password)

const SecurityPage: React.FC = () => {
  const [mfaEnabled, setMfaEnabled] = useState<boolean | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // Setup flow
  const [setupUri, setSetupUri] = useState<string | null>(null);
  const [setupQrDataUrl, setSetupQrDataUrl] = useState<string | null>(null);
  const [setupToken, setSetupToken] = useState<string | null>(null);
  const [setupCode, setSetupCode] = useState('');

  // Disable flow
  const [showDisable, setShowDisable] = useState(false);
  const [disablePassword, setDisablePassword] = useState('');
  const [disableCode, setDisableCode] = useState('');

  useEffect(() => {
    adminApi.getMfaStatus().then((s) => setMfaEnabled(s.mfaEnabled)).catch(() => {});
  }, []);

  const startSetup = async () => {
    setError(''); setSuccess(''); setLoading(true);
    try {
      const { setupToken: st, uri, qrCodeDataUrl } = await adminApi.setupMfa();
      setSetupToken(st);
      setSetupUri(uri);
      setSetupQrDataUrl(qrCodeDataUrl);
    } catch (err: any) {
      setError(err.message || 'Setup failed');
    } finally {
      setLoading(false);
    }
  };

  const confirmEnable = async () => {
    if (!setupToken) return;
    setError(''); setLoading(true);
    try {
      await adminApi.enableMfa(setupToken, setupCode);
      setMfaEnabled(true);
      setSetupUri(null); setSetupQrDataUrl(null); setSetupToken(null); setSetupCode('');
      setSuccess('MFA enabled successfully');
    } catch (err: any) {
      setError(err.message || 'Failed to enable MFA');
    } finally {
      setLoading(false);
    }
  };

  const confirmDisable = async () => {
    setError(''); setLoading(true);
    try {
      await adminApi.disableAdminMfa(disablePassword, disableCode);
      setMfaEnabled(false);
      setShowDisable(false); setDisablePassword(''); setDisableCode('');
      setSuccess('MFA disabled');
    } catch (err: any) {
      setError(err.message || 'Failed to disable MFA');
    } finally {
      setLoading(false);
    }
  };

  if (mfaEnabled === null) return <div className="text-slate-500 text-sm flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Loading...</div>;

  return (
    <div style={{ maxWidth: '36rem', margin: '0 auto' }}>
      <h2 className="text-2xl font-bold text-white tracking-tight mb-2">Security</h2>
      <p className="text-sm text-slate-500 mb-8">Manage two-factor authentication for your admin account</p>

      {error && <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2.5 mb-5"><AlertTriangle size={15} className="shrink-0" /> {error}</div>}
      {success && <div className="px-4 py-3 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 text-sm flex items-center gap-2.5 mb-5"><ShieldCheck size={15} className="shrink-0" /> {success}</div>}

      <div className={`${CARD} p-6`}>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${mfaEnabled ? 'bg-emerald-500/15 border border-emerald-500/25' : 'bg-white/[0.04] border border-white/[0.08]'}`}>
              {mfaEnabled ? <ShieldCheck size={18} className="text-emerald-400" /> : <ShieldOff size={18} className="text-slate-500" />}
            </div>
            <div>
              <div className="text-white font-semibold text-sm">Two-Factor Authentication</div>
              <div className={`text-xs font-medium ${mfaEnabled ? 'text-emerald-400' : 'text-slate-500'}`}>{mfaEnabled ? 'Enabled' : 'Disabled'}</div>
            </div>
          </div>
        </div>

        {/* Setup flow */}
        {!mfaEnabled && !setupUri && (
          <button onClick={startSetup} disabled={loading} className={BTN_PRIMARY}>
            {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Setting up...</span> : 'Enable MFA'}
          </button>
        )}

        {setupUri && (
          <div className="space-y-5 mt-4">
            <p className="text-sm text-slate-400">Scan this QR code with your authenticator app (Google Authenticator, Authy, 1Password, etc.)</p>
            <div className="flex justify-center p-4 bg-white rounded-2xl" style={{ width: 'fit-content', margin: '0 auto' }}>
              {setupQrDataUrl && <img src={setupQrDataUrl} alt="QR Code" width={200} height={200} />}
            </div>
            <details className="text-xs text-slate-500">
              <summary className="cursor-pointer hover:text-slate-300 transition-colors">Can't scan? Copy manual entry key</summary>
              <code className="block mt-2 p-3 rounded-lg bg-white/[0.04] break-all text-slate-400 font-mono text-xs select-all">
                {setupUri}
              </code>
            </details>
            <div>
              <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Verification code</label>
              <input
                type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code"
                value={setupCode} onChange={(e) => setSetupCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className={`${INPUT_CLS} text-center text-lg tracking-[0.3em] font-mono`}
                placeholder="000000" autoFocus
              />
            </div>
            <div className="flex gap-3">
              <button onClick={confirmEnable} disabled={loading || setupCode.length !== 6} className={BTN_PRIMARY}>
                {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Verifying...</span> : 'Verify & Enable'}
              </button>
              <button onClick={() => { setSetupUri(null); setSetupQrDataUrl(null); setSetupToken(null); setSetupCode(''); setError(''); }}
                className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all duration-200">
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Disable flow */}
        {mfaEnabled && !showDisable && (
          <button onClick={() => { setShowDisable(true); setError(''); setSuccess(''); }}
            className="px-5 py-2.5 rounded-xl bg-red-500/10 text-red-300 border border-red-500/20 text-sm font-semibold hover:bg-red-500/20 hover:border-red-500/30 transition-all duration-200">
            Disable MFA
          </button>
        )}

        {showDisable && (
          <div className="space-y-4 mt-4">
            <p className="text-sm text-slate-400">Confirm your password and current TOTP code to disable MFA.</p>
            <div>
              <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">Password</label>
              <input type="password" value={disablePassword} onChange={(e) => setDisablePassword(e.target.value)} className={INPUT_CLS} autoFocus />
            </div>
            <div>
              <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2">TOTP code</label>
              <input type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code"
                value={disableCode} onChange={(e) => setDisableCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                className={`${INPUT_CLS} text-center text-lg tracking-[0.3em] font-mono`} placeholder="000000"
              />
            </div>
            <div className="flex gap-3">
              <button onClick={confirmDisable} disabled={loading || !disablePassword || disableCode.length !== 6}
                className="px-5 py-2.5 rounded-xl bg-red-500/10 text-red-300 border border-red-500/20 text-sm font-semibold hover:bg-red-500/20 disabled:opacity-40 transition-all duration-200">
                {loading ? <span className="flex items-center gap-2"><RefreshCw size={14} className="animate-spin" /> Disabling...</span> : 'Confirm Disable'}
              </button>
              <button onClick={() => { setShowDisable(false); setDisablePassword(''); setDisableCode(''); setError(''); }}
                className="px-4 py-2.5 rounded-xl text-sm text-slate-400 hover:text-white hover:bg-white/[0.06] transition-all duration-200">
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Passkeys ── */}
      <PasskeysSection />

      {/* ── Change Password ── */}
      <ChangePasswordSection />
    </div>
  );
};

export default SecurityPage;
