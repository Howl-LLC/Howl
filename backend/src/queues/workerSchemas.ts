// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import { z } from 'zod';

export const emailJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('verification'), to: z.string().email(), code: z.string().min(1) }),
  z.object({ type: z.literal('passwordReset'), to: z.string().email(), code: z.string().min(1) }),
  z.object({ type: z.literal('mfaSms'), phone: z.string(), code: z.string().min(1) }),
  z.object({ type: z.literal('dataExportReady'), to: z.string().email(), code: z.string().min(1) }),
  z.object({ type: z.literal('emailChanged'), to: z.string().email(), newEmail: z.string().email() }),
  // admin-action notifications
  z.object({ type: z.literal('adminDisabledMfa'), to: z.string().email() }),
  z.object({ type: z.literal('adminChangedEmail'), to: z.string().email(), addressee: z.enum(['old', 'new']), newEmail: z.string().email() }),
  z.object({ type: z.literal('adminDeletedSessions'), to: z.string().email() }),
  z.object({ type: z.literal('adminPasswordReset'), to: z.string().email() }),
  // password-installed notification
  z.object({ type: z.literal('passwordInstalled'), to: z.string().email() }),
  // email-changed-with-revert
  z.object({ type: z.literal('emailChangedWithRevert'), to: z.string().email(), newEmail: z.string().email(), revertUrl: z.string().url() }),
  // new-device login notification
  z.object({
    type: z.literal('newDeviceLogin'),
    to: z.string().email(),
    deviceName: z.string().min(1).max(200),
    ipMasked: z.string().min(1).max(64),
    loginAtIso: z.string().datetime(),
    revokeUrl: z.string().url(),
  }),
  // Device-verification challenge (email 6-digit code for new-device login)
  z.object({
    type: z.literal('deviceVerify'),
    to: z.string().email(),
    code: z.string().regex(/^\d{6}$/),
    deviceLabel: z.string().min(1).max(200),
    ipMasked: z.string().min(1).max(64),
  }),
  // Username reset notification — sent when an automated cleanup script renames
  // a user (HTML-meta sanitization, severe-slur enforcement, etc.). The user
  // is informed of the new auto-assigned username and pointed at account
  // settings to choose a new one.
  z.object({
    type: z.literal('usernameResetRequired'),
    to: z.string().email(),
    oldUsername: z.string().min(1).max(64),
    newUsername: z.string().min(1).max(64),
    reason: z.enum(['profanity', 'sanitization']),
  }),
]);

export const imageJobSchema = z.object({
  filename: z.string().min(1),
  mimetype: z.string().min(1),
  originalSize: z.number().int().positive(),
  skipDerivatives: z.boolean().optional(),
});

export const importJobSchema = z.object({
  serverId: z.string().uuid(),
  userId: z.string().uuid(),
  channelId: z.string().uuid(),
  channelName: z.string().min(1),
  filePath: z.string().min(1),
});

export const exportJobSchema = z.object({
  requestId: z.string().uuid(),
  userId: z.string().uuid(),
});

export const cleanupJobSchema = z.object({
  task: z.enum([
    'expiredInvites', 'expiredVerifyCodes', 'expiredResetCodes', 'staleSessions',
    'staleAdminSessions', 'auditLogs', 'messageRetention', 'orphanAttachments',
    'stalePushSubs', 'expiredExports', 'expiredPowerUps', 'expiredPlans',
    'expiredTrialSetups', 'imageHashes', 'imageHashSweep', 'expiredGiftSubs',
    'stalePresence', 'expiredTrustedDevices',
    'expiredLoginVerifications', 'sessionPii', 'expiredTemporaryMembers',
    'mlsStalePendingRemoval', 'mlsRetentionSweep', 'lightweight', 'all',
  ]),
});

const activityBroadcastPayload = z.object({
  type: z.string().min(1),
  name: z.string().min(1),
  details: z.string().nullish(),
  state: z.string().nullish(),
  largeImage: z.string().nullish(),
  smallImage: z.string().nullish(),
  startedAt: z.string(),
  platformId: z.string().nullish(),
  platform: z.string().nullish(),
  durationMs: z.number().int().nullish(),
}).strict();

export const eventReminderJobSchema = z.object({}).strict();

export const calendarJobSchema = z.object({}).strict();

export const notificationCleanupJobSchema = z.object({}).strict();

export const analyticsJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('snapshot') }),
  z.object({ type: z.literal('purge') }),
  z.object({ type: z.literal('protocol-snapshot') }),
  z.object({ type: z.literal('protocol-purge') }),
]);

// Server-stats rollup worker for public/community servers.
// `daily` runs at 00:30 UTC and computes stats for the previous UTC day.
// `backfill` is the same logic but with an explicit ISO-date target so
// admins can re-run a missed day without manipulating cron timing.
export const serverStatsJobSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('daily') }),
  z.object({
    type: z.literal('backfill'),
    // Plain ISO date "YYYY-MM-DD"; the day in UTC to compute.
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
]);

// Discovery-eligibility refresh worker. Recomputes
// `ServerSettings.eligibleForDiscoverySince` for every server with
// `discoveryEnabled=true`, so cached eligibility doesn't drift when member
// count or recent message activity changes between owner-triggered reads.
export const discoveryEligibilityJobSchema = z.object({}).strict();

export const notificationJobSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('presence'),
    userId: z.string().uuid(),
    status: z.string().min(1),
  }),
  z.object({
    type: z.literal('mentions'),
    serverId: z.string().uuid(),
    channelId: z.string().uuid(),
    messageId: z.string().uuid(),
    content: z.string(),
    authorId: z.string().uuid(),
  }),
  z.object({
    type: z.literal('dm'),
    dmChannelId: z.string().uuid(),
    messageId: z.string().uuid(),
    content: z.string(),
    authorId: z.string().uuid(),
    recipientIds: z.array(z.string().uuid()),
    encrypted: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('activity'),
    userId: z.string().uuid(),
    activity: activityBroadcastPayload.nullable(),
    secondaryActivity: activityBroadcastPayload.nullable().optional(),
  }),
]);
