// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Package the Stream Deck plugin into a .streamDeckPlugin file.
 *
 * The .streamDeckPlugin format is a renamed .zip archive containing the
 * contents of the com.howlpro.streamdeck.sdPlugin directory.
 *
 * Usage: node scripts/package.js
 * Output: com.howlpro.streamdeck.streamDeckPlugin (in the streamdeck-plugin dir)
 */

import { execSync } from 'node:child_process';
import { existsSync, unlinkSync, readdirSync, statSync, readFileSync, createWriteStream } from 'node:fs';
import { resolve, dirname, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');
const sdPluginDir = resolve(root, 'com.howlpro.streamdeck.sdPlugin');
const outFile = resolve(root, 'com.howlpro.streamdeck.streamDeckPlugin');

// Pre-flight checks
if (!existsSync(resolve(sdPluginDir, 'bin', 'plugin.js'))) {
  console.error('Error: bin/plugin.js not found. Run `npm run build` first.');
  process.exit(1);
}

if (!existsSync(resolve(sdPluginDir, 'manifest.json'))) {
  console.error('Error: manifest.json not found in sdPlugin directory.');
  process.exit(1);
}

// Validate manifest before packaging
console.log('Running validation...');
try {
  execSync('node scripts/validate.js', { cwd: root, stdio: 'inherit' });
} catch {
  console.error('Validation failed. Fix the issues above before packaging.');
  process.exit(1);
}

if (existsSync(outFile)) {
  unlinkSync(outFile);
}

// Use tar on *nix / PowerShell Compress-Archive on Windows.
const platform = process.platform;
console.log('\nCreating .streamDeckPlugin archive...');

if (platform === 'win32') {
  // Create a zip, then rename to .streamDeckPlugin
  const zipFile = outFile.replace(/\.streamDeckPlugin$/, '.zip');
  if (existsSync(zipFile)) unlinkSync(zipFile);
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${sdPluginDir}\\*' -DestinationPath '${zipFile}' -Force"`,
    { cwd: root, stdio: 'inherit' },
  );
  execSync(
    `powershell -NoProfile -Command "Rename-Item -Path '${zipFile}' -NewName '${outFile}'"`,
    { cwd: root, stdio: 'inherit' },
  );
} else {
  execSync(
    `cd "${sdPluginDir}" && zip -r "${outFile}" .`,
    { cwd: root, stdio: 'inherit' },
  );
}

// Report size
try {
  const stats = statSync(outFile);
  const sizeKB = (stats.size / 1024).toFixed(1);
  console.log(`\nPackaged: ${outFile}`);
  console.log(`Size: ${sizeKB} KB`);
} catch {
  console.log(`\nPackaged: ${outFile}`);
}
