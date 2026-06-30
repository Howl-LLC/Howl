// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { User } from '../types';
import { socketService } from '../services/socket';
import { apiClient } from '../services/api';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useServerStore } from '../stores/serverStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useVoiceStore } from '../stores/voiceStore';
import { clearServerChannelListStorage } from '../components/ChannelList';
import { useServerFolderStore } from '../stores/serverFolderStore';

type ServerMember = User & { role?: string; roleColor?: string; roleStyle?: 'solid' | 'gradient' | 'holographic'; roles?: Array<{ id: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean }>; nickname?: string | null; serverAvatar?: string | null; serverBanner?: string | null };

export interface UseServerMemberSocketEventsOpts {
  currentUserId: string | undefined;
  joinedServerRoomsRef: MutableRefObject<Set<string>>;
  navigateHome: () => void;
  refetchServerMembers: () => void;
  showGlobalToast: (message: string, type?: 'info' | 'warning', duration?: number) => void;
}

/**
 * Registers server member and role socket events:
 * member joined/left/kicked, role updated, role created/updated/deleted,
 * and member profile updates (nickname, avatar, banner).
 */
export function useServerMemberSocketEvents(opts: UseServerMemberSocketEventsOpts): void {
  const {
    currentUserId,
    joinedServerRoomsRef,
    navigateHome,
    refetchServerMembers,
    showGlobalToast,
  } = opts;

  // Member profile updates (nickname, avatar, banner changes by other members)
  useEffect(() => {
    if (!currentUserId) return;
    socketService.onServerMemberProfileUpdated((payload) => {
      if (typeof payload?.serverId !== 'string' || !payload.serverId || typeof payload?.userId !== 'string' || !payload.userId) return;
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(
          serverMembers.map((m) =>
            m.id === payload.userId
              ? { ...m, nickname: payload.nickname, serverAvatar: payload.serverAvatar, serverBanner: payload.serverBanner }
              : m
          )
        );
      });
    });
    return () => { socketService.offServerMemberProfileUpdated(); };
  }, [currentUserId]);

  // Server member join/leave/kick and role real-time updates
  useEffect(() => {
    if (!currentUserId) return;

    socketService.onServerMemberJoined((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId || !data?.user?.id || typeof data.user.id !== 'string') return;
      if (useNavigationStore.getState().activeServerId !== data.serverId) return;
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        if (serverMembers.some((m) => m.id === data.user.id)) return;
        setServerMembers([...serverMembers, {
          id: data.user.id,
          username: data.user.username,
          discriminator: data.user.discriminator ?? '',
          avatar: data.user.avatar ?? null,
          status: (data.user.status ?? 'online') as User['status'],
          role: data.role,
          roleColor: data.roleColor,
        } as ServerMember]);
      });
    });

    socketService.onServerMemberLeft((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId || typeof data?.userId !== 'string' || !data.userId) return;
      if (useNavigationStore.getState().activeServerId !== data.serverId) return;

      // Show toast for kicks (not for self — self gets the server-kicked event)
      if (data.kicked && data.userId !== currentUserId) {
        const { serverMembers } = useServerStore.getState();
        const member = serverMembers.find((m) => m.id === data.userId);
        const displayName = member?.username ?? 'A member';
        showGlobalToast(`${displayName} was kicked from the server`, 'info', 5000);
      }

      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(serverMembers.filter((m) => m.id !== data.userId));
      });
    });

    socketService.onServerKicked((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId) return;
      deferStoreUpdate(() => {
        const channelIds = useServerStore.getState().servers.find(s => s.id === data.serverId)?.channels.map(c => c.id);
        useServerStore.getState().removeServer(data.serverId);
        useVoiceStore.getState().clearServerData(data.serverId, channelIds);
        clearServerChannelListStorage(data.serverId);
        {
          const folder = useServerFolderStore.getState().getFolderForServer(data.serverId);
          if (folder) {
            const newIds = folder.serverIds.filter(id => id !== data.serverId);
            useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
            apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {});
          }
        }
      });
      joinedServerRoomsRef.current.delete(data.serverId);
      if (useNavigationStore.getState().activeServerId === data.serverId) {
        navigateHome();
        showGlobalToast('You have been removed from this server', 'info', 5000);
      }
    });

    socketService.onServerBanned((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId) return;
      const serverName = useServerStore.getState().servers.find(s => s.id === data.serverId)?.name;
      deferStoreUpdate(() => {
        const channelIds = useServerStore.getState().servers.find(s => s.id === data.serverId)?.channels.map(c => c.id);
        useServerStore.getState().removeServer(data.serverId);
        useVoiceStore.getState().clearServerData(data.serverId, channelIds);
        clearServerChannelListStorage(data.serverId);
        {
          const folder = useServerFolderStore.getState().getFolderForServer(data.serverId);
          if (folder) {
            const newIds = folder.serverIds.filter(id => id !== data.serverId);
            useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
            apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {});
          }
        }
      });
      joinedServerRoomsRef.current.delete(data.serverId);
      if (useNavigationStore.getState().activeServerId === data.serverId) {
        navigateHome();
      }
      const displayName = serverName ?? 'a server';
      showGlobalToast(`You were banned from ${displayName}`, 'warning', 5000);
    });

    socketService.onServerDeleted((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId) return;
      deferStoreUpdate(() => {
        const channelIds = useServerStore.getState().servers.find(s => s.id === data.serverId)?.channels.map(c => c.id);
        useServerStore.getState().removeServer(data.serverId);
        useVoiceStore.getState().clearServerData(data.serverId, channelIds);
        clearServerChannelListStorage(data.serverId);
        {
          const folder = useServerFolderStore.getState().getFolderForServer(data.serverId);
          if (folder) {
            const newIds = folder.serverIds.filter(id => id !== data.serverId);
            useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
            apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {});
          }
        }
      });
      joinedServerRoomsRef.current.delete(data.serverId);
      if (useNavigationStore.getState().activeServerId === data.serverId) {
        navigateHome();
        showGlobalToast('This server has been deleted', 'info', 5000);
      }
    });

    socketService.onServerMemberRoleUpdated((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId || typeof data?.userId !== 'string' || !data.userId) return;
      // If the current user's role changed, invalidate the servers cache so
      // myPermissions/myRole refresh immediately instead of waiting for TTL expiry.
      if (data.userId === currentUserId) {
        apiClient.invalidateCache('servers');
      }
      if (useNavigationStore.getState().activeServerId !== data.serverId) return;
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(
          serverMembers.map((m) =>
            m.id === data.userId
              ? { ...m, role: data.roleName, roleColor: data.roleColor, roleStyle: data.roleStyle as ServerMember['roleStyle'] }
              : m
          )
        );
      });
    });

    // Multi-role: the add/remove events carry the authoritative list of role
    // IDs for the target user. Reconciling the local member.roles array from
    // this is what makes Server Settings → Roles → "Members in role" update
    // live for every viewer without a full refetch. The legacy -updated
    // event only carries the single display role, which doesn't change when
    // a lower-position role is added/removed, so it's insufficient alone.
    //
    // Metadata strategy: we reuse whatever role metadata the local member
    // already has, plus the freshly-added role (which the backend sends in
    // full on the -added event). If the resulting list is shorter than the
    // authoritative ID list — because the local state hasn't seen a role ID
    // before — we also invalidate the members cache so the next refetch
    // (e.g. opening Server Settings later) pulls the full metadata.
    const reconcileMemberRoles = (
      serverId: string,
      userId: string,
      roleIds: string[],
      newlyAddedRole?: { id: string; name: string; color: string; style: string; position: number; displaySeparately: boolean },
    ) => {
      if (useNavigationStore.getState().activeServerId !== serverId) return;
      if (userId === currentUserId) apiClient.invalidateCache('servers');
      apiClient.invalidateCache(`members:${serverId}`);
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(
          serverMembers.map((m) => {
            if (m.id !== userId) return m;
            const byId = new Map<string, { id: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean }>();
            for (const r of (m.roles ?? [])) if (r.id) byId.set(r.id, r);
            if (newlyAddedRole) byId.set(newlyAddedRole.id, newlyAddedRole);
            const nextRoles = roleIds
              .map(id => byId.get(id))
              .filter((r): r is { id: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean } => !!r);
            return { ...m, roles: nextRoles };
          })
        );
      });
    };

    socketService.onServerMemberRoleAdded((data) => {
      if (typeof data?.serverId !== 'string' || typeof data?.userId !== 'string') return;
      reconcileMemberRoles(data.serverId, data.userId, Array.isArray(data.roles) ? data.roles : [], data.role);
    });

    socketService.onServerMemberRoleRemoved((data) => {
      if (typeof data?.serverId !== 'string' || typeof data?.userId !== 'string') return;
      reconcileMemberRoles(data.serverId, data.userId, Array.isArray(data.roles) ? data.roles : []);
    });

    socketService.onServerRoleCreated(({ serverId }) => {
      if (useNavigationStore.getState().activeServerId === serverId) refetchServerMembers();
    });
    socketService.onServerRoleUpdated(({ serverId }) => {
      apiClient.invalidateCache('servers');
      if (useNavigationStore.getState().activeServerId === serverId) refetchServerMembers();
    });
    socketService.onServerRoleDeleted(({ serverId }) => {
      apiClient.invalidateCache('servers');
      if (useNavigationStore.getState().activeServerId === serverId) refetchServerMembers();
    });

    // Server meta updates (name, icon, banner)
    socketService.onServerUpdated((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId) return;
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(data.serverId, (s) => ({
          ...s,
          name: data.name,
          icon: data.icon,
          banner: data.banner,
        }));
      });
    });

    // Server settings updated (description, verification, notifications, etc.)
    socketService.onServerSettingsUpdated((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId) return;
      if (!data.settings || typeof data.settings !== 'object') return;
      deferStoreUpdate(() => {
        useServerStore.getState().updateServer(data.serverId, (s) => {
          const patch: Record<string, unknown> = {};
          if (data.settings.description !== undefined) {
            patch.description = typeof data.settings.description === 'string' ? data.settings.description : null;
          }
          // Merge all other settings fields so the UI reflects changes
          // without requiring a page refresh (e.g. verification level,
          // default notifications, content filter, join method, etc.)
          const settingsKeys = [
            'verificationLevel', 'contentFilter', 'dmSpamFilter',
            'welcomeMessage', 'welcomeEnabled', 'defaultNotifications',
            'joinMethod', 'ageRestricted', 'rules', 'communityEnabled',
            'discoveryEnabled', 'region', 'blockedNicknames',
          ] as const;
          const settingsPatch: Record<string, unknown> = {};
          for (const key of settingsKeys) {
            if (data.settings[key] !== undefined) {
              settingsPatch[key] = data.settings[key];
            }
          }
          if (Object.keys(patch).length === 0 && Object.keys(settingsPatch).length === 0) return s;
          return {
            ...s,
            ...patch,
            ...(Object.keys(settingsPatch).length > 0 ? { settings: { ...(s as any).settings, ...settingsPatch } } : {}),
          };
        });
      });
    });

    // Ownership transfer
    socketService.onServerOwnershipTransferred((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId) return;
      // Invalidate server cache so myRole/myPermissions refresh
      apiClient.invalidateCache('servers');
      if (useNavigationStore.getState().activeServerId === data.serverId) refetchServerMembers();
    });

    // Member timeout applied (moderator timed out a member)
    socketService.onMemberTimeoutApplied((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId || typeof data?.userId !== 'string' || !data.userId) return;
      if (useNavigationStore.getState().activeServerId !== data.serverId) return;
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(
          serverMembers.map((m) =>
            m.id === data.userId
              ? { ...m, timeoutUntil: data.timeoutUntil }
              : m
          )
        );
      });
    });

    // Member timeout cleared (moderator removed a timeout)
    socketService.onMemberTimeoutCleared((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId || typeof data?.userId !== 'string' || !data.userId) return;
      if (useNavigationStore.getState().activeServerId !== data.serverId) return;
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(
          serverMembers.map((m) =>
            m.id === data.userId
              ? { ...m, timeoutUntil: undefined }
              : m
          )
        );
      });
    });

    // Member nickname changed by moderator
    socketService.onMemberNicknameChanged((data) => {
      if (typeof data?.serverId !== 'string' || !data.serverId || typeof data?.userId !== 'string' || !data.userId) return;
      if (useNavigationStore.getState().activeServerId !== data.serverId) return;
      deferStoreUpdate(() => {
        const { serverMembers, setServerMembers } = useServerStore.getState();
        setServerMembers(
          serverMembers.map((m) =>
            m.id === data.userId
              ? { ...m, nickname: data.nickname }
              : m
          )
        );
      });
    });

    // Expression events (emoji, sticker, soundboard) -- invalidate expression caches
    socketService.onServerEmojiCreated((data) => {
      if (data?.serverId) apiClient.invalidateCache(`emojis:${data.serverId}`);
    });
    socketService.onServerEmojiDeleted((data) => {
      if (data?.serverId) apiClient.invalidateCache(`emojis:${data.serverId}`);
    });
    socketService.onServerStickerCreated((data) => {
      if (data?.serverId) apiClient.invalidateCache(`stickers:${data.serverId}`);
    });
    socketService.onServerStickerDeleted((data) => {
      if (data?.serverId) apiClient.invalidateCache(`stickers:${data.serverId}`);
    });
    socketService.onServerSoundboardCreated(() => { /* soundboard fetched fresh */ });
    socketService.onServerSoundboardDeleted(() => { /* soundboard fetched fresh */ });

    return () => { socketService.offAllServerEvents(); };
  }, [currentUserId, refetchServerMembers, showGlobalToast]);
}
