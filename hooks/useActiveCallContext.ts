// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo } from 'react';
import { useVoiceStore } from '../stores/voiceStore';
import { useDmStore } from '../stores/dmStore';
import { useServerStore } from '../stores/serverStore';

export interface ActiveCallContext {
  kind: 'voice' | 'dm' | 'stage';
  scopeId: string;
  /** Display name for the PIP chrome (channel name / DM peer name / stage title). */
  displayName: string;
}

/**
 * Look up a channel name across all servers in the server store.
 * Returns the channel name if found, null otherwise.
 */
function resolveChannelName(channelId: string): string | null {
  const { servers } = useServerStore.getState();
  for (const server of servers) {
    const channel = server.channels?.find(ch => ch.id === channelId);
    if (channel) return channel.name;
  }
  return null;
}

/** Derives the single active-call descriptor. These three contexts are
 *  mutually exclusive (backend auto-leaves others on join). */
export function useActiveCallContext(activeDmCallChannelId: string | null): ActiveCallContext | null {
  const voiceChannelId = useVoiceStore(s => s.connectedVoiceChannelId);
  const stageChannelId = useVoiceStore(s => s.connectedStageChannelId);
  const dmChannels = useDmStore(s => s.dmChannels);
  // Subscribe to servers so we re-derive when server data changes.
  const servers = useServerStore(s => s.servers);

  return useMemo<ActiveCallContext | null>(() => {
    if (voiceChannelId) {
      return {
        kind: 'voice',
        scopeId: voiceChannelId,
        displayName: resolveChannelName(voiceChannelId) ?? 'Voice channel',
      };
    }
    if (stageChannelId) {
      return {
        kind: 'stage',
        scopeId: stageChannelId,
        displayName: resolveChannelName(stageChannelId) ?? 'Stage',
      };
    }
    if (activeDmCallChannelId) {
      const dm = dmChannels?.find(d => d.id === activeDmCallChannelId);
      // For 1:1 DMs, use the other user's username; for groups, use the channel name.
      const displayName = dm?.name
        ?? dm?.otherUser?.username
        ?? 'Direct message';
      return {
        kind: 'dm',
        scopeId: activeDmCallChannelId,
        displayName,
      };
    }
    return null;
  }, [voiceChannelId, stageChannelId, activeDmCallChannelId, dmChannels, servers]);
}
