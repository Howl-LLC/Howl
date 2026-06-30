// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { MustUpdateReason } from '../shared/protocol';

export type UpdateStage = 'idle' | 'checking' | 'downloading' | 'ready' | 'failed';

interface UpdateState {
  required: boolean;
  reason: MustUpdateReason | null;
  stage: UpdateStage;
  progress: number; // 0-100 during downloading
  recommended: boolean; // soft warning banner
  recommendedDismissed: boolean; // session-scoped; suppresses re-raise on reconnect

  setRequired(reason: MustUpdateReason): void;
  setRecommended(value: boolean): void;
  setStage(stage: UpdateStage): void;
  setProgress(progress: number): void;
  dismissRecommended(): void;
  reset(): void;
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  required: false,
  reason: null,
  stage: 'idle',
  progress: 0,
  recommended: false,
  recommendedDismissed: false,

  setRequired(reason) { set({ required: true, reason, stage: 'checking' }); },
  setRecommended(value) {
    // If the user dismissed the banner this session, don't re-raise it on
    // reconnect. A page reload clears the flag (Zustand is session-scoped).
    if (value && get().recommendedDismissed) return;
    set({ recommended: value });
  },
  setStage(stage) { set({ stage }); },
  setProgress(progress) { set({ progress }); },
  dismissRecommended() { set({ recommended: false, recommendedDismissed: true }); },
  reset() { set({ required: false, reason: null, stage: 'idle', progress: 0 }); },
}));
