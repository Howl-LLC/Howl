// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// backend/src/services/selfHostBootstrap.ts
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { prisma } from '../db.js';
import { logger } from '../logger.js';
import { encryptSecret, hashEmail } from './mfaCrypto.js';

const log = logger.child({ module: 'selfHostBootstrap' });
const BCRYPT_ROUNDS = 12;
const BOOTSTRAP_LOCK_KEY = 4242; // advisory-lock key serializing first-admin claims

export interface FirstAdminInput {
  username: string;
  normalizedEmail: string;
  password: string;
  dob: Date;
  /** One-time setup token presented by the registrant (compared to BOOTSTRAP_TOKEN). */
  bootstrapToken?: string;
}

/** Thrown when the first-admin claim is missing or presents a wrong BOOTSTRAP_TOKEN. */
export class BootstrapTokenError extends Error {
  constructor() {
    super('Bootstrap token required');
    this.name = 'BootstrapTokenError';
  }
}

/**
 * Constant-time check of the provided setup token against BOOTSTRAP_TOKEN.
 * Returns true when no token is configured (no gate — backward compatible).
 */
function bootstrapTokenOk(provided: string | undefined): boolean {
  const expected = process.env.BOOTSTRAP_TOKEN;
  if (!expected) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Atomically claim the first-admin slot on a fresh self-hosted instance.
 * Returns the created admin User if this registration was the very first
 * (zero existing users), otherwise null. A Postgres advisory lock serializes
 * concurrent first-registrations so exactly one becomes admin.
 */
export async function tryClaimFirstAdmin(input: FirstAdminInput): Promise<{ id: string; username: string; discriminator: string } | null> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${BOOTSTRAP_LOCK_KEY})`;
    const count = await tx.user.count();
    if (count > 0) return null;

    // This registration IS the first-admin claim. Require the one-time setup
    // token so a fresh, internet-reachable instance (Caddy must already be
    // publicly reachable to obtain its TLS cert) can't be admin-claimed by
    // whoever races to the register endpoint first.
    if (!bootstrapTokenOk(input.bootstrapToken)) {
      throw new BootstrapTokenError();
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_ROUNDS);
    const discriminator = crypto.randomInt(10000).toString().padStart(4, '0');
    const user = await tx.user.create({
      data: {
        username: input.username,
        discriminator,
        email: encryptSecret(input.normalizedEmail),
        emailHash: hashEmail(input.normalizedEmail),
        passwordHash,
        dateOfBirth: input.dob,
        status: 'offline',
        emailVerified: true,
        role: 'ADMIN',
        tosAcceptedAt: new Date(),
        privacyPolicyAcceptedAt: new Date(),
      },
      select: { id: true, username: true, discriminator: true },
    });

    const server = await tx.server.create({
      data: {
        name: `${input.username}'s Server`,
        ownerId: user.id,
        members: { create: { userId: user.id, role: 'owner' } },
        categories: { create: { name: 'General', position: 0 } },
      },
      include: { categories: true },
    });
    await tx.channel.create({
      data: { serverId: server.id, name: 'general', type: 'text', categoryId: server.categories[0].id, position: 0 },
    });

    log.info({ userId: user.id }, 'self-host: first registrant claimed admin + default server');
    return user;
  }, { timeout: 15000 });
}
