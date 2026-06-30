// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import {
  createForumPostSchema, updateForumPostSchema, createForumMessageSchema,
  updateForumMessageSchema, forumPostListQuery, forumMessageListQuery, forumReactionSchema,
} from '../schemas.js';
import { getParam, AUTHOR_USER_SELECT, getEffectivePlan, loadPermissionContext } from '../utils.js';
import { hasChannelPermission } from '../utils/channelPermissions.js';
import { logger } from '../logger.js';
import { redis } from '../redis.js';
import { deleteUploadedFile } from './upload.js';
import { checkUploadAttachment } from '../services/uploadProvenance.js';
import { applyBadgePrefs } from '../utils/badges.js';
import { getClientIp } from '../utils/clientIp.js';

const _log = logger.child({ module: 'forum' });

// Rate limiters

const forumReadLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-read:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const forumPostLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-post:'),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Too many posts. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const forumMsgLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-msg:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many messages. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const forumMutateLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-mutate:'),
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many actions. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const forumReactionLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:forum-react:'),
  windowMs: 60 * 1000,
  max: 30,
  message: { error: 'Too many reactions. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

const router = Router();

// Helpers

async function fetchChannelWithOverrides(channelId: string, serverId: string) {
  const channel = await prisma.channel.findFirst({
    where: { id: channelId, serverId },
    select: {
      id: true, serverId: true, type: true, categoryId: true,
      isPrivate: true, requireTags: true, postSlowMode: true, messageSlowMode: true,
      postGuidelines: true, defaultSortOrder: true, defaultReaction: true,
    },
  });
  if (!channel) return null;
  const [chOverrides, catOverrides] = await Promise.all([
    prisma.channelPermissionOverride.findMany({ where: { channelId }, take: 200 }),
    channel.categoryId
      ? prisma.categoryPermissionOverride.findMany({ where: { categoryId: channel.categoryId }, take: 200 })
      : Promise.resolve([]),
  ]);
  return { channel, chOverrides, catOverrides };
}

function formatAuthor(author: any) {
  if (!author) return { id: 'deleted', username: 'Deleted User', discriminator: '0000', avatar: null };
  return {
    id: author.id,
    username: author.username,
    discriminator: author.discriminator,
    avatar: author.avatar ?? null,
    nameColor: author.nameColor ?? null,
    nameFont: author.nameFont ?? null,
    nameEffect: author.nameEffect ?? null,
    stripePlan: getEffectivePlan(author),
    badges: applyBadgePrefs(author),
  };
}

async function checkSlowMode(key: string, seconds: number): Promise<{ allowed: boolean; retryAfter?: number }> {
  if (seconds <= 0) return { allowed: true };
  if (redis) {
    const result = await redis.set(key, '1', 'PX', seconds * 1000, 'NX');
    if (result === 'OK') return { allowed: true };
    const ttl = await redis.pttl(key);
    return { allowed: false, retryAfter: Math.ceil(Math.max(ttl, 0) / 1000) };
  }
  // No Redis — allow (single-instance fallback; not worth in-memory map for forum slow mode)
  return { allowed: true };
}

// GET /servers/:serverId/channels/:channelId/posts

router.get('/:serverId/channels/:channelId/posts', validateUuidParams('serverId', 'channelId'), authenticateToken, forumReadLimiter, validate(forumPostListQuery), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });
  if (result.channel.type !== 'forum') return res.status(400).json({ error: 'Channel is not a forum' });

  if (result.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', result.chOverrides, result.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const { before, sortBy, tagId } = req.query as unknown as { before?: string; sortBy: string; tagId?: string };
  const limit = Math.min(Number(req.query.limit) || 20, 50);

  const where: any = { channelId };
  if (before) {
    const cursor = sortBy === 'creation_date'
      ? await prisma.forumPost.findUnique({ where: { id: before }, select: { createdAt: true } })
      : await prisma.forumPost.findUnique({ where: { id: before }, select: { lastActivityAt: true } });
    if (cursor) {
      const ts = sortBy === 'creation_date' ? (cursor as any).createdAt : (cursor as any).lastActivityAt;
      where[sortBy === 'creation_date' ? 'createdAt' : 'lastActivityAt'] = { lt: ts };
    }
  }
  if (tagId) {
    where.tags = { some: { tagId } };
  }

  // Fetch pinned + non-pinned separately for correct ordering
  const [pinnedPosts, regularPosts] = await Promise.all([
    !before ? prisma.forumPost.findMany({
      where: { ...where, pinned: true },
      orderBy: { lastActivityAt: 'desc' },
      take: 10,
      include: { tags: { include: { tag: true }, take: 5 } },
    }) : Promise.resolve([]),
    prisma.forumPost.findMany({
      where: { ...where, pinned: false },
      orderBy: sortBy === 'creation_date' ? { createdAt: 'desc' } : { lastActivityAt: 'desc' },
      take: limit,
      include: { tags: { include: { tag: true }, take: 5 } },
    }),
  ]);

  const allPosts = before ? regularPosts : [...pinnedPosts, ...regularPosts];
  const authorIds = [...new Set(allPosts.map(p => p.authorId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT })
    : [];
  const authorMap = Object.fromEntries(authors.map(u => [u.id, u]));

  const posts = allPosts.map(p => ({
    id: p.id,
    channelId: p.channelId,
    title: p.title,
    content: p.content.length > 200 ? p.content.slice(0, 200) + '...' : p.content,
    imageUrl: p.imageUrl,
    pinned: p.pinned,
    locked: p.locked,
    lastActivityAt: p.lastActivityAt.toISOString(),
    messageCount: p.messageCount,
    createdAt: p.createdAt.toISOString(),
    author: formatAuthor(authorMap[p.authorId]),
    tags: p.tags.map(t => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color, emoji: t.tag.emoji })),
  }));

  const hasMore = regularPosts.length >= limit;

  res.json({ posts, hasMore });
}));

// GET /servers/:serverId/channels/:channelId/posts/:postId

router.get('/:serverId/channels/:channelId/posts/:postId', validateUuidParams('serverId', 'channelId', 'postId'), authenticateToken, forumReadLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });
  if (result.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', result.chOverrides, result.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'readMessageHistory', result.chOverrides, result.catOverrides)) {
    return res.status(403).json({ error: 'You do not have permission to read message history' });
  }

  const post = await prisma.forumPost.findFirst({
    where: { id: postId, channelId },
    include: { tags: { include: { tag: true }, take: 5 } },
  });
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const author = await prisma.user.findUnique({ where: { id: post.authorId }, select: AUTHOR_USER_SELECT });

  res.json({
    post: {
      id: post.id,
      channelId: post.channelId,
      title: post.title,
      content: post.content,
      imageUrl: post.imageUrl,
      pinned: post.pinned,
      locked: post.locked,
      lastActivityAt: post.lastActivityAt.toISOString(),
      messageCount: post.messageCount,
      createdAt: post.createdAt.toISOString(),
      author: formatAuthor(author),
      tags: post.tags.map(t => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color, emoji: t.tag.emoji })),
    },
  });
}));

// POST /servers/:serverId/channels/:channelId/posts

router.post('/:serverId/channels/:channelId/posts', validateUuidParams('serverId', 'channelId'), authenticateToken, forumPostLimiter, validate(createForumPostSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });
  if (result.channel.type !== 'forum') return res.status(400).json({ error: 'Channel is not a forum' });

  if (result.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', result.chOverrides, result.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'createPosts', result.chOverrides, result.catOverrides)) {
    return res.status(403).json({ error: 'You do not have permission to create posts' });
  }

  const { title, content, imageUrl, tagIds } = req.body as { title: string; content: string; imageUrl?: string; tagIds?: string[] };

  // Validate imageUrl is a server upload path
  if (imageUrl && !/^\/api\/uploads\//.test(imageUrl)) {
    return res.status(400).json({ error: 'Image URL must be a server upload path' });
  }
  // Refuse an encrypted (scan-skipped) DM blob on this plaintext,
  // multi-recipient forum surface. Fail-closed on a provenance lookup error.
  {
    const att = await checkUploadAttachment(imageUrl);
    if (!att.ok) return res.status(att.status).json({ error: att.error });
  }

  // Enforce requireTags
  if (result.channel.requireTags && (!tagIds || tagIds.length === 0)) {
    return res.status(400).json({ error: 'This forum requires at least one tag on posts' });
  }

  // Enforce postSlowMode
  if (result.channel.postSlowMode > 0) {
    const smResult = await checkSlowMode(`forum:slowmode:post:${channelId}:${req.userId}`, result.channel.postSlowMode);
    if (!smResult.allowed) {
      return res.status(429).json({ error: `Please wait ${smResult.retryAfter}s before creating another post`, retryAfter: smResult.retryAfter });
    }
  }

  // Validate tags belong to this channel
  let validTagIds: string[] = [];
  if (tagIds && tagIds.length > 0) {
    const tags = await prisma.forumTag.findMany({
      where: { id: { in: tagIds }, channelId },
      select: { id: true },
      take: 5,
    });
    validTagIds = tags.map(t => t.id);
    if (result.channel.requireTags && validTagIds.length === 0) {
      return res.status(400).json({ error: 'None of the provided tags are valid for this channel' });
    }
  }

  const post = await prisma.forumPost.create({
    data: {
      channelId,
      authorId: req.userId,
      title,
      content,
      imageUrl: imageUrl ?? null,
      tags: validTagIds.length > 0
        ? { create: validTagIds.map(tagId => ({ tagId })) }
        : undefined,
    },
    include: { tags: { include: { tag: true }, take: 5 } },
  });

  const author = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });

  const postPayload = {
    id: post.id,
    channelId: post.channelId,
    title: post.title,
    content: post.content,
    imageUrl: post.imageUrl,
    pinned: post.pinned,
    locked: post.locked,
    lastActivityAt: post.lastActivityAt.toISOString(),
    messageCount: post.messageCount,
    createdAt: post.createdAt.toISOString(),
    author: formatAuthor(author),
    tags: post.tags.map(t => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color, emoji: t.tag.emoji })),
  };

  const io = req.app.get('io');
  // Emit to the channel room (permission-gated by `join-channel`) instead of
  // the server room (which broadcasts to every server member regardless of
  // channel-level viewChannels override).
  if (io) io.to(`channel:${channelId}`).emit('forum-post-created', { serverId, channelId, post: postPayload });
  res.status(201).json(postPayload);
}));

// PATCH /servers/:serverId/channels/:channelId/posts/:postId

router.patch('/:serverId/channels/:channelId/posts/:postId', validateUuidParams('serverId', 'channelId', 'postId'), authenticateToken, forumMutateLimiter, validate(updateForumPostSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });

  const post = await prisma.forumPost.findFirst({ where: { id: postId, channelId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const isModerator = hasChannelPermission(permCtx,'managePosts', result.chOverrides, result.catOverrides);
  const isAuthor = post.authorId === req.userId;
  if (!isAuthor && !isModerator) return res.status(403).json({ error: 'Not authorized to edit this post' });
  if (post.locked && !isModerator) return res.status(403).json({ error: 'This post is locked' });

  const { title, content, imageUrl, pinned, locked, tagIds } = req.body as Record<string, any>;
  const data: Record<string, unknown> = {};

  if (typeof title === 'string') data.title = title;
  if (typeof content === 'string') data.content = content;
  if (Object.prototype.hasOwnProperty.call(req.body, 'imageUrl')) {
    if (imageUrl && !/^\/api\/uploads\//.test(imageUrl)) {
      return res.status(400).json({ error: 'Image URL must be a server upload path' });
    }
    // Refuse an encrypted (scan-skipped) DM blob here too.
    const att = await checkUploadAttachment(imageUrl);
    if (!att.ok) return res.status(att.status).json({ error: att.error });
    data.imageUrl = imageUrl ?? null;
  }
  // Only moderators can pin/lock
  if (typeof pinned === 'boolean' && isModerator) data.pinned = pinned;
  if (typeof locked === 'boolean' && isModerator) data.locked = locked;

  // Handle tag updates
  if (Array.isArray(tagIds)) {
    const validTags = await prisma.forumTag.findMany({
      where: { id: { in: tagIds }, channelId },
      select: { id: true },
      take: 5,
    });
    await prisma.forumPostTag.deleteMany({ where: { postId } });
    if (validTags.length > 0) {
      await prisma.forumPostTag.createMany({
        data: validTags.map(t => ({ postId, tagId: t.id })),
      });
    }
  }

  if (Object.keys(data).length === 0 && !Array.isArray(tagIds)) {
    return res.json({ id: post.id });
  }

  const updated = Object.keys(data).length > 0
    ? await prisma.forumPost.update({ where: { id: postId }, data, include: { tags: { include: { tag: true }, take: 5 } } })
    : await prisma.forumPost.findFirst({ where: { id: postId }, include: { tags: { include: { tag: true }, take: 5 } } });
  if (!updated) return res.status(404).json({ error: 'Post not found' });

  const author = await prisma.user.findUnique({ where: { id: updated.authorId }, select: AUTHOR_USER_SELECT });
  const postPayload = {
    id: updated.id,
    channelId: updated.channelId,
    title: updated.title,
    content: updated.content,
    imageUrl: updated.imageUrl,
    pinned: updated.pinned,
    locked: updated.locked,
    lastActivityAt: updated.lastActivityAt.toISOString(),
    messageCount: updated.messageCount,
    createdAt: updated.createdAt.toISOString(),
    author: formatAuthor(author),
    tags: updated.tags.map((t: any) => ({ id: t.tag.id, name: t.tag.name, color: t.tag.color, emoji: t.tag.emoji })),
  };

  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-post-updated', { serverId, channelId, post: postPayload });
  res.json(postPayload);
}));

// DELETE /servers/:serverId/channels/:channelId/posts/:postId

router.delete('/:serverId/channels/:channelId/posts/:postId', validateUuidParams('serverId', 'channelId', 'postId'), authenticateToken, forumMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });

  const post = await prisma.forumPost.findFirst({ where: { id: postId, channelId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const isModerator = hasChannelPermission(permCtx,'managePosts', result.chOverrides, result.catOverrides);
  if (post.authorId !== req.userId && !isModerator) {
    return res.status(403).json({ error: 'Not authorized to delete this post' });
  }

  // Clean up uploaded images
  if (post.imageUrl) deleteUploadedFile(post.imageUrl).catch(() => {});
  const attachments = await prisma.forumMessage.findMany({
    where: { forumPostId: postId, attachmentUrl: { not: null } },
    select: { attachmentUrl: true },
    take: 5000,
  });
  for (const a of attachments) {
    if (a.attachmentUrl) deleteUploadedFile(a.attachmentUrl).catch(() => {});
  }

  // Cascade deletes ForumMessages, ForumPostTags, ForumMessageReactions
  await prisma.forumPost.delete({ where: { id: postId } });

  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-post-deleted', { serverId, channelId, postId });
  res.json({ success: true });
}));

// POST /servers/:serverId/channels/:channelId/posts/:postId/messages

router.post('/:serverId/channels/:channelId/posts/:postId/messages', validateUuidParams('serverId', 'channelId', 'postId'), authenticateToken, forumMsgLimiter, validate(createForumMessageSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });

  if (!hasChannelPermission(permCtx,'sendMessagesInPosts', result.chOverrides, result.catOverrides)) {
    return res.status(403).json({ error: 'You do not have permission to send messages in posts' });
  }

  const post = await prisma.forumPost.findFirst({ where: { id: postId, channelId } });
  if (!post) return res.status(404).json({ error: 'Post not found' });
  if (post.locked) return res.status(403).json({ error: 'This post is locked' });

  // Enforce messageSlowMode
  if (result.channel.messageSlowMode > 0) {
    const smResult = await checkSlowMode(`forum:slowmode:msg:${postId}:${req.userId}`, result.channel.messageSlowMode);
    if (!smResult.allowed) {
      return res.status(429).json({ error: `Please wait ${smResult.retryAfter}s before sending another message`, retryAfter: smResult.retryAfter });
    }
  }

  const { content, attachmentUrl, attachmentName, attachmentContentType, attachmentWidth, attachmentHeight } = req.body as Record<string, any>;

  if (attachmentUrl && !/^\/api\/uploads\//.test(attachmentUrl)) {
    return res.status(400).json({ error: 'Attachment URL must be a server upload path' });
  }
  // Refuse an encrypted (scan-skipped) DM blob on this forum surface.
  {
    const att = await checkUploadAttachment(attachmentUrl);
    if (!att.ok) return res.status(att.status).json({ error: att.error });
  }

  const [message] = await prisma.$transaction([
    prisma.forumMessage.create({
      data: {
        forumPostId: postId,
        authorId: req.userId,
        content,
        attachmentUrl: attachmentUrl ?? null,
        attachmentName: attachmentName ?? null,
        attachmentContentType: attachmentContentType ?? null,
        attachmentWidth: attachmentWidth ?? null,
        attachmentHeight: attachmentHeight ?? null,
      },
    }),
    prisma.forumPost.update({
      where: { id: postId },
      data: { messageCount: { increment: 1 }, lastActivityAt: new Date() },
    }),
  ]);

  const author = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });

  const msgPayload = {
    id: message.id,
    authorId: message.authorId,
    forumPostId: message.forumPostId,
    content: message.content,
    attachmentUrl: message.attachmentUrl,
    attachmentName: message.attachmentName,
    attachmentContentType: message.attachmentContentType,
    attachmentWidth: message.attachmentWidth,
    attachmentHeight: message.attachmentHeight,
    createdAt: message.createdAt.toISOString(),
    editedAt: null,
    author: formatAuthor(author),
    reactions: [],
  };

  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-message-created', { serverId, channelId, postId, message: msgPayload });
  res.status(201).json(msgPayload);
}));

// GET /servers/:serverId/channels/:channelId/posts/:postId/messages

router.get('/:serverId/channels/:channelId/posts/:postId/messages', validateUuidParams('serverId', 'channelId', 'postId'), authenticateToken, forumReadLimiter, validate(forumMessageListQuery), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });

  if (!hasChannelPermission(permCtx,'readMessageHistory', result.chOverrides, result.catOverrides)) {
    return res.status(403).json({ error: 'You do not have permission to read message history' });
  }

  const post = await prisma.forumPost.findFirst({ where: { id: postId, channelId }, select: { id: true } });
  if (!post) return res.status(404).json({ error: 'Post not found' });

  const before = req.query.before as string | undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const where: any = { forumPostId: postId };
  if (before) {
    const cursor = await prisma.forumMessage.findUnique({ where: { id: before }, select: { createdAt: true } });
    if (cursor) where.createdAt = { lt: cursor.createdAt };
  }

  const messages = await prisma.forumMessage.findMany({
    where,
    orderBy: { createdAt: 'desc' },
    take: limit + 1,
    include: { reactions: { take: 100 } },
  });

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();
  messages.reverse();

  const authorIds = [...new Set(messages.map(m => m.authorId))];
  const authors = authorIds.length
    ? await prisma.user.findMany({ where: { id: { in: authorIds } }, select: AUTHOR_USER_SELECT })
    : [];
  const authorMap = Object.fromEntries(authors.map(u => [u.id, u]));

  const formatted = messages.map(m => {
    const reactionGroups: Array<{ emoji: string; userIds: string[] }> = [];
    for (const r of m.reactions) {
      const existing = reactionGroups.find(g => g.emoji === r.emoji);
      if (existing) existing.userIds.push(r.userId);
      else reactionGroups.push({ emoji: r.emoji, userIds: [r.userId] });
    }
    return {
      id: m.id,
      authorId: m.authorId,
      forumPostId: m.forumPostId,
      content: m.content,
      attachmentUrl: m.attachmentUrl,
      attachmentName: m.attachmentName,
      attachmentContentType: m.attachmentContentType,
      attachmentWidth: m.attachmentWidth,
      attachmentHeight: m.attachmentHeight,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      author: formatAuthor(authorMap[m.authorId]),
      reactions: reactionGroups,
    };
  });

  res.json({ messages: formatted, hasMore });
}));

// PATCH /servers/:serverId/channels/:channelId/posts/:postId/messages/:messageId

router.patch('/:serverId/channels/:channelId/posts/:postId/messages/:messageId', validateUuidParams('serverId', 'channelId', 'postId', 'messageId'), authenticateToken, forumMutateLimiter, validate(updateForumMessageSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');
  const messageId = getParam(req, 'messageId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  // Verify channel-level viewChannels before allowing edit on a private channel.
  // Without this, a user with `viewChannels` denied by override could still PATCH
  // messages they authored while membership was permitted.
  const chResult = await fetchChannelWithOverrides(channelId, serverId);
  if (!chResult) return res.status(404).json({ error: 'Channel not found' });
  if (chResult.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chResult.chOverrides, chResult.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const message = await prisma.forumMessage.findFirst({ where: { id: messageId, forumPostId: postId } });
  if (!message) return res.status(404).json({ error: 'Message not found' });
  if (message.authorId !== req.userId) return res.status(403).json({ error: 'You can only edit your own messages' });

  const { content } = req.body as { content: string };
  const updated = await prisma.forumMessage.update({
    where: { id: messageId },
    data: { content, editedAt: new Date() },
  });

  const author = await prisma.user.findUnique({ where: { id: req.userId }, select: AUTHOR_USER_SELECT });
  const msgPayload = {
    id: updated.id,
    authorId: updated.authorId,
    forumPostId: updated.forumPostId,
    content: updated.content,
    createdAt: updated.createdAt.toISOString(),
    editedAt: updated.editedAt?.toISOString() ?? null,
    author: formatAuthor(author),
  };

  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-message-updated', { serverId, channelId, postId, message: msgPayload });
  res.json(msgPayload);
}));

// DELETE /servers/:serverId/channels/:channelId/posts/:postId/messages/:messageId

router.delete('/:serverId/channels/:channelId/posts/:postId/messages/:messageId', validateUuidParams('serverId', 'channelId', 'postId', 'messageId'), authenticateToken, forumMutateLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');
  const messageId = getParam(req, 'messageId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  const result = await fetchChannelWithOverrides(channelId, serverId);
  if (!result) return res.status(404).json({ error: 'Channel not found' });
  // viewChannels gate — deny-by-override on the channel must block deletes
  // even for messages the user originally authored while they had access.
  if (result.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', result.chOverrides, result.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const message = await prisma.forumMessage.findFirst({ where: { id: messageId, forumPostId: postId } });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const canManage = hasChannelPermission(permCtx,'manageMessages', result.chOverrides, result.catOverrides);
  if (message.authorId !== req.userId && !canManage) {
    return res.status(403).json({ error: 'Not authorized to delete this message' });
  }

  if (message.attachmentUrl) deleteUploadedFile(message.attachmentUrl).catch(() => {});

  const post = await prisma.forumPost.findUnique({ where: { id: postId }, select: { messageCount: true } });
  await prisma.$transaction([
    prisma.forumMessage.delete({ where: { id: messageId } }),
    prisma.forumPost.update({ where: { id: postId }, data: { messageCount: Math.max(0, (post?.messageCount ?? 1) - 1) } }),
  ]);

  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-message-deleted', { serverId, channelId, postId, messageId });
  res.json({ success: true });
}));

// POST /servers/:serverId/channels/:channelId/posts/:postId/messages/:messageId/reactions

router.post('/:serverId/channels/:channelId/posts/:postId/messages/:messageId/reactions', validateUuidParams('serverId', 'channelId', 'postId', 'messageId'), authenticateToken, forumReactionLimiter, validate(forumReactionSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');
  const messageId = getParam(req, 'messageId');

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  // Verify viewChannels + addReactions with channel-level overrides before
  // allowing a reaction. Without this, a user denied `viewChannels` on a private
  // forum channel could POST reactions to a channel they can no longer see.
  const chResult = await fetchChannelWithOverrides(channelId, serverId);
  if (!chResult) return res.status(404).json({ error: 'Channel not found' });
  if (chResult.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chResult.chOverrides, chResult.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }
  if (!hasChannelPermission(permCtx,'addReactions', chResult.chOverrides, chResult.catOverrides)) {
    return res.status(403).json({ error: 'You do not have permission to add reactions' });
  }

  const message = await prisma.forumMessage.findFirst({
    where: { id: messageId, forumPostId: postId, forumPost: { channelId } },
    select: { id: true },
  });
  if (!message) return res.status(404).json({ error: 'Message not found' });

  const { emoji } = req.body as { emoji: string };

  // Check max reactions per message per user
  const existingCount = await prisma.forumMessageReaction.count({
    where: { messageId, userId: req.userId },
  });
  if (existingCount >= 20) return res.status(400).json({ error: 'Maximum reactions per message reached' });

  try {
    await prisma.forumMessageReaction.create({
      data: { messageId, userId: req.userId, emoji },
    });
  } catch (err: any) {
    if (err.code === 'P2002') return res.status(409).json({ error: 'Already reacted with this emoji' });
    throw err;
  }

  const allReactions = await prisma.forumMessageReaction.findMany({
    where: { messageId },
    select: { emoji: true, userId: true },
    take: 200,
  });
  const reactionGroups: Array<{ emoji: string; userIds: string[] }> = [];
  for (const r of allReactions) {
    const existing = reactionGroups.find(g => g.emoji === r.emoji);
    if (existing) existing.userIds.push(r.userId);
    else reactionGroups.push({ emoji: r.emoji, userIds: [r.userId] });
  }

  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-reaction-added', { serverId, channelId, postId, messageId, emoji, userId: req.userId });
  res.status(201).json({ success: true, reactions: reactionGroups });
}));

// DELETE /servers/:serverId/channels/:channelId/posts/:postId/messages/:messageId/reactions/:emoji

router.delete('/:serverId/channels/:channelId/posts/:postId/messages/:messageId/reactions/:emoji', validateUuidParams('serverId', 'channelId', 'postId', 'messageId'), authenticateToken, forumReactionLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const serverId = getParam(req, 'serverId');
  const messageId = getParam(req, 'messageId');
  const emoji = decodeURIComponent(String(req.params.emoji ?? ''));
  if (!emoji || emoji.length > 64) return res.status(400).json({ error: 'Invalid emoji' });

  const [member, permCtx] = await Promise.all([
    prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: req.userId, serverId } },
      include: { serverRole: true },
    }),
    loadPermissionContext(req.userId, serverId),
  ]);
  if (!member || !permCtx) return res.status(403).json({ error: 'Not a member of this server' });

  // Verify channel-level viewChannels before allowing reaction removal.
  // A user who lost `viewChannels` via override should not be able to mutate
  // state in a channel they can no longer see.
  const channelIdForPerm = getParam(req, 'channelId');
  const chResult = await fetchChannelWithOverrides(channelIdForPerm, serverId);
  if (!chResult) return res.status(404).json({ error: 'Channel not found' });
  if (chResult.channel.isPrivate && !hasChannelPermission(permCtx,'viewChannels', chResult.chOverrides, chResult.catOverrides, undefined, { requireOverride: true })) {
    return res.status(404).json({ error: 'Channel not found' });
  }

  const reaction = await prisma.forumMessageReaction.findFirst({
    where: { messageId, userId: req.userId, emoji },
  });
  if (!reaction) return res.status(404).json({ error: 'Reaction not found' });

  await prisma.forumMessageReaction.delete({ where: { id: reaction.id } });

  const channelId = getParam(req, 'channelId');
  const postId = getParam(req, 'postId');
  const io = req.app.get('io');
  if (io) io.to(`channel:${channelId}`).emit('forum-reaction-removed', { serverId, channelId, postId, messageId, emoji, userId: req.userId });
  res.json({ success: true });
}));

export default router;
