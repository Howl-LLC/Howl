// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import streamDeck from '@elgato/streamdeck';
import type { JsonValue } from '@elgato/utils';

/**
 * Token storage backed by Elgato's global settings API.
 *
 * Global settings are persisted by the Stream Deck software across plugin
 * restarts. They are per-plugin, stored as a JSON object. We use the key
 * `howl.token` for the pairing token.
 */

const SETTINGS_KEY = 'howl.token' as const;

interface GlobalSettings {
  [SETTINGS_KEY]?: string;
  [key: string]: JsonValue;
}

/**
 * Store a pairing token in Elgato's global settings.
 */
export async function setToken(token: string): Promise<void> {
  const current = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  await streamDeck.settings.setGlobalSettings({
    ...current,
    [SETTINGS_KEY]: token,
  });
}

/**
 * Retrieve the stored pairing token. Returns null if not set.
 */
export async function getToken(): Promise<string | null> {
  const settings = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  return settings[SETTINGS_KEY] ?? null;
}

/**
 * Clear the stored pairing token (e.g. when pairing is revoked or
 * invalidated by a Howl reinstall).
 */
export async function clearToken(): Promise<void> {
  const current = await streamDeck.settings.getGlobalSettings<GlobalSettings>();
  const updated = { ...current };
  delete updated[SETTINGS_KEY];
  await streamDeck.settings.setGlobalSettings(updated);
}
