// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DMProfilePanel } from '../components/DMProfilePanel';
import type { UserWithRole } from '../components/UserProfilePopup';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../hooks/useGifFrameUrl', () => ({ useGifFrameUrl: (u: string | null | undefined) => u ?? null }));
vi.mock('../stores/authStore', () => ({ useAuthStore: (sel: (s: { currentUser: { id: string } | null }) => unknown) => sel({ currentUser: { id: 'me' } }) }));
vi.mock('../components/showcase/ShowcaseGrid', () => ({ ShowcaseGrid: () => <div data-testid="showcase-grid" /> }));

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

const user = { id: 'u1', username: 'alice', discriminator: '0001', status: 'online' } as unknown as UserWithRole;

function primeMutual(profileOverrides: Record<string, unknown> = {}) {
  m.getSpotifyProfile.mockResolvedValue({ connected: false });
  m.getShowcase.mockResolvedValue({ layout: [{ id: 'c1', type: 'custom_text', size: '1x1', position: 0 }], mobileLayout: null, gameAccounts: [], steamPlaytime: [], steamRecentActivity: [] });
  m.getUserMutuals.mockResolvedValue({ mutualFriends: [], mutualServers: [] });
  m.getUserActivityHistory.mockResolvedValue([]);
  m.getUserProfile.mockResolvedValue({ createdAt: '2026-01-01T00:00:00Z', bio: 'hi from alice', connections: [], ...profileOverrides });
}

describe('DMProfilePanel', () => {
  beforeEach(() => { Object.values(m).forEach(fn => fn.mockReset()); });

  it('renders the username and bio once profile resolves', async () => {
    primeMutual();
    render(<DMProfilePanel user={user} onViewFullProfile={() => {}} />);
    expect(screen.getByText('alice#0001')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('hi from alice')).toBeInTheDocument());
  });

  it('renders the showcase grid when a layout is present', async () => {
    primeMutual();
    render(<DMProfilePanel user={user} onViewFullProfile={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('showcase-grid')).toBeInTheDocument());
  });

  it('renders the private state when the profile is private (and not self)', async () => {
    primeMutual({ private: true });
    render(<DMProfilePanel user={user} onViewFullProfile={() => {}} />);
    await waitFor(() => expect(screen.getByText('Private Profile')).toBeInTheDocument());
    expect(screen.queryByText('hi from alice')).not.toBeInTheDocument();
  });

  it('calls onViewFullProfile with the user when the button is clicked', async () => {
    primeMutual();
    const onView = vi.fn();
    render(<DMProfilePanel user={user} onViewFullProfile={onView} />);
    fireEvent.click(screen.getByRole('button', { name: 'View Full Profile' }));
    expect(onView).toHaveBeenCalledWith(user);
  });

  it('shows a back button and calls onBack when provided', async () => {
    primeMutual();
    const onBack = vi.fn();
    render(<DMProfilePanel user={user} onViewFullProfile={() => {}} onBack={onBack} />);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('renders the user badges passed via the prop', () => {
    primeMutual();
    const user = {
      id: 'u1',
      username: 'Alice',
      discriminator: '0001',
      status: 'online',
      badges: ['pro', 'beta'],
    } as unknown as import('../components/UserProfilePopup').UserWithRole;
    render(<DMProfilePanel user={user} onViewFullProfile={() => {}} />);
    expect(screen.getByTitle('Howl Pro')).toBeInTheDocument();
    expect(screen.getByTitle('Beta')).toBeInTheDocument();
  });
});
