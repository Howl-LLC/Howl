// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app, httpServer } from '../src/server.js';
import { createTestUser, authHeader, cleanupTestData, type TestUser } from './helpers.js';
import { prisma } from '../src/db.js';
import { mlsCreateGroupSchema } from '../src/schemas';

describe('mlsCreateGroupSchema tier', () => {
  const base = { dmChannelId: '11111111-1111-4111-8111-111111111111', groupInfo: 'AA==' };
  it('accepts tier="otr"', () => {
    const r = mlsCreateGroupSchema.safeParse({ body: { ...base, tier: 'otr' } });
    expect(r.success).toBe(true);
  });
  it('defaults missing tier to "saved"', () => {
    const r = mlsCreateGroupSchema.safeParse({ body: base });
    expect(r.success && r.data.body.tier).toBe('saved');
  });
  it('rejects an unknown tier', () => {
    const r = mlsCreateGroupSchema.safeParse({ body: { ...base, tier: 'bogus' } });
    expect(r.success).toBe(false);
  });
});

// Server-enforced OTR eligibility gate on POST /mls/groups.
// tier:'otr' requires the channel to be 1:1 AND every participant to be on
// "Private"/user-held recovery (DmKeyBundle.passwordDerived === false). The
// 403 is generic ('Off the Record is not available for this chat') and must
// never reveal WHICH participant is ineligible (counterparty recovery-mode
// privacy). tier:'saved' (or omitted) is unaffected by the gate.

const OTR_MSG = 'Off the Record is not available for this chat';

/** Create a 1:1 (or group) DM channel with the given participants. */
async function createDmChannel(userIds: string[], isGroup = false): Promise<string> {
  const channel = await prisma.dMChannel.create({
    data: { isGroup, participants: { create: userIds.map((userId) => ({ userId })) } },
    select: { id: true },
  });
  return channel.id;
}

/** Seed a DmKeyBundle row for a user with the given recovery mode. */
async function seedKeyBundle(userId: string, passwordDerived: boolean): Promise<void> {
  await prisma.dmKeyBundle.create({
    data: {
      userId,
      publicKey: 'AA==',
      encryptedBlob: 'AA==',
      blobSalt: 'AA==',
      recoveryBlob: 'AA==',
      recoveryNonce: 'AA==',
      passwordDerived,
    },
  });
}

describe('POST /mls/groups — OTR eligibility gate', () => {
  let alice: TestUser;
  let bob: TestUser;

  beforeAll(async () => {
    await new Promise<void>((r) => httpServer.listen(0, r));
    alice = await createTestUser();
    bob = await createTestUser();
  });
  afterAll(async () => {
    await new Promise<void>((r) => httpServer.close(() => r()));
    await prisma.mlsGroup.deleteMany({});
    await cleanupTestData();
  });

  it('allows OTR when both participants are Private (passwordDerived=false) on a 1:1 channel → 201', async () => {
    await seedKeyBundle(alice.id, false);
    await seedKeyBundle(bob.id, false);
    const dmChannelId = await createDmChannel([alice.id, bob.id]);
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(alice.token))
      .send({ dmChannelId, tier: 'otr', groupInfo: 'AA==' });
    expect(res.status).toBe(201);
    expect(res.body.groupId).toBeTruthy();
  });

  it('rejects OTR when a participant is on Server recovery (passwordDerived=true) → 403 generic', async () => {
    const caller = await createTestUser();
    const peer = await createTestUser();
    await seedKeyBundle(caller.id, false);
    await seedKeyBundle(peer.id, true); // escrowed peer
    const dmChannelId = await createDmChannel([caller.id, peer.id]);
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(caller.token))
      .send({ dmChannelId, tier: 'otr', groupInfo: 'AA==' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(OTR_MSG);
    // Privacy: the generic error must not name the ineligible counterparty.
    expect(JSON.stringify(res.body)).not.toContain(peer.id);
    expect(JSON.stringify(res.body)).not.toContain(peer.username);
  });

  it('rejects OTR when a participant has no DmKeyBundle → 403 generic', async () => {
    const caller = await createTestUser();
    const peer = await createTestUser();
    await seedKeyBundle(caller.id, false);
    // peer has NO bundle → absent from query → ineligible.
    const dmChannelId = await createDmChannel([caller.id, peer.id]);
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(caller.token))
      .send({ dmChannelId, tier: 'otr', groupInfo: 'AA==' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(OTR_MSG);
  });

  it('rejects OTR on a group channel (isGroup=true) even when all participants are Private → 403', async () => {
    const caller = await createTestUser();
    const p2 = await createTestUser();
    const p3 = await createTestUser();
    await seedKeyBundle(caller.id, false);
    await seedKeyBundle(p2.id, false);
    await seedKeyBundle(p3.id, false);
    const dmChannelId = await createDmChannel([caller.id, p2.id, p3.id], true);
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(caller.token))
      .send({ dmChannelId, tier: 'otr', groupInfo: 'AA==' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe(OTR_MSG);
  });

  it('does NOT gate tier:"saved" — 201 even with an escrowed participant', async () => {
    const caller = await createTestUser();
    const peer = await createTestUser();
    await seedKeyBundle(caller.id, false);
    await seedKeyBundle(peer.id, true); // escrowed; would fail OTR but saved is unaffected
    const dmChannelId = await createDmChannel([caller.id, peer.id]);
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(caller.token))
      .send({ dmChannelId, tier: 'saved', groupInfo: 'AA==' });
    expect(res.status).toBe(201);
    expect(res.body.groupId).toBeTruthy();
  });

  it('does NOT gate an omitted tier (defaults to "saved") — 201 even with an escrowed participant', async () => {
    const caller = await createTestUser();
    const peer = await createTestUser();
    await seedKeyBundle(caller.id, false);
    await seedKeyBundle(peer.id, true);
    const dmChannelId = await createDmChannel([caller.id, peer.id]);
    const res = await request(app)
      .post('/api/v1/mls/groups')
      .set('Authorization', authHeader(caller.token))
      .send({ dmChannelId, groupInfo: 'AA==' }); // tier omitted
    expect(res.status).toBe(201);
    expect(res.body.groupId).toBeTruthy();
  });
});
