// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate, Link } from 'react-router-dom';
import { LockKeyhole, Loader2, AlertCircle, CheckCircle2, ArrowLeft } from 'lucide-react';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { apiClient } from '../../services/api';
import { getBackendOrigin } from '../../config';
import { assetPath } from '../../utils/assetPath';

type State = 'loading' | 'authenticating' | 'verifying' | 'success' | 'error' | 'manual';

const providers = ['Windows Hello', 'Touch ID', 'iCloud Keychain', 'Security keys'];

/** Consume the opaque session ID to recover the mfaToken from Redis (single-use). */
async function consumeMfaSession(sessionId: string): Promise<string> {
  const base = getBackendOrigin();
  const res = await fetch(`${base}/api/auth/mfa/passkey/consume-mfa-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  if (!res.ok) throw new Error('Invalid or expired session');
  const data = await res.json();
  return data.mfaToken;
}

export const PasskeyMfaPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  // Capture params from URL before cleaning — refs survive the replaceState
  const sessionIdRef = useRef(searchParams.get('session'));
  const nonceRef = useRef(searchParams.get('nonce'));

  // Resolved mfaToken from Redis (not in URL)
  const mfaTokenRef = useRef<string | null>(null);

  const [state, setState] = useState<State>('loading');
  const [error, setError] = useState<string | null>(null);
  const [challengeData, setChallengeData] = useState<{ options: any; challengeToken: string } | null>(null);

  // Immediately clean session ID from URL/browser history
  useEffect(() => {
    window.history.replaceState({}, '', window.location.pathname);
  }, []);

  const handleVerify = useCallback(async (challengeToken: string, credential: any) => {
    setState('verifying');
    try {
      const { code } = await apiClient.passkeyMfaVerifyForCode(challengeToken, credential);
      setState('success');
      if (nonceRef.current) {
        window.location.href = `howl://auth/callback?code=${encodeURIComponent(code)}&nonce=${encodeURIComponent(nonceRef.current)}`;
      } else {
        await apiClient.exchangeSsoCode(code);
        navigate('/home', { replace: true });
      }
    } catch (err: any) {
      setError(err?.message || 'Verification failed');
      setState('error');
    }
  }, [navigate]);

  // Consume session + auto-trigger passkey on mount
  useEffect(() => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      setError('Invalid session. Please try signing in again from the Howl app.');
      setState('error');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setState('loading');
        // Exchange opaque session ID for mfaToken (single-use, from Redis)
        const mfaToken = await consumeMfaSession(sessionId);
        if (cancelled) return;
        mfaTokenRef.current = mfaToken;

        const data = await apiClient.mfaPasskeyAuthOptions(mfaToken);
        if (cancelled) return;
        setChallengeData(data);
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
  }, [handleVerify]);

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
    const mfaToken = mfaTokenRef.current;
    if (!mfaToken) {
      setError('Session expired. Please try signing in again.');
      setState('error');
      return;
    }
    setError(null);
    setState('loading');
    try {
      const data = await apiClient.mfaPasskeyAuthOptions(mfaToken);
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
            <p className="text-xs" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>
              {nonceRef.current ? 'Returning to Howl...' : 'Redirecting...'}
            </p>
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
            Verify your identity
          </h1>
          <p className="text-sm mt-1 text-center" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>
            Complete your sign-in with a passkey
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
