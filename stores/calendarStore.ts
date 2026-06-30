// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { create } from 'zustand';
import type { ServerEvent } from '../types';

const MAX_CALENDAR_EVENTS = 500;

interface CalendarState {
  calendarEvents: ServerEvent[];
  calendarMonth: { year: number; month: number };
  calendarCreateModal: { open: boolean; initialDate?: Date | null; editEvent?: ServerEvent | null };
  calendarSelectedEvent: ServerEvent | null;
  calendarLoading: boolean;

  setCalendarEvents(events: ServerEvent[] | ((prev: ServerEvent[]) => ServerEvent[])): void;
  setCalendarMonth(month: CalendarState['calendarMonth']): void;
  setCalendarCreateModal(modal: CalendarState['calendarCreateModal']): void;
  setCalendarSelectedEvent(event: ServerEvent | null | ((prev: ServerEvent | null) => ServerEvent | null)): void;
  setCalendarLoading(v: boolean): void;
}

export const useCalendarStore = create<CalendarState>()((set) => ({
  calendarEvents: [],
  calendarMonth: { year: new Date().getFullYear(), month: new Date().getMonth() + 1 },
  calendarCreateModal: { open: false },
  calendarSelectedEvent: null,
  calendarLoading: false,

  setCalendarEvents(events) {
    // Dedup by id at the store boundary. Optimistic-add + socket-broadcast +
    // GET-replace already individually dedup, but any latent duplicate row
    // (e.g. left over from before the fast-double-click guard landed) would
    // paint two chips on every recurrence day. Collapsing here makes that
    // class of bug invisible to the rendering layer regardless of source.
    const dedup = (arr: ServerEvent[]): ServerEvent[] => {
      const seen = new Set<string>();
      const out: ServerEvent[] = [];
      for (const ev of arr) {
        if (seen.has(ev.id)) continue;
        seen.add(ev.id);
        out.push(ev);
      }
      return out;
    };
    if (typeof events === 'function') {
      set((state) => {
        const raw = (events as (prev: ServerEvent[]) => ServerEvent[])(state.calendarEvents);
        if (raw === state.calendarEvents) return state; // no-op: skip re-render
        const next = dedup(raw);
        return { calendarEvents: next.length > MAX_CALENDAR_EVENTS ? next.slice(0, MAX_CALENDAR_EVENTS) : next };
      });
    } else {
      const next = dedup(events);
      set({ calendarEvents: next.length > MAX_CALENDAR_EVENTS ? next.slice(0, MAX_CALENDAR_EVENTS) : next });
    }
  },
  setCalendarMonth(month) { set({ calendarMonth: month }); },
  setCalendarCreateModal(modal) { set({ calendarCreateModal: modal }); },
  setCalendarSelectedEvent(event) {
    if (typeof event === 'function') set((state) => ({ calendarSelectedEvent: (event as (prev: ServerEvent | null) => ServerEvent | null)(state.calendarSelectedEvent) }));
    else set({ calendarSelectedEvent: event });
  },
  setCalendarLoading(v) { set({ calendarLoading: v }); },
}));
