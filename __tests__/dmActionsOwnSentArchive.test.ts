// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Own-sent (and own-edited) plaintext is archived to the durable
 * history store at send/edit time. The sender cannot self-decrypt its own MLS
 * ciphertext, so without this the sender's own history renders as the lock
 * placeholder after reload. The archive call is:
 *   - gated on MLS channels only (legacy E2E DMs are self-decryptable),
 *   - history-store-only (mlsGroupStore.putHistory, never putGroupAndHistory),
 *   - best-effort (a failure must NEVER fail the send/edit).
 *
 * The crypto bundle (dmEncryption), the coordinator, dmKeyManager, and the history
 * store are mocked so the WIRING is observable without IndexedDB/network. The
 * encryptionFlags module is REAL so isChannelMls reflects the real classification.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    sendDMMessage: vi.fn(),
    editDMMessage: vi.fn(),
  },
}));

vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: vi.fn(() => true),
}));

vi.mock('../services/mls/mlsCoordinator', () => ({
  establishChannel: vi.fn(async () => {}),
}));

// dmEncryption pulls in the heavy TweetNaCl crypto bundle; stub the exports
// dmActions imports so the module graph loads in jsdom.
vi.mock('../services/dmEncryption', () => ({
  encryptDMContent: vi.fn(),
  decryptDMContentCached: vi.fn(async (_i: string, _m: string, c: string) => c),
  parseE2eeFileEnvelope: vi.fn(() => null),
  ENCRYPTED_PLACEHOLDER: '\u{1F512} Encrypted message',
}));

vi.mock('../services/mls/mlsGroupStore', () => ({
  putHistory: vi.fn(async () => {}),
}));

import { sendEncryptedDmMessage, editDmMessage } from '../utils/dmActions';
import { apiClient } from '../services/api';
import { encryptDMContent } from '../services/dmEncryption';
import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import { setChannelProtocol, setChannelEncryptionStatus } from '../services/encryptionFlags';
import { useMessageStore } from '../stores/messageStore';
import { useDmStore } from '../stores/dmStore';

const MLS_CH = '00000000-0000-4000-8000-0000000000d1';
const LEGACY_CH = '00000000-0000-4000-8000-0000000000d2';
// The v4 envelope the (mocked) encryptDMContent returns as the wire content.
const V4_ENV = JSON.stringify({ v: 4, m: 'ZmFrZQ==' });

beforeEach(() => {
  vi.clearAllMocks();
  useMessageStore.setState({ dmMessages: {} } as any);
  useDmStore.setState({ dmChannels: [] } as any);
  (apiClient.sendDMMessage as any).mockResolvedValue({ id: 'msg-1', content: V4_ENV, timestamp: new Date(), authorId: 'me' });
  (apiClient.editDMMessage as any).mockResolvedValue({ id: 'msg-1', content: V4_ENV, editedAt: new Date().toISOString() });
  (encryptDMContent as any).mockResolvedValue({ content: V4_ENV, encrypted: true });
});

describe('sendEncryptedDmMessage — own-sent archive', () => {
  it('archives the plaintext keyed by the v4 envelope + server messageId on an MLS channel', async () => {
    setChannelProtocol(MLS_CH, 'mls');
    await sendEncryptedDmMessage(MLS_CH, 'hello world', { id: MLS_CH, encrypted: true });
    expect(mlsGroupStore.putHistory).toHaveBeenCalledTimes(1);
    expect(mlsGroupStore.putHistory).toHaveBeenCalledWith(MLS_CH, {
      messageId: 'msg-1',
      plaintext: 'hello world',
      envelopeContent: V4_ENV,
    });
  });

  it('archives the FULL file-envelope plaintext (not the display caption) so reload reconstructs attachments', async () => {
    setChannelProtocol(MLS_CH, 'mls');
    const e2eeFileMeta = new Map([
      ['https://cdn/x.enc', { key: 'k', name: 'x.png', type: 'image/png', size: 9 }],
    ]);
    await sendEncryptedDmMessage(MLS_CH, 'caption', { id: MLS_CH, encrypted: true }, {
      attachment: { url: 'https://cdn/x.enc', name: 'x.png', contentType: 'image/png' },
      e2eeFileMeta,
    });
    expect(mlsGroupStore.putHistory).toHaveBeenCalledTimes(1);
    const arg = (mlsGroupStore.putHistory as any).mock.calls[0][1];
    // The archived plaintext is the FULL file envelope JSON, not the 'caption' the
    // user sees — so parseE2eeFileEnvelope can reconstruct the attachment on reload.
    const parsed = JSON.parse(arg.plaintext);
    expect(parsed.text).toBe('caption');
    expect(parsed.file.key).toBe('k');
    expect(parsed.file.url).toBe('https://cdn/x.enc');
    expect(arg.envelopeContent).toBe(V4_ENV);
  });

  it('does NOT archive on a non-MLS (legacy E2E) channel', async () => {
    // LEGACY_CH is encrypted but never classified 'mls' => isChannelMls is false.
    await sendEncryptedDmMessage(LEGACY_CH, 'legacy', { id: LEGACY_CH, encrypted: true });
    expect(mlsGroupStore.putHistory).not.toHaveBeenCalled();
  });

  it('never fails the send when the archive write rejects (best-effort)', async () => {
    setChannelProtocol(MLS_CH, 'mls');
    (mlsGroupStore.putHistory as any).mockRejectedValueOnce(new Error('QuotaExceededError'));
    const saved = await sendEncryptedDmMessage(MLS_CH, 'still sends', { id: MLS_CH, encrypted: true });
    expect(saved.id).toBe('msg-1');
    // The optimistic render still happened despite the archive failure.
    expect(useMessageStore.getState().dmMessages[MLS_CH]?.some((m) => m.id === 'msg-1')).toBe(true);
  });
});

describe('editDmMessage — own-edited archive', () => {
  it('archives the edited plaintext under the NEW envelope on an MLS channel', async () => {
    setChannelProtocol(MLS_CH, 'mls');
    setChannelEncryptionStatus(MLS_CH, true);
    editDmMessage(MLS_CH, 'msg-1', 'edited text', [{ id: MLS_CH } as any]);
    await vi.waitFor(() => expect(mlsGroupStore.putHistory).toHaveBeenCalledTimes(1));
    expect(mlsGroupStore.putHistory).toHaveBeenCalledWith(MLS_CH, {
      messageId: 'msg-1',
      plaintext: 'edited text',
      envelopeContent: V4_ENV,
    });
  });

  it('does NOT archive an edit on a non-MLS channel', async () => {
    setChannelEncryptionStatus(LEGACY_CH, true);
    editDmMessage(LEGACY_CH, 'msg-1', 'edited', [{ id: LEGACY_CH } as any]);
    await vi.waitFor(() => expect(apiClient.editDMMessage).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(mlsGroupStore.putHistory).not.toHaveBeenCalled();
  });
});
