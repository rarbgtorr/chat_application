import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';

const script = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker(windows = []) {
  const handlers = {}, shown = [], delivered = [];
  runInNewContext(script, {
    URL, MessageChannel, setTimeout, clearTimeout,
    fetch: async (...args) => { delivered.push(args); },
    self: {
      location: { origin: 'https://chat.example' },
      clients: { matchAll: async () => windows },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      registration: {
        showNotification: async (title, options) => { shown.push({ title, ...options }); },
      },
    },
  });
  return { shown, delivered,
    push(payload) { let done; handlers.push({ data: { json: () => payload }, waitUntil: promise => { done = promise; } }); return done; },
  };
}

test('chat pushes remain silent while still grouping and acknowledging every message', async () => {
  const w = worker(), payload = { kind: 'reply', roomId: 'room-one', title: 'Wingfactor Support replied', body: 'A new reply is waiting.', url: '/c/room-one' };
  await Promise.all([w.push(payload), w.push(payload)]);
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0].renotify, false);
  assert.equal(w.shown[0].silent, true);
  assert.equal(w.shown[0].vibrate, undefined);
  assert.equal(w.shown[1].silent, true);
  assert.equal(w.shown[1].renotify, false);
  assert.equal(w.shown[0].tag, w.shown[1].tag);
  assert.equal(w.delivered.length, 2);
  await w.push(payload);
  assert.equal(w.shown[2].renotify, false);
  assert.equal(w.shown[2].silent, true);
});

test('visible matching chat suppresses push, while background tabs and different chats keep it', async () => {
  const notices = [], roomId = 'room-one';
  const window = { url: 'https://chat.example/?room=room-one', visibilityState: 'visible',
    postMessage(message, ports) { if (message.type === 'chat-visibility') ports[0].postMessage({ visible: message.roomId === roomId }); else notices.push(message); } };
  const open = worker([window]);
  await open.push({ kind: 'message', roomId, title: 'New message' });
  assert.equal(open.shown.length, 0); assert.equal(open.delivered.length, 1); assert.equal(notices[0].type, 'chat-message');
  await open.push({ kind: 'reply', roomId: 'room-two', title: 'New image' });
  assert.equal(open.shown.length, 1);
  window.visibilityState = 'hidden';
  await open.push({ kind: 'reply', roomId, title: 'New message' });
  assert.equal(open.shown.length, 2);
  window.visibilityState = 'visible';
  await open.push({ kind: 'call', roomId, title: 'Incoming video call' });
  assert.equal(open.shown.length, 3); assert.equal(open.shown[2].requireInteraction, true);
});

test('only incoming voice and video calls request audible push alerts', async () => {
  const w = worker();
  await w.push({ kind: 'message', roomId: 'room-one', title: 'New message' });
  await w.push({ kind: 'message', roomId: 'room-two', title: 'New message' });
  await w.push({ kind: 'call', roomId: 'room-one', tag: 'call-one', title: 'Incoming video call' });
  assert.equal(w.shown[1].silent, true);
  assert.equal(w.shown[1].vibrate, undefined);
  assert.equal(w.shown[2].requireInteraction, true);
  assert.equal(w.shown[2].renotify, true);
  assert.equal(w.shown[2].silent, undefined);
  assert.match(w.shown[2].title, /^Wingfactor/);
  await w.push({ kind: 'call', roomId: 'room-two', tag: 'call-two', title: 'Incoming voice call' });
  assert.equal(w.shown[3].silent, undefined);
  assert.equal(w.shown[3].renotify, true);
  assert.ok(w.shown[3].vibrate.length > 0);
});

test('notification targets stay on this site and invalid URLs still show an alert', async () => {
  const w = worker();
  for (const url of ['https://other.example/phishing', 'https://[invalid']) {
    await w.push({ title: 'New chat notification', url });
    assert.match(w.shown.at(-1).data.url, /^https:\/\/chat\.example\/?$/);
  }
});
