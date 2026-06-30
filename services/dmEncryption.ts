// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * DM encryption integration layer.
 * Delegates to mlsCoordinator + dmKeyManager for E2E encryption. MLS is the
 * only message path; there is no legacy codec.
 */
import { Message } from '../types';
import * as dmKeyManager from './dmKeyManager';
import { isChannelMls } from './encryptionFlags';
import * as mlsCoordinator from './mls/mlsCoordinator';
import type { MlsTier } from './mls/roomKey';
import { isMlsEnvelopeV4 } from './mls/types';
import { apiClient } from './api';
import { useUiStore } from '../stores/uiStore';

export const ENCRYPTED_PLACEHOLDER = '\u{1F512} Encrypted message';

interface DMChannelInfo {
  id: string;
  encrypted?: boolean;
  isGroup?: boolean;
  otherUser?: { id: string } | null;
  otherUsers?: Array<{ id: string }>;
}

let _currentUserId: string | null = null;

// Sender-side plaintext cache for files we've just encrypted+uploaded ourselves.
// Keyed by the upload URL (relative `/api/uploads/<uuid>.enc`). Lets the sender
// render their own attachments directly from the local File without round-tripping
// through CDN→fetch→decrypt — which races CDN edge cache warm-up on fresh PUTs and
// surfaces as "Could not load image" until a hard refresh.
// FIFO-evicted at 20 entries; File objects reference their source rather than
// holding bytes in memory, so this stays cheap.
const _localPlaintextBlobs = new Map<string, Blob>();
const LOCAL_PLAINTEXT_BLOB_CAP = 20;

function rememberLocalPlaintext(uploadUrl: string, blob: Blob): void {
  // Same eviction shape as backend's cappedMapSet:
  // only evict when adding a new key, not when overwriting an existing one.
  if (_localPlaintextBlobs.size >= LOCAL_PLAINTEXT_BLOB_CAP && !_localPlaintextBlobs.has(uploadUrl)) {
    const oldestKey = _localPlaintextBlobs.keys().next().value;
    if (oldestKey !== undefined) _localPlaintextBlobs.delete(oldestKey);
  }
  _localPlaintextBlobs.set(uploadUrl, blob);
}

/** Extract the `/api/uploads/<filename>` portion from a full or relative URL. */
function uploadPathOf(urlOrPath: string): string {
  const idx = urlOrPath.indexOf('/api/uploads/');
  return idx >= 0 ? urlOrPath.slice(idx) : urlOrPath;
}

export function getCurrentUserId(): string | null {
  return _currentUserId;
}

// Re-export lightweight flag functions from encryptionFlags
export { setChannelEncryptionStatus, isChannelEncrypted, isChannelEncryptionKnown, clearEncryptionStatus } from './encryptionFlags';

/**
 * Drop the sender-side plaintext cache. Called on every session boundary —
 * including idle expiry and cross-tab logout where E2E key material is
 * intentionally preserved — because plaintext attachment bytes from a prior
 * session must not survive into the next one on a shared browser.
 */
export function clearLocalPlaintextCache(): void {
  _localPlaintextBlobs.clear();
}

export function clearDmEncryptionState(): void {
  _currentUserId = null;
  _localPlaintextBlobs.clear();
}

export async function clearAllDmEncryptionData(): Promise<void> {
  // Full sign-out: scrub ALL in-memory E2EE key material. Login/logout are
  // in-SPA transitions with no page reload, so without reset() the prior
  // user's X25519/Ed25519 private keys, the Argon2id-derived AES key, and
  // every channel key stay live in dmKeyManager module memory and remain
  // readable via the exported getters until the next user unlocks. On a
  // shared device that is a cross-account private-key exposure.
  // reset() is async (it also wipes the durable device-local MLS store, incl.
  // the local history archive) — await it so the wipe completes before logout
  // proceeds.
  await dmKeyManager.reset();
  _currentUserId = null;
  _localPlaintextBlobs.clear();
}

/**
 * Session-end teardown for paths that PRESERVE the on-disk wrapped credential
 * (idle expiry, cross-tab logout, server session-expiry): scrub the decrypted
 * key material from memory but keep the remembered credential so the next
 * unlock stays seamless. "Preserve encryption" means keep the wrapped
 * credential on disk, NOT keep decrypted keys hot in RAM.
 */
export function lockEncryptionForSessionEnd(): void {
  dmKeyManager.lock();
  clearLocalPlaintextCache();
  // Release the history-sync lease (so another tab can take over) and reset the
  // per-session restore dedupe — but do NOT wipe the durable local history
  // store, which must survive an idle-lock for a seamless re-unlock.
  void import('./mls/mlsHistoryLocks').then((m) => m.releaseHistorySyncLease()).catch(() => {});
  void import('./mls/mlsHistoryRestore').then((m) => m.resetHistoryRestore()).catch(() => {});
}

/**
 * Module-level guard so the dmKeyManager lock-state subscriber is wired
 * exactly once per page load, even if `initializeEncryption` is called
 * again after an account switch. Re-subscribing would multiply emits and
 * leak the listener across the user lifetime.
 */
let _lockSubscribed = false;

export function initializeEncryption(userId: string): void {
  _currentUserId = userId;

  if (!_lockSubscribed) {
    _lockSubscribed = true;
    dmKeyManager.on(() => {
      // Recompute from authoritative source rather than trusting the event
      // name — avoids races where 'unlocked' fires but a concurrent reset
      // already locked the manager again.
      const locked = dmKeyManager.isSetup() && !dmKeyManager.isUnlocked();
      try {
        useUiStore.getState().setE2eLocked(locked);
      } catch (err) {
        console.error('[diag][e2e-emit] setE2eLocked threw', err);
      }
    });
  }
}

/** Parse E2E file metadata envelope from decrypted content. Returns null if not a file envelope. */
export function parseE2eeFileEnvelope(content: string): {
  text: string;
  file: {
    url: string;
    key: string;
    name: string;
    type: string;
    size: number;
    thumbUrl?: string;
    thumbKey?: string;
    thumbWidth?: number;
    thumbHeight?: number;
  };
} | null {
  if (!content.startsWith('{"text":')) return null;
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed === 'object' && parsed !== null && 'text' in parsed && 'file' in parsed && typeof parsed.file?.url === 'string' && typeof parsed.file?.key === 'string') {
      return parsed;
    }
  } catch { /* not JSON */ }
  return null;
}

/** True for any DM envelope shape: v4 MLS, or the dead v2/v3 legacy formats.
 *  Used only to decide placeholder-vs-passthrough on channels that are not
 *  (yet) classified 'mls'. Detection only; nothing here can decrypt. */
function looksLikeEnvelope(content: string): boolean {
  if (isMlsEnvelopeV4(content)) return true;
  try {
    const parsed = JSON.parse(content);
    if (!parsed) return false;
    if (typeof parsed.iv !== 'string' || typeof parsed.ct !== 'string') return false;
    return parsed.v === 2 || parsed.v === 3;
  } catch {
    return false;
  }
}

/**
 * MLS-channel content decryptor. Reached ONLY when isChannelMls(dmChannelId).
 * A v4 envelope -> mlsCoordinator.decrypt, then parse any file envelope; anything
 * else (stray v2/v3, non-envelope) or a decrypt failure -> ENCRYPTED_PLACEHOLDER.
 * Never legacy-decrypts, never drops.
 *
 * Returns the display content plus parsed file info (null when not a file msg or
 * when undecryptable). For a file message `content` is `fileInfo.text || ''` —
 * empty caption is correct because the attachment is surfaced via fields on the
 * Message; object-returning funnels read `fileInfo`, and the scalar funnel
 * (decryptDMContent) maps an empty caption to its own '(attachment)' fallback.
 */
async function decryptMlsContent(
  dmChannelId: string,
  content: string,
  messageId?: string,
  tier: MlsTier = 'saved',
): Promise<{ content: string; fileInfo: ReturnType<typeof parseE2eeFileEnvelope> }> {
  if (!isMlsEnvelopeV4(content)) return { content: ENCRYPTED_PLACEHOLDER, fileInfo: null };
  try {
    const decrypted = await mlsCoordinator.decrypt(dmChannelId, content, messageId, tier);
    const fileInfo = parseE2eeFileEnvelope(decrypted);
    return { content: fileInfo ? (fileInfo.text || '') : decrypted, fileInfo };
  } catch {
    return { content: ENCRYPTED_PLACEHOLDER, fileInfo: null };
  }
}

export async function encryptDMContent(
  dmChannelId: string,
  plaintext: string,
  _channel?: DMChannelInfo,
  tier: MlsTier = 'saved',
): Promise<{ content: string; encrypted: boolean; failedRecipients?: string[] }> {
  // MLS-classified channels (1:1 DMs) route through the MLS coordinator.
  // Fail closed: if the coordinator isn't ready we throw. There is
  // no rung below MLS; the tail of this function is a fail-closed throw (no
  // silent downgrade).
  if (isChannelMls(dmChannelId)) {
    if (!mlsCoordinator.isReadyForChannel(dmChannelId, tier)) {
      throw new Error('Encryption unavailable — unlock encryption to send messages.');
    }
    const content = await mlsCoordinator.encrypt(dmChannelId, plaintext, tier);
    return { content, encrypted: true };
  }

  // No rung below MLS. A channel not classified 'mls' (or not ready)
  // fails closed; there is no legacy AES path.
  throw new Error('Encryption unavailable — unlock encryption to send messages.');
}

export async function decryptDMContent(
  dmChannelId: string,
  ciphertext: string,
  _isEncrypted: boolean,
  senderUserId?: string,
  messageId?: string,
  tier: MlsTier = 'saved',
): Promise<string> {
  // MLS-classified channels never touch the legacy key path: route through the
  // MLS coordinator (v4 -> decrypt; anything else / failure -> placeholder).
  // This scalar funnel has no attachment fields to surface, so a file message
  // collapses to its caption or the '(attachment)' display fallback (the same
  // file-envelope behavior the legacy decryptDMContent path used to give).
  if (isChannelMls(dmChannelId)) {
    const { content, fileInfo } = await decryptMlsContent(dmChannelId, ciphertext, messageId, tier);
    if (fileInfo) return fileInfo.text || '(attachment)';
    return content;
  }

  // The legacy v2/v3 read path is gone. Any envelope-shaped content on an
  // unclassified channel renders the placeholder (pre-MLS rows permanently;
  // a racing fresh channel until the Welcome drain classifies it 'mls' and
  // useMlsRedecrypt heals). Non-envelope content (legacy plaintext rows,
  // system text) passes through.
  if (looksLikeEnvelope(ciphertext)) return ENCRYPTED_PLACEHOLDER;
  return ciphertext;
}

/** Alias kept for call sites that pass a messageId — delegates to decryptDMContent. */
export function decryptDMContentCached(
  dmChannelId: string,
  messageId: string,
  ciphertext: string,
  isEncrypted: boolean,
  senderUserId?: string,
): Promise<string> {
  return decryptDMContent(dmChannelId, ciphertext, isEncrypted, senderUserId, messageId);
}

export async function decryptDMMessages(
  dmChannelId: string,
  messages: Message[],
  _isEncrypted: boolean,
  _channel?: DMChannelInfo,
): Promise<Message[]> {
  // MLS-classified channels never touch the legacy key path: route every
  // message (and reply) through the MLS coordinator. v4 -> decrypt; anything
  // else / failure -> placeholder. System messages pass through untouched.
  // File messages surface the attachment via fields (attachmentUrl /
  // _encryptedFileKey) the same way the legacy path used to; `content` is the
  // caption (empty for a caption-less file, the attachment carries it).
  if (isChannelMls(dmChannelId)) {
    // In-order catch-up: drive the single-use ratchet oldest-first so a fresh
    // backlog never asks for a forward jump beyond maximumForwardRatchetSteps.
    // Decrypt in timestamp-ascending order; emit in the caller's original order.
    const order = messages.map((_, i) => i).sort((a, b) => {
      const ta = new Date(messages[a].timestamp).getTime();
      const tb = new Date(messages[b].timestamp).getTime();
      return (ta - tb) || (a - b);
    });
    const builtById = new Map<string, Message>();
    for (const idx of order) {
      const msg = messages[idx];
      if (msg.type === 'system') { builtById.set(msg.id, msg); continue; }
      const { content, fileInfo } = await decryptMlsContent(dmChannelId, msg.content, msg.id);
      const undecryptable = content === ENCRYPTED_PLACEHOLDER;
      let replyTo = msg.replyTo;
      if (replyTo?.content) {
        const { content: replyContent, fileInfo: replyFileInfo } = await decryptMlsContent(dmChannelId, replyTo.content, replyTo.id);
        // Match the legacy reply-quote: a caption-less file shows '(attachment)'.
        replyTo = { ...replyTo, content: replyFileInfo?.file ? (replyFileInfo.text || '(attachment)') : replyContent };
      }
      builtById.set(msg.id, {
        ...msg,
        content,
        undecryptable,
        _encryptedEnvelope: undecryptable ? msg.content : undefined,
        ...(replyTo && { replyTo }),
        ...(fileInfo?.file && {
          attachmentUrl: fileInfo.file.url,
          attachmentName: fileInfo.file.name,
          attachmentContentType: fileInfo.file.type,
          attachmentSize: fileInfo.file.size,
          _encryptedFileKey: fileInfo.file.key,
        }),
      });
    }
    return messages.map((m) => builtById.get(m.id) ?? m);
  }

  // No legacy key path. Envelope-shaped rows on an unclassified channel
  // are stamped HEALABLE (undecryptable + preserved ciphertext) so the
  // useMlsRedecrypt sweep recovers them the moment the Welcome drain
  // classifies the channel 'mls' (socket-ordering race: new-dm-message can
  // beat mls-welcome on a brand-new channel). Pre-MLS v2/v3 rows stay on the
  // placeholder permanently (full teardown), which is the same stamped shape.
  const results: Message[] = [];
  for (const msg of messages) {
    if (msg.type === 'system') {
      results.push(msg);
      continue;
    }
    const isEnvelope = looksLikeEnvelope(msg.content);
    let replyTo = msg.replyTo;
    if (replyTo?.content && looksLikeEnvelope(replyTo.content)) {
      replyTo = { ...replyTo, content: ENCRYPTED_PLACEHOLDER, _encryptedContent: replyTo.content };
    }
    results.push({
      ...msg,
      content: isEnvelope ? ENCRYPTED_PLACEHOLDER : msg.content,
      ...(isEnvelope && { undecryptable: true, _encryptedEnvelope: msg.content }),
      ...(replyTo && { replyTo }),
    });
  }
  return results;
}

export async function decryptSingleDMMessage(
  dmChannelId: string,
  message: Message,
  _channel?: DMChannelInfo,
  tier: MlsTier = 'saved',
): Promise<Message> {
  if (message.type === 'system') return message;
  // MLS-classified channels never touch the legacy key path: route through the
  // MLS coordinator. v4 -> decrypt; anything else / failure -> placeholder.
  // File messages surface the attachment via fields the same way the legacy
  // single-message path used to.
  if (isChannelMls(dmChannelId)) {
    const { content, fileInfo } = await decryptMlsContent(dmChannelId, message.content, message.id, tier);
    const undecryptable = content === ENCRYPTED_PLACEHOLDER;
    return {
      ...message,
      content,
      undecryptable,
      _encryptedEnvelope: undecryptable ? message.content : undefined,
      ...(fileInfo?.file && {
        attachmentUrl: fileInfo.file.url,
        attachmentName: fileInfo.file.name,
        attachmentContentType: fileInfo.file.type,
        attachmentSize: fileInfo.file.size,
        _encryptedFileKey: fileInfo.file.key,
      }),
    };
  }
  if (looksLikeEnvelope(message.content)) {
    return {
      ...message,
      content: ENCRYPTED_PLACEHOLDER,
      undecryptable: true,
      _encryptedEnvelope: message.content,
    };
  }
  return message;
}

export async function encryptAndUploadFile(
  file: File,
  dmChannelId: string,
  _channel?: DMChannelInfo,
): Promise<{
  url: string;
  name: string;
  type: string;
  size: number;
  key: string;
  thumbUrl?: string;
  thumbKey?: string;
  thumbWidth?: number;
  thumbHeight?: number;
}> {
  if (!dmKeyManager.isUnlocked()) {
    throw new Error('Encryption unavailable — unlock encryption to upload files.');
  }

  const { generateFileKey, encryptFile, generateThumbnail, fileKeyToBase64 } = await import('./fileCrypto');

  // Encrypt the file
  const fileKey = generateFileKey();
  const encryptedBlob = await encryptFile(file, fileKey);

  // Upload encrypted file with UUID.enc filename — no content inspection (E2E)
  const encName = `${crypto.randomUUID()}.enc`;
  const fileResp = await apiClient.uploadEncryptedFile(encryptedBlob, encName, dmChannelId);

  // Stash the original plaintext so our own client renders it locally instead of
  // re-fetching from CDN (which races edge warm-up on fresh PUTs).
  rememberLocalPlaintext(uploadPathOf(fileResp.url), file);

  const result: {
    url: string; name: string; type: string; size: number; key: string;
    thumbUrl?: string; thumbKey?: string; thumbWidth?: number; thumbHeight?: number;
  } = {
    url: fileResp.url,
    name: file.name,
    type: file.type,
    size: file.size,
    key: fileKeyToBase64(fileKey),
  };

  // Generate and encrypt thumbnail for images
  const thumb = await generateThumbnail(file);
  if (thumb) {
    const thumbKey = generateFileKey();
    const encryptedThumb = await encryptFile(thumb.blob, thumbKey);
    const thumbName = `${crypto.randomUUID()}.enc`;
    const thumbResp = await apiClient.uploadEncryptedFile(encryptedThumb, thumbName, dmChannelId);
    rememberLocalPlaintext(uploadPathOf(thumbResp.url), thumb.blob);
    result.thumbUrl = thumbResp.url;
    result.thumbKey = fileKeyToBase64(thumbKey);
    result.thumbWidth = thumb.width;
    result.thumbHeight = thumb.height;
  }

  return result;
}

export async function fetchAndDecryptFile(
  url: string,
  fileKeyBase64: string,
  expectedSize?: number,
): Promise<Blob | null> {
  // Sender's own freshly-uploaded files are still in memory — return the
  // plaintext directly and skip the CDN round-trip (which can 4xx until the
  // edge warms up on the new R2 object).
  const local = _localPlaintextBlobs.get(uploadPathOf(url));
  if (local) return local;

  try {
    const { decryptFile, fileKeyFromBase64 } = await import('./fileCrypto');
    const fileKey = fileKeyFromBase64(fileKeyBase64);

    // Fetching the encrypted blob is a two-step hop:
    //   1. Ask the backend for the CDN URL as JSON (same-origin, so no CORS
    //      drama — the backend returns `{ url }` including a fresh HMAC
    //      signature when CDN signing is enabled).
    //   2. Fetch the CDN URL directly. Splitting it this way avoids the
    //      cross-origin 302 redirect, which either strips Origin (blocking
    //      CORS) or races Worker CORS headers depending on the browser.
    const sep = url.includes('?') ? '&' : '?';
    const metaRes = await fetch(`${url}${sep}as=json`, {
      credentials: 'include',
      signal: AbortSignal.timeout(10000),
    });
    if (!metaRes.ok) return null;
    const { url: fetchUrl } = await metaRes.json() as { url: string };
    if (!fetchUrl) return null;

    const response = await fetch(fetchUrl, { signal: AbortSignal.timeout(30000) });
    if (!response.ok) return null;
    const encryptedBlob = await response.blob();
    const decrypted = await decryptFile(encryptedBlob, fileKey);
    // Cross-check the reassembled plaintext length against the
    // MLS-authenticated file size (sealed in the message envelope, so a
    // blob-bytes / CDN / R2 adversary cannot forge it). This is the only control
    // that catches a trailing whole-chunk drop or a length-changing duplication
    // (incl. v3, whose per-chunk AAD binds only the local index, not the total
    // count); the per-chunk IV check in decryptChunked handles same-length v2
    // reorders/dups. Fail closed (return null) on mismatch, matching the existing
    // failure contract. Best-effort: callers that don't pass expectedSize (legacy
    // pre-MLS attachments, thumbnails) get no cross-check and rely on Layer 1.
    if (typeof expectedSize === 'number' && decrypted.size !== expectedSize) {
      return null;
    }
    return decrypted;
  } catch {
    return null;
  }
}
