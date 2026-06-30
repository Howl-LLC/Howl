// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Calendar / server event action utilities.
 * Extracted from App.tsx useCallback handlers for reuse outside React components.
 */
import { apiClient } from '../services/api';
import { useCalendarStore } from '../stores/calendarStore';
import { isRealServerId } from './navigationHelpers';
import type { ServerEvent } from '../types';

// Open create event modal

export function openCreateEventModal(date?: Date): void {
  useCalendarStore.getState().setCalendarCreateModal({
    open: true,
    initialDate: date ?? null,
    editEvent: null,
  });
}

// Select an event

export function selectEvent(event: ServerEvent): void {
  useCalendarStore.getState().setCalendarSelectedEvent(event);
}

// Change calendar month

export function changeMonth(year: number, month: number): void {
  useCalendarStore.getState().setCalendarMonth({ year, month });
}

// Submit event (create or edit)

export async function submitEvent(
  activeServerId: string,
  data: Parameters<typeof apiClient.createServerEvent>[1],
  editEvent?: ServerEvent | null,
): Promise<void> {
  if (!isRealServerId(activeServerId)) return;
  if (editEvent) {
    const updated = await apiClient.updateServerEvent(activeServerId, editEvent.id, data);
    useCalendarStore.getState().setCalendarEvents((prev) =>
      prev.map((e) => (e.id === updated.id ? updated : e)),
    );
    useCalendarStore.getState().setCalendarSelectedEvent((sel) =>
      sel?.id === updated.id ? updated : sel,
    );
  } else {
    const created = await apiClient.createServerEvent(activeServerId, data);
    // Dedup against the socket path. Backend fires `io.emit('server-event-
    // created')` before returning the HTTP response; the socket and HTTP
    // travel on independent connections so the broadcast can land at the
    // client first. The socket handler in useCalendarSocketEvents already
    // dedups by id, but its early add then collides with the unconditional
    // `[...prev, created]` here, leaving two copies of the same row in the
    // store. Visible especially on recurring events, which expand each row
    // into multiple occurrences in the week / day views.
    useCalendarStore.getState().setCalendarEvents((prev) =>
      prev.some((e) => e.id === created.id) ? prev : [...prev, created],
    );
  }
}

// Delete event

export async function deleteEvent(activeServerId: string, eventId: string): Promise<void> {
  if (!isRealServerId(activeServerId)) return;
  await apiClient.deleteServerEvent(activeServerId, eventId);
  useCalendarStore.getState().setCalendarEvents((prev) =>
    prev.filter((e) => e.id !== eventId),
  );
  useCalendarStore.getState().setCalendarSelectedEvent(null);
}

// Open edit event modal

export function openEditEventModal(event: ServerEvent): void {
  useCalendarStore.getState().setCalendarCreateModal({
    open: true,
    initialDate: null,
    editEvent: event,
  });
}

// RSVP to an event

export async function rsvpEvent(
  activeServerId: string,
  eventId: string,
  status: 'GOING' | 'INTERESTED' | 'DECLINED',
): Promise<void> {
  if (!isRealServerId(activeServerId)) return;
  await apiClient.rsvpEvent(activeServerId, eventId, status);
  const updated = await apiClient.getServerEvent(activeServerId, eventId);
  useCalendarStore.getState().setCalendarEvents((prev) =>
    prev.map((e) => (e.id === eventId ? updated : e)),
  );
  useCalendarStore.getState().setCalendarSelectedEvent((sel) =>
    sel?.id === eventId ? updated : sel,
  );
}

// Remove RSVP

export async function removeRsvp(activeServerId: string, eventId: string): Promise<void> {
  if (!isRealServerId(activeServerId)) return;
  await apiClient.removeRsvp(activeServerId, eventId);
  const updated = await apiClient.getServerEvent(activeServerId, eventId);
  useCalendarStore.getState().setCalendarEvents((prev) =>
    prev.map((e) => (e.id === eventId ? updated : e)),
  );
  useCalendarStore.getState().setCalendarSelectedEvent((sel) =>
    sel?.id === eventId ? updated : sel,
  );
}
