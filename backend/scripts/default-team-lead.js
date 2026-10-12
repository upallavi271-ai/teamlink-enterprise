#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// GIVE JOBS THEIR DEPARTMENT'S ONE TEAM LEAD (user, 2026-10-09)
//
//   node scripts/default-team-lead.js                 DRY RUN: writes NOTHING, prints the table
//   node scripts/default-team-lead.js --md plan.md    dry run + a readable file
//   node scripts/default-team-lead.js --apply         backup first, then set the team lead + audit rows
//   node scripts/default-team-lead.js --undo <file>   take every team lead set by that run off again
//
//   --db <sqlite file>   another database (the sandbox copy). Default: .env DATABASE_URL.
//
// RULE (utils/defaultTeamLead.js): a job with NO team lead whose department has
// exactly ONE active recruiting team lead gets that team lead. Departments with
// several team leads (Education) or none (IT) are skipped — somebody picks.
// Jobs that already have a team lead are never touched. Open AND closed jobs
// are counted separately; both are set (so reports and the TL's history agree).
//
// SAFETY: --apply on the REAL database also needs --really-real; it makes a full
// backup first (utils/backup.js), writes in ONE transaction, writes one audit
// row per job ("Default team lead set"), and saves an undo file next to the
// backup. Test rows (ZZTEST / example.test) are never touched.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const BACKEND = path.resolve(__dirname, '..');
process.chdir(BACKEND);
require('dotenv').config({ path: path.join(BACKEND, '.env') });

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : null; };
const dbArg = opt('--db');
if (dbArg) process.env.DATABASE_URL = `file:${path.resolve(dbArg).replace(/\\/g, '/')}`;
const REAL_DB = path.resolve(BACKEND, 'prisma', 'dev.db').toLowerCase();
function dbFileNow() {
  const url = String(process.env.DATABASE_URL || 'file:./dev.db').trim().replace(/^["']|["']$/g, '').replace(/^file:/, '').replace(/[?#].*$/, '');
  return path.isAbsolute(url) ? path.resolve(url) : path.resolve(BACKEND, 'prisma', url);
}
const isRealDb = () => dbFileNow().toLowerCase() === REAL_DB;

// eslint-disable-next-line import/order
const prisma = require('../src/db');
const dtl = require('../src/utils/defaultTeamLead');
const { canonicalDepartment } = require('../src/utils/bdeDesk');

const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
const TEST_ROW = /zztest|example\.test/i;

async function plan() {
  await dtl.prime({ fresh: true });
  const dir = dtl.directory();
  const reqs = await prisma.requirement.findMany({
    where: { tlId: null },
    select: { id: true, reqCode: true, title: true, department: true, status: true, client: { select: { name: true } } },
  });
  const real = reqs.filter((r) => !TEST_ROW.test(`${r.title || ''} ${r.reqCode || ''} ${(r.client && r.client.name) || ''}`));
  const depts = new Map(); // canonical -> row
  const row = (k) => {
    if (!depts.has(k)) depts.set(k, { dept: k, tls: (dir.byDept.get(k) || []).map((t) => t.name), open: 0, closed: 0, ids: [], tl: null });
    return depts.get(k);
  };
  dir.byDept.forEach((_, k) => row(k));
  real.forEach((r) => {
    const k = canonicalDepartment(r.department) || '(no department)';
    const d = row(k);
    if (LIVE.includes(r.status)) d.open += 1; else d.closed += 1;
    d.ids.push(r.id);
  });
  const out = [...depts.values()].map((d) => {
    const single = dir.singles.get(d.dept) || null;
    return { ...d, tl: single, action: single ? 'SET' : (d.tls.length === 0 ? 'SKIP — no team lead' : 'SKIP — several team leads') };
  }).sort((a, b) => (b.open + b.closed) - (a.open + a.closed));
  return { out, noTlTotal: real.length, testSkipped: reqs.length - real.length };
}

function table(p) {
  const L = [];
  L.push('| Department | Team leads | Jobs with no TL: open | closed | What happens |');
  L.push('|---|---|---|---|---|');
  p.out.forEach((d) => {
    L.push(`| ${d.dept} | ${d.tls.length ? `${d.tls.length} (${d.tls.join(', ')})` : '0'} | ${d.open} | ${d.closed} | ${d.action === 'SET' ? `SET to ${d.tl.name}` : d.action} |`);
  });
  const set = p.out.filter((d) => d.action === 'SET');
  const skip = p.out.filter((d) => d.action !== 'SET');
  L.push('');
  L.push(`WOULD SET: ${set.reduce((n, d) => n + d.open + d.closed, 0)} jobs (${set.reduce((n, d) => n + d.open, 0)} open, ${set.reduce((n, d) => n + d.closed, 0)} closed). `
    + `SKIPPED: ${skip.reduce((n, d) => n + d.open + d.closed, 0)} jobs (${skip.reduce((n, d) => n + d.open, 0)} open, ${skip.reduce((n, d) => n + d.closed, 0)} closed). Jobs with no TL in total: ${p.noTlTotal}.`);
  return L.join('\n');
}

async function apply(p) {
  if (isRealDb() && !has('--really-real')) throw new Error('This is the REAL database. Run the dry run, get the table approved, then add --really-real.');
  // eslint-disable-next-line global-require
  const backup = require('../src/utils/backup');
  const b = await backup.makeBackup({ reason: 'before setting default team leads', by: 'default-team-lead.js', log: (m) => console.log(`[backup] ${m}`) });
  console.log(`Backup made: ${b.name}`);
  const undo = { at: new Date().toISOString(), db: dbFileNow(), backup: b.name, rows: [] };
  await prisma.$transaction(async (tx) => {
    for (const d of p.out.filter((x) => x.action === 'SET')) {
      for (let i = 0; i < d.ids.length; i += 400) {
        const ids = d.ids.slice(i, i + 400);
        // eslint-disable-next-line no-await-in-loop
        const r = await tx.requirement.updateMany({ where: { id: { in: ids }, tlId: null }, data: { tlId: d.tl.id, tl: d.tl.name } });
        if (r.count) {
          undo.rows.push(...ids.map((id) => ({ id, tlId: d.tl.id })));
          // eslint-disable-next-line no-await-in-loop
          await tx.auditLog.createMany({
            data: ids.map((id) => ({
              action: 'Default team lead set', entity: 'Requirement', entityId: id, toValue: d.tl.name,
              reason: `Automatic: ${d.dept} has one team lead (bulk, ${undo.at.slice(0, 10)})`, actorName: 'System',
            })),
          });
        }
      }
    }
  }, { timeout: 300000, maxWait: 30000 });
  const file = path.join(backup.backupRoot(), `default-tl-undo-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(file, JSON.stringify(undo));
  console.log(`Set the team lead on ${undo.rows.length} jobs.`);
  console.log(`To put them back:  node scripts/default-team-lead.js --undo "${file}"`);
}

async function undoRun(file) {
  if (isRealDb() && !has('--really-real')) throw new Error('This is the REAL database. Add --really-real to undo there.');
  const u = JSON.parse(fs.readFileSync(file, 'utf8'));
  let n = 0;
  await prisma.$transaction(async (tx) => {
    for (let i = 0; i < u.rows.length; i += 400) {
      const chunk = u.rows.slice(i, i + 400);
      for (const tlId of [...new Set(chunk.map((x) => x.tlId))]) {
        const ids = chunk.filter((x) => x.tlId === tlId).map((x) => x.id);
        // eslint-disable-next-line no-await-in-loop
        n += (await tx.requirement.updateMany({ where: { id: { in: ids }, tlId }, data: { tlId: null, tl: null } })).count;
        // eslint-disable-next-line no-await-in-loop
        await tx.auditLog.createMany({ data: ids.map((id) => ({ action: 'Default team lead removed (undo)', entity: 'Requirement', entityId: id, reason: 'Bulk undo', actorName: 'System' })) });
      }
    }
  }, { timeout: 300000, maxWait: 30000 });
  console.log(`Undone: ${n} jobs have no team lead again (only where the team lead was still the one that run set).`);
}

(async () => {
  console.log(`Database: ${dbFileNow()}${isRealDb() ? '  (REAL)' : ''}`);
  if (opt('--undo')) { await undoRun(opt('--undo')); return; }
  const p = await plan();
  if (has('--apply')) {
    console.log(table(p));
    await apply(p);
  } else {
    console.log('DRY RUN: nothing is written.\n');
    console.log(table(p));
    if (opt('--md')) { fs.writeFileSync(path.resolve(opt('--md')), `# Default team lead: DRY RUN (nothing written)\n\nDatabase: \`${dbFileNow()}\`\n\n${table(p)}\n`); console.log(`\nWritten to ${path.resolve(opt('--md'))}`); }
    console.log('\nTo write these: add --apply (after approval).');
  }
})().catch((e) => { console.error(`FAILED: ${e.message}`); process.exitCode = 1; }).finally(() => prisma.$disconnect());
