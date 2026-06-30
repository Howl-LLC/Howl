// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { useEffect } from 'react';
import type { NavigationTarget } from '../types';
import { socketService } from '../services/socket';
import { apiClient } from '../services/api';
import { deferStoreUpdate } from '../utils/storeHelpers';
import { useCalendarStore } from '../stores/calendarStore';
import { isRealServerId } from '../utils/navigationHelpers';

/**
 * Registers socket events for calendar real-time updates:
 * - server-event-created
 * - server-event-updated
 * - server-event-deleted
 * - server-event-rsvp
 *
 * Always registered so events arriving while the calendar panel is closed
 * still update the store. The data is ready when the user opens the panel.
 */
export function useCalendarSocketEvents(opts: {
  activeServerId: NavigationTarget;
}): void {
  const { activeServerId } = opts;

  useEffect(() => {
    if (!isRealServerId(activeServerId)) return;

    socketService.onServerEventCreated((event) => {
      if (event.serverId === activeServerId) {
        deferStoreUpdate(() => {
          useCalendarStore.getState().setCalendarEvents((prev) => {
            // Deduplicate: optimistic add may already have this event
            if (prev.some((e) => e.id === event.id)) return prev;
            return [...prev, event];
          });
        });
      }
    });
    socketService.onServerEventUpdated((event) => {
      if (event.serverId === activeServerId) {
        deferStoreUpdate(() => {
          useCalendarStore.getState().setCalendarEvents((prev) => prev.map((e) => e.id === event.id ? event : e));
          useCalendarStore.getState().setCalendarSelectedEvent((sel) => sel?.id === event.id ? event : sel);
        });
      }
    });
    socketService.onServerEventDeleted(({ serverId, eventId }) => {
      if (serverId === activeServerId) {
        deferStoreUpdate(() => {
          useCalendarStore.getState().setCalendarEvents((prev) => prev.filter((e) => e.id !== eventId));
          useCalendarStore.getState().setCalendarSelectedEvent((sel) => sel?.id === eventId ? null : sel);
        });
      }
    });
    socketService.onServerEventRsvp(({ serverId, eventId }) => {
      if (serverId !== activeServerId) return;
      apiClient.getServerEvent(serverId, eventId)
        .then((updated) => {
          deferStoreUpdate(() => {
            useCalendarStore.getState().setCalendarEvents((p) => p.map((ev) => ev.id === eventId ? updated : ev));
            useCalendarStore.getState().setCalendarSelectedEvent((sel) => sel?.id === eventId ? updated : sel);
          });
        })
        .catch(() => {});
    });
    return () => {
      socketService.offServerEventCreated();
      socketService.offServerEventUpdated();
      socketService.offServerEventDeleted();
      socketService.offServerEventRsvp();
    };
  }, [activeServerId]);
}
