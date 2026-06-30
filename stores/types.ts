// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { User, GameActivity, Channel } from '../types';

// ServerMember: locally defined in App.tsx, shared across stores
export type ServerMember = User & {
  role?: string;
  roleColor?: string;
  roleStyle?: 'solid' | 'gradient' | 'holographic';
  /** Multi-role: non-@everyone role assignments for this member. Driven by
   *  the backend GET /servers/:id/members roles[] and reconciled live by
   *  server-member-role-added/removed events. Used by Server Settings →
   *  Roles → Members-in-role filter. */
  roles?: Array<{ id: string; name: string; color?: string; style?: string; position?: number; displaySeparately?: boolean }>;
  nickname?: string | null;
  serverAvatar?: string | null;
  serverBanner?: string | null;
};

// DM channel types: originally from hooks/useDmSocketEvents.ts
export type DmChannelEntry = {
  id: string;
  otherUser?: {
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string;
    banner?: string;
    bannerPositionY?: number;
    bannerZoom?: number;
    nameColor?: string | null;
    nameFont?: string | null;
    nameEffect?: string | null;
    avatarEffect?: string | null;
    effectivePlan?: string | null;
    status?: string;
    activity?: GameActivity | null;
    secondaryActivity?: GameActivity | null;
    badges?: string[];
  } | null;
  isGroup?: boolean;
  name?: string;
  icon?: string;
  otherUsers?: Array<{
    id: string;
    username: string;
    discriminator?: string;
    avatar?: string;
    banner?: string;
    bannerPositionY?: number;
    bannerZoom?: number;
    nameColor?: string | null;
    nameFont?: string | null;
    nameEffect?: string | null;
    avatarEffect?: string | null;
    effectivePlan?: string | null;
    status?: string;
    activity?: GameActivity | null;
    secondaryActivity?: GameActivity | null;
    badges?: string[];
  }>;
  encrypted?: boolean;
  /** 1:1 DM only: server-derived flag for whether either participant's MLS keys
   *  are recoverable from Howl's servers (Server recovery escrow). Optional and
   *  additive; undefined means unknown (hide the recoverability chip). */
  serverReadable?: boolean;
  /** Server MLS group id for this DM channel — both 1:1 and group DMs;
   *  set once a group exists. Null/undefined = no MLS group yet. */
  mlsGroupId?: string | null;
  /** OTR-tier MLS group id for this DM channel (1:1 only). Set once an OTR group
   *  exists; null/undefined = no OTR group yet. */
  otrMlsGroupId?: string | null;
  lastMessage?: { content: string; createdAt: string; encrypted?: boolean; authorId?: string };
  pinned?: boolean;
  pinnedAt?: string;
  blockedByMe?: boolean;
  blockedByThem?: boolean;
  blockedParticipantIds?: string[];
  ownerId?: string | null;
};

export type DmBlockStatusEntry = {
  blockedByMe?: boolean;
  blockedByThem?: boolean;
  blockedParticipantIds?: string[];
};

// Voice participant info: locally defined in multiple components
export type VoiceParticipantInfo = {
  userId: string;
  username: string;
  avatar?: string;
  nameColor?: string;
  nameFont?: string;
  nameEffect?: string;
  avatarEffect?: string;
  effectivePlan?: string;
  roleColor?: string;
  roleStyle?: string;
  /** Set by the backend when the participant is currently publishing a
   *  screen track. Drives the sidebar "watch stream" indicator. */
  isScreenSharing?: boolean;
};

// Re-exported types from their original modules
export type { ServerContextAction } from '../components/Sidebar';
export type { UserWithRole } from '../components/UserProfilePopup';
export type { ForwardPayload } from '../components/ForwardImageModal';
export type { ScreenShareQuality } from '../utils/videoConstraints';

// Types that were locally scoped in App.tsx
export type ProfileFriendStatus = {
  status: 'none' | 'friends' | 'pending_outgoing' | 'pending_incoming';
  outgoingRequestId?: string;
};

// Stable empty references for store defaults
export const EMPTY_ARRAY: never[] = [];
export const EMPTY_RECORD: Record<string, never> = {};

// Channel type re-export for convenience
export type { Channel };

// Stream context types for viewer tracking
export type StreamType = 'screen';
export type StreamContextKind = 'voice' | 'dm' | 'stage';

export interface StreamContext {
  kind: StreamContextKind;
  scopeId: string; // voice channelId, dm channelId, stage channelId
}

/** Canonical key: `${kind}:${scopeId}:${ownerId}:${streamType}` */
export type StreamKey = `${StreamContextKind}:${string}:${string}:${StreamType}`;

export function makeStreamKey(ctx: StreamContext, ownerId: string, type: StreamType = 'screen'): StreamKey {
  return `${ctx.kind}:${ctx.scopeId}:${ownerId}:${type}` as StreamKey;
}

export function parseStreamKey(key: StreamKey): { ctx: StreamContext; ownerId: string; type: StreamType } {
  const [kind, scopeId, ownerId, type] = key.split(':') as [StreamContextKind, string, string, StreamType];
  return { ctx: { kind, scopeId }, ownerId, type };
}
