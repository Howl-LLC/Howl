// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '../src/db.js';
import { postJoinWelcomeMessage } from '../src/utils/joinWelcome.js';
import { createTestUser, createTestServer, cleanupTestData } from './helpers.js';

// Each scenario uses a fresh server and scopes every assertion to the channel
// ids it created, so Message rows from sibling scenarios / leftover data can
// never leak into an assertion.
describe('postJoinWelcomeMessage', () => {
  let joiner: { id: string; username: string };

  beforeAll(async () => {
    const j = await createTestUser();
    joiner = { id: j.id, username: j.username };
  });
  afterAll(cleanupTestData);

  it('posts a system message to the configured welcomeChannelId text channel', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id, 'WChan Server');
    const generalId = server.channels[0].id; // seeded text channel
    const second = await prisma.channel.create({
      data: { serverId: server.id, name: 'welcome', type: 'text', position: 1 },
    });
    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, welcomeEnabled: true, welcomeMessage: 'Hi {user}, welcome to {server}!', welcomeChannelId: second.id },
      update: { welcomeEnabled: true, welcomeMessage: 'Hi {user}, welcome to {server}!', welcomeChannelId: second.id },
    });

    await postJoinWelcomeMessage(server.id, joiner);

    const msgs = await prisma.message.findMany({
      where: { channelId: { in: [generalId, second.id] }, type: 'system' },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channelId).toBe(second.id);
    expect(msgs[0].authorId).toBe(joiner.id);
    expect(msgs[0].content).toBe(`Hi ${joiner.username}, welcome to WChan Server!`);
    expect(msgs[0].systemPayload).toEqual({ kind: 'member_join' });
  });

  it('falls back to the first text channel (createdAt asc) when welcomeChannelId is null', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id, 'NullChan Server');
    const firstTextId = server.channels[0].id; // seeded first, oldest createdAt
    const laterText = await prisma.channel.create({
      data: { serverId: server.id, name: 'later', type: 'text', position: 1 },
    });
    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, welcomeEnabled: true, welcomeMessage: 'Welcome {user}', welcomeChannelId: null },
      update: { welcomeEnabled: true, welcomeMessage: 'Welcome {user}', welcomeChannelId: null },
    });

    await postJoinWelcomeMessage(server.id, joiner);

    const msgs = await prisma.message.findMany({
      where: { channelId: { in: [firstTextId, laterText.id] }, type: 'system' },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channelId).toBe(firstTextId);
    expect(msgs[0].content).toBe(`Welcome ${joiner.username}`);
  });

  it('falls back to the first text channel when welcomeChannelId points to a non-text channel', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id, 'VoiceChan Server');
    const firstTextId = server.channels[0].id;
    const voice = await prisma.channel.create({
      data: { serverId: server.id, name: 'Voice', type: 'voice', position: 1 },
    });
    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, welcomeEnabled: true, welcomeMessage: 'Hello {user}', welcomeChannelId: voice.id },
      update: { welcomeEnabled: true, welcomeMessage: 'Hello {user}', welcomeChannelId: voice.id },
    });

    await postJoinWelcomeMessage(server.id, joiner);

    const msgs = await prisma.message.findMany({
      where: { channelId: { in: [firstTextId, voice.id] }, type: 'system' },
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0].channelId).toBe(firstTextId);
  });

  it('posts nothing when welcomeEnabled is false', async () => {
    const owner = await createTestUser();
    const server = await createTestServer(owner.id, 'Disabled Server');
    const firstTextId = server.channels[0].id;
    await prisma.serverSettings.upsert({
      where: { serverId: server.id },
      create: { serverId: server.id, welcomeEnabled: false, welcomeMessage: 'Hi {user}' },
      update: { welcomeEnabled: false, welcomeMessage: 'Hi {user}' },
    });

    await postJoinWelcomeMessage(server.id, joiner);

    const msgs = await prisma.message.findMany({
      where: { channelId: { in: [firstTextId] }, type: 'system' },
    });
    expect(msgs).toHaveLength(0);
  });
});
