// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Resolve a public asset path that works in both web (https://) and Electron (file://).
 * On web: "/howl-logo.png" → "/howl-logo.png" (works as-is)
 * On Electron: "/howl-logo.png" → "./howl-logo.png" (relative to index.html in dist/)
 */
export function assetPath(absolutePath: string): string {
  if (!absolutePath.startsWith('/')) return absolutePath;
  if (
    typeof window !== 'undefined' &&
    (window.location.protocol === 'file:' || (window as any).__ELECTRON_WINDOW__)
  ) {
    return '.' + absolutePath;
  }
  return absolutePath;
}
