// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useCallback, useEffect, useState } from 'react';
import type { ActiveCallContext } from './useActiveCallContext';

export interface PipStreamDesc {
  ownerId: string;
  type: 'camera' | 'screen';
  /** Set if this is the local user's stream. */
  isSelf?: boolean;
  /** Monotonic timestamp when the stream became active (for tiebreaking). */
  startedAt?: number;
  /** True if the user is actively subscribed (screen only; camera is auto). */
  subscribed?: boolean;
}

interface Params {
  activeCall: ActiveCallContext | null;
  isViewingCallContext: boolean;
  availableStreams: PipStreamDesc[];
  /** Optional stream the user explicitly focused (e.g. via FocusedScreenOverlay). */
  focusedStreamOwnerId?: string | null;
  focusedStreamType?: 'camera' | 'screen' | null;
}

interface PipStateResult {
  visible: boolean;
  selectedStream: PipStreamDesc | null;
  dismiss: () => void;
  setSelectedStream: (desc: PipStreamDesc) => void;
}

export function usePipState(params: Params): PipStateResult {
  const { activeCall, isViewingCallContext, availableStreams } = params;
  const [dismissed, setDismissed] = useState(false);
  const [manualSelection, setManualSelection] = useState<PipStreamDesc | null>(null);

  // Reset dismissed when user enters call view.
  useEffect(() => {
    if (isViewingCallContext) {
      setDismissed(false);
      setManualSelection(null);
    }
  }, [isViewingCallContext]);

  // Clear state when call ends.
  useEffect(() => {
    if (!activeCall) { setDismissed(false); setManualSelection(null); }
  }, [activeCall]);

  const selectedStream = selectStream({
    streams: availableStreams,
    manual: manualSelection,
    focusedOwnerId: params.focusedStreamOwnerId ?? null,
    focusedType: params.focusedStreamType ?? null,
  });

  const visible = !!activeCall && !isViewingCallContext && !dismissed && !!selectedStream;

  const dismiss = useCallback(() => setDismissed(true), []);
  const setSelectedStream = useCallback((desc: PipStreamDesc) => setManualSelection(desc), []);

  return { visible, selectedStream, dismiss, setSelectedStream };
}

/** Priority order (from design section 3):
 *  1. Manual selection (switcher).
 *  2. Focused stream (set by FocusedScreenOverlay).
 *  3. Subscribed screenshare, most-recently-subscribed.
 *  4. Any published screenshare, most-recently-started.
 *  5. Camera stream, most-recently-started. */
function selectStream(input: {
  streams: PipStreamDesc[];
  manual: PipStreamDesc | null;
  focusedOwnerId: string | null;
  focusedType: 'camera' | 'screen' | null;
}): PipStreamDesc | null {
  const { streams, manual, focusedOwnerId, focusedType } = input;
  if (!streams.length) return null;

  if (manual) {
    const match = streams.find(s => s.ownerId === manual.ownerId && s.type === manual.type);
    if (match) return match;
  }

  if (focusedOwnerId && focusedType) {
    const match = streams.find(s => s.ownerId === focusedOwnerId && s.type === focusedType);
    if (match) return match;
  }

  const byRecency = (a?: number, b?: number) => (b ?? 0) - (a ?? 0);

  const subscribedScreens = streams
    .filter(s => s.type === 'screen' && s.subscribed)
    .sort((a, b) => byRecency(a.startedAt, b.startedAt));
  if (subscribedScreens[0]) return subscribedScreens[0];

  const anyScreens = streams
    .filter(s => s.type === 'screen')
    .sort((a, b) => byRecency(a.startedAt, b.startedAt));
  if (anyScreens[0]) return anyScreens[0];

  const cameras = streams
    .filter(s => s.type === 'camera')
    .sort((a, b) => byRecency(a.startedAt, b.startedAt));
  return cameras[0] ?? null;
}
