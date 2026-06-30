// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * OTR (Off the Record) send path.
 *
 * An OTR send rides the ephemeral socket (socketService.emitOtrMessage), writes
 * the optimistic message to the roomKey(id,'otr') message-store bucket, and SKIPS
 * the durable path entirely: NO apiClient.sendDMMessage, NO mlsGroupStore.putHistory,
 * NO useDmStore lastMessage update (ephemeral, never persisted server-side).
 *
 * The crypto bundle (dmEncryption), the coordinator, dmKeyManager, the history
 * store, the socket service, and the auth store are mocked so the WIRING is
 * observable without IndexedDB / network / a live socket.
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

vi.mock('../services/dmEncryption', () => ({
  encryptDMContent: vi.fn(),
  decryptDMContentCached: vi.fn(async (_i: string, _m: string, c: string) => c),
  parseE2eeFileEnvelope: vi.fn(() => null),
  ENCRYPTED_PLACEHOLDER: '\u{1F512} Encrypted message',
}));

vi.mock('../services/mls/mlsGroupStore', () => ({
  putHistory: vi.fn(async () => {}),
}));

vi.mock('../services/socket', () => ({
  socketService: {
    emitOtrMessage: vi.fn(),
  },
}));

vi.mock('../stores/authStore', () => ({
  useAuthStore: {
    getState: vi.fn(() => ({ currentUser: { id: 'me' } })),
  },
}));

import { sendEncryptedDmMessage } from '../utils/dmActions';
import { apiClient } from '../services/api';
import { encryptDMContent } from '../services/dmEncryption';
import * as mlsGroupStore from '../services/mls/mlsGroupStore';
import { socketService } from '../services/socket';
import { useMessageStore } from '../stores/messageStore';
import { useDmStore } from '../stores/dmStore';
import { roomKey } from '../services/mls/roomKey';

const DM_CH = '00000000-0000-4000-8000-0000000000d1';
const OTR_GROUP_ID = '11111111-1111-4111-8111-111111111111';
// The v4 ciphertext the (mocked) encryptDMContent returns as the wire content.
const V4_CIPHERTEXT = JSON.stringify({ v: 4, m: 'b3Ry' });

beforeEach(() => {
  vi.clearAllMocks();
  useMessageStore.setState({ dmMessages: {} } as any);
  // Spy on updateDmChannel so we can assert the OTR path never touches lastMessage.
  vi.spyOn(useDmStore.getState(), 'updateDmChannel');
  (encryptDMContent as any).mockResolvedValue({ content: V4_CIPHERTEXT, encrypted: true });
});

describe('sendEncryptedDmMessage — OTR ephemeral send', () => {
  const dmChannel = { id: DM_CH, encrypted: true, otrMlsGroupId: OTR_GROUP_ID } as any;

  it('encrypts with the OTR tier', async () => {
    await sendEncryptedDmMessage(DM_CH, 'hi', dmChannel, { tier: 'otr' });
    expect(encryptDMContent).toHaveBeenCalledWith(DM_CH, 'hi', dmChannel, 'otr');
  });

  it('emits the OTR message over the ephemeral socket with a fresh clientMsgId', async () => {
    await sendEncryptedDmMessage(DM_CH, 'hi', dmChannel, { tier: 'otr' });
    expect(socketService.emitOtrMessage).toHaveBeenCalledTimes(1);
    const payload = (socketService.emitOtrMessage as any).mock.calls[0][0];
    expect(payload.dmChannelId).toBe(DM_CH);
    expect(payload.mlsGroupId).toBe(OTR_GROUP_ID);
    expect(payload.ciphertext).toBe(V4_CIPHERTEXT);
    // clientMsgId is a fresh v4 UUID.
    expect(payload.clientMsgId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('does NOT call the durable REST send path', async () => {
    await sendEncryptedDmMessage(DM_CH, 'hi', dmChannel, { tier: 'otr' });
    expect(apiClient.sendDMMessage).not.toHaveBeenCalled();
  });

  it('does NOT archive to the durable history store', async () => {
    await sendEncryptedDmMessage(DM_CH, 'hi', dmChannel, { tier: 'otr' });
    expect(mlsGroupStore.putHistory).not.toHaveBeenCalled();
  });

  it('writes the optimistic message into the roomKey(id, "otr") bucket', async () => {
    const optimistic = await sendEncryptedDmMessage(DM_CH, 'hi', dmChannel, { tier: 'otr' });
    const rk = roomKey(DM_CH, 'otr');
    expect(rk).toBe(`${DM_CH}#otr`);
    const bucket = useMessageStore.getState().dmMessages[rk];
    expect(bucket).toHaveLength(1);
    expect(bucket![0].id).toBe(optimistic.id);
    // OTR is text-only — the optimistic content is the plaintext.
    expect(bucket![0].content).toBe('hi');
    // clientMsgId === optimistic.id === the emitted payload's clientMsgId.
    const emitted = (socketService.emitOtrMessage as any).mock.calls[0][0];
    expect(optimistic.id).toBe(emitted.clientMsgId);
  });

  it('does NOT update the DM-list lastMessage (ephemeral, no sidebar preview)', async () => {
    await sendEncryptedDmMessage(DM_CH, 'hi', dmChannel, { tier: 'otr' });
    expect(useDmStore.getState().updateDmChannel).not.toHaveBeenCalled();
  });

  it('throws when OTR is not set up for this chat (no otrMlsGroupId)', async () => {
    await expect(
      sendEncryptedDmMessage(DM_CH, 'hi', { id: DM_CH, encrypted: true } as any, { tier: 'otr' }),
    ).rejects.toThrow(/Off the Record is not set up/);
    expect(socketService.emitOtrMessage).not.toHaveBeenCalled();
  });
});
