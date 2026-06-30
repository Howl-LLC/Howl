// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Channel-level permission resolution now lives in ./permissions.ts alongside
// the server-level helpers. This file is a thin re-export shim for existing
// imports. New code should import from './permissions.js' directly.

export {
  hasChannelPermission,
  canViewChannel,
  loadPermissionContext,
  hasPermission,
  memberHasPermission,
  unionPerms,
  computeMyPermissions,
  pickDisplayRole,
  ALL_PERMISSIONS_GRANTED,
} from './permissions.js';
export type {
  PermissionContext,
  LoadedPermissionContext,
  RoleLike,
  MemberLike,
  PermissionOverride,
} from './permissions.js';
