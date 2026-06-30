// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { Message } from '../types';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { isChannelMls } from '../services/encryptionFlags';
import { decryptDMMessages, ENCRYPTED_PLACEHOLDER } from '../services/dmEncryption';
import { useMessageStore } from '../stores/messageStore';

export interface UseMlsRedecryptOpts {
  currentUserId: string | undefined;
}

/**
 * Re-decrypt-on-epoch-key-arrival. Heals DM messages that rendered
 * as the lock placeholder because the channel was transiently not-ready (group not
 * yet joined, this tab not yet leader, or the enabling commit not yet processed).
 *
 * Leader-gated via mlsCoordinator.isReadyForChannel — the only main-thread
 * leadership+ready signal (epoch events broadcast to ALL tabs on the worker path,
 * so the gate must be re-checked inside the handler). Event-driven, no polling: a
 * message that still cannot decrypt stays flagged until the next epoch event.
 * Complementary to the archive — the archive persists SUCCESSFUL decrypts; this
 * retries FIRST-TIME failures (which were never archived because they never
 * decrypted), keyed off the preserved `_encryptedEnvelope`.
 */
export function useMlsRedecrypt(opts: UseMlsRedecryptOpts): void {
  const { currentUserId } = opts;
  useEffect(() => {
    if (!currentUserId) return;

    async function sweepChannel(dmChannelId: string): Promise<void> {
      if (!isChannelMls(dmChannelId)) return;
      if (!mlsCoordinator.isReadyForChannel(dmChannelId)) return; // leader + ready gate
      const msgs = useMessageStore.getState().dmMessages[dmChannelId];
      if (!msgs || msgs.length === 0) return;
      const pending = msgs.filter((m) => m.undecryptable === true && typeof m._encryptedEnvelope === 'string');
      if (pending.length === 0) return;
      // Re-run the full MLS funnel against the preserved ciphertext. decryptDMMessages
      // is archive-first in the coordinator, so a healed message is also archived.
      // When the reply preview was itself transiently undecryptable, restore
      // its preserved ciphertext (_encryptedContent) so the funnel re-decrypts the
      // reply too; otherwise leave replyTo alone (a good preview must not be re-fed as
      // an envelope — that would collapse to the placeholder).
      const reconstructed: Message[] = pending.map((m) => ({
        ...m,
        content: m._encryptedEnvelope as string,
        ...(m.replyTo?._encryptedContent
          ? { replyTo: { ...m.replyTo, content: m.replyTo._encryptedContent } }
          : {}),
      }));
      let healed: Message[];
      try {
        healed = await decryptDMMessages(dmChannelId, reconstructed, true, undefined);
      } catch {
        return;
      }
      const update = useMessageStore.getState().updateDmMessage;
      for (const h of healed) {
        if (h.undecryptable || h.content === ENCRYPTED_PLACEHOLDER) continue; // still locked — leave flagged
        update(dmChannelId, h.id, (cur) => ({
          ...cur,
          content: h.content,
          undecryptable: false,
          _encryptedEnvelope: undefined,
          // Only adopt the healed reply when it genuinely re-decrypted.
          // If it collapsed to the placeholder (e.g. the store's reply was already
          // good plaintext, not a v4 envelope), keep the existing good preview.
          // On a genuine reply heal, clear the now-stale ciphertext stash.
          ...(h.replyTo && h.replyTo.content !== ENCRYPTED_PLACEHOLDER
            ? { replyTo: { ...h.replyTo, _encryptedContent: undefined } }
            : {}),
          attachmentUrl: h.attachmentUrl,
          attachmentName: h.attachmentName,
          attachmentContentType: h.attachmentContentType,
          // Carry the MLS-authenticated size through the heal write-back too — a
          // placeholder row had no attachment fields, so without this the healed
          // attachment renders with attachmentSize=undefined and the Layer-2
          // size cross-check (fetchAndDecryptFile) is silently skipped.
          attachmentSize: h.attachmentSize,
          _encryptedFileKey: h._encryptedFileKey,
        }));
      }
    }

    function sweepAll(): void {
      const all = useMessageStore.getState().dmMessages;
      for (const ch of Object.keys(all)) void sweepChannel(ch);
    }

    const offEpoch = mlsCoordinator.onEpochChange((e) => { void sweepChannel(e.dmChannelId); });
    const offReady = mlsCoordinator.mlsEvents.on((ev) => { if (ev === 'mls-ready') sweepAll(); });
    // When restored archive history lands, the freshly-persisted
    // plaintext makes a previously-undecryptable message readable: heal the
    // affected channel (dmChannelId set) or run the bulk eager pass (null).
    const offHistory = mlsCoordinator.onHistoryRestored((e) => {
      if (e.dmChannelId) void sweepChannel(e.dmChannelId);
      else sweepAll();
    });
    // Reload race: 'mls-ready' and the mount-time sweepAll below are one-shot, and an
    // already-established channel fires no epoch/Welcome on a plain reload. In the common
    // boot ordering MLS becomes ready BEFORE the DM list finishes loading, so a channel's
    // messages populate the store AFTER those one-shot sweeps already ran against an empty
    // store — and nothing would re-heal the placeholders. Sweep any channel whose
    // dmMessages reference just changed; sweepChannel is gated on isReadyForChannel and
    // early-returns when nothing is pending, so a no-op change is cheap, and a message that
    // does NOT heal writes nothing back (so this cannot loop on a persistently-locked row).
    const offStore = useMessageStore.subscribe((state, prev) => {
      if (state.dmMessages === prev.dmMessages) return;
      for (const ch of Object.keys(state.dmMessages)) {
        if (state.dmMessages[ch] !== prev.dmMessages[ch]) void sweepChannel(ch);
      }
    });
    // mls-ready is one-time per activation; a late mount would miss it, so sweep once now.
    sweepAll();

    return () => { offEpoch(); offReady(); offHistory(); offStore(); };
  }, [currentUserId]);
}
