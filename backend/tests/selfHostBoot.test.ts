// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.ts'), 'utf8');

describe('self-host boot guards', () => {
  it('LiveKit hard-fail guards are skipped under self-host', () => {
    // The LiveKit secret/key fatal guards must be wrapped so they do not run
    // when SELF_HOST is enabled (voice is bring-your-own and optional).
    const block = serverSrc.slice(serverSrc.indexOf('LIVEKIT_API_SECRET ||'), serverSrc.indexOf('LIVEKIT_API_KEY must be set') + 200);
    expect(serverSrc).toContain("process.env.SELF_HOST !== 'true'");
    // The guards still reject the insecure defaults for non-self-host.
    expect(block).toContain("=== 'secret'");
  });
});
