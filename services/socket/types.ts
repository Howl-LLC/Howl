// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export interface SocketServerRole {
  id: string;
  name: string;
  color: string;
  style: string;
  icon?: string;
  position: number;
  locked: boolean;
  permissions: Record<string, boolean>;
  displaySeparately: boolean;
  allowMention: boolean;
  memberCount: number;
}

export interface SocketNewMessagePayload {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  type?: string;
  systemPayload?: { kind: string; messageId?: string } | null;
  replyTo?: { id: string; authorId: string; authorUsername?: string | null; content: string } | null;
  createdAt: string;
  editedAt?: string | null;
  authorUsername?: string | null;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
  authorRoleColor?: string | null;
  authorRoleStyle?: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  forwarded?: boolean;
  authorStripePlan?: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
}

export type { SocketDMMessagePayload, SocketDMSystemPayload, SocketNewDmChannelPayload } from '../socketTypes';
