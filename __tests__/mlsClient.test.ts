// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * mlsClient: typed transport. Verifies request shapes (base64 artifacts,
 * decimal-string epochs, idempotencyKey), the 409 epoch_conflict mapping, the
 * idempotent-200 mapping, and socket subscribe/unsubscribe wiring.
 *
 * apiClient and socketService are mocked so the test asserts on the exact
 * endpoint/options the client builds, never a live network or socket.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// The submitCommit conflict path issues a raw fetch (to read the full 409 body)
// using apiClient.getToken() + API_BASE_URL. Mock both.
const requestMock = vi.fn();
const getTokenMock = vi.fn(() => 'test-token');
vi.mock('../services/api', () => ({
  apiClient: {
    request: (...args: unknown[]) => requestMock(...args),
    getToken: () => getTokenMock(),
  },
}));

const onMock = vi.fn();
const offMock = vi.fn();
// Returns a tracked remover so tests can assert the subscription's unsubscriber
// cancels the queued onSocketCreated callback. `socketPresent` toggles whether
// the callback fires immediately (socket exists) or is left queued.
const removeCreatedMock = vi.fn();
let socketPresent = true;
const onSocketCreatedMock = vi.fn((cb: () => void) => {
  if (socketPresent) cb();
  return removeCreatedMock;
});
vi.mock('../services/socket', () => ({
  socketService: {
    get socket() {
      return socketPresent ? { on: onMock, off: offMock } : null;
    },
    onSocketCreated: (cb: () => void) => onSocketCreatedMock(cb),
  },
}));

// config exports API_BASE_URL used by the raw-fetch conflict path.
vi.mock('../config', () => ({ API_BASE_URL: 'http://test.local/api/v1' }));

import * as client from '../services/mls/mlsClient';

beforeEach(() => {
  requestMock.mockReset();
  onMock.mockReset();
  offMock.mockReset();
  onSocketCreatedMock.mockClear();
  removeCreatedMock.mockClear();
  socketPresent = true;
  getTokenMock.mockClear();
  vi.unstubAllGlobals();
});

describe('mlsClient REST', () => {
  it('publishKeyPackages POSTs deviceId + keyPackages and returns published/remaining', async () => {
    requestMock.mockResolvedValue({ published: 2, remaining: 18 });
    const res = await client.publishKeyPackages('dev-1', [
      { keyPackage: 'a2V5', isLastResort: false },
      { keyPackage: 'bGFzdA', isLastResort: true },
    ]);
    expect(res).toEqual({ published: 2, remaining: 18 });
    const [endpoint, options] = requestMock.mock.calls[0];
    expect(endpoint).toBe('/mls/keypackages');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      deviceId: 'dev-1',
      keyPackages: [
        { keyPackage: 'a2V5', isLastResort: false },
        { keyPackage: 'bGFzdA', isLastResort: true },
      ],
    });
  });

  it('keyPackageCount GETs with the deviceId query', async () => {
    requestMock.mockResolvedValue({ remaining: 5, hasLastResort: true });
    const res = await client.keyPackageCount('dev-1');
    expect(res).toEqual({ remaining: 5, hasLastResort: true });
    expect(requestMock.mock.calls[0][0]).toBe('/mls/keypackages/count?deviceId=dev-1');
  });

  it('consumeKeyPackages GETs by target user and unwraps the keyPackages array', async () => {
    requestMock.mockResolvedValue({
      keyPackages: [{ deviceId: 'd', keyPackage: 'a2V5', keyPackageRef: 'cmVm', isLastResort: false }],
    });
    const target = '00000000-0000-4000-8000-000000000001';
    const res = await client.consumeKeyPackages(target);
    expect(res).toEqual([{ deviceId: 'd', keyPackage: 'a2V5', keyPackageRef: 'cmVm', isLastResort: false }]);
    expect(requestMock.mock.calls[0][0]).toBe(`/mls/keypackages/${target}`);
  });

  it('createGroup POSTs dmChannelId + tier:saved + groupInfo', async () => {
    requestMock.mockResolvedValue({ groupId: 'g1', currentEpoch: '0' });
    const res = await client.createGroup('ch-1', 'Z2lCNjQ');
    expect(res).toEqual({ groupId: 'g1', currentEpoch: '0' });
    const [endpoint, options] = requestMock.mock.calls[0];
    expect(endpoint).toBe('/mls/groups');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({ dmChannelId: 'ch-1', tier: 'saved', groupInfo: 'Z2lCNjQ' });
  });

  it('getGroupInfo GETs and returns groupInfo + groupInfoEpoch', async () => {
    requestMock.mockResolvedValue({ groupInfo: 'Z2k', groupInfoEpoch: '1' });
    const res = await client.getGroupInfo('g1');
    expect(res).toEqual({ groupInfo: 'Z2k', groupInfoEpoch: '1' });
    expect(requestMock.mock.calls[0][0]).toBe('/mls/groups/g1/group-info');
  });

  it('submitCommit POSTs the full member-mode body and maps a 200 to ok:true', async () => {
    requestMock.mockResolvedValue({ epoch: '1', commitId: 'c1' });
    const res = await client.submitCommit({
      groupId: 'g1',
      baseEpoch: '0',
      mode: 'member',
      commitB64: 'Y29tbWl0',
      groupInfoB64: 'Z2k',
      idempotencyKey: 'idemkey-123',
      welcomes: [{ recipientId: 'u2', welcomeData: 'd2VsY29tZQ' }],
    });
    expect(res).toEqual({ ok: true, epoch: '1', commitId: 'c1' });
    const [endpoint, options] = requestMock.mock.calls[0];
    expect(endpoint).toBe('/mls/groups/g1/commits');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      baseEpoch: '0',
      mode: 'member',
      commit: 'Y29tbWl0',
      groupInfo: 'Z2k',
      idempotencyKey: 'idemkey-123',
      welcomes: [{ recipientId: 'u2', welcomeData: 'd2VsY29tZQ' }],
    });
  });

  it('submitCommit serializes removedUserIds (Remove finalize hint) and omits welcomes', async () => {
    requestMock.mockResolvedValue({ epoch: '3', commitId: 'c3' });
    const res = await client.submitCommit({
      groupId: 'g1',
      baseEpoch: '2',
      mode: 'member',
      commitB64: 'Y29tbWl0',
      groupInfoB64: 'Z2k',
      idempotencyKey: 'idemkey-remove',
      removedUserIds: ['u2', 'u3'],
    });
    expect(res).toEqual({ ok: true, epoch: '3', commitId: 'c3' });
    const [endpoint, options] = requestMock.mock.calls[0];
    expect(endpoint).toBe('/mls/groups/g1/commits');
    expect(JSON.parse(options.body)).toEqual({
      baseEpoch: '2',
      mode: 'member',
      commit: 'Y29tbWl0',
      groupInfo: 'Z2k',
      idempotencyKey: 'idemkey-remove',
      removedUserIds: ['u2', 'u3'],
    });
    // The Remove path never carries welcomes.
    expect(JSON.parse(options.body)).not.toHaveProperty('welcomes');
  });

  it('submitCommit maps a 200 {idempotent:true} to ok:true with idempotent flag', async () => {
    requestMock.mockResolvedValue({ epoch: '2', commitId: 'c2', idempotent: true });
    const res = await client.submitCommit({
      groupId: 'g1',
      baseEpoch: '1',
      mode: 'member',
      commitB64: 'Y29tbWl0',
      groupInfoB64: 'Z2k',
      idempotencyKey: 'idemkey-123',
    });
    expect(res).toEqual({ ok: true, epoch: '2', commitId: 'c2', idempotent: true });
  });

  it('submitCommit maps a 409 epoch_conflict to ok:false + conflict + currentEpoch', async () => {
    // The conflict path reads the full 409 body via a raw fetch.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'epoch_conflict', recovery: 'rebase', currentEpoch: '3' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    // request() throws on non-2xx exactly like the real apiClient.
    requestMock.mockRejectedValue(Object.assign(new Error('epoch_conflict'), { status: 409 }));

    const res = await client.submitCommit({
      groupId: 'g1',
      baseEpoch: '0',
      mode: 'member',
      commitB64: 'Y29tbWl0',
      groupInfoB64: 'Z2k',
      idempotencyKey: 'idemkey-123',
    });
    expect(res).toEqual({ ok: false, conflict: 'rebase', currentEpoch: '3' });
    // Raw fetch hit the right URL with the Authorization header.
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://test.local/api/v1/mls/groups/g1/commits');
    expect((init.headers as Record<string, string>)['Authorization']).toBe('Bearer test-token');
  });

  it('submitCommit external-mode 409 maps conflict to refetch_group_info', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'epoch_conflict', recovery: 'refetch_group_info', currentEpoch: null }),
    });
    vi.stubGlobal('fetch', fetchMock);
    requestMock.mockRejectedValue(Object.assign(new Error('epoch_conflict'), { status: 409 }));

    const res = await client.submitCommit({
      groupId: 'g1',
      baseEpoch: '5',
      mode: 'external',
      commitB64: 'Y29tbWl0',
      groupInfoB64: 'Z2k',
      idempotencyKey: 'idemkey-999',
    });
    expect(res).toEqual({ ok: false, conflict: 'refetch_group_info', currentEpoch: null });
  });

  it('submitCommit rethrows non-409 errors (does not swallow)', async () => {
    requestMock.mockRejectedValue(Object.assign(new Error('Server error'), { status: 500 }));
    await expect(
      client.submitCommit({
        groupId: 'g1',
        baseEpoch: '0',
        mode: 'member',
        commitB64: 'Y29tbWl0',
        groupInfoB64: 'Z2k',
        idempotencyKey: 'idemkey-123',
      }),
    ).rejects.toThrow('Server error');
  });

  it('catchUp GETs with sinceEpoch + limit and returns the commits array', async () => {
    requestMock.mockResolvedValue({
      commits: [{ baseEpoch: '1', resultingEpoch: '2', commit: 'Yw', idempotencyKey: 'k' }],
    });
    const res = await client.catchUp('g1', '1', 100);
    expect(res).toHaveLength(1);
    expect(requestMock.mock.calls[0][0]).toBe('/mls/groups/g1/commits?sinceEpoch=1&limit=100');
  });

  it('catchUp omits limit from the query when not supplied', async () => {
    requestMock.mockResolvedValue({ commits: [] });
    await client.catchUp('g1', '0');
    expect(requestMock.mock.calls[0][0]).toBe('/mls/groups/g1/commits?sinceEpoch=0');
  });

  it('getWelcomes GETs /mls/welcomes and unwraps the welcomes array', async () => {
    requestMock.mockResolvedValue({
      welcomes: [{ groupId: 'g1', epoch: '1', welcomeData: 'd2VsY29tZQ' }],
    });
    const res = await client.getWelcomes(50);
    expect(res).toEqual([{ groupId: 'g1', epoch: '1', welcomeData: 'd2VsY29tZQ' }]);
    expect(requestMock.mock.calls[0][0]).toBe('/mls/welcomes?limit=50');
  });
});

describe('mlsClient socket subscriptions', () => {
  it('onMlsCommit subscribes to mls-commit and unsubscribes via the returned fn', () => {
    const cb = vi.fn();
    const unsub = client.onMlsCommit(cb);
    expect(onSocketCreatedMock).toHaveBeenCalledTimes(1);
    // Registered the handler on the live socket.
    expect(onMock).toHaveBeenCalledWith('mls-commit', expect.any(Function));
    // The registered handler routes the payload to cb.
    const handler = onMock.mock.calls[0][1] as (e: unknown) => void;
    handler({ groupId: 'g1', epoch: '2', commit: 'Yw' });
    expect(cb).toHaveBeenCalledWith({ groupId: 'g1', epoch: '2', commit: 'Yw' });
    unsub();
    expect(offMock).toHaveBeenCalledWith('mls-commit', expect.any(Function));
  });

  it('onMlsWelcome subscribes to mls-welcome and unsubscribes', () => {
    const cb = vi.fn();
    const unsub = client.onMlsWelcome(cb);
    expect(onMock).toHaveBeenCalledWith('mls-welcome', expect.any(Function));
    const handler = onMock.mock.calls[0][1] as (e: unknown) => void;
    handler({ groupId: 'g1', epoch: '1' });
    expect(cb).toHaveBeenCalledWith({ groupId: 'g1', epoch: '1' });
    unsub();
    expect(offMock).toHaveBeenCalledWith('mls-welcome', expect.any(Function));
  });

  it('onMlsCommit cancels the queued onSocketCreated callback when torn down before socket creation (FIX 1)', () => {
    // No socket yet: the .on binding is queued via onSocketCreated, not bound.
    socketPresent = false;
    const unsub = client.onMlsCommit(vi.fn());
    expect(onSocketCreatedMock).toHaveBeenCalledTimes(1);
    expect(onMock).not.toHaveBeenCalled(); // nothing bound yet
    // Tear down BEFORE the socket exists: the unsubscriber must cancel the queued
    // callback so it never binds later (no listener leak across activate cycles).
    unsub();
    expect(removeCreatedMock).toHaveBeenCalledTimes(1);
  });

  it('onMlsWelcome cancels the queued onSocketCreated callback when torn down before socket creation (FIX 1)', () => {
    socketPresent = false;
    const unsub = client.onMlsWelcome(vi.fn());
    expect(onSocketCreatedMock).toHaveBeenCalledTimes(1);
    expect(onMock).not.toHaveBeenCalled();
    unsub();
    expect(removeCreatedMock).toHaveBeenCalledTimes(1);
  });
});

describe('idempotencyKeyFor', () => {
  // SHA-256 needs WebCrypto; jsdom lacks it, so install Node's webcrypto polyfill.
  beforeAll(() => {
    if (typeof globalThis.crypto?.subtle === 'undefined') {
      const { webcrypto } = require('node:crypto');
      Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true });
    }
  });

  it('is deterministic for the same logical commit and >= 8 chars', async () => {
    const a = await client.idempotencyKeyFor('g1', '0', 'add', 'u2');
    const b = await client.idempotencyKeyFor('g1', '0', 'add', 'u2');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(8);
  });

  it('differs for a different baseEpoch (genuine rebase), kind, or recipient', async () => {
    const base = await client.idempotencyKeyFor('g1', '0', 'add', 'u2');
    expect(await client.idempotencyKeyFor('g1', '1', 'add', 'u2')).not.toBe(base);
    expect(await client.idempotencyKeyFor('g1', '0', 'update', 'u2')).not.toBe(base);
    expect(await client.idempotencyKeyFor('g1', '0', 'add')).not.toBe(base);
  });
});
