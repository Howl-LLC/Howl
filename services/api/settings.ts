// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

declare module './core' {
  interface APIClient {
    getSettings(): Promise<{ data: Record<string, unknown> | null; updatedAt: string | null }>;
    saveSettings(data: Record<string, unknown>): Promise<{ updatedAt: string }>;
  }
}

APIClient.prototype.getSettings = async function(this: APIClient) {
  return this.request('/settings');
};

APIClient.prototype.saveSettings = async function(this: APIClient, data: Record<string, unknown>) {
  return this.request('/settings', {
    method: 'PUT',
    body: JSON.stringify({ data }),
  });
};
