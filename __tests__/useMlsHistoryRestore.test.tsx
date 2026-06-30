// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import { renderHook } from '@testing-library/react';

// First-join restore. On a fresh device, opening a Saved DM triggers an
// External-Commit self-join that runs CONCURRENTLY with the open: at mount the
// channel is not yet ready, so the lazy restore must no-op and then RETRY when the
// channel transitions to ready. The self-joining device fires neither mls-ready nor
// onEpochChange, so the hook also retries on the mlsCoordinator.onReadyChannel
// signal, which fills the full history without a manual reload.

let readyChannelCb: ((id: string) => void) | null = null;
let ready = false;

vi.mock('../services/mls/mlsCoordinator', () => ({
  mlsEvents: { on: () => () => {} },
  onEpochChange: () => () => {},
  onReadyChannel: (cb: (id: string) => void) => { readyChannelCb = cb; return () => { readyChannelCb = null; }; },
  isReadyForChannel: () => ready,
}));
vi.mock('../services/encryptionFlags', () => ({ isChannelMls: () => true }));
vi.mock('../services/mls/mlsHistoryRestore', () => ({ restoreChannelHistory: vi.fn() }));

import { restoreChannelHistory } from '../services/mls/mlsHistoryRestore';
import { useMlsHistoryRestore } from '../hooks/useMlsHistoryRestore';

const CH = 'dm-1';
const USER = 'u1';

describe('useMlsHistoryRestore', () => {
  beforeEach(() => { readyChannelCb = null; ready = false; vi.clearAllMocks(); });

  it('does not restore on mount while the channel is not yet ready (concurrent self-join)', () => {
    renderHook(() => useMlsHistoryRestore({ currentUserId: USER, activeDmChannelId: CH }));
    expect(restoreChannelHistory).not.toHaveBeenCalled();
  });

  it('retries the restore when the channel NEWLY becomes ready (first-join gap)', () => {
    renderHook(() => useMlsHistoryRestore({ currentUserId: USER, activeDmChannelId: CH }));
    expect(restoreChannelHistory).not.toHaveBeenCalled(); // self-join still in flight
    expect(readyChannelCb).toBeTruthy();                  // hook subscribed to the ready signal
    ready = true;                                         // self-join completes -> channel ready
    readyChannelCb!(CH);                                  // readiness transition fires
    expect(restoreChannelHistory).toHaveBeenCalledTimes(1);
    expect(restoreChannelHistory).toHaveBeenCalledWith(USER, CH);
  });

  it('ignores a ready transition for a different channel', () => {
    renderHook(() => useMlsHistoryRestore({ currentUserId: USER, activeDmChannelId: CH }));
    ready = true;
    readyChannelCb!('other-channel');
    expect(restoreChannelHistory as Mock).not.toHaveBeenCalled();
  });
});
