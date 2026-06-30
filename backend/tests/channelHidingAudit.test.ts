// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import { app, httpServer } from '../src/server.js';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import type { AddressInfo } from 'net';
import { prisma } from '../src/db.js';
import { getIO } from '../src/socketIO.js';
import { filterVisibleChannelIds, emitChannelEventToViewers } from '../src/utils/channelVisibility.js';
import { loadPermissionContext } from '../src/utils/permissions.js';
import { createTestUser, createTestServer, authHeader, cleanupTestData } from './helpers.js';
import { addVoiceParticipant, setVoiceReverseLookup } from '../src/redis.js';

const EVERYONE_BASELINE = {
  viewChannels: true, sendMessages: true, readMessageHistory: true,
  connect: true, speak: true, createPosts: true, sendMessagesInPosts: true,
};
type ChannelType = 'text' | 'voice' | 'stage' | 'forum';

async function seedScenario(type: ChannelType) {
  const owner = await createTestUser();
  const granted = await createTestUser();
  const notGranted = await createTestUser();
  const server = await createTestServer(owner.id);
  const serverId = server.id;
  const categoryId = server.categories[0]!.id;
  const everyone = await prisma.serverRole.create({
    data: { serverId, name: '@everyone', color: '#99aab5', style: 'solid', position: 999, locked: true, isEveryone: true, permissions: EVERYONE_BASELINE },
  });
  await prisma.serverMember.create({ data: { userId: granted.id, serverId, role: 'member' } });
  await prisma.serverMember.create({ data: { userId: notGranted.id, serverId, role: 'member' } });
  const channel = await prisma.channel.create({
    data: { id: randomUUID(), name: `private-${type}`, type, serverId, categoryId, position: 10, isPrivate: true },
  });
  await prisma.channelPermissionOverride.create({
    data: { channelId: channel.id, targetType: 'member', targetId: granted.id, permissions: { viewChannels: true } },
  });
  if (type === 'voice') {
    // The join-voice-channel handler rejects users without a published key
    // bundle BEFORE we reach the size/E2EE gates. Give notGranted a bundle so
    // the only thing standing between them and the channel is the private-view
    // gate this test exercises.
    await prisma.dmKeyBundle.create({
      data: { userId: notGranted.id, publicKey: 'x', encryptedBlob: 'x', blobSalt: 'x', recoveryBlob: 'x', recoveryNonce: 'x' },
    });
  }
  return { owner, granted, notGranted, serverId, channelId: channel.id, everyoneId: everyone.id };
}

let baseUrl: string;
const clients: ClientSocket[] = [];
function connectSocket(token: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { transports: ['websocket'], auth: { token }, forceNew: true, reconnection: false });
    clients.push(s);
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
    setTimeout(() => reject(new Error('socket timeout')), 5000);
  });
}

beforeAll(async () => {
  await new Promise<void>((r) => httpServer.listen(0, () => r()));
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => {
  for (const c of clients) if (c.connected) c.disconnect();
  await cleanupTestData();
  await new Promise<void>((r) => httpServer.close(() => r()));
});

describe('filterVisibleChannelIds (already enforced)', () => {
  for (const type of ['text', 'voice', 'stage', 'forum'] as ChannelType[]) {
    it(`excludes a private ${type} channel for a member without a viewChannels override`, async () => {
      const s = await seedScenario(type);
      const ctxDenied = await loadPermissionContext(s.notGranted.id, s.serverId);
      const ctxGranted = await loadPermissionContext(s.granted.id, s.serverId);
      const channels = [{ id: s.channelId, isPrivate: true, categoryId: null }];
      expect(await filterVisibleChannelIds(ctxDenied!, channels)).not.toContain(s.channelId);
      expect(await filterVisibleChannelIds(ctxGranted!, channels)).toContain(s.channelId);
    });
  }
});

describe('socket join-channel (already enforced)', () => {
  it('does not join a non-granted member to a private channel room', async () => {
    const s = await seedScenario('text');
    const sock = await connectSocket(s.notGranted.token);
    sock.emit('join-channel', s.channelId);
    await new Promise((r) => setTimeout(r, 300));
    const all = await getIO().fetchSockets();
    const mine = all.find((x) => x.rooms.has(`user:${s.notGranted.id}`));
    expect(mine?.rooms.has(`channel:${s.channelId}`)).toBe(false);
  });
  it('joins a granted member to the private channel room', async () => {
    const s = await seedScenario('text');
    const sock = await connectSocket(s.granted.token);
    sock.emit('join-channel', s.channelId);
    await new Promise((r) => setTimeout(r, 300));
    const all = await getIO().fetchSockets();
    const mine = all.find((x) => x.rooms.has(`user:${s.granted.id}`));
    expect(mine?.rooms.has(`channel:${s.channelId}`)).toBe(true);
  });
});

describe('GET /:serverId channel-list excludes private channels', () => {
  for (const type of ['text', 'voice', 'stage', 'forum'] as ChannelType[]) {
    it(`hides a private ${type} channel from a member without an override`, async () => {
      const s = await seedScenario(type);
      const denied = await request(app).get(`/api/servers/${s.serverId}`).set('Authorization', authHeader(s.notGranted.token));
      expect(denied.status).toBe(200);
      expect(denied.body.channels.map((c: { id: string }) => c.id)).not.toContain(s.channelId);
      const ok = await request(app).get(`/api/servers/${s.serverId}`).set('Authorization', authHeader(s.granted.token));
      expect(ok.body.channels.map((c: { id: string }) => c.id)).toContain(s.channelId);
      const asOwner = await request(app).get(`/api/servers/${s.serverId}`).set('Authorization', authHeader(s.owner.token));
      expect(asOwner.body.channels.map((c: { id: string }) => c.id)).toContain(s.channelId);
    });
  }
});

describe('message read path honors private channels', () => {
  it('returns 404 for a non-granted member fetching a private channel message list', async () => {
    const s = await seedScenario('text');
    const res = await request(app).get(`/api/messages/channels/${s.channelId}`).set('Authorization', authHeader(s.notGranted.token));
    expect(res.status).toBe(404);
  });
  it('returns 200 for a granted member', async () => {
    const s = await seedScenario('text');
    const res = await request(app).get(`/api/messages/channels/${s.channelId}`).set('Authorization', authHeader(s.granted.token));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.messages)).toBe(true);
  });
});

describe('forum read path honors private channels', () => {
  it('returns 404 for a non-granted member listing posts in a private forum channel', async () => {
    const s = await seedScenario('forum');
    const res = await request(app).get(`/api/v1/servers/${s.serverId}/channels/${s.channelId}/posts`).set('Authorization', authHeader(s.notGranted.token));
    expect(res.status).toBe(404);
  });
  it('returns 200 for a granted member', async () => {
    const s = await seedScenario('forum');
    const res = await request(app).get(`/api/v1/servers/${s.serverId}/channels/${s.channelId}/posts`).set('Authorization', authHeader(s.granted.token));
    expect(res.status).toBe(200);
  });
});

describe('join-voice-channel honors private channels', () => {
  function joinVoice(sock: ClientSocket, channelId: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      sock.emit('join-voice-channel', { channelId }, (resp: { ok: boolean; error?: string }) => resolve(resp));
      setTimeout(() => resolve({ ok: false, error: 'timeout' }), 2000);
    });
  }
  it('rejects a non-granted member joining a private voice channel', async () => {
    const s = await seedScenario('voice');
    const sock = await connectSocket(s.notGranted.token);
    const resp = await joinVoice(sock, s.channelId);
    expect(resp.ok).toBe(false);
  });
});

describe('stage-join-audience honors private channels', () => {
  function joinStage(sock: ClientSocket, channelId: string): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve) => {
      sock.emit('stage-join-audience', channelId, (resp: { ok: boolean; error?: string }) => resolve(resp));
      setTimeout(() => resolve({ ok: false, error: 'timeout' }), 2000);
    });
  }
  it('rejects a non-granted member joining a private stage channel', async () => {
    const s = await seedScenario('stage');
    // The handler's viewChannels gate runs BEFORE the "No active stage" check,
    // so without a live session a non-granted member would be rejected for the
    // wrong reason. Start a real stage session as the owner (owner
    // short-circuits manageStages) so the join actually reaches the
    // private-view gate.
    const start = await request(app)
      .post(`/api/v1/servers/${s.serverId}/channels/${s.channelId}/stage/start`)
      .set('Authorization', authHeader(s.owner.token))
      .send({});
    expect(start.status).toBe(201);
    const sock = await connectSocket(s.notGranted.token);
    const resp = await joinStage(sock, s.channelId);
    expect(resp.ok).toBe(false);
  });
});

describe('livekit token honors private channels', () => {
  it('returns 403 for a non-granted member requesting a private voice channel token', async () => {
    const s = await seedScenario('voice');
    // Forge Redis membership so the route's "you must join the channel first"
    // gate (isInVoiceChannel) passes, isolating the new private-view re-check.
    // Real signatures (redis.ts): addVoiceParticipant(channelId, userId, data:
    // VoiceParticipant {username,...}); setVoiceReverseLookup(userId, channelId).
    await addVoiceParticipant(s.channelId, s.notGranted.id, { username: 'x', joinedAt: Date.now() });
    await setVoiceReverseLookup(s.notGranted.id, s.channelId);
    const res = await request(app)
      .post(`/api/livekit/token`)
      .set('Authorization', authHeader(s.notGranted.token))
      .send({ roomName: `voice:${s.channelId}`, participantName: 'x' });
    // The forged member passes connect + join-first, so the request reaches the
    // private-view re-check, which intercepts with 403 (rather than continuing
    // to region resolution).
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/permission to view this channel/);
  });
});

describe('Private-channel metadata broadcast is scoped to viewers (socket)', () => {
  it('channel-created for a PRIVATE channel reaches the owner but NOT a non-granted member', async () => {
    const owner = await createTestUser();
    const member = await createTestUser();
    const server = await createTestServer(owner.id);
    await prisma.serverRole.create({
      data: { serverId: server.id, name: '@everyone', color: '#99aab5', style: 'solid', position: 999, locked: true, isEveryone: true, permissions: EVERYONE_BASELINE },
    });
    await prisma.serverMember.create({ data: { userId: member.id, serverId: server.id, role: 'member' } });

    const ownerSock = await connectSocket(owner.token);
    const memberSock = await connectSocket(member.token);
    await new Promise((r) => setTimeout(r, 300)); // connection-time server-room auto-subscribe

    let ownerGot: any = null;
    let memberGot: any = null;
    ownerSock.on('channel-created', (p: any) => { ownerGot = p; });
    memberSock.on('channel-created', (p: any) => { memberGot = p; });

    const res = await request(app)
      .post(`/api/servers/${server.id}/channels`)
      .set('Authorization', authHeader(owner.token))
      .send({ name: 'secret-plans', type: 'text', isPrivate: true });
    expect(res.status).toBe(201);
    expect(res.body.isPrivate).toBe(true);

    await new Promise((r) => setTimeout(r, 300));
    expect(ownerGot?.channel?.id).toBe(res.body.id); // owner (creator) still receives it
    expect(memberGot).toBeNull();                    // non-granted member must NOT
  });

  it('emitChannelEventToViewers delivers a private-channel event to owner + override-holder, not to a non-viewer', async () => {
    const s = await seedScenario('text'); // private channel + member override granting `granted` viewChannels
    const ownerSock = await connectSocket(s.owner.token);
    const grantedSock = await connectSocket(s.granted.token);
    const deniedSock = await connectSocket(s.notGranted.token);
    await new Promise((r) => setTimeout(r, 300));

    let ownerGot: any = null, grantedGot: any = null, deniedGot: any = null;
    ownerSock.on('test-scoped-channel', (p: any) => { ownerGot = p; });
    grantedSock.on('test-scoped-channel', (p: any) => { grantedGot = p; });
    deniedSock.on('test-scoped-channel', (p: any) => { deniedGot = p; });

    const chOvr = await prisma.channelPermissionOverride.findMany({ where: { channelId: s.channelId }, take: 1000 });
    const chan = await prisma.channel.findUnique({ where: { id: s.channelId }, select: { categoryId: true } });
    await emitChannelEventToViewers({
      io: getIO(),
      serverId: s.serverId,
      channel: { id: s.channelId, isPrivate: true, categoryId: chan?.categoryId ?? null },
      channelOverrides: chOvr,
      categoryOverrides: [],
      event: 'test-scoped-channel',
      payload: { hello: true },
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(ownerGot).toEqual({ hello: true });   // owner bypass
    expect(grantedGot).toEqual({ hello: true });  // viewChannels override
    expect(deniedGot).toBeNull();                 // no override, not owner/admin
  });

  it('channel-updated-meta for a PRIVATE channel reaches a granted viewer but NOT a non-viewer', async () => {
    const s = await seedScenario('text'); // private channel + member override for `granted`
    const grantedSock = await connectSocket(s.granted.token);
    const deniedSock = await connectSocket(s.notGranted.token);
    await new Promise((r) => setTimeout(r, 300));

    let grantedGot: any = null, deniedGot: any = null;
    grantedSock.on('channel-updated-meta', (p: any) => { grantedGot = p; });
    deniedSock.on('channel-updated-meta', (p: any) => { deniedGot = p; });

    const res = await request(app)
      .patch(`/api/servers/${s.serverId}/channels/${s.channelId}`)
      .set('Authorization', authHeader(s.owner.token))
      .send({ name: 'renamed-secret' });
    expect(res.status).toBe(200);

    await new Promise((r) => setTimeout(r, 300));
    expect(grantedGot?.channel?.id).toBe(s.channelId); // override-holder gets the meta update
    expect(deniedGot).toBeNull();                       // non-viewer must NOT
  });
});
