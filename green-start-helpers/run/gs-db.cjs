// TeamLink helper (NOT part of the Green Start zip). Small, read-mostly tool for Green Start's OWN database (never TeamLink's).
//
//   node gs-db.cjs state                 prints one JSON line: { migrations, users, contacts }   (read only; used by the TeamLink supervisor)
//   node gs-db.cjs dump  <file.gz>       writes a full logical backup (every table, rows as JSON lines, gzip). Read only.
//   node gs-db.cjs restore <file.gz>     puts a backup into an EMPTY Green Start database (migrations already applied, no users yet).
//                                        Refuses when the database already has users, unless --force is given.
//
// Why a logical backup: the portable PostgreSQL here has no pg_dump. This uses only the `pg` package that Green Start itself ships
// with (gs-api\node_modules), so nothing is downloaded or installed. The database address comes from the DATABASE_URL environment
// variable, else from gs-api\.env (the same place pg.mjs and the product read it). Passwords are never printed.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');

const API = process.env.GS_API_DIR ? path.resolve(process.env.GS_API_DIR) : path.resolve(__dirname, '..', 'gs-api');
function databaseUrl() {
  let u = process.env.DATABASE_URL;
  if (!u) {
    const m = /^DATABASE_URL="?([^"\r\n]+)"?/m.exec(fs.readFileSync(path.join(API, '.env'), 'utf8'));
    if (!m) throw new Error('DATABASE_URL is missing (env or gs-api\\.env)');
    u = m[1];
  }
  return u.replace(/\?schema=.*$/, '');
}
const { Client } = require(path.join(API, 'node_modules', 'pg'));
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const CHUNK = 500;

async function tables(c) {
  const r = await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`);
  return r.rows.map((x) => x.table_name);
}
async function columns(c, t) {
  // generated columns (e.g. customers.customFieldSearch) cannot be written back; the database fills them again by itself
  const r = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND is_generated='NEVER' ORDER BY ordinal_position`, [t]);
  return r.rows.map((x) => x.column_name);
}
const tableExists = async (c, t) => (await c.query(`SELECT to_regclass($1) AS r`, [`public.${t}`])).rows[0].r !== null;

async function state() {
  const c = new Client({ connectionString: databaseUrl() });
  await c.connect();
  try {
    const out = { migrations: 0, users: 0, contacts: 0 };
    if (await tableExists(c, '_prisma_migrations')) out.migrations = Number((await c.query(`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`)).rows[0].n);
    if (await tableExists(c, 'users')) out.users = Number((await c.query(`SELECT count(*) AS n FROM users`)).rows[0].n);
    if (await tableExists(c, 'customers')) out.contacts = Number((await c.query(`SELECT count(*) AS n FROM customers`)).rows[0].n);
    console.log(JSON.stringify(out));
  } finally { await c.end(); }
}

async function dump(file) {
  if (!file) throw new Error('usage: gs-db.cjs dump <file>');
  const tmp = `${file}.part`;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const gz = zlib.createGzip({ level: 6 });
  const out = fs.createWriteStream(tmp);
  gz.pipe(out);
  const write = (obj) => new Promise((res) => { if (gz.write(`${JSON.stringify(obj)}\n`)) res(); else gz.once('drain', res); });
  const c = new Client({ connectionString: databaseUrl() });
  await c.connect();
  let rows = 0; let nTables = 0;
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); // one consistent picture of every table
    await write({ kind: 'header', app: 'green-start', format: 1, at: new Date().toISOString(), migrations: Number((await c.query(`SELECT count(*) AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL`)).rows[0].n) });
    for (const t of await tables(c)) {
      const cols = await columns(c, t);
      if (!cols.length) continue;
      nTables += 1;
      await write({ kind: 'table', name: t, columns: cols });
      const list = cols.map(q).join(', ');
      await c.query(`DECLARE gs_cur NO SCROLL CURSOR FOR SELECT row_to_json(x) AS j FROM (SELECT ${list} FROM ${q(t)}) x`);
      for (;;) {
        const r = await c.query(`FETCH ${CHUNK} FROM gs_cur`);
        if (!r.rows.length) break;
        await write({ kind: 'rows', name: t, rows: r.rows.map((x) => x.j) });
        rows += r.rows.length;
      }
      await c.query('CLOSE gs_cur');
    }
    await write({ kind: 'end', tables: nTables, rows });
    await c.query('COMMIT');
  } finally { await c.end(); }
  await new Promise((res, rej) => { out.on('finish', res); out.on('error', rej); gz.end(); });
  fs.renameSync(tmp, file);
  console.log(JSON.stringify({ ok: true, file, tables: nTables, rows, bytes: fs.statSync(file).size }));
}

async function restore(file, force) {
  if (!file || !fs.existsSync(file)) throw new Error('backup file not found');
  const c = new Client({ connectionString: databaseUrl() });
  await c.connect();
  try {
    const users = (await tableExists(c, 'users')) ? Number((await c.query(`SELECT count(*) AS n FROM users`)).rows[0].n) : -1;
    if (users < 0) throw new Error('This database has no tables yet. Apply the migrations first (prisma migrate deploy), then restore.');
    if (users > 0 && !force) throw new Error('This database already has users. Restore only into an empty Green Start database (or add --force if you are sure).');
    const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    let cols = []; let total = 0; let sawEnd = false;
    await c.query('BEGIN');
    await c.query(`SET LOCAL session_replication_role = 'replica'`); // rows are already consistent: skip foreign-key and identity-key triggers while loading
    for await (const line of rl) {
      if (!line.trim()) continue;
      const o = JSON.parse(line);
      if (o.kind === 'table') { cols = o.columns; if (force) await c.query(`TRUNCATE ${q(o.name)} CASCADE`); } else if (o.kind === 'rows') {
        const list = cols.map(q).join(', ');
        await c.query(`INSERT INTO ${q(o.name)} (${list}) SELECT ${list} FROM jsonb_populate_recordset(null::${q(o.name)}, $1::jsonb)`, [JSON.stringify(o.rows)]);
        total += o.rows.length;
      } else if (o.kind === 'end') sawEnd = true;
    }
    if (!sawEnd) throw new Error('The backup file is incomplete (no end marker). Nothing was restored.');
    await c.query('COMMIT');
    console.log(JSON.stringify({ ok: true, rows: total }));
  } catch (e) { try { await c.query('ROLLBACK'); } catch { /* closed */ } throw e; } finally { await c.end(); }
}

(async () => {
  const [cmd, arg, flag] = process.argv.slice(2);
  if (cmd === 'state') await state();
  else if (cmd === 'dump') await dump(arg);
  else if (cmd === 'restore') await restore(arg, flag === '--force' || arg === '--force');
  else { console.error('usage: gs-db.cjs state | dump <file> | restore <file> [--force]'); process.exit(2); }
})().catch((e) => { console.error(String(e && e.message ? e.message : e).replace(/postgres(ql)?:\/\/[^\s@]*@/gi, 'postgres://***@')); process.exit(1); });
