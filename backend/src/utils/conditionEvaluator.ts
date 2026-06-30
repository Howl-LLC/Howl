// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Pure-function evaluator for self-role claim conditions.
 *
 * The 5 condition types map to JSON keys on RolePickerEntry.requirements.
 * Each is independently optional. All checked conditions must pass (AND).
 *
 * Manual approval is a sentinel — when set, this evaluator always returns
 * a `manualApproval` failure. The caller (claim route) is responsible for
 * routing to the approval queue *before* calling the evaluator. The
 * sentinel exists so we can also surface "this role needs approval" in
 * the user picker view via the same code path.
 */

export interface ConditionRequirements {
  /** Howl account is at least N days old. */
  accountAgeDays?: number;
  /** Member of this server for at least N days. */
  tenureDays?: number;
  /** Already holds all of these role IDs. */
  hasRoleIds?: string[];
  /** Holds none of these role IDs (exclusion gate). */
  excludeRoleIds?: string[];
  /** Sent at least N messages in this server. */
  messageCount?: number;
  /** Manual approval gate. */
  manualApproval?: boolean;
}

export interface EvaluationContext {
  now: Date;
  userCreatedAt: Date;
  memberJoinedAt: Date;
  /** All role IDs the user currently holds in this server (excl. @everyone). */
  userRoleIds: Set<string>;
  /** Cached message count for this user in this server. */
  messageCount: number;
}

export type ConditionFailure =
  | { kind: 'accountAge'; current: number; required: number }
  | { kind: 'tenure'; current: number; required: number }
  | { kind: 'hasRole'; missing: string[] }
  | { kind: 'excludedRole'; present: string[] }
  | { kind: 'messageCount'; current: number; required: number }
  | { kind: 'manualApproval' };

export type EvaluationResult =
  | { ok: true }
  | { ok: false; failed: ConditionFailure[] };

const MS_PER_DAY = 86_400_000;

function daysBetween(a: Date, b: Date): number {
  return Math.floor((a.getTime() - b.getTime()) / MS_PER_DAY);
}

export function evaluateConditions(
  req: ConditionRequirements | null | undefined,
  ctx: EvaluationContext,
): EvaluationResult {
  if (!req) return { ok: true };
  const failed: ConditionFailure[] = [];

  if (typeof req.accountAgeDays === 'number') {
    const current = daysBetween(ctx.now, ctx.userCreatedAt);
    if (current < req.accountAgeDays) {
      failed.push({ kind: 'accountAge', current, required: req.accountAgeDays });
    }
  }

  if (typeof req.tenureDays === 'number') {
    const current = daysBetween(ctx.now, ctx.memberJoinedAt);
    if (current < req.tenureDays) {
      failed.push({ kind: 'tenure', current, required: req.tenureDays });
    }
  }

  if (Array.isArray(req.hasRoleIds) && req.hasRoleIds.length > 0) {
    const missing = req.hasRoleIds.filter((id) => !ctx.userRoleIds.has(id));
    if (missing.length > 0) failed.push({ kind: 'hasRole', missing });
  }

  if (Array.isArray(req.excludeRoleIds) && req.excludeRoleIds.length > 0) {
    const present = req.excludeRoleIds.filter((id) => ctx.userRoleIds.has(id));
    if (present.length > 0) failed.push({ kind: 'excludedRole', present });
  }

  if (typeof req.messageCount === 'number') {
    if (ctx.messageCount < req.messageCount) {
      failed.push({ kind: 'messageCount', current: ctx.messageCount, required: req.messageCount });
    }
  }

  if (req.manualApproval === true) {
    failed.push({ kind: 'manualApproval' });
  }

  return failed.length === 0 ? { ok: true } : { ok: false, failed };
}
