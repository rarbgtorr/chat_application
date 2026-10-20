import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const script = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const themeScript = await readFile(new URL('../public/theme.js', import.meta.url), 'utf8');
const mediaScript = await readFile(new URL('../public/chat-media.js', import.meta.url), 'utf8');
const styles = await readFile(new URL('../public/style.css', import.meta.url), 'utf8');
const serviceWorker = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');
const callFix = await readFile(new URL('../supabase/migrations/20261019141500_fix_call_finish_ambiguity.sql', import.meta.url), 'utf8');
const receiptMigration = await readFile(new URL('../supabase/migrations/20261019145343_whatsapp_receipts_and_assigned_call_ringing.sql', import.meta.url), 'utf8');
const deleteMigration = await readFile(new URL('../supabase/migrations/20261020095600_soft_delete_message_tombstones.sql', import.meta.url), 'utf8');
const delay = () => new Promise(resolve => setTimeout(resolve, 10));
async function until(predicate) { for (let n = 0; n < 100; n++) { if (predicate()) return; await delay(); } throw new Error('UI did not reach the expected state.'); }

async function ui(t, { role = 'agent', link = false, uploadGate = null, messageGate = null, pointerEvents = true, serviceWorker = false, savedTheme = null, storageBlocked = false } = {}) {
  const roomId = 'room123'; const calls = []; const messages = [];
  const dom = new JSDOM(html, { url: `http://localhost:3000/${role === 'client' ? `c/${roomId}${link ? '#key=private-secret' : ''}` : '?room=room123'}`, runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  if (savedTheme !== null) window.localStorage.setItem('wingfactor-chat-theme', savedTheme);
  if (storageBlocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  window.eval(themeScript);
  const stylesheet = window.document.createElement('style'); stylesheet.textContent = styles; window.document.head.append(stylesheet);
  if (!pointerEvents) window.PointerEvent = undefined;
  const errors = []; window.addEventListener('error', event => errors.push(event.error?.message || event.message));
  window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  window.EventSource = class { constructor() { this.listeners = {}; window.testEventStream = this; } addEventListener(name, handler) { this.listeners[name] = handler; } close() {} };
  window.confirm = () => true;
  if (serviceWorker) {
    const worker = new window.EventTarget(); worker.register = async () => ({ pushManager: { getSubscription: async () => null } });
    Object.defineProperty(window.navigator, 'serviceWorker', { value: worker });
  }
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
      if (messageGate) await messageGate;
      const m = { id: `m${messages.length}`, seq: messages.length + 1, body: data.body, sender: 'Wingfactor Support', own: true, sender_role: role, created_at: Date.now(),
        delivery: 'sent',
        ...(data.attachmentId ? { attachment_id: data.attachmentId, filename: uploadedFile.name, mime: uploadedFile.type, size: uploadedFile.size } : {}) };
      messages.push(m); result = { id: m.id, seq: m.seq };
    } else if (/\/messages\/[\w-]+$/.test(path) && options.method === 'DELETE') {
      const id = path.split('/').at(-1); const message = messages.find(item => item.id === id); const deletedAt = Date.now();
      if (message) Object.assign(message, { body: '', attachment_id: null, deleted_at: deletedAt, deleted_by_me: true, delivery: undefined });
      result = { ok: true, deletedAt };
    } else if (path.includes('/messages')) result = { messages: [...messages], hasMore: false };
    else if (path === '/api/client/session') result = { roomId };
    else if (path === '/api/alerts') result = [];
    else result = { ok: true };
    return { ok: true, status: 200, json: async () => result };
  };
  window.eval(script + '\nwindow.testAppState = state;');
  await until(() => window.document.querySelector('#message-form'));
  t.after(() => { dom.window.close(); assert.deepEqual(errors, [], 'Unexpected UI error'); });
  return { window, document: window.document, calls, messages, room, appState: window.testAppState };
}

test('all roles can change appearance without losing their draft or recreating the chat', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    const f = await ui(t, { role });
    const input = f.document.querySelector('#message-input'); input.value = 'My unsent draft';
    const header = f.document.querySelector('.chat-header');
    const logo = f.document.querySelector('.support-logo');
    f.document.querySelector('.chat-header [data-action="settings"]').click();
    assert.equal(f.document.querySelector('[data-theme-choice="normal"]').getAttribute('aria-pressed'), 'true');
    f.document.querySelector('[data-theme-choice="dark"]').click();
    assert.equal(f.document.documentElement.dataset.theme, 'dark');
    assert.equal(f.document.querySelector('meta[name="color-scheme"]').content, 'only dark');
    assert.equal(f.window.localStorage.getItem('wingfactor-chat-theme'), 'dark');
    assert.equal(f.document.querySelector('[data-theme-choice="dark"]').getAttribute('aria-pressed'), 'true');
    assert.equal(f.window.getComputedStyle(header).backgroundColor, 'rgb(32, 44, 51)');
    assert.equal(f.window.getComputedStyle(f.document.querySelector('.composer-field')).backgroundColor, 'rgb(42, 57, 66)');
    assert.equal(f.document.querySelector('#message-input'), input);
    assert.equal(input.value, 'My unsent draft');
    assert.equal(f.document.querySelector('.chat-header'), header);
    if (logo) {
      assert.equal(f.document.querySelector('.support-logo'), logo);
      assert.equal(logo.getAttribute('src'), '/icon.svg');
      assert.equal(f.window.getComputedStyle(logo).colorScheme, 'only light');
      assert.equal(f.window.getComputedStyle(logo).filter, 'none');
    }
    f.document.querySelector('[data-action="close-modal"]').click();
    f.document.querySelector('.chat-header [data-action="settings"]').click();
    assert.equal(f.document.querySelector('[data-theme-choice="dark"]').getAttribute('aria-pressed'), 'true');
    f.document.querySelector('[data-theme-choice="normal"]').click();
    assert.equal(f.document.documentElement.dataset.theme, 'normal');
    assert.equal(f.window.localStorage.getItem('wingfactor-chat-theme'), 'normal');
    assert.equal(f.document.querySelector('meta[name="color-scheme"]').content, 'only light');
    assert.equal(f.window.getComputedStyle(f.document.querySelector('.composer-field')).backgroundColor, 'rgb(255, 255, 255)');
  }
});

test('appearance restores on a new page and follows changes from another tab', async t => {
  const f = await ui(t, { savedTheme: 'dark' });
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
  f.window.dispatchEvent(new f.window.StorageEvent('storage', { key: 'wingfactor-chat-theme', newValue: 'normal' }));
  assert.equal(f.document.documentElement.dataset.theme, 'normal');
  f.window.dispatchEvent(new f.window.StorageEvent('storage', { key: 'unrelated', newValue: 'dark' }));
  assert.equal(f.document.documentElement.dataset.theme, 'normal');
  f.window.dispatchEvent(new f.window.StorageEvent('storage', { key: 'wingfactor-chat-theme', newValue: 'dark' }));
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
  f.window.dispatchEvent(new f.window.StorageEvent('storage', { key: null }));
  assert.equal(f.document.documentElement.dataset.theme, 'normal');
  const invalid = await ui(t, { savedTheme: 'invalid' });
  assert.equal(invalid.document.documentElement.dataset.theme, 'normal');
});

test('appearance works when browser storage is blocked and is available before sign-in', async t => {
  const f = await ui(t, { storageBlocked: true });
  f.window.auth();
  assert.ok(f.document.querySelector('#login-form'));
  f.document.querySelector('[data-theme-choice="dark"]').click();
  assert.equal(f.document.documentElement.dataset.theme, 'dark');
  f.document.querySelector('[data-theme-choice="normal"]').click();
  assert.equal(f.document.documentElement.dataset.theme, 'normal');
});

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
  const logo = f.document.querySelector('.chat-header .support-logo');
  assert.equal(logo.getAttribute('src'), '/icon.svg');
  assert.equal(logo.getAttribute('alt'), 'Wingfactor logo');
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

test('compact composer switches between recording and sending and grows with the draft', async t => {
  const f = await ui(t, { role: 'client' });
  const input = f.document.querySelector('#message-input');
  const send = f.document.querySelector('#send-button'), record = f.document.querySelector('#record-button');
  assert.equal(f.window.getComputedStyle(send).display, 'none');
  assert.notEqual(f.window.getComputedStyle(record).display, 'none');
  let scrollHeight = 220;
  Object.defineProperty(input, 'scrollHeight', { get: () => scrollHeight });
  input.value = 'A long message\nwith several lines';
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  assert.notEqual(f.window.getComputedStyle(send).display, 'none');
  assert.equal(f.window.getComputedStyle(record).display, 'none');
  assert.equal(input.style.height, '144px');
  assert.equal(input.style.overflowY, 'auto');
  scrollHeight = 48;
  send.click();
  assert.equal(input.value, ''); assert.equal(input.style.height, '48px');
  assert.equal(f.window.getComputedStyle(send).display, 'none');
  assert.notEqual(f.window.getComputedStyle(record).display, 'none');
  await until(() => f.document.querySelector('.message:not(.pending-message)'));
  f.window.previewFile(new f.window.File(['photo'], 'sample.jpg', { type: 'image/jpeg' }));
  assert.notEqual(f.window.getComputedStyle(send).display, 'none');
  f.document.querySelector('[data-action="remove-file"]').click();
  assert.equal(f.window.getComputedStyle(send).display, 'none');
  assert.notEqual(f.window.getComputedStyle(record).display, 'none');
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

test('text messages appear immediately without putting the composer into a sending stage', async t => {
  let finishSend; const messageGate = new Promise(resolve => { finishSend = resolve; });
  const f = await ui(t, { role: 'client', messageGate }); const input = f.document.querySelector('#message-input');
  input.value = 'This should appear instantly';
  f.document.querySelector('#message-form').requestSubmit();
  const pending = f.document.querySelector('.pending-message');
  assert.ok(pending); assert.match(pending.textContent, /This should appear instantly/);
  assert.ok(pending.querySelector('.delivery-mark.sending'));
  assert.equal(input.value, ''); assert.match(f.document.querySelector('#send-button').textContent, /Send/);
  assert.equal(f.document.querySelector('#send-button').disabled, false);
  finishSend(); await until(() => f.document.querySelector('.message:not(.pending-message)'));
});

test('sending from older history immediately reveals the latest text, photo and voice note for every role', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    let finishSend; const messageGate = new Promise(resolve => { finishSend = resolve; });
    const f = await ui(t, { role, messageGate });
    const container = f.document.querySelector('#messages');
    let height = 2400;
    Object.defineProperty(container, 'scrollHeight', { get: () => height });
    Object.defineProperty(container, 'clientHeight', { value: 500 });
    container.scrollTop = 150;
    f.document.querySelector('#message-input').value = 'Reply while reading an older message';
    f.document.querySelector('#message-form').requestSubmit();
    assert.equal(container.scrollTop, height, `${role}: text should be visible before the server responds`);
    container.scrollTop = 100; finishSend();
    await until(() => f.document.querySelector('.message:not(.pending-message)'));
    assert.equal(container.scrollTop, 100, 'The response must respect scrolling after Send');

    f.window.previewFile(new f.window.File(['image'], 'photo.jpg', { type: 'image/jpeg' }), true);
    assert.equal(container.scrollTop, height, `${role}: captured photo should be visible immediately`);
    const photo = container.querySelector('.pending-message img');
    height = 2800; photo.dispatchEvent(new f.window.Event('load'));
    assert.equal(container.scrollTop, height, 'The photo stays visible when its dimensions arrive');
    f.document.querySelector('#message-form').requestSubmit();
    await until(() => f.document.querySelectorAll('.message:not(.pending-message)').length === 2);

    container.scrollTop = 200;
    f.window.previewFile(new f.window.File(['audio'], 'voice-note.webm', { type: 'audio/webm' }));
    assert.equal(container.scrollTop, 200, 'Preparing a file does not count as sending it');
    f.document.querySelector('#message-form').requestSubmit();
    assert.equal(container.scrollTop, height, `${role}: sent voice note should be visible immediately`);
    await until(() => f.document.querySelectorAll('.message:not(.pending-message)').length === 3);
  }
});

test('Send keeps the composer focused for all roles and respects later manual dismissal', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    let finishSend; const messageGate = new Promise(resolve => { finishSend = resolve; });
    const f = await ui(t, { role, messageGate });
    const input = f.document.querySelector('#message-input'), send = f.document.querySelector('#send-button');
    input.focus(); input.value = 'First message';
    for (const type of ['pointerdown', 'mousedown']) {
      const down = new f.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      send.querySelector('svg').dispatchEvent(down);
      assert.equal(down.defaultPrevented, true); assert.equal(f.document.activeElement, input);
    }
    send.click(); assert.equal(f.document.activeElement, input); assert.equal(input.value, '');
    assert.equal(f.document.querySelectorAll('.pending-message').length, 1);
    input.value = 'Next message'; send.click();
    assert.equal(f.document.activeElement, input); assert.equal(f.document.querySelectorAll('.pending-message').length, 2);
    // A network response must not bring the keyboard back after the user dismisses it.
    input.blur(); const dismissedFocus = f.document.activeElement;
    finishSend(); await until(() => f.document.querySelectorAll('.message:not(.pending-message)').length === 2);
    assert.equal(f.document.activeElement, dismissedFocus);
    // Sending a photo programmatically must not open a keyboard that was closed.
    f.window.previewFile(new f.window.File(['image'], 'photo.jpg', { type: 'image/jpeg' }));
    f.document.querySelector('#message-form').requestSubmit();
    assert.equal(f.document.activeElement, dismissedFocus);
    await until(() => f.document.querySelectorAll('.message:not(.pending-message)').length === 3);
    assert.equal(f.document.activeElement, dismissedFocus);
  }
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

test('consecutive messages share one sender label while every bubble keeps its time', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    const f = await ui(t, { role }); const at = new Date(2026, 9, 20, 12).getTime();
    const sender = role === 'client' ? 'Wingfactor Support' : 'Visible Member';
    const senderRole = role === 'client' ? 'agent' : 'client';
    const incoming = { sender, sender_role: senderRole, sender_id: 'sender-one', own: false };
    const own = { sender: 'Me', sender_role: role, sender_id: f.appState.me.id, own: true, delivery: 'read' };
    f.messages.push(
      { ...incoming, id: 'first', seq: 1, body: 'Hello', created_at: at },
      { ...incoming, id: 'photo', seq: 2, body: 'This photo', created_at: at + 60000, attachment_id: 'image-one', mime: 'image/jpeg', filename: 'photo.jpg', size: 100 },
      { ...own, id: 'own-first', seq: 3, body: 'Checking', created_at: at + 120000 },
      { ...own, id: 'own-second', seq: 4, body: 'One moment', created_at: at + 180000 },
      { ...incoming, id: 'returned', seq: 5, body: 'Thank you', created_at: at + 240000 },
      { ...incoming, sender_id: 'sender-two', id: 'another-sender', seq: 6, body: 'Another sender with the same display name', created_at: at + 300000 },
      { ...incoming, sender_id: 'sender-two', id: 'next-day', seq: 7, body: 'Next day', created_at: new Date(2026, 9, 21, 12).getTime() },
    );
    await f.window.refresh();
    const rows = [...f.document.querySelectorAll('.message')];
    assert.deepEqual(rows.filter(row => row.querySelector('.message-meta')).map(row => row.dataset.messageId), ['first', 'returned', 'another-sender', 'next-day']);
    for (const id of ['photo', 'own-second']) assert.ok(f.document.querySelector(`[data-message-id="${id}"]`).classList.contains('group-continuation'));
    for (const [index, row] of rows.entries()) {
      const time = row.querySelector('.bubble .message-status time');
      assert.ok(time.textContent.trim()); assert.equal(time.dateTime, new Date(f.messages[index].created_at).toISOString());
      assert.equal(row.querySelector('.message-meta time'), null);
      assert.equal(f.window.getComputedStyle(time.parentElement).display, 'inline-flex');
    }
    assert.ok(rows[1].classList.contains('image-message')); assert.ok(rows[2].querySelector('.delivery-mark.read'));
    assert.equal(f.document.querySelectorAll('.day-divider').length, 2);
  }
});

test('message deletion controls follow sender ownership and admin permissions', async t => {
  const client = await ui(t, { role: 'client' });
  let noticeTimer;
  const setTimer = client.window.setTimeout.bind(client.window);
  client.window.setTimeout = (fn, ms, ...args) => {
    if (ms === 2000) { noticeTimer = { fn, ms }; return 1000000; }
    return setTimer(fn, ms, ...args);
  };
  client.messages.push(
    { id: 'client-own', seq: 1, body: 'Mine', sender: 'Client', sender_role: 'client', own: true, created_at: Date.now(), delivery: 'sent' },
    { id: 'staff-other', seq: 2, body: 'Staff', sender: 'Wingfactor Support', sender_role: 'agent', own: false, created_at: Date.now() },
  );
  await client.window.refresh();
  client.window.confirm = () => { throw new Error('Message deletion must not use browser confirmation.'); };
  const deleteTrigger = client.document.querySelector('[data-delete-options="client-own"]');
  assert.equal(client.window.getComputedStyle(deleteTrigger).visibility, 'hidden');
  assert.equal(client.document.querySelector('[data-message-id="staff-other"]').hasAttribute('data-selectable'), false);
  const bubble = client.document.querySelector('[data-message-id="client-own"] .bubble');
  bubble.dispatchEvent(new client.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  await until(() => bubble.closest('.message').classList.contains('selected'));
  bubble.dispatchEvent(new client.window.MouseEvent('pointerup', { bubbles: true }));
  assert.ok(bubble.closest('.message').classList.contains('selected'));
  assert.equal(client.window.getComputedStyle(deleteTrigger).visibility, 'visible');
  assert.equal(deleteTrigger.closest('.message').dataset.messageId, 'client-own');
  assert.equal(client.document.querySelector('.bubble button'), null);
  await client.window.refresh();
  assert.ok(client.document.querySelector('[data-delete-options="client-own"]'));
  client.document.querySelector('[data-delete-options="client-own"]').click();
  assert.equal(client.calls.some(call => call.method === 'DELETE'), false);
  assert.equal(client.document.querySelector('[data-delete-message="client-own"]').textContent.trim(), 'Delete for everyone');
  client.document.querySelector('#modal [data-action="close-modal"]').click();
  assert.equal(client.calls.some(call => call.method === 'DELETE'), false);
  client.document.querySelector('[data-delete-options="client-own"]').click();
  client.document.querySelector('[data-delete-message="client-own"]').click();
  await until(() => client.messages.find(message => message.id === 'client-own')?.deleted_at && !client.document.querySelector('[data-delete-message="client-own"]'));
  assert.match(client.document.querySelector('.deleted-message').textContent, /You deleted this message/);
  assert.equal(client.document.querySelector('[data-delete-message="client-own"]'), null);
  assert.equal(client.document.querySelector('.message.selected'), null);
  await until(() => noticeTimer && client.document.querySelector('#toast').classList.contains('visible'));
  assert.equal(client.document.querySelector('#toast').textContent, 'Message deleted for everyone.');
  assert.equal(noticeTimer.ms, 2000); noticeTimer.fn();
  assert.equal(client.document.querySelector('#toast').classList.contains('visible'), false);

  const admin = await ui(t, { role: 'admin' });
  admin.messages.push({ id: 'client-message', seq: 1, body: 'Client', sender: 'Visible Client', sender_role: 'client', own: false, created_at: Date.now() });
  await admin.window.refresh();
  admin.document.querySelector('.bubble').dispatchEvent(new admin.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  assert.ok(admin.document.querySelector('[data-delete-options="client-message"]'));
  admin.document.dispatchEvent(new admin.window.KeyboardEvent('keydown', { bubbles: true, key: 'Escape' }));
  assert.equal(admin.document.querySelector('.message.selected'), null);
  assert.match(deleteMigration, /role_name<>'admin' and m\.sender_id<>who/);
  assert.match(deleteMigration, /update public\.wc_messages set body='',attachment_id=null,deleted_at=/);
  assert.match(deleteMigration, /revoke all on function public\.wc_message_delete/);

  const teammate = await ui(t, { role: 'agent' });
  teammate.messages.push({ id: 'deleted-by-client', seq: 1, body: '', sender: 'Visible Client', sender_role: 'client', own: false,
    created_at: Date.now(), deleted_at: Date.now(), deleted_by_me: false });
  await teammate.window.refresh();
  assert.match(teammate.document.querySelector('.deleted-message').textContent, /This message was deleted/);
});

test('message selection cancels for short taps, scrolling, movement and pointer cancellation', async t => {
  const f = await ui(t, { role: 'agent' });
  f.messages.push({ id: 'my-reply', seq: 1, body: 'Reply', sender: 'Wingfactor Support', sender_role: 'agent', own: true, created_at: Date.now() });
  await f.window.refresh();
  const timers = new Map(); let next = 10000;
  const setTimer = f.window.setTimeout.bind(f.window), clearTimer = f.window.clearTimeout.bind(f.window);
  f.window.setTimeout = (fn, ms, ...args) => { if (ms === 500) { const id = next++; timers.set(id, fn); return id; } return setTimer(fn, ms, ...args); };
  f.window.clearTimeout = id => { if (timers.has(id)) timers.delete(id); else clearTimer(id); };
  const bubble = f.document.querySelector('.bubble');
  const down = () => bubble.dispatchEvent(new f.window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
  for (const type of ['pointerup', 'pointercancel', 'scroll', 'pointermove']) {
    down(); assert.equal(timers.size, 1);
    bubble.dispatchEvent(new f.window.MouseEvent(type, { bubbles: true, clientX: 30, clientY: 30 }));
    assert.equal(timers.size, 0);
    assert.equal(f.document.querySelector('.message.selected'), null);
  }
  down(); [...timers.values()][0]();
  assert.ok(f.document.querySelector('[data-delete-options="my-reply"]'));
  f.document.querySelector('#message-input').click();
  assert.equal(f.document.querySelector('.message.selected'), null);
  const message = f.document.querySelector('.message');
  message.dispatchEvent(new f.window.KeyboardEvent('keydown', { bubbles: true, key: 'F10', shiftKey: true }));
  assert.ok(f.document.querySelector('[data-delete-options="my-reply"]'));
});

test('a long press on a photo selects it without opening the image viewer', async t => {
  const f = await ui(t, { role: 'client' });
  f.messages.push({ id: 'my-photo', seq: 1, body: '', attachment_id: 'photo-file', filename: 'photo.jpg', mime: 'image/jpeg',
    own: true, sender_role: 'client', created_at: Date.now() });
  await f.window.refresh();
  const photo = f.document.querySelector('.image-open');
  photo.dispatchEvent(new f.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  await until(() => photo.closest('.message').classList.contains('selected'));
  photo.dispatchEvent(new f.window.MouseEvent('pointerup', { bubbles: true })); photo.click();
  assert.equal(f.document.querySelector('.image-viewer'), null);
  assert.equal(f.document.querySelector('#modal').open, false);
  // The revealed button must work even during suppression of the long-press click.
  f.document.querySelector('[data-delete-options="my-photo"]').click();
  assert.equal(f.document.querySelector('#modal').open, true);
  assert.ok(f.document.querySelector('[data-delete-message="my-photo"]'));
});

test('client, teammate and admin can use the per-message popup to delete photos without browser prompts', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    const f = await ui(t, { role });
    f.window.confirm = () => { throw new Error('Unexpected browser confirmation'); };
    const id = `photo-${role}`;
    f.messages.push({ id, seq: 1, body: '', attachment_id: 'photo-file', filename: 'photo.jpg', mime: 'image/jpeg',
      own: role !== 'admin', sender_role: role === 'admin' ? 'client' : role, created_at: Date.now() });
    await f.window.refresh();
    const trigger = f.document.querySelector(`[data-delete-options="${id}"]`);
    assert.equal(trigger.closest('.message-content').querySelector('.bubble .message-delete-trigger'), null);
    // Desktop hover reveals this same button through CSS; clicking opens the in-app popup.
    trigger.click(); assert.equal(f.document.querySelector('#modal').open, true);
    f.document.querySelector(`[data-delete-message="${id}"]`).click();
    await until(() => f.messages[0].deleted_at && !f.document.querySelector(`[data-delete-options="${id}"]`));
    assert.match(f.document.querySelector('.deleted-message').textContent, /You deleted this message/);
  }
});

test('touch fallback selects a message and delete errors stay in the popup for retry', async t => {
  const f = await ui(t, { role: 'client', pointerEvents: false });
  f.messages.push({ id: 'retry-delete', seq: 1, body: 'Please delete', own: true, sender_role: 'client', created_at: Date.now() });
  await f.window.refresh();
  const bubble = f.document.querySelector('.bubble');
  const touch = new f.window.Event('touchstart', { bubbles: true });
  Object.defineProperty(touch, 'touches', { value: [{ identifier: 1, clientX: 10, clientY: 10 }] });
  bubble.dispatchEvent(touch);
  await until(() => bubble.closest('.message').classList.contains('selected'));
  bubble.dispatchEvent(new f.window.Event('touchend', { bubbles: true }));
  f.document.querySelector('[data-delete-options="retry-delete"]').click();
  const fetch = f.window.fetch;
  f.window.fetch = async (path, options) => options?.method === 'DELETE'
    ? { ok: false, status: 401, json: async () => { throw new SyntaxError('Unexpected HTML response'); } }
    : fetch(path, options);
  const button = f.document.querySelector('[data-delete-message="retry-delete"]'); button.click();
  await until(() => f.document.querySelector('.delete-message-error').textContent);
  assert.match(f.document.querySelector('.delete-message-error').textContent, /sign in again/);
  assert.equal(button.disabled, false); assert.equal(f.document.querySelector('#modal').open, true);
  assert.equal(f.messages[0].deleted_at, undefined);
  f.window.fetch = fetch; button.click();
  await until(() => f.messages[0].deleted_at && !f.document.querySelector('#modal').open);
  assert.equal(f.document.querySelector('#modal').open, false);
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
  const f = await ui(t); const at = new Date(2026, 9, 20, 12).getTime();
  f.messages.push({ id: 'm1', seq: 1, body: '', sender: 'Client #ABC123', own: false, created_at: at,
    attachment_id: 'media123', filename: 'voice-note.webm', mime: 'audio/webm', size: 1000 });
  await f.window.refresh();
  const audio = f.document.querySelector('audio'); assert.ok(audio);
  f.document.querySelector('#message-input').value = 'My unsent answer';
  f.messages.push({ id: 'm2', seq: 2, body: 'One more detail', sender: 'Client #ABC123', own: false, created_at: at + 1000 });
  await f.window.refresh();
  assert.equal(f.document.querySelector('audio'), audio);
  assert.equal(f.document.querySelector('#message-input').value, 'My unsent answer');
  assert.equal(f.document.querySelectorAll('.message').length, 2);
  assert.equal(f.document.querySelectorAll('.message-meta').length, 1);
  f.appState.messages.unshift({ id: 'earlier', seq: 0, body: 'Earlier message', sender: 'Client #ABC123', own: false, created_at: at - 1000 });
  f.window.renderMessages(true);
  assert.equal(f.document.querySelector('audio'), audio);
  assert.equal(f.document.querySelector('[data-message-id="m1"] .message-meta'), null);
  assert.ok(f.document.querySelector('[data-message-id="m1"]').classList.contains('group-continuation'));
  assert.equal(f.document.querySelectorAll('.message-meta').length, 1);
  assert.equal(f.document.querySelector('#message-input').value, 'My unsent answer');
});

test('incoming text and image messages do not play the call ringtone', async t => {
  const f = await ui(t);
  let rings = 0; f.window.playCallRingtone = () => { rings++; };
  f.messages.push({ id: 'first', seq: 1, body: 'First message', own: false, sender: 'Client', sender_role: 'client', created_at: Date.now() });
  await f.window.refresh();
  f.messages.push({ id: 'text', seq: 2, body: 'New text', own: false, sender: 'Client', sender_role: 'client', created_at: Date.now() });
  await f.window.refresh();
  f.messages.push({ id: 'image', seq: 3, body: '', own: false, sender: 'Client', sender_role: 'client', created_at: Date.now(),
    attachment_id: 'new-image', filename: 'photo.jpg', mime: 'image/jpeg' });
  await f.window.refresh();
  assert.equal(f.document.querySelectorAll('.message').length, 3);
  assert.ok(f.document.querySelector('.message img'));
  assert.equal(rings, 0);
});

test('incoming call pushes check calls for every role without requiring a visible conversation', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    const f = await ui(t, { role, serviceWorker: true }); let synced = 0;
    f.appState.media = { sync: () => { synced++; } }; f.appState.roomId = null; f.window.renderChat();
    Object.defineProperty(f.document, 'hidden', { configurable: true, value: true });
    const emit = data => f.window.navigator.serviceWorker.dispatchEvent(new f.window.MessageEvent('message', { data }));
    emit({ type: 'chat-message', roomId: 'room123' }); assert.equal(synced, 0);
    emit({ type: 'incoming-call' }); assert.equal(synced, 1);
  }
});

test('clicking the text field or typing enables call sound; cancelled pending audio stays silent', async t => {
  const f = await ui(t); let created = 0, resumed = 0, started = 0, resolveResume;
  f.window.AudioContext = class {
    constructor() { created++; this.state = 'suspended'; this.currentTime = 0; }
    async resume() { resumed++; this.state = 'running'; }
    createOscillator() { return { connect() {}, disconnect() {}, frequency: {}, start() { started++; }, stop() {} }; }
    createGain() { return { connect() {}, disconnect() {}, gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} } }; }
  };
  const input = f.document.querySelector('#message-input'); input.click(); await delay();
  assert.equal(created, 1); assert.equal(resumed, 1); assert.equal(started, 0);
  f.appState.sound.state = 'suspended';
  input.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'a', bubbles: true })); await delay();
  assert.equal(resumed, 2); assert.equal(started, 0);
  const context = f.appState.sound; context.state = 'suspended';
  context.resume = () => new Promise(resolve => { resolveResume = () => { context.state = 'running'; resolve(); }; });
  const cancel = f.window.playCallRingtone(); cancel(); resolveResume(); await delay();
  assert.equal(started, 0);
  context.state = 'suspended'; const stop = f.window.playCallRingtone(); resolveResume(); await delay();
  assert.ok(started > 0); stop();
  f.appState.calls = {}; f.window.showSettings();
  assert.equal(f.document.querySelector('[data-action="test-ringtone"]'), null);
  assert.equal(f.document.querySelector('#modal-body').textContent.includes('Enable / test ringtone'), false);
});

test('typing activity sends only flags and clears on pause, send and hidden chat', async t => {
  const f = await ui(t); let now = Date.now(); f.window.Date.now = () => now;
  const input = f.document.querySelector('#message-input');
  input.value = 'PRIVATE DRAFT'; input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  await until(() => f.calls.some(call => call.path === '/api/activity' && call.data.typing));
  const activity = f.calls.filter(call => call.path === '/api/activity').at(-1).data;
  assert.deepEqual(Object.keys(activity).sort(), ['active', 'roomId', 'tabId', 'typing']);
  assert.equal(JSON.stringify(activity).includes('PRIVATE DRAFT'), false);
  now += 4000; f.window.reportActivity();
  await until(() => f.calls.filter(call => call.path === '/api/activity').at(-1).data.typing === false);
  input.dispatchEvent(new f.window.Event('input', { bubbles: true }));
  f.document.querySelector('#message-form').dispatchEvent(new f.window.Event('submit', { bubbles: true, cancelable: true }));
  await until(() => f.calls.filter(call => call.path === '/api/activity').at(-1).data.typing === false);
  Object.defineProperty(f.document, 'hidden', { configurable: true, value: true });
  f.document.dispatchEvent(new f.window.Event('visibilitychange'));
  await until(() => f.calls.filter(call => call.path === '/api/activity').at(-1).data.active === false);
});

test('typing indicators show only other participants in the visible current conversation and expire', async t => {
  for (const role of ['client', 'agent', 'admin']) {
    const f = await ui(t, { role }); let now = Date.now(); f.window.Date.now = () => now;
    const emit = payload => f.window.testEventStream.listeners.typing({ data: JSON.stringify(payload) });
    const indicator = f.document.querySelector('#typing-indicator');
    assert.equal(indicator.parentElement, f.document.querySelector('.composer-wrap'));
    assert.equal(indicator.nextElementSibling, f.document.querySelector('#message-form'));
    assert.equal(f.document.querySelector('.chat-title #typing-indicator'), null);
    emit({ roomId: 'room123', subject: role === 'client' ? 'room123' : 'agent123', role, typing: true, ttl: 6000 });
    assert.ok(indicator.classList.contains('hidden'));
    const payload = { roomId: 'room123', subject: role === 'client' ? 'staff-other' : 'room123', role: role === 'client' ? 'agent' : 'client', typing: true, ttl: 6000 };
    emit(payload); assert.equal(indicator.classList.contains('hidden'), false); assert.match(indicator.textContent, /typing/);
    emit({ ...payload, typing: false, ttl: 0 }); assert.ok(indicator.classList.contains('hidden'));
    emit({ ...payload, roomId: 'other-room' }); assert.ok(indicator.classList.contains('hidden'));
    emit(payload); now += 6001; f.window.renderTyping(); assert.ok(indicator.classList.contains('hidden'));
    emit(payload); Object.defineProperty(f.document, 'hidden', { configurable: true, value: true }); f.window.renderTyping();
    assert.ok(indicator.classList.contains('hidden'));
  }
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
