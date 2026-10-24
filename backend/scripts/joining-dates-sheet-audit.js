#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// PIN-TO-PIN AUDIT OF THE JOININGS SHEETS vs THE APP  (2026-10-22)   READ ONLY - writes only CSV / Markdown files.
//
//   node scripts/joining-dates-sheet-audit.js --out "C:\Users\user\Desktop\TeamLink-Joinings-Audit-2026-10-22"
//   options: --db <file> (default prisma/dev.db, always read through a VACUUM copy)   --downloads <dir>   --sample 100   --seed 22
//
// For EVERY row of the Medical / Education / Manufacturing joinings workbooks:
//   the joining cell as typed + the day it means  <->  the joining day the app shows (utils/joinDayShared.js)  +  stage, client, recruiter ...
// then the joined people the app shows as "Not recorded", the status conflicts, the Drop rows, and a 100-person field-by-field check.
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
const DOWNLOADS = val('--downloads', 'C:/Users/user/Downloads');
const OUT = path.resolve(val('--out', path.join(os.tmpdir(), `joining-dates-audit-${Date.now()}`)));
const SAMPLE = Number(val('--sample', '100'));
const SEED = Number(val('--seed', '22'));
process.env.DATABASE_URL = `file:${dbArg.split(path.sep).join('/')}`;
process.env.TL_JOININGS_DIR = DOWNLOADS;
process.chdir(BACK);
const { PrismaClient } = require('@prisma/client');
const parse = require('./lib/joinings-2026-10-17/parse');
const JL = require('./lib/joining-dates-sheet-2026-10-22');
const FC = require('./lib/joining-fields-check-2026-10-22');
const NM = require('./lib/joinings-2026-10-17/names');
const { STATUS } = JL;

const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v).replace(/\r?\n/g, ' ⏎ '); return /[",;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
const writeCsv = (name, cols, rows) => fs.writeFileSync(path.join(OUT, name), `\ufeff${cols.join(',')}\n${rows.map((r) => cols.map((c) => csvCell(r[c])).join(',')).join('\n')}\n`);
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;
const count = (list, key) => list.reduce((o, x) => { const k = typeof key === 'function' ? key(x) : x[key]; o[k] = (o[k] || 0) + 1; return o; }, {});
const mulberry = (a) => () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const base = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  const tmp = path.join(os.tmpdir(), `joining-audit-${Date.now()}.db`);
  await base.$executeRawUnsafe(`VACUUM INTO ${sqlq(tmp)}`);
  await base.$disconnect();
  const prisma = new PrismaClient({ datasources: { db: { url: `file:${tmp.split(path.sep).join('/')}` } } });
  try {
    const parsed = parse.parseAll(DOWNLOADS);
    const db = await JL.loadDb(prisma);
    const A = JL.analyse({ parsed, db });
    const rows = A.rows;
    const cols = ['sheet', 'row', 'hidden', 'name', 'clientSheet', 'clientApp', 'sheetJoinText', 'sheetJoinKind', 'sheetJoinIso', 'appDay', 'appDaySource', 'appStage', 'status', 'differentKind', 'reason', 'sheetSays', 'sheetStatusText', 'importNoteJoin', 'appTyped', 'sheetJoinCell', 'sheetJoinNote', 'appId', 'candidateId'];
    const flat = rows.map((r) => ({ ...r, neighbour: r.neighbour ? `${r.neighbour.days} days from its neighbours${r.neighbour.swapLooksRight ? `; day/month swapped would be ${r.neighbour.swapLooksRight}` : ''}` : '' }));
    writeCsv('audit-per-row.csv', [...cols, 'neighbour'], flat);

    // ---- counts
    const perSheet = {};
    rows.forEach((r) => { const s = perSheet[r.sheet] = perSheet[r.sheet] || { rows: 0 }; s.rows += 1; s[r.status] = (s[r.status] || 0) + 1; });
    const statusCount = count(rows, 'status');
    const medEdu = rows.filter((r) => r.sheet !== 'MFG');

    // ---- the joined people the app shows as "Not recorded"
    const allJoined = [...db.apps.values()].filter((a) => JL.isJoinedStage(a.stage));
    const noDay = allJoined.filter((a) => !JL.appDayOf(db, a).day);
    const noDayRows = await notRecorded({ prisma, db, noDay, parsed, A });
    writeCsv('not-recorded-joined-people.csv', ['candidate', 'client', 'department', 'appStage', 'joiningStatus', 'inTheSheets', 'sheetRows', 'sheetJoiningText', 'sheetDay', 'category', 'whatWeKnow', 'recruiter', 'tl', 'appCreated', 'lastEvent', 'invoiceDate', 'appId', 'candidateId', 'founderDay'], noDayRows);

    // ---- people whose joining day the founder must give: joined in the app + sheet row without a clear day (blank / month / text)
    const needDay = [];
    rows.filter((r) => r.status === STATUS.NO_SHEET_DATE).forEach((r) => needDay.push({ candidate: r.appCandidate || r.name, client: r.clientApp || r.clientSheet, sheetRow: r.id, sheetSays: r.sheetSays, sheetJoiningText: r.sheetJoinText, kind: r.sheetJoinKind, appDayNow: r.appDay, appDaySource: r.appDaySource, why: r.reason, appId: r.appId, founderDay: '' }));
    noDayRows.filter((r) => !r.sheetDay && !/^DUPLICATE/.test(r.category)).forEach((r) => needDay.push({ candidate: r.candidate, client: r.client, sheetRow: r.sheetRows || '(not in these three sheets)', sheetSays: r.inTheSheets, sheetJoiningText: r.sheetJoiningText, kind: r.category, appDayNow: '', appDaySource: 'none', why: r.whatWeKnow, appId: r.appId, founderDay: '' }));
    writeCsv('people-who-need-a-joining-date-from-you.csv', ['candidate', 'client', 'sheetRow', 'sheetSays', 'sheetJoiningText', 'kind', 'appDayNow', 'appDaySource', 'why', 'appId', 'founderDay'], needDay);

    // ---- conflicts both ways
    const conf = rows.filter((r) => [STATUS.CONFLICT, STATUS.NOT_JOINED].includes(r.status)).map((r) => ({ kind: r.status === STATUS.CONFLICT ? 'APP SAYS JOINED, SHEET SAYS NOT' : 'SHEET SAYS JOINED, APP NOT JOINED', sheet: r.sheet, row: r.row, name: r.name, client: r.clientApp || r.clientSheet, sheetSays: r.sheetSays, sheetStatusText: r.sheetStatusText, sheetJoinText: r.sheetJoinText, appStage: r.appStage, appDay: r.appDay, reason: r.reason, appId: r.appId }));
    writeCsv('status-conflicts.csv', ['kind', 'sheet', 'row', 'name', 'client', 'sheetSays', 'sheetStatusText', 'sheetJoinText', 'appStage', 'appDay', 'reason', 'appId'], conf);

    // ---- the days that differ: sheet vs app
    const diffs = rows.filter((r) => r.status === STATUS.DIFFERENT || r.status === STATUS.MISSING).map((r) => ({ differentKind: r.differentKind, sheet: r.sheet, row: r.row, name: r.name, client: r.clientApp || r.clientSheet, sheetJoinText: r.sheetJoinText, sheetDay: r.sheetJoinIso, appDay: r.appDay, appDaySource: r.appDaySource, importWrote: r.importNoteJoin, howFar: r.detail, appStage: r.appStage, appId: r.appId, founderDay: '' }));
    writeCsv('date-differences-sheet-vs-app.csv', ['differentKind', 'sheet', 'row', 'name', 'client', 'sheetJoinText', 'sheetDay', 'appDay', 'appDaySource', 'importWrote', 'howFar', 'appStage', 'appId', 'founderDay'], diffs);

    // ---- Drop rows + rows needing a decision (the sheet's own words)
    const dropRows = rows.filter((r) => /DID NOT JOIN|THEN LEFT/.test(r.sheetSays) || r.status === STATUS.NOT_FOUND).map((r) => ({ group: r.status === STATUS.NOT_FOUND ? 'NOT IMPORTED - NEEDS YOUR DECISION' : (r.sheetSays === 'DID NOT JOIN' ? 'DROP READ AS: DID NOT JOIN' : 'DROP READ AS: JOINED THEN LEFT'), sheet: r.sheet, row: r.row, name: r.name, client: r.clientApp || r.clientSheet, sheetStatusText: r.sheetStatusText, sheetJoinText: r.sheetJoinText, appStage: r.appStage, appDay: r.appDay, treatedAs: r.status === STATUS.NOT_FOUND ? r.reason : r.sheetNote, appId: r.appId }));
    writeCsv('drops-and-needs-decision.csv', ['group', 'sheet', 'row', 'name', 'client', 'sheetStatusText', 'sheetJoinText', 'appStage', 'appDay', 'treatedAs', 'appId'], dropRows);

    // ---- placeholders: the app's own day for a month-only / blank-date joined person
    const placeholders = rows.filter((r) => r.status === STATUS.NO_SHEET_DATE && r.appDay).map((r) => ({ candidate: r.appCandidate, client: r.clientApp, sheetRow: r.id, sheetSays: r.sheetJoinText, kind: r.sheetJoinKind, appDay: r.appDay, appDaySource: r.appDaySource, appId: r.appId }));
    writeCsv('joined-days-the-sheet-does-not-support.csv', ['candidate', 'client', 'sheetRow', 'sheetSays', 'kind', 'appDay', 'appDaySource', 'appId'], placeholders);

    // ---- every row whose joining cell is a month, words or empty-but-present (part 4)
    const textDates = rows.filter((r) => ['MONTH-ONLY', 'TEXT-ONLY', 'BAD-DATE'].includes(r.sheetJoinKind)).map((r) => ({ sheet: r.sheet, row: r.row, name: r.name, client: r.clientApp || r.clientSheet, sheetJoinText: r.sheetJoinText, kind: r.sheetJoinKind, monthOnly: r.sheetJoinMonth ? JL.monthHuman(r.sheetJoinMonth) : '', sheetSays: r.sheetSays, status: r.status, appStage: r.appStage, appDay: r.appDay, display: r.sheetJoinMonth ? `${JL.monthHuman(r.sheetJoinMonth)} (day not recorded)` : '' }));
    writeCsv('month-only-and-text-dates.csv', ['sheet', 'row', 'name', 'client', 'sheetJoinText', 'kind', 'monthOnly', 'sheetSays', 'status', 'appStage', 'appDay', 'display'], textDates);

    // ---- Joining & Drop records vs app day
    const recMismatch = [];
    for (const a of allJoined) {
      const recs = db.records.get(a.id) || [];
      const d = JL.appDayOf(db, a).day;
      recs.forEach((rc) => { if ((rc.joinedOn || null) !== (d || null)) recMismatch.push({ appId: a.id, candidate: (db.cands.get(a.candidateId) || {}).name, appDay: d || '', recordJoinedOn: rc.joinedOn || '', recordStatus: rc.status }); });
    }
    writeCsv('joining-and-drop-record-vs-app-day.csv', ['appId', 'candidate', 'appDay', 'recordJoinedOn', 'recordStatus'], recMismatch);

    // ---- the founder's screenshot people
    const shot = rows.filter((r) => /nova|shifa/i.test(`${r.clientSheet} ${r.clientApp}`) && /(divya|vijay ?kumar|venka|abik)/i.test(r.name));
    writeCsv('screenshot-people.csv', ['sheet', 'row', 'name', 'clientSheet', 'clientApp', 'sheetJoinText', 'sheetJoinIso', 'appDay', 'appDaySource', 'appStage', 'status', 'reason'], shot);

    // ---- suspicious days (neighbour check) - for a person to look at
    const suspicious = flat.filter((r) => r.neighbour).map((r) => ({ sheet: r.sheet, row: r.row, name: r.name, sheetJoinText: r.sheetJoinText, sheetJoinIso: r.sheetJoinIso, appDay: r.appDay, neighbour: r.neighbour, status: r.status }));
    writeCsv('sheet-days-far-from-their-neighbours.csv', ['sheet', 'row', 'name', 'sheetJoinText', 'sheetJoinIso', 'appDay', 'neighbour', 'status'], suspicious);

    // ---- part 5: every column vs the database
    const fields = await FC.check({ prisma, parsed, db, rows, rowsOfApp: A.rowsOfApp });
    writeCsv('field-check-every-row.csv', ['id', 'name', 'field', 'sheetValue', 'appValue', 'result', 'note'], fields.all);
    const rnd = mulberry(SEED);
    const pool = fields.byRow.filter((x) => x.sheet !== 'MFG');
    const picked = []; const taken = new Set();
    while (picked.length < Math.min(SAMPLE, pool.length)) { const i = Math.floor(rnd() * pool.length); if (!taken.has(i)) { taken.add(i); picked.push(pool[i]); } }
    const pickedIds = new Set(picked.map((x) => x.id));
    writeCsv('field-check-sample-100-people.csv', ['id', 'name', 'field', 'sheetValue', 'appValue', 'result', 'note'], fields.all.filter((x) => pickedIds.has(x.id)));
    const fieldSummary = FC.summarise(fields.all);
    const sampleSummary = FC.summarise(fields.all.filter((x) => pickedIds.has(x.id)));
    writeCsv('field-check-problems.csv', ['id', 'name', 'field', 'sheetValue', 'appValue', 'result', 'note'], fields.all.filter((x) => /^(DIFFERENT|MISSING|NOT-LINKED|NOT-FOUND)/.test(x.result)));

    // ---- summary
    const md = buildSummary({ rows, medEdu, perSheet, statusCount, allJoined, noDay, noDayRows, needDay, conf, dropRows, placeholders, textDates, recMismatch, shot, suspicious, fieldSummary, sampleSummary, fields, db, parsed, picked });
    fs.writeFileSync(path.join(OUT, 'summary.md'), md);
    fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ statusCount, perSheet, allJoined: allJoined.length, notRecorded: noDay.length, notRecordedInSheets: noDayRows.filter((r) => r.inTheSheets === 'yes').length, fieldSummary, sampleSummary }, null, 1));
    console.log(md.split('\n').slice(0, 60).join('\n'));
    console.log('reports in:', OUT);
  } finally {
    await prisma.$disconnect();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ------------------------------------------------------------------------------------------------ the 235 "Not recorded"
async function notRecorded({ prisma, db, noDay, parsed, A }) {
  // index the sheet rows by phone and by name
  const byPhone = new Map(); const byName = new Map();
  const nk = (s) => parse.letters(String(s || '').replace(/^dr\.?\s*/i, ''));
  parsed.rows.forEach((r) => {
    r.f.phones.forEach((p) => { if (!byPhone.has(p)) byPhone.set(p, []); byPhone.get(p).push(r); });
    const k = nk(r.f.name); if (k.length >= 5) { if (!byName.has(k)) byName.set(k, []); byName.get(k).push(r); }
  });
  const ids = noDay.map((a) => a.id);
  const fus = new Map();
  for (const part of JL.chunks(ids, 400)) (await prisma.applicationFollowUp.findMany({ where: { applicationId: { in: part } }, orderBy: { createdAt: 'asc' }, select: { applicationId: true, ownerName: true, tlName: true, createdByName: true } })).forEach((f) => fus.set(f.applicationId, f));
  const lastEv = new Map();
  for (const part of JL.chunks(ids, 400)) (await prisma.applicationStageEvent.findMany({ where: { applicationId: { in: part } }, orderBy: { createdAt: 'asc' }, select: { applicationId: true, createdAt: true, toStage: true, actorName: true } })).forEach((e) => lastEv.set(e.applicationId, e));
  const invs = new Map();
  const candIds = [...new Set(noDay.map((a) => a.candidateId))];
  for (const part of JL.chunks(candIds, 400)) (await prisma.invoice.findMany({ where: { candidateId: { in: part } }, select: { candidateId: true, invoiceDate: true, invoiceNumber: true } }).catch(() => [])).forEach((i) => { if (!invs.has(i.candidateId)) invs.set(i.candidateId, i); });
  const out = [];
  for (const a of noDay) {
    const cand = db.cands.get(a.candidateId) || {}; const req = db.reqs.get(a.requirementId) || {}; const cl = db.clients.get(req.clientId) || {};
    const linked = A.rowsOfApp.get(a.id) || [];
    const phoneRows = parse.phonesIn(cand.phone).list.flatMap((p) => byPhone.get(p) || []);
    const nameRows = (byName.get(nk(cand.name)) || []);
    const cand2 = [...new Map([...linked, ...phoneRows.filter((r) => parse.letters(r.f.name).slice(0, 4) === parse.letters(cand.name || '').replace(/^dr/, '').slice(0, 4) || nk(r.f.name) === nk(cand.name)), ...nameRows].map((r) => [r.id, r])).values()];
    const sheetRows = cand2.map((r) => r.id).join(' + ');
    const joinTexts = cand2.map((r) => JL.joinCell(r).text || '(blank)').join(' | ');
    const sheetDays = [...new Set(cand2.filter((r) => JL.verdictOf(r).joined).map((r) => JL.joinCell(r)).filter((c) => c.kind === 'DATE').map((c) => c.iso))];
    const fu = fus.get(a.id) || {}; const ev = lastEv.get(a.id);
    const inv = invs.get(a.candidateId);
    // the application(s) the sheet rows of this person were attached to: is it the same college as this one?
    const mine = NM.fullKey(cl.name || '');
    const sheetAppIds = new Set(cand2.map((r) => db.byMarker.get(r.id)).filter(Boolean).map((f) => f.applicationId));
    const others = [...db.apps.values()].filter((x) => x.candidateId === a.candidateId && x.id !== a.id && JL.isJoinedStage(x.stage)).map((x) => { const rq = db.reqs.get(x.requirementId) || {}; const c2 = db.clients.get(rq.clientId) || {}; return { id: x.id, clientId: rq.clientId, client: c2.name || '', key: NM.fullKey(c2.name || ''), day: JL.appDayOf(db, x).day || '', stage: x.stage, inSheet: sheetAppIds.has(x.id) }; }).filter((x) => x.day);
    const sameCollege = others.filter((x) => x.clientId === req.clientId || (x.key && mine && (x.key === mine || (Math.min(x.key.length, mine.length) >= 6 && (x.key.startsWith(mine) || mine.startsWith(x.key))))));
    let category; let know;
    if (sameCollege.length) { category = 'DUPLICATE: THE SAME PERSON IS JOINED TWICE AT THIS COLLEGE'; know = `The same person is also Joined at "${sameCollege[0].client}" with the day ${sameCollege[0].day}${sameCollege[0].inSheet ? ' (from the sheets)' : ''}; this one is an extra Joined application at the same college. Not given a date: it would count the joining twice.`; }
    else if (others.length) { category = 'THE SAME PERSON HAS A DATED JOINING AT ANOTHER COLLEGE'; know = `Dated joining(s): ${others.map((x) => `${x.client} ${x.day}${x.inSheet ? ' (sheet)' : ''}`).join(' | ')}. This application is Joined at "${cl.name}" with no day: a wrong Joined mark, or a second joining - the founder decides.`; }
    else if (!cand2.length) { category = 'NOT IN THESE THREE SHEETS'; know = 'No row of the three workbooks has this person (by phone or full name). The joined status was entered in the app without a joining date.'; }
    else if (sheetDays.length === 1) { category = 'IN A SHEET WITH A CLEAR DAY (not attached to this application)'; know = `A sheet row names this person with the day ${sheetDays[0]}, not attached to this application: check before using it.`; }
    else if (sheetDays.length > 1) { category = 'IN THE SHEETS WITH SEVERAL DAYS'; know = `Sheet rows give: ${sheetDays.join(', ')}`; }
    else { category = 'IN THE SHEETS, NO CLEAR DAY'; know = `The sheet row(s) give no day: ${joinTexts}`; }
    out.push({
      candidate: cand.name || '', client: cl.name || '', department: req.department || cl.ownerDepartment || '', appStage: a.stage, joiningStatus: a.joiningStatus || '', inTheSheets: cand2.length ? 'yes' : 'no',
      sheetRows, sheetJoiningText: joinTexts, sheetDay: sheetDays.length === 1 ? sheetDays[0] : '', category, whatWeKnow: know, recruiter: fu.ownerName || '', tl: fu.tlName || '',
      appCreated: a.createdAt ? a.createdAt.toISOString().slice(0, 10) : '', lastEvent: ev ? `${ev.toStage} ${ev.createdAt.toISOString().slice(0, 10)} (${ev.actorName || ''})` : '',
      invoiceDate: inv && inv.invoiceDate ? String(inv.invoiceDate instanceof Date ? inv.invoiceDate.toISOString().slice(0, 10) : inv.invoiceDate).slice(0, 10) : '', appId: a.id, candidateId: a.candidateId, founderDay: '',
    });
  }
  return out.sort((x, y) => x.client.localeCompare(y.client) || x.candidate.localeCompare(y.candidate));
}

// ------------------------------------------------------------------------------------------------ summary.md
function buildSummary(c) {
  const { rows, perSheet, statusCount, allJoined, noDay, noDayRows, needDay, conf, dropRows, placeholders, textDates, recMismatch, shot, suspicious, fieldSummary, sampleSummary } = c;
  const S = STATUS;
  const L = [];
  const p = (s = '') => L.push(s);
  const table = (head, body) => { p(`| ${head.join(' | ')} |`); p(`| ${head.map(() => '---').join(' | ')} |`); body.forEach((r) => p(`| ${r.join(' | ')} |`)); p(); };
  p('# Joinings sheets vs the app - pin-to-pin audit (2026-10-22)');
  p();
  p(`Source: the three workbooks (Medical Sheet1, Education 9 sheets, plus the Manufacturing sheet imported earlier), ${rows.length} data rows read (hidden rows included).`);
  p('Database: a VACUUM copy of the real dev.db (read only).');
  p();
  p('## 1. Rows per sheet and status');
  const cols = [S.MATCH, S.MISSING, S.DIFFERENT, S.NOT_JOINED, S.NO_SHEET_DATE, S.CONFLICT, S.EARLIER_STEP, S.NOT_A_JOINING, S.NOT_FOUND];
  table(['Sheet', 'Rows', ...cols], Object.keys(perSheet).map((k) => [k, perSheet[k].rows, ...cols.map((s) => perSheet[k][s] || 0)]));
  table(['Status', 'Rows'], Object.entries(statusCount).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]));
  p('Status words: MATCH = sheet day and app day are the same. DATE-MISSING-IN-APP = sheet has a day, app has none. DATE-DIFFERENT = both have a day, not the same. STAGE-NOT-JOINED-BUT-SHEET-SAYS-JOINED = sheet says joined, the application is not Joined. SHEET-HAS-NO-DATE = person joined in both, but the sheet has no clear day (blank / month only / words). APP-JOINED-BUT-SHEET-SAYS-NOT = application Joined, sheet row says dropped / did not join / still in pipeline. NOT-A-JOINING-ROW = pipeline / dropped row and the application is not Joined either. NOT-FOUND = the row was not imported.');
  p();
  const diffRows = rows.filter((r) => r.status === S.DIFFERENT || r.status === S.MISSING);
  p('### Rows where both have a day but the days differ');
  table(['Kind of difference', 'Rows'], Object.entries(count(diffRows, (r) => (r.differentKind || '').replace(/ \(.*\)$/, ''))).map(([k, v]) => [k, v]));
  p('File: date-differences-sheet-vs-app.csv (both days side by side).');
  p();
  p('## 2. The joined people the app shows as "Not recorded"');
  p(`Joined (or Hired) applications in the app: ${allJoined.length}. Without any joining day: ${noDay.length}.`);
  table(['Category', 'People'], Object.entries(count(noDayRows, 'category')).map(([k, v]) => [k, v]));
  p('File: not-recorded-joined-people.csv (one line per person, with the column founderDay to fill in).');
  p();
  p('## 3. Joined in both, but the sheet gives no clear day');
  table(['What the joining cell holds', 'People'], Object.entries(count(rows.filter((r) => r.status === S.NO_SHEET_DATE), (r) => r.sheetJoinKind)).map(([k, v]) => [k, v]));
  p(`Every sheet row whose joining cell is only a month, words or empty (${c.textDates.length} rows, any status) is listed with its exact text in month-only-and-text-dates.csv. Of the joined people among them, ${placeholders.length} show a day in the app (typed by someone; the sheet only gives a month) - file joined-days-the-sheet-does-not-support.csv. No day is invented for anybody.`);
  p();
  p('## 4. Status conflicts');
  table(['Kind', 'Rows'], Object.entries(count(conf, 'kind')).map(([k, v]) => [k, v]));
  p('File: status-conflicts.csv.');
  p();
  p('## 5. Drop rows and rows that need a decision');
  table(['Group', 'Rows'], Object.entries(count(dropRows, 'group')).map(([k, v]) => [k, v]));
  p('File: drops-and-needs-decision.csv (the sheet text is in every line).');
  p();
  p('## 6. The founder\'s screenshot people');
  table(['Sheet row', 'Name', 'Client (sheet)', 'Sheet joining cell', 'Sheet day', 'App day', 'App stage', 'Status'], shot.map((r) => [r.id, r.name, r.clientSheet, r.sheetJoinText, r.sheetJoinIso, r.appDay, r.appStage, r.status]));
  p('## 7. Field-by-field check (every column of every imported row against the database)');
  table(['Field', 'OK', 'Not equal / missing', 'Info (import never overwrites app data)'], Object.entries(fieldSummary).map(([k, v]) => [k, v.ok, v.bad, v.info]));
  p(`Sample of ${c.picked.length} random people (seed 22), same checks:`);
  table(['Field', 'OK', 'Not equal / missing', 'Info'], Object.entries(sampleSummary).map(([k, v]) => [k, v.ok, v.bad, v.info]));
  p();
  p(`Joining & Drop records whose "joined on" differs from the app day: ${recMismatch.length} (file joining-and-drop-record-vs-app-day.csv).`);
  p(`Sheet days far from their neighbouring rows (possible day/month slips, for a person to look at): ${suspicious.length} (file sheet-days-far-from-their-neighbours.csv).`);
  p(`People for whom a joining day must be supplied: ${needDay.length} (file people-who-need-a-joining-date-from-you.csv).`);
  return L.join('\n');
}

main().catch((e) => { console.error('FAILED:', e && e.stack ? e.stack : e); process.exit(1); });
