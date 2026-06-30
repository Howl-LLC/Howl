// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Frontend permission helper.
//
// The backend already computes `myPermissions` as the union across all the
// current user's roles ∪ @everyone, so the client check is just a lookup on
// that object (plus owner/administrator shortcut).
//
// Usage:
//   hasPermission(server, 'manageRoles')  // true/false
//
// Keeps a single source of truth on the frontend so UI gating doesn't drift
// from server-side enforcement.

type ServerLike = {
  myRole?: string;
  myPermissions?: Record<string, boolean>;
};

export function hasPermission(server: ServerLike | null | undefined, permission: string): boolean {
  if (!server) return false;
  if (server.myRole?.toLowerCase() === 'owner') return true;
  const p = server.myPermissions ?? {};
  if (p.administrator === true) return true;
  return p[permission] === true;
}
