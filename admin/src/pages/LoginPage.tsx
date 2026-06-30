// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { AlertTriangle, RefreshCw, Eye, EyeOff, Shield, Key, QrCode, CheckCircle } from 'lucide-react';
import { startRegistration, startAuthentication } from '@simplewebauthn/browser';
import { adminApi, type AuthUser } from '../api';
import { INPUT_CLS } from '../components/styles';

interface LoginPageProps {
  onLogin: (user: AuthUser) => void;
}

type Phase =
  | { kind: 'login' }
  | { kind: 'mfa'; mfaToken: string }
  | { kind: 'passkey'; passkeyToken: string }
  | { kind: 'enroll-totp-setup'; enrollmentToken: string; mfaAlreadyEnabled: boolean; passkeyCount: number }
  | { kind: 'enroll-totp-show'; enrollmentToken: string; setupToken: string; qrCodeDataUrl: string; uri: string }
  | { kind: 'enroll-passkey'; enrollmentToken: string }
  | { kind: 'enroll-complete'; enrollmentToken: string };

const LoginPage: React.FC<LoginPageProps> = ({ onLogin }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [mfaCode, setMfaCode] = useState('');
  const [passkeyFriendlyName, setPasskeyFriendlyName] = useState('My Admin Device');
  const [phase, setPhase] = useState<Phase>({ kind: 'login' });

  const resetToLogin = () => {
    setPhase({ kind: 'login' });
    setMfaCode('');
    setPassword('');
    setError('');
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await adminApi.login(email, password);
      if (result.enrollmentRequired && result.enrollmentToken) {
        // Route into enrollment wizard. Skip TOTP setup if already enabled.
        if (result.mfaEnabled) {
          setPhase({ kind: 'enroll-passkey', enrollmentToken: result.enrollmentToken });
        } else {
          setPhase({
            kind: 'enroll-totp-setup',
            enrollmentToken: result.enrollmentToken,
            mfaAlreadyEnabled: !!result.mfaEnabled,
            passkeyCount: result.passkeyCount ?? 0,
          });
        }
        setPassword('');
      } else if (result.mfaRequired && result.mfaToken) {
        setPhase({ kind: 'mfa', mfaToken: result.mfaToken });
        setPassword('');
      } else {
        throw new Error('Unexpected login response');
      }
    } catch (err: any) {
      setError(err.message || 'Login failed');
      setPassword('');
    } finally {
      setLoading(false);
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.kind !== 'mfa') return;
    setError('');
    setLoading(true);
    try {
      const { passkeyToken } = await adminApi.verifyMfaLogin(phase.mfaToken, mfaCode);
      setPhase({ kind: 'passkey', passkeyToken });
      setMfaCode('');
    } catch (err: any) {
      setError(err.message || 'Verification failed');
      if (err.message?.includes('expired') || err.message?.includes('already used')) {
        resetToLogin();
      }
    } finally {
      setLoading(false);
    }
  };

  // Auto-trigger passkey auth when we enter the passkey phase
  useEffect(() => {
    if (phase.kind !== 'passkey') return;
    let cancelled = false;
    (async () => {
      setError('');
      setLoading(true);
      try {
        const { options, challengeToken } = await adminApi.passkeyLoginBegin(phase.passkeyToken);
        const assertion = await startAuthentication({ optionsJSON: options });
        if (cancelled) return;
        const { user, token } = await adminApi.passkeyLoginFinish(challengeToken, assertion);
        adminApi.setToken(token);
        onLogin(user);
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || 'Passkey authentication failed');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [phase, onLogin]);

  const handleTotpSetupBegin = async () => {
    if (phase.kind !== 'enroll-totp-setup') return;
    setError('');
    setLoading(true);
    try {
      const { setupToken, uri, qrCodeDataUrl } = await adminApi.enrollmentSetupMfa(phase.enrollmentToken);
      setPhase({ kind: 'enroll-totp-show', enrollmentToken: phase.enrollmentToken, setupToken, uri, qrCodeDataUrl });
    } catch (err: any) {
      setError(err?.message || 'Failed to start MFA setup');
    } finally {
      setLoading(false);
    }
  };

  const handleTotpEnable = async (e: React.FormEvent) => {
    e.preventDefault();
    if (phase.kind !== 'enroll-totp-show') return;
    setError('');
    setLoading(true);
    try {
      await adminApi.enrollmentEnableMfa(phase.enrollmentToken, phase.setupToken, mfaCode);
      setMfaCode('');
      setPhase({ kind: 'enroll-passkey', enrollmentToken: phase.enrollmentToken });
    } catch (err: any) {
      setError(err?.message || 'Invalid code');
    } finally {
      setLoading(false);
    }
  };

  const handlePasskeyRegister = async () => {
    if (phase.kind !== 'enroll-passkey') return;
    setError('');
    setLoading(true);
    try {
      const { options, challengeToken } = await adminApi.enrollmentPasskeyRegisterBegin(phase.enrollmentToken);
      const credential = await startRegistration({ optionsJSON: options });
      await adminApi.enrollmentPasskeyRegisterFinish(phase.enrollmentToken, challengeToken, credential, passkeyFriendlyName.trim() || 'My Admin Device');
      setPhase({ kind: 'enroll-complete', enrollmentToken: phase.enrollmentToken });
    } catch (err: any) {
      setError(err?.message || 'Passkey registration failed');
    } finally {
      setLoading(false);
    }
  };

  const handleEnrollComplete = async () => {
    if (phase.kind !== 'enroll-complete') return;
    setError('');
    setLoading(true);
    try {
      const { user, token } = await adminApi.enrollmentComplete(phase.enrollmentToken);
      adminApi.setToken(token);
      onLogin(user);
    } catch (err: any) {
      setError(err?.message || 'Enrollment completion failed');
    } finally {
      setLoading(false);
    }
  };

  const header = (() => {
    switch (phase.kind) {
      case 'mfa': return 'Two-factor authentication';
      case 'passkey': return 'Verifying passkey';
      case 'enroll-totp-setup':
      case 'enroll-totp-show': return 'Set up authenticator app';
      case 'enroll-passkey': return 'Register a passkey';
      case 'enroll-complete': return 'Enrollment complete';
      default: return 'Sign in to the management console';
    }
  })();

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden" style={{ background: 'linear-gradient(180deg, #060918 0%, #080d1c 50%, #0a0e20 100%)' }}>
      <div className="fixed inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
        <div className="absolute rounded-full" style={{ width: 700, height: 700, top: '15%', left: '50%', transform: 'translate(-50%, -50%)', background: 'radial-gradient(circle, #076FA0 0%, transparent 70%)', filter: 'blur(100px)', opacity: 0.04 }} />
        <div className="absolute rounded-full" style={{ width: 500, height: 500, bottom: '10%', left: '30%', background: 'radial-gradient(circle, #8b5cf6 0%, transparent 70%)', filter: 'blur(100px)', opacity: 0.03 }} />
      </div>

      <div className="w-full max-w-[440px] mx-auto relative z-10">
        <div className="flex flex-col items-center mb-10">
          <div className="relative mb-5" style={{ width: 72, height: 72 }}>
            <div className="absolute inset-0 rounded-2xl" style={{ background: 'linear-gradient(135deg, #076FA0, #8b5cf6)', filter: 'blur(16px)', opacity: 0.35 }} />
            <img src="/howl-logo.png" alt="Howl" className="relative block w-full h-full rounded-2xl object-contain" style={{ boxShadow: '0 4px 24px rgba(0,0,0,0.4)' }} />
          </div>
          <h1 className="text-[28px] font-bold text-white tracking-tight">Howl <span className="text-cyan-400">Admin</span></h1>
          <p className="text-sm text-slate-500 mt-2">{header}</p>
        </div>

        <div className="rounded-2xl p-px" style={{ background: 'linear-gradient(135deg, rgba(7,111,160,0.15), rgba(139,92,246,0.1), rgba(255,255,255,0.05))' }}>
          <div className="rounded-2xl bg-[#0b1022]/95 backdrop-blur-xl p-8">

            {error && (
              <div className="px-4 py-3 rounded-xl bg-red-500/10 border border-red-500/20 text-red-300 text-sm flex items-center gap-2.5 mb-5">
                <AlertTriangle size={15} className="shrink-0" /> {error}
              </div>
            )}

            {phase.kind === 'login' && (
              <form onSubmit={handleLoginSubmit} className="space-y-6">
                <div>
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2.5">Email or username</label>
                  <input type="text" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus className={`${INPUT_CLS} !py-3`} placeholder="admin@howl.local" />
                </div>
                <div>
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2.5">Password</label>
                  <div className="relative">
                    <input type={showPassword ? 'text' : 'password'} value={password} onChange={(e) => setPassword(e.target.value)} required className={`${INPUT_CLS} !py-3 pr-11`} />
                    <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors">
                      {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                    </button>
                  </div>
                </div>
                <PrimaryButton loading={loading} disabled={loading}>Sign In</PrimaryButton>
              </form>
            )}

            {phase.kind === 'mfa' && (
              <form onSubmit={handleMfaSubmit} className="space-y-6">
                <div className="flex items-center justify-center gap-2.5 mb-2">
                  <Shield size={18} className="text-cyan-400" />
                  <span className="text-sm font-semibold text-cyan-300 uppercase tracking-wider">Authenticator Code</span>
                </div>
                <div>
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2.5">6-digit code</label>
                  <input type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code"
                    value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required autoFocus className={`${INPUT_CLS} text-center text-lg tracking-[0.3em] font-mono !py-3.5`}
                    placeholder="000000" />
                </div>
                <PrimaryButton loading={loading} disabled={loading || mfaCode.length !== 6}>Verify</PrimaryButton>
                <button type="button" onClick={resetToLogin} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition-colors py-1">Back to login</button>
              </form>
            )}

            {phase.kind === 'passkey' && (
              <div className="space-y-6">
                <div className="flex items-center justify-center gap-2.5 mb-2">
                  <Key size={18} className="text-cyan-400" />
                  <span className="text-sm font-semibold text-cyan-300 uppercase tracking-wider">Passkey</span>
                </div>
                <p className="text-sm text-slate-400 text-center">
                  {loading ? 'Waiting for your passkey…' : 'Touch your security key or use your device biometric to continue.'}
                </p>
                <button type="button" onClick={() => setPhase({ kind: 'passkey', passkeyToken: phase.passkeyToken })} disabled={loading}
                  className="w-full py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  style={{ background: 'linear-gradient(135deg, rgba(7,111,160,0.2), rgba(139,92,246,0.2))', color: '#076FA0', border: '1px solid rgba(7,111,160,0.25)' }}>
                  {loading ? <span className="flex items-center justify-center gap-2"><RefreshCw size={14} className="animate-spin" /> Verifying…</span> : 'Retry passkey'}
                </button>
                <button type="button" onClick={resetToLogin} className="w-full text-center text-sm text-slate-500 hover:text-slate-300 transition-colors py-1">Back to login</button>
              </div>
            )}

            {phase.kind === 'enroll-totp-setup' && (
              <div className="space-y-5">
                <p className="text-sm text-slate-400">
                  Admin access now requires an authenticator app and a passkey. We'll walk through both now.
                </p>
                <PrimaryButton loading={loading} disabled={loading} onClick={handleTotpSetupBegin}>
                  Start TOTP setup
                </PrimaryButton>
              </div>
            )}

            {phase.kind === 'enroll-totp-show' && (
              <form onSubmit={handleTotpEnable} className="space-y-5">
                <div className="flex items-center justify-center gap-2.5">
                  <QrCode size={18} className="text-cyan-400" />
                  <span className="text-sm font-semibold text-cyan-300 uppercase tracking-wider">Scan QR</span>
                </div>
                <div className="flex justify-center">
                  <img src={phase.qrCodeDataUrl} alt="QR" className="rounded-xl bg-white p-2" style={{ width: 200, height: 200 }} />
                </div>
                <details className="text-xs text-slate-500">
                  <summary className="cursor-pointer">Can't scan? Show secret</summary>
                  <code className="mt-2 block break-all bg-black/30 p-2 rounded">{phase.uri}</code>
                </details>
                <div>
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2.5">Enter 6-digit code from your app</label>
                  <input type="text" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code"
                    value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    required autoFocus className={`${INPUT_CLS} text-center text-lg tracking-[0.3em] font-mono !py-3.5`} placeholder="000000" />
                </div>
                <PrimaryButton loading={loading} disabled={loading || mfaCode.length !== 6}>Enable TOTP</PrimaryButton>
              </form>
            )}

            {phase.kind === 'enroll-passkey' && (
              <div className="space-y-5">
                <div className="flex items-center justify-center gap-2.5">
                  <Key size={18} className="text-cyan-400" />
                  <span className="text-sm font-semibold text-cyan-300 uppercase tracking-wider">Register passkey</span>
                </div>
                <p className="text-sm text-slate-400">
                  Your passkey is a phishing-resistant second factor bound to this device.
                </p>
                <div>
                  <label className="text-xs text-slate-400 font-semibold uppercase tracking-wider block mb-2.5">Device name</label>
                  <input type="text" value={passkeyFriendlyName} onChange={(e) => setPasskeyFriendlyName(e.target.value)} maxLength={100} className={`${INPUT_CLS} !py-3`} placeholder="e.g. MacBook Touch ID or YubiKey 5C" />
                </div>
                <PrimaryButton loading={loading} disabled={loading || !passkeyFriendlyName.trim()} onClick={handlePasskeyRegister}>
                  Register passkey
                </PrimaryButton>
              </div>
            )}

            {phase.kind === 'enroll-complete' && (
              <div className="space-y-5">
                <div className="flex items-center justify-center gap-2.5">
                  <CheckCircle size={18} className="text-emerald-400" />
                  <span className="text-sm font-semibold text-emerald-300 uppercase tracking-wider">All set</span>
                </div>
                <p className="text-sm text-slate-400 text-center">
                  Enrollment complete. Click below to finish signing in — next time you'll be asked for your password, TOTP code, and passkey.
                </p>
                <PrimaryButton loading={loading} disabled={loading} onClick={handleEnrollComplete}>
                  Enter admin panel
                </PrimaryButton>
              </div>
            )}

          </div>
        </div>

        <p className="text-center text-[11px] text-slate-600 mt-8 tracking-wide">Howl Platform &middot; Admin Console</p>
      </div>
    </div>
  );
};

const PrimaryButton: React.FC<React.PropsWithChildren<{ loading?: boolean; disabled?: boolean; onClick?: () => void }>> = ({ loading, disabled, onClick, children }) => (
  <button type={onClick ? 'button' : 'submit'} disabled={disabled} onClick={onClick}
    className="w-full py-3.5 rounded-xl text-sm font-semibold transition-all duration-200 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
    style={{
      background: loading ? 'rgba(7,111,160,0.15)' : 'linear-gradient(135deg, rgba(7,111,160,0.2), rgba(139,92,246,0.2))',
      color: '#076FA0',
      border: '1px solid rgba(7,111,160,0.25)',
      boxShadow: '0 0 20px rgba(7,111,160,0.1)',
    }}>
    {loading ? <span className="flex items-center justify-center gap-2"><RefreshCw size={14} className="animate-spin" /> Working…</span> : children}
  </button>
);

export default LoginPage;
