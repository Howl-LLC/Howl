// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import '../loadEnv.js';
import readline from 'readline';
import bcrypt from 'bcrypt';
import { prisma } from '../db.js';
import { hashEmail, encryptSecret } from '../services/mfaCrypto.js';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function main() {
  // Support non-interactive mode: --email x --username y --password z
  const args = process.argv.slice(2);
  const flagIdx = (flag: string) => args.indexOf(flag);
  const flagVal = (flag: string) => { const i = flagIdx(flag); return i >= 0 && i + 1 < args.length ? args[i + 1] : null; };

  let email = flagVal('--email');
  let username = flagVal('--username');
  let password = flagVal('--password');

  const interactive = !email || !username || !password;

  if (interactive) {
    console.log('\n  Howl Admin — Create Admin Account\n');

    if (!email) email = (await ask('  Email: ')).trim().toLowerCase();
    if (!email || !email.includes('@')) {
      console.error('  Error: Invalid email address.');
      process.exit(1);
    }

    const existing = await prisma.adminUser.findUnique({ where: { emailHash: hashEmail(email) } });
    if (existing) {
      console.error(`  Error: An admin with email "${email}" already exists.`);
      process.exit(1);
    }

    if (!username) username = (await ask('  Username: ')).trim();
    if (!username || username.length < 2) {
      console.error('  Error: Username must be at least 2 characters.');
      process.exit(1);
    }

    if (!password) password = (await ask('  Password: ')).trim();
    if (password.length < 12) {
      console.error('  Error: Password must be at least 12 characters.');
      process.exit(1);
    }

    const confirm = (await ask('  Confirm password: ')).trim();
    // eslint-disable-next-line security/detect-possible-timing-attacks -- CLI script, not a web endpoint
    if (password !== confirm) {
      console.error('  Error: Passwords do not match.');
      process.exit(1);
    }
  } else {
    email = email!.toLowerCase().trim();
    if (!email.includes('@')) { console.error('Error: Invalid email.'); process.exit(1); }
    if (username!.length < 2) { console.error('Error: Username must be at least 2 characters.'); process.exit(1); }
    if (password!.length < 12) { console.error('Error: Password must be at least 12 characters.'); process.exit(1); }

    const existing = await prisma.adminUser.findUnique({ where: { emailHash: hashEmail(email!) } });
    if (existing) { console.error(`Error: Admin "${email}" already exists.`); process.exit(1); }
  }

  const passwordHash = await bcrypt.hash(password!, 12);

  const admin = await prisma.adminUser.create({
    data: {
      email: encryptSecret(email!),
      emailHash: hashEmail(email!),
      username: username!,
      passwordHash,
    },
  });

  // Audit trail for admin account creation
  await prisma.adminAuditLog.create({
    data: {
      adminId: admin.id,
      action: 'admin_account_created',
      targetUserId: admin.id,
      details: { source: 'cli_script', username: username! } as any,
    },
  });

  console.log(`\n  Admin account created successfully.`);
  console.log(`  ID:       ${admin.id}`);
  console.log(`  Email:    ${email}`);
  console.log(`  Username: ${admin.username}\n`);

  rl.close();
  await prisma.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('  Fatal error:', err.message);
  process.exit(1);
});
