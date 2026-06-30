// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { evaluateConditions, type EvaluationContext } from '../src/utils/conditionEvaluator';

const NOW = new Date('2026-05-03T00:00:00Z');

const baseCtx: EvaluationContext = {
  now: NOW,
  userCreatedAt: new Date('2026-01-01T00:00:00Z'), // 122 days
  memberJoinedAt: new Date('2026-04-01T00:00:00Z'), // 32 days
  userRoleIds: new Set(['role-a', 'role-b']),
  messageCount: 25,
};

describe('evaluateConditions', () => {
  it('returns ok when no conditions', () => {
    expect(evaluateConditions(null, baseCtx)).toEqual({ ok: true });
    expect(evaluateConditions({}, baseCtx)).toEqual({ ok: true });
  });

  it('account age — pass', () => {
    expect(evaluateConditions({ accountAgeDays: 30 }, baseCtx)).toEqual({ ok: true });
  });

  it('account age — fail', () => {
    const r = evaluateConditions({ accountAgeDays: 200 }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed[0]).toMatchObject({ kind: 'accountAge', current: 122, required: 200 });
  });

  it('server tenure — pass / fail', () => {
    expect(evaluateConditions({ tenureDays: 30 }, baseCtx)).toEqual({ ok: true });
    const fail = evaluateConditions({ tenureDays: 60 }, baseCtx);
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.failed[0]).toMatchObject({ kind: 'tenure', current: 32, required: 60 });
  });

  it('has-another-role — pass when all required held', () => {
    expect(evaluateConditions({ hasRoleIds: ['role-a'] }, baseCtx)).toEqual({ ok: true });
    expect(evaluateConditions({ hasRoleIds: ['role-a', 'role-b'] }, baseCtx)).toEqual({ ok: true });
  });

  it('has-another-role — fail when one missing', () => {
    const r = evaluateConditions({ hasRoleIds: ['role-a', 'role-c'] }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed[0]).toMatchObject({ kind: 'hasRole', missing: ['role-c'] });
  });

  it('message count — pass / fail', () => {
    expect(evaluateConditions({ messageCount: 10 }, baseCtx)).toEqual({ ok: true });
    const fail = evaluateConditions({ messageCount: 100 }, baseCtx);
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.failed[0]).toMatchObject({ kind: 'messageCount', current: 25, required: 100 });
  });

  it('manual approval short-circuits — never resolves to ok via evaluator', () => {
    const r = evaluateConditions({ manualApproval: true }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed[0]).toMatchObject({ kind: 'manualApproval' });
  });

  it('AND semantics — all conditions must pass', () => {
    const r = evaluateConditions(
      { tenureDays: 7, messageCount: 100 },
      baseCtx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed.map(f => f.kind)).toEqual(['messageCount']);
  });

  it('reports multiple failures', () => {
    const r = evaluateConditions(
      { accountAgeDays: 500, tenureDays: 100 },
      baseCtx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed.map(f => f.kind).sort()).toEqual(['accountAge', 'tenure']);
  });

  it('excludeRoleIds — fails with excludedRole when holder has an excluded role', () => {
    const r = evaluateConditions({ excludeRoleIds: ['role-a', 'role-c'] }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.failed).toContainEqual({ kind: 'excludedRole', present: ['role-a'] });
  });

  it('excludeRoleIds — passes when holder has none of the excluded roles', () => {
    expect(evaluateConditions({ excludeRoleIds: ['role-c', 'role-d'] }, baseCtx).ok).toBe(true);
  });

  it('excludeRoleIds — composes with hasRoleIds (both can fail)', () => {
    const r = evaluateConditions({ hasRoleIds: ['need'], excludeRoleIds: ['role-a'] }, baseCtx);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.failed).toContainEqual({ kind: 'hasRole', missing: ['need'] });
      expect(r.failed).toContainEqual({ kind: 'excludedRole', present: ['role-a'] });
    }
  });
});
