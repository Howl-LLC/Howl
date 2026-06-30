// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { LockKeyhole, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { getBackendOrigin } from '../../config';
import { assetPath } from '../../utils/assetPath';

type Step = 'validating' | 'create' | 'naming' | 'saving' | 'success' | 'error';

export const PasskeyRegisterPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const sessionToken = searchParams.get('session');
  const nonce = searchParams.get('nonce');

  const [step, setStep] = useState<Step>('validating');
  const [error, setError] = useState<string | null>(null);
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [registerOptions, setRegisterOptions] = useState<any>(null);
  const [credential, setCredential] = useState<any>(null);
  const [passkeyName, setPasskeyName] = useState('');

  // Validate session on mount
  useEffect(() => {
    if (!sessionToken) {
      setError('Missing session token. Please start passkey registration from the Howl app.');
      setStep('error');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const base = getBackendOrigin();
        const res = await fetch(`${base}/api/v1/auth/mfa/passkey/browser-register-options`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionToken }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Session expired');
        }
        const data = await res.json();
        if (cancelled) return;
        setChallengeToken(data.challengeToken);
        setRegisterOptions(data.options);
        setStep('create');
      } catch (err: any) {
        if (cancelled) return;
        setError(err?.message || 'Invalid session. Please try again from the Howl app.');
        setStep('error');
      }
    })();
    return () => { cancelled = true; };
  }, [sessionToken]);

  const handleCreate = async () => {
    try {
      setStep('validating');
      const { startRegistration } = await import('@simplewebauthn/browser');
      const cred = await startRegistration({ optionsJSON: registerOptions as PublicKeyCredentialCreationOptionsJSON });
      setCredential(cred);
      setStep('naming');
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
        setStep('create');
      } else {
        setError(err?.message || 'Passkey creation failed');
        setStep('error');
      }
    }
  };

  const handleSave = async () => {
    if (!credential || !challengeToken || !sessionToken) return;
    setStep('saving');
    try {
      const base = getBackendOrigin();
      const res = await fetch(`${base}/api/v1/auth/mfa/passkey/browser-register-verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionToken,
          challengeToken,
          credential,
          name: passkeyName.trim() || 'My Passkey',
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Registration failed');
      }
      setStep('success');
      if (nonce) {
        setTimeout(() => {
          window.location.href = `howl://settings/callback?passkey_registered=true&nonce=${encodeURIComponent(nonce)}`;
        }, 2000);
      }
    } catch (err: any) {
      setError(err?.message || 'Failed to save passkey');
      setStep('error');
    }
  };

  const handleRetry = () => {
    setError(null);
    if (sessionToken) {
      setStep('validating');
      (async () => {
        try {
          const base = getBackendOrigin();
          const res = await fetch(`${base}/api/v1/auth/mfa/passkey/browser-register-options`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionToken }),
          });
          if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || 'Session expired');
          }
          const data = await res.json();
          setChallengeToken(data.challengeToken);
          setRegisterOptions(data.options);
          setStep('create');
        } catch (err: any) {
          setError(err?.message || 'Invalid session. Please try again from the Howl app.');
          setStep('error');
        }
      })();
    } else {
      setError('Missing session token. Please start passkey registration from the Howl app.');
      setStep('error');
    }
  };

  const stepNumber = step === 'create' || step === 'validating' ? 1 : step === 'naming' || step === 'saving' ? 2 : null;

  const renderContent = () => {
    switch (step) {
      case 'validating':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 size={28} className="animate-spin" style={{ color: '#076FA0' }} />
            <p className="text-sm" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>Validating session...</p>
          </div>
        );

      case 'create':
        return (
          <div className="flex flex-col items-center gap-4 py-2">
            <h2 className="font-clash text-xl font-semibold tracking-[-0.02em] text-center" style={{ color: '#f1f5f9' }}>
              Create your passkey
            </h2>
            <p className="text-sm text-center" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>
              Click below to create a passkey using your device's authenticator
            </p>
            <button
              type="button"
              onClick={handleCreate}
              className="btn-cta w-full py-3 rounded-xl text-sm transition-all flex items-center justify-center gap-2 mt-2"
            >
              <LockKeyhole size={16} />
              Create passkey
            </button>
          </div>
        );

      case 'naming':
        return (
          <div className="flex flex-col gap-4 py-2">
            <div className="text-center">
              <h2 className="font-clash text-xl font-semibold tracking-[-0.02em]" style={{ color: '#f1f5f9' }}>
                Name your passkey
              </h2>
              <p className="text-sm mt-1" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>
                Give it a friendly name so you can identify it later
              </p>
            </div>
            <input
              type="text"
              value={passkeyName}
              onChange={e => setPasskeyName(e.target.value)}
              placeholder="e.g. MacBook Pro, iPhone 15"
              className="w-full px-4 py-3 rounded-xl text-sm outline-none transition-all focus:ring-1"
              style={{
                backgroundColor: 'rgba(30, 41, 59, 0.5)',
                border: '1px solid rgba(255, 255, 255, 0.06)',
                color: '#f1f5f9',
              }}
              onFocus={e => {
                e.currentTarget.style.borderColor = 'rgba(7, 111, 160, 0.3)';
                e.currentTarget.style.boxShadow = '0 0 0 2px rgba(7, 111, 160, 0.08)';
              }}
              onBlur={e => {
                e.currentTarget.style.borderColor = 'rgba(255, 255, 255, 0.06)';
                e.currentTarget.style.boxShadow = 'none';
              }}
              autoFocus
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            />
            <button
              type="button"
              onClick={handleSave}
              className="btn-cta w-full py-3 rounded-xl text-sm transition-all flex items-center justify-center gap-2"
            >
              Save passkey
            </button>
          </div>
        );

      case 'saving':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <Loader2 size={28} className="animate-spin" style={{ color: '#076FA0' }} />
            <p className="text-sm" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>Saving passkey...</p>
          </div>
        );

      case 'success':
        return (
          <div className="flex flex-col items-center gap-3 py-4">
            <CheckCircle2 size={40} style={{ color: '#4ade80' }} />
            <h2 className="font-clash text-xl font-semibold tracking-[-0.02em]" style={{ color: '#4ade80' }}>
              Passkey registered!
            </h2>
            <p className="text-sm text-center" style={{ color: 'rgba(148, 163, 184, 0.8)' }}>
              {nonce ? 'Returning to Howl...' : 'You can close this tab.'}
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
              className="btn-cta px-5 py-2 rounded-xl text-sm font-medium transition-colors"
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

          {/* Step indicator */}
          {stepNumber && (
            <span
              className="text-[10px] font-semibold uppercase tracking-widest mb-2"
              style={{ color: '#076FA0' }}
            >
              Step {stepNumber} of 2
            </span>
          )}
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
          {renderContent()}
        </div>
      </div>
    </div>
  );
};
