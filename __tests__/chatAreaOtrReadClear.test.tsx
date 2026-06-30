// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import type { Channel } from '../types';
import type { UserWithRole } from '../components/UserProfilePopup';

/**
 * OTR read-clear is tier-aware: an active OTR room clears the OTR unread maps
 * (by bare id) and never hits the server; a Saved DM clears the Saved maps and
 * calls markDmAsRead.
 */
const H = vi.hoisted(() => {
  const BARE_ID = 'dm-bare-1';
  const OTR_ROOM = `${BARE_ID}#otr`;
  const LAST_READ = '2026-01-01T00:00:00.000Z';
  const notif = {
    removeUnreadDmChannel: vi.fn(),
    clearDmUnread: vi.fn(),
    clearDmMention: vi.fn(),
    removeOtrUnreadDmChannel: vi.fn(),
    clearOtrDmUnread: vi.fn(),
    clearChannelLastReadAt: vi.fn(),
    removeChannelUnread: vi.fn(),
    clearChannelMention: vi.fn(),
  };
  const markDmAsRead = vi.fn(() => Promise.resolve());
  const markChannelRead = vi.fn(() => Promise.resolve());
  return { BARE_ID, OTR_ROOM, LAST_READ, notif, markDmAsRead, markChannelRead };
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
  const dmMsg = { id: 'm1', content: 'hi', authorId: 'u1', timestamp: new Date(H.LAST_READ), type: 'message' };
  return {
    useMessageStore: (s: (st: Record<string, unknown>) => unknown) => s({
      messages: {},
      dmMessages: { [H.OTR_ROOM]: [dmMsg], [H.BARE_ID]: [dmMsg] },
      channelHasMore: {},
      dmHasMore: { [H.OTR_ROOM]: false, [H.BARE_ID]: false },
      channelPinnedMessageIds: {},
      dmPinnedMessageIds: {},
    }),
  };
});
vi.mock('../stores/typingStore', () => ({ useTypingStore: (s: (st: Record<string, unknown>) => unknown) => s({ typingByChannel: {} }) }));
vi.mock('../stores/threadPollStore', () => ({ useThreadPollStore: (s: (st: Record<string, unknown>) => unknown) => s({ channelPolls: {}, channelThreads: {} }) }));
vi.mock('../stores/notificationStore', () => {
  const state = { channelLastReadAt: { [H.OTR_ROOM]: H.LAST_READ, [H.BARE_ID]: H.LAST_READ }, ...H.notif };
  const hook = (s: (st: Record<string, unknown>) => unknown) => s(state);
  hook.getState = () => state;
  return { useNotificationStore: hook };
});
vi.mock('../services/api', () => ({ apiClient: { markDmAsRead: H.markDmAsRead, markChannelRead: H.markChannelRead } }));

import { ChatArea } from '../components/ChatArea';

const headerUser = { id: 'u1', username: 'alice', discriminator: '0001', status: 'online' } as unknown as UserWithRole;

describe('ChatArea — tier-aware OTR read-clear', () => {
  beforeEach(() => vi.clearAllMocks());

  it('OTR room: clears the OTR maps by bare id, never the Saved maps, never markDmAsRead', () => {
    const otrChannel = { id: H.OTR_ROOM, name: 'alice', type: 'DM' } as unknown as Channel;
    render(<ChatArea channel={otrChannel} headerUser={headerUser} chatHidden onSendMessage={() => {}} />);

    expect(H.notif.removeOtrUnreadDmChannel).toHaveBeenCalledWith(H.BARE_ID);
    expect(H.notif.clearOtrDmUnread).toHaveBeenCalledWith(H.BARE_ID);
    expect(H.notif.removeUnreadDmChannel).not.toHaveBeenCalled();
    expect(H.notif.clearDmUnread).not.toHaveBeenCalled();
    expect(H.notif.clearDmMention).not.toHaveBeenCalled();
    expect(H.markDmAsRead).not.toHaveBeenCalled();
  });

  it('Saved DM: clears the Saved maps and calls markDmAsRead, never the OTR maps', () => {
    const savedChannel = { id: H.BARE_ID, name: 'alice', type: 'DM' } as unknown as Channel;
    render(<ChatArea channel={savedChannel} headerUser={headerUser} chatHidden onSendMessage={() => {}} />);

    expect(H.notif.removeUnreadDmChannel).toHaveBeenCalledWith(H.BARE_ID);
    expect(H.notif.clearDmUnread).toHaveBeenCalledWith(H.BARE_ID);
    expect(H.notif.clearDmMention).toHaveBeenCalledWith(H.BARE_ID);
    expect(H.markDmAsRead).toHaveBeenCalledWith(H.BARE_ID);
    expect(H.notif.removeOtrUnreadDmChannel).not.toHaveBeenCalled();
    expect(H.notif.clearOtrDmUnread).not.toHaveBeenCalled();
  });
});
