#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// FIX THE JOINING DATES THAT THE JOININGS SHEETS PROVE WRONG  (founder request, 2026-10-22)
//
// WHAT IT DOES
//   Reads the Medical / Education / Manufacturing joinings workbooks with the import's own reader (the month-first fix included), finds
//   every joined person whose application holds no joining day, or a day that is NOT the sheet's, and corrects ONLY the cases that are
//   provable:
//     rule EMPTY               the application has no joining day at all, the sheet gives one clear day;
//     rule IMPORT-WROTE-IT     the app's day is exactly what the 2026-10-17 import wrote (its history note says so) and the sheet reads
//                              differently now (day and month swapped in a month-first cell, a typed year that contradicts the sheet);
//     rule LEGACY-YEAR-AS-DAY  the app's day is the September conversion's slip: a month-only cell "June 2025" had been read as day 25 of
//                              2026 (2026-06-25) and this person's sheet rows give one clear day;
//     rule FOUNDER-LIST        only with --decisions <file.csv>: the founder wrote the day himself (column founderDay, with the appId).
//   A day somebody typed in the app (not the import's, not empty), or one that the sheet rows of the person disagree about, is NEVER
//   changed: it is listed in not-fixed-and-why.csv.
//
// WHAT IT CHANGES (per corrected application): application.joiningDate; application.joinedAt and the import's own "Joined" history step
//   ONLY when they still sit exactly on the day the import wrote; the Joining & Drop record's joined-on (+ guarantee window) and its history
//   line when they hold the old day; ONE audit-log line. The application's changed-at time moves (that is how the candidate list notices).
//   NOT touched: stages, names, recruiters, amounts, interview dates, invoices; no notification, mail, WhatsApp, incentive or workflow.
//
//   node scripts/fix-joining-dates-from-sheets-2026-10-22.js --out <dir>                          DRY RUN (default): reads a copy, writes the CSVs
//   node scripts/fix-joining-dates-from-sheets-2026-10-22.js --db <copy.db> --out <dir> --apply  really writes - on a COPY
//   node scripts/fix-joining-dates-from-sheets-2026-10-22.js --out <dir> --apply --really-real   into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/fix-joining-dates-from-sheets-2026-10-22.js --undo <undo-manifest.json> [--db ...] [--really-real]
//   options: --downloads <dir>  --decisions <csv>  --backup-dir <dir>  --allow-other-workbooks
// SAFETY: dry run by default; VACUUM backup first; undo manifest (old values); ONE transaction; running it twice changes nothing.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };

const BACK = path.resolve(__dirname, '..');
const DEV_DB = path.join(BACK, 'prisma', 'dev.db');
const dbArg = path.resolve(val('--db', DEV_DB));
const isReal = dbArg.toLowerCase() === DEV_DB.toLowerCase();
const APPLY = has('--apply');
const UNDO = val('--undo');
const DOWNLOADS = val('--downloads', 'C:/Users/user/Downloads');
const DECISIONS = val('--decisions');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `fix-joining-dates-2026-10-22-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `fix-joining-dates-${STAMP}`) : path.join(OUT, 'backup')));
const ACTOR = 'Joining date audit 2026-10-22';
const TODAY = new Date().toISOString().slice(0, 10);
// the two workbooks the audit was made on (SHA-256); the Manufacturing one is only recorded
const KNOWN = { 'med': 'F2558A4FAD9896B7499FA13D3BACCA967CD9029632BD2DDDC8A14F3EB249C15D', 'edu': 'E20473F8A3C16B4B3B164B6E127034E4CED33649AE7328152BD5EC1E6D513482' };

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.env.TL_JOININGS_DIR = DOWNLOADS;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const parse = require('./lib/joinings-2026-10-17/parse');
const LG = require('./lib/joinings-2026-10-17/ledger');
const JL = require('./lib/joining-dates-sheet-2026-10-22');
const FC = require('./lib/joining-fields-check-2026-10-22');

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (name, cols, rows) => fs.writeFileSync(path.join(OUT, name), `\ufeff${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex').toUpperCase();
const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);

async function vacuumInto(prisma, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlq(dest)}`);
}

// a day written by the founder: 2025-12-09 | 9/12/2025 | 9-12-2025 | 9 Dec 2025  (day first, like the sheets)
function founderDay(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const d = parse.datesIn(s); return d.length && d[0].iso ? d[0].iso : null; }
  const d = parse.datesIn(s);
  return d.length === 1 && d[0].iso ? d[0].iso : null;
}

// ------------------------------------------------------------------------------------------- PLAN
async function plan(prisma) {
  // the workbooks: which files are they?
  const files = Object.fromEntries(Object.entries(parse.FILES).map(([k, v]) => [k, path.join(DOWNLOADS, v.file)]));
  const hashes = {};
  for (const [k, f] of Object.entries(files)) { if (!fs.existsSync(f)) throw new Error(`workbook not found: ${f}`); hashes[k] = sha(f); }
  const wrong = Object.entries(KNOWN).filter(([k, h]) => hashes[k] !== h);
  if (wrong.length && !has('--allow-other-workbooks')) throw new Error(`The ${wrong.map(([k]) => k === 'med' ? 'Medical' : 'Education').join(' and ')} workbook is not the one the audit was made on (SHA-256 differs). Use --allow-other-workbooks only if you know why.`);
  const parsed = parse.parseAll(DOWNLOADS);
  const db = await JL.loadDb(prisma);
  const A = JL.analyse({ parsed, db });
  // humans: a change of the application after the import in the audit log
  const humanEdited = new Set();
  const ids = [...new Set(A.rows.map((r) => r.appId).filter(Boolean))];
  if (db.importedAt) {
    for (const part of JL.chunks(ids, 400)) {
      (await prisma.auditLog.findMany({ where: { entityId: { in: part }, createdAt: { gt: db.importedAt }, entity: { in: ['Application', 'application'] } }, select: { entityId: true, action: true, field: true, fromValue: true, toValue: true } }))
        .forEach((l) => { if (/join/i.test(`${l.action} ${l.field || ''} ${l.fromValue || ''} ${l.toValue || ''}`)) humanEdited.add(l.entityId); });
    }
  }
  // the import's own undo file (when it is at hand): did it write this typed day?
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(path.join(FC_APPLIED(), 'undo-manifest.json'), 'utf8')); } catch { manifest = null; }
  let importWroteTyped = null;
  if (manifest) {
    const created = new Set(manifest.created.application || []);
    const sets = new Map((manifest.updates || []).filter((u) => u.model === 'application').map((u) => [u.id, u.set || {}]));
    importWroteTyped = (appId, typed) => {
      if (sets.has(appId) && sets.get(appId).joiningDate === typed) return true;
      if (created.has(appId)) return true; // made by the import: every value on it came from a sheet row
      return false;
    };
  }
  const P = JL.planFixes(A, { today: TODAY, humanEdited, importWroteTyped });
  const fixes = P.fixes; const skipped = P.skipped;
  // the founder's own list
  const decisionsRejected = [];
  if (DECISIONS) {
    const list = FC.parseCsv(fs.readFileSync(path.resolve(DECISIONS), 'utf8'));
    const taken = new Set(fixes.map((x) => x.appId));
    for (const d of list) {
      const raw = String(d.founderDay || '').trim();
      if (!raw) continue;
      const appId = String(d.appId || '').trim();
      // "sheet" (or "yes") = take the day the sheet gives, from the column sheetDay of the same line
      const iso = /^(sheet|yes)$/i.test(raw) ? founderDay(d.sheetDay || '') : founderDay(raw);
      const app = db.apps.get(appId) || (await prisma.application.findUnique({ where: { id: appId }, select: { id: true, candidateId: true, requirementId: true, stage: true, joiningDate: true, joinedAt: true, joiningStatus: true, offerStatus: true, offeredCtc: true, offerNotes: true, interviewAt: true, interviewStatus: true, billingStatus: true, documentsStatus: true, createdAt: true, updatedAt: true } }));
      const who = d.candidate || d.name || '';
      if (!app) { decisionsRejected.push({ appId, candidate: who, founderDay: raw, why: 'no application with this id' }); continue; }
      if (!JL.isJoinedStage(app.stage)) { decisionsRejected.push({ appId, candidate: who, founderDay: raw, why: `the application is ${app.stage}, not Joined` }); continue; }
      if (!iso || iso < '2015-01-01' || iso > TODAY) { decisionsRejected.push({ appId, candidate: who, founderDay: raw, why: 'not a day between 2015 and today (write it as 2025-12-09 or 9/12/2025)' }); continue; }
      if (taken.has(appId)) { decisionsRejected.push({ appId, candidate: who, founderDay: raw, why: 'already corrected from the sheet in this run' }); continue; }
      if (!db.apps.has(appId)) { db.apps.set(appId, app); }
      const cur = JL.appDayOf(db, app);
      if (app.joiningDate === iso) continue;
      const cand = db.cands.get(app.candidateId) || (await prisma.candidate.findUnique({ where: { id: app.candidateId }, select: { name: true } })) || {};
      fixes.push({ appId, candidateId: app.candidateId, candidate: cand.name || who, client: d.client || '', rows: '(founder list)', evidence: `founder wrote "${raw}"`, old: cur.day || '', appTyped: app.joiningDate || '', new: iso, rule: 'FOUNDER-LIST', why: 'the day was written by the founder in the audit list', kind: '', changeTyped: true });
      taken.add(appId);
    }
  }
  // the surrounding rows (Joining & Drop records, the import's Joined step) for every fix
  const detail = new Map();
  for (const x of fixes) {
    const app = db.apps.get(x.appId);
    const oldNote = A.rows.filter((r) => r.appId === x.appId).map((r) => r.importNoteJoin).filter(Boolean);
    const oldDays = new Set([x.appTyped, ...oldNote, x.old].filter(Boolean));
    const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: x.appId, actorName: JL.IMPORTER, toStage: { in: JL.JOINED_STAGES } }, select: { id: true, createdAt: true } });
    const recs = await JL.rawRows(prisma, 'SELECT * FROM "JoiningRecord" WHERE "applicationId" = ?', x.appId);
    const evRows = [];
    for (const r of recs) evRows.push(...(await JL.rawRows(prisma, 'SELECT "id","summary" FROM "JoiningEvent" WHERE "recordId" = ?', r.id)));
    detail.set(x.appId, { app, oldDays, evs, recs, evRows });
  }
  return { parsed, db, A, fixes, skipped, humanEdited, decisionsRejected, hashes, detail, manifestUsed: !!manifest };
}
const FC_APPLIED = () => process.env.TL_JOININGS_APPLIED || 'C:/Users/user/Desktop/TeamLink-Joinings-Import-2026-10-17/applied';

// ---- what exactly will be written for each fix
function writes(r) {
  const out = { app: [], events: [], records: [], jevents: [], audit: [] };
  for (const x of r.fixes) {
    const d = r.detail.get(x.appId); const app = d.app;
    const setApp = { joiningDate: x.new }; const before = { joiningDate: app.joiningDate === undefined ? null : app.joiningDate };
    // joined-at / the import's Joined step: only when still exactly on a day the import wrote (09:00 UTC of that day)
    const oldImportDay = [...d.oldDays].find((day) => app.joinedAt && same(app.joinedAt, JL.at(day)));
    if (oldImportDay && x.rule !== 'EMPTY') { setApp.joinedAt = JL.at(x.new); before.joinedAt = app.joinedAt; }
    out.app.push({ id: x.appId, set: setApp, before, rule: x.rule });
    for (const e of d.evs) {
      const dayHit = [...d.oldDays].find((day) => same(e.createdAt, JL.at(day)) || same(e.createdAt, JL.at(day, '18')));
      if (dayHit && x.rule !== 'EMPTY') out.events.push({ id: e.id, set: { createdAt: same(e.createdAt, JL.at(dayHit)) ? JL.at(x.new) : JL.at(x.new, '18') }, before: { createdAt: e.createdAt } });
    }
    const oldJoin = x.appTyped || x.old;
    for (const rc of d.recs) {
      const set = {}; const before = {};
      if (!rc.joinedOn || (oldJoin && rc.joinedOn === oldJoin)) { set.joinedOn = x.new; before.joinedOn = rc.joinedOn || null; }
      if (oldJoin && rc.guaranteeStartOn === oldJoin) {
        const delta = JL.dayN(x.new) - JL.dayN(oldJoin);
        set.guaranteeStartOn = x.new; before.guaranteeStartOn = rc.guaranteeStartOn;
        if (rc.guaranteeEndsOn) { set.guaranteeEndsOn = JL.addDays(rc.guaranteeEndsOn, delta); before.guaranteeEndsOn = rc.guaranteeEndsOn; }
      }
      if (Object.keys(set).length) out.records.push({ table: 'JoiningRecord', id: rc.id, set, before });
      for (const ev of d.evRows) {
        if (oldJoin && String(ev.summary || '').includes(`joined on ${JL.human(oldJoin)}`)) out.jevents.push({ table: 'JoiningEvent', id: ev.id, set: { summary: ev.summary.replace(`joined on ${JL.human(oldJoin)}`, `joined on ${JL.human(x.new)}`) }, before: { summary: ev.summary } });
      }
    }
    out.audit.push({ id: LG.newId('jda'), action: 'Joining date corrected from the joinings sheet (2026-10-22)', entity: 'Application', entityId: x.appId, fromValue: `joining ${x.appTyped || '-'} (shown ${x.old || 'Not recorded'})`.slice(0, 300), toValue: `joining ${x.new} (${x.rule}; ${x.evidence})`.slice(0, 300), actorName: ACTOR });
  }
  return out;
}

function reports(r, w) {
  fs.mkdirSync(OUT, { recursive: true });
  writeCsv('intended-changes.csv', ['appId', 'candidate', 'client', 'old', 'appTyped', 'new', 'rule', 'rows', 'evidence', 'why'], r.fixes);
  writeCsv('not-fixed-and-why.csv', ['appId', 'candidate', 'client', 'old', 'appTyped', 'new', 'rows', 'evidence', 'why'], r.skipped);
  if (r.decisionsRejected.length) writeCsv('decisions-not-used.csv', ['appId', 'candidate', 'founderDay', 'why'], r.decisionsRejected);
  const byRule = {}; r.fixes.forEach((x) => { byRule[x.rule] = (byRule[x.rule] || 0) + 1; });
  const allJoined = [...r.db.apps.values()].filter((a) => JL.isJoinedStage(a.stage));
  const notRec = allJoined.filter((a) => !JL.appDayOf(r.db, a).day).length;
  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, today: TODAY, workbookSha256: r.hashes, importUndoFileUsed: r.manifestUsed,
    joinedApplications: allJoined.length, joinedWithoutAnyDay: notRec, rowsRead: r.A.rows.length,
    corrections: r.fixes.length, byRule, notFixed: r.skipped.length, decisionsNotUsed: r.decisionsRejected.length,
    changes: { applicationRows: w.app.length, joinedAtAlso: w.app.filter((x) => x.set.joinedAt).length, importJoinedSteps: w.events.length, joiningAndDropRecords: w.records.length, joiningAndDropHistoryLines: w.jevents.length, auditLines: w.audit.length },
    expectedAfter: { joinedWithoutAnyDay: notRec - r.fixes.filter((x) => !x.old).length },
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  return summary;
}

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, r, w, summary) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  if (!w.app.length) { console.log('NOTHING TO DO: every provable joining date already agrees with the sheets (no backup, nothing written).'); return null; }
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  console.log(`backup written: ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
  const manifest = { stamp: STAMP, database: dbArg, backup, status: 'planned', app: w.app, events: w.events, records: w.records, jevents: w.jevents, audit: w.audit.map((a) => a.id), summary };
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, LG.serialise(manifest));
  fs.writeFileSync(path.join(OUT, 'undo.cmd.txt'), `node scripts\\fix-joining-dates-from-sheets-2026-10-22.js --undo "${manifestPath}"${isReal ? ' --db "' + dbArg + '" --really-real   (and set TL_ALLOW_REAL_APPLY=1)' : ` --db "${dbArg}"`}\n`);
  try {
    await prisma.$transaction(async (tx) => {
      for (const a of w.app) await tx.application.update({ where: { id: a.id }, data: a.set });
      for (const e of w.events) await tx.applicationStageEvent.update({ where: { id: e.id }, data: e.set });
      for (const x of [...w.records, ...w.jevents]) {
        const cols = Object.keys(x.set);
        await tx.$executeRawUnsafe(`UPDATE "${x.table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => x.set[c]), x.id);
      }
      if (w.audit.length) await tx.auditLog.createMany({ data: w.audit });
    }, { timeout: 300000, maxWait: 60000 });
    manifest.status = 'committed';
    fs.writeFileSync(manifestPath, LG.serialise(manifest));
  } catch (e) {
    manifest.status = 'failed'; manifest.error = String(e.message || e).slice(0, 600);
    fs.writeFileSync(manifestPath, LG.serialise(manifest));
    throw e;
  }
  return manifestPath;
}

// ------------------------------------------------------------------------------------------- UNDO
async function undo(prisma) {
  const m = LG.revive(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO of ${m.stamp}: ${m.app.length} applications, ${m.events.length} history steps, ${m.records.length} Joining & Drop records, ${m.audit.length} audit lines`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  await vacuumInto(prisma, path.join(BACKUP_DIR, 'before-undo.db'));
  const out = { restored: 0, auditRemoved: 0, skipped: [] };
  await prisma.$transaction(async (tx) => {
    // a field is put back ONLY when it still holds what this fix wrote (a later change by a person stays). The changed-at time is left to
    // move forward on purpose: that is how the candidate list notices the change.
    for (const a of m.app) {
      const cur = await tx.application.findUnique({ where: { id: a.id } });
      if (!cur) { out.skipped.push(`application ${a.id}: gone`); continue; }
      const data = {};
      Object.keys(a.before).forEach((k) => { if (JSON.stringify(cur[k]) === JSON.stringify(a.set[k])) data[k] = a.before[k]; else out.skipped.push(`application ${a.id}.${k}: changed after the fix - left as it is`); });
      if (Object.keys(data).length) { await tx.application.update({ where: { id: a.id }, data }); out.restored += 1; }
    }
    for (const e of m.events) {
      const cur = await tx.applicationStageEvent.findUnique({ where: { id: e.id } });
      if (cur && same(cur.createdAt, e.set.createdAt)) { await tx.applicationStageEvent.update({ where: { id: e.id }, data: e.before }); out.restored += 1; } else out.skipped.push(`history step ${e.id}: changed after the fix - left as it is`);
    }
    for (const x of [...m.records, ...m.jevents]) {
      const cols = Object.keys(x.before);
      const cur = (await tx.$queryRawUnsafe(`SELECT ${Object.keys(x.set).map((c) => `"${c}"`).join(',')} FROM "${x.table}" WHERE "id" = ?`, x.id))[0];
      if (cur && Object.keys(x.set).every((c) => cur[c] === x.set[c])) { await tx.$executeRawUnsafe(`UPDATE "${x.table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => x.before[c]), x.id); out.restored += 1; } else out.skipped.push(`${x.table} ${x.id}: changed after the fix - left as it is`);
    }
    for (let i = 0; i < m.audit.length; i += 400) out.auditRemoved += (await tx.auditLog.deleteMany({ where: { id: { in: m.audit.slice(i, i + 400) } } })).count;
  }, { timeout: 300000, maxWait: 60000 });
  console.log(JSON.stringify(out, null, 1));
  return out;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    if (UNDO) { await undo(prisma); return; }
    let work = prisma; let tmp = null;
    if (!APPLY) {
      tmp = path.join(os.tmpdir(), `fixjoin-dryrun-${Date.now()}.db`);
      await vacuumInto(prisma, tmp);
      work = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
    }
    const r = await plan(work);
    const w = writes(r);
    const summary = reports(r, w);
    console.log(JSON.stringify(summary, null, 1));
    console.log('reports in:', OUT);
    if (APPLY) {
      const done = await apply(prisma, r, w, summary);
      if (done) console.log('APPLIED. undo manifest:', done);
    } else {
      await work.$disconnect(); if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      console.log('DRY RUN - nothing was written to the database.');
    }
  } finally { await prisma.$disconnect(); }
}

main().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
