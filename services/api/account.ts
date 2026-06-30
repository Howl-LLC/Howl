// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import { API_BASE_URL } from '../../config';
import type { SessionInfo, FamilyLinkInfo, FamilyRestrictions, FamilyActivity } from '../apiTypes';
import { getProtocolHeaders } from './protocolHeaders';

declare module './core' {
  interface APIClient {
    changeDiscriminator(discriminator: string): Promise<{ discriminator: string; changed: boolean; error?: string; suggestions?: string[] }>;
    changePassword(currentPassword: string | undefined, newPassword: string): Promise<{ success: boolean }>;
    changeEmail(currentPassword: string, newEmail: string, mfaCode?: string): Promise<{ success: boolean; requiresVerification?: boolean; mfaRequired?: boolean; email?: string }>;
    confirmEmailChange(code: string): Promise<{ success: boolean; email: string }>;
    deleteAccount(password: string): Promise<{ success: boolean }>;
    deactivateAccount(password: string): Promise<{ success: boolean }>;
    exportMyData(password: string): Promise<Blob>;
    requestDataExport(password: string): Promise<{ requestId: string; message: string }>;
    getExportStatus(): Promise<{
      hasRequest: boolean;
      requestId?: string;
      status?: string;
      createdAt?: string;
      expiresAt?: string;
      error?: string;
      downloadToken?: string;
      nextAvailableAt?: string;
    }>;
    getSessions(): Promise<SessionInfo[]>;
    revokeSession(sessionId: string): Promise<{ success: boolean }>;
    revokeAllOtherSessions(): Promise<{ success: boolean }>;
    getFamilyLinks(): Promise<FamilyLinkInfo[]>;
    createFamilyLink(childUsername: string, childDiscriminator: string): Promise<FamilyLinkInfo>;
    acceptFamilyLink(linkId: string): Promise<{ id: string; status: string }>;
    revokeFamilyLink(linkId: string): Promise<{ success: boolean }>;
    requestFamilyUnlink(linkId: string): Promise<{ id: string; unlinkRequestedAt: string | null }>;
    approveFamilyUnlink(linkId: string): Promise<{ success: boolean }>;
    denyFamilyUnlink(linkId: string): Promise<{ id: string; unlinkRequestedAt: null }>;
    updateFamilyRestrictions(linkId: string, restrictions: Partial<FamilyRestrictions>): Promise<FamilyRestrictions>;
    getFamilyActivity(linkId: string): Promise<FamilyActivity>;
  }
}

APIClient.prototype.changeDiscriminator = async function(this: APIClient, discriminator: string): Promise<{ discriminator: string; changed: boolean; error?: string; suggestions?: string[] }> {
  return this.request('/auth/me/discriminator', { method: 'POST', body: JSON.stringify({ discriminator }) });
};

APIClient.prototype.changePassword = async function(this: APIClient, currentPassword: string | undefined, newPassword: string): Promise<{ success: boolean }> {
  return this.request('/auth/me/password', { method: 'PATCH', body: JSON.stringify({ currentPassword, newPassword }) });
};

APIClient.prototype.changeEmail = async function(this: APIClient, currentPassword: string, newEmail: string, mfaCode?: string): Promise<{ success: boolean; requiresVerification?: boolean; mfaRequired?: boolean; email?: string }> {
  return this.request('/auth/me/email', { method: 'PATCH', body: JSON.stringify({ currentPassword, newEmail, ...(mfaCode && { mfaCode }) }) });
};

APIClient.prototype.confirmEmailChange = async function(this: APIClient, code: string): Promise<{ success: boolean; email: string }> {
  return this.request('/auth/me/email/verify', { method: 'POST', body: JSON.stringify({ code }) });
};

APIClient.prototype.deleteAccount = async function(this: APIClient, password: string): Promise<{ success: boolean }> {
  return this.request('/gdpr/delete', { method: 'POST', body: JSON.stringify({ password }) });
};

APIClient.prototype.deactivateAccount = async function(this: APIClient, password: string): Promise<{ success: boolean }> {
  return this.request('/gdpr/deactivate', { method: 'POST', body: JSON.stringify({ password }) });
};

APIClient.prototype.exportMyData = async function(this: APIClient, password: string): Promise<Blob> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...await getProtocolHeaders(),
  };
  const token = this.getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API_BASE_URL}/gdpr/export`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(data.error || 'Export failed');
  }
  return res.blob();
};

APIClient.prototype.requestDataExport = async function(this: APIClient, password: string): Promise<{ requestId: string; message: string }> {
  return this.request('/gdpr/request-export', {
    method: 'POST',
    body: JSON.stringify({ password }),
  });
};

APIClient.prototype.getExportStatus = async function(this: APIClient) {
  return this.request('/gdpr/export-status');
};

APIClient.prototype.getSessions = async function(this: APIClient): Promise<SessionInfo[]> {
  return this.request('/sessions');
};

APIClient.prototype.revokeSession = async function(this: APIClient, sessionId: string): Promise<{ success: boolean }> {
  return this.request(`/sessions/${sessionId}`, { method: 'DELETE' });
};

APIClient.prototype.revokeAllOtherSessions = async function(this: APIClient): Promise<{ success: boolean }> {
  return this.request('/sessions', { method: 'DELETE' });
};

APIClient.prototype.getFamilyLinks = async function(this: APIClient): Promise<FamilyLinkInfo[]> {
  return this.request('/family/links');
};

APIClient.prototype.createFamilyLink = async function(this: APIClient, childUsername: string, childDiscriminator: string): Promise<FamilyLinkInfo> {
  return this.request('/family/links', { method: 'POST', body: JSON.stringify({ childUsername, childDiscriminator }) });
};

APIClient.prototype.acceptFamilyLink = async function(this: APIClient, linkId: string): Promise<{ id: string; status: string }> {
  return this.request(`/family/links/${linkId}/accept`, { method: 'PATCH' });
};

APIClient.prototype.revokeFamilyLink = async function(this: APIClient, linkId: string): Promise<{ success: boolean }> {
  return this.request(`/family/links/${linkId}/revoke`, { method: 'PATCH' });
};

APIClient.prototype.requestFamilyUnlink = async function(this: APIClient, linkId: string): Promise<{ id: string; unlinkRequestedAt: string | null }> {
  return this.request(`/family/links/${linkId}/request-unlink`, { method: 'PATCH' });
};

APIClient.prototype.approveFamilyUnlink = async function(this: APIClient, linkId: string): Promise<{ success: boolean }> {
  return this.request(`/family/links/${linkId}/approve-unlink`, { method: 'PATCH' });
};

APIClient.prototype.denyFamilyUnlink = async function(this: APIClient, linkId: string): Promise<{ id: string; unlinkRequestedAt: null }> {
  return this.request(`/family/links/${linkId}/deny-unlink`, { method: 'PATCH' });
};

APIClient.prototype.updateFamilyRestrictions = async function(this: APIClient, linkId: string, restrictions: Partial<FamilyRestrictions>): Promise<FamilyRestrictions> {
  return this.request(`/family/links/${linkId}/restrictions`, { method: 'PATCH', body: JSON.stringify(restrictions) });
};

APIClient.prototype.getFamilyActivity = async function(this: APIClient, linkId: string): Promise<FamilyActivity> {
  return this.request(`/family/links/${linkId}/activity`);
};
