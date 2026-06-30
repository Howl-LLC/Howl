// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown, opts?: { name?: string }) => {
    const base = typeof d === 'string' ? d : k;
    return opts?.name ? base.replace('{{name}}', opts.name) : base;
  } }),
}));
vi.mock('../components/UserAvatar', () => ({ UserAvatar: () => <div data-testid="avatar" /> }));
vi.mock('../components/GroupAvatarComposite', () => ({ GroupAvatarComposite: () => <div data-testid="group-avatar" /> }));

import { EmptyChatState } from '../components/EmptyChatState';

const otherUser = { username: 'alice' };

describe('EmptyChatState — OTR variant', () => {
  it('renders the OTR explainer for the otr surface', () => {
    render(<EmptyChatState surface="otr" channelName="alice" otherUser={otherUser} />);
    expect(screen.getByText('Off the Record with alice')).toBeInTheDocument();
    expect(screen.getByText(/lives only on your devices/i)).toBeInTheDocument();
    expect(screen.getByText(/A new device will not see this history/i)).toBeInTheDocument();
  });

  it('renders the standard DM copy for the dm surface (no OTR cautionary lines)', () => {
    render(<EmptyChatState surface="dm" channelName="alice" otherUser={otherUser} />);
    expect(screen.getByText('This is the start of your messages with alice.')).toBeInTheDocument();
    expect(screen.queryByText(/A new device will not see this history/i)).not.toBeInTheDocument();
  });
});
