#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// FIX THE DATES OF THE JOININGS-SHEETS IMPORT  (user request, 2026-10-17)
//
// Found by the date audit: the Manufacturing sheet holds dates in a MONTH-FIRST number format (m-d-yyyy, mm-dd-yy). The staff typed
// dd-mm-yyyy, Excel (US setting) read a day up to 12 as a month, so the cell stored the day and month SWAPPED
// (Dr.Amrutha: joined 12 Oct 2026 was stored as 10 Dec 2026, a date in the future). Two more rows carry a typed YEAR that contradicts their
// sheet. The parser (lib/joinings-2026-10-17/parse.js) is fixed; this script brings the data already imported in line with it.
//
// HOW: it re-reads the three workbooks with the FIXED parser and compares, for every imported row, with what the import wrote down
// ("Joined / joining date read as ...", "Interview date read as ..." in the row's follow-up). Only rows that differ are touched, and only
// a date field that still holds exactly the value the import wrote (a date somebody changed by hand afterwards is left as it is).
// WHAT CAN CHANGE for such a row: application joining date, joined-at, interview date (+ "completed" when it becomes usable), added-at;
// the import's own history steps and follow-up (dates + the two "read as" lines of its note); the candidate's added-at (if the import made
// it); the Joining & Drop record (joined on, guarantee window) and its history line. One audit line per corrected application.
// NOT touched: stages, names, recruiters, amounts, invoices; no notification, mail, WhatsApp, incentive or workflow is started.
//
//   node scripts/fix-import-dates-2026-10-17.js                          DRY RUN (default): reads a copy of the database, writes only reports
//   node scripts/fix-import-dates-2026-10-17.js --db <copy.db> --apply   really writes - on a COPY
//   node scripts/fix-import-dates-2026-10-17.js --apply --really-real    really writes into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/fix-import-dates-2026-10-17.js --undo <manifest.json> [--db ...] [--really-real]
//   --downloads <dir>  where the three workbooks are (default C:/Users/user/Downloads)   --out <dir>   reports + undo manifest
//   --backup-dir <dir> where the pre-change backup goes (default ~/.teamlink-backups/fix-dates-<stamp>)
// SAFETY: dry run by default; VACUUM INTO backup first; undo manifest (old values); one transaction; running it twice changes nothing.
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
const DOWNLOADS = val('--downloads', 'C:/Users/user/Downloads');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `fix-dates-2026-10-17-${STAMP}`)));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `fix-dates-${STAMP}`) : path.join(OUT, 'backup')));
const IMPORTER = 'Imported — Joinings sheets 2026-10-17';
const IMPORT_TODAY = '2026-10-17'; // the day the import ran (its "not in the future" test)
const RUN_TODAY = new Date().toISOString().slice(0, 10);

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this would change the REAL database (prisma/dev.db). It needs --really-real AND the environment variable TL_ALLOW_REAL_APPLY=1. Use --db <copy> to try it on a copy first.');
  process.exit(2);
}
if (APPLY && UNDO) { console.error('Use either --apply or --undo, not both.'); process.exit(2); }

process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.env.TL_JOININGS_DIR = DOWNLOADS;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const L = require('./lib/joinings-2026-10-17/ledger');
const parse = require('./lib/joinings-2026-10-17/parse');

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (name, cols, rows) => fs.writeFileSync(path.join(OUT, name), `\ufeff${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;
const at = (iso, hh = '09') => new Date(`${iso}T${hh}:00:00Z`);
const same = (a, b) => (a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b);
const dayN = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const addDays = (iso, n) => new Date((dayN(iso) + n) * 86400000).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const human = (iso) => `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const ISO = /\d{4}-\d{2}-\d{2}/;

async function vacuumInto(prisma, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlq(dest)}`);
}

// ------------------------------------------------------------------------------------------- PLAN
async function plan(prisma) {
  const parsed = parse.parseAll(DOWNLOADS);
  const rowById = new Map(parsed.rows.map((r) => [r.id, r]));
  const Lg = new L.Ledger();
  const rawUpdates = [];
  const fus = await prisma.applicationFollowUp.findMany({
    where: { createdByName: { startsWith: 'Imported — Joinings sheets' } },
  });
  const table = []; // the audit table
  const review = []; // suspicious dates that are NOT changed (a person has to decide)
  const counts = { rowsImported: fus.length, rowsChanged: 0, objectsChanged: {}, problem: {} };
  const bump = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };
  const seenApps = new Set();

  for (const fu of fus) {
    const m = /\[JNG ([A-Z0-9-]+:\d+)\]/.exec(fu.notes || '');
    const row = m ? rowById.get(m[1]) : null;
    if (!row) continue;
    const f = row.f;
    const noteJoin = (/Joined \/ joining date read as (\d{4}-\d{2}-\d{2})/.exec(fu.notes) || [])[1] || null;
    const noteIv = (/Interview date read as (\d{4}-\d{2}-\d{2})/.exec(fu.notes) || [])[1] || null;
    const oldWhen = fu.createdAt.toISOString().slice(0, 10);
    const newJoin = f.joinIso || null; const newIv = f.ivIso || null;
    const newWhen = f.joinIso || f.ivIso || f.schedIso || IMPORT_TODAY;
    const sheetCellText = (k) => { const L2 = row.sheetCfg.cols[k]; const c = L2 ? row.cells[L2] : null; return c ? (c.t === 'n' ? `${c.w || ''} (serial ${c.v}, format ${c.z || ''})` : String(c.v).replace(/\s+/g, ' ')) : ''; };

    // ---- review list: dates that look wrong and that this script does NOT change
    const flags = [];
    if (newJoin && newJoin > RUN_TODAY) flags.push('JOINING DATE IN THE FUTURE');
    if (newIv && newJoin && newIv > newJoin) flags.push('INTERVIEW AFTER JOINING');
    const shYear = (/(20\d\d)/.exec(row.sheetCfg.sheet) || [])[1];
    if (newJoin && shYear && /^EDU-20/.test(row.sheetCode) && newJoin.slice(0, 4) !== shYear) flags.push(`JOINING YEAR ${newJoin.slice(0, 4)} ON THE ${shYear} SHEET`);

    const changed = (noteJoin || null) !== newJoin || (noteIv || null) !== newIv || oldWhen !== newWhen;
    if (!changed) { if (flags.length) review.push({ appId: fu.applicationId, sheetRow: row.id, name: f.name, joinCell: sheetCellText('join'), ivCell: sheetCellText('iv'), join: newJoin || '', interview: newIv || '', flags: flags.join('; '), proposal: 'left as it is - a person has to decide' }); continue; }
    if (seenApps.has(fu.applicationId) && false) continue;
    seenApps.add(fu.applicationId);
    counts.rowsChanged += 1;
    const why = row.anomalies.filter((a) => /DAY_MONTH_SWAPPED|YEAR_TYPO/.test(a.code));
    const kind = why.some((a) => a.code === 'DATE_YEAR_TYPO') ? 'YEAR TYPED WRONG' : (why.length ? 'DAY AND MONTH SWAPPED (month-first cell)' : 'DATE DIFFERS');
    bump(counts.problem, kind);
    const fix = [];
    const touched = [];

    const app = await prisma.application.findUnique({ where: { id: fu.applicationId } });
    const cand = await prisma.candidate.findUnique({ where: { id: fu.candidateId } });
    const events = await prisma.applicationStageEvent.findMany({ where: { applicationId: fu.applicationId, actorName: IMPORTER } });
    const createdByImport = events.some((e) => e.fromStage === null);
    const note = (obj, model, id, set, label) => { Lg.update(model, id, set, obj); touched.push(label); bump(counts.objectsChanged, model); };

    if (app) {
      const set = {};
      if (noteJoin && newJoin && noteJoin !== newJoin && app.joiningDate === noteJoin) set.joiningDate = newJoin;
      if (noteJoin && newJoin && noteJoin !== newJoin && app.joinedAt && same(app.joinedAt, at(noteJoin))) set.joinedAt = at(newJoin);
      // the interview: the import wrote it only when it was not after the joining day and not in the future
      const oldOk = noteIv && (!noteJoin || noteIv <= noteJoin) && noteIv <= IMPORT_TODAY;
      const newOk = newIv && (!newJoin || newIv <= newJoin) && newIv <= RUN_TODAY;
      if (noteIv !== newIv || (noteJoin || null) !== newJoin) {
        if (app.interviewAt && noteIv && same(app.interviewAt, at(noteIv, '10')) && oldOk) {
          if (newOk) set.interviewAt = at(newIv, '10'); else { set.interviewAt = null; if (app.interviewStatus === 'COMPLETED') set.interviewStatus = null; }
        } else if (!app.interviewAt && !app.interviewStatus && newOk && !oldOk) { set.interviewAt = at(newIv, '10'); set.interviewStatus = 'COMPLETED'; }
      }
      if (createdByImport && same(app.createdAt, at(oldWhen)) && oldWhen !== newWhen) set.createdAt = at(newWhen);
      Object.keys(set).forEach((k) => { if (same(set[k], app[k])) delete set[k]; });
      if (Object.keys(set).length) { note(app, 'application', app.id, set, `application: ${Object.keys(set).join(', ')}`); fix.push(...Object.keys(set).map((k) => `application.${k}`)); }
    }
    for (const e of events) {
      const set = {};
      if (oldWhen !== newWhen) {
        if (same(e.createdAt, at(oldWhen))) set.createdAt = at(newWhen);
        else if (same(e.createdAt, at(oldWhen, '18'))) set.createdAt = at(newWhen, '18');
      }
      if (Object.keys(set).length) { note(e, 'applicationStageEvent', e.id, set, 'history step'); }
    }
    {
      const set = {};
      if (oldWhen !== newWhen) {
        if (same(fu.createdAt, at(oldWhen))) set.createdAt = at(newWhen);
        if (fu.lastContactedAt && same(fu.lastContactedAt, at(oldWhen))) set.lastContactedAt = at(newWhen);
        if (fu.completedAt && same(fu.completedAt, at(oldWhen, '18'))) set.completedAt = at(newWhen, '18');
      }
      let notes = fu.notes;
      if (noteJoin !== newJoin && newJoin) notes = notes.replace(/Joined \/ joining date read as \d{4}-\d{2}-\d{2}/, `Joined / joining date read as ${newJoin}`);
      if (noteIv !== newIv && newIv) {
        const newOkNote = newIv && (!newJoin || newIv <= newJoin) && newIv <= RUN_TODAY;
        notes = notes.replace(/Interview date read as \d{4}-\d{2}-\d{2}[^\n]*/, `Interview date read as ${newIv}${f.ivRepaired ? ` (${f.ivRepaired})` : ''}${newOkNote ? '' : ' - NOT used on the application (it is after the joining date)'}`);
      } else if (noteIv && newIv && noteJoin !== newJoin) {
        const newOkNote = newIv <= (newJoin || '9999') && newIv <= RUN_TODAY;
        notes = notes.replace(/(Interview date read as \d{4}-\d{2}-\d{2})( \([^)\n]*\))?( - NOT used on the application \(it is after the joining date\))?/, `$1$2${newOkNote ? '' : ' - NOT used on the application (it is after the joining date)'}`);
      }
      notes += `\nDates corrected on ${RUN_TODAY} (date audit): joining ${noteJoin || '-'} -> ${newJoin || '-'}; interview ${noteIv || '-'} -> ${newIv || '-'}. ${kind}.`;
      if (notes !== fu.notes) set.notes = notes;
      if (Object.keys(set).length) note(fu, 'applicationFollowUp', fu.id, set, 'follow-up note + dates');
    }
    if (cand && createdByImport && oldWhen !== newWhen && same(cand.createdAt, at(oldWhen))) note(cand, 'candidate', cand.id, { createdAt: at(newWhen) }, 'candidate added-at');
    // the Joining & Drop record and its history line (self-made tables, no Prisma model)
    if (noteJoin && newJoin && noteJoin !== newJoin) {
      const recs = await prisma.$queryRawUnsafe('SELECT * FROM "JoiningRecord" WHERE "applicationId" = ?', fu.applicationId).catch(() => []);
      for (const r of recs) {
        const set = {};
        if (r.joinedOn === noteJoin) set.joinedOn = newJoin;
        const delta = dayN(newJoin) - dayN(noteJoin);
        if (r.guaranteeStartOn === noteJoin) { set.guaranteeStartOn = newJoin; if (r.guaranteeEndsOn) set.guaranteeEndsOn = addDays(r.guaranteeEndsOn, delta); }
        if (Object.keys(set).length) {
          rawUpdates.push({ table: 'JoiningRecord', id: r.id, set, before: Object.fromEntries(Object.keys(set).map((k) => [k, r[k]])) });
          touched.push('Joining & Drop record'); bump(counts.objectsChanged, 'JoiningRecord');
        }
        const evs = await prisma.$queryRawUnsafe('SELECT "id","summary" FROM "JoiningEvent" WHERE "recordId" = ?', r.id).catch(() => []);
        for (const ev of evs) {
          if (String(ev.summary || '').includes(`joined on ${human(noteJoin)}`)) {
            rawUpdates.push({ table: 'JoiningEvent', id: ev.id, set: { summary: ev.summary.replace(`joined on ${human(noteJoin)}`, `joined on ${human(newJoin)}`) }, before: { summary: ev.summary } });
            bump(counts.objectsChanged, 'JoiningEvent');
          }
        }
      }
    }
    if (touched.length) {
      Lg.create('auditLog', { action: 'Dates corrected from the joinings sheet (date audit 2026-10-17)', entity: 'Application', entityId: fu.applicationId, fromValue: `joining ${noteJoin || '-'}; interview ${noteIv || '-'}`.slice(0, 300), toValue: `joining ${newJoin || '-'}; interview ${newIv || '-'} (${kind})`.slice(0, 300), actorName: IMPORTER });
    }
    table.push({
      appId: fu.applicationId, candidate: f.name, sheetRow: row.id, joinCell: sheetCellText('join'), interviewCell: sheetCellText('iv'),
      oldJoining: noteJoin || '', newJoining: newJoin || '', oldInterview: noteIv || '', newInterview: newIv || '', oldAdded: oldWhen, newAdded: newWhen,
      problem: kind, fix: touched.length ? [...new Set(touched)].join('; ') : 'nothing to change in the database (the application was not made by the import)',
    });
    if (flags.length) review.push({ appId: fu.applicationId, sheetRow: row.id, name: f.name, joinCell: sheetCellText('join'), ivCell: sheetCellText('iv'), join: newJoin || '', interview: newIv || '', flags: `${flags.join('; ')} (after the fix)`, proposal: 'left as it is - a person has to decide' });
  }
  return { Lg, rawUpdates, table, review, counts };
}

function reports(r) {
  fs.mkdirSync(OUT, { recursive: true });
  writeCsv('date-audit-table.csv', ['appId', 'candidate', 'sheetRow', 'joinCell', 'interviewCell', 'oldJoining', 'newJoining', 'oldInterview', 'newInterview', 'oldAdded', 'newAdded', 'problem', 'fix'], r.table);
  writeCsv('date-audit-review-not-changed.csv', ['appId', 'sheetRow', 'name', 'joinCell', 'ivCell', 'join', 'interview', 'flags', 'proposal'], r.review);
  const reviewKinds = {}; r.review.forEach((x) => x.flags.split('; ').forEach((fl) => { const k = fl.replace(/ \(after the fix\)/, '').replace(/JOINING YEAR \d{4} ON THE \d{4} SHEET/, 'JOINING YEAR DIFFERS FROM THE SHEET YEAR'); reviewKinds[k] = (reviewKinds[k] || 0) + 1; }));
  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, today: RUN_TODAY,
    importedRowsChecked: r.counts.rowsImported, rowsWithAWrongDate: r.counts.rowsChanged, byProblem: r.counts.problem,
    rowsChangedInTheDatabase: [...r.Lg.updates.values()].filter((u) => u.model === 'application').length,
    objectsChanged: r.counts.objectsChanged, rawUpdates: r.rawUpdates.length, ledger: r.Lg.counts(),
    reviewNotChanged: reviewKinds,
  };
  fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
  return summary;
}

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, r, summary) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  const lg = r.Lg;
  if (!lg.creates.length && !lg.updates.size && !r.rawUpdates.length) { console.log('NOTHING TO DO: every imported date already agrees with the sheets (no backup, nothing written).'); return null; }
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  console.log(`backup written: ${backup} (${(fs.statSync(backup).size / 1048576).toFixed(1)} MB)`);
  const manifest = { stamp: STAMP, database: dbArg, backup, status: 'planned', created: {}, updates: [...lg.updates.values()], rawUpdates: r.rawUpdates, summary };
  lg.creates.forEach((c) => { (manifest.created[c.model] = manifest.created[c.model] || []).push(c.id); });
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, L.serialise(manifest));
  try {
    await prisma.$transaction(async (tx) => {
      for (const u of lg.updates.values()) await tx[u.model].update({ where: { id: u.id }, data: u.set });
      for (const x of r.rawUpdates) {
        const cols = Object.keys(x.set);
        await tx.$executeRawUnsafe(`UPDATE "${x.table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => x.set[c]), x.id);
      }
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
  console.log(`UNDO of ${m.stamp}: ${m.updates.length} rows, ${(m.rawUpdates || []).length} module rows, ${(m.created.auditLog || []).length} audit rows`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  await vacuumInto(prisma, path.join(BACKUP_DIR, 'before-undo.db'));
  const out = { auditRowsRemoved: 0, restored: 0, restoredModule: 0, restoreSkipped: [] };
  await prisma.$transaction(async (tx) => {
    const ids = m.created.auditLog || [];
    for (let i = 0; i < ids.length; i += 400) out.auditRowsRemoved += (await tx.auditLog.deleteMany({ where: { id: { in: ids.slice(i, i + 400) } } })).count;
    for (const u of m.updates) {
      const cur = await tx[u.model].findUnique({ where: { id: u.id } });
      if (!cur) { out.restoreSkipped.push(`${u.model} ${u.id}: no longer exists`); continue; }
      const data = {};
      Object.keys(u.before).forEach((f) => {
        if (f === 'updatedAt' || JSON.stringify(cur[f]) === JSON.stringify(u.set[f])) data[f] = u.before[f];
        else out.restoreSkipped.push(`${u.model} ${u.id}.${f}: changed after the fix (now ${JSON.stringify(cur[f])}) - left as it is`);
      });
      if (Object.keys(data).length) { await tx[u.model].update({ where: { id: u.id }, data }); out.restored += 1; }
    }
    for (const x of (m.rawUpdates || [])) {
      const cols = Object.keys(x.before);
      await tx.$executeRawUnsafe(`UPDATE "${x.table}" SET ${cols.map((c) => `"${c}" = ?`).join(', ')} WHERE "id" = ?`, ...cols.map((c) => x.before[c]), x.id);
      out.restoredModule += 1;
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
      tmp = path.join(os.tmpdir(), `fixdates-dryrun-${Date.now()}.db`);
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
