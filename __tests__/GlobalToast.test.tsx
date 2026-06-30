// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import GlobalToast from '../components/GlobalToast';

describe('GlobalToast', () => {
  it('renders the message text', () => {
    render(<GlobalToast id="1" message="Hello world" type="info" onDismiss={() => {}} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
  });

  it('calls onDismiss when the close button is clicked', () => {
    const onDismiss = vi.fn();
    render(<GlobalToast id="1" message="Dismissable" type="info" onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('renders with warning styling when type is warning', () => {
    const { container } = render(
      <GlobalToast id="1" message="Warning!" type="warning" onDismiss={() => {}} />,
    );
    const toast = container.firstElementChild as HTMLElement;
    expect(toast.style.borderColor).toBe('var(--warning-subtle)');
  });

  it('renders with info styling when type is info', () => {
    const { container } = render(
      <GlobalToast id="1" message="Info" type="info" onDismiss={() => {}} />,
    );
    const toast = container.firstElementChild as HTMLElement;
    expect(toast.style.borderColor).toBe('var(--glass-border)');
  });
});
