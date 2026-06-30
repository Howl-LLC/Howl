// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const pf = await import('../../electron/streamdeck/port-file.js').then((m) => m.default ?? m);

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'howl-sdpf-'));
});

describe('streamdeck/port-file', () => {
  it('writes, reads, and deletes', () => {
    pf.write(tmpDir, { port: 12345, installId: 'abc', version: '1.0.3' });
    expect(pf.read(tmpDir)).toEqual({ port: 12345, installId: 'abc', version: '1.0.3' });
    pf.remove(tmpDir);
    expect(pf.read(tmpDir)).toBeNull();
  });

  it('removes stale file on init before writing', () => {
    fs.writeFileSync(path.join(tmpDir, 'streamdeck-bridge.json'), '{"port":9999}', 'utf8');
    pf.removeStale(tmpDir);
    expect(pf.read(tmpDir)).toBeNull();
  });

  it('read returns null on missing file', () => {
    expect(pf.read(tmpDir)).toBeNull();
  });

  it('read returns null on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, 'streamdeck-bridge.json'), 'not json', 'utf8');
    expect(pf.read(tmpDir)).toBeNull();
  });
});
