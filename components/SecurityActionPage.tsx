// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect, useRef, useState } from 'react';
import { ShieldAlert, CheckCircle2, AlertTriangle } from 'lucide-react';
import { apiClient } from '../services/api';

type SecurityAction = 'revoke-sessions' | 'email-revert';

interface SecurityActionPageProps {
  action: SecurityAction;
}

/* ──────────────────────────────────────────────────────────────────────────
   Landing page for the one-click links in security emails:
     • "Sign out of all sessions"  → /revoke-sessions?token=…   (new-device alert)
     • "Revert email change"       → /email-revert?token=…      (email-change alert)

   These render OUTSIDE the auth gate (see App.tsx): the recipient may not be
   logged in (an attacker may have changed the password), and the whole point
   of a "this wasn't me" action is to act without first signing in. The signed
   token in the URL is the authentication signal; the backend verifies it.

   The action is NEVER fired automatically on mount — email scanners and
   link-preview bots prefetch URLs, which would silently nuke sessions. It
   requires an explicit button press. Visual style matches CreditsPage /
   LegalPage: a quiet, system-font document, not a marketing surface.
   ────────────────────────────────────────────────────────────────────────── */

const COPY: Record<SecurityAction, {
  title: string;
  intro: string;
  button: string;
  busy: string;
  success: string;
}> = {
  'revoke-sessions': {
    title: 'Sign out of all sessions',
    intro:
      "If you didn't just sign in to Howl from a new device, sign out of every device on your account, then sign back in and change your password.",
    button: 'Sign out of all sessions',
    busy: 'Signing out…',
    success:
      'Every session on your account has been signed out. Sign in again and change your password to keep your account secure.',
  },
  'email-revert': {
    title: 'Revert email change',
    intro:
      "If you didn't change the email address on your Howl account, undo the change below. This also signs out every device. You'll then sign in and set your email again.",
    button: 'Revert email change',
    busy: 'Reverting…',
    success:
      'The email change has been reverted and all sessions signed out. Sign in and set a new email address.',
  },
};

export const SecurityActionPage: React.FC<SecurityActionPageProps> = ({ action }) => {
  const copy = COPY[action];
  const [token] = useState<string>(() => {
    try {
      return new URLSearchParams(window.location.search).get('token') ?? '';
    } catch {
      return '';
    }
  });
  const [status, setStatus] = useState<'idle' | 'working' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  const linkRef = useRef<HTMLAnchorElement>(null);

  const tokenMissing = !token;
  const showLink = status === 'done' || tokenMissing;

  useEffect(() => {
    document.title = `Howl | ${copy.title}`;
  }, [copy.title]);

  // Move keyboard/AT focus to the actionable control as state changes: the
  // confirm button while idle, then the "Go to sign in" link once we're done.
  useEffect(() => {
    if (status === 'idle' && token) buttonRef.current?.focus();
    else if (status === 'done') linkRef.current?.focus();
  }, [status, token]);

  const run = async (): Promise<void> => {
    if (!token || status === 'working') return;
    setStatus('working');
    setErrorMsg('');
    try {
      if (action === 'revoke-sessions') {
        await apiClient.revokeSessions(token);
      } else {
        await apiClient.revertEmail(token);
      }
      // All sessions are now invalid server-side; drop the local token so this
      // device is signed out too, and the next load lands on the sign-in page.
      apiClient.clearToken();
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
      setStatus('error');
    }
  };

  return (
    <div
      className="h-screen overflow-y-auto"
      style={{
        background: 'var(--bg-app)',
        color: 'var(--text-secondary)',
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        lineHeight: 1.7,
        padding: '2rem',
      }}
    >
      <main style={{ maxWidth: 480, margin: '8vh auto 0', textAlign: 'center' }}>
        <div aria-hidden="true" style={{ display: 'flex', justifyContent: 'center', marginBottom: '1.25rem' }}>
          {status === 'done'
            ? <CheckCircle2 size={40} style={{ color: 'var(--cyan-accent, #38bdf8)' }} />
            : status === 'error' || tokenMissing
              ? <AlertTriangle size={40} style={{ color: '#f87171' }} />
              : <ShieldAlert size={40} style={{ color: 'var(--text-primary)' }} />}
        </div>

        <h1 style={{ color: 'var(--text-primary)', fontSize: '1.5rem', marginBottom: '0.75rem' }}>
          {copy.title}
        </h1>

        {/* Persistent live region (present from first paint) so screen readers
            reliably announce the result text when it changes. */}
        <p role="status" aria-live="polite" style={{ fontSize: '0.95rem', margin: 0 }}>
          {tokenMissing ? (
            'This link is invalid or incomplete. Open the most recent security email from Howl and use the button there again.'
          ) : status === 'done' ? (
            copy.success
          ) : status === 'error' ? (
            <>
              {errorMsg || 'This link is invalid or has expired.'} If you keep seeing this, request a new email or contact{' '}
              <a href="mailto:support@howlpro.com" style={{ color: 'var(--cyan-accent, #38bdf8)' }}>support@howlpro.com</a>.
            </>
          ) : (
            copy.intro
          )}
        </p>

        <div style={{ marginTop: '1.75rem' }}>
          {showLink ? (
            <a
              ref={linkRef}
              href="/login"
              style={{
                display: 'inline-block',
                padding: '0.7rem 1.6rem',
                borderRadius: 12,
                background: '#02385A',
                color: '#fff',
                fontSize: '0.95rem',
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Go to sign in
            </a>
          ) : (
            <button
              ref={buttonRef}
              type="button"
              onClick={run}
              disabled={status === 'working'}
              style={{
                padding: '0.7rem 1.6rem',
                borderRadius: 12,
                background: status === 'working' ? 'var(--surface-2, #1e293b)' : '#02385A',
                color: '#fff',
                fontSize: '0.95rem',
                fontWeight: 600,
                border: 'none',
                cursor: status === 'working' ? 'default' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {status === 'working' ? copy.busy : copy.button}
            </button>
          )}
        </div>
      </main>
    </div>
  );
};
