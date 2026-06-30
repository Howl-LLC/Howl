// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { DropdownSheet } from '../../../components/ui/dropdown-sheet';

describe('<DropdownSheet />', () => {
  it('renders children when open', () => {
    render(
      <DropdownSheet isOpen onClose={() => {}}>
        <div>hello sheet</div>
      </DropdownSheet>
    );
    expect(screen.getByText('hello sheet')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <DropdownSheet isOpen={false} onClose={() => {}}>
        <div>hidden</div>
      </DropdownSheet>
    );
    expect(screen.queryByText('hidden')).not.toBeInTheDocument();
  });

  it('closes when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(
      <DropdownSheet isOpen onClose={onClose}>
        <div>content</div>
      </DropdownSheet>
    );
    const backdrop = screen.getByLabelText('Close');
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes on Escape key', () => {
    const onClose = vi.fn();
    render(
      <DropdownSheet isOpen onClose={onClose}>
        <div>content</div>
      </DropdownSheet>
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
