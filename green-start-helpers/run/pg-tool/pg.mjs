// TeamLink helper (NOT part of the Green Start zip). Runs a portable PostgreSQL 16 for Green Start from plain files:
// no Windows service, no installer. Data lives in green-start-app\run\pgdata. Port 5436, 127.0.0.1 only.
// The user, password and database name are read from gs-api\.env (DATABASE_URL), so there is one place for them.
// Keep this window open: closing it stops the database (the data stays).
import EmbeddedPostgres from 'embedded-postgres';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const envText = fs.readFileSync(path.resolve(here, '..', '..', 'gs-api', '.env'), 'utf8');
const m = /^DATABASE_URL="?([^"\r\n]+)"?/m.exec(envText);
if (!m) { console.error('DATABASE_URL is missing in gs-api\\.env'); process.exit(1); }
const u = new URL(m[1]);
const dataDir = path.resolve(here, '..', 'pgdata');
const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));

const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  port: Number(u.port) || 5436,
  persistent: true,
  // UTF8 on purpose: Windows would otherwise pick WIN1252 and the migrations (box-drawing characters in comments) fail
  initdbFlags: ['--encoding=UTF8', '--locale=C'],
  // small footprint: this computer has little free memory
  postgresFlags: ['-c', 'shared_buffers=24MB', '-c', 'max_connections=40', '-c', 'listen_addresses=127.0.0.1', '-c', 'fsync=on'],
  onLog: (l) => { if (/ERROR|FATAL|ready to accept/i.test(String(l))) console.log(String(l).trim()); },
  onError: (e) => console.error(String(e).trim()),
});

if (fresh) { console.log('First start: creating the database folder...'); await pg.initialise(); }
await pg.start();
const dbName = decodeURIComponent(u.pathname.replace(/^\//, ''));
if (fresh) { await pg.createDatabase(dbName); console.log(`Database "${dbName}" created.`); }
console.log(`Green Start database is running on 127.0.0.1:${u.port}. Leave this window open.`);

const stop = async () => { try { await pg.stop(); } catch { /* already stopped */ } process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
setInterval(() => {}, 1 << 30);
