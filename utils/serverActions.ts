// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Server action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { useServerStore } from '../stores/serverStore';
import { useNotificationStore } from '../stores/notificationStore';
import { useNavigationStore } from '../stores/navigationStore';
import { useVoiceStore } from '../stores/voiceStore';
import { clearServerChannelListStorage } from '../components/ChannelList';
import { useServerFolderStore } from '../stores/serverFolderStore';
import type { ApplicationQuestion } from '../services/api/community';
import type { Server, Channel } from '../types';

/**
 * Result of joining via invite. Apply-to-join servers do NOT add the server
 * to the user's list — the caller is expected to render an application form
 * with the returned questions.
 */
export type JoinByInviteResult =
  | { kind: 'joined'; server: Server }
  | {
      kind: 'application_required';
      serverId: string;
      serverName: string;
      questions: ApplicationQuestion[];
      /** Non-null when the caller already has a pending application; the UI
       *  should render "already applied" and skip the form. */
      existingApplication: { status: 'pending'; createdAt: string } | null;
    };

// Create a server

export async function createServer(
  name: string,
  navigate: (path: string) => void,
  options?: { icon?: string; template?: string; community?: boolean },
): Promise<void> {
  const newServer = await apiClient.createServer(name, options?.icon, options?.template);
  useServerStore.getState().addServer(newServer);
  // If the user opted into community mode at creation, flip the flag in a
  // best-effort follow-up call. We don't block server creation on this — if
  // the enable call fails, the server is created normally and the user can
  // turn community mode on later in Server Settings → Community Hub.
  if (options?.community) {
    try {
      await apiClient.serverCommunityEnable(newServer.id);
    } catch {
      /* ignore — user can enable from settings */
    }
  }
  navigate(`/channels/${newServer.id}/${newServer.channels[0]?.id ?? ''}`);
}

// Handle server created from template

export function handleServerCreatedFromTemplate(
  server: { id: string; name: string; channels: Array<{ id: string; name: string; type: string }> },
  navigate: (path: string) => void,
): void {
  const { servers } = useServerStore.getState();
  if (!servers.some((s) => s.id === server.id)) {
    useServerStore.getState().addServer({
      id: server.id,
      name: server.name,
      icon: null,
      channels: server.channels.map((c) => ({
        id: c.id,
        name: c.name,
        type: (c.type ?? 'text') as Channel['type'],
        categoryId: null,
        position: 0,
      })),
    } as Server);
  }
  navigate(`/channels/${server.id}/${server.channels[0]?.id ?? ''}`);
}

// Update server settings

export async function updateServer(updatedServer: Server): Promise<void> {
  // Optimistic update
  const { servers } = useServerStore.getState();
  const prevServer = servers.find((s) => s.id === updatedServer.id);
  useServerStore.getState().updateServer(updatedServer.id, () => updatedServer);

  if (updatedServer.id) {
    try {
      const saved = await apiClient.updateServer(updatedServer.id, {
        name: updatedServer.name,
        icon: updatedServer.icon ?? undefined,
        banner: updatedServer.banner ?? undefined,
      });
      useServerStore.getState().updateServer(saved.id, (s) => ({
        ...s,
        name: saved.name,
        icon: saved.icon,
        banner: saved.banner,
      }));
    } catch (e) {
      // Revert on failure
      if (prevServer) {
        useServerStore.getState().updateServer(prevServer.id, () => prevServer!);
      }
      throw e;
    }
  }
}

// Join server by invite

export async function joinByInvite(
  code: string,
  navigate: (path: string) => void,
): Promise<JoinByInviteResult> {
  let result;
  try {
    result = await apiClient.joinServerByInvite(code);
  } catch (err) {
    if (err instanceof Error && err.message === 'age_restricted') {
      const confirmed = window.confirm(
        'This server is age-restricted. By continuing, you confirm you are 18 years or older. Do you want to proceed?',
      );
      if (!confirmed)
        throw new Error('You must confirm your age to join this server.', { cause: err });
      result = await apiClient.joinServerByInvite(code, true);
    } else {
      throw err;
    }
  }
  if ('applicationRequired' in result) {
    return {
      kind: 'application_required',
      serverId: result.serverId,
      serverName: result.serverName,
      questions: result.questions,
      existingApplication: result.existingApplication ?? null,
    };
  }
  const server = result;
  const { servers } = useServerStore.getState();
  if (!servers.some((s) => s.id === server.id)) {
    useServerStore.getState().addServer(server);
  }
  navigate(`/channels/${server.id}/${server.channels[0]?.id ?? ''}`);
  return { kind: 'joined', server };
}

// Leave server

export async function leaveServer(
  serverId: string,
  navigate: (path: string) => void,
  joinedServerRoomsRef?: React.MutableRefObject<Set<string>>,
): Promise<void> {
  const channelIds = useServerStore.getState().servers.find(s => s.id === serverId)?.channels.map(c => c.id);
  await apiClient.leaveServer(serverId);
  useServerStore.getState().removeServer(serverId);
  useVoiceStore.getState().clearServerData(serverId, channelIds);
  clearServerChannelListStorage(serverId);
  {
    const folder = useServerFolderStore.getState().getFolderForServer(serverId);
    if (folder) {
      const newIds = folder.serverIds.filter(id => id !== serverId);
      useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
      apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {});
    }
  }
  joinedServerRoomsRef?.current.delete(serverId);
  if (useNavigationStore.getState().activeServerId === serverId) {
    navigate('/home');
  }
}

// Transfer ownership and leave

export async function transferOwnershipAndLeave(
  serverId: string,
  newOwnerId: string,
  navigate: (path: string) => void,
  joinedServerRoomsRef?: React.MutableRefObject<Set<string>>,
): Promise<void> {
  const channelIds = useServerStore.getState().servers.find(s => s.id === serverId)?.channels.map(c => c.id);
  await apiClient.transferServerOwnership(serverId, newOwnerId);
  await apiClient.leaveServer(serverId);
  useServerStore.getState().removeServer(serverId);
  useVoiceStore.getState().clearServerData(serverId, channelIds);
  clearServerChannelListStorage(serverId);
  {
    const folder = useServerFolderStore.getState().getFolderForServer(serverId);
    if (folder) {
      const newIds = folder.serverIds.filter(id => id !== serverId);
      useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
      apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {});
    }
  }
  joinedServerRoomsRef?.current.delete(serverId);
  if (useNavigationStore.getState().activeServerId === serverId) {
    navigate('/home');
  }
}

// Delete server

export async function deleteServer(
  serverId: string,
  navigate: (path: string) => void,
  password?: string,
  joinedServerRoomsRef?: React.MutableRefObject<Set<string>>,
): Promise<void> {
  const channelIds = useServerStore.getState().servers.find(s => s.id === serverId)?.channels.map(c => c.id);
  await apiClient.deleteServer(serverId, password);
  useServerStore.getState().removeServer(serverId);
  useVoiceStore.getState().clearServerData(serverId, channelIds);
  clearServerChannelListStorage(serverId);
  {
    const folder = useServerFolderStore.getState().getFolderForServer(serverId);
    if (folder) {
      const newIds = folder.serverIds.filter(id => id !== serverId);
      useServerFolderStore.getState().updateFolder(folder.id, { serverIds: newIds });
      apiClient.updateServerFolder(folder.id, { serverIds: newIds }).catch(() => {});
    }
  }
  joinedServerRoomsRef?.current.delete(serverId);
  if (useNavigationStore.getState().activeServerId === serverId) {
    navigate('/home');
  }
}

// Mark server as read

export function markServerRead(serverId: string): void {
  const notif = useNotificationStore.getState();
  // Clear the server-level dot
  notif.removeServerUnread(serverId);
  notif.clearServerMention(serverId);
  // Sweep every channel in this server so individual channel dots/mentions don't
  // linger after "mark server as read". Pre-fix the server dot cleared but
  // channel dots persisted, leaving the user wondering why the server still
  // looked partly-unread.
  const server = useServerStore.getState().servers.find(s => s.id === serverId);
  if (server) {
    for (const ch of server.channels) {
      notif.removeChannelUnread(ch.id);
      notif.clearChannelMention(ch.id);
    }
  }
}

// Create channel

export async function createChannel(
  serverId: string,
  name: string,
  type: Channel['type'],
  categoryId?: string | null,
  isPrivate?: boolean,
): Promise<Channel> {
  const channel = await apiClient.createChannel(serverId, name, type, categoryId, isPrivate);
  // Optimistic store update so the creator's UI reflects the new channel
  // immediately, independent of the socket round-trip. The channel-created
  // socket event handler is idempotent (checks `id` existence) so it won't
  // duplicate when it arrives.
  useServerStore.getState().updateServer(serverId, (s: any) => {
    if (!s?.channels) return s;
    if (s.channels.some((c: Channel) => c.id === channel.id)) return s;
    const next = [...s.channels, channel];
    next.sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
    return { ...s, channels: next };
  });
  return channel;
}

// Create category

export async function createCategory(
  serverId: string,
  name: string,
): Promise<any> {
  const category = await apiClient.createCategory(serverId, name);
  useServerStore.getState().updateServer(serverId, (s: any) => {
    const existing = s?.categories ?? [];
    if (existing.some((c: any) => c.id === category.id)) return s;
    const next = [...existing, category];
    next.sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0));
    return { ...s, categories: next };
  });
  return category;
}

// Channel update / delete / reorder
// All three apply the store change immediately so the caller's UI reflects
// the mutation without waiting for the socket round-trip. Socket handlers
// (onChannelUpdatedMeta / onChannelDeleted / onChannelsReordered) are
// idempotent — they re-apply the same change when they arrive.

export async function updateChannel(
  serverId: string,
  channelId: string,
  data: Record<string, unknown>,
): Promise<any> {
  const updated = await apiClient.updateChannel(serverId, channelId, data as any);
  useServerStore.getState().updateServer(serverId, (s: any) => ({
    ...s,
    channels: (s?.channels ?? []).map((ch: Channel) =>
      ch.id === channelId ? { ...ch, ...updated } : ch,
    ),
  }));
  return updated;
}

export async function deleteChannel(serverId: string, channelId: string): Promise<void> {
  await apiClient.deleteChannel(serverId, channelId);
  useServerStore.getState().updateServer(serverId, (s: any) => ({
    ...s,
    channels: (s?.channels ?? []).filter((ch: Channel) => ch.id !== channelId),
  }));
}

export async function reorderChannels(
  serverId: string,
  channels: Array<{ id: string; position: number; categoryId?: string | null }>,
): Promise<void> {
  const normalized = channels.map((c) => ({
    id: c.id,
    position: c.position,
    categoryId: c.categoryId ?? null,
  }));
  await apiClient.reorderChannels(serverId, normalized);
  const updates = new Map(channels.map((c) => [c.id, c]));
  useServerStore.getState().updateServer(serverId, (s: any) => ({
    ...s,
    channels: (s?.channels ?? [])
      .map((ch: Channel) => {
        const u = updates.get(ch.id);
        if (!u) return ch;
        return { ...ch, position: u.position, categoryId: u.categoryId ?? ch.categoryId };
      })
      .sort((a: Channel, b: Channel) => (a.position ?? 0) - (b.position ?? 0)),
  }));
}

// Category update / delete / reorder

export async function updateCategory(
  serverId: string,
  categoryId: string,
  data: Record<string, unknown>,
): Promise<any> {
  const updated = await apiClient.updateCategory(serverId, categoryId, data as any);
  useServerStore.getState().updateServer(serverId, (s: any) => ({
    ...s,
    categories: (s?.categories ?? []).map((c: any) =>
      c.id === categoryId ? { ...c, ...updated } : c,
    ),
  }));
  return updated;
}

export async function deleteCategory(serverId: string, categoryId: string): Promise<void> {
  await apiClient.deleteCategory(serverId, categoryId);
  useServerStore.getState().updateServer(serverId, (s: any) => ({
    ...s,
    categories: (s?.categories ?? []).filter((c: any) => c.id !== categoryId),
    // Orphan channels lose their categoryId but remain in the channel list
    channels: (s?.channels ?? []).map((ch: Channel) =>
      ch.categoryId === categoryId ? { ...ch, categoryId: null } : ch,
    ),
  }));
}

export async function reorderCategories(
  serverId: string,
  categories: Array<{ id: string; position: number }>,
): Promise<void> {
  await apiClient.reorderCategories(serverId, categories);
  const updates = new Map(categories.map((c) => [c.id, c]));
  useServerStore.getState().updateServer(serverId, (s: any) => ({
    ...s,
    categories: (s?.categories ?? [])
      .map((c: any) => {
        const u = updates.get(c.id);
        if (!u) return c;
        return { ...c, position: u.position };
      })
      .sort((a: any, b: any) => (a.position ?? 0) - (b.position ?? 0)),
  }));
}

// Create / delete server invites

export function createInvite(
  serverId: string,
  options?: { expireAfter?: number | null; maxUses?: number | null; temporary?: boolean; label?: string; shareable?: boolean },
): Promise<{ id: string; code: string; link: string; maxUses?: number; expiresAt?: string; temporary?: boolean; label?: string; shareable: boolean }> {
  return apiClient.createServerInvite(serverId, options);
}

export function deleteInvite(serverId: string, inviteId: string): Promise<void> {
  return apiClient.deleteServerInvite(serverId, inviteId);
}

// Edit server profile (navigates to settings)

export function editServerProfile(
  serverId: string,
  navigate: (path: string) => void,
): void {
  useNavigationStore.getState().setAccountDeepLink({
    page: 'my-account',
    subTab: 'profiles',
    profileServerId: serverId,
  });
  navigate('/settings');
}
