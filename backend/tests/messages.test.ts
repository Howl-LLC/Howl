// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../src/server.js';
import { prisma } from '../src/db.js';
import {
  createTestUser,
  createTestServer,
  createTestChannel,
  authHeader,
  cleanupTestData,
  type TestUser,
} from './helpers.js';

let user: TestUser;
let serverId: string;
let channelId: string;
let messageId: string;

beforeAll(async () => {
  user = await createTestUser();
  const server = await createTestServer(user.id);
  serverId = server.id;
  const channel = await createTestChannel(serverId);
  channelId = channel.id;
});

afterAll(cleanupTestData);

describe('POST /api/messages/channels/:channelId', () => {
  it('returns 401 without auth', async () => {
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .send({ content: 'Hello' });

    expect(res.status).toBe(401);
  });

  it('returns 201 with valid auth and message data', async () => {
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token))
      .send({ content: 'Hello, world!' });

    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('id');
    expect(res.body.content).toBe('Hello, world!');
    expect(res.body.authorId).toBe(user.id);
    expect(res.body.channelId).toBe(channelId);
    messageId = res.body.id;
  });

  it('returns 400 when content is empty', async () => {
    const res = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token))
      .send({ content: '' });

    expect(res.status).toBe(400);
  });
});

describe('GET /api/messages/channels/:channelId', () => {
  it('returns the sent message', async () => {
    const res = await request(app)
      .get(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('messages');
    expect(Array.isArray(res.body.messages)).toBe(true);

    const match = res.body.messages.find((m: { id: string }) => m.id === messageId);
    expect(match).toBeDefined();
    expect(match.content).toBe('Hello, world!');
  });
});

describe('PATCH /api/messages/channels/:channelId/messages/:messageId', () => {
  it('edits own message successfully', async () => {
    const res = await request(app)
      .patch(`/api/messages/channels/${channelId}/messages/${messageId}`)
      .set('Authorization', authHeader(user.token))
      .send({ content: 'Edited message' });

    expect(res.status).toBe(200);
    expect(res.body.content).toBe('Edited message');
    expect(res.body.editedAt).not.toBeNull();
  });
});

describe('DELETE /api/messages/channels/:channelId/messages/:messageId', () => {
  it('deletes own message successfully', async () => {
    const res = await request(app)
      .delete(`/api/messages/channels/${channelId}/messages/${messageId}`)
      .set('Authorization', authHeader(user.token));

    expect([200, 204]).toContain(res.status);
  });
});

// Spoiler fields on server messages (legacy column dropped)

describe('spoiler fields on server messages', () => {
  it('attachmentIsSpoiler=true is persisted to the DB row', async () => {
    const sendRes = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token))
      .send({
        content: 'spoiler test',
        attachmentUrl: '/api/uploads/test-spoiler.png',
        attachmentName: 'test-spoiler.png',
        attachmentIsSpoiler: true,
      });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.attachmentIsSpoiler).toBe(true);

    // Verify in the DB
    const dbRow = await prisma.message.findUnique({
      where: { id: sendRes.body.id },
      select: { attachmentIsSpoiler: true },
    });
    expect(dbRow).toBeDefined();
    expect(dbRow!.attachmentIsSpoiler).toBe(true);
  });

  // "legacy attachmentIsExplicit=true is treated as spoiler via dual-accept"
  // test deleted: the legacy column no longer exists and the dual-accept
  // window is closed.

  it('attachmentAlt round-trips on send and fetch', async () => {
    const sendRes = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token))
      .send({
        content: 'alt text test',
        attachmentUrl: '/api/uploads/alt.png',
        attachmentName: 'alt.png',
        attachmentAlt: 'A beautiful sunset over the ocean',
      });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.attachmentAlt).toBe('A beautiful sunset over the ocean');

    // Fetch and verify
    const fetchRes = await request(app)
      .get(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token));
    expect(fetchRes.status).toBe(200);
    const match = fetchRes.body.messages.find(
      (m: { id: string }) => m.id === sendRes.body.id,
    );
    expect(match).toBeDefined();
    expect(match.attachmentAlt).toBe('A beautiful sunset over the ocean');
  });

  it('attachmentIsSpoiler defaults to false when not provided', async () => {
    const sendRes = await request(app)
      .post(`/api/messages/channels/${channelId}`)
      .set('Authorization', authHeader(user.token))
      .send({
        content: 'no spoiler test',
        attachmentUrl: '/api/uploads/normal.png',
        attachmentName: 'normal.png',
      });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.attachmentIsSpoiler).toBe(false);
  });

  // "new field takes precedence when both are supplied" test deleted: the
  // legacy attachmentIsExplicit field no longer exists, so no "both" scenario
  // is possible.
});
