// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * createGroupDm — MLS-only group create.
 *
 * New group DMs are MLS-only. createGroupDm no longer generates a legacy
 * per-channel X25519 key, does not send encryptedKeys/senderPublicKey, and does
 * not run the legacy channel-key recovery dance. It POSTs the bare
 * member set, the server writes NO PendingKeyDelivery dead-drops, and the MLS
 * Welcome (driven by mlsCoordinator.createGroupDmGroup, exercised separately) is
 * the sole key distribution. createGroupDm just returns the server's response
 * shape so dmActions.createGroupDM can gate MLS creation on `created`.
 *
 * Reverses the earlier "keep sending legacy keys" rule: a recipient who
 * read a legacy dead-drop BEFORE their MLS Welcome drained could send a legacy
 * message the already-MLS creator couldn't decrypt.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';

vi.mock('../services/api', () => ({
  apiClient: {
    setupDmKeys: vi.fn(),
    getDmKeysPublicKey: vi.fn(),
    createGroupDM: vi.fn(),
    updateDmKeysBlob: vi.fn(),
    getDmKeyBundle: vi.fn(),
    updateDmKeysSigningKey: vi.fn(),
  },
}));
import { apiClient } from '../services/api';
import * as dmKeyManager from '../services/dmKeyManager';

beforeAll(() => {
  if (typeof globalThis.crypto?.subtle === 'undefined') {
    const { webcrypto } = require('node:crypto');
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
  }
});
const mock = <T,>(fn: T) => fn as unknown as ReturnType<typeof vi.fn>;

async function freshSetup(): Promise<void> {
  dmKeyManager.reset();
  mock(apiClient.setupDmKeys).mockImplementation(async () => ({ blobVersion: 1 }));
  await dmKeyManager.setup('pw');
  mock(apiClient.getDmKeysPublicKey).mockResolvedValue({ publicKey: dmKeyManager.getPublicKey()! });
}

const MEMBER = '11111111-1111-1111-1111-111111111111';

describe('createGroupDm — MLS-only create', () => {
  it('POSTs WITHOUT legacy key exchange and mints no channel key (genuine create)', async () => {
    await freshSetup();
    mock(apiClient.createGroupDM).mockResolvedValue({ id: 'grp-1', created: true, encrypted: true, isGroup: true, ownerId: 'me', otherUsers: [] });
    mock(apiClient.updateDmKeysBlob).mockClear();
    mock(apiClient.getDmKeysPublicKey).mockClear();

    const res = await dmKeyManager.createGroupDm([MEMBER]);

    // Returns the server response shape unchanged.
    expect(res).toEqual({ id: 'grp-1', encrypted: true, isGroup: true, created: true, ownerId: 'me', otherUsers: [] });

    // No legacy key exchange: createGroupDM called with NO second arg (the server
    // therefore writes no PendingKeyDelivery dead-drops).
    expect(apiClient.createGroupDM).toHaveBeenCalledTimes(1);
    expect(apiClient.createGroupDM).toHaveBeenCalledWith([MEMBER]);
    expect((apiClient.createGroupDM as any).mock.calls[0][1]).toBeUndefined();

    // No recipient public keys are fetched, and no blob write happens (all of
    // that legacy machinery is gone, and the per-channel key store is gone too).
    expect(apiClient.getDmKeysPublicKey).not.toHaveBeenCalled();
    expect(apiClient.updateDmKeysBlob).not.toHaveBeenCalled();
  });

  it('passes through the server `created: false` dedup flag without any key recovery', async () => {
    await freshSetup();
    mock(apiClient.createGroupDM).mockResolvedValue({ id: 'grp-x', created: false, encrypted: true, isGroup: true, ownerId: 'x', otherUsers: [] });
    mock(apiClient.getDmKeyBundle).mockClear();
    mock(apiClient.updateDmKeysBlob).mockClear();

    const res = await dmKeyManager.createGroupDm([MEMBER]);

    expect(res.created).toBe(false);
    expect(res.id).toBe('grp-x');
    // The legacy dedup key-recovery dance is gone: no own-blob
    // reconcile, no fresh key persisted. MLS group re-establishment is handled
    // by the normal open path, not here.
    expect(apiClient.getDmKeyBundle).not.toHaveBeenCalled();
    expect(apiClient.updateDmKeysBlob).not.toHaveBeenCalled();
  });

  it('requires encryption to be unlocked', async () => {
    dmKeyManager.reset();
    mock(apiClient.createGroupDM).mockClear();
    await expect(dmKeyManager.createGroupDm([MEMBER])).rejects.toThrow(/unlock/i);
    expect(apiClient.createGroupDM).not.toHaveBeenCalled();
  });
});
