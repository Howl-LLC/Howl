// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useCallback, useEffect, useRef } from 'react';
import type { NavigationTarget } from '../types';

const MEMBERS_COLUMN_MIN = 180;
const MEMBERS_COLUMN_MAX = 400;

/**
 * Manages the members sidebar: per-server open/close state,
 * draggable column width, mobile overlay, and localStorage persistence.
 */
export function useMembersColumn(activeServerId: NavigationTarget, activeChannelId: string) {
  const [membersColumnWidth, setMembersColumnWidth] = useState(() => {
    try {
      const s = localStorage.getItem('howl_members_column_width');
      if (s != null) { const n = Number(s); if (n >= 180 && n <= 400) return n; }
    } catch { /* ignored */ }
    return 280;
  });

  const [membersColumnOpenByServer, setMembersColumnOpenByServer] = useState<Record<string, boolean>>(() => {
    try {
      const s = localStorage.getItem('howl_members_open_by_server');
      if (s) return JSON.parse(s) as Record<string, boolean>;
    } catch { /* ignored */ }
    return {};
  });

  const membersColumnOpen = activeServerId && activeServerId !== 'home' && activeServerId !== 'account' && activeServerId !== 'friends' && activeServerId !== 'dm'
    ? (membersColumnOpenByServer[activeServerId] ?? false)
    : false;

  const setMembersColumnOpen = useCallback((open: boolean) => {
    if (!activeServerId || activeServerId === 'home' || activeServerId === 'account' || activeServerId === 'friends' || activeServerId === 'dm') return;
    setMembersColumnOpenByServer((prev) => {
      const next = { ...prev, [activeServerId]: open };
      try { localStorage.setItem('howl_members_open_by_server', JSON.stringify(next)); } catch { /* ignored */ }
      return next;
    });
  }, [activeServerId]);

  const [mobileMembersOpen, setMobileMembersOpen] = useState(false);
  useEffect(() => { setMobileMembersOpen(false); }, [activeServerId, activeChannelId]);

  const [isDraggingMembersColumn, setIsDraggingMembersColumn] = useState(false);
  const membersColumnPointerRef = useRef({ x: 0 });

  // Persist column width to localStorage
  useEffect(() => {
    try { localStorage.setItem('howl_members_column_width', String(membersColumnWidth)); } catch { /* ignored */ }
  }, [membersColumnWidth]);

  // Drag-resize: track mouse movement while dragging
  useEffect(() => {
    if (!isDraggingMembersColumn) return;
    const onMove = (e: MouseEvent) => {
      const deltaX = e.clientX - membersColumnPointerRef.current.x;
      membersColumnPointerRef.current.x = e.clientX;
      setMembersColumnWidth((w) => Math.max(MEMBERS_COLUMN_MIN, Math.min(MEMBERS_COLUMN_MAX, w - deltaX)));
    };
    const onUp = () => setIsDraggingMembersColumn(false);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    return () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
  }, [isDraggingMembersColumn]);

  // Drag-resize: set cursor style on body while dragging
  useEffect(() => {
    if (isDraggingMembersColumn) {
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    return () => { document.body.style.cursor = ''; document.body.style.userSelect = ''; };
  }, [isDraggingMembersColumn]);

  const startDrag = useCallback((e: React.MouseEvent) => {
    if (!membersColumnOpen) return;
    e.preventDefault();
    membersColumnPointerRef.current.x = e.clientX;
    setIsDraggingMembersColumn(true);
  }, [membersColumnOpen]);

  return {
    membersColumnWidth,
    membersColumnOpen,
    setMembersColumnOpen,
    mobileMembersOpen,
    setMobileMembersOpen,
    isDraggingMembersColumn,
    startDrag,
  };
}
