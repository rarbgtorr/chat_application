import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore, id, passwordHash } from '../server/store.js';

let values;
if (process.stdin.isTTY) {
  let mute = false;
  const output = new Writable({ write(chunk, encoding, done) { if (!mute) process.stdout.write(chunk, encoding); done(); } });
  const reader = createInterface({ input: process.stdin, output, terminal: true });
  const username = await reader.question('Admin username: ');
  const name = await reader.question('Display name: ');
  process.stdout.write('Password (14+ characters; hidden): '); mute = true;
  const password = await reader.question(''); mute = false; process.stdout.write('\n'); reader.close();
  values = { username, name, password };
} else {
  // For host automation, pass JSON through stdin rather than command-line arguments.
  let input = ''; for await (const chunk of process.stdin) input += chunk;
  try { values = JSON.parse(input); } catch { throw new Error('Expected admin JSON on stdin.'); }
}
const username = String(values.username || '').trim().toLowerCase();
const name = String(values.name || 'Administrator').trim().slice(0, 80);
if (!/^[a-z0-9_.@-]{3,100}$/.test(username)) throw new Error('Username must have 3–100 valid characters.');
if (typeof values.password !== 'string' || values.password.length < 14 || values.password.length > 200) throw new Error('Password must have 14–200 characters.');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const store = openStore(process.env.DATA_DIR || join(root, 'data'));
try {
  if (store.get('SELECT id FROM users WHERE username=?', username)) throw new Error('Username already exists. Use account settings to change its password.');
  store.run('INSERT INTO users(id,username,name,role,password) VALUES(?,?,?,?,?)', id(), username, name, 'admin', passwordHash(values.password));
  console.log('Administrator created. Sign in through the application.');
} finally { store.close(); }
