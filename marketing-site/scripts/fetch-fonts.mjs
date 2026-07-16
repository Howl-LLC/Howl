#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
// Fetches the Fontshare display fonts (Clash Display + Satoshi) at build time.
//
// These two families are NOT committed to the repository: they ship under the
// ITF Free Font License, whose redistribution terms are unclear, so we download
// them on demand instead of re-hosting the files in git. The site's CSS font
// stacks fall back to system sans-serif when they are absent, so this step is
// best-effort and must NEVER fail the build.
//
// Requires the `unzip` binary (present on macOS and standard CI images). If it
// is missing, or the network is unavailable, the fonts are simply skipped.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONTS_ROOT = join(__dirname, '..', 'public', 'fonts');

// Only the weights referenced by src/styles/global.css.
const FAMILIES = [
  {
    slug: 'clash-display',
    dir: 'clash-display',
    zipPrefix: 'ClashDisplay_Complete/Fonts/WEB/fonts',
    files: [
      'ClashDisplay-Medium.woff2',
      'ClashDisplay-Semibold.woff2',
      'ClashDisplay-Bold.woff2',
    ],
  },
  {
    slug: 'satoshi',
    dir: 'satoshi',
    zipPrefix: 'Satoshi_Complete/Fonts/WEB/fonts',
    files: [
      'Satoshi-Regular.woff2',
      'Satoshi-Medium.woff2',
      'Satoshi-Bold.woff2',
    ],
  },
];

async function fetchFamily(fam) {
  const destDir = join(FONTS_ROOT, fam.dir);
  const missing = fam.files.filter((f) => !existsSync(join(destDir, f)));
  if (missing.length === 0) {
    console.log(`[fetch-fonts] ${fam.dir}: already present, skipping`);
    return;
  }
  mkdirSync(destDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'howl-fonts-'));
  const zipPath = join(tmp, `${fam.slug}.zip`);
  try {
    const res = await fetch(`https://api.fontshare.com/v2/fonts/download/${fam.slug}`, {
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
    for (const f of fam.files) {
      execFileSync('unzip', ['-o', '-j', zipPath, `${fam.zipPrefix}/${f}`, '-d', destDir], {
        stdio: 'ignore',
      });
    }
    console.log(`[fetch-fonts] ${fam.dir}: fetched ${fam.files.length} weights`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

for (const fam of FAMILIES) {
  try {
    await fetchFamily(fam);
  } catch (err) {
    console.warn(
      `[fetch-fonts] ${fam.dir}: could not fetch (${err.message}). ` +
        `Falling back to the system sans-serif stack.`,
    );
  }
}

process.exit(0); // best-effort: never fail the build
