// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// i18n: return the default string when supplied, else the key.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => () => {} }));

// Stub ChatArea: capture the props DMView wires (channel.id, the OTR flags)
//    and expose a button that invokes onSendMessage so we can assert the tier
// threads through handleSendDMMessage → onSendDMMessage(id, …, tier).
const chatAreaProps: { current: Record<string, unknown> | null } = { current: null };
vi.mock('../components/ChatArea', () => ({
  ChatArea: (props: Record<string, unknown>) => {
    chatAreaProps.current = props;
    return (
      <div data-testid="chatarea-stub">
        <span data-testid="channel-id">{(props.channel as { id: string }).id}</span>
        <span data-testid="otr-active">{String(props.offTheRecordActive)}</span>
        <button
          type="button"
          data-testid="send-btn"
          onClick={() => (props.onSendMessage as (c: string) => void)('hello')}
        >
          send
        </button>
      </div>
    );
  },
}));

// Heavy / irrelevant children + leaf modules DMView imports at module scope.
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
vi.mock('../hooks/useSwipeGesture', () => ({ useSwipeGesture: () => ({ bind: {} }) }));
vi.mock('../hooks/useLongPress', () => ({ longPressBindings: () => ({}) }));

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ chatSettings: { dmSidebarShowActivity: false } }),
}));

// Services. dmKeyManager: unlocked + Self recovery → otrEligible true.
vi.mock('../services/dmKeyManager', () => ({
  isUnlocked: () => true,
  isPasswordDerived: () => false,
  unlock: vi.fn(),
  rememberOnDevice: vi.fn(),
  getUnlockOnLogin: () => false,
}));
const establishChannel = vi.fn().mockResolvedValue(undefined);
vi.mock('../services/mls/mlsCoordinator', () => ({
  establishChannel: (...args: unknown[]) => establishChannel(...args),
  isActive: () => true,
}));
vi.mock('../services/encryptionFlags', () => ({ isChannelMls: () => false }));
vi.mock('../utils/mlsRetry', () => ({ routeEstablishOutcome: vi.fn() }));

vi.mock('../services/api', () => ({
  apiClient: {
    getToken: () => 't',
    resolveAssetUrl: (u: unknown) => u,
    getDmCallStatus: vi.fn().mockResolvedValue({ active: false, participants: [] }),
    getFriends: vi.fn().mockResolvedValue([]),
    invalidateCache: vi.fn(),
    markDmAsRead: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/socket', () => ({
  socketService: {
    onDmCallStatusChanged: () => () => {},
    onDmCallEnded: () => () => {},
    getSocket: () => null,
  },
}));

import { DMView } from '../components/DMView';
import { useAuthStore } from '../stores/authStore';
import { useDmStore } from '../stores/dmStore';
import { useNavigationStore } from '../stores/navigationStore';

const CHANNEL_ID = 'dm-abc';
const OTHER = { id: 'u-other', username: 'bob', discriminator: '0001', status: 'online' };

function seedStores(tier: 'saved' | 'otr') {
  act(() => {
    useAuthStore.setState({ currentUser: { id: 'me', username: 'me', discriminator: '0000' } as never });
    useDmStore.setState({
      dmChannels: [{ id: CHANNEL_ID, isGroup: false, otherUser: OTHER, encrypted: true } as never],
      dmBlockStatus: {},
    } as never);
    useNavigationStore.setState({ activeDmChannelId: CHANNEL_ID, activeDmTier: tier });
  });
}

const noop = () => {};
type DMViewProps = React.ComponentProps<typeof DMView>;
const baseProps: Omit<DMViewProps, 'onSendDMMessage'> = {
  dmUsers: [],
  onSelectDM: noop,
  onCreateOrSelectDM: noop,
  onCreateGroupDM: async () => {},
  allUsers: [],
};

describe('DMView — OTR room wiring', () => {
  beforeEach(() => {
    chatAreaProps.current = null;
    establishChannel.mockClear();
  });

  it('passes the OTR room-key channel id + offTheRecordActive when activeDmTier=otr', () => {
    seedStores('otr');
    const onSendDMMessage = vi.fn();
    render(<DMView {...baseProps} onSendDMMessage={onSendDMMessage} />);

    expect(screen.getByTestId('channel-id').textContent).toBe(`${CHANNEL_ID}#otr`);
    expect(screen.getByTestId('otr-active').textContent).toBe('true');
  });

  it('threads the active tier into onSendDMMessage (bare id + tier)', () => {
    seedStores('otr');
    const onSendDMMessage = vi.fn();
    render(<DMView {...baseProps} onSendDMMessage={onSendDMMessage} />);

    fireEvent.click(screen.getByTestId('send-btn'));
    expect(onSendDMMessage).toHaveBeenCalledWith(CHANNEL_ID, 'hello', undefined, undefined, 'otr');
  });

  it('writes the established OTR groupId into the dmStore entry when enabling OTR on an existing DM', async () => {
    // Toggling OTR on an EXISTING channel creates the server OTR group lazily; the
    // dmStore entry has no otrMlsGroupId yet. The toggle must persist the groupId
    // establishChannel resolves, or the first OTR send throws "not set up" because
    // sendEncryptedDmMessage reads dmChannel.otrMlsGroupId fresh from the store.
    seedStores('saved'); // toggle will enable OTR
    establishChannel.mockResolvedValue('grp-otr-xyz');
    const onSendDMMessage = vi.fn();
    render(<DMView {...baseProps} onSendDMMessage={onSendDMMessage} />);

    await act(async () => {
      await (chatAreaProps.current!.onToggleOffTheRecord as () => Promise<void>)();
    });

    expect(establishChannel).toHaveBeenCalledWith(CHANNEL_ID, OTHER.id, null, 'otr');
    const ch = useDmStore.getState().dmChannels.find((c) => c.id === CHANNEL_ID);
    expect(ch?.otrMlsGroupId).toBe('grp-otr-xyz');
  });

  it('uses the bare channel id (no #otr) on the Saved tier', () => {
    seedStores('saved');
    const onSendDMMessage = vi.fn();
    render(<DMView {...baseProps} onSendDMMessage={onSendDMMessage} />);

    expect(screen.getByTestId('channel-id').textContent).toBe(CHANNEL_ID);
    expect(screen.getByTestId('otr-active').textContent).toBe('false');

    fireEvent.click(screen.getByTestId('send-btn'));
    expect(onSendDMMessage).toHaveBeenCalledWith(CHANNEL_ID, 'hello', undefined, undefined, 'saved');
  });
});
