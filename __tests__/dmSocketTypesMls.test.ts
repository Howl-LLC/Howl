// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * The `new-dm-channel` socket handler threads the additive `mlsGroupId` field
 * from the server payload onto the local DmChannelEntry.
 *
 * `mlsGroupId` rides the EXISTING `newDmChannelPayload` zod schema (additive,
 * uuid().nullable().optional()) — no new event, no new protocol-v1 fixture.
 * The handler must:
 *   - thread a real `mlsGroupId` straight through, and
 *   - default to `null` when the server omits it (legacy / pre-MLS channels).
 *
 * Drives the real `useDmSocketEvents` hook via renderHook with a Proxy
 * `socketService` mock that captures the `onNewDmChannel` callback, then fires
 * the callback exactly as the socket layer would and asserts against the real
 * dmStore.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

// Capture the `onNewDmChannel` callback the hook registers. A Proxy stands in
// for the whole socketService surface: the hook's effect registers ~20 onXxx
// listeners and the cleanup calls ~20 offXxx — every property access returns a
// recording/no-op function, so nothing throws at mount or unmount. `joinDM`
// (called inside the handler) is likewise a no-op fn.
const captured = vi.hoisted(() => ({
  onNewDmChannel: null as ((data: unknown) => void) | null,
  onDMMessageDeleted: null as ((dmChannelId: string, messageId: string) => void) | null,
  onDMMessageUpdated: null as
    | ((
        dmChannelId: string,
        messageId: string,
        content: string,
        editedAt: string | null,
        encrypted?: boolean,
        authorId?: string,
      ) => void | Promise<void>)
    | null,
}));

vi.mock('../services/socket', () => {
  const socketService = new Proxy(
    {},
    {
      get(_target, prop: string) {
        if (prop === 'onNewDmChannel') {
          return (cb: (data: unknown) => void) => {
            captured.onNewDmChannel = cb;
          };
        }
        if (prop === 'onDMMessageDeleted') {
          return (cb: (dmChannelId: string, messageId: string) => void) => {
            captured.onDMMessageDeleted = cb;
          };
        }
        if (prop === 'onDMMessageUpdated') {
          return (cb: typeof captured.onDMMessageUpdated) => {
            captured.onDMMessageUpdated = cb;
          };
        }
        // Any other onXxx/offXxx/joinDM/etc. — a recorded no-op.
        return () => undefined;
      },
    },
  );
  return { socketService };
});

// The edit handler decrypts the new envelope through the scalar funnel
// `decryptDMContent`. Keep every other dmEncryption export real (the hook also
// uses ENCRYPTED_PLACEHOLDER + decryptSingleDMMessage); only stub the scalar
// decrypt so each test can map a ciphertext to a plaintext (or the placeholder).
const decryptDMContentSpy = vi.hoisted(() => vi.fn());
vi.mock('../services/dmEncryption', async (importActual) => {
  const actual = await importActual<typeof import('../services/dmEncryption')>();
  return { ...actual, decryptDMContent: decryptDMContentSpy };
});

// The edit handler fire-and-forgets a dynamic import of the search index; stub
// it so the real MiniSearch/idb modules never load under the runner.
vi.mock('../services/dmSearchIndex', () => ({
  addMessageToIndex: vi.fn(() => Promise.resolve()),
  removeMessageFromIndex: vi.fn(() => Promise.resolve()),
  updateMessageInIndex: vi.fn(() => Promise.resolve()),
}));

// The delete handler purges the at-rest plaintext archive. Mock the whole
// mlsGroupStore so deleteHistory is a spy (and the real IndexedDB module never
// loads under the test runner).
const deleteHistorySpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('../services/mls/mlsGroupStore', () => ({
  deleteHistory: deleteHistorySpy,
}));

// The delete handler also write-throughs to the server archive, gated on
// isChannelMls. Keep encryptionFlags real except isChannelMls so the other
// handlers (which use isChannelEncrypted/setChannelEncryptionStatus) work.
const isChannelMlsSpy = vi.hoisted(() => vi.fn(() => false));
vi.mock('../services/encryptionFlags', async (importActual) => {
  const actual = await importActual<typeof import('../services/encryptionFlags')>();
  return { ...actual, isChannelMls: isChannelMlsSpy };
});

import { useDmSocketEvents } from '../hooks/useDmSocketEvents';
import { useDmStore } from '../stores/dmStore';
import { useMessageStore } from '../stores/messageStore';
import { apiClient } from '../services/api';
import { ENCRYPTED_PLACEHOLDER } from '../services/dmEncryption';
import type { Message } from '../types';

const CURRENT_USER = 'user-self';
const CHANNEL = '00000000-0000-4000-8000-00000000d001';
const GROUP = '00000000-0000-4000-8000-00000000d0a1';

beforeEach(() => {
  captured.onNewDmChannel = null;
  captured.onDMMessageDeleted = null;
  captured.onDMMessageUpdated = null;
  deleteHistorySpy.mockClear();
  isChannelMlsSpy.mockReset();
  isChannelMlsSpy.mockReturnValue(false);
  decryptDMContentSpy.mockReset();
  useDmStore.getState()._setAll({ dmChannels: [], dmBlockStatus: {} });
  useMessageStore.getState()._setAll({ dmMessages: {} });
});

describe('useDmSocketEvents.onNewDmChannel — threads additive mlsGroupId', () => {
  it('threads a real server-supplied mlsGroupId onto the added channel', () => {
    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    expect(captured.onNewDmChannel).toBeTypeOf('function');

    captured.onNewDmChannel!({
      id: CHANNEL,
      isGroup: true,
      otherUsers: [{ id: 'a', username: 'a' }],
      encrypted: true,
      ownerId: CURRENT_USER,
      mlsGroupId: GROUP,
    });

    const ch = useDmStore.getState().dmChannels.find((c) => c.id === CHANNEL);
    expect(ch).toBeDefined();
    expect(ch!.mlsGroupId).toBe(GROUP);
  });

  it('defaults mlsGroupId to null when the server omits it (legacy / pre-MLS)', () => {
    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    expect(captured.onNewDmChannel).toBeTypeOf('function');

    captured.onNewDmChannel!({
      id: CHANNEL,
      isGroup: false,
      otherUser: { id: 'a', username: 'a' },
      encrypted: false,
      ownerId: null,
      // mlsGroupId omitted
    });

    const ch = useDmStore.getState().dmChannels.find((c) => c.id === CHANNEL);
    expect(ch).toBeDefined();
    expect(ch!.mlsGroupId).toBeNull();
  });
});

describe('useDmSocketEvents.onDMMessageDeleted — delete write-through purges at-rest plaintext', () => {
  const MSG = '00000000-0000-4000-8000-00000000e001';

  it('calls mlsGroupStore.deleteHistory(dmChannelId, messageId) on a delete event for a known channel', () => {
    // Channel must exist so the handler's membership guard passes.
    useDmStore.getState()._setAll({
      dmChannels: [{ id: CHANNEL, isGroup: false, encrypted: true }],
      dmBlockStatus: {},
    });

    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    expect(captured.onDMMessageDeleted).toBeTypeOf('function');

    captured.onDMMessageDeleted!(CHANNEL, MSG);

    expect(deleteHistorySpy).toHaveBeenCalledWith(CHANNEL, MSG);
  });

  it('does NOT purge when the channel is unknown (guard rejects before the write-through)', () => {
    // dmChannels left empty by beforeEach — membership guard returns early.
    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    expect(captured.onDMMessageDeleted).toBeTypeOf('function');

    captured.onDMMessageDeleted!(CHANNEL, MSG);

    expect(deleteHistorySpy).not.toHaveBeenCalled();
  });

  it('write-throughs the server archive DELETE when the channel is MLS', () => {
    useDmStore.getState()._setAll({
      dmChannels: [{ id: CHANNEL, isGroup: false, encrypted: true }],
      dmBlockStatus: {},
    });
    isChannelMlsSpy.mockReturnValue(true);
    const archiveDeleteSpy = vi
      .spyOn(apiClient, 'deleteDmHistoryArchiveMessage')
      .mockResolvedValue({ deleted: 1 });

    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    captured.onDMMessageDeleted!(CHANNEL, MSG);

    expect(deleteHistorySpy).toHaveBeenCalledWith(CHANNEL, MSG);
    expect(archiveDeleteSpy).toHaveBeenCalledWith(CHANNEL, MSG);
    archiveDeleteSpy.mockRestore();
  });

  it('does NOT hit the server archive for a non-MLS channel', () => {
    useDmStore.getState()._setAll({
      dmChannels: [{ id: CHANNEL, isGroup: false, encrypted: true }],
      dmBlockStatus: {},
    });
    isChannelMlsSpy.mockReturnValue(false);
    const archiveDeleteSpy = vi
      .spyOn(apiClient, 'deleteDmHistoryArchiveMessage')
      .mockResolvedValue({ deleted: 0 });

    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    captured.onDMMessageDeleted!(CHANNEL, MSG);

    // Local history purge stays unconditional; only the server write-through is
    // MLS-gated.
    expect(deleteHistorySpy).toHaveBeenCalledWith(CHANNEL, MSG);
    expect(archiveDeleteSpy).not.toHaveBeenCalled();
    archiveDeleteSpy.mockRestore();
  });
});

describe('useDmSocketEvents.onDMMessageUpdated — edit handler stamps/clears undecryptable flags', () => {
  const MSG = '00000000-0000-4000-8000-00000000e002';

  // Seed a message that previously rendered as the lock placeholder (arrived
  // during a transient not-ready window) so the heal sweep would otherwise pick
  // it up via (undecryptable === true && typeof _encryptedEnvelope === 'string').
  function seedUndecryptable(): void {
    useDmStore.getState()._setAll({
      dmChannels: [{ id: CHANNEL, isGroup: false, encrypted: true }],
      dmBlockStatus: {},
    });
    const msg = {
      id: MSG,
      authorId: 'user-peer',
      content: ENCRYPTED_PLACEHOLDER,
      undecryptable: true,
      _encryptedEnvelope: 'ENV_orig',
      timestamp: new Date(),
    } as unknown as Message;
    useMessageStore.getState()._setAll({ dmMessages: { [CHANNEL]: [msg] } });
  }

  it('on a SUCCESSFUL edit decrypt: applies edited content and CLEARS undecryptable + _encryptedEnvelope', async () => {
    seedUndecryptable();
    // Edit's new envelope decrypts to the edited plaintext.
    decryptDMContentSpy.mockImplementation((_ch: string, content: string) =>
      Promise.resolve(content === 'ENV_edit' ? 'edited plaintext' : ENCRYPTED_PLACEHOLDER),
    );

    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    expect(captured.onDMMessageUpdated).toBeTypeOf('function');

    await captured.onDMMessageUpdated!(CHANNEL, MSG, 'ENV_edit', '2026-06-06T00:00:00.000Z', true, 'user-peer');

    const stored = useMessageStore.getState().dmMessages[CHANNEL].find((m) => m.id === MSG)!;
    expect(stored.content).toBe('edited plaintext');
    expect(stored.undecryptable).toBe(false);
    expect(stored._encryptedEnvelope).toBeUndefined();
    // A subsequent heal sweep filter would NOT match this message.
    expect(stored.undecryptable === true && typeof stored._encryptedEnvelope === 'string').toBe(false);
  });

  it('on a FAILED edit decrypt: stamps undecryptable and preserves the NEW edit ciphertext (not the stale original)', async () => {
    seedUndecryptable();
    // The edit arrived while transiently not-ready → decrypts to the placeholder.
    decryptDMContentSpy.mockImplementation(() => Promise.resolve(ENCRYPTED_PLACEHOLDER));

    renderHook(() => useDmSocketEvents({ currentUserId: CURRENT_USER }));
    expect(captured.onDMMessageUpdated).toBeTypeOf('function');

    await captured.onDMMessageUpdated!(CHANNEL, MSG, 'ENV_edit', '2026-06-06T00:00:00.000Z', true, 'user-peer');

    const stored = useMessageStore.getState().dmMessages[CHANNEL].find((m) => m.id === MSG)!;
    expect(stored.content).toBe(ENCRYPTED_PLACEHOLDER);
    expect(stored.undecryptable).toBe(true);
    // Heal sweep must retry the CURRENT (edit) envelope, never the stale original.
    expect(stored._encryptedEnvelope).toBe('ENV_edit');
  });
});
