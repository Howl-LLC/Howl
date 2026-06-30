// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { Channel } from '../types';
import type { UserWithRole } from '../components/UserProfilePopup';

// i18n: return the default string when supplied, else the key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

// Settings context — return only the fields ChatArea destructures.
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    uiDensity: 'cozy',
    chatMessageDisplay: 'cozy',
    messageGroupSpacing: 0,
    cssZoomLevel: 100,
    chatSettings: {},
    accessibilitySettings: {},
    timeFormat: 'auto',
    streamerSettings: {},
    mentionHighlightColor: 'cyan',
  }),
}));

vi.mock('../components/SpoilerRevealContext', () => ({
  useSpoilerRevealActions: () => ({ isRevealed: () => false, reveal: () => {} }),
}));

// Lightweight hooks.
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useKeyboardAware', () => ({ useKeyboardAware: () => ({ keyboardOpen: false, viewportHeight: 800 }) }));
vi.mock('../hooks/useRenderLoopDetector', () => ({ useRenderLoopDetector: () => {} }));

// Zustand stores: each is `useXStore(selector)` → `selector(state)`. The factory
// closures must be self-contained (vi.mock is hoisted above any top-level const).
vi.mock('../stores/authStore', () => ({ useAuthStore: (s: (st: Record<string, unknown>) => unknown) => s({ currentUser: { id: 'me', username: 'me', discriminator: '0000', stripePlan: null } }) }));
vi.mock('../stores/navigationStore', () => ({ useNavigationStore: (s: (st: Record<string, unknown>) => unknown) => s({ activeServerId: null }) }));
vi.mock('../stores/serverStore', () => ({ useServerStore: (s: (st: Record<string, unknown>) => unknown) => s({ servers: [], serverMembers: [] }) }));
vi.mock('../stores/dmStore', () => ({ useDmStore: (s: (st: Record<string, unknown>) => unknown) => s({ dmChannels: [] }) }));
vi.mock('../stores/appStore', () => ({ useAppStore: (s: (st: Record<string, unknown>) => unknown) => s({ floatingBarDocked: false }) }));
vi.mock('../stores/messageStore', () => ({
  useMessageStore: (s: (st: Record<string, unknown>) => unknown) => s({
    messages: {},
    dmMessages: {},
    channelHasMore: {},
    dmHasMore: {},
    channelPinnedMessageIds: {},
    dmPinnedMessageIds: {},
  }),
}));
vi.mock('../stores/typingStore', () => ({ useTypingStore: (s: (st: Record<string, unknown>) => unknown) => s({ typingByChannel: {} }) }));
vi.mock('../stores/threadPollStore', () => ({ useThreadPollStore: (s: (st: Record<string, unknown>) => unknown) => s({ channelPolls: {}, channelThreads: {} }) }));
vi.mock('../stores/notificationStore', () => ({ useNotificationStore: (s: (st: Record<string, unknown>) => unknown) => s({ channelLastReadAt: {} }) }));

vi.mock('../services/api', () => ({ apiClient: {} }));

import { ChatArea } from '../components/ChatArea';

const headerUser = { id: 'u1', username: 'alice', discriminator: '0001', status: 'online' } as unknown as UserWithRole;
const channel = { id: 'dm1', name: 'alice', type: 'DM' } as unknown as Channel;

function renderHeader(extra: Record<string, unknown> = {}) {
  return render(
    // chatHidden skips the Virtuoso message list + MessageInput, leaving just the DM header.
    <ChatArea
      channel={channel}
      headerUser={headerUser}
      chatHidden
      onSendMessage={() => {}}
      {...extra}
    />,
  );
}

describe('ChatArea — Off the Record header toggle', () => {
  it('renders the OTR toggle for a 1:1 DM when eligible, and clicking it fires the handler', () => {
    const onToggle = vi.fn();
    renderHeader({ otrEligible: true, onToggleOffTheRecord: onToggle });

    const btn = screen.getByRole('button', { name: 'Off the Record' });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('reflects active state via aria-pressed / accent color', () => {
    renderHeader({ otrEligible: true, offTheRecordActive: true, onToggleOffTheRecord: () => {} });
    const btn = screen.getByRole('button', { name: 'Off the Record' });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not render the toggle when otrEligible is false', () => {
    renderHeader({ otrEligible: false, onToggleOffTheRecord: () => {} });
    expect(screen.queryByRole('button', { name: 'Off the Record' })).not.toBeInTheDocument();
  });

  it('does not render the toggle when no handler is provided', () => {
    renderHeader({ otrEligible: true });
    expect(screen.queryByRole('button', { name: 'Off the Record' })).not.toBeInTheDocument();
  });

  it('shows the "Off the Record" tag only when active', () => {
    const { rerender } = renderHeader({ otrEligible: true, onToggleOffTheRecord: () => {}, offTheRecordActive: false });
    expect(screen.queryByText('Off the Record')).not.toBeInTheDocument();
    rerender(
      <ChatArea channel={channel} headerUser={headerUser} chatHidden onSendMessage={() => {}} otrEligible onToggleOffTheRecord={() => {}} offTheRecordActive />,
    );
    expect(screen.getByText('Off the Record')).toBeInTheDocument();
  });
});
