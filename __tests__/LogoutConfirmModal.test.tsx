// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LogoutConfirmModal from '../components/LogoutConfirmModal';
import * as dmKeyManager from '../services/dmKeyManager';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: string) => d || k }) }));

vi.mock('../services/dmKeyManager', () => ({
  isRememberedOnDevice: vi.fn(),
}));

const isRememberedOnDevice = dmKeyManager.isRememberedOnDevice as unknown as ReturnType<typeof vi.fn>;

// A deferred promise so the test controls exactly when the probe settles.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const getLogoutButton = () => screen.getByRole('button', { name: 'Log Out' });

describe('LogoutConfirmModal - disables Log Out until the remember-on-device probe resolves', () => {
  beforeEach(() => {
    isRememberedOnDevice.mockReset();
  });

  it('disables Log Out and does not call onConfirm while the probe is pending', () => {
    const d = deferred<boolean>();
    isRememberedOnDevice.mockReturnValue(d.promise);
    const onConfirm = vi.fn();

    render(<LogoutConfirmModal onConfirm={onConfirm} onCancel={() => {}} />);

    const button = getLogoutButton();
    expect(button).toBeDisabled();

    // A disabled button does not fire onClick; clicking must be a no-op.
    fireEvent.click(button);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('enables Log Out, reflects keepKeys=true, and calls onConfirm(true) once the probe resolves true', async () => {
    const d = deferred<boolean>();
    isRememberedOnDevice.mockReturnValue(d.promise);
    const onConfirm = vi.fn();

    render(<LogoutConfirmModal onConfirm={onConfirm} onCancel={() => {}} />);

    d.resolve(true);

    await waitFor(() => expect(getLogoutButton()).toBeEnabled());

    // The toggle reflects the remembered state.
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(getLogoutButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('calls onConfirm(false) when the probe resolves false', async () => {
    const d = deferred<boolean>();
    isRememberedOnDevice.mockReturnValue(d.promise);
    const onConfirm = vi.fn();

    render(<LogoutConfirmModal onConfirm={onConfirm} onCancel={() => {}} />);

    d.resolve(false);

    await waitFor(() => expect(getLogoutButton()).toBeEnabled());
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(getLogoutButton());
    expect(onConfirm).toHaveBeenCalledWith(false);
  });

  it('still enables Log Out (not wedged) when the probe rejects, defaulting to onConfirm(false)', async () => {
    const d = deferred<boolean>();
    isRememberedOnDevice.mockReturnValue(d.promise);
    const onConfirm = vi.fn();

    render(<LogoutConfirmModal onConfirm={onConfirm} onCancel={() => {}} />);

    d.reject(new Error('probe failed'));

    await waitFor(() => expect(getLogoutButton()).toBeEnabled());

    fireEvent.click(getLogoutButton());
    expect(onConfirm).toHaveBeenCalledWith(false);
  });
});
