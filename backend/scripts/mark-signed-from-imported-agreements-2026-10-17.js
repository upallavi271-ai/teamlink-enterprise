#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// MARK CLIENTS SIGNED FROM THEIR IMPORTED SIGNED AGREEMENT  (user request, 2026-10-17)
//
// The joinings / agreements import attached the signed files (ClientDocument kind AGREEMENT_SIGNED + AppSetting
// "agrsigned.<id>") but did not touch the agreement STEP of the client, so the Clients page still counted them as
// "Unsigned Agreement". This script sets the step for those clients. It uses EXACTLY the way the earlier sheet imports
// (import-edu-fixes.js / import-medmfg-fixes.js) recorded an agreement signed on paper:
//     agreementStatus = 'ACTIVE'   agreementStart = the date (YYYY-MM-DD)   agreementSignedAt = agreementActivatedAt = that date, 00:00 UTC
// (Active is what the app's lifecycle needs to let the client's requirements go live; a signed paper has no e-sign seals to wait for.)
//
//   node scripts/mark-signed-from-imported-agreements-2026-10-17.js                      DRY RUN (default): reads a copy, writes only reports
//   node scripts/mark-signed-from-imported-agreements-2026-10-17.js --db <copy.db> --apply     really writes - on a COPY
//   node scripts/mark-signed-from-imported-agreements-2026-10-17.js --apply --really-real      really writes into prisma/dev.db
//                                                                                        (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/mark-signed-from-imported-agreements-2026-10-17.js --undo <manifest.json> [--db ...] [--really-real]
//   --out <dir>          where the reports / the undo manifest go
//   --backup-dir <dir>   where the pre-change backup goes (default ~/.teamlink-backups/mark-signed-<stamp>)
//   --include-sent       ALSO mark a client whose e-sign link is out (SENT / VIEWED / waiting) - default: left alone and listed
//
// WHO IS MARKED: a client whose agreement step is DRAFT (or empty) AND who holds at least one imported file that is a SIGNED AGREEMENT
// (not a confirmation picture, not a letter / challan flagged "not an agreement"). Clients already Signed / Active are not touched.
// Clients with no signed file are never touched (they are listed with their step for the founder to decide).
// THE DATE (never invented): 1. the date printed on the agreement (the most recent one when there are several),
//   2. else the day the file was uploaded to the Drive form, 3. else empty.
// WRITES: Client (status + 3 date fields) and ONE AuditLog row per client "Marked signed from imported signed agreement (import 2026-10-17)".
// NO notification, mail, SMS or WhatsApp; no parked job is opened; no incentive / workflow / invoice is touched. One transaction.
// SAFETY: dry run by default; the real database needs --apply --really-real AND TL_ALLOW_REAL_APPLY=1; VACUUM INTO backup first;
// undo manifest (old values); running it twice changes nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const UNDO = val('--undo');
const INCLUDE_SENT = has('--include-sent');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `mark-signed-2026-10-17-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `mark-signed-${STAMP}`) : path.join(OUT, 'backup')));
const WHO = 'Imported — signed agreements 2026-10-17';
const ACTION = 'Marked signed from imported signed agreement (import 2026-10-17)';

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const L = require('./lib/joinings-2026-10-17/ledger');

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (name, cols, rows) => fs.writeFileSync(path.join(OUT, name), `﻿${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;
const SIGNED = ['SIGNED', 'ACTIVE', 'CONFIRMED'];
const YMD = /^\d{4}-\d{2}-\d{2}$/;

async function vacuumInto(prisma, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlq(dest)}`);
}

// ------------------------------------------------------------------------------------------- PLAN
async function plan(prisma) {
  const clients = await prisma.client.findMany({
    select: { id: true, name: true, ownerDepartment: true, status: true, agreementStatus: true, agreementStart: true, agreementSignedAt: true, agreementActivatedAt: true },
  });
  const docs = await prisma.clientDocument.findMany({ where: { kind: 'AGREEMENT_SIGNED' }, select: { id: true, clientId: true, fileName: true } });
  const settings = await prisma.appSetting.findMany({ where: { key: { startsWith: 'agrsigned.' } }, select: { key: true, value: true } });
  const meta = new Map();
  settings.forEach((s) => { try { meta.set(s.key.slice('agrsigned.'.length), JSON.parse(s.value) || {}); } catch { /* ignore */ } });
  const filesBy = new Map();
  docs.forEach((d) => { if (!filesBy.has(d.clientId)) filesBy.set(d.clientId, []); filesBy.get(d.clientId).push({ ...d, meta: meta.get(d.id) || {} }); });
  const jobs = await prisma.requirement.groupBy({ by: ['clientId', 'status'], _count: true });
  const jobsBy = new Map();
  jobs.forEach((j) => { const o = jobsBy.get(j.clientId) || { total: 0, parked: 0, open: 0 }; o.total += j._count; if (['DRAFT', 'AGREEMENT_CHECK'].includes(j.status)) o.parked += j._count; if (['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'].includes(j.status)) o.open += j._count; jobsBy.set(j.clientId, o); });

  const Lg = new L.Ledger();
  const marked = []; const leftAlone = []; const noFile = []; const already = [];
  for (const c of clients) {
    const files = filesBy.get(c.id) || [];
    const j = jobsBy.get(c.id) || { total: 0, parked: 0, open: 0 };
    const base = { clientId: c.id, name: c.name, department: c.ownerDepartment || '', agreementStatus: c.agreementStatus || 'DRAFT', files: files.length, jobsTotal: j.total, jobsOpen: j.open, jobsWaiting: j.parked };
    if (SIGNED.includes(c.agreementStatus)) { already.push(base); if (!files.length) noFile.push({ ...base, why: 'already Signed / Active (set earlier from the sheets); no signed file was imported for this client' }); continue; }
    if (!files.length) { noFile.push({ ...base, why: 'no signed file was imported for this client' }); continue; }
    const real = files.filter((f) => f.meta.kind === 'Signed agreement' && !f.meta.notAgreement);
    if (!real.length) {
      const kinds = [...new Set(files.map((f) => (f.meta.notAgreement ? 'a paper that is not an agreement' : (f.meta.kind || 'file'))))].join(', ');
      leftAlone.push({ ...base, why: `only ${kinds} attached - no signed agreement document, so the step is left for you to decide` });
      continue;
    }
    if (!['DRAFT', null, undefined, ''].includes(c.agreementStatus) && !INCLUDE_SENT) {
      leftAlone.push({ ...base, why: `an e-sign agreement is in progress (${c.agreementStatus}) - not changed by default (re-run with --include-sent to include it)` });
      continue;
    }
    const printed = real.map((f) => f.meta.agreementDate).filter((d) => typeof d === 'string' && YMD.test(d)).sort();
    const uploaded = real.map((f) => String(f.meta.uploadedOn || '').slice(0, 10)).filter((d) => YMD.test(d)).sort();
    let date = null; let dateFrom = 'no date known - left empty';
    if (printed.length) { date = printed[printed.length - 1]; dateFrom = 'date printed on the agreement'; } else if (uploaded.length) { date = uploaded[uploaded.length - 1]; dateFrom = 'no date printed - the day the file was uploaded'; }
    const set = { agreementStatus: 'ACTIVE' };
    if (date) {
      const at = new Date(`${date}T00:00:00.000Z`);
      if (!c.agreementStart) set.agreementStart = date;
      if (!c.agreementSignedAt) set.agreementSignedAt = at;
      if (!c.agreementActivatedAt) set.agreementActivatedAt = at;
    }
    Lg.update('client', c.id, set, c);
    Lg.create('auditLog', { action: ACTION, entity: 'Client', entityId: c.id, fromValue: c.agreementStatus || 'DRAFT', toValue: `ACTIVE${date ? ` (signed ${date}: ${dateFrom})` : ' (no date known)'}`.slice(0, 300), actorName: WHO });
    marked.push({ ...base, newStatus: 'ACTIVE', signedDate: date || '', dateFrom, otherPrintedDates: printed.length > 1 ? printed.join(' ; ') : '' });
  }
  return { Lg, marked, leftAlone, noFile, already, clientsTotal: clients.length };
}

function reports(r) {
  fs.mkdirSync(OUT, { recursive: true });
  const cols = ['clientId', 'name', 'department', 'agreementStatus', 'files', 'jobsTotal', 'jobsOpen', 'jobsWaiting'];
  writeCsv('A-clients-marked-signed.csv', [...cols, 'newStatus', 'signedDate', 'dateFrom', 'otherPrintedDates'], r.marked);
  writeCsv('B-clients-with-a-file-left-alone.csv', [...cols, 'why'], r.leftAlone);
  writeCsv('C-clients-with-no-signed-file.csv', [...cols, 'why'], r.noFile);
  const stillUnsigned = r.noFile.filter((x) => !SIGNED.includes(x.agreementStatus)).length + r.leftAlone.length;
  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, includeSent: INCLUDE_SENT,
    clientsTotal: r.clientsTotal, alreadySignedOrActive: r.already.length,
    willBeMarkedSigned: r.marked.length, withDatePrinted: r.marked.filter((x) => x.dateFrom.startsWith('date printed')).length,
    withUploadDateOnly: r.marked.filter((x) => x.dateFrom.startsWith('no date printed')).length, withNoDate: r.marked.filter((x) => !x.signedDate).length,
    holdFileButLeftAlone: r.leftAlone.length, noSignedFileUntouched: r.noFile.filter((x) => !SIGNED.includes(x.agreementStatus)).length,
    unsignedBefore: r.clientsTotal - r.already.length, unsignedAfter: stillUnsigned,
    ledger: r.Lg.counts(),
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  return summary;
}

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, r, summary) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  const lg = r.Lg;
  if (!lg.creates.length && !lg.updates.size) { console.log('NOTHING TO DO: every client that holds an imported signed agreement is already Signed / Active (no backup, nothing written).'); return null; }
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  console.log(`backup written: ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
  const manifest = { stamp: STAMP, database: dbArg, backup, status: 'planned', created: {}, updates: [...lg.updates.values()], summary };
  lg.creates.forEach((c) => { (manifest.created[c.model] = manifest.created[c.model] || []).push(c.id); });
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, L.serialise(manifest));
  try {
    await prisma.$transaction(async (tx) => {
      for (const u of lg.updates.values()) await tx.client.update({ where: { id: u.id }, data: u.set });
      const rows = lg.orderedCreates().filter((c) => c.model === 'auditLog').map((c) => c.data);
      for (let i = 0; i < rows.length; i += 100) await tx.auditLog.createMany({ data: rows.slice(i, i + 100) });
    }, { timeout: 300000, maxWait: 60000 });
    manifest.status = 'committed';
    fs.writeFileSync(manifestPath, L.serialise(manifest));
  } catch (e) {
    manifest.status = 'failed'; manifest.error = String(e.message || e).slice(0, 600);
    fs.writeFileSync(manifestPath, L.serialise(manifest));
    throw e;
  }
  return manifestPath;
}

// ------------------------------------------------------------------------------------------- UNDO
async function undo(prisma) {
  const m = L.revive(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO of ${m.stamp}: ${m.updates.length} clients, ${(m.created.auditLog || []).length} audit rows`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  await vacuumInto(prisma, path.join(BACKUP_DIR, 'before-undo.db'));
  const out = { auditRowsRemoved: 0, restored: 0, restoreSkipped: [] };
  await prisma.$transaction(async (tx) => {
    const ids = (m.created.auditLog || []);
    for (let i = 0; i < ids.length; i += 400) out.auditRowsRemoved += (await tx.auditLog.deleteMany({ where: { id: { in: ids.slice(i, i + 400) } } })).count;
    for (const u of m.updates) {
      const cur = await tx.client.findUnique({ where: { id: u.id } });
      if (!cur) { out.restoreSkipped.push(`client ${u.id}: no longer exists`); continue; }
      const data = {};
      Object.keys(u.before).forEach((f) => {
        if (JSON.stringify(cur[f]) === JSON.stringify(u.set[f])) data[f] = u.before[f];
        else out.restoreSkipped.push(`client ${u.id}.${f}: changed after the import (now ${JSON.stringify(cur[f])}) - left as it is`);
      });
      if (Object.keys(data).length) { await tx.client.update({ where: { id: u.id }, data }); out.restored += 1; }
    }
  }, { timeout: 300000, maxWait: 60000 });
  console.log(JSON.stringify(out, null, 1));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    if (UNDO) { await undo(prisma); return; }
    let work = prisma; let tmp = null;
    if (!APPLY) {
      tmp = path.join(os.tmpdir(), `marksigned-dryrun-${Date.now()}.db`);
      await vacuumInto(prisma, tmp);
      work = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
    }
    const r = await plan(work);
    const summary = reports(r);
    console.log(JSON.stringify(summary, null, 1));
    console.log('reports in:', OUT);
    if (APPLY) {
      const done = await apply(prisma, r, summary);
      if (done) console.log('APPLIED. undo manifest:', done);
    } else {
      await work.$disconnect(); if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      console.log('DRY RUN - nothing was written to the database.');
    }
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
