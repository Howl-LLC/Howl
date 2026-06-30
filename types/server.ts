// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export type ServerMemberRole = { id?: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean };

export type ServerMemberWithRole = {
  id: string;
  username: string;
  discriminator?: string;
  avatar?: string | null;
  status?: string;
  role?: string;
  tag?: string;
  memberSince?: string | Date;
  joinedPlatform?: string | Date;
  joinMethod?: string;
  roles?: ServerMemberRole[];
};

export type ServerInvite = { id: string; code: string; link: string; useCount: number; maxUses?: number; expiresAt?: string; temporary?: boolean; label?: string; shareable: boolean; createdAt: string; createdBy?: { id: string; username: string; discriminator: string; avatar: string | null } };

export type RoleStyle = 'solid' | 'gradient' | 'holographic';

export type LinkedRoleRequirement = { id: string; type: 'connection' | 'app'; label?: string };

export type ServerRole = {
  id: string;
  name: string;
  color: string;
  icon?: string;
  locked?: boolean;
  isEveryone?: boolean;
  position?: number;
  memberCount: number;
  style?: RoleStyle;
  displaySeparately?: boolean;
  allowMention?: boolean;
  selfAssignable?: boolean;
  hidden?: boolean;
  blocksSelfRoles?: boolean;
  permissions?: Record<string, boolean>;
  memberIds?: string[];
  linkedRoleRequirements?: LinkedRoleRequirement[];
};

export type ServerRoleFromAPI = {
  id: string; name: string; color: string; style: string; icon?: string; position: number; locked: boolean; isEveryone?: boolean;
  permissions: Record<string, boolean>; displaySeparately: boolean; allowMention: boolean; selfAssignable?: boolean; hidden?: boolean; blocksSelfRoles?: boolean;
  linkedRoleRequirements?: unknown[]; memberCount: number;
};

export function apiRoleToServerRole(r: ServerRoleFromAPI): ServerRole {
  return {
    id: r.id, name: r.name, color: r.color, style: (r.style as RoleStyle) || 'solid', icon: r.icon,
    locked: r.locked, isEveryone: r.isEveryone ?? false, position: r.position,
    memberCount: r.memberCount, permissions: r.permissions ?? {},
    displaySeparately: r.displaySeparately, allowMention: r.allowMention,
    selfAssignable: r.selfAssignable ?? false,
    hidden: r.hidden ?? false,
    blocksSelfRoles: r.blocksSelfRoles ?? false,
    linkedRoleRequirements: r.linkedRoleRequirements as ServerRole['linkedRoleRequirements'],
  };
}
