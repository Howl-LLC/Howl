// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BluetoothQualityBanner } from '../../components/audio/BluetoothQualityBanner';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, opts?: Record<string, unknown>) => {
    if (opts && opts.deviceName) return `${k}:${opts.deviceName}`;
    return k;
  } }),
}));

describe('BluetoothQualityBanner — action variant', () => {
  it('renders title and body', () => {
    render(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel="Built-in Microphone"
        variant="action"
        onSplit={() => {}}
        onDismiss={() => {}}
        onRemember={() => {}}
      />,
    );
    expect(screen.getByText('bluetoothQuality.banner.title')).toBeInTheDocument();
    expect(screen.getByText('bluetoothQuality.banner.body')).toBeInTheDocument();
  });

  it('calls onSplit when the action button is clicked', () => {
    const onSplit = vi.fn();
    render(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel="Built-in Microphone"
        variant="action"
        onSplit={onSplit}
        onDismiss={() => {}}
        onRemember={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /fixAction/ }));
    expect(onSplit).toHaveBeenCalledTimes(1);
  });

  it('calls onDismiss when the dismiss button is clicked', () => {
    const onDismiss = vi.fn();
    render(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel="Built-in Microphone"
        variant="action"
        onSplit={() => {}}
        onDismiss={onDismiss}
        onRemember={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /dismissAction/ }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('remember checkbox is disabled until splitApplied is true', () => {
    const onRemember = vi.fn();
    const onSplit = vi.fn();
    const { rerender } = render(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel="Built-in Microphone"
        variant="action"
        onSplit={onSplit}
        onDismiss={() => {}}
        onRemember={onRemember}
      />,
    );
    const cb = screen.getByRole('checkbox');
    expect(cb).toBeDisabled();
    rerender(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel="Built-in Microphone"
        variant="action"
        onSplit={onSplit}
        onDismiss={() => {}}
        onRemember={onRemember}
        splitApplied
      />,
    );
    expect(screen.getByRole('checkbox')).not.toBeDisabled();
  });

  it('calls onRemember when the checkbox is clicked (after split applied)', () => {
    const onRemember = vi.fn();
    render(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel="Built-in Microphone"
        variant="action"
        onSplit={() => {}}
        onDismiss={() => {}}
        onRemember={onRemember}
        splitApplied
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onRemember).toHaveBeenCalledTimes(1);
  });
});

describe('BluetoothQualityBanner — guidance variant', () => {
  it('renders guidance text and got-it button without the action button', () => {
    render(
      <BluetoothQualityBanner
        deviceLabel="AirPods Pro"
        candidateLabel={null}
        variant="guidance-ios"
        onSplit={() => {}}
        onDismiss={() => {}}
        onRemember={() => {}}
      />,
    );
    expect(screen.getByText('bluetoothQuality.banner.iosGuidance')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gotIt/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fixAction/ })).toBeNull();
  });

  it('renders android fallback text', () => {
    render(
      <BluetoothQualityBanner
        deviceLabel="Pixel Buds"
        candidateLabel={null}
        variant="guidance-android"
        onSplit={() => {}}
        onDismiss={() => {}}
        onRemember={() => {}}
      />,
    );
    expect(screen.getByText('bluetoothQuality.banner.androidFallback')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /gotIt/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /fixAction/ })).toBeNull();
  });
});
