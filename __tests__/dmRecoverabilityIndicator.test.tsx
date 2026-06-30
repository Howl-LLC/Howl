// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

import { DmRecoverabilityIndicator } from '../components/DmRecoverabilityIndicator';

const noop = () => {};

describe('DmRecoverabilityIndicator', () => {
  it('private: shows the Private chip and, on open, the private body + OTR nudge (no self-fix)', () => {
    const onGoOtr = vi.fn();
    render(<DmRecoverabilityIndicator state="private" peerName="alice" onGoOtr={onGoOtr} onOpenRecoverySettings={noop} />);
    const chip = screen.getByRole('button', { name: 'Private' });
    fireEvent.click(chip);
    expect(screen.getByText(/unable to be recovered by anybody/)).toBeInTheDocument();
    const otr = screen.getByRole('button', { name: 'Go Off the Record' });
    expect(screen.queryByRole('button', { name: 'Switch to Self recovery' })).not.toBeInTheDocument();
    fireEvent.click(otr);
    expect(onGoOtr).toHaveBeenCalledTimes(1);
  });

  it('recoverable-self: shows Recoverable chip and, on open, the server body + self-fix link (no OTR nudge)', () => {
    const onOpenRecoverySettings = vi.fn();
    render(<DmRecoverabilityIndicator state="recoverable-self" peerName="alice" onGoOtr={noop} onOpenRecoverySettings={onOpenRecoverySettings} />);
    const chip = screen.getByRole('button', { name: 'Recoverable' });
    fireEvent.click(chip);
    expect(screen.getByText(/able to be recovered from Howl/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go Off the Record' })).not.toBeInTheDocument();
    const fix = screen.getByRole('button', { name: 'Switch to Self recovery' });
    fireEvent.click(fix);
    expect(onOpenRecoverySettings).toHaveBeenCalledTimes(1);
  });

  it('recoverable-peer: shows the server body only (no actions)', () => {
    render(<DmRecoverabilityIndicator state="recoverable-peer" peerName="alice" onGoOtr={noop} onOpenRecoverySettings={noop} />);
    fireEvent.click(screen.getByRole('button', { name: 'Recoverable' }));
    expect(screen.getByText(/able to be recovered from Howl/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go Off the Record' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch to Self recovery' })).not.toBeInTheDocument();
  });
});
