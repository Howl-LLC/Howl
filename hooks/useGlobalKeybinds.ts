// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef, useCallback } from 'react';
import type { KeybindEntry } from '../utils/settingsStorage';
import {
  buildComboFromEvent,
  currentComboForEvent,
  isCaptureActive,
  isModifierCode,
  migrateLegacyCombo,
  isLegacyCombo,
  formatComboText,
} from '../utils/keybindFormat';
import { useUpdateStore } from '../stores/updateStore';

/**
 * A keybind action. Called with `'down'` on activation-key press and
 * (only for hold-actions like pushToTalk) `'up'` on release. Non-hold
 * actions only receive `'down'` — they can ignore the phase entirely.
 */
export type KeybindHandler = (phase: 'down' | 'up') => void;
export type KeybindActions = Record<string, KeybindHandler>;

export const HOLD_ACTIONS: ReadonlySet<string> = new Set([
  'pushToTalk',
  'pushToMute',
  'openSoundboardHold',
]);

/** React event wrapper for components still using synchronous capture. */
export function captureKeyCombo(e: KeyboardEvent): string | null {
  return buildComboFromEvent(e);
}

/** @deprecated Use `formatComboText` / `formatComboDisplay` from utils/keybindFormat. */
export function keybindDisplayString(keys: string): string {
  return formatComboText(keys);
}

export function useGlobalKeybinds(
  keybinds: KeybindEntry[],
  actions: KeybindActions,
  enabled = true,
) {
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const bindsRef = useRef(keybinds);
  bindsRef.current = keybinds;

  // DOM path: handles bindings with global !== true
  // Track which hold-activation-key-code is currently firing via DOM so we
  // know which action to release on keyup.
  const pendingUpRef = useRef<Map<string, string>>(new Map());

  const fireAction = useCallback((actionId: string, phase: 'down' | 'up') => {
    const fn = actionsRef.current[actionId];
    if (fn) fn(phase);
  }, []);

  const handler = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;
    // Suppress all global keybinds while the blocking update modal is active.
    // The modal's own keys (Esc, Enter, Tab for focus-trap) still work because
    // useFocusTrap attaches its listener to the document at capture phase on
    // the modal element — it fires regardless. We only suppress application
    // shortcuts (push-to-talk, navigation, etc.) here.
    if (useUpdateStore.getState().required) return;
    if (isCaptureActive()) return;
    if (isModifierCode(e.code)) return;

    const target = e.target as HTMLElement;
    const inTextInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
    const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
    if (inTextInput && !hasModifier) return;
    // Exempt standard text-editing shortcuts when focus is in a text field.
    // Otherwise a user-configured combo like Ctrl+Shift+V (toggleCamera default)
    // will steal Ctrl+Shift+V from the composer's paste-as-plaintext path,
    // and similar for Ctrl+V/C/X/A/Z/Y. The bind still works outside text fields.
    if (inTextInput && hasModifier && !e.altKey && (e.ctrlKey || e.metaKey)) {
      const k = e.key.toLowerCase();
      if (k === 'v' || k === 'c' || k === 'x' || k === 'a' || k === 'z' || k === 'y') return;
    }

    const combo = currentComboForEvent(e);
    if (!combo) return;

    for (const bind of bindsRef.current) {
      if (!bind.enabled) continue;
      // Skip global bindings — handled via IPC below.
      if (bind.global) continue;
      const storedCombo = isLegacyCombo(bind.keys) ? migrateLegacyCombo(bind.keys) : bind.keys;
      if (storedCombo !== combo) continue;

      e.preventDefault();
      e.stopPropagation();
      fireAction(bind.action, 'down');
      if (HOLD_ACTIONS.has(bind.action)) {
        // Record so keyup matches on activation key alone (don't require
        // modifiers to still be held — see keybindFormat PTT rationale).
        const parts = storedCombo.split('+');
        const activation = parts[parts.length - 1];
        pendingUpRef.current.set(activation, bind.action);
      }
      break;
    }
  }, [enabled, fireAction]);

  const upHandler = useCallback((e: KeyboardEvent) => {
    if (!enabled) return;
    // When the update modal activates mid-hold (e.g., push-to-talk is held
    // when must-update fires), release any pending hold actions immediately
    // so the mic doesn't stay hot behind the modal. The keyup still fires
    // for the pending action but no new keydown will be accepted.
    if (useUpdateStore.getState().required) {
      const actionId = pendingUpRef.current.get(e.code);
      if (actionId) {
        pendingUpRef.current.delete(e.code);
        fireAction(actionId, 'up');
      }
      return;
    }
    const actionId = pendingUpRef.current.get(e.code);
    if (!actionId) return;
    pendingUpRef.current.delete(e.code);
    fireAction(actionId, 'up');
  }, [enabled, fireAction]);

  useEffect(() => {
    document.addEventListener('keydown', handler, true);
    document.addEventListener('keyup', upHandler, true);
    const clearOnBlur = () => {
      // Release any in-flight hold so mic doesn't stay hot when the window
      // loses focus.
      for (const [, actionId] of pendingUpRef.current) {
        fireAction(actionId, 'up');
      }
      pendingUpRef.current.clear();
    };
    window.addEventListener('blur', clearOnBlur);
    return () => {
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('keyup', upHandler, true);
      window.removeEventListener('blur', clearOnBlur);
    };
  }, [handler, upHandler, fireAction]);

  // IPC path: handles bindings with global === true (Electron only)
  useEffect(() => {
    if (!enabled) return;
    const electron = (window as any).electron;
    if (!electron?.keybinds?.onTrigger) return;        // web — no-op

    const unsubscribe = electron.keybinds.onTrigger((trigger: { actionId: string; phase: 'down' | 'up' }) => {
      // Ignore if the action isn't registered locally (renderer owns the
      // allowlist — main can't force an unknown action).
      if (!actionsRef.current[trigger.actionId]) return;
      // Suppress global keybinds while the blocking update modal is active.
      if (useUpdateStore.getState().required) return;
      fireAction(trigger.actionId, trigger.phase);
    });
    return () => unsubscribe?.();
  }, [enabled, fireAction]);
}
