// Deliberately no fetch cache: private messages and attachments stay out of CacheStorage.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
let notificationQueue = Promise.resolve();
self.addEventListener('push', event => {
  let payload = { title: 'Wingfactor Support', body: 'You have a new support notification.', url: '/' };
  try { payload = { ...payload, ...event.data.json() }; } catch {}
  let target;
  try { target = new URL(payload.url || '/', self.location.origin); } catch { target = new URL('/', self.location.origin); }
  const call = payload.kind === 'call';
  const chatMessage = ['message', 'reply'].includes(payload.kind);
  const notification = notificationQueue.catch(() => {}).then(async () => {
    // Chat notifications stay visible but silent; sound and vibration are for calls only.
    const tag = chatMessage && payload.roomId ? `chat-${payload.roomId}` : payload.tag || `support-${payload.kind || 'update'}`;
    const title = String(payload.title || 'New chat notification');
    await self.registration.showNotification(/wingfactor/i.test(title) ? title : `Wingfactor · ${title}`, {
      body: payload.body, icon: '/icon.svg', badge: '/icon.svg',
      tag, renotify: call, requireInteraction: call,
      ...(call ? { vibrate: [500, 200, 500, 200, 500] } : { silent: true }),
      data: { url: target.origin === self.location.origin ? target.href : self.location.origin },
    });
  });
  notificationQueue = notification;
  const delivered = ['message', 'reply'].includes(payload.kind) && payload.roomId
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
