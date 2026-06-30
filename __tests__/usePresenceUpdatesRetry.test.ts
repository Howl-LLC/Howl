// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('../utils/mlsRetry', () => ({ retryMlsEstablishForUser: vi.fn() }));

let presenceHandler: ((p: { userId: string; status: string }) => void) | null = null;
vi.mock('../services/socket', () => ({
  socketService: {
    onPresenceUpdate: vi.fn((cb: (p: { userId: string; status: string }) => void) => { presenceHandler = cb; }),
    offPresenceUpdate: vi.fn(),
  },
}));
// vi.mock paths resolve relative to THIS test file, so the hook's
// './useAppVisible' import is intercepted via '../hooks/useAppVisible'.
vi.mock('../hooks/useAppVisible', () => ({ isAppVisible: () => true, onVisibilityChange: () => () => {} }));

import { retryMlsEstablishForUser } from '../utils/mlsRetry';
import { usePresenceUpdates } from '../hooks/usePresenceUpdates';

describe('usePresenceUpdates — peer-online MLS retrigger', () => {
  beforeEach(() => { vi.useFakeTimers(); presenceHandler = null; vi.clearAllMocks(); });
  afterEach(() => vi.useRealTimers());

  it('retries MLS establish for a user who flips to any connected status, on the next flush', () => {
    renderHook(() => usePresenceUpdates({ currentUserId: 'me' }));
    expect(presenceHandler).toBeTypeOf('function');
    presenceHandler!({ userId: 'bob', status: 'online' });
    presenceHandler!({ userId: 'carol', status: 'offline' });
    presenceHandler!({ userId: 'dave', status: 'idle' });
    vi.advanceTimersByTime(2000); // VISIBLE_FLUSH_MS

    expect(retryMlsEstablishForUser).toHaveBeenCalledWith('bob');
    expect(retryMlsEstablishForUser).toHaveBeenCalledWith('dave');
    expect(retryMlsEstablishForUser).not.toHaveBeenCalledWith('carol');
  });
});
