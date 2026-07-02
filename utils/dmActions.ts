// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * DM message action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { socketService } from '../services/socket';
import { useMessageStore } from '../stores/messageStore';
import { useAuthStore } from '../stores/authStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useUiStore } from '../stores/uiStore';
import { useDmStore } from '../stores/dmStore';
import { useSocialStore } from '../stores/socialStore';
import { setChannelEncryptionStatus, isChannelEncrypted, isChannelMls, setChannelProtocol } from '../services/encryptionFlags';
import { encryptDMContent, decryptDMContentCached, parseE2eeFileEnvelope, ENCRYPTED_PLACEHOLDER } from '../services/dmEncryption';
import * as dmKeyManager from '../services/dmKeyManager';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import { pokeHistorySync } from '../services/mls/mlsHistoryArchiveSync';
import { routeEstablishOutcome, describeSendBlock } from './mlsRetry';
import { roomKey, type MlsTier } from '../services/mls/roomKey';
import type { DmChannelEntry } from '../stores/types';
import type { Message } from '../types';

/** Max messages kept in memory per channel. */
const MAX_MESSAGES_PER_CHANNEL = 1000;
const capMessages = (arr: Message[]) =>
  arr.length > MAX_MESSAGES_PER_CHANNEL ? arr.slice(-MAX_MESSAGES_PER_CHANNEL) : arr;

// Core encrypted send helper

/**
 * Encrypt and send a DM message, updating message + channel stores.
 * This is the shared send path for handleSendDMMessage, handleForwardToFriend,
 * handleForwardToDM, and handleSendMessageAndOpenDM.
 */
export async function sendEncryptedDmMessage(
  dmChannelId: string,
  plaintext: string,
  dmChannel:
    | DmChannelEntry
    | { id: string; encrypted?: boolean; isGroup?: boolean; otherUser?: { id: string } | null }
    | undefined,
  opts?: {
    replyToMessageId?: string;
    attachment?: { url: string; name: string; contentType?: string };
    isForward?: boolean;
    e2eeFileMeta?: Map<string, { key: string; name: string; type: string; size: number; thumbUrl?: string; thumbKey?: string; thumbWidth?: number; thumbHeight?: number }>;
    tier?: MlsTier;
  },
): Promise<Message> {
  const tier = opts?.tier ?? 'saved';
  // If attachment was encrypted (E2E file), embed file metadata in message content
  let textForEncryption = plaintext;
  let attachmentForApi = opts?.attachment;
  if (opts?.attachment?.url && opts?.e2eeFileMeta?.has(opts.attachment.url)) {
    const fileMeta = opts.e2eeFileMeta.get(opts.attachment.url)!;
    opts.e2eeFileMeta.delete(opts.attachment.url);
    const contentPayload = JSON.stringify({
      text: plaintext === '(attachment)' ? '' : plaintext,
      file: {
        url: opts.attachment.url,
        key: fileMeta.key,
        name: fileMeta.name,
        type: fileMeta.type,
        size: fileMeta.size,
        thumbUrl: fileMeta.thumbUrl,
        thumbKey: fileMeta.thumbKey,
        thumbWidth: fileMeta.thumbWidth,
        thumbHeight: fileMeta.thumbHeight,
      },
    });
    textForEncryption = contentPayload;
    attachmentForApi = { url: opts.attachment.url, name: fileMeta.name, contentType: fileMeta.type };
  }

  const { content: finalContent, encrypted } = await encryptDMContent(
    dmChannelId,
    textForEncryption,
    dmChannel,
    tier,
  );

  // OTR (Off the Record): ephemeral send. Rides the otr-message socket, writes the
  // optimistic message to the roomKey(id,'otr') bucket, and SKIPS the durable path
  // entirely — no REST send, no history archive, no DM-list lastMessage preview.
  // Text-only.
  if (tier === 'otr') {
    const clientMsgId = crypto.randomUUID();
    // Read otrMlsGroupId defensively so this stays tsc-clean.
    const otrGroupId = (dmChannel as { otrMlsGroupId?: string | null } | undefined)?.otrMlsGroupId;
    if (!otrGroupId) throw new Error('Off the Record is not set up for this chat');
    socketService.emitOtrMessage({ dmChannelId, mlsGroupId: otrGroupId, ciphertext: finalContent, clientMsgId });
    const optimistic: Message = {
      id: clientMsgId,
      authorId: useAuthStore.getState().currentUser?.id ?? '',
      content: textForEncryption,
      timestamp: new Date(),
      type: 'message',
    };
    const rk = roomKey(dmChannelId, 'otr');
    const msgStore = useMessageStore.getState();
    const existing = msgStore.dmMessages[rk] ?? [];
    if (!existing.some((m) => m.id === clientMsgId)) {
      msgStore._setAll({ dmMessages: { ...msgStore.dmMessages, [rk]: capMessages([...existing, optimistic]) } });
    }
    return optimistic; // NO api call, NO lastMessage, NO archive
  }

  const saved = await apiClient.sendDMMessage(
    dmChannelId,
    finalContent,
    opts?.replyToMessageId,
    attachmentForApi,
    opts?.isForward,
    encrypted,
  );
  let displayContent = encrypted ? textForEncryption : saved.content;
  // For file envelope messages, extract the text part and set file metadata
  let senderFileKey: string | undefined;
  if (encrypted && textForEncryption.startsWith('{"text":')) {
    try {
      const parsed = JSON.parse(textForEncryption);
      if (parsed.text !== undefined && parsed.file) {
        displayContent = parsed.text || '';
        senderFileKey = parsed.file.key;
      }
    } catch { /* not a file envelope */ }
  }

  // Update dmMessages store
  const msgStore = useMessageStore.getState();
  const existing = msgStore.dmMessages[dmChannelId] ?? [];
  const idx = existing.findIndex((m) => m.id === saved.id);
  const fileOverlay = senderFileKey ? { _encryptedFileKey: senderFileKey } : {};
  if (idx >= 0) {
    // Socket arrived first -- replace with sender plaintext
    const next = [...existing];
    next[idx] = { ...next[idx], content: displayContent, ...fileOverlay };
    msgStore._setAll({ dmMessages: { ...msgStore.dmMessages, [dmChannelId]: next } });
  } else {
    msgStore._setAll({
      dmMessages: {
        ...msgStore.dmMessages,
        [dmChannelId]: capMessages([...existing, { ...saved, content: displayContent, ...fileOverlay }]),
      },
    });
  }

  // Update DM channel lastMessage
  useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
    ...ch,
    lastMessage: {
      content: displayContent,
      createdAt: saved.timestamp.toISOString(),
      authorId: saved.authorId,
    },
  }));

  // Archive own-sent plaintext. The sender cannot self-decrypt its own
  // MLS ciphertext (ts-mls seals to the OTHER members' ratchets), so the receive-path
  // archive in core.decrypt never captures own-sent messages and the sender's own
  // history would render as the lock placeholder after reload. We hold all three pieces
  // the archive needs with zero race: the FULL pre-encryption plaintext
  // (textForEncryption, incl. any file envelope, matching what the receive path
  // archives), the exact v4 envelope the read path hashes (finalContent), and the
  // server messageId (saved.id, so "delete for everyone" can target the row). Run AFTER
  // the optimistic store update so the own-sent render is never delayed by the write
  // (the archive is a memo with no ordering dependency on the render). Gated on MLS
  // channels only (legacy E2E DMs are self-decryptable). History-store-only and best-
  // effort: a locked (Self-recovery) / quota failure must NEVER fail the send.
  if (encrypted && isChannelMls(dmChannelId)) {
    try {
      await mlsGroupStore.putHistory(dmChannelId, {
        messageId: saved.id,
        plaintext: textForEncryption,
        envelopeContent: finalContent,
      });
    } catch { /* best-effort archive; never block or fail the send */ }
    // Nudge the upload syncer so this fresh own-sent row reaches the
    // server archive (for cross-device restore) promptly. Debounced + lease-gated.
    pokeHistorySync();
  }

  return saved;
}

// Send a DM message

export async function sendDmMessage(
  dmChannelId: string,
  content: string,
  opts?: {
    replyToMessageId?: string;
    attachment?: { url: string; name: string; contentType?: string };
    e2eeFileMeta?: Map<string, { key: string; name: string; type: string; size: number; thumbUrl?: string; thumbKey?: string; thumbWidth?: number; thumbHeight?: number }>;
    showToast?: (msg: string, type: string) => void;
    tier?: MlsTier;
  },
): Promise<void> {
  const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === dmChannelId);
  try {
    await sendEncryptedDmMessage(dmChannelId, content, dmChannel, {
      replyToMessageId: opts?.replyToMessageId,
      attachment: opts?.attachment,
      e2eeFileMeta: opts?.e2eeFileMeta,
      tier: opts?.tier,
    });
  } catch (err) {
    // When this channel's establish failed with a typed reason (peer-unprovisioned /
    // key-change-blocked), map the misleading 'unlock encryption' not-ready error to
    // the real copy for BOTH surfaces below. Unmapped errors pass through unchanged.
    const surfaced = describeSendBlock(dmChannelId, err);
    // With a toast handler, surface the error in-app and swallow. Without one, re-throw
    // so callers (e.g. InviteModal) can drive their own UI feedback via try/catch.
    if (!opts?.showToast) {
      if (surfaced instanceof Error && surfaced.message.includes('Encryption unavailable')) {
        (surfaced as any).__expected = true;
      }
      throw surfaced;
    }
    if (err instanceof Error && err.message.includes('Encryption unavailable')) {
      // A mapped error names the actual block (who to wait on / whose key to review);
      // keep the generic still-loading copy only for genuinely-unmapped not-ready errors.
      const mapped = surfaced instanceof Error && !surfaced.message.includes('Encryption unavailable');
      opts.showToast(mapped ? (surfaced as Error).message : 'Encryption is still loading — try again in a moment.', 'warning');
      return;
    }
    const isRateLimit = !!(err && ((err as any).isRateLimit || (err instanceof Error && err.message.toLowerCase().includes('rate limit'))));
    const fallback = err instanceof Error ? err.message : 'Failed to send message';
    console.error('Failed to send DM:', err);
    opts.showToast(isRateLimit ? "You're sending messages too fast. Wait a few seconds and try again." : fallback, 'warning');
  }
}

// Delete a DM message

export function deleteDmMessage(
  dmChannelId: string,
  messageId: string,
  showToast?: (msg: string, type: string) => void,
): void {
  apiClient
    .deleteDMMessage(dmChannelId, messageId)
    .then(() => {
      useMessageStore.getState().removeDmMessage(dmChannelId, messageId);
      useMessageStore.getState().removeDmPinnedId(dmChannelId, messageId);
      // Purge the at-rest plaintext archive (local + server) for a
      // delete-for-everyone initiated on THIS device. The socket echo also fires
      // this on the deleter's session, but a dropped echo (e.g. sole session, brief
      // socket loss) must not leave the originating device's archive rows behind.
      // Both calls are idempotent and MLS-only; best-effort, never blocks the UI.
      if (isChannelMls(dmChannelId)) {
        void mlsGroupStore.deleteHistory(dmChannelId, messageId).catch(() => {});
        void apiClient.deleteDmHistoryArchiveMessage(dmChannelId, messageId).catch(() => {});
      }
    })
    .catch((err) => {
      console.error('Failed to delete DM message:', err);
      showToast?.('Failed to delete message', 'warning');
    });
}

// Edit a DM message (with encryption)

export function editDmMessage(
  dmChannelId: string,
  messageId: string,
  newContent: string,
  dmChannels: DmChannelEntry[],
  showToast?: (msg: string, type: string) => void,
): void {
  const dmChannel = dmChannels.find((ch) => ch.id === dmChannelId);
  (async () => {
    const { content: finalContent, encrypted } = await encryptDMContent(dmChannelId, newContent, dmChannel);
    const res = await apiClient.editDMMessage(dmChannelId, messageId, finalContent, encrypted);
    const displayContent = isChannelEncrypted(dmChannelId) ? newContent : res.content;
    // Keep the heal-flag invariant uniform with the socket edit handler.
    // The sender's displayContent is the local plaintext (never the placeholder),
    // so this clears undecryptable/_encryptedEnvelope — ensuring a message that
    // was previously undecryptable for this user, then edited by them, isn't
    // reverted by the useMlsRedecrypt sweep reconstructing the stale envelope.
    const undecryptable = displayContent === ENCRYPTED_PLACEHOLDER;
    useMessageStore.getState().updateDmMessage(dmChannelId, messageId, (m) => ({
      ...m,
      content: displayContent,
      editedAt: res.editedAt,
      undecryptable,
      _encryptedEnvelope: undecryptable ? finalContent : undefined,
    }));
    // Archive the edited own-sent plaintext under the NEW
    // envelope's hash. An edit produces a new v4 envelope the sender also cannot
    // self-decrypt, so without this the edited message reverts to the lock placeholder
    // on reload (same bug class as the send path). Keyed by the new finalContent hash,
    // same messageId so deleteHistory still clears every revision. Runs after the
    // optimistic store update (off the render path). History-store-only and best-effort:
    // a failure must never fail the edit. NOTE: the backend edit route must accept v4
    // envelopes for this to be reachable end-to-end.
    if (encrypted && isChannelMls(dmChannelId)) {
      try {
        await mlsGroupStore.putHistory(dmChannelId, {
          messageId,
          plaintext: newContent,
          envelopeContent: finalContent,
        });
      } catch { /* best-effort archive; never block or fail the edit */ }
      // Nudge the upload syncer so the edited row reaches the server
      // archive promptly. Debounced + lease-gated.
      pokeHistorySync();
    }
  })().catch((err) => {
    console.error('Failed to edit DM message:', err);
    showToast?.(err instanceof Error ? err.message : 'Failed to edit message', 'warning');
  });
}

// Report a DM message

export function reportDmMessage(
  dmChannelId: string,
  messageId: string,
  currentUserId: string | undefined,
): void {
  const { dmMessages } = useMessageStore.getState();
  const msgs = dmMessages[dmChannelId] ?? [];
  const msg = msgs.find((m) => m.id === messageId);
  if (!msg || !currentUserId) return;
  useUiStore.getState().setReportModal({
    messageId,
    messageType: 'dm',
    dmChannelId,
    authorId: msg.authorId,
    content: msg.content,
    attachmentUrl: msg.attachmentUrl ?? undefined,
  });
}

// React to a DM message (optimistic toggle)

export function reactDmMessage(
  dmChannelId: string,
  messageId: string,
  emoji: string,
  currentUserId: string,
): void {
  useMessageStore.getState().updateDmMessage(dmChannelId, messageId, (m) => {
    const reactions = [...(m.reactions ?? [])];
    const idx = reactions.findIndex((r) => r.emoji === emoji);
    if (idx >= 0) {
      const r = reactions[idx];
      if (r.userIds.includes(currentUserId)) {
        const next = r.userIds.filter((id) => id !== currentUserId);
        if (next.length === 0) reactions.splice(idx, 1);
        else reactions[idx] = { ...r, userIds: next };
      } else {
        reactions[idx] = { ...r, userIds: [...r.userIds, currentUserId] };
      }
    } else {
      reactions.push({ emoji, userIds: [currentUserId] });
    }
    return { ...m, reactions };
  });
  apiClient.reactDMMessage(dmChannelId, messageId, emoji).catch(() => {
    // Revert optimistic reaction by re-applying the inverse toggle
    useMessageStore.getState().updateDmMessage(dmChannelId, messageId, (m) => {
      const reactions = [...(m.reactions ?? [])];
      const idx = reactions.findIndex((r) => r.emoji === emoji);
      if (idx >= 0) {
        const r = reactions[idx];
        if (r.userIds.includes(currentUserId)) {
          const next = r.userIds.filter((id) => id !== currentUserId);
          if (next.length === 0) reactions.splice(idx, 1);
          else reactions[idx] = { ...r, userIds: next };
        } else {
          reactions[idx] = { ...r, userIds: [...r.userIds, currentUserId] };
        }
      } else {
        reactions.push({ emoji, userIds: [currentUserId] });
      }
      return { ...m, reactions };
    });
  });
}

// Pin a DM message

export function pinDmMessage(dmChannelId: string, messageId: string): void {
  apiClient
    .pinDMMessage(dmChannelId, messageId)
    .then((systemMessage) => {
      useMessageStore.getState().addDmPinnedId(dmChannelId, messageId);
      useMessageStore.getState().bumpDmPinnedVersion();
      useMessageStore.getState().addDmMessage(dmChannelId, systemMessage);
    })
    .catch((err) => console.error('Failed to pin message:', err));
}

// Unpin a DM message

export function unpinDmMessage(dmChannelId: string, messageId: string): void {
  // Optimistic removal
  useMessageStore.getState().removeDmPinnedId(dmChannelId, messageId);
  useMessageStore.getState().bumpDmPinnedVersion();
  // Remove pin system message
  const { dmMessages } = useMessageStore.getState();
  const list = dmMessages[dmChannelId] ?? [];
  const filtered = list.filter(
    (m) =>
      !(m.type === 'system' && m.systemPayload?.kind === 'pin' && m.systemPayload?.messageId === messageId),
  );
  if (filtered.length !== list.length) {
    useMessageStore.getState()._setAll({
      dmMessages: { ...useMessageStore.getState().dmMessages, [dmChannelId]: filtered },
    });
  }

  apiClient.unpinDMMessage(dmChannelId, messageId).catch((err) => {
    console.error('Failed to unpin message:', err);
    // Revert optimistic removal
    useMessageStore.getState().addDmPinnedId(dmChannelId, messageId);
    useMessageStore.getState().bumpDmPinnedVersion();
  });
}

// Pin / Unpin a DM conversation

export function pinDmConversation(dmChannelId: string): void {
  useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
    ...ch,
    pinned: true,
    pinnedAt: new Date().toISOString(),
  }));
  apiClient.pinDMConversation(dmChannelId).catch((err) => {
    console.error('Failed to pin conversation:', err);
    useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
      ...ch,
      pinned: false,
      pinnedAt: undefined,
    }));
  });
}

export function unpinDmConversation(dmChannelId: string): void {
  useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
    ...ch,
    pinned: false,
    pinnedAt: undefined,
  }));
  apiClient.unpinDMConversation(dmChannelId).catch((err) => {
    console.error('Failed to unpin conversation:', err);
    useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
      ...ch,
      pinned: true,
      pinnedAt: new Date().toISOString(),
    }));
  });
}

// Get DM pins (decrypted)

export async function getDmPins(dmChannelId: string): Promise<Message[]> {
  const pins = await apiClient.getDMPins(dmChannelId);
  if (!isChannelEncrypted(dmChannelId)) return pins;
  const decrypted = await Promise.all(
    pins.map(async (pin) => {
      try {
        const plaintext = await decryptDMContentCached(dmChannelId, pin.id, pin.content, true, pin.authorId);
        const fileInfo = parseE2eeFileEnvelope(plaintext);
        if (fileInfo) {
          return {
            ...pin,
            content: fileInfo.text || '(attachment)',
            attachmentUrl: fileInfo.file?.url,
            attachmentName: fileInfo.file?.name,
            attachmentContentType: fileInfo.file?.type,
            // Surface the MLS-authenticated size so a pinned attachment's
            // fetchAndDecryptFile keeps its size cross-check armed.
            attachmentSize: fileInfo.file?.size,
            _encryptedFileKey: fileInfo.file?.key,
          };
        }
        return { ...pin, content: plaintext };
      } catch {
        return { ...pin, content: '\u{1F512} Unable to decrypt' };
      }
    }),
  );
  return decrypted;
}

// Create or select a DM

/** Get or create the 1:1 DM (keyless). Throws if encryption is locked. */
export async function getOrCreateEncryptedDM(
  otherUserId: string,
): Promise<{ id: string; otherUser?: any; encrypted?: boolean; otherUsers?: any[] }> {
  if (!dmKeyManager.isUnlocked()) {
    throw new Error('Encryption must be unlocked before sending messages. Please enter your encryption password.');
  }
  // Keyless create. The server mints (or dedups) the channel row; no
  // legacy X25519 key or dead-drop exists anywhere in the create path.
  const dm = await apiClient.getOrCreateDM(otherUserId);
  const recipientId = dm.otherUser?.id ?? otherUserId;
  // Every 1:1 DM is E2EE by construction; set the ratchet explicitly (the
  // deleted legacy create used to do this inside dmKeyManager).
  setChannelEncryptionStatus(dm.id, true);
  // No-downgrade ratchet: classify 'mls' UNCONDITIONALLY
  // and BEFORE establishing, so the channel fails closed on send regardless
  // of whether establishChannel succeeds, defers, or throws. There is no
  // created/dedup gate: establishChannel is idempotent and self-resolves a
  // deduped or concurrent channel via Welcome / External Commit.
  setChannelProtocol(dm.id, 'mls');
  try {
    await mlsCoordinator.establishChannel(dm.id, recipientId);
  } catch (err) {
    // Record the typed failure for this channel's UI. peer-unprovisioned and
    // key-change-blocked are SOFT outcomes: the channel exists and is classified,
    // sends stay fail-closed, and the composer/banner explain the block (for a key
    // change, the review banner LIVES in the DM — the open must proceed so the user
    // can reach it). Anything else is a real failure and still rejects.
    routeEstablishOutcome(dm.id, err);
    const reason = (err as { reason?: string }).reason;
    if (reason !== 'peer-unprovisioned' && reason !== 'key-change-blocked') throw err;
  }
  return dm;
}

export async function createOrSelectDM(
  otherUserId: string,
  navigate: (path: string) => void,
): Promise<void> {
  const dm = await getOrCreateEncryptedDM(otherUserId);
  const { dmChannels } = useDmStore.getState();
  if (!dmChannels.some((d) => d.id === dm.id)) {
    useDmStore.getState().addDmChannel({ id: dm.id, otherUser: dm.otherUser });
  }
  navigate(`/channels/@me/${dm.id}`);
}

// Send message and open DM

export async function sendMessageAndOpenDM(
  otherUserId: string,
  content: string,
  navigate: (path: string) => void,
  opts?: {
    e2eeFileMeta?: Map<string, any>;
    onRateLimit?: () => void;
    onError?: (msg: string) => void;
  },
): Promise<void> {
  if (!content.trim()) return;
  const dm = await getOrCreateEncryptedDM(otherUserId);
  const { dmChannels } = useDmStore.getState();
  if (!dmChannels.some((d) => d.id === dm.id)) {
    useDmStore.getState().addDmChannel({
      id: dm.id,
      otherUser: dm.otherUser,
      encrypted: dm.encrypted,
    });
  }
  if (dm.encrypted !== undefined) setChannelEncryptionStatus(dm.id, dm.encrypted);
  else setChannelEncryptionStatus(dm.id, true);
  try {
    const dmChannel = { id: dm.id, encrypted: !!dm.encrypted, isGroup: false, otherUser: dm.otherUser };
    await sendEncryptedDmMessage(dm.id, content.trim(), dmChannel, {
      e2eeFileMeta: opts?.e2eeFileMeta,
    });
  } catch (err) {
    // Reason-aware send-block copy (see sendDmMessage). The navigate below
    // also lands the user on the composer showing the same waiting copy.
    const surfaced = describeSendBlock(dm.id, err);
    if (surfaced instanceof Error && surfaced.message.includes('Encryption unavailable')) {
      (surfaced as any).__expected = true;
    }
    if (err && (err as Error & { isRateLimit?: boolean }).isRateLimit) opts?.onRateLimit?.();
    else opts?.onError?.(surfaced instanceof Error ? surfaced.message : 'Failed to send message');
  }
  navigate(`/channels/@me/${dm.id}`);
  useUiStore.getState().setUserProfileTarget(null);
  useUiStore.getState().setProfileFriendStatus(null);
}

// Create a group DM

export async function createGroupDM(
  memberIds: string[],
  navigate: (path: string) => void,
): Promise<void> {
  if (!dmKeyManager.isUnlocked()) {
    throw new Error('Encryption must be unlocked before creating group DMs. Please enter your encryption password.');
  }
  // REST funnel: legacy keys still satisfy the unchanged createGroupDmSchema, so this
  // creates the server-side group-DM channel row (and returns its id + ownerId). The
  // group's content protocol is MLS — the legacy keys it ships are vestigial.
  const dm = await dmKeyManager.createGroupDm(memberIds);
  // Coexistence guard: POST /dms/group dedups on the exact member set.
  // created === false means the server returned a PRE-EXISTING group — which keeps
  // whatever protocol it already has (a legacy group stays legacy; an
  // existing mls group is re-established via the normal open path, not here). Only a
  // genuinely NEW group (created === true) is MLS-created + classified, so a dedup
  // never silently force-migrates an existing legacy group on the creator's side.
  if (dm.created === true) {
    // No-downgrade ratchet: classify 'mls' BEFORE the
    // coordinator await — mirroring getOrCreateEncryptedDM. If createGroupDmGroup
    // defers (not leader/active) or THROWS, the channel must already be 'mls' so it
    // fails closed on send rather than silently downgrading to legacy.
    // setChannelProtocol is a one-way ratchet the coordinator never reads, so ordering
    // has no behavioral side effect beyond the fail-closed guarantee.
    setChannelProtocol(dm.id, 'mls');
    // memberIds EXCLUDES self: the creator is already in its own freshly-built
    // group; createGroupDmGroup adds the remaining members in one inline-Add commit.
    try {
      await mlsCoordinator.createGroupDmGroup(dm.id, memberIds);
    } catch (err) {
      routeEstablishOutcome(dm.id, err); // surface peer-unprovisioned for this channel's UI
      throw err;
    }
  }
  const { dmChannels } = useDmStore.getState();
  if (!dmChannels.some((d) => d.id === dm.id)) {
    useDmStore.getState().addDmChannel({
      id: dm.id,
      isGroup: true,
      otherUsers: dm.otherUsers,
      // MLS group content is always encrypted; hard-set rather than echoing
      // the legacy `dm.encrypted` flag.
      encrypted: true,
      ownerId: dm.ownerId,
    });
  }
  navigate(`/channels/@me/${dm.id}`);
}

// Add members to a group DM

export async function addGroupDmMembers(
  dmChannelId: string,
  memberIds: string[],
): Promise<void> {
  await apiClient.addGroupDmMembers(dmChannelId, memberIds);
  // Fan the new members into the MLS group with an Add commit (owner authors it).
  // After the REST add so the server-side membership row exists when the commit lands.
  await mlsCoordinator.addGroupMembers(dmChannelId, memberIds);
}

// Update group DM (name/icon)

export function updateGroupDM(
  dmChannelId: string,
  data: { name?: string; icon?: string },
): void {
  useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({ ...ch, ...data }));
}

// Leave a group DM

export async function leaveGroupDM(
  dmChannelId: string,
  navigate: (path: string) => void,
  activeDmChannelId: string | null,
): Promise<void> {
  // No MLS commit here: a member cannot author its own MLS Remove. The
  // oldest-remaining member commits the leaver's removal via the repurposed
  // leader-election in App.tsx. The leaver just tears down its
  // own local + REST state below.
  await apiClient.leaveGroupDM(dmChannelId);
  useDmStore.getState().removeDmChannel(dmChannelId);
  if (activeDmChannelId === dmChannelId) {
    navigate('/channels/@me');
  }
  useNotificationStore.getState().removeUnreadDmChannel(dmChannelId);
}

// Kick a member from a group DM

export async function kickFromGroupDM(dmChannelId: string, userId: string): Promise<void> {
  await apiClient.kickGroupDmMember(dmChannelId, userId);
  // Optimistically drop the kicked user from the local member list; the
  // dm-participant-removed socket event will also arrive for all clients.
  useDmStore.getState().updateDmChannel(dmChannelId, (ch) => ({
    ...ch,
    otherUsers: ch.otherUsers?.filter((u) => u.id !== userId),
  }));
  // Author the MLS Remove for the kicked user after the REST kick (owner-only Remove).
  await mlsCoordinator.removeGroupMembers(dmChannelId, [userId]);
}

// Mark DM as read

export function markDmRead(dmChannelId: string): void {
  useNotificationStore.getState().removeUnreadDmChannel(dmChannelId);
  useNotificationStore.getState().clearDmUnread(dmChannelId);
  useNotificationStore.getState().clearDmMention(dmChannelId);
  apiClient.markDmAsRead(dmChannelId).catch(() => {});
}

// Forward to a friend

export async function forwardToFriend(
  friendUserId: string,
  payload: { text?: string; attachment?: { url: string; name: string; contentType?: string } },
  opts?: { e2eeFileMeta?: Map<string, any> },
): Promise<void> {
  const content = payload.text ?? (payload.attachment ? '(attachment)' : '');
  const dm = await getOrCreateEncryptedDM(friendUserId);
  if (dm.encrypted !== undefined) setChannelEncryptionStatus(dm.id, dm.encrypted);
  else setChannelEncryptionStatus(dm.id, true);
  const { dmChannels } = useDmStore.getState();
  if (!dmChannels.some((d) => d.id === dm.id)) {
    useDmStore.getState().addDmChannel({ id: dm.id, otherUser: dm.otherUser });
  }
  const dmChannel = { id: dm.id, encrypted: !!dm.encrypted, isGroup: false as const, otherUser: dm.otherUser };
  try {
    await sendEncryptedDmMessage(dm.id, content, dmChannel, {
      attachment: payload.attachment,
      isForward: true,
      e2eeFileMeta: opts?.e2eeFileMeta,
    });
  } catch (err) {
    // Reason-aware send-block copy (see sendDmMessage).
    const surfaced = describeSendBlock(dm.id, err);
    if (surfaced instanceof Error && surfaced.message.includes('Encryption unavailable')) {
      (surfaced as any).__expected = true;
    }
    throw surfaced;
  }
}

// Forward to a DM

export async function forwardToDM(
  dmChannelId: string,
  payload: { text?: string; attachment?: { url: string; name: string; contentType?: string } },
  opts?: { e2eeFileMeta?: Map<string, any> },
): Promise<void> {
  const content = payload.text ?? (payload.attachment ? '(attachment)' : '');
  const dmChannel = useDmStore.getState().dmChannels.find((ch) => ch.id === dmChannelId);
  try {
    await sendEncryptedDmMessage(dmChannelId, content, dmChannel, {
      attachment: payload.attachment,
      isForward: true,
      e2eeFileMeta: opts?.e2eeFileMeta,
    });
  } catch (err) {
    // Reason-aware send-block copy (see sendDmMessage). Same seam as
    // forwardToFriend - both feed the same forward modal.
    const surfaced = describeSendBlock(dmChannelId, err);
    if (surfaced instanceof Error && surfaced.message.includes('Encryption unavailable')) {
      (surfaced as any).__expected = true;
    }
    throw surfaced;
  }
}

// Block user in DM view

export function blockUserInDmView(
  userId: string,
  closePopup: () => void,
  showToast?: (msg: string, type: string) => void,
): void {
  apiClient
    .blockUser(userId)
    .then(() => {
      closePopup();
      useSocialStore.getState().addBlockedUser(userId);
      const { dmChannels } = useDmStore.getState();
      // Update DM channels for block
      for (const ch of dmChannels) {
        if (ch.otherUser?.id === userId) {
          useDmStore.getState().updateDmChannel(ch.id, (c) => ({ ...c, blockedByMe: true }));
        } else if (ch.isGroup && ch.otherUsers?.some((u) => u.id === userId)) {
          const ids = ch.blockedParticipantIds ?? [];
          if (!ids.includes(userId)) {
            useDmStore.getState().updateDmChannel(ch.id, (c) => ({
              ...c,
              blockedParticipantIds: [...(c.blockedParticipantIds ?? []), userId],
            }));
          }
        }
      }
      // Update block status map
      for (const ch of dmChannels) {
        if (ch.otherUser?.id === userId) {
          useDmStore.getState().setDmBlockStatus(ch.id, {
            ...useDmStore.getState().dmBlockStatus[ch.id],
            blockedByMe: true,
          });
        } else if (ch.isGroup && ch.otherUsers?.some((u) => u.id === userId)) {
          const existing = useDmStore.getState().dmBlockStatus[ch.id]?.blockedParticipantIds ?? [];
          if (!existing.includes(userId)) {
            useDmStore.getState().setDmBlockStatus(ch.id, {
              ...useDmStore.getState().dmBlockStatus[ch.id],
              blockedParticipantIds: [...existing, userId],
            });
          }
        }
      }
    })
    .catch(() => showToast?.('Failed to block user', 'warning'));
}

// Unblock user

export async function unblockUser(userId: string): Promise<void> {
  await apiClient.unblockUser(userId);
  useSocialStore.getState().removeBlockedUser(userId);
}

// Unblock user in DM view

export async function unblockUserInDmView(userId: string): Promise<void> {
  await apiClient.unblockUser(userId);
  useSocialStore.getState().removeBlockedUser(userId);
  const { dmChannels } = useDmStore.getState();
  for (const ch of dmChannels) {
    if (ch.otherUser?.id === userId) {
      useDmStore.getState().updateDmChannel(ch.id, (c) => ({ ...c, blockedByMe: false }));
    } else if (ch.isGroup && ch.otherUsers?.some((u) => u.id === userId)) {
      const ids = ch.blockedParticipantIds ?? [];
      if (ids.includes(userId)) {
        useDmStore.getState().updateDmChannel(ch.id, (c) => ({
          ...c,
          blockedParticipantIds: (c.blockedParticipantIds ?? []).filter((id) => id !== userId),
        }));
      }
    }
  }
  // Update block status map
  for (const ch of dmChannels) {
    if (ch.otherUser?.id === userId) {
      useDmStore.getState().setDmBlockStatus(ch.id, {
        ...useDmStore.getState().dmBlockStatus[ch.id],
        blockedByMe: false,
      });
    } else if (ch.isGroup && ch.otherUsers?.some((u) => u.id === userId)) {
      const existing = useDmStore.getState().dmBlockStatus[ch.id]?.blockedParticipantIds ?? [];
      useDmStore.getState().setDmBlockStatus(ch.id, {
        ...useDmStore.getState().dmBlockStatus[ch.id],
        blockedParticipantIds: existing.filter((id) => id !== userId),
      });
    }
  }
}

// Load older DM messages

// Per-DM in-flight guard. A module-level boolean would silently drop a fetch on
// DM B if DM A had a fetch in flight when the user switched.
const _dmLoadingOlderChannels = new Set<string>();

export async function loadOlderDmMessages(
  dmChannelId: string,
  dmChannels: DmChannelEntry[],
): Promise<void> {
  if (!dmChannelId || _dmLoadingOlderChannels.has(dmChannelId)) return;
  const { dmMessages, dmHasMore } = useMessageStore.getState();
  const current = dmMessages[dmChannelId];
  if (!current || current.length === 0 || !dmHasMore[dmChannelId]) return;
  const oldest = current[0];
  _dmLoadingOlderChannels.add(dmChannelId);
  try {
    const { messages: older, hasMore } = await apiClient.getDMMessages(dmChannelId, {
      before: oldest.id,
    });

    let decrypted = older;
    if (isChannelEncrypted(dmChannelId)) {
      const { decryptDMMessages } = await import('../services/dmEncryption');
      const dmChannel = dmChannels.find((ch) => ch.id === dmChannelId);
      decrypted = await decryptDMMessages(dmChannelId, older, isChannelEncrypted(dmChannelId), dmChannel);
    }

    if (decrypted.length > 0) {
      const store = useMessageStore.getState();
      const existing = store.dmMessages[dmChannelId] ?? [];
      const existingIds = new Set(existing.map((m) => m.id));
      const newOlder = decrypted.filter((m) => !existingIds.has(m.id));
      store._setAll({
        dmMessages: {
          ...store.dmMessages,
          [dmChannelId]: capMessages([...newOlder, ...existing]),
        },
        dmHasMore: { ...store.dmHasMore, [dmChannelId]: hasMore },
      });
    } else {
      useMessageStore.getState().setDmHasMore(dmChannelId, hasMore);
    }
  } catch (err) {
    console.error('Failed to load older DM messages:', err);
  } finally {
    _dmLoadingOlderChannels.delete(dmChannelId);
  }
}
