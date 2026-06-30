// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Thread cross-server tenancy guard —
 * thread message mutations (PATCH / DELETE / reaction POST) must reject when
 * the URL `serverId` does not match the thread's real `serverId`.
 *
 * Before the fix, a moderator in server A could craft a request against
 *   /api/v1/servers/{A}/threads/{threadInB}/messages/{msgInB}...
 * and pass the permission check against A while operating on B's data.
 * These tests lock in the 404 response for each mismatched-tenant call.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, createTestChannel, authHeader, cleanupTestData, type TestUser } from './helpers.js';

describe('thread cross-server tenancy guard', () => {
  let attacker: TestUser;
  let victim: TestUser;
  let serverA: string; // attacker-owned
  let serverB: string; // victim-owned
  let channelB: string;
  let parentMessageB: string;
  let threadB: string;
  let threadMessageB: string; // victim's message in threadB
  let attackerMessageInB: string; // attacker's own message in threadB (for PATCH test)

  beforeAll(async () => {
    attacker = await createTestUser();
    victim = await createTestUser();

    const a = await createTestServer(attacker.id);
    serverA = a.id;

    const b = await createTestServer(victim.id);
    serverB = b.id;
    channelB = b.channels[0]!.id;

    // Seed @everyone role on serverB so non-owner members get the baseline
    // permission set (addReactions, etc.). Production server creation does
    // this automatically; createTestServer doesn't.
    await prisma.serverRole.create({
      data: {
        serverId: serverB,
        name: '@everyone',
        isEveryone: true,
        position: 999,
        locked: true,
        permissions: {
          viewChannels: true, sendMessages: true, readMessageHistory: true,
          addReactions: true, embedLinks: true, attachFiles: true,
          createThreads: true, sendMessagesInThreads: true,
        },
      },
    });

    // attacker is also a member of server B with default role (so they CAN be the
    // author of a message inside threadB, isolating the PATCH test to the tenancy
    // check rather than "not a server member").
    await prisma.serverMember.create({
      data: { userId: attacker.id, serverId: serverB, role: 'member' },
    });

    // Seed: parent message in channelB, thread on it, and two thread messages
    // (one authored by victim, one by attacker) so we can cover both the
    // manageMessages (DELETE) and author-only (PATCH) code paths.
    const parent = await prisma.message.create({
      data: {
        id: randomUUID(),
        channelId: channelB,
        authorId: victim.id,
        content: 'parent',
      },
    });
    parentMessageB = parent.id;

    const thread = await prisma.thread.create({
      data: {
        id: randomUUID(),
        channelId: channelB,
        serverId: serverB,
        parentMessageId: parentMessageB,
        name: 'threadB',
        authorId: victim.id,
      },
    });
    threadB = thread.id;

    const victimMsg = await prisma.threadMessage.create({
      data: {
        id: randomUUID(),
        threadId: threadB,
        authorId: victim.id,
        content: 'victim message',
      },
    });
    threadMessageB = victimMsg.id;

    const attackerMsg = await prisma.threadMessage.create({
      data: {
        id: randomUUID(),
        threadId: threadB,
        authorId: attacker.id,
        content: 'attacker message',
      },
    });
    attackerMessageInB = attackerMsg.id;
  });

  afterAll(cleanupTestData);

  // Cross-tenant requests (serverId = A, thread/message belong to B)

  it('PATCH with mismatched serverId returns 404 (own message in other server)', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverA}/threads/${threadB}/messages/${attackerMessageInB}`)
      .set('Authorization', authHeader(attacker.token))
      .send({ content: 'tampered' });
    expect(res.status).toBe(404);

    // Confirm no write happened
    const after = await prisma.threadMessage.findUnique({ where: { id: attackerMessageInB } });
    expect(after?.content).toBe('attacker message');
    expect(after?.editedAt).toBeNull();
  });

  it('DELETE with mismatched serverId returns 404 (moderator in A attacking B)', async () => {
    const res = await request(app)
      .delete(`/api/v1/servers/${serverA}/threads/${threadB}/messages/${threadMessageB}`)
      .set('Authorization', authHeader(attacker.token));
    expect(res.status).toBe(404);

    // Confirm the message still exists
    const after = await prisma.threadMessage.findUnique({ where: { id: threadMessageB } });
    expect(after).not.toBeNull();
  });

  it('POST reaction with mismatched serverId returns 404', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverA}/threads/${threadB}/messages/${threadMessageB}/reactions`)
      .set('Authorization', authHeader(attacker.token))
      .send({ emoji: '👍' });
    expect(res.status).toBe(404);

    // Confirm no reaction row was created
    const count = await prisma.threadMessageReaction.count({
      where: { messageId: threadMessageB, userId: attacker.id, emoji: '👍' },
    });
    expect(count).toBe(0);
  });

  // Control: matching serverId still works end-to-end

  it('PATCH with matching serverId edits own thread message', async () => {
    const res = await request(app)
      .patch(`/api/v1/servers/${serverB}/threads/${threadB}/messages/${attackerMessageInB}`)
      .set('Authorization', authHeader(attacker.token))
      .send({ content: 'edited correctly' });
    expect(res.status).toBe(200);
    expect(res.body.content).toBe('edited correctly');
  });

  it('POST reaction with matching serverId succeeds', async () => {
    const res = await request(app)
      .post(`/api/v1/servers/${serverB}/threads/${threadB}/messages/${threadMessageB}/reactions`)
      .set('Authorization', authHeader(attacker.token))
      .send({ emoji: '👍' });
    expect(res.status).toBe(200);

    const count = await prisma.threadMessageReaction.count({
      where: { messageId: threadMessageB, userId: attacker.id, emoji: '👍' },
    });
    expect(count).toBe(1);
  });

  it('DELETE with matching serverId deletes the message (author path)', async () => {
    // Use a fresh message so other tests aren't affected
    const tmp = await prisma.threadMessage.create({
      data: {
        id: randomUUID(),
        threadId: threadB,
        authorId: attacker.id,
        content: 'to be deleted',
      },
    });
    const res = await request(app)
      .delete(`/api/v1/servers/${serverB}/threads/${threadB}/messages/${tmp.id}`)
      .set('Authorization', authHeader(attacker.token));
    expect(res.status).toBe(204);

    const after = await prisma.threadMessage.findUnique({ where: { id: tmp.id } });
    expect(after).toBeNull();
  });
});
