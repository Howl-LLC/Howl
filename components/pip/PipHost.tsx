// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useActiveCallContext } from '../../hooks/useActiveCallContext';
import { useNavigationStore } from '../../stores/navigationStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { usePipState } from '../../hooks/usePipState';
import { usePipPosition } from '../../hooks/usePipPosition';
import { usePipStreamDescriptors } from '../../hooks/usePipStreamDescriptors';
import { PipStreamTile } from './PipStreamTile';
import { PipChrome } from './PipChrome';
import { PipPopoutView } from './PipPopoutView';
import { ViewerIndicator } from '../call/ViewerIndicator';
import { ViewerAvatarStack } from '../call/ViewerAvatarStack';
import { useAuthStore } from '../../stores/authStore';
import { useIsMobile } from '../../hooks/useIsMobile';
import type { CallParticipant } from '../../services/call';

const DESKTOP_SIZE = { width: 320, height: 180 };
const MOBILE_SIZE = { width: 160, height: 90 };

interface Props {
  /** Active DM call channel id from App.tsx's useDmCallState. */
  activeDmCallChannelId: string | null;
  /** Voice channel remote participants (threaded from App.tsx via AppLayout). */
  voiceRemoteParticipants: ReadonlyArray<CallParticipant>;
  /** Stage remote participants (threaded from App.tsx via AppLayout). */
  stageRemoteParticipants: ReadonlyArray<CallParticipant>;
  /** DM call remote participants (threaded from App.tsx via AppLayout). */
  dmRemoteParticipants: ReadonlyArray<CallParticipant>;
  /** Voice enableRemoteScreen callback. */
  voiceEnableRemoteScreen: ((userId: string) => void) | undefined;
  /** Stage enableRemoteScreen callback. */
  stageEnableRemoteScreen: ((userId: string) => void) | undefined;
  /** DM enableRemoteScreen callback. */
  dmEnableRemoteScreen: ((userId: string) => void) | undefined;
  /** DM call local stream (mic stream from useDMCall, lifted to App.tsx). */
  dmLocalStream: MediaStream | null;
}

/**
 * PipHost is the root PIP component mounted at the AppLayout level.
 * It picks the active call context (voice / stage / DM), resolves streams,
 * and renders a draggable PIP overlay with stream switching and popout support.
 */
export const PipHost = React.memo(({
  activeDmCallChannelId,
  voiceRemoteParticipants,
  stageRemoteParticipants,
  dmRemoteParticipants,
  voiceEnableRemoteScreen,
  stageEnableRemoteScreen,
  dmEnableRemoteScreen,
  dmLocalStream,
}: Props) => {
  const activeCall = useActiveCallContext(activeDmCallChannelId);
  const navActiveChannel = useNavigationStore(s => s.activeChannelId);
  const navActiveDmChannel = useNavigationStore(s => s.activeDmChannelId);
  const selfUserId = useAuthStore(s => s.currentUser?.id);
  const isMobile = useIsMobile();

  // Resolve which remote participants to use based on active call context
  const activeRemoteParticipants = useMemo(() => {
    if (!activeCall) return [];
    switch (activeCall.kind) {
      case 'voice': return voiceRemoteParticipants;
      case 'stage': return stageRemoteParticipants;
      case 'dm': return dmRemoteParticipants;
      default: return [];
    }
  }, [activeCall, voiceRemoteParticipants, stageRemoteParticipants, dmRemoteParticipants]);

  // Resolve active enableRemoteScreen
  const activeEnableRemoteScreen = useMemo(() => {
    if (!activeCall) return null;
    switch (activeCall.kind) {
      case 'voice': return voiceEnableRemoteScreen ?? null;
      case 'stage': return stageEnableRemoteScreen ?? null;
      case 'dm': return dmEnableRemoteScreen ?? null;
      default: return null;
    }
  }, [activeCall, voiceEnableRemoteScreen, stageEnableRemoteScreen, dmEnableRemoteScreen]);

  // Build the stream context for usePipStreamDescriptors
  const streamCtx = useMemo(() => {
    if (!activeCall) return null;
    return { kind: activeCall.kind, scopeId: activeCall.scopeId };
  }, [activeCall]);

  const streamDescriptors = usePipStreamDescriptors(streamCtx, activeRemoteParticipants, dmLocalStream);

  // Determine if the user is currently viewing the active call context
  const isViewingCallContext = useMemo(() => {
    if (!activeCall) return false;
    if (activeCall.kind === 'voice' || activeCall.kind === 'stage') {
      return navActiveChannel === activeCall.scopeId;
    }
    if (activeCall.kind === 'dm') {
      return navActiveDmChannel === activeCall.scopeId;
    }
    return false;
  }, [activeCall, navActiveChannel, navActiveDmChannel]);

  const { visible, selectedStream, dismiss, setSelectedStream } = usePipState({
    activeCall,
    isViewingCallContext,
    availableStreams: streamDescriptors,
  });

  const size = isMobile ? MOBILE_SIZE : DESKTOP_SIZE;
  const { ref: pipRef, style, onPointerDown, isDragging } = usePipPosition(size);
  const [popoutOpen, setPopoutOpen] = useState(false);

  // Build a single lookup map across all three participant lists. Turns
  // three O(N) array scans per name/avatar/stream lookup into one O(1)
  // hash probe. Rebuilt only when one of the participant lists changes
  // identity — React.memo downstream keeps tile re-renders from paying
  // the rebuild cost on every drag frame.
  const participantById = useMemo(() => {
    const map = new Map<string, CallParticipant>();
    for (const p of voiceRemoteParticipants) map.set(p.userId, p);
    for (const p of stageRemoteParticipants) map.set(p.userId, p);
    for (const p of dmRemoteParticipants) map.set(p.userId, p);
    return map;
  }, [voiceRemoteParticipants, stageRemoteParticipants, dmRemoteParticipants]);

  const resolveName = useCallback((ownerId: string): string => {
    if (ownerId === selfUserId) return 'You';
    const p = participantById.get(ownerId);
    return p ? (p.nickname ?? p.username) : 'Unknown';
  }, [selfUserId, participantById]);

  const resolveAvatar = useCallback((ownerId: string): string | undefined => {
    return participantById.get(ownerId)?.avatar;
  }, [participantById]);

  // MediaStream accessor. Reads voiceStore.getState() directly for local
  // streams (avoids subscribing to the store and re-rendering PipHost on
  // every mic level update) and hits the O(1) participant map for remotes.
  const getMediaStream = useCallback((ownerId: string, type: 'camera' | 'screen'): MediaStream | null => {
    if (ownerId === selfUserId) {
      if (type === 'screen') return useVoiceStore.getState().screenStream;
      if (type === 'camera') return useVoiceStore.getState().cameraStream;
    }
    const p = participantById.get(ownerId);
    if (!p) return null;
    if (type === 'screen') return p.screenStream ?? null;
    return p.cameraStream ?? p.stream ?? null;
  }, [selfUserId, participantById]);

  // Subscribe trigger
  const watchStream = useCallback((ownerId: string) => {
    activeEnableRemoteScreen?.(ownerId);
  }, [activeEnableRemoteScreen]);

  // Navigate to source call context
  const goToSource = useCallback(() => {
    if (!activeCall) return;
    const nav = useNavigationStore.getState();
    if (activeCall.kind === 'voice' || activeCall.kind === 'stage') {
      nav.setActiveChannelId(activeCall.scopeId);
    } else if (activeCall.kind === 'dm') {
      nav.setActiveDmChannelId(activeCall.scopeId);
      nav.setActiveServerId('dm');
    }
  }, [activeCall]);

  const onPopout = useCallback(() => {
    setPopoutOpen(true);
    dismiss();
  }, [dismiss]);

  // Double-click to navigate to source
  const dblClickRef = useRef(0);
  const onBodyClick = useCallback(() => {
    const now = Date.now();
    if (now - dblClickRef.current < 300) goToSource();
    dblClickRef.current = now;
  }, [goToSource]);

  if (!visible || !activeCall || !selectedStream) {
    // Popout window might still be open
    if (popoutOpen && selectedStream) {
      const stream = getMediaStream(selectedStream.ownerId, selectedStream.type);
      const isScreen = selectedStream.type === 'screen';
      return (
        <PipPopoutView
          stream={stream}
          presenterName={resolveName(selectedStream.ownerId)}
          presenterAvatar={resolveAvatar(selectedStream.ownerId)}
          isSelf={selectedStream.isSelf}
          streamContext={isScreen && activeCall ? { kind: activeCall.kind, scopeId: activeCall.scopeId } : undefined}
          ownerId={isScreen ? selectedStream.ownerId : undefined}
          selfUserId={selfUserId}
          onClose={() => setPopoutOpen(false)}
        />
      );
    }
    return null;
  }

  const stream = getMediaStream(selectedStream.ownerId, selectedStream.type);
  const awaitingWatch = selectedStream.type === 'screen' && !selectedStream.subscribed && !selectedStream.isSelf;

  // Render the PIP overlay as a body-level portal. The PIP root creates its
  // own stacking context (via `isolation: isolate` + `contain: paint` for
  // GPU isolation — see comment below), so when PipHost was mounted inside
  // AppLayout, modal-input-bar portals (also at body) painted above the PIP.
  // Mounting at body level puts both at the same stacking-context root, where
  // --z-pip (150) properly outranks --z-dropdown (100).
  return createPortal(
    <>
      <div
        ref={pipRef}
        style={{
          ...style,
          // Isolate the PIP video from the rest of the page's compositing
          // tree. Without this, every decoded frame from the <video> forces
          // the browser to recomposite all the backdrop-filter glass panels
          // sitting beneath it (status bar, DM panel, ChatArea, MemberList,
          // member-list popups) — which is what was pegging the GPU at 80%
          // when the PIP was up. `isolation: isolate` stops the PIP from
          // joining the parent stacking context's blend group, and
          // `contain: layout paint` tells the engine that nothing inside
          // this box affects layout/paint outside it. Combined, the PIP
          // becomes its own GPU surface and its repaints are no longer
          // cascading work onto the rest of the layer tree.
          isolation: 'isolate' as const,
          contain: 'layout paint' as const,
        }}
        className="rounded-lg overflow-hidden shadow-2xl bg-black select-none"
        onPointerDown={onPointerDown}
        onClick={onBodyClick}
        role="dialog"
        aria-label={`Picture-in-picture: ${activeCall.displayName}`}
      >
        <PipStreamTile
          stream={stream}
          awaitingWatch={awaitingWatch}
          isSelf={selectedStream.isSelf}
          presenterAvatar={resolveAvatar(selectedStream.ownerId)}
          presenterName={resolveName(selectedStream.ownerId)}
          onWatch={awaitingWatch ? () => watchStream(selectedStream.ownerId) : undefined}
        />
        {/* Viewer affordances live outside the hover-fade chrome so they stay
            visible without requiring a hover. Only render for screen streams
            since viewer tracking is screen-only. */}
        {selectedStream.type === 'screen' && (
          <>
            <div className="absolute top-2 right-2 z-20 pointer-events-auto">
              <ViewerIndicator
                context={{ kind: activeCall.kind, scopeId: activeCall.scopeId }}
                ownerId={selectedStream.ownerId}
                selfUserId={selfUserId}
              />
            </div>
            <div className="absolute bottom-2 left-2 z-20 pointer-events-auto">
              <ViewerAvatarStack
                context={{ kind: activeCall.kind, scopeId: activeCall.scopeId }}
                ownerId={selectedStream.ownerId}
                selfUserId={selfUserId}
              />
            </div>
          </>
        )}
        {!isDragging && (
          <PipChrome
            selected={selectedStream}
            streams={streamDescriptors}
            presenterName={resolveName(selectedStream.ownerId)}
            isMobile={isMobile}
            resolveName={resolveName}
            onClose={dismiss}
            onPopout={onPopout}
            onSelectStream={setSelectedStream}
          />
        )}
      </div>
      {popoutOpen && (
        <PipPopoutView
          stream={stream}
          presenterName={resolveName(selectedStream.ownerId)}
          presenterAvatar={resolveAvatar(selectedStream.ownerId)}
          isSelf={selectedStream.isSelf}
          streamContext={selectedStream.type === 'screen' ? { kind: activeCall.kind, scopeId: activeCall.scopeId } : undefined}
          ownerId={selectedStream.type === 'screen' ? selectedStream.ownerId : undefined}
          selfUserId={selfUserId}
          onClose={() => setPopoutOpen(false)}
        />
      )}
    </>,
    document.body,
  );
});

PipHost.displayName = 'PipHost';
