// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import type { User } from '../types';
import { apiClient } from '../services/api';
import { useAuthStore } from '../stores/authStore';
import { useServerStore } from '../stores/serverStore';
import { useSocialStore } from '../stores/socialStore';
import { useDmStore } from '../stores/dmStore';

type Status = User['status'];

// Module-level debounce/dedupe state for the outbound status write. Shared
// across auto-idle, manual status changes, Stream Deck, and session restore so
// rapid status churn (hide/show, focus flapping) collapses to a single — often
// zero — network call instead of hammering the per-user status rate limiter.
let _lastSentStatus: Status | null = null;
let _pendingStatus: Status | null = null;
let _syncTimer: ReturnType<typeof setTimeout> | null = null;
const DEBOUNCE_MS = 1500;

/**
 * Optimistically apply the current user's OWN status to every presence surface
 * at once — the status bar (authStore) AND the server member list, friends
 * list, and DM list — so they stay consistent immediately instead of waiting
 * for the server's `presence-update` echo (which the client buffers for up to
 * 30s while the window is hidden). This is the root-cause fix for "online in a
 * server but away in the status bar at the same time".
 */
export function applySelfStatus(status: Status): void {
  const uid = useAuthStore.getState().currentUser?.id;
  useAuthStore.getState().setCurrentUserStatus(status);
  if (!uid) return;
  useServerStore.getState().updateMemberPresence(uid, status);
  useSocialStore.getState().updateFriendPresence(uid, status);
  useDmStore.getState().updateDmChannelPresence(uid, status);
}

function flushStatusSync(): void {
  _syncTimer = null;
  const desired = _pendingStatus;
  _pendingStatus = null;
  if (desired == null || desired === _lastSentStatus) return;
  _lastSentStatus = desired;
  apiClient.updateMyStatus(desired).catch(() => {
    // Permit a later retry of the same value if the write failed.
    if (_lastSentStatus === desired) _lastSentStatus = null;
  });
}

/**
 * Schedule a debounced server write of the user's status. A quick hide/show or
 * rapid focus churn resolves to a single (often zero, since idle→online
 * cancels out) PATCH /auth/me/status. Unchanged values are deduped. Pass
 * `{ immediate: true }` for deliberate user actions (manual status change,
 * Stream Deck, session restore) that should sync right away.
 */
export function syncStatusToServer(status: Status, opts?: { immediate?: boolean }): void {
  _pendingStatus = status;
  if (_syncTimer) { clearTimeout(_syncTimer); _syncTimer = null; }
  if (opts?.immediate) flushStatusSync();
  else _syncTimer = setTimeout(flushStatusSync, DEBOUNCE_MS);
}

/** Optimistic local update across all surfaces + debounced server write. */
export function setSelfStatus(status: Status, opts?: { immediate?: boolean }): void {
  applySelfStatus(status);
  syncStatusToServer(status, opts);
}

/**
 * Record the status the server already knows (e.g. right after session
 * restore) so the next change dedupes against it without an extra write.
 */
export function primeSentStatus(status: Status): void {
  _lastSentStatus = status;
}
