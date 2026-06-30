// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Log-string sanitizer used by `pino-http` and `Sentry.beforeSend`.
 *
 * Two guarantees:
 *   1. Control characters (`\x00`–`\x1F`, `\x7F`) are stripped so adversarial
 *      URLs cannot inject log-forging newlines / ANSI sequences.
 *   2. Sensitive query parameters are replaced with `[REDACTED]` before the
 *      string is written. This specifically covers OAuth / SSO callback URLs
 *      which land at paths like `/api/v1/sso/<provider>/callback?code=...&state=...`
 *      and would otherwise leak short-lived single-use authorization codes
 *      into transport logs.
 *
 * Input is a path-relative URL (`req.url`), not an absolute URL — we deliberately
 * avoid `new URL()` to skip the fake-base dance and preserve exact byte layout
 * (param order, empty values, malformed pairs).
 *
 * OAuth query parameters are case-sensitive per RFC 6749, so the match is
 * case-sensitive on the decoded key.
 */

export const SENSITIVE_QUERY_PARAMS: readonly string[] = [
  'code',
  'state',
  'access_token',
  'id_token',
  'token',
  'key',
  'nonce',
];

const SENSITIVE_QUERY_PARAM_SET: ReadonlySet<string> = new Set(SENSITIVE_QUERY_PARAMS);

export function sanitizeLogString(s: string): string {
  // 1) Strip control chars.
  // eslint-disable-next-line no-control-regex -- log output must not carry terminal control seqs
  const cleaned = s.replace(/[\x00-\x1F\x7F]/g, '');

  // 2) Redact sensitive query params if this looks like a URL with a query string.
  const qIdx = cleaned.indexOf('?');
  if (qIdx === -1) return cleaned;

  const pathPart = cleaned.slice(0, qIdx);
  const queryStr = cleaned.slice(qIdx + 1);

  // Manual parse — `new URL()` requires a base and would re-encode the path.
  const parts = queryStr.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1) return pair; // bare param (`?foo`) — not a key=value, leave intact
    const rawKey = pair.slice(0, eq);
    let decodedKey: string;
    try {
      decodedKey = decodeURIComponent(rawKey);
    } catch {
      decodedKey = rawKey;
    }
    return SENSITIVE_QUERY_PARAM_SET.has(decodedKey)
      ? `${rawKey}=[REDACTED]`
      : pair;
  });

  return `${pathPart}?${parts.join('&')}`;
}
