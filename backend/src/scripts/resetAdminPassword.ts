// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import '../loadEnv.js';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { hashEmail } from '../services/mfaCrypto.js';

async function main() {
  const args = process.argv.slice(2);
  const flagVal = (flag: string) => {
    const i = args.indexOf(flag);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
  };

  const email = flagVal('--email')?.trim().toLowerCase();
  const password = flagVal('--password');

  if (!email || !email.includes('@')) {
    console.error('Usage: npx tsx src/scripts/resetAdminPassword.ts --email <email> --password <new-password>');
    process.exit(1);
  }
  if (!password || password.length < 12) {
    console.error('Error: Password must be at least 12 characters.');
    process.exit(1);
  }

  const admin = await prisma.adminUser.findUnique({ where: { emailHash: hashEmail(email) } });
  if (!admin) {
    console.error(`Error: No admin found with email "${email}".`);
    process.exit(1);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.adminUser.update({
    where: { id: admin.id },
    data: { passwordHash },
  });

  // Revoke all existing sessions for this admin
  const deleted = await prisma.adminSession.deleteMany({ where: { adminUserId: admin.id } });
  if (deleted.count > 0) {
    console.log(`  Revoked ${deleted.count} active session(s).`);
  }

  // Audit trail for admin password reset
  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      action: 'admin_password_reset',
      targetUserId: admin.id,
      details: { source: 'cli_script', sessionsRevoked: deleted.count } as any,
    },
  });

  console.log(`\n  Admin password reset successfully.`);
  console.log(`  Email: ${email}`);
  console.log(`  Use the new password to sign in.\n`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
