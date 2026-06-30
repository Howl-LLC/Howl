// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LetterAvatar } from '../components/LetterAvatar';

describe('LetterAvatar', () => {
  it('renders the first letter of the username when no custom avatar', () => {
    render(<LetterAvatar username="Alice" size={40} />);
    expect(screen.getByText('A')).toBeInTheDocument();
  });

  it('renders an img element when a custom avatar URL is provided', () => {
    render(<LetterAvatar username="Bob" avatar="https://example.com/bob.png" size={40} />);
    const img = screen.getByRole('img');
    expect(img).toHaveAttribute('alt', 'Bob');
  });

  it('falls back to letter avatar for the default avatar path', () => {
    render(<LetterAvatar username="Carol" avatar="/default-avatar.svg" size={40} />);
    expect(screen.getByText('C')).toBeInTheDocument();
  });

  it('applies the given size', () => {
    const { container } = render(<LetterAvatar username="Dan" size={64} />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.style.width).toBe('64px');
    expect(el.style.height).toBe('64px');
  });

  it('fills parent when size is not specified', () => {
    const { container } = render(<LetterAvatar username="Eve" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.classList.contains('w-full')).toBe(true);
    expect(el.classList.contains('h-full')).toBe(true);
  });

  it('produces deterministic colors for the same username', () => {
    const { container: c1 } = render(<LetterAvatar username="Frank" size={32} />);
    const { container: c2 } = render(<LetterAvatar username="Frank" size={32} />);
    const bg1 = (c1.firstElementChild as HTMLElement).style.backgroundColor;
    const bg2 = (c2.firstElementChild as HTMLElement).style.backgroundColor;
    expect(bg1).toBe(bg2);
  });
});
