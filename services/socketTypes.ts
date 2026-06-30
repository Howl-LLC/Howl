// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Payload for the 'new-dm-message' socket event. */
export interface SocketDMMessagePayload {
  dmChannelId: string;
  id: string;
  authorId: string;
  content: string;
  replyTo?: { id: string; authorId: string; authorUsername?: string | null; content: string } | null;
  createdAt: string;
  editedAt?: string | null;
  authorUsername?: string | null;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  forwarded?: boolean;
  authorStripePlan?: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
  encrypted?: boolean;
}

/** Payload for the 'dm-system-message' socket event. */
export interface SocketDMSystemPayload {
  dmChannelId: string;
  id: string;
  authorId: string;
  content: string;
  type?: string;
  systemPayload?: { kind: string; messageId?: string; userId?: string };
  createdAt: string;
  authorUsername?: string | null;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
}

/** Payload for the 'new-dm-channel' socket event. */
export interface SocketNewDmChannelPayload {
  id: string;
  isGroup?: boolean;
  otherUser?: { id: string; username: string; discriminator?: string; avatar?: string; status?: string } | null;
  otherUsers?: Array<{ id: string; username: string; discriminator?: string; avatar?: string; status?: string }>;
  encrypted?: boolean;
  ownerId?: string | null;
  /** Saved-tier MLS group id for this DM channel (1:1 or group).
   *  Additive — mirrors the server zod `newDmChannelPayload.mlsGroupId`
   *  (uuid().nullable().optional()). Null/undefined = no MLS group yet. */
  mlsGroupId?: string | null;
  /** OTR-tier MLS group id for this DM channel (1:1 only). Additive; null/undefined
   *  = no OTR group yet (the common case at channel-create time). */
  otrMlsGroupId?: string | null;
}

/** Payload for the 'otr-message' socket event (OTR tier, ephemeral 1:1). */
export interface SocketOtrMessagePayload {
  dmChannelId: string;
  mlsGroupId: string;
  clientMsgId: string;
  ciphertext: string;
  authorId?: string;
  createdAt?: number;
}

/** Payload for the 'otr-ended' socket event (OTR tier teardown). */
export interface SocketOtrEndedPayload {
  dmChannelId: string;
  mlsGroupId: string;
}
