import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const script = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
function worker() {
  const handlers = {}, visible = new Map(), shown = [], delivered = [];
  let now = 100000;
  runInNewContext(script, {
    URL, Date: { now: () => now },
    fetch: async (...args) => { delivered.push(args); },
    self: {
      location: { origin: 'https://chat.example' },
      addEventListener: (name, handler) => { handlers[name] = handler; },
      registration: {
        getNotifications: async ({ tag }) => visible.has(tag) ? [visible.get(tag)] : [],
        showNotification: async (title, options) => { shown.push({ title, ...options }); visible.set(options.tag, options); },
      },
    },
  });
  return { shown, delivered, advance: ms => { now += ms; },
    push(payload) { let done; handlers.push({ data: { json: () => payload }, waitUntil: promise => { done = promise; } }); return done; },
  };
}

test('chat pushes group burst updates without delaying notifications or delivery receipts', async () => {
  const w = worker(), payload = { kind: 'reply', roomId: 'room-one', title: 'Wingfactor Support replied', body: 'A new reply is waiting.', url: '/c/room-one' };
  await Promise.all([w.push(payload), w.push(payload)]);
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0].renotify, true);
  assert.equal(w.shown[1].silent, true);
  assert.equal(w.shown[1].renotify, false);
  assert.equal(w.shown[0].tag, w.shown[1].tag);
  assert.equal(w.delivered.length, 2);
  w.advance(15001); await w.push(payload);
  assert.equal(w.shown[2].renotify, true);
  assert.equal(w.shown[2].silent, undefined);
});

test('incoming calls remain audible during message bursts and other rooms alert immediately', async () => {
  const w = worker();
  await w.push({ kind: 'message', roomId: 'room-one', title: 'New message' });
  await w.push({ kind: 'message', roomId: 'room-two', title: 'New message' });
  await w.push({ kind: 'call', roomId: 'room-one', tag: 'call-one', title: 'Incoming video call' });
  assert.equal(w.shown[1].renotify, true);
  assert.equal(w.shown[2].requireInteraction, true);
  assert.equal(w.shown[2].renotify, true);
  assert.equal(w.shown[2].silent, undefined);
  assert.match(w.shown[2].title, /^Wingfactor/);
});

test('notification targets stay on this site and invalid URLs still show an alert', async () => {
  const w = worker();
  for (const url of ['https://other.example/phishing', 'https://[invalid']) {
    await w.push({ title: 'New chat notification', url });
    assert.match(w.shown.at(-1).data.url, /^https:\/\/chat\.example\/?$/);
  }
});
