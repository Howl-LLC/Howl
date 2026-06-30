// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Lightweight base helpers for Howl Stream Deck actions.
 *
 * This is NOT a base class — SingletonAction must remain the direct
 * superclass for the @action() decorator to work. Instead, these are
 * free functions that actions can import.
 */

import type { JsonObject, JsonValue } from '@elgato/utils';
import streamDeck, { type KeyAction, type Action, type ActionContext, type SendToPluginEvent } from '@elgato/streamdeck';
import type { Topic } from '../../protocol/types.js';
import { Connection } from '../../state/connection.js';
import { renderPairPrompt } from './render.js';

/** Union of all action reference types the SDK surfaces in events. */
type AnyAction = ActionContext | Action<JsonObject> | KeyAction<JsonObject>;

/**
 * Tracks unsubscribe functions per-action-context so we can clean up
 * state subscriptions when an action disappears from the Stream Deck.
 */
const unsubs = new Map<string, (() => void)[]>();

/**
 * Subscribe to a bridge state topic for a specific action context.
 * Returns the unsubscribe function (also tracked for cleanup via `cleanupAction`).
 */
export function subscribeTopic(
  actionId: string,
  topic: Topic,
  cb: (data: unknown, isSnapshot: boolean) => void,
): () => void {
  const conn = Connection.get();
  const off = conn.onChange(topic, cb);

  let list = unsubs.get(actionId);
  if (!list) {
    list = [];
    unsubs.set(actionId, list);
  }
  list.push(off);

  return off;
}

/**
 * Unsubscribe all tracked listeners for an action context.
 * Call from `onWillDisappear`.
 */
export function cleanupAction(actionId: string): void {
  const list = unsubs.get(actionId);
  if (list) {
    for (const off of list) {
      try { off(); } catch { /* swallow */ }
    }
    unsubs.delete(actionId);
  }
}

/**
 * Get a unique identifier for an action event's context.
 * Uses the internal context string from the SDK.
 */
export function actionId(action: AnyAction): string {
  return action.id;
}

/**
 * Show a brief alert flash on the action, then re-render.
 * Uses the SDK's built-in showAlert() which flashes a yellow triangle.
 */
export async function flashError(action: AnyAction): Promise<void> {
  try {
    // showAlert() exists on Action/KeyAction but not on bare ActionContext.
    if ('showAlert' in action && typeof action.showAlert === 'function') {
      await (action as Action<JsonObject>).showAlert();
    }
  } catch {
    // Ignore — the action may have disappeared.
  }
}

/**
 * Get current state snapshot for a topic.
 */
export function getState(topic: Topic): unknown {
  return Connection.get().getState(topic);
}

/**
 * Subscribe an action to pair-pending state changes. While the connection
 * is pair-pending, every Howl action key should render the pair-prompt
 * screen. When the user clicks Allow / Deny in Howl the state clears and
 * actions re-render their normal icons.
 *
 * Returns the unsubscribe (also tracked in the per-action cleanup map).
 */
export function subscribePairPending(
  actionId: string,
  cb: () => void,
): () => void {
  const conn = Connection.get();
  const off = conn.onPairPendingChange(() => cb());

  let list = unsubs.get(actionId);
  if (!list) {
    list = [];
    unsubs.set(actionId, list);
  }
  list.push(off);

  return off;
}

/**
 * If the plugin is currently in pair-pending state, render the
 * "OPEN HOWL TO PAIR" key image and return true. Action `render()`
 * methods should call this first and bail early if it returns true.
 */
export async function maybeRenderPairPrompt(action: AnyAction): Promise<boolean> {
  if (!Connection.get().isPairPending) return false;
  try {
    const image = await renderPairPrompt();
    if ('isKey' in action && typeof (action as { isKey?: () => boolean }).isKey === 'function'
        && (action as { isKey: () => boolean }).isKey()) {
      await (action as KeyAction<JsonObject>).setImage(image);
    }
  } catch {
    // Swallow — action may have disappeared between event and render.
  }
  return true;
}

/**
 * Execute an action on the Howl renderer via the bridge.
 */
export async function executeAction(action: string, params?: Record<string, unknown>): Promise<unknown> {
  return Connection.get().executeAction(action, params);
}

/**
 * Handle `sendToPlugin` messages from a Property Inspector. Actions delegate
 * to this helper from their `onSendToPlugin` override. The shared message
 * types are:
 *
 *   { type: 'list', resource, params }     PI requests resource list
 *   { type: 'pair-state-query' }           PI asks for current pair state
 *   { type: 'retry-pair' }                 PI requests a fresh pair attempt
 *
 * Responses (sent via `streamDeck.ui.sendToPropertyInspector`):
 *
 *   { type: 'list-response', resource, data }
 *   { type: 'list-error', resource, error }
 *   { type: 'pair-state', fingerprint }    fingerprint = { words, display } or null
 */
export async function handleListFromPI(
  ev: SendToPluginEvent<JsonValue, JsonObject>,
): Promise<void> {
  const p = ev.payload as { type?: string; resource?: string; params?: Record<string, unknown> } | undefined;
  if (!p || typeof p.type !== 'string') return;

  if (p.type === 'list' && typeof p.resource === 'string') {
    try {
      const data = await Connection.get().listResources(p.resource, p.params);
      await streamDeck.ui.sendToPropertyInspector({
        type: 'list-response',
        resource: p.resource,
        data: data as JsonValue,
      } as JsonValue);
    } catch (err) {
      await streamDeck.ui.sendToPropertyInspector({
        type: 'list-error',
        resource: p.resource,
        error: String(err),
      } as JsonValue);
    }
    return;
  }

  if (p.type === 'pair-state-query') {
    await streamDeck.ui.sendToPropertyInspector({
      type: 'pair-state',
      pending: Connection.get().isPairPending,
    } as JsonValue);
    return;
  }

  if (p.type === 'retry-pair') {
    // Fire-and-forget. The Connection's onPairFingerprintChange listener
    // (wired in plugin.ts) will broadcast the new fingerprint to the PI.
    void Connection.get().requestPairing().catch(() => { /* swallow */ });
    return;
  }
}
