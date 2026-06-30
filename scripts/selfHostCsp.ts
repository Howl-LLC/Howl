// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// scripts/selfHostCsp.ts
// Domain-agnostic CSP for self-hosted builds. Permissive enough to work on any
// operator domain + any bring-your-own LiveKit + optional S3/CDN, while keeping
// object-src/base-uri/form-action locked down.
export function selfHostCspContent(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "connect-src 'self' https: wss:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'self' https://www.youtube-nocookie.com https://open.spotify.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ') + ';';
}

export function applySelfHostCsp(html: string): string {
  return html.replace(
    /(<meta http-equiv="Content-Security-Policy" content=")[^"]*(">)/,
    `$1${selfHostCspContent()}$2`,
  );
}
