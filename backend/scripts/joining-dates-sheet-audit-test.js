#!/usr/bin/env node
/* eslint-disable no-console, no-await-in-loop */
// ---------------------------------------------------------------------------
// TEST of the joining-dates sheet audit + the guarded fix (2026-10-22).   node scripts/joining-dates-sheet-audit-test.js [--db <file>]
// Works ONLY on COPIES of the database (a VACUUM copy made from the given file, default prisma/dev.db - read only). Every copy and every
// output folder is named ZZTEST and is deleted at the end. The real database is never written.
//   1. parser cases      every date format found in the sheets, month-only, words, 2-digit years, typo years, month-first cells
//   2. fix rules         empty / import-wrote-it / person-typed / sheets disagree / future / audit-log edit / legacy slip / undo file says no
//   3. on a copy         dry run changes nothing; apply changes exactly the planned rows and only the planned columns; apply twice = nothing;
//                        undo = the same tables as before; the "Not recorded" count and the shared joining-day rule move as expected
//   4. the founder list  --decisions: a day from the founder is used for a Joined person, refused for a person who is not Joined
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const argv = process.argv.slice(2);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d; };
const BACK = path.resolve(__dirname, '..');
const SRC_DB = path.resolve(val('--db', path.join(BACK, 'prisma', 'dev.db')));
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ZZTEST-joining-dates-'));
process.chdir(BACK);
process.env.TL_JOININGS_DIR = val('--downloads', 'C:/Users/user/Downloads');

let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) { pass += 1; console.log(`  PASS  ${msg}`); } else { fail += 1; console.log(`  FAIL  ${msg}`); } };
const eq = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}${JSON.stringify(a) === JSON.stringify(b) ? '' : `   (got ${JSON.stringify(a)}, wanted ${JSON.stringify(b)})`}`);
const sqlq = (s) => `'${String(s).split(path.sep).join('/').replace(/'/g, "''")}'`;

const parse = require('./lib/joinings-2026-10-17/parse');
const JL = require('./lib/joining-dates-sheet-2026-10-22');
const JD = require('../src/utils/joinDayShared');

// ------------------------------------------------------------------------------------------------ 1. parser
function parserCases() {
  console.log('1. PARSER');
  const iso = (t) => { const d = parse.datesIn(t); return d.length && d[0].iso ? d[0].iso : null; };
  eq(iso('2 January 2025'), '2025-01-02', "'2 January 2025'");
  eq(iso('31-May-25'), '2025-05-31', "'31-May-25' (two-digit year)");
  eq(iso('16-04-2025'), '2025-04-16', "'16-04-2025' is day-month-year");
  eq(iso('04-05-2025'), '2025-05-04', "'04-05-2025' is read day first (4 May), never 5 April");
  eq(iso('11 August 2025'), '2025-08-11', "'11 August 2025'");
  eq(iso('10 Oct 2025'), '2025-10-10', "'10 Oct 2025'");
  eq(iso('1 June 2022'), '2022-06-01', "'1 June 2022'");
  eq(iso('28-01-26'), '2026-01-28', "'28-01-26' (two-digit year)");
  eq(iso('O5-DEC-2022'), '2022-12-05', "'O5-DEC-2022' (letter O typed for zero)");
  eq(iso('5 Febuary 2025'), '2025-02-05', "'5 Febuary 2025' (month misspelt)");
  eq(iso('16 auguest 2022'), '2022-08-16', "'16 auguest 2022' (month misspelt)");
  eq(iso('Immediate'), null, "'Immediate' gives no day");
  eq(iso('Continue'), null, "'Continue' gives no day");
  eq(iso('13 March 2202'), null, "'13 March 2202' (year typo) is not accepted as a day");
  const m = parse.datesIn('June 2025');
  ok(m.length === 1 && m[0].iso === null && m[0].month === '2025-06', "'June 2025' = month 2025-06, no day");
  ok(parse.datesIn('July 2025')[0].month === '2025-07', "'July 2025' = month 2025-07, no day");
  // the cells of the real workbooks
  const p = parse.parseAll(process.env.TL_JOININGS_DIR);
  const row = (id) => p.rows.find((r) => r.id === id);
  eq(JL.joinCell(row('MFG:15')).iso, '2026-10-12', 'MFG:15 month-first cell 12-10-2026 is 12 October (not 10 December)');
  eq(JL.joinCell(row('MFG:10')).iso, '2026-02-12', 'MFG:10 month-first cell 12-02-26 is 12 February');
  eq(JL.joinCell(row('EDU-2023:19')).iso, '2023-01-02', 'EDU-2023:19 typed year 2022 on the 2023 sheet is read as 2023');
  eq(JL.joinCell(row('EDU-2026:30')).iso, '2026-03-13', 'EDU-2026:30 typed year 2025 on the 2026 sheet is read as 2026');
  eq(JL.joinCell(row('MED:96')).iso, '2026-10-12', 'MED:96 (Dr.Divya) 12/10/2026 is 12 October 2026');
  eq(JL.joinCell(row('EDU-2025:36')).iso, '2025-02-05', 'EDU-2025:36 "5 Febuary 2025"');
  const rep = JL.joinCell(row('EDU-REPORT:2'));
  ok(rep.kind === 'MONTH-ONLY' && rep.month === '2025-06' && rep.iso === null, 'EDU-REPORT:2 "June 2025" is MONTH-ONLY, no day');
  ok(JL.joinCell(row('EDU-MISS:291')).kind === 'BLANK' || JL.joinCell(row('EDU-MISS:80')).kind === 'BLANK', 'an empty joining cell is BLANK');
  const fake = { cells: { G: { v: 'Immediate', t: 's' } }, sheetCfg: { cols: { join: 'G' } }, anomalies: [], f: { joinDates: parse.datesIn('Immediate'), joinIso: null } };
  eq(JL.joinCell(fake).kind, 'TEXT-ONLY', "'Immediate' in a cell is TEXT-ONLY");
  ok(JL.human('2025-12-09') === '9 Dec 2025' && JL.monthHuman('2025-06') === 'June 2025', 'display texts: "9 Dec 2025" and "June 2025"');
  // the shared joining-day rule (utils/joinDayShared.js): typed day, else joined-at (IST), else the day of the move into Joined
  eq(JD.joinDay({ joiningDate: '2025-12-09', joinedAt: new Date('2025-12-01T09:00:00Z') }, null), '2025-12-09', 'rule: the typed day wins over joined-at');
  eq(JD.joinDay({ joiningDate: null, joinedAt: new Date('2025-12-01T20:00:00Z') }, null), '2025-12-02', 'rule: joined-at is read as an India day (20:00 UTC = next day)');
  eq(JD.joinDay({ joiningDate: '2203-05-12', joinedAt: null }, new Date('2025-03-03T05:00:00Z')), '2025-03-03', 'rule: a typed 2203 is not a day; the move into Joined is used');
  eq(JD.joinDay({ joiningDate: null, joinedAt: null }, null), null, 'rule: nothing known = null (Not recorded)');
}

// ------------------------------------------------------------------------------------------------ 2. fix rules (no database)
function rulesCases() {
  console.log('2. FIX RULES (planFixes)');
  const S = JL.STATUS;
  let n = 0;
  // one application with one or more sheet rows
  function app({ typed = null, joinedAt = null, rows, note = null, eventByImport = false, eventDay = null }) {
    n += 1;
    const appId = `app${n}`;
    const a = { id: appId, candidateId: `c${n}`, joiningDate: typed, joinedAt, stage: 'JOINED' };
    const day = typed || (joinedAt ? joinedAt.toISOString().slice(0, 10) : eventDay) || null;
    const cur = { day, source: '', typed: typed && /^\d{4}-/.test(typed) ? typed : null, joinedAtDay: !typed && joinedAt ? joinedAt.toISOString().slice(0, 10) : null, eventDay, eventByImport };
    const out = rows.map((r, i) => {
      const jc = { kind: r.kind || 'DATE', iso: r.iso || null, month: r.month || null, text: r.text || r.iso || '', cell: 'date cell', ambiguous: false };
      const v = { joined: r.joined !== false, says: 'JOINED' };
      let status = S.MATCH;
      if (jc.kind === 'DATE' && v.joined) status = !day ? S.MISSING : (day === jc.iso ? S.MATCH : S.DIFFERENT);
      else if (jc.kind !== 'DATE' && v.joined) status = S.NO_SHEET_DATE;
      return { id: `X:${n}${i}`, appId, status, ambiguous: false, appCandidate: `Person ${n}`, name: `Person ${n}`, clientApp: 'College', sheetJoinText: jc.text, sheetJoinCell: jc.cell, appDay: day || '', detail: '', importNoteJoin: r.note !== undefined ? r.note : (note || ''), appTyped: typed || '', _app: a, _day: cur, _verdict: v, _jc: jc };
    });
    return out;
  }
  const plan = (rows, opts) => JL.planFixes({ rows }, { today: '2026-10-22', ...opts });
  let r;
  r = plan(app({ typed: null, rows: [{ iso: '2025-03-04' }] }));
  ok(r.fixes.length === 1 && r.fixes[0].rule === 'EMPTY' && r.fixes[0].new === '2025-03-04', 'EMPTY: no day in the app + one clear sheet day = fixed');
  r = plan(app({ typed: '2025-12-04', rows: [{ iso: '2025-04-12', note: '2025-12-04' }] }));
  ok(r.fixes.length === 1 && r.fixes[0].rule === 'IMPORT-WROTE-IT' && r.fixes[0].new === '2025-04-12', 'IMPORT-WROTE-IT: the app holds what the import wrote, the sheet reads differently = fixed');
  r = plan(app({ typed: '2025-12-05', rows: [{ iso: '2025-12-09', note: '2025-12-09' }] }));
  ok(r.fixes.length === 0 && r.skipped.length === 1 && /not what the import wrote/.test(r.skipped[0].why), 'A person\'s own day (differs from the import\'s note) is NOT touched');
  r = plan(app({ typed: '2025-12-05', rows: [{ iso: '2025-12-09', note: '2025-12-05' }, { iso: '2025-12-11', note: '2025-12-05' }] }));
  ok(r.fixes.length === 0 && /different days/.test(r.skipped[0].why), 'Two sheet rows with two different days = asked, not fixed');
  r = plan(app({ typed: null, rows: [{ iso: '2030-01-01' }] }));
  ok(r.fixes.length === 0 && /outside/.test(r.skipped[0].why), 'A sheet day in the future is left for a person');
  r = plan(app({ typed: null, rows: [{ iso: '2025-03-04' }] }), { humanEdited: new Set(['app' + (n)]) });
  ok(r.fixes.length === 0 && /audit log/.test(r.skipped[0].why), 'An application changed after the import (audit log) is left alone');
  const rowsA = app({ typed: '2026-06-25', rows: [{ iso: '2025-05-05', note: '' }, { kind: 'MONTH-ONLY', month: '2025-06', joined: true, note: '' }] });
  r = plan(rowsA, { importWroteTyped: () => false });
  ok(r.fixes.length === 1 && r.fixes[0].rule === 'LEGACY-YEAR-AS-DAY', 'LEGACY-YEAR-AS-DAY: "June 2025" had been read as 2026-06-25 and the person has one clear day = fixed (even though the import did not write it)');
  r = plan(app({ typed: '2026-06-24', rows: [{ iso: '2025-05-05', note: '' }, { kind: 'MONTH-ONLY', month: '2025-06', joined: true, note: '' }] }), { importWroteTyped: () => false });
  ok(r.fixes.length === 0, 'A 2026-06-24 does not match "June 2025" (would be 25): not treated as the slip');
  r = plan(app({ typed: '2025-12-04', rows: [{ iso: '2025-04-12', note: '2025-12-04' }] }), { importWroteTyped: () => false });
  ok(r.fixes.length === 0 && /undo file/.test(r.skipped[0].why), 'IMPORT-WROTE-IT also needs the import\'s undo file to agree (when it is at hand)');
  r = plan(app({ typed: '2025-04-12', rows: [{ iso: '2025-04-12', note: '2025-04-12' }] }));
  ok(r.fixes.length === 0 && r.skipped.length === 0, 'Already the same day = nothing to do');
  r = plan(app({ typed: null, joinedAt: new Date('2025-03-04T09:00:00Z'), rows: [{ iso: '2025-04-03', note: '2025-03-04' }] }));
  ok(r.fixes.length === 1 && r.fixes[0].rule === 'IMPORT-WROTE-IT', 'The import\'s joined-at (no typed day) on the day of its note and a different sheet day = fixed');
  r = plan(app({ typed: null, joinedAt: new Date('2025-03-04T09:30:00Z'), rows: [{ iso: '2025-04-03', note: '2025-03-04' }] }));
  ok(r.fixes.length === 0, 'A joined-at with a real time (someone moved the person to Joined) is not the import\'s: left alone');
  r = plan(app({ typed: null, rows: [{ kind: 'MONTH-ONLY', month: '2025-06' }] }));
  ok(r.fixes.length === 0, 'A month-only sheet cell never produces a day (no day is invented)');
}

// ------------------------------------------------------------------------------------------------ 3 + 4. on a copy
const run = (args, env = {}) => {
  const r = cp.spawnSync(process.execPath, args, { cwd: BACK, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 1 << 28 });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
};
const FIX = path.join(__dirname, 'fix-joining-dates-from-sheets-2026-10-22.js');

async function snapshot(prisma) {
  const q = async (sql) => (await prisma.$queryRawUnsafe(sql)).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; }); return o; });
  const crypto = require('crypto');
  const h = (rows) => crypto.createHash('sha1').update(JSON.stringify(rows)).digest('hex');
  const app = await q('SELECT * FROM "Application" ORDER BY id');
  const appNoUpd = app.map((r) => { const o = { ...r }; delete o.updatedAt; return o; });
  return {
    appNoUpd: h(appNoUpd), app: h(app), appRows: new Map(app.map((r) => [r.id, r])),
    events: h(await q('SELECT * FROM "ApplicationStageEvent" ORDER BY id')), audit: h(await q('SELECT * FROM "AuditLog" ORDER BY id')), auditCount: (await q('SELECT count(*) n FROM "AuditLog"'))[0].n,
    records: h(await q('SELECT * FROM "JoiningRecord" ORDER BY id')), jevents: h(await q('SELECT * FROM "JoiningEvent" ORDER BY id')),
  };
}

async function dbCases() {
  console.log('3. ON A COPY OF THE DATABASE');
  const { PrismaClient } = require('@prisma/client');
  // a VACUUM copy of the source (the source is only read)
  const base = path.join(WORK, 'ZZTEST-base.db');
  const src = new PrismaClient({ datasources: { db: { url: `file:${SRC_DB.split(path.sep).join('/')}` } } });
  await src.$executeRawUnsafe(`VACUUM INTO ${sqlq(base)}`);
  await src.$disconnect();
  const copy = path.join(WORK, 'ZZTEST-copy.db');
  fs.copyFileSync(base, copy);
  const url = `file:${copy.split(path.sep).join('/')}`;
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const outDry = path.join(WORK, 'ZZTEST-dry'); const outApply = path.join(WORK, 'ZZTEST-apply'); const outTwice = path.join(WORK, 'ZZTEST-twice');
  try {
    const before = await snapshot(prisma);
    // ---- dry run
    let r = run([FIX, '--db', copy, '--out', outDry]);
    ok(r.code === 0 && /DRY RUN/.test(r.out), 'dry run runs and says DRY RUN');
    const sumDry = JSON.parse(fs.readFileSync(path.join(outDry, 'summary.json'), 'utf8'));
    const intended = require('./lib/joining-fields-check-2026-10-22').parseCsv(fs.readFileSync(path.join(outDry, 'intended-changes.csv'), 'utf8'));
    const afterDry = await snapshot(prisma);
    ok(afterDry.app === before.app && afterDry.audit === before.audit && afterDry.events === before.events, 'dry run changed nothing in the database');
    ok(sumDry.corrections === intended.length && intended.length > 0, `dry run plans ${intended.length} corrections (summary agrees)`);
    ok(!fs.existsSync(path.join(outDry, 'undo-manifest.json')), 'dry run writes no undo file and no backup');
    // ---- refused on the real database without the two guards
    r = run([FIX, '--apply', '--out', path.join(WORK, 'ZZTEST-refused')]);
    ok(r.code === 2 && /REFUSED/.test(r.out), 'apply on the real database is refused without --really-real and TL_ALLOW_REAL_APPLY=1');
    // ---- apply on the copy
    const joinedNoDayBefore = async () => {
      const apps = await prisma.application.findMany({ where: { stage: { in: ['JOINED', 'HIRED'] } }, select: { id: true, joiningDate: true, joinedAt: true } });
      const evs = await prisma.applicationStageEvent.findMany({ where: { toStage: { in: ['JOINED', 'HIRED'] } }, select: { applicationId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
      const last = new Map(); evs.forEach((e) => last.set(e.applicationId, e.createdAt));
      return { apps, notRec: apps.filter((a) => !JD.joinDay(a, last.get(a.id))).length, day: (a) => JD.joinDay(a, last.get(a.id)) };
    };
    const nrBefore = (await joinedNoDayBefore()).notRec;
    r = run([FIX, '--db', copy, '--out', outApply, '--apply']);
    ok(r.code === 0 && /APPLIED/.test(r.out), 'apply on the copy works');
    const manifestPath = path.join(outApply, 'undo-manifest.json');
    const man = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    ok(man.status === 'committed' && fs.existsSync(path.join(outApply, 'backup', 'dev.db')), 'backup (VACUUM) taken and undo file says committed');
    const afterApply = await snapshot(prisma);
    const changed = [...afterApply.appRows.keys()].filter((id) => JSON.stringify({ ...afterApply.appRows.get(id), updatedAt: 0 }) !== JSON.stringify({ ...before.appRows.get(id), updatedAt: 0 }));
    eq(changed.sort(), intended.map((x) => x.appId).sort(), 'exactly the planned applications changed - no other application row');
    const cols = new Set();
    changed.forEach((id) => { const a = afterApply.appRows.get(id); const b = before.appRows.get(id); Object.keys(a).forEach((k) => { if (k !== 'updatedAt' && JSON.stringify(a[k]) !== JSON.stringify(b[k])) cols.add(k); }); });
    ok([...cols].every((c) => ['joiningDate', 'joinedAt'].includes(c)), `only joiningDate / joinedAt changed (changed columns: ${[...cols].join(', ')})`);
    ok(changed.every((id) => afterApply.appRows.get(id).updatedAt !== before.appRows.get(id).updatedAt), 'the changed-at time moved on every corrected application (the candidate list notices that)');
    eq(afterApply.auditCount - before.auditCount, intended.length, 'one audit line per corrected application');
    // every corrected person now shows the sheet's day through the shared rule, and the next audit says MATCH
    const nr = await joinedNoDayBefore();
    ok(intended.every((x) => { const a = nr.apps.find((y) => y.id === x.appId); return nr.day(a) === x.new; }), 'the shared joining-day rule (Candidates list, Reports Joined list) now shows the sheet day for each corrected person');
    ok(nr.notRec === nrBefore - intended.filter((x) => !x.old).length, `"Not recorded" joined people: ${nrBefore} -> ${nr.notRec} (expected drop = people who had no day at all: ${intended.filter((x) => !x.old).length})`);
    // ---- apply twice = nothing
    const backupsBefore = fs.readdirSync(WORK).length;
    r = run([FIX, '--db', copy, '--out', outTwice, '--apply']);
    ok(r.code === 0 && /NOTHING TO DO/.test(r.out), 'apply a second time says NOTHING TO DO');
    const again = await snapshot(prisma);
    ok(again.app === afterApply.app && again.audit === afterApply.audit && again.events === afterApply.events && again.records === afterApply.records && again.jevents === afterApply.jevents, 'apply twice: the database is exactly as after the first apply');
    ok(!fs.existsSync(path.join(outTwice, 'backup')) && !fs.existsSync(path.join(outTwice, 'undo-manifest.json')), 'apply twice: no backup and no undo file made');
    ok(fs.readdirSync(WORK).length >= backupsBefore, 'bookkeeping');
    // ---- undo = identical to before
    r = run([FIX, '--db', copy, '--out', path.join(WORK, 'ZZTEST-undo'), '--undo', manifestPath]);
    ok(r.code === 0, 'undo runs');
    const afterUndo = await snapshot(prisma);
    ok(afterUndo.appNoUpd === before.appNoUpd, 'undo: every application column is back as before (the changed-at time is left moved on purpose)');
    ok(afterUndo.audit === before.audit && afterUndo.events === before.events && afterUndo.records === before.records && afterUndo.jevents === before.jevents, 'undo: audit log, history steps and Joining & Drop tables are identical to before');

    // ---- a person's own entry after the import is not touched
    console.log('   - a day typed by a person is protected');
    const target = intended.find((x) => x.rule === 'IMPORT-WROTE-IT');
    if (target) {
      await prisma.application.update({ where: { id: target.appId }, data: { joiningDate: '2024-02-02' } });
      r = run([FIX, '--db', copy, '--out', path.join(WORK, 'ZZTEST-human')]);
      const planned = require('./lib/joining-fields-check-2026-10-22').parseCsv(fs.readFileSync(path.join(WORK, 'ZZTEST-human', 'intended-changes.csv'), 'utf8'));
      const notFixed = require('./lib/joining-fields-check-2026-10-22').parseCsv(fs.readFileSync(path.join(WORK, 'ZZTEST-human', 'not-fixed-and-why.csv'), 'utf8'));
      ok(!planned.some((x) => x.appId === target.appId) && notFixed.some((x) => x.appId === target.appId), 'a day somebody typed after the import is not planned and shows in not-fixed-and-why.csv');
      await prisma.application.update({ where: { id: target.appId }, data: { joiningDate: target.appTyped } });
    }

    // ---- 4. the founder's own list
    console.log('4. THE FOUNDER\'S LIST (--decisions)');
    const nrow = await joinedNoDayBefore();
    const lacking = nrow.apps.filter((a) => !nrow.day(a)).slice(0, 3);
    const notJoined = await prisma.application.findFirst({ where: { stage: 'REJECTED' }, select: { id: true } });
    const dec = path.join(WORK, 'ZZTEST-decisions.csv');
    fs.writeFileSync(dec, `appId,candidate,founderDay\n${lacking.map((a, i) => `${a.id},P${i},${['2025-12-09', '9/12/2025', 'not a day'][i]}`).join('\n')}\n${notJoined.id},Rejected one,2025-01-01\n`);
    const nrBefore2 = nrow.notRec;
    const outDec = path.join(WORK, 'ZZTEST-dec');
    r = run([FIX, '--db', copy, '--out', outDec, '--apply', '--decisions', dec]);
    ok(r.code === 0 && /APPLIED/.test(r.out), 'apply with the founder list works on the copy');
    const nrow2 = await joinedNoDayBefore();
    eq(nrow2.notRec, nrBefore2 - 2, '"Not recorded" drops by 2 (two good days written; "not a day" refused)');
    eq([nrow2.day(nrow2.apps.find((a) => a.id === lacking[0].id)), nrow2.day(nrow2.apps.find((a) => a.id === lacking[1].id))], ['2025-12-09', '2025-12-09'], 'the days 2025-12-09 and 9/12/2025 both read as 9 December 2025 (day first)');
    const notUsed = require('./lib/joining-fields-check-2026-10-22').parseCsv(fs.readFileSync(path.join(outDec, 'decisions-not-used.csv'), 'utf8'));
    ok(notUsed.length === 2 && notUsed.some((x) => /not Joined|REJECTED/i.test(x.why)) && notUsed.some((x) => /not a day/.test(x.why)), 'a person who is not Joined and a text that is not a day are refused and listed');
    const rej = await prisma.application.findUnique({ where: { id: notJoined.id }, select: { joiningDate: true } });
    ok(rej.joiningDate === null || rej.joiningDate !== '2025-01-01', 'the not-Joined person got no joining day');
    // the shared rule through the reports module, for one corrected person (same inputs, the report's own function)
    try {
      process.env.DATABASE_URL = url;
      const PLUS = require('../src/utils/reportsPlus');
      const a = await prisma.application.findUnique({ where: { id: lacking[0].id } });
      eq(PLUS.joinDayOf({ joined: true, a, evs: [] }), '2025-12-09', 'the Reports module (reportsPlus.joinDayOf) gives the same day for that person');
    } catch (e) { ok(false, `reportsPlus could not be loaded: ${e.message}`); }
    // undo of the list run
    const manDec = path.join(outDec, 'undo-manifest.json');
    r = run([FIX, '--db', copy, '--out', path.join(WORK, 'ZZTEST-undo2'), '--undo', manDec]);
    const nrow3 = await joinedNoDayBefore();
    eq(nrow3.notRec, nrBefore2, 'undo of the list run: "Not recorded" is back to the number before');
  } finally {
    await prisma.$disconnect();
  }
}

(async () => {
  try {
    parserCases();
    rulesCases();
    await dbCases();
  } catch (e) {
    fail += 1; console.log('  FAIL  test crashed:', e && e.stack ? e.stack : e);
  } finally {
    try { fs.rmSync(WORK, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log(`\nZZTEST folder removed: ${!fs.existsSync(WORK)}`);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
