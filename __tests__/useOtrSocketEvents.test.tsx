// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { renderHook } from '@testing-library/react';
import { socketService } from '../services/socket';
import type { SocketOtrMessagePayload, SocketOtrEndedPayload } from '../services/socketTypes';

/**
 * Lightweight fake of the socket.io-client Socket surface used by the OTR
 * wrappers (on/off/emit). `on` records handlers so tests can simulate an
 * inbound event by invoking the captured handler.
 */
function makeFakeSocket() {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    connected: true,
    on: vi.fn((event: string, cb: (payload: unknown) => void) => { handlers.set(event, cb); }),
    off: vi.fn((event: string) => { handlers.delete(event); }),
    once: vi.fn((event: string, cb: (payload: unknown) => void) => { handlers.set(event, cb); }),
    emit: vi.fn(),
    /** Test helper: drive an inbound event through the registered handler. */
    __emitInbound(event: string, payload: unknown) { handlers.get(event)?.(payload); },
  };
}

describe('OTR socket wrappers', () => {
  let fakeSocket: ReturnType<typeof makeFakeSocket>;

  beforeEach(() => {
    fakeSocket = makeFakeSocket();
    socketService.socket = fakeSocket as unknown as NonNullable<typeof socketService.socket>;
  });

  it('onOtrMessage registers a handler that fires the callback with the inbound payload', () => {
    const cb = vi.fn();
    socketService.onOtrMessage(cb);
    expect(fakeSocket.on).toHaveBeenCalledWith('otr-message', expect.any(Function));

    const payload: SocketOtrMessagePayload = {
      dmChannelId: 'dm-1',
      mlsGroupId: 'g-1',
      clientMsgId: 'c-1',
      ciphertext: 'deadbeef',
      authorId: 'u-1',
      createdAt: 123,
    };
    fakeSocket.__emitInbound('otr-message', payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('emitOtrMessage emits otr-message with the payload', () => {
    const payload = { dmChannelId: 'dm-1', mlsGroupId: 'g-1', clientMsgId: 'c-1', ciphertext: 'deadbeef' };
    socketService.emitOtrMessage(payload);
    expect(fakeSocket.emit).toHaveBeenCalledWith('otr-message', payload);
  });
});

// useOtrSocketEvents hook (incoming render / ended teardown / pull)
vi.mock('../services/dmEncryption', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, decryptSingleDMMessage: vi.fn() };
});
vi.mock('../services/mls/mlsCoordinator', async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    endOtrGroup: vi.fn().mockResolvedValue(undefined),
    // The pull is gated on activation and re-fired on ready signals.
    isActive: vi.fn(() => true),
    onReadyChannel: vi.fn(() => () => {}),
    mlsEvents: { on: vi.fn(() => () => {}) },
  };
});
// Notification side effects are not under test here — stub them out so the hook
// runs without a DOM Audio / storage dependency.
vi.mock('../utils/notificationSound', () => ({ playMessageNotification: vi.fn() }));
vi.mock('../utils/dmMuteStorage', () => ({ isDmChannelMuted: () => false }));

import * as dmEncryption from '../services/dmEncryption';
import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { roomKey } from '../services/mls/roomKey';
import { useMessageStore } from '../stores/messageStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useOtrSocketEvents } from '../hooks/useOtrSocketEvents';

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('useOtrSocketEvents', () => {
  let fakeSocket: ReturnType<typeof makeFakeSocket>;
  const CH = 'dm-1';

  beforeEach(() => {
    vi.clearAllMocks();
    fakeSocket = makeFakeSocket();
    socketService.socket = fakeSocket as unknown as NonNullable<typeof socketService.socket>;
    useMessageStore.setState({ dmMessages: {} });
    useNavigationStore.setState({ activeDmChannelId: null, activeDmTier: 'saved' });
    useNotificationStore.setState({
      unreadDmChannelIds: new Set(), dmUnreadCounts: {},
      otrUnreadDmChannelIds: new Set(), otrDmUnreadCounts: {},
    });
    // clearAllMocks resets call records but not implementations, so a prior
    // test's mockReturnValue(false) would leak; restore the active default.
    (mlsCoordinator.isActive as Mock).mockReturnValue(true);
  });

  it('decrypts an inbound otr-message into the OTR bucket, dedups, and acks', async () => {
    (dmEncryption.decryptSingleDMMessage as Mock).mockResolvedValue({
      id: 'c-1', authorId: 'u-other', content: 'hello otr', timestamp: new Date(), type: 'message',
    });
    renderHook(() => useOtrSocketEvents('u-me'));

    const payload: SocketOtrMessagePayload = {
      dmChannelId: CH, mlsGroupId: 'g-1', clientMsgId: 'c-1', ciphertext: 'deadbeef', authorId: 'u-other',
    };
    fakeSocket.__emitInbound('otr-message', payload);
    await flush();

    // Decrypt called with the 'otr' tier param (4th arg), channel id 1st.
    expect(dmEncryption.decryptSingleDMMessage).toHaveBeenCalledWith(CH, expect.anything(), undefined, 'otr');
    // Inserted into the namespaced OTR bucket, not the bare channel bucket.
    const otrBucket = useMessageStore.getState().dmMessages[roomKey(CH, 'otr')];
    expect(otrBucket).toHaveLength(1);
    expect(otrBucket[0].content).toBe('hello otr');
    expect(useMessageStore.getState().dmMessages[CH]).toBeUndefined();
    // Acked.
    expect(fakeSocket.emit).toHaveBeenCalledWith('otr-ack', { clientMsgId: 'c-1' });

    // A second identical event dedups (no double-insert) but re-acks.
    (dmEncryption.decryptSingleDMMessage as Mock).mockClear();
    fakeSocket.__emitInbound('otr-message', payload);
    await flush();
    expect(dmEncryption.decryptSingleDMMessage).not.toHaveBeenCalled();
    expect(useMessageStore.getState().dmMessages[roomKey(CH, 'otr')]).toHaveLength(1);
    expect(fakeSocket.emit).toHaveBeenCalledWith('otr-ack', { clientMsgId: 'c-1' });
  });

  it('drops a message whose decrypt fails (no placeholder, no ack)', async () => {
    (dmEncryption.decryptSingleDMMessage as Mock).mockRejectedValue(new Error('no key'));
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-message', {
      dmChannelId: CH, mlsGroupId: 'g-1', clientMsgId: 'c-2', ciphertext: 'deadbeef', authorId: 'u-other',
    } as SocketOtrMessagePayload);
    await flush();

    expect(useMessageStore.getState().dmMessages[roomKey(CH, 'otr')]).toBeUndefined();
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('otr-ack', { clientMsgId: 'c-2' });
  });

  it('drops an undecryptable placeholder without inserting or acking', async () => {
    // decryptSingleDMMessage(...,'otr') does NOT throw on failure — it resolves an
    // undecryptable 🔒 placeholder. For ephemeral OTR that must be dropped (never
    // shown) and left UN-acked so it stays queued for a post-activation retry.
    (dmEncryption.decryptSingleDMMessage as Mock).mockResolvedValue({
      id: 'c-3', authorId: 'u-other', content: dmEncryption.ENCRYPTED_PLACEHOLDER,
      timestamp: new Date(), type: 'message', undecryptable: true,
    });
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-message', {
      dmChannelId: CH, mlsGroupId: 'g-1', clientMsgId: 'c-3', ciphertext: 'deadbeef', authorId: 'u-other',
    } as SocketOtrMessagePayload);
    await flush();

    expect(useMessageStore.getState().dmMessages[roomKey(CH, 'otr')]).toBeUndefined();
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('otr-ack', { clientMsgId: 'c-3' });
  });

  it('otr-ended clears the OTR bucket and ends the OTR group', async () => {
    useMessageStore.getState().setDmMessages(roomKey(CH, 'otr'), [
      { id: 'c-1', authorId: 'u-other', content: 'hi', timestamp: new Date(), type: 'message' },
    ], false);
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-ended', { dmChannelId: CH, mlsGroupId: 'g-1' } as SocketOtrEndedPayload);
    await flush();

    expect(useMessageStore.getState().dmMessages[roomKey(CH, 'otr')]).toEqual([]);
    expect(mlsCoordinator.endOtrGroup).toHaveBeenCalledWith(CH);
  });

  it('otr-ended resets the active tier to saved when the OTR room is active', async () => {
    useNavigationStore.setState({ activeDmChannelId: CH, activeDmTier: 'otr' });
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-ended', { dmChannelId: CH, mlsGroupId: 'g-1' } as SocketOtrEndedPayload);
    await flush();

    expect(useNavigationStore.getState().activeDmTier).toBe('saved');
  });

  it('pulls queued OTR messages on connect when MLS is active', () => {
    (mlsCoordinator.isActive as Mock).mockReturnValue(true);
    renderHook(() => useOtrSocketEvents('u-me'));
    expect(fakeSocket.emit).toHaveBeenCalledWith('otr-pull', {});
  });

  it('does not pull on connect while MLS is still inactive', () => {
    // On a reload the socket reconnects before MLS finishes loading the OTR
    // group from IndexedDB; an eager pull then delivers envelopes we can't
    // decrypt yet. Gate the pull on activation.
    (mlsCoordinator.isActive as Mock).mockReturnValue(false);
    renderHook(() => useOtrSocketEvents('u-me'));
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('otr-pull', {});
  });

  it('re-pulls queued OTR messages once MLS becomes ready', () => {
    (mlsCoordinator.isActive as Mock).mockReturnValue(false);
    renderHook(() => useOtrSocketEvents('u-me'));
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('otr-pull', {});

    // Activation completes (in-process path emits 'mls-ready'; the worker relays it).
    (mlsCoordinator.isActive as Mock).mockReturnValue(true);
    const onMls = (mlsCoordinator.mlsEvents.on as Mock).mock.calls[0][0] as (e: string) => void;
    onMls('mls-locked'); // unrelated event → no pull
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('otr-pull', {});
    onMls('mls-ready');
    expect(fakeSocket.emit).toHaveBeenCalledWith('otr-pull', {});
  });

  it('re-pulls when an OTR group newly becomes ready, but not a saved group', () => {
    renderHook(() => useOtrSocketEvents('u-me'));
    fakeSocket.emit.mockClear(); // ignore the eager connect pull
    const onReadyCh = (mlsCoordinator.onReadyChannel as Mock).mock.calls[0][0] as (rk: string) => void;

    onReadyCh(roomKey(CH, 'saved')); // bare channel id (a Saved group) → no re-pull
    expect(fakeSocket.emit).not.toHaveBeenCalledWith('otr-pull', {});

    onReadyCh(roomKey(CH, 'otr')); // '<id>#otr' → re-pull
    expect(fakeSocket.emit).toHaveBeenCalledWith('otr-pull', {});
  });

  it('unsubscribes the ready listeners on unmount', () => {
    const offReadyChannel = vi.fn();
    const offMlsReady = vi.fn();
    (mlsCoordinator.onReadyChannel as Mock).mockReturnValueOnce(offReadyChannel);
    (mlsCoordinator.mlsEvents.on as Mock).mockReturnValueOnce(offMlsReady);
    const { unmount } = renderHook(() => useOtrSocketEvents('u-me'));
    unmount();
    expect(offReadyChannel).toHaveBeenCalled();
    expect(offMlsReady).toHaveBeenCalled();
  });

  it('bumps OTR unread (not Saved) for an inbound message when the OTR room is not active', async () => {
    (dmEncryption.decryptSingleDMMessage as Mock).mockResolvedValue({
      id: 'c-9', authorId: 'u-other', content: 'ping', timestamp: new Date(), type: 'message',
    });
    useNavigationStore.setState({ activeDmChannelId: null, activeDmTier: 'saved' });
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-message', {
      dmChannelId: CH, mlsGroupId: 'g-1', clientMsgId: 'c-9', ciphertext: 'deadbeef', authorId: 'u-other',
    } as SocketOtrMessagePayload);
    await flush();

    expect(useNotificationStore.getState().otrUnreadDmChannelIds.has(CH)).toBe(true);
    expect(useNotificationStore.getState().otrDmUnreadCounts[CH]).toBe(1);
    // Saved unread is untouched.
    expect(useNotificationStore.getState().unreadDmChannelIds.has(CH)).toBe(false);
    expect(useNotificationStore.getState().dmUnreadCounts[CH]).toBeUndefined();
  });

  it('does not bump OTR unread when the OTR room is already active', async () => {
    (dmEncryption.decryptSingleDMMessage as Mock).mockResolvedValue({
      id: 'c-10', authorId: 'u-other', content: 'ping', timestamp: new Date(), type: 'message',
    });
    useNavigationStore.setState({ activeDmChannelId: CH, activeDmTier: 'otr' });
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-message', {
      dmChannelId: CH, mlsGroupId: 'g-1', clientMsgId: 'c-10', ciphertext: 'deadbeef', authorId: 'u-other',
    } as SocketOtrMessagePayload);
    await flush();

    expect(useNotificationStore.getState().otrUnreadDmChannelIds.has(CH)).toBe(false);
  });

  it('otr-ended clears the channel OTR unread', async () => {
    useNotificationStore.getState().addOtrUnreadDmChannel(CH);
    useNotificationStore.getState().incrementOtrDmUnread(CH);
    renderHook(() => useOtrSocketEvents('u-me'));

    fakeSocket.__emitInbound('otr-ended', { dmChannelId: CH, mlsGroupId: 'g-1' } as SocketOtrEndedPayload);
    await flush();

    expect(useNotificationStore.getState().otrUnreadDmChannelIds.has(CH)).toBe(false);
    expect(useNotificationStore.getState().otrDmUnreadCounts[CH]).toBeUndefined();
  });
});
