// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
/**
 * Frontend push notification manager.
 *
 * Handles:
 * - Requesting notification permission
 * - Subscribing to push via the service worker
 * - Sending the subscription to the backend
 * - Unsubscribing
 */

import { apiClient } from '../services/api';
import { API_BASE_URL } from '../config';

/** Check if push is supported in this browser */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** Get the current notification permission state */
export function getPushPermission(): NotificationPermission {
  if (!isPushSupported()) return 'denied';
  return Notification.permission;
}

/** Fetch the VAPID public key from the backend */
async function getVapidKey(): Promise<string | null> {
  try {
    const token = apiClient.getToken();
    const res = await fetch(`${API_BASE_URL}/push/vapid-key`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.publicKey || null;
  } catch {
    return null;
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from(rawData, (char) => char.charCodeAt(0));
}

/**
 * Request permission and subscribe to push notifications.
 * Returns true if successfully subscribed.
 */
export async function subscribeToPush(): Promise<boolean> {
  if (!isPushSupported()) return false;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return false;

  const vapidKey = await getVapidKey();
  if (!vapidKey) return false;

  const registration = await navigator.serviceWorker.ready;
  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    // Already subscribed — re-register with backend in case token changed
    await sendSubscriptionToBackend(existing);
    return true;
  }

  try {
    const keyBytes = urlBase64ToUint8Array(vapidKey);
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes.buffer.slice(keyBytes.byteOffset, keyBytes.byteOffset + keyBytes.byteLength) as ArrayBuffer,
    });
    await sendSubscriptionToBackend(subscription);
    return true;
  } catch {
    return false;
  }
}

async function sendSubscriptionToBackend(subscription: PushSubscription): Promise<void> {
  const token = apiClient.getToken();
  if (!token) return;

  await fetch(`${API_BASE_URL}/push/subscribe`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    credentials: 'include',
    body: JSON.stringify({ subscription: subscription.toJSON() }),
  }).catch(() => {});
}

/**
 * Unsubscribe from push notifications.
 */
export async function unsubscribeFromPush(): Promise<void> {
  if (!isPushSupported()) return;

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;

  const token = apiClient.getToken();
  if (token) {
    await fetch(`${API_BASE_URL}/push/unsubscribe`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      credentials: 'include',
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }).catch(() => {});
  }

  await subscription.unsubscribe().catch(() => {});
}
