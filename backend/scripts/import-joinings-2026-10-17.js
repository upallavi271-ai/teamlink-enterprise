#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// JOININGS + SIGNED AGREEMENTS IMPORT - 2026-10-17
//
//   node scripts/import-joinings-2026-10-17.js [options]                         DRY RUN (default): reads, plans, writes reports, changes nothing
//   node scripts/import-joinings-2026-10-17.js --db <copy.db> --apply            really writes - on a COPY of the database
//   node scripts/import-joinings-2026-10-17.js --apply --really-real             really writes into prisma/dev.db (also needs env TL_ALLOW_REAL_APPLY=1)
//   node scripts/import-joinings-2026-10-17.js --undo <manifest.json> [--db ...] [--really-real]   takes back exactly what an --apply wrote
//
// Options
//   --db <file>        database to use (default prisma/dev.db). A dry run reads a VACUUM copy of it, so the database itself is only read.
//   --zip-dir <dir>    the EXTRACTED agreements zip ("All Signed Agreements (File responses)") - needed for the file part
//   --downloads <dir>  where the three joinings workbooks are (default C:/Users/user/Downloads)
//   --out <dir>        where the reports / manifest go (default <scratch>/import-joinings-2026-10-17-<stamp>)
//   --only agreements|joinings   run one part only (default both)
//   --uploads <dir>    the app's uploads folder (default ~/.teamlink-uploads, or env UPLOAD_DIR)
//   --backup-dir <dir> where the pre-import backup goes (default ~/.teamlink-backups/import-joinings-<stamp>)
//
// WHAT IT DOES (phases, one database transaction for all of them):
//   A  official client names from the signed agreements (old names kept as aliases) + the signed agreement files (viewable in the app)
//   B  every row of the Medical / Education / Manufacturing joinings workbooks: candidates, jobs, applications, history, invoice links
// WHAT IT NEVER DOES: delete anything, send a message / e-mail / WhatsApp, raise an invoice or a payment, change a seat, run any
// workflow / incentive / notification hook (it writes the tables directly), or touch a row it was not told about.
// IDEMPOTENT: every imported row leaves a marker; running again changes nothing.
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
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `import-joinings-2026-10-17-${STAMP}`)));
const ONLY = val('--only', 'all');
const ZIP_DIR = val('--zip-dir');
const DOWNLOADS = val('--downloads', 'C:/Users/user/Downloads');
const UPLOADS = path.resolve(val('--uploads', process.env.UPLOAD_DIR || path.join(os.homedir(), '.teamlink-uploads')));
const BACKUP_DIR = path.resolve(val('--backup-dir', isReal ? path.join(os.homedir(), '.teamlink-backups', `import-joinings-${STAMP}`) : path.join(OUT, 'backup')));

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
const { load } = require('./lib/joinings-2026-10-17/state');
const AG = require('./lib/joinings-2026-10-17/agreements');
const PJ = require('./lib/joinings-2026-10-17/plan-joinings');
const { planDenorm } = require('./lib/joinings-2026-10-17/denorm');
const { planDropRecords } = require('./lib/joinings-2026-10-17/joindrop');

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' ⏎ '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (name, cols, rows) => {
  fs.writeFileSync(path.join(OUT, name), `\ufeff${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
};
const writeJson = (name, obj) => fs.writeFileSync(path.join(OUT, name), L.serialise(obj));
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;

async function vacuumInto(prisma, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) fs.unlinkSync(dest);
  await prisma.$executeRawUnsafe(`VACUUM INTO ${sqlq(dest)}`);
}

// ------------------------------------------------------------------------------------------- UNDO
async function undo(prisma) {
  const m = L.revive(fs.readFileSync(UNDO, 'utf8'));
  console.log(`UNDO of ${m.stamp} (${m.counts.creates} rows created, ${m.counts.updates} rows changed, ${m.counts.denorm || 0} name copies, ${m.files.length} files)`);
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  const backup = path.join(BACKUP_DIR, 'before-undo.db');
  await vacuumInto(prisma, backup);
  console.log('backup before the undo:', backup);
  const out = { deleted: {}, restored: 0, restoreSkipped: [] };
  await prisma.$transaction(async (tx) => {
    for (const table of ['JoiningEvent', 'JoiningRecord']) {
      const ids = (m.rawCreated || {})[table] || [];
      for (let i = 0; i < ids.length; i += 400) { const part = ids.slice(i, i + 400); await tx.$executeRawUnsafe(`DELETE FROM "${table}" WHERE "id" IN (${part.map(() => '?').join(',')})`, ...part); }
      if (ids.length) out.deleted[table] = ids.length;
    }
    const order = Object.keys(L.RANK).sort((a, b) => L.RANK[b] - L.RANK[a]);
    for (const model of order) {
      const ids = m.created[model] || [];
      if (!ids.length) continue;
      const pk = L.PK[model] || 'id';
      for (let i = 0; i < ids.length; i += 400) {
        const r = await tx[model].deleteMany({ where: { [pk]: { in: ids.slice(i, i + 400) } } });
        out.deleted[model] = (out.deleted[model] || 0) + r.count;
      }
    }
    for (const d of (m.denorm || [])) {
      const cur = await tx.$queryRawUnsafe(`SELECT "${d.column}" AS v FROM "${d.table}" WHERE "id" = ?`, d.id);
      if (cur[0] && cur[0].v === d.after) { await tx.$executeRawUnsafe(`UPDATE "${d.table}" SET "${d.column}" = ? WHERE "id" = ?`, d.before, d.id); out.restored += 1; } else out.restoreSkipped.push(`${d.table} ${d.id}.${d.column}: changed after the import - left as it is`);
    }
    for (const u of m.updates) {
      const pk = L.PK[u.model] || 'id';
      const cur = await tx[u.model].findUnique({ where: { [pk]: u.id } });
      if (!cur) { out.restoreSkipped.push(`${u.model} ${u.id}: row no longer exists`); continue; }
      const data = {};
      Object.keys(u.before).forEach((f) => {
        const same = f === 'updatedAt' || JSON.stringify(cur[f]) === JSON.stringify(u.set[f]);
        if (same) data[f] = u.before[f]; else out.restoreSkipped.push(`${u.model} ${u.id}.${f}: changed after the import (now ${JSON.stringify(cur[f])}) - left as it is`);
      });
      if (Object.keys(data).length) { await tx[u.model].update({ where: { [pk]: u.id }, data }); out.restored += 1; }
    }
  }, { timeout: 600000, maxWait: 60000 });
  let removed = 0;
  m.files.forEach((fp) => { try { if (fs.existsSync(fp)) { fs.unlinkSync(fp); removed += 1; } } catch (e) { out.restoreSkipped.push(`file ${fp}: ${e.message}`); } });
  out.filesRemoved = removed;
  console.log(JSON.stringify(out, null, 1));
}

// ------------------------------------------------------------------------------------------- PLAN
async function plan(prisma) {
  const S = await load(prisma);
  const Lg = new L.Ledger();
  const result = { S, L: Lg };
  const parsed = parse.parseAll(DOWNLOADS);
  result.parsed = parsed;
  const pack = JSON.parse(fs.readFileSync(path.join(__dirname, 'lib', 'joinings-2026-10-17', 'agreements-pack.json'), 'utf8'));
  const problems = PJ.prepareClientRules(S, pack.renames);
  result.ruleProblems = problems;
  if (ONLY === 'all' || ONLY === 'agreements') {
    result.renames = AG.planRenames({ S, L: Lg, pack });
    result.denorm = await planDenorm({ prisma, renamed: result.renames.filter((x) => x.applied).map((x) => ({ id: x.clientId, oldName: x.current, newName: x.official })) });
    if (ZIP_DIR) result.files = AG.planFiles({ S, L: Lg, pack, zipDir: path.resolve(ZIP_DIR), uploadsDir: UPLOADS, readFiles: true });
    else console.log('(no --zip-dir: the signed agreement FILES are not planned, only the names)');
  }
  if (ONLY === 'all' || ONLY === 'joinings') {
    result.joinings = PJ.planJoinings({ S, L: Lg, parsed });
    result.drops = await planDropRecords({ prisma, L: Lg, leftApps: result.joinings.leftApps });
  }
  return result;
}

function reports(r) {
  fs.mkdirSync(OUT, { recursive: true });
  const { parsed } = r;
  // every cell of every row (the audit inventory)
  writeCsv('01-inventory-every-cell.csv', ['sheetCode', 'sheet', 'row', 'hidden', 'col', 'header', 'value'], parsed.inventory);
  if (r.joinings) {
    const J = r.joinings;
    writeCsv('02-reconciliation-every-row.csv', ['id', 'sheet', 'row', 'name', 'phone', 'action', 'candidateId', 'applicationId', 'clientId', 'interpretation', 'detail'], J.rows);
    const tot = {};
    J.rows.forEach((x) => { const k = x.sheetCode; tot[k] = tot[k] || { sheet: x.sheet, rows: 0, CREATED: 0, ENRICHED: 0, SKIPPED: 0, SKIPPED_DUPLICATE: 0, NEEDS_DECISION: 0, ALREADY_IMPORTED: 0 }; tot[k].rows += 1; tot[k][x.action] += 1; });
    r.totals = Object.values(tot);
    r.unaccounted = J.rows.filter((x) => !x.action).length;
    writeCsv('03-totals-per-sheet.csv', ['sheet', 'rows', 'CREATED', 'ENRICHED', 'SKIPPED', 'SKIPPED_DUPLICATE', 'NEEDS_DECISION', 'ALREADY_IMPORTED'], r.totals);
    writeCsv('04-needs-your-decision.csv', ['id', 'sheet', 'row', 'name', 'category', 'why'], J.decisions);
    writeCsv('05-anomalies.csv', ['id', 'sheet', 'row', 'name', 'code', 'text'], J.anomalies);
    writeCsv('06-people-recruiters-tls.csv', ['role', 'written', 'status', 'mappedTo', 'rows'], [...J.people.values()]);
    writeCsv('07-client-name-map.csv', ['dept', 'written', 'client', 'how', 'rows', 'clientId'], [...J.clientMap.values()]);
    writeCsv('08-drop-and-docs-interpretation.csv', ['id', 'sheet', 'row', 'name', 'written', 'treatedAs', 'because'], J.dropInterpretation);
    writeJson('09-joinings-extra.json', { conflicts: J.conflicts, info: J.info, invoiceLinks: J.invoiceLinks, sharedInvoices: J.sharedInvoices, phoneShared: J.phoneShared, possibleDuplicates: J.possibleDup, newClients: J.newClients, newRequirements: J.newRequirements, statusWords: J.statusWords, counters: J.counters });
  }
  if (r.renames) {
    writeCsv('10-client-renames.csv', ['clientId', 'current', 'official', 'status', 'applied', 'alias', 'dateUsed', 'pdfUsed', 'pageUsed', 'otherPrintedNames', 'reason', 'evidenceText'], r.renames.map((x) => ({ ...x, evidenceText: x.evidence.join(' || ') })));
    writeCsv('10b-same-name-client-pairs.csv', ['official', 'idA', 'oldNameA', 'cityA', 'idB', 'oldNameB', 'cityB'], (r.renames.pairs || []).map((x) => ({ official: x.official, idA: x.a.id, oldNameA: x.a.oldName, cityA: x.a.city, idB: x.b.id, oldNameB: x.b.oldName, cityB: x.b.city })));
  }
  if (r.drops) writeCsv('17-joining-and-drop-dropped-records.csv', ['candidate', 'client', 'joinedOn', 'droppedOn', 'said', 'marker'], r.drops.rows);
  if (r.denorm) writeCsv('16-client-name-copies-updated.csv', ['table', 'id', 'column', 'before', 'after', 'why'], r.denorm);
  if (r.files) {
    writeCsv('11-agreement-files-attached.csv', ['key', 'client', 'clientId', 'kind', 'label', 'size', 'how', 'stored'], r.files.attached);
    writeCsv('12-agreement-files-unmatched.csv', ['key', 'kind', 'why', 'size', 'printed', 'sha256'], r.files.unmatched);
    writeCsv('13-agreement-files-duplicates.csv', ['key', 'client', 'keptTwin', 'why', 'size', 'sha256'], r.files.duplicates);
    writeCsv('18-agreement-every-file.csv', ['folder', 'file', 'sha256', 'size', 'uploaded', 'client', 'clientId', 'action', 'how', 'keptTwin', 'storedAs', 'realType', 'nameFixed'], r.files.fileRows);
    writeCsv('19-clients-created-from-agreements.csv', ['clientId', 'name', 'department', 'departmentFrom', 'sourcePdf', 'formRow', 'location', 'contactName', 'contactPhone', 'contactEmail', 'charges', 'files'], r.files.createdClients);
    writeCsv('19b-agreement-clients-already-existing.csv', ['key', 'name', 'clientId', 'department', 'why'], r.files.reusedClients);
    writeCsv('18b-same-file-for-two-clients.csv', ['key', 'client', 'clientId', 'sha256', 'why'], r.files.sharedContent);
    writeJson('14-agreement-problems.json', r.files.problems);
  }
  {
    const fus = r.L.creates.filter((c) => c.model === 'applicationFollowUp');
    const per = {};
    const sample = [];
    fus.forEach((c) => {
      const m = /\[JNG ([A-Z0-9-]+):/.exec(c.data.notes || '');
      const k = m ? m[1] : '?';
      per[k] = (per[k] || 0) + 1;
      if (per[k] <= 3) sample.push({ marker: (/\[JNG ([^\]]+)\]/.exec(c.data.notes) || [])[1], ownerName: c.data.ownerName, tlName: c.data.tlName, seat: c.data.ownerPositionCode, notes: c.data.notes });
    });
    writeJson('15-planned-followups-sample.json', sample);
  }
  const summary = {
    mode: APPLY ? 'APPLY' : 'DRY RUN', database: dbArg, real: isReal, ledger: r.L.counts(), ruleProblems: r.ruleProblems,
    joinings: r.joinings ? { rows: r.joinings.rows.length, byAction: r.joinings.rows.reduce((o, x) => { o[x.action] = (o[x.action] || 0) + 1; return o; }, {}), unaccounted: r.unaccounted, counters: r.joinings.counters, newClients: r.joinings.newClients, newRequirements: r.joinings.newRequirements } : null,
    renames: r.renames ? r.renames.reduce((o, x) => { o[x.status] = (o[x.status] || 0) + 1; return o; }, {}) : null,
    nameCopies: r.denorm ? r.denorm.length : null,
    dropRecords: r.drops ? { planned: r.drops.planned, alreadyThere: r.drops.skippedExisting, tablesMissing: r.drops.tablesMissing } : null,
    files: r.files ? { total: r.files.fileRows.length, attached: r.files.attached.length, attachedToNewClients: r.files.attached.filter((a) => a.newClient).length, duplicatesSkipped: r.files.duplicates.length, notLinked: r.files.unmatched.length, newClients: r.files.createdClients.length, existingClientsReused: r.files.reusedClients.length, sameFileForTwoClients: r.files.sharedContent.length, problems: r.files.problems.length } : null,
  };
  writeJson('00-summary.json', summary);
  return summary;
}

// ------------------------------------------------------------------------------------------- APPLY
async function apply(prisma, r) {
  await prisma.$queryRawUnsafe('PRAGMA busy_timeout=120000');
  const lg = r.L;
  const unmatchedPending = r.files ? r.files.unmatchedOps.filter((f) => !fs.existsSync(f.dst)).length : 0;
  if (!lg.creates.length && !lg.updates.size && !lg.rawCreates.length && !(r.denorm || []).length && !unmatchedPending) { console.log('NOTHING TO DO: everything in the sheets and the agreements is already in the database (no backup, no audit row, nothing written).'); return { manifestPath: null, backup: null }; }
  const files = r.files ? r.files.fileOps : [];
  const unmatchedOps = r.files ? r.files.unmatchedOps : [];
  lg.create('auditLog', { action: 'Joinings sheets and signed agreements imported (2026-10-17)', entity: 'Import', entityId: 'import-joinings-2026-10-17', toValue: JSON.stringify(r.summary || {}).slice(0, 900), actorName: PJ.IMPORTER });
  // 1. backup
  const backup = path.join(BACKUP_DIR, 'dev.db');
  await vacuumInto(prisma, backup);
  const bsz = fs.statSync(backup).size;
  console.log(`backup written: ${backup} (${(bsz / 1048576).toFixed(1)} MB)`);
  // 2. the manifest (written BEFORE writing, completed after)
  const manifest = {
    stamp: STAMP, database: dbArg, backup, counts: { creates: lg.creates.length, updates: lg.updates.size, denorm: (r.denorm || []).length }, status: 'planned',
    created: {}, updates: [...lg.updates.values()], denorm: r.denorm || [], rawCreated: {}, files: [...files.map((f) => f.dst), ...unmatchedOps.map((f) => f.dst)],
  };
  lg.creates.forEach((c) => { (manifest.created[c.model] = manifest.created[c.model] || []).push(c.id); });
  lg.rawCreates.forEach((c) => { (manifest.rawCreated[c.table] = manifest.rawCreated[c.table] || []).push(c.row.id); });
  manifest.counts.rawCreates = lg.rawCreates.length;
  const manifestPath = path.join(OUT, 'undo-manifest.json');
  fs.writeFileSync(manifestPath, L.serialise(manifest));
  fs.writeFileSync(path.join(OUT, 'undo.cmd.txt'), `node scripts/import-joinings-2026-10-17.js --undo "${manifestPath}" --db "${dbArg}"${isReal ? ' --really-real   (and set TL_ALLOW_REAL_APPLY=1)' : ''}\n`);
  // 3. files (copied first; removed again if the database step fails)
  const copied = [];
  try {
    for (const f of files) { fs.mkdirSync(path.dirname(f.dst), { recursive: true }); fs.copyFileSync(f.src, f.dst); copied.push(f.dst); }
    for (const f of unmatchedOps) { fs.mkdirSync(path.dirname(f.dst), { recursive: true }); if (!fs.existsSync(f.dst)) { fs.copyFileSync(f.src, f.dst); copied.push(f.dst); } }
    console.log(`files copied: ${files.length} to the app uploads + ${unmatchedOps.length} unmatched kept aside`);
    // 4. one transaction
    const t0 = Date.now();
    await prisma.$transaction(async (tx) => {
      const byModel = new Map();
      lg.orderedCreates().forEach((c) => { if (!byModel.has(c.model)) byModel.set(c.model, []); byModel.get(c.model).push(c.data); });
      for (const model of Object.keys(L.RANK).sort((a, b) => L.RANK[a] - L.RANK[b])) {
        const rows = byModel.get(model) || [];
        const size = model === 'application' ? 60 : 120;
        for (let i = 0; i < rows.length; i += size) await tx[model].createMany({ data: rows.slice(i, i + size) });
      }
      for (const u of lg.updates.values()) {
        const pk = L.PK[u.model] || 'id';
        await tx[u.model].update({ where: { [pk]: u.id }, data: u.set });
      }
      for (const c of lg.rawCreates) {
        const cols = Object.keys(c.row);
        await tx.$executeRawUnsafe(`INSERT OR IGNORE INTO "${c.table}" (${cols.map((x) => `"${x}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((x) => (c.row[x] === undefined ? null : c.row[x])));
      }
      for (const d of (r.denorm || [])) await tx.$executeRawUnsafe(`UPDATE "${d.table}" SET "${d.column}" = ? WHERE "id" = ?`, d.after, d.id);
    }, { timeout: 900000, maxWait: 120000 });
    console.log(`database transaction done in ${Math.round((Date.now() - t0) / 1000)}s`);
    manifest.status = 'committed';
    fs.writeFileSync(manifestPath, L.serialise(manifest));
  } catch (e) {
    copied.forEach((fp) => { try { fs.unlinkSync(fp); } catch { /* ignore */ } });
    manifest.status = 'failed'; manifest.error = String(e.message || e).slice(0, 600);
    fs.writeFileSync(manifestPath, L.serialise(manifest));
    throw e;
  }
  return { manifestPath, backup };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const prisma = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    if (UNDO) { await undo(prisma); return; }
    let work = prisma; let tmp = null;
    if (!APPLY) {
      tmp = path.join(os.tmpdir(), `joinings-dryrun-${Date.now()}.db`);
      await vacuumInto(prisma, tmp);
      work = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
    }
    const r = await plan(work);
    r.summary = reports(r);
    console.log(JSON.stringify(r.summary, null, 1));
    console.log('reports in:', OUT);
    if (r.unaccounted) console.log(`WARNING: ${r.unaccounted} source rows have no outcome`);
    if (APPLY) {
      const done = await apply(prisma, r);
      if (done.manifestPath) console.log('APPLIED. undo manifest:', done.manifestPath);
    } else {
      await work.$disconnect(); if (tmp) { try { fs.unlinkSync(tmp); } catch { /* ignore */ } }
      console.log('DRY RUN - nothing was written to the database.');
    }
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
