// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Stage WRITE-path age gate.
 *
 * The read-path stage batch (7b3d4d16) closed the JOIN / GET /stage / history /
 * livekit-token surfaces, so no adult media or roster reaches a minor. This
 * batch closes the matching WRITE leaks: a minor `manageStages` host could still
 * CREATE and MODERATE an age-restricted stage, and two handlers (start, PATCH)
 * ECHO the session's 18+ topic + speaker/audience roster back in the response.
 *
 * Mirrors messages.ts, which age-gates BOTH the participate send path AND the
 * moderator pin/unpin handlers — so every participate + moderator stage write is
 * gated. Self-exits (hand/lower-self, move-to-audience) are deliberately LEFT
 * OPEN: gating them would trap a minor who is already a speaker in an
 * age-restricted stage (the gate is forward-only), which is the opposite of the
 * intent.
 *
 * The scenario is a PUBLIC age-restricted stage so the channel visibility gate
 * passes for everyone and ONLY the age gate distinguishes the minor (403
 * `age_restricted`) from the adult (2xx). The minor is granted manageStages +
 * requestToSpeak so they reach every moderator + participate handler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { addToSet, clearStageState } from '../src/routes/stages.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData, type TestUser } from './helpers.js';

const BASELINE_PERMS = {
  viewChannels: true,
  readMessageHistory: true,
  connect: true,
  manageStages: true,
  requestToSpeak: true,
};

const START_BODY = { maxSpeakers: 10, textChatEnabled: true, allowEmojis: false, allowStickers: false, allowGifs: false };

type Method = 'post' | 'patch';
type Write = readonly [label: string, method: Method, path: string, body: Record<string, unknown>];

describe('Stage write-path age gate — start / end / PATCH / speakers / hands', () => {
  let owner: TestUser; // adult (helper default DOB) — owner, starts the seed sessions
  let adult: TestUser; // explicit adult DOB, member + host via @everyone
  let minor: TestUser; // 14 today, member + host via @everyone

  let s: string;
  let arActive: string;   // public AR stage, owner-started active session (minor-denied set)
  let arStart: string;    // public AR stage, NO session (minor start-denied)
  let arAdult: string;    // public AR stage, NO session (adult full-lifecycle 2xx)
  let safeActive: string; // public non-AR stage, owner-started active session (scoping control)

  const stagePath = (channelId: string, suffix = '') =>
    `/api/v1/servers/${s}/channels/${channelId}/stage${suffix}`;

  beforeAll(async () => {
    owner = await createTestUser();
    adult = await createTestUser();
    await prisma.user.update({ where: { id: adult.id }, data: { dateOfBirth: new Date('1990-01-01') } });
    minor = await createTestUser();
    const fourteen = new Date();
    fourteen.setUTCFullYear(fourteen.getUTCFullYear() - 14);
    await prisma.user.update({ where: { id: minor.id }, data: { dateOfBirth: fourteen } });

    const server = await createTestServer(owner.id);
    s = server.id;
    const categoryId = server.categories[0].id;
    await prisma.serverMember.create({ data: { userId: adult.id, serverId: s, role: 'member' } });
    await prisma.serverMember.create({ data: { userId: minor.id, serverId: s, role: 'member' } });
    await prisma.serverRole.create({
      data: { id: randomUUID(), serverId: s, name: '@everyone', position: 0, isEveryone: true, permissions: BASELINE_PERMS },
    });

    const mkStage = (name: string, ageRestricted: boolean) =>
      prisma.channel.create({
        data: { id: randomUUID(), serverId: s, name, type: 'stage', categoryId, position: 0, isPrivate: false, ageRestricted },
      });
    arActive = (await mkStage('ar-active', true)).id;
    arStart = (await mkStage('ar-start', true)).id;
    arAdult = (await mkStage('ar-adult', true)).id;
    safeActive = (await mkStage('safe-active', false)).id;

    // Active sessions (owner is an adult → can start). arActive carries a 18+
    // topic marker so the content-echo (start/PATCH) leak can be asserted.
    const startActive = await request(app)
      .post(stagePath(arActive, '/start'))
      .set('Authorization', authHeader(owner.token))
      .send({ ...START_BODY, topic: 'ADULT-STAGE-TOPIC' });
    expect(startActive.status).toBe(201);

    const startSafe = await request(app)
      .post(stagePath(safeActive, '/start'))
      .set('Authorization', authHeader(owner.token))
      .send(START_BODY);
    expect(startSafe.status).toBe(201);
  });

  afterAll(async () => {
    for (const c of [arActive, arStart, arAdult, safeActive]) await clearStageState(c).catch(() => {});
    await prisma.notification.deleteMany({ where: { serverId: s } }).catch(() => {});
    await prisma.stageSession.deleteMany({ where: { serverId: s } }).catch(() => {});
    await cleanupTestData();
  });

  const send = (who: TestUser, [, method, path, body]: Write) =>
    request(app)[method](path).set('Authorization', authHeader(who.token)).send(body);

  // Every participate + moderator write a minor could reach. `start` goes to a
  // no-session stage (its gate fires before the session-existence check); the
  // rest need the owner-started active session on `arActive`.
  const minorWrites = (): Write[] => [
    ['start', 'post', stagePath(arStart, '/start'), START_BODY],
    ['end', 'post', stagePath(arActive, '/end'), {}],
    ['PATCH', 'patch', stagePath(arActive), { topic: 'minor-edit' }],
    ['speakers/invite', 'post', stagePath(arActive, '/speakers/invite'), { userId: owner.id }],
    ['speakers/remove', 'post', stagePath(arActive, '/speakers/remove'), { userId: owner.id }],
    ['hand/raise', 'post', stagePath(arActive, '/hand/raise'), {}],
    ['hand/accept', 'post', stagePath(arActive, '/hand/accept'), { userId: owner.id }],
    ['join-as-speaker', 'post', stagePath(arActive, '/join-as-speaker'), {}],
  ];

  it('minor is denied (403 age_restricted) on every participate + moderator stage write, with no 18+ session content echoed', async () => {
    for (const w of minorWrites()) {
      const res = await send(minor, w);
      expect(res.status, `${w[0]} :: ${w[2]} (got ${res.status}: ${JSON.stringify(res.body)})`).toBe(403);
      expect(res.body.error, `${w[0]} :: ${w[2]}`).toBe('age_restricted');
      // start + PATCH echo buildStageResponse (topic + roster); the 403 must not.
      expect(JSON.stringify(res.body), `${w[0]} leaked 18+ topic`).not.toMatch(/ADULT-STAGE-TOPIC/);
    }
  });

  it('adult host is NOT over-restricted — the full stage lifecycle succeeds (2xx, never age_restricted)', async () => {
    // Ordered sequence on a dedicated AR stage: start seeds the session, end
    // (destructive) is last. Proves the age gate never fires for an adult.
    const adultLifecycle: Write[] = [
      ['start', 'post', stagePath(arAdult, '/start'), { ...START_BODY, topic: 'adult-topic' }],
      ['PATCH', 'patch', stagePath(arAdult), { topic: 'adult-edit' }],
      ['hand/raise', 'post', stagePath(arAdult, '/hand/raise'), {}],
      ['speakers/invite', 'post', stagePath(arAdult, '/speakers/invite'), { userId: owner.id }],
      ['hand/accept', 'post', stagePath(arAdult, '/hand/accept'), { userId: adult.id }],
      ['join-as-speaker', 'post', stagePath(arAdult, '/join-as-speaker'), {}],
      ['speakers/remove', 'post', stagePath(arAdult, '/speakers/remove'), { userId: owner.id }],
      ['end', 'post', stagePath(arAdult, '/end'), {}],
    ];
    for (const w of adultLifecycle) {
      const res = await send(adult, w);
      expect([200, 201], `${w[0]} :: ${w[2]} (got ${res.status}: ${JSON.stringify(res.body)})`).toContain(res.status);
      expect(res.body?.error, `${w[0]} unexpectedly age-gated`).not.toBe('age_restricted');
    }
  });

  it('minor writes to a NON-age-restricted stage normally (gate is scoped, not blanket)', async () => {
    const safeWrites: Write[] = [
      ['PATCH', 'patch', stagePath(safeActive), { topic: 'safe-edit' }],
      ['hand/raise', 'post', stagePath(safeActive, '/hand/raise'), {}],
      ['join-as-speaker', 'post', stagePath(safeActive, '/join-as-speaker'), {}],
    ];
    for (const w of safeWrites) {
      const res = await send(minor, w);
      expect([200, 201], `${w[0]} :: ${w[2]} (got ${res.status}: ${JSON.stringify(res.body)})`).toContain(res.status);
      expect(res.body?.error, `${w[0]} unexpectedly age-gated on safe stage`).not.toBe('age_restricted');
    }
  });

  it('self-exits stay open — a minor already speaking in an AR stage can step down / lower their own hand', async () => {
    // Forward-only gate: a minor may already be a speaker when the channel was
    // flipped ageRestricted. move-to-audience + hand/lower-self must NOT be gated
    // or the minor is trapped on stage in age-restricted content.
    await addToSet(arActive, 'speakers', minor.id);
    const exits: Write[] = [
      ['move-to-audience', 'post', stagePath(arActive, '/move-to-audience'), {}],
      ['hand/lower', 'post', stagePath(arActive, '/hand/lower'), {}],
    ];
    for (const w of exits) {
      const res = await send(minor, w);
      expect(res.status, `${w[0]} :: ${w[2]} (got ${res.status}: ${JSON.stringify(res.body)})`).toBe(200);
      expect(res.body?.error, `${w[0]} wrongly age-gated a self-exit`).not.toBe('age_restricted');
    }
  });
});
