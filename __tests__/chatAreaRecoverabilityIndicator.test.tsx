// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Channel } from '../types';
import type { UserWithRole } from '../components/UserProfilePopup';

/**
 * Verifies the DM recoverability chip is wired into the ChatArea header: it
 * renders for a 1:1 DM when a recoverabilityState is supplied, reflects the
 * state in its label/accent, and is suppressed while Off the Record is active
 * (the OTR faced indicator owns that case). The mock set mirrors
 * chatAreaOtrEmptySeed.test.tsx so ChatArea renders headlessly.
 */
const H = vi.hoisted(() => {
  const BARE_ID = 'dm-recoverability-seed';
  const setDmMessages = vi.fn();
  const renderState: Record<string, unknown> = {
    messages: {}, dmMessages: {}, channelHasMore: {}, dmHasMore: {},
    channelPinnedMessageIds: {}, dmPinnedMessageIds: {},
  };
  const liveState: { dmMessages: Record<string, unknown[]>; dmHasMore: Record<string, boolean> } = {
    dmMessages: {}, dmHasMore: {},
  };
  return { BARE_ID, setDmMessages, renderState, liveState };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({
    uiDensity: 'cozy', chatMessageDisplay: 'cozy', messageGroupSpacing: 0, cssZoomLevel: 100,
    chatSettings: {}, accessibilitySettings: {}, timeFormat: 'auto', streamerSettings: {}, mentionHighlightColor: 'cyan',
  }),
}));
vi.mock('../components/SpoilerRevealContext', () => ({
  useSpoilerRevealActions: () => ({ isRevealed: () => false, reveal: () => {} }),
}));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => false }));
vi.mock('../hooks/useKeyboardAware', () => ({ useKeyboardAware: () => ({ keyboardOpen: false, viewportHeight: 800 }) }));
vi.mock('../hooks/useRenderLoopDetector', () => ({ useRenderLoopDetector: () => {} }));
vi.mock('../stores/authStore', () => ({ useAuthStore: (s: (st: Record<string, unknown>) => unknown) => s({ currentUser: { id: 'me', username: 'me', discriminator: '0000', stripePlan: null } }) }));
vi.mock('../stores/navigationStore', () => ({ useNavigationStore: (s: (st: Record<string, unknown>) => unknown) => s({ activeServerId: null }) }));
vi.mock('../stores/serverStore', () => ({ useServerStore: (s: (st: Record<string, unknown>) => unknown) => s({ servers: [], serverMembers: [] }) }));
vi.mock('../stores/dmStore', () => ({ useDmStore: (s: (st: Record<string, unknown>) => unknown) => s({ dmChannels: [] }) }));
vi.mock('../stores/appStore', () => ({ useAppStore: (s: (st: Record<string, unknown>) => unknown) => s({ floatingBarDocked: false }) }));
vi.mock('../stores/messageStore', () => {
  const hook = (s: (st: Record<string, unknown>) => unknown) => s(H.renderState);
  hook.getState = () => ({
    ...H.renderState,
    dmMessages: H.liveState.dmMessages,
    dmHasMore: H.liveState.dmHasMore,
    setDmMessages: H.setDmMessages,
  });
  return { useMessageStore: hook };
});
vi.mock('../stores/typingStore', () => ({ useTypingStore: (s: (st: Record<string, unknown>) => unknown) => s({ typingByChannel: {} }) }));
vi.mock('../stores/threadPollStore', () => ({ useThreadPollStore: (s: (st: Record<string, unknown>) => unknown) => s({ channelPolls: {}, channelThreads: {} }) }));
vi.mock('../stores/notificationStore', () => {
  const state = {
    channelLastReadAt: {},
    removeUnreadDmChannel: vi.fn(), clearDmUnread: vi.fn(), clearDmMention: vi.fn(),
    removeOtrUnreadDmChannel: vi.fn(), clearOtrDmUnread: vi.fn(),
    clearChannelLastReadAt: vi.fn(), removeChannelUnread: vi.fn(), clearChannelMention: vi.fn(),
  };
  const hook = (s: (st: Record<string, unknown>) => unknown) => s(state);
  hook.getState = () => state;
  return { useNotificationStore: hook };
});
vi.mock('../services/api', () => ({ apiClient: { markDmAsRead: vi.fn(() => Promise.resolve()), markChannelRead: vi.fn(() => Promise.resolve()) } }));

import { ChatArea } from '../components/ChatArea';

const headerUser = { id: 'u1', username: 'alice', discriminator: '0001', status: 'online' } as unknown as UserWithRole;
const dmChannel = { id: H.BARE_ID, name: 'alice', type: 'DM' } as unknown as Channel;

describe('ChatArea - DM recoverability indicator wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.renderState.dmMessages = {};
    H.renderState.dmHasMore = {};
    H.liveState.dmMessages = {};
    H.liveState.dmHasMore = {};
  });

  it('renders the Private chip for a 1:1 DM when recoverabilityState is "private"', () => {
    render(
      <ChatArea
        channel={dmChannel}
        headerUser={headerUser}
        recoverabilityState="private"
        onSendMessage={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Private' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recoverable' })).not.toBeInTheDocument();
  });

  it('renders the Recoverable chip when recoverabilityState is "recoverable-self"', () => {
    render(
      <ChatArea
        channel={dmChannel}
        headerUser={headerUser}
        recoverabilityState="recoverable-self"
        onSendMessage={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: 'Recoverable' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Private' })).not.toBeInTheDocument();
  });

  it('suppresses the chip while Off the Record is active, even with a recoverabilityState', () => {
    render(
      <ChatArea
        channel={dmChannel}
        headerUser={headerUser}
        recoverabilityState="private"
        offTheRecordActive
        onSendMessage={() => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Private' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Recoverable' })).not.toBeInTheDocument();
  });
});
