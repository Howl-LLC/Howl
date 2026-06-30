// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { prisma } from '../db.js';

/**
 * An encrypted (E2E DM) upload skips ALL server-side content
 * safety (MIME magic-byte, EXIF strip, decompression-bomb, SHA-256/NCMEC,
 * PDQ/CSAM) because the bytes are ciphertext. Such a blob must never be attached
 * to a plaintext, multi-recipient server surface (channel/forum/thread message,
 * role icon, etc.). The upload route records an `ImageHash` row with
 * `encrypted: true` for every encrypted upload; these helpers let any send/set
 * path reject a URL that points at one.
 */

// Matches the stored upload filename in any URL form the serve route accepts:
// relative `/api/uploads/<f>`, the `/api/v1/uploads/<f>` mount, and absolute
// backend-origin URLs. `[^/?#]+` stops at the next path separator, a query, or a
// fragment, so a trailing slash (`/api/uploads/<f>/`) or `?cachebust=1` cannot
// hide the real filename the serve route resolves.
const UPLOAD_PATH_RE = /\/api\/(?:v1\/)?uploads\/([^/?#]+)/;

/**
 * Extract the stored upload filename from an attachment/asset URL, normalized the
 * same way the serve route resolves `:filename` (single path segment, query/
 * fragment stripped, percent-decoded once). Returns null when the URL does not
 * point at a local upload (e.g. an external/CDN URL), in which case there is no
 * provenance row to check and other validators apply.
 */
export function extractUploadFilename(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = UPLOAD_PATH_RE.exec(url);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1]; // malformed percent-escape: fall back to the raw segment
  }
}

export type AttachmentCheck = { ok: true } | { ok: false; status: number; error: string };

/**
 * Fail-closed check for whether a client-supplied attachment/asset URL points at
 * an encrypted (scan-skipped) upload. Returns `{ ok: false, 400 }` to reject an
 * encrypted blob, `{ ok: false, 503 }` if the provenance lookup itself fails (we
 * refuse rather than risk attaching unscanned content), and `{ ok: true }` for
 * non-upload URLs or genuinely scanned uploads.
 */
export async function checkUploadAttachment(url: string | null | undefined): Promise<AttachmentCheck> {
  const filename = extractUploadFilename(url);
  if (!filename) return { ok: true };
  try {
    const row = await prisma.imageHash.findFirst({
      where: { filename, encrypted: true },
      select: { id: true },
    });
    if (row) {
      return { ok: false, status: 400, error: 'Encrypted attachments cannot be posted to a server surface.' };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: 'Unable to verify attachment. Please try again in a moment.' };
  }
}
