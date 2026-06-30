// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Sentry client-side initialization for the React frontend.
 *
 * Set VITE_SENTRY_DSN in the root .env to enable.
 * When unset, Sentry is a no-op — zero overhead.
 *
 * Initialization is deferred until the user consents via the cookie banner.
 * Call `initSentryIfConsented()` after reading consent from localStorage.
 */

import * as Sentry from '@sentry/react';

const dsn = import.meta.env.VITE_SENTRY_DSN || '';

const COOKIE_CONSENT_KEY = 'howl_cookie_consent';

let _sentryInitialized = false;

function hasAnalyticsConsent(): boolean {
  try {
    const raw = localStorage.getItem(COOKIE_CONSENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.analytics === true;
  } catch {
    return false;
  }
}

export function initSentryIfConsented(): void {
  if (_sentryInitialized || !dsn) return;
  if (!hasAnalyticsConsent()) return;

  Sentry.init({
    dsn,
    environment: import.meta.env.MODE || 'development',
    // __APP_VERSION__ is injected by Vite from package.json (see vite.config.ts
    // → define). Previously read VITE_APP_VERSION which was never set,
    // leaving every renderer-side Sentry event with no release identifier.
    release: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : undefined,

    tracesSampleRate: import.meta.env.PROD ? 0.2 : 1.0,
    replaysSessionSampleRate: 0,
    replaysOnErrorSampleRate: import.meta.env.PROD ? 1.0 : 0,

    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        maskAllText: true,
        maskAllInputs: true,
        blockAllMedia: true,
      }),
    ],

    beforeSend(event, hint) {
      // Drop expected errors (e.g. "Encryption unavailable" UX state)
      const origErr = hint?.originalException;
      if (origErr instanceof Error && (origErr as any).__expected) return null;

      if (event.request?.headers) {
        delete event.request.headers['Authorization'];
        delete event.request.headers['authorization'];
        delete event.request.headers['Cookie'];
      }
      if (event.request?.url) {
        try {
          const u = new URL(event.request.url, window.location.origin);
          u.searchParams.delete('token');
          u.searchParams.delete('key');
          u.searchParams.delete('code');
          u.searchParams.delete('state');
          event.request.url = u.toString();
        } catch { /* malformed URL, leave as-is */ }
      }
      // Truncate long exception values that may contain message content or DM plaintext
      if (event.exception?.values) {
        for (const exc of event.exception.values) {
          if (exc.value && exc.value.length > 200) {
            exc.value = exc.value.slice(0, 150) + ' [truncated by Howl]';
          }
        }
      }
      return event;
    },

    beforeBreadcrumb(breadcrumb) {
      if (breadcrumb.category === 'xhr' || breadcrumb.category === 'fetch') {
        if (breadcrumb.data?.url) {
          try {
            const u = new URL(breadcrumb.data.url, window.location.origin);
            u.searchParams.delete('token');
            u.searchParams.delete('key');
            breadcrumb.data.url = u.toString();
          } catch { /* malformed URL */ }
        }
        delete breadcrumb.data?.request_body;
      }
      if (breadcrumb.category === 'navigation' && breadcrumb.data) {
        for (const field of ['from', 'to'] as const) {
          if (breadcrumb.data[field]) {
            try {
              const u = new URL(breadcrumb.data[field], window.location.origin);
              u.searchParams.delete('code');
              u.searchParams.delete('token');
              u.searchParams.delete('state');
              u.searchParams.delete('key');
              breadcrumb.data[field] = u.toString();
            } catch { /* malformed URL */ }
          }
        }
      }
      return breadcrumb;
    },

    ignoreErrors: [
      'ResizeObserver loop',
      'Non-Error promise rejection captured',
      /Loading chunk \d+ failed/,
      'Network Error',
      // Cloudflare Turnstile 300xxx codes are "generic challenge failure"
      // (transient/environmental — ad blockers, VPNs, network blips) and
      // are auto-retried by the widget itself. Not actionable; sitekey/CSP
      // bugs would surface in 110xxx/400xxx instead.
      /\[Cloudflare Turnstile\] Error: 300\d{3}/,
    ],
  });

  _sentryInitialized = true;
}

// Auto-init if consent was previously granted
initSentryIfConsented();

export { Sentry };
export function sentryEnabled(): boolean { return _sentryInitialized; }
