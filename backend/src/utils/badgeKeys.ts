// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Canonical badge taxonomy AND default display order (single source of truth).
 * This ordered list is both the Zod enum source (schemas.ts) and the cosmetic
 * default order applied when a user has no `order` preference (utils/badges.ts).
 *
 * Kept in this dependency-free leaf module so `schemas.ts` can import the enum
 * without pulling in `utils/badges.ts` -> `utils.ts` -> `utils/permissions.ts`,
 * which imports back from `schemas.ts` (a module-init cycle).
 */
export const BADGE_KEYS = [
  'staff', 'verified', 'pro', 'pro_essential', 'beta', 'bug_hunter', 'early_supporter',
] as const;
