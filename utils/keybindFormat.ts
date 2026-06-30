// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Howl keybind format — physical-key-based, side-specific modifier combos.
 *
 * Combos are `+`-separated tokens. Each token is an `e.code` value for
 * the physical key (so `KeyM` vs `Numpad5` vs `NumpadAdd` are all distinct).
 * Modifiers are side-specific: `LCtrl` ≠ `RCtrl`, `LAlt` ≠ `RAlt`, etc.
 *
 * Examples:
 *   LCtrl+LShift+KeyM    — left ctrl + left shift + M
 *   RAlt+NumpadAdd       — right alt + numpad plus
 *   LAlt+ArrowLeft       — left alt + left arrow
 *
 * Module state:
 *   Installs window-level listeners on first import that maintain a Set
 *   of currently-held physical modifier codes. The matcher in
 *   useGlobalKeybinds and the capture flow both read from this Set.
 *   Cleared on `window.blur` so Alt-tabbing / OS-shortcut focus-steal
 *   doesn't leave sticky modifiers.
 */

const MODIFIER_CODES = new Set<string>([
  'ControlLeft', 'ControlRight',
  'ShiftLeft', 'ShiftRight',
  'AltLeft', 'AltRight',
  'MetaLeft', 'MetaRight',
  'OSLeft', 'OSRight',  // Firefox legacy for Meta
]);

const MODIFIER_CODE_TO_TOKEN: Record<string, string> = {
  ControlLeft: 'LCtrl',
  ControlRight: 'RCtrl',
  ShiftLeft: 'LShift',
  ShiftRight: 'RShift',
  AltLeft: 'LAlt',
  AltRight: 'RAlt',
  MetaLeft: 'LMeta',
  MetaRight: 'RMeta',
  OSLeft: 'LMeta',
  OSRight: 'RMeta',
};

// Preferred ordering so `LCtrl+LShift+KeyM` is canonical — same event always
// produces the same string. `LCtrl` always comes before `RCtrl` etc.
const MODIFIER_ORDER = ['LCtrl', 'RCtrl', 'LShift', 'RShift', 'LAlt', 'RAlt', 'LMeta', 'RMeta'];

const heldModifiers = new Set<string>();

let trackerInstalled = false;
function installModifierTracker(): void {
  if (trackerInstalled) return;
  if (typeof window === 'undefined') return;
  trackerInstalled = true;

  const onDown = (e: KeyboardEvent) => {
    if (MODIFIER_CODES.has(e.code)) heldModifiers.add(e.code);
  };
  const onUp = (e: KeyboardEvent) => {
    if (MODIFIER_CODES.has(e.code)) heldModifiers.delete(e.code);
  };
  const onBlur = () => heldModifiers.clear();

  // Use window with capture=true so we see the events before any component-
  // level listener calls stopPropagation.
  window.addEventListener('keydown', onDown, true);
  window.addEventListener('keyup', onUp, true);
  window.addEventListener('blur', onBlur);
  // visibilitychange catches minimize / lock-screen / tab-switch in cases
  // the blur event may miss.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) heldModifiers.clear();
  });
}
installModifierTracker();

export function isModifierCode(code: string): boolean {
  return MODIFIER_CODES.has(code);
}

/** Currently-held physical modifier tokens, in canonical order. */
function currentModifierTokens(): string[] {
  const tokens: string[] = [];
  for (const code of heldModifiers) {
    const token = MODIFIER_CODE_TO_TOKEN[code];
    if (token && !tokens.includes(token)) tokens.push(token);
  }
  tokens.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
  return tokens;
}

/**
 * Build a combo string from a keyboard event + the currently-tracked
 * modifier set. Returns null if the event's key is itself a modifier
 * (pure-modifier presses don't produce a combo).
 */
export function buildComboFromEvent(e: KeyboardEvent): string | null {
  if (e.isComposing) return null;         // IME composition — ignore
  if (MODIFIER_CODES.has(e.code)) return null;
  const modifiers = currentModifierTokens();
  return [...modifiers, e.code].join('+');
}

/**
 * Synchronous match — reads current modifier state + the event's code,
 * returns the full combo string. Used by useGlobalKeybinds to compare
 * against stored binds. Empty string for pure modifier events.
 */
export function currentComboForEvent(e: KeyboardEvent): string {
  if (e.isComposing) return '';
  if (MODIFIER_CODES.has(e.code)) return '';
  return [...currentModifierTokens(), e.code].join('+');
}

// Capture mode (recording a bind)

let captureActive = false;
export function isCaptureActive(): boolean { return captureActive; }

export interface CaptureCallbacks {
  onCapture: (combo: string) => void;
  onCancel?: () => void;
  onClear?: () => void;
}

/**
 * Start capturing the next key combination from anywhere in the app. Installs
 * document-level capture listeners that swallow all keydown/keyup events
 * (preventDefault + stopPropagation) so OS/browser shortcuts like Alt-menu,
 * Ctrl+R refresh, F11 fullscreen, Ctrl+W close tab etc. can't interfere.
 *
 * Escape cancels (no combo captured). Backspace clears (captured as empty
 * string — caller should interpret as "unbind"). Any other non-modifier key
 * completes with the combo string.
 *
 * Also sets the module-level `captureActive` flag so `useGlobalKeybinds`
 * bails out and doesn't fire the pre-existing bind whose combo you're
 * trying to re-record.
 *
 * Safety: auto-uninstalls after 30 seconds if nothing happens.
 */
export function startKeyCapture(cb: CaptureCallbacks): () => void {
  if (captureActive) return () => {};

  captureActive = true;

  const onKeyDown = (e: KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    if (e.isComposing) return;

    // Escape cancels
    if (e.code === 'Escape') {
      cleanup();
      cb.onCancel?.();
      return;
    }
    // Backspace clears the binding
    if (e.code === 'Backspace') {
      cleanup();
      cb.onClear?.();
      return;
    }
    // Pure modifier presses don't complete the capture — user is mid-combo
    if (MODIFIER_CODES.has(e.code)) return;

    const combo = [...currentModifierTokens(), e.code].join('+');
    cleanup();
    cb.onCapture(combo);
  };

  const onKeyUp = (e: KeyboardEvent) => {
    // Swallow keyup so Alt doesn't activate the browser/Electron menu bar,
    // Tab doesn't lose focus, etc. We don't act on keyup — the combo is
    // captured on keydown of a non-modifier key.
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const onBlur = () => {
    // User alt-tabbed or clicked away — cancel capture.
    cleanup();
    cb.onCancel?.();
  };

  let timeoutId: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    cleanup();
    cb.onCancel?.();
  }, 30_000);

  function cleanup(): void {
    if (!captureActive) return;
    captureActive = false;
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    if (timeoutId !== null) { clearTimeout(timeoutId); timeoutId = null; }
  }

  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('blur', onBlur);

  return cleanup;
}

// Display formatting

const TOKEN_DISPLAY: Record<string, string> = {
  // Modifiers
  LCtrl: 'Ctrl', RCtrl: 'R-Ctrl',
  LShift: 'Shift', RShift: 'R-Shift',
  LAlt: 'Alt', RAlt: 'R-Alt',
  LMeta: 'Meta', RMeta: 'R-Meta',
  // Navigation
  ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓',
  Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn',
  Insert: 'Ins', Delete: 'Del',
  // Whitespace / control
  Space: 'Space', Tab: 'Tab', Enter: 'Enter', Escape: 'Esc',
  Backspace: 'Backspace', CapsLock: 'Caps',
  // Numpad
  Numpad0: 'Num 0', Numpad1: 'Num 1', Numpad2: 'Num 2', Numpad3: 'Num 3',
  Numpad4: 'Num 4', Numpad5: 'Num 5', Numpad6: 'Num 6', Numpad7: 'Num 7',
  Numpad8: 'Num 8', Numpad9: 'Num 9',
  NumpadAdd: 'Num +', NumpadSubtract: 'Num -',
  NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
  NumpadDecimal: 'Num .', NumpadEnter: 'Num ⏎',
  NumpadEqual: 'Num =', NumpadComma: 'Num ,',
  NumLock: 'NumLock',
  // Symbol (physical-position tokens — labels shown are the US-layout
  // unshifted glyph; other layouts will still identify the physical key).
  Equal: '=', Minus: '-', Slash: '/', Backslash: '\\',
  BracketLeft: '[', BracketRight: ']',
  Semicolon: ';', Quote: "'", Comma: ',', Period: '.',
  Backquote: '`', IntlBackslash: '\\', IntlRo: '\\',
  // Lock / system
  ScrollLock: 'ScrLk', Pause: 'Pause', PrintScreen: 'PrtSc',
  ContextMenu: 'Menu',
  // Media
  MediaPlayPause: '⏯', MediaStop: '⏹',
  MediaTrackNext: '⏭', MediaTrackPrevious: '⏮',
  AudioVolumeMute: '🔇', AudioVolumeUp: '🔊+', AudioVolumeDown: '🔊-',
};

function formatToken(token: string): string {
  if (TOKEN_DISPLAY[token]) return TOKEN_DISPLAY[token];
  // KeyA..KeyZ → A..Z
  if (token.startsWith('Key') && token.length === 4) return token.slice(3);
  // Digit0..Digit9 → 0..9
  if (token.startsWith('Digit') && token.length === 6) return token.slice(5);
  // F1..F24 → as-is
  if (/^F\d{1,2}$/.test(token)) return token;
  // Fallback: drop common prefixes, otherwise show raw token.
  return token;
}

/** Split a combo into an array of display tokens. Empty combo → [] so
 *  callers can render an "Unset" placeholder themselves. */
export function formatComboDisplay(combo: string): string[] {
  if (!combo) return [];
  return combo.split('+').map(formatToken);
}

/** Human-readable one-line rendering — used for confirmation dialogs etc. */
export function formatComboText(combo: string): string {
  return formatComboDisplay(combo).join(' + ');
}

// Legacy migration

/** True if `combo` looks like the old uppercase `CTRL+SHIFT+M` format. */
export function isLegacyCombo(combo: string): boolean {
  if (!combo) return false;
  // New format tokens are mixed-case (LCtrl, KeyM, ArrowLeft). Legacy is
  // all-caps. Heuristic: if the string contains only uppercase letters,
  // digits, `+`, and spaces, it's legacy.
  return /^[A-Z0-9+ ]+$/.test(combo);
}

const LEGACY_KEY_MAP: Record<string, string> = {
  SPACE: 'Space',
  ESCAPE: 'Escape',
  ESC: 'Escape',
  TAB: 'Tab',
  ENTER: 'Enter',
  RETURN: 'Enter',
  BACKSPACE: 'Backspace',
  DELETE: 'Delete',
  DEL: 'Delete',
  HOME: 'Home',
  END: 'End',
  PAGEUP: 'PageUp',
  PAGEDOWN: 'PageDown',
  INSERT: 'Insert',
  INS: 'Insert',
  CAPSLOCK: 'CapsLock',
  // Arrow keys
  LEFT: 'ArrowLeft', RIGHT: 'ArrowRight', UP: 'ArrowUp', DOWN: 'ArrowDown',
  ARROWLEFT: 'ArrowLeft', ARROWRIGHT: 'ArrowRight',
  ARROWUP: 'ArrowUp', ARROWDOWN: 'ArrowDown',
  // Symbols (map to physical-position code)
  '=': 'Equal', '-': 'Minus', '/': 'Slash', '\\': 'Backslash',
  '[': 'BracketLeft', ']': 'BracketRight',
  ';': 'Semicolon', "'": 'Quote', ',': 'Comma', '.': 'Period', '`': 'Backquote',
  '+': 'Equal',  // legacy `+` was unreliable; best guess is Shift+Equal
};

/** Convert a legacy `CTRL+SHIFT+M` combo to the new `LCtrl+LShift+KeyM`
 *  format. Side-agnostic modifiers default to the left key (the common
 *  case). Returns the original string if it's already new-format. */
export function migrateLegacyCombo(combo: string): string {
  if (!combo) return combo;
  if (!isLegacyCombo(combo)) return combo;

  const parts = combo.split('+').map(p => p.trim());
  const tokens: string[] = [];
  for (const p of parts) {
    const upper = p.toUpperCase();
    switch (upper) {
      case 'CTRL':
      case 'CONTROL':
        tokens.push('LCtrl'); break;
      case 'RIGHT CTRL':
      case 'RCTRL':
        tokens.push('RCtrl'); break;
      case 'SHIFT':
        tokens.push('LShift'); break;
      case 'RIGHT SHIFT':
      case 'RSHIFT':
        tokens.push('RShift'); break;
      case 'ALT':
      case 'OPTION':
        tokens.push('LAlt'); break;
      case 'RIGHT ALT':
      case 'RALT':
        tokens.push('RAlt'); break;
      case 'META':
      case 'CMD':
      case 'WIN':
      case 'SUPER':
        tokens.push('LMeta'); break;
      case 'RIGHT META':
      case 'RMETA':
        tokens.push('RMeta'); break;
      default: {
        if (LEGACY_KEY_MAP[upper]) { tokens.push(LEGACY_KEY_MAP[upper]); break; }
        if (LEGACY_KEY_MAP[p]) { tokens.push(LEGACY_KEY_MAP[p]); break; }
        // Letter
        if (/^[A-Z]$/.test(upper)) { tokens.push(`Key${upper}`); break; }
        // Digit
        if (/^[0-9]$/.test(upper)) { tokens.push(`Digit${upper}`); break; }
        // Function key
        if (/^F\d{1,2}$/.test(upper)) { tokens.push(upper); break; }
        // Last resort: pass through (will likely fail to match — user can re-record)
        tokens.push(p);
      }
    }
  }
  return tokens.join('+');
}
