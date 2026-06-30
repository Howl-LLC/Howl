// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';

// uiohook-napi loads a native .node binary that fails on dev boxes / CI
// runners without a matching prebuilt for the platform (foreign-arch,
// missing prebuild, mismatched node ABI). Detect that case here and skip
// — the mapping logic is a pure function that runs the same in production
// regardless of whether the test exercises it on every machine.
let UiohookKey;
let translateUiohookKey;
let skipReason = null;
try {
  ({ UiohookKey } = await import('uiohook-napi'));
  ({ translateUiohookKey } = await import('../electron/globalKeybindsMapping.js'));
} catch (err) {
  skipReason = err instanceof Error ? err.message : String(err);
}

const d = skipReason ? describe.skip : describe;

d('globalKeybindsMapping' + (skipReason ? ` [skipped: ${skipReason}]` : ''), () => {
  it('maps letter keys to KeyX tokens', () => {
    expect(translateUiohookKey(UiohookKey.A)).toBe('KeyA');
    expect(translateUiohookKey(UiohookKey.Z)).toBe('KeyZ');
    expect(translateUiohookKey(UiohookKey.M)).toBe('KeyM');
  });

  it('maps digits to DigitX tokens', () => {
    expect(translateUiohookKey(UiohookKey['0'])).toBe('Digit0');
    expect(translateUiohookKey(UiohookKey['9'])).toBe('Digit9');
  });

  it('maps side-specific modifiers', () => {
    expect(translateUiohookKey(UiohookKey.Ctrl)).toBe('LCtrl');
    expect(translateUiohookKey(UiohookKey.CtrlRight)).toBe('RCtrl');
    expect(translateUiohookKey(UiohookKey.Shift)).toBe('LShift');
    expect(translateUiohookKey(UiohookKey.ShiftRight)).toBe('RShift');
    expect(translateUiohookKey(UiohookKey.Alt)).toBe('LAlt');
    expect(translateUiohookKey(UiohookKey.AltRight)).toBe('RAlt');
    expect(translateUiohookKey(UiohookKey.Meta)).toBe('LMeta');
    expect(translateUiohookKey(UiohookKey.MetaRight)).toBe('RMeta');
  });

  it('maps arrow keys', () => {
    expect(translateUiohookKey(UiohookKey.ArrowLeft)).toBe('ArrowLeft');
    expect(translateUiohookKey(UiohookKey.ArrowRight)).toBe('ArrowRight');
    expect(translateUiohookKey(UiohookKey.ArrowUp)).toBe('ArrowUp');
    expect(translateUiohookKey(UiohookKey.ArrowDown)).toBe('ArrowDown');
  });

  it('maps function keys', () => {
    expect(translateUiohookKey(UiohookKey.F1)).toBe('F1');
    expect(translateUiohookKey(UiohookKey.F12)).toBe('F12');
  });

  it('maps common control keys', () => {
    expect(translateUiohookKey(UiohookKey.Space)).toBe('Space');
    expect(translateUiohookKey(UiohookKey.Enter)).toBe('Enter');
    expect(translateUiohookKey(UiohookKey.Escape)).toBe('Escape');
    expect(translateUiohookKey(UiohookKey.Tab)).toBe('Tab');
    expect(translateUiohookKey(UiohookKey.Backspace)).toBe('Backspace');
  });

  it('returns null for unmapped keycodes', () => {
    expect(translateUiohookKey(999_999)).toBeNull();
  });
});
