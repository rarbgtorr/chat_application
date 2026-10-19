import http from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import webpush from 'web-push';
import { openStore, id, secret, hash, passwordHash, passwordMatches } from './store.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const YEAR = 365 * 24 * 60 * 60;
const MAX_FILE = 25 * 1024 * 1024;
const allowedFiles = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.pdf': 'application/pdf', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.txt': 'text/plain', '.csv': 'text/csv',
};
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const ensure = (condition, status, message) => { if (!condition) throw new HttpError(status, message); };
const text = (value, max = 1000) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validPassword = value => typeof value === 'string' && value.length >= 14 && value.length <= 200;
async function body(req, limit = 64 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    ensure(size <= limit, 413, 'File or message is too large. Maximum attachment size is 25 MB.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req) {
  ensure(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'Expected JSON.');
  try { return JSON.parse((await body(req)).toString()); }
  catch (error) { if (error.status) throw error; throw new HttpError(400, 'Invalid JSON.'); }
}
function validPushEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.username && !u.password && !u.port &&
      (u.hostname === 'fcm.googleapis.com' || u.hostname === 'updates.push.services.mozilla.com' ||
        u.hostname.endsWith('.push.apple.com'));
  } catch { return false; }
}

export function createApp(options = {}) {
  const directory = options.directory || process.env.DATA_DIR || join(root, 'data');
  const origin = new URL(options.origin || process.env.APP_URL || 'http://localhost:3000').origin;
  const production = process.env.NODE_ENV === 'production';
  if (production && !origin.startsWith('https://')) throw new Error('Production APP_URL must use HTTPS.');
  const pushContact = options.pushContact || process.env.PUSH_CONTACT;
  if (production && !pushContact) throw new Error('Set PUSH_CONTACT to your mailto: contact for Web Push.');
  const store = openStore(directory);
  const { get, all, run, transaction } = store;
  const clock = options.clock || Date.now;
  const streams = new Set(); const rate = new Map();
  let busy = false, shuttingDown = false;
  const keyPath = join(directory, 'vapid.json');
  const vapid = existsSync(keyPath) ? JSON.parse(readFileSync(keyPath, 'utf8')) : webpush.generateVAPIDKeys();
  if (!existsSync(keyPath)) writeFileSync(keyPath, JSON.stringify(vapid), { mode: 0o600 });
  const pushReady = Boolean(pushContact || options.sendPush);
  const sendPush = options.sendPush || ((sub, payload) => webpush.sendNotification(sub, JSON.stringify(payload), {
    vapidDetails: { subject: pushContact, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
    urgency: 'high', TTL: 300, timeout: 10000,
  }));
  // No default password and no public signup. Bootstrap an admin only on a fresh database.
  if (!get('SELECT id FROM users LIMIT 1') && process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    ensure(validPassword(process.env.ADMIN_PASSWORD), 400, 'ADMIN_PASSWORD must have 14–200 characters.');
    run('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)', id(),
      process.env.ADMIN_USERNAME.toLowerCase(), 'Administrator', 'admin', passwordHash(process.env.ADMIN_PASSWORD));
  }
  function principal(tokenHash) {
    const session = get('SELECT * FROM sessions WHERE token_hash=?', tokenHash);
    if (!session) return null;
    if (session.user_id) {
      const user = get('SELECT id,username,name,role,disabled FROM users WHERE id=?', session.user_id);
      return user && !user.disabled ? { ...user, sessionHash: tokenHash } : null;
    }
    return get('SELECT id FROM rooms WHERE id=?', session.room_id)
      ? { id: session.room_id, roomId: session.room_id, role: 'client', name: 'Client', sessionHash: tokenHash } : null;
  }
  function canAccess(actor, roomId) {
    return actor && (actor.role === 'admin' || (actor.role === 'client' ? actor.roomId === roomId :
      Boolean(get('SELECT 1 FROM assignments WHERE room_id=? AND user_id=?', roomId, actor.id))));
  }
  function roomAccess(actor, roomId) {
    ensure(canAccess(actor, roomId), 404, 'Conversation not found.');
    const room = get('SELECT * FROM rooms WHERE id=?', roomId);
    ensure(room, 404, 'Conversation not found.'); return room;
  }
  function admin(actor) { ensure(actor?.role === 'admin', 403, 'Administrator access required.'); }
  function cookie(value, maxAge = YEAR) {
    return `wf_session=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
  }
  function session(res, userId, roomId) {
    const token = secret(); run('INSERT INTO sessions VALUES(?,?,?,?)', hash(token), userId, roomId, clock());
    res.setHeader('Set-Cookie', cookie(token)); return hash(token);
  }
  function limited(key, max, windowMs) {
    const now = clock(); const entry = rate.get(key);
    if (!entry || entry.until < now) { rate.set(key, { count: 1, until: now + windowMs }); return; }
    ensure(++entry.count <= max, 429, 'Too many attempts. Please try again later.');
  }
  function emit(roomId, event = 'change') {
    for (const stream of streams) {
      const actor = principal(stream.tokenHash);
      if (!actor) { stream.res.end(); continue; }
      // Events contain IDs only. Never broadcast private contact data or message bodies.
      if (!roomId || canAccess(actor, roomId)) stream.res.write(`event: ${event}\ndata: ${JSON.stringify({ roomId })}\n\n`);
    }
  }
  function notify({ userId = null, clientRoomId = null, roomId, kind, cycleId = null, title, message }) {
    if (userId) run('INSERT INTO alerts VALUES(?,?,?,?,?,?,?,0)', id(), roomId, userId, kind, cycleId, message, clock());
    const subs = userId
      ? all(`SELECT p.* FROM subscriptions p JOIN sessions s ON p.session_hash=s.token_hash WHERE s.user_id=?`, userId)
      : all(`SELECT p.* FROM subscriptions p JOIN sessions s ON p.session_hash=s.token_hash WHERE s.room_id=?`, clientRoomId);
    const payload = JSON.stringify({ title, body: message, url: clientRoomId ? `/c/${roomId}` : `/?room=${roomId}`,
      tag: `${roomId}-${kind}`, roomId, kind });
    for (const sub of subs) run('INSERT INTO push_jobs VALUES(?,?,?,?,?,?,?,?,?)', id(), sub.endpoint,
      roomId, cycleId, kind, payload, clock(), 0, clock() + 24 * 60 * 60 * 1000);
  }
  function agentIds(roomId) {
    return all(`SELECT u.id FROM users u JOIN assignments a ON a.user_id=u.id
      WHERE a.room_id=? AND u.disabled=0`, roomId).map(u => u.id);
  }
  function adminIds() { return all("SELECT id FROM users WHERE role='admin' AND disabled=0").map(u => u.id); }
  function recipientIds(roomId) { const assigned = agentIds(roomId); return assigned.length ? assigned : adminIds(); }
  function receiptState(roomId) {
    const recipients = new Set(recipientIds(roomId)); let delivered = 0; let read = 0;
    for (const marker of all('SELECT subject,seq FROM read_markers WHERE room_id=?', roomId)) {
      if (recipients.has(marker.subject)) read = Math.max(read, marker.seq);
      if (marker.subject.startsWith('delivered:') && recipients.has(marker.subject.slice(10))) delivered = Math.max(delivered, marker.seq);
    }
    return { delivered: Math.max(delivered, read), read };
  }
  function newMessage(actor, roomId, data) {
    const room = roomAccess(actor, roomId);
    ensure(room.status === 'open', 409, 'This conversation is closed. Ask the administrator to reopen it.');
    ensure(typeof data.nonce === 'string' && /^[\w-]{10,100}$/.test(data.nonce), 400, 'Missing message identifier.');
    const senderId = actor.role === 'client' ? roomId : actor.id;
    const previous = get('SELECT * FROM messages WHERE room_id=? AND sender_id=? AND nonce=?', roomId, senderId, data.nonce);
    if (previous) return previous;
    const value = text(data.body, 10000); const attachmentId = data.attachmentId || null;
    ensure(value || attachmentId, 400, 'Write a message or attach a file.');
    if (attachmentId) ensure(get('SELECT id FROM attachments WHERE id=? AND room_id=? AND session_hash=?',
      attachmentId, roomId, actor.sessionHash) && !get('SELECT id FROM messages WHERE attachment_id=?', attachmentId),
    400, 'Attachment not available. Please upload it again.');
    const messageId = id(); const now = clock();
    transaction(() => {
      run('INSERT INTO messages(id,room_id,sender_id,sender_role,body,attachment_id,created_at,nonce) VALUES(?,?,?,?,?,?,?,?)',
        messageId, roomId, senderId, actor.role, value, attachmentId, now, data.nonce);
      if (actor.role === 'client') {
        run('INSERT OR IGNORE INTO cycles(room_id,first_message_id,first_at) VALUES(?,?,?)', roomId, messageId, now);
        const recipients = agentIds(roomId);
        for (const userId of recipients.length ? recipients : adminIds()) notify({ userId, roomId, kind: 'message',
          title: `New message · ${room.code}`, message: 'A client sent a message or attachment.' });
      } else {
        const cycle = get('SELECT * FROM cycles WHERE room_id=?', roomId);
        if (cycle) {
          run('DELETE FROM push_jobs WHERE room_id=? AND cycle_id=?', roomId, cycle.first_message_id);
          run('UPDATE alerts SET seen=1 WHERE room_id=? AND cycle_id=?', roomId, cycle.first_message_id);
        }
        run('DELETE FROM cycles WHERE room_id=?', roomId);
        notify({ clientRoomId: roomId, roomId, kind: 'reply', title: 'Wingfactor Support replied',
          message: 'You have a new message in your support chat.' });
      }
    });
    emit(roomId); void tick(); return get('SELECT * FROM messages WHERE id=?', messageId);
  }
  function scheduleEscalations() {
    const now = clock();
    transaction(() => {
      for (const cycle of all("SELECT c.*,r.code FROM cycles c JOIN rooms r ON r.id=c.room_id WHERE r.status='open'")) {
        if (!cycle.reminded_at && now - cycle.first_at >= 5 * 60 * 1000) {
          for (const userId of agentIds(cycle.room_id)) notify({ userId, roomId: cycle.room_id, kind: 'reminder',
            cycleId: cycle.first_message_id, title: `Reply needed · ${cycle.code}`,
            message: 'This client has been waiting at least 5 minutes. Please reply.' });
          run('UPDATE cycles SET reminded_at=? WHERE room_id=?', now, cycle.room_id); emit(cycle.room_id, 'alert');
        }
        if (!cycle.escalated_at && now - cycle.first_at >= 10 * 60 * 1000) {
          for (const userId of adminIds()) notify({ userId, roomId: cycle.room_id, kind: 'escalation',
            cycleId: cycle.first_message_id, title: `Client waiting · ${cycle.code}`,
            message: 'No teammate reply for at least 10 minutes. Please check this conversation.' });
          run('UPDATE cycles SET escalated_at=? WHERE room_id=?', now, cycle.room_id); emit(cycle.room_id, 'alert');
        }
      }
    });
  }
  async function cleanupDeletedFiles() {
    for (const file of all('SELECT id FROM file_deletions LIMIT 100')) {
      try {
        await unlink(join(directory, 'uploads', file.id));
        run('DELETE FROM file_deletions WHERE id=?', file.id);
      } catch (error) {
        if (error.code === 'ENOENT') run('DELETE FROM file_deletions WHERE id=?', file.id);
        // Keep failed deletions durably queued for the next worker pass.
      }
    }
  }
  async function tick() {
    if (busy || shuttingDown) return;
    busy = true;
    try {
      await cleanupDeletedFiles();
      scheduleEscalations();
      run('DELETE FROM push_jobs WHERE expires_at<?', clock());
      if (!pushReady) return;
      const jobs = all(`SELECT j.*,s.subscription,s.session_hash FROM push_jobs j
        JOIN subscriptions s ON j.endpoint=s.endpoint WHERE j.next_at<=? ORDER BY j.next_at LIMIT 30`, clock());
      // Bounded parallel sends stop one slow device from holding up all other alerts.
      await Promise.all(jobs.map(async job => {
        if (!get('SELECT id FROM push_jobs WHERE id=?', job.id)) return;
        const actor = principal(job.session_hash);
        if (!actor || (job.room_id && !canAccess(actor, job.room_id))) { run('DELETE FROM push_jobs WHERE id=?', job.id); return; }
        try {
          await sendPush(JSON.parse(job.subscription), JSON.parse(job.payload));
          run('DELETE FROM push_jobs WHERE id=?', job.id);
        } catch (error) {
          if ([404, 410].includes(error.statusCode)) run('DELETE FROM subscriptions WHERE endpoint=?', job.endpoint);
          else run('UPDATE push_jobs SET attempts=attempts+1,next_at=? WHERE id=?',
            clock() + Math.min(5 * 60 * 1000, 1000 * 2 ** Math.min(job.attempts + 1, 8)), job.id);
        }
      }));
    } finally { busy = false; }
  }
  function roomSummary(actor, room) {
    const subject = actor.role === 'client' ? `client:${actor.roomId}` : actor.id;
    const marker = get('SELECT seq FROM read_markers WHERE room_id=? AND subject=?', room.id, subject)?.seq || 0;
    const last = get(`SELECT body,created_at,sender_role,attachment_id FROM messages WHERE room_id=? ORDER BY seq DESC LIMIT 1`, room.id);
    const unread = get(`SELECT COUNT(*) AS n FROM messages WHERE room_id=? AND seq>? AND
      ${actor.role === 'client' ? "sender_role!='client'" : "sender_role='client'"}`, room.id, marker).n;
    const result = { ...room, last: last ? { ...last, body: last.body || 'Attachment' } : null, unread,
      waitingSince: get('SELECT first_at FROM cycles WHERE room_id=?', room.id)?.first_at || null,
      agents: all(`SELECT u.id,u.name FROM users u JOIN assignments a ON a.user_id=u.id WHERE a.room_id=? AND u.disabled=0`, room.id) };
    if (actor.role !== 'client') {
      const details = get('SELECT name,contact,notes FROM client_private WHERE room_id=?', room.id);
      if (actor.role === 'admin') result.private = details;
      else result.client = { name: details?.name || '', notes: details?.notes || '' };
    }
    return result;
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Cache-Control', 'no-store');
    if (origin.startsWith('https:')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, origin); const path = url.pathname; const method = req.method;
      if (!['GET', 'HEAD'].includes(method)) ensure(req.headers.origin === origin, 403, 'Request origin not allowed.');
      if (path === '/healthz') return reply(200, { ok: true });
      if (!path.startsWith('/api/')) {
        ensure(method === 'GET' || method === 'HEAD', 405, 'Method not allowed.');
        const assets = { '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'],
          '/sw.js': ['sw.js', 'text/javascript'], '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
          '/icon.svg': ['icon.svg', 'image/svg+xml'] };
        const [file, mime] = assets[path] || ['index.html', 'text/html; charset=utf-8'];
        res.writeHead(200, { 'Content-Type': mime });
        return res.end(method === 'HEAD' ? undefined : await readFile(join(root, 'public', file)));
      }
      if (path === '/api/login' && method === 'POST') {
        const data = await jsonBody(req); const username = text(data.username, 100).toLowerCase();
        limited(`login-ip:${req.socket.remoteAddress}`, 100, 10 * 60 * 1000);
        limited(`login-user:${username}`, 10, 10 * 60 * 1000);
        ensure(typeof data.password === 'string' && data.password.length <= 200, 401, 'Incorrect username or password.');
        const user = get('SELECT * FROM users WHERE username=?', username);
        const dummy = passwordHash('dummy-password-for-timing');
        const matches = passwordMatches(data.password, user?.password || dummy);
        ensure(user && !user.disabled && matches, 401, 'Incorrect username or password.');
        session(res, user.id, null); return reply(200, { ok: true });
      }
      if (path === '/api/client/session' && method === 'POST') {
        limited(`client-login:${req.socket.remoteAddress}`, 100, 10 * 60 * 1000);
        const data = await jsonBody(req);
        ensure(typeof data.key === 'string' && data.key.length <= 100, 401, 'This support link is invalid or has been revoked.');
        const key = get('SELECT room_id FROM client_keys WHERE key_hash=?', hash(data.key));
        ensure(key, 401, 'This support link is invalid or has been revoked.');
        session(res, null, key.room_id); return reply(200, { roomId: key.room_id });
      }
      const rawCookie = /(?:^|;\s*)wf_session=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
      const actor = rawCookie ? principal(hash(rawCookie)) : null;
      ensure(actor, 401, 'Please sign in or open your private support link.');
      res.setHeader('Set-Cookie', cookie(rawCookie)); // Rolling browser persistence; no server-side inactivity timeout.
      if (path === '/api/me' && method === 'GET') return reply(200, {
        user: { id: actor.id, role: actor.role, name: actor.role === 'client' ? 'Client' : actor.name, roomId: actor.roomId },
        push: { enabled: pushReady, publicKey: vapid.publicKey,
          devices: get('SELECT COUNT(*) AS n FROM subscriptions WHERE session_hash=?', actor.sessionHash).n },
      });
      if (path === '/api/logout' && method === 'POST') {
        run('DELETE FROM sessions WHERE token_hash=?', actor.sessionHash);
        res.setHeader('Set-Cookie', cookie('', 0)); emit(null); return reply(200, { ok: true });
      }
      if (path === '/api/password' && method === 'POST') {
        ensure(actor.role !== 'client', 403, 'Staff only.');
        limited(`password:${actor.id}`, 8, 10 * 60 * 1000);
        const data = await jsonBody(req); const u = get('SELECT password FROM users WHERE id=?', actor.id);
        ensure(typeof data.current === 'string' && data.current.length <= 200 && passwordMatches(data.current, u.password), 403, 'Current password is incorrect.');
        ensure(validPassword(data.password), 400, 'Use a password with 14–200 characters.');
        transaction(() => {
          run('UPDATE users SET password=? WHERE id=?', passwordHash(data.password), actor.id);
          run('DELETE FROM sessions WHERE user_id=?', actor.id); session(res, actor.id, null);
        }); emit(null); return reply(200, { ok: true });
      }
      if (path === '/api/events' && method === 'GET') {
        ensure([...streams].filter(s => s.tokenHash === actor.sessionHash).length < 6, 429, 'Too many open chat tabs.');
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 2000\nevent: connected\ndata: {}\n\n');
        const stream = { tokenHash: actor.sessionHash, res }; streams.add(stream);
        const keepAlive = setInterval(() => {
          if (!principal(actor.sessionHash)) return res.end();
          res.write(': heartbeat\n\n');
        }, 20000);
        res.on('close', () => { clearInterval(keepAlive); streams.delete(stream); }); return;
      }
      if (path === '/api/users' && method === 'GET') {
        admin(actor); return reply(200, all('SELECT id,username,name,role,disabled FROM users ORDER BY name'));
      }
      if (path === '/api/users' && method === 'POST') {
        admin(actor); const data = await jsonBody(req); const username = text(data.username, 100).toLowerCase();
        ensure(/^[a-z0-9_.@-]{3,100}$/.test(username) && text(data.name, 80), 400, 'Enter a name and a valid username (at least 3 characters).');
        ensure(validPassword(data.password), 400, 'Use a password with 14–200 characters.');
        ensure(!get('SELECT id FROM users WHERE username=?', username), 409, 'That username already exists.');
        const userId = id();
        run('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)', userId, username, text(data.name, 80), 'agent', passwordHash(data.password));
        return reply(201, { id: userId });
      }
      const userMatch = /^\/api\/users\/([\w-]+)$/.exec(path);
      if (userMatch && method === 'PATCH') {
        admin(actor); const data = await jsonBody(req); const userId = userMatch[1];
        const target = get('SELECT * FROM users WHERE id=?', userId); ensure(target, 404, 'Teammate not found.');
        ensure(target.role !== 'admin', 403, 'Use your own password settings to update an administrator.');
        if (data.password !== undefined) ensure(validPassword(data.password), 400, 'Use a password with 14–200 characters.');
        transaction(() => {
          if (data.password) run('UPDATE users SET password=? WHERE id=?', passwordHash(data.password), userId);
          if (typeof data.disabled === 'boolean') run('UPDATE users SET disabled=? WHERE id=?', Number(data.disabled), userId);
          run('DELETE FROM sessions WHERE user_id=?', userId);
        }); emit(null); return reply(200, { ok: true });
      }
      if (path === '/api/delivered' && method === 'POST') {
        ensure(actor.role !== 'client', 403, 'Staff only.'); const data = await jsonBody(req);
        ensure(Array.isArray(data.roomIds) && data.roomIds.length <= 500 && data.roomIds.every(roomId => typeof roomId === 'string' && /^[\w-]{10,100}$/.test(roomId)), 400, 'Invalid conversations.');
        const changed = [];
        transaction(() => {
          for (const roomId of new Set(data.roomIds)) {
            const eligible = actor.role === 'agent'
              ? Boolean(get('SELECT 1 FROM assignments WHERE room_id=? AND user_id=?', roomId, actor.id))
              : agentIds(roomId).length === 0;
            if (!eligible) continue;
            const seq = get("SELECT MAX(seq) AS n FROM messages WHERE room_id=? AND sender_role='client'", roomId)?.n || 0;
            const subject = `delivered:${actor.id}`; const previous = get('SELECT seq FROM read_markers WHERE room_id=? AND subject=?', roomId, subject)?.seq || 0;
            if (seq > previous) {
              run('INSERT INTO read_markers VALUES(?,?,?) ON CONFLICT(room_id,subject) DO UPDATE SET seq=MAX(seq,excluded.seq)', roomId, subject, seq);
              changed.push(roomId);
            }
          }
        });
        changed.forEach(roomId => emit(roomId)); return reply(200, { ok: true });
      }
      if (path === '/api/rooms' && method === 'GET') {
        const rooms = actor.role === 'admin' ? all('SELECT * FROM rooms ORDER BY created_at DESC') : actor.role === 'client'
          ? all('SELECT * FROM rooms WHERE id=?', actor.roomId)
          : all('SELECT r.* FROM rooms r JOIN assignments a ON a.room_id=r.id WHERE a.user_id=? ORDER BY r.created_at DESC', actor.id);
        return reply(200, rooms.map(r => roomSummary(actor, r)));
      }
      if (path === '/api/rooms' && method === 'POST') {
        admin(actor); const data = await jsonBody(req); const roomId = id(); const key = secret();
        ensure(!data.agentIds || (Array.isArray(data.agentIds) && data.agentIds.length <= 50), 400, 'Invalid teammates.');
        const code = `Client #${secret().slice(0, 6).toUpperCase()}`;
        transaction(() => {
          run('INSERT INTO rooms(id,code,created_at) VALUES(?,?,?)', roomId, code, clock());
          run('INSERT INTO client_private VALUES(?,?,?,?)', roomId, text(data.name, 100), text(data.contact, 200), text(data.notes, 2000));
          run('INSERT INTO client_keys VALUES(?,?)', hash(key), roomId);
          for (const userId of [...new Set(data.agentIds || [])]) {
            ensure(get("SELECT id FROM users WHERE id=? AND role='agent' AND disabled=0", userId), 400, 'Choose an active teammate.');
            run('INSERT INTO assignments VALUES(?,?)', roomId, userId);
          }
        }); emit(roomId); return reply(201, { roomId, code, link: `${origin}/c/${roomId}#key=${key}` });
      }
      const roomMatch = /^\/api\/rooms\/([\w-]+)(?:\/(messages|read|upload|link|revoke))?$/.exec(path);
      if (roomMatch) {
        const roomId = roomMatch[1], action = roomMatch[2]; const room = roomAccess(actor, roomId);
        if (!action && method === 'PATCH') {
          admin(actor); const data = await jsonBody(req);
          transaction(() => {
            if (data.status !== undefined) {
              ensure(['open', 'closed'].includes(data.status), 400, 'Invalid conversation status.');
              run('UPDATE rooms SET status=? WHERE id=?', data.status, roomId);
              if (data.status === 'closed') {
                run('DELETE FROM cycles WHERE room_id=?', roomId);
                run("DELETE FROM push_jobs WHERE room_id=? AND kind IN ('reminder','escalation')", roomId);
              }
            }
            if (data.private) run('UPDATE client_private SET name=?,contact=?,notes=? WHERE room_id=?',
              text(data.private.name, 100), text(data.private.contact, 200), text(data.private.notes, 2000), roomId);
            if (data.agentIds) {
              ensure(Array.isArray(data.agentIds) && data.agentIds.length <= 50, 400, 'Invalid teammates.');
              const old = new Set(agentIds(roomId));
              run('DELETE FROM assignments WHERE room_id=?', roomId);
              for (const userId of [...new Set(data.agentIds)]) {
                ensure(get("SELECT id FROM users WHERE id=? AND role='agent' AND disabled=0", userId), 400, 'Choose an active teammate.');
                run('INSERT INTO assignments VALUES(?,?)', roomId, userId);
                if (!old.has(userId)) notify({ userId, roomId, kind: 'assigned', title: `Assigned · ${room.code}`,
                  message: 'A support conversation has been assigned to you.' });
              }
            }
          }); emit(null); return reply(200, { ok: true });
        }
        if (!action && method === 'DELETE') {
          admin(actor); const files = all('SELECT id FROM attachments WHERE room_id=?', roomId);
          transaction(() => {
            for (const file of files) run('INSERT OR IGNORE INTO file_deletions VALUES(?)', file.id);
            run('DELETE FROM messages WHERE room_id=?', roomId); run('DELETE FROM rooms WHERE id=?', roomId);
          });
          await cleanupDeletedFiles();
          emit(null); return reply(200, { ok: true });
        }
        if (['link', 'revoke'].includes(action) && method === 'POST') {
          admin(actor); const key = secret();
          transaction(() => {
            run('DELETE FROM client_keys WHERE room_id=?', roomId);
            run('DELETE FROM sessions WHERE room_id=?', roomId);
            if (action === 'link') run('INSERT INTO client_keys VALUES(?,?)', hash(key), roomId);
          }); emit(null); return reply(200, action === 'link' ? { link: `${origin}/c/${roomId}#key=${key}` } : { ok: true });
        }
        if (action === 'messages' && method === 'GET') {
          const before = Math.max(1, Number(url.searchParams.get('before')) || Number.MAX_SAFE_INTEGER);
          const rows = all(`SELECT m.seq,m.id,m.sender_role,m.sender_id,m.body,m.created_at,m.attachment_id,
            a.filename,a.mime,a.size FROM messages m LEFT JOIN attachments a ON a.id=m.attachment_id
            WHERE m.room_id=? AND m.seq<? ORDER BY m.seq DESC LIMIT 100`, roomId, before);
          // The display name is intentional; phone/email contact information is never joined here.
          const clientLabel = actor.role === 'client' ? room.code : get('SELECT name FROM client_private WHERE room_id=?', roomId)?.name || room.code;
          const receipts = actor.role === 'client' ? receiptState(roomId) : null;
          return reply(200, { messages: rows.reverse().map(m => ({ ...m,
            own: m.sender_id === (actor.role === 'client' ? roomId : actor.id),
            sender: m.sender_role === 'client' ? clientLabel : 'Wingfactor Support',
            ...(receipts && m.sender_role === 'client' ? { delivery: m.seq <= receipts.read ? 'read' : m.seq <= receipts.delivered ? 'delivered' : 'sent' } : {}),
          })), hasMore: rows.length === 100 });
        }
        if (action === 'messages' && method === 'POST') {
          limited(`message:${actor.sessionHash}`, 120, 60000);
          const message = newMessage(actor, roomId, await jsonBody(req));
          return reply(201, { id: message.id, seq: message.seq });
        }
        if (action === 'read' && method === 'POST') {
          const data = await jsonBody(req); const subject = actor.role === 'client' ? `client:${roomId}` : actor.id;
          const latest = get('SELECT MAX(seq) AS n FROM messages WHERE room_id=?', roomId).n || 0;
          const seq = Math.max(0, Math.min(latest, Number(data.seq) || 0)); const previous = get('SELECT seq FROM read_markers WHERE room_id=? AND subject=?', roomId, subject)?.seq || 0;
          run('INSERT INTO read_markers VALUES(?,?,?) ON CONFLICT(room_id,subject) DO UPDATE SET seq=MAX(seq,excluded.seq)', roomId, subject, seq);
          if (actor.role !== 'client') run("UPDATE alerts SET seen=1 WHERE room_id=? AND user_id=? AND kind IN ('message','assigned')", roomId, actor.id);
          if (actor.role !== 'client' && seq > previous) emit(roomId);
          return reply(200, { ok: true });
        }
        if (action === 'upload' && method === 'POST') {
          ensure(room.status === 'open', 409, 'Conversation is closed.');
          limited(`upload:${actor.sessionHash}`, 20, 60000);
          const filename = text(decodeURIComponent(req.headers['x-filename'] || ''), 200).replace(/[\r\n\x00-\x1f]/g, '').replace(/[\\/]/g, '_');
          const extension = extname(filename).toLowerCase();
          let mime = allowedFiles[extension];
          // MediaRecorder uses WebM for audio on Chromium.
          if (extension === '.webm' && req.headers['content-type']?.startsWith('audio/webm')) mime = 'audio/webm';
          ensure(mime, 415, 'Unsupported file. Use an image, video, audio, PDF, Word, TXT, or CSV file.');
          ensure(!req.headers['content-length'] || Number(req.headers['content-length']) <= MAX_FILE, 413, 'Maximum attachment size is 25 MB.');
          const bytes = await body(req, MAX_FILE); ensure(bytes.length, 400, 'Empty file.');
          // Recheck after the asynchronous upload in case access was revoked during transfer.
          ensure(principal(actor.sessionHash) && canAccess(principal(actor.sessionHash), roomId), 403, 'Access revoked.');
          ensure(get('SELECT status FROM rooms WHERE id=?', roomId)?.status === 'open', 409, 'Conversation is closed.');
          const attachmentId = id(); const filePath = join(directory, 'uploads', attachmentId);
          await writeFile(filePath, bytes, { mode: 0o600, flag: 'wx' });
          try { run('INSERT INTO attachments VALUES(?,?,?,?,?,?,?)', attachmentId, roomId, actor.sessionHash, filename, mime, bytes.length, clock()); }
          catch (error) { await unlink(filePath); throw error; }
          return reply(201, { attachmentId });
        }
      }
      const mediaMatch = /^\/api\/media\/([\w-]+)$/.exec(path);
      if (mediaMatch && method === 'GET') {
        const media = get('SELECT * FROM attachments WHERE id=?', mediaMatch[1]);
        ensure(media, 404, 'Attachment not found.'); roomAccess(actor, media.room_id);
        const inline = /^(image\/(jpeg|png|webp|gif)|audio\/|video\/)/.test(media.mime) && url.searchParams.get('download') !== '1';
        const bytes = await readFile(join(directory, 'uploads', media.id));
        const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
        let start = 0, end = bytes.length - 1;
        if (range) {
          start = Number(range[1]); end = Math.min(Number(range[2] || end), end);
          ensure(start <= end && start < bytes.length, 416, 'Invalid media range.');
          res.setHeader('Content-Range', `bytes ${start}-${end}/${bytes.length}`);
        }
        res.writeHead(range ? 206 : 200, { 'Content-Type': media.mime,
          'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes',
          'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(media.filename).replace(/'/g, '%27')}` });
        return res.end(bytes.subarray(start, end + 1));
      }
      if (path === '/api/alerts' && method === 'GET') {
        ensure(actor.role !== 'client', 403, 'Staff only.');
        return reply(200, all(`SELECT a.*,r.code FROM alerts a JOIN rooms r ON r.id=a.room_id
          WHERE a.user_id=? AND a.seen=0 ORDER BY a.created_at DESC LIMIT 100`, actor.id)
          .filter(a => canAccess(actor, a.room_id)));
      }
      if (path === '/api/alerts/read' && method === 'POST') {
        ensure(actor.role !== 'client', 403, 'Staff only.');
        run('UPDATE alerts SET seen=1 WHERE user_id=?', actor.id); return reply(200, { ok: true });
      }
      if (path === '/api/push' && method === 'POST') {
        ensure(pushReady, 503, 'Push is not configured on the server.');
        const data = await jsonBody(req); const sub = data.subscription;
        ensure(sub && validPushEndpoint(sub.endpoint) && typeof sub.keys?.auth === 'string' &&
          typeof sub.keys?.p256dh === 'string' && /^[\w-]{20,30}$/.test(sub.keys.auth) && /^[\w-]{80,100}$/.test(sub.keys.p256dh), 400, 'Invalid browser push subscription.');
        ensure(sub.endpoint.length <= 2048, 400, 'Invalid push endpoint.');
        const current = get('SELECT session_hash FROM subscriptions WHERE endpoint=?', sub.endpoint);
        if (current && current.session_hash !== actor.sessionHash) run('DELETE FROM subscriptions WHERE endpoint=?', sub.endpoint);
        run('INSERT INTO subscriptions VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET session_hash=excluded.session_hash,subscription=excluded.subscription',
          sub.endpoint, actor.sessionHash, JSON.stringify(sub), clock());
        return reply(200, { ok: true });
      }
      if (path === '/api/push/test' && method === 'POST') {
        ensure(pushReady, 503, 'Push is not configured on the server.');
        limited(`push-test:${actor.sessionHash}`, 5, 60000);
        const subs = all('SELECT * FROM subscriptions WHERE session_hash=?', actor.sessionHash);
        ensure(subs.length, 400, 'Enable notifications on this device first.');
        for (const sub of subs) run('INSERT INTO push_jobs VALUES(?,?,?,?,?,?,?,?,?)', id(), sub.endpoint,
          null, null, 'test', JSON.stringify({ title: 'Notifications are working', body: 'This device can receive support chat alerts.', url: '/', tag: 'test' }), clock(), 0, clock() + 60000);
        void tick(); return reply(200, { ok: true, message: 'Test queued. Confirm the notification appears on this device.' });
      }
      throw new HttpError(404, 'Not found.');
    } catch (error) {
      if (res.headersSent) return res.end();
      if (!error.status) console.error('Request failed:', error.code || error.name); // Never log tokens, bodies, or client identity.
      return reply(error.status || 500, { error: error.status ? error.message : 'Something went wrong. Please try again.' });
    }
  });
  server.requestTimeout = 120000;
  const interval = options.startWorker === false ? null : setInterval(() => { void tick().catch(() => console.error('Notification worker failed; will retry.')); }, 1000);
  const housekeeping = setInterval(() => {
    for (const [key, value] of rate) if (value.until < clock()) rate.delete(key);
  }, 60000); housekeeping.unref();
  return { server, store, tick, newMessage, origin,
    async close() {
      shuttingDown = true; clearInterval(interval); clearInterval(housekeeping);
      for (const stream of streams) stream.res.end();
      if (server.listening) await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
      while (busy) await new Promise(resolve => setTimeout(resolve, 10));
      store.close();
    },
  };
}
