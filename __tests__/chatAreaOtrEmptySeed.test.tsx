// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { Channel } from '../types';
import type { UserWithRole } from '../components/UserProfilePopup';

/**
 * OTR rooms are ephemeral and never fetch history, so nothing seeds
 * dmHasMore['<id>#otr']. Without that, channelFetched (and showEmptyState)
 * stays false and the OTR empty-room explainer + start-composer placeholder
 * never render on open. ChatArea must seed an empty "fetched" bucket for an
 * un-fetched, empty OTR room — but must NOT seed a Saved DM, and must NOT wipe
 * a message that already arrived (e.g. the on-open re-pull burst landing in the
 * gap between render and the passive-effect flush). The effect re-reads LIVE
 * store state, so the no-wipe guarantee holds even when the render-time view is
 * still empty.
 */
const H = vi.hoisted(() => {
  const BARE_ID = 'dm-bare-seed';
  const OTR_ROOM = `${BARE_ID}#otr`;
  const setDmMessages = vi.fn();
  // renderState = what selectors see at render time.
  // liveState = what useMessageStore.getState() returns when the effect runs.
  // They diverge to simulate a message landing between render and effect flush.
  const renderState: Record<string, unknown> = {
    messages: {}, dmMessages: {}, channelHasMore: {}, dmHasMore: {},
    channelPinnedMessageIds: {}, dmPinnedMessageIds: {},
  };
  const liveState: { dmMessages: Record<string, unknown[]>; dmHasMore: Record<string, boolean> } = {
    dmMessages: {}, dmHasMore: {},
  };
  return { BARE_ID, OTR_ROOM, setDmMessages, renderState, liveState };
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
  // getState returns the LIVE view (with overrides), plus the spy.
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

describe('ChatArea — OTR empty-room bucket seed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    H.renderState.dmMessages = {};
    H.renderState.dmHasMore = {};
    H.liveState.dmMessages = {};
    H.liveState.dmHasMore = {};
  });

  it('seeds an empty fetched bucket for an un-fetched, empty OTR room', () => {
    const otrChannel = { id: H.OTR_ROOM, name: 'alice', type: 'DM' } as unknown as Channel;
    render(<ChatArea channel={otrChannel} headerUser={headerUser} chatHidden onSendMessage={() => {}} />);
    expect(H.setDmMessages).toHaveBeenCalledWith(H.OTR_ROOM, [], false);
  });

  it('does NOT seed a Saved (non-OTR) DM room', () => {
    const savedChannel = { id: H.BARE_ID, name: 'alice', type: 'DM' } as unknown as Channel;
    render(<ChatArea channel={savedChannel} headerUser={headerUser} chatHidden onSendMessage={() => {}} />);
    expect(H.setDmMessages).not.toHaveBeenCalledWith(H.BARE_ID, [], false);
  });

  it('does NOT wipe an OTR message that landed between render and effect (live re-read)', () => {
    // Render-time view is still empty, but the live store already holds a message
    // (delivered via the on-open re-pull burst). The effect must NOT seed [].
    H.liveState.dmMessages = { [H.OTR_ROOM]: [{ id: 'm1', content: 'hi', authorId: 'u1' }] };
    const otrChannel = { id: H.OTR_ROOM, name: 'alice', type: 'DM' } as unknown as Channel;
    render(<ChatArea channel={otrChannel} headerUser={headerUser} chatHidden onSendMessage={() => {}} />);
    expect(H.setDmMessages).not.toHaveBeenCalled();
  });
});
