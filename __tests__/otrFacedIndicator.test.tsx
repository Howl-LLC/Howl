// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

import { OtrFacedIndicator } from '../components/OtrFacedIndicator';

describe('OtrFacedIndicator', () => {
  it('calls onToggle on click and exposes aria-pressed=false when not active', () => {
    const onToggle = vi.fn();
    render(<OtrFacedIndicator active={false} onToggle={onToggle} />);
    const btn = screen.getByRole('button', { name: 'Off the Record' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('shows the "Off the Record" tag and aria-pressed=true only when active', () => {
    const { rerender } = render(<OtrFacedIndicator active={false} onToggle={() => {}} />);
    expect(screen.queryByText('Off the Record')).not.toBeInTheDocument();
    rerender(<OtrFacedIndicator active onToggle={() => {}} />);
    expect(screen.getByText('Off the Record')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('aria-pressed', 'true');
  });
});
