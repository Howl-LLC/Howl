// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * One-call-at-a-time enforcement.
 *
 * A user can be in at most one of: server voice channel, stage, or DM/group
 * call. Call `leaveOtherActiveCalls(nextType)` BEFORE setting up the new
 * call; any other currently-active call is torn down first.
 *
 * Voice and stage state live in useVoiceStore and can be read/written from
 * plain modules. DM call state lives in React (useDmCallState in App.tsx)
 * and isn't reachable from here, so App.tsx registers a leave callback via
 * `setDmCallLeaveFn` once its setters are stable.
 */
import { socketService } from '../services/socket';
import { useVoiceStore } from '../stores/voiceStore';

type CallType = 'voice' | 'stage' | 'dm';

let dmCallLeaveFn: (() => void) | null = null;

/** Registered by App.tsx with a function that tears down any active DM call. */
export function setDmCallLeaveFn(fn: (() => void) | null): void {
  dmCallLeaveFn = fn;
}

export function leaveOtherActiveCalls(nextType: CallType): void {
  const { connectedVoiceChannelId, connectedStageChannelId } = useVoiceStore.getState();

  if (nextType !== 'voice' && connectedVoiceChannelId) {
    socketService.leaveVoiceChannel(connectedVoiceChannelId);
    useVoiceStore.getState().setConnectedVoiceChannelId(null);
    useVoiceStore.getState().setVoiceChannelParticipants([]);
    useVoiceStore.getState().setServerMuted(false);
    useVoiceStore.getState().setServerDeafened(false);
    try { sessionStorage.removeItem('howl_voice_channel'); } catch { /* storage unavailable */ }
  }

  if (nextType !== 'stage' && connectedStageChannelId) {
    socketService.leaveStage(connectedStageChannelId);
    useVoiceStore.getState().setConnectedStageChannelId(null);
    try { localStorage.removeItem('howl_connected_stage_channel'); } catch { /* storage unavailable */ }
  }

  if (nextType !== 'dm') {
    dmCallLeaveFn?.();
  }
}
