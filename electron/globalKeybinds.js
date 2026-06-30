// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';

/**
 * Main-process owner of the system-wide keyboard hook. Lazy-loads
 * uiohook-napi on first use, integrates with the pure matcher, and emits
 * {actionId, phase} triggers.
 *
 * SECURITY: this module sees every keystroke system-wide. It MUST NEVER log,
 * serialize, or transmit raw key events. Only matched action triggers leave
 * this module. All errors must be scrubbed before logging.
 */

const { EventEmitter } = require('events');
const { createMatcher } = require('./globalKeybindsMatcher');
const { translateUiohookKey } = require('./globalKeybindsMapping');

const HOLD_ACTIONS = new Set(['pushToTalk', 'pushToMute', 'openSoundboardHold']);

let state = {
  loaded: false,         // uiohook-napi lazy-loaded
  running: false,        // hook currently listening
  matcher: null,
  emitter: new EventEmitter(),
  uIOhook: null,         // uiohook-napi singleton when loaded
};

/**
 * Attempt to lazy-load uiohook-napi. Returns true on success, false otherwise.
 * On failure (e.g., missing native binary, unsupported platform), state is
 * left unloaded and a scrubbed warning is logged.
 */
function tryLoad() {
  if (state.loaded) return true;
  try {
    const mod = require('uiohook-napi');
    state.uIOhook = mod.uIOhook;
    state.loaded = true;
    return true;
  } catch (err) {
    console.warn('[globalKeybinds] native hook unavailable:', scrubError(err));
    return false;
  }
}

/**
 * Scrub an error before logging. Defence-in-depth: in practice uiohook errors
 * wouldn't contain key data, but this module never takes chances.
 */
function scrubError(err) {
  if (!err) return 'unknown error';
  return String(err.message || err.code || 'error').slice(0, 200);
}

/**
 * Start the hook with the given bindings. Idempotent — calling twice replaces
 * the binding set without restarting the hook.
 *
 * @param {Array<{ actionId: string, combo: string }>} bindings
 */
function start(bindings) {
  if (!bindings || bindings.length === 0) {
    // No global bindings — don't load the native hook at all.
    stop();
    return;
  }
  if (!tryLoad()) return;

  if (!state.matcher) {
    state.matcher = createMatcher({ bindings, holdActions: HOLD_ACTIONS });
    state.matcher.on('trigger', (t) => state.emitter.emit('trigger', t));
  } else {
    state.matcher.setBindings(bindings);
  }

  if (state.running) return;

  try {
    const { uIOhook } = state;
    uIOhook.on('keydown', onUiohookKeyDown);
    uIOhook.on('keyup',   onUiohookKeyUp);
    uIOhook.start();
    state.running = true;
  } catch (err) {
    console.warn('[globalKeybinds] hook start failed:', scrubError(err));
    state.running = false;
  }
}

function onUiohookKeyDown(e) {
  try {
    const token = translateUiohookKey(e.keycode);
    if (!token) return;
    state.matcher?.onKeyDown(token);
  } catch (err) {
    // Never surface raw event data — scrub aggressively.
    console.warn('[globalKeybinds] keydown dispatch error:', scrubError(err));
  }
}

function onUiohookKeyUp(e) {
  try {
    const token = translateUiohookKey(e.keycode);
    if (!token) return;
    state.matcher?.onKeyUp(token);
  } catch (err) {
    console.warn('[globalKeybinds] keyup dispatch error:', scrubError(err));
  }
}

/**
 * Stop the hook. Safe to call when not running.
 */
function stop() {
  if (!state.running || !state.uIOhook) return;
  try {
    state.uIOhook.removeAllListeners('keydown');
    state.uIOhook.removeAllListeners('keyup');
    state.uIOhook.stop();
  } catch (err) {
    console.warn('[globalKeybinds] hook stop failed:', scrubError(err));
  }
  state.running = false;
}

/**
 * Flush modifier state. Called on powerMonitor.resume to prevent stuck
 * modifiers after the OS goes to sleep and wakes up.
 */
function clearHeldKeys() {
  state.matcher?.clearHeldKeys();
}

/**
 * Subscribe to action triggers.
 * @param {(trigger: {actionId: string, phase: 'down' | 'up'}) => void} cb
 */
function onTrigger(cb) {
  state.emitter.on('trigger', cb);
  return () => state.emitter.off('trigger', cb);
}

module.exports = { start, stop, clearHeldKeys, onTrigger };
