// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { Channel } from '../types';

/**
 * Shared helpers for computing channel/category reorder updates.
 *
 * Used by both the server-settings drag UI (`ChannelsSection.tsx`) and the
 * Classic-layout left bar (`ClassicChannelTree.tsx`). Keeping the math in
 * one place ensures the two views produce identical payloads for the same
 * gesture, which matters because the server broadcasts a single
 * `channels-reordered` socket event that both views consume — divergent
 * math here would manifest as positions flipping when the user drags in
 * one place and watches the other.
 */

export interface ChannelReorderUpdate {
  id: string;
  position: number;
  categoryId: string | null;
}

export interface CategoryReorderUpdate {
  id: string;
  position: number;
}

/** Group channels by their categoryId (null bucket for uncategorized),
 *  sorting each bucket by its current position. */
function groupChannelsByCategory(channels: ReadonlyArray<Channel>): Map<string | null, Channel[]> {
  const map = new Map<string | null, Channel[]>();
  for (const ch of channels) {
    const key = ch.categoryId ?? null;
    let arr = map.get(key);
    if (!arr) { arr = []; map.set(key, arr); }
    arr.push(ch);
  }
  for (const arr of map.values()) {
    arr.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  }
  return map;
}

/**
 * Compute the list of channel updates needed to move `draggedId` to
 * `targetCategoryId` at `targetIndex` (the index it should occupy AFTER
 * the move within the target category's channel list).
 *
 * Returns the full set of updates needed — for cross-category moves this
 * includes BOTH the target category's new ordering AND the source
 * category's gap-closed ordering, so the API gets a single coherent batch.
 *
 * Returns `null` for genuine no-ops (same-category move where the index
 * doesn't actually change anything), so callers can skip the API round-trip.
 */
export function computeChannelMove(args: {
  channels: ReadonlyArray<Channel>;
  draggedId: string;
  targetCategoryId: string | null;
  targetIndex: number;
}): ChannelReorderUpdate[] | null {
  const { channels, draggedId, targetCategoryId, targetIndex } = args;
  const dragged = channels.find(c => c.id === draggedId);
  if (!dragged) return null;

  const byCategory = groupChannelsByCategory(channels);
  const sourceCategoryId = dragged.categoryId ?? null;
  const targetList = [...(byCategory.get(targetCategoryId) ?? [])];

  if (sourceCategoryId === targetCategoryId) {
    const srcIdx = targetList.findIndex(c => c.id === draggedId);
    if (srcIdx === -1) return null;
    // Same-category no-ops: dropping at the current index, or dropping
    // immediately after the dragged item (which collapses to the same
    // ordering once the item is removed-and-reinserted).
    if (srcIdx === targetIndex || srcIdx === targetIndex - 1) return null;
    targetList.splice(srcIdx, 1);
    // After removing from earlier in the list, the target index needs
    // to shift back by one to land on the user-visible drop slot.
    const insertAt = srcIdx < targetIndex ? targetIndex - 1 : targetIndex;
    targetList.splice(insertAt, 0, dragged);
  } else {
    // Cross-category move: clamp index into [0, targetList.length].
    const insertAt = Math.max(0, Math.min(targetIndex, targetList.length));
    targetList.splice(insertAt, 0, dragged);
  }

  const updates: ChannelReorderUpdate[] = targetList.map((ch, i) => ({
    id: ch.id,
    position: i,
    categoryId: targetCategoryId,
  }));

  if (sourceCategoryId !== targetCategoryId) {
    const sourceList = (byCategory.get(sourceCategoryId) ?? []).filter(c => c.id !== draggedId);
    sourceList.forEach((ch, i) => {
      updates.push({ id: ch.id, position: i, categoryId: sourceCategoryId });
    });
  }

  return updates.length > 0 ? updates : null;
}

/**
 * Compute updates to reorder categories. `targetIndex` is the index the
 * dragged category should occupy AFTER the move.
 *
 * Returns `null` for no-ops.
 */
export function computeCategoryMove<T extends { id: string; position?: number }>(args: {
  categories: ReadonlyArray<T>;
  draggedId: string;
  targetIndex: number;
}): CategoryReorderUpdate[] | null {
  const { categories, draggedId, targetIndex } = args;
  const ordered = [...categories].sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const fromIdx = ordered.findIndex(c => c.id === draggedId);
  if (fromIdx === -1) return null;
  if (fromIdx === targetIndex || fromIdx === targetIndex - 1) return null;
  const insertAt = fromIdx < targetIndex ? targetIndex - 1 : targetIndex;
  const [item] = ordered.splice(fromIdx, 1);
  ordered.splice(insertAt, 0, item);
  return ordered.map((c, i) => ({ id: c.id, position: i }));
}
