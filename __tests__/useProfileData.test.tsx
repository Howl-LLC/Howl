// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useProfileData } from '../hooks/useProfileData';

vi.mock('../services/api', () => ({
  apiClient: {
    getSpotifyProfile: vi.fn(),
    getShowcase: vi.fn(),
    activityHistory: vi.fn(),
    getUserProfile: vi.fn(),
    getUserMutuals: vi.fn(),
    getUserActivityHistory: vi.fn(),
  },
}));

import { apiClient } from '../services/api';
const m = apiClient as unknown as Record<string, ReturnType<typeof vi.fn>>;

function Harness({ userId }: { userId: string }) {
  const d = useProfileData(userId, { isSelf: false });
  return (
    <div>
      <span data-testid="loading">{String(d.loading)}</span>
      <span data-testid="showcase-loading">{String(d.showcaseLoading)}</span>
      <span data-testid="bio">{d.profileData?.bio ?? ''}</span>
      <span data-testid="friends">{d.mutualFriends.length}</span>
      <span data-testid="servers">{d.mutualServers.length}</span>
    </div>
  );
}

describe('useProfileData', () => {
  beforeEach(() => {
    Object.values(m).forEach(fn => fn.mockReset());
    m.getSpotifyProfile.mockResolvedValue({ connected: false });
    m.getShowcase.mockResolvedValue({ layout: [], mobileLayout: null, gameAccounts: [], steamPlaytime: [], steamRecentActivity: [] });
    m.getUserProfile.mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z', bio: 'hello there', connections: [] });
    m.getUserMutuals.mockResolvedValue({ mutualFriends: [{ id: 'f1' }], mutualServers: [{ id: 's1' }, { id: 's2' }] });
    m.getUserActivityHistory.mockResolvedValue([]);
  });

  it('fetches profile + mutuals + showcase for another user and exposes them', async () => {
    render(<Harness userId="u1" />);
    await waitFor(() => expect(screen.getByTestId('bio').textContent).toBe('hello there'));
    expect(screen.getByTestId('friends').textContent).toBe('1');
    expect(screen.getByTestId('servers').textContent).toBe('2');
    await waitFor(() => expect(screen.getByTestId('loading').textContent).toBe('false'));
    await waitFor(() => expect(screen.getByTestId('showcase-loading').textContent).toBe('false'));
    expect(m.getUserProfile).toHaveBeenCalledWith('u1', undefined);
  });

  it('does not write stale state after the userId changes mid-flight', async () => {
    let resolveFirst!: (v: unknown) => void;
    m.getUserProfile.mockReturnValueOnce(new Promise(res => { resolveFirst = res; }));
    const { rerender } = render(<Harness userId="u1" />);
    rerender(<Harness userId="u2" />);
    // u2 resolves with the beforeEach default ('hello there'); now resolve the stale u1 promise late.
    await waitFor(() => expect(screen.getByTestId('bio').textContent).toBe('hello there'));
    resolveFirst({ createdAt: 'x', bio: 'STALE', connections: [] });
    // Give the late resolution a tick; it must be ignored.
    await new Promise(r => setTimeout(r, 0));
    expect(screen.getByTestId('bio').textContent).toBe('hello there');
  });
});
