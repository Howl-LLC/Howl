// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewerIndicator } from '../components/call/ViewerIndicator';
import { useViewerStore } from '../stores/viewerStore';
import { makeStreamKey } from '../stores/types';

const ctx = { kind: 'voice' as const, scopeId: 'ch-1' };
const ownerId = 'bob';
const key = makeStreamKey(ctx, ownerId, 'screen');

describe('<ViewerIndicator />', () => {
  beforeEach(() => useViewerStore.getState().reset());

  it('hides when no viewers', () => {
    const { container } = render(<ViewerIndicator context={ctx} ownerId={ownerId} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows count when viewers present', () => {
    useViewerStore.getState().addViewers(key, ['alice', 'carol']);
    render(<ViewerIndicator context={ctx} ownerId={ownerId} />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('excludes self from count', () => {
    useViewerStore.getState().addViewers(key, ['alice', 'self', 'carol']);
    render(<ViewerIndicator context={ctx} ownerId={ownerId} selfUserId="self" />);
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('clicking opens popover', () => {
    useViewerStore.getState().addViewers(key, ['alice']);
    render(<ViewerIndicator context={ctx} ownerId={ownerId} />);
    fireEvent.click(screen.getByRole('button', { name: /viewers/i }));
    expect(screen.getByRole('dialog', { name: /viewers/i })).toBeInTheDocument();
  });
});
