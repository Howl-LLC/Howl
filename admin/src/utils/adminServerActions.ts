// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { adminApi } from '../api';

export type AdminServerActionKind =
  | 'feature' | 'unfeature'
  | 'verify' | 'unverify'
  | 'hide' | 'unhide'
  | 'suspend' | 'unsuspend'
  | 'grantDiscoveryOverride' | 'revokeDiscoveryOverride';

export const ADMIN_SERVER_ACTION_LABEL: Record<AdminServerActionKind, string> = {
  feature: 'Feature',
  unfeature: 'Unfeature',
  verify: 'Verify',
  unverify: 'Unverify',
  hide: 'Hide from discovery',
  unhide: 'Restore to discovery',
  suspend: 'Suspend server',
  unsuspend: 'Unsuspend server',
  grantDiscoveryOverride: 'Grant discovery override',
  revokeDiscoveryOverride: 'Revoke discovery override',
};

/**
 * Whether the action requires a reason that gets recorded in the audit log.
 * Hide and Suspend are the only audit-required actions; the rest accept an
 * optional reason.
 */
export function adminServerActionRequiresReason(kind: AdminServerActionKind): boolean {
  return kind === 'suspend' || kind === 'hide';
}

/** Whether the action is destructive (uses red styling in the confirm modal). */
export function adminServerActionIsDestructive(kind: AdminServerActionKind): boolean {
  return kind === 'suspend' || kind === 'hide';
}

/**
 * Dispatches the appropriate `adminApi` call for a given action kind.
 * For required-reason actions (`hide`, `suspend`) the reason is non-nullable
 * — callers should validate before calling.
 */
export async function performAdminServerAction(
  serverId: string,
  kind: AdminServerActionKind,
  reason: string | undefined,
): Promise<{ success: boolean }> {
  const r = reason?.trim() || undefined;
  switch (kind) {
    case 'feature':    return adminApi.adminServerFeature(serverId, r);
    case 'unfeature':  return adminApi.adminServerUnfeature(serverId, r);
    case 'verify':     return adminApi.adminServerVerify(serverId, r);
    case 'unverify':   return adminApi.adminServerUnverify(serverId, r);
    case 'hide':       return adminApi.adminServerHide(serverId, reason ?? '');
    case 'unhide':     return adminApi.adminServerUnhide(serverId, r);
    case 'suspend':    return adminApi.adminServerSuspend(serverId, reason ?? '');
    case 'unsuspend':  return adminApi.adminServerUnsuspend(serverId, r);
    case 'grantDiscoveryOverride':  return adminApi.adminServerGrantDiscoveryOverride(serverId, r);
    case 'revokeDiscoveryOverride': return adminApi.adminServerRevokeDiscoveryOverride(serverId, r);
  }
}
