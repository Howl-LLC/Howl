// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { APIClient } from './core';
import type { Poll } from '../../types';

interface CreatePollData {
  question: string;
  options: (string | { text: string; emoji?: string })[];
  allowMultiple: boolean;
  anonymous: boolean;
  duration: string;
}

interface EditPollData {
  question?: string;
  allowMultiple?: boolean;
  anonymous?: boolean;
  duration?: string;
  closePoll?: boolean;
}

declare module './core' {
  interface APIClient {
    createPoll(channelId: string, serverId: string, data: CreatePollData): Promise<Poll>;
    getPolls(channelId: string, serverId: string, limit?: number): Promise<Poll[]>;
    votePoll(pollId: string, optionId: string, serverId: string, channelId: string): Promise<Poll>;
    removeVotePoll(pollId: string, optionId: string, serverId: string, channelId: string): Promise<Poll>;
    editPoll(pollId: string, data: EditPollData, serverId: string, channelId: string): Promise<Poll>;
    deletePoll(pollId: string, serverId: string, channelId: string): Promise<void>;
    createDmPoll(dmChannelId: string, data: CreatePollData): Promise<Poll>;
    getDmPolls(dmChannelId: string, limit?: number): Promise<Poll[]>;
    voteDmPoll(pollId: string, optionId: string, dmChannelId: string): Promise<Poll>;
    removeVoteDmPoll(pollId: string, optionId: string, dmChannelId: string): Promise<Poll>;
    editDmPoll(pollId: string, data: EditPollData, dmChannelId: string): Promise<Poll>;
    deleteDmPoll(pollId: string, dmChannelId: string): Promise<void>;
    getPollVoters(pollId: string, optionId: string, serverId: string, channelId: string, limit?: number): Promise<{
      voters: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; votedAt: string }>;
      total: number;
    }>;
    getDmPollVoters(pollId: string, optionId: string, dmChannelId: string, limit?: number): Promise<{
      voters: Array<{ id: string; username: string; discriminator?: string; avatar?: string | null; votedAt: string }>;
      total: number;
    }>;
  }
}

// Server channel polls

APIClient.prototype.createPoll = async function(this: APIClient, channelId: string, serverId: string, data: CreatePollData): Promise<Poll> {
  return this.request<Poll>(`/servers/${serverId}/channels/${channelId}/polls`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.getPolls = async function(this: APIClient, channelId: string, serverId: string, limit = 20): Promise<Poll[]> {
  return this.request<Poll[]>(`/servers/${serverId}/channels/${channelId}/polls?limit=${limit}`);
};

APIClient.prototype.votePoll = async function(this: APIClient, pollId: string, optionId: string, serverId: string, channelId: string): Promise<Poll> {
  return this.request<Poll>(`/servers/${serverId}/channels/${channelId}/polls/${pollId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ optionId }),
  });
};

APIClient.prototype.removeVotePoll = async function(this: APIClient, pollId: string, optionId: string, serverId: string, channelId: string): Promise<Poll> {
  return this.request<Poll>(`/servers/${serverId}/channels/${channelId}/polls/${pollId}/vote/${optionId}`, {
    method: 'DELETE',
  });
};

APIClient.prototype.editPoll = async function(this: APIClient, pollId: string, data: EditPollData, serverId: string, channelId: string): Promise<Poll> {
  return this.request<Poll>(`/servers/${serverId}/channels/${channelId}/polls/${pollId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deletePoll = async function(this: APIClient, pollId: string, serverId: string, channelId: string): Promise<void> {
  await this.request<void>(`/servers/${serverId}/channels/${channelId}/polls/${pollId}`, {
    method: 'DELETE',
  });
};

// DM polls

APIClient.prototype.createDmPoll = async function(this: APIClient, dmChannelId: string, data: CreatePollData): Promise<Poll> {
  return this.request<Poll>(`/dms/${dmChannelId}/polls`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.getDmPolls = async function(this: APIClient, dmChannelId: string, limit = 20): Promise<Poll[]> {
  return this.request<Poll[]>(`/dms/${dmChannelId}/polls?limit=${limit}`);
};

APIClient.prototype.voteDmPoll = async function(this: APIClient, pollId: string, optionId: string, dmChannelId: string): Promise<Poll> {
  return this.request<Poll>(`/dms/${dmChannelId}/polls/${pollId}/vote`, {
    method: 'POST',
    body: JSON.stringify({ optionId }),
  });
};

APIClient.prototype.removeVoteDmPoll = async function(this: APIClient, pollId: string, optionId: string, dmChannelId: string): Promise<Poll> {
  return this.request<Poll>(`/dms/${dmChannelId}/polls/${pollId}/vote/${optionId}`, {
    method: 'DELETE',
  });
};

APIClient.prototype.editDmPoll = async function(this: APIClient, pollId: string, data: EditPollData, dmChannelId: string): Promise<Poll> {
  return this.request<Poll>(`/dms/${dmChannelId}/polls/${pollId}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
};

APIClient.prototype.deleteDmPoll = async function(this: APIClient, pollId: string, dmChannelId: string): Promise<void> {
  await this.request<void>(`/dms/${dmChannelId}/polls/${pollId}`, {
    method: 'DELETE',
  });
};

// Voter lists

APIClient.prototype.getPollVoters = async function(this: APIClient, pollId: string, optionId: string, serverId: string, channelId: string, limit = 50) {
  return this.request(`/servers/${serverId}/channels/${channelId}/polls/${pollId}/options/${optionId}/voters?limit=${limit}`);
};

APIClient.prototype.getDmPollVoters = async function(this: APIClient, pollId: string, optionId: string, dmChannelId: string, limit = 50) {
  return this.request(`/dms/${dmChannelId}/polls/${pollId}/options/${optionId}/voters?limit=${limit}`);
};
