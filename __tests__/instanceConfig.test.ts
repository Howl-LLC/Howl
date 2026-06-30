// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import { registrationOpen, billingVisible, voiceVisible, selfHostRootRedirect, type InstanceConfig } from '../shared/instanceConfig';
import { useAppStore } from '../stores/appStore';

const closed: InstanceConfig = { instanceName: 'X', selfHost: true, registrationMode: 'closed', voiceEnabled: false, livekitUrl: '', billingEnabled: false, emailEnabled: false };

describe('instanceConfig selectors', () => {
  it('default (null = hosted) is permissive', () => {
    expect(registrationOpen(null)).toBe(true);
    expect(billingVisible(null)).toBe(true);
    expect(voiceVisible(null)).toBe(true);
  });
  it('self-host closed/disabled hides the right things', () => {
    expect(registrationOpen(closed)).toBe(false);
    expect(billingVisible(closed)).toBe(false);
    expect(voiceVisible(closed)).toBe(false);
  });
});

describe('selfHostRootRedirect', () => {
  it('redirects the web root to /login on a self-host build (no marketing site)', () => {
    expect(selfHostRootRedirect(true, '/')).toBe('/login');
  });
  it('renders the marketing landing on a hosted build (returns null)', () => {
    expect(selfHostRootRedirect(false, '/')).toBeNull();
  });
  it('only affects the root path, never other paths', () => {
    expect(selfHostRootRedirect(true, '/about')).toBeNull();
    expect(selfHostRootRedirect(true, '/login')).toBeNull();
  });
});

describe('appStore instanceConfig slice', () => {
  beforeEach(() => useAppStore.getState().setInstanceConfig(null));
  it('stores and clears instance config', () => {
    useAppStore.getState().setInstanceConfig(closed);
    expect(useAppStore.getState().instanceConfig?.instanceName).toBe('X');
    useAppStore.getState().setInstanceConfig(null);
    expect(useAppStore.getState().instanceConfig).toBeNull();
  });
});
