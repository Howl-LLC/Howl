// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MentionText } from '../components/MentionText';

vi.mock('../contexts/SettingsContext', () => ({
  useSettings: () => ({ chatSettings: { showEmbeds: false } }),
}));
vi.mock('../components/SpoilerRevealContext', () => ({
  useSpoilerReveal: () => ({ isRevealed: () => false, reveal: () => {} }),
}));

/** Non-empty lines rendered as their own block (one visual line each). */
function textLines(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('span.block'))
    .filter((el) => el.querySelector('span.block') === null) // leaf line blocks only
    .map((el) => el.textContent ?? '');
}

describe('MentionText line breaks', () => {
  it('renders one newline as exactly two adjacent lines with no extra <br>', () => {
    const { container } = render(<MentionText content={'a\nb'} />);
    expect(textLines(container)).toEqual(['a', 'b']);
    // A <br> inside a display:block line adds a blank line above it — must be none.
    expect(container.querySelectorAll('br')).toHaveLength(0);
  });

  it('renders two newlines as one blank line between the text lines', () => {
    const { container } = render(<MentionText content={'a\n\nb'} />);
    expect(textLines(container)).toEqual(['a', '', 'b']);
    // Exactly one <br>: the one that gives the empty line its height.
    const brs = container.querySelectorAll('br');
    expect(brs).toHaveLength(1);
    expect(brs[0].parentElement?.textContent).toBe('');
  });

  it('renders three newlines as two blank lines', () => {
    const { container } = render(<MentionText content={'a\n\n\nb'} />);
    expect(textLines(container)).toEqual(['a', '', '', 'b']);
    expect(container.querySelectorAll('br')).toHaveLength(2);
  });
});
