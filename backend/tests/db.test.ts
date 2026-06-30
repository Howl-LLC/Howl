// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { createTestUser, createTestServer, createTestChannel, cleanupTestData } from './helpers.js';

afterAll(async () => {
  await cleanupTestData();
  await prisma.$disconnect();
});

describe('Database: User operations', () => {
  it('should create a user with all required fields', async () => {
    const user = await createTestUser();
    const found = await prisma.user.findUnique({ where: { id: user.id } });
    expect(found).toBeTruthy();
    expect(found!.username).toBe(user.username);
    expect(found!.email).toBe(user.email);
    expect(found!.emailVerified).toBe(true);
  });

  it('should enforce unique emailHash constraint', async () => {
    const emailHash = `unique-hash-${Date.now()}`;
    const user1 = await createTestUser();
    await prisma.user.update({ where: { id: user1.id }, data: { emailHash } });
    const user2 = await createTestUser();
    await expect(
      prisma.user.update({ where: { id: user2.id }, data: { emailHash } })
    ).rejects.toThrow();
  });

  it('should update user status', async () => {
    const user = await createTestUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: 'dnd' } });
    const updated = await prisma.user.findUnique({ where: { id: user.id } });
    expect(updated!.status).toBe('dnd');
  });

  it('should delete user and cascade correctly', async () => {
    const user = await createTestUser();
    await prisma.user.delete({ where: { id: user.id } });
    const found = await prisma.user.findUnique({ where: { id: user.id } });
    expect(found).toBeNull();
  });
});

describe('Database: Server operations', () => {
  it('should create a server with an owner', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id, 'DB Test Server');
    expect(server.name).toBe('DB Test Server');
    const ownerMember = (server as any).members?.find((m: any) => m.role === 'owner');
    expect(ownerMember).toBeTruthy();
    expect(ownerMember.userId).toBe(owner.id);
  });

  it('should create server membership on server creation', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const membership = await prisma.serverMember.findUnique({
      where: { userId_serverId: { userId: owner.id, serverId: server.id } },
    });
    expect(membership).toBeTruthy();
    expect(membership!.role).toBe('owner');
  });

  it('should create channels in a server', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = await createTestChannel(server.id, 'test-channel');
    expect(channel.name).toBe('test-channel');
    expect(channel.serverId).toBe(server.id);
    expect(channel.type).toBe('text');
  });
});

describe('Database: Message operations', () => {
  it('should create and retrieve a message', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = await createTestChannel(server.id);

    const message = await prisma.message.create({
      data: {
        channelId: channel.id,
        authorId: owner.id,
        content: 'Hello from DB test',
      },
    });

    expect(message.content).toBe('Hello from DB test');
    expect(message.authorId).toBe(owner.id);

    const fetched = await prisma.message.findUnique({ where: { id: message.id } });
    expect(fetched).toBeTruthy();
    expect(fetched!.content).toBe('Hello from DB test');
  });

  it('should update a message', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = await createTestChannel(server.id);

    const message = await prisma.message.create({
      data: { channelId: channel.id, authorId: owner.id, content: 'Original' },
    });

    const updated = await prisma.message.update({
      where: { id: message.id },
      data: { content: 'Edited' },
    });
    expect(updated.content).toBe('Edited');
  });

  it('should delete a message', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id);
    const channel = await createTestChannel(server.id);

    const message = await prisma.message.create({
      data: { channelId: channel.id, authorId: owner.id, content: 'To delete' },
    });

    await prisma.message.delete({ where: { id: message.id } });
    const found = await prisma.message.findUnique({ where: { id: message.id } });
    expect(found).toBeNull();
  });
});

describe('Database: DMChannel encryption-downgrade guard', () => {
  async function createEncryptedDm() {
    const a = await createTestUser();
    const b = await createTestUser();
    return prisma.dMChannel.create({
      data: {
        encrypted: true,
        participants: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    });
  }

  it('update with encrypted=false throws', async () => {
    const channel = await createEncryptedDm();
    await expect(
      prisma.dMChannel.update({ where: { id: channel.id }, data: { encrypted: false } })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('updateMany with encrypted=false throws', async () => {
    const channel = await createEncryptedDm();
    await expect(
      prisma.dMChannel.updateMany({ where: { id: channel.id }, data: { encrypted: false } })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('upsert with update.encrypted=false throws', async () => {
    const channel = await createEncryptedDm();
    await expect(
      prisma.dMChannel.upsert({
        where: { id: channel.id },
        update: { encrypted: false },
        create: { id: channel.id, encrypted: true },
      })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('upsert with create.encrypted=false throws', async () => {
    await expect(
      prisma.dMChannel.upsert({
        where: { id: '00000000-0000-0000-0000-000000000000' },
        update: { name: 'x' },
        create: { encrypted: false },
      })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('createMany with encrypted=false throws (array)', async () => {
    await expect(
      prisma.dMChannel.createMany({ data: [{ encrypted: false }] })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('createMany with encrypted=false throws (single object)', async () => {
    await expect(
      prisma.dMChannel.createMany({ data: { encrypted: false } })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('create with encrypted=false throws', async () => {
    await expect(
      prisma.dMChannel.create({ data: { encrypted: false } })
    ).rejects.toThrow(/Encryption downgrade is not allowed/);
  });

  it('update with encrypted=true (or omitted) succeeds', async () => {
    const channel = await createEncryptedDm();
    const updated = await prisma.dMChannel.update({
      where: { id: channel.id },
      data: { encrypted: true },
    });
    expect(updated.encrypted).toBe(true);

    const renamed = await prisma.dMChannel.update({
      where: { id: channel.id },
      data: { name: 'renamed' },
    });
    expect(renamed.name).toBe('renamed');
    expect(renamed.encrypted).toBe(true);
  });

  it('create with encrypted=true succeeds', async () => {
    const a = await createTestUser();
    const b = await createTestUser();
    const channel = await prisma.dMChannel.create({
      data: {
        encrypted: true,
        participants: { create: [{ userId: a.id }, { userId: b.id }] },
      },
    });
    expect(channel.encrypted).toBe(true);
  });

  it('createMany with encrypted=true succeeds', async () => {
    const result = await prisma.dMChannel.createMany({
      data: [{ encrypted: true }, { encrypted: true }],
    });
    expect(result.count).toBe(2);
  });
});

describe('Database: Server ban enforcement', () => {
  it('should create a ban record', async () => {
    const owner = await createTestUser();
    const target = await createTestUser();
    const server = await createTestServer(owner.id);

    const ban = await prisma.serverBan.create({
      data: {
        serverId: server.id,
        userId: target.id,
        bannedById: owner.id,
        reason: 'Test ban',
      },
    });
    expect(ban.userId).toBe(target.id);
    expect(ban.reason).toBe('Test ban');
  });

  it('should look up bans by serverId + userId', async () => {
    const owner = await createTestUser();
    const target = await createTestUser();
    const server = await createTestServer(owner.id);

    await prisma.serverBan.create({
      data: { serverId: server.id, userId: target.id, bannedById: owner.id },
    });

    const found = await prisma.serverBan.findUnique({
      where: { serverId_userId: { serverId: server.id, userId: target.id } },
    });
    expect(found).toBeTruthy();
  });
});
