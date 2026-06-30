// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression tests for user-FK cascade + SetNull behavior.
 *
 * Before this landed, author/uploader columns on ~17 models were bare
 * `String`s with no FK constraint. Deleting a user left dangling rows (e.g.
 * `Message.authorId` pointing at a non-existent user). The GDPR flow
 * hand-enumerated these rows and either deleted them or updated `authorId`
 * to the literal string `'deleted'` — an invariant that could easily drift.
 *
 * With FK constraints in place, `prisma.user.delete(...)` cascades content-bearing rows
 * (Message, DMMessage, ThreadMessage, Thread, Poll, ForumPost, ForumMessage,
 * CustomEmoji, Sticker, SoundboardSound, MessageReport.authorId,
 * GiftSubscription.senderId) and sets audit-bearing
 * rows' user FK to NULL (AuditLog.actorId, MessageReport.reporterId,
 * ChannelPinnedMessage.pinnedById, DMPinnedMessage.pinnedById,
 * ServerEvent.createdById,
 * GiftSubscription.recipientId).
 *
 * These tests require a running Postgres (CI's `postgres:16` service).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, createTestChannel, cleanupTestData } from './helpers.js';

afterAll(async () => {
  await cleanupTestData();
  await prisma.$disconnect();
});

describe('cascade delete on user-authored rows', () => {
  it('deletes channel messages when the author is deleted', async () => {
    const owner = await createTestUser();
    const author = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: author.id, serverId: server.id, role: 'member' } });
    const channel = await createTestChannel(server.id);

    const msg = await prisma.message.create({
      data: { channelId: channel.id, authorId: author.id, content: 'hello' },
    });

    await prisma.user.delete({ where: { id: author.id } });

    const found = await prisma.message.findUnique({ where: { id: msg.id } });
    expect(found).toBeNull();
  });

  it('deletes DM messages when the author is deleted', async () => {
    const a = await createTestUser();
    const b = await createTestUser();

    const dm = await prisma.dMChannel.create({
      data: {
        encrypted: true,
        participants: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    });
    const msg = await prisma.dMMessage.create({
      data: { dmChannelId: dm.id, authorId: a.id, content: 'hi' },
    });

    await prisma.user.delete({ where: { id: a.id } });

    const found = await prisma.dMMessage.findUnique({ where: { id: msg.id } });
    expect(found).toBeNull();
  });

  it('deletes threads + thread messages when the thread author is deleted', async () => {
    const owner = await createTestUser();
    const author = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: author.id, serverId: server.id, role: 'member' } });
    const channel = await createTestChannel(server.id);
    const parent = await prisma.message.create({ data: { channelId: channel.id, authorId: owner.id, content: 'parent' } });

    const thread = await prisma.thread.create({
      data: { channelId: channel.id, parentMessageId: parent.id, serverId: server.id, name: 't', authorId: author.id },
    });
    const tm = await prisma.threadMessage.create({ data: { threadId: thread.id, authorId: author.id, content: 'x' } });

    await prisma.user.delete({ where: { id: author.id } });

    expect(await prisma.thread.findUnique({ where: { id: thread.id } })).toBeNull();
    expect(await prisma.threadMessage.findUnique({ where: { id: tm.id } })).toBeNull();
  });

  it('deletes polls authored by the user', async () => {
    const owner = await createTestUser();
    const author = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: author.id, serverId: server.id, role: 'member' } });
    const channel = await createTestChannel(server.id);

    const poll = await prisma.poll.create({
      data: {
        channelId: channel.id,
        serverId: server.id,
        authorId: author.id,
        question: 'q',
        options: { create: [{ text: 'a', position: 0 }] },
      },
    });

    await prisma.user.delete({ where: { id: author.id } });

    expect(await prisma.poll.findUnique({ where: { id: poll.id } })).toBeNull();
  });

  it('deletes forum posts + replies when the author is deleted', async () => {
    const owner = await createTestUser();
    const author = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: author.id, serverId: server.id, role: 'member' } });
    const forum = await prisma.channel.create({
      data: { serverId: server.id, name: 'forum', type: 'forum' },
    });

    const post = await prisma.forumPost.create({
      data: { channelId: forum.id, authorId: author.id, title: 't', content: 'c' },
    });
    const reply = await prisma.forumMessage.create({
      data: { forumPostId: post.id, authorId: author.id, content: 'r' },
    });

    await prisma.user.delete({ where: { id: author.id } });

    expect(await prisma.forumPost.findUnique({ where: { id: post.id } })).toBeNull();
    expect(await prisma.forumMessage.findUnique({ where: { id: reply.id } })).toBeNull();
  });

  it('deletes uploaded custom emoji / sticker / soundboard sounds', async () => {
    const owner = await createTestUser();
    const uploader = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: uploader.id, serverId: server.id, role: 'member' } });

    const emoji = await prisma.customEmoji.create({
      data: { serverId: server.id, name: 'e', imageUrl: '/e.png', uploadedById: uploader.id },
    });
    const sticker = await prisma.sticker.create({
      data: { serverId: server.id, name: 's', imageUrl: '/s.png', uploadedById: uploader.id },
    });
    const sound = await prisma.soundboardSound.create({
      data: { serverId: server.id, name: 'snd', audioUrl: '/s.mp3', uploadedById: uploader.id },
    });

    await prisma.user.delete({ where: { id: uploader.id } });

    expect(await prisma.customEmoji.findUnique({ where: { id: emoji.id } })).toBeNull();
    expect(await prisma.sticker.findUnique({ where: { id: sticker.id } })).toBeNull();
    expect(await prisma.soundboardSound.findUnique({ where: { id: sound.id } })).toBeNull();
  });
});

describe('SetNull on audit-bearing rows', () => {
  it('nulls AuditLog.actorId when the actor is deleted (audit row survives)', async () => {
    const owner = await createTestUser();
    const actor = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: actor.id, serverId: server.id, role: 'member' } });

    const entry = await prisma.auditLog.create({
      data: { serverId: server.id, actorId: actor.id, action: 'test_action' },
    });

    await prisma.user.delete({ where: { id: actor.id } });

    const after = await prisma.auditLog.findUnique({ where: { id: entry.id } });
    expect(after).not.toBeNull();
    expect(after!.actorId).toBeNull();
    expect(after!.action).toBe('test_action');
  });

  it('nulls MessageReport.reporterId when the reporter self-deletes (report survives)', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();

    const report = await prisma.messageReport.create({
      data: {
        reporterId: reporter.id,
        messageType: 'channel',
        messageId: 'msg-fixture-id',
        authorId: author.id,
        content: 'snapshot of reported content',
        reason: 'harassment',
      },
    });

    await prisma.user.delete({ where: { id: reporter.id } });

    const after = await prisma.messageReport.findUnique({ where: { id: report.id } });
    expect(after).not.toBeNull();
    expect(after!.reporterId).toBeNull();
    expect(after!.authorId).toBe(author.id);
    expect(after!.content).toBe('snapshot of reported content');
  });

  it('nulls MessageReport.authorId when the reported-author is deleted (report survives — §2258A preservation)', async () => {
    // Cascade was changed to SetNull on 2026-04-27 to preserve evidence
    // (especially CSAM auto-flagged uploads) past a self-delete. Identity at
    // report time lives in the *Snapshot fields, populated at insert.
    const reporter = await createTestUser();
    const author = await createTestUser();

    const report = await prisma.messageReport.create({
      data: {
        reporterId: reporter.id,
        messageType: 'channel',
        messageId: 'msg-fixture-id-2',
        authorId: author.id,
        authorUsernameSnapshot: author.username,
        authorEmailHashSnapshot: 'snapshot-hash',
        content: 'snapshot',
        reason: 'spam',
      },
    });

    await prisma.user.delete({ where: { id: author.id } });

    const after = await prisma.messageReport.findUnique({ where: { id: report.id } });
    expect(after).not.toBeNull();
    expect(after!.authorId).toBeNull();
    expect(after!.authorUsernameSnapshot).toBe(author.username);
    expect(after!.authorEmailHashSnapshot).toBe('snapshot-hash');
    expect(after!.content).toBe('snapshot');
  });

  it('nulls ChannelPinnedMessage.pinnedById when the pinner is deleted', async () => {
    const owner = await createTestUser();
    const pinner = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: pinner.id, serverId: server.id, role: 'member' } });
    const channel = await createTestChannel(server.id);
    const msg = await prisma.message.create({ data: { channelId: channel.id, authorId: owner.id, content: 'x' } });

    const pin = await prisma.channelPinnedMessage.create({
      data: { channelId: channel.id, messageId: msg.id, pinnedById: pinner.id },
    });

    await prisma.user.delete({ where: { id: pinner.id } });

    const after = await prisma.channelPinnedMessage.findUnique({ where: { id: pin.id } });
    expect(after).not.toBeNull();
    expect(after!.pinnedById).toBeNull();
  });

  it('nulls ServerEvent.createdById when the creator is deleted (event survives)', async () => {
    const owner = await createTestUser();
    const creator = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: creator.id, serverId: server.id, role: 'member' } });

    const event = await prisma.serverEvent.create({
      data: {
        serverId: server.id,
        createdById: creator.id,
        title: 't',
        startTime: new Date('2030-01-01T00:00:00Z'),
        endTime: new Date('2030-01-01T01:00:00Z'),
      },
    });

    await prisma.user.delete({ where: { id: creator.id } });

    const after = await prisma.serverEvent.findUnique({ where: { id: event.id } });
    expect(after).not.toBeNull();
    expect(after!.createdById).toBeNull();
  });

  it('nulls GiftSubscription.recipientId + cascades GiftSubscription.senderId', async () => {
    const sender = await createTestUser();
    const recipient = await createTestUser();

    const gift = await prisma.giftSubscription.create({
      data: {
        code: `g-${Date.now()}`,
        plan: 'pro',
        durationMonths: 1,
        senderId: sender.id,
        recipientId: recipient.id,
      },
    });

    // Delete recipient — gift survives with null recipientId.
    await prisma.user.delete({ where: { id: recipient.id } });
    const after1 = await prisma.giftSubscription.findUnique({ where: { id: gift.id } });
    expect(after1).not.toBeNull();
    expect(after1!.recipientId).toBeNull();

    // Delete sender — gift cascades away (the sender's financial record dies
    // with them; recipient has already been handled above).
    await prisma.user.delete({ where: { id: sender.id } });
    expect(await prisma.giftSubscription.findUnique({ where: { id: gift.id } })).toBeNull();
  });
});

describe('pre-fix bug repro — orphan rows are impossible now', () => {
  // Before the FK constraints, `prisma.user.delete` on a user
  // with authored messages either (a) threw if Prisma emitted some FK or
  // (b) left orphan `Message.authorId` strings pointing nowhere. After the
  // fix the only observable post-delete state is "cascade wiped" or
  // "authorId is NULL" — never orphaned.
  it('no authored message survives user.delete with a non-existent authorId', async () => {
    const owner = await createTestUser();
    const author = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverMember.create({ data: { userId: author.id, serverId: server.id, role: 'member' } });
    const channel = await createTestChannel(server.id);
    const msg = await prisma.message.create({ data: { channelId: channel.id, authorId: author.id, content: 'a' } });
    const msgId = msg.id;

    await prisma.user.delete({ where: { id: author.id } });

    // Post-fix behavior: the message must be gone (Cascade wiped it).
    // Pre-fix behavior: the message would still exist with authorId equal to
    // either the still-stored-but-dangling author.id or a sentinel 'deleted'.
    // We assert the stronger, new invariant: row is absent.
    const orphan = await prisma.message.findUnique({ where: { id: msgId } });
    expect(orphan).toBeNull();
  });
});
