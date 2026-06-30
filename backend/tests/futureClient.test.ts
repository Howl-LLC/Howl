// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as schemas from '../src/socketSchemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = resolve(__dirname, 'fixtures/protocol-v1');

describe('future-client tolerance', () => {
  it('every socket schema tolerates extra unknown fields (except signedVoiceJoinBlob)', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      if (name === 'signedVoiceJoinBlob') continue; // intentionally .strict()
      if (typeof (schema as { safeParse?: unknown }).safeParse !== 'function') continue;

      const fixturePath = resolve(FIXTURE_DIR, `${name}.json`);
      if (!existsSync(fixturePath)) continue; // no fixture -> skip

      const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
      const withExtra = { ...(fixture as object), __futureField: 'hello', __nestedFuture: { x: 1 } };
      const result = (schema as { safeParse: (d: unknown) => { success: boolean } }).safeParse(withExtra);
      expect(result.success, `Schema ${name} rejected unknown fields — did someone reintroduce .strict()?`).toBe(true);
    }
  });
});
