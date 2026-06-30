// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { describe, it, expect } from 'vitest';
import { createMatcher } from '../electron/globalKeybindsMatcher.js';

const HOLD_ACTIONS = new Set(['pushToTalk', 'pushToMute', 'openSoundboardHold']);

describe('globalKeybindsMatcher', () => {
  it('fires a toggle action once on keydown when all modifiers held', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'toggleMute', combo: 'LCtrl+LShift+KeyM' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('LCtrl');
    m.onKeyDown('LShift');
    m.onKeyDown('KeyM');

    expect(triggers).toEqual([{ actionId: 'toggleMute', phase: 'down' }]);
  });

  it('does not fire on keydown when a required modifier is missing', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'toggleMute', combo: 'LCtrl+LShift+KeyM' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('LCtrl');
    m.onKeyDown('KeyM');                 // LShift missing

    expect(triggers).toEqual([]);
  });

  it('distinguishes LCtrl from RCtrl (side-specific modifiers)', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'toggleMute', combo: 'LCtrl+KeyM' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('RCtrl');
    m.onKeyDown('KeyM');

    expect(triggers).toEqual([]);
  });

  it('fires hold actions on both keydown and keyup of activation key', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'pushToTalk', combo: 'LCtrl+KeyP' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('LCtrl');
    m.onKeyDown('KeyP');
    m.onKeyUp('KeyP');

    expect(triggers).toEqual([
      { actionId: 'pushToTalk', phase: 'down' },
      { actionId: 'pushToTalk', phase: 'up' },
    ]);
  });

  it('fires hold `up` even after modifiers already released', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'pushToTalk', combo: 'LCtrl+KeyP' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('LCtrl');
    m.onKeyDown('KeyP');
    m.onKeyUp('LCtrl');      // release ctrl first (common case)
    m.onKeyUp('KeyP');       // then release P

    expect(triggers.map(t => t.phase)).toEqual(['down', 'up']);
  });

  it('does not re-fire toggle when held key repeats (no key-repeat dispatch)', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'toggleMute', combo: 'KeyM' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('KeyM');
    m.onKeyDown('KeyM');           // OS key-repeat — ignored
    m.onKeyDown('KeyM');

    expect(triggers).toHaveLength(1);
  });

  it('clearHeldKeys() resets modifier state (used on sleep/wake)', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'toggleMute', combo: 'LCtrl+KeyM' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.onKeyDown('LCtrl');
    m.clearHeldKeys();
    m.onKeyDown('KeyM');            // LCtrl forgotten — should not fire

    expect(triggers).toEqual([]);
  });

  it('setBindings() atomically replaces the binding set', () => {
    const m = createMatcher({
      bindings: [{ actionId: 'old', combo: 'LCtrl+KeyM' }],
      holdActions: HOLD_ACTIONS,
    });
    const triggers = [];
    m.on('trigger', (t) => triggers.push(t));

    m.setBindings([{ actionId: 'new', combo: 'LCtrl+KeyM' }]);

    m.onKeyDown('LCtrl');
    m.onKeyDown('KeyM');

    expect(triggers).toEqual([{ actionId: 'new', phase: 'down' }]);
  });
});
