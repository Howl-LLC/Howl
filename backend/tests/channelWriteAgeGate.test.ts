// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Write-path age gate — thread / poll / forum writes into an age-restricted
 * channel must apply the same per-channel age drop that `messages.ts` enforces
 * via `denyIfAgeGated`.
 *
 * The read-path batch (d680df3a) closed the READ leak; this batch closes the
 * matching WRITE leaks. Two classes are covered:
 *
 *  1. PARTICIPATE-writes (mirror messages.ts send): create a thread, post a
 *     thread message, create a poll, vote in a poll, create a forum post, post
 *     a forum message. Before the fix a minor could produce content in an
 *     age-restricted channel's threads/polls/forum even though the main-channel
 *     send was 403'd.
 *
 *  2. MODERATOR-capable PATCH handlers that ECHO stored 18+ content back in the
 *     response — forum-post PATCH (title+content), thread PATCH (name), poll
 *     PATCH (question+options). These are the pin/lock/edit-others path (like
 *     messages.ts pin/unpin, which ARE age-gated), so a minor moderator could
 *     retrieve the 18+ content the read gate blocks on GET, and edit others'
 *     18+ content. (forum-MESSAGE PATCH is author-only + self-supplied content,
 *     so it is safe and intentionally NOT gated — same as messages.ts message
 *     edit.)
 *
 * The scenario is deliberately a PUBLIC age-restricted channel so the channel
 * visibility gate (`assertChannelVisible`) passes for everyone and ONLY the age
 * gate distinguishes the minor (403 `age_restricted`) from the adult (2xx) —
 * isolating the fix from the existing private-channel visibility gate. The
 * minor is granted managePosts + manageMessages so they reach the moderator
 * PATCH path (the strongest form of the leak).
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
  createPosts: true,
  sendMessagesInPosts: true,
  // Moderator perms so the minor reaches the pin/lock/edit-others PATCH path.
  manageMessages: true,
  managePosts: true,
};

type Method = 'post' | 'patch';
type Write = readonly [label: string, method: Method, path: string, body: Record<string, unknown>];

describe('Write-path age gate — thread / poll / forum writes', () => {
  let owner: TestUser; // adult (helper default DOB 2000-01-15) — authors the seed content
  let adult: TestUser; // explicit adult DOB, plain member (also a moderator via @everyone)
  let minor: TestUser; // 14 today, member + moderator via @everyone

  let s: string;
  let safeTextId: string; // public text, ageRestricted=false (scoping control)
  let arTextId: string; // public text, ageRestricted=true
  let safeForumId: string; // public forum, ageRestricted=false
  let arForumId: string; // public forum, ageRestricted=true

  // Participate-write fixtures (shared: minor is denied → never mutates them).
  let parentMinorAr: string;
  let parentAdultAr: string;
  let parentMinorSafe: string;
  let arThreadId: string;
  let safeThreadId: string;
  let arPollId: string;
  let arPollOptionId: string;
  let safePollId: string;
  let safePollOptionId: string;
  let arPostId: string;
  let safePostId: string;

  // Dedicated PATCH fixtures (authored by owner; the adult/minor moderator PATCH
  // mutates these, so they are kept separate from the participate-write ones).
  let arThreadPatchId: string;
  let safeThreadPatchId: string;
  let arPollPatchId: string;
  let safePollPatchId: string;
  let arPostPatchId: string;
  let safePostPatchId: string;

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

    safeTextId = (await mkChannel('safe-text', 'text', false)).id;
    arTextId = (await mkChannel('ar-text', 'text', true)).id;
    safeForumId = (await mkChannel('safe-forum', 'forum', false)).id;
    arForumId = (await mkChannel('ar-forum', 'forum', true)).id;

    const mkMsg = (channelId: string) =>
      prisma.message.create({ data: { channelId, authorId: owner.id, content: 'PARENT' } });
    const mkThread = (channelId: string, parentId: string, name: string) =>
      prisma.thread.create({ data: { channelId, serverId: s, parentMessageId: parentId, name, authorId: owner.id } });
    const mkPoll = (channelId: string, question: string) =>
      prisma.poll.create({
        data: {
          channelId, serverId: s, authorId: owner.id, question,
          options: { create: [{ text: 'yes', position: 0 }, { text: 'no', position: 1 }] },
        },
        include: { options: true },
      });
    const mkPost = (channelId: string, title: string, content: string) =>
      prisma.forumPost.create({ data: { channelId, authorId: owner.id, title, content } });

    // --- participate-write fixtures ---
    parentMinorAr = (await mkMsg(arTextId)).id;
    parentAdultAr = (await mkMsg(arTextId)).id;
    parentMinorSafe = (await mkMsg(safeTextId)).id;

    arThreadId = (await mkThread(arTextId, (await mkMsg(arTextId)).id, 'ADULT-THREAD')).id;
    safeThreadId = (await mkThread(safeTextId, (await mkMsg(safeTextId)).id, 'SAFE-THREAD')).id;

    const arPoll = await mkPoll(arTextId, 'ADULT-POLL');
    arPollId = arPoll.id;
    arPollOptionId = arPoll.options[0].id;
    const safePoll = await mkPoll(safeTextId, 'SAFE-POLL');
    safePollId = safePoll.id;
    safePollOptionId = safePoll.options[0].id;

    arPostId = (await mkPost(arForumId, 'ADULT-POST', 'ADULT-POSTBODY')).id;
    safePostId = (await mkPost(safeForumId, 'SAFE-POST', 'SAFE-POSTBODY')).id;

    // --- dedicated PATCH fixtures (18+ markers to assert non-echo) ---
    arThreadPatchId = (await mkThread(arTextId, (await mkMsg(arTextId)).id, 'ADULT-PATCH-THREAD')).id;
    safeThreadPatchId = (await mkThread(safeTextId, (await mkMsg(safeTextId)).id, 'SAFE-PATCH-THREAD')).id;
    arPollPatchId = (await mkPoll(arTextId, 'ADULT-PATCH-POLL')).id;
    safePollPatchId = (await mkPoll(safeTextId, 'SAFE-PATCH-POLL')).id;
    arPostPatchId = (await mkPost(arForumId, 'ADULT-PATCH-POST', 'ADULT-PATCH-POSTBODY')).id;
    safePostPatchId = (await mkPost(safeForumId, 'SAFE-PATCH-POST', 'SAFE-PATCH-POSTBODY')).id;
  });

  afterAll(cleanupTestData);

  // Participate-writes into the AGE-RESTRICTED channels. `who` only affects
  // thread-create (needs a per-principal parent to avoid a 409).
  const arWrites = (who: 'minor' | 'adult'): Write[] => [
    ['thread-create', 'post', `/api/v1/servers/${s}/channels/${arTextId}/threads`, { name: 'T', parentMessageId: who === 'minor' ? parentMinorAr : parentAdultAr }],
    ['thread-msg', 'post', `/api/v1/servers/${s}/threads/${arThreadId}/messages`, { content: 'hello' }],
    ['poll-create', 'post', `/api/v1/servers/${s}/channels/${arTextId}/polls`, { question: 'Q?', options: ['a', 'b'] }],
    ['poll-vote', 'post', `/api/v1/servers/${s}/channels/${arTextId}/polls/${arPollId}/vote`, { optionId: arPollOptionId }],
    ['forum-post', 'post', `/api/v1/servers/${s}/channels/${arForumId}/posts`, { title: 'P', content: 'c' }],
    ['forum-msg', 'post', `/api/v1/servers/${s}/channels/${arForumId}/posts/${arPostId}/messages`, { content: 'hello' }],
  ];

  const safeWrites = (): Write[] => [
    ['thread-create', 'post', `/api/v1/servers/${s}/channels/${safeTextId}/threads`, { name: 'T', parentMessageId: parentMinorSafe }],
    ['thread-msg', 'post', `/api/v1/servers/${s}/threads/${safeThreadId}/messages`, { content: 'hello' }],
    ['poll-create', 'post', `/api/v1/servers/${s}/channels/${safeTextId}/polls`, { question: 'Q?', options: ['a', 'b'] }],
    ['poll-vote', 'post', `/api/v1/servers/${s}/channels/${safeTextId}/polls/${safePollId}/vote`, { optionId: safePollOptionId }],
    ['forum-post', 'post', `/api/v1/servers/${s}/channels/${safeForumId}/posts`, { title: 'P', content: 'c' }],
    ['forum-msg', 'post', `/api/v1/servers/${s}/channels/${safeForumId}/posts/${safePostId}/messages`, { content: 'hello' }],
  ];

  // Moderator-capable PATCH handlers that echo stored 18+ content. The bodies
  // touch ONLY moderator/action fields (pinned/archived/closePoll) so the leak
  // is via the response echo, not via content the caller supplied.
  const arPatchWrites = (): Write[] => [
    ['forum-post-PATCH', 'patch', `/api/v1/servers/${s}/channels/${arForumId}/posts/${arPostPatchId}`, { pinned: true }],
    ['thread-PATCH', 'patch', `/api/v1/servers/${s}/channels/${arTextId}/threads/${arThreadPatchId}`, { archived: true }],
    ['poll-PATCH', 'patch', `/api/v1/servers/${s}/channels/${arTextId}/polls/${arPollPatchId}`, { closePoll: true }],
  ];

  const safePatchWrites = (): Write[] => [
    ['forum-post-PATCH', 'patch', `/api/v1/servers/${s}/channels/${safeForumId}/posts/${safePostPatchId}`, { pinned: true }],
    ['thread-PATCH', 'patch', `/api/v1/servers/${s}/channels/${safeTextId}/threads/${safeThreadPatchId}`, { archived: true }],
    ['poll-PATCH', 'patch', `/api/v1/servers/${s}/channels/${safeTextId}/polls/${safePollPatchId}`, { closePoll: true }],
  ];

  const send = (who: TestUser, [, method, path, body]: Write) =>
    request(app)[method](path).set('Authorization', authHeader(who.token)).send(body);

  it('minor is denied (403 age_restricted) on every participate-write into an age-restricted channel', async () => {
    for (const w of arWrites('minor')) {
      const res = await send(minor, w);
      expect(res.status, `${w[0]} :: ${w[2]}`).toBe(403);
      expect(res.body.error, `${w[0]} :: ${w[2]}`).toBe('age_restricted');
    }
  });

  it('minor moderator is denied (403 age_restricted) on the content-echoing PATCH handlers, with no 18+ content leaked', async () => {
    for (const w of arPatchWrites()) {
      const res = await send(minor, w);
      expect(res.status, `${w[0]} :: ${w[2]}`).toBe(403);
      expect(res.body.error, `${w[0]} :: ${w[2]}`).toBe('age_restricted');
      expect(JSON.stringify(res.body), `${w[0]} leaked 18+ content`).not.toMatch(/ADULT-PATCH/);
    }
  });

  it('adult member is NOT over-restricted (2xx) on the same participate-writes and PATCH handlers', async () => {
    for (const w of [...arWrites('adult'), ...arPatchWrites()]) {
      const res = await send(adult, w);
      expect([200, 201, 204], `${w[0]} :: ${w[2]} (got ${res.status}: ${JSON.stringify(res.body)})`).toContain(res.status);
    }
  });

  it('minor writes to a non-age-restricted channel normally (gate is scoped, not blanket)', async () => {
    for (const w of [...safeWrites(), ...safePatchWrites()]) {
      const res = await send(minor, w);
      expect([200, 201, 204], `${w[0]} :: ${w[2]} (got ${res.status}: ${JSON.stringify(res.body)})`).toContain(res.status);
    }
  });
});
