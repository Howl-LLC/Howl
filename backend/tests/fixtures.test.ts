// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import * as schemas from '../src/socketSchemas.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const FIXTURE_DIR = resolve(__dirname, 'fixtures/protocol-v1');

describe('protocol v1 fixtures round-trip through current schemas', () => {
  const files = readdirSync(FIXTURE_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const schemaName = file.replace('.json', '');
    it(`${schemaName} fixture passes current schema`, () => {
      const schema = (schemas as Record<string, { safeParse: (d: unknown) => { success: boolean; error?: unknown } }>)[schemaName];
      expect(schema, `Schema ${schemaName} not exported from socketSchemas.ts — rename the fixture or add the export`).toBeTruthy();
      const fixture = JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf8'));
      const result = schema.safeParse(fixture);
      expect(result.success, `Fixture ${file} failed schema: ${JSON.stringify(result.error)}`).toBe(true);
    });
  }

  it('every exported socket schema has a matching fixture (except the nested signed .strict() blobs)', () => {
    const schemaNames = Object.entries(schemas)
      .filter(([name, val]) => {
        if (name === 'signedVoiceJoinBlob' || name === 'stageHostBlob') return false; // nested signed blobs, intentionally .strict()
        return typeof (val as { safeParse?: unknown }).safeParse === 'function';
      })
      .map(([name]) => name)
      .sort();
    const fixtureNames = readdirSync(FIXTURE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''))
      .sort();
    expect(fixtureNames, 'Every exported socket schema must have a matching fixture file in backend/tests/fixtures/protocol-v1/. Missing or extra fixture filenames listed below.').toEqual(schemaNames);
  });
});
