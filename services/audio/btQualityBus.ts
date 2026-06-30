// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Thin pub/sub bridge for BtQualityStatus events.
 *
 * The call engine (created at a React ancestor component that doesn't consume
 * the useBluetoothQuality hook) publishes status updates here. The hook
 * subscribes on mount to relay them into its local state for banner/badge UI.
 *
 * This is intentionally NOT a React context — it lives outside the render
 * tree so the engine's callback can publish without touching the component
 * lifecycle.
 */

import type { BtQualityStatus } from './btQualityDetector';

type Listener = (s: BtQualityStatus | null) => void;

const listeners = new Set<Listener>();
let current: BtQualityStatus | null = null;

/** Publish the latest BT quality status to all subscribers. */
export function publishBtQualityStatus(s: BtQualityStatus | null): void {
  current = s;
  for (const l of listeners) l(s);
}

/**
 * Subscribe to status updates. The listener is immediately called with the
 * current value (if any) for "catch up" semantics. Returns an unsubscribe fn.
 */
export function subscribeBtQualityBus(l: Listener): () => void {
  listeners.add(l);
  if (current !== null) l(current);
  return () => { listeners.delete(l); };
}

/** For tests only — reset bus state. Don't use in production code. */
export function _resetBtQualityBus(): void {
  listeners.clear();
  current = null;
}
