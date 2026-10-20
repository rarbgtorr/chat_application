const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const icons = {
  phone: '<path d="M22 16v3a2 2 0 0 1-2 2A19 19 0 0 1 3 4a2 2 0 0 1 2-2h3l2 5-2 2a15 15 0 0 0 7 7l2-2 5 2Z"/>',
  video: '<path d="M15 10 21 6v12l-6-4Z"/><rect x="3" y="5" width="12" height="14" rx="2"/>',
  camera: '<path d="M3 6h4l2-3h6l2 3h4v15H3Z"/><circle cx="12" cy="13" r="4"/>',
  note: '<path d="M5 3h14v18H5zM8 8h8M8 12h8M8 16h5"/>',
  chat: '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  team: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  settings: '<path d="m9 3-1 3-3 1-2 3 2 3-1 3 3 2 3-1 3 2 3-2 1-3 3-1 1-4-3-2-1-3-4 1z"/><circle cx="12" cy="12" r="3"/>',
  logout: '<path d="M9 21H4V3h5m6 14 5-5-5-5M8 12h12"/>',
  search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 5 5"/>',
  send: '<path d="m22 2-7 20-4-9L2 9 22 2ZM22 2 11 13"/>',
  clip: '<path d="m21 11-9 9a6 6 0 0 1-8-8L14 2a4 4 0 0 1 6 6L9 19a2 2 0 0 1-3-3l10-10"/>',
  mic: '<rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/>',
  back: '<path d="m14 6-6 6 6 6"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>',
  lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
  file: '<path d="M14 2H5v20h14V7l-5-5ZM14 2v6h5M8 13h8M8 17h5"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  deleted: '<circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.chat}</svg>`;
const iconButton = (name, action, title) => `<button class="icon-btn" type="button" data-action="${action}" aria-label="${title}" title="${title}">${icon(name)}</button>`;
const brand = `<div class="brand"><span class="brand-mark">w<span>·</span></span><div><strong>wingfactor</strong><small>Support workspace</small></div></div>`;
const state = { me: null, rooms: [], users: [], roomId: null, messages: [], hasMore: false,
  filter: 'all', search: '', file: null, stream: null, connected: false, alerts: [], push: null,
  recorder: null, recordingTimer: null, loading: false, queuedRefresh: false, sound: null,
  pendingMessages: [], selectedMessageId: null };
let toastTimer, refreshTimer, messagePress, suppressMessageClick;
function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5000); }
async function api(path, options = {}) {
  const headers = { ...(options.body && !(options.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...options.headers };
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin', cache: 'no-store' });
  let result;
  try { result = await response.json(); }
  catch {
    const error = new Error(response.status === 401 ? 'Please sign in again or reopen your private support link.' : 'Could not reach the chat service. Refresh and try again.');
    error.status = response.status; throw error;
  }
  if (!response.ok) { const error = new Error(result.error || 'Request failed.'); error.status = response.status; throw error; }
  return result;
}
const post = (path, data = {}) => api(path, { method: 'POST', body: JSON.stringify(data) });
const formatTime = value => value ? new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const formatDay = value => new Date(value).toLocaleDateString([], { day: 'numeric', month: 'long', year: 'numeric' });
function deliveryMark(status, failed = false, pendingId = '') {
  if (failed) return `<button type="button" class="delivery-retry" data-action="retry-send" data-pending-id="${esc(pendingId)}" aria-label="Retry sending" title="Retry sending"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8"/><path d="M10 5v6M10 15h.01"/></svg></button>`;
  if (status === 'sending') return `<span class="delivery-mark sending" aria-label="Sending" title="Sending"><svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.5"/><path d="M10 5.5V10l3 2"/></svg></span>`;
  const double = status === 'delivered' || status === 'read';
  return `<span class="delivery-mark ${status}" aria-label="${status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent'}" title="${status === 'read' ? 'Read' : status === 'delivered' ? 'Delivered' : 'Sent'}"><svg viewBox="0 0 20 14" aria-hidden="true"><path d="M1.5 7.5 5 11l7.5-8.5"/>${double ? '<path d="M7 7.5 10.5 11 18 2.5"/>' : ''}</svg></span>`;
}
function age(value) { const minutes = Math.floor((Date.now() - value) / 60000); return minutes < 1 ? 'Just now' : minutes < 60 ? `${minutes}m` : new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short' }); }
const selectedRoom = () => state.rooms.find(room => room.id === state.roomId);
const clientName = room => room?.private?.name || room?.client?.name || room?.code || 'Client';
const clientNotes = room => room?.private?.notes ?? room?.client?.notes ?? '';
function modal(title, content) { state.media?.closeCamera(); $('#modal').classList.remove('camera-dialog'); $('#modal-body').innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2>${iconButton('close', 'close-modal', 'Close')}</div>${content}`; if (!$('#modal').open) $('#modal').showModal(); }
function dismiss() { $('#modal').close(); }
function cancelMessagePress() { clearTimeout(messagePress?.timer); messagePress = null; }
function clearMessageSelection() {
  cancelMessagePress(); state.selectedMessageId = null;
  document.querySelectorAll('.message.selected').forEach(node => node.classList.remove('selected'));
}
function syncMessageSelection() {
  const message = state.messages.find(item => item.id === state.selectedMessageId);
  if (!message || message.deleted_at || !(message.own || state.me?.role === 'admin')) return clearMessageSelection();
  document.querySelectorAll('[data-message-id]').forEach(node => node.classList.toggle('selected', node.dataset.messageId === message.id));
}
function selectMessage(messageId) {
  state.selectedMessageId = messageId; syncMessageSelection();
  window.getSelection?.()?.removeAllRanges?.();
}
function initials(name) { return esc(name.split(/\s+/).map(x => x[0]).slice(0, 2).join('').toUpperCase()); }
function cameraPhoto(message) { return message.sender_role === 'client' && /^photo-\d+\.jpe?g$/i.test(message.filename || ''); }
function openMessageImage(messageId) {
  const message = state.messages.find(item => item.id === messageId);
  if (!message?.attachment_id || message.attachment_expired || !message.mime?.startsWith('image/')) return;
  const src = `/api/media/${message.attachment_id}`;
  modal(message.filename || 'Photo', `<div class="image-viewer"><img src="${src}" alt="${esc(message.filename || 'Photo')}"></div><div class="modal-actions"><a class="secondary" href="${src}?download=1" download="${esc(message.filename || 'photo')}">${icon('file')} Download</a></div>`);
  if (state.me.role !== 'client' && cameraPhoto(message)) {
    const download = document.createElement('a'); download.href = `${src}?download=1`; download.download = message.filename;
    download.hidden = true; document.body.append(download); download.click(); download.remove();
  }
}

function auth(error = '') {
  state.stream?.close(); state.media?.close(); state.media=null; state.me = null;
  const clientPage = location.pathname.startsWith('/c/');
  $('#app').innerHTML = `<main class="auth"><section class="auth-story">${brand}<div class="eyebrow">A little closer. A lot simpler.</div><h1>Good support<br>starts with a<br><em>conversation.</em></h1><p>One private space for your questions, files, and the people here to help.</p><div class="auth-foot">WINGFACTOR IT SUPPORT<br>Thoughtful support. Connected people.</div></section><section class="auth-form"><div class="auth-form-inner">${clientPage ? `<h2>Your private support space</h2><p>Open the original support link shared with you to access your conversation. If your access was revoked, ask Wingfactor for a new link.</p><div class="error">${esc(error)}</div>` : `<div class="eyebrow muted">Team workspace</div><h2>Welcome back.</h2><p>Sign in to pick up your conversations.</p><form id="login-form"><label class="field"><span>Username</span><input name="username" autocomplete="username" required placeholder="Your team username"></label><label class="field"><span>Password</span><input name="password" type="password" autocomplete="current-password" required placeholder="Enter your password"></label><div class="error" id="login-error">${esc(error)}</div><button class="primary" type="submit">Sign in ${icon('send')}</button></form><div class="auth-note">You’ll stay signed in on this device.<br>Clients: use the private link shared with you.</div>`}</div></section></main>`;
}
function setupScreen(key) {
  auth();
  $('.auth-form-inner').innerHTML = `<div class="eyebrow muted">First-time setup</div><h2>Your support workspace.</h2><p>Create your administrator account. This setup link can be used once.</p><form id="setup-form"><label class="field"><span>Admin username</span><input name="username" value="owner" autocomplete="username" pattern="[a-zA-Z0-9_.@-]{3,100}" required></label><label class="field"><span>Password · at least 14 characters</span><input name="password" type="password" minlength="14" maxlength="200" autocomplete="new-password" required></label><div class="error form-error"></div><button class="primary" type="submit">Create administrator account</button></form>`;
  $('#setup-form').addEventListener('submit', async event => {
    event.preventDefault(); event.stopImmediatePropagation();
    const button = event.target.querySelector('button'); button.disabled = true; button.textContent = 'Creating account…';
    try { await post('/api/setup', { ...Object.fromEntries(new FormData(event.target)), key }); await boot(); }
    catch (error) { event.target.querySelector('.form-error').textContent = error.message; button.disabled = false; button.textContent = 'Create administrator account'; }
  });
}
function rail() {
  const client = state.me.role === 'client';
  return `<aside class="rail">${brand}<p class="nav-label">WORKSPACE</p><button class="nav-item active" data-action="conversations">${icon('chat')}<span>Conversations</span></button>${!client ? `<button class="nav-item" data-action="alerts">${icon('bell')}<span>Notifications</span><span class="count hidden" id="alert-count">0</span></button>` : ''}${state.me.role === 'admin' ? `<button class="nav-item" data-action="team">${icon('team')}<span>Your team</span></button>` : ''}<button class="nav-item" data-action="settings">${icon('settings')}<span>Settings</span></button><div class="rail-note"><strong>${client ? 'A space just for you.' : 'Every conversation matters.'}</strong>${client ? 'Send a message or share a file. Your support team is here to help.' : 'Reply with care. Keep your notifications on so no client is left waiting.'}</div><div class="profile"><span class="avatar">${client ? 'C' : initials(state.me.name)}</span><div>${esc(state.me.name)}<small>${client ? 'Private conversation' : state.me.role === 'admin' ? 'Administrator' : 'Support teammate'}</small></div>${!client ? iconButton('logout', 'logout', 'Sign out') : ''}</div></aside>`;
}
function workspace() {
  const client = state.me.role === 'client';
  $('#app').innerHTML = `<main class="layout ${client ? 'client-layout' : ''}">${rail()}${!client ? `<section class="inbox"><header class="inbox-heading"><h1>Conversations<span class="muted">.</span></h1><div class="mobile-menu">${iconButton('bell', 'alerts', 'Notifications')}${state.me.role === 'admin' ? iconButton('team', 'team', 'Your team') : ''}${iconButton('settings', 'settings', 'Settings')}</div>${state.me.role === 'admin' ? iconButton('plus', 'create-room', 'New conversation') : ''}</header><p class="inbox-subtitle">${state.me.role === 'admin' ? 'Your clients. Your team. One place.' : 'Your assigned clients, all in one place.'}</p><label class="search">${icon('search')}<input id="room-search" placeholder="Search conversations" aria-label="Search conversations"></label><div class="filters"><button class="filter active" data-filter="all">All chats</button><button class="filter" data-filter="unread">Unread</button><button class="filter" data-filter="waiting">Waiting</button><button class="filter" data-filter="closed">Closed</button></div><div id="room-list" class="room-list"></div><div class="list-foot"><span class="dot"></span><span id="list-count">Your support workspace</span></div></section>` : ''}<section class="conversation" id="conversation"></section></main>`;
  renderList(); renderChat();
}
function renderList() {
  if (!$('#room-list')) return;
  const rooms = state.rooms.filter(r => {
    const query = `${r.code} ${clientName(r)} ${r.private?.contact || ''}`.toLowerCase();
    return query.includes(state.search.toLowerCase()) && (state.filter === 'unread' ? r.unread > 0 :
      state.filter === 'waiting' ? Boolean(r.waitingSince) && r.status === 'open' : state.filter === 'closed' ? r.status === 'closed' : true);
  }).sort((a, b) => (b.last?.created_at || b.created_at) - (a.last?.created_at || a.created_at));
  $('#room-list').innerHTML = rooms.map(room => `<button class="room-item ${room.id === state.roomId ? 'selected' : ''}" data-room="${room.id}"><span class="avatar">${initials(clientName(room))}</span><span class="room-info"><span class="room-top"><strong>${esc(clientName(room))}</strong><time>${age(room.last?.created_at || room.created_at)}</time></span><span class="room-preview">${esc(room.last?.body || 'Your conversation starts here.')}</span><span class="room-bottom"><span class="tag ${room.waitingSince ? 'waiting' : ''}">${room.status === 'closed' ? 'Closed' : room.waitingSince ? 'Awaiting reply' : 'Open'}</span>${room.unread ? `<span class="count">${room.unread}</span>` : `<small>${esc(room.agents.map(a => a.name).join(', ') || 'Unassigned')}</small>`}</span></span></button>`).join('') || `<div class="empty-list">${state.rooms.length ? 'No matching conversations.' : 'No conversations yet.<br>' + (state.me.role === 'admin' ? 'Create a room and share the private link.' : 'Your assigned conversations will appear here.')}</div>`;
  $('#list-count').textContent = `${state.rooms.length} conversation${state.rooms.length === 1 ? '' : 's'} · history stays saved`;
}
function renderChat() {
  clearMessageSelection();
  const room = selectedRoom();
  $('.layout')?.classList.toggle('has-room', Boolean(room));
  if (!room) {
    $('#conversation').innerHTML = `<div class="chat-empty"><div class="chat-empty-inner"><span class="brand-mark">w<span>·</span></span><div class="eyebrow">Your support workspace</div><h2>A clear space.<br>A better conversation.</h2><p>Select a conversation to read messages, share files, and help your clients move forward.</p>${state.me.role === 'admin' ? `<button class="primary" data-action="create-room">${icon('plus')} Create a conversation</button>` : ''}</div></div>`;
    return;
  }
  const client = state.me.role === 'client', displayName = client ? 'Wingfactor Support' : clientName(room);
  $('#conversation').innerHTML = `<header class="chat-header">${!client ? `<span class="mobile-back">${iconButton('back', 'back', 'Back to conversations')}</span>` : ''}<span class="avatar">${client ? 'W' : initials(displayName)}</span><div class="chat-title"><h2>${esc(displayName)}</h2>${client ? '' : `<p>${room.agents.length ? `Assigned to ${esc(room.agents.map(a => a.name).join(', '))}` : 'No teammate assigned'}</p>`}</div><div class="header-actions"><span class="connection"><span class="dot"></span><span id="connection-text">Connecting…</span></span><span class="tag">${room.status === 'open' ? 'Open' : 'Closed'}</span>${state.calls && room.status==='open' ? `${iconButton('phone', 'voice-call', 'Start voice call')}${iconButton('video', 'video-call', 'Start video call')}` : ''}${state.me.role === 'agent' ? iconButton('note', 'client-notes', 'View client notes') : ''}${iconButton('bell', 'settings', 'Notification settings')}${state.me.role === 'admin' ? iconButton('more', 'room-settings', 'Conversation settings') : ''}</div></header><div id="notification-banner"></div><div class="messages" id="messages" role="log" aria-label="Conversation messages" aria-live="polite"></div><div class="composer-wrap">${room.status === 'open' ? `<form class="composer" id="message-form"><div id="file-preview" class="file-preview hidden"></div><label class="hidden" for="message-input">Message</label><textarea id="message-input" placeholder="Write a message…" maxlength="10000"></textarea><div class="composer-bar">${iconButton('clip', 'attach', 'Attach a file')}${state.calls ? iconButton('camera', 'camera', 'Take a photo') : ''}${iconButton('mic', 'record', 'Record or stop a voice note')}<span class="composer-hint">Enter to send · Shift + Enter for a new line</span><button class="send" id="send-button" type="submit">Send ${icon('send')}</button></div><input type="file" id="file-input" class="hidden" accept=".jpg,.jpeg,.png,.webp,.gif,.mp4,.webm,.mov,.mp3,.m4a,.ogg,.wav,.pdf,.doc,.docx,.txt,.csv"></form><div class="composer-footer">${client ? `<span>${icon('lock').replace('<svg ', '<svg width="9" height="9" ')} Securely connected</span>` : `<span>${icon('lock').replace('<svg ', '<svg width="9" height="9" ')} Private support room</span><span>Messages stay until your admin deletes them.</span>`}</div>` : `<div class="settings-note">This conversation is closed. Your history and files are still available.</div>`}</div>`;
  state.file = null; renderMessages(); notificationBanner(); connection(state.connected);
}
function renderMessages(prepend = false) {
  const container = $('#messages'); if (!container) return;
  const oldHeight = container.scrollHeight; const scrollTop = container.scrollTop;
  const atBottom = oldHeight - scrollTop - container.clientHeight < 120;
  const room = selectedRoom(); let lastDay = '';
  const savedIds = new Set(state.messages.map(message => message.id));
  const messages = [...state.messages, ...state.pendingMessages.filter(message => message.roomId === state.roomId && !savedIds.has(message.serverId))];
  const rows = messages.map(message => {
    const day = formatDay(message.created_at); let divider = '';
    if (day !== lastDay) { lastDay = day; divider = `<div class="day-divider" data-key="day-${esc(day)}">${esc(day)}</div>`; }
    const deleted = Boolean(message.deleted_at); let attachment = '';
    if (deleted) {
      attachment = '';
    } else if (message.localUrl) {
      attachment = `<div class="attachment image-attachment pending-attachment"><img src="${esc(message.localUrl)}" alt="${esc(message.filename)}"></div>`;
    } else if (message.pending && message.filename) {
      attachment = `<div class="attachment pending-attachment">${icon('file')} <span>${esc(message.filename)}</span></div>`;
    } else if (message.attachment_id && message.attachment_expired) {
      attachment = `<div class="attachment"><span class="small">Attachment expired · deleted after 7 days</span></div>`;
    } else if (message.attachment_id) {
      const src = `/api/media/${message.attachment_id}`;
      const image = message.mime?.startsWith('image/');
      const preview = image ? `<button type="button" class="image-open" data-open-image="${message.id}" aria-label="Open ${esc(message.filename || 'photo')}"><img src="${src}" alt="${esc(message.filename)}" loading="lazy"></button>` : message.mime?.startsWith('video/') ? `<video src="${src}" controls preload="metadata"></video>` : message.mime?.startsWith('audio/') ? `<audio src="${src}" controls preload="metadata"></audio>` : '';
      attachment = image ? `<div class="attachment image-attachment">${preview}</div>` : `<div class="attachment">${preview}<a href="${src}?download=1" download>${icon('file')} ${esc(message.filename)}</a><small>${(message.size / 1024 / 1024).toFixed(2)} MB · Download</small></div>`;
    }
    const receipt = message.own && !deleted && message.sender_role !== 'system';
    const delivery = message.pending ? message.failed ? 'failed' : message.serverId ? 'sent' : 'sending' : message.delivery || 'sent';
    const imageMessage = !deleted && Boolean(message.localUrl || (message.attachment_id && !message.attachment_expired && message.mime?.startsWith('image/')));
    const key = message.pending ? `${message.id}-${delivery}` : `${message.id}-${Boolean(message.attachment_expired)}-${message.deleted_at || ''}-${message.deleted_by_me || ''}-${receipt ? delivery : ''}`;
    const meta = message.own ? '' : `<div class="message-meta"><span>${esc(message.sender)}</span><time>${formatTime(message.created_at)}</time></div>`;
    const status = `<span class="message-status"><time>${formatTime(message.created_at)}</time>${receipt ? deliveryMark(delivery, message.failed, message.id) : ''}</span>`;
    const canDelete = !message.pending && !deleted && (message.own || state.me.role === 'admin');
    const remove = canDelete ? `<button type="button" class="message-delete-trigger" data-delete-options="${esc(message.id)}" aria-label="Delete message" title="Delete message">${icon('trash')}</button>` : '';
    const content = deleted ? `<span class="deleted-message">${icon('deleted')}<em>${message.deleted_by_me ? 'You deleted this message' : 'This message was deleted'}</em></span>` : `${message.body ? `<span class="message-body">${esc(message.body)}</span>` : ''}${attachment}`;
    return `${divider}<article data-key="${key}" data-message-id="${esc(message.id)}" ${canDelete ? 'data-selectable="true" tabindex="0" aria-keyshortcuts="Shift+F10" title="Press and hold for message actions"' : ''} class="message ${message.own ? 'own' : ''} ${deleted ? 'deleted' : ''} ${imageMessage ? 'image-message' : ''} ${message.pending ? 'pending-message' : ''} ${message.failed ? 'send-failed' : ''}">${meta}<div class="message-content"><div class="bubble">${content}${status}</div>${remove}</div></article>`;
  }).join('');
  const template = document.createElement('template');
  template.innerHTML = `${state.hasMore ? '<button data-key="earlier" class="secondary load-earlier" data-action="earlier">Load earlier messages</button>' : ''}${rows || `<div data-key="intro" class="chat-intro"><span class="avatar">${icon('chat')}</span><h3>You’re connected.</h3><p>${state.me.role === 'client' ? 'Send your first message or share a file. Your support team will take it from here.' : `This is your conversation with ${esc(clientName(room))}. Send a message to get started.`}</p></div>`}`;
  // Keep existing media elements attached: a live message must not restart playing audio/video.
  const existing = new Map([...container.children].map(node => [node.dataset.key, node]));
  const freshNodes = [...template.content.children]; const keep = new Set();
  freshNodes.forEach((fresh, index) => {
    const node = existing.get(fresh.dataset.key) || fresh; keep.add(node);
    const position = container.children[index] || null;
    if (node !== position) container.insertBefore(node, position);
  });
  [...container.children].filter(node => !keep.has(node)).forEach(node => node.remove());
  if (state.selectedMessageId) syncMessageSelection();
  if (prepend) container.scrollTop = scrollTop + container.scrollHeight - oldHeight;
  else if (atBottom || !oldHeight) container.scrollTop = container.scrollHeight;
}
function connection(connected) {
  state.connected = connected;
  $('.connection')?.classList.toggle('offline', !connected);
  if ($('#connection-text')) $('#connection-text').textContent = connected ? 'Live chat' : 'Reconnecting…';
}
function notificationBanner() {
  if (!$('#notification-banner')) return;
  const enabled = 'Notification' in window && Notification.permission === 'granted' && state.push?.devices > 0;
  $('#notification-banner').innerHTML = enabled ? '' : `<div class="notification-banner">${icon('bell')}<p>${state.push?.enabled ? 'Stay in the loop. Enable notifications on this device for new messages.' : 'Live chat is ready. Background alerts need server push configuration.'}</p><button class="secondary" data-action="settings">${state.push?.enabled ? 'Enable alerts' : 'Details'}</button></div>`;
}
async function loadMessages(roomId, before) {
  const result = await api(`/api/rooms/${roomId}/messages${before ? `?before=${before}` : ''}`);
  if (state.roomId !== roomId) return;
  const previousLast = state.messages.at(-1)?.seq;
  const oldSignature = state.messages.map(m => `${m.id}:${Boolean(m.attachment_expired)}:${m.deleted_at || ''}:${m.deleted_by_me || ''}:${m.delivery || ''}`).join(',');
  if (before) state.messages = [...result.messages, ...state.messages];
  else {
    // Retain previously loaded pages when realtime refresh fetches the most recent page.
    const first = result.messages[0]?.seq || 0;
    state.messages = [...(result.hasMore ? state.messages.filter(m => m.seq < first) : []), ...result.messages];
  }
  if (before || state.messages.length <= 100) state.hasMore = result.hasMore;
  const savedIds = new Set(state.messages.map(message => message.id));
  state.pendingMessages = state.pendingMessages.filter(message => {
    if (!message.serverId || !savedIds.has(message.serverId)) return true;
    if (message.localUrl) URL.revokeObjectURL(message.localUrl); return false;
  });
  if (oldSignature !== state.messages.map(m => `${m.id}:${Boolean(m.attachment_expired)}:${m.deleted_at || ''}:${m.deleted_by_me || ''}:${m.delivery || ''}`).join(',') || !$('#messages')?.querySelector('.message')) renderMessages(Boolean(before));
  if (!before && previousLast && state.messages.at(-1)?.seq > previousLast && !state.messages.at(-1).own) beep();
  if (!document.hidden && state.messages.length) {
    await post(`/api/rooms/${roomId}/read`, { seq: state.messages.at(-1).seq });
    const room = selectedRoom(); if (room) room.unread = 0; renderList();
  }
}
async function selectRoom(roomId) {
  state.media?.closeCamera(); if ($('#camera-video')) dismiss();
  if (state.recorder?.state === 'recording') return toast('Stop your voice recording before switching conversations.');
  if (state.file || $('#message-input')?.value.trim()) {
    if (!confirm('Switch conversation and discard this unsent draft?')) return;
  }
  state.roomId = roomId; state.messages = []; state.hasMore = false;
  history.replaceState(null, '', state.me.role === 'client' ? `/c/${roomId}` : `/?room=${roomId}`);
  renderList(); renderChat(); await loadMessages(roomId);
}
async function refresh() {
  if (!state.me) return;
  if (state.loading) { state.queuedRefresh = true; return; } state.loading = true;
  try {
    state.rooms = await api('/api/rooms'); renderList(); void acknowledgeDeliveries(); void state.media?.sync();
    if (state.roomId && !selectedRoom()) { state.roomId = null; state.messages = []; renderChat(); }
    if (state.roomId) {
      const closed = selectedRoom()?.status === 'closed';
      if (closed !== !Boolean($('#message-form'))) renderChat();
      await loadMessages(state.roomId);
    }
    if (state.me.role !== 'client') {
      state.alerts = await api('/api/alerts');
      if ($('#alert-count')) { $('#alert-count').textContent = state.alerts.length; $('#alert-count').classList.toggle('hidden', !state.alerts.length); }
    }
  } catch (error) {
    if (error.status === 401) auth('Your access changed. Please sign in again.');
    else { connection(false); }
  } finally { state.loading = false; if (state.queuedRefresh) { state.queuedRefresh = false; void refresh(); } }
}
async function startEvents() {
  state.stream?.close();
  if (state.realtime) {
    try {
      const { connect } = await import('/realtime.js');
      state.stream = connect(state.realtime, () => {
        clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh(), 100);
      }, status => { connection(status === 'SUBSCRIBED'); if (status === 'SUBSCRIBED') void refresh(); });
    } catch { connection(false); }
    return;
  }
  const stream = new EventSource('/api/events'); state.stream = stream;
  stream.addEventListener('connected', () => { connection(true); void refresh(); });
  for (const type of ['change', 'alert']) stream.addEventListener(type, () => {
    clearTimeout(refreshTimer); refreshTimer = setTimeout(() => void refresh(), 100);
  });
  stream.onerror = () => connection(false);
}
function beep() {
  if (!state.sound || state.sound.state !== 'running') return;
  const nodes = [], now = state.sound.currentTime;
  for (const offset of [0, .58]) {
    for (const frequency of [660, 880]) {
      const oscillator = state.sound.createOscillator(), gain = state.sound.createGain();
      nodes.push(oscillator); oscillator.connect(gain); gain.connect(state.sound.destination);
      oscillator.frequency.value = frequency;
      const start = now + offset;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(.22, start + .025);
      gain.gain.setValueAtTime(.22, start + .34);
      gain.gain.linearRampToValueAtTime(0, start + .4);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(start); oscillator.stop(start + .4);
    }
  }
  return () => nodes.forEach(node => { try { node.stop(); } catch {} });
}
async function boot() {
  try {
    const setup = new URLSearchParams(location.hash.slice(1)).get('setup');
    if (setup) { history.replaceState(null, '', '/'); setupScreen(setup); return; }
    const key = new URLSearchParams(location.hash.slice(1)).get('key');
    if (key) {
      // Remove the bearer link secret from the address bar before any other app requests.
      history.replaceState(null, '', location.pathname);
      const result = await post('/api/client/session', { key });
      history.replaceState(null, '', `/c/${result.roomId}`);
    }
    const result = await api('/api/me'); state.me = result.user; state.push = result.push; state.realtime = result.realtime; state.calls=result.calls;
    state.media?.close();state.media=null;
    if(result.calls){const {installMedia}=await import('/chat-media.js');state.media=installMedia({api,post,config:result.calls,room:id=>{const r=state.rooms.find(x=>x.id===id);return r?{...r,code:state.me?.role==='client'?'Wingfactor Support':clientName(r)}:null;},preview:previewFile,modal,dismiss,toast,recording:()=>state.recorder?.state==='recording',beep});}
    state.rooms = await api('/api/rooms'); void acknowledgeDeliveries();
    state.roomId = state.me.role === 'client' ? state.me.roomId : new URLSearchParams(location.search).get('room');
    if (!selectedRoom()) state.roomId = null;
    workspace(); if (state.roomId) await loadMessages(state.roomId);
    if ('serviceWorker' in navigator) {
      try {
        const registration = await navigator.serviceWorker.register('/sw.js');
        const subscription = await registration.pushManager?.getSubscription();
        if (subscription && 'Notification' in window && Notification.permission === 'granted' && state.push.enabled) {
          await post('/api/push', { subscription: subscription.toJSON() });
          state.push.devices = 1; notificationBanner();
        }
      } catch {
        toast('Chat is ready. Check notification settings to enable background alerts.');
      }
    }
    startEvents();
  } catch (error) { auth(error.status === 401 && !location.pathname.startsWith('/c/') ? '' : error.message); }
}
async function enablePush() {
  if (!state.push.enabled) throw new Error('Background push is not configured on the server yet.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('This browser does not support background push. Use a supported browser; on iPhone, add the app to your Home Screen.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Allow notifications in your browser/site settings, then try again.');
  const registration = await navigator.serviceWorker.ready;
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    const base64 = state.push.publicKey.replace(/-/g, '+').replace(/_/g, '/');
    const key = Uint8Array.from(atob(base64), char => char.charCodeAt(0));
    subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await post('/api/push', { subscription: subscription.toJSON() }); state.push.devices = 1;
  notificationBanner(); toast('Notifications enabled. Send a test to check this device.'); showSettings();
}
function showSettings() {
  const permission = 'Notification' in window ? Notification.permission : 'unsupported';
  modal('Your settings', `<p class="modal-description">Keep alerts enabled on every device you use for support.</p><div class="section-label">Notifications on this device</div><div class="settings-row"><span class="tag ${permission === 'granted' ? '' : 'waiting'}">${esc(permission === 'granted' && state.push.devices ? 'Enabled' : permission === 'denied' ? 'Blocked in browser' : 'Not enabled')}</span><button class="secondary" data-action="enable-push">Enable notifications</button><button class="secondary" data-action="test-push">Send test alert</button></div><div class="settings-note">Allow browser notifications and sound. Check your phone’s notification and battery settings if alerts are delayed. Delivery needs an internet connection.<br>${state.push.enabled ? '' : '<strong>Server setup needed:</strong> set PUSH_CONTACT before using background alerts.'}</div>${state.me.role !== 'client' ? `<div class="section-label">Your account</div><button class="secondary" data-action="password">Change password</button><div class="settings-note">You stay signed in on this device. Signing out, an admin revoking access, or clearing browser data will require a new login.<br>Unanswered client messages: teammate reminder at 5 minutes, admin alert at 10 minutes.</div><div class="modal-actions"><button class="danger" data-action="logout">Sign out of this device</button></div>` : ''}`);
}
async function showTeam() {
  state.users = await api('/api/users');
  modal('Your team', `<p class="modal-description">Teammates can access only their assigned client rooms.</p>${state.users.map(user => `<div class="team-row"><span class="avatar">${initials(user.name)}</span><div class="team-info">${esc(user.name)}<small>${esc(user.username)} · ${user.role === 'admin' ? 'Administrator' : user.disabled ? 'Disabled' : 'Teammate'}</small></div>${user.role === 'agent' ? `<button class="secondary" data-reset-user="${user.id}">Reset password</button><button class="${user.disabled ? 'secondary' : 'danger'}" data-disable-user="${user.id}" data-disabled="${!user.disabled}">${user.disabled ? 'Enable' : 'Disable'}</button>` : ''}</div>`).join('')}<div class="modal-actions"><button class="primary" data-action="add-agent">${icon('plus')} Add teammate</button></div>`);
}
function agentChecks(selected = []) {
  const agents = state.users.filter(u => u.role === 'agent' && !u.disabled);
  return `<div class="check-list">${agents.map(u => `<label class="check-item"><input type="checkbox" name="agentIds" value="${u.id}" ${selected.includes(u.id) ? 'checked' : ''}>${esc(u.name)}</label>`).join('') || '<p class="small muted">Add a teammate from “Your team” to assign this room.</p>'}</div>`;
}
async function createRoom() {
  state.users = await api('/api/users');
  modal('Start a conversation', `<p class="modal-description">Assigned teammates can see the client name and support notes. Phone or email stays visible only to you.</p><form id="room-form"><label class="field"><span>Client name · visible to teammates</span><input name="name" maxlength="100" placeholder="Optional"></label><label class="field"><span>Phone or email · admin only</span><input name="contact" maxlength="200" placeholder="Optional"></label><label class="field"><span>Support notes · visible to teammates</span><textarea name="notes" maxlength="2000" placeholder="Optional"></textarea></label><label class="field"><span>Assign teammates</span>${agentChecks()}</label><div class="error form-error"></div><div class="modal-actions"><button class="secondary" type="button" data-action="close-modal">Cancel</button><button class="primary" type="submit">Create room & access link</button></div></form>`);
}
function showLink(link) {
  modal('Client access link', `<p class="modal-description">Send this link privately to your client on WhatsApp. Anyone with it can access this conversation. Keep a copy: the secret is shown only now. Creating a replacement revokes the old link and client sessions.</p><div class="link-box" id="client-link">${esc(link)}</div><div class="modal-actions"><button class="primary" data-action="copy-link">Copy private link</button><button class="secondary" data-action="close-modal">Done</button></div>`);
}
async function roomSettings() {
  const room = selectedRoom(); if (!room) return; state.users = await api('/api/users');
  modal(clientName(room), `<form id="edit-room-form"><p class="modal-description">Assigned teammates can see the client name and support notes. Contact details stay administrator-only.</p><label class="field"><span>Client name</span><input name="name" value="${esc(room.private?.name)}" maxlength="100"></label><label class="field"><span>Phone or email · admin only</span><input name="contact" value="${esc(room.private?.contact)}" maxlength="200"></label><label class="field"><span>Support notes · visible to teammates</span><textarea name="notes" maxlength="2000">${esc(room.private?.notes)}</textarea></label><label class="field"><span>Assigned teammates</span>${agentChecks(room.agents.map(a => a.id))}</label><div class="error form-error"></div><div class="modal-actions"><button class="primary" type="submit">Save changes</button></div></form><div class="section-label">Conversation controls</div><div class="settings-row"><button class="secondary" data-action="rotate-link">Replace access link</button><button class="secondary" data-action="revoke-link">Revoke client access</button><button class="secondary" data-action="toggle-room">${room.status === 'open' ? 'Close conversation' : 'Reopen conversation'}</button></div><div class="settings-note">Closing keeps all messages and files. Deleting permanently removes this room, its history, and its attachments.</div><div class="modal-actions"><button class="danger" data-action="delete-room">Delete permanently</button></div>`);
}
async function showAlerts() {
  state.alerts = await api('/api/alerts');
  modal('Notifications', `<p class="modal-description">Unread updates and unanswered-client reminders.</p>${state.alerts.map(alert => `<div class="alert-row"><span class="tag ${alert.kind === 'escalation' ? 'waiting' : ''}">${esc(alert.kind)}</span> <strong>${esc(alert.code)}</strong><p>${esc(alert.body)} · ${age(alert.created_at)}</p><button class="secondary" data-alert-room="${alert.room_id}">Open conversation</button></div>`).join('') || '<div class="settings-note">All caught up. New alerts will appear here.</div>'}<div class="modal-actions"><button class="secondary" data-action="clear-alerts">Mark alerts as seen</button></div>`);
}
function removePendingMessage(id, rerender = true) {
  const pending = state.pendingMessages.find(message => message.id === id);
  if (!pending) return;
  if (pending.localUrl) URL.revokeObjectURL(pending.localUrl);
  state.pendingMessages = state.pendingMessages.filter(message => message.id !== id);
  if (rerender) renderMessages();
}
function previewFile(file, sendImmediately = false) {
  if (file.size > 25 * 1024 * 1024) { toast('Maximum attachment size is 25 MB.'); return false; }
  const form = $('#message-form');
  if (form?.dataset.pendingId) { removePendingMessage(form.dataset.pendingId); delete form.dataset.pendingId; }
  state.file = file; $('#file-preview').classList.toggle('hidden', sendImmediately);
  $('#file-preview').innerHTML = `<span>${esc(file.name)} · ${(file.size / 1024 / 1024).toFixed(2)} MB</span>${iconButton('close', 'remove-file', 'Remove attachment')}`;
  if (sendImmediately) {
    const pending = { id: `pending-${crypto.randomUUID()}`, roomId: state.roomId, created_at: Date.now(), own: true,
      sender: state.me.name, sender_role: state.me.role, body: '', filename: file.name, mime: file.type, size: file.size,
      localUrl: URL.createObjectURL(file), file, nonce: crypto.randomUUID(), pending: true, failed: false, serverId: null };
    state.pendingMessages.push(pending); form.dataset.pendingId = pending.id; renderMessages();
  }
  return true;
}
async function sendPendingMessage(pending) {
  if (!pending || pending.sending || pending.serverId) return;
  pending.sending = true; pending.failed = false; renderMessages();
  try {
    if (pending.file && !pending.attachmentId) {
      const uploaded = await api(`/api/rooms/${pending.roomId}/upload`, { method: 'POST', body: pending.file,
        headers: { 'X-Filename': encodeURIComponent(pending.file.name), 'Content-Type': pending.file.type || 'application/octet-stream' } });
      pending.attachmentId = uploaded.attachmentId;
    }
    const sent = await post(`/api/rooms/${pending.roomId}/messages`, { body: pending.body,
      attachmentId: pending.attachmentId || null, nonce: pending.nonce });
    pending.serverId = sent.id; pending.failed = false; pending.file = null; renderMessages();
    await refresh();
  } catch (error) {
    pending.failed = true; renderMessages(); toast(error.message);
  } finally { pending.sending = false; }
}
async function acknowledgeDeliveries() {
  if (!state.me || !state.rooms.length) return;
  const roomIds = state.me.role === 'client' ? [state.me.roomId] : state.rooms.map(room => room.id).slice(0, 500);
  try { await post('/api/delivered', { roomIds }); } catch {}
}
async function record() {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Voice recording is unavailable. You can attach an audio file instead.');
  const media = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(media, type ? { mimeType: type } : {}); const chunks = [];
  state.recorder = recorder;
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  recorder.onstop = () => {
    media.getTracks().forEach(track => track.stop()); clearTimeout(state.recordingTimer);
    $('[data-action="record"]')?.classList.remove('recording');
    const mime = recorder.mimeType; const extension = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
    previewFile(new File(chunks, `voice-note-${Date.now()}.${extension}`, { type: mime }));
    state.recorder = null; toast('Voice note ready. Press Send to share it.');
  };
  recorder.start(); $('[data-action="record"]')?.classList.add('recording');
  state.recordingTimer = setTimeout(() => recorder.state === 'recording' && recorder.stop(), 3 * 60 * 1000);
  toast('Recording… Tap the microphone again to stop. Maximum 3 minutes.');
}

document.addEventListener('submit', async event => {
  const form = event.target; event.preventDefault();
  const button = form.querySelector('[type="submit"]'); const oldLabel = button?.innerHTML;
  if (button && form.id !== 'message-form') { button.disabled = true; button.textContent = 'Saving…'; }
  const values = Object.fromEntries(new FormData(form));
  try {
    if (form.id === 'login-form') { await post('/api/login', values); await boot(); }
    else if (form.id === 'room-form') {
      const room = await post('/api/rooms', { ...values, agentIds: new FormData(form).getAll('agentIds') });
      await refresh(); await selectRoom(room.roomId); showLink(room.link);
    } else if (form.id === 'edit-room-form') {
      await api(`/api/rooms/${state.roomId}`, { method: 'PATCH', body: JSON.stringify({ private: values, agentIds: new FormData(form).getAll('agentIds') }) });
      dismiss(); await refresh(); renderChat(); toast('Conversation updated.');
    } else if (form.id === 'agent-form') { await post('/api/users', values); await showTeam(); toast('Teammate added. Share their credentials privately.'); }
    else if (form.id === 'reset-form') {
      await api(`/api/users/${form.dataset.userId}`, { method: 'PATCH', body: JSON.stringify(values) });
      await showTeam(); toast('Password reset. Previous sessions have been revoked.');
    } else if (form.id === 'password-form') {
      await post('/api/password', values); dismiss(); await boot(); toast('Password changed. Enable notifications again on this device.');
    } else if (form.id === 'message-form') {
      if (state.recorder?.state === 'recording') throw new Error('Stop the voice recording before sending.');
      const input = $('#message-input'); const value = input.value.trim(); const roomId = state.roomId;
      if (!value && !state.file) return;
      const file = state.file; let pending = state.pendingMessages.find(message => message.id === form.dataset.pendingId);
      if (!pending) {
        pending = { id: `pending-${crypto.randomUUID()}`, roomId, created_at: Date.now(), own: true,
          sender: state.me.name, sender_role: state.me.role, body: value, filename: file?.name, mime: file?.type,
          size: file?.size, localUrl: file?.type.startsWith('image/') ? URL.createObjectURL(file) : null,
          file, nonce: crypto.randomUUID(), pending: true, failed: false, serverId: null };
        state.pendingMessages.push(pending);
      } else {
        pending.body = value; pending.file ||= file; pending.nonce ||= crypto.randomUUID();
      }
      input.value = ''; state.file = null; $('#file-preview').classList.add('hidden');
      delete form.dataset.pendingId; renderMessages();
      void sendPendingMessage(pending); return;
    }
  } catch (error) {
    if (form.id === 'message-form' && form.dataset.pendingId) {
      const pending = state.pendingMessages.find(message => message.id === form.dataset.pendingId);
      if (pending) { pending.failed = true; renderMessages(); }
    }
    const target = form.querySelector('.form-error') || $('#login-error');
    if (target) target.textContent = error.message; else toast(error.message);
  } finally { if (button?.isConnected && form.id !== 'message-form') { button.disabled = false; button.innerHTML = oldLabel; } }
});
function startMessagePress(target, point, pointerId) {
  cancelMessagePress();
  const message = target?.closest?.('.message[data-selectable="true"]');
  if (!message || !target.closest('.bubble') || target.closest('a,audio,video,input,button:not(.image-open)')) return;
  const press = { id: message.dataset.messageId, pointerId, x: point.clientX, y: point.clientY };
  press.timer = setTimeout(() => {
    if (messagePress !== press || !message.isConnected) return;
    selectMessage(press.id); press.selected = true; suppressMessageClick = { id: press.id, until: Date.now() + 1000 };
  }, 500);
  messagePress = press;
}
document.addEventListener('pointerdown', event => {
  if (event.isPrimary === false || (event.button !== undefined && event.button !== 0)) return cancelMessagePress();
  startMessagePress(event.target, event, event.pointerId);
});
document.addEventListener('pointermove', event => {
  if (messagePress && event.pointerId === messagePress.pointerId &&
    Math.hypot(event.clientX - messagePress.x, event.clientY - messagePress.y) > 10) cancelMessagePress();
});
for (const name of ['pointerup', 'pointercancel']) document.addEventListener(name, () => {
  if (messagePress?.selected) suppressMessageClick = { id: messagePress.id, until: Date.now() + 1000 };
  cancelMessagePress();
});
document.addEventListener('scroll', cancelMessagePress, true);
if (!window.PointerEvent) {
  document.addEventListener('touchstart', event => {
    if (event.touches.length !== 1) return cancelMessagePress();
    startMessagePress(event.target, event.touches[0], event.touches[0].identifier);
  }, { passive: true });
  document.addEventListener('touchmove', event => {
    const touch = [...event.touches].find(item => item.identifier === messagePress?.pointerId);
    if (!touch || Math.hypot(touch.clientX - messagePress.x, touch.clientY - messagePress.y) > 10) cancelMessagePress();
  }, { passive: true });
  for (const name of ['touchend', 'touchcancel']) document.addEventListener(name, () => {
    if (messagePress?.selected) suppressMessageClick = { id: messagePress.id, until: Date.now() + 1000 };
    cancelMessagePress();
  });
}
document.addEventListener('contextmenu', event => {
  const message = event.target.closest?.('.message[data-selectable="true"] .bubble');
  if (!message || event.target.closest('audio,video,a')) return;
  const id = message.closest('.message').dataset.messageId;
  event.preventDefault(); cancelMessagePress(); selectMessage(id); suppressMessageClick = { id, until: Date.now() + 1000 };
});
document.addEventListener('click', event => {
  const target = event.target.closest ? event.target : event.target.parentElement; if (!target) return;
  const message = target.closest('[data-message-id]');
  if (!target.closest('[data-delete-options]') && suppressMessageClick && message && suppressMessageClick.id === message.dataset.messageId && Date.now() < suppressMessageClick.until) {
    suppressMessageClick = null; event.preventDefault(); event.stopImmediatePropagation(); return;
  }
  if (state.selectedMessageId && !target.closest('#modal') && message?.dataset.messageId !== state.selectedMessageId) clearMessageSelection();
}, true);
document.addEventListener('click', async event => {
  const button = event.target.closest?.('button'); if (!button) return;
  try {
    if (!state.sound && window.AudioContext) { state.sound = new AudioContext(); }
    if (state.sound?.state === 'suspended') void state.sound.resume();
    if (button.dataset.room) return await selectRoom(button.dataset.room);
    if (button.dataset.alertRoom) { dismiss(); return await selectRoom(button.dataset.alertRoom); }
    if (button.dataset.openImage) { openMessageImage(button.dataset.openImage); return; }
    if (button.dataset.deleteOptions) {
      const message = state.messages.find(item => item.id === button.dataset.deleteOptions);
      if (!message || message.deleted_at || !(message.own || state.me.role === 'admin')) return clearMessageSelection();
      selectMessage(message.id);
      modal('Delete message', `<div class="delete-message-options"><button type="button" class="danger" data-delete-message="${esc(message.id)}" data-delete-room="${esc(state.roomId)}">${icon('trash')} Delete for everyone</button><button type="button" class="secondary" data-action="close-modal">Cancel</button><p class="error delete-message-error" role="alert"></p></div>`);
      return;
    }
    if (button.dataset.deleteMessage) {
      button.disabled = true; button.setAttribute('aria-busy', 'true');
      const roomId = button.dataset.deleteRoom;
      const errorText = $('#modal .delete-message-error'); if (errorText) errorText.textContent = '';
      let result;
      try { result = await api(`/api/rooms/${roomId}/messages/${button.dataset.deleteMessage}`, { method: 'DELETE' }); }
      catch (error) { button.disabled = false; button.removeAttribute('aria-busy'); if (errorText) errorText.textContent = error.message; else toast(error.message); return; }
      const message = state.messages.find(item => item.id === button.dataset.deleteMessage);
      if (message) Object.assign(message, { body: '', attachment_id: null, attachment_expired: false,
        deleted_at: result.deletedAt || Date.now(), deleted_by_me: true, delivery: undefined });
      dismiss(); $('#modal-body').replaceChildren(); clearMessageSelection(); renderMessages();
      await refresh(); toast('Message deleted for everyone.'); return;
    }
    if (button.dataset.filter) {
      state.filter = button.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === button)); renderList(); return;
    }
    if (button.dataset.disableUser) {
      const disabled = button.dataset.disabled === 'true';
      if (!confirm(`${disabled ? 'Disable this teammate and revoke their access' : 'Enable this teammate'}?`)) return;
      await api(`/api/users/${button.dataset.disableUser}`, { method: 'PATCH', body: JSON.stringify({ disabled }) }); return await showTeam();
    }
    if (button.dataset.resetUser) {
      modal('Reset teammate password', `<form id="reset-form" data-user-id="${button.dataset.resetUser}"><p class="modal-description">This revokes the teammate’s existing sessions and device notifications.</p><label class="field"><span>New password · at least 14 characters</span><input name="password" type="password" minlength="14" maxlength="200" autocomplete="new-password" required></label><div class="error form-error"></div><div class="modal-actions"><button class="primary" type="submit">Reset password</button></div></form>`); return;
    }
    switch (button.dataset.action) {
      case 'clear-message-selection': clearMessageSelection(); break;
      case 'close-modal': dismiss(); break;
      case 'back': state.media?.closeCamera(); if (state.recorder?.state === 'recording') throw new Error('Stop your recording first.'); state.roomId = null; renderChat(); break;
      case 'conversations': $('.layout').classList.remove('has-room'); break;
      case 'settings': showSettings(); break;
      case 'enable-push': await enablePush(); break;
      case 'test-push': toast((await post('/api/push/test')).message); break;
      case 'team': await showTeam(); break;
      case 'alerts': await showAlerts(); break;
      case 'clear-alerts': await post('/api/alerts/read'); dismiss(); await refresh(); break;
      case 'create-room': await createRoom(); break;
      case 'room-settings': await roomSettings(); break;
      case 'client-notes': { const room=selectedRoom(); modal(`${clientName(room)} · notes`, `<p class="note-content">${clientNotes(room) ? esc(clientNotes(room)) : 'No support notes have been added.'}</p>`); break; }
      case 'copy-link': await navigator.clipboard.writeText($('#client-link').textContent); toast('Private link copied.'); break;
      case 'rotate-link': if (confirm('Replace the client link? Their old link and sessions will stop working.')) { const result = await post(`/api/rooms/${state.roomId}/link`); showLink(result.link); } break;
      case 'revoke-link': if (confirm('Revoke all client access to this conversation? History stays saved.')) { await post(`/api/rooms/${state.roomId}/revoke`); dismiss(); toast('Client access revoked.'); } break;
      case 'toggle-room': await api(`/api/rooms/${state.roomId}`, { method: 'PATCH', body: JSON.stringify({ status: selectedRoom().status === 'open' ? 'closed' : 'open' }) }); dismiss(); await refresh(); renderChat(); break;
      case 'delete-room': if (confirm('Permanently delete this conversation and all its messages and files? This cannot be undone.')) { await api(`/api/rooms/${state.roomId}`, { method: 'DELETE' }); dismiss(); state.roomId = null; await refresh(); renderChat(); } break;
      case 'voice-call': await state.media?.call(state.roomId); break;
      case 'video-call': await state.media?.call(state.roomId, 'video'); break;
      case 'camera': await state.media?.camera(); break;
      case 'attach': $('#file-input').click(); break;
      case 'remove-file': {
        const form = $('#message-form'); if (form?.dataset.pendingId) removePendingMessage(form.dataset.pendingId);
        if (form) delete form.dataset.pendingId; state.file = null; $('#file-preview').classList.add('hidden'); break;
      }
      case 'retry-send': void sendPendingMessage(state.pendingMessages.find(message => message.id === button.dataset.pendingId)); break;
      case 'record': if(state.media?.active())throw new Error('Finish your call before recording a voice note.'); await record(); break;
      case 'earlier': if (state.messages.length) await loadMessages(state.roomId, state.messages[0].seq); break;
      case 'logout': if (!confirm('Sign out on this device? Its support notifications will stop.')) break;
        await post('/api/logout');
        if ('serviceWorker' in navigator) await (await navigator.serviceWorker.getRegistration())?.pushManager.getSubscription().then(sub => sub?.unsubscribe());
        dismiss(); history.replaceState(null, '', '/'); auth(); break;
      case 'add-agent': modal('Add a teammate', `<form id="agent-form"><label class="field"><span>Teammate name</span><input name="name" maxlength="80" required></label><label class="field"><span>Username</span><input name="username" pattern="[a-zA-Z0-9_.@-]{3,100}" autocomplete="off" required></label><label class="field"><span>Password · at least 14 characters</span><input name="password" type="password" minlength="14" maxlength="200" autocomplete="new-password" required></label><div class="error form-error"></div><div class="modal-actions"><button class="primary" type="submit">Add teammate</button></div></form>`); break;
      case 'password': modal('Change your password', `<form id="password-form"><label class="field"><span>Current password</span><input name="current" type="password" autocomplete="current-password" required></label><label class="field"><span>New password · at least 14 characters</span><input name="password" type="password" autocomplete="new-password" minlength="14" maxlength="200" required></label><div class="error form-error"></div><div class="modal-actions"><button class="primary" type="submit">Change password</button></div></form>`); break;
    }
  } catch (error) { toast(error.message); }
});
document.addEventListener('input', event => { if (event.target.id === 'room-search') { state.search = event.target.value; renderList(); } });
document.addEventListener('change', event => { if (event.target.id === 'file-input' && event.target.files[0]) { previewFile(event.target.files[0]); event.target.value = ''; } });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { clearMessageSelection(); return; }
  const message = event.target.closest?.('.message[data-selectable="true"]');
  if (message && (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) {
    event.preventDefault(); selectMessage(message.dataset.messageId); return;
  }
  if (event.target.id === 'message-input' && event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); if (!$('#send-button').disabled) $('#message-form').requestSubmit();
  }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden && state.me) void refresh(); });
window.addEventListener('online', () => { if (state.me) { startEvents(); void refresh(); } });
window.addEventListener('offline', () => connection(false));
window.addEventListener('beforeunload', event => {
  if (state.file || $('#message-input')?.value.trim() || state.recorder?.state === 'recording') { event.preventDefault(); event.returnValue = ''; }
});
// Reconcile missed SSE events after reconnect and keep waiting durations fresh.
setInterval(() => { if (!document.hidden && state.me) void refresh(); }, 30000);
void boot();
