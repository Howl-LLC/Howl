// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { TierUnreadBadge } from '../components/TierUnreadBadge';

describe('TierUnreadBadge', () => {
  it('renders nothing when neither tier is unread', () => {
    const { container } = render(<TierUnreadBadge savedUnread={false} savedCount={0} otrUnread={false} otrCount={0} />);
    expect(container.firstChild).toBeNull();
  });
  it('renders a single saved (red) dot for Saved-only unread', () => {
    const { container } = render(<TierUnreadBadge savedUnread savedCount={3} otrUnread={false} otrCount={0} />);
    expect(container.querySelectorAll('[data-tier]').length).toBe(1);
    expect(container.querySelector('[data-tier="saved"]')?.textContent).toBe('3');
    expect(container.querySelector('[data-tier="otr"]')).toBeNull();
  });
  it('renders a single OTR (blue) dot for OTR-only unread', () => {
    const { container } = render(<TierUnreadBadge savedUnread={false} savedCount={0} otrUnread otrCount={2} />);
    expect(container.querySelectorAll('[data-tier]').length).toBe(1);
    expect(container.querySelector('[data-tier="otr"]')?.textContent).toBe('2');
    expect(container.querySelector('[data-tier="saved"]')).toBeNull();
  });
  it('renders both dots when both tiers are unread', () => {
    const { container } = render(<TierUnreadBadge savedUnread savedCount={1} otrUnread otrCount={5} />);
    expect(container.querySelector('[data-tier="saved"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-tier="otr"]')?.textContent).toBe('5');
  });
  it('caps counts at 99+ and shows 1 for a true flag with zero count', () => {
    const { container } = render(<TierUnreadBadge savedUnread savedCount={150} otrUnread otrCount={0} />);
    expect(container.querySelector('[data-tier="saved"]')?.textContent).toBe('99+');
    expect(container.querySelector('[data-tier="otr"]')?.textContent).toBe('1');
  });
});
