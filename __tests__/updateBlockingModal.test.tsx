// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useUpdateStore } from '../stores/updateStore';
import { UpdateBlockingModal } from '../components/UpdateBlockingModal';

// Mock resolveBuildDateSync
vi.mock('../services/buildDate', () => ({
  resolveBuildDateSync: () => '2026-04-29',
}));

describe('UpdateBlockingModal — web cache-bust reload', () => {
  let replaceSpy: ReturnType<typeof vi.fn>;
  let reloadSpy: ReturnType<typeof vi.fn>;
  let originalLocation: Location;

  beforeEach(() => {
    vi.useFakeTimers();
    useUpdateStore.getState().reset();
    sessionStorage.clear();

    // Mock window.location with a URL object that we can inspect.
    replaceSpy = vi.fn();
    reloadSpy = vi.fn();
    originalLocation = window.location;

    Object.defineProperty(window, 'location', {
      configurable: true,
      value: {
        ...originalLocation,
        href: 'https://howlpro.com/app',
        search: '',
        replace: replaceSpy,
        reload: reloadSpy,
      },
    });

    // Ensure no electron bridge (web path)
    delete (window as unknown as Record<string, unknown>).electron;
    delete (window as unknown as Record<string, unknown>).__ELECTRON_WINDOW__;
  });

  afterEach(() => {
    vi.useRealTimers();
    useUpdateStore.getState().reset();
    sessionStorage.clear();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: originalLocation,
    });
  });

  it('renders the modal when required is true', () => {
    useUpdateStore.getState().setRequired('buildDate');
    render(<UpdateBlockingModal />);
    expect(screen.getByText('Howl needs to update')).toBeTruthy();
  });

  it('does not render when required is false', () => {
    render(<UpdateBlockingModal />);
    expect(screen.queryByText('Howl needs to update')).toBeNull();
  });

  it('first reload attempt calls location.replace with a cache-bust _v param', () => {
    useUpdateStore.getState().setRequired('buildDate');
    render(<UpdateBlockingModal />);

    // Advance past the 3s timeout
    vi.advanceTimersByTime(3_100);

    expect(replaceSpy).toHaveBeenCalledOnce();
    const url = new URL(replaceSpy.mock.calls[0][0]);
    expect(url.searchParams.has('_v')).toBe(true);
    const vParam = url.searchParams.get('_v')!;
    expect(vParam).toMatch(/^2026-04-29-/); // buildDate prefix
  });

  it('second reload attempt calls navigator.serviceWorker.getRegistration then reload', async () => {
    // Simulate attempt=1 (second attempt)
    sessionStorage.setItem('howl-update-reload-attempt', '1');

    const unregisterSpy = vi.fn().mockResolvedValue(undefined);
    const getRegSpy = vi.fn().mockResolvedValue({ unregister: unregisterSpy });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: getRegSpy },
    });

    useUpdateStore.getState().setRequired('buildDate');
    render(<UpdateBlockingModal />);

    // Advance past the 3s timeout
    vi.advanceTimersByTime(3_100);

    // Let the async chain resolve
    await vi.runAllTimersAsync();

    expect(getRegSpy).toHaveBeenCalledOnce();
  });

  it('third attempt (attempt >= 2) sets stage to failed immediately', () => {
    sessionStorage.setItem('howl-update-reload-attempt', '2');
    useUpdateStore.getState().setRequired('buildDate');
    render(<UpdateBlockingModal />);

    // The store should transition to 'failed' synchronously (no timeout needed)
    expect(useUpdateStore.getState().stage).toBe('failed');
  });
});
