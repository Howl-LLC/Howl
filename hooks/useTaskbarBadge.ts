// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useMemo, useState } from 'react';
import { useNotificationStore } from '../stores/notificationStore';
import { unreadBadgeEnabled, taskbarFlashEnabled } from '../utils/notificationSoundRef';

/**
 * Electron OS taskbar/dock unread-badge driver.
 *
 * This is lifted verbatim from the Sidebar's badge effect so the badge keeps
 * working in the `default`-layout rail-less mode, where the Sidebar is not
 * rendered (the Howl Navigator replaces it). Exactly ONE of {Sidebar,
 * NavigatorTrigger} is mounted at a time, so the badge is never driven twice.
 *
 * Computes the same `mentionCount` (server mentions + unread DMs + thread
 * mentions + unread channels), renders a 32×32 red overlay PNG, and clears the
 * overlay on unmount so a stale badge doesn't persist across sessions.
 */
export function useTaskbarBadge(): void {
  const serverMentionCounts = useNotificationStore(s => s.serverMentionCounts);
  const unreadDmChannelIds = useNotificationStore(s => s.unreadDmChannelIds);
  const dmUnreadCounts = useNotificationStore(s => s.dmUnreadCounts);
  const threadMentionCounts = useNotificationStore(s => s.threadMentionCounts);
  const channelUnreadIds = useNotificationStore(s => s.channelUnreadIds);

  const mentionCount = useMemo(() => {
    let sum = 0;
    for (const id in serverMentionCounts) sum += serverMentionCounts[id] || 0;
    for (const id of unreadDmChannelIds) sum += dmUnreadCounts[id] || 0;
    for (const id in threadMentionCounts) sum += threadMentionCounts[id] || 0;
    sum += channelUnreadIds.size;
    return sum;
  }, [serverMentionCounts, unreadDmChannelIds, dmUnreadCounts, threadMentionCounts, channelUnreadIds]);

  // Re-run when notification prefs change (the prefs live in module refs).
  const [prefsVersion, setPrefsVersion] = useState(0);
  useEffect(() => {
    const bump = () => setPrefsVersion(v => v + 1);
    window.addEventListener('howl-prefs-change', bump);
    return () => window.removeEventListener('howl-prefs-change', bump);
  }, []);

  useEffect(() => {
    if (!window.electron?.setBadgeCount) return;
    if (!unreadBadgeEnabled.current) {
      window.electron.setBadgeCount(0, { overlayPng: null, taskbarFlash: false });
      return;
    }
    const n = mentionCount;
    let overlayPng: string | null = null;
    if (n > 0 && typeof document !== 'undefined') {
      const size = 32;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#ef4444';
        ctx.beginPath();
        ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const label = n > 9 ? '9+' : String(n);
        const fontSize = label.length === 2 ? 18 : 22;
        ctx.font = `bold ${fontSize}px -apple-system, "Segoe UI", system-ui, sans-serif`;
        ctx.fillText(label, size / 2, size / 2 + 1);
        try { overlayPng = canvas.toDataURL('image/png'); } catch { overlayPng = null; }
      }
    }
    window.electron.setBadgeCount(n, { overlayPng, taskbarFlash: taskbarFlashEnabled.current });
  }, [mentionCount, prefsVersion]);

  // Clear the overlay when this driver unmounts so no stale badge lingers.
  useEffect(() => {
    return () => {
      if (window.electron?.setBadgeCount) {
        window.electron.setBadgeCount(0, { overlayPng: null, taskbarFlash: false });
      }
    };
  }, []);
}
