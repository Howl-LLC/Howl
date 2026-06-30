// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { notificationSoundEnabled, streamerSoundsDisabled, allSoundsDisabled, soundNewMessageEnabled, soundCurrentChannelEnabled } from './notificationSoundRef';
import { useAuthStore } from '../stores/authStore';

let audioCtx: AudioContext | null = null;
let lastPlayedAt = 0;
const THROTTLE_MS = 2000;

function playChime(): void {
  try {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
    }
    const ctx = audioCtx;
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    const note = (freq: number, start: number, dur: number, vol: number) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.value = freq;
      g.gain.setValueAtTime(vol, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      osc.connect(g).connect(ctx.destination);
      osc.start(ctx.currentTime + start);
      osc.stop(ctx.currentTime + start + dur);
    };

    // Two-note ascending chime — subtle and brief (~150ms)
    note(800, 0, 0.06, 0.15);
    note(1200, 0.05, 0.08, 0.12);
  } catch { /* no audio support */ }
}

/**
 * Play a short two-note ascending chime for incoming message notifications.
 * Throttled to max 1 play per 2 seconds. Respects streamer mode, master kill switch, and per-type prefs.
 * @param isActiveChannel true when the message is in the currently viewed channel (but tab hidden or user idle)
 */
export function playMessageNotification(isActiveChannel = false): void {
  if (!notificationSoundEnabled.current) return;
  if (streamerSoundsDisabled.current) return;
  if (allSoundsDisabled.current) return;
  // Suppress notification sounds when user is in Do Not Disturb mode
  if (useAuthStore.getState().currentUserStatus === 'dnd') return;
  if (isActiveChannel && !soundCurrentChannelEnabled.current) return;
  if (!isActiveChannel && !soundNewMessageEnabled.current) return;

  const now = Date.now();
  if (now - lastPlayedAt < THROTTLE_MS) return;
  lastPlayedAt = now;

  playChime();
}

/** Play the notification chime immediately for settings preview — ignores throttle and all enabled/disabled checks. */
export function playNotificationPreview(): void {
  playChime();
}
