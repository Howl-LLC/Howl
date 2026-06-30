// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// services/buildDate.ts
// Resolves the client's build date (ISO "YYYY-MM-DD"). On web, uses the
// Vite-injected __BUILD_DATE__ constant (known synchronously at module load).
// In Electron, asynchronously refreshes the cache from the packaged build date
// via preload IPC — fire-and-forget, never awaited on the hot path, because
// SocketService.connect() must create the socket synchronously so that sibling
// React effects on the same commit see a non-null this.socket.

let _cached: string = typeof __BUILD_DATE__ !== 'undefined'
  ? __BUILD_DATE__
  : new Date().toISOString().slice(0, 10);

if (typeof window !== 'undefined' && window.electron?.getBuildDate) {
  window.electron.getBuildDate()
    .then((d) => { if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) _cached = d; })
    .catch(() => { /* ignore; __BUILD_DATE__ fallback already in _cached */ });
}

export function resolveBuildDateSync(): string {
  return _cached;
}

export async function resolveBuildDate(): Promise<string> {
  return _cached;
}
