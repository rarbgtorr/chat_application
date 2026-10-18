import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

export const id = () => randomBytes(18).toString('base64url');
export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(value) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(value, salt, 64).toString('hex');
}
export function passwordMatches(value, stored) {
  const [salt, key] = stored.split(':');
  return timingSafeEqual(scryptSync(value, salt, 64), Buffer.from(key, 'hex'));
}
export function openStore(directory) {
  mkdirSync(join(directory, 'uploads'), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(directory, 'chat.sqlite'));
  chmodSync(join(directory, 'chat.sqlite'), 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('admin','agent')), password TEXT NOT NULL,
      disabled INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'open'
        CHECK(status IN ('open','closed')), created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS client_private (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      name TEXT NOT NULL DEFAULT '', contact TEXT NOT NULL DEFAULT '', notes TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE IF NOT EXISTS assignments (
      room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(room_id,user_id)
    );
    CREATE TABLE IF NOT EXISTS client_keys (
      key_hash TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, created_at INTEGER NOT NULL,
      CHECK ((user_id IS NOT NULL) != (room_id IS NOT NULL))
    );
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      session_hash TEXT NOT NULL, filename TEXT NOT NULL, mime TEXT NOT NULL,
      size INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      sender_id TEXT NOT NULL, sender_role TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', attachment_id TEXT REFERENCES attachments(id),
      created_at INTEGER NOT NULL, nonce TEXT NOT NULL,
      UNIQUE(room_id,sender_id,nonce)
    );
    CREATE INDEX IF NOT EXISTS messages_room_seq ON messages(room_id,seq);
    CREATE TABLE IF NOT EXISTS read_markers (
      room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE, subject TEXT NOT NULL,
      seq INTEGER NOT NULL, PRIMARY KEY(room_id,subject)
    );
    CREATE TABLE IF NOT EXISTS cycles (
      room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
      first_message_id TEXT NOT NULL, first_at INTEGER NOT NULL,
      reminded_at INTEGER, escalated_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS subscriptions (
      endpoint TEXT PRIMARY KEY, session_hash TEXT NOT NULL REFERENCES sessions(token_hash) ON DELETE CASCADE,
      subscription TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, cycle_id TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL,
      seen INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS push_jobs (
      id TEXT PRIMARY KEY, endpoint TEXT NOT NULL REFERENCES subscriptions(endpoint) ON DELETE CASCADE,
      room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
      cycle_id TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL,
      next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_due ON push_jobs(next_at);
    CREATE TABLE IF NOT EXISTS file_deletions (
      id TEXT PRIMARY KEY
    );
  `);
  const run = (sql, ...params) => db.prepare(sql).run(...params);
  const get = (sql, ...params) => db.prepare(sql).get(...params);
  const all = (sql, ...params) => db.prepare(sql).all(...params);
  const transaction = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  return { db, run, get, all, transaction, close: () => db.close() };
}
