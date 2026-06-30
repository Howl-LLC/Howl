// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import { API_BASE_URL } from '../../config';
import { getProtocolHeaders } from './protocolHeaders';

declare module './core' {
  interface APIClient {
    uploadFile(file: File): Promise<{ url: string; name: string; contentType: string; size: number; width?: number | null; height?: number | null }>;
    uploadEncryptedFile(encryptedBlob: Blob, originalName: string, dmChannelId: string): Promise<{ url: string; name: string; contentType: string; size: number }>;
    importDiscordHistory(serverId: string, file: File): Promise<{ channelName: string; channelId: string; messagesImported: number; channelCreated: boolean }>;
    reportMessage(data: {
      messageId: string;
      messageType: 'dm' | 'channel';
      channelId?: string;
      dmChannelId?: string;
      reason: 'spam' | 'harassment' | 'csam' | 'violence' | 'other';
      details?: string;
      plaintext?: string;
    }): Promise<{ id: string; status: string }>;
  }
}

/** Upload a file (max 50MB). Returns { url, name, contentType, size } for use in sendChannelMessage/sendDMMessage. */
APIClient.prototype.uploadFile = async function(this: APIClient, file: File): Promise<{ url: string; name: string; contentType: string; size: number; width?: number | null; height?: number | null }> {
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds the maximum upload size of 50 MB.');
  }
  const formData = new FormData();
  formData.append('file', file);
  const token = this.getToken();
  const headers: Record<string, string> = { ...await getProtocolHeaders() };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}/upload`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `Upload failed: ${res.status}`;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      message = 'Upload failed. Please try again.';
    }
    throw new Error(message);
  }
  return res.json();
};

APIClient.prototype.uploadEncryptedFile = async function(this: APIClient, encryptedBlob: Blob, originalName: string, dmChannelId: string): Promise<{ url: string; name: string; contentType: string; size: number }> {
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB
  if (encryptedBlob.size > MAX_UPLOAD_BYTES) {
    throw new Error('File exceeds the maximum upload size of 50 MB.');
  }
  const formData = new FormData();
  formData.append('file', encryptedBlob, originalName);
  const token = this.getToken();
  const headers: Record<string, string> = { ...await getProtocolHeaders() };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  // An encrypted upload skips all server-side content safety, so
  // the server only accepts it bound to a DM the caller is in. Declare the DM
  // context explicitly (source=dm + sourceId) so the upload is authorized and gets
  // an encrypted-provenance row; the server rejects encrypted=true otherwise.
  const res = await fetch(`${API_BASE_URL}/upload?encrypted=true&source=dm&sourceId=${encodeURIComponent(dmChannelId)}`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `Upload failed: ${res.status}`;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      message = 'Upload failed. Please try again.';
    }
    throw new Error(message);
  }
  return res.json();
};

APIClient.prototype.importDiscordHistory = async function(this: APIClient, serverId: string, file: File): Promise<{ channelName: string; channelId: string; messagesImported: number; channelCreated: boolean }> {
  const formData = new FormData();
  formData.append('file', file);
  const token = this.getToken();
  const headers: Record<string, string> = { ...await getProtocolHeaders() };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}/servers/${encodeURIComponent(serverId)}/import-discord`, {
    method: 'POST',
    headers,
    credentials: 'include',
    body: formData,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let message = `Import failed: ${res.status}`;
    try {
      const body = text ? JSON.parse(text) : null;
      if (body && typeof body.error === 'string') message = body.error;
    } catch {
      message = 'Import failed. Please try again.';
    }
    throw new Error(message);
  }
  return res.json();
};

APIClient.prototype.reportMessage = async function(this: APIClient, data: {
  messageId: string;
  messageType: 'dm' | 'channel';
  channelId?: string;
  dmChannelId?: string;
  reason: 'spam' | 'harassment' | 'csam' | 'violence' | 'other';
  details?: string;
  plaintext?: string;
}): Promise<{ id: string; status: string }> {
  return this.request('/reports', { method: 'POST', body: JSON.stringify(data) });
};
