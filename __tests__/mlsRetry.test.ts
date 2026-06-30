// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../services/mls/mlsCoordinator', () => ({
  isReadyForChannel: vi.fn(() => false),
  establishChannel: vi.fn(() => Promise.resolve()),
  establishGroupDmChannel: vi.fn(() => Promise.resolve()),
}));
vi.mock('../services/encryptionFlags', () => ({ isChannelMls: vi.fn(() => true) }));

import * as mlsCoordinator from '../services/mls/mlsCoordinator';
import { useDmStore } from '../stores/dmStore';
import { useUiStore } from '../stores/uiStore';
import { routeEstablishOutcome, retryMlsEstablishForUser } from '../utils/mlsRetry';

describe('routeEstablishOutcome', () => {
  beforeEach(() => useUiStore.setState({ establishFailureReasons: {} }));

  it('records a peer-unprovisioned failure with the member id', () => {
    routeEstablishOutcome('chan-1', Object.assign(new Error('x'), { reason: 'peer-unprovisioned', unprovisionedUserId: 'bob' }));
    expect(useUiStore.getState().establishFailureReasons['chan-1']).toEqual({ reason: 'peer-unprovisioned', userId: 'bob' });
  });

  it('is a no-op for a generic error', () => {
    routeEstablishOutcome('chan-1', new Error('boom'));
    expect(useUiStore.getState().establishFailureReasons['chan-1']).toBeUndefined();
  });
});

describe('retryMlsEstablishForUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (mlsCoordinator.isReadyForChannel as ReturnType<typeof vi.fn>).mockReturnValue(false);
    useUiStore.setState({ establishFailureReasons: {} });
    useDmStore.setState({
      dmChannels: [
        { id: 'chan-1', isGroup: false, otherUser: { id: 'bob' }, mlsGroupId: 'g1' },
        { id: 'chan-2', isGroup: false, otherUser: { id: 'carol' }, mlsGroupId: 'g2' },
      ] as never,
    });
  });

  it('re-establishes only a failed channel whose peer matches the now-online user', () => {
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    retryMlsEstablishForUser('bob');
    expect(mlsCoordinator.establishChannel).toHaveBeenCalledWith('chan-1', 'bob', 'g1');
  });

  it('does nothing for a user with no failed channel', () => {
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    retryMlsEstablishForUser('carol');
    expect(mlsCoordinator.establishChannel).not.toHaveBeenCalled();
  });

  it('clears the failure and skips establish when the channel is already ready', () => {
    useUiStore.getState().setEstablishFailureReason('chan-1', 'peer-unprovisioned', 'bob');
    (mlsCoordinator.isReadyForChannel as ReturnType<typeof vi.fn>).mockReturnValue(true);
    retryMlsEstablishForUser('bob');
    expect(mlsCoordinator.establishChannel).not.toHaveBeenCalled();
    expect(useUiStore.getState().establishFailureReasons['chan-1']).toBeUndefined();
  });

  it('re-establishes a rowless (no mlsGroupId) 1:1 channel — fix 2 leaves no server row', () => {
    useDmStore.setState({
      dmChannels: [{ id: 'chan-3', isGroup: false, otherUser: { id: 'dave' }, mlsGroupId: null }] as never,
    });
    useUiStore.getState().setEstablishFailureReason('chan-3', 'peer-unprovisioned', 'dave');
    retryMlsEstablishForUser('dave');
    expect(mlsCoordinator.establishChannel).toHaveBeenCalledWith('chan-3', 'dave', null);
  });

  it('retries a group DM (with row) only when the RECORDED unprovisioned member comes online', () => {
    useDmStore.setState({
      dmChannels: [{ id: 'grp-1', isGroup: true, otherUsers: [{ id: 'alice' }, { id: 'bob' }], mlsGroupId: 'gg1' }] as never,
    });
    useUiStore.getState().setEstablishFailureReason('grp-1', 'peer-unprovisioned', 'alice');
    retryMlsEstablishForUser('bob'); // non-offending member online -> no retry
    expect(mlsCoordinator.establishGroupDmChannel).not.toHaveBeenCalled();
    retryMlsEstablishForUser('alice'); // the recorded member online -> retry
    expect(mlsCoordinator.establishGroupDmChannel).toHaveBeenCalledWith('grp-1', 'gg1');
  });

  it('skips a rowless group DM (group re-create is out of scope for presence retry)', () => {
    useDmStore.setState({
      dmChannels: [{ id: 'grp-2', isGroup: true, otherUsers: [{ id: 'erin' }], mlsGroupId: null }] as never,
    });
    useUiStore.getState().setEstablishFailureReason('grp-2', 'peer-unprovisioned', 'erin');
    retryMlsEstablishForUser('erin');
    expect(mlsCoordinator.establishGroupDmChannel).not.toHaveBeenCalled();
    expect(mlsCoordinator.establishChannel).not.toHaveBeenCalled();
  });
});
