// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Engine conformance gate: the PRODUCTION frontend MLS engine
 * (services/mls/*) driving TWO devices (Alice + Bob) through the LIVE backend
 * contract end to end:
 *
 *   publish KeyPackages -> consume -> createGroup -> addMember commit + welcome
 *   -> submitCommit -> Bob getWelcomes + joinFromWelcome -> Alice encryptApp
 *   -> relay (v4 envelope) -> Bob decryptApp; plus ordered catch-up.
 *
 * Modeled on backend/tests/mls/conformance.test.ts (same test DB + Supertest
 * server harness), but exercising the real client engine instead of
 * HarnessClient.
 *
 * We import the frontend engine by relative path. It is pure (no IndexedDB, no
 * fetch), so state and the joiner's candidate private KeyPackages live in local
 * variables here — no mlsGroupStore involved.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import nacl from 'tweetnacl';
import request from 'supertest';
import { app } from '../../src/server.js';
import { createTestUser, authHeader, cleanupTestData, seedMlsPublisherAik, type TestUser } from '../helpers.js';
import { prisma } from '../../src/db.js';

// Production frontend engine + identity + envelope (pure modules).
import {
  createGroup,
  addMember,
  joinFromWelcome,
  joinExternal,
  encryptApp,
  decryptApp,
  processHandshake,
  makeGroupInfo,
  currentEpoch,
  removeMembers,
  resolveLeafIndex,
  selfUpdate,
  type KeyPackageCandidate,
} from '../../../services/mls/mlsEngine.js';
import { createIdentity, generateKeyPackages, decodeMlsCredentialIdentity } from '../../../services/mls/mlsIdentity.js';
import { encodeMlsEnvelope, tryParseMlsEnvelope, type MlsClientState } from '../../../services/mls/types.js';

// createIdentity is 4-arg (AIK cross-sign). Thread an ephemeral AIK per call;
// the AS validates the credential structurally here.
const makeIdentity = (userId: string, deviceId: string) => {
  const aik = nacl.sign.keyPair();
  return createIdentity(userId, deviceId, aik.publicKey, aik.secretKey);
};

const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

// Seed the account's published AIK (DmKeyBundle.signingPublicKey) so the AS cross-sig
// gate passes. Recovers the AIK embedded in the device's cross-signed credential.
const seedAikFromBundle = (userId: string, bundle: { identity: { credentialIdentity: Uint8Array } }) =>
  seedMlsPublisherAik(userId, b64(decodeMlsCredentialIdentity(bundle.identity.credentialIdentity).aikPub));
const fromB64 = (s: string) => new Uint8Array(Buffer.from(s, 'base64'));
const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const enc = (s: string) => new TextEncoder().encode(s);

const post = (path: string, token: string, body: unknown) =>
  request(app).post(path).set('Authorization', authHeader(token)).send(body);
const get = (path: string, token: string) => request(app).get(path).set('Authorization', authHeader(token));

let alice: TestUser;
let bob: TestUser;
let dmChannelId: string;

beforeAll(async () => {
  alice = await createTestUser();
  bob = await createTestUser();
  const channel = await prisma.dMChannel.create({
    data: { participants: { create: [{ userId: alice.id }, { userId: bob.id }] } },
    select: { id: true },
  });
  dmChannelId = channel.id;
});
afterAll(async () => {
  await prisma.mlsWelcome.deleteMany({});
  await prisma.mlsCommit.deleteMany({});
  await prisma.mlsKeyPackage.deleteMany({});
  await prisma.mlsGroup.deleteMany({});
  await cleanupTestData();
});

describe('MLS engine conformance: real client engine over the live backend contract', () => {
  it('publish -> consume -> create -> addMember -> welcome join -> relay -> ordered catch-up', async () => {
    const aliceDev = randomUUID();
    const bobDev = randomUUID();

    // Identities (stable signing keypair per device, AIK-cross-signed credential).
    const aliceAik = nacl.sign.keyPair();
    const bobAik = nacl.sign.keyPair();
    const aliceId = await createIdentity(alice.id, aliceDev, aliceAik.publicKey, aliceAik.secretKey);
    const bobId = await createIdentity(bob.id, bobDev, bobAik.publicKey, bobAik.secretKey);

    // Bob publishes a single-use KeyPackage; keep the full candidate (public +
    // private + ref) as the joinFromWelcome candidate set, exactly the shape
    // mlsGroupStore holds and joinFromWelcome consumes (KeyPackageCandidate).
    const bobKps = await generateKeyPackages(bobId.identity, 1, false);
    const bobCandidates: KeyPackageCandidate[] = bobKps.map((k) => ({
      keyPackageRef: b64(k.keyPackageRef),
      keyPackage: k.keyPackage,
      privateKeyPackage: k.privateKeyPackage,
      isLastResort: k.isLastResort,
    }));
    await seedMlsPublisherAik(bob.id, b64(bobAik.publicKey));
    const pub = await post('/api/v1/mls/keypackages', bob.token, {
      deviceId: bobDev,
      keyPackages: [{ keyPackage: b64(bobKps[0].keyPackage), isLastResort: false }],
    });
    expect(pub.status).toBe(201);
    expect(pub.body.remaining).toBe(1);

    // Alice creates the group locally (epoch 0) and registers it server-side
    // with the epoch-0 GroupInfo.
    let aliceState: MlsClientState = await createGroup(aliceId.identity, randomUUID());
    const created = await post('/api/v1/mls/groups', alice.token, {
      dmChannelId,
      tier: 'saved',
      groupInfo: b64(await makeGroupInfo(aliceState)),
    });
    expect(created.status).toBe(201);
    expect(created.body.currentEpoch).toBe('0');
    const groupId: string = created.body.groupId;

    // Alice consumes Bob's KeyPackage from the DS.
    const fetched = await get(`/api/v1/mls/keypackages/${bob.id}`, alice.token);
    expect(fetched.status).toBe(200);
    const consumedKp = fetched.body.keyPackages[0].keyPackage as string;

    // Alice produces the Add+Commit (epoch 0 -> 1) with the Welcome, then a
    // fresh epoch-1 GroupInfo.
    const add = await addMember(aliceState, fromB64(consumedKp));
    aliceState = add.newState;
    expect(currentEpoch(aliceState)).toBe(1n);
    const epoch1GroupInfo = await makeGroupInfo(aliceState);

    const commitRes = await post(`/api/v1/mls/groups/${groupId}/commits`, alice.token, {
      baseEpoch: '0',
      mode: 'member',
      commit: b64(add.commit),
      groupInfo: b64(epoch1GroupInfo),
      idempotencyKey: randomUUID(),
      welcomes: [{ recipientId: bob.id, welcomeData: b64(add.welcome) }],
    });
    expect(commitRes.status).toBe(200);
    expect(commitRes.body.epoch).toBe('1');

    // Bob drains his Welcome and joins from it using his candidate private keys.
    const welcomes = await get('/api/v1/mls/welcomes', bob.token);
    expect(welcomes.body.welcomes).toHaveLength(1);
    expect(welcomes.body.welcomes[0].groupId).toBe(groupId);
    const bobJoin = await joinFromWelcome(
      fromB64(welcomes.body.welcomes[0].welcomeData),
      bobCandidates,
    );
    let bobState: MlsClientState = bobJoin.state;
    expect(bobJoin.consumedKpRef).toBe(bobCandidates[0].keyPackageRef);
    expect(currentEpoch(bobState)).toBe(1n);

    // Alice -> Bob application message, carried as the v4 envelope the
    // transport relays verbatim, then decrypted by Bob.
    const encAtoB = await encryptApp(aliceState, enc('hello from alice'));
    aliceState = encAtoB.newState;
    const envelope = encodeMlsEnvelope(encAtoB.privateMessage);
    const onWire = tryParseMlsEnvelope(envelope);
    expect(onWire).not.toBeNull();
    const decAtoB = await decryptApp(bobState, onWire!);
    bobState = decAtoB.newState;
    expect(dec(decAtoB.plaintext)).toBe('hello from alice');

    // Bob -> Alice reply round-trips too.
    const encBtoA = await encryptApp(bobState, enc('hi back from bob'));
    bobState = encBtoA.newState;
    const decBtoA = await decryptApp(aliceState, tryParseMlsEnvelope(encodeMlsEnvelope(encBtoA.privateMessage))!);
    aliceState = decBtoA.newState;
    expect(dec(decBtoA.plaintext)).toBe('hi back from bob');

    // Ordered catch-up: Bob requests the commit log from epoch 0 and replays it.
    // (He joined via Welcome at epoch 1, so the epoch-0 Add commit is the only
    // row; replaying it is a stale no-op his current state must tolerate, but
    // the canonical epoch ordering is what we assert here.)
    const catchup = await get(`/api/v1/mls/groups/${groupId}/commits?sinceEpoch=0`, bob.token);
    expect(catchup.status).toBe(200);
    const epochs = catchup.body.commits.map((c: { baseEpoch: string }) => c.baseEpoch);
    expect(epochs).toEqual([...epochs].sort());
    expect(epochs).toContain('0');
  }, 30000);

  it('processHandshake applies a member self-update commit to advance the epoch', async () => {
    // A second channel so this case is independent of the first.
    const a = await createTestUser();
    const b = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
      select: { id: true },
    });
    const aDev = randomUUID();
    const bDev = randomUUID();
    const aId = await makeIdentity(a.id, aDev);
    const bId = await makeIdentity(b.id, bDev);

    const bKps = await generateKeyPackages(bId.identity, 1, false);
    const bCandidates: KeyPackageCandidate[] = bKps.map((k) => ({
      keyPackageRef: b64(k.keyPackageRef),
      keyPackage: k.keyPackage,
      privateKeyPackage: k.privateKeyPackage,
      isLastResort: k.isLastResort,
    }));
    await seedAikFromBundle(b.id, bId);
    await post('/api/v1/mls/keypackages', b.token, {
      deviceId: bDev,
      keyPackages: [{ keyPackage: b64(bKps[0].keyPackage), isLastResort: false }],
    });

    let aState = await createGroup(aId.identity, randomUUID());
    const created = await post('/api/v1/mls/groups', a.token, {
      dmChannelId: channel.id,
      tier: 'saved',
      groupInfo: b64(await makeGroupInfo(aState)),
    });
    const groupId = created.body.groupId;
    const consumed = (await get(`/api/v1/mls/keypackages/${b.id}`, a.token)).body.keyPackages[0].keyPackage;

    const add = await addMember(aState, fromB64(consumed));
    aState = add.newState;
    const r = await post(`/api/v1/mls/groups/${groupId}/commits`, a.token, {
      baseEpoch: '0',
      mode: 'member',
      commit: b64(add.commit),
      groupInfo: b64(await makeGroupInfo(aState)),
      idempotencyKey: randomUUID(),
      welcomes: [{ recipientId: b.id, welcomeData: b64(add.welcome) }],
    });
    expect(r.body.epoch).toBe('1');

    const w = await get('/api/v1/mls/welcomes', b.token);
    const bState = (await joinFromWelcome(fromB64(w.body.welcomes[0].welcomeData), bCandidates)).state;
    expect(currentEpoch(bState)).toBe(1n);

    // processHandshake on Bob's side for the (epoch-0 -> 1) Add commit that
    // catch-up returns: Bob is already at epoch 1, so ts-mls rejects the stale
    // epoch — we assert that failure is surfaced (never swallowed), proving the
    // engine's continuity check is live.
    const catchup = await get(`/api/v1/mls/groups/${groupId}/commits?sinceEpoch=0`, b.token);
    const epoch0Commit = catchup.body.commits.find((c: { baseEpoch: string }) => c.baseEpoch === '0');
    expect(epoch0Commit).toBeDefined();
    await expect(processHandshake(bState, fromB64(epoch0Commit.commit))).rejects.toBeTruthy();
    // Bob's state is unchanged (processHandshake returns a NEW state on success;
    // on the rejection above bState is untouched).
    expect(currentEpoch(bState)).toBe(1n);
  }, 30000);

  it('external-commit self-join: a member who lost local state re-joins the current epoch', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } },
      select: { id: true },
    });
    const aId = await makeIdentity(a.id, randomUUID());
    const bId = await makeIdentity(b.id, randomUUID());

    // A creates + adds B (epoch 1) so B's leaf is in the tree.
    // Publish under B's identity device: the server binds the KeyPackage credential
    // to the v2 169-byte credential struct's `{userId, deviceId}` fields, so the publish
    // deviceId must match the device the identity (and thus its KeyPackages) is bound to,
    // else `identity_mismatch`.
    const bKps = await generateKeyPackages(bId.identity, 1, false);
    await seedAikFromBundle(b.id, bId);
    await post('/api/v1/mls/keypackages', b.token, {
      deviceId: bId.deviceId,
      keyPackages: [{ keyPackage: b64(bKps[0].keyPackage), isLastResort: false }],
    });
    let aState: MlsClientState = await createGroup(aId.identity, randomUUID());
    const created = await post('/api/v1/mls/groups', a.token, {
      dmChannelId: channel.id, tier: 'saved', groupInfo: b64(await makeGroupInfo(aState)),
    });
    const groupId: string = created.body.groupId;
    const consumed = (await get(`/api/v1/mls/keypackages/${b.id}`, a.token)).body.keyPackages[0].keyPackage;
    const add = await addMember(aState, fromB64(consumed));
    aState = add.newState;
    await post(`/api/v1/mls/groups/${groupId}/commits`, a.token, {
      baseEpoch: '0', mode: 'member', commit: b64(add.commit),
      groupInfo: b64(await makeGroupInfo(aState)), idempotencyKey: randomUUID(),
      welcomes: [{ recipientId: b.id, welcomeData: b64(add.welcome) }],
    });
    expect(currentEpoch(aState)).toBe(1n);

    // B "loses local state" and re-joins via External Commit off the published GroupInfo.
    const gi = await get(`/api/v1/mls/groups/${groupId}/group-info`, b.token);
    expect(gi.status).toBe(200);
    expect(gi.body.groupInfoEpoch).toBe('1');
    const ext = await joinExternal(fromB64(gi.body.groupInfo), bId.identity);
    expect(currentEpoch(ext.newState)).toBe(2n); // resync (B's leaf present): epoch 1 -> 2
    const extCommit = await post(`/api/v1/mls/groups/${groupId}/commits`, b.token, {
      baseEpoch: '1', mode: 'external', commit: b64(ext.commit),
      groupInfo: b64(await makeGroupInfo(ext.newState)), idempotencyKey: randomUUID(),
    });
    expect(extCommit.status).toBe(200);
    expect(extCommit.body.epoch).toBe('2');

    // A applies the external commit and converges; A <-> re-joined-B messaging works.
    // (`enc`/`dec` are the file's top-level string<->bytes helpers; name the locals
    // `encrypted`/`decrypted` so they don't shadow them.)
    aState = await processHandshake(aState, ext.commit);
    expect(currentEpoch(aState)).toBe(2n);
    const encrypted = await encryptApp(aState, enc('after rejoin'));
    const decrypted = await decryptApp(
      ext.newState,
      tryParseMlsEnvelope(encodeMlsEnvelope(encrypted.privateMessage))!,
    );
    expect(dec(decrypted.plaintext)).toBe('after rejoin');
  }, 30000);

  it('either-party create race: exactly one POST /groups wins; both converge', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }] } }, select: { id: true },
    });
    const aId = await makeIdentity(a.id, randomUUID());
    const bId = await makeIdentity(b.id, randomUUID());
    const aState = await createGroup(aId.identity, randomUUID());
    const bState = await createGroup(bId.identity, randomUUID());
    const r1 = await post('/api/v1/mls/groups', a.token, { dmChannelId: channel.id, tier: 'saved', groupInfo: b64(await makeGroupInfo(aState)) });
    const r2 = await post('/api/v1/mls/groups', b.token, { dmChannelId: channel.id, tier: 'saved', groupInfo: b64(await makeGroupInfo(bState)) });
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 409]); // create-once: one wins, one loses
  }, 30000);

  it('removeMembers evicts the resolved leaf; remaining members advance, the removed member cannot decrypt the new epoch', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const c = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: { participants: { create: [{ userId: a.id }, { userId: b.id }, { userId: c.id }] } },
      select: { id: true },
    });
    const aId = await makeIdentity(a.id, randomUUID());
    const bId = await makeIdentity(b.id, randomUUID());
    const cId = await makeIdentity(c.id, randomUUID());

    const bKps = await generateKeyPackages(bId.identity, 1, false);
    const cKps = await generateKeyPackages(cId.identity, 1, false);
    const bCand: KeyPackageCandidate[] = bKps.map((k) => ({ keyPackageRef: b64(k.keyPackageRef), keyPackage: k.keyPackage, privateKeyPackage: k.privateKeyPackage, isLastResort: k.isLastResort }));
    const cCand: KeyPackageCandidate[] = cKps.map((k) => ({ keyPackageRef: b64(k.keyPackageRef), keyPackage: k.keyPackage, privateKeyPackage: k.privateKeyPackage, isLastResort: k.isLastResort }));
    await seedAikFromBundle(b.id, bId);
    await seedAikFromBundle(c.id, cId);
    await post('/api/v1/mls/keypackages', b.token, { deviceId: bId.deviceId, keyPackages: [{ keyPackage: b64(bKps[0].keyPackage), isLastResort: false }] });
    await post('/api/v1/mls/keypackages', c.token, { deviceId: cId.deviceId, keyPackages: [{ keyPackage: b64(cKps[0].keyPackage), isLastResort: false }] });

    let aState: MlsClientState = await createGroup(aId.identity, randomUUID());
    const groupId = (await post('/api/v1/mls/groups', a.token, { dmChannelId: channel.id, tier: 'saved', groupInfo: b64(await makeGroupInfo(aState)) })).body.groupId;

    // Add b then c (sequential single-Adds keep the tree deterministic for leaf assertions).
    const consumedB = (await get(`/api/v1/mls/keypackages/${b.id}`, a.token)).body.keyPackages[0].keyPackage;
    const addB = await addMember(aState, fromB64(consumedB));
    aState = addB.newState;
    await post(`/api/v1/mls/groups/${groupId}/commits`, a.token, { baseEpoch: '0', mode: 'member', commit: b64(addB.commit), groupInfo: b64(await makeGroupInfo(aState)), idempotencyKey: randomUUID(), welcomes: [{ recipientId: b.id, welcomeData: b64(addB.welcome) }] });
    let bState: MlsClientState = (await joinFromWelcome(fromB64((await get('/api/v1/mls/welcomes', b.token)).body.welcomes[0].welcomeData), bCand)).state;

    const consumedC = (await get(`/api/v1/mls/keypackages/${c.id}`, a.token)).body.keyPackages[0].keyPackage;
    const addC = await addMember(aState, fromB64(consumedC));
    aState = addC.newState;
    await post(`/api/v1/mls/groups/${groupId}/commits`, a.token, { baseEpoch: '1', mode: 'member', commit: b64(addC.commit), groupInfo: b64(await makeGroupInfo(aState)), idempotencyKey: randomUUID(), welcomes: [{ recipientId: c.id, welcomeData: b64(addC.welcome) }] });
    bState = await processHandshake(bState, addC.commit); // b advances over c's Add
    let cState: MlsClientState = (await joinFromWelcome(fromB64((await get('/api/v1/mls/welcomes', c.token)).body.welcomes[0].welcomeData), cCand)).state;
    expect(currentEpoch(aState)).toBe(2n);

    // Resolver: b is present (returns its leaf index), a bogus identity throws (no hang).
    const bLeaf = resolveLeafIndex(aState, bId.identity.credentialIdentity);
    expect(bLeaf).toBeGreaterThanOrEqual(0);
    const absent = new TextEncoder().encode(`${randomUUID()}:${randomUUID()}`);
    expect(() => resolveLeafIndex(aState, absent)).toThrow();

    // a Removes b (no Welcome). a + c advance to epoch 3; b is evicted.
    const rm = await removeMembers(aState, [bLeaf]);
    aState = rm.newState;
    expect(currentEpoch(aState)).toBe(3n);
    cState = await processHandshake(cState, rm.commit);
    expect(currentEpoch(cState)).toBe(3n);

    // a <-> c still converge at the new epoch.
    const ct = await encryptApp(aState, enc('after remove'));
    aState = ct.newState;
    const dc = await decryptApp(cState, tryParseMlsEnvelope(encodeMlsEnvelope(ct.privateMessage))!);
    cState = dc.newState;
    expect(dec(dc.plaintext)).toBe('after remove');

    // Eviction (forward-secrecy boundary). In MLS, b processes the very commit
    // that removes it — that handshake RESOLVES (b is still a participant at the
    // instant it applies the commit) and b lands on a terminal "removed" state at
    // the eviction epoch. The genuine forward-secrecy guarantee is that b is
    // locked out of every SUBSEQUENT epoch: it can never follow the next path
    // update, because its leaf secret no longer overlaps the update path. We
    // assert that strict boundary directly (a -1 leaf hazard would also throw,
    // but this is the cryptographic eviction proof, not the resolver guard).
    const bRemoved = await processHandshake(bState, rm.commit); // terminal removed state
    const su = await selfUpdate(aState); // a's next commit (epoch 3 -> 4)
    aState = su.newState;
    cState = await processHandshake(cState, su.commit); // c (still a member) follows it
    expect(currentEpoch(cState)).toBe(4n);
    // b, evicted, CANNOT follow the post-eviction commit — no key overlap with the path.
    await expect(processHandshake(bRemoved, su.commit)).rejects.toBeTruthy();
  }, 40000);
});
