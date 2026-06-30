// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { LockKeyhole, Loader2, AlertCircle, ArrowLeft, CheckCircle2 } from 'lucide-react';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { apiClient } from '../../services/api';
import { assetPath } from '../../utils/assetPath';

type State = 'loading' | 'authenticating' | 'verifying' | 'success' | 'error' | 'manual';

const providers = ['Windows Hello', 'Touch ID', 'iCloud Keychain', 'Security keys'];

export const PasskeyLoginPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const nonce = searchParams.get('nonce');
  // Electron-originated flow when a nonce is present. We require an explicit
  // user click to start WebAuthn (auto-firing in a background browser tab
  // silently completes with cached platform credentials and confuses the user)
  // and trigger the howl:// deep link via a programmatic anchor click on success.
  const isElectronFlow = !!nonce;

  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const [challengeData, setChallengeData] = useState<{ options: any; challengeToken: string } | null>(null);
  // Cached SSO code so the user can re-fire the deep link from the success state
  // (in case Chrome's "external protocol" prompt was dismissed or auto-deny is set).
  const [ssoCode, setSsoCode] = useState<string | null>(null);

  // Programmatic anchor click is the right way to fire an OS protocol handler from JS:
  //   - Preserves user-activation context (matters in modern Chromium).
  //   - Doesn't navigate the current tab away — the browser tries to navigate to a
  //     URL with no http response, the OS handler intercepts, and the tab stays.
  //   - iframe.src is silently blocked for custom protocols in modern Chromium —
  //     do NOT use that approach (we tried, it breaks the deep link).
  const fireElectronCallback = useCallback((code: string, n: string) => {
    const url = `howl://auth/callback?code=${encodeURIComponent(code)}&nonce=${encodeURIComponent(n)}`;
    try {
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener noreferrer';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      // Hard fallback. May briefly navigate the tab — acceptable, the protocol
      // handler still fires and Electron signs in.
      window.location.href = url;
    }
  }, []);

  const handleVerify = useCallback(async (challengeToken: string, credential: any) => {
    setState('verifying');
    try {
      const { code } = await apiClient.passkeyLoginForCode(challengeToken, credential);
      setSsoCode(code);
      setState('success');
      if (nonce) {
        fireElectronCallback(code, nonce);
      } else {
        await apiClient.exchangeSsoCode(code);
        navigate('/home', { replace: true });
      }
    } catch (err: any) {
      setError(err?.message || 'Authentication failed');
      setState('error');
    }
  }, [nonce, navigate, fireElectronCallback]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        setState('loading');
        const data = await apiClient.passkeyLoginOptions();
        if (cancelled) return;
        setChallengeData(data);

        if (isElectronFlow) {
          // Require explicit user click. The Electron app launched this tab via
          // shell.openExternal — the browser is likely backgrounded, and silently
          // auto-completing the WebAuthn ceremony with a cached platform credential
          // (Windows Hello passive PIN, etc.) makes it look like nothing happened.
          setState('manual');
          return;
        }

        // Web flow (user opened /auth/passkey-login directly): auto-trigger the
        // ceremony as before so the OS picker pops without an extra click.
        setState('authenticating');
        const { startAuthentication } = await import('@simplewebauthn/browser');
        const credential = await startAuthentication({ optionsJSON: data.options as PublicKeyCredentialRequestOptionsJSON });
        if (!cancelled) await handleVerify(data.challengeToken, credential);
      } catch (err: any) {
        if (cancelled) return;
        if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
          setState('manual');
        } else {
          setError(err?.message || 'Authentication failed');
          setState('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [handleVerify, isElectronFlow]);

  const handleManualTrigger = async () => {
    if (!challengeData) return;
    try {
      setState('authenticating');
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const credential = await startAuthentication({ optionsJSON: challengeData.options as PublicKeyCredentialRequestOptionsJSON });
      await handleVerify(challengeData.challengeToken, credential);
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
        setState('manual');
      } else {
        setError(err?.message || 'Authentication failed');
        setState('error');
      }
    }
  };

  const handleRetry = async () => {
    setError(null);
    setState('loading');
    try {
      const data = await apiClient.passkeyLoginOptions();
      setChallengeData(data);
      setState('manual');
    } catch (err: any) {
      setError(err?.message || 'Failed to start authentication');
      setState('error');
    }
  };

  const renderStatus = () => {
    switch (state) {
      case 'loading':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 size={28} className="animate-spin" style={{ color: '#076FA0' }} />
            <p className="text-sm" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>Preparing passkey authentication...</p>
          </div>
        );
      case 'authenticating':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 size={28} className="animate-spin" style={{ color: '#076FA0' }} />
            <p className="text-sm" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>Waiting for passkey...</p>
          </div>
        );
      case 'verifying':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 size={28} className="animate-spin" style={{ color: '#076FA0' }} />
            <p className="text-sm" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>Verifying...</p>
          </div>
        );
      case 'success':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 size={32} style={{ color: '#4ade80' }} />
            <p className="text-sm font-semibold" style={{ color: '#4ade80' }}>Authenticated!</p>
            {nonce ? (
              <>
                <p className="text-xs text-center" style={{ color: 'rgba(148, 163, 184, 0.85)' }}>
                  Returning to Howl Desktop... if it doesn't open, click below.
                </p>
                <button
                  type="button"
                  onClick={() => { if (ssoCode && nonce) fireElectronCallback(ssoCode, nonce); }}
                  disabled={!ssoCode}
                  className="btn-cta mt-1 px-4 py-2 rounded-xl text-sm transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  <LockKeyhole size={14} />
                  Open Howl Desktop
                </button>
                <button
                  type="button"
                  onClick={() => { try { window.close(); } catch { /* blocked by browser */ } }}
                  className="text-xs px-3 py-1 rounded-md transition-colors hover:underline"
                  style={{ color: 'rgba(148, 163, 184, 0.7)' }}
                >
                  Close this tab
                </button>
              </>
            ) : (
              <p className="text-xs" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>Redirecting...</p>
            )}
          </div>
        );
      case 'manual':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <button
              type="button"
              onClick={handleManualTrigger}
              className="btn-cta w-full py-3 rounded-xl text-sm transition-all flex items-center justify-center gap-2"
            >
              <LockKeyhole size={16} />
              Click to authenticate with passkey
            </button>
            <p className="text-xs text-center" style={{ color: 'rgba(148, 163, 184, 0.6)' }}>
              Don't see a dialog? Check if your browser supports passkeys.
            </p>
          </div>
        );
      case 'error':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <AlertCircle size={28} style={{ color: '#f87171' }} />
            <p className="text-sm text-center" style={{ color: '#fca5a5' }}>{error}</p>
            <button
              type="button"
              onClick={handleRetry}
              className="btn-cta px-5 py-2 rounded-xl text-sm transition-colors"
            >
              Try again
            </button>
          </div>
        );
      default:
        return null;
    }
  };

  return (
    <div
      className="relative flex h-full w-full items-center justify-center overflow-hidden px-4 py-8"
      style={{ backgroundColor: 'var(--bg-app)' }}
    >
      {/* Background orbs — radial-gradient alone produces the soft glow. */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden>
        <div
          className="absolute top-[15%] left-[10%] w-[600px] h-[600px] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(7,111,160,0.06) 0%, transparent 65%)',
          }}
        />
        <div
          className="absolute bottom-[10%] right-[10%] w-[500px] h-[500px] rounded-full"
          style={{
            background: 'radial-gradient(circle, rgba(139,92,246,0.05) 0%, transparent 65%)',
          }}
        />
      </div>
      <div
        className="absolute inset-0 pointer-events-none"
        style={{ background: 'radial-gradient(ellipse at center, transparent 50%, rgba(2,6,23,0.7) 100%)' }}
      />

      <div className="relative w-full max-w-[420px] z-10">
        {/* Logo + heading */}
        <div className="flex flex-col items-center mb-8">
          <div className="relative mb-4">
            <div
              className="absolute inset-0 rounded-2xl blur-xl opacity-40"
              style={{ background: 'linear-gradient(135deg, #076FA0, #003E5D)' }}
            />
            <img
              src={assetPath('/howl-logo.png')}
              alt="Howl"
              className="relative h-16 w-16 sm:h-20 sm:w-20 rounded-lg object-cover"
              decoding="async"
            />
          </div>
          <h1
            className="font-clash text-2xl font-semibold tracking-[-0.02em]"
            style={{ color: '#f1f5f9' }}
          >
            {isElectronFlow ? 'Sign in to Howl Desktop' : 'Sign in with passkey'}
          </h1>
          <p className="text-sm mt-1 text-center" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>
            {isElectronFlow
              ? 'Click below to authenticate with your passkey, then return to the desktop app'
              : "Your browser's passkey dialog should appear automatically"}
          </p>
        </div>

        {/* Glass card */}
        <div
          className="rounded-2xl border p-6 sm:p-8 backdrop-blur-xl"
          style={{
            backgroundColor: 'rgba(15, 23, 42, 0.6)',
            border: '1px solid rgba(7, 111, 160, 0.1)',
            boxShadow: '0 0 60px rgba(7, 111, 160, 0.04), 0 25px 50px rgba(0, 0, 0, 0.35)',
          }}
        >
          {/* Provider chips */}
          <div className="flex flex-wrap justify-center gap-2 mb-6">
            {providers.map(p => (
              <span
                key={p}
                className="text-[10px] font-medium px-2.5 py-1 rounded-full"
                style={{
                  backgroundColor: 'rgba(7, 111, 160, 0.08)',
                  color: 'rgba(148, 163, 184, 0.8)',
                  border: '1px solid rgba(7, 111, 160, 0.12)',
                }}
              >
                {p}
              </span>
            ))}
          </div>

          {/* Status area */}
          {renderStatus()}

          {/* Back to sign in */}
          <div className="mt-6 pt-4 text-center" style={{ borderTop: '1px solid rgba(255, 255, 255, 0.06)' }}>
            <Link
              to="/login"
              className="inline-flex items-center gap-1.5 text-xs font-medium transition-colors hover:underline"
              style={{ color: '#076FA0' }}
            >
              <ArrowLeft size={12} />
              Back to sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
};
