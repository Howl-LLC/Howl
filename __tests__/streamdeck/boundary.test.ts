// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const FORBIDDEN_PATTERNS = [
  /dm(?:Crypto|KeyManager)/,
  /dmEncryption/,
  /fileCrypto/,
  /channelKey/,
  /encryptReaction/,
  /privateKey/,
];

function walk(dir: string, files: string[] = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && /\.(js|cjs|mjs)$/.test(entry.name)) files.push(full);
  }
  return files;
}

describe('streamdeck/boundary — source-level scan', () => {
  it('no bridge source file imports forbidden modules', () => {
    const root = path.resolve(__dirname, '../../electron/streamdeck');
    const files = walk(root);
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const f of files) {
      if (f.endsWith('bip39-english.js')) continue;
      const src = fs.readFileSync(f, 'utf8');
      for (const re of FORBIDDEN_PATTERNS) {
        if (re.test(src)) offenders.push(`${f} matched ${re}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
