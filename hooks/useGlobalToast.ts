// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useState, useCallback, useEffect, useRef } from 'react';

export interface ToastPayload {
  id: string;
  message: string;
  type: 'info' | 'warning';
  actionLabel?: string;
  onAction?: () => void;
}

/**
 * Auto-dismissing global toast notification (e.g. inactivity disconnect,
 * report reviewed, friend request).
 */
export function useGlobalToast() {
  const [globalToast, setGlobalToast] = useState<ToastPayload | null>(null);
  const globalToastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showGlobalToast = useCallback((message: string, type: 'info' | 'warning' = 'info', durationMs = 8000, opts?: { actionLabel?: string; onAction?: () => void }) => {
    if (globalToastTimerRef.current) clearTimeout(globalToastTimerRef.current);
    setGlobalToast({ id: `${Date.now()}`, message, type, actionLabel: opts?.actionLabel, onAction: opts?.onAction });
    if (durationMs > 0) {
      globalToastTimerRef.current = setTimeout(() => setGlobalToast(null), durationMs);
    }
  }, []);

  const dismissToast = useCallback(() => {
    if (globalToastTimerRef.current) clearTimeout(globalToastTimerRef.current);
    setGlobalToast(null);
  }, []);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (globalToastTimerRef.current) clearTimeout(globalToastTimerRef.current); };
  }, []);

  return { globalToast, showGlobalToast, dismissToast };
}
