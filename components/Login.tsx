// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '../services/api';
import { getBackendOrigin, API_BASE_URL, isElectron as detectElectron } from '../config';
import type { User } from '../types';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { Eye, EyeOff, ArrowRight, WifiOff, Loader2, Check, X, Smartphone, Key, MessageSquare, LockKeyhole, ShieldCheck, Mail } from 'lucide-react';
import { DatePicker } from './DatePicker';
import { assetPath } from '../utils/assetPath';
import { useAppStore } from '../stores/appStore';
import { registrationOpen } from '../shared/instanceConfig';
import {
  TERMS_SUMMARY_CLAUSES,
  TERMS_SUMMARY_INTRO,
  TERMS_SUMMARY_LAST_UPDATED,
  TERMS_SUMMARY_EFFECTIVE_DATE,
  TERMS_SUMMARY_FULL_LINK_HREF,
  TERMS_SUMMARY_FULL_LINK_LABEL,
  TERMS_SUMMARY_SUPPORT_EMAIL,
} from '../src/legal/termsSummary';

const TURNSTILE_SITE_KEY = import.meta.env?.VITE_TURNSTILE_SITE_KEY ?? '';

function PasswordStrength({ password }: { password: string }) {
  const { t } = useTranslation();
  const checks = [
    { label: t('login.passwordStrength12Chars'), ok: password.length >= 12 },
    { label: t('login.passwordStrengthUppercase'), ok: /[A-Z]/.test(password) },
    { label: t('login.passwordStrengthNumber'), ok: /[0-9]/.test(password) },
    { label: t('login.passwordStrengthSymbol'), ok: /[^A-Za-z0-9]/.test(password) },
  ];
  const passed = checks.filter((c) => c.ok).length;
  const colors = ['var(--danger)', 'var(--warning)', 'var(--warning)', 'var(--success)'];
  const barColor = passed === 0 ? 'rgba(51,65,85,0.5)' : colors[passed - 1];

  if (!password) return null;
  return (
    <div className="mt-2 space-y-1.5">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-1 flex-1 rounded-full transition-colors duration-200" style={{ backgroundColor: i < passed ? barColor : 'rgba(51,65,85,0.3)' }} />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        {checks.map((c) => (
          <div key={c.label} className="flex items-center gap-1 text-[10px]" style={{ color: c.ok ? 'var(--success)' : 'rgba(255,255,255,0.5)' }}>
            {c.ok ? <Check size={10} /> : <X size={10} />}
            {c.label}
          </div>
        ))}
      </div>
    </div>
  );
}

function TurnstileWidget({ onToken, resetKey }: { onToken: (token: string) => void; resetKey?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetId = useRef<string | null>(null);

  useEffect(() => {
    if (!widgetId.current || !window.turnstile) return;
    window.turnstile.reset(widgetId.current);
    onToken('');
  }, [resetKey]);

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !containerRef.current) return;

    const tryRender = () => {
      if (!window.turnstile || widgetId.current) return;
      widgetId.current = window.turnstile.render(containerRef.current!, {
        sitekey: TURNSTILE_SITE_KEY,
        callback: onToken,
        'expired-callback': () => onToken(''),
        theme: 'dark',
      });
    };

    if (window.turnstile) {
      tryRender();
    } else {
      // Load script if not already loaded
      if (!document.querySelector('script[src*="turnstile"]')) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => setTimeout(tryRender, 100);
        document.head.appendChild(script);
      } else {
        const iv = setInterval(() => { if (window.turnstile) { clearInterval(iv); tryRender(); } }, 100);
        return () => clearInterval(iv);
      }
    }

    return () => {
      if (widgetId.current && window.turnstile) {
        try { window.turnstile.remove(widgetId.current); } catch { /* ignored */ }
        widgetId.current = null;
      }
    };
  }, [onToken]);

  if (!TURNSTILE_SITE_KEY) return null;
  return <div ref={containerRef} className="flex justify-center mt-3" />;
}

const isElectron = detectElectron();

function SsoButtons() {
  const { t } = useTranslation();
  const backend = getBackendOrigin();
  const cls = "btn-secondary flex items-center justify-center gap-2 px-3 py-2.5 text-xs";

  function SsoLink({ provider, icon, label }: { provider: string; icon: string; label: string }) {
    if (isElectron) {
      return (
        <button type="button" onClick={() => (window as any).electron?.startSso?.(provider)} className={cls}>
          <img src={assetPath(icon)} alt={label} className="w-7 h-7 rounded-full" decoding="async" width={28} height={28} />
          {label}
        </button>
      );
    }
    return (
      <a href={`${backend}/api/auth/sso/${provider}`} className={cls}>
        <img src={assetPath(icon)} alt={label} className="w-7 h-7 rounded-full" decoding="async" width={28} height={28} />
        {label}
      </a>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-center gap-3 my-5">
        <div className="flex-1 h-px bg-[var(--glass-border)]" />
        <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-t-secondary/40">{t('login.orContinueWith')}</span>
        <div className="flex-1 h-px bg-[var(--glass-border)]" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <SsoLink provider="google" icon="/sso-google.svg" label={t('login.google')} />
        <SsoLink provider="apple" icon="/sso-apple.svg" label={t('login.apple')} />
        <SsoLink provider="steam" icon="/sso-steam.svg" label={t('login.steam')} />
      </div>
    </div>
  );
}

interface LoginProps {
  onAuthSuccess: (user: User, loginPassword?: string) => void;
}

type BackendStatus = { status: 'checking' } | { status: 'ok'; db?: string } | { status: 'error'; message: string };

export const Login: React.FC<LoginProps> = ({ onAuthSuccess }) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [backendStatus, setBackendStatus] = useState<BackendStatus>({ status: 'checking' });
  const [captchaToken, setCaptchaToken] = useState<string>('');
  const [captchaResetKey, setCaptchaResetKey] = useState(0);
  const [agreedToTerms, setAgreedToTerms] = useState(false);
  const [parentalConsentAcknowledged, setParentalConsentAcknowledged] = useState(false);
  const [showTerms, setShowTerms] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [setupToken, setSetupToken] = useState('');

  const instanceConfig = useAppStore(s => s.instanceConfig);
  const registrationClosed = !registrationOpen(instanceConfig) && !instanceConfig?.needsBootstrap;
  useEffect(() => { if (registrationClosed && mode === 'register') setMode('login'); }, [registrationClosed, mode]);

  // Compute age from `dateOfBirth` for the parental-consent gate (13–17).
  // Empty / unparseable string returns null; the consent checkbox is only
  // rendered when age resolves to a number in [13, 17].
  const computedAge: number | null = (() => {
    if (!dateOfBirth) return null;
    const dob = new Date(dateOfBirth + 'T00:00:00Z');
    if (isNaN(dob.getTime())) return null;
    const today = new Date();
    let age = today.getUTCFullYear() - dob.getUTCFullYear();
    const m = today.getUTCMonth() - dob.getUTCMonth();
    if (m < 0 || (m === 0 && today.getUTCDate() < dob.getUTCDate())) age--;
    return age;
  })();
  const requiresParentalConsent = computedAge !== null && computedAge >= 13 && computedAge < 18;

  // Email verification state
  const [verifyStep, setVerifyStep] = useState(false);
  const [verifyUserId, setVerifyUserId] = useState('');
  const [verifyCode, setVerifyCode] = useState('');
  const [resendCooldown, setResendCooldown] = useState(0);

  // MFA state
  const [mfaStep, setMfaStep] = useState(false);
  const [mfaToken, setMfaToken] = useState('');
  const [mfaMethods, setMfaMethods] = useState<string[]>([]);
  const [mfaMethod, setMfaMethod] = useState<'totp' | 'passkey' | 'sms' | 'recovery'>('totp');
  const [mfaCode, setMfaCode] = useState('');
  const mediationAbortRef = useRef<AbortController | null>(null);
  const [smsSent, setSmsSent] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState('');

  // Device-verification state (new-device login challenge for no-MFA users)
  const [deviceVerifyStep, setDeviceVerifyStep] = useState(false);
  const [deviceVerifyToken, setDeviceVerifyToken] = useState('');
  const [deviceVerifyMethods, setDeviceVerifyMethods] = useState<string[]>([]);
  const [deviceVerifyMethod, setDeviceVerifyMethod] = useState<'email' | 'sms'>('email');
  const [deviceVerifyEmailMasked, setDeviceVerifyEmailMasked] = useState('');
  const [deviceVerifyCode, setDeviceVerifyCode] = useState('');
  const [deviceVerifyTrust, setDeviceVerifyTrust] = useState(true);
  const [deviceResendCooldown, setDeviceResendCooldown] = useState(0);

  // SSO → MFA handoff: SsoCallback writes the mfaToken/methods here when the
  // SSO-matched account is MFA-enrolled. Consume + clear on mount so
  // refreshing the login page doesn't resurrect a stale challenge.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem('howl_sso_mfa');
      if (!raw) return;
      sessionStorage.removeItem('howl_sso_mfa');
      const parsed = JSON.parse(raw) as { mfaToken?: string; methods?: string[]; ts?: number };
      if (!parsed.mfaToken || !Array.isArray(parsed.methods)) return;
      if (!parsed.ts || Date.now() - parsed.ts > 5 * 60 * 1000) return;
      setMfaToken(parsed.mfaToken);
      setMfaMethods(parsed.methods);
      setMfaMethod(parsed.methods.includes('totp') ? 'totp' : parsed.methods.includes('passkey') ? 'passkey' : parsed.methods.includes('sms') ? 'sms' : 'recovery');
      setMfaStep(true);
    } catch { /* best-effort handoff */ }
  }, []);

  // Electron SSO callback listener
  useEffect(() => {
    if (!isElectron) return;
    const cleanup = (window as any).electron?.onSsoCallback?.((data: { code?: string; error?: string }) => {
      if (data.error) {
        const knownErrors: Record<string, string> = {
          sso_failed: t('sso.ssoFailed'),
          invalid_state: t('sso.invalidState'),
          access_denied: t('sso.accessDenied'),
          email_exists: t('sso.emailExists'),
          suspended: t('sso.suspended'),
        };
        setError(knownErrors[data.error] ?? t('sso.authFailed'));
        return;
      }
      if (data.code) {
        setIsLoading(true);
        apiClient.exchangeSsoCode(data.code)
          .then((result) => {
            if ('mfaRequired' in result && result.mfaRequired) {
              // SSO login on an MFA-enrolled account — drop into the same
              // MFA step as password login. /totp/verify (or passkey/sms)
              // mints the session after the second factor.
              setMfaToken(result.mfaToken);
              setMfaMethods(result.methods);
              const methods = result.methods;
              const hasNonPasskey = methods.includes('totp') || methods.includes('sms');
              if (isElectron && !hasNonPasskey && methods.includes('passkey')) {
                (window as any).electron?.startPasskeyMfa?.(result.mfaToken);
                return;
              }
              setMfaMethod(methods.includes('totp') ? 'totp' : methods.includes('passkey') ? 'passkey' : methods.includes('sms') ? 'sms' : 'recovery');
              setMfaStep(true);
            } else if ('user' in result && result.user) {
              onAuthSuccess(result.user);
            } else {
              setError(t('sso.failedToComplete'));
            }
          })
          .catch((e: Error) => {
            setError(e?.message || t('sso.failedToComplete'));
          })
          .finally(() => setIsLoading(false));
      }
    });
    return cleanup;
  }, []);

  // MFA timeout: clear MFA state after 5 minutes of inactivity
  useEffect(() => {
    if (!mfaStep) return;
    const timeout = setTimeout(() => {
      setMfaStep(false);
      setMfaToken('');
      setMfaCode('');
      setSmsSent(false);
      setRecoveryCode('');
      setError(t('login.mfaTimeout', 'Verification timed out. Please log in again.'));
    }, 5 * 60 * 1000);
    return () => clearTimeout(timeout);
  }, [mfaStep, t]);

  // Forgot password state
  const [forgotStep, setForgotStep] = useState<'email' | 'code' | 'success' | null>(null);
  const [forgotEmail, setForgotEmail] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    const tm = setTimeout(() => controller.abort(), 8000);
    fetch(`${API_BASE_URL}/health`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data: { status?: string; db?: string; error?: string }) => {
        clearTimeout(tm);
        if (data.db === 'connected') {
          setBackendStatus({ status: 'ok', db: 'connected' });
        } else if (data.db === 'error') {
          setBackendStatus({ status: 'error', message: data.error || t('login.dbUnreachable') });
        } else {
          setBackendStatus({ status: 'ok' });
        }
      })
      .catch((err) => {
        clearTimeout(tm);
        const msg = err.name === 'AbortError' ? t('login.backendTimeout') : (err?.message || t('login.backendUnreachable'));
        setBackendStatus({ status: 'error', message: msg });
      });
    return () => { controller.abort(); clearTimeout(tm); };
  }, []);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const iv = setInterval(() => setResendCooldown((c) => c - 1), 1000);
    return () => clearInterval(iv);
  }, [resendCooldown]);

  // Device-verify resend cooldown timer
  useEffect(() => {
    if (deviceResendCooldown <= 0) return;
    const iv = setInterval(() => setDeviceResendCooldown((c) => c - 1), 1000);
    return () => clearInterval(iv);
  }, [deviceResendCooldown]);

  // Device-verify timeout — mirror the 5-min MFA guard so a stale verifyToken
  // doesn't keep the user stuck on this screen after it silently expired.
  useEffect(() => {
    if (!deviceVerifyStep) return;
    const timeout = setTimeout(() => {
      setDeviceVerifyStep(false);
      setDeviceVerifyToken('');
      setDeviceVerifyCode('');
      setError(t('login.mfaTimeout', 'Verification timed out. Please log in again.'));
    }, 5 * 60 * 1000);
    return () => clearTimeout(timeout);
  }, [deviceVerifyStep, t]);

  // Clear field errors when switching modes
  useEffect(() => { setFieldErrors({}); }, [mode]);

  // Client-side pre-validation with 500ms debounce (register mode only)
  const validateField = useCallback((field: string, value: string) => {
    let msg = '';
    switch (field) {
      case 'username':
        if (value && (value.length < 2 || value.length > 32)) {
          msg = value.length < 2 ? t('login.fieldErrorUsernameMin', 'Username must be at least 2 characters') : t('login.fieldErrorUsernameMax', 'Username must be at most 32 characters');
        }
        break;
      case 'email':
        if (value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          msg = t('login.fieldErrorEmail', 'Invalid email address');
        }
        break;
      case 'password':
        if (value && value.length < 12) {
          msg = t('login.fieldErrorPasswordMin', 'Password must be at least 12 characters');
        }
        break;
    }
    setFieldErrors((prev) => {
      if (!msg) {
        if (!prev[field]) return prev;
        const next = { ...prev };
        delete next[field];
        return next;
      }
      if (prev[field] === msg) return prev;
      return { ...prev, [field]: msg };
    });
  }, [t]);

  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const debouncedValidate = useCallback((field: string, value: string) => {
    if (debounceTimers.current[field]) clearTimeout(debounceTimers.current[field]);
    debounceTimers.current[field] = setTimeout(() => validateField(field, value), 500);
  }, [validateField]);

  const handleFieldChange = useCallback((field: 'username' | 'email' | 'password', value: string, setter: (v: string) => void) => {
    setter(value);
    // Clear existing field error immediately on typing
    setFieldErrors((prev) => {
      if (!prev[field]) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
    if (mode === 'register') debouncedValidate(field, value);
  }, [mode, debouncedValidate]);

  // Conditional mediation: passkey autofill on login screen.
  // Electron uses the external-browser passkey flow (window.electron.startPasskeyLogin),
  // so skip conditional mediation here — otherwise Chromium triggers Windows Hello /
  // platform-authenticator on mount without a user gesture.
  useEffect(() => {
    if (mode !== 'login') return;
    if (isElectron) return;
    mediationAbortRef.current?.abort();
    const ac = new AbortController();
    mediationAbortRef.current = ac;

    (async () => {
      try {
        const available = await PublicKeyCredential.isConditionalMediationAvailable?.();
        if (!available || ac.signal.aborted) return;

        const { options, challengeToken } = await apiClient.passkeyLoginOptions();
        if (ac.signal.aborted) return;
        const { startAuthentication } = await import('@simplewebauthn/browser');
        const credential = await startAuthentication({
          optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
          useBrowserAutofill: true,
        });

        if (ac.signal.aborted) return;
        setIsLoading(true);
        const result = await apiClient.passkeyLoginVerify(challengeToken, credential);
        if (result.user) onAuthSuccess(result.user);
      } catch (err: any) {
        // AbortError = normal (user navigated away, explicit passkey action started)
        // NotAllowedError = normal (user didn't select a passkey from autofill)
        // Everything else = actual bug that needs diagnosing
        if (err?.name !== 'AbortError' && err?.name !== 'NotAllowedError') {
          console.warn('[Passkey] Conditional mediation failed:', err?.name, err?.message || err);
        }
      } finally {
        setIsLoading(false);
      }
    })();

    return () => { ac.abort(); mediationAbortRef.current = null; };
  }, [mode]);


  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setIsLoading(true);

    try {
      if (mode === 'register') {
        if (!agreedToTerms) { setError(t('login.mustAgreeToTerms')); setIsLoading(false); return; }
        if (!dateOfBirth) { setError(t('login.dateOfBirthRequired')); setIsLoading(false); return; }
        if (requiresParentalConsent && !parentalConsentAcknowledged) {
          setError(t('login.parentalConsentRequired', 'A parent or legal guardian must consent to your use of Howl. Please confirm consent to continue.'));
          setIsLoading(false);
          return;
        }
        const result = await apiClient.register(
          username, email, password, captchaToken || undefined, dateOfBirth,
          // For 13–17 the user has explicitly ticked the box. For 18+ we send
          // true so the bit is set on their User row at signup time, indicating
          // "consent not applicable, recorded at registration."
          requiresParentalConsent ? parentalConsentAcknowledged : true,
          instanceConfig?.needsBootstrap ? (setupToken.trim() || undefined) : undefined,
        );
        if (result.requiresVerification) {
          setVerifyUserId(result.userId);
          setVerifyStep(true);
        } else if (result.user) {
          onAuthSuccess(result.user, password);
          setPassword('');
        }
      } else {
        const result = await apiClient.login(email, password, captchaToken || undefined);
        if (result.mfaRequired) {
          setPassword('');
          setMfaToken(result.mfaToken!);
          setMfaMethods(result.methods!);
          const methods = result.methods!;
          if (isElectron) {
            const hasNonPasskey = methods.includes('totp') || methods.includes('sms');
            if (!hasNonPasskey && methods.includes('passkey')) {
              // Electron + passkey-only MFA: open browser for passkey verification
              (window as any).electron?.startPasskeyMfa?.(result.mfaToken!);
              setIsLoading(false);
              return; // Auth completes via deep link callback (onSsoCallback)
            }
            // Electron with other methods: skip passkey, prefer TOTP > SMS > recovery
            setMfaMethod(methods.includes('totp') ? 'totp' : methods.includes('sms') ? 'sms' : 'recovery');
          } else {
            setMfaMethod(methods.includes('totp') ? 'totp' : methods.includes('passkey') ? 'passkey' : 'sms');
          }
          setMfaStep(true);
        } else if (result.verificationRequired) {
          // New-device login challenge — user has no MFA so we email them a code.
          setPassword('');
          setDeviceVerifyToken(result.verifyToken);
          setDeviceVerifyMethods(result.methods);
          setDeviceVerifyEmailMasked(result.emailMasked);
          setDeviceVerifyMethod(result.methods.includes('email') ? 'email' : 'sms');
          setDeviceVerifyCode('');
          setDeviceVerifyTrust(true);
          setDeviceVerifyStep(true);
          // Auto-send the first code so the user doesn't see a "click send" step
          // on arrival — it's a single-purpose screen.
          try {
            await apiClient.verifyDeviceSend(result.verifyToken, result.methods.includes('email') ? 'email' : 'sms');
            setDeviceResendCooldown(60);
          } catch (err) {
            setError(err instanceof Error ? err.message : t('login.failedToSendCode', 'Failed to send code.'));
          }
        } else if (result.requiresVerification) {
          setVerifyUserId(result.userId!);
          setVerifyStep(true);
        } else if (result.user) {
          onAuthSuccess(result.user, password);
          setPassword('');
        }
      }
    } catch (err: unknown) {
      // Extract field-level validation errors from API response
      if (err instanceof Error && 'fields' in err) {
        const apiFields = (err as Error & { fields?: Record<string, string> }).fields;
        if (apiFields && Object.keys(apiFields).length > 0) {
          setFieldErrors(apiFields);
          // Don't show the generic "Validation failed" banner when we have field errors
          if (err.message !== 'Validation failed') setError(err.message);
          setCaptchaResetKey((k) => k + 1);
          setIsLoading(false);
          return;
        }
      }
      const msg = err instanceof Error ? err.message : t('login.authenticationFailed');
      const isConnectionError = msg === 'Failed to fetch' || msg.toLowerCase().includes('failed to fetch') || msg === 'Load failed';
      if (isConnectionError) {
        setError(t('login.cannotReachBackend', { origin: getBackendOrigin() }));
      } else if (err instanceof Error && 'isRateLimit' in err && err.isRateLimit) {
        setError(t('login.tooManyAttempts', 'Too many login attempts. Please try again later.'));
        setPassword('');
      } else {
        setError(msg);
        setPassword('');
      }
      setCaptchaResetKey((k) => k + 1);
    } finally {
      setIsLoading(false);
    }
  };

  const handlePasskeyLogin = async () => {
    if (isElectron) {
      // Electron: open system browser for passkey auth (WebAuthn requires web origin)
      (window as any).electron?.startPasskeyLogin?.();
      return;
    }
    // Web: run the passkey ceremony inline. Previously this navigated to
    // /auth/passkey-login via window.location.href, which works for the
    // Electron-callback path (?nonce=) but produced a confusing
    // "Can't reach the server" error on a fresh page load when the
    // dedicated page's first API call raced ahead of the SPA boot. Calling
    // passkeyLoginOptions in-place reuses the apiClient instance the
    // login page has already proven works (the /health probe and the
    // conditional-mediation flow both succeed against the same path).
    setError(null);
    setIsLoading(true);
    try {
      const { options, challengeToken } = await apiClient.passkeyLoginOptions();
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const credential = await startAuthentication({
        optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
      });
      const result = await apiClient.passkeyLoginVerify(challengeToken, credential);
      if (result.user) onAuthSuccess(result.user);
    } catch (err: any) {
      // NotAllowedError = user dismissed/cancelled the passkey dialog.
      // AbortError = ceremony was cancelled programmatically. Both are
      // routine outcomes, not error conditions to surface.
      if (err?.name !== 'NotAllowedError' && err?.name !== 'AbortError') {
        setError(err?.message || t('login.passkeyFailed', 'Passkey sign-in failed.'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const user = await apiClient.verifyEmail(verifyUserId, verifyCode, captchaToken || undefined);
      onAuthSuccess(user, password);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.verificationFailed'));
      setCaptchaToken('');
      setCaptchaResetKey(k => k + 1);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResendCode = async () => {
    if (resendCooldown > 0) return;
    try {
      await apiClient.resendVerification(verifyUserId, captchaToken || undefined);
      setCaptchaToken('');
      setCaptchaResetKey(k => k + 1);
      setResendCooldown(60);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.failedToResend'));
    }
  };

  const handleMfaSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      let user;
      if (mfaMethod === 'totp') {
        user = await apiClient.mfaTotpVerify(mfaToken, mfaCode);
      } else if (mfaMethod === 'sms') {
        user = await apiClient.mfaPhoneVerify(mfaToken, mfaCode);
      } else if (mfaMethod === 'passkey') {
        mediationAbortRef.current?.abort();
        mediationAbortRef.current = null;
        const { options, challengeToken } = await apiClient.mfaPasskeyAuthOptions(mfaToken);
        const { startAuthentication } = await import('@simplewebauthn/browser');
        const credential = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
        user = await apiClient.mfaPasskeyAuthVerify(challengeToken, credential);
      }
      if (user) onAuthSuccess(user);
    } catch (err: any) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
        // User cancelled passkey prompt — let them retry, don't show error
      } else {
        setError(err instanceof Error ? err.message : t('login.mfaVerificationFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendSms = async () => {
    try {
      await apiClient.mfaPhoneSend(mfaToken);
      setSmsSent(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.failedToSendSms'));
    }
  };

  const handleDeviceVerifySubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const user = await apiClient.verifyDeviceConfirm(deviceVerifyToken, deviceVerifyCode, deviceVerifyTrust);
      onAuthSuccess(user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.verificationFailed'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeviceVerifyResend = async () => {
    if (deviceResendCooldown > 0) return;
    setError(null);
    try {
      await apiClient.verifyDeviceSend(deviceVerifyToken, deviceVerifyMethod);
      setDeviceResendCooldown(60);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.failedToResend'));
    }
  };

  const handleForgotPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await apiClient.forgotPassword(forgotEmail || email, captchaToken || undefined);
      setCaptchaToken('');
      setCaptchaResetKey(k => k + 1);
      setForgotStep('code');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.failedToSendResetCode'));
      setCaptchaResetKey(k => k + 1);
    } finally {
      setIsLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      await apiClient.resetPassword(forgotEmail || email, resetCode, newPassword, captchaToken || undefined);
      setForgotStep('success');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.passwordResetFailed'));
      setCaptchaResetKey(k => k + 1);
    } finally {
      setIsLoading(false);
    }
  };

  const handleRecoveryCodeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const result = await apiClient.verifyRecoveryCode(mfaToken, recoveryCode);
      if (result.user) onAuthSuccess(result.user);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('login.invalidRecoveryCode'));
    } finally {
      setIsLoading(false);
    }
  };

  const inputCls = "w-full rounded-lg border bg-input-surface border-[var(--glass-border)] px-4 py-3 text-sm text-t-primary outline-none transition-[border-color] duration-150 focus:border-[#076FA0] placeholder:text-white/30";

  const SubmitButton = ({ children, disabled }: { children: React.ReactNode; disabled?: boolean }) => (
    <button
      type="submit"
      disabled={isLoading || disabled}
      className="btn-cta group mt-2 w-full flex items-center justify-center gap-2 py-3 text-sm"
    >
      {isLoading ? <Loader2 size={18} className="animate-spin" /> : children}
    </button>
  );

  // -- Render verification screen --
  const renderVerifyScreen = () => (
    <div className="space-y-4 text-center">
      <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center" style={{ background: 'rgba(7,111,160,0.1)' }}>
        <MessageSquare size={28} style={{ color: '#076FA0' }} />
      </div>
      <h2 className="text-xl font-bold text-white">{t('login.checkYourEmail')}</h2>
      <p className="text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>{t('login.weSentCodeTo')} <strong className="text-white">{email}</strong></p>
      <form onSubmit={handleVerifyEmail} className="space-y-4">
        <input
          type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={verifyCode} onChange={(e) => setVerifyCode(e.target.value.replace(/\D/g, ''))}
          className={inputCls + " text-center text-2xl font-mono tracking-[0.5em]"}          placeholder={t('login.codePlaceholder')} required autoFocus
        />
        <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaResetKey} />
        <SubmitButton disabled={verifyCode.length !== 6}>
          <span>{t('login.verifyEmail')}</span><ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
        </SubmitButton>
      </form>
      <div className="flex items-center justify-center gap-4">
        <button onClick={handleResendCode} disabled={resendCooldown > 0} className="text-xs font-semibold transition-colors hover:underline disabled:opacity-40" style={{ color: '#076FA0' }}>
          {resendCooldown > 0 ? t('login.resendIn', { seconds: resendCooldown }) : t('login.resendCode')}
        </button>
        <span className="text-white/20">|</span>
        <button onClick={() => { setVerifyStep(false); setVerifyCode(''); setVerifyUserId(''); setError(null); }} className="text-xs font-semibold transition-colors hover:underline" style={{ color: 'rgba(255,255,255,0.6)' }}>
          {mode === 'register' ? t('login.backToRegister') : t('login.backToLogin')}
        </button>
      </div>
    </div>
  );

  // -- Render MFA screen --
  const renderMfaScreen = () => (
    <div className="space-y-4">
      <div className="text-center">
        <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: 'rgba(7,111,160,0.1)' }}>
          <Key size={28} style={{ color: '#076FA0' }} />
        </div>
        <h2 className="text-xl font-bold text-white">{t('login.twoFactorAuth')}</h2>
        <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>{t('login.verifyIdentity')}</p>
      </div>

      {mfaMethods.length > 1 && (
        <div className="flex gap-2 justify-center">
          {mfaMethods.includes('totp') && (
            <button onClick={() => setMfaMethod('totp')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors" style={{ backgroundColor: mfaMethod === 'totp' ? 'rgba(7,111,160,0.15)' : 'transparent', color: mfaMethod === 'totp' ? '#076FA0' : 'rgba(255,255,255,0.6)' }}>
              <Smartphone size={14} /> {t('login.authApp')}
            </button>
          )}
          {mfaMethods.includes('passkey') && !isElectron && (
            <button onClick={() => setMfaMethod('passkey')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors" style={{ backgroundColor: mfaMethod === 'passkey' ? 'rgba(7,111,160,0.15)' : 'transparent', color: mfaMethod === 'passkey' ? '#076FA0' : 'rgba(255,255,255,0.6)' }}>
              <Key size={14} /> {t('login.passkey')}
            </button>
          )}
          {mfaMethods.includes('sms') && (
            <button onClick={() => setMfaMethod('sms')} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors" style={{ backgroundColor: mfaMethod === 'sms' ? 'rgba(7,111,160,0.15)' : 'transparent', color: mfaMethod === 'sms' ? '#076FA0' : 'rgba(255,255,255,0.6)' }}>
              <MessageSquare size={14} /> {t('login.sms')}
            </button>
          )}
        </div>
      )}

      {mfaMethod === 'recovery' ? (
        <form onSubmit={handleRecoveryCodeSubmit} className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.recoveryCodeLabel')}</label>
            <input type="text" maxLength={8} value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value.replace(/[^a-fA-F0-9]/g, '').toLowerCase())} className={inputCls + " text-center text-lg font-mono tracking-[0.3em]"} placeholder={t('login.recoveryCodePlaceholder')} required autoFocus />
          </div>
          <SubmitButton disabled={recoveryCode.length < 8}>
            <span>{t('login.useRecoveryCode')}</span><ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </SubmitButton>
        </form>
      ) : (
        <form onSubmit={handleMfaSubmit} className="space-y-4">
          {mfaMethod === 'totp' && (
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.authenticatorCode')}</label>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} className={inputCls + " text-center text-lg font-mono tracking-[0.3em]"} placeholder={t('login.codePlaceholder')} required autoFocus />
            </div>
          )}
          {mfaMethod === 'passkey' && (
            <p className="text-sm text-center" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.clickToAuthenticate')}</p>
          )}
          {mfaMethod === 'sms' && (
            <div>
              {!smsSent ? (
                <button type="button" onClick={handleSendSms} className="btn-cta w-full rounded-xl px-4 py-3 text-sm transition-colors">{t('login.sendSmsCode')}</button>
              ) : (
                <div>
                  <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.smsCode')}</label>
                  <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={mfaCode} onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, ''))} className={inputCls + " text-center text-lg font-mono tracking-[0.3em]"} placeholder={t('login.codePlaceholder')} required autoFocus />
                </div>
              )}
            </div>
          )}
          <SubmitButton disabled={(mfaMethod !== 'passkey' && mfaCode.length !== 6) || (mfaMethod === 'sms' && !smsSent)}>
            <span>{mfaMethod === 'passkey' ? t('login.usePasskey') : t('login.verify')}</span><ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </SubmitButton>
        </form>
      )}

      <div className="flex items-center justify-center gap-4">
        <button onClick={() => setMfaMethod(mfaMethod === 'recovery' ? (mfaMethods.includes('totp') ? 'totp' : (!isElectron && mfaMethods.includes('passkey')) ? 'passkey' : 'sms') : 'recovery')} className="text-xs font-semibold transition-colors hover:underline" style={{ color: '#076FA0' }}>
          {mfaMethod === 'recovery' ? t('login.backToMfa') : t('login.useARecoveryCode')}
        </button>
        <span className="text-white/20">|</span>
        <button onClick={() => { setMfaStep(false); setMfaToken(''); setMfaCode(''); setSmsSent(false); setRecoveryCode(''); setError(null); }} className="text-xs font-semibold transition-colors hover:underline" style={{ color: 'rgba(255,255,255,0.6)' }}>
          {t('login.backToLogin')}
        </button>
      </div>
    </div>
  );

  // -- Render device verification screen (new-device login, no-MFA users) --
  const renderDeviceVerifyScreen = () => {
    const smsEnabled = deviceVerifyMethods.includes('sms');
    return (
      <div className="space-y-5">
        <div className="text-center">
          {/* Icon tile — flat accent fill, no glow/ring (login page removes
              accent glows; the landing CTA keeps its glow, the login does not). */}
          <div className="relative w-16 h-16 mx-auto mb-3">
            <div className="absolute inset-[3px] rounded-2xl flex items-center justify-center" style={{ background: 'rgba(7,111,160,0.08)' }}>
              <ShieldCheck size={26} style={{ color: 'var(--cyan-accent)' }} />
            </div>
          </div>
          <h2 className="text-xl font-black uppercase tracking-[0.08em] text-t-primary">{t('login.verifyNewDeviceTitle', 'New device check')}</h2>
          <p className="text-sm mt-2 text-t-secondary">
            {t('login.verifyNewDeviceDesc', 'We sent a 6-digit code to')}
          </p>
          {/* Masked email chip — monospace + subtle border echoes the code
              input below, telling the user at a glance where the code lives. */}
          <div className="inline-flex items-center gap-1.5 mt-2 px-3 py-1.5 rounded-lg border border-[var(--glass-border)] bg-input-surface">
            <Mail size={12} className="text-t-tertiary" />
            <span className="text-xs font-mono tracking-[0.06em] text-t-primary">{deviceVerifyEmailMasked}</span>
          </div>
        </div>

        {deviceVerifyMethods.length > 0 && (
          <div className="flex gap-2 justify-center">
            <button
              type="button"
              onClick={() => setDeviceVerifyMethod('email')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-[0.1em] transition-colors"
              style={{ backgroundColor: deviceVerifyMethod === 'email' ? 'var(--accent-muted)' : 'transparent', color: deviceVerifyMethod === 'email' ? 'var(--cyan-accent)' : 'rgba(255,255,255,0.6)' }}
            >
              <Mail size={14} /> {t('login.email')}
            </button>
            <button
              type="button"
              onClick={() => smsEnabled && setDeviceVerifyMethod('sms')}
              disabled={!smsEnabled}
              aria-label={smsEnabled ? t('login.sms') : t('login.smsComingSoon', 'SMS verification coming soon')}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold uppercase tracking-[0.1em] transition-colors disabled:cursor-not-allowed"
              style={{ backgroundColor: deviceVerifyMethod === 'sms' && smsEnabled ? 'var(--accent-muted)' : 'transparent', color: !smsEnabled ? 'rgba(255,255,255,0.35)' : deviceVerifyMethod === 'sms' ? 'var(--cyan-accent)' : 'rgba(255,255,255,0.6)' }}
            >
              <MessageSquare size={14} /> {t('login.sms')}
              {!smsEnabled && (
                <span className="ml-0.5 px-1.5 py-0.5 rounded text-[8px] font-black uppercase tracking-[0.15em] border border-[var(--glass-border)] text-t-tertiary">
                  {t('common.soon', 'Soon')}
                </span>
              )}
            </button>
          </div>
        )}

        <form onSubmit={handleDeviceVerifySubmit} className="space-y-4">
          <input
            type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={deviceVerifyCode}
            onChange={(e) => setDeviceVerifyCode(e.target.value.replace(/\D/g, ''))}
            className={inputCls + " text-center text-2xl font-mono tracking-[0.5em]"}
            placeholder={t('login.codePlaceholder')} required autoFocus
          />

          {/* Trust toggle — uses Howl's pill-thumb Toggle pattern (see
              components/settings/SettingsWidgets.tsx ToggleRow). Bare native
              checkboxes are visual AI-slop in a design system this distinctive. */}
          <button
            type="button"
            role="switch"
            aria-checked={deviceVerifyTrust}
            onClick={() => setDeviceVerifyTrust((v) => !v)}
            className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-lg border border-[var(--glass-border)] bg-input-surface text-left transition-colors hover:border-[var(--border-strong)]"
          >
            <span className="flex-1 min-w-0">
              <span className="block text-xs font-bold uppercase tracking-[0.08em] text-t-primary">{t('login.trustThisDevice', 'Trust this device')}</span>
              <span className="block text-[11px] mt-0.5 text-t-secondary">{t('login.trustThisDeviceDesc', 'Skip verification for 90 days on this browser.')}</span>
            </span>
            <span
              className="relative shrink-0 w-10 h-[22px] rounded-full transition-colors duration-200"
              style={{ backgroundColor: deviceVerifyTrust ? 'var(--cyan-accent)' : 'var(--fill-active)' }}
            >
              <span
                className="absolute top-[2px] left-[2px] w-[18px] h-[18px] rounded-full bg-white shadow transition-transform duration-200"
                style={{ transform: deviceVerifyTrust ? 'translateX(18px)' : 'translateX(0)' }}
              />
            </span>
          </button>

          <SubmitButton disabled={deviceVerifyCode.length !== 6}>
            <span>{t('login.verify')}</span><ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </SubmitButton>
        </form>

        <div className="flex items-center justify-center gap-4">
          <button onClick={handleDeviceVerifyResend} disabled={deviceResendCooldown > 0} className="text-xs font-bold uppercase tracking-[0.08em] transition-colors hover:underline disabled:opacity-40" style={{ color: 'var(--cyan-accent)' }}>
            {deviceResendCooldown > 0 ? t('login.resendIn', { seconds: deviceResendCooldown }) : t('login.resendCode')}
          </button>
          <span className="text-white/20">|</span>
          <button
            onClick={() => {
              setDeviceVerifyStep(false);
              setDeviceVerifyToken('');
              setDeviceVerifyCode('');
              setDeviceVerifyEmailMasked('');
              setError(null);
            }}
            className="text-xs font-bold uppercase tracking-[0.08em] transition-colors hover:underline"
            style={{ color: 'rgba(255,255,255,0.6)' }}
          >
            {t('login.backToLogin')}
          </button>
        </div>

        {/* Soft security reminder — if the login wasn't them, someone knows
            their password. Styled as an aside, not a scare banner. */}
        <p className="text-[11px] text-center leading-relaxed text-t-tertiary">
          {t('login.deviceVerifyWarning', 'Wasn\'t you? Change your password right away.')}
        </p>
      </div>
    );
  };

  // -- Render forgot password screen --
  const renderForgotPasswordScreen = () => {
    if (forgotStep === 'success') {
      return (
        <div className="space-y-4 text-center">
          <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center" style={{ background: 'rgba(34,197,94,0.1)' }}>
            <Check size={28} style={{ color: 'var(--success)' }} />
          </div>
          <h2 className="text-xl font-bold text-white">{t('login.passwordResetSuccessTitle')}</h2>
          <p className="text-sm" style={{ color: 'rgba(255,255,255,0.8)' }}>{t('login.passwordResetSuccessDescription')}</p>
          <button onClick={() => { setForgotStep(null); setResetCode(''); setNewPassword(''); setPassword(''); setError(null); }} className="mt-2 text-xs font-bold transition-colors hover:underline" style={{ color: '#076FA0' }}>
            {t('login.backToLogin')}
          </button>
        </div>
      );
    }

    if (forgotStep === 'code') {
      return (
        <div className="space-y-4">
          <div className="text-center">
            <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: 'rgba(7,111,160,0.1)' }}>
              <MessageSquare size={28} style={{ color: '#076FA0' }} />
            </div>
            <h2 className="text-xl font-bold text-white">{t('login.checkYourEmail')}</h2>
            <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>{t('login.enterResetCodePrefix')} <strong className="text-white">{forgotEmail || email}</strong> {t('login.enterResetCodeSuffix')}</p>
          </div>
          <form onSubmit={handleResetPassword} className="space-y-4">
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.resetCodeLabel')}</label>
              <input type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={resetCode} onChange={(e) => setResetCode(e.target.value.replace(/\D/g, ''))} className={inputCls + " text-center text-2xl font-mono tracking-[0.5em]"} placeholder={t('login.codePlaceholder')} required autoFocus />
            </div>
            <div>
              <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.newPasswordLabel')}</label>
              <div className="relative">
                <input type={showPassword ? 'text' : 'password'} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputCls + " pr-11"} placeholder={t('login.passwordPlaceholder')} required />
                <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg hover:bg-white/10 transition-colors" tabIndex={-1}>
                  {showPassword ? <EyeOff size={16} className="text-white/40" /> : <Eye size={16} className="text-white/40" />}
                </button>
              </div>
              <PasswordStrength password={newPassword} />
            </div>
            <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaResetKey} />
            <SubmitButton disabled={resetCode.length !== 6 || newPassword.length < 12}>
              <span>{t('login.resetPasswordButton')}</span><ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
            </SubmitButton>
          </form>
          <button onClick={() => { setForgotStep(null); setResetCode(''); setNewPassword(''); setError(null); }} className="block mx-auto text-xs font-semibold transition-colors hover:underline" style={{ color: 'rgba(255,255,255,0.6)' }}>
            {t('login.backToLogin')}
          </button>
        </div>
      );
    }

    return (
      <div className="space-y-4">
        <div className="text-center">
          <div className="w-14 h-14 rounded-2xl mx-auto flex items-center justify-center mb-3" style={{ background: 'rgba(7,111,160,0.1)' }}>
            <Key size={28} style={{ color: '#076FA0' }} />
          </div>
          <h2 className="text-xl font-bold text-white">{t('login.forgotPasswordTitle')}</h2>
          <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.8)' }}>{t('login.forgotPasswordDescription')}</p>
        </div>
        <form onSubmit={handleForgotPassword} className="space-y-4">
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.email')}</label>
            <input type="email" maxLength={254} value={forgotEmail || email} onChange={(e) => setForgotEmail(e.target.value)} className={inputCls} placeholder={t('login.emailPlaceholder')} required autoFocus />
          </div>
          <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaResetKey} />
          <SubmitButton>
            <span>{t('login.sendResetCode')}</span><ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
          </SubmitButton>
        </form>
        <button onClick={() => { setForgotStep(null); setError(null); }} className="block mx-auto text-xs font-semibold transition-colors hover:underline" style={{ color: 'rgba(255,255,255,0.6)' }}>
          {t('login.backToLogin')}
        </button>
      </div>
    );
  };

  // -- Main form --
  const renderForm = () => (
    <>
      <form onSubmit={handleSubmit} className="space-y-4">
        {mode === 'register' && instanceConfig?.needsBootstrap && (
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.setupToken', 'Setup token')}</label>
            <input type="text" value={setupToken} onChange={(e) => setSetupToken(e.target.value)} className={inputCls} placeholder={t('login.setupTokenPlaceholder', 'Paste the setup token from your server')} autoComplete="off" required />
            <p className="text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>{t('login.setupTokenHint', 'The BOOTSTRAP_TOKEN your install printed. It authorizes creating the first admin account.')}</p>
          </div>
        )}

        {mode === 'register' && (
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.username')}</label>
            <input type="text" maxLength={32} value={username} onChange={(e) => handleFieldChange('username', e.target.value, setUsername)} className={inputCls + (fieldErrors.username ? ' border-[var(--danger)]' : '')} placeholder={t('login.chooseUsernamePlaceholder')} required />
            {fieldErrors.username && <span className="block text-xs text-[var(--danger)] mt-1">{fieldErrors.username}</span>}
          </div>
        )}

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.email')}</label>
          <input type="email" maxLength={254} value={email} onChange={(e) => handleFieldChange('email', e.target.value, setEmail)} className={inputCls + (fieldErrors.email ? ' border-[var(--danger)]' : '')} placeholder={t('login.emailPlaceholder')} required autoComplete={mode === 'login' && !isElectron ? 'email webauthn' : 'email'} />
          {fieldErrors.email && <span className="block text-xs text-[var(--danger)] mt-1">{fieldErrors.email}</span>}
        </div>

        <div>
          <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.password')}</label>
          <div className="relative">
            <input type={showPassword ? 'text' : 'password'} maxLength={128} value={password} onChange={(e) => handleFieldChange('password', e.target.value, setPassword)} className={inputCls + " pr-11" + (fieldErrors.password ? ' border-[var(--danger)]' : '')} placeholder={t('login.passwordPlaceholder')} required autoComplete={mode === 'register' ? 'new-password' : 'current-password'} />
            <button type="button" onClick={() => setShowPassword(!showPassword)} className="absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded-lg hover:bg-white/10 transition-colors" tabIndex={-1}>
              {showPassword ? <EyeOff size={16} className="text-white/40" /> : <Eye size={16} className="text-white/40" />}
            </button>
          </div>
          {fieldErrors.password && <span className="block text-xs text-[var(--danger)] mt-1">{fieldErrors.password}</span>}
          {mode === 'register' && <PasswordStrength password={password} />}
          {mode === 'login' && (
            <button type="button" onClick={() => { setForgotStep('email'); setForgotEmail(email); setError(null); }} className="mt-1.5 text-[11px] font-semibold transition-colors hover:underline" style={{ color: '#076FA0' }}>
              {t('login.forgotPassword')}
            </button>
          )}
        </div>

        {mode === 'register' && (
          <div>
            <label className="block text-[10px] font-bold uppercase tracking-[0.15em] mb-1.5" style={{ color: 'rgba(255,255,255,0.7)' }}>{t('login.dateOfBirth')}</label>
            <DatePicker
              value={dateOfBirth}
              onChange={setDateOfBirth}
              max={new Date().toISOString().split('T')[0]}
              className={inputCls}
              required
            />
            {fieldErrors.dateOfBirth && <span className="block text-xs text-[var(--danger)] mt-1">{fieldErrors.dateOfBirth}</span>}
            <p className="text-[10px] mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>{t('login.dateOfBirthHint')}</p>
          </div>
        )}

        <TurnstileWidget onToken={setCaptchaToken} resetKey={captchaResetKey} />

        {mode === 'register' && (
          <label className="flex items-start gap-2.5 cursor-pointer group py-1">
            <input
              type="checkbox"
              checked={agreedToTerms}
              onChange={(e) => setAgreedToTerms(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-2 border-white/20 bg-transparent checked:bg-[var(--cyan-accent)] checked:border-[var(--cyan-accent)] accent-[var(--cyan-accent)] cursor-pointer shrink-0"
            />
            <span className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {t('login.agreeToTermsPrefix')}{' '}
              <button type="button" onClick={(e) => { e.preventDefault(); setShowTerms(true); }} className="text-[var(--cyan-accent)] hover:underline font-medium">
                {t('login.termsOfService')}
              </button>{' '}
              {t('login.and')}{' '}
              <button type="button" onClick={(e) => { e.preventDefault(); setShowPrivacy(true); }} className="text-[var(--cyan-accent)] hover:underline font-medium">
                {t('login.privacyPolicy')}
              </button>
              {t('login.agreeToTermsSuffix')}
            </span>
          </label>
        )}

        {mode === 'register' && requiresParentalConsent && (
          <label className="flex items-start gap-2.5 cursor-pointer group py-1">
            <input
              type="checkbox"
              checked={parentalConsentAcknowledged}
              onChange={(e) => setParentalConsentAcknowledged(e.target.checked)}
              className="mt-0.5 w-4 h-4 rounded border-2 border-white/20 bg-transparent checked:bg-[var(--cyan-accent)] checked:border-[var(--cyan-accent)] accent-[var(--cyan-accent)] cursor-pointer shrink-0"
            />
            <span className="text-[11px] leading-relaxed" style={{ color: 'rgba(255,255,255,0.6)' }}>
              {t(
                'login.parentalConsent',
                'I confirm that a parent or legal guardian has read these Terms and consents to my use of Howl.',
              )}
            </span>
          </label>
        )}

        <SubmitButton disabled={backendStatus.status === 'error' || (mode === 'register' && (!agreedToTerms || !dateOfBirth || (requiresParentalConsent && !parentalConsentAcknowledged) || (!!instanceConfig?.needsBootstrap && !setupToken.trim())))}>
          <span>{mode === 'login' ? t('login.signIn') : t('login.createAccount')}</span>
          <ArrowRight size={16} className="transition-transform group-hover:translate-x-0.5" />
        </SubmitButton>
      </form>

      <SsoButtons />

      {mode === 'login' && (
        <button
          type="button"
          onClick={handlePasskeyLogin}
          className="flex items-center justify-center gap-2 w-full rounded-lg px-3 py-3 text-[15px] font-semibold transition-all duration-150 hover:brightness-[1.08] hover:-translate-y-0.5 active:scale-[0.98] mt-2.5"
          style={{
            backgroundColor: '#02385A',
            color: '#fff',
          }}
        >
          <LockKeyhole size={15} />
          Sign in with passkey
        </button>
      )}

      <div className="mt-6 pt-5 border-t text-center" style={{ borderColor: 'rgba(51,65,85,0.3)' }}>
        <span className="text-xs" style={{ color: 'rgba(255,255,255,0.5)' }}>
          {mode === 'login' ? t('login.noAccount') : t('login.alreadyHaveAccount')}
        </span>
        {!registrationClosed && (
          <button type="button" onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }} className="ml-1.5 text-xs font-bold transition-colors hover:underline" style={{ color: '#076FA0' }}>
            {mode === 'login' ? t('login.register') : t('login.signInLink')}
          </button>
        )}
      </div>
    </>
  );

  return (
    // Pin the theme tokens to their :root (dark) values so the login screen
    // renders a fixed dark appearance regardless of which [data-theme] the user
    // selected in-app. Mirrors the local-pin pattern the landing page uses. The
    // opaque black background keeps the themed <body> from bleeding behind the
    // card. The fill/accent tokens are color-mix() against --text-primary /
    // --cyan-accent, so we re-state those mixes with the dark base values.
    <div
      className="font-satoshi relative flex min-h-full w-full flex-col overflow-x-hidden px-4 py-8"
      style={{
        backgroundColor: '#000000',
        '--bg-app': '#0c0e13',
        '--bg-panel': 'rgba(7, 11, 18, 0.72)',
        '--bg-input': 'rgba(7, 11, 18, 0.5)',
        '--text-primary': '#f1f5f9',
        '--text-secondary': 'rgba(241, 245, 249, 0.5)',
        '--text-tertiary': 'rgba(241, 245, 249, 0.3)',
        '--glass-border': 'rgba(7, 111, 160, 0.16)',
        '--fill-hover': 'color-mix(in srgb, #f1f5f9 6%, transparent)',
        '--fill-active': 'color-mix(in srgb, #f1f5f9 10%, transparent)',
        '--accent-muted': 'color-mix(in srgb, #076FA0 15%, transparent)',
        '--accent-subtle': 'color-mix(in srgb, #076FA0 8%, transparent)',
        '--divider': 'rgba(7, 111, 160, 0.1)',
        '--border-strong': 'color-mix(in srgb, #f1f5f9 12%, transparent)',
      } as React.CSSProperties}
    >
      <div className="relative mx-auto my-auto w-full max-w-[420px] z-10">
        <div className="flex flex-col items-center mb-8">
          <div className="mb-4">
            <img src={assetPath('/howl-logo.png')} alt="Howl" className="h-16 w-16 sm:h-20 sm:w-20 rounded object-cover" decoding="async" />
          </div>
          <h1 className="font-clash text-3xl font-semibold text-white tracking-[-0.02em]">
            {verifyStep ? t('login.verifyEmailTitle') : deviceVerifyStep ? t('login.verifyNewDeviceTitle', 'Verify new device') : mfaStep ? t('login.secureLogin') : forgotStep ? t('login.resetPasswordTitle') : mode === 'login' ? t('login.welcomeBack') : t('login.joinThePack')}
          </h1>
          {!verifyStep && !mfaStep && !forgotStep && (
            <p className="text-sm mt-1" style={{ color: 'rgba(255,255,255,0.55)' }}>
              {mode === 'login' ? t('login.signInToContinue') : t('login.createHowlAccount')}
            </p>
          )}
        </div>

        <div
          className="rounded-2xl border p-6 sm:p-8"
          style={{
            backgroundColor: 'var(--bg-panel)',
            borderColor: 'rgba(7, 111, 160, 0.18)',
            boxShadow: '0 25px 50px rgba(0, 0, 0, 0.4)',
          }}
        >
          {!verifyStep && !mfaStep && !forgotStep && backendStatus.status === 'error' && (
            <div className="flex items-center gap-2 mb-5 px-3 py-2 rounded-lg text-xs font-medium" style={{ backgroundColor: 'rgba(239,68,68,0.08)' }}>
              <WifiOff size={13} className="text-[#fca5a5]" /><span className="text-[#fca5a5] truncate" title={backendStatus.message}>{t('login.serverUnreachable')}</span>
            </div>
          )}

          {error && (
            <div className="mb-5 rounded-xl border px-4 py-3 text-sm" style={{ borderColor: 'rgba(239,68,68,0.3)', backgroundColor: 'rgba(239,68,68,0.08)', color: '#fca5a5' }}>
              {error}
            </div>
          )}

          {verifyStep ? renderVerifyScreen() : deviceVerifyStep ? renderDeviceVerifyScreen() : mfaStep ? renderMfaScreen() : forgotStep ? renderForgotPasswordScreen() : renderForm()}
        </div>

        {!verifyStep && !mfaStep && !forgotStep && backendStatus.status === 'error' && (
          <details className="mt-4 rounded-xl border px-4 py-3 text-xs cursor-pointer" style={{ borderColor: 'rgba(239,68,68,0.2)', backgroundColor: 'rgba(239,68,68,0.05)', color: '#fca5a5' }}>
            <summary className="font-medium select-none">{t('login.connectionDetails')}</summary>
            <p className="mt-2 text-[11px] leading-relaxed" style={{ color: 'rgba(252,165,165,0.7)' }}>{backendStatus.message}</p>
          </details>
        )}
      </div>

      {/* Privacy Policy popup */}
      {showPrivacy && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowPrivacy(false)} />
          <div className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border overflow-hidden shadow-2xl" style={{ backgroundColor: 'rgba(7, 11, 18, 0.97)', borderColor: 'rgba(7, 111, 160, 0.15)' }}>
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: 'var(--divider)' }}>
              <h3 className="text-sm font-black uppercase tracking-wider text-white">{t('login.privacyPolicy')}</h3>
              <button type="button" onClick={() => setShowPrivacy(false)} className="p-1 rounded-lg hover:bg-white/10 transition-all text-white/50 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 text-[12px] leading-relaxed space-y-4" style={{ color: 'rgba(255,255,255,0.8)' }}>
              <p className="text-white/40 text-[10px]">Effective Date: March 4, 2026 · Last Updated: March 4, 2026</p>

              <p>This Privacy Policy describes how Howl collects, uses, stores, and protects your personal information when you use the Howl platform.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">1. Information We Collect</h4>
              <p><strong className="text-white/70">You provide:</strong> Account info (username, email, securely stored password), profile info (avatar, banner, status), payment info (processed by Stripe — we never see your card number), user content (messages, images, files), and communication preferences.</p>
              <p><strong className="text-white/70">Automatically:</strong> Usage data (features used, activity timestamps — not for ads), device/connection data (IP for security/rate limiting), and error reports via Sentry (opt-in only).</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">2. How We Use It</h4>
              <p>Provide and improve the Service, ensure safety and security, process payments, and communicate service notices. We do not sell your data or use it for targeted advertising.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">3. How We Share It</h4>
              <p>With other users (profile, messages), service providers (Stripe, Sentry, AWS, Cloudflare, LiveKit), legal obligations, and safety emergencies. We do not sell or rent your data.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">4. Encryption</h4>
              <p>Direct messages are end-to-end encrypted. We cannot read the content of your DMs — only ciphertext is stored on our servers.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">5. Data Retention</h4>
              <p>Account data is kept while active. Server messages follow each server's retention settings. When you delete your account, profile data is permanently removed and messages are anonymized.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">6. Cookies</h4>
              <p>One essential cookie (howl_refresh) for authentication. Sentry error reporting is opt-in via cookie consent. If ads are enabled in the future, advertising cookies may require your consent via the cookie banner.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">7. Your Rights</h4>
              <p>Access, export, and delete your data via Account Settings. GDPR (EU), CCPA (California), LGPD (Brazil), and other regional rights are supported. Contact support@howlpro.com.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">8. Children</h4>
              <p>Howl is for users 13 and older. We do not knowingly collect data from children under 13.</p>

              <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">9. Security</h4>
              <p>Passwords are securely hashed and never stored in plain text. DMs are end-to-end encrypted. All data in transit uses HTTPS. MFA is available. Emails are encrypted at rest.</p>

              <p className="text-white/40 text-[10px] pt-2">
                This is a summary. Read the full <a href="/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-[#076FA0] hover:underline">Privacy Policy</a> for complete details.
              </p>
              <p className="text-white/30 text-[10px] pt-4 border-t" style={{ borderColor: 'var(--divider)' }}>
                Contact: support@howlpro.com
              </p>
            </div>
            <div className="px-6 py-4 border-t shrink-0 flex justify-end" style={{ borderColor: 'var(--divider)' }}>
              <button
                type="button"
                onClick={() => setShowPrivacy(false)}
                className="px-5 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all"
                style={{ backgroundColor: 'rgba(7, 111, 160, 0.15)', color: '#076FA0', border: '1px solid rgba(7, 111, 160, 0.3)' }}
              >
                {t('common.close')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Terms of Service popup */}
      {showTerms && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowTerms(false)} />
          <div className="relative w-full max-w-2xl max-h-[80vh] flex flex-col rounded-2xl border overflow-hidden shadow-2xl" style={{ backgroundColor: 'rgba(7, 11, 18, 0.97)', borderColor: 'rgba(7, 111, 160, 0.15)' }}>
            <div className="flex items-center justify-between px-6 py-4 border-b shrink-0" style={{ borderColor: 'var(--divider)' }}>
              <h3 className="text-sm font-black uppercase tracking-wider text-white">{t('login.termsOfService')}</h3>
              <button type="button" onClick={() => setShowTerms(false)} className="p-1 rounded-lg hover:bg-white/10 transition-all text-white/50 hover:text-white">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5 text-[12px] leading-relaxed space-y-4" style={{ color: 'rgba(255,255,255,0.8)' }}>
              <p className="text-white/40 text-[10px]">Effective Date: {TERMS_SUMMARY_EFFECTIVE_DATE} · Last Updated: {TERMS_SUMMARY_LAST_UPDATED}</p>

              <p>{TERMS_SUMMARY_INTRO}</p>

              {TERMS_SUMMARY_CLAUSES.map((clause) => (
                <React.Fragment key={clause.heading}>
                  <h4 className="text-white font-bold text-xs uppercase tracking-wide pt-2">{clause.heading}</h4>
                  <p>{clause.body}</p>
                </React.Fragment>
              ))}

              <p className="text-white/40 text-[10px] pt-2">
                This is a summary. Read the full <a href={TERMS_SUMMARY_FULL_LINK_HREF} target="_blank" rel="noopener noreferrer" className="text-[#076FA0] hover:underline">{TERMS_SUMMARY_FULL_LINK_LABEL}</a> for complete details.
              </p>
              <p className="text-white/30 text-[10px] pt-4 border-t" style={{ borderColor: 'var(--divider)' }}>
                Contact: {TERMS_SUMMARY_SUPPORT_EMAIL}
              </p>
            </div>
            <div className="px-6 py-4 border-t shrink-0 flex items-center justify-between" style={{ borderColor: 'var(--divider)' }}>
              <p className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>{t('login.scrollToReadTerms')}</p>
              <button
                type="button"
                onClick={() => { setAgreedToTerms(true); setShowTerms(false); }}
                className="btn-cta px-5 py-2 rounded-xl text-[10px] uppercase tracking-widest transition-all"
              >
                {t('login.iAgree')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
