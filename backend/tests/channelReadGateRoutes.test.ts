// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * table-driven 404/403 assertions for an ordinary
 * server member on every channel-content route across search / threads / polls /
 * forum / forumTags / stages. This is the regression test the audit called for —
 * "a table-driven test asserting 404/403 for the member on every channel-content
 * route would have caught all of this and would prevent the next instance."
 *
 * Fixture mirrors the security-audit fixture seeder:
 *  - `secret`      : private text  channel, member has NO viewChannels override
 *                    (relies on the @everyone baseline → the requireOverride case)
 *  - `secretForum` : private forum channel
 *  - `secretStage` : private stage channel
 *  - `denied`      : PUBLIC text channel, @everyone readMessageHistory = false
 *  - `general`     : public text channel (anti-over-restriction control)
 *
 * Member expectations: private channels → 404 (existence must not leak), the
 * override-denied public channel → 403 on reads, the public channel → 200.
 * Owner is the access-intact control (owner bypass → 200 everywhere).
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
  requestToSpeak: true,
  sendMessagesInPosts: true,
};

describe('channel read gate (route matrix)', () => {
  let owner: TestUser;
  let member: TestUser;
  let outsider: TestUser;
  let s: string;
  let generalId: string;
  let secretId: string;
  let secretForumId: string;
  let secretStageId: string;
  let deniedId: string;
  let deniedStageId: string;
  let secretThreadId: string;
  let secretThreadMsgId: string;
  let secretPollId: string;
  let secretPostId: string;
  let secretForumMsgId: string;
  let publicThreadId: string;
  let deniedThreadId: string;
  // Second server (owned by `outsider`) for the cross-tenant IDOR + override-grant tests.
  let attacker: TestUser;
  let vip: TestUser;
  let plain2: TestUser;
  let s2: string;
  let pubForum2Id: string;
  let s2SecretChannelId: string;
  let s2SecretThreadId: string;
  // vip-owned resources in override-granted private channels, for the
  // per-handler override-admission coverage (B6-T3).
  let s2SecretForumId: string;
  let s2VipPostId: string;
  let s2VipPollId: string;
  let s2VipThreadMsgId: string;
  const OPT = randomUUID();

  beforeAll(async () => {
    owner = await createTestUser();
    member = await createTestUser();
    outsider = await createTestUser();

    const server = await createTestServer(owner.id);
    s = server.id;
    generalId = server.channels[0].id;
    const categoryId = server.categories[0].id;

    await prisma.serverMember.create({ data: { userId: member.id, serverId: s, role: 'member' } });

    const everyone = await prisma.serverRole.create({
      data: { id: randomUUID(), serverId: s, name: '@everyone', position: 0, isEveryone: true, permissions: BASELINE_PERMS },
    });

    const mkChannel = (name: string, type: string, isPrivate: boolean) =>
      prisma.channel.create({ data: { id: randomUUID(), serverId: s, name, type, categoryId, position: 0, isPrivate } });

    secretId = (await mkChannel('secret', 'text', true)).id;
    secretForumId = (await mkChannel('secret-forum', 'forum', true)).id;
    secretStageId = (await mkChannel('secret-stage', 'stage', true)).id;
    deniedId = (await mkChannel('denied', 'text', false)).id;
    deniedStageId = (await mkChannel('denied-stage', 'stage', false)).id;

    // denied / denied-stage: public, but @everyone cannot read history. The stage
    // twin isolates visible-vs-readable: a member can VIEW (and join) it but not
    // read its history.
    await prisma.channelPermissionOverride.create({
      data: { channelId: deniedId, targetType: 'role', targetId: everyone.id, permissions: { readMessageHistory: false } as any },
    });
    await prisma.channelPermissionOverride.create({
      data: { channelId: deniedStageId, targetType: 'role', targetId: everyone.id, permissions: { readMessageHistory: false } as any },
    });

    // Content owned by the owner (the member must never reach it).
    const secretMsg = await prisma.message.create({ data: { channelId: secretId, authorId: owner.id, content: 'SECRET-CANARY' } });
    const deniedMsg = await prisma.message.create({ data: { channelId: deniedId, authorId: owner.id, content: 'DENIED-CANARY' } });
    const publicMsg = await prisma.message.create({ data: { channelId: generalId, authorId: owner.id, content: 'PUBLIC-PARENT' } });
    const secretThread = await prisma.thread.create({
      data: { channelId: secretId, serverId: s, parentMessageId: secretMsg.id, name: 'secret thread', authorId: owner.id },
    });
    secretThreadId = secretThread.id;
    const secretThreadMsg = await prisma.threadMessage.create({ data: { threadId: secretThreadId, authorId: owner.id, content: 'THREAD-SECRET-CANARY' } });
    secretThreadMsgId = secretThreadMsg.id;

    // Threads in a PUBLIC and an override-denied-PUBLIC channel: the server-wide
    // list (GET /:serverId/threads) must return the public one to the member but
    // NOT the denied one (readMessageHistory denied) nor the private one.
    publicThreadId = (await prisma.thread.create({
      data: { channelId: generalId, serverId: s, parentMessageId: publicMsg.id, name: 'PUBLIC-THREAD-CANARY', authorId: owner.id },
    })).id;
    deniedThreadId = (await prisma.thread.create({
      data: { channelId: deniedId, serverId: s, parentMessageId: deniedMsg.id, name: 'DENIED-THREAD-CANARY', authorId: owner.id },
    })).id;
    const poll = await prisma.poll.create({
      data: {
        channelId: secretId, serverId: s, authorId: owner.id, question: 'POLL-SECRET-CANARY',
        options: { create: [{ text: 'yes', position: 0 }, { text: 'no', position: 1 }] },
      },
    });
    secretPollId = poll.id;
    const post = await prisma.forumPost.create({ data: { channelId: secretForumId, authorId: owner.id, title: 'secret post', content: 'FORUMPOST-CANARY' } });
    secretPostId = post.id;
    secretForumMsgId = (await prisma.forumMessage.create({ data: { forumPostId: secretPostId, authorId: owner.id, content: 'FORUMMSG-CANARY' } })).id;
    await prisma.forumTag.create({ data: { channelId: secretForumId, name: 'secret-tag' } });

    // ---- Second server for cross-tenant IDOR + override-grant coverage --------
    // `attacker` owns s2 (so the owner short-circuit grants it every permission in
    // s2). s2 has a PUBLIC forum channel it will name in the URL when trying to
    // reach server-1's private forum message. s2 has NO @everyone role, so a
    // member's channel access is granted ONLY by an override — which is exactly
    // the invariant the per-channel readable filter must honor (and a swap to a
    // server-level-short-circuiting helper would break).
    attacker = outsider;
    vip = await createTestUser();
    plain2 = await createTestUser();
    const server2 = await createTestServer(attacker.id);
    s2 = server2.id;
    const s2cat = server2.categories[0].id;
    pubForum2Id = (await prisma.channel.create({ data: { id: randomUUID(), serverId: s2, name: 'pub-forum', type: 'forum', categoryId: s2cat, position: 1, isPrivate: false } })).id;

    await prisma.serverMember.create({ data: { userId: vip.id, serverId: s2, role: 'member' } });
    await prisma.serverMember.create({ data: { userId: plain2.id, serverId: s2, role: 'member' } });
    const vipRole = await prisma.serverRole.create({ data: { id: randomUUID(), serverId: s2, name: 'vip', position: 1, isEveryone: false, permissions: {} } });
    await prisma.memberRole.create({ data: { userId: vip.id, serverId: s2, roleId: vipRole.id } });
    s2SecretChannelId = (await prisma.channel.create({ data: { id: randomUUID(), serverId: s2, name: 's2-secret', type: 'text', categoryId: s2cat, position: 2, isPrivate: true } })).id;
    // vip's ONLY path to the channel: a role-tier override GRANT.
    await prisma.channelPermissionOverride.create({
      data: { channelId: s2SecretChannelId, targetType: 'role', targetId: vipRole.id, permissions: { viewChannels: true, readMessageHistory: true } as any },
    });
    const s2msg = await prisma.message.create({ data: { channelId: s2SecretChannelId, authorId: vip.id, content: 'VIP-MSG' } });
    s2SecretThreadId = (await prisma.thread.create({ data: { channelId: s2SecretChannelId, serverId: s2, parentMessageId: s2msg.id, name: 'VIP-THREAD-CANARY', authorId: vip.id } })).id;

    // vip-owned poll + thread-message in the override-granted text channel, and a
    // vip-owned post in an override-granted PRIVATE FORUM channel — so each of the
    // remaining ownership-mutation gates (poll PATCH, thread-message PATCH, forum
    // post PATCH, mark-read) has its OWN override-admission assertion, not just
    // thread PATCH. Owner short-circuits the override chain, so only a non-owner
    // whose sole access is a role-tier GRANT exercises the override code path.
    s2VipPollId = (await prisma.poll.create({
      data: {
        channelId: s2SecretChannelId, serverId: s2, authorId: vip.id, question: 'VIP-POLL',
        options: { create: [{ text: 'a', position: 0 }, { text: 'b', position: 1 }] },
      },
    })).id;
    s2VipThreadMsgId = (await prisma.threadMessage.create({ data: { threadId: s2SecretThreadId, authorId: vip.id, content: 'VIP-THREADMSG' } })).id;
    s2SecretForumId = (await prisma.channel.create({ data: { id: randomUUID(), serverId: s2, name: 's2-secret-forum', type: 'forum', categoryId: s2cat, position: 3, isPrivate: true } })).id;
    await prisma.channelPermissionOverride.create({
      data: { channelId: s2SecretForumId, targetType: 'role', targetId: vipRole.id, permissions: { viewChannels: true, readMessageHistory: true } as any },
    });
    s2VipPostId = (await prisma.forumPost.create({ data: { channelId: s2SecretForumId, authorId: vip.id, title: 'vip post', content: 'VIP-POST' } })).id;
  });

  afterAll(cleanupTestData);

  // ---- Member is BLOCKED on every private-channel content route (404) --------
  describe('member → 404 on private-channel content', () => {
    const cases = () => [
      ['GET', `/api/v1/messages/channels/${secretId}`],
      ['GET', `/api/v1/servers/${s}/channels/${secretId}/threads`],
      ['GET', `/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`],
      ['GET', `/api/v1/servers/${s}/threads/${secretThreadId}/messages`],
      ['GET', `/api/v1/servers/${s}/channels/${secretId}/polls`],
      ['GET', `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`],
      ['GET', `/api/v1/servers/${s}/channels/${secretForumId}/posts`],
      ['GET', `/api/v1/servers/${s}/channels/${secretForumId}/posts/${secretPostId}/messages`],
      ['GET', `/api/v1/servers/${s}/channels/${secretForumId}/tags`],
      ['GET', `/api/v1/servers/${s}/channels/${secretStageId}/stage`],
      ['GET', `/api/v1/servers/${s}/channels/${secretStageId}/stage/history`],
      // channelId ONLY (no serverId) forces the single-channel search branch;
      // supplying both would hit the server-wide branch, which silently omits
      // secret and returns 200 rather than 404.
      ['GET', `/api/v1/search/messages?channelId=${secretId}`],
    ] as const;

    it('reads all return 404 and never leak the canary', async () => {
      for (const [method, path] of cases()) {
        const res = await request(app)[method.toLowerCase() as 'get'](path).set('Authorization', authHeader(member.token));
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(JSON.stringify(res.body), `${method} ${path} leaked a canary`).not.toMatch(/CANARY/);
      }
    });
  });

  // ---- Member WRITE paths into private channels are blocked (404) ------------
  describe('member → 404 on private-channel writes', () => {
    it('vote / thread-message / forum-message / hand-raise / hand-lower / reaction-remove all 404', async () => {
      const writes: Array<['post' | 'delete', string, object]> = [
        ['post', `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}/vote`, { optionId: OPT }],
        ['post', `/api/v1/servers/${s}/threads/${secretThreadId}/messages`, { content: 'intrusion' }],
        ['post', `/api/v1/servers/${s}/channels/${secretForumId}/posts/${secretPostId}/messages`, { content: 'intrusion' }],
        ['post', `/api/v1/servers/${s}/channels/${secretStageId}/stage/hand/raise`, {}],
        // hand/lower self-path previously had ZERO auth — the critical landmine.
        ['post', `/api/v1/servers/${s}/channels/${secretStageId}/stage/hand/lower`, {}],
        // DELETE-reaction twin: a non-viewer must not inject a reaction-removed
        // event into a private thread room (never resolved the thread before).
        ['delete', `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${randomUUID()}/reactions/${encodeURIComponent('👍')}`, {}],
      ];
      for (const [method, path, body] of writes) {
        const res = await request(app)[method](path).set('Authorization', authHeader(member.token)).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
      }
    });
  });

  // ---- Landmine 1: thread detail gates on thread.channelId, not the URL ------
  it('member → 404 even when a PUBLIC channelId is spoofed in the thread-detail URL', async () => {
    const res = await request(app)
      .get(`/api/v1/servers/${s}/channels/${generalId}/threads/${secretThreadId}`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/CANARY/);
  });

  // ---- Override-denied PUBLIC channel: member is READABLE-denied (403) -------
  describe('member → 403 on the override-denied public channel', () => {
    it('reads return 403 (readMessageHistory), not 404', async () => {
      const paths = [
        `/api/v1/messages/channels/${deniedId}`,
        `/api/v1/servers/${s}/channels/${deniedId}/threads`,
        `/api/v1/servers/${s}/channels/${deniedId}/polls`,
      ];
      for (const path of paths) {
        const res = await request(app).get(path).set('Authorization', authHeader(member.token));
        expect(res.status, path).toBe(403);
      }
    });
  });

  // ---- Stage reads are VISIBILITY-gated, not readMessageHistory-gated ---------
  // GET /stage returns the live session, which stage-join-audience exposes on
  // viewChannels alone; gating it on readMessageHistory would refuse a member who
  // can legitimately join. /stage/history is content and stays readMessageHistory-gated.
  describe('member → 200 on GET /stage but 403 on /stage/history for a read-denied PUBLIC stage', () => {
    it('GET /stage is visible (200) while /stage/history is readable-denied (403)', async () => {
      const live = await request(app)
        .get(`/api/v1/servers/${s}/channels/${deniedStageId}/stage`)
        .set('Authorization', authHeader(member.token));
      expect(live.status, 'GET /stage').toBe(200);
      const history = await request(app)
        .get(`/api/v1/servers/${s}/channels/${deniedStageId}/stage/history`)
        .set('Authorization', authHeader(member.token));
      expect(history.status, 'GET /stage/history').toBe(403);
    });
  });

  // ---- hand/lower self-path enforces membership on PUBLIC stages too ----------
  // The self-lower path previously had no membership check; on a public stage
  // (where the visibility gate is vacuous) a non-member could reach the handler.
  it('outsider (non-member) → 403 on self-lower of a PUBLIC stage', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${s}/channels/${deniedStageId}/stage/hand/lower`)
      .set('Authorization', authHeader(outsider.token))
      .send({});
    expect(res.status).toBe(403);
  });

  // ---- forum POST /posts: visibility runs before the forum-type check ---------
  it('member → 404 (not 400) creating a post in a PRIVATE non-forum channel', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${s}/channels/${secretId}/posts`)
      .set('Authorization', authHeader(member.token))
      .send({ title: 'probe', content: 'probe' });
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/not a forum/i);
  });

  // ---- Inverted existence oracle in search is closed (404, not 200 []) ------
  it('member → 404 (not 200) for a nonexistent single-channel search', async () => {
    const res = await request(app)
      .get(`/api/v1/search/messages?channelId=${randomUUID()}`)
      .set('Authorization', authHeader(member.token));
    expect(res.status).toBe(404);
  });

  // ---- Anti-over-restriction: the public channel still works for the member --
  describe('member → 200 on public content (no over-restriction)', () => {
    it('public channel reads succeed', async () => {
      const paths = [
        `/api/v1/messages/channels/${generalId}`,
        `/api/v1/servers/${s}/channels/${generalId}/threads`,
        `/api/v1/servers/${s}/channels/${generalId}/polls`,
      ];
      for (const path of paths) {
        const res = await request(app).get(path).set('Authorization', authHeader(member.token));
        expect(res.status, path).toBe(200);
      }
    });
  });

  // ---- Access-intact control: the owner reaches everything (owner bypass) ----
  describe('owner → 200 on the same private content (control)', () => {
    it('owner reads succeed', async () => {
      const paths = [
        `/api/v1/messages/channels/${secretId}`,
        `/api/v1/servers/${s}/channels/${secretId}/threads`,
        `/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`,
        `/api/v1/servers/${s}/threads/${secretThreadId}/messages`,
        `/api/v1/servers/${s}/channels/${secretId}/polls`,
        `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`,
        `/api/v1/servers/${s}/channels/${secretForumId}/posts`,
        `/api/v1/servers/${s}/channels/${secretForumId}/posts/${secretPostId}/messages`,
        `/api/v1/servers/${s}/channels/${secretForumId}/tags`,
        `/api/v1/servers/${s}/channels/${secretStageId}/stage`,
        `/api/v1/servers/${s}/channels/${secretStageId}/stage/history`,
        `/api/v1/search/messages?channelId=${secretId}`,
      ];
      for (const path of paths) {
        const res = await request(app).get(path).set('Authorization', authHeader(owner.token));
        expect(res.status, path).toBe(200);
      }
    });

    it('owner reaches the override-denied public channel too (403 is member-specific)', async () => {
      const res = await request(app).get(`/api/v1/messages/channels/${deniedId}`).set('Authorization', authHeader(owner.token));
      expect(res.status).toBe(200);
    });
  });

  // ==========================================================================
  // ownership-fronted PATCH/DELETE existence oracle
  // A non-viewer member currently distinguishes "resource exists in a private
  // channel" (403 Not authorized) from "resource does not exist" (404) because
  // these write handlers gate on ownership only, never channel visibility. The
  // fix inserts assertChannelVisible on the resource's own channelId so every
  // non-viewer answer collapses to a single 404 (existence must not leak).
  // ==========================================================================
 describe('ownership-fronted mutations: member → uniform 404 (no existence oracle)', () => {
    it('PATCH/DELETE on private-channel forum post / poll / thread / thread-message all 404, real and fake alike', async () => {
      const fakePost = randomUUID(), fakePoll = randomUUID(), fakeThread = randomUUID(), fakeMsg = randomUUID();
      const cases: Array<['patch' | 'delete', string, object]> = [
        // forum post
        ['patch', `/api/v1/servers/${s}/channels/${secretForumId}/posts/${secretPostId}`, { title: 'x' }],
        ['delete', `/api/v1/servers/${s}/channels/${secretForumId}/posts/${secretPostId}`, {}],
        ['patch', `/api/v1/servers/${s}/channels/${secretForumId}/posts/${fakePost}`, { title: 'x' }],
        // poll
        ['patch', `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`, {}],
        ['delete', `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`, {}],
        ['patch', `/api/v1/servers/${s}/channels/${secretId}/polls/${fakePoll}`, {}],
        // thread
        ['patch', `/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`, { name: 'x' }],
        ['delete', `/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`, {}],
        ['patch', `/api/v1/servers/${s}/channels/${secretId}/threads/${fakeThread}`, { name: 'x' }],
        // thread message
        ['patch', `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${secretThreadMsgId}`, { content: 'x' }],
        ['delete', `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${secretThreadMsgId}`, {}],
        ['patch', `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${fakeMsg}`, { content: 'x' }],
      ];
      for (const [method, path, body] of cases) {
        const res = await request(app)[method](path).set('Authorization', authHeader(member.token)).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(JSON.stringify(res.body), `${method} ${path} leaked a canary`).not.toMatch(/CANARY/);
      }
    });

    it('POST /threads/:id/read on a private-channel thread → 404 (was a 204-vs-404 oracle + durable write)', async () => {
      const res = await request(app)
        .post(`/api/v1/servers/${s}/threads/${secretThreadId}/read`)
        .set('Authorization', authHeader(member.token))
        .send({});
      expect(res.status).toBe(404);
    });

    it('owner (author + viewer) is NOT over-restricted on the same mutations', async () => {
      // PATCH is a no-op-safe way to prove the gate lets the legitimate author
      // through; DELETE is skipped here so the shared fixture survives.
      const oks: Array<[string, object, number[]]> = [
        [`/api/v1/servers/${s}/channels/${secretForumId}/posts/${secretPostId}`, { title: 'still ok' }, [200]],
        [`/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`, { question: 'still ok?' }, [200]],
        [`/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`, { name: 'still ok' }, [200]],
        [`/api/v1/servers/${s}/threads/${secretThreadId}/messages/${secretThreadMsgId}`, { content: 'still ok' }, [200]],
      ];
      for (const [path, body, want] of oks) {
        const res = await request(app).patch(path).set('Authorization', authHeader(owner.token)).send(body);
        expect(want, `owner PATCH ${path} → ${res.status}`).toContain(res.status);
      }
      const read = await request(app).post(`/api/v1/servers/${s}/threads/${secretThreadId}/read`).set('Authorization', authHeader(owner.token)).send({});
      expect([200, 204], 'owner mark-read').toContain(read.status);
    });
  });

  // ==========================================================================
  // GET /:serverId/threads server-wide list visibility
  // The list filtered `channel.isPrivate:false` only, so a thread in a PUBLIC
  // channel whose @everyone readMessageHistory is DENIED via override leaked its
  // name/metadata. The fix resolves the member's actually-readable channel set
  // (silent omission, no 403/404). Private threads the member CAN see newly
  // appear (intentional widening), matching the per-channel list.
  // ==========================================================================
 describe('server-wide thread list is visibility-scoped', () => {
    const ids = async (token: string) => {
      const res = await request(app).get(`/api/v1/servers/${s}/threads`).set('Authorization', authHeader(token));
      expect(res.status).toBe(200);
      return new Set((res.body as Array<{ id: string }>).map((t) => t.id));
    };

    it('member sees the public thread but NOT the override-denied or private ones', async () => {
      const seen = await ids(member.token);
      expect(seen.has(publicThreadId), 'public thread visible').toBe(true);
      expect(seen.has(deniedThreadId), 'override-denied thread must NOT leak').toBe(false);
      expect(seen.has(secretThreadId), 'private thread must NOT leak').toBe(false);
    });

    it('owner sees public + private (viewer) threads (anti-over-restriction)', async () => {
      const seen = await ids(owner.token);
      expect(seen.has(publicThreadId), 'owner sees public').toBe(true);
      expect(seen.has(secretThreadId), 'owner sees the private thread it can view').toBe(true);
    });
  });

  // ==========================================================================
  // cross-tenant forum-message IDOR (review-surfaced)
  // The forum-message PATCH/DELETE/reaction handlers resolved the channel from the
  // URL :channelId but looked up the message with no channel binding, so the owner
  // of ANY server could edit/delete a forum message in ANY other server by naming
  // their own public forum channel in the URL. The fix binds the lookup to the
  // gated channel via `forumPost: { channelId }`.
  // ==========================================================================
 describe('cross-tenant forum-message mutation is refused', () => {
    it('attacker (owner of s2) cannot DELETE a forum message living in server-1 via their own channel URL', async () => {
      const res = await request(app)
        .delete(`/api/v1/servers/${s2}/channels/${pubForum2Id}/posts/${secretPostId}/messages/${secretForumMsgId}`)
        .set('Authorization', authHeader(attacker.token));
      expect(res.status).toBe(404);
      const still = await prisma.forumMessage.findUnique({ where: { id: secretForumMsgId } });
      expect(still, 'victim message must still exist').not.toBeNull();
    });

    it('attacker cannot PATCH a forum message living in server-1 via their own channel URL', async () => {
      const res = await request(app)
        .patch(`/api/v1/servers/${s2}/channels/${pubForum2Id}/posts/${secretPostId}/messages/${secretForumMsgId}`)
        .set('Authorization', authHeader(attacker.token))
        .send({ content: 'pwned' });
      expect(res.status).toBe(404);
      const msg = await prisma.forumMessage.findUnique({ where: { id: secretForumMsgId } });
      expect(msg?.content, 'victim message content unchanged').not.toBe('pwned');
    });
  });

  // ==========================================================================
  // reaction-DELETE binds the message to its parent (regression)
  // Both reaction-DELETE handlers pass the channel/thread visibility gate on the
  // URL scope, then look up the reaction/message. The commit binds that lookup to
  // the gated parent (thread reaction → msg.threadId === threadId; forum reaction →
  // message.forumPost.channelId === URL channel). These lock that binding: a caller
  // who CAN see the URL scope but names a resource living in a DIFFERENT scope is
  // refused with 404, so the visibility gate cannot be bypassed by id substitution.
  // ==========================================================================
 describe('reaction-DELETE binds the message to its URL parent', () => {
    it('thread reaction-DELETE: a messageId from another thread → 404 Message not found', async () => {
      // owner CAN view publicThread (owner bypass), so the visibility gate passes and
      // control reaches the messageId→threadId binding. secretThreadMsgId belongs to
      // a DIFFERENT thread; without the binding the handler would emit a spurious
      // thread-message-reaction-removed into publicThread's room and return success.
      const res = await request(app)
        .delete(`/api/v1/servers/${s}/threads/${publicThreadId}/messages/${secretThreadMsgId}/reactions/${encodeURIComponent('👍')}`)
        .set('Authorization', authHeader(owner.token));
      expect(res.status).toBe(404);
      expect(res.body?.error).toBe('Message not found');
    });

    it('forum reaction-DELETE: a message in another channel → 404 and the reaction survives', async () => {
      // owner reacts on a forum message living in the PRIVATE secretForum, then names
      // a DIFFERENT visible channel (general) in the URL. Without the
      // forumPost.channelId binding the reaction findFirst (scoped only to
      // messageId+userId+emoji) would match and delete the owner's own reaction; the
      // binding refuses it as 404 and the reaction row must remain.
      await prisma.forumMessageReaction.create({ data: { messageId: secretForumMsgId, userId: owner.id, emoji: '👍' } });
      const res = await request(app)
        .delete(`/api/v1/servers/${s}/channels/${generalId}/posts/${secretPostId}/messages/${secretForumMsgId}/reactions/${encodeURIComponent('👍')}`)
        .set('Authorization', authHeader(owner.token));
      expect(res.status).toBe(404);
      const still = await prisma.forumMessageReaction.findFirst({ where: { messageId: secretForumMsgId, userId: owner.id, emoji: '👍' } });
      expect(still, 'owner reaction must survive the cross-channel delete attempt').not.toBeNull();
    });
  });

  // ==========================================================================
  // override-only members are NOT over-restricted
  // s2 has no @everyone role; `vip`'s access to a private channel comes solely
  // from a role-tier override GRANT. The per-channel readable filter (and the
  // mutation gates) must admit vip — a swap to any server-level-short-circuiting
  // helper would over-deny here and fail these assertions.
  // ==========================================================================
 describe('override-grant admission (anti-over-restriction)', () => {
    it('vip (override-only viewer) sees the private-channel thread in the server-wide list; a plain member does not', async () => {
      const vipRes = await request(app).get(`/api/v1/servers/${s2}/threads`).set('Authorization', authHeader(vip.token));
      expect(vipRes.status).toBe(200);
      expect((vipRes.body as Array<{ id: string }>).some((t) => t.id === s2SecretThreadId), 'vip sees override-granted thread').toBe(true);

      const plainRes = await request(app).get(`/api/v1/servers/${s2}/threads`).set('Authorization', authHeader(plain2.token));
      expect(plainRes.status).toBe(200);
      expect((plainRes.body as Array<{ id: string }>).some((t) => t.id === s2SecretThreadId), 'plain member must NOT see it').toBe(false);
    });

    it('vip can PATCH their own thread in the override-granted private channel (gate admits them)', async () => {
      const res = await request(app)
        .patch(`/api/v1/servers/${s2}/channels/${s2SecretChannelId}/threads/${s2SecretThreadId}`)
        .set('Authorization', authHeader(vip.token))
        .send({ name: 'vip-renamed' });
      expect(res.status).toBe(200);
    });

    // Each ownership gate resolves the override GRANT independently, so lock every
    // one — not just thread PATCH. A swap to a server-level-short-circuiting helper
    // (e.g. filterVisibleChannelIds) in any single handler would over-deny vip here.
    it('vip is admitted by the poll / thread-message / forum-post PATCH gates and mark-read', async () => {
      const poll = await request(app)
        .patch(`/api/v1/servers/${s2}/channels/${s2SecretChannelId}/polls/${s2VipPollId}`)
        .set('Authorization', authHeader(vip.token)).send({ question: 'vip-poll-renamed' });
      expect(poll.status, 'poll PATCH').toBe(200);

      const tmsg = await request(app)
        .patch(`/api/v1/servers/${s2}/threads/${s2SecretThreadId}/messages/${s2VipThreadMsgId}`)
        .set('Authorization', authHeader(vip.token)).send({ content: 'vip-edit' });
      expect(tmsg.status, 'thread-message PATCH').toBe(200);

      const post = await request(app)
        .patch(`/api/v1/servers/${s2}/channels/${s2SecretForumId}/posts/${s2VipPostId}`)
        .set('Authorization', authHeader(vip.token)).send({ title: 'vip-renamed' });
      expect(post.status, 'forum post PATCH').toBe(200);

      const read = await request(app)
        .post(`/api/v1/servers/${s2}/threads/${s2SecretThreadId}/read`)
        .set('Authorization', authHeader(vip.token)).send({});
      expect([200, 204], 'mark-read').toContain(read.status);
    });
  });

  // ==========================================================================
  // privilege-scoping residual (1): non-member ordering oracle
  // On thread/poll PATCH/DELETE, thread-message PATCH/DELETE, reaction-POST, and
  // mark-read the resource-scoping 404 ran BEFORE the membership 403, so a
  // NON-member holding a valid serverId+channelId+resourceId triple got 403
  // ("resource exists") while a bogus id got 404 — an existence oracle. The fix
  // moves the membership check first, so a non-member's answer is a uniform 403
  // regardless of whether the resource exists. forum.ts already did this.
  // ==========================================================================
 describe('non-member sees a uniform 403 (no resource existence oracle)', () => {
    it('outsider gets the SAME (403) status for a real vs a fake resource on every reordered mutation', async () => {
      const fake = randomUUID();
      // [method, realPath, fakePath, body] — the fake path replaces the id the
      // handler existence-checks first (pollId / threadId).
      const cases: Array<['patch' | 'delete' | 'post', string, string, object]> = [
        ['patch',  `/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`, `/api/v1/servers/${s}/channels/${secretId}/threads/${fake}`, { name: 'x' }],
        ['delete', `/api/v1/servers/${s}/channels/${secretId}/threads/${secretThreadId}`, `/api/v1/servers/${s}/channels/${secretId}/threads/${fake}`, {}],
        ['patch',  `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`,     `/api/v1/servers/${s}/channels/${secretId}/polls/${fake}`,   {}],
        ['delete', `/api/v1/servers/${s}/channels/${secretId}/polls/${secretPollId}`,     `/api/v1/servers/${s}/channels/${secretId}/polls/${fake}`,   {}],
        ['patch',  `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${secretThreadMsgId}`, `/api/v1/servers/${s}/threads/${fake}/messages/${secretThreadMsgId}`, { content: 'x' }],
        ['delete', `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${secretThreadMsgId}`, `/api/v1/servers/${s}/threads/${fake}/messages/${secretThreadMsgId}`, {}],
        ['post',   `/api/v1/servers/${s}/threads/${secretThreadId}/messages/${secretThreadMsgId}/reactions`, `/api/v1/servers/${s}/threads/${fake}/messages/${secretThreadMsgId}/reactions`, { emoji: '👍' }],
        ['post',   `/api/v1/servers/${s}/threads/${secretThreadId}/messages`, `/api/v1/servers/${s}/threads/${fake}/messages`, { content: 'x' }],
        ['post',   `/api/v1/servers/${s}/threads/${secretThreadId}/read`, `/api/v1/servers/${s}/threads/${fake}/read`, {}],
      ];
      for (const [method, realPath, fakePath, body] of cases) {
        const real = await request(app)[method](realPath).set('Authorization', authHeader(outsider.token)).send(body);
        const fk = await request(app)[method](fakePath).set('Authorization', authHeader(outsider.token)).send(body);
        expect(real.status, `${method} ${realPath}: real must match fake (no existence oracle)`).toBe(fk.status);
        expect(real.status, `${method} ${realPath}: non-member must be a uniform 403`).toBe(403);
      }
    });

    // The reorder gates thread/poll PATCH/DELETE on the URL channelId (before the
    // resource lookup); the resource check then binds thread/poll → channelId, so
    // a channel the member CAN view spoofed in the URL cannot reach a resource in
    // a private channel. Locks Landmine-1 against the gate-on-URL-channel change.
    it('a visible channelId spoofed in the PATCH/DELETE URL still 404s for a private-channel thread/poll', async () => {
      const spoofs: Array<['patch' | 'delete', string, object]> = [
        ['patch',  `/api/v1/servers/${s}/channels/${generalId}/threads/${secretThreadId}`, { name: 'x' }],
        ['delete', `/api/v1/servers/${s}/channels/${generalId}/threads/${secretThreadId}`, {}],
        ['patch',  `/api/v1/servers/${s}/channels/${generalId}/polls/${secretPollId}`, {}],
        ['delete', `/api/v1/servers/${s}/channels/${generalId}/polls/${secretPollId}`, {}],
      ];
      for (const [method, path, body] of spoofs) {
        const res = await request(app)[method](path).set('Authorization', authHeader(member.token)).send(body);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(JSON.stringify(res.body), `${method} ${path} leaked a canary`).not.toMatch(/CANARY/);
      }
    });
  });

  // ==========================================================================
  // privilege-scoping residual (2): view-but-not-read on mark-read
  // mark-read gated on assertChannelVisible (view half only), so a member with
  // viewChannels but NOT readMessageHistory could write a durable ThreadReadState
  // (204) for a thread they cannot read, with a 204-vs-404 existence signal.
  // mark-read is a read-shaped op → gate on assertChannelReadable, with the
  // readable-denied outcome mapped to 404 so present-unreadable and absent match.
  // ==========================================================================
 describe('mark-read requires readMessageHistory (view-but-not-read closed)', () => {
    it('member with view-but-not-read on a public channel → 404 on mark-read (not 204)', async () => {
      // deniedId: public (member CAN view) but @everyone readMessageHistory = false.
      const res = await request(app)
        .post(`/api/v1/servers/${s}/threads/${deniedThreadId}/read`)
        .set('Authorization', authHeader(member.token)).send({});
      expect(res.status).toBe(404);
    });

    it('member WITH read access → mark-read still succeeds (anti-over-restriction)', async () => {
      const res = await request(app)
        .post(`/api/v1/servers/${s}/threads/${publicThreadId}/read`)
        .set('Authorization', authHeader(member.token)).send({});
      expect([200, 204]).toContain(res.status);
    });
  });

  // ---- Outsider boundary still holds (pre-existing membership gate) ----------
  it('outsider (non-member) → 403 on a private channel', async () => {
    const res = await request(app).get(`/api/v1/messages/channels/${secretId}`).set('Authorization', authHeader(outsider.token));
    expect(res.status).toBe(403);
  });
});
