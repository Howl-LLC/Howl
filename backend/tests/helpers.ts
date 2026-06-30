// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Shared test helpers for creating authenticated requests, test users, etc.
 */

import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../src/db.js';
import { randomUUID } from 'crypto';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-vitest';

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashEmail(email: string): string {
  const key = process.env.EMAIL_HMAC_KEY || 'test-only-email-hmac-key-minimum-32chars';
  return crypto.createHmac('sha256', key).update(email.toLowerCase().trim()).digest('hex');
}

let userCounter = 0;

export function uniqueEmail(): string {
  return `testuser${Date.now()}_${++userCounter}@test.com`;
}

export function uniqueUsername(): string {
  return `testuser${Date.now()}_${++userCounter}`;
}

export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '1h' });
}

export function authHeader(token: string): string {
  return `Bearer ${token}`;
}

export interface TestUser {
  id: string;
  username: string;
  discriminator: string;
  email: string;
  token: string;
}

/**
 * Create a verified user directly in the database and return their details + JWT.
 * Bypasses the registration endpoint for faster test setup.
 */
export async function createTestUser(overrides?: { username?: string; email?: string }): Promise<TestUser> {
  const email = overrides?.email ?? uniqueEmail();
  const username = overrides?.username ?? uniqueUsername();
  const passwordHash = await bcrypt.hash('TestPass123!', 4); // low rounds for speed
  const discriminator = String(Math.floor(1000 + Math.random() * 9000));

  const user = await prisma.user.create({
    data: {
      id: randomUUID(),
      username,
      discriminator,
      email,
      emailHash: hashEmail(email),
      passwordHash,
      emailVerified: true,
      status: 'online',
      dateOfBirth: new Date('2000-01-15'),
    },
  });

  const token = generateToken(user.id);

  await prisma.session.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      deviceName: 'Test Runner',
      deviceType: 'web',
      os: 'Test',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });

  return {
    id: user.id,
    username: user.username,
    discriminator: user.discriminator,
    email: user.email,
    token,
  };
}

/**
 * Create a test server owned by the given user.
 *
 * Note: this helper does NOT create the @everyone role (production server
 * creation does). Tests that need permission checks against
 * loadPermissionContext for non-owner members must seed @everyone manually
 * with the appropriate baseline permissions.
 */
export async function createTestServer(ownerId: string, name?: string) {
  const server = await prisma.server.create({
    data: {
      name: name ?? `Test Server ${Date.now()}`,
      members: { create: { userId: ownerId, role: 'owner' } },
      categories: { create: { name: 'General', position: 0 } },
    },
    include: { categories: true, members: true },
  });
  const defaultCategory = server.categories[0];
  await prisma.channel.create({
    data: { serverId: server.id, name: 'general', type: 'text', categoryId: defaultCategory.id, position: 0 },
  });
  const full = await prisma.server.findUniqueOrThrow({
    where: { id: server.id },
    include: { channels: true, members: true, categories: true },
  });
  return full;
}

/**
 * Create a text channel in a server.
 */
export async function createTestChannel(serverId: string, name?: string) {
  // Find the first category for this server
  const cat = await prisma.channelCategory.findFirst({
    where: { serverId },
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  const maxPos = await prisma.channel.aggregate({ where: { serverId, categoryId: cat?.id ?? null }, _max: { position: true } });
  return prisma.channel.create({
    data: {
      id: randomUUID(),
      name: name ?? `test-channel-${Date.now()}`,
      type: 'text',
      serverId,
      categoryId: cat?.id ?? null,
      position: (maxPos._max.position ?? -1) + 1,
    },
  });
}

/**
 * Seed (or update) an account's MLS account identity key. The AS cross-sig gate
 * requires DmKeyBundle.signingPublicKey to equal the AIK embedded in
 * every published KeyPackage; route-level publish tests must seed the publishing
 * HarnessClient's aikPublicKeyB64() here first. The other bundle columns are
 * non-nullable but irrelevant to the AIK path, so they get placeholder material.
 */
export async function seedMlsPublisherAik(userId: string, signingPublicKeyB64: string): Promise<void> {
  await prisma.dmKeyBundle.upsert({
    where: { userId },
    create: {
      userId,
      publicKey: 'x',
      signingPublicKey: signingPublicKeyB64,
      encryptedBlob: 'x',
      blobSalt: 'x',
      recoveryBlob: 'x',
      recoveryNonce: 'x',
    },
    update: { signingPublicKey: signingPublicKeyB64 },
  });
}

/**
 * Clean up all test data. Call in afterAll or afterEach.
 */
export async function cleanupTestData() {
  // Delete in dependency order
  const tables = [
    'MlsWelcome', 'MlsCommit', 'MlsKeyPackage', 'MlsGroup',
    'DmHistoryArchive',
    'ChannelPinnedMessage', 'DMPinnedMessage', 'DMMessage', 'DMParticipant', 'DMChannel',
    'Message', 'Channel', 'ServerWelcomeChannel', 'DailyServerStats', 'ServerReport',
    'ServerApplication', 'ServerMember', 'ServerRole', 'ServerBan',
    'ServerPowerUp', 'ServerSettings', 'AuditLog', 'AutomodRule',
    'CustomEmoji', 'Sticker', 'SoundboardSound', 'ServerTemplate',
    'Invite', 'Server',
    // Device-verification tables must be cleared BEFORE Session because
    // Session.trustedDeviceId FK points to TrustedDevice.
    'LoginVerification', 'Session', 'TrustedDevice',
    'FriendRequest', 'Block',
    'PasskeyCredential', 'SsoAccount', 'FamilyLink', 'FamilyRestriction',
    'AdminAuditLog', 'MessageReport', 'ImageHash', 'FlaggedHash',
    'PushSubscription', 'DataExportRequest', 'GiftSubscription',
    'UserSecurityEvent',
    // Refund cascades from User; RefundUsage doesn't (intentional — survives user delete).
    'Refund', 'RefundUsage',
    'User',
  ];
  for (const table of tables) {
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "${table}"`);
    } catch {
      // table may not exist or have FK issues; continue
    }
  }
}
