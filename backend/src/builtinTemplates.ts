// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
export interface BuiltInTemplateChannel {
  name: string;
  type: 'text' | 'voice';
}

export interface BuiltInTemplateCategory {
  name: string;
  channels: BuiltInTemplateChannel[];
}

export interface BuiltInTemplateRole {
  name: string;
  color: string;
  permissions: Record<string, boolean>;
}

export interface BuiltInTemplate {
  name: string;
  categories: BuiltInTemplateCategory[];
  extraRoles: BuiltInTemplateRole[];
}

// Moderator-tier perms layered on top of @everyone baseline.
// Baseline perms (viewChannels, sendMessages, readMessageHistory, etc.) now
// come from the server's @everyone role — no need to restate them here.
const moderatorPerms = {
  kickMembers: true, banMembers: true, manageMessages: true,
};

export const BUILT_IN_TEMPLATES: Record<string, BuiltInTemplate> = {
  'gaming': {
    name: 'Gaming',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'rules', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'memes', type: 'text' }, { name: 'clips', type: 'text' }] },
      { name: 'Gaming', channels: [{ name: 'lfg', type: 'text' }, { name: 'game-chat', type: 'text' }, { name: 'strategy', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'lobby-1', type: 'voice' }, { name: 'lobby-2', type: 'voice' }, { name: 'afk', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Moderator', color: '#22c55e', permissions: moderatorPerms }],
  },
  'friends': {
    name: 'Friends',
    categories: [
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'photos', type: 'text' }, { name: 'memes', type: 'text' }] },
      { name: 'Hangout', channels: [{ name: 'lounge', type: 'voice' }, { name: 'music', type: 'voice' }, { name: 'stream', type: 'voice' }] },
    ],
    extraRoles: [],
  },
  'study-group': {
    name: 'Study Group',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'resources', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'homework-help', type: 'text' }, { name: 'study-tips', type: 'text' }] },
      { name: 'Subjects', channels: [{ name: 'math', type: 'text' }, { name: 'science', type: 'text' }, { name: 'english', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'study-room-1', type: 'voice' }, { name: 'study-room-2', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Tutor', color: '#3b82f6', permissions: { ...moderatorPerms, kickMembers: false, banMembers: false } }],
  },
  'school-club': {
    name: 'School Club',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'schedule', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'ideas', type: 'text' }, { name: 'off-topic', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'meeting-room', type: 'voice' }, { name: 'hangout', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Officer', color: '#a855f7', permissions: { ...moderatorPerms, manageChannels: true } }],
  },
  'local-community': {
    name: 'Local Community',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'rules', type: 'text' }, { name: 'events', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'marketplace', type: 'text' }, { name: 'recommendations', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'town-hall', type: 'voice' }, { name: 'hangout', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Moderator', color: '#22c55e', permissions: moderatorPerms }],
  },
  'artists-creators': {
    name: 'Artists & Creators',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'rules', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'inspiration', type: 'text' }, { name: 'feedback', type: 'text' }] },
      { name: 'Showcase', channels: [{ name: 'art-share', type: 'text' }, { name: 'work-in-progress', type: 'text' }, { name: 'commissions', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'studio', type: 'voice' }, { name: 'critique', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Curator', color: '#ec4899', permissions: { ...moderatorPerms, kickMembers: false, banMembers: false } }],
  },
  'content-creators': {
    name: 'Content Creators',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'schedule', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'collabs', type: 'text' }, { name: 'self-promo', type: 'text' }] },
      { name: 'Content', channels: [{ name: 'feedback', type: 'text' }, { name: 'clips-highlights', type: 'text' }, { name: 'behind-the-scenes', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'stream-planning', type: 'voice' }, { name: 'watch-party', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Moderator', color: '#22c55e', permissions: moderatorPerms }],
  },
  'dev-team': {
    name: 'Dev Team',
    categories: [
      { name: 'Info', channels: [{ name: 'announcements', type: 'text' }, { name: 'resources', type: 'text' }] },
      { name: 'General', channels: [{ name: 'general', type: 'text' }, { name: 'introductions', type: 'text' }, { name: 'off-topic', type: 'text' }] },
      { name: 'Development', channels: [{ name: 'bugs', type: 'text' }, { name: 'feature-requests', type: 'text' }, { name: 'code-review', type: 'text' }, { name: 'docs', type: 'text' }] },
      { name: 'Voice', channels: [{ name: 'standup', type: 'voice' }, { name: 'pair-programming', type: 'voice' }] },
    ],
    extraRoles: [{ name: 'Lead', color: '#f59e0b', permissions: { ...moderatorPerms, manageChannels: true, manageRoles: true } }],
  },
};
