// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import * as mlsCoordinator from '../services/mls/mlsCoordinator';

/**
 * Warn + tear down local OTR before enabling Server recovery.
 *
 * Enabling Server recovery makes the user OTR-ineligible, so the SERVER
 * auto-ends their OTR groups. The acknowledgment must be explicit, never
 * silent: the client warns the user first if they have active local OTR
 * chats, then best-effort tears down the local OTR group state.
 *
 * Returns true to proceed (no OTR, or the user confirmed), false if the user
 * cancelled. On proceed, runs `enable()` then best-effort ends each local OTR
 * group (the server also deletes the rows and emits otr-ended to our other
 * devices + the counterparties).
 *
 * Uses window.confirm for the acknowledgment; a styled modal can replace it.
 */
export async function withOtrServerRecoveryGuard(enable: () => Promise<void>): Promise<boolean> {
  const otrChannels = await mlsCoordinator.listOtrChannels();
  if (otrChannels.length > 0) {
    const ok = window.confirm(
      `Enabling Server recovery will end your ${otrChannels.length} Off the Record chat(s). ` +
        `The other person will see them close. Continue?`,
    );
    if (!ok) return false;
  }
  await enable();
  for (const id of otrChannels) {
    try {
      await mlsCoordinator.endOtrGroup(id);
    } catch {
      /* best-effort */
    }
  }
  return true;
}
