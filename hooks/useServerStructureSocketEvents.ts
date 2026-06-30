// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { Channel } from '../types';
import { socketService } from '../services/socket';
import { apiClient } from '../services/api';
import { useServerStore } from '../stores/serverStore';
import { deferStoreUpdate } from '../utils/storeHelpers';


/**
 * Registers socket events for server structure CRUD:
 * - category-created / category-updated / category-deleted / categories-reordered
 * - channel-created / channel-updated-meta / channel-deleted / channels-reordered
 * - channel-permissions-updated / category-permissions-updated
 *
 * Writes directly to useServerStore. AppLayout / Sidebar / ChannelList all
 * subscribe to the store, so the UI re-renders the moment a socket event
 * lands — no more "rename a channel and it vanishes until refresh".
 */
export function useServerStructureSocketEvents(): void {
  useEffect(() => {
    socketService.onCategoryCreated(({ serverId, category }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => {
          const existing = s.categories ?? [];
          if (existing.some((c: any) => c.id === category.id)) return s;
          return { ...s, categories: [...existing, category].sort((a: any, b: any) => a.position - b.position) };
        });
      });
    });

    socketService.onCategoryUpdated(({ serverId, category }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => ({
          ...s,
          categories: (s.categories ?? []).map((c: any) => c.id === category.id ? category : c).sort((a: any, b: any) => a.position - b.position),
        }));
      });
    });

    socketService.onCategoryDeleted(({ serverId, categoryId }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => ({
          ...s,
          categories: (s.categories ?? []).filter((c: any) => c.id !== categoryId),
          channels: s.channels.map((ch: Channel) => ch.categoryId === categoryId ? { ...ch, categoryId: null } : ch),
        }));
      });
    });

    socketService.onChannelsReordered(({ serverId, channels }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => {
          const updates = new Map(channels.map((c: any) => [c.id, c]));
          return {
            ...s,
            channels: s.channels.map((ch: Channel) => {
              const update = updates.get(ch.id);
              if (!update) return ch;
              return { ...ch, position: update.position, categoryId: update.categoryId };
            }).sort((a: Channel, b: Channel) => (a.position ?? 0) - (b.position ?? 0)),
          };
        });
      });
    });

    socketService.onCategoriesReordered(({ serverId, categories }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => {
          const updates = new Map(categories.map((c: any) => [c.id, c]));
          return {
            ...s,
            categories: (s.categories ?? []).map((cat: any) => {
              const update = updates.get(cat.id);
              if (!update) return cat;
              return { ...cat, position: update.position };
            }).sort((a: any, b: any) => a.position - b.position),
          };
        });
      });
    });

    socketService.onChannelCreated(({ serverId, channel }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => {
          if (s.channels.some((c: Channel) => c.id === channel.id)) return s;
          const newChannel: Channel = {
            id: channel.id,
            name: channel.name,
            description: channel.description ?? undefined,
            type: (channel.type ?? 'text') as Channel['type'],
            categoryId: channel.categoryId ?? null,
            position: channel.position ?? 0,
            isPrivate: (channel as any).isPrivate ?? false,
          };
          return { ...s, channels: [...s.channels, newChannel].sort((a: Channel, b: Channel) => a.position - b.position) };
        });
      });
    });

    socketService.onChannelUpdatedMeta(({ serverId, channel }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => ({
          ...s,
          channels: s.channels.map((ch: Channel) => {
            if (ch.id !== channel.id) return ch;
            return {
              ...ch,
              ...channel,
              description: channel.description ?? undefined,
              type: (channel.type ?? ch.type) as Channel['type'],
              categoryId: channel.categoryId ?? null,
              position: channel.position ?? 0,
            };
          }),
        }));
      });
    });

    socketService.onChannelDeleted(({ serverId, channelId }) => {
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(serverId, (s: any) => ({
          ...s,
          channels: s.channels.filter((ch: Channel) => ch.id !== channelId),
        }));
      });
    });

    socketService.onChannelPermissionsUpdated(({ serverId: _sid }: { serverId: string }) => {
      apiClient.invalidateCache('servers');
      apiClient.getServers().then((servers) => {
        deferStoreUpdate(() => useServerStore.getState().setServers(servers));
      }).catch(() => {});
    });

    socketService.onCategoryPermissionsUpdated(({ serverId: _sid }: { serverId: string }) => {
      apiClient.invalidateCache('servers');
      apiClient.getServers().then((servers) => {
        deferStoreUpdate(() => useServerStore.getState().setServers(servers));
      }).catch(() => {});
    });

    return () => {
      socketService.offCategoryCreated();
      socketService.offCategoryUpdated();
      socketService.offCategoryDeleted();
      socketService.offChannelsReordered();
      socketService.offCategoriesReordered();
      socketService.offChannelCreated();
      socketService.offChannelUpdatedMeta();
      socketService.offChannelDeleted();
      socketService.offChannelPermissionsUpdated();
      socketService.offCategoryPermissionsUpdated();
    };
  }, []);
}
