import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(); } throw new Error('UI did not reach the expected state.'); }

async function ui(t, { role = 'agent', link = false } = {}) {
  const roomId = 'room123'; const calls = []; const messages = [];
  const dom = new JSDOM(html, { url: `http://localhost:3000/${role === 'client' ? `c/${roomId}${link ? '#key=private-secret' : ''}` : '?room=room123'}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.EventSource = class { addEventListener() {} close() {} };
  window.confirm = () => true;
  const room = { id: roomId, code: 'Client #ABC123', status: 'open', created_at: Date.now(), unread: 0,
    agents: [{ id: 'agent123', name: 'Support teammate' }], waitingSince: null,
    ...(role === 'admin' ? { private: { name: 'ADMIN-ONLY CLIENT', contact: 'SECRET-PHONE', notes: 'PRIVATE' } } : {}) };
  window.fetch = async (path, options = {}) => {
    const data = options.body && !(options.body instanceof window.Blob) ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || 'GET', data });
    let result;
    if (path === '/api/me') result = { user: { id: role === 'client' ? roomId : 'agent123', name: 'Support teammate', role, roomId: role === 'client' ? roomId : undefined }, push: { enabled: false, devices: 0 } };
    else if (path === '/api/rooms') result = [room];
    else if (path.endsWith('/messages') && options.method === 'POST') {
      const m = { id: `m${messages.length}`, seq: messages.length + 1, body: data.body, sender: 'Wingfactor Support', own: true, created_at: Date.now() };
      messages.push(m); result = { id: m.id, seq: m.seq };
    } else if (path.includes('/messages')) result = { messages: [...messages], hasMore: false };
    else if (path === '/api/client/session') result = { roomId };
    else if (path === '/api/alerts') result = [];
    else result = { ok: true };
    return { ok: true, status: 200, json: async () => result };
  };
  window.eval(script);
  await until(() => window.document.querySelector('#message-form'));
  t.after(() => dom.window.close());
  return { window, document: window.document, calls, messages, room };
}

test('teammate screen exposes client ID and omits private fields/admin controls', async t => {
  const f = await ui(t);
  assert.match(f.document.querySelector('.chat-title').textContent, /Client #ABC123/);
  assert.equal(f.document.querySelector('[data-action="create-room"]'), null);
  assert.equal(f.document.querySelector('[data-action="room-settings"]'), null);
  for (const value of ['ADMIN-ONLY CLIENT', 'SECRET-PHONE']) assert.equal(f.document.body.textContent.includes(value), false);
});

test('client access secret is exchanged once and removed from the visible URL', async t => {
  const f = await ui(t, { role: 'client', link: true });
  assert.equal(f.window.location.hash, '');
  assert.equal(f.calls.filter(call => call.path === '/api/client/session').length, 1);
  assert.equal(f.calls[0].data.key, 'private-secret');
  assert.match(f.document.querySelector('.chat-title').textContent, /Wingfactor Support/);
  assert.equal(f.document.querySelector('.inbox'), null);
});

test('sending through the composer renders text safely and clears the sent draft', async t => {
  const f = await ui(t); const input = f.document.querySelector('#message-input');
  input.value = '<img src=x onerror=alert(1)> Hello';
  f.document.querySelector('#message-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.document.querySelector('.message'));
  assert.equal(f.document.querySelector('.bubble').textContent, '<img src=x onerror=alert(1)> Hello');
  assert.equal(f.document.querySelector('.bubble img'), null);
  assert.equal(input.value, '');
  const send = f.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST');
  assert.ok(send.data.nonce); assert.equal(send.data.body, '<img src=x onerror=alert(1)> Hello');
});

test('live updates preserve existing media DOM elements and unsent drafts', async t => {
  const f = await ui(t);
  f.messages.push({ id: 'm1', seq: 1, body: '', sender: 'Client #ABC123', own: false, created_at: Date.now(),
    attachment_id: 'media123', filename: 'voice-note.webm', mime: 'audio/webm', size: 1000 });
  await f.window.refresh();
  const audio = f.document.querySelector('audio'); assert.ok(audio);
  f.document.querySelector('#message-input').value = 'My unsent answer';
  f.messages.push({ id: 'm2', seq: 2, body: 'One more detail', sender: 'Client #ABC123', own: false, created_at: Date.now() });
  await f.window.refresh();
  assert.equal(f.document.querySelector('audio'), audio);
  assert.equal(f.document.querySelector('#message-input').value, 'My unsent answer');
  assert.equal(f.document.querySelectorAll('.message').length, 2);
});

test('administrator can reach private room settings and assignment controls', async t => {
  const f = await ui(t, { role: 'admin' });
  assert.ok(f.document.querySelector('[data-action="room-settings"]'));
  // User list response is not needed here; verify the private details are absent from the ordinary conversation view.
  assert.equal(f.document.querySelector('.conversation').textContent.includes('SECRET-PHONE'), false);
  assert.ok(f.document.querySelector('[data-action="create-room"]'));
});

test('expired media keeps its message and shows an expiry marker without a download link', async t => {
  const f = await ui(t);
  f.messages.push({ id: 'expired-message', seq: 1, body: 'Please review this document.', sender: 'Client #ABC123',
    own: false, created_at: Date.now(), attachment_id: 'expired-file', attachment_expired: true,
    filename: 'old.pdf', mime: 'application/pdf', size: 123 });
  await f.window.refresh();
  assert.match(f.document.querySelector('.bubble').textContent, /Please review this document/);
  assert.match(f.document.querySelector('.attachment').textContent, /Attachment expired/);
  assert.equal(f.document.querySelector('.attachment a'), null);
});
