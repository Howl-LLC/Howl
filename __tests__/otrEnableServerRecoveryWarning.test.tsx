// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Client warning + local teardown before enabling Server recovery.
 *
 * Tests `withOtrServerRecoveryGuard` directly (cleaner than rendering the two
 * modals). The guard:
 *   - if local OTR channels exist, asks window.confirm (explicit ack);
 *   - on cancel, returns false and does NOT enable / tear down;
 *   - on confirm, runs enable() then best-effort ends each OTR group;
 *   - if no OTR channels exist, never prompts and just runs enable().
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const listOtrChannels = vi.fn<() => Promise<string[]>>();
const endOtrGroup = vi.fn<(id: string) => Promise<void>>();

vi.mock('../services/mls/mlsCoordinator', () => ({
  listOtrChannels: () => listOtrChannels(),
  endOtrGroup: (id: string) => endOtrGroup(id),
}));

import { withOtrServerRecoveryGuard } from '../utils/otrServerRecoveryGuard';

describe('withOtrServerRecoveryGuard', () => {
  let confirmSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    listOtrChannels.mockReset();
    endOtrGroup.mockReset().mockResolvedValue(undefined);
    confirmSpy = vi.spyOn(window, 'confirm');
  });

  afterEach(() => {
    confirmSpy.mockRestore();
  });

  it('cancels: 2 OTR channels + confirm→false → returns false, does not enable or tear down', async () => {
    listOtrChannels.mockResolvedValue(['ch-1', 'ch-2']);
    confirmSpy.mockReturnValue(false);
    const enable = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const proceed = await withOtrServerRecoveryGuard(enable);

    expect(proceed).toBe(false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(enable).not.toHaveBeenCalled();
    expect(endOtrGroup).not.toHaveBeenCalled();
  });

  it('confirms: 2 OTR channels + confirm→true → returns true, enables once, ends each channel', async () => {
    listOtrChannels.mockResolvedValue(['ch-1', 'ch-2']);
    confirmSpy.mockReturnValue(true);
    const enable = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const proceed = await withOtrServerRecoveryGuard(enable);

    expect(proceed).toBe(true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(enable).toHaveBeenCalledTimes(1);
    expect(endOtrGroup).toHaveBeenCalledTimes(2);
    expect(endOtrGroup).toHaveBeenCalledWith('ch-1');
    expect(endOtrGroup).toHaveBeenCalledWith('ch-2');
  });

  it('no OTR: empty list → never prompts, enables, returns true', async () => {
    listOtrChannels.mockResolvedValue([]);
    const enable = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    const proceed = await withOtrServerRecoveryGuard(enable);

    expect(proceed).toBe(true);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(enable).toHaveBeenCalledTimes(1);
    expect(endOtrGroup).not.toHaveBeenCalled();
  });
});
