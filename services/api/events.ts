// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { ServerEvent, EventReminderTiming } from '../../types';

interface EventInviteeInput {
  scope: 'EVERYONE' | 'ROLE' | 'USER';
  targetId?: string;
}

declare module './core' {
  interface APIClient {
    getServerEvents(serverId: string, month?: number, year?: number): Promise<ServerEvent[]>;
    getServerEvent(serverId: string, eventId: string): Promise<ServerEvent>;
    createServerEvent(serverId: string, data: {
      title: string; description?: string; startTime: string; endTime: string;
      allDay?: boolean; color?: string; timezone?: string;
      reminderChannelId?: string; reminders?: EventReminderTiming[];
      invitees?: EventInviteeInput[];
      recurrenceRule?: string; recurrenceDays?: number[];
      recurrenceEndDate?: string | null; voiceChannelId?: string | null;
      reminderMentions?: { everyone?: boolean; here?: boolean; roleIds?: string[] } | null;
    }): Promise<ServerEvent>;
    updateServerEvent(serverId: string, eventId: string, data: Partial<{
      title: string; description: string | null; startTime: string; endTime: string;
      allDay: boolean; color: string; timezone: string;
      reminderChannelId: string | null; reminders: EventReminderTiming[];
      invitees: EventInviteeInput[];
      recurrenceRule: string; recurrenceDays: number[];
      recurrenceEndDate: string | null; voiceChannelId: string | null;
      reminderMentions: { everyone?: boolean; here?: boolean; roleIds?: string[] } | null;
    }>): Promise<ServerEvent>;
    deleteServerEvent(serverId: string, eventId: string): Promise<void>;
    rsvpEvent(serverId: string, eventId: string, status: 'GOING' | 'INTERESTED' | 'DECLINED'): Promise<void>;
    removeRsvp(serverId: string, eventId: string): Promise<void>;
  }
}

APIClient.prototype.getServerEvents = async function(this: APIClient, serverId: string, month?: number, year?: number): Promise<ServerEvent[]> {
  const params = new URLSearchParams();
  if (month) params.set('month', String(month));
  if (year) params.set('year', String(year));
  const qs = params.toString();
  return this.request<ServerEvent[]>(`/servers/${serverId}/events${qs ? `?${qs}` : ''}`);
};

APIClient.prototype.getServerEvent = async function(this: APIClient, serverId: string, eventId: string): Promise<ServerEvent> {
  return this.request<ServerEvent>(`/servers/${serverId}/events/${eventId}`);
};

APIClient.prototype.createServerEvent = async function(this: APIClient, serverId: string, data) {
  return this.request<ServerEvent>(`/servers/${serverId}/events`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.updateServerEvent = async function(this: APIClient, serverId: string, eventId: string, data) {
  return this.request<ServerEvent>(`/servers/${serverId}/events/${eventId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteServerEvent = async function(this: APIClient, serverId: string, eventId: string) {
  await this.request(`/servers/${serverId}/events/${eventId}`, { method: 'DELETE' });
};

APIClient.prototype.rsvpEvent = async function(this: APIClient, serverId: string, eventId: string, status) {
  await this.request(`/servers/${serverId}/events/${eventId}/rsvp`, {
    method: 'PUT',
    body: JSON.stringify({ status }),
  });
};

APIClient.prototype.removeRsvp = async function(this: APIClient, serverId: string, eventId: string) {
  await this.request(`/servers/${serverId}/events/${eventId}/rsvp`, { method: 'DELETE' });
};
