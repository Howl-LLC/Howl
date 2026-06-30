// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * API client for the Self Roles feature.
 *
 * One-picker-per-server: rolePickersList returns a single picker (or null).
 * The list endpoint name is kept for symmetry with the URL `/role-pickers`.
 */

import { APIClient } from './core';

export interface ConditionRequirements {
  accountAgeDays?: number;
  tenureDays?: number;
  hasRoleIds?: string[];
  excludeRoleIds?: string[];
  messageCount?: number;
  manualApproval?: boolean;
}

export type ConditionFailure =
  | { kind: 'accountAge'; current: number; required: number }
  | { kind: 'tenure'; current: number; required: number }
  | { kind: 'hasRole'; missing: string[] }
  | { kind: 'excludedRole'; present: string[] }
  | { kind: 'messageCount'; current: number; required: number }
  | { kind: 'manualApproval' };

export interface RolePickerSummary {
  id: string;
  channelId: string;
  serverId: string;
  heroTitle: string | null;
  heroDescription: string | null;
  _count?: { categories: number };
}

export interface RolePickerEntry {
  id: string;
  roleId: string;
  position: number;
  emoji: string | null;
  iconUrl: string | null;
  description: string | null;
  requirements: ConditionRequirements | null;
  memberCount: number;
  held: boolean;
  pending: boolean;
  role: { id: string; name: string; color: string; position: number; selfAssignable: boolean; displaySeparately: boolean; locked: boolean };
}

export interface RolePickerCategory {
  id: string;
  name: string;
  position: number;
  pickMode: 'single' | 'multi';
  /** When true, members must pick at least one role from this category during onboarding. */
  required: boolean;
  entries: RolePickerEntry[];
}

export interface RolePickerTree {
  id: string;
  channelId: string;
  serverId: string;
  heroTitle: string | null;
  heroDescription: string | null;
  selfRolesBlocked: boolean;
  categories: RolePickerCategory[];
}

export interface RoleClaimRequestRow {
  id: string;
  serverId: string;
  applicant: { id: string; username: string; discriminator?: string; avatar: string | null };
  roleId: string;
  role: { id: string; name: string; color: string } | null;
  category: { id: string; name: string } | null;
  entryEmoji: string | null;
  entryDescription: string | null;
  applicantMessage: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'withdrawn';
  decisionNote: string | null;
  decidedBy: { id: string; username: string; discriminator?: string; avatar: string | null } | null;
  createdAt: string;
  decidedAt: string | null;
}

declare module './core' {
  interface APIClient {
    rolePickersList(serverId: string): Promise<{ picker: RolePickerSummary | null }>;
    rolePickerGet(serverId: string, pickerId: string): Promise<RolePickerTree>;
    rolePickerUpdate(serverId: string, pickerId: string, data: { heroTitle?: string | null; heroDescription?: string | null }): Promise<RolePickerSummary>;
    rolePickerCategoryCreate(serverId: string, pickerId: string, data: { name: string; pickMode?: 'single' | 'multi'; required?: boolean }): Promise<RolePickerCategory>;
    rolePickerCategoryUpdate(serverId: string, pickerId: string, catId: string, data: { name?: string; pickMode?: 'single' | 'multi'; position?: number; required?: boolean }): Promise<{ ok: true }>;
    rolePickerCategoryDelete(serverId: string, pickerId: string, catId: string): Promise<{ ok: true }>;
    rolePickerEntryCreate(serverId: string, pickerId: string, catId: string, data: { roleId: string; emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null }): Promise<RolePickerEntry>;
    rolePickerEntryUpdate(serverId: string, pickerId: string, entryId: string, data: { emoji?: string | null; iconUrl?: string | null; description?: string | null; requirements?: ConditionRequirements | null }): Promise<RolePickerEntry>;
    rolePickerEntryMove(serverId: string, pickerId: string, entryId: string, data: { categoryId?: string; position: number }): Promise<{ ok: true }>;
    rolePickerEntryDelete(serverId: string, pickerId: string, entryId: string): Promise<{ ok: true }>;
    rolePickerEntryClaim(serverId: string, pickerId: string, entryId: string): Promise<{ ok: true; status: 'granted' | 'already_held' | 'pending_approval'; requestId?: string }>;
    rolePickerEntryRelease(serverId: string, pickerId: string, entryId: string): Promise<{ ok: true; removed: number }>;
    rolePickerEntryRequest(serverId: string, pickerId: string, entryId: string, data?: { applicantMessage?: string }): Promise<{ id: string }>;
    rolePickerRequestWithdraw(serverId: string, pickerId: string, requestId: string): Promise<{ ok: true }>;
    roleClaimRequestsList(serverId: string, opts?: { status?: 'pending' | 'approved' | 'rejected' | 'withdrawn'; cursor?: string; limit?: number }): Promise<{ requests: RoleClaimRequestRow[]; nextCursor: string | null }>;
    roleClaimRequestDecide(serverId: string, requestId: string, data: { decision: 'approve' | 'reject'; decisionNote?: string }): Promise<{ ok: true; status: 'approved' | 'rejected' }>;
  }
}

const enc = (s: string) => encodeURIComponent(s);

APIClient.prototype.rolePickersList = async function(this: APIClient, serverId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers`);
};
APIClient.prototype.rolePickerGet = async function(this: APIClient, serverId, pickerId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}`);
};
APIClient.prototype.rolePickerUpdate = async function(this: APIClient, serverId, pickerId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}`, {
    method: 'PATCH', body: JSON.stringify(data),
  });
};
APIClient.prototype.rolePickerCategoryCreate = async function(this: APIClient, serverId, pickerId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/categories`, {
    method: 'POST', body: JSON.stringify(data),
  });
};
APIClient.prototype.rolePickerCategoryUpdate = async function(this: APIClient, serverId, pickerId, catId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/categories/${enc(catId)}`, {
    method: 'PATCH', body: JSON.stringify(data),
  });
};
APIClient.prototype.rolePickerCategoryDelete = async function(this: APIClient, serverId, pickerId, catId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/categories/${enc(catId)}`, {
    method: 'DELETE',
  });
};
APIClient.prototype.rolePickerEntryCreate = async function(this: APIClient, serverId, pickerId, catId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/categories/${enc(catId)}/entries`, {
    method: 'POST', body: JSON.stringify(data),
  });
};
APIClient.prototype.rolePickerEntryUpdate = async function(this: APIClient, serverId, pickerId, entryId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/entries/${enc(entryId)}`, {
    method: 'PATCH', body: JSON.stringify(data),
  });
};
APIClient.prototype.rolePickerEntryMove = async function(this: APIClient, serverId, pickerId, entryId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/entries/${enc(entryId)}/move`, {
    method: 'PATCH', body: JSON.stringify(data),
  });
};
APIClient.prototype.rolePickerEntryDelete = async function(this: APIClient, serverId, pickerId, entryId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/entries/${enc(entryId)}`, {
    method: 'DELETE',
  });
};
APIClient.prototype.rolePickerEntryClaim = async function(this: APIClient, serverId, pickerId, entryId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/entries/${enc(entryId)}/claim`, {
    method: 'POST',
  });
};
APIClient.prototype.rolePickerEntryRelease = async function(this: APIClient, serverId, pickerId, entryId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/entries/${enc(entryId)}/claim`, {
    method: 'DELETE',
  });
};
APIClient.prototype.rolePickerEntryRequest = async function(this: APIClient, serverId, pickerId, entryId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/entries/${enc(entryId)}/request`, {
    method: 'POST', body: JSON.stringify(data ?? {}),
  });
};
APIClient.prototype.rolePickerRequestWithdraw = async function(this: APIClient, serverId, pickerId, requestId) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/${enc(pickerId)}/requests/me/${enc(requestId)}`, {
    method: 'DELETE',
  });
};
APIClient.prototype.roleClaimRequestsList = async function(this: APIClient, serverId, opts) {
  const params = new URLSearchParams();
  if (opts?.status) params.set('status', opts.status);
  if (opts?.cursor) params.set('cursor', opts.cursor);
  if (opts?.limit !== undefined) params.set('limit', String(opts.limit));
  const q = params.toString() ? `?${params.toString()}` : '';
  return this.request(`/servers/${enc(serverId)}/role-pickers/requests/list${q}`);
};
APIClient.prototype.roleClaimRequestDecide = async function(this: APIClient, serverId, requestId, data) {
  return this.request(`/servers/${enc(serverId)}/role-pickers/requests/${enc(requestId)}/decide`, {
    method: 'PATCH', body: JSON.stringify(data),
  });
};
