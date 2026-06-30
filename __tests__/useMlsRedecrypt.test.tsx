// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { renderHook } from '@testing-library/react';

let epochCb: ((e: { dmChannelId: string; groupId: string; epoch: string }) => void) | null = null;
let readyOk = true;

vi.mock('../services/mls/mlsCoordinator', () => ({
  onEpochChange: (cb: never) => { epochCb = cb; return () => { epochCb = null; }; },
  mlsEvents: { on: () => () => {} },
  onHistoryRestored: () => () => {},
  isReadyForChannel: () => readyOk,
}));
vi.mock('../services/encryptionFlags', () => ({ isChannelMls: () => true }));
vi.mock('../services/dmEncryption', async (orig) => {
  const real = await orig() as Record<string, unknown>;
  return { ...real, decryptDMMessages: vi.fn() };
});

import * as dmEncryption from '../services/dmEncryption';
import { ENCRYPTED_PLACEHOLDER } from '../services/dmEncryption';
import { useMessageStore } from '../stores/messageStore';
import { useMlsRedecrypt } from '../hooks/useMlsRedecrypt';

const CH = 'dm-1';
function seedUndecryptable() {
  useMessageStore.getState().setDmMessages(CH, [
    { id: 'm1', authorId: 'a', content: '\u{1F512} Encrypted message', timestamp: new Date(), undecryptable: true, _encryptedEnvelope: 'ENV1' },
  ], false);
}

// epochCb returns void (it kicks off an async sweep), so flush the full queue.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useMlsRedecrypt', () => {
  beforeEach(() => { epochCb = null; readyOk = true; useMessageStore.setState({ dmMessages: {} }); vi.clearAllMocks(); });

  it('heals undecryptable messages on an epoch change for the channel', async () => {
    (dmEncryption.decryptDMMessages as Mock).mockResolvedValue([
      { id: 'm1', authorId: 'a', content: 'healed', timestamp: new Date(), undecryptable: false },
    ]);
    renderHook(() => useMlsRedecrypt({ currentUserId: 'u1' })); // mount: store empty → no-op
    seedUndecryptable();                                         // seed AFTER mount
    expect(epochCb).toBeTruthy();
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '2' });
    await flush();
    expect(useMessageStore.getState().dmMessages[CH][0].content).toBe('healed');
    expect(useMessageStore.getState().dmMessages[CH][0].undecryptable).toBe(false);
  });

  it('heals when undecryptable messages populate the store AFTER mount/ready (no epoch event)', async () => {
    // Reload race: 'mls-ready' and the mount-time sweepAll are one-shot and already ran
    // while the store was empty; an already-established channel fires NO new epoch or
    // Welcome on a plain reload. So when the channel's messages finally load into the
    // store, nothing re-sweeps and the lock placeholder persists forever. Populating the
    // store must itself drive the heal.
    (dmEncryption.decryptDMMessages as Mock).mockResolvedValue([
      { id: 'm1', authorId: 'a', content: 'healed', timestamp: new Date(), undecryptable: false },
    ]);
    renderHook(() => useMlsRedecrypt({ currentUserId: 'u1' })); // mount: store empty → mount sweepAll no-op
    seedUndecryptable();                                         // messages arrive AFTER mount — the ONLY signal
    await flush();
    expect(dmEncryption.decryptDMMessages).toHaveBeenCalled();
    expect(useMessageStore.getState().dmMessages[CH][0].content).toBe('healed');
    expect(useMessageStore.getState().dmMessages[CH][0].undecryptable).toBe(false);
  });

  it('does not heal when this tab is not leader/ready', async () => {
    readyOk = false;
    renderHook(() => useMlsRedecrypt({ currentUserId: 'u1' }));
    seedUndecryptable();
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '2' });
    await flush();
    expect(dmEncryption.decryptDMMessages).not.toHaveBeenCalled();
    expect(useMessageStore.getState().dmMessages[CH][0].undecryptable).toBe(true);
  });

  it('leaves a still-undecryptable message flagged (no false heal, e.g. pre-join)', async () => {
    (dmEncryption.decryptDMMessages as Mock).mockResolvedValue([
      { id: 'm1', authorId: 'a', content: '\u{1F512} Encrypted message', timestamp: new Date(), undecryptable: true, _encryptedEnvelope: 'ENV1' },
    ]);
    renderHook(() => useMlsRedecrypt({ currentUserId: 'u1' }));
    seedUndecryptable();
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '2' });
    await flush();
    expect(useMessageStore.getState().dmMessages[CH][0].undecryptable).toBe(true);
  });

  // #8: parent body failed, but the quoted (older) message had decrypted fine, so
  // the store's replyTo.content is GOOD plaintext. The heal re-runs decryptDMMessages
  // which re-decrypts replyTo.content; a plaintext preview is not a v4 envelope so the
  // MLS funnel collapses it to the placeholder. The writeback must NOT clobber the
  // good preview with that placeholder.
  it('does not clobber a GOOD reply preview when the healed reply collapses to the placeholder', async () => {
    useMessageStore.getState().setDmMessages(CH, [
      {
        id: 'm1', authorId: 'a', content: '\u{1F512} Encrypted message', timestamp: new Date(),
        undecryptable: true, _encryptedEnvelope: 'ENV1',
        replyTo: { id: 'r1', authorId: 'b', content: 'good reply preview' },
      },
    ], false);
    (dmEncryption.decryptDMMessages as Mock).mockResolvedValue([
      {
        id: 'm1', authorId: 'a', content: 'healed', timestamp: new Date(), undecryptable: false,
        replyTo: { id: 'r1', authorId: 'b', content: ENCRYPTED_PLACEHOLDER },
      },
    ]);
    renderHook(() => useMlsRedecrypt({ currentUserId: 'u1' }));
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '2' });
    await flush();
    const stored = useMessageStore.getState().dmMessages[CH][0];
    expect(stored.content).toBe('healed');
    expect(stored.undecryptable).toBe(false);
    // The good preview survives — it was NOT overwritten with the lock placeholder.
    expect(stored.replyTo!.content).toBe('good reply preview');
  });

  // #9: the reply itself was transiently undecryptable; the socket path stashed the
  // reply's original ciphertext in _encryptedContent while content holds the placeholder.
  // The heal reconstructs replyTo.content from _encryptedContent, re-decrypts it, and
  // adopts the genuinely-decrypted preview — and clears the stale _encryptedContent.
  it('heals a reply preview from its preserved ciphertext and clears _encryptedContent', async () => {
    useMessageStore.getState().setDmMessages(CH, [
      {
        id: 'm1', authorId: 'a', content: '\u{1F512} Encrypted message', timestamp: new Date(),
        undecryptable: true, _encryptedEnvelope: 'ENV1',
        replyTo: { id: 'r1', authorId: 'b', content: ENCRYPTED_PLACEHOLDER, _encryptedContent: 'REPLY_ENV' },
      },
    ], false);
    (dmEncryption.decryptDMMessages as Mock).mockImplementation(
      async (_ch: string, msgs: Array<{ id: string; replyTo?: { content?: string } }>) => {
        // The reconstruction must have restored the reply ciphertext for re-decrypt.
        expect(msgs[0].replyTo?.content).toBe('REPLY_ENV');
        return [
          {
            id: 'm1', authorId: 'a', content: 'healed', timestamp: new Date(), undecryptable: false,
            replyTo: { id: 'r1', authorId: 'b', content: 'decrypted reply' },
          },
        ];
      },
    );
    renderHook(() => useMlsRedecrypt({ currentUserId: 'u1' }));
    epochCb!({ dmChannelId: CH, groupId: 'g', epoch: '2' });
    await flush();
    const stored = useMessageStore.getState().dmMessages[CH][0];
    expect(stored.content).toBe('healed');
    expect(stored.replyTo!.content).toBe('decrypted reply');
    expect(stored.replyTo!._encryptedContent).toBeUndefined();
  });
});
