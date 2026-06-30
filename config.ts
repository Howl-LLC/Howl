// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Backend base URL for API and WebSocket.
 *
 * Resolution order:
 * 1. Build-time __BACKEND_URL__ (injected by build-release.mjs for Electron releases)
 * 2. VITE_BACKEND_URL env var (set at build time for web deploys)
 * 3. VITE_SAME_ORIGIN=true → use window.location.origin
 * 4. Electron (file:// protocol) → http://localhost:<port>
 * 5. localhost / 127.0.0.1 → http://localhost:<port>
 * 6. LAN IP (192.168.x.x / 10.x.x.x) → same host on port 5000
 * 7. app.<domain> → https://api.<domain> (production convention)
 * 8. Fallback: same host on backend port
 */

declare const __BACKEND_URL__: string | undefined;

const BACKEND_PORT =
  typeof import.meta !== 'undefined' && typeof import.meta.env?.VITE_BACKEND_PORT === 'string'
    ? import.meta.env.VITE_BACKEND_PORT
    : '5000';

const BUILD_TIME_URL: string =
  typeof __BACKEND_URL__ === 'string' ? __BACKEND_URL__.replace(/\/$/, '') : '';

const BACKEND_URL_OVERRIDE =
  BUILD_TIME_URL ||
  (typeof import.meta !== 'undefined' && typeof import.meta.env?.VITE_BACKEND_URL === 'string'
    ? import.meta.env.VITE_BACKEND_URL.replace(/\/$/, '')
    : '');

const SAME_ORIGIN =
  typeof import.meta !== 'undefined' && import.meta.env?.VITE_SAME_ORIGIN === 'true';

function isPrivateHost(hostname: string): boolean {
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  return false;
}

function isTunnelHost(hostname: string): boolean {
  return /\.ngrok(-free)?\.dev$/i.test(hostname) ||
    /\.ngrok\.io$/i.test(hostname) ||
    /\.loca\.lt$/i.test(hostname) ||
    /\.trycloudflare\.com$/i.test(hostname);
}

/**
 * Map app.<domain> → api.<domain> for known production hosts only.
 * In production builds VITE_BACKEND_URL should always be set (bypassing this entirely),
 * but this guard prevents credential theft if the frontend is served from an unknown domain.
 */
const KNOWN_APP_HOSTS: ReadonlySet<string> = new Set(
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_KNOWN_APP_HOSTS)
    ? (import.meta.env.VITE_KNOWN_APP_HOSTS as string).split(',').map((h: string) => h.trim().toLowerCase())
    : ['app.howlpro.com']
);

function inferApiOrigin(host: string, protocol: string): string | null {
  if (!KNOWN_APP_HOSTS.has(host.toLowerCase())) return null;
  const m = /^app\.(.+)$/.exec(host);
  if (!m) return null;
  return `${protocol}//api.${m[1]}`;
}

/**
 * Canonical Electron detection. Packaged Electron now loads the production
 * web bundle from https://app.howlpro.com (same origin as web users), so
 * there is no custom protocol to key off of — rely on the preload's
 * contextBridge exposure of `window.electron`. `file:` is kept as a legacy
 * fallback; `__ELECTRON_WINDOW__` is set by the preload as a belt-and-
 * suspenders signal for the rare preload-race on startup.
 */
export function isElectron(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.protocol === 'file:' ||
    window.electron?.isElectron === true ||
    window.__ELECTRON_WINDOW__ === true;
}

/**
 * Canonical web origin for shareable URLs (copy message link, copy invite link,
 * etc.). In Electron `window.location.origin` is `howl-app://app` which is
 * unusable outside the app, so we return the production web frontend origin.
 * Override at build time via VITE_FRONTEND_ORIGIN; otherwise falls back to
 * `https://app.howlpro.com`.
 */
export function getWebOrigin(): string {
  const buildOverride = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_FRONTEND_ORIGIN) || '';
  if (buildOverride) return String(buildOverride).replace(/\/$/, '');
  if (typeof window !== 'undefined' && !isElectron()) return window.location.origin;
  return 'https://app.howlpro.com';
}

export function getBackendOrigin(): string {
  if (typeof window === 'undefined') return `http://localhost:${BACKEND_PORT}`;

  if (BACKEND_URL_OVERRIDE) return BACKEND_URL_OVERRIDE;
  if (SAME_ORIGIN) return window.location.origin;

  if (window.location.protocol === 'https:' && !isElectron()) {
    return window.location.origin;
  }

  const host = window.location.hostname;
  const protocol = window.location.protocol;

  // Dev Electron loads from localhost or file:// (legacy) without a real host.
  // Packaged Electron is at https://app.howlpro.com so it falls through to the
  // same inferApiOrigin path the web uses.
  if (protocol === 'file:' || !host) {
    return `http://localhost:${BACKEND_PORT}`;
  }

  const isLocal = host === 'localhost' || host === '127.0.0.1';
  const isDev = typeof import.meta !== 'undefined' && import.meta.env?.DEV;

  // In dev-browser mode, use same-origin so requests route through the
  // Vite proxy (/api → :5000, /socket.io → :5000). This avoids cross-origin
  // CSP violations and matches how production works (API behind same origin).
  if (isLocal && isDev) return window.location.origin;

  if (isLocal) return `http://localhost:${BACKEND_PORT}`;

  if (isPrivateHost(host) && isDev) return window.location.origin;
  if (isPrivateHost(host)) return `${protocol}//${host}:${BACKEND_PORT}`;

  if (isTunnelHost(host)) return window.location.origin;

  const inferred = inferApiOrigin(host, protocol);
  if (inferred) return inferred;

  return `${protocol}//${host}:${BACKEND_PORT}`;
}

export const API_BASE_URL = typeof window !== 'undefined' ? `${getBackendOrigin()}/api/v1` : `http://localhost:${BACKEND_PORT}/api/v1`;
export const WS_URL = typeof window !== 'undefined' ? getBackendOrigin() : `http://localhost:${BACKEND_PORT}`;

/** LiveKit WebSocket URL for voice/video SFU. Falls back to localhost only in development. */
export const LIVEKIT_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_LIVEKIT_URL) ||
  (typeof import.meta !== 'undefined' && import.meta.env?.DEV ? 'ws://localhost:7880' : '');

export const CDN_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_CDN_URL)
    ? (import.meta.env.VITE_CDN_URL as string).replace(/\/$/, '')
    : '';

/** AdSense: when set, real ad slots are rendered on the home page; when unset, placeholders show. */
export const ADSENSE_CLIENT_ID =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADSENSE_CLIENT_ID) || '';

/** AdSense slot ID for the header ad unit on the home page. */
export const ADSENSE_SLOT_HEADER =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADSENSE_SLOT_HEADER) || '';

/** AdSense slot ID for the sidebar ad unit on the home page. */
export const ADSENSE_SLOT_SIDEBAR =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_ADSENSE_SLOT_SIDEBAR) || '';

/** @deprecated Klipy API key is now proxied through the backend. This export is kept for compatibility but always returns empty. */
export const KLIPY_API_KEY = '';
