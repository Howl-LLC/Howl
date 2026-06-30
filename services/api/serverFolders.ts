// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';

export interface ServerFolder {
  id: string;
  userId: string;
  name: string;
  color: string | null;
  serverIds: string[];
  position: number;
  muted: boolean;
  createdAt: string;
  updatedAt: string;
}

declare module './core' {
  interface APIClient {
    getServerFolders(): Promise<ServerFolder[]>;
    createServerFolder(data: { name: string; color?: string; serverIds?: string[] }): Promise<ServerFolder>;
    updateServerFolder(id: string, data: { name?: string; color?: string | null; serverIds?: string[]; muted?: boolean }): Promise<ServerFolder>;
    deleteServerFolder(id: string): Promise<{ success: boolean }>;
    reorderServerFolders(folderIds: string[]): Promise<{ success: boolean }>;
    importServerFolders(folders: Array<{ name: string; color?: string; serverIds: string[]; muted?: boolean }>): Promise<ServerFolder[]>;
  }
}

APIClient.prototype.getServerFolders = async function(this: APIClient) {
  return this.request('/server-folders');
};

APIClient.prototype.createServerFolder = async function(this: APIClient, data) {
  return this.request('/server-folders', {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.updateServerFolder = async function(this: APIClient, id, data) {
  return this.request(`/server-folders/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteServerFolder = async function(this: APIClient, id) {
  return this.request(`/server-folders/${id}`, {
    method: 'DELETE',
  });
};

APIClient.prototype.reorderServerFolders = async function(this: APIClient, folderIds) {
  return this.request('/server-folders/reorder', {
    method: 'PUT',
    body: JSON.stringify({ folderIds }),
  });
};

APIClient.prototype.importServerFolders = async function(this: APIClient, folders) {
  return this.request('/server-folders/import', {
    method: 'POST',
    body: JSON.stringify({ folders }),
  });
};
