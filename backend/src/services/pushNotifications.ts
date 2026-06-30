// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Web Push notification service.
 *
 * Sends push notifications to user's registered browser/device subscriptions.
 * Uses the web-push library with VAPID authentication.
 */

import webpush from 'web-push';
import { prisma } from '../db.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'push' });

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@howl.app';

export const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  log.info('web push enabled');
} else {
  log.info('web push disabled — set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable');
}

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  badge?: string;
  tag?: string;
  url?: string;
  data?: Record<string, unknown>;
}

/**
 * Send a push notification to all of a user's registered subscriptions.
 * Silently removes any subscriptions that have expired or been revoked.
 */
export async function sendPushToUser(userId: string, payload: PushPayload): Promise<number> {
  if (!pushEnabled) return 0;

  const subscriptions = await prisma.pushSubscription.findMany({
    where: { userId },
    take: 50,
  });

  if (subscriptions.length === 0) return 0;

  let sent = 0;
  const staleIds: string[] = [];

  const jsonPayload = JSON.stringify(payload);

  await Promise.allSettled(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.p256dh, auth: sub.auth },
          },
          jsonPayload,
          { TTL: 3600 },
        );
        sent++;
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          staleIds.push(sub.id);
        } else {
          log.warn({ err: err.message, endpoint: sub.endpoint.slice(0, 50) }, 'push send failed');
        }
      }
    }),
  );

  // Clean up expired/revoked subscriptions
  if (staleIds.length > 0) {
    await prisma.pushSubscription.deleteMany({
      where: { id: { in: staleIds } },
    }).catch(() => {});
  }

  return sent;
}

/**
 * Send push notifications to multiple users at once (e.g. mention fanout).
 */
export async function sendPushToUsers(userIds: string[], payload: PushPayload): Promise<number> {
  if (!pushEnabled || userIds.length === 0) return 0;

  let totalSent = 0;
  for (const userId of userIds) {
    totalSent += await sendPushToUser(userId, payload);
  }
  return totalSent;
}
