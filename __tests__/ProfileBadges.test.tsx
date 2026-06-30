// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProfileBadges } from '../components/ProfileBadges';

describe('ProfileBadges', () => {
  it('renders nothing for an empty array', () => {
    const { container } = render(<ProfileBadges badges={[]} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders all 7 badge types', () => {
    render(<ProfileBadges badges={['staff', 'verified', 'pro', 'pro_essential', 'beta', 'bug_hunter', 'early_supporter']} />);
    expect(screen.getByTitle('Staff')).toBeInTheDocument();
    expect(screen.getByTitle('Verified')).toBeInTheDocument();
    expect(screen.getByTitle('Howl Pro')).toBeInTheDocument();
    expect(screen.getByTitle('Essential')).toBeInTheDocument();
    expect(screen.getByTitle('Beta')).toBeInTheDocument();
    expect(screen.getByTitle('Bug Hunter')).toBeInTheDocument();
    expect(screen.getByTitle('Early Supporter')).toBeInTheDocument();
  });

  it('renders in the received order, not an internal sort', () => {
    const { container } = render(<ProfileBadges badges={['beta', 'pro']} />);
    const titles = Array.from(container.querySelectorAll('span[title]')).map((el) => el.getAttribute('title'));
    expect(titles).toEqual(['Beta', 'Howl Pro']);
  });

  it('skips unknown/unconfigured keys', () => {
    const { container } = render(<ProfileBadges badges={['totally_made_up', 'beta']} />);
    const titles = Array.from(container.querySelectorAll('span[title]')).map((el) => el.getAttribute('title'));
    expect(titles).toEqual(['Beta']);
  });
});
