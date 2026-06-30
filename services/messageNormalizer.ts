// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Message } from '../types';
import { getBackendOrigin } from '../config';

function resolveUrl(url: string | null | undefined): string | undefined {
  if (!url) return undefined;
  if (url.startsWith('/')) return getBackendOrigin() + url;
  return url;
}

/** Structural type matching BackendMessage, BackendDMMessage, and SocketNewMessagePayload */
export interface RawMessage {
  id: string;
  authorId: string;
  content: string;
  createdAt: string;
  type?: string;
  systemPayload?: Record<string, unknown> | { kind?: string; messageId?: string } | null;
  replyTo?: { id: string; authorId: string; authorUsername?: string | null; content: string } | null;
  editedAt?: string | null;
  authorUsername?: string | null;
  authorDiscriminator?: string | null;
  authorAvatar?: string | null;
  authorRoleColor?: string | null;
  authorRoleStyle?: string;
  attachmentUrl?: string | null;
  attachmentName?: string | null;
  attachmentContentType?: string | null;
  attachmentWidth?: number | null;
  attachmentHeight?: number | null;
  attachmentIsSpoiler?: boolean;
  attachmentAlt?: string | null;
  forwarded?: boolean;
  authorStripePlan?: string | null;
  authorNameColor?: string | null;
  authorNameFont?: string | null;
  authorNameEffect?: string | null;
  authorAvatarEffect?: string | null;
}

/**
 * Normalize a raw backend/socket message payload into a frontend Message.
 *
 * Note: authorRoleStyle defaults to undefined here. Channel-message callers
 * should override to 'solid' after calling this function.
 */
export function normalizeMessage(raw: RawMessage): Message {
  return {
    id: raw.id,
    authorId: raw.authorId,
    content: raw.content,
    timestamp: new Date(raw.createdAt),
    type: raw.type === 'system' ? 'system' : raw.type === 'imported' ? 'imported' : 'message',
    systemPayload: raw.systemPayload ?? undefined,
    replyTo: raw.replyTo ?? undefined,
    authorUsername: raw.authorUsername ?? undefined,
    authorDiscriminator: raw.authorDiscriminator ?? undefined,
    authorAvatar: resolveUrl(raw.authorAvatar),
    authorRoleColor: raw.authorRoleColor ?? undefined,
    authorRoleStyle: (raw.authorRoleStyle as Message['authorRoleStyle']) ?? undefined,
    attachmentUrl: resolveUrl(raw.attachmentUrl),
    attachmentName: raw.attachmentName ?? undefined,
    attachmentContentType: raw.attachmentContentType ?? undefined,
    attachmentWidth: raw.attachmentWidth ?? undefined,
    attachmentHeight: raw.attachmentHeight ?? undefined,
    attachmentIsSpoiler: raw.attachmentIsSpoiler ?? undefined,
    attachmentAlt: raw.attachmentAlt ?? null,
    forwarded: raw.forwarded ?? false,
    editedAt: raw.editedAt ?? null,
    authorStripePlan: raw.authorStripePlan ?? undefined,
    authorNameColor: raw.authorNameColor ?? undefined,
    authorNameFont: raw.authorNameFont ?? undefined,
    authorNameEffect: raw.authorNameEffect ?? undefined,
    authorAvatarEffect: raw.authorAvatarEffect ?? undefined,
  };
}
