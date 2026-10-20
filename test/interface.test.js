import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const mediaScript = await readFile(new URL('../public/chat-media.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const callFix = await readFile(new URL('../supabase/migrations/20261019141500_fix_call_finish_ambiguity.sql', import.meta.url), 'utf8');
const receiptMigration = await readFile(new URL('../supabase/migrations/20261019145343_whatsapp_receipts_and_assigned_call_ringing.sql', import.meta.url), 'utf8');
const deleteMigration = await readFile(new URL('../supabase/migrations/20261020092500_message_delete_for_everyone.sql', import.meta.url), 'utf8');
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(); } throw new Error('UI did not reach the expected state.'); }

async function ui(t, { role = 'agent', link = false, uploadGate = null } = {}) {
  const roomId = 'room123'; const calls = []; const messages = [];
  const dom = new JSDOM(html, { url: `http://localhost:3000/${role === 'client' ? `c/${roomId}${link ? '#key=private-secret' : ''}` : '?room=room123'}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.EventSource = class { addEventListener() {} close() {} };
  window.confirm = () => true;
  let objectUrl = 0; window.URL.createObjectURL = () => `blob:test-${++objectUrl}`; window.URL.revokeObjectURL = () => {};
  let uploadedFile = null;
  const room = { id: roomId, code: 'Client #ABC123', status: 'open', created_at: Date.now(), unread: 0,
    agents: [{ id: 'agent123', name: 'Support teammate' }], waitingSince: null,
    ...(role === 'agent' ? { client: { name: 'Visible Client', notes: 'Keep the client updated every hour.' } } : {}),
    ...(role === 'admin' ? { private: { name: 'ADMIN-ONLY CLIENT', contact: 'SECRET-PHONE', notes: 'PRIVATE' } } : {}) };
  window.fetch = async (path, options = {}) => {
    const data = options.body && !(options.body instanceof window.Blob) ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method || 'GET', data });
    let result;
    if (path === '/api/me') result = { user: { id: role === 'client' ? roomId : 'agent123', name: 'Support teammate', role, roomId: role === 'client' ? roomId : undefined }, push: { enabled: false, devices: 0 } };
    else if (path === '/api/rooms') result = [room];
    else if (path.endsWith('/upload') && options.method === 'POST') {
      uploadedFile = options.body; if (uploadGate) await uploadGate; result = { attachmentId: 'attachment123' };
    } else if (path.endsWith('/messages') && options.method === 'POST') {
      const m = { id: `m${messages.length}`, seq: messages.length + 1, body: data.body, sender: 'Wingfactor Support', own: true, sender_role: role, created_at: Date.now(),
        delivery: 'sent',
        ...(data.attachmentId ? { attachment_id: data.attachmentId, filename: uploadedFile.name, mime: uploadedFile.type, size: uploadedFile.size } : {}) };
      messages.push(m); result = { id: m.id, seq: m.seq };
    } else if (/\/messages\/[\w-]+$/.test(path) && options.method === 'DELETE') {
      const id = path.split('/').at(-1); const index = messages.findIndex(message => message.id === id);
      if (index >= 0) messages.splice(index, 1); result = { ok: true };
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

test('teammate screen uses the admin client name and exposes notes without contact details', async t => {
  const f = await ui(t);
  assert.match(f.document.querySelector('.chat-title').textContent, /Visible Client/);
  assert.equal(f.document.body.textContent.includes('Client #ABC123'), false);
  f.document.querySelector('[data-action="client-notes"]').click();
  await until(() => f.document.querySelector('.note-content'));
  assert.match(f.document.querySelector('.note-content').textContent, /Keep the client updated every hour/);
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
  assert.equal(f.document.querySelector('.chat-title p'), null);
  assert.match(f.document.querySelector('.composer-footer').textContent, /Securely connected/);
  for (const removed of ['Your private support conversation', 'Private support room', 'Messages stay until your admin deletes them']) assert.equal(f.document.body.textContent.includes(removed), false);
  assert.equal(f.document.querySelector('.inbox'), null);
});

test('camera and video-call controls use the requested labels and icons', () => {
  assert.match(script, /iconButton\('video', 'video-call'/);
  assert.match(mediaScript, /data-camera="capture"/);
  assert.match(mediaScript, /data-camera="flip"/);
  assert.match(mediaScript, /class="camera-send hidden"[^>]+aria-label="Send photo"/);
  assert.doesNotMatch(mediaScript, />Use photo</);
  assert.match(styles, /\.camera-send\{background:#25a65a;color:#fff/);
  assert.doesNotMatch(mediaScript, /Device camera or photo/);
});

test('captured photo appears immediately while its upload continues', async t => {
  let finishUpload; const uploadGate = new Promise(resolve => { finishUpload = resolve; });
  const f = await ui(t, { role: 'client', uploadGate });
  const photo = new f.window.File(['photo bytes'], 'captured.jpg', { type: 'image/jpeg' });
  assert.equal(f.window.previewFile(photo, true), true);
  f.document.querySelector('#message-form').requestSubmit();
  const pending = f.document.querySelector('.pending-message');
  assert.ok(pending); assert.ok(pending.querySelector('.delivery-mark.sending[aria-label="Sending"]'));
  assert.equal(f.document.querySelector('#file-preview').classList.contains('hidden'), true);
  assert.match(pending.querySelector('img').src, /^blob:test-/); assert.equal(f.messages.length, 0);
  finishUpload();
  await until(() => f.document.querySelector('.message:not(.pending-message) img'));
  assert.equal(f.document.querySelector('.pending-message'), null);
  assert.match(f.document.querySelector('.message img').src, /\/api\/media\/attachment123$/);
  assert.ok(f.document.querySelector('.message .image-open'));
});

test('call cleanup avoids ambiguous notification columns and secure status is aligned', () => {
  assert.match(callFix, /call_kind text/);
  assert.match(callFix, /j\.kind='call'/);
  assert.match(callFix, /a\.kind='call'/);
  assert.doesNotMatch(callFix, /declare[^;]*\bkind text/);
  assert.match(styles, /\.composer-footer>span\{display:inline-flex;align-items:center;gap:5px/);
  assert.match(serviceWorker, /requireInteraction: call/);
  assert.match(serviceWorker, /\['message', 'reply'\]\.includes\(payload\.kind\)/);
  assert.match(receiptMigration, /role_name='agent' or not exists/);
});

test('sending through the composer renders text safely and clears the sent draft', async t => {
  const f = await ui(t); const input = f.document.querySelector('#message-input');
  input.value = '<img src=x onerror=alert(1)> Hello';
  f.document.querySelector('#message-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.document.querySelector('.message'));
  assert.equal(f.document.querySelector('.message-body').textContent, '<img src=x onerror=alert(1)> Hello');
  assert.equal(f.document.querySelector('.bubble img'), null);
  assert.equal(input.value, '');
  const send = f.calls.find(call => call.path.endsWith('/messages') && call.method === 'POST');
  assert.ok(send.data.nonce); assert.equal(send.data.body, '<img src=x onerror=alert(1)> Hello');
});

test('client, teammate, and admin outgoing messages show WhatsApp delivery ticks', async t => {
  const f = await ui(t, { role: 'client' });
  const message = { id: 'receipt-message', seq: 1, body: 'Are you there?', sender: 'Client', sender_role: 'client', own: true, created_at: Date.now(), delivery: 'sent' };
  f.messages.push(message); await f.window.refresh();
  assert.equal(f.document.querySelector('.delivery-mark.sent svg').querySelectorAll('path').length, 1);
  f.messages[0] = { ...message, delivery: 'delivered' }; await f.window.refresh();
  assert.equal(f.document.querySelector('.delivery-mark.delivered svg').querySelectorAll('path').length, 2);
  f.messages[0] = { ...message, delivery: 'read' }; await f.window.refresh();
  assert.equal(f.document.querySelector('.delivery-mark.read svg').querySelectorAll('path').length, 2);
  assert.match(styles, /\.delivery-mark\.read\{color:#53bdeb/);

  for (const role of ['agent', 'admin']) {
    const staff = await ui(t, { role });
    staff.messages.push({ id: `${role}-receipt`, seq: 1, body: 'Reply sent', sender: 'Wingfactor Support', sender_role: role, own: true, created_at: Date.now(), delivery: 'read' });
    await staff.window.refresh();
    assert.ok(staff.document.querySelector('.delivery-mark.read'));
    assert.equal(staff.document.querySelector('.delivery-mark.read svg').querySelectorAll('path').length, 2);
  }
});

test('message deletion controls follow sender ownership and admin permissions', async t => {
  const client = await ui(t, { role: 'client' });
  client.messages.push(
    { id: 'client-own', seq: 1, body: 'Mine', sender: 'Client', sender_role: 'client', own: true, created_at: Date.now(), delivery: 'sent' },
    { id: 'staff-other', seq: 2, body: 'Staff', sender: 'Wingfactor Support', sender_role: 'agent', own: false, created_at: Date.now() },
  );
  await client.window.refresh();
  assert.ok(client.document.querySelector('[data-delete-message="client-own"]'));
  assert.equal(client.document.querySelector('[data-delete-message="staff-other"]'), null);
  client.document.querySelector('[data-delete-message="client-own"]').click();
  await until(() => !client.messages.some(message => message.id === 'client-own') && !client.document.querySelector('[data-delete-message="client-own"]'));
  assert.equal(client.document.querySelector('[data-delete-message="client-own"]'), null);

  const admin = await ui(t, { role: 'admin' });
  admin.messages.push({ id: 'client-message', seq: 1, body: 'Client', sender: 'Visible Client', sender_role: 'client', own: false, created_at: Date.now() });
  await admin.window.refresh();
  assert.ok(admin.document.querySelector('[data-delete-message="client-message"]'));
  assert.match(deleteMigration, /role_name<>'admin' and m\.sender_id<>who/);
  assert.match(deleteMigration, /revoke all on function public\.wc_message_delete/);
});

test('opening a client camera photo gives staff a full preview and starts a device download', async t => {
  const f = await ui(t, { role: 'agent' }); const downloads = [];
  f.window.HTMLAnchorElement.prototype.click = function () { downloads.push(this.href); };
  f.messages.push({ id: 'camera-photo', seq: 1, body: '', sender: 'Visible Client', sender_role: 'client', own: false, created_at: Date.now(),
    attachment_id: 'camera-file', filename: 'photo-1800000000000.jpg', mime: 'image/jpeg', size: 1000 });
  await f.window.refresh();
  f.document.querySelector('[data-open-image="camera-photo"]').click();
  await until(() => f.document.querySelector('.image-viewer img'));
  assert.match(f.document.querySelector('.image-viewer img').src, /\/api\/media\/camera-file$/);
  assert.equal(downloads.length, 1); assert.match(downloads[0], /\/api\/media\/camera-file\?download=1$/);
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
