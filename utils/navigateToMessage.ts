// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Cross-channel jump-to-message helper. Detects whether the given channelId belongs
 * to a server or a DM, navigates to the corresponding URL, and stores the target
 * messageId in navigationStore. The next ChatArea instance (which keys on channel.id)
 * picks up the target on mount and scrolls to it — fetching around the message via
 * the backend if it isn't loaded.
 *
 * If the channelId isn't in the user's current state (deleted, no longer a member),
 * we no-op and log a warning rather than navigate to a broken URL.
 */
import { useServerStore } from '../stores/serverStore';
import { useDmStore } from '../stores/dmStore';
import { useNavigationStore } from '../stores/navigationStore';

export function navigateToMessage(
  channelId: string,
  messageId: string,
  navigate: (path: string) => void,
): void {
  const serverContaining = useServerStore.getState().servers.find(
    (s) => s.channels.some((c) => c.id === channelId),
  );
  if (serverContaining) {
    navigate(`/channels/${serverContaining.id}/${channelId}`);
  } else if (useDmStore.getState().dmChannels.some((ch) => ch.id === channelId)) {
    navigate(`/channels/@me/${channelId}`);
  } else {
    console.warn('[navigateToMessage] channel not found in state:', channelId);
    return;
  }
  useNavigationStore.getState().setPendingScrollTarget({ channelId, messageId });
}
