// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useGlobalKeybinds, type KeybindActions, type KeybindHandler } from '../hooks/useGlobalKeybinds';
import type { KeybindEntry } from '../utils/settingsStorage';
import { useUpdateStore } from '../stores/updateStore';

// Minimal keybind entry that triggers on KeyA
const TEST_BIND: KeybindEntry = {
  id: 'test-bind-1',
  action: 'testAction',
  keys: 'KeyA',
  enabled: true,
  global: false,
};

function fireKeydown(code: string, opts?: Partial<KeyboardEvent>) {
  const event = new KeyboardEvent('keydown', {
    code,
    key: code === 'KeyA' ? 'a' : code,
    bubbles: true,
    cancelable: true,
    ...opts,
  });
  document.dispatchEvent(event);
}

describe('useGlobalKeybinds update suppression', () => {
  let handler: KeybindHandler;
  let actions: KeybindActions;

  beforeEach(() => {
    handler = vi.fn() as unknown as KeybindHandler;
    actions = { testAction: handler };
    // Reset the update store to default (required = false)
    useUpdateStore.getState().reset();
  });

  afterEach(() => {
    useUpdateStore.getState().reset();
  });

  it('fires the action when update is NOT required', () => {
    renderHook(() => useGlobalKeybinds([TEST_BIND], actions, true));
    fireKeydown('KeyA');
    expect(handler).toHaveBeenCalledWith('down');
  });

  it('does NOT fire the action when update IS required', () => {
    useUpdateStore.getState().setRequired('buildDate');
    renderHook(() => useGlobalKeybinds([TEST_BIND], actions, true));
    fireKeydown('KeyA');
    expect(handler).not.toHaveBeenCalled();
  });

  it('does NOT fire the action when enabled=false (pre-existing behavior)', () => {
    renderHook(() => useGlobalKeybinds([TEST_BIND], actions, false));
    fireKeydown('KeyA');
    expect(handler).not.toHaveBeenCalled();
  });
});
