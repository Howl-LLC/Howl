// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { NavigationTarget } from '../../types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { CreateJoinServerModal } from '../sidebar/CreateJoinServerModal';
import { ServerActivityPanel } from '../ServerActivityPanel';
import { useServerStore } from '../../stores/serverStore';
import { useVoiceStore } from '../../stores/voiceStore';
import { useSocialStore } from '../../stores/socialStore';
import { useUiStore } from '../../stores/uiStore';
import { CrescentCanvas } from './CrescentCanvas';
import './navigator.css';

const EMPTY_SUMMARY = {};

// Close plays the open animation in reverse, then unmounts after this long.
const REVEAL_MS = 700;

interface HowlNavigatorProps {
  /** Close the overlay (return to the resting trigger). */
  onClose: () => void;
  /** Route to a nav target (the canonical AppLayout dispatcher). */
  onNavigate: (target: NavigationTarget) => void;
  /** Electron title-bar offset (28 in the desktop app, 0 on web). */
  titleBarPad: number;
  // Reused add/join-server flow (same adapters AppLayout passes to the Sidebar).
  onCreateServer?: (name: string, options?: { icon?: string; template?: string; community?: boolean }) => Promise<void>;
  onJoinServer?: (code: string) => Promise<void>;
  onServerCreated?: (server: { id: string; name: string; channels: Array<{ id: string; name: string; type: string }> }) => void;
  userName?: string;
}

/**
 * Full-screen "Howl Navigator" overlay — the rail-less server launcher for the
 * `default` layout on desktop. Hosts the free pannable/zoomable canvas of server
 * tiles, user-made section note-cards, and the built-in "howl" nav section
 * (Home / Friends / You / Messages / Discover / Activity). Selecting any
 * destination routes via `onNavigate` and closes (close-on-select); Escape and
 * the toolbar ✕ also close.
 */
export const HowlNavigator: React.FC<HowlNavigatorProps> = ({
  onClose, onNavigate, titleBarPad, onCreateServer, onJoinServer, onServerCreated, userName,
}) => {
  const stageRef = useRef<HTMLDivElement>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [revealed, setRevealed] = useState(false);

  // Same "Server Activity" panel the Friends view shows (friends in voice/stage).
  const servers = useServerStore(s => s.servers);
  const serverVoiceSummary = useVoiceStore(s => s.serverVoiceSummary);
  const serverStageSummary = useVoiceStore(s => s.serverStageSummary);
  const friends = useSocialStore(s => s.homeFriends);
  // Yield the stage's Tab trap while the add-server modal is open — that modal
  // portals to document.body (outside .hn-stage), so trapping Tab to stage
  // descendants would make its fields unreachable by keyboard.
  useFocusTrap(stageRef, !addOpen);

  // Play the reveal (fan-out + crescent sweep + tile fly-in) one frame after mount.
  useEffect(() => {
    const r = requestAnimationFrame(() => setRevealed(true));
    return () => cancelAnimationFrame(r);
  }, []);

  // Close = the opening animation in reverse: collapse everything back toward
  // the logo corner and fade the stage, then unmount once it has finished.
  const closeTimer = useRef<number | null>(null);
  useEffect(() => () => { if (closeTimer.current != null) window.clearTimeout(closeTimer.current); }, []);
  const handleClose = useCallback(() => {
    if (closeTimer.current != null) return; // already closing
    setRevealed(false);
    closeTimer.current = window.setTimeout(() => { closeTimer.current = null; onClose(); }, REVEAL_MS);
  }, [onClose]);

  // Navigate, then play the reverse-close (the destination loads behind it).
  const go = useCallback((target: NavigationTarget) => {
    onNavigate(target);
    handleClose();
  }, [onNavigate, handleClose]);

  // Escape closes the add-server modal first if it's open, otherwise the overlay.
  // (The shared CreateJoinServerModal has no Escape handler of its own.)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      if (addOpen) setAddOpen(false);
      else handleClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [handleClose, addOpen]);

  return (
    <div
      className="hn-stage"
      ref={stageRef}
      role="dialog"
      aria-modal="true"
      aria-label="Server navigator"
      data-revealed={revealed}
      style={{ top: titleBarPad }}
    >
      <CrescentCanvas open={revealed} onNavigate={go} onAddServer={() => setAddOpen(true)} onClose={handleClose} />

      {/* Friends' live server activity — the same panel as the Friends view,
          docked to the right edge. Clicking a server navigates + closes. */}
      <div style={{ position: 'absolute', top: 72, right: 16, bottom: 16, display: 'flex', zIndex: 5 }}>
        <ServerActivityPanel
          servers={servers}
          friends={friends}
          serverVoiceSummary={serverVoiceSummary ?? EMPTY_SUMMARY}
          serverStageSummary={serverStageSummary ?? EMPTY_SUMMARY}
          onServerClick={(id) => go(id)}
          onUserClick={(user, e) => useUiStore.getState().setUserProfileTarget({ user, anchorRect: { left: e.clientX, top: e.clientY + 8 } })}
          onUserRightClick={(user, e) => useUiStore.getState().setUserContextMenuTarget({ user, x: e.clientX, y: e.clientY })}
        />
      </div>

      {/* Dim the canvas behind the add-server modal (the shared modal renders no
          backdrop of its own — without this the pins/tiles show through). It
          sits above stage content but below the portaled modal (--z-modal). */}
      {addOpen && <div style={{ position: 'absolute', inset: 0, background: 'rgba(0, 0, 0, 0.6)', zIndex: 100 }} />}

      <CreateJoinServerModal
        open={addOpen}
        onClose={() => setAddOpen(false)}
        onCreateServer={onCreateServer}
        onJoinServer={onJoinServer}
        onServerCreated={onServerCreated}
        userName={userName}
      />
    </div>
  );
};

export default HowlNavigator;
