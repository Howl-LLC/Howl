// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * DM E2EE invariant regression test (spoiler / age-gate metadata).
 *
 * Asserts that sending a DM with attachmentIsSpoiler=true and attachmentAlt
 * does NOT cause any server-side content inspection. The spoiler/alt fields
 * are stored alongside the (potentially encrypted) message and emitted
 * unchanged on read. The server never interprets, filters, or logs based on
 * these fields for DMs — they are sender-set metadata.
 *
 * The legacy `attachmentIsExplicit` column no longer exists on DMMessage.
 * Only `attachmentIsSpoiler` and `attachmentAlt` remain.
 *
 * Privacy invariant: "NEVER add content inspection, automod, logging, or
 * filtering to DM message handlers. DMs are E2E encrypted; the server sees
 * opaque blobs."
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';
import { randomUUID } from 'crypto';

let sender: TestUser;
let receiver: TestUser;
let dmChannelId: string;

beforeAll(async () => {
  sender = await createTestUser();
  receiver = await createTestUser();

  // Create a 1:1 DM channel with both users as participants.
  dmChannelId = randomUUID();
  await prisma.dMChannel.create({ data: { id: dmChannelId } });
  await prisma.dMParticipant.createMany({
    data: [
      { userId: sender.id, dmChannelId },
      { userId: receiver.id, dmChannelId },
    ],
  });
});

afterAll(cleanupTestData);

describe('DM spoiler + alt text E2EE invariant', () => {
  let sentMessageId: string;
  const testAlt = 'A description the server must not inspect or filter';

  it('stores attachmentIsSpoiler and attachmentAlt on DM message without content inspection', async () => {
    const res = await request(app)
      .post(`/api/dms/${dmChannelId}/messages`)
      .set('Authorization', authHeader(sender.token))
      .send({
        content: 'dm spoiler test',
        attachmentUrl: '/api/uploads/dm-spoiler.enc',
        attachmentName: 'dm-spoiler.enc',
        attachmentIsSpoiler: true,
        attachmentAlt: testAlt,
      });
    expect(res.status).toBe(201);
    sentMessageId = res.body.id;

    // Fields are echoed back unchanged
    expect(res.body.attachmentIsSpoiler).toBe(true);
    expect(res.body.attachmentAlt).toBe(testAlt);
  });

  it('fetched DM message preserves spoiler/alt fields unchanged', async () => {
    const res = await request(app)
      .get(`/api/dms/${dmChannelId}/messages`)
      .set('Authorization', authHeader(receiver.token));
    expect(res.status).toBe(200);

    const match = res.body.messages.find(
      (m: { id: string }) => m.id === sentMessageId,
    );
    expect(match).toBeDefined();
    expect(match.attachmentIsSpoiler).toBe(true);
    expect(match.attachmentAlt).toBe(testAlt);
  });

  it('DB row stores attachmentIsSpoiler and attachmentAlt', async () => {
    const dbRow = await prisma.dMMessage.findUnique({
      where: { id: sentMessageId },
      select: {
        attachmentIsSpoiler: true,
        attachmentAlt: true,
      },
    });
    expect(dbRow).toBeDefined();
    expect(dbRow!.attachmentIsSpoiler).toBe(true);
    expect(dbRow!.attachmentAlt).toBe(testAlt);
  });

  it('non-spoiler DM message has attachmentIsSpoiler=false by default', async () => {
    const res = await request(app)
      .post(`/api/dms/${dmChannelId}/messages`)
      .set('Authorization', authHeader(sender.token))
      .send({
        content: 'normal dm message',
        attachmentUrl: '/api/uploads/normal.enc',
        attachmentName: 'normal.enc',
      });
    expect(res.status).toBe(201);
    expect(res.body.attachmentIsSpoiler).toBe(false);
    expect(res.body.attachmentAlt).toBeNull();
  });
});
