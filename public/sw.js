// Deliberately no fetch cache: private messages and attachments stay out of CacheStorage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = { title: 'Wingfactor Support', body: 'You have a new support notification.', url: '/' };
  try { payload = { ...payload, ...event.data.json() }; } catch {}
  const target = new URL(payload.url || '/', self.location.origin);
  const call = payload.kind === 'call';
  const notification = self.registration.showNotification(payload.title, {
    body: payload.body, icon: '/icon.svg', badge: '/icon.svg',
    tag: payload.tag || 'support', renotify: true, requireInteraction: call,
    vibrate: call ? [500, 200, 500, 200, 500] : [200, 100, 200],
    data: { url: target.origin === self.location.origin ? target.href : self.location.origin },
  });
  const delivered = payload.kind === 'message' && payload.roomId
    ? fetch('/api/delivered', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomIds: [payload.roomId] }) }).catch(() => {})
    : Promise.resolve();
  event.waitUntil(Promise.allSettled([notification, delivered]));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const url = event.notification.data?.url || self.location.origin;
    for (const window of windows) {
      if (new URL(window.url).origin === self.location.origin) {
        await window.navigate(url); return window.focus();
      }
    }
    return self.clients.openWindow(url);
  })());
});
