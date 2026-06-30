/**
 * Push notification event handlers for the service worker.
 * This file is injected into the main SW via importScripts or inlined.
 */

function sanitizeText(str) {
  return String(str || '').slice(0, 500);
}

function safeIconUrl(raw) {
  if (typeof raw !== 'string') return '/howl-logo.png';
  var trimmed = raw.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\')) return trimmed;
  return '/howl-logo.png';
}

self.addEventListener('push', (event) => {
  if (!event.data) return;

  let payload;
  try {
    payload = event.data.json();
  } catch {
    payload = { title: 'Howl', body: event.data.text() };
  }

  const options = {
    body: sanitizeText(payload.body),
    icon: safeIconUrl(payload.icon),
    badge: safeIconUrl(payload.badge),
    tag: sanitizeText(payload.tag) || 'howl-notification',
    data: { url: payload.url || '/', ...payload.data },
    vibrate: [200, 100, 200],
    actions: [],
  };

  event.waitUntil(self.registration.showNotification(sanitizeText(payload.title) || 'Howl', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const raw = event.notification.data?.url || '/';
  let url = '/';

  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.includes('\\')) {
      try {
        const resolved = new URL(trimmed, self.location.origin);
        if (resolved.origin === self.location.origin) {
          url = resolved.pathname + resolved.search + resolved.hash;
        }
      } catch { /* fall back to '/' */ }
    }
  }

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: false }).then((clientList) => {
      for (const client of clientList) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          client.focus();
          client.navigate(url);
          return;
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
