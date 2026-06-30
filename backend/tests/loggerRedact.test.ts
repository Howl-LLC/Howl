// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Regression test for Pino `redact.paths`.
 *
 * Construct a fresh pino instance using the same `REDACT_PATHS` the real
 * logger registers, pipe its output to an in-memory buffer, and assert
 * sensitive field values never appear in the serialized JSON.
 *
 * Runs in-process — no Postgres / Redis / infra.
 */

import { describe, it, expect } from 'vitest';
import pino from 'pino';
import { Writable } from 'node:stream';
import { REDACT_PATHS } from '../src/logger.js';

function makeCapturingLogger(): { log: pino.Logger; read: () => string } {
  let buf = '';
  const sink = new Writable({
    write(chunk, _enc, cb) { buf += chunk.toString('utf8'); cb(); },
  });
  const log = pino({ redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' } }, sink);
  return { log, read: () => buf };
}

const sensitiveFields = [
  { field: 'to', value: 'alice@example.com' },
  { field: 'code', value: '123456' },
  { field: 'phone', value: '+15551234567' },
  { field: 'newEmail', value: 'bob@example.com' },
  { field: 'revokeUrl', value: 'https://howl.example/revoke?token=abc' },
  { field: 'revertUrl', value: 'https://howl.example/revert?token=xyz' },
  { field: 'ipMasked', value: '203.0.113.***' },
];

describe('Pino redact covers email-worker sensitive fields', () => {
  for (const { field, value } of sensitiveFields) {
    it(`redacts \`${field}\` at the top level`, () => {
      const { log, read } = makeCapturingLogger();
      log.info({ [field]: value, jobId: 'job-1' }, 'email sent');
      const out = read();
      expect(out).not.toContain(value);
      expect(out).toContain('[REDACTED]');
    });

    it(`redacts \`${field}\` under a single-level nested object (*.${field})`, () => {
      const { log, read } = makeCapturingLogger();
      log.info({ job: { [field]: value }, jobId: 'job-1' }, 'email sent');
      expect(read()).not.toContain(value);
    });

    it(`redacts \`data.${field}\` (BullMQ job.data shape)`, () => {
      const { log, read } = makeCapturingLogger();
      log.info({ data: { [field]: value }, jobId: 'job-1' }, 'DEAD_LETTER');
      expect(read()).not.toContain(value);
    });
  }

  it('still redacts the prior field set (regression guard)', () => {
    const { log, read } = makeCapturingLogger();
    log.info({
      email: 'u@example.com',
      password: 'hunter2',
      token: 'eyJhbGciOi...',
      mfaTotpSecret: 'JBSWY3DPEHPK3PXP',
      ip: '203.0.113.42',
    }, 'legacy fields');
    const out = read();
    expect(out).not.toContain('u@example.com');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('eyJhbGciOi...');
    expect(out).not.toContain('JBSWY3DPEHPK3PXP');
    expect(out).not.toContain('203.0.113.42');
  });

  it('does NOT censor non-sensitive sibling fields (jobId, msg)', () => {
    const { log, read } = makeCapturingLogger();
    log.info({ jobId: 'job-abc', to: 'alice@example.com' }, 'email sent');
    const out = read();
    expect(out).toContain('job-abc'); // triage field survives
    expect(out).toContain('email sent'); // message survives
    expect(out).not.toContain('alice@example.com');
  });
});
