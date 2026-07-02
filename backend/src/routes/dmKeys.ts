// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { Router, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { prisma } from '../db.js';
import { authenticateToken, AuthRequest } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { validateUuidParams } from '../middleware/validateParams.js';
import {
  dmKeysSetupSchema,
  dmKeyBlobUpdateSchema,
  dmKeyPasswordChangeSchema,
  dmKeysRecoverSchema,
  enablePasswordDerivedSchema,
  serverRecoverSchema,
  dmKeysSigningKeyUpdateSchema,
  dmKeysRoamingIdentitySchema,
} from '../schemas.js';
import { encryptEscrow, decryptEscrow, isMasterKeyConfigured } from '../services/e2eEscrow.js';
import { getParam } from '../utils.js';
import rateLimit from 'express-rate-limit';
import { createRateLimitStore, RATE_LIMIT_DEFAULTS } from '../rateLimitStore.js';
import { logger } from '../logger.js';
import bcrypt from 'bcrypt';
import { getClientIp } from '../utils/clientIp.js';
import { hasBlockBetween } from './dmHelpers.js';

const router = Router();

// Display-only context persisted on each rotation link. The verifier uses a
// compiled-in label (services/mls/aikRotation LINK_LABEL); the server does zero crypto.
const AIK_LINK_CONTEXT = 'howl:mls:aik-rotation:v1';
// Server-side prune ceiling for a served chain. Rotations are rare, so 64 is generous;
// a peer pinned older than the pruned window fails closed -> manual recovery.
const AIK_CHAIN_MAX = 64;

const dmKeysLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-keys:'),
  windowMs: 60 * 1000,
  max: 15,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

// GET /api/dms/keys/bundle – fetch current user's key bundle
router.get('/bundle', authenticateToken, dmKeysLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: {
      publicKey: true,
      signingPublicKey: true,
      encryptedBlob: true,
      blobSalt: true,
      blobVersion: true,
      recoveryBlob: true,
      recoveryNonce: true,
      recoveryMode: true,
      recoveryPassphraseSalt: true,
      lastRecoveryReminder: true,
      passwordDerived: true,
    },
  });
  if (!bundle) return res.status(404).json({ error: 'Secure DMs not set up' });
  res.json(bundle);
}));

// POST /api/dms/keys/setup – first-time DM password setup
router.post('/setup', authenticateToken, dmKeysLimiter, validate(dmKeysSetupSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { publicKey, signingPublicKey, encryptedBlob, blobSalt, recoveryBlob, recoveryNonce, recoveryMode, recoveryPassphraseSalt } = req.body;

  const existing = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: { id: true },
  });
  if (existing) return res.status(409).json({ error: 'Secure DMs already set up' });

  const bundle = await prisma.dmKeyBundle.create({
    data: {
      userId: req.userId,
      publicKey,
      signingPublicKey: signingPublicKey ?? null,
      encryptedBlob,
      blobSalt,
      recoveryBlob,
      recoveryNonce,
      recoveryMode: recoveryMode ?? null,
      recoveryPassphraseSalt: recoveryPassphraseSalt ?? null,
    },
    select: { blobVersion: true },
  });
  logger.info({ userId: req.userId }, 'Secure DM setup complete');
  res.status(201).json({ blobVersion: bundle.blobVersion });
}));

// PUT /api/dms/keys/blob – update blob after merging keys (optimistic lock)
router.put('/blob', authenticateToken, dmKeysLimiter, validate(dmKeyBlobUpdateSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { encryptedBlob, blobVersion, rawBlobForEscrow } = req.body;

  const updated = await prisma.$transaction(async (tx): Promise<{ count: number; escrowStale: boolean } | { error: 'escrow_unavailable' }> => {
    // Look up the authoritative escrow mode unconditionally: needed both to
    // escrow when the client sent rawBlobForEscrow, and to flag `escrowStale`
    // when a password-derived row receives a write that OMITTED escrow — a stale
    // per-tab gate with no 409 to trigger reconcile. The
    // client adopts the truth and re-sends escrow once.
    const bundle = await tx.dmKeyBundle.findUnique({
      where: { userId: req.userId! },
      select: { passwordDerived: true },
    });
    let serverEscrowBlob: string | null | undefined;
    if (rawBlobForEscrow && bundle?.passwordDerived) {
      if (!isMasterKeyConfigured()) {
        // Do NOT null escrow on a missing master key — that silently
        // destroys the user's only Server-recovery path during an unrelated
        // write. Fail the whole write; blob + escrow move together or not at all.
        logger.error({ userId: req.userId }, 'SERVER_E2E_MASTER_KEY missing — refusing escrow-bearing write (503)');
        return { error: 'escrow_unavailable' } as const;
      }
      serverEscrowBlob = encryptEscrow(req.userId!, Buffer.from(rawBlobForEscrow, 'base64').toString('utf8'));
    }
    const escrowStale = !!bundle?.passwordDerived && !rawBlobForEscrow;

    const r = await tx.dmKeyBundle.updateMany({
      where: { userId: req.userId!, blobVersion },
      data: {
        encryptedBlob,
        blobVersion: blobVersion + 1,
        ...(serverEscrowBlob !== undefined && { serverEscrowBlob }),
      },
    });
    return { count: r.count, escrowStale };
  });

  if ('error' in updated) {
    return res.status(503).json({ error: 'Recovery escrow is temporarily unavailable. Please try again shortly.' });
  }
  if (updated.count === 0) {
    const current = await prisma.dmKeyBundle.findUnique({
      where: { userId: req.userId },
      select: { blobVersion: true },
    });
    if (!current) return res.status(404).json({ error: 'Secure DMs not set up' });
    return res.status(409).json({ error: 'Version conflict', currentVersion: current.blobVersion });
  }
  res.json({ blobVersion: blobVersion + 1, ...(updated.escrowStale && { escrowStale: true }) });
}));

// PUT /api/dms/keys/password – change DM password (re-encrypt blob)
router.put('/password', authenticateToken, dmKeysLimiter, validate(dmKeyPasswordChangeSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { encryptedBlob, blobSalt, blobVersion, recoveryBlob, recoveryNonce, recoveryMode, recoveryPassphraseSalt, signingPublicKey, rawBlobForEscrow } = req.body;

  const updated = await prisma.$transaction(async (tx): Promise<{ count: number } | { error: 'escrow_unavailable' }> => {
    let serverEscrowBlob: string | null | undefined;
    if (rawBlobForEscrow) {
      const bundle = await tx.dmKeyBundle.findUnique({
        where: { userId: req.userId! },
        select: { passwordDerived: true },
      });
      if (bundle?.passwordDerived) {
        if (!isMasterKeyConfigured()) {
          // Do NOT null escrow on a missing master key — that silently
          // destroys the user's only Server-recovery path during an unrelated
          // write. Fail the whole write; blob + escrow move together or not at all.
          logger.error({ userId: req.userId }, 'SERVER_E2E_MASTER_KEY missing — refusing escrow-bearing write (503)');
          return { error: 'escrow_unavailable' } as const;
        }
        serverEscrowBlob = encryptEscrow(req.userId!, Buffer.from(rawBlobForEscrow, 'base64').toString('utf8'));
      }
    }

    return tx.dmKeyBundle.updateMany({
      where: { userId: req.userId!, blobVersion },
      data: {
        encryptedBlob,
        blobSalt,
        blobVersion: blobVersion + 1,
        recoveryBlob,
        recoveryNonce,
        ...(recoveryMode !== undefined && { recoveryMode }),
        ...(recoveryPassphraseSalt !== undefined && { recoveryPassphraseSalt }),
        // Move the AIK column with the blob so it can never lag the blob's signing key.
        ...(signingPublicKey !== undefined && { signingPublicKey }),
        ...(serverEscrowBlob !== undefined && { serverEscrowBlob }),
      },
    });
  });

  if ('error' in updated) {
    return res.status(503).json({ error: 'Recovery escrow is temporarily unavailable. Please try again shortly.' });
  }
  if (updated.count === 0) {
    const current = await prisma.dmKeyBundle.findUnique({
      where: { userId: req.userId },
      select: { blobVersion: true },
    });
    if (!current) return res.status(404).json({ error: 'Secure DMs not set up' });
    return res.status(409).json({ error: 'Version conflict', currentVersion: current.blobVersion });
  }
  logger.info({ userId: req.userId }, 'Secure DM password changed');
  res.json({ blobVersion: blobVersion + 1 });
}));

// POST /api/dms/keys/recover – recovery key flow
router.post('/recover', authenticateToken, dmKeysLimiter, validate(dmKeysRecoverSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { encryptedBlob, blobSalt, recoveryBlob, recoveryNonce, recoveryMode, recoveryPassphraseSalt, signingPublicKey, rawBlobForEscrow } = req.body;

  // Recovery resets the blob entirely — no optimistic lock needed. Wrapped in a
  // transaction so the column write, escrow refresh, and rotation-chain reset commit
  // atomically (blob + escrow + chain move together or not at all).
  const result = await prisma.$transaction(async (tx): Promise<{ ok: true } | { error: 'escrow_unavailable' } | { error: 'not_setup' }> => {
    let serverEscrowBlob: string | null | undefined;
    if (rawBlobForEscrow) {
      const bundle = await tx.dmKeyBundle.findUnique({
        where: { userId: req.userId! },
        select: { passwordDerived: true },
      });
      if (bundle?.passwordDerived) {
        if (!isMasterKeyConfigured()) {
          // Do NOT null escrow on a missing master key — blob + escrow move together
          // or not at all. Fail the whole write (503, rolls back).
          logger.error({ userId: req.userId }, 'SERVER_E2E_MASTER_KEY missing — refusing escrow-bearing recover (503)');
          return { error: 'escrow_unavailable' } as const;
        }
        serverEscrowBlob = encryptEscrow(req.userId!, Buffer.from(rawBlobForEscrow, 'base64').toString('utf8'));
      }
    }

    // An AIK discontinuity check BEFORE the write: recovery emits NO rotation link
    // (the restored key may be an ancestor or unrelated). If the restored column AIK
    // is not the current chain head, the prior chain is orphaned — clear it so a later
    // rotation starts a fresh lineage instead of forking. Restoring the current head
    // keeps the chain intact (lagging peers can still walk it forward).
    let clearChain = false;
    if (signingPublicKey !== undefined) {
      const head = await tx.aikHead.findUnique({ where: { userId: req.userId! }, select: { aik: true } });
      clearChain = !head || head.aik !== signingPublicKey;
    }

    const updated = await tx.dmKeyBundle.updateMany({
      where: { userId: req.userId! },
      data: {
        encryptedBlob,
        blobSalt,
        blobVersion: { increment: 1 },
        ...(recoveryBlob && { recoveryBlob }),
        ...(recoveryNonce && { recoveryNonce }),
        ...(recoveryMode !== undefined && { recoveryMode }),
        ...(recoveryPassphraseSalt !== undefined && { recoveryPassphraseSalt }),
        // Heal the AIK column to the recovered blob's signing key (a recovery restores the
        // canonical AIK from the recovery/escrow blob, so the column must follow it).
        ...(signingPublicKey !== undefined && { signingPublicKey }),
        ...(serverEscrowBlob !== undefined && { serverEscrowBlob }),
      },
    });
    if (updated.count === 0) return { error: 'not_setup' } as const;

    if (clearChain) {
      await tx.aikRotation.deleteMany({ where: { userId: req.userId! } });
      await tx.aikHead.deleteMany({ where: { userId: req.userId! } });
    }
    return { ok: true } as const;
  });

  if ('error' in result) {
    if (result.error === 'escrow_unavailable') {
      return res.status(503).json({ error: 'Recovery escrow is temporarily unavailable. Please try again shortly.' });
    }
    return res.status(404).json({ error: 'Secure DMs not set up' });
  }
  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: { blobVersion: true },
  });
  logger.info({ userId: req.userId }, 'Secure DM recovery complete');
  res.json({ blobVersion: bundle!.blobVersion });
}));

// GET /api/dms/keys/public-key/:userId – fetch another user's public keys
// Returns both the X25519 box pubkey and the Ed25519 signing pubkey.
router.get('/public-key/:userId', validateUuidParams('userId'), authenticateToken, dmKeysLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const targetUserId = getParam(req, 'userId');

  // Trust & Safety: a block in either direction must not let a blocked user fetch
  // the blocker's identity keys (used for voice/stage join-blob verification).
  // Mirrors the block guard on GET /mls/keypackages/:userId.
  if (await hasBlockBetween(req.userId, targetUserId)) {
    return res.status(403).json({ error: 'Cannot fetch keys for this user' });
  }

  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: targetUserId },
    select: { publicKey: true, signingPublicKey: true },
  });
  if (!bundle) return res.status(404).json({ error: 'User has not set up Secure DMs' });
  res.json({ publicKey: bundle.publicKey, signingPublicKey: bundle.signingPublicKey });
}));

// GET /api/dms/keys/aik-chain/:userId – fetch another user's AIK rotation-attestation
// chain so a peer can advance its pin across a legitimate rotation. Public material
// only (AIKs + detached signatures); the server does no crypto. Block-guarded AND gated
// to users who share a DM channel (a peer only needs this when validating that user's
// credential, which only happens inside a shared DM/group). Returns the chain ascending
// by seq, pruned to the most recent AIK_CHAIN_MAX links, plus the current signed head.
router.get('/aik-chain/:userId', validateUuidParams('userId'), authenticateToken, dmKeysLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const targetUserId = getParam(req, 'userId');

  if (await hasBlockBetween(req.userId, targetUserId)) {
    return res.status(403).json({ error: 'Cannot fetch keys for this user' });
  }
  // Self is always allowed; otherwise require a shared DM channel.
  if (targetUserId !== req.userId) {
    const shared = await prisma.dMChannel.findFirst({
      where: {
        AND: [
          { participants: { some: { userId: req.userId } } },
          { participants: { some: { userId: targetUserId } } },
        ],
      },
      select: { id: true },
    });
    if (!shared) return res.status(403).json({ error: 'No shared conversation with this user' });
  }

  const [rows, head] = await Promise.all([
    prisma.aikRotation.findMany({
      where: { userId: targetUserId },
      select: { seq: true, oldAik: true, newAik: true, signature: true },
      orderBy: { seq: 'desc' },
      take: AIK_CHAIN_MAX, // most recent K
    }),
    prisma.aikHead.findUnique({
      where: { userId: targetUserId },
      select: { seq: true, aik: true, signature: true },
    }),
  ]);
  res.json({ chain: rows.reverse(), head: head ?? null }); // ascending by seq
}));

// PUT /api/dms/keys/signing-key – lazy upload of Ed25519 public key for
// legacy bundles that predate the signing-key rollout. Requires a matching
// blobVersion update so the corresponding privateSigningKey inside the blob
// stays in sync.
router.put('/signing-key', authenticateToken, dmKeysLimiter, validate(dmKeysSigningKeyUpdateSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { signingPublicKey, encryptedBlob, blobVersion, rawBlobForEscrow } = req.body;

  const result = await prisma.$transaction(async (tx): Promise<{ newVersion: number } | { error: 'conflict' } | { error: 'escrow_unavailable' }> => {
    // Resolve the authoritative escrow mode BEFORE the blob write so blob + escrow
    // move together or not at all — mirroring /blob and /password. (Previously this
    // route bumped blobVersion FIRST and re-escrowed only if the master key happened
    // to be configured, so a passwordDerived=true (Server-recovery) user's escrow
    // could silently lag the committed blob during a master-key-unconfigured window,
    // and a later /server-recover would return a stale blob.)
    const bundle = await tx.dmKeyBundle.findUnique({
      where: { userId: req.userId! },
      select: { passwordDerived: true },
    });
    let serverEscrowBlob: string | undefined;
    if (rawBlobForEscrow && bundle?.passwordDerived) {
      if (!isMasterKeyConfigured()) {
        // Do NOT commit a blob+version bump without the matching escrow
        // refresh — that strands a Server-recovery user's escrow behind the live
        // blob with no convergence trigger. Fail the whole write (503, rolls back).
        logger.error({ userId: req.userId }, 'SERVER_E2E_MASTER_KEY missing — refusing escrow-bearing signing-key write (503)');
        return { error: 'escrow_unavailable' } as const;
      }
      serverEscrowBlob = encryptEscrow(req.userId!, Buffer.from(rawBlobForEscrow, 'base64').toString('utf8'));
    }

    // A signing-key install emits NO rotation link (it is a genesis AIK for a legacy
    // bundle, or a fresh key minted during recovery). If a chain head exists for a
    // DIFFERENT key, this is a discontinuity — clear the orphaned chain so a later
    // rotation starts a fresh lineage instead of forking. (Usually a no-op: a legacy
    // bundle has no chain.)
    const head = await tx.aikHead.findUnique({ where: { userId: req.userId! }, select: { aik: true } });
    const clearChain = !!head && head.aik !== signingPublicKey;

    const updateRes = await tx.dmKeyBundle.updateMany({
      where: { userId: req.userId!, blobVersion },
      data: {
        signingPublicKey,
        encryptedBlob,
        blobVersion: blobVersion + 1,
        ...(serverEscrowBlob !== undefined && { serverEscrowBlob }),
      },
    });
    if (updateRes.count === 0) return { error: 'conflict' } as const;

    if (clearChain) {
      await tx.aikRotation.deleteMany({ where: { userId: req.userId! } });
      await tx.aikHead.deleteMany({ where: { userId: req.userId! } });
    }
    return { newVersion: blobVersion + 1 };
  });

  if ('error' in result) {
    if (result.error === 'escrow_unavailable') {
      return res.status(503).json({ error: 'Recovery escrow is temporarily unavailable. Please try again shortly.' });
    }
    const current = await prisma.dmKeyBundle.findUnique({ where: { userId: req.userId }, select: { blobVersion: true } });
    return res.status(409).json({ error: 'Version conflict', currentVersion: current?.blobVersion });
  }
  res.json({ blobVersion: result.newVersion });
}));

// PUT /api/dms/keys/roaming-identity - Move-to-Private rotation of the X25519 box
// keypair + Ed25519 signing keypair. Updates publicKey + signingPublicKey +
// re-sealed encryptedBlob atomically under a blobVersion CAS. Escrow is re-written
// ONLY if passwordDerived (a no-op during move-to-Private, where it is already
// false) - asserted by tests.
router.put('/roaming-identity', authenticateToken, dmKeysLimiter, validate(dmKeysRoamingIdentitySchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { publicKey, signingPublicKey, encryptedBlob, blobVersion, rawBlobForEscrow, aikRotation, aikHead } = req.body;

  const result = await prisma.$transaction(async (tx) => {
    // Defense-in-depth attestation validation (the client enforces linearity too).
    // Both halves must be present and internally consistent: the head binds the link's
    // successor, and the seq must extend the existing head by exactly one.
    if (aikRotation || aikHead) {
      if (!aikRotation || !aikHead) return { error: 'bad_attestation' } as const;
      if (
        aikRotation.newAik !== signingPublicKey ||
        aikRotation.oldAik === aikRotation.newAik ||
        aikHead.aik !== aikRotation.newAik ||
        aikHead.seq !== aikRotation.seq
      ) {
        return { error: 'bad_attestation' } as const;
      }
      const head = await tx.aikHead.findUnique({ where: { userId: req.userId! }, select: { seq: true } });
      if (aikRotation.seq !== (head?.seq ?? 0) + 1) return { error: 'bad_attestation' } as const;
    }

    // Compatibility / discontinuity: a roaming rotation that does NOT carry an
    // attestation (an old client predating this deploy, or a genesis install) is a
    // discontinuity when it actually changes the column AIK. Clear any existing chain so
    // a subsequent attested rotation starts a clean lineage from the new key instead of
    // forking an orphaned one. (New clients always attest, so this is the legacy path.)
    let clearChainNoAttest = false;
    if (!aikRotation) {
      const cur = await tx.dmKeyBundle.findUnique({ where: { userId: req.userId! }, select: { signingPublicKey: true } });
      clearChainNoAttest = !!cur && cur.signingPublicKey !== signingPublicKey;
    }

    const updateRes = await tx.dmKeyBundle.updateMany({
      where: {
        userId: req.userId!,
        blobVersion,
        // CAS on the predecessor: when attesting a rotation, the column AIK MUST equal
        // the link's oldAik, so the column never advances without a reaching link. A
        // concurrent device that already won (column != oldAik) loses here (count 0).
        ...(aikRotation && { signingPublicKey: aikRotation.oldAik }),
      },
      data: { publicKey, signingPublicKey, encryptedBlob, blobVersion: blobVersion + 1 },
    });
    if (updateRes.count === 0) return { error: 'conflict' } as const;

    if (clearChainNoAttest) {
      await tx.aikRotation.deleteMany({ where: { userId: req.userId! } });
      await tx.aikHead.deleteMany({ where: { userId: req.userId! } });
    }

    if (aikRotation && aikHead) {
      // Same transaction as the column write. The @@unique([userId, seq|oldAik|newAik])
      // guards roll the whole tx back on a forked/duplicate append, so a column AIK can
      // never reach a peer without a well-formed, contiguous link to it.
      await tx.aikRotation.create({
        data: {
          userId: req.userId!, seq: aikRotation.seq, oldAik: aikRotation.oldAik,
          newAik: aikRotation.newAik, signature: aikRotation.signature, context: AIK_LINK_CONTEXT,
        },
      });
      await tx.aikHead.upsert({
        where: { userId: req.userId! },
        create: { userId: req.userId!, seq: aikHead.seq, aik: aikHead.aik, signature: aikHead.signature },
        update: { seq: aikHead.seq, aik: aikHead.aik, signature: aikHead.signature },
      });
    }

    if (rawBlobForEscrow) {
      const bundle = await tx.dmKeyBundle.findUnique({
        where: { userId: req.userId! },
        select: { passwordDerived: true },
      });
      if (bundle?.passwordDerived && isMasterKeyConfigured()) {
        const escrow = encryptEscrow(req.userId!, Buffer.from(rawBlobForEscrow, 'base64').toString('utf8'));
        await tx.dmKeyBundle.update({
          where: { userId: req.userId! },
          data: { serverEscrowBlob: escrow },
        });
      }
    }
    return { newVersion: blobVersion + 1 };
  });

  if ('error' in result) {
    if (result.error === 'bad_attestation') {
      return res.status(400).json({ error: 'Invalid rotation attestation' });
    }
    // Surface the current column AIK so a losing concurrent device can tell a pure
    // blobVersion conflict (retry) from another device having already rotated (abandon).
    const current = await prisma.dmKeyBundle.findUnique({ where: { userId: req.userId }, select: { blobVersion: true, signingPublicKey: true } });
    return res.status(409).json({ error: 'Version conflict', currentVersion: current?.blobVersion, currentSigningPublicKey: current?.signingPublicKey });
  }
  res.json({ blobVersion: result.newVersion });
}));

// POST /api/dms/keys/dismiss-reminder – update lastRecoveryReminder
router.post('/dismiss-reminder', authenticateToken, dmKeysLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  await prisma.dmKeyBundle.updateMany({
    where: { userId: req.userId },
    data: { lastRecoveryReminder: new Date() },
  });
  res.json({ success: true });
}));

// PUT /api/dms/keys/password-derived – enable password-derived mode with server escrow
router.put('/password-derived', authenticateToken, dmKeysLimiter, validate(enablePasswordDerivedSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });
  const { rawBlobForEscrow } = req.body;

  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: { id: true, passwordDerived: true },
  });
  if (!bundle) return res.status(404).json({ error: 'Secure DMs not set up' });

  if (!isMasterKeyConfigured()) {
    return res.status(503).json({ error: 'Password-derived mode is not available. The server administrator has not configured it.' });
  }

  const escrowBlob = encryptEscrow(req.userId, Buffer.from(rawBlobForEscrow, 'base64').toString('utf8'));

  await prisma.dmKeyBundle.update({
    where: { userId: req.userId },
    data: {
      passwordDerived: true,
      serverEscrowBlob: escrowBlob,
      recoveryMode: 'server-escrowed',
    },
  });

  // Enabling Server recovery is incompatible with OTR (the escrowed
  // identity could mint a ghost device into the group). Auto-end every OTR
  // group this user is in: delete the server row and signal both participants.
  try {
    const otrGroups = await prisma.mlsGroup.findMany({
      where: {
        tier: 'otr',
        dmChannel: { participants: { some: { userId: req.userId } } },
      },
      select: { id: true, dmChannelId: true, dmChannel: { select: { participants: { select: { userId: true }, take: 1000 } } } },
      take: 1000,
    });
    if (otrGroups.length) {
      await prisma.mlsGroup.deleteMany({ where: { id: { in: otrGroups.map((g) => g.id) } } });
      const io = req.app.get('io') as import('socket.io').Server | undefined;
      if (io) {
        for (const g of otrGroups) {
          for (const { userId: pid } of g.dmChannel.participants) {
            io.to(`user:${pid}`).emit('otr-ended', { dmChannelId: g.dmChannelId, mlsGroupId: g.id });
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err, userId: req.userId }, 'OTR auto-end on Server-recovery enable failed');
  }

  logger.info({ userId: req.userId }, 'Password-derived E2E mode enabled');
  res.json({ success: true });
}));

// DELETE /api/dms/keys/password-derived – disable password-derived mode
router.delete('/password-derived', authenticateToken, dmKeysLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: { id: true, passwordDerived: true },
  });
  if (!bundle) return res.status(404).json({ error: 'Secure DMs not set up' });
  if (!bundle.passwordDerived) return res.status(400).json({ error: 'Password-derived mode is not enabled' });

  await prisma.dmKeyBundle.update({
    where: { userId: req.userId },
    data: {
      passwordDerived: false,
      serverEscrowBlob: null,
      recoveryMode: null,
    },
  });

  logger.info({ userId: req.userId }, 'Password-derived E2E mode disabled');
  res.json({ success: true });
}));

// POST /api/dms/keys/server-recover – recover E2E keys from server escrow
const serverRecoverLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-keys-recover:'),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many recovery attempts. Try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

router.post('/server-recover', authenticateToken, serverRecoverLimiter, validate(serverRecoverSchema), asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  if (!isMasterKeyConfigured()) {
    return res.status(503).json({ error: 'Server recovery is not available.' });
  }

  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: { passwordDerived: true, serverEscrowBlob: true },
  });
  if (!bundle) return res.status(404).json({ error: 'Secure DMs not set up' });
  if (!bundle.passwordDerived) return res.status(400).json({ error: 'Password-derived mode is not enabled' });
  if (!bundle.serverEscrowBlob) return res.status(404).json({ error: 'No escrow blob found' });

  // Verify account password — defense in depth for the most sensitive endpoint
  const { password } = req.body;
  const user = await prisma.user.findUnique({
    where: { id: req.userId },
    select: { passwordHash: true },
  });
  if (!user?.passwordHash) return res.status(400).json({ error: 'Account has no password set' });
  const validPw = await bcrypt.compare(password, user.passwordHash);
  if (!validPw) return res.status(403).json({ error: 'Incorrect password' });

  try {
    const rawBlobJson = decryptEscrow(req.userId, bundle.serverEscrowBlob);
    const rawBlobBase64 = Buffer.from(rawBlobJson, 'utf8').toString('base64');

    res.setHeader('Cache-Control', 'no-store');
    res.json({ rawBlob: rawBlobBase64 });
    logger.info({ userId: req.userId }, 'E2E server-escrowed recovery completed');
  } catch (err) {
    logger.error({ userId: req.userId, error: (err as Error).message }, 'E2E escrow decryption failed');
    return res.status(500).json({ error: 'Failed to decrypt escrow. The server encryption key may have changed.' });
  }
}));

// DELETE /api/dms/keys/bundle – full encryption reset (wipe key bundle)
const dmKeysResetLimiter = rateLimit({ ...RATE_LIMIT_DEFAULTS,
  store: createRateLimitStore('rl:dm-keys-reset:'),
  windowMs: 60 * 1000,
  max: 5,
  message: { error: 'Too many requests. Please slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req as AuthRequest).userId ?? getClientIp(req) ?? 'anonymous',
});

router.delete('/bundle', authenticateToken, dmKeysResetLimiter, asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.userId) return res.status(401).json({ error: 'Missing user' });

  const bundle = await prisma.dmKeyBundle.findUnique({
    where: { userId: req.userId },
    select: { id: true },
  });
  if (!bundle) return res.status(404).json({ error: 'Secure DMs not set up' });

  await prisma.$transaction([
    prisma.dmHistoryArchive.deleteMany({ where: { userId: req.userId } }),
    // Clear the user's delete-for-everyone tombstones too — an encryption
    // reset wipes the archive, so the tombstones that guarded it are moot.
    prisma.dmHistoryArchiveTombstone.deleteMany({ where: { userId: req.userId } }),
    // Also drop the user's server-side MLS KeyPackages (single-use AND the no-expiry
    // last-resort) so an encryption reset leaves no orphaned last-resort row that a
    // future adder could still consume.
    prisma.mlsKeyPackage.deleteMany({ where: { userId: req.userId } }),
    // Reset hygiene: the user's pending MLS Welcomes are sealed to init keys whose
    // private halves the reset just destroyed — they can never be joined and would
    // spam "no candidate KeyPackage matched" on every future drain.
    prisma.mlsWelcome.deleteMany({ where: { recipientId: req.userId } }),
    // Reset hygiene: the AIK lineage ends here (re-setup mints an unlinked genesis
    // AIK), so clear the now-orphaned rotation chain + head — mirrors the
    // discontinuity clears on /recover and /signing-key.
    prisma.aikRotation.deleteMany({ where: { userId: req.userId } }),
    prisma.aikHead.deleteMany({ where: { userId: req.userId } }),
    prisma.dmKeyBundle.delete({ where: { userId: req.userId } }),
  ]);

  // Best-effort fan-out so DM partners' clients (and this account's OTHER devices)
  // learn about the reset immediately instead of on the next failed establish. The
  // payload names only the resetter; receivers NEVER clear a pin on it (a
  // server-triggerable event must not weaken TOFU) — they just re-attempt establish,
  // which surfaces the key-change accept prompt through the normal validation path.
  try {
    const [partners, blocks] = await Promise.all([
      prisma.dMParticipant.findMany({
        where: {
          userId: { not: req.userId },
          pendingRemoval: null,
          dmChannel: { participants: { some: { userId: req.userId } } },
        },
        select: { userId: true },
        distinct: ['userId'],
        take: 1000,
      }),
      // Trust & Safety: a block in either direction must not let this event act as an
      // activity beacon to a blocked user (blocked pairs keep their DM channel rows).
      prisma.block.findMany({
        where: { OR: [{ blockerId: req.userId }, { blockedUserId: req.userId }] },
        select: { blockerId: true, blockedUserId: true },
        take: 5000,
      }),
    ]);
    const blockedIds = new Set(blocks.map((b) => (b.blockerId === req.userId ? b.blockedUserId : b.blockerId)));
    const io = req.app.get('io') as import('socket.io').Server | undefined;
    if (io) {
      io.to(`user:${req.userId}`).emit('dm-encryption-reset', { userId: req.userId });
      for (const { userId } of partners) {
        if (blockedIds.has(userId)) continue;
        io.to(`user:${userId}`).emit('dm-encryption-reset', { userId: req.userId });
      }
    }
  } catch (err) {
    logger.warn({ userId: req.userId, error: (err as Error).message }, 'Encryption-reset fan-out failed; peers learn on next establish');
  }

  logger.info({ userId: req.userId }, 'Secure DM encryption reset — bundle deleted');
  res.json({ success: true });
}));

export default router;
