/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// LOCAL ONLY (2026-10-27): remove the seeded demo data - every login but developer@tmlink.in, all demo employees and what hangs on
// them, the 4 demo clients, all candidates, demo accounts / HR records. KEEPS the 194 agreement clients (+ their requirements and
// agreement files) and the setup data (company, departments, teams, roles, leave types, holidays, ledger, templates, settings).
// Follows every foreign key: a child row goes with its parent, a KEPT row that points at a removed one gets that link cleared.
//   node remove-demo-data.js            DRY RUN (everything is done inside a transaction, then rolled back)
//   node remove-demo-data.js --apply    backup (VACUUM INTO) first, then the same, committed
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..', '..');
const APPLY = process.argv.includes('--apply');
const KEEP_LOGIN = 'developer@tmlink.in';
process.env.DATABASE_URL = `file:${path.join(BACK, 'prisma', 'dev.db').split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require(path.join(BACK, 'node_modules/@prisma/client'));
const prisma = new PrismaClient();
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const qi = (s) => `"${s.replace(/"/g, '""')}"`;

// Setup tables: never deleted (a link to a removed row is cleared instead).
const SETUP = new Set(['Company', 'Department', 'Team', 'DesignationRole', 'Role', 'LeaveType', 'LeaveReason', 'Holiday', 'ShiftPattern', 'HrConfig',
  'LedgerAccount', 'ExpenseCategory', 'DistPlatform', 'PortalMapping', 'WaTemplate', 'Integration', 'LoginIdCounter', 'StationeryItem', 'AuditLog', 'AppSetting']);
class Rollback extends Error {}

(async () => {
  const tables = (await prisma.$queryRawUnsafe("select name from sqlite_master where type='table' and name not like 'sqlite_%' and name not like '_prisma%'")).map((r) => r.name);
  const fks = []; const cols = {};
  for (const t of tables) {
    (await prisma.$queryRawUnsafe(`PRAGMA foreign_key_list(${qi(t)})`)).forEach((f) => fks.push({ child: t, from: f.from, parent: f.table, to: f.to || 'id', onDelete: f.on_delete }));
    cols[t] = new Map((await prisma.$queryRawUnsafe(`PRAGMA table_info(${qi(t)})`)).map((c) => [c.name, { notnull: !!num(c.notnull) }]));
  }
  const kids = (t) => fks.filter((f) => f.parent === t);
  const before = {};
  for (const t of tables) before[t] = num((await prisma.$queryRawUnsafe(`select count(*) n from ${qi(t)}`))[0].n);

  // the rows that must survive
  const keepClients = (await prisma.client.findMany({ where: { internalNotes: { contains: 'local import 2026-10-27' } }, select: { id: true } })).map((c) => c.id);
  if (keepClients.length !== 194) throw new Error(`expected 194 agreement clients, found ${keepClients.length} - stopping`);
  const keep = {
    Client: new Set(keepClients),
    Requirement: new Set((await prisma.requirement.findMany({ where: { clientId: { in: keepClients } }, select: { id: true } })).map((r) => r.id)),
    ClientDocument: new Set((await prisma.clientDocument.findMany({ where: { clientId: { in: keepClients } }, select: { id: true } })).map((r) => r.id)),
    User: new Set((await prisma.user.findMany({ where: { email: KEEP_LOGIN }, select: { id: true } })).map((u) => u.id)),
  };
  if (keep.User.size !== 1) throw new Error(`${KEEP_LOGIN} not found - stopping`);
  const isKept = (t, row) => SETUP.has(t) || (keep[t] && keep[t].has(row.id));

  const removed = {}; const cleared = {};
  const run = async (tx) => {
    const q = (s, ...a) => tx.$queryRawUnsafe(s, ...a);
    const x = (s, ...a) => tx.$executeRawUnsafe(s, ...a);
    const seen = new Set();
    // remove rows (by rowid) of table t, children first
    async function remove(t, rowids) {
      rowids = rowids.filter((r) => !seen.has(`${t}|${r}`));
      if (!rowids.length) return;
      rowids.forEach((r) => seen.add(`${t}|${r}`));
      for (let i = 0; i < rowids.length; i += 500) {
        const part = rowids.slice(i, i + 500); const inList = part.join(',');
        for (const f of kids(t)) {
          const vals = (await q(`select ${qi(f.to)} v from ${qi(t)} where rowid in (${inList})`)).map((r) => r.v).filter((v) => v != null);
          if (!vals.length) continue;
          const ph = vals.map(() => '?').join(',');
          const rows = await q(`select rowid rid, ${cols[f.child].has('id') ? 'id' : 'null'} id from ${qi(f.child)} where ${qi(f.from)} in (${ph})`, ...vals);
          const del = []; const nul = [];
          rows.forEach((r) => (isKept(f.child, r) || f.onDelete === 'SET NULL' ? nul : del).push(num(r.rid)));
          if (nul.length) {
            if (cols[f.child].get(f.from).notnull) throw new Error(`a KEPT ${f.child} row needs ${t} (${f.from} is required) - stopping, nothing changed`);
            await x(`update ${qi(f.child)} set ${qi(f.from)} = null where rowid in (${nul.join(',')})`);
            cleared[`${f.child}.${f.from}`] = (cleared[`${f.child}.${f.from}`] || 0) + nul.length;
          }
          if (del.length) await remove(f.child, del);
        }
        await x(`delete from ${qi(t)} where rowid in (${inList})`);
      }
      removed[t] = (removed[t] || 0) + rowids.length;
    }
    const rid = async (t, where = '1=1', ...a) => (await q(`select rowid rid from ${qi(t)} where ${where}`, ...a)).map((r) => num(r.rid));
    const keepCl = [...keep.Client].map((id) => `'${id}'`).join(',');
    // the demo roots
    await remove('Client', await rid('Client', `id not in (${keepCl})`));
    for (const t of ['Candidate', 'Invoice', 'BankTransaction', 'OfficeExpense', 'PayrollRun', 'Asset', 'Announcement', 'Survey', 'Project', 'Course', 'PolicyDocument', 'ProofReminderRun', 'Notification', 'Employee']) {
      if (tables.includes(t)) await remove(t, await rid(t));
    }
    await remove('User', await rid('User', 'email <> ?', KEEP_LOGIN));
    await x("delete from AppSetting where key like 'proofReminders.planned.%'");
    // safety: everything that must survive is still there
    const left = num((await q(`select count(*) n from Client where id in (${keepCl})`))[0].n);
    const docs = num((await q('select count(*) n from ClientDocument'))[0].n);
    const reqs = num((await q(`select count(*) n from Requirement where clientId in (${keepCl})`))[0].n);
    const sig = num((await q("select count(*) n from AppSetting where key like 'agrsigned.%'"))[0].n);
    if (left !== 194 || docs !== keep.ClientDocument.size || reqs !== keep.Requirement.size || sig !== before.AppSetting - 3) throw new Error(`safety check failed: clients ${left}, docs ${docs}, reqs ${reqs}, agrsigned ${sig}`);
    const fk = await q('PRAGMA foreign_key_check');
    if (fk.length) throw new Error(`foreign key check failed: ${JSON.stringify(fk.slice(0, 3), (k, v) => num(v))}`);
    if (!APPLY) throw new Rollback();
  };

  let bak = null;
  if (APPLY) {
    const dir = path.join(os.homedir(), '.teamlink-backups', `remove-demo-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    fs.mkdirSync(dir, { recursive: true });
    bak = path.join(dir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
  }
  try { await prisma.$transaction(run, { timeout: 300000, maxWait: 60000 }); } catch (e) { if (!(e instanceof Rollback)) throw e; }

  console.log(APPLY ? '=== REMOVED ===' : '=== DRY RUN (rolled back, nothing changed) ===');
  Object.entries(removed).sort((a, b) => b[1] - a[1]).forEach(([t, n]) => console.log(`  ${t.padEnd(28)} ${String(n).padStart(5)}  of ${before[t]}`));
  console.log('links cleared on kept rows:', JSON.stringify(cleared));
  if (APPLY) {
    const after = {};
    for (const t of tables) { const n = num((await prisma.$queryRawUnsafe(`select count(*) n from ${qi(t)}`))[0].n); if (n) after[t] = n; }
    console.log('\nleft in the database:', JSON.stringify(after));
    console.log(`\nBackup of the database before: ${bak}`);
  }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 1500)); process.exitCode = 1; }).finally(() => prisma.$disconnect());
