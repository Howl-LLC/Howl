// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/** Module-level mutable refs for notification sound gating — importable from hooks without prop drilling. */
export const notificationSoundEnabled = { current: true };
export const streamerSoundsDisabled = { current: false };

/** User pref: play sound for new messages in other channels (notifySoundNewMessage) */
export const soundNewMessageEnabled = { current: true };
/** User pref: play sound for new messages in the current/active channel when tab hidden or idle (notifySoundCurrentChannel) */
export const soundCurrentChannelEnabled = { current: true };
/** User pref: master kill switch — disable ALL notification sounds (notifyDisableAllSounds) */
export const allSoundsDisabled = { current: false };
/** User pref: play ringtone on incoming call (notifySoundIncomingRing). Only gates 'ring', not 'ringback'. */
export const incomingRingEnabled = { current: true };

/** User pref: allow the Electron OS taskbar/dock unread badge (notifyUnreadBadge) */
export const unreadBadgeEnabled = { current: true };
/** User pref: allow Windows taskbar flashFrame on new mentions (notifyTaskbarFlash) */
export const taskbarFlashEnabled = { current: true };
/** User pref: desktop notification permission (notifyDesktop) — renderer-side Notification gate */
export const desktopNotificationsEnabled = { current: true };
