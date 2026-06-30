// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { prisma } from '../src/db.js';
import { hashToken } from '../src/utils/sessionUtils.js';
import { createTestUser, createTestServer, createTestChannel, cleanupTestData, authHeader, type TestUser } from './helpers.js';

// uploadAcl reads UPLOAD_ACL_ENABLED at module load. Set it BEFORE the first
// dynamic import of uploadAcl/server (in beforeAll) so the route-level suite sees
// the gate enabled, then clear it in afterAll so the flag does not leak into other
// suites (e.g. upload.test.ts, which asserts the flag-OFF unauthenticated serve).
// Matches the codebase idiom (cdnSign.test.ts): env in beforeAll + dynamic import.
let uploadAcl: typeof import('../src/services/uploadAcl.js');
let app: typeof import('../src/server.js')['app'];

let owner: TestUser;
let serverId: string;
let channelId: string;
let threadChannelId: string;
let forumChannelId: string;
let dmChannelId: string;
const imageUuid = randomUUID();
const dmUuid = randomUUID();
const threadUuid = randomUUID();
const forumMsgUuid = randomUUID();
const forumCoverUuid = randomUUID();

beforeAll(async () => {
  process.env.UPLOAD_ACL_ENABLED = 'true';
  uploadAcl = await import('../src/services/uploadAcl.js');
  // Import app AFTER the flag is set so upload.ts's uploadAcl import captures
  // UPLOAD_ACL_ENABLED=true (the const is read at module load).
  app = (await import('../src/server.js')).app;

  owner = await createTestUser();
  const server = await createTestServer(owner.id);
  serverId = server.id;
  const channel = await createTestChannel(serverId);
  channelId = channel.id;
  await prisma.message.create({
    data: { channelId, authorId: owner.id, content: 'pic', attachmentUrl: `/api/uploads/${imageUuid}.png` },
  });
  const dm = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: owner.id }] } }, select: { id: true } });
  dmChannelId = dm.id;
  await prisma.dMMessage.create({
    data: { dmChannelId, authorId: owner.id, content: 'dmpic', attachmentUrl: `/api/uploads/${dmUuid}.png` },
  });

  // Thread surface: a thread lives in a channel, anchored to a parent message.
  const threadChannel = await createTestChannel(serverId);
  threadChannelId = threadChannel.id;
  const parent = await prisma.message.create({ data: { channelId: threadChannelId, authorId: owner.id, content: 'parent' }, select: { id: true } });
  const thread = await prisma.thread.create({ data: { channelId: threadChannelId, parentMessageId: parent.id, serverId, name: 'T', authorId: owner.id }, select: { id: true } });
  await prisma.threadMessage.create({ data: { threadId: thread.id, authorId: owner.id, content: 'tpic', attachmentUrl: `/api/uploads/${threadUuid}.png` } });

  // Forum surface: a forum post in a channel, with a cover image + a reply attachment.
  const forumChannel = await createTestChannel(serverId);
  forumChannelId = forumChannel.id;
  const post = await prisma.forumPost.create({
    data: { channelId: forumChannelId, authorId: owner.id, title: 'P', content: 'body', imageUrl: `/api/uploads/${forumCoverUuid}.png` },
    select: { id: true },
  });
  await prisma.forumMessage.create({ data: { forumPostId: post.id, authorId: owner.id, content: 'fpic', attachmentUrl: `/api/uploads/${forumMsgUuid}.png` } });
});
afterAll(async () => { await cleanupTestData(); delete process.env.UPLOAD_ACL_ENABLED; });

describe('extractUploadStem', () => {
  it('returns the uuid stem for an original file', () => {
    expect(uploadAcl.extractUploadStem(`${imageUuid}.png`)).toBe(imageUuid);
  });
  it('strips thumb_/frame_ prefixes', () => {
    expect(uploadAcl.extractUploadStem(`thumb_${imageUuid}.webp`)).toBe(imageUuid);
    expect(uploadAcl.extractUploadStem(`frame_${imageUuid}.webp`)).toBe(imageUuid);
  });
  it('returns null for a non-uuid filename', () => {
    expect(uploadAcl.extractUploadStem('logo.png')).toBeNull();
  });
});

describe('resolveUploadOwner', () => {
  it('resolves a channel attachment to its channel', async () => {
    const o = await uploadAcl.resolveUploadOwner(`${imageUuid}.png`);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(channelId);
  });
  it('resolves a thumb_/frame_ derivative to the parent channel', async () => {
    const o = await uploadAcl.resolveUploadOwner(`frame_${imageUuid}.webp`);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(channelId);
  });
  it('resolves a DM attachment to its dm channel', async () => {
    const o = await uploadAcl.resolveUploadOwner(`${dmUuid}.png`);
    expect(o.kind).toBe('dm');
    if (o.kind === 'dm') expect(o.dmChannelIds).toContain(dmChannelId);
  });
  it('resolves a thread-message attachment to the thread channel', async () => {
    const o = await uploadAcl.resolveUploadOwner(`${threadUuid}.png`);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(threadChannelId);
  });
  it('resolves a forum-message attachment to the forum channel', async () => {
    const o = await uploadAcl.resolveUploadOwner(`${forumMsgUuid}.png`);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(forumChannelId);
  });
  it('resolves a forum-post cover image to the forum channel', async () => {
    const o = await uploadAcl.resolveUploadOwner(`${forumCoverUuid}.png`);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(forumChannelId);
  });
  it('returns public for a file with no message row (avatar/legacy)', async () => {
    const o = await uploadAcl.resolveUploadOwner(`${randomUUID()}.png`);
    expect(o.kind).toBe('public');
  });
  it('resolves an EXTENSIONLESS attachment (no dot) to its channel — fail-open regression', async () => {
    const u = randomUUID();
    const ch = await createTestChannel(serverId);
    await prisma.message.create({ data: { channelId: ch.id, authorId: owner.id, content: 'x', attachmentUrl: `/api/uploads/${u}` } });
    const o = await uploadAcl.resolveUploadOwner(u);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(ch.id);
  });
  it('resolves an absolute backend-origin attachment URL to its channel', async () => {
    const u = randomUUID();
    const ch = await createTestChannel(serverId);
    const origin = new URL((process.env.FRONTEND_ORIGIN || 'http://localhost:5000').split(',')[0].trim()).origin;
    await prisma.message.create({ data: { channelId: ch.id, authorId: owner.id, content: 'x', attachmentUrl: `${origin}/api/uploads/${u}.png` } });
    const o = await uploadAcl.resolveUploadOwner(`${u}.png`);
    expect(o.kind).toBe('channel');
    if (o.kind === 'channel') expect(o.channelIds).toContain(ch.id);
  });
});

describe('identifyServeViewer', () => {
  it('resolves a userId from a valid Bearer access token backed by a live session', async () => {
    // owner.token is a real access token with a Session row (createTestUser).
    const req = { headers: { authorization: `Bearer ${owner.token}` }, cookies: {} } as any;
    expect(await uploadAcl.identifyServeViewer(req)).toBe(owner.id);
  });

  it('rejects a Bearer token whose session was revoked (logged out)', async () => {
    const u = await createTestUser();
    await prisma.session.deleteMany({ where: { userId: u.id } });
    const req = { headers: { authorization: `Bearer ${u.token}` }, cookies: {} } as any;
    expect(await uploadAcl.identifyServeViewer(req)).toBeNull();
  });

  it('rejects a Bearer token for a suspended user', async () => {
    const u = await createTestUser();
    await prisma.user.update({ where: { id: u.id }, data: { suspended: true } });
    const req = { headers: { authorization: `Bearer ${u.token}` }, cookies: {} } as any;
    expect(await uploadAcl.identifyServeViewer(req)).toBeNull();
  });

  it('rejects an MFA-purpose token', async () => {
    const token = jwt.sign({ userId: owner.id, purpose: 'mfa' }, process.env.JWT_SECRET!, { algorithm: 'HS256' });
    const req = { headers: { authorization: `Bearer ${token}` }, cookies: {} } as any;
    expect(await uploadAcl.identifyServeViewer(req)).toBeNull();
  });

  it('resolves a userId from the howl_refresh session cookie', async () => {
    const refresh = randomUUID() + randomUUID();
    await prisma.session.create({
      data: {
        userId: owner.id,
        tokenHash: hashToken(randomUUID()),
        refreshTokenHash: hashToken(refresh),
        deviceName: 'Cookie Test', deviceType: 'web', os: 'Test',
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });
    const req = { headers: {}, cookies: { howl_refresh: refresh } } as any;
    expect(await uploadAcl.identifyServeViewer(req)).toBe(owner.id);
  });

  it('returns null with no credential', async () => {
    const req = { headers: {}, cookies: {} } as any;
    expect(await uploadAcl.identifyServeViewer(req)).toBeNull();
  });
});

describe('authorizeUploadAccess', () => {
  it('always allows a public owner', async () => {
    expect(await uploadAcl.authorizeUploadAccess(owner.id, { kind: 'public' })).toBe(true);
  });
  it('allows a channel member (owner) and denies a non-member', async () => {
    const stranger = await createTestUser();
    expect(await uploadAcl.authorizeUploadAccess(owner.id, { kind: 'channel', channelIds: [channelId] })).toBe(true);
    expect(await uploadAcl.authorizeUploadAccess(stranger.id, { kind: 'channel', channelIds: [channelId] })).toBe(false);
  });
  it('allows an active DM participant and denies an outsider', async () => {
    const stranger = await createTestUser();
    expect(await uploadAcl.authorizeUploadAccess(owner.id, { kind: 'dm', dmChannelIds: [dmChannelId] })).toBe(true);
    expect(await uploadAcl.authorizeUploadAccess(stranger.id, { kind: 'dm', dmChannelIds: [dmChannelId] })).toBe(false);
  });
  it('allows a both-owner when either context grants, denies when neither does', async () => {
    const stranger = await createTestUser();
    expect(await uploadAcl.authorizeUploadAccess(owner.id, { kind: 'both', channelIds: [channelId], dmChannelIds: [dmChannelId] })).toBe(true);
    expect(await uploadAcl.authorizeUploadAccess(stranger.id, { kind: 'both', channelIds: [channelId], dmChannelIds: [dmChannelId] })).toBe(false);
  });
});

describe('GET /api/uploads/:filename — ACL (flag on)', () => {
  let member: TestUser;
  let nonMember: TestUser;
  const chFile = `${randomUUID()}.png`;
  const dmFile = `${randomUUID()}.png`;
  let aclServerId: string;
  let aclChannelId: string;
  let aclDmId: string;

  beforeAll(async () => {
    member = await createTestUser();
    nonMember = await createTestUser();
    const server = await createTestServer(member.id); // member is owner
    aclServerId = server.id;
    // @everyone grants readMessageHistory so a plain (non-owner) member can read,
    // making the removed-member test's before(200)/after-kick(403) assertion exact.
    await prisma.serverRole.create({
      data: { serverId: aclServerId, name: '@everyone', position: 999, isEveryone: true, permissions: { viewChannels: true, readMessageHistory: true } as never },
    });
    const channel = await createTestChannel(aclServerId);
    aclChannelId = channel.id;
    await prisma.message.create({ data: { channelId: aclChannelId, authorId: member.id, content: 'x', attachmentUrl: `/api/uploads/${chFile}` } });
    const dm = await prisma.dMChannel.create({ data: { participants: { create: [{ userId: member.id }] } }, select: { id: true } });
    aclDmId = dm.id;
    await prisma.dMMessage.create({ data: { dmChannelId: aclDmId, authorId: member.id, content: 'x', attachmentUrl: `/api/uploads/${dmFile}` } });
  });

  it('serves a channel attachment to a member (200 json url)', async () => {
    const res = await request(app).get(`/api/uploads/${chFile}?as=json`).set('Authorization', authHeader(member.token));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('url');
  });

  it('rejects a non-member (403)', async () => {
    const res = await request(app).get(`/api/uploads/${chFile}?as=json`).set('Authorization', authHeader(nonMember.token));
    expect(res.status).toBe(403);
  });

  it('rejects an anonymous request for a gated channel file (403)', async () => {
    const res = await request(app).get(`/api/uploads/${chFile}?as=json`);
    expect(res.status).toBe(403);
  });

  it('gates a frame_/thumb_ derivative against the parent channel', async () => {
    const stem = chFile.replace(/\.[^.]+$/, '');
    const member200 = await request(app).get(`/api/uploads/frame_${stem}.webp?as=json`).set('Authorization', authHeader(member.token));
    expect(member200.status).toBe(200);
    const nonMember403 = await request(app).get(`/api/uploads/thumb_${stem}.webp?as=json`).set('Authorization', authHeader(nonMember.token));
    expect(nonMember403.status).toBe(403);
  });

  it('serves a public asset (no message row) unauthenticated', async () => {
    const res = await request(app).get(`/api/uploads/${randomUUID()}.png?as=json`);
    expect(res.status).toBe(200); // public/legacy fallthrough
  });

  it('serves a plain member, then rejects them after removal from the server', async () => {
    const transient = await createTestUser();
    await prisma.serverMember.create({ data: { userId: transient.id, serverId: aclServerId, role: 'member' } });
    const before = await request(app).get(`/api/uploads/${chFile}?as=json`).set('Authorization', authHeader(transient.token));
    expect(before.status).toBe(200); // @everyone grants readMessageHistory
    await prisma.serverMember.deleteMany({ where: { userId: transient.id, serverId: aclServerId } });
    const after = await request(app).get(`/api/uploads/${chFile}?as=json`).set('Authorization', authHeader(transient.token));
    expect(after.status).toBe(403);
  });

  it('serves a DM attachment to an active participant and rejects an outsider', async () => {
    const inRes = await request(app).get(`/api/uploads/${dmFile}?as=json`).set('Authorization', authHeader(member.token));
    expect(inRes.status).toBe(200);
    const outRes = await request(app).get(`/api/uploads/${dmFile}?as=json`).set('Authorization', authHeader(nonMember.token));
    expect(outRes.status).toBe(403);
  });

  it('gates an EXTENSIONLESS channel attachment (fail-open regression): member 200, non-member 403', async () => {
    const extlFile = randomUUID(); // no extension -> stored as /api/uploads/<uuid>
    await prisma.message.create({ data: { channelId: aclChannelId, authorId: member.id, content: 'x', attachmentUrl: `/api/uploads/${extlFile}` } });
    const memberRes = await request(app).get(`/api/uploads/${extlFile}?as=json`).set('Authorization', authHeader(member.token));
    expect(memberRes.status).toBe(200);
    const nonMemberRes = await request(app).get(`/api/uploads/${extlFile}?as=json`).set('Authorization', authHeader(nonMember.token));
    expect(nonMemberRes.status).toBe(403);
  });

  it('gates a PRIVATE channel by view override: a granted member 200s, a plain @everyone member 403s', async () => {
    const privFile = `${randomUUID()}.png`;
    const privChannel = await prisma.channel.create({ data: { serverId: aclServerId, name: 'secret', type: 'text', isPrivate: true, position: 99 } });
    await prisma.message.create({ data: { channelId: privChannel.id, authorId: member.id, content: 'x', attachmentUrl: `/api/uploads/${privFile}` } });
    const granted = await createTestUser();
    const plain = await createTestUser();
    await prisma.serverMember.createMany({ data: [
      { userId: granted.id, serverId: aclServerId, role: 'member' },
      { userId: plain.id, serverId: aclServerId, role: 'member' },
    ] });
    // Member-scoped view override on the private channel grants only `granted`.
    await prisma.channelPermissionOverride.create({ data: { channelId: privChannel.id, targetType: 'member', targetId: granted.id, permissions: { viewChannels: true, readMessageHistory: true } as never } });
    const grantedRes = await request(app).get(`/api/uploads/${privFile}?as=json`).set('Authorization', authHeader(granted.token));
    expect(grantedRes.status).toBe(200);
    // plain relies on @everyone(viewChannels) which does NOT satisfy requireOverride on a private channel.
    const plainRes = await request(app).get(`/api/uploads/${privFile}?as=json`).set('Authorization', authHeader(plain.token));
    expect(plainRes.status).toBe(403);
  });
});
