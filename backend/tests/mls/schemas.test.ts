// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  mlsPublishKeyPackagesSchema,
  mlsKeyPackageCountQuerySchema,
  mlsCreateGroupSchema,
  mlsSubmitCommitSchema,
  mlsCommitCatchupSchema,
  mlsGroupIdParamSchema,
} from '../../src/schemas.js';

const b64 = Buffer.from('hello-mls').toString('base64');

describe('MLS REST schemas', () => {
  it('accepts a valid keypackage publish batch and rejects unknown fields', () => {
    const ok = mlsPublishKeyPackagesSchema.safeParse({
      body: { deviceId: randomUUID(), keyPackages: [{ keyPackage: b64, isLastResort: false }] },
    });
    expect(ok.success).toBe(true);
    const bad = mlsPublishKeyPackagesSchema.safeParse({
      body: { deviceId: randomUUID(), keyPackages: [{ keyPackage: b64 }], surprise: 1 },
    });
    expect(bad.success).toBe(false); // .strict() rejects extra keys
  });

  it('rejects a publish batch carrying more than one last-resort KeyPackage', () => {
    const deviceId = randomUUID();
    // Two explicit last-resort items => rejected.
    const twoLastResort = mlsPublishKeyPackagesSchema.safeParse({
      body: {
        deviceId,
        keyPackages: [
          { keyPackage: b64, isLastResort: true },
          { keyPackage: b64, isLastResort: true },
        ],
      },
    });
    expect(twoLastResort.success).toBe(false);

    // Exactly one explicit last-resort, the rest false => accepted.
    const oneLastResort = mlsPublishKeyPackagesSchema.safeParse({
      body: {
        deviceId,
        keyPackages: [
          { keyPackage: b64, isLastResort: true },
          { keyPackage: b64, isLastResort: false },
        ],
      },
    });
    expect(oneLastResort.success).toBe(true);

    // Zero last-resort => accepted.
    const zeroLastResort = mlsPublishKeyPackagesSchema.safeParse({
      body: { deviceId, keyPackages: [{ keyPackage: b64, isLastResort: false }] },
    });
    expect(zeroLastResort.success).toBe(true);

    // One explicit last-resort + one item OMITTING the flag => accepted.
    // Proves the element-level .default(false) resolves before the array-level
    // .refine(), so an omitted flag does NOT count toward the at-most-one limit.
    const oneLastResortPlusOmitted = mlsPublishKeyPackagesSchema.safeParse({
      body: {
        deviceId,
        keyPackages: [{ keyPackage: b64, isLastResort: true }, { keyPackage: b64 }],
      },
    });
    expect(oneLastResortPlusOmitted.success).toBe(true);
  });

  it('requires epoch as a decimal string (not a number) on commit submit', () => {
    const base = {
      body: {
        baseEpoch: '0',
        mode: 'member' as const,
        commit: b64,
        groupInfo: b64,
        idempotencyKey: randomUUID(),
      },
    };
    expect(mlsSubmitCommitSchema.safeParse(base).success).toBe(true);
    const numericEpoch = { body: { ...base.body, baseEpoch: 0 as unknown as string } };
    expect(mlsSubmitCommitSchema.safeParse(numericEpoch).success).toBe(false);
  });

  it('coerces catch-up limit and validates sinceEpoch as a string', () => {
    const parsed = mlsCommitCatchupSchema.safeParse({ query: { sinceEpoch: '5', limit: '50' } });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.query.limit).toBe(50);
  });

  it('validates the groupId param as a UUID', () => {
    expect(mlsGroupIdParamSchema.safeParse({ params: { groupId: randomUUID() } }).success).toBe(true);
    expect(mlsGroupIdParamSchema.safeParse({ params: { groupId: 'nope' } }).success).toBe(false);
  });

  it('rejects member-mode commit that carries welcomes when none allowed, and accepts add-with-welcomes', () => {
    const withWelcome = mlsSubmitCommitSchema.safeParse({
      body: {
        baseEpoch: '1',
        mode: 'member',
        commit: b64,
        groupInfo: b64,
        idempotencyKey: randomUUID(),
        welcomes: [{ recipientId: randomUUID(), welcomeData: b64 }],
      },
    });
    expect(withWelcome.success).toBe(true);
  });

  it('accepts a member-mode commit carrying removedUserIds (the Remove finalize hint)', () => {
    const withRemoved = mlsSubmitCommitSchema.safeParse({
      body: {
        baseEpoch: '2',
        mode: 'member',
        commit: b64,
        groupInfo: b64,
        idempotencyKey: randomUUID(),
        removedUserIds: [randomUUID(), randomUUID()],
      },
    });
    expect(withRemoved.success).toBe(true);
  });

  it('rejects removedUserIds whose element is not a UUID', () => {
    const badRemoved = mlsSubmitCommitSchema.safeParse({
      body: {
        baseEpoch: '2',
        mode: 'member',
        commit: b64,
        groupInfo: b64,
        idempotencyKey: randomUUID(),
        removedUserIds: ['not-a-uuid'],
      },
    });
    expect(badRemoved.success).toBe(false);
  });
});
