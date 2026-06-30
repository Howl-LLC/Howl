// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
'use strict';

/**
 * Pure combo matcher. Maintains the set of currently-held key tokens
 * (modifiers + activation keys), matches incoming key events against
 * registered bindings, and emits {actionId, phase} triggers through an
 * EventEmitter.
 *
 * @typedef {{ actionId: string, combo: string }} Binding
 * @typedef {{ actionId: string, phase: 'down' | 'up' }} Trigger
 */

const { EventEmitter } = require('events');

const MODIFIER_TOKENS = new Set([
  'LCtrl', 'RCtrl', 'LShift', 'RShift',
  'LAlt',  'RAlt',  'LMeta',  'RMeta',
]);

/**
 * Parse a combo string like "LCtrl+LShift+KeyM" into { modifiers, activation }.
 * Returns null if the combo has no non-modifier token (unbindable).
 *
 * @param {string} combo
 * @returns {{ modifiers: Set<string>, activation: string } | null}
 */
function parseCombo(combo) {
  if (!combo) return null;
  const tokens = combo.split('+');
  const modifiers = new Set();
  let activation = null;
  for (const t of tokens) {
    if (MODIFIER_TOKENS.has(t)) modifiers.add(t);
    else activation = t;    // last non-modifier wins (combos only have one)
  }
  if (!activation) return null;
  return { modifiers, activation };
}

/**
 * Index bindings by activation key for O(1) lookup on key events.
 *
 * @param {Binding[]} bindings
 * @returns {Map<string, Array<{ actionId: string, modifiers: Set<string> }>>}
 */
function indexByActivation(bindings) {
  const index = new Map();
  for (const b of bindings) {
    const parsed = parseCombo(b.combo);
    if (!parsed) continue;
    const bucket = index.get(parsed.activation) || [];
    bucket.push({ actionId: b.actionId, modifiers: parsed.modifiers });
    index.set(parsed.activation, bucket);
  }
  return index;
}

/**
 * Does the current held-modifier set satisfy `required`?
 * Required modifiers must all be held; extra held modifiers are fine
 * (e.g., CapsLock being on doesn't break the match).
 *
 * @param {Set<string>} held
 * @param {Set<string>} required
 */
function modifiersSatisfied(held, required) {
  for (const r of required) if (!held.has(r)) return false;
  return true;
}

/**
 * @param {{ bindings: Binding[], holdActions: Set<string> }} opts
 */
function createMatcher({ bindings, holdActions }) {
  const emitter = new EventEmitter();
  const held = new Set();               // all currently-held tokens
  // Activation keys that have already produced a 'down' event and are waiting
  // on their 'up' (prevents OS key-repeat from firing multiple times, tracks
  // which hold-action to release on keyup).
  const pendingUp = new Map();          // activationToken -> actionId
  let index = indexByActivation(bindings);

  function matchDown(token) {
    // Modifier key pressed — just track state, no matching yet.
    if (MODIFIER_TOKENS.has(token)) {
      held.add(token);
      return;
    }
    // Suppress OS key-repeat: if already held, don't fire again.
    if (held.has(token)) return;
    held.add(token);

    const candidates = index.get(token);
    if (!candidates) return;
    for (const c of candidates) {
      if (!modifiersSatisfied(held, c.modifiers)) continue;
      emitter.emit('trigger', { actionId: c.actionId, phase: 'down' });
      if (holdActions.has(c.actionId)) {
        pendingUp.set(token, c.actionId);
      }
      break;          // at most one action per keydown
    }
  }

  function matchUp(token) {
    held.delete(token);
    if (MODIFIER_TOKENS.has(token)) return;
    const actionId = pendingUp.get(token);
    if (actionId) {
      pendingUp.delete(token);
      emitter.emit('trigger', { actionId, phase: 'up' });
    }
  }

  return {
    on: (evt, cb) => emitter.on(evt, cb),
    onKeyDown: matchDown,
    onKeyUp:   matchUp,
    clearHeldKeys: () => {
      held.clear();
      // Any pending hold-release triggers also flush as 'up' so mic doesn't
      // stay hot across sleep/wake. This is intentional.
      for (const [, actionId] of pendingUp) {
        emitter.emit('trigger', { actionId, phase: 'up' });
      }
      pendingUp.clear();
    },
    setBindings: (next) => { index = indexByActivation(next); },
  };
}

module.exports = { createMatcher, parseCombo };
