// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FORBIDDEN = ['../encryptionFlags', '../api', './mlsClient', '../socket'];
const WORKER_SCOPE_FILES = [
  'services/mls/mlsWorker.ts',
  'services/mls/mlsWorkerHost.ts',
  'services/mls/mlsCoordinatorCore.ts',
];

describe('worker-scope import guard', () => {
  for (const f of WORKER_SCOPE_FILES) {
    it(`${f} does not import any main-thread-only module`, () => {
      const src = readFileSync(resolve(process.cwd(), f), 'utf8');
      for (const mod of FORBIDDEN) {
        expect(src.includes(`from '${mod}'`), `${f} must not import ${mod} (breaks/silently-fails in SharedWorker scope)`).toBe(false);
      }
    });
  }
});
