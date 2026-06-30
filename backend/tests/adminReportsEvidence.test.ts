// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Integration tests for the action-time evidence snapshot path on
 * PATCH /api/admin/reports/:reportId.
 *
 * Auto-flagged uploads populate uploaderIp / userAgent / sha256 etc.
 * synchronously at the upload request — that path is covered in
 * upload.test.ts. These tests cover the *user-reported* path: when T&S
 * confirms a CSAM report, we look up the session that was active around
 * the message's timestamp and snapshot rawIp / userAgent onto the report.
 *
 * Critical correctness property: the lookup picks the most-recent session
 * whose `createdAt <= message.createdAt`, NOT the most-recent session
 * overall. For a repeat offender who has logged in from a different IP
 * since sending the abusive message, "most-recent overall" returns the
 * wrong evidence.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, createTestChannel, cleanupTestData } from './helpers.js';
import type { TestUser } from './helpers.js';

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'test-admin-jwt-secret-for-vitest';
function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

let adminToken: string;
let adminUserId: string;

beforeAll(async () => {
  const admin = await prisma.adminUser.create({
    data: {
      email: `evidence-admin-${Date.now()}@test.com`,
      username: `evidenceadmin_${Date.now()}`,
      passwordHash: '$2b$04$dummyhashnotusedfortestlogin000000000000000000000',
      role: 'superadmin',
    },
  });
  adminUserId = admin.id;
  adminToken = jwt.sign({ adminId: admin.id, scope: 'admin' }, ADMIN_JWT_SECRET, {
    algorithm: 'HS256', expiresIn: '1h',
  });
  await prisma.adminSession.create({
    data: {
      adminUserId: admin.id,
      tokenHash: hashToken(adminToken),
      deviceName: 'Evidence Test Runner',
      os: 'Test',
    },
  });
});

afterAll(async () => {
  await prisma.adminSession.deleteMany({ where: { adminUserId } });
  await prisma.adminAuditLog.deleteMany({ where: { adminId: adminUserId } });
  await prisma.adminUser.delete({ where: { id: adminUserId } }).catch(() => {});
  await cleanupTestData();
});

async function makeReportedChannelMessage(args: {
  abuser: TestUser;
  reporter: TestUser;
  messageContent?: string;
}): Promise<{ messageId: string; reportId: string; channelId: string; serverId: string }> {
  const server = await createTestServer(args.abuser.id);
  await prisma.serverMember.create({
    data: { userId: args.reporter.id, serverId: server.id, role: 'member' },
  }).catch(() => { /* may already exist */ });
  const channel = await createTestChannel(server.id);
  const msg = await prisma.message.create({
    data: {
      channelId: channel.id,
      authorId: args.abuser.id,
      content: args.messageContent ?? 'reported message body',
    },
  });
  const report = await prisma.messageReport.create({
    data: {
      reporterId: args.reporter.id,
      messageType: 'channel',
      messageId: msg.id,
      channelId: channel.id,
      authorId: args.abuser.id,
      content: msg.content ?? '',
      reason: 'csam',
      // No evidenceSource — this is the user-reported path; action-time
      // lookup runs at PATCH time.
    },
  });
  return { messageId: msg.id, reportId: report.id, channelId: channel.id, serverId: server.id };
}

describe('PATCH /api/admin/reports/:reportId — action-time CSAM evidence', () => {
  it('snapshots IP/UA from the session active around the message timestamp (not the most-recent session)', async () => {
    const abuser = await createTestUser();
    const reporter = await createTestUser();
    const { reportId, messageId } = await makeReportedChannelMessage({ abuser, reporter });

    // Two sessions for the abuser:
    //   - "old": created 30 days ago, the IP they actually sent the
    //     abusive message from
    //   - "new": created 1 day ago, the IP they happen to have today
    // The message was sent 15 days ago, AFTER `old` but BEFORE `new`.
    // The snapshot must pick `old` — the IP the user was on when they
    // actually committed the offense, not their current IP.
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 3600 * 1000);
    const oneDayAgo = new Date(Date.now() - 1 * 24 * 3600 * 1000);

    await prisma.session.create({
      data: {
        userId: abuser.id,
        tokenHash: hashToken(`old-${reportId}`),
        deviceName: 'Old Browser',
        deviceType: 'web',
        os: 'Test',
        rawIp: '203.0.113.42',
        userAgent: 'old-abusive-session/1.0',
        createdAt: thirtyDaysAgo,
        lastActiveAt: thirtyDaysAgo,
      },
    });
    await prisma.session.create({
      data: {
        userId: abuser.id,
        tokenHash: hashToken(`new-${reportId}`),
        deviceName: 'New Browser',
        deviceType: 'web',
        os: 'Test',
        rawIp: '198.51.100.77',
        userAgent: 'new-clean-session/1.0',
        createdAt: oneDayAgo,
        lastActiveAt: oneDayAgo,
      },
    });
    // Backdate the *Message* itself — that's what the snapshot logic queries.
    // The report's createdAt only matters as a fallback when message lookup fails.
    await prisma.message.update({
      where: { id: messageId },
      data: { createdAt: fifteenDaysAgo },
    });

    const res = await request(app)
      .patch(`/api/admin/reports/${reportId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'actioned', actionTaken: 'ncmec_report' });

    expect(res.status).toBe(200);
    expect(res.body.evidenceSource).toBe('action-time-lookup');
    expect(res.body.sessionEvidence).toBe('captured');

    const after = await prisma.messageReport.findUnique({ where: { id: reportId } });
    expect(after).not.toBeNull();
    expect(after!.evidenceSource).toBe('action-time-lookup');
    expect(after!.uploaderIp).toBe('203.0.113.42');
    expect(after!.uploaderUserAgent).toBe('old-abusive-session/1.0');
    expect(after!.evidenceCapturedAt).toBeInstanceOf(Date);
    expect(after!.preservedAt).toBeInstanceOf(Date);
  });

  it('returns evidenceSource=action-time-unavailable when no session exists in the retention window', async () => {
    const abuser = await createTestUser();
    const reporter = await createTestUser();
    const { reportId } = await makeReportedChannelMessage({ abuser, reporter });

    // Null out the rawIp on every session for this user so the lookup
    // finds no candidate (simulates the 90-day TTL having already fired).
    await prisma.session.updateMany({
      where: { userId: abuser.id },
      data: { rawIp: null, userAgent: null },
    });

    const res = await request(app)
      .patch(`/api/admin/reports/${reportId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'actioned' });

    expect(res.status).toBe(200);
    expect(res.body.evidenceSource).toBe('action-time-unavailable');
    expect(res.body.sessionEvidence).toBe('unavailable');

    const after = await prisma.messageReport.findUnique({ where: { id: reportId } });
    expect(after!.evidenceSource).toBe('action-time-unavailable');
    expect(after!.uploaderIp).toBeNull();
    expect(after!.uploaderUserAgent).toBeNull();
    // preservedAt is still set — we want investigators to know we've
    // started preservation even if specific fields are unrecoverable.
    expect(after!.preservedAt).toBeInstanceOf(Date);
  });

  it('does not overwrite an existing upload-block snapshot', async () => {
    // Auto-flagged reports already have the gold-standard upload-time IP/UA.
    // Admin actioning them must NOT clobber that with a stale lookup.
    const abuser = await createTestUser();
    const report = await prisma.messageReport.create({
      data: {
        reporterId: null,
        messageType: 'channel',
        messageId: `auto-flag-${Date.now()}.png`,
        authorId: abuser.id,
        content: '[auto-flagged upload]',
        attachmentUrl: '/api/uploads/test.png',
        reason: 'csam',
        details: 'PDQ hash match: deadbeef',
        contentSource: 'server',
        status: 'pending',
        uploaderIp: '203.0.113.99',
        uploaderUserAgent: 'upload-time-ua/1.0',
        sha256: 'a'.repeat(64),
        evidenceSource: 'upload-block',
        evidenceCapturedAt: new Date(),
        preservedAt: new Date(),
      },
    });

    // Add a session for the abuser so the lookup *would* find something
    // if it were to run — proving the early-exit works.
    await prisma.session.create({
      data: {
        userId: abuser.id,
        tokenHash: hashToken(`would-overwrite-${report.id}`),
        deviceName: 'Test',
        deviceType: 'web',
        os: 'Test',
        rawIp: '198.51.100.1',
        userAgent: 'would-overwrite-ua/1.0',
      },
    });

    const res = await request(app)
      .patch(`/api/admin/reports/${report.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'actioned', actionTaken: 'ncmec_report' });

    expect(res.status).toBe(200);
    // No sessionEvidence key in the response — lookup was skipped.
    expect(res.body.sessionEvidence).toBeUndefined();

    const after = await prisma.messageReport.findUnique({ where: { id: report.id } });
    expect(after!.evidenceSource).toBe('upload-block');
    expect(after!.uploaderIp).toBe('203.0.113.99');
    expect(after!.uploaderUserAgent).toBe('upload-time-ua/1.0');
  });

  it('looks up sha256 from ImageHash by filename when actioning user-reported non-image CSAM', async () => {
    // The most important capture for video/audio CSAM CyberTipline reports.
    // Auto-flagged uploads populate sha256 synchronously at upload-block,
    // but user-reported video sits in T&S until confirmed. The fallback
    // queries ImageHash (where the upload route stored sha256 with hash=null
    // for the non-image case) and copies it onto the MessageReport.
    const abuser = await createTestUser();
    const reporter = await createTestUser();
    const server = await createTestServer(abuser.id);
    const channel = await createTestChannel(server.id);
    const filename = `${crypto.randomUUID()}.mp4`;
    const sha256 = 'b'.repeat(64);

    // Simulate what the upload route would have written for a video upload.
    await prisma.imageHash.create({
      data: {
        hash: null,
        sha256,
        uploaderId: abuser.id,
        filename,
        source: 'channel',
        sourceId: channel.id,
        flagMatch: false,
      },
    });

    const msg = await prisma.message.create({
      data: {
        channelId: channel.id,
        authorId: abuser.id,
        content: '',
        attachmentUrl: `/api/uploads/${filename}`,
      },
    });
    const report = await prisma.messageReport.create({
      data: {
        reporterId: reporter.id,
        messageType: 'channel',
        messageId: msg.id,
        channelId: channel.id,
        authorId: abuser.id,
        content: '',
        attachmentUrl: `/api/uploads/${filename}`,
        reason: 'csam',
        // Note: no sha256 at create time — that's what we're testing the fallback for.
      },
    });

    // Give the abuser a session so the IP/UA lookup also has something to find.
    // Backdate it so its createdAt is before the message's (the lookup picks
    // the most-recent session whose createdAt <= message.createdAt).
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.session.create({
      data: {
        userId: abuser.id,
        tokenHash: hashToken(`mp4-${report.id}`),
        deviceName: 'Test',
        deviceType: 'web',
        os: 'Test',
        rawIp: '203.0.113.55',
        userAgent: 'video-upload-ua/1.0',
        createdAt: oneHourAgo,
        lastActiveAt: oneHourAgo,
      },
    });

    const res = await request(app)
      .patch(`/api/admin/reports/${report.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'actioned', actionTaken: 'ncmec_report' });

    expect(res.status).toBe(200);

    const after = await prisma.messageReport.findUnique({ where: { id: report.id } });
    expect(after!.sha256).toBe(sha256);
    // Identity + IP/UA snapshots also fire on this path; we covered those above.
    expect(after!.evidenceSource).toBe('action-time-lookup');
  });

  it('does not run the lookup for non-CSAM reports', async () => {
    const abuser = await createTestUser();
    const reporter = await createTestUser();
    const server = await createTestServer(abuser.id);
    const channel = await createTestChannel(server.id);
    const msg = await prisma.message.create({
      data: { channelId: channel.id, authorId: abuser.id, content: 'spam' },
    });
    const report = await prisma.messageReport.create({
      data: {
        reporterId: reporter.id,
        messageType: 'channel',
        messageId: msg.id,
        channelId: channel.id,
        authorId: abuser.id,
        content: 'spam',
        reason: 'spam',
      },
    });

    await prisma.session.create({
      data: {
        userId: abuser.id,
        tokenHash: hashToken(`spam-${report.id}`),
        deviceName: 'Test',
        deviceType: 'web',
        os: 'Test',
        rawIp: '198.51.100.50',
        userAgent: 'spam-session/1.0',
      },
    });

    const res = await request(app)
      .patch(`/api/admin/reports/${report.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'actioned' });

    expect(res.status).toBe(200);
    expect(res.body.sessionEvidence).toBeUndefined();

    const after = await prisma.messageReport.findUnique({ where: { id: report.id } });
    expect(after!.evidenceSource).toBeNull();
    expect(after!.uploaderIp).toBeNull();
  });
});
