// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect, beforeEach } from 'vitest';
import {
  getStoredKeybinds,
  setStoredKeybinds,
  getKeybindsGlobalMasterEnabled,
  setKeybindsGlobalMasterEnabled,
  type KeybindEntry,
} from '../utils/settingsStorage';

describe('settingsStorage — keybinds global schema', () => {
  beforeEach(() => { localStorage.clear(); });

  it('loads legacy entry without `global` field as global=undefined (falsy)', () => {
    localStorage.setItem('howl_keybinds', JSON.stringify([
      { id: 'a', action: 'toggleMute', keys: 'LCtrl+LShift+KeyM', enabled: true },
    ]));
    const binds = getStoredKeybinds();
    expect(binds).toHaveLength(1);
    expect(binds[0].global).toBeUndefined();
    expect(!!binds[0].global).toBe(false);
  });

  it('round-trips global=true', () => {
    const input: KeybindEntry[] = [
      { id: 'a', action: 'pushToTalk', keys: 'LCtrl+KeyP', enabled: true, global: true },
    ];
    setStoredKeybinds(input);
    const out = getStoredKeybinds();
    expect(out[0].global).toBe(true);
  });

  it('master flag defaults to true and persists changes', () => {
    expect(getKeybindsGlobalMasterEnabled()).toBe(true);
    setKeybindsGlobalMasterEnabled(false);
    expect(getKeybindsGlobalMasterEnabled()).toBe(false);
    setKeybindsGlobalMasterEnabled(true);
    expect(getKeybindsGlobalMasterEnabled()).toBe(true);
  });
});
