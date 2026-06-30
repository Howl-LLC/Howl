// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import { socketService } from '../services/socket';

/**
 * Global socket subscriber for the Self Roles feature.
 *
 * The events themselves (`role-picker-updated`, `role-claim-request-updated`)
 * are consumed component-side by the picker view, the admin tab, and the
 * approvals queue. This hook only exists to mount once per session so the
 * raw socket connection has the right `on` handlers attached early; the
 * components subscribe additionally via `socketService.getSocket().on(...)`
 * inside their own effects (mirrors how InvitesSection / ChannelsSection
 * approach refresh-on-co-admin-change).
 *
 * If we ever centralize a store-side cache for picker trees, this is where
 * the invalidation/refetch dispatch would live.
 */
export function useRolePickerSocketEvents(): void {
  useEffect(() => {
    const sock = socketService.getSocket();
    if (!sock) return;
    // No-op handlers — components own their own refetch logic. Registering
    // here just guarantees the events are not buffered/dropped during the
    // brief gap between socket connect and first component mount.
    const noop = () => {};
    sock.on('role-picker-updated', noop);
    sock.on('role-claim-request-updated', noop);
    return () => {
      sock.off('role-picker-updated', noop);
      sock.off('role-claim-request-updated', noop);
    };
  }, []);
}
