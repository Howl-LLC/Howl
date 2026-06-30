// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../db.js';
import { JWT_SECRET } from '../middleware/auth.js';
import { hashToken } from '../utils/sessionUtils.js';
import { loadPermissionContext, hasChannelPermission } from '../utils/permissions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Extract the upload's uuid stem from a served :filename. Strips an optional
 * derivative prefix (thumb_/frame_) and the extension, so an original
 * `<uuid>.png`, a thumbnail `thumb_<uuid>.webp`, and a GIF poster
 * `frame_<uuid>.webp` all resolve to the same `<uuid>`. Returns null when the
 * remaining stem is not a UUID (avatars/legacy/non-upload names), which the
 * caller treats as public.
 */
export function extractUploadStem(filename: string): string | null {
  let name = filename;
  if (name.startsWith('thumb_')) name = name.slice('thumb_'.length);
  else if (name.startsWith('frame_')) name = name.slice('frame_'.length);
  const dot = name.lastIndexOf('.');
  const stem = dot === -1 ? name : name.slice(0, dot);
  return UUID_RE.test(stem) ? stem : null;
}

export type UploadOwner =
  | { kind: 'channel'; channelIds: string[] }
  | { kind: 'dm'; dmChannelIds: string[] }
  | { kind: 'both'; channelIds: string[]; dmChannelIds: string[] }
  | { kind: 'public' };

const RESOLVE_TAKE = 50; // per-table row cap (forwarding/fan-out); distinct channels are deduped below

/**
 * Base forms a stored attachment URL can take. The upload route emits the relative
 * `/api/uploads/` path, but the message schemas also accept an absolute backend-
 * origin URL (origin set = FRONTEND_ORIGIN, the same set messages.ts trusts), so a
 * stored row may carry either. Computed once at module load.
 */
const UPLOAD_URL_BASES: string[] = [
  '/api/uploads/',
  ...(process.env.FRONTEND_ORIGIN || 'http://localhost:5000')
    .split(',')
    .map((o) => {
      try { return `${new URL(o.trim()).origin}/api/uploads/`; } catch { return ''; }
    })
    .filter(Boolean),
];

/**
 * Resolve the served filename to the channel(s)/DM(s) that reference it, via the
 * authoritative message/post rows. A file is stored as `<stem>` (extensionless
 * upload) or `<stem>.<ext>`, under the relative `/api/uploads/` path or an absolute
 * backend-origin URL; thumb_/frame_ derivatives share the parent's `<stem>`. We
 * therefore match every (base, stem) form — extensionless exact + `<stem>.` prefix
 * — rather than only a dot-anchored `/api/uploads/<stem>.`, which would MISS the
 * extensionless and absolute forms and fall OPEN (resolve `public` -> served
 * unauthenticated). All conditions stay left-anchored so the `text_pattern_ops`
 * indexes are used. Every plaintext-channel surface contributes a channel owner:
 * regular channel messages (`Message.channelId`), thread messages
 * (`ThreadMessage -> Thread.channelId`), forum messages
 * (`ForumMessage -> ForumPost.channelId`), and forum-post covers
 * (`ForumPost.imageUrl -> channelId`). DM attachments contribute a DM owner
 * (`DMMessage.dmChannelId`). A filename referenced by no row (avatar/banner/emoji/
 * legacy, or a not-yet-posted upload still in the composer preview window) resolves
 * to `public`. Throws on a DB error so the serve route can fail closed.
 */
export async function resolveUploadOwner(filename: string): Promise<UploadOwner> {
  const stem = extractUploadStem(filename);
  if (!stem) return { kind: 'public' };
  const exacts = UPLOAD_URL_BASES.map((b) => `${b}${stem}`);
  const extPrefixes = UPLOAD_URL_BASES.map((b) => `${b}${stem}.`);
  const attOr = [
    ...exacts.map((v) => ({ attachmentUrl: v })),
    ...extPrefixes.map((v) => ({ attachmentUrl: { startsWith: v } })),
  ];
  const imgOr = [
    ...exacts.map((v) => ({ imageUrl: v })),
    ...extPrefixes.map((v) => ({ imageUrl: { startsWith: v } })),
  ];
  const [msgRows, dmRows, threadRows, forumMsgRows, forumPostRows] = await Promise.all([
    prisma.message.findMany({
      where: { OR: attOr },
      select: { channelId: true },
      distinct: ['channelId'],
      take: RESOLVE_TAKE,
    }),
    prisma.dMMessage.findMany({
      where: { OR: attOr },
      select: { dmChannelId: true },
      distinct: ['dmChannelId'],
      take: RESOLVE_TAKE,
    }),
    prisma.threadMessage.findMany({
      where: { OR: attOr },
      select: { thread: { select: { channelId: true } } },
      take: RESOLVE_TAKE,
    }),
    prisma.forumMessage.findMany({
      where: { OR: attOr },
      select: { forumPost: { select: { channelId: true } } },
      take: RESOLVE_TAKE,
    }),
    prisma.forumPost.findMany({
      where: { OR: imgOr },
      select: { channelId: true },
      distinct: ['channelId'],
      take: RESOLVE_TAKE,
    }),
  ]);
  const channelIds = [...new Set<string>([
    ...msgRows.map((r) => r.channelId),
    ...threadRows.map((r) => r.thread.channelId),
    ...forumMsgRows.map((r) => r.forumPost.channelId),
    ...forumPostRows.map((r) => r.channelId),
  ])];
  const dmChannelIds = [...new Set<string>(dmRows.map((r) => r.dmChannelId))];
  if (channelIds.length && dmChannelIds.length) return { kind: 'both', channelIds, dmChannelIds };
  if (channelIds.length) return { kind: 'channel', channelIds };
  if (dmChannelIds.length) return { kind: 'dm', dmChannelIds };
  return { kind: 'public' };
}

const REFRESH_COOKIE_NAME = 'howl_refresh';

/**
 * Identify the requesting user for the serve route, without the authenticateToken
 * middleware (the route stays reachable for public assets). Tries a Bearer access
 * token first (channel-image and download fetches send one), then the
 * `howl_refresh` session cookie (DM fetches send one via credentials:'include').
 * Both paths confirm a LIVE, non-suspended session, mirroring authenticateToken: a
 * signature-valid access token whose Session row was deleted (logout / revoke-
 * sessions / admin action) does NOT authorize a serve, and a suspended user is
 * rejected. Returns null when neither path yields such an identity. MFA-purpose
 * tokens are rejected (any `purpose` claim is not a session token).
 */
export async function identifyServeViewer(req: Request): Promise<string | null> {
  const authHeader = req.headers['authorization'];
  const bearer = authHeader && authHeader.split(' ')[1];
  if (bearer) {
    try {
      const decoded = jwt.verify(bearer, JWT_SECRET, { algorithms: ['HS256'] }) as { userId?: string; purpose?: string };
      if (decoded?.userId && !decoded.purpose) {
        // Parity with authenticateToken: the access token's hash keys its Session
        // row (sessionUtils.hashToken). No row => revoked/logged-out; suspended user
        // => rejected. Without this a 15-min-valid token outlives its revocation.
        const session = await prisma.session.findUnique({
          where: { tokenHash: hashToken(bearer) },
          select: { userId: true, user: { select: { suspended: true } } },
        });
        if (session && !session.user.suspended) return session.userId;
      }
    } catch {
      /* fall through to the cookie */
    }
  }
  const refresh = (req as Request & { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE_NAME];
  if (refresh) {
    try {
      const session = await prisma.session.findFirst({
        where: { refreshTokenHash: hashToken(refresh) },
        select: { userId: true, expiresAt: true, user: { select: { suspended: true } } },
      });
      if (session && session.expiresAt && session.expiresAt > new Date() && !session.user.suspended) return session.userId;
    } catch {
      /* treat as anonymous */
    }
  }
  return null;
}

/**
 * Transition flag. Default OFF: with it off the serve route is unchanged. Flip to
 * 'true' only AFTER the frontend tokening is live, so channel video and
 * thread/forum attachments fetch with a credential before they can be gated.
 */
export const UPLOAD_ACL_ENABLED = process.env.UPLOAD_ACL_ENABLED === 'true';

const CH_OVERRIDE_TAKE = 200;

/** True iff `viewerId` can view+read at least one channel that references the file. */
async function canViewAnyChannel(viewerId: string, channelIds: string[]): Promise<boolean> {
  for (const channelId of channelIds) {
    const channel = await prisma.channel.findUnique({
      where: { id: channelId },
      select: { id: true, serverId: true, isPrivate: true, categoryId: true },
    });
    if (!channel) continue;
    const permCtx = await loadPermissionContext(viewerId, channel.serverId);
    if (!permCtx) continue; // not a member of this server
    const [chOverrides, catOverrides] = await Promise.all([
      prisma.channelPermissionOverride.findMany({ where: { channelId }, take: CH_OVERRIDE_TAKE }),
      channel.categoryId
        ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: CH_OVERRIDE_TAKE })
        : Promise.resolve([]),
    ]);
    if (channel.isPrivate && !hasChannelPermission(permCtx, 'viewChannels', chOverrides, catOverrides, undefined, { requireOverride: true })) continue;
    if (!hasChannelPermission(permCtx, 'readMessageHistory', chOverrides, catOverrides)) continue;
    return true;
  }
  return false;
}

/** True iff `viewerId` is an active participant of at least one referencing DM. */
async function isActiveInAnyDm(viewerId: string, dmChannelIds: string[]): Promise<boolean> {
  const row = await prisma.dMParticipant.findFirst({
    where: { userId: viewerId, dmChannelId: { in: dmChannelIds }, pendingRemoval: null },
    select: { userId: true },
  });
  return row !== null;
}

/**
 * Authorize a viewer against a resolved upload owner. A `public` owner is always
 * allowed (the caller skips auth for it). For a channel owner the viewer must be a
 * ServerMember who can view (private -> requireOverride viewChannels) AND read
 * history; for a DM owner the viewer must be an active DMParticipant. A `both`
 * owner is allowed if EITHER context grants access (a forwarded file the viewer
 * can legitimately see via one of its homes).
 */
export async function authorizeUploadAccess(viewerId: string, owner: UploadOwner): Promise<boolean> {
  switch (owner.kind) {
    case 'public':
      return true;
    case 'channel':
      return canViewAnyChannel(viewerId, owner.channelIds);
    case 'dm':
      return isActiveInAnyDm(viewerId, owner.dmChannelIds);
    case 'both':
      return (await canViewAnyChannel(viewerId, owner.channelIds)) || (await isActiveInAnyDm(viewerId, owner.dmChannelIds));
  }
}
