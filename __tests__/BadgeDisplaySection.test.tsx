// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { BadgeDisplaySection, orderedEarned } from '../components/settings/BadgeDisplaySection';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));

describe('orderedEarned', () => {
  it('orders by saved order first, then canonical default', () => {
    expect(orderedEarned(['pro', 'staff', 'beta'], ['beta'])).toEqual(['beta', 'staff', 'pro']);
  });
  it('appends earned-but-unordered keys in canonical default order', () => {
    expect(orderedEarned(['staff', 'verified'], ['verified'])).toEqual(['verified', 'staff']);
  });
});

describe('BadgeDisplaySection', () => {
  it('shows the empty message when no badges are earned', () => {
    render(<BadgeDisplaySection earned={[]} value={{ hidden: [], order: [] }} disabled={false} onChange={() => {}} />);
    expect(screen.getByText("You haven't earned any badges yet.")).toBeInTheDocument();
  });

  it('hides a badge when its toggle is turned off', () => {
    const onChange = vi.fn();
    render(<BadgeDisplaySection earned={['staff', 'beta']} value={{ hidden: [], order: [] }} disabled={false} onChange={onChange} />);
    // Rows render in canonical default order: staff first.
    const toggles = screen.getAllByRole('switch');
    fireEvent.click(toggles[0]);
    expect(onChange).toHaveBeenCalledWith({ hidden: ['staff'], order: [] });
  });

  it('re-shows a hidden badge when toggled back on', () => {
    const onChange = vi.fn();
    render(<BadgeDisplaySection earned={['staff', 'beta']} value={{ hidden: ['staff'], order: [] }} disabled={false} onChange={onChange} />);
    const toggles = screen.getAllByRole('switch');
    fireEvent.click(toggles[0]);
    expect(onChange).toHaveBeenCalledWith({ hidden: [], order: [] });
  });
});
