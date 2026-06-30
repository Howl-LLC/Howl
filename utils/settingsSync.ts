// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { apiClient } from '../services/api';
import {
  getStoredAccessibility, getStoredChatSettings, getStoredKeybinds,
  getStoredStreamer, getStoredVoice, getStoredLanguage, getStoredTimeFormat, getStoredAdvanced,
  getStoredGameOverlay, getStoredBluetoothAudio, getStoredBtDevicePreferences,
} from './settingsStorage';
import {
  getStoredUiDensity, getStoredChatMessageDisplay,
  getStoredMessageGroupSpacing, getStoredChatFontSize,
  getStoredMentionHighlightColor, getStoredServerLayout,
} from './uiDensityStorage';

/** localStorage key gating whether the first-run layout picker modal has
 *  been shown for this account on this device. Mirrored to the server in
 *  the settings blob (`hasSeenLayoutPicker`) so a second device sign-in
 *  doesn't re-prompt the user. Defined here so SettingsContext can write
 *  the flag on inbound server sync without importing the modal component
 *  (which would create a cycle: modal → useSettings → context → modal). */
export const LAYOUT_PICKER_SEEN_KEY = 'howl_has_seen_layout_picker';

/** Custom event fired when applyServerSettings discovers the seen flag in
 *  the inbound blob and writes it to localStorage. App.tsx listens for it
 *  and dismisses the picker if it's currently mounted. Same-tab updates
 *  don't fire native `storage` events, so we need our own. */
export const LAYOUT_PICKER_SEEN_EVENT = 'howl:layout-picker-seen';

/** Shape of the settings blob stored on the server */
export interface SettingsBlob {
  theme?: string;
  uiDensity?: string;
  chatMessageDisplay?: string;
  messageGroupSpacing?: number;
  chatFontSize?: number;
  mentionHighlightColor?: string;
  serverLayout?: string;
  /** True once the user has confirmed (or skipped) the first-run layout
   *  picker on any device. Synced server-side so signing in elsewhere
   *  doesn't re-prompt. */
  hasSeenLayoutPicker?: boolean;
  accessibility?: Record<string, unknown>;
  chat?: Record<string, unknown>;
  keybinds?: Array<Record<string, unknown>>;
  streamer?: Record<string, unknown>;
  voice?: Record<string, unknown>;
  language?: string;
  timeFormat?: string;
  advanced?: Record<string, unknown>;
  gameOverlay?: Record<string, unknown>;
  bluetoothAudio?: Record<string, unknown>;
  btDevicePreferences?: Array<Record<string, unknown>>;
  pinnedActivityServers?: string[];
}

const DEVICE_SPECIFIC_VOICE_KEYS = ['selectedMicId', 'selectedSpeakerId', 'selectedCameraId'];
const DEVICE_SPECIFIC_ADVANCED_KEYS = ['hardwareAcceleration'];

/** Collect current settings from localStorage into a sync-ready blob */
export function collectSettingsBlob(): SettingsBlob {
  const voice: Record<string, unknown> = { ...getStoredVoice() };
  for (const key of DEVICE_SPECIFIC_VOICE_KEYS) delete voice[key];

  const advanced: Record<string, unknown> = { ...getStoredAdvanced() };
  for (const key of DEVICE_SPECIFIC_ADVANCED_KEYS) delete advanced[key];

  return {
    theme: localStorage.getItem('howl_app_theme') ?? 'void',
    uiDensity: getStoredUiDensity() ?? 'default',
    chatMessageDisplay: getStoredChatMessageDisplay() ?? 'default',
    messageGroupSpacing: getStoredMessageGroupSpacing() ?? 16,
    chatFontSize: getStoredChatFontSize() ?? 16,
    mentionHighlightColor: getStoredMentionHighlightColor(),
    serverLayout: getStoredServerLayout(),
    hasSeenLayoutPicker: (() => {
      try { return localStorage.getItem(LAYOUT_PICKER_SEEN_KEY) === '1'; } catch { return false; }
    })(),
    accessibility: { ...getStoredAccessibility() },
    chat: { ...getStoredChatSettings() },
    keybinds: getStoredKeybinds().map(k => ({ ...k })),
    streamer: { ...getStoredStreamer() },
    voice,
    language: getStoredLanguage(),
    timeFormat: getStoredTimeFormat(),
    advanced,
    gameOverlay: { ...getStoredGameOverlay() },
    bluetoothAudio: { ...getStoredBluetoothAudio() },
    btDevicePreferences: getStoredBtDevicePreferences().map(p => ({ ...p })),
    pinnedActivityServers: (() => {
      try {
        const raw = localStorage.getItem('howl_pinned_activity_servers');
        return raw ? JSON.parse(raw) : [];
      } catch { return []; }
    })(),
  };
}

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Timestamp of the most recent `updatedAt` WE received back from our own
 * PUT /api/settings call. Compared against incoming `settings-updated`
 * socket events: if an event's updatedAt matches one we already saw, it
 * is our own echo and applyServerSettings will no-op (saves a pointless
 * roundtrip through the store that can race with an in-flight edit).
 */
let lastLocallyObservedUpdatedAt: string | null = null;

export function getLastLocallyObservedUpdatedAt(): string | null {
  return lastLocallyObservedUpdatedAt;
}

/** Push current settings to the server immediately and return the
 *  server-reported `updatedAt`. Used by flushSyncToServer() below. */
async function syncNow(): Promise<void> {
  try {
    const blob = collectSettingsBlob();
    const resp = await apiClient.saveSettings(blob as Record<string, unknown>);
    if (resp && typeof (resp as { updatedAt?: string }).updatedAt === 'string') {
      lastLocallyObservedUpdatedAt = (resp as { updatedAt: string }).updatedAt;
    }
  } catch {
    // Graceful degradation — will retry on next change. Keeping
    // lastLocallyObservedUpdatedAt untouched means the next successful
    // save wins and echo dedup stays correct.
  }
}

/**
 * Debounced push of current settings to server. Dropped from 2000ms →
 * 500ms so a user who edits and immediately closes the tab has a much
 * smaller window in which unsynced localStorage diverges from the
 * server. A beforeunload flush (flushSyncToServer) catches the rest.
 */
export function scheduleSyncToServer(): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void syncNow();
  }, 500);
}

/**
 * Flush any pending debounced sync synchronously. Call on
 * `beforeunload` / `visibilitychange hidden` / settings-modal close so
 * a quick "edit + close the app" doesn't leave the server out of date
 * (which would cause a login-time fetchAndApplyServerSettings to roll
 * the user's local edits back to the stale server values).
 */
export function flushSyncToServer(): void {
  if (!syncTimer) return;
  clearTimeout(syncTimer);
  syncTimer = null;
  void syncNow();
}

/** Fetch server settings and apply if they exist. Call once on login. */
export async function fetchAndApplyServerSettings(applyFn: (blob: SettingsBlob) => void): Promise<void> {
  try {
    const { data, updatedAt } = await apiClient.getSettings() as { data: unknown; updatedAt: string | null };
    applyServerSettings({ data, updatedAt }, applyFn);
  } catch {
    // Graceful degradation — use local settings
  }
}

/**
 * Apply a settings blob that was already fetched (e.g. via the /bootstrap
 * aggregate endpoint). Same semantics as fetchAndApplyServerSettings but
 * skips the redundant network round trip.
 */
export function applyServerSettings(
  payload: { data: unknown; updatedAt: string | null },
  applyFn: (blob: SettingsBlob) => void,
): void {
  if (!payload.data) {
    // No server settings yet — push local as initial seed
    scheduleSyncToServer();
    return;
  }
  if (payload.updatedAt) lastLocallyObservedUpdatedAt = payload.updatedAt;
  applyFn(payload.data as SettingsBlob);
}
