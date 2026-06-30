// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { ServerFolder } from '../services/api/serverFolders';

const EMPTY_FOLDERS: ServerFolder[] = [];

interface ServerFolderState {
  folders: ServerFolder[];
  loaded: boolean;

  setFolders(folders: ServerFolder[]): void;
  addFolder(folder: ServerFolder): void;
  updateFolder(id: string, data: Partial<ServerFolder>): void;
  removeFolder(id: string): void;
  reorderFolders(folderIds: string[]): void;

  /** Check if a server is inside a muted folder */
  isServerMuted(serverId: string): boolean;
  /** Get the folder a server belongs to (if any) */
  getFolderForServer(serverId: string): ServerFolder | undefined;
  /** Get server IDs not in any folder */
  getUncategorizedServerIds(allServerIds: string[]): string[];
}

export const useServerFolderStore = create<ServerFolderState>((set, get) => ({
  folders: EMPTY_FOLDERS,
  loaded: false,

  setFolders(folders) {
    set({ folders, loaded: true });
  },

  addFolder(folder) {
    set((state) => ({ folders: [...state.folders, folder] }));
  },

  updateFolder(id, data) {
    set((state) => ({
      folders: state.folders.map((f) => (f.id === id ? { ...f, ...data } : f)),
    }));
  },

  removeFolder(id) {
    set((state) => ({ folders: state.folders.filter((f) => f.id !== id) }));
  },

  reorderFolders(folderIds) {
    set((state) => {
      const map = new Map(state.folders.map((f) => [f.id, f]));
      const reordered = folderIds.map((id, i) => {
        const f = map.get(id);
        return f ? { ...f, position: i } : null;
      }).filter(Boolean) as ServerFolder[];
      const reorderedIds = new Set(folderIds);
      const remaining = state.folders.filter((f) => !reorderedIds.has(f.id));
      return { folders: [...reordered, ...remaining] };
    });
  },

  isServerMuted(serverId) {
    return get().folders.some((f) => f.muted && f.serverIds.includes(serverId));
  },

  getFolderForServer(serverId) {
    return get().folders.find((f) => f.serverIds.includes(serverId));
  },

  getUncategorizedServerIds(allServerIds) {
    const inFolder = new Set(get().folders.flatMap((f) => f.serverIds));
    return allServerIds.filter((id) => !inFolder.has(id));
  },
}));
