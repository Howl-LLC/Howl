// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { StageSession } from '../types';
import { socketService } from '../services/socket';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useVoiceStore } from '../stores/voiceStore';
import { normalizeStageSession, resolveAsset } from '../utils/stageHelpers';

/**
 * Registers socket events for stage session lifecycle and participant changes:
 * - stage-started, stage-ended, stage-updated
 * - stage-speaker-added, stage-speaker-removed
 * - stage-hand-raised, stage-hand-lowered
 * - stage-audience-joined, stage-audience-left
 */
export function useStageSocketEvents(): void {
  useEffect(() => {
    socketService.onStageStarted((session: StageSession) => {
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => ({ ...prev, [session.channelId]: normalizeStageSession(session) }));
      });
    });
    socketService.onStageEnded((data) => {
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => { const next = { ...prev }; delete next[data.channelId]; return next; });
        useVoiceStore.getState().setConnectedStageChannelId((prev) => (prev === data.channelId ? null : prev));
      });
    });
    socketService.onStageUpdated((session: StageSession) => {
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => ({ ...prev, [session.channelId]: normalizeStageSession(session) }));
      });
    });
    socketService.onStageSpeakerAdded((data) => {
      if (!data.channelId) return;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          const session = prev[data.channelId];
          if (!session || session.speakers.some(s => s.userId === data.userId)) return prev;
          return {
            ...prev,
            [data.channelId]: {
              ...session,
              speakers: [...session.speakers, {
                userId: data.userId,
                username: data.username,
                discriminator: data.discriminator,
                avatar: resolveAsset(data.avatar) ?? null,
                banner: resolveAsset(data.banner) ?? null,
                bannerPositionY: data.bannerPositionY,
                bannerZoom: data.bannerZoom,
                nameColor: data.nameColor ?? null,
                nameFont: data.nameFont ?? null,
                nameEffect: data.nameEffect ?? null,
                avatarEffect: data.avatarEffect ?? null,
                effectivePlan: data.effectivePlan,
                isMuted: data.isMuted ?? true,
                isHost: data.isHost ?? false,
              }],
              audienceCount: Math.max(0, session.audienceCount - ((session.audienceMembers ?? []).some(m => m.userId === data.userId) ? 1 : 0)),
              audienceMembers: (session.audienceMembers ?? []).filter(m => m.userId !== data.userId),
            },
          };
        });
      });
    });
    socketService.onStageSpeakerRemoved((data) => {
      if (!data.channelId) return;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          const session = prev[data.channelId];
          if (!session) return prev;
          return { ...prev, [data.channelId]: { ...session, speakers: session.speakers.filter(s => s.userId !== data.userId) } };
        });
      });
    });
    socketService.onStageHandRaised((data) => {
      if (!data.channelId) return;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          const session = prev[data.channelId];
          if (!session || session.handRaises.some((h: any) => h.userId === data.userId)) return prev;
          return { ...prev, [data.channelId]: { ...session, handRaises: [...session.handRaises, { userId: data.userId, username: data.username, avatar: resolveAsset(data.avatar) ?? null }] } };
        });
      });
    });
    socketService.onStageHandLowered((data) => {
      if (!data.channelId) return;
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          const session = prev[data.channelId];
          if (!session) return prev;
          return { ...prev, [data.channelId]: { ...session, handRaises: session.handRaises.filter((h: any) => h.userId !== data.userId) } };
        });
      });
    });
    socketService.onStageAudienceJoined((member) => {
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          const session = prev[member.channelId];
          if (!session) return prev;
          if (session.audienceMembers?.some(m => m.userId === member.userId)) return prev;
          return {
            ...prev,
            [member.channelId]: {
              ...session,
              audienceCount: session.audienceCount + 1,
              audienceMembers: [...(session.audienceMembers ?? []), { ...member, avatar: resolveAsset(member.avatar) ?? null }],
            },
          };
        });
      });
    });
    socketService.onStageAudienceLeft(({ userId, channelId }) => {
      deferStoreUpdate(() => {
        useVoiceStore.getState().setActiveStageSessions((prev) => {
          const session = prev[channelId];
          if (!session) return prev;
          const filtered = (session.audienceMembers ?? []).filter(m => m.userId !== userId);
          if (filtered.length === (session.audienceMembers ?? []).length) return prev;
          return {
            ...prev,
            [channelId]: {
              ...session,
              audienceCount: Math.max(0, session.audienceCount - 1),
              audienceMembers: filtered,
            },
          };
        });
      });
    });
    return () => {
      socketService.offStageStarted();
      socketService.offStageEnded();
      socketService.offStageUpdated();
      socketService.offStageSpeakerAdded();
      socketService.offStageSpeakerRemoved();
      socketService.offStageHandRaised();
      socketService.offStageHandLowered();
      socketService.offStageAudienceJoined();
      socketService.offStageAudienceLeft();
    };
  }, []);
}
