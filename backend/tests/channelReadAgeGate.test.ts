// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Read-path age gate — thread / poll / forum content reads must apply the same
 * per-channel age drop that `messages.ts` enforces via `denyIfAgeGated`.
 *
 * Before this batch, a minor member of a server with a PUBLIC
 * `ageRestricted = true` channel was correctly 403'd on the main channel
 * message read, but still received 200 + full 18+ content via the sibling
 * thread / poll / forum read handlers — they gated only channel readability
 * (`assertChannelReadable` / inline `hasChannelPermission`) and never the age
 * gate. The three channel-load helpers did not even select `ageRestricted`.
 *
 * The scenario is deliberately a PUBLIC age-restricted channel so the channel
 * read gate passes for everyone and ONLY the age gate distinguishes the minor
 * (403 `age_restricted`) from the adult (200) — isolating the fix from the
 * existing private-channel visibility gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

const BASELINE_PERMS = {
  viewChannels: true,
  readMessageHistory: true,
  sendMessages: true,
  createThreads: true,
  sendMessagesInThreads: true,
  createPolls: true,
  addReactions: true,
  sendMessagesInPosts: true,
};

function expectAgeGated(res: { status: number; body: any }, label: string) {
  expect(res.status, label).toBe(403);
  expect(res.body.error, label).toBe('age_restricted');
  expect(JSON.stringify(res.body), `${label} leaked adult content`).not.toMatch(/ADULT-ONLY/);
}

describe('Read-path age gate — thread / poll / forum reads', () => {
  let owner: TestUser; // adult (helper default DOB 2000-01-15)
  let adult: TestUser; // explicit adult DOB
  let minor: TestUser; // 14 today
  let s: string;
  let safeTextId: string; // public, ageRestricted=false (scoping control)
  let arTextId: string; // public text, ageRestricted=true — holds thread + poll
  let arForumId: string; // public forum, ageRestricted=true — holds post
  let threadId: string;
  let pollId: string;
  let optionId: string;
  let postId: string;

  beforeAll(async () => {
    owner = await createTestUser();

    adult = await createTestUser();
    await prisma.user.update({ where: { id: adult.id }, data: { dateOfBirth: new Date('1990-01-01') } });

    minor = await createTestUser();
    const fourteenYearsAgo = new Date();
    fourteenYearsAgo.setUTCFullYear(fourteenYearsAgo.getUTCFullYear() - 14);
    await prisma.user.update({ where: { id: minor.id }, data: { dateOfBirth: fourteenYearsAgo } });

    const server = await createTestServer(owner.id);
    s = server.id;
    const categoryId = server.categories[0].id;

    await prisma.serverMember.create({ data: { userId: adult.id, serverId: s, role: 'member' } });
    await prisma.serverMember.create({ data: { userId: minor.id, serverId: s, role: 'member' } });
    await prisma.serverRole.create({
      data: { id: randomUUID(), serverId: s, name: '@everyone', position: 0, isEveryone: true, permissions: BASELINE_PERMS },
    });

    const mkChannel = (name: string, type: string, ageRestricted: boolean) =>
      prisma.channel.create({
        data: { id: randomUUID(), serverId: s, name, type, categoryId, position: 0, isPrivate: false, ageRestricted },
      });

    safeTextId = (await mkChannel('safe', 'text', false)).id;
    arTextId = (await mkChannel('ar-text', 'text', true)).id;
    arForumId = (await mkChannel('ar-forum', 'forum', true)).id;

    // Thread + poll in the age-restricted TEXT channel, authored by an adult.
    const parent = await prisma.message.create({ data: { channelId: arTextId, authorId: owner.id, content: 'PARENT' } });
    const thread = await prisma.thread.create({
      data: { channelId: arTextId, serverId: s, parentMessageId: parent.id, name: 'ADULT-ONLY-THREAD', authorId: owner.id },
    });
    threadId = thread.id;
    await prisma.threadMessage.create({ data: { threadId, authorId: owner.id, content: 'ADULT-ONLY-THREADMSG' } });

    const poll = await prisma.poll.create({
      data: {
        channelId: arTextId, serverId: s, authorId: owner.id, question: 'ADULT-ONLY-POLL',
        options: { create: [{ text: 'yes', position: 0 }, { text: 'no', position: 1 }] },
      },
      include: { options: true },
    });
    pollId = poll.id;
    optionId = poll.options[0].id;
    await prisma.pollVote.create({ data: { pollId, optionId, userId: owner.id } });

    // Forum post + message in the age-restricted FORUM channel, authored by an adult.
    const post = await prisma.forumPost.create({
      data: { channelId: arForumId, authorId: owner.id, title: 'ADULT-ONLY-POST', content: 'ADULT-ONLY-POSTBODY' },
    });
    postId = post.id;
    await prisma.forumMessage.create({ data: { forumPostId: postId, authorId: owner.id, content: 'ADULT-ONLY-FORUMMSG' } });
  });

  afterAll(cleanupTestData);

  // Every read handler that returns content authored in an age-restricted channel.
  const readEndpoints = () =>
    [
      ['thread list', `/api/v1/servers/${s}/channels/${arTextId}/threads`],
      ['thread detail', `/api/v1/servers/${s}/channels/${arTextId}/threads/${threadId}`],
      ['thread transcript', `/api/v1/servers/${s}/threads/${threadId}/messages`],
      ['poll list', `/api/v1/servers/${s}/channels/${arTextId}/polls`],
      ['poll single', `/api/v1/servers/${s}/channels/${arTextId}/polls/${pollId}`],
      ['poll voters', `/api/v1/servers/${s}/channels/${arTextId}/polls/${pollId}/options/${optionId}/voters`],
      ['forum post list', `/api/v1/servers/${s}/channels/${arForumId}/posts`],
      ['forum post detail', `/api/v1/servers/${s}/channels/${arForumId}/posts/${postId}`],
      ['forum messages', `/api/v1/servers/${s}/channels/${arForumId}/posts/${postId}/messages`],
    ] as const;

  it('minor is denied (403 age_restricted) on every age-restricted content read', async () => {
    for (const [label, path] of readEndpoints()) {
      const res = await request(app).get(path).set('Authorization', authHeader(minor.token));
      expectAgeGated(res, `${label} :: ${path}`);
    }
  });

  it('adult member is NOT over-restricted (200) on the same reads', async () => {
    for (const [label, path] of readEndpoints()) {
      const res = await request(app).get(path).set('Authorization', authHeader(adult.token));
      expect(res.status, `${label} :: ${path}`).toBe(200);
    }
  });

  it('minor reads a non-age-restricted channel normally (gate is scoped, not blanket)', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${s}/channels/${safeTextId}/threads`)
      .set('Authorization', authHeader(minor.token));
    expect(res.status).toBe(200);
  });
});
