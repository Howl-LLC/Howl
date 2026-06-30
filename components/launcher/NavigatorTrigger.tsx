// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import React from 'react';
import { useTranslation } from 'react-i18next';
import { assetPath } from '../../utils/assetPath';
import { useNotificationStore } from '../../stores/notificationStore';
import { useTaskbarBadge } from '../../hooks/useTaskbarBadge';

interface NavigatorTriggerProps {
  /** Open the full-screen navigator overlay. */
  onOpen: () => void;
  /** Electron title-bar offset (28 in the desktop app, 0 on web). */
  titleBarPad: number;
}

/**
 * The resting state of the `default`-layout launcher: the rail is gone, only
 * the top-left Howl logo survives (with an aggregate-unread badge). Clicking it
 * opens the Navigator overlay. AppLayout reserves a left gutter for it so it
 * never overlaps the content's top-left controls.
 *
 * This component is always mounted while the Navigator is active (desktop +
 * `default` layout), so it also hosts the Electron taskbar-badge driver that
 * otherwise lived in the Sidebar — preventing a regression now that the Sidebar
 * isn't rendered in this mode.
 */
export const NavigatorTrigger: React.FC<NavigatorTriggerProps> = ({ onOpen, titleBarPad }) => {
  const { t } = useTranslation();

  // Keep the OS taskbar/dock badge alive in rail-less mode.
  useTaskbarBadge();

  // Aggregate unread for the logo badge (same formula the Sidebar uses).
  const aggregate = useNotificationStore(s => {
    let sum = 0;
    for (const id in s.serverMentionCounts) sum += s.serverMentionCounts[id] || 0;
    for (const id of s.unreadDmChannelIds) sum += s.dmUnreadCounts[id] || 0;
    for (const id in s.threadMentionCounts) sum += s.threadMentionCounts[id] || 0;
    sum += s.channelUnreadIds.size;
    return sum;
  });

  const label = t('nav.openNavigator', { defaultValue: 'Open navigator' });

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      title={label}
      style={{
        position: 'fixed',
        top: titleBarPad + 12,
        left: 14,
        zIndex: 40,
        // Match the classic-rail logo button: full-size mark, no box/outline.
        width: 48,
        height: 48,
        border: 'none',
        outline: 'none',
        WebkitTapHighlightColor: 'transparent',
        padding: 0,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'transparent',
      }}
    >
      <img
        src={assetPath('/howl-logo.png')}
        alt="Howl"
        decoding="async"
        style={{ width: '100%', height: '100%', objectFit: 'contain', pointerEvents: 'none' }}
      />
      {aggregate > 0 && (
        <span
          style={{
            position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, padding: '0 5px',
            borderRadius: 999, background: '#ef4444', color: '#fff', fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center', border: '2px solid var(--bg-app, #000)',
          }}
        >
          {aggregate > 99 ? '99+' : aggregate}
        </span>
      )}
    </button>
  );
};
