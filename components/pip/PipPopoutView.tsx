// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePopoutWindow } from '../../hooks/usePopoutWindow';
import { PipStreamTile } from './PipStreamTile';
import { ViewerIndicator } from '../call/ViewerIndicator';
import { ViewerAvatarStack } from '../call/ViewerAvatarStack';
import type { StreamContext } from '../../stores/types';

interface Props {
  stream: MediaStream | null;
  presenterName: string;
  presenterAvatar?: string;
  isSelf?: boolean;
  /** Provided when the popped-out stream is a screen share — drives the
   *  viewer count pill + avatar stack overlays. Omitted for camera streams. */
  streamContext?: StreamContext;
  ownerId?: string;
  selfUserId?: string;
  onClose: () => void;
}

/** Stream-only popout view. Opens a detached browser window via usePopoutWindow
 *  and portals a full-bleed PipStreamTile into it. When the stream is a screen
 *  share, mirrors the in-app PIP's viewer overlays so the viewer count + avatars
 *  stay visible after popout. */
export const PipPopoutView = React.memo(({
  stream,
  presenterName,
  presenterAvatar,
  isSelf,
  streamContext,
  ownerId,
  selfUserId,
  onClose,
}: Props) => {
  const { isPoppedOut, popoutContainerRef, openPopout, closePopout } = usePopoutWindow({
    windowName: 'howl-pip-stream-popout',
    title: `Stream · ${presenterName}`,
    containerId: 'pip-stream-popout-root',
  });

  // Auto-open the popout window on mount.
  useEffect(() => {
    openPopout();
  }, [openPopout]);

  // Notify parent when popout closes (user closed the window).
  useEffect(() => {
    if (!isPoppedOut) {
      // Only fire onClose if we were previously popped out (avoid initial render).
      return;
    }
    return () => { onClose(); };
  }, [isPoppedOut, onClose]);

  // Close popout on unmount.
  useEffect(() => {
    return () => { closePopout(); };
  }, [closePopout]);

  if (!isPoppedOut || !popoutContainerRef.current) return null;

  return createPortal(
    <div className="relative w-full h-full bg-black">
      <PipStreamTile
        stream={stream}
        presenterName={presenterName}
        presenterAvatar={presenterAvatar}
        isSelf={isSelf}
      />
      {streamContext && ownerId && (
        <>
          <div className="absolute top-2 right-2 z-20 pointer-events-auto">
            <ViewerIndicator context={streamContext} ownerId={ownerId} selfUserId={selfUserId} />
          </div>
          <div className="absolute bottom-2 left-2 z-20 pointer-events-auto">
            <ViewerAvatarStack context={streamContext} ownerId={ownerId} selfUserId={selfUserId} />
          </div>
        </>
      )}
    </div>,
    popoutContainerRef.current,
  );
});

PipPopoutView.displayName = 'PipPopoutView';
