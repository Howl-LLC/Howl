// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Sentry instrumentation for the backend.
 *
 * MUST be imported before any other application modules (especially Express)
 * so Sentry can monkey-patch HTTP, Express, and Prisma for automatic tracing.
 *
 * Set SENTRY_DSN in your environment to enable. When unset, Sentry is a no-op.
 */

import * as Sentry from '@sentry/node';
import { SENSITIVE_QUERY_PARAMS } from './utils/sanitizeLogString.js';

const dsn = process.env.SENTRY_DSN || '';

/** Strip sensitive params from a leading-'?' query string (URL.search shape).
 * Returns the scrubbed query keeping the leading '?' when non-empty, '' when empty. */
function scrubQueryString(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  for (const param of SENSITIVE_QUERY_PARAMS) params.delete(param);
  const out = params.toString();
  return out ? `?${out}` : '';
}

/**
 * Scrub sensitive data from Sentry breadcrumbs (frontend parity with
 * src/sentry.ts). The @sentry/node SDK emits category 'http' for outgoing
 * http/fetch requests, putting the SANITIZED path in `data.url` and the raw query
 * string in `data['http.query']` (e.g. `?key=<STEAM_API_KEY>&steamid=...`). Scrub
 * `http.query` — that is where outgoing-request secrets actually land — and also
 * scrub `data.url` (a no-op for node's path-only url, but covers browser-shaped
 * breadcrumbs), and drop any captured request body. Pure + exported for testing.
 */
export function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb): Sentry.Breadcrumb {
  const cat = breadcrumb.category;
  if (cat === 'http' || cat === 'fetch' || cat === 'xhr') {
    const data = breadcrumb.data as Record<string, unknown> | undefined;
    if (data) {
      if (typeof data['http.query'] === 'string') {
        data['http.query'] = scrubQueryString(data['http.query'] as string);
      }
      if (typeof data.url === 'string') {
        try {
          const u = new URL(data.url, 'https://placeholder.invalid');
          for (const param of SENSITIVE_QUERY_PARAMS) u.searchParams.delete(param);
          data.url = u.toString();
        } catch { /* malformed URL */ }
      }
      delete data.request_body;
      delete data.body;
    }
  }
  return breadcrumb;
}

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV || 'development',
    release: process.env.APP_VERSION || undefined,

    tracesSampleRate: process.env.NODE_ENV === 'production' ? 0.2 : 1.0,

    integrations: [
      Sentry.httpIntegration(),
      Sentry.expressIntegration(),
      Sentry.prismaIntegration(),
    ],

    beforeSend(event) {
      // Strip auth headers
      if (event.request?.headers) {
        delete event.request.headers['authorization'];
        delete event.request.headers['cookie'];
      }
      // Strip sensitive query params from URLs. Covers OAuth callback params
      // (`code`, `state`, `access_token`, `id_token`, `nonce`) alongside the
      // `token`/`key` scrub. Without this, Sentry events captured during a
      // failed OAuth callback would leak short-lived single-use authorization
      // codes.
      if (event.request?.url) {
        try {
          const u = new URL(event.request.url, 'https://placeholder.invalid');
          for (const param of SENSITIVE_QUERY_PARAMS) {
            u.searchParams.delete(param);
          }
          event.request.url = u.toString();
        } catch { /* malformed URL */ }
      }
      // Truncate exception values that may contain message content or PII
      if (event.exception?.values) {
        for (const exc of event.exception.values) {
          if (exc.value && exc.value.length > 200) {
            exc.value = exc.value.slice(0, 150) + ' [truncated by Howl]';
          }
        }
      }
      return event;
    },

    beforeBreadcrumb: scrubBreadcrumb,

    ignoreErrors: [
      'ECONNRESET',
      'EPIPE',
      'ERR_HTTP_HEADERS_SENT',
    ],
  });
}

export { Sentry };
export const sentryEnabled = !!dsn;
