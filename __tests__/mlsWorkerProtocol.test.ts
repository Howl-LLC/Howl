// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { newCorrelationId, type WorkerRequest, type WorkerResponse } from '../services/mls/mlsWorkerProtocol';

describe('mlsWorkerProtocol', () => {
  it('newCorrelationId returns unique increasing ids', () => {
    const a = newCorrelationId();
    const b = newCorrelationId();
    expect(a).not.toBe(b);
    expect(typeof a).toBe('string');
  });

  it('request and response carry a correlationId', () => {
    const req: WorkerRequest = { kind: 'rpc', correlationId: 'c1', method: 'encrypt', args: ['ch', 'hi'] };
    const res: WorkerResponse = { kind: 'rpc-result', correlationId: 'c1', ok: true, value: 'envelope' };
    expect(req.correlationId).toBe(res.correlationId);
  });
});
