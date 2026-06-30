// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect, useRef } from 'react';
import { socketService } from '../services/socket';

interface UseGameDetectionOpts {
  enabled: boolean;
  shareDetectedGames: boolean;
}

/**
 * Bridges Electron game scanner IPC events to the backend via Socket.IO.
 *
 * When a game is detected by the Electron main process, this hook emits
 * `set-activity` to the server. When the game closes, it emits `clear-activity`.
 *
 * No-op when running in browser (non-Electron) or when detection is disabled.
 * Debounces: won't re-emit for the same game within 30 seconds.
 */
export function useGameDetection(opts: UseGameDetectionOpts): void {
  const { enabled, shareDetectedGames } = opts;
  const lastEmittedRef = useRef<{ name: string; at: number } | null>(null);
  const DEBOUNCE_MS = 30_000;

  useEffect(() => {
    const electron = window.electron;
    if (!electron?.isElectron) return;

    if (!enabled || !shareDetectedGames) {
      // If disabled, clear any existing detected_game activity
      socketService.emitClearActivity();
      return;
    }

    const unsubDetected = electron.onGameActivityDetected((game) => {
      if (!game?.name) return;

      // Debounce: skip if same game was reported within 30s
      const now = Date.now();
      const last = lastEmittedRef.current;
      if (last && last.name === game.name && now - last.at < DEBOUNCE_MS) return;

      lastEmittedRef.current = { name: game.name, at: now };
      // Pass through steamAppId as platformId so the backend can mark this as
      // a Steam-platformed activity and the renderer can derive store header
      // art (cdn.cloudflare.steamstatic.com/steam/apps/<id>/header.jpg).
      socketService.emitSetActivity({
        type: 'detected_game',
        name: game.name,
        ...(game.steamAppId ? { platformId: game.steamAppId } : {}),
      });
    });

    const unsubCleared = electron.onGameActivityCleared(() => {
      lastEmittedRef.current = null;
      socketService.emitClearActivity();
    });

    // Query current state on mount in case scanner already has a detection
    electron.getDetectedGame().then((game) => {
      if (game?.name) {
        lastEmittedRef.current = { name: game.name, at: Date.now() };
        socketService.emitSetActivity({
          type: 'detected_game',
          name: game.name,
          ...(game.steamAppId ? { platformId: game.steamAppId } : {}),
        });
      }
    }).catch(() => {});

    return () => {
      unsubDetected();
      unsubCleared();
    };
  }, [enabled, shareDetectedGames]);
}
