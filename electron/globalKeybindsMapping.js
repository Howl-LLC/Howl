// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';

const { UiohookKey } = require('uiohook-napi');

/**
 * Translate a uiohook-napi key code into our DOM-event.code-compatible token
 * format. Returns null for unmapped keys.
 *
 * Token format matches utils/keybindFormat.ts (KeyA..KeyZ, Digit0..Digit9,
 * LCtrl/RCtrl/LShift/RShift/LAlt/RAlt/LMeta/RMeta, ArrowLeft, etc.).
 *
 * @param {number} uiohookKeycode
 * @returns {string | null}
 */
function translateUiohookKey(uiohookKeycode) {
  const token = REVERSE[uiohookKeycode];
  return token || null;
}

// Build reverse map once at require time. Every entry here is a constant
// value from uiohook-napi's UiohookKey enum.
const REVERSE = (() => {
  const m = {};

  // Letters
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i);          // 'A'..'Z'
    const code = UiohookKey[letter];
    if (typeof code === 'number') m[code] = `Key${letter}`;
  }

  // Digits (top row)
  for (let i = 0; i <= 9; i++) {
    const code = UiohookKey[String(i)];
    if (typeof code === 'number') m[code] = `Digit${i}`;
  }

  // Side-specific modifiers
  m[UiohookKey.Ctrl]        = 'LCtrl';
  m[UiohookKey.CtrlRight]   = 'RCtrl';
  m[UiohookKey.Shift]       = 'LShift';
  m[UiohookKey.ShiftRight]  = 'RShift';
  m[UiohookKey.Alt]         = 'LAlt';
  m[UiohookKey.AltRight]    = 'RAlt';
  m[UiohookKey.Meta]        = 'LMeta';
  m[UiohookKey.MetaRight]   = 'RMeta';

  // Arrows, navigation
  m[UiohookKey.ArrowLeft]  = 'ArrowLeft';
  m[UiohookKey.ArrowRight] = 'ArrowRight';
  m[UiohookKey.ArrowUp]    = 'ArrowUp';
  m[UiohookKey.ArrowDown]  = 'ArrowDown';
  m[UiohookKey.Home]       = 'Home';
  m[UiohookKey.End]        = 'End';
  m[UiohookKey.PageUp]     = 'PageUp';
  m[UiohookKey.PageDown]   = 'PageDown';
  m[UiohookKey.Insert]     = 'Insert';
  m[UiohookKey.Delete]     = 'Delete';

  // Control
  m[UiohookKey.Space]       = 'Space';
  m[UiohookKey.Enter]       = 'Enter';
  m[UiohookKey.Escape]      = 'Escape';
  m[UiohookKey.Tab]         = 'Tab';
  m[UiohookKey.Backspace]   = 'Backspace';
  m[UiohookKey.CapsLock]    = 'CapsLock';
  m[UiohookKey.PrintScreen] = 'PrintScreen';
  m[UiohookKey.ScrollLock]  = 'ScrollLock';

  // Function keys F1..F24
  for (let i = 1; i <= 24; i++) {
    const code = UiohookKey[`F${i}`];
    if (typeof code === 'number') m[code] = `F${i}`;
  }

  // Numpad
  for (let i = 0; i <= 9; i++) {
    const code = UiohookKey[`Numpad${i}`];
    if (typeof code === 'number') m[code] = `Numpad${i}`;
  }
  m[UiohookKey.NumpadAdd]      = 'NumpadAdd';
  m[UiohookKey.NumpadSubtract] = 'NumpadSubtract';
  m[UiohookKey.NumpadMultiply] = 'NumpadMultiply';
  m[UiohookKey.NumpadDivide]   = 'NumpadDivide';
  m[UiohookKey.NumpadDecimal]  = 'NumpadDecimal';
  m[UiohookKey.NumpadEnter]    = 'NumpadEnter';
  m[UiohookKey.NumLock]        = 'NumLock';

  // US-layout symbols (physical-position)
  m[UiohookKey.Equal]        = 'Equal';
  m[UiohookKey.Minus]        = 'Minus';
  m[UiohookKey.Slash]        = 'Slash';
  m[UiohookKey.Backslash]    = 'Backslash';
  m[UiohookKey.BracketLeft]  = 'BracketLeft';
  m[UiohookKey.BracketRight] = 'BracketRight';
  m[UiohookKey.Semicolon]    = 'Semicolon';
  m[UiohookKey.Quote]        = 'Quote';
  m[UiohookKey.Comma]        = 'Comma';
  m[UiohookKey.Period]       = 'Period';
  m[UiohookKey.Backquote]    = 'Backquote';

  return m;
})();

module.exports = { translateUiohookKey };
