#!/usr/bin/env node
/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// EDUCATION + MANUFACTURING REQUIREMENTS = THE FOUNDER'S SHEETS (2026-10-27):
//   "Only these requirements must be visible. Where a requirement name is a short form, replace it with the official one from the sheets
//    I gave, and import the data properly."  Decisions (asked): old requirements that are not in the sheets are DELETED, as was done for
//   Medical (with their candidate applications; candidate profiles stay; one with an INVOICE is never deleted, it is CLOSED); ONLY the zip
//   clients (the signed-agreement clients left on 2026-10-26) - a sheet company that is not one of them is left out; the sheet's
//   Stopped / No Requirement rows come in as CLOSED (On Hold = ON_HOLD).
//
// THE SHEETS
//   Education    "Edu - 2 Requirement Sheet (3).xlsx" is free text, so it was read by hand into
//                scripts/data/education-requirements-2026-10-27.json (row -> zip client, status, one position per role + count). This
//                script takes the positions from that file and each row's own text (Requirements + Positions columns) from the sheet.
//   Manufacturing "ManuFacture Requirements Sheet.xlsx": tab "Running " = OPEN, tab "Stopped" = CLOSED (the tab decides, as for Medical);
//                a row = company (blank = the one above) | location | qualification | specialization | designation | vacancies | details.
//                ("Manufacturing All Requirements" is the two tabs together; the "just dial" tabs are not a zip client - left out.)
//   Medical was replaced from its sheet on 2026-10-26 (scripts/replace-medical-requirements.js) - not touched here.
//
// WHAT HAPPENS, per department
//   * a sheet position takes over the client's existing requirement that fits it best (same title, else the same subject words / most of
//     the same designation words; the one with more candidates first): it gets the OFFICIAL title from the sheet, the count, the status,
//     the details - and keeps its code, candidates, TL and recruiters. A live step past OPEN (Recruiter assigned ...) is kept for a Running one;
//   * a position with nothing to take over is CREATED (next EDU- / MFG- code);
//   * every other requirement of the department is DELETED with its applications (stage history, follow-ups, interview rows go with
//     them; candidate profiles stay) - except one with an invoice, which is set CLOSED. Internal TeamLink hiring is never touched.
//
//   node scripts/replace-edu-mfg-requirements.js --edu "<edu.xlsx>" --mfg "<mfg.xlsx>"          DRY RUN (default): numbers + plan file
//   TL_ALLOW_REAL_APPLY=1 node scripts/replace-edu-mfg-requirements.js --edu ... --mfg ... --apply --really-real
//   --db <copy.db> to try it on a copy first. --only Education|Manufacturing to do one department.
// SAFETY: dry run by default; VACUUM INTO backup first (the undo: copy it back); one transaction; the deleted rows are written to a file;
// running it twice changes nothing new (the second run finds every position already in place).
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
const EDU_FILE = val('--edu');
const MFG_FILE = val('--mfg');
const EDU_JSON = path.resolve(val('--edu-json', path.join(__dirname, 'data', 'education-requirements-2026-10-27.json')));
const ONLY = val('--only');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `replace-edu-mfg-${STAMP}`)));
const WHO = 'Education + Manufacturing requirement sheets 2026-10-27';

if (APPLY && isReal && !(has('--really-real') && process.env.TL_ALLOW_REAL_APPLY === '1')) {
  console.error('REFUSED: this writes to the REAL database. It needs --really-real AND TL_ALLOW_REAL_APPLY=1. Run the dry run first, or --db <copy>.');
  process.exit(2);
}
const wantEdu = !ONLY || ONLY === 'Education';
const wantMfg = !ONLY || ONLY === 'Manufacturing';
if ((wantEdu && !EDU_FILE) || (wantMfg && !MFG_FILE)) {
  console.error('Give the sheets: --edu "C:\\Users\\user\\Downloads\\Edu - 2 Requirement Sheet  (3).xlsx" --mfg "C:\\Users\\user\\Downloads\\ManuFacture Requirements  Sheet.xlsx"');
  process.exit(2);
}
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.chdir(BACK);
const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { fullKey, baseKey } = require('../src/utils/clientDedupe');

const one = (v) => String(v == null ? '' : v).replace(/\r/g, '').trim();
const flat = (v) => one(v).replace(/\s+/g, ' ').trim();
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = (s) => new Set(String(s || '').toLowerCase().replace(/m\.?\s?tech/g, 'mtech').replace(/ph\.?\s?d/g, 'phd').replace(/m\.?\s?sc/g, 'msc')
  .split(/[^a-z0-9&]+/).filter((w) => w.length > 1 && !STOP.has(w)));
const STOP = new Set(['and', 'the', 'of', 'for', 'in', 'or', 'to', 'with', 'faculty', 'professor', 'assistant', 'associate', 'asst', 'requirement', 'requirements', 'position', 'positions', 'fresher', 'freshers', 'experience', 'salary', 'based', 'interview', 'mode', 'online', 'offline']);
// the subject words that tell two faculty posts apart
// (generic words - teacher, trainer, lab, data ... - are left out: on their own they say nothing about the post)
const SUBJECTS = ['cse', 'ece', 'eee', 'civil', 'mech', 'mba', 'mca', 'phd', 'physics', 'mathematics', 'english', 'chemistry', 'pharmd', 'pharmaceutics', 'pharmacology', 'pharmacognosy', 'pharmaceutical', 'telugu', 'history', 'economics', 'commerce', 'principal', 'fire', 'cloud', 'network', 'aiml', 'iot'];
const subjectsOf = (s) => { const w = words(String(s).replace(/maths/gi, 'mathematics').replace(/pharms*d/gi, 'pharmd')); return new Set(SUBJECTS.filter((k) => w.has(k))); };
const MFG_STOP = new Set(['and', 'the', 'of', 'for', 'in', 'or', 'to', 'with']);
const mwords = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9&]+/).filter((w) => w.length > 1 && !MFG_STOP.has(w)));
const usefulPlace = (s) => { const t = flat(s); return t && !/https?:|@|www\./i.test(t) ? t.slice(0, 160) : null; };
const count = (v) => { const n = Number(String(v).match(/\d+/)?.[0] || 0); return n > 0 && n <= 500 ? n : 1; }; // 45787 (a date typed into the count) -> 1

// ---- Education: hand-read positions + the row text from the sheet -------------------------------
function readEducation() {
  const plan = JSON.parse(fs.readFileSync(EDU_JSON, 'utf8'));
  const rows = XLSX.utils.sheet_to_json(XLSX.readFile(path.resolve(EDU_FILE)).Sheets.Sheet1, { header: 1, defval: '' });
  const out = []; const left = [];
  for (const e of plan.rows) {
    if (!e.client) { left.push(`row ${e.row} ${e.sheet}: ${e.why}`); continue; } // eslint-disable-line no-continue
    const r = rows[e.row - 1] || [];
    const text = [one(r[5]), one(r[6]) && one(r[6]) !== one(r[5]) ? one(r[6]) : ''].filter(Boolean).join('\n\n');
    const contact = [flat(r[1]) && `Contact: ${flat(r[1])}`, flat(r[2]) && `Phone: ${flat(r[2])}`, flat(r[7]) && `Mail: ${flat(r[7])}`, flat(r[8]) && `Agreement: ${flat(r[8])}`].filter(Boolean).join('\n');
    for (const p of e.positions || []) {
      out.push({
        dept: 'Education', row: e.row, sheetName: e.sheet, clientName: e.client, status: e.status, title: p.title, openings: p.openings,
        qualification: p.qualification || null, specialisation: null, location: usefulPlace(r[3]),
        description: [`From the Education requirements sheet (row ${e.row}, ${e.sheet}).`, e.note ? `Note: ${e.note}` : '', text && `Sheet details:\n${text}`, contact].filter(Boolean).join('\n\n').slice(0, 4000),
      });
    }
  }
  return { reqs: out, left };
}

// ---- Manufacturing: the two tabs ----------------------------------------------------------------
// the same company under the spelling the zip client has (checked by hand 2026-10-27)
const MFG_ALIAS = {
  'Mobiesmart Card Technology': 'Mobismart Card Technology',
  'Aurochem Pharmaceuticals (India )Private Limited': 'AUROCHEM PHARMACEUTICALS INDIA PVT LTD.',
  'ICHOR BIOLOGICS PVT ITD': 'ICHOR BIOLOGICS PRIVATE LIMITED',
  'Manaksia Coated Metal Industries Ltd': 'MANAKSIA COATED METALS &INDUSTRIESLIMITED',
  'Manaksia Coated metal industries Limited': 'MANAKSIA COATED METALS &INDUSTRIESLIMITED',
  'Western Airducts(india) pvt ltd': 'Western Airducts India Pvt Ltd',
  'Nile Li -Cycle Private Limited': 'NILE LI-CYCLE PRIVATE LIMITED',
  'Nile Li Cycle Private Limited': 'NILE LI-CYCLE PRIVATE LIMITED',
  'Fortune Biotech Pvt Ltd': 'Fortune Biotech Ltd',
};
function readManufacturing() {
  const wb = XLSX.readFile(path.resolve(MFG_FILE));
  const out = []; const left = [];
  const seen = new Map(); // company|title -> entry (Running is read first and wins)
  for (const [tab, status] of [['Running ', 'OPEN'], ['Stopped', 'CLOSED']]) {
    const ws = wb.Sheets[tab] || wb.Sheets[tab.trim()];
    if (!ws) { left.push(`tab "${tab.trim()}" not found`); continue; } // eslint-disable-line no-continue
    let company = ''; let place = '';
    XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }).slice(1).forEach((r, i) => {
      // a name can run over two lines ("Calyx Chemicals &" / "Pharmaceuticals Ltd."); office hours in brackets are not part of it
      if (flat(r[0])) { company = flat(r[0]).replace(/\(\s*office timings[^)]*\)/i, '').trim(); place = ''; }
      if (usefulPlace(r[1])) place = usefulPlace(r[1]);
      const title = flat(r[4]).replace(/\s*\/\s*/g, ' / ').replace(/[.\s]+$/, '');
      if (!title || !company) return;
      const spec = flat(r[3]).slice(0, 120) || null;
      const e = {
        dept: 'Manufacturing', tab: tab.trim(), row: i + 2, sheetName: company, clientName: MFG_ALIAS[company] || company, status, title, openings: count(r[5]),
        qualification: flat(r[2]).slice(0, 160) || null, specialisation: spec, location: place || null,
        description: [`From the Manufacturing requirements sheet (tab ${tab.trim()}, row ${i + 2}).`, flat(r[2]) && `Qualification: ${flat(r[2])}`, spec && `Specialization: ${spec}`,
          one(r[6]) && `Details:\n${one(r[6])}`, flat(r[7]) && `Remarks: ${flat(r[7])}`].filter(Boolean).join('\n\n').slice(0, 4000),
      };
      const k = `${norm(company)}|${norm(title)}|${norm(spec)}`;
      if (seen.has(k)) return; // the same post written twice (or Running and Stopped): once, Running first
      seen.set(k, e); out.push(e);
    });
  }
  // the same designation twice at one company with a different specialization -> the specialization goes into the title
  const byTitle = new Map();
  out.forEach((e) => { const k = `${norm(e.sheetName)}|${norm(e.title)}`; byTitle.set(k, (byTitle.get(k) || 0) + 1); });
  out.forEach((e) => { if (byTitle.get(`${norm(e.sheetName)}|${norm(e.title)}`) > 1 && e.specialisation && norm(e.specialisation) !== norm(e.title)) e.title = `${e.title} — ${e.specialisation}`; });
  return { reqs: out, left };
}

async function nextCode(prefix, taken) {
  let max = 0;
  taken.forEach((c) => { const m = new RegExp(`^${prefix}-(\\d+)$`).exec(c || ''); if (m) max = Math.max(max, Number(m[1])); });
  return () => { let code; do { max += 1; code = `${prefix}-${String(max).padStart(4, '0')}`; } while (taken.has(code)); taken.add(code); return code; };
}

// how well an old requirement fits a sheet position (0 = not at all)
function fit(s, r) {
  if (norm(r.title) === norm(s.title)) return 1000;
  if (s.dept === 'Education') {
    const a = subjectsOf(`${s.title} ${s.qualification || ''}`); const b = subjectsOf(r.title);
    let n = 0; a.forEach((k) => { if (b.has(k)) n += 1; });
    let clash = 0; b.forEach((k) => { if (!a.has(k)) clash += 1; });
    // PhD is a level, not a subject: PhD ECE and PhD CSE are different posts, so the subject itself must be shared
    const subjA = [...a].filter((k) => k !== 'phd'); const sharedSubj = subjA.filter((k) => b.has(k)).length;
    if (subjA.length && !sharedSubj) return 0;
    const sc = n * 10 - clash * 6;
    return n && sc > 0 ? 100 + sc : 0;
  }
  const a = mwords(s.title); const b = mwords(r.title);
  if (!a.size || !b.size) return 0;
  let n = 0; a.forEach((w) => { if (b.has(w)) n += 1; });
  const j = n / (a.size + b.size - n);
  return j >= 0.5 ? 100 + Math.round(j * 100) : 0;
}

(async () => {
  try {
    const sheet = [];
    const left = [];
    if (wantEdu) { const e = readEducation(); sheet.push(...e.reqs); left.push(...e.left.map((x) => `Education ${x}`)); }
    if (wantMfg) { const m = readManufacturing(); sheet.push(...m.reqs); left.push(...m.left.map((x) => `Manufacturing ${x}`)); }

    // clients: only the ones on file (the zip clients)
    const clients = await prisma.client.findMany({ select: { id: true, name: true } });
    const byExact = new Map(clients.map((c) => [c.name.trim().toLowerCase(), c]));
    const byFull = new Map(); const byBase = new Map();
    clients.forEach((c) => { const f = fullKey(c.name); byFull.set(f, byFull.has(f) ? null : c); const b = baseKey(c.name); byBase.set(b, byBase.has(b) ? null : c); });
    // only ZIP clients (a signed agreement on file): the colleges kept Inactive for joinings history never get requirements
    const zip = new Set((await prisma.clientDocument.findMany({ where: { kind: 'AGREEMENT_SIGNED' }, select: { clientId: true } })).map((d) => d.clientId));
    const clientOf0 = (s) => byExact.get(s.clientName.trim().toLowerCase()) || (s.dept === 'Manufacturing' ? (byFull.get(fullKey(s.clientName)) || byBase.get(baseKey(s.clientName))) : null) || null;
    const clientOf = (s) => { const c = clientOf0(s); return c && zip.has(c.id) ? c : null; };
    const notZip = new Map();
    sheet.forEach((s) => { s.client = clientOf(s); if (!s.client) notZip.set(`${s.dept}: ${s.sheetName}`, (notZip.get(`${s.dept}: ${s.sheetName}`) || 0) + 1); });
    const eduMissing = sheet.filter((s) => s.dept === 'Education' && !s.client);
    if (eduMissing.length) { console.error(`STOP: the Education file names client(s) that are not on file: ${[...new Set(eduMissing.map((s) => s.clientName))].join(' | ')}`); process.exit(3); }
    const todo = sheet.filter((s) => s.client);

    const depts = [wantEdu && 'Education', wantMfg && 'Manufacturing'].filter(Boolean);
    const old = await prisma.requirement.findMany({
      where: { department: { in: depts }, internal: false },
      select: { id: true, reqCode: true, title: true, status: true, department: true, clientId: true, openings: true, createdAt: true, _count: { select: { applications: true, invoices: true } } },
    });
    // match: Running positions first, then the bigger counts, so they get the requirement with the most candidates
    const used = new Set();
    const order = [...todo].sort((a, b) => (a.status !== 'OPEN') - (b.status !== 'OPEN') || b.openings - a.openings);
    for (const s of order) {
      let best = null; let bestScore = 0;
      for (const r of old) {
        if (used.has(r.id) || r.clientId !== s.client.id || r.department !== s.dept) continue; // eslint-disable-line no-continue
        const sc = fit(s, r);
        if (!sc) continue; // eslint-disable-line no-continue
        const tie = (r._count.applications > 0 ? 1e9 : 0) + sc * 100000 + r._count.applications;
        if (tie > bestScore) { bestScore = tie; best = r; }
      }
      if (best) { used.add(best.id); s.match = best; }
    }
    const others = old.filter((r) => !used.has(r.id));
    const toClose = others.filter((r) => r._count.invoices > 0);
    const toDelete = others.filter((r) => r._count.invoices === 0);
    const delApps = toDelete.reduce((n, r) => n + r._count.applications, 0);
    const keptApps = todo.reduce((n, s) => n + (s.match ? s.match._count.applications : 0), 0);

    console.log(`Database: ${dbArg}${isReal ? '  (REAL)' : ''}`);
    for (const d of depts) {
      const mine = todo.filter((s) => s.dept === d);
      const st = (x) => mine.filter((s) => s.status === x).length;
      const oldD = old.filter((r) => r.department === d);
      console.log(`\n== ${d} ==`);
      console.log(`  from the sheet (zip clients only): ${mine.length} requirement(s) for ${new Set(mine.map((s) => s.client.id)).size} client(s) - open ${st('OPEN')}, on hold ${st('ON_HOLD')}, closed ${st('CLOSED')}`);
      console.log(`  take over an existing requirement (official name, candidates kept): ${mine.filter((s) => s.match).length}`);
      console.log(`  new: ${mine.filter((s) => !s.match).length}`);
      console.log(`  old requirements now: ${oldD.length}; deleted: ${toDelete.filter((r) => r.department === d).length} (with ${toDelete.filter((r) => r.department === d).reduce((n, r) => n + r._count.applications, 0)} applications); invoiced -> closed, not deleted: ${toClose.filter((r) => r.department === d).length}`);
    }
    console.log(`\nCandidate applications kept on the taken-over requirements: ${keptApps}; deleted with the old ones: ${delApps} (candidate profiles stay).`);
    if (notZip.size) console.log(`Left out (not a zip client): ${[...notZip.keys()].join(' | ')}`);
    if (left.length) console.log(`Left out of the sheets on purpose: ${left.length} (see the plan file)`);
    fs.mkdirSync(OUT, { recursive: true });
    const planFile = path.join(OUT, 'plan.json');
    fs.writeFileSync(planFile, JSON.stringify({
      sheet: todo.map((s) => ({ dept: s.dept, row: s.row, tab: s.tab, client: s.client.name, title: s.title, openings: s.openings, status: s.status, takesOver: s.match ? `${s.match.reqCode} "${s.match.title}" (${s.match._count.applications} applications)` : null })),
      deleted: toDelete.map((r) => `${r.reqCode} ${r.title} (${r._count.applications} applications)`), closedInvoiced: toClose.map((r) => r.reqCode),
      notZip: [...notZip.keys()], leftOut: left,
    }, null, 1));
    console.log(`Full plan: ${planFile}`);
    if (!APPLY) { console.log('\nDRY RUN: nothing was changed.'); return; }

    const bakDir = path.resolve(isReal ? path.join(os.homedir(), '.teamlink-backups', `replace-edu-mfg-${STAMP}`) : path.join(OUT, 'backup'));
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, 'before.db');
    await prisma.$executeRawUnsafe(`VACUUM INTO '${bak.split(path.sep).join('/').replace(/'/g, "''")}'`);
    const delIds = toDelete.map((r) => r.id);
    fs.writeFileSync(path.join(bakDir, 'deleted-requirements.json'), JSON.stringify(await prisma.requirement.findMany({ where: { id: { in: delIds } } }), null, 1));
    const taken = new Set((await prisma.requirement.findMany({ where: { reqCode: { not: null } }, select: { reqCode: true } })).map((r) => r.reqCode));
    const code = { Education: await nextCode('EDU', taken), Manufacturing: await nextCode('MFG', taken) };
    let created = 0; let updated = 0;
    await prisma.$transaction(async (tx) => {
      for (const s of todo) {
        const data = { title: s.title, openings: s.openings, status: s.status, description: s.description, specialisation: s.specialisation,
          ...(s.qualification ? { education: s.qualification.slice(0, 160) } : {}), ...(s.location ? { location: s.location } : {}) };
        if (s.match) {
          // keep a live step (Sourcing, Recruiter assigned ...) that is already further than OPEN
          if (s.status === 'OPEN' && !['OPEN', 'CLOSED', 'ON_HOLD', 'DRAFT', 'AGREEMENT_CHECK'].includes(s.match.status)) data.status = s.match.status;
          await tx.requirement.update({ where: { id: s.match.id }, data }); updated += 1; // eslint-disable-line no-await-in-loop
        } else {
          // eslint-disable-next-line no-await-in-loop
          await tx.requirement.create({ data: { ...data, clientId: s.client.id, department: s.dept, reqCode: code[s.dept](), hiringType: 'Client Placement', priority: 'Medium' } });
          created += 1;
        }
      }
      for (const r of toClose) if (r.status !== 'CLOSED') await tx.requirement.update({ where: { id: r.id }, data: { status: 'CLOSED' } }); // eslint-disable-line no-await-in-loop
      for (let i = 0; i < delIds.length; i += 400) {
        const part = delIds.slice(i, i + 400);
        for (const model of ['applicationFollowUp', 'applicationStageEvent', 'partnerJobShare', 'partnerSubmission', 'scheduledMessage', 'candidateReferral', 'campusDrive']) {
          if (tx[model]) await tx[model].deleteMany({ where: { requirementId: { in: part } } }).catch(() => null); // eslint-disable-line no-await-in-loop
        }
        await tx.application.deleteMany({ where: { requirementId: { in: part } } }); // eslint-disable-line no-await-in-loop
        await tx.requirement.deleteMany({ where: { id: { in: part } } }); // eslint-disable-line no-await-in-loop
      }
      await tx.auditLog.create({ data: { action: `Education + Manufacturing requirements replaced from the sheets: ${created} created, ${updated} renamed / updated, ${delIds.length} deleted (${delApps} applications), ${toClose.length} invoiced closed`, entity: 'Requirement', toValue: 'sheets 2026-10-27', actorName: WHO } });
    }, { timeout: 1800000 });
    console.log(`\nDONE: ${created} created, ${updated} renamed / updated, ${delIds.length} deleted (${delApps} applications), ${toClose.length} invoiced closed.\nBackup (the whole database before this): ${bak}\nThe deleted rows: ${path.join(bakDir, 'deleted-requirements.json')}\nTo undo: stop TeamLink, copy the backup over prisma/dev.db (remove dev.db-wal / dev.db-shm), start TeamLink.`);
  } finally { await prisma.$disconnect(); }
})().catch((e) => { console.error(String(e && e.stack ? e.stack : e).slice(0, 1200)); process.exit(1); });
