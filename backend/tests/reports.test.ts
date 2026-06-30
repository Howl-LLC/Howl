// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { createTestUser, createTestServer, cleanupTestData, authHeader } from './helpers.js';
import { prisma } from '../src/db.js';
import { decryptSecret } from '../src/services/mfaCrypto.js';

afterAll(async () => { await cleanupTestData(); });

// Helper: create DM channel with message

async function createDmWithMessage(opts: {
  reporterId: string;
  authorId: string;
  content: string;
  encrypted: boolean;
}) {
  const dmChannel = await prisma.dMChannel.create({
    data: { encrypted: opts.encrypted },
  });
  await prisma.dMParticipant.createMany({
    data: [
      { userId: opts.reporterId, dmChannelId: dmChannel.id },
      { userId: opts.authorId, dmChannelId: dmChannel.id },
    ],
  });
  const message = await prisma.dMMessage.create({
    data: {
      dmChannelId: dmChannel.id,
      authorId: opts.authorId,
      content: opts.content,
    },
  });
  return { dmChannel, message };
}

// Tests

describe('Message Reports — E2E DM reports (plaintext-only)', () => {
  it('stores reporter-disclosed plaintext for an encrypted DM report (no channelKey)', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();

    // An encrypted DM channel with a message whose stored content is an opaque
    // envelope (any string; the server never parses it).
    const { dmChannel, message } = await createDmWithMessage({
      reporterId: reporter.id,
      authorId: author.id,
      content: '{"v":4,"m":"AAAA"}',
      encrypted: true,
    });

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', authHeader(reporter.token))
      .send({
        messageId: message.id,
        messageType: 'dm',
        dmChannelId: dmChannel.id,
        reason: 'harassment',
        plaintext: 'the readable message text',
      });

    expect(res.status).toBe(201);

    const report = await prisma.messageReport.findFirst({ where: { messageId: message.id } });
    expect(report!.contentSource).toBe('reporter_disclosed');
    // Content is encrypted at rest with encryptSecret — decrypt to verify.
    expect(decryptSecret(report!.content)).toBe('the readable message text');
  });

  it('marks content unavailable when the reporter discloses nothing', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();

    const { dmChannel, message } = await createDmWithMessage({
      reporterId: reporter.id,
      authorId: author.id,
      content: '{"v":4,"m":"AAAA"}',
      encrypted: true,
    });

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', authHeader(reporter.token))
      .send({
        messageId: message.id,
        messageType: 'dm',
        dmChannelId: dmChannel.id,
        reason: 'violence',
      });

    expect(res.status).toBe(201);

    const report = await prisma.messageReport.findFirst({ where: { messageId: message.id } });
    expect(report!.contentSource).toBe('unavailable');
  });

  it('rejects a report body carrying the removed channelKey field (strict schema)', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();

    const { dmChannel, message } = await createDmWithMessage({
      reporterId: reporter.id,
      authorId: author.id,
      content: '{"v":4,"m":"AAAA"}',
      encrypted: true,
    });

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', authHeader(reporter.token))
      .send({
        messageId: message.id,
        messageType: 'dm',
        dmChannelId: dmChannel.id,
        reason: 'harassment',
        plaintext: 'the readable message text',
        channelKey: 'AAAA',
      });

    expect(res.status).toBe(400);
  });

  it('channel report → contentSource = "server"', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();
    const server = await createTestServer(reporter.id);
    const channelId = server.channels[0].id;

    // Author must be a server member to send a message
    await prisma.serverMember.create({
      data: { userId: author.id, serverId: server.id },
    });

    const message = await prisma.message.create({
      data: {
        channelId,
        authorId: author.id,
        content: 'A normal channel message',
      },
    });

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({
        messageId: message.id,
        messageType: 'channel',
        channelId,
        reason: 'spam',
      });

    expect(res.status).toBe(201);

    const report = await prisma.messageReport.findUnique({ where: { id: res.body.id } });
    expect(report!.contentSource).toBe('server');
  });

  it('self-report is blocked', async () => {
    const user = await createTestUser();
    const other = await createTestUser();

    // Create a DM where user is reporter and also the author of the message
    const dmChannel = await prisma.dMChannel.create({ data: {} });
    await prisma.dMParticipant.createMany({
      data: [
        { userId: user.id, dmChannelId: dmChannel.id },
        { userId: other.id, dmChannelId: dmChannel.id },
      ],
    });
    const message = await prisma.dMMessage.create({
      data: {
        dmChannelId: dmChannel.id,
        authorId: user.id, // user authored this message
        content: 'My own message',
      },
    });

    const res = await request(app)
      .post('/api/v1/reports')
      .set('Authorization', `Bearer ${user.token}`)
      .send({
        messageId: message.id,
        messageType: 'dm',
        dmChannelId: dmChannel.id,
        reason: 'spam',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot report your own/i);
  });
});

// Author identity snapshot — captured at user-report-create time so the
// record survives the accused user later self-deleting their account. The
// FK is SetNull on cascade; without these fields admins lose investigative
// context for every report aged past a self-delete event. Fields snapshotted
// here are not privacy-sensitive (username is public, emailHash is HMAC-keyed,
// createdAt is on every public profile) — locking them in just preserves
// what was already accessible. Raw IP/UA is gated separately at admin-action
// time and is intentionally NOT captured here.

describe('Message Reports — Author identity snapshot at create', () => {
  async function createReportableChannelMessage(reporter: { id: string }, author: { id: string }) {
    const server = await createTestServer(author.id);
    await prisma.serverMember.create({
      data: { userId: reporter.id, serverId: server.id, role: 'member' },
    }).catch(() => { /* may already exist */ });
    const channel = await prisma.channel.findFirst({ where: { serverId: server.id } });
    const message = await prisma.message.create({
      data: { channelId: channel!.id, authorId: author.id, content: 'reportable content' },
    });
    return { server, channel: channel!, message };
  }

  it('snapshots authorUsername/discriminator/emailHash/registeredAt for any reason', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();
    const { channel, message } = await createReportableChannelMessage(reporter, author);

    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({
        messageId: message.id,
        messageType: 'channel',
        channelId: channel.id,
        reason: 'harassment',
        details: 'identity-snapshot test',
      });

    expect(res.status).toBe(201);
    const report = await prisma.messageReport.findUnique({ where: { id: res.body.id } });
    expect(report).not.toBeNull();
    expect(report!.authorUsernameSnapshot).toBe(author.username);
    expect(report!.authorDiscriminatorSnapshot).toBe(author.discriminator);
    // emailHash should be a 64-char hex HMAC, not the plaintext email.
    expect(report!.authorEmailHashSnapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(report!.authorEmailHashSnapshot).not.toBe(author.email);
    expect(report!.authorRegisteredAtSnapshot).toBeInstanceOf(Date);
    // Non-CSAM: preservedAt stays null. §2258A doesn't apply.
    expect(report!.preservedAt).toBeNull();
  });

  it('sets preservedAt on CSAM reports specifically', async () => {
    const reporter = await createTestUser();
    const author = await createTestUser();
    const { channel, message } = await createReportableChannelMessage(reporter, author);

    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({
        messageId: message.id,
        messageType: 'channel',
        channelId: channel.id,
        reason: 'csam',
      });

    expect(res.status).toBe(201);
    const report = await prisma.messageReport.findUnique({ where: { id: res.body.id } });
    expect(report!.preservedAt).toBeInstanceOf(Date);
    // Identity snapshot fires regardless of reason, so CSAM reports also have it.
    expect(report!.authorUsernameSnapshot).toBe(author.username);
  });

  it('preserves snapshot fields after the accused user self-deletes', async () => {
    // The whole point of the snapshot: identity survives cascade. Verify by
    // creating a report, then deleting the author's User row, then reading
    // the report and confirming the snapshot fields are still there even
    // though authorId has been nulled by the FK SetNull.
    const reporter = await createTestUser();
    const author = await createTestUser();
    const { channel, message } = await createReportableChannelMessage(reporter, author);

    const res = await request(app)
      .post('/api/reports')
      .set('Authorization', `Bearer ${reporter.token}`)
      .send({
        messageId: message.id,
        messageType: 'channel',
        channelId: channel.id,
        reason: 'csam',
      });
    expect(res.status).toBe(201);

    // Author self-deletes. FK SetNull → authorId becomes null but the
    // *Snapshot fields and the rest of the row stay.
    await prisma.user.delete({ where: { id: author.id } });

    const after = await prisma.messageReport.findUnique({ where: { id: res.body.id } });
    expect(after).not.toBeNull();
    expect(after!.authorId).toBeNull();
    expect(after!.authorUsernameSnapshot).toBe(author.username);
    expect(after!.authorDiscriminatorSnapshot).toBe(author.discriminator);
    expect(after!.authorEmailHashSnapshot).toMatch(/^[0-9a-f]{64}$/);
    expect(after!.authorRegisteredAtSnapshot).toBeInstanceOf(Date);
    expect(after!.preservedAt).toBeInstanceOf(Date);
  });
});
