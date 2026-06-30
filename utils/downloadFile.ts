// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Cross-platform file download utility.
 *
 * Web: fetch → blob → createObjectURL → <a download> → click → revoke.
 * Electron: IPC to main process which uses dialog.showSaveDialog + fs.writeFile.
 *
 * Emits 'howl:download-toast' CustomEvents for toast feedback so callers
 * don't need access to React toast hooks.
 */

function inferFileName(url: string, fallback = 'download'): string {
  try {
    const pathname = new URL(url, window.location.origin).pathname;
    const last = pathname.split('/').pop();
    if (last && last.includes('.')) return decodeURIComponent(last);
  } catch { /* ignore */ }
  return fallback;
}

function emitToast(message: string, type: 'info' | 'warning' = 'info') {
  window.dispatchEvent(new CustomEvent('howl:download-toast', { detail: { message, type } }));
}

function triggerBlobDownload(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 200);
}

/**
 * Download a blob that's already in memory (text files, decrypted content).
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunks: string[] = [];
  // Process in 8KB slices to avoid call-stack overflow from spread operator
  for (let i = 0; i < bytes.length; i += 8192) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
  }
  return btoa(chunks.join(''));
}

/**
 * Download a blob that's already in memory (text files, decrypted content).
 */
export async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  try {
    if (window.electron?.downloadBlob) {
      const buffer = await blob.arrayBuffer();
      const base64 = arrayBufferToBase64(buffer);
      const success = await window.electron.downloadBlob(base64, fileName);
      if (success) {
        emitToast(`Downloaded ${fileName}`);
      }
      return;
    }
    triggerBlobDownload(blob, fileName);
    emitToast(`Downloaded ${fileName}`);
  } catch {
    emitToast('Failed to download', 'warning');
  }
}

/**
 * Download a file from a URL. Fetches it as a blob first so the `download`
 * attribute works even for cross-origin resources.
 *
 * @param url       - The file URL
 * @param fileName  - Suggested file name (falls back to URL-derived name)
 * @param token     - Optional auth token for same-origin backend requests
 */
export async function downloadUrl(url: string, fileName?: string, token?: string | null): Promise<void> {
  const name = fileName || inferFileName(url);
  try {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    await downloadBlob(blob, name);
  } catch {
    emitToast('Failed to download', 'warning');
  }
}
