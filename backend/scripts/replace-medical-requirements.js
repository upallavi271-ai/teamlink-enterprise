#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// REPLACE THE MEDICAL REQUIREMENTS WITH THE FOUNDER'S SHEET (2026-10-26):
//   "In place of the Medical requirements there now, the sheet I gave must be there. Replace them with it; change only that."
//
// THE SHEET ("Medical team requirements sheet.xlsx"):
//   tab "Running"  -> requirements that are OPEN         tab "Stopped" -> requirements that are CLOSED
//   (tab "Sheet" is an older copy and "Client Follow Up Process Sheet" is notes: both are left out)
//   A row = a client (blank = the client of the row above) + bed capacity, qualification, specialization and a COUNT per role:
//   Nurse | Consultant/Doctor | SR (Senior Resident) | Assistant (Professor) | Associate (Professor) | Professor, + Package + Remarks.
//   Every role with a count becomes ONE requirement: "<role> — <specialization>", openings = the count.
//
// WHAT HAPPENS (nothing is deleted, so the 2,855 candidate applications on the old Medical requirements stay safe):
//   * a sheet requirement that already exists (same client + same title) is UPDATED in place (openings, open/closed, details) and keeps
//     its code, its candidates and its TL / recruiters;
//   * a new one is CREATED (department Medical, a new REQ- code). A client that is not on file yet is created (department Medical).
//     Running = OPEN exactly as the sheet says (the founder's list is the truth here; the dry run counts the clients whose agreement is not Active);
//   * every OTHER Medical requirement (not in the sheet) is set to CLOSED. Its candidates and history stay; it can be reopened.
//
//   node scripts/replace-medical-requirements.js --file "<xlsx>"                                  DRY RUN (default): numbers + a report file
//   TL_ALLOW_REAL_APPLY=1 node scripts/replace-medical-requirements.js --file "<xlsx>" --apply --really-real
//   node scripts/replace-medical-requirements.js --undo <undo.json> [--really-real]     puts every changed requirement back, removes the
//                                                                                          ones it created (only if nobody added a candidate)
//   --db <copy.db> to try it on a copy first.
// SAFETY: dry run by default; VACUUM INTO backup first; one transaction; undo manifest with the old values; running it twice changes nothing new.
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
const FILE = val('--file');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `replace-medical-${STAMP}`)));
const DEPT = 'Medical';
const WHO = 'Medical requirements sheet 2026-10-26';

if ((APPLY || UNDO) && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first, or --db <copy>.');
  process.exit(2);
}
if (!UNDO && !FILE) { console.error('Give the sheet: --file "C:\\Users\\user\\Downloads\\Medical team requirements sheet.xlsx"'); process.exit(2); }
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { fullKey, baseKey } = require('../src/utils/clientDedupe');
const { agreementIsActive } = require('../src/utils/atsVocab');

const ROLES = [['Nurse', 'Nurse'], ['Consultant/Doctor', 'Consultant / Doctor'], ['SR', 'Senior Resident'], ['Assistant', 'Assistant Professor'], ['Associate', 'Associate Professor'], ['Professor', 'Professor']];
const TABS = [['Running', 'OPEN'], ['Stopped', 'CLOSED']];
const one = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const flat = (v) => one(v).replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const count = (v) => { const s = one(v); if (!s) return 0; const m = s.match(/\d+/); return m ? Math.max(0, Math.min(500, Number(m[0]))) : 1; };

// ---- read the sheet ---------------------------------------------------------------------------
function readSheet(file) {
  const wb = XLSX.readFile(file);
  const out = []; const skipped = [];
  for (const [tab, status] of TABS) {
    const ws = wb.Sheets[tab];
    if (!ws) { skipped.push(`tab "${tab}" not found`); continue; }
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    const head = rows[0].map((h) => flat(h).toLowerCase());
    const col = (name) => head.findIndex((h) => h === name.toLowerCase());
    const cClient = col('Client Name') >= 0 ? col('Client Name') : 0;
    const c = { bed: col('Bed Capacity'), qual: col('Qualification'), spec: col('Specialization'), pack: col('Package'), rem: col('Remarks') };
    const roleCols = ROLES.map(([h, label]) => [col(h), label]).filter(([i]) => i >= 0);
    let client = ''; let bed = '';
    rows.slice(1).forEach((r, i) => {
      const name = flat(r[cClient]);
      if (name) { client = name; bed = c.bed >= 0 ? flat(r[c.bed]) : ''; }
      const spec = c.spec >= 0 ? one(r[c.spec]).split('\n').map((x) => x.trim()).filter(Boolean)[0] || '' : '';
      const roles = roleCols.map(([idx, label]) => ({ label, n: count(r[idx]) })).filter((x) => x.n > 0);
      if (!roles.length) { if (r.some((x) => one(x))) skipped.push(`${tab} row ${i + 2}: no count in any role column`); return; }
      if (!client) { skipped.push(`${tab} row ${i + 2}: no client above it`); return; }
      roles.forEach(({ label, n }) => out.push({
        tab, row: i + 2, status, client, bed: c.bed >= 0 && flat(r[c.bed]) ? flat(r[c.bed]) : bed,
        title: `${label}${spec ? ` — ${spec.slice(0, 120)}` : ''}`, role: label, spec: spec.slice(0, 120) || null, openings: n,
        qualification: c.qual >= 0 ? flat(r[c.qual]).slice(0, 120) : '', pack: c.pack >= 0 ? one(r[c.pack]) : '', remarks: c.rem >= 0 ? one(r[c.rem]) : '',
      }));
    });
  }
  return { reqs: out, skipped };
}
const describe = (s) => [
  s.qualification && `Qualification: ${s.qualification}`, s.pack && `Package:\n${s.pack}`, s.remarks && `Remarks:\n${s.remarks}`,
  s.bed && `Bed capacity: ${s.bed}`, `From the ${WHO} (tab ${s.tab}, row ${s.row}).`,
].filter(Boolean).join('\n\n').slice(0, 4000);

async function nextCodes(n) {
  const rows = await prisma.requirement.findMany({ where: { reqCode: { startsWith: 'REQ-' } }, select: { reqCode: true } });
  let max = 0; rows.forEach((r) => { const m = /^REQ-(\d+)$/.exec(r.reqCode || ''); if (m) max = Math.max(max, Number(m[1])); });
  max = Math.max(max, await prisma.requirement.count());
  const taken = new Set((await prisma.requirement.findMany({ where: { reqCode: { not: null } }, select: { reqCode: true } })).map((r) => r.reqCode));
  const out = []; let k = max;
  while (out.length < n) { k += 1; const code = `REQ-${String(k).padStart(4, '0')}`; if (!taken.has(code)) out.push(code); }
  return out;
}

async function doUndo() {
  const m = JSON.parse(fs.readFileSync(path.resolve(UNDO), 'utf8'));
  let restored = 0; let removed = 0; let kept = 0;
  await prisma.$transaction(async (tx) => {
    for (const u of m.updated) { await tx.requirement.update({ where: { id: u.id }, data: u.before }).catch(() => null); restored += 1; } // eslint-disable-line no-await-in-loop
    for (const id of m.created) {
      // eslint-disable-next-line no-await-in-loop
      const apps = await tx.application.count({ where: { requirementId: id } });
      if (apps) { kept += 1; continue; } // eslint-disable-line no-continue
      await tx.requirement.delete({ where: { id } }).catch(() => null); removed += 1; // eslint-disable-line no-await-in-loop
    }
    for (const id of m.createdClients) {
      // eslint-disable-next-line no-await-in-loop
      if (!(await tx.requirement.count({ where: { clientId: id } }))) await tx.client.delete({ where: { id } }).catch(() => null);
    }
  }, { timeout: 600000 });
  console.log(`Undone: ${restored} requirement(s) put back as they were, ${removed} created one(s) removed${kept ? `, ${kept} kept because candidates were added to them` : ''}.`);
}

(async () => {
  try {
    if (UNDO) { await doUndo(); return; }
    const { reqs, skipped } = readSheet(path.resolve(FILE));
    const clients = await prisma.client.findMany({ select: { id: true, name: true, agreementStatus: true, clientType: true } });
    const byFull = new Map(); const byBase = new Map();
    clients.forEach((c) => {
      const f = fullKey(c.name); byFull.set(f, byFull.has(f) ? null : c);
      const b = baseKey(c.name); byBase.set(b, byBase.has(b) ? null : c);
    });
    const newClients = new Map(); // name key -> name
    // the same client under another spelling: the same name key, else the Add Client duplicate check (merged-away spellings, same name
    // apart from a branch / place tail) when it is a STRONG match - never a weak guess, so no duplicate client is made
    const { findClientDuplicates } = require('../src/utils/clientDuplicates'); // eslint-disable-line global-require
    const byIdC = new Map(clients.map((c) => [c.id, c]));
    const viaDup = new Map();
    for (const name of new Set(reqs.map((x) => x.client))) {
      if (byFull.get(fullKey(name)) || byBase.get(baseKey(name))) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const { matches } = await findClientDuplicates({ name }, { limit: 1 });
      const top = matches[0];
      if (top && top.strength !== 'possible' && byIdC.get(top.id)) viaDup.set(name, byIdC.get(top.id));
    }
    const clientOf = (name) => byFull.get(fullKey(name)) || byBase.get(baseKey(name)) || viaDup.get(name) || null;
    reqs.forEach((s) => { const c = clientOf(s.client); s.clientRow = c; if (!c) newClients.set(fullKey(s.client), s.client); });

    const old = await prisma.requirement.findMany({
      where: { department: DEPT, internal: false },
      select: { id: true, reqCode: true, title: true, status: true, openings: true, description: true, education: true, specialisation: true, clientId: true, _count: { select: { applications: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const pool = new Map(); // clientId|title -> [old reqs], open ones first
    old.forEach((r) => { const k = `${r.clientId}|${norm(r.title)}`; if (!pool.has(k)) pool.set(k, []); pool.get(k).push(r); });
    pool.forEach((list) => list.sort((a, b) => (a.status === 'CLOSED') - (b.status === 'CLOSED')));
    const used = new Set();
    let toCreate = 0;
    reqs.forEach((s) => {
      if (!s.clientRow) { toCreate += 1; s.action = 'create'; return; }
      const list = pool.get(`${s.clientRow.id}|${norm(s.title)}`) || [];
      const hit = list.find((r) => !used.has(r.id));
      if (hit) { used.add(hit.id); s.action = 'update'; s.match = hit; } else { toCreate += 1; s.action = 'create'; }
    });
    const toClose = old.filter((r) => !used.has(r.id) && r.status !== 'CLOSED');
    const closeApps = toClose.reduce((n, r) => n + r._count.applications, 0);
    const openN = reqs.filter((s) => s.status === 'OPEN').length;
    const gated = reqs.filter((s) => s.status === 'OPEN' && (!s.clientRow || (!agreementIsActive(s.clientRow.agreementStatus) && s.clientRow.clientType !== 'Internal'))).length;

    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}\nSheet: ${path.resolve(FILE)}\n`);
    console.log(`From the sheet: ${reqs.length} requirement(s) (${openN} Running -> open, ${reqs.length - openN} Stopped -> closed) for ${new Set(reqs.map((s) => fullKey(s.client))).size} client(s)`);
    console.log(`  already in TeamLink (updated in place, candidates kept): ${reqs.filter((s) => s.action === 'update').length}`);
    console.log(`  new (created):                                          ${toCreate}`);
    console.log(`  of the open ones, client agreement not Active in TeamLink (still opened, as the sheet says): ${gated}`);
    console.log(`  clients not on file yet (created, department Medical):  ${newClients.size}${newClients.size ? `  -> ${[...newClients.values()].slice(0, 15).join(' | ')}${newClients.size > 15 ? ' ...' : ''}` : ''}`);
    console.log(`Old Medical requirements now: ${old.length}; not in the sheet and not closed yet -> set CLOSED: ${toClose.length} (their ${closeApps} candidate application(s) stay)`);
    if (skipped.length) console.log(`Rows left out: ${skipped.length} (e.g. ${skipped.slice(0, 4).join('; ')})`);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ sheet: reqs.map(({ clientRow, match, ...s }) => ({ ...s, clientId: clientRow ? clientRow.id : null, matchCode: match ? match.reqCode : null })), close: toClose.map((r) => r.reqCode), newClients: [...newClients.values()], skipped }, null, 1));
    console.log(`Full plan: ${path.join(OUT, 'plan.json')}`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    const bakDir = path.resolve(isReal ? path.join(os.homedir(), '.teamlink-backups', `replace-medical-${STAMP}`) : path.join(OUT, 'backup'));
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    const codes = await nextCodes(toCreate);
    const undo = { at: new Date().toISOString(), db: dbArg, updated: [], created: [], createdClients: [] };
    await prisma.$transaction(async (tx) => {
      const made = new Map();
      for (const [k, name] of newClients) {
        // eslint-disable-next-line no-await-in-loop
        const c = await tx.client.create({ data: { name, ownerDepartment: DEPT, clientType: 'Direct', status: 'Active' } });
        made.set(k, c); undo.createdClients.push(c.id);
      }
      for (const s of reqs) {
        const client = s.clientRow || made.get(fullKey(s.client));
        const live = s.status === 'OPEN';
        const status = s.status; // the founder's sheet decides: Running = OPEN, Stopped = CLOSED
        const data = { openings: s.openings, status, description: describe(s), specialisation: s.spec, ...(s.qualification ? { education: s.qualification } : {}) };
        if (s.action === 'update') {
          const r = s.match;
          // keep a live step (Sourcing, Recruiter assigned ...) that is already further than OPEN
          if (live && r.status !== 'CLOSED' && r.status !== 'AGREEMENT_CHECK' && r.status !== 'DRAFT') data.status = r.status;
          undo.updated.push({ id: r.id, before: { openings: r.openings, status: r.status, description: r.description, specialisation: r.specialisation, education: r.education } });
          await tx.requirement.update({ where: { id: r.id }, data }); // eslint-disable-line no-await-in-loop
        } else {
          // eslint-disable-next-line no-await-in-loop
          const r = await tx.requirement.create({ data: { ...data, title: s.title, clientId: client.id, department: DEPT, reqCode: codes.shift(), hiringType: 'Client Placement', priority: 'Medium' } });
          undo.created.push(r.id);
        }
      }
      for (const r of toClose) {
        undo.updated.push({ id: r.id, before: { status: r.status } });
        await tx.requirement.update({ where: { id: r.id }, data: { status: 'CLOSED' } }); // eslint-disable-line no-await-in-loop
      }
      await tx.auditLog.create({ data: { action: `Medical requirements replaced from the sheet: ${undo.created.length} created, ${reqs.length - undo.created.length} updated, ${toClose.length} closed`, entity: 'Requirement', toValue: path.basename(FILE), actorName: WHO } });
    }, { timeout: 900000 });
    const um = path.join(OUT, 'undo.json');
    fs.writeFileSync(um, JSON.stringify(undo, null, 1));
    console.log(`\nDONE: ${undo.created.length} created, ${reqs.length - undo.created.length} updated, ${toClose.length} closed, ${undo.createdClients.length} client(s) added.\nBackup: ${bak}\nUndo:   node scripts/replace-medical-requirements.js --undo "${um}"${isReal ? ' --really-real' : ` --db "${dbArg}"`}`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 900)); process.exit(1); });
