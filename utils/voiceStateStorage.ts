// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
const STORAGE_KEY = 'howl_voice_state';

export interface PersistedVoiceState {
  cardSizes: Record<string, { w: number; h: number }>;
  watchingScreenShareUserId: string | null;
  showSelfScreenPreview: boolean;
  focusedScreenKey: string | null;
  shareAudio: boolean;
}

const DEFAULTS: PersistedVoiceState = {
  cardSizes: {},
  watchingScreenShareUserId: null,
  showSelfScreenPreview: true,
  focusedScreenKey: null,
  shareAudio: true,
};

export function loadVoiceState(): PersistedVoiceState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveVoiceState(state: Partial<PersistedVoiceState>): void {
  try {
    const current = loadVoiceState();
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...current, ...state }));
  } catch { /* localStorage quota exceeded or unavailable */ }
}

export function clearVoiceState(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}
