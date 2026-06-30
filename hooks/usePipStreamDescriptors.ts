// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useMemo, useRef } from 'react';
import { useVoiceStore } from '../stores/voiceStore';
import { useViewerStore } from '../stores/viewerStore';
import { useAuthStore } from '../stores/authStore';
import type { PipStreamDesc } from './usePipState';
import { makeStreamKey, type StreamContext } from '../stores/types';

/**
 * Returns a stable first-seen timestamp for a stream descriptor key.
 * Avoids resetting startedAt on every memo recomputation so
 * usePipState.selectStream can use recency as a meaningful tiebreaker.
 */
function useStartedAtMap() {
  const ref = useRef<Map<string, number>>(new Map());
  return {
    getOrSeed(ownerId: string, type: 'camera' | 'screen'): number {
      const key = `${ownerId}:${type}`;
      const existing = ref.current.get(key);
      if (existing !== undefined) return existing;
      const t = Date.now();
      ref.current.set(key, t);
      return t;
    },
    /** Remove entries whose key is not in the given set. */
    prune(activeKeys: Set<string>) {
      for (const key of ref.current.keys()) {
        if (!activeKeys.has(key)) ref.current.delete(key);
      }
    },
  };
}

/**
 * Flattens the current call's participants + local publishers into a single
 * PipStreamDesc[] array. Works for any active context (voice, stage, DM).
 *
 * All remote participants and enableRemoteScreen callbacks are threaded
 * from App.tsx via AppLayout props (including DM calls).
 */
export function usePipStreamDescriptors(
  ctx: StreamContext | null,
  remoteParticipants: ReadonlyArray<{
    userId: string;
    screenStream?: MediaStream | null;
    cameraStream?: MediaStream | null;
    screenShareAvailable?: boolean;
  }>,
  /** DM call local stream (mic/media) from App.tsx's useDMCall, for reactivity. */
  dmLocalStream?: MediaStream | null,
): PipStreamDesc[] {
  const localScreenStream = useVoiceStore(s => s.screenStream);
  const localCameraStream = useVoiceStore(s => s.cameraStream);
  const dmCameraStream = useVoiceStore(s => s.dmCameraStream);
  const dmScreenStream = useVoiceStore(s => s.dmScreenStream);
  const selfUserId = useAuthStore(s => s.currentUser?.id);
  const viewersVersion = useViewerStore(s => s.version);
  const startedAt = useStartedAtMap();

  return useMemo<PipStreamDesc[]>(() => {
    if (!ctx) return [];
    const out: PipStreamDesc[] = [];
    const isDm = ctx.kind === 'dm';

    // Local streams — for voice/stage, use voiceStore's screen/camera.
    // For DM calls, the camera/screen are published to voiceStore's
    // dmCameraStream / dmScreenStream by DMCallView.
    if (selfUserId) {
      const selfScreen = isDm ? dmScreenStream : localScreenStream;
      const selfCamera = isDm ? dmCameraStream : localCameraStream;
      if (selfScreen) {
        out.push({ ownerId: selfUserId, type: 'screen', isSelf: true, subscribed: true, startedAt: startedAt.getOrSeed(selfUserId, 'screen') });
      }
      if (selfCamera) {
        out.push({ ownerId: selfUserId, type: 'camera', isSelf: true, subscribed: true, startedAt: startedAt.getOrSeed(selfUserId, 'camera') });
      }
    }

    // Remote streams
    for (const p of remoteParticipants) {
      if (p.screenStream || p.screenShareAvailable) {
        const key = makeStreamKey(ctx, p.userId, 'screen');
        const subscribed = !!p.screenStream;
        out.push({ ownerId: p.userId, type: 'screen', subscribed, startedAt: startedAt.getOrSeed(p.userId, 'screen') });
        // Track viewer state from viewerStore for subscription awareness
        void viewersVersion; // ensure reactivity
        void key;
      }
      if (p.cameraStream) {
        out.push({ ownerId: p.userId, type: 'camera', subscribed: true, startedAt: startedAt.getOrSeed(p.userId, 'camera') });
      }
    }

    // Prune stale startedAt entries
    const activeKeys = new Set(out.map(d => `${d.ownerId}:${d.type}`));
    startedAt.prune(activeKeys);

    return out;
  }, [ctx?.kind, ctx?.scopeId, remoteParticipants, localScreenStream, localCameraStream, dmCameraStream, dmScreenStream, dmLocalStream, selfUserId, viewersVersion]);
}
