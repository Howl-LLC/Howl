// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import enUS from '../src/locales/en-US.json';

// Resolve t() against the real en-US copy so assertions check rendered text.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      const dict = enUS as unknown as Record<string, string>;
      const v = dict[k] ?? k;
      return opts ? v.replace(/\{\{(\w+)\}\}/g, (_m, p) => String(opts[p] ?? '')) : v;
    },
  }),
}));

import { AboutPage } from '../components/AboutPage';

function renderAbout(path = '/about') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AboutPage />
    </MemoryRouter>,
  );
}

describe('AboutPage redesign', () => {
  it('renders the new story, values, and security section headings', () => {
    renderAbout();
    expect(screen.getByText('Our story')).toBeInTheDocument();
    expect(screen.getByText('What we stand for')).toBeInTheDocument();
    expect(screen.getByText('Security & privacy')).toBeInTheDocument();
  });

  it('leads security with accurate post-quantum claims', () => {
    renderAbout();
    expect(screen.getByText('Post-quantum by default')).toBeInTheDocument();
    expect(screen.getByText(/X-Wing/)).toBeInTheDocument();
    expect(screen.getByText(/ML-KEM-768/)).toBeInTheDocument();
  });

  it('keeps the honest transparency note about non-E2E surfaces', () => {
    renderAbout();
    expect(screen.getByText(/GIFs from the GIF picker/)).toBeInTheDocument();
    expect(screen.getByText(/server and community channels/)).toBeInTheDocument();
  });

  it('keeps the open-source credits link', () => {
    renderAbout();
    expect(screen.getByText('View Open Source Credits')).toBeInTheDocument();
  });
});
