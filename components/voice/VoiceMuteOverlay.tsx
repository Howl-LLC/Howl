// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { MicOff, ShieldAlert } from 'lucide-react';
import { DeafenedIcon } from '../call/DeafenedIcon';

export interface VoiceMuteState {
  isMuted?: boolean;
  isDeafened?: boolean;
  serverMuted?: boolean;
  serverDeafened?: boolean;
}

export interface VoiceMuteOverlayProps extends VoiceMuteState {
  /** Icon size in px. Defaults to 14 — fits a 24px avatar. */
  size?: number;
}

/**
 * Avatar overlay matching the call-card pattern (see ParticipantCardFooter).
 * Shows a single indicator at the appropriate priority:
 *
 *   server-deafen > server-mute > self-deafen > self-mute
 *
 * Returns null when no state is active. The caller is responsible for the
 * relative-positioned avatar wrapper; this component renders an
 * absolutely-positioned overlay div.
 */
export const VoiceMuteOverlay = React.memo(function VoiceMuteOverlay({
  isMuted, isDeafened, serverMuted, serverDeafened, size = 14,
}: VoiceMuteOverlayProps) {
  if (serverDeafened) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-full text-[var(--danger)] pointer-events-none"
        title="Server-deafened"
      >
        <ShieldAlert size={size} />
      </div>
    );
  }
  if (serverMuted) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-full text-[var(--danger)] pointer-events-none"
        title="Server-muted"
      >
        <ShieldAlert size={size} />
      </div>
    );
  }
  if (isDeafened) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-full text-[var(--danger)] pointer-events-none"
        title="Deafened"
      >
        <DeafenedIcon size={size} />
      </div>
    );
  }
  if (isMuted) {
    return (
      <div
        className="absolute inset-0 flex items-center justify-center bg-[var(--danger-muted)] rounded-full text-[var(--danger)] pointer-events-none"
        title="Muted"
      >
        <MicOff size={size} />
      </div>
    );
  }
  return null;
});

/** True when any mute/deafen state is active — useful for dimming the avatar
 *  consistently with the overlay. */
export function hasMuteState(s: VoiceMuteState): boolean {
  return !!(s.isMuted || s.isDeafened || s.serverMuted || s.serverDeafened);
}
