// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Recovery escape hatch: clears an admin's TOTP + all passkeys
 * + all sessions, returning the account to the fresh-bootstrap state where
 * the next login walks the full enrollment wizard.
 *
 * With factor-auth-first enrollment, an admin who loses their factors
 * cannot re-enroll (they cannot prove factors they lost). The panel's
 * two-person recovery (POST /admin/accounts/:id/disable-mfa) covers other
 * admins but deliberately refuses self and owner targets; this CLI is the
 * escape hatch for exactly those.
 */
import '../loadEnv.js';
import readline from 'readline';
import { prisma } from '../db.js';
import { hashEmail } from '../services/mfaCrypto.js';

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    // Stdin that ends without an answer (EOF, non-interactive shell) resolves
    // empty, which the caller treats as "not an explicit yes" and aborts.
    rl.once('close', () => resolve(''));
    rl.question(question, resolve);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const flagVal = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  const email = flagVal('--email')?.trim().toLowerCase();

  if (!email || !email.includes('@')) {
    console.error('Usage: npx tsx src/scripts/resetAdminMfa.ts --email <email>');
    process.exit(1);
  }

  const admin = await prisma.adminUser.findUnique({ where: { emailHash: hashEmail(email) } });
  if (!admin) {
    console.error(`Error: No admin found with email "${email}".`);
    process.exit(1);
  }

  // Confirm interactively against the resolved row, so a wrong-target reset is
  // visible before it happens rather than after.
  console.log(`\n  This will clear TOTP, delete all passkeys, and revoke all sessions for`);
  console.log(`  admin "${admin.username}" (role: ${admin.role}).`);
  // The interface is opened here, not at module load: one opened at import time
  // consumes and closes piped stdin before the prompt is ever reached.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await ask(rl, '  Continue? (y/N): ')).trim().toLowerCase();
  rl.close();

  if (answer !== 'y' && answer !== 'yes') {
    console.error('Aborted. No changes were made.');
    process.exit(1);
  }

  // Reset and audit row commit or roll back together: an audit write that failed
  // after the mutations committed would leave a completed reset with no trail.
  const { passkeys, sessions } = await prisma.$transaction(async (tx) => {
    const passkeys = await tx.adminPasskey.deleteMany({ where: { adminUserId: admin.id } });
    await tx.adminUser.update({
      where: { id: admin.id },
      data: { mfaEnabled: false, mfaTotpSecret: null },
    });
    const sessions = await tx.adminSession.deleteMany({ where: { adminUserId: admin.id } });

    await tx.adminAuditLog.create({
      data: {
        adminId: admin.id,
        action: 'admin_mfa_reset',
        targetUserId: admin.id,
        details: {
          source: 'cli_script',
          passkeysDeleted: passkeys.count,
          sessionsRevoked: sessions.count,
        } as any,
      },
    });

    return { passkeys, sessions };
  });

  console.log(`\n  Admin MFA reset successfully.`);
  console.log(`  Email: ${email}`);
  console.log(`  Removed ${passkeys.count} passkey(s), revoked ${sessions.count} session(s).`);
  console.log(`  WARNING: the account is now in fresh-bootstrap state. The next login`);
  console.log(`  with the password walks the full enrollment wizard (TOTP + passkey).`);
  console.log(`  Re-enroll immediately.\n`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
