// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BluetoothQualityBadge } from '../../components/audio/BluetoothQualityBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

describe('BluetoothQualityBadge', () => {
  it('renders green dot for tier=good', () => {
    const { container } = render(<BluetoothQualityBadge tier="good" isHdBluetooth={false} />);
    const dot = container.querySelector('[data-tier="good"]');
    expect(dot).not.toBeNull();
  });

  it('renders yellow dot for tier=medium', () => {
    const { container } = render(<BluetoothQualityBadge tier="medium" isHdBluetooth={false} />);
    const dot = container.querySelector('[data-tier="medium"]');
    expect(dot).not.toBeNull();
  });

  it('renders red dot for tier=bad', () => {
    const { container } = render(<BluetoothQualityBadge tier="bad" isHdBluetooth={false} />);
    const dot = container.querySelector('[data-tier="bad"]');
    expect(dot).not.toBeNull();
  });

  it('shows "HD Bluetooth" label when isHdBluetooth is true', () => {
    render(<BluetoothQualityBadge tier="good" isHdBluetooth={true} />);
    expect(screen.getByText('bluetoothQuality.badge.hdBluetooth')).toBeInTheDocument();
  });

  it('sets aria-label from the tier key', () => {
    render(<BluetoothQualityBadge tier="bad" isHdBluetooth={false} />);
    const el = screen.getByLabelText('bluetoothQuality.badge.bad');
    expect(el).toBeInTheDocument();
  });
});
