// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, d?: unknown, opts?: Record<string, unknown>) => {
      let s = typeof d === 'string' ? d : k;
      if (opts) for (const [name, val] of Object.entries(opts)) s = s.split(`{{${name}}}`).join(String(val));
      return s;
    },
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));
vi.mock('../components/ChatArea', () => ({ ChatArea: () => <div data-testid="chatarea-stub" /> }));
vi.mock('../components/MemberList', () => ({ MemberList: () => null }));
vi.mock('../components/GroupChatContextMenu', () => ({ GroupChatContextMenu: () => null }));
vi.mock('../components/dm/GroupEditModal', () => ({ GroupEditModal: () => null }));
vi.mock('../components/dm/AddFriendsToDmModal', () => ({ AddFriendsToDmModal: () => null }));
vi.mock('../components/dm/CreateGroupDmModal', () => ({ CreateGroupDmModal: () => null }));
vi.mock('../components/call/InlineCallSurface', () => ({ InlineCallSurface: () => null }));
vi.mock('../components/call/ParticipantCardFooter', () => ({ ParticipantCardFooter: () => null }));
vi.mock('../components/DMProfilePanel', () => ({ DMProfilePanel: () => null }));
vi.mock('../hooks/useIsMobile', () => ({ useIsMobile: () => true }));
vi.mock('../hooks/useRenderLoopDetector', () => ({ useRenderLoopDetector: () => {} }));
vi.mock('../hooks/useLongPress', () => ({ longPressBindings: () => ({}) }));

// Capture the swipe options so the test can drive commits.
let lastSwipeOpts: { onSwipe?: (dir: 'left' | 'right') => void } | null = null;
vi.mock('../hooks/useSwipeGesture', () => ({
  useSwipeGesture: (opts: { onSwipe?: (dir: 'left' | 'right') => void }) => { lastSwipeOpts = opts; return { bind: {} }; },
}));

vi.mock('../contexts/SettingsContext', () => ({ useSettings: () => ({ chatSettings: { dmSidebarShowActivity: false } }) }));
vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: () => true, isPasswordDerived: () => false, unlock: vi.fn(), rememberOnDevice: vi.fn(), getUnlockOnLogin: () => false,
}));
const establishChannel = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/mls/mlsCoordinator', () => ({
  establishChannel: (...args: unknown[]) => establishChannel(...args),
  isActive: () => true,
}));
vi.mock('../services/encryptionFlags', () => ({ isChannelMls: () => false }));
const routeEstablishOutcome = vi.fn();
vi.mock('../utils/mlsRetry', () => ({ routeEstablishOutcome: (...a: unknown[]) => routeEstablishOutcome(...a) }));
vi.mock('../services/api', () => ({
  apiClient: {
    getToken: () => 't', resolveAssetUrl: (u: unknown) => u,
    getDmCallStatus: vi.fn().mockResolvedValue({ active: false, participants: [] }),
    getFriends: vi.fn().mockResolvedValue([]), invalidateCache: vi.fn(), markDmAsRead: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/socket', () => ({
  socketService: { onDmCallStatusChanged: () => () => {}, onDmCallEnded: () => () => {}, getSocket: () => null },
}));

import { DMView } from '../components/DMView';
import { useAuthStore } from '../stores/authStore';
import { useDmStore } from '../stores/dmStore';
import { useNavigationStore } from '../stores/navigationStore';
import { getOtrFirstSwipeSeen, setOtrFirstSwipeSeen } from '../utils/otrFirstSwipeStorage';

const CHANNEL_ID = 'dm-abc';
const OTHER = { id: 'u-other', username: 'bob', discriminator: '0001', status: 'online' };
const flush = () => new Promise((r) => setTimeout(r, 0));

const noop = () => {};
type DMViewProps = React.ComponentProps<typeof DMView>;
const baseProps: Omit<DMViewProps, 'onSendDMMessage'> = {
  dmUsers: [], onSelectDM: noop, onCreateOrSelectDM: noop, onCreateGroupDM: async () => {}, allUsers: [],
};

function seedDirectRow() {
  act(() => {
    useAuthStore.setState({ currentUser: { id: 'me', username: 'me', discriminator: '0000' } as never });
    useDmStore.setState({
      dmChannels: [{ id: CHANNEL_ID, isGroup: false, otherUser: OTHER, encrypted: true } as never],
      dmBlockStatus: {},
    } as never);
    useNavigationStore.setState({ activeDmChannelId: null, activeDmTier: 'saved' });
  });
  render(<DMView {...baseProps} onSendDMMessage={vi.fn()} />);
}

describe('DMView — OTR row swipe', () => {
  beforeEach(() => {
    lastSwipeOpts = null;
    establishChannel.mockReset().mockResolvedValue(undefined);
    routeEstablishOutcome.mockReset();
  });

  it('swipe-left establishes the OTR group and lands on the OTR tier', async () => {
    establishChannel.mockResolvedValue('grp-otr-1');
    seedDirectRow();
    expect(lastSwipeOpts).toBeTruthy();
    await act(async () => { lastSwipeOpts!.onSwipe!('left'); await flush(); });

    expect(establishChannel).toHaveBeenCalledWith(CHANNEL_ID, OTHER.id, null, 'otr');
    expect(useNavigationStore.getState().activeDmChannelId).toBe(CHANNEL_ID);
    expect(useNavigationStore.getState().activeDmTier).toBe('otr');
    expect(useDmStore.getState().dmChannels.find((c) => c.id === CHANNEL_ID)?.otrMlsGroupId).toBe('grp-otr-1');
  });

  it('swipe-right returns the row to Saved', async () => {
    seedDirectRow();
    await act(async () => { lastSwipeOpts!.onSwipe!('right'); await flush(); });
    expect(useNavigationStore.getState().activeDmChannelId).toBe(CHANNEL_ID);
    expect(useNavigationStore.getState().activeDmTier).toBe('saved');
  });

  it('stays on Saved and routes the outcome when establish fails', async () => {
    const err = new Error('boom');
    establishChannel.mockRejectedValue(err);
    seedDirectRow();
    await act(async () => { lastSwipeOpts!.onSwipe!('left'); await flush(); });
    expect(routeEstablishOutcome).toHaveBeenCalledWith(CHANNEL_ID, err);
    expect(useNavigationStore.getState().activeDmTier).toBe('saved');
  });

  it('does not wire the OTR swipe for group rows', () => {
    act(() => {
      useAuthStore.setState({ currentUser: { id: 'me', username: 'me', discriminator: '0000' } as never });
      useDmStore.setState({
        dmChannels: [{ id: 'grp-1', isGroup: true, otherUsers: [OTHER], encrypted: true } as never],
        dmBlockStatus: {},
      } as never);
      useNavigationStore.setState({ activeDmChannelId: null, activeDmTier: 'saved' });
    });
    lastSwipeOpts = null;
    render(<DMView {...baseProps} onSendDMMessage={vi.fn()} />);
    expect(lastSwipeOpts).toBeNull();
  });
});

describe('DMView — OTR first-swipe toast', () => {
  beforeEach(() => {
    lastSwipeOpts = null;
    establishChannel.mockReset().mockResolvedValue('grp-otr-1');
    localStorage.clear();
  });

  it('fires the explainer toast on the first OTR open and not after "Don\'t show again"', async () => {
    const onShowToast = vi.fn();
    act(() => {
      useAuthStore.setState({ currentUser: { id: 'me', username: 'me', discriminator: '0000' } as never });
      useDmStore.setState({
        dmChannels: [{ id: CHANNEL_ID, isGroup: false, otherUser: OTHER, encrypted: true } as never], dmBlockStatus: {},
      } as never);
      useNavigationStore.setState({ activeDmChannelId: null, activeDmTier: 'saved' });
    });
    render(<DMView {...baseProps} onSendDMMessage={vi.fn()} onShowToast={onShowToast} />);

    await act(async () => { lastSwipeOpts!.onSwipe!('left'); await flush(); });
    expect(onShowToast).toHaveBeenCalledTimes(1);
    expect(String(onShowToast.mock.calls[0][0])).toContain('bob'); // {{name}} interpolated

    // Persisting the flag suppresses subsequent toasts.
    setOtrFirstSwipeSeen(true);
    onShowToast.mockClear();
    await act(async () => { lastSwipeOpts!.onSwipe!('left'); await flush(); });
    expect(onShowToast).not.toHaveBeenCalled();
    expect(getOtrFirstSwipeSeen()).toBe(true);
  });
});
