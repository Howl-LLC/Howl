// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Tests for forum write routes that must enforce channel permissions.
 *
 * Without the fix, a member with `viewChannels` denied on a private forum
 * channel could still POST reactions, DELETE reactions, and PATCH their own
 * messages. This suite pins the fix.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

describe('forum — channel-permission enforcement on write routes', () => {
  let owner: TestUser;
  let stranger: TestUser;
  let serverId: string;
  let forumChannelId: string;
  let postId: string;
  let messageId: string;

  beforeAll(async () => {
    owner = await createTestUser();
    stranger = await createTestUser();

    const server = await createTestServer(owner.id);
    serverId = server.id;

    // Add stranger as a server member (so membership check passes)
    await prisma.serverMember.create({
      data: { userId: stranger.id, serverId, role: 'member' },
    });

    // Create a PRIVATE forum channel
    const cat = await prisma.channelCategory.findFirst({ where: { serverId } });
    const forumChannel = await prisma.channel.create({
      data: {
        id: randomUUID(),
        name: 'private-forum',
        type: 'forum',
        serverId,
        categoryId: cat?.id ?? null,
        position: 0,
        isPrivate: true,
      },
    });
    forumChannelId = forumChannel.id;

    // Explicit deny for `viewChannels` on stranger
    await prisma.channelPermissionOverride.create({
      data: {
        channelId: forumChannelId,
        targetType: 'member',
        targetId: stranger.id,
        permissions: { viewChannels: false } as any,
      },
    });

    // Seed a post + message authored by the stranger BEFORE they were locked out,
    // so we can test that "author owns this record" alone doesn't bypass the gate.
    const post = await prisma.forumPost.create({
      data: {
        id: randomUUID(),
        channelId: forumChannelId,
        authorId: stranger.id,
        title: 'seed post',
        content: 'seed',
      },
    });
    postId = post.id;
    const msg = await prisma.forumMessage.create({
      data: {
        id: randomUUID(),
        forumPostId: postId,
        authorId: stranger.id,
        content: 'seed message',
      },
    });
    messageId = msg.id;
  });

  afterAll(cleanupTestData);

  it('POST reaction is blocked when viewChannels is denied', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverId}/channels/${forumChannelId}/posts/${postId}/messages/${messageId}/reactions`)
      .set('Authorization', authHeader(stranger.token))
      .send({ emoji: '👍' });
    expect(res.status).toBe(404);
  });

  it('PATCH own message is blocked when viewChannels is denied', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverId}/channels/${forumChannelId}/posts/${postId}/messages/${messageId}`)
      .set('Authorization', authHeader(stranger.token))
      .send({ content: 'tampered' });
    expect(res.status).toBe(404);
  });

  it('DELETE reaction is blocked when viewChannels is denied', async () => {
    const res = await request(app)
      .delete(`/api/v1/servers/${serverId}/channels/${forumChannelId}/posts/${postId}/messages/${messageId}/reactions/${encodeURIComponent('👍')}`)
      .set('Authorization', authHeader(stranger.token));
    expect(res.status).toBe(404);
  });

  it('DELETE own message is blocked when viewChannels is denied', async () => {
    const res = await request(app)
      .delete(`/api/v1/servers/${serverId}/channels/${forumChannelId}/posts/${postId}/messages/${messageId}`)
      .set('Authorization', authHeader(stranger.token));
    expect(res.status).toBe(404);
  });

  it('owner can still read the post (control: access intact for allowed users)', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${serverId}/channels/${forumChannelId}/posts/${postId}`)
      .set('Authorization', authHeader(owner.token));
    expect(res.status).toBe(200);
  });
});
