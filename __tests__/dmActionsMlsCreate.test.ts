// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * New 1:1 DM creation is routed through the MLS coordinator and the channel is
 * classified 'mls'.
 *
 * getOrCreateEncryptedDM is the single funnel for every 1:1 create path
 * (createOrSelectDM, sendMessageAndOpenDM, forwardToFriend). After the legacy
 * channel row exists it must:
 *   1. call mlsCoordinator.establishChannel(dm.id, recipientId) once, and
 *   2. ratchet the channel to protocol 'mls' via setChannelProtocol.
 *
 * Group-DM creation / membership ops are wired to the MLS coordinator.
 * createGroupDM routes through mlsCoordinator.createGroupDmGroup and classifies
 * the channel 'mls' (classify-first, before the coordinator await, the same
 * no-downgrade ratchet getOrCreateEncryptedDM uses). addGroupDmMembers
 * fans the new members in via mlsCoordinator.addGroupMembers after the REST add;
 * kickFromGroupDM authors an MLS Remove via mlsCoordinator.removeGroupMembers
 * after the REST kick (keeping the optimistic splice); leaveGroupDM does NOT
 * author its own Remove (the oldest-remaining member commits it).
 *
 * mlsCoordinator + dmKeyManager + dmEncryption (heavy crypto bundle) are mocked.
 * apiClient is mocked so the REST group ops are observable without a network.
 * encryptionFlags is the REAL module so getChannelProtocol reflects the real
 * one-way ratchet.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/mls/mlsCoordinator', () => ({
  establishChannel: vi.fn(async () => {}),
  createGroupDmGroup: vi.fn(async () => {}),
  addGroupMembers: vi.fn(async () => {}),
  removeGroupMembers: vi.fn(async () => {}),
}));

vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: vi.fn(() => true),
  createGroupDm: vi.fn(),
}));

vi.mock('../services/api', () => ({
  apiClient: {
    getOrCreateDM: vi.fn(async () => ({ id: 'chan-1', encrypted: true, otherUser: { id: 'peer-1' } })),
    addGroupDmMembers: vi.fn(async () => ({ id: 'gdm-1', members: [] })),
    kickGroupDmMember: vi.fn(async () => ({ id: 'gdm-1', members: [] })),
    leaveGroupDM: vi.fn(async () => {}),
  },
}));

// dmEncryption pulls in the heavy TweetNaCl crypto bundle; stub the exports
// dmActions actually imports from it so the module graph loads in jsdom.
vi.mock('../services/dmEncryption', () => ({
  encryptDMContent: vi.fn(async (_id: string, text: string) => ({ content: text, encrypted: true })),
  decryptDMContentCached: vi.fn(async (_id: string, _mid: string, content: string) => content),
  parseE2eeFileEnvelope: vi.fn(() => null),
}));

import {
  getOrCreateEncryptedDM,
  createGroupDM,
  addGroupDmMembers,
  kickFromGroupDM,
  leaveGroupDM,
  sendDmMessage,
} from '../utils/dmActions';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import * as dmKeyManager from '../services/dmKeyManager';
import { encryptDMContent } from '../services/dmEncryption';
import { apiClient } from '../services/api';
import { useDmStore } from '../stores/dmStore';
import { useUiStore } from '../stores/uiStore';
import { getChannelProtocol, isChannelEncrypted } from '../services/encryptionFlags';

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  (dmKeyManager.isUnlocked as any).mockReturnValue(true);
  // Reset the dm store between cases so optimistic-splice assertions are isolated.
  useDmStore.setState({ dmChannels: [] } as any);
});

describe('getOrCreateEncryptedDM - keyless create + MLS classification', () => {
  it('getOrCreateEncryptedDM: keyless create, then classify + establish unconditionally', async () => {
    (apiClient.getOrCreateDM as any).mockResolvedValue({
      id: 'chan-1',
      encrypted: true,
      otherUser: { id: 'peer-1' },
    });

    const dm = await getOrCreateEncryptedDM('peer-1');

    // The keyless server route is THE caller (no legacy key-exchange arg).
    expect(apiClient.getOrCreateDM).toHaveBeenCalledWith('peer-1');
    // Every 1:1 DM is E2EE by construction; the ratchet is set explicitly now.
    expect(isChannelEncrypted('chan-1')).toBe(true); // real ratchet
    expect(getChannelProtocol('chan-1')).toBe('mls'); // real ratchet
    expect(mlsCoordinator.establishChannel).toHaveBeenCalledWith('chan-1', 'peer-1');
    expect(dm.id).toBe('chan-1');
  });

  it('falls back to the passed otherUserId when dm.otherUser is absent', async () => {
    (apiClient.getOrCreateDM as any).mockResolvedValue({
      id: 'chan-2',
      encrypted: true,
      otherUser: null,
    });

    await getOrCreateEncryptedDM('peer-2');

    expect(mlsCoordinator.establishChannel).toHaveBeenCalledTimes(1);
    expect(mlsCoordinator.establishChannel).toHaveBeenCalledWith('chan-2', 'peer-2');
    expect(getChannelProtocol('chan-2')).toBe('mls');
  });

  it('classifies mls BEFORE establishChannel and even when establishChannel rejects', async () => {
    // The no-downgrade ratchet fires BEFORE the establish await, so a
    // transient establish failure can never leave a server-created channel
    // unclassified and thus downgradable on send.
    (apiClient.getOrCreateDM as any).mockResolvedValue({
      id: 'chan-throw',
      encrypted: true,
      otherUser: { id: 'peer-throw' },
    });
    (mlsCoordinator.establishChannel as any).mockRejectedValueOnce(new Error('mls not leader'));

    await expect(getOrCreateEncryptedDM('peer-throw')).rejects.toThrow();

    // Ratchet set despite the throw (its observable effect on the real module).
    expect(getChannelProtocol('chan-throw')).toBe('mls');
  });

  it('throws when the vault is locked (unchanged UX gate)', async () => {
    (dmKeyManager.isUnlocked as any).mockReturnValue(false);

    await expect(getOrCreateEncryptedDM('peer-1')).rejects.toThrow(/unlock/i);
    expect(apiClient.getOrCreateDM).not.toHaveBeenCalled();
    expect(mlsCoordinator.establishChannel).not.toHaveBeenCalled();
  });

  // The FIRST establish on the 1:1 create seam routes a typed peer-unprovisioned
  // failure into uiStore and treats it as a SOFT outcome (the DM still opens;
  // sends stay fail-closed on the not-ready channel).
  it('getOrCreateEncryptedDM records peer-unprovisioned and resolves (soft outcome)', async () => {
    useUiStore.setState({ establishFailureReasons: {} });
    (apiClient.getOrCreateDM as any).mockResolvedValue({
      id: 'dm-ghost',
      encrypted: true,
      otherUser: { id: 'ghost' },
    });
    (mlsCoordinator.establishChannel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('member ghost has no available KeyPackages'), {
        reason: 'peer-unprovisioned',
        unprovisionedUserId: 'ghost',
      }),
    );

    const dm = await getOrCreateEncryptedDM('ghost'); // resolves, does NOT reject
    expect(dm?.id).toBe('dm-ghost');
    expect(useUiStore.getState().establishFailureReasons['dm-ghost']).toEqual({
      reason: 'peer-unprovisioned',
      userId: 'ghost',
    });
    // The soft outcome never weakens the ratchet: the channel is still 'mls'.
    expect(getChannelProtocol('dm-ghost')).toBe('mls');
  });

  it('getOrCreateEncryptedDM still rejects on a generic establish error', async () => {
    useUiStore.setState({ establishFailureReasons: {} });
    (apiClient.getOrCreateDM as any).mockResolvedValue({
      id: 'dm-generic',
      encrypted: true,
      otherUser: { id: 'someone' },
    });
    (mlsCoordinator.establishChannel as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));

    await expect(getOrCreateEncryptedDM('someone')).rejects.toThrow('boom');
    // Generic failures leave no UI failure state (routeEstablishOutcome is a no-op).
    expect(useUiStore.getState().establishFailureReasons['dm-generic']).toBeUndefined();
  });
});

describe('createGroupDM — MLS routing + classification', () => {
  it('routes through createGroupDmGroup, classifies mls, and never calls establishChannel', async () => {
    (dmKeyManager.createGroupDm as any).mockResolvedValue({
      id: 'gdm-1',
      encrypted: true,
      isGroup: true,
      ownerId: 'me',
      created: true,
      otherUsers: [{ id: 'bob', username: 'bob' }, { id: 'carol', username: 'carol' }],
    });

    await createGroupDM(['bob', 'carol'], () => {});

    // Group create routes through the group coordinator, not the 1:1 establish path.
    expect(mlsCoordinator.createGroupDmGroup).toHaveBeenCalledTimes(1);
    expect(mlsCoordinator.createGroupDmGroup).toHaveBeenCalledWith('gdm-1', ['bob', 'carol']);
    expect(mlsCoordinator.establishChannel).not.toHaveBeenCalled();
    // No-downgrade ratchet: the group channel is classified 'mls'.
    expect(getChannelProtocol('gdm-1')).toBe('mls');
    // The new MLS group is seeded into the dm store as an encrypted group entry.
    const ch = useDmStore.getState().dmChannels.find((d) => d.id === 'gdm-1');
    expect(ch).toBeDefined();
    expect(ch?.isGroup).toBe(true);
    expect(ch?.encrypted).toBe(true);
    expect(ch?.ownerId).toBe('me');
  });

  it('still classifies mls even when createGroupDmGroup throws (unconditional no-downgrade ratchet)', async () => {
    // Load-bearing: setChannelProtocol('mls') fires BEFORE the coordinator await, so a
    // throw/defer can never leave a server-created group legacy-keyed and downgradable.
    (mlsCoordinator.createGroupDmGroup as any).mockRejectedValueOnce(new Error('mls not leader'));
    (dmKeyManager.createGroupDm as any).mockResolvedValue({
      id: 'gdm-throw',
      encrypted: true,
      isGroup: true,
      ownerId: 'me',
      created: true,
      otherUsers: [{ id: 'bob', username: 'bob' }],
    });

    await expect(createGroupDM(['bob'], () => {})).rejects.toThrow(/mls not leader/);

    expect(getChannelProtocol('gdm-throw')).toBe('mls');
  });

  it('does NOT force-classify mls or create an MLS group when the server deduped to an existing group (created === false)', async () => {
    // Coexistence invariant: POST /dms/group dedups on the exact member set and
    // returns created:false for a PRE-EXISTING group. That group keeps its own
    // protocol (a legacy group stays legacy). Force-classifying it 'mls' here
    // would silently migrate it on the creator's side, making the creator's v4
    // sends unreadable to members still on legacy.
    (dmKeyManager.createGroupDm as any).mockResolvedValue({
      id: 'gdm-existing',
      encrypted: true,
      isGroup: true,
      ownerId: 'me',
      created: false,
      otherUsers: [{ id: 'bob', username: 'bob' }, { id: 'carol', username: 'carol' }],
    });

    await createGroupDM(['bob', 'carol'], () => {});

    // No MLS group is created for a deduped existing channel.
    expect(mlsCoordinator.createGroupDmGroup).not.toHaveBeenCalled();
    expect(mlsCoordinator.establishChannel).not.toHaveBeenCalled();
    // The existing channel is NOT force-ratcheted to 'mls' (legacy stays legacy;
    // an existing mls group is re-established via the normal open path, not here).
    expect(getChannelProtocol('gdm-existing')).not.toBe('mls');
    // The channel is still surfaced into the dm store / navigation as before.
    const ch = useDmStore.getState().dmChannels.find((d) => d.id === 'gdm-existing');
    expect(ch).toBeDefined();
  });

  it('throws and skips both the REST funnel and MLS when encryption is locked', async () => {
    (dmKeyManager.isUnlocked as any).mockReturnValue(false);

    await expect(createGroupDM(['bob', 'carol'], () => {})).rejects.toThrow(/unlock/i);
    expect(dmKeyManager.createGroupDm).not.toHaveBeenCalled();
    expect(mlsCoordinator.createGroupDmGroup).not.toHaveBeenCalled();
  });

  // A group-create whose coordinator throws peer-unprovisioned records the typed
  // reason for the NEW channel id and re-throws unchanged.
  it('routes a peer-unprovisioned coordinator failure into uiStore and re-throws', async () => {
    useUiStore.setState({ establishFailureReasons: {} });
    (dmKeyManager.createGroupDm as any).mockResolvedValue({
      id: 'gdm-1',
      encrypted: true,
      isGroup: true,
      ownerId: 'me',
      created: true,
      otherUsers: [{ id: 'bob', username: 'bob' }, { id: 'carol', username: 'carol' }],
    });
    (mlsCoordinator.createGroupDmGroup as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      Object.assign(new Error('member bob has no available KeyPackages'), {
        reason: 'peer-unprovisioned',
        unprovisionedUserId: 'bob',
      }),
    );

    await expect(createGroupDM(['bob', 'carol'], () => {})).rejects.toMatchObject({ reason: 'peer-unprovisioned' });
    expect(useUiStore.getState().establishFailureReasons['gdm-1']).toEqual({
      reason: 'peer-unprovisioned',
      userId: 'bob',
    });
  });
});

// Chained create-then-send flows (InviteModal, sendMessageAndOpenDM,
// forwardToFriend) die fail-closed on a channel whose establish failed
// peer-unprovisioned. The not-ready error's copy tells the SENDER to unlock
// their own vault; when the channel has a recorded peer-unprovisioned failure,
// the surfaced error must instead carry the waiting copy with the peer's name
// (mirroring the composer placeholder).
describe('sendDmMessage - peer-unprovisioned send-block copy', () => {
  // The mapping keys on the 'Encryption unavailable' prefix, not the full text.
  const NOT_READY = 'Encryption unavailable - unlock encryption to send messages.';

  it('translates the not-ready error to the waiting copy for a 1:1 with a recorded failure', async () => {
    useDmStore.setState({
      dmChannels: [{ id: 'chan-w', isGroup: false, otherUser: { id: 'ghost', username: 'ghostuser' } } as any],
    } as any);
    useUiStore.setState({
      establishFailureReasons: { 'chan-w': { reason: 'peer-unprovisioned', userId: 'ghost' } },
    });
    (encryptDMContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(NOT_READY));

    let caught: unknown;
    try { await sendDmMessage('chan-w', 'hi'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('Waiting for ghostuser to enable encryption');
    expect((caught as Error).message).not.toMatch(/unlock encryption/);
    // The mapped error is still the expected-UX state Sentry drops.
    expect((caught as Error & { __expected?: boolean }).__expected).toBe(true);
  });

  it('names the RECORDED unprovisioned member for a group channel', async () => {
    useDmStore.setState({
      dmChannels: [{
        id: 'gdm-w',
        isGroup: true,
        otherUsers: [{ id: 'bob', username: 'bobby' }, { id: 'carol', username: 'carol' }],
      } as any],
    } as any);
    useUiStore.setState({
      establishFailureReasons: { 'gdm-w': { reason: 'peer-unprovisioned', userId: 'bob' } },
    });
    (encryptDMContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(NOT_READY));

    await expect(sendDmMessage('gdm-w', 'hi')).rejects.toThrow('Waiting for bobby to enable encryption');
  });

  it('keeps the original not-ready message when the channel has NO recorded failure', async () => {
    useDmStore.setState({
      dmChannels: [{ id: 'chan-n', isGroup: false, otherUser: { id: 'pat', username: 'pat' } } as any],
    } as any);
    useUiStore.setState({ establishFailureReasons: {} });
    (encryptDMContent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error(NOT_READY));

    let caught: unknown;
    try { await sendDmMessage('chan-n', 'hi'); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/unlock encryption/);
    // Historical behavior preserved: stamped expected + rethrown unchanged.
    expect((caught as Error & { __expected?: boolean }).__expected).toBe(true);
  });
});

describe('addGroupDmMembers — REST add then MLS Add commit', () => {
  it('calls the REST add then fans the new members in via mlsCoordinator.addGroupMembers', async () => {
    await addGroupDmMembers('gdm-1', ['dave', 'erin']);

    expect(apiClient.addGroupDmMembers).toHaveBeenCalledTimes(1);
    expect(apiClient.addGroupDmMembers).toHaveBeenCalledWith('gdm-1', ['dave', 'erin']);
    expect(mlsCoordinator.addGroupMembers).toHaveBeenCalledTimes(1);
    expect(mlsCoordinator.addGroupMembers).toHaveBeenCalledWith('gdm-1', ['dave', 'erin']);
  });
});

describe('kickFromGroupDM — REST kick then MLS Remove (optimistic splice preserved)', () => {
  it('calls the REST kick, optimistically splices the member, then authors an MLS Remove', async () => {
    useDmStore.setState({
      dmChannels: [
        {
          id: 'gdm-1',
          isGroup: true,
          otherUsers: [
            { id: 'bob', username: 'bob' },
            { id: 'carol', username: 'carol' },
          ],
        } as any,
      ],
    } as any);

    await kickFromGroupDM('gdm-1', 'bob');

    expect(apiClient.kickGroupDmMember).toHaveBeenCalledTimes(1);
    expect(apiClient.kickGroupDmMember).toHaveBeenCalledWith('gdm-1', 'bob');
    // Optimistic splice preserved.
    const ch = useDmStore.getState().dmChannels.find((d) => d.id === 'gdm-1');
    expect(ch?.otherUsers?.map((u: any) => u.id)).toEqual(['carol']);
    // MLS Remove authored for the kicked user.
    expect(mlsCoordinator.removeGroupMembers).toHaveBeenCalledTimes(1);
    expect(mlsCoordinator.removeGroupMembers).toHaveBeenCalledWith('gdm-1', ['bob']);
  });
});

describe('leaveGroupDM — no self-authored Remove', () => {
  it('calls the REST leave, cleans up local state, and never authors an MLS Remove', async () => {
    useDmStore.setState({
      dmChannels: [{ id: 'gdm-1', isGroup: true, otherUsers: [] } as any],
    } as any);

    await leaveGroupDM('gdm-1', () => {}, 'gdm-1');

    expect(apiClient.leaveGroupDM).toHaveBeenCalledTimes(1);
    expect(apiClient.leaveGroupDM).toHaveBeenCalledWith('gdm-1');
    // Local channel removed.
    expect(useDmStore.getState().dmChannels.find((d) => d.id === 'gdm-1')).toBeUndefined();
    // The leaver does NOT commit its own removal — oldest-remaining authors it.
    expect(mlsCoordinator.removeGroupMembers).not.toHaveBeenCalled();
  });
});
