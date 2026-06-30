// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { useNotificationStore } from '../stores/notificationStore';

describe('notificationStore — OTR DM unread (parallel to Saved)', () => {
  beforeEach(() => {
    useNotificationStore.setState({
      dmUnreadCounts: {}, unreadDmChannelIds: new Set(),
      otrDmUnreadCounts: {}, otrUnreadDmChannelIds: new Set(),
    });
  });

  it('incrementOtrDmUnread bumps the OTR count without touching Saved counts', () => {
    useNotificationStore.getState().incrementOtrDmUnread('dm1');
    useNotificationStore.getState().incrementOtrDmUnread('dm1');
    expect(useNotificationStore.getState().otrDmUnreadCounts.dm1).toBe(2);
    expect(useNotificationStore.getState().dmUnreadCounts.dm1).toBeUndefined();
  });

  it('clearOtrDmUnread removes the OTR count key', () => {
    useNotificationStore.getState().incrementOtrDmUnread('dm1');
    useNotificationStore.getState().clearOtrDmUnread('dm1');
    expect(useNotificationStore.getState().otrDmUnreadCounts.dm1).toBeUndefined();
  });

  it('addOtrUnreadDmChannel adds to the OTR set, not the Saved set', () => {
    useNotificationStore.getState().addOtrUnreadDmChannel('dm1');
    expect(useNotificationStore.getState().otrUnreadDmChannelIds.has('dm1')).toBe(true);
    expect(useNotificationStore.getState().unreadDmChannelIds.has('dm1')).toBe(false);
  });

  it('removeOtrUnreadDmChannel removes from the OTR set', () => {
    useNotificationStore.getState().addOtrUnreadDmChannel('dm1');
    useNotificationStore.getState().removeOtrUnreadDmChannel('dm1');
    expect(useNotificationStore.getState().otrUnreadDmChannelIds.has('dm1')).toBe(false);
  });

  it('removeOtrUnreadDmChannel preserves referential equality when absent', () => {
    const before = useNotificationStore.getState().otrUnreadDmChannelIds;
    useNotificationStore.getState().removeOtrUnreadDmChannel('absent');
    expect(useNotificationStore.getState().otrUnreadDmChannelIds).toBe(before);
  });

  it('_setAll hydrates the OTR unread fields', () => {
    const ids = new Set(['dm9']);
    useNotificationStore.getState()._setAll({ otrUnreadDmChannelIds: ids, otrDmUnreadCounts: { dm9: 3 } });
    expect(useNotificationStore.getState().otrUnreadDmChannelIds).toBe(ids);
    expect(useNotificationStore.getState().otrDmUnreadCounts.dm9).toBe(3);
  });
});
