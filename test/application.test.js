import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.js';
import { id, passwordHash, hash } from '../server/store.js';

const origin = 'http://localhost:3000';
const password = 'test-password-long-enough';
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'wingfactor-test-'));
  let now = 1800000000000; const deliveries = [];
  const app = createApp({ directory, origin, clock: () => now, startWorker: false,
    sendPush: async (subscription, payload) => deliveries.push({ subscription, payload }) });
  const { run } = app.store;
  const admin = id(), agent = id(), other = id();
  for (const [userId, username, name, role] of [[admin, 'owner', 'Owner', 'admin'], [agent, 'teammate', 'Teammate', 'agent'], [other, 'unassigned', 'Other', 'agent']]) {
    run('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)', userId, username, name, role, passwordHash(password));
  }
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const jar = {};
  async function request(who, path, { method = 'GET', body, headers = {} } = {}) {
    const response = await fetch(base + path, { method,
      headers: { Origin: origin, ...(jar[who] ? { Cookie: jar[who] } : {}),
        ...(body && !Buffer.isBuffer(body) ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? Buffer.isBuffer(body) ? body : JSON.stringify(body) : undefined,
    });
    const cookie = response.headers.get('set-cookie'); if (cookie) jar[who] = cookie.split(';')[0];
    const bytes = Buffer.from(await response.arrayBuffer());
    const data = response.headers.get('content-type')?.includes('application/json') ? JSON.parse(bytes.toString()) : bytes;
    return { status: response.status, data, headers: response.headers };
  }
  for (const [who, username] of [['admin', 'owner'], ['agent', 'teammate'], ['other', 'unassigned']]) {
    assert.equal((await request(who, '/api/login', { method: 'POST', body: { username, password } })).status, 200);
  }
  async function room(overrides = {}) {
    const r = await request('admin', '/api/rooms', { method: 'POST', body: {
      name: 'SECRET CLIENT NAME', contact: '+91-9876543210', notes: 'PRIVATE ADMIN NOTES', agentIds: [agent], ...overrides,
    } }); assert.equal(r.status, 201);
    const key = new URLSearchParams(new URL(r.data.link).hash.slice(1)).get('key');
    assert.equal((await request('client', '/api/client/session', { method: 'POST', body: { key } })).status, 200);
    return r.data;
  }
  async function message(who, roomId, value, nonce = id()) {
    return request(who, `/api/rooms/${roomId}/messages`, { method: 'POST', body: { body: value, nonce } });
  }
  async function subscribe(who, suffix = who) {
    const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/test-${suffix}`, keys: {
      auth: 'A'.repeat(22), p256dh: 'B'.repeat(87),
    } };
    assert.equal((await request(who, '/api/push', { method: 'POST', body: { subscription } })).status, 200);
    return subscription;
  }
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, request, room, message, subscribe, deliveries, advance: ms => { now += ms; }, ids: { admin, agent, other }, directory, base, jar };
}

test('server protects client identity, admin-only routes, and unassigned conversations', async t => {
  const f = await fixture(t); const room = await f.room();
  const agentRooms = await f.request('agent', '/api/rooms'); assert.equal(agentRooms.status, 200);
  assert.deepEqual(agentRooms.data[0].client, { name: 'SECRET CLIENT NAME', notes: 'PRIVATE ADMIN NOTES' });
  assert.equal(JSON.stringify(agentRooms.data).includes('9876543210'), false);
  assert.equal(JSON.stringify(agentRooms.data).includes('private'), false);
  const clientRooms = await f.request('client', '/api/rooms'); assert.equal(clientRooms.status, 200);
  const clientPayload = JSON.stringify(clientRooms.data);
  for (const secret of ['SECRET CLIENT NAME', '9876543210', 'PRIVATE ADMIN NOTES', 'private', 'client']) assert.equal(clientPayload.includes(secret), false);
  for (const role of ['agent', 'client']) {
    const rooms = role === 'agent' ? agentRooms : clientRooms;
    assert.equal(rooms.data[0].code, room.code);
    assert.equal((await f.request(role, '/api/users')).status, 403);
    assert.equal((await f.request(role, `/api/rooms/${room.roomId}`, { method: 'DELETE' })).status, 403);
    assert.equal((await f.request(role, `/api/rooms/${room.roomId}/link`, { method: 'POST' })).status, 403);
  }
  assert.equal((await f.request('other', '/api/rooms')).data.length, 0);
  assert.equal((await f.request('other', `/api/rooms/${room.roomId}/messages`)).status, 404);
  assert.equal((await f.message('other', room.roomId, 'intrusion')).status, 404);
  assert.equal((await f.request('admin', '/api/rooms')).data[0].private.contact, '+91-9876543210');
});

test('messages are bidirectional, idempotent, and safely retain raw text for escaped rendering', async t => {
  const f = await fixture(t), room = await f.room(), nonce = id();
  const first = await f.message('client', room.roomId, '<script>alert(1)</script>', nonce);
  const duplicate = await f.message('client', room.roomId, '<script>alert(1)</script>', nonce);
  assert.equal(first.status, 201); assert.equal(first.data.id, duplicate.data.id);
  assert.equal((await f.message('agent', room.roomId, 'Hello, I can help.')).status, 201);
  const history = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(history.length, 2); assert.equal(history[0].own, true); assert.equal(history[1].own, false);
  assert.equal(history[1].sender, 'Wingfactor Support');
  assert.equal(JSON.stringify(history).includes('SECRET CLIENT NAME'), false);
  assert.equal(f.app.store.get('SELECT * FROM cycles WHERE room_id=?', room.roomId), undefined);
});

test('receipts progress in both directions between the client and assigned teammate', async t => {
  const f = await fixture(t), room = await f.room();
  const message = await f.message('client', room.roomId, 'Please check this.');
  let history = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(history[0].delivery, 'sent');
  assert.equal((await f.request('other', '/api/delivered', { method: 'POST', body: { roomIds: [room.roomId] } })).status, 200);
  history = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(history[0].delivery, 'sent');
  assert.equal((await f.request('agent', '/api/delivered', { method: 'POST', body: { roomIds: [room.roomId] } })).status, 200);
  history = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(history[0].delivery, 'delivered');
  await f.request('agent', `/api/rooms/${room.roomId}/read`, { method: 'POST', body: { seq: message.data.seq } });
  history = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(history[0].delivery, 'read');

  const reply = await f.message('agent', room.roomId, 'I am checking it now.');
  let agentHistory = (await f.request('agent', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(agentHistory.at(-1).delivery, 'sent');
  assert.equal((await f.request('client', '/api/delivered', { method: 'POST', body: { roomIds: [room.roomId] } })).status, 200);
  agentHistory = (await f.request('agent', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(agentHistory.at(-1).delivery, 'delivered');
  await f.request('client', `/api/rooms/${room.roomId}/read`, { method: 'POST', body: { seq: reply.data.seq } });
  agentHistory = (await f.request('agent', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(agentHistory.at(-1).delivery, 'read');
});

test('attachments reach teammates directly, support ranges, and remain private to their room', async t => {
  const f = await fixture(t), room = await f.room();
  const upload = await f.request('client', `/api/rooms/${room.roomId}/upload`, { method: 'POST',
    body: Buffer.from('sample-media-content'), headers: { 'X-Filename': encodeURIComponent('client-file.pdf'), 'Content-Type': 'application/pdf' } });
  assert.equal(upload.status, 201);
  const attachmentId = upload.data.attachmentId;
  assert.equal((await f.request('client', `/api/rooms/${room.roomId}/messages`, { method: 'POST', body: { attachmentId, nonce: id() } })).status, 201);
  const media = await f.request('agent', `/api/media/${attachmentId}`);
  assert.equal(media.status, 200); assert.equal(media.data.toString(), 'sample-media-content');
  assert.match(media.headers.get('content-disposition'), /^attachment/);
  assert.equal((await f.request('other', `/api/media/${attachmentId}`)).status, 404);
  const range = await f.request('agent', `/api/media/${attachmentId}`, { headers: { Range: 'bytes=0-5' } });
  assert.equal(range.status, 206); assert.equal(range.data.toString(), 'sample');
  assert.equal((await f.request('client', `/api/rooms/${room.roomId}/upload`, { method: 'POST',
    body: Buffer.from('<script/>'), headers: { 'X-Filename': 'bad.html' } })).status, 415);
  // An attachment uploaded by another principal cannot be attached as your own message.
  assert.equal((await f.request('agent', `/api/rooms/${room.roomId}/messages`, { method: 'POST', body: { attachmentId, nonce: id() } })).status, 400);
});

test('senders delete their own messages for everyone and administrators can delete any message', async t => {
  const f = await fixture(t), room = await f.room();
  const clientMessage = await f.message('client', room.roomId, 'Client-owned message');
  const agentMessage = await f.message('agent', room.roomId, 'Teammate-owned message');
  assert.equal((await f.request('agent', `/api/rooms/${room.roomId}/messages/${clientMessage.data.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await f.request('client', `/api/rooms/${room.roomId}/messages/${agentMessage.data.id}`, { method: 'DELETE' })).status, 403);
  assert.equal((await f.request('client', `/api/rooms/${room.roomId}/messages/${clientMessage.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request('admin', `/api/rooms/${room.roomId}/messages/${agentMessage.data.id}`, { method: 'DELETE' })).status, 200);
  const clientView = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(clientView[0].body, ''); assert.ok(clientView[0].deleted_at); assert.equal(clientView[0].deleted_by_me, true);
  assert.equal(clientView[1].deleted_by_me, false);
  const adminView = (await f.request('admin', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(adminView[0].deleted_by_me, false); assert.equal(adminView[1].deleted_by_me, true);

  const upload = await f.request('agent', `/api/rooms/${room.roomId}/upload`, { method: 'POST',
    body: Buffer.from('delete this image'), headers: { 'X-Filename': 'photo-1800000000000.jpg', 'Content-Type': 'image/jpeg' } });
  const mediaMessage = await f.request('agent', `/api/rooms/${room.roomId}/messages`, { method: 'POST', body: { attachmentId: upload.data.attachmentId, nonce: id() } });
  assert.equal(mediaMessage.status, 201);
  assert.equal((await f.request('agent', `/api/rooms/${room.roomId}/messages/${mediaMessage.data.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await f.request('agent', `/api/media/${upload.data.attachmentId}`)).status, 404);
  assert.equal(f.app.store.get('SELECT id FROM attachments WHERE id=?', upload.data.attachmentId), undefined);
  const history = (await f.request('client', `/api/rooms/${room.roomId}/messages`)).data.messages;
  assert.equal(history.length, 3); assert.ok(history.every(message => message.deleted_at && message.body === ''));
  assert.equal(history.some(message => message.attachment_id), false);
  assert.equal(JSON.stringify(history).includes('Client-owned message'), false);
  assert.equal(f.app.store.all('SELECT * FROM messages').length, 3);
});

test('5-minute reminder and 10-minute admin escalation use the first unanswered message', async t => {
  const f = await fixture(t), room = await f.room();
  await f.subscribe('agent'); await f.subscribe('admin');
  await f.message('client', room.roomId, 'Need help.'); await f.app.tick();
  assert.equal(f.deliveries.filter(d => d.payload.title.startsWith('New message')).length, 1);
  assert.equal(f.deliveries.find(d => d.payload.title.startsWith('New message')).payload.kind, 'message');
  f.advance(4 * 60000); await f.message('client', room.roomId, 'Additional context.'); await f.app.tick();
  assert.equal(f.app.store.all("SELECT * FROM alerts WHERE kind='reminder'").length, 0);
  f.advance(60000); await f.app.tick();
  let reminders = f.app.store.all("SELECT * FROM alerts WHERE kind='reminder'");
  assert.equal(reminders.length, 1); assert.equal(reminders[0].user_id, f.ids.agent);
  await f.app.tick(); assert.equal(f.app.store.all("SELECT * FROM alerts WHERE kind='reminder'").length, 1);
  f.advance(5 * 60000); await f.app.tick();
  const escalations = f.app.store.all("SELECT * FROM alerts WHERE kind='escalation'");
  assert.equal(escalations.length, 1); assert.equal(escalations[0].user_id, f.ids.admin);
  assert.equal(f.deliveries.filter(d => d.payload.title.startsWith('Client waiting')).length, 1);
});

test('teammate reply cancels escalation; opening a chat does not count as a reply', async t => {
  const f = await fixture(t), room = await f.room();
  const m = await f.message('client', room.roomId, 'Can you check?');
  await f.request('agent', `/api/rooms/${room.roomId}/read`, { method: 'POST', body: { seq: m.data.seq } });
  f.advance(5 * 60000); await f.app.tick();
  assert.equal(f.app.store.all("SELECT * FROM alerts WHERE kind='reminder'").length, 1);
  await f.message('agent', room.roomId, 'I am checking now.');
  f.advance(10 * 60000); await f.app.tick();
  assert.equal(f.app.store.all("SELECT * FROM alerts WHERE kind='escalation'").length, 0);
  await f.message('client', room.roomId, 'One more question.');
  assert.ok(f.app.store.get('SELECT * FROM cycles WHERE room_id=?', room.roomId));
});

test('reassignment immediately blocks old teammate, retains history, and routes alerts to new teammate', async t => {
  const f = await fixture(t), room = await f.room();
  await f.subscribe('agent'); await f.subscribe('other');
  await f.message('client', room.roomId, 'Previous conversation.'); await f.app.tick();
  assert.equal((await f.request('admin', `/api/rooms/${room.roomId}`, { method: 'PATCH', body: { agentIds: [f.ids.other] } })).status, 200);
  assert.equal((await f.request('agent', `/api/rooms/${room.roomId}/messages`)).status, 404);
  assert.equal((await f.request('other', `/api/rooms/${room.roomId}/messages`)).data.messages.length, 1);
  f.advance(5 * 60000); await f.app.tick();
  assert.equal(f.app.store.get("SELECT user_id FROM alerts WHERE kind='reminder'").user_id, f.ids.other);
});

test('revoking client links and disabling teammates revoke sessions and push subscriptions', async t => {
  const f = await fixture(t), room = await f.room();
  await f.subscribe('client'); await f.subscribe('agent');
  await f.request('admin', `/api/rooms/${room.roomId}/revoke`, { method: 'POST' });
  assert.equal((await f.request('client', '/api/me')).status, 401);
  const key = new URLSearchParams(new URL(room.link).hash.slice(1)).get('key');
  assert.equal((await f.request('client', '/api/client/session', { method: 'POST', body: { key } })).status, 401);
  assert.equal(f.app.store.all('SELECT * FROM subscriptions').length, 1);
  await f.request('admin', `/api/users/${f.ids.agent}`, { method: 'PATCH', body: { disabled: true } });
  assert.equal((await f.request('agent', '/api/me')).status, 401);
  assert.equal(f.app.store.all('SELECT * FROM subscriptions').length, 0);
  assert.equal((await f.request('admin', '/api/rooms')).data.length, 1);
});

test('sessions do not idle-expire and logout removes that device push access', async t => {
  const f = await fixture(t); await f.room(); await f.subscribe('agent');
  f.advance(180 * 24 * 60 * 60000);
  const me = await f.request('agent', '/api/me'); assert.equal(me.status, 200);
  assert.match(me.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=31536000/);
  await f.request('agent', '/api/logout', { method: 'POST' });
  assert.equal((await f.request('agent', '/api/me')).status, 401);
  assert.equal(f.app.store.all('SELECT * FROM subscriptions').length, 0);
});

test('closing keeps history and stops escalation; room deletion removes media and records', async t => {
  const f = await fixture(t), room = await f.room(); await f.message('client', room.roomId, 'Keep me.');
  const upload = await f.request('agent', `/api/rooms/${room.roomId}/upload`, { method: 'POST',
    body: Buffer.from('persistent file'), headers: { 'X-Filename': 'note.txt' } });
  await f.request('agent', `/api/rooms/${room.roomId}/messages`, { method: 'POST', body: { nonce: id(), attachmentId: upload.data.attachmentId } });
  await f.message('client', room.roomId, 'Pending.');
  await f.request('admin', `/api/rooms/${room.roomId}`, { method: 'PATCH', body: { status: 'closed' } });
  assert.equal((await f.message('client', room.roomId, 'Blocked.')).status, 409);
  assert.equal((await f.request('agent', `/api/rooms/${room.roomId}/messages`)).data.messages.length, 3);
  f.advance(20 * 60000); await f.app.tick();
  assert.equal(f.app.store.all("SELECT * FROM alerts WHERE kind='escalation'").length, 0);
  assert.equal((await f.request('admin', `/api/rooms/${room.roomId}`, { method: 'DELETE' })).status, 200);
  assert.equal(f.app.store.all('SELECT * FROM messages').length, 0);
  assert.equal(f.app.store.all('SELECT * FROM attachments').length, 0);
  const { readdir } = await import('node:fs/promises'); assert.equal((await readdir(join(f.directory, 'uploads'))).length, 0);
});

test('cross-origin writes and non-browser push endpoints are rejected', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('admin', '/api/rooms', { method: 'POST', body: {}, headers: { Origin: 'https://attacker.example' } })).status, 403);
  for (const endpoint of ['http://localhost:3000/', 'https://127.0.0.1/', 'https://fcm.googleapis.com.attacker.example/']) {
    const result = await f.request('agent', '/api/push', { method: 'POST', body: { subscription: { endpoint, keys: { auth: 'A'.repeat(22), p256dh: 'B'.repeat(87) } } } });
    assert.equal(result.status, 400);
  }
});

test('pagination keeps old messages available beyond the first 100', async t => {
  const f = await fixture(t), room = await f.room();
  for (let n = 0; n < 105; n++) assert.equal((await f.message('client', room.roomId, `message ${n}`)).status, 201);
  const first = (await f.request('agent', `/api/rooms/${room.roomId}/messages`)).data;
  assert.equal(first.messages.length, 100); assert.equal(first.hasMore, true);
  const older = (await f.request('agent', `/api/rooms/${room.roomId}/messages?before=${first.messages[0].seq}`)).data;
  assert.equal(older.messages.length, 5); assert.equal(older.messages[0].body, 'message 0');
});

test('disk persistence retains conversations, sessions, and escalation deadlines across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'wingfactor-restart-')); let now = 1800000000000;
  let app = createApp({ directory, origin, startWorker: false, clock: () => now });
  const adminId = id(), roomId = id(), messageId = id(), token = 'test-persistent-session';
  app.store.run('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)', adminId, 'owner', 'Owner', 'admin', passwordHash(password));
  app.store.run('INSERT INTO rooms(id,code,created_at) VALUES(?,?,?)', roomId, 'Client #PERSIST', now);
  app.store.run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), adminId, null, now);
  app.store.run('INSERT INTO messages(id,room_id,sender_id,sender_role,body,created_at,nonce) VALUES(?,?,?,?,?,?,?)', messageId, roomId, roomId, 'client', 'Still here.', now, id());
  app.store.run('INSERT INTO cycles(room_id,first_message_id,first_at) VALUES(?,?,?)', roomId, messageId, now);
  await app.close(); now += 10 * 60000;
  app = createApp({ directory, origin, startWorker: false, clock: () => now });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  assert.equal(app.store.get('SELECT body FROM messages WHERE id=?', messageId).body, 'Still here.');
  assert.ok(app.store.get('SELECT * FROM sessions WHERE token_hash=?', hash(token)));
  await app.tick(); assert.equal(app.store.all("SELECT * FROM alerts WHERE kind='escalation'").length, 1);
  await app.tick(); assert.equal(app.store.all("SELECT * FROM alerts WHERE kind='escalation'").length, 1);
});

test('realtime stream carries only room IDs and reconnect signals', async t => {
  const f = await fixture(t), room = await f.room();
  const abort = new AbortController();
  const response = await fetch(f.base + '/api/events', { headers: { Cookie: f.jar.agent }, signal: abort.signal });
  assert.equal(response.status, 200); const reader = response.body.getReader();
  const connected = new TextDecoder().decode((await reader.read()).value); assert.match(connected, /event: connected/);
  await f.message('client', room.roomId, 'PRIVATE MESSAGE BODY');
  const update = new TextDecoder().decode((await reader.read()).value);
  assert.match(update, /event: change/); assert.match(update, new RegExp(room.roomId));
  assert.equal(update.includes('PRIVATE MESSAGE BODY'), false); assert.equal(update.includes('SECRET CLIENT NAME'), false);
  abort.abort();
});
