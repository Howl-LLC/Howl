// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { CrescentCanvas } from '../components/launcher/CrescentCanvas';
import { useServerStore } from '../stores/serverStore';
import { useServerFolderStore } from '../stores/serverFolderStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useAuthStore } from '../stores/authStore';
import type { Server } from '../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d || k }) }));

const mk = (id: string, name: string): Server => ({ id, name, icon: null, channels: [] } as unknown as Server);

function seedStores() {
  useServerStore.setState({ servers: [mk('a', 'A'), mk('b', 'B'), mk('c', 'C')] } as never);
  useServerFolderStore.setState({ folders: [], loaded: true } as never);
  useNavigationStore.setState({ activeServerId: 'home' } as never);
  useNotificationStore.setState({
    serverMentionCounts: {}, serverUnreadIds: new Set<string>(),
    unreadDmChannelIds: new Set<string>(), dmUnreadCounts: {},
    pendingFriendRequestCount: 0, notificationCounts: { total: 0, byServer: {} },
  } as never);
  useAuthStore.setState({ currentUserStatus: 'online' } as never);
}

// Adversarial persisted layouts (the kind accumulated across deploys) that must
// NOT crash the Navigator. The storage loader normalizes on read, and the
// validPos guards + stale-item pruning in CrescentCanvas catch the rest.
const BLOBS: Record<string, unknown> = {
  staleServerInSection: {
    version: 1, snap: false, howlSeeded: true, positions: { a: { x: 100, y: 100 } },
    sections: [
      { id: '__howl__', title: 'howl', x: 1446, y: 870, w: 326, h: 191, oc: '#102C49', fc: '#000000', expanded: false, items: ['home', 'friends', 'account', 'dm', 'discover', 'notifications'] },
      { id: 'old1', title: 'Old', x: 1450, y: 1300, w: 200, h: 150, oc: '#076FA0', fc: '#06141c', expanded: false, items: ['DELETED_1', 'DELETED_2', 'b'] },
    ],
  },
  malformedPositions: {
    version: 1, snap: false, howlSeeded: true,
    positions: { a: { x: 100, y: 100 }, BROKEN1: {}, BROKEN2: { x: 5 }, BROKEN3: null },
    sections: [{ id: '__howl__', title: 'howl', x: 1446, y: 870, w: 326, h: 191, oc: '#102C49', fc: '#000000', expanded: false, items: ['home', 'friends'] }],
  },
  legacyNoHowlFields: {
    positions: { a: { x: 100, y: 100 }, GONE: { x: 200, y: 100 } },
    sections: [{ id: 'f1', title: 'Folder', x: 1450, y: 1080, w: 200, h: 150, oc: 'rgba(255,255,255,0.85)', fc: '#000000', expanded: true, items: ['c', 'ALSO_GONE'] }],
  },
};

describe('Navigator resilience to stale/malformed persisted layouts', () => {
  beforeEach(() => { localStorage.clear(); });

  for (const [name, blob] of Object.entries(BLOBS)) {
    it(`renders without throwing: ${name}`, () => {
      localStorage.setItem('howl_navigator_layout', JSON.stringify(blob));
      seedStores();
      expect(() => {
        const { unmount } = render(<CrescentCanvas open onNavigate={() => {}} onAddServer={() => {}} onClose={() => {}} />);
        unmount();
      }).not.toThrow();
    });
  }
});
