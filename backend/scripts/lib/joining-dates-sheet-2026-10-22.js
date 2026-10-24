/* eslint-disable no-console */
// ---------------------------------------------------------------------------
// JOINING DATES vs THE THREE JOININGS SHEETS - shared logic (2026-10-22).
// Used by scripts/joining-dates-sheet-audit.js (reads only), scripts/fix-joining-dates-from-sheets-2026-10-22.js (guarded fix) and
// scripts/joining-dates-sheet-audit-test.js.  Nothing here writes to a database.
//
// THE THREE QUESTIONS, for one source row of a workbook:
//   1. What does the SHEET say?   verdictOf(row) = joined / left / did not join / pipeline stage,  joinCell(row) = the joining cell
//                                  as typed + the day it means (or why it means no day).
//   2. What does the APP hold?    appDay = the one rule utils/joinDayShared.js (typed joining date, else joined-at as an India day,
//                                  else the day of the latest move into Joined).
//   3. Do they agree?             analyse() gives one status per row; planFixes() says which rows are provably wrong AND safe to correct.
// ---------------------------------------------------------------------------
const path = require('path');
const P = require('./joinings-2026-10-17/parse');
const ST = require('./joinings-2026-10-17/status');
const JD = require('../../src/utils/joinDayShared');

const IMPORTER = 'Imported — Joinings sheets 2026-10-17';
const MARK = /\[JNG ([A-Z0-9-]+:\d+)\]/;
const JOINED_STAGES = ['JOINED', 'HIRED'];
const isJoinedStage = (s) => JOINED_STAGES.includes(s);
const { oneLine, t } = P;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
const at = (iso, hh = '09') => new Date(`${iso}T${hh}:00:00Z`);
const dayN = (iso) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const addDays = (iso, n) => new Date((dayN(iso) + n) * 86400000).toISOString().slice(0, 10);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const human = (iso) => (iso && ISO.test(iso) ? `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}` : '');
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthHuman = (ym) => (/^\d{4}-\d{2}$/.test(ym || '') ? `${MONTH_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}` : '');

// ------------------------------------------------------------------------------------------------ the sheet side
// The joining cell of a row: what it says (verbatim), what kind of thing it is, and the day it means.
//   kind  DATE | MONTH-ONLY | TEXT-ONLY | BAD-DATE | BLANK | NO-COLUMN
//   iso   the day (null unless kind is DATE)             ambiguous  true when the cell holds more than one date
//   how   a short note: a month-first cell that was swapped back, a year typo the import repaired, ...
function joinCell(row) {
  const f = row.f;
  const L = row.sheetCfg.cols.join;
  if (!L) return { kind: 'NO-COLUMN', text: '', iso: null, month: null, cell: '', ambiguous: false, how: '' };
  const c = row.cells[L];
  if (!c) return { kind: 'BLANK', text: '', iso: null, month: null, cell: '', ambiguous: false, how: '' };
  const text = t(c.t === 'n' && c.w ? c.w : c.v).replace(/\s*\n\s*/g, ' / ');
  const cell = c.t === 'n' ? `date cell, serial ${c.v}, format ${c.z || 'General'}` : 'text cell';
  const withIso = f.joinDates.filter((d) => d.iso);
  const how = [];
  const sw = f.joinDates.find((d) => d.monthFirstSwapped);
  if (sw) how.push(`month-first cell format: Excel stored ${sw.monthFirstSwapped}, read as day-month = ${sw.iso}`);
  const typo = row.anomalies.find((a) => a.code === 'DATE_YEAR_TYPO');
  if (typo) how.push(typo.text);
  if (f.joinIso) {
    return { kind: 'DATE', text, iso: f.joinIso, month: null, cell, ambiguous: withIso.length > 1, how: how.join('; ') };
  }
  const month = f.joinDates.find((d) => d.month);
  if (month) return { kind: 'MONTH-ONLY', text, iso: null, month: month.month, cell, ambiguous: false, how: 'only a month is written, no day' };
  const bad = f.joinDates.find((d) => d.why);
  if (bad) return { kind: 'BAD-DATE', text, iso: null, month: null, cell, ambiguous: false, how: `not a usable date (${bad.why})` };
  return { kind: 'TEXT-ONLY', text, iso: null, month: null, cell, ambiguous: false, how: 'no date in the words' };
}

// What the row says about the PERSON, by the same rules the importer used (status.js). `unknown` = the importer did not import the row.
function verdictOf(row) {
  const f = row.f;
  const kind = row.kind;
  let s;
  if (kind === 'J' || kind === 'F') {
    s = kind === 'F' ? { joined: true, statusText: f.statusRaw || f.respRaw, note: 'Joined' } : ST.joiningsStatus(f, row, row.sheetCode);
    if (s.unknown) return { unknown: true, says: 'UNKNOWN', text: s.why, joined: false };
    if (s.joined) return { says: s.left ? 'JOINED, THEN LEFT' : 'JOINED', joined: true, left: !!s.left, text: s.statusText || '', note: s.note || '' };
    return { says: 'DID NOT JOIN', joined: false, dnj: true, noProof: s.evidence === 'no proof of joining', text: s.statusText || '', note: s.note || '' };
  }
  if (kind === 'M') {
    s = ST.medicalStatus(f, row);
    if (s.unknown) return { unknown: true, says: 'UNKNOWN', text: s.why, joined: false };
    if (s.joined) return { says: s.left ? 'JOINED, THEN LEFT' : 'JOINED', joined: true, left: !!s.left, text: s.statusText || '', note: s.note || '' };
    return { says: 'DID NOT JOIN', joined: false, dnj: true, noProof: s.evidence === 'no proof of joining', text: s.statusText || '', note: s.note || '' };
  }
  if (kind === 'D') {
    s = ST.docsStatus(f, row);
    if (s.stage === 'JOINED') return { says: 'JOINED', joined: true, text: f.statusRaw || s.text, note: s.text };
    return { says: s.dnj ? 'DID NOT JOIN' : s.stage, joined: false, dnj: !!s.dnj, text: f.statusRaw || s.text, note: s.text };
  }
  s = ST.pipelineStatus(f);
  if (s.unknown) return { unknown: true, says: 'UNKNOWN', text: s.why, joined: false };
  if (s.stage === 'JOINED') return { says: 'JOINED', joined: true, text: s.text, note: s.note || s.text };
  return { says: s.dnj ? 'DID NOT JOIN' : s.stage, joined: false, dnj: !!s.dnj, text: s.text, note: s.note || s.text };
}

// A few rows of a sheet around this one that carry a day: the sheets are kept in date order, so a day far from its neighbours is a
// reading slip (day and month swapped, wrong year ...).  Reported for a person to look at - never changed by the fix.
function neighbourCheck(rows) {
  const bySheet = new Map();
  rows.forEach((r) => { if (!bySheet.has(r.sheetCode)) bySheet.set(r.sheetCode, []); bySheet.get(r.sheetCode).push(r); });
  const out = new Map();
  for (const [code, list] of bySheet) {
    if (!/^(EDU-J22|EDU-2023|EDU-2024|EDU-2025|EDU-BIO24|EDU-2026|MED)$/.test(code)) continue;
    const dated = list.filter((r) => r.f.joinIso).sort((a, b) => a.row - b.row);
    dated.forEach((r, i) => {
      const near = [];
      for (let k = Math.max(0, i - 4); k <= Math.min(dated.length - 1, i + 4); k += 1) if (k !== i) near.push(dayN(dated[k].f.joinIso));
      if (near.length < 4) return;
      near.sort((a, b) => a - b);
      const med = near[Math.floor(near.length / 2)];
      const me = dayN(r.f.joinIso);
      if (Math.abs(me - med) > 75) {
        const [y, m, d] = r.f.joinIso.split('-');
        const alt = `${y}-${d}-${m}`;
        let swapOk = false;
        if (Number(d) <= 12 && d !== m) { const chk = new Date(`${alt}T00:00:00Z`); swapOk = !Number.isNaN(chk.getTime()) && chk.toISOString().slice(0, 10) === alt && Math.abs(dayN(alt) - med) <= 30; }
        out.set(r.id, { days: me - med, swapLooksRight: swapOk ? alt : '' });
      }
    });
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ the database side
const chunks = (arr, n) => { const o = []; for (let i = 0; i < arr.length; i += n) o.push(arr.slice(i, i + n)); return o; };
const rawRows = async (prisma, sql, ...p) => (await prisma.$queryRawUnsafe(sql, ...p).catch(() => [])).map((r) => { const o = {}; Object.keys(r).forEach((k) => { o[k] = typeof r[k] === 'bigint' ? Number(r[k]) : r[k]; }); return o; });

// Everything the audit needs, read once (read only).
async function loadDb(prisma) {
  const fus = await prisma.applicationFollowUp.findMany({ where: { createdByName: { startsWith: 'Imported — Joinings sheets' } } });
  const byMarker = new Map();
  fus.forEach((f) => { const m = MARK.exec(f.notes || ''); if (m) byMarker.set(m[1], f); });
  const markerApps = [...new Set(fus.map((f) => f.applicationId))];
  const sel = { id: true, candidateId: true, requirementId: true, stage: true, joiningDate: true, joinedAt: true, joiningStatus: true, offerStatus: true, offeredCtc: true, offerNotes: true, interviewAt: true, interviewStatus: true, billingStatus: true, documentsStatus: true, createdAt: true, updatedAt: true };
  const joinedApps = await prisma.application.findMany({ where: { stage: { in: JOINED_STAGES } }, select: sel });
  const apps = new Map(joinedApps.map((a) => [a.id, a]));
  const missing = markerApps.filter((id) => !apps.has(id));
  for (const part of chunks(missing, 500)) (await prisma.application.findMany({ where: { id: { in: part } }, select: sel })).forEach((a) => apps.set(a.id, a));
  const appIds = [...apps.keys()];
  // joined moves (latest per app) + the import's own events
  const joinedEvents = new Map(); // appId -> [{ createdAt, actorName, id, fromStage }] oldest first
  for (const part of chunks(appIds, 500)) {
    // eslint-disable-next-line no-await-in-loop
    const evs = await prisma.applicationStageEvent.findMany({ where: { applicationId: { in: part }, toStage: { in: JOINED_STAGES } }, orderBy: { createdAt: 'asc' }, select: { id: true, applicationId: true, createdAt: true, actorName: true, fromStage: true, toStage: true } });
    evs.forEach((e) => { if (!joinedEvents.has(e.applicationId)) joinedEvents.set(e.applicationId, []); joinedEvents.get(e.applicationId).push(e); });
  }
  const reqIds = [...new Set([...apps.values()].map((a) => a.requirementId))];
  const reqs = new Map();
  for (const part of chunks(reqIds, 500)) (await prisma.requirement.findMany({ where: { id: { in: part } }, select: { id: true, title: true, clientId: true, department: true } })).forEach((r) => reqs.set(r.id, r));
  const clientIds = [...new Set([...reqs.values()].map((r) => r.clientId).filter(Boolean))];
  const clients = new Map();
  for (const part of chunks(clientIds, 500)) (await prisma.client.findMany({ where: { id: { in: part } }, select: { id: true, name: true, ownerDepartment: true } })).forEach((c) => clients.set(c.id, c));
  const candIds = [...new Set([...apps.values()].map((a) => a.candidateId))];
  const cands = new Map();
  for (const part of chunks(candIds, 500)) (await prisma.candidate.findMany({ where: { id: { in: part } }, select: { id: true, name: true, phone: true, education: true, specialization: true, experienceYears: true, currentDesignation: true, createdAt: true } })).forEach((c) => cands.set(c.id, c));
  const records = new Map(); // applicationId -> JoiningRecord rows
  (await rawRows(prisma, 'SELECT * FROM "JoiningRecord"')).forEach((r) => { if (!records.has(r.applicationId)) records.set(r.applicationId, []); records.get(r.applicationId).push(r); });
  const importAudit = await prisma.auditLog.findFirst({ where: { entityId: 'import-joinings-2026-10-17' }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } });
  return { fus, byMarker, apps, joinedEvents, reqs, clients, cands, records, importedAt: importAudit ? importAudit.createdAt : null };
}

// The day the app holds for a JOINED application, and where it comes from.
function appDayOf(db, app) {
  if (!app) return { day: null, source: '' };
  const evs = db.joinedEvents.get(app.id) || [];
  const latest = evs.length ? evs[evs.length - 1] : null;
  const typed = JD.typedDay(app.joiningDate);
  let source = '';
  if (typed) source = 'joining date typed on the application';
  else if (app.joinedAt && JD.istDay(app.joinedAt)) source = 'joined-at time';
  else if (latest) source = latest.actorName === IMPORTER ? 'day of the Joined step written by the sheets import' : 'day the application was moved to Joined';
  const day = JD.joinDay(app, latest ? latest.createdAt : null);
  return { day, source, typed, joinedAtDay: app.joinedAt ? JD.istDay(app.joinedAt) : null, eventDay: latest ? JD.istDay(latest.createdAt) : null, eventByImport: !!latest && latest.actorName === IMPORTER };
}

// What the import wrote about the joining date of this row (the follow-up note carries "Joined / joining date read as YYYY-MM-DD").
const noteJoin = (fu) => ((/Joined \/ joining date read as (\d{4}-\d{2}-\d{2})/.exec((fu && fu.notes) || '') || [])[1]) || null;

const diffKind = (appDay, sheetIso) => {
  const days = dayN(sheetIso) - dayN(appDay);
  const [ay, am, ad] = appDay.split('-'); const [sy, sm, sd] = sheetIso.split('-');
  if (ay === sy && am === sd && ad === sm) return { kind: 'DAY AND MONTH SWAPPED', days };
  if (am === sm && ad === sd && ay !== sy) return { kind: 'SAME DAY AND MONTH, OTHER YEAR', days };
  if (Math.abs(days) <= 7) return { kind: 'WITHIN A WEEK', days };
  return { kind: 'DIFFERENT DAY', days };
};

// ------------------------------------------------------------------------------------------------ the audit of every row
const STATUS = {
  MATCH: 'MATCH',
  MISSING: 'DATE-MISSING-IN-APP',
  DIFFERENT: 'DATE-DIFFERENT',
  NOT_JOINED: 'STAGE-NOT-JOINED-BUT-SHEET-SAYS-JOINED',
  NOT_FOUND: 'NOT-FOUND',
  NO_SHEET_DATE: 'SHEET-HAS-NO-DATE',
  CONFLICT: 'APP-JOINED-BUT-SHEET-SAYS-NOT',
  NOT_A_JOINING: 'NOT-A-JOINING-ROW',
  EARLIER_STEP: 'ROW-IS-AN-EARLIER-STEP',
};
// words of the pipeline sheets that say "not joined YET" (the person may have joined since)
const LEGACY_YEAR = '2026';
const STILL_COMING =new Set(['OFFER_ACCEPTED', 'SELECTED', 'INTERVIEW_COMPLETED', 'INTERVIEW_SCHEDULED', 'HOLD']);

function analyse({ parsed, db }) {
  const near = neighbourCheck(parsed.rows);
  // all sheet rows of one application (several sheets can carry the same person)
  const rowsOfApp = new Map();
  parsed.rows.forEach((r) => { const fu = db.byMarker.get(r.id); if (fu) { if (!rowsOfApp.has(fu.applicationId)) rowsOfApp.set(fu.applicationId, []); rowsOfApp.get(fu.applicationId).push(r); } });
  const out = [];
  for (const r of parsed.rows) {
    let v = verdictOf(r);
    const jc = joinCell(r);
    const fu = db.byMarker.get(r.id) || null;
    const app = fu ? db.apps.get(fu.applicationId) || null : null;
    // "Drop" with nothing on the row that proves the person joined: the import reads it as "did not join" - unless the application itself
    // already says Joined, then it reads it as "joined, then left" (plan-joinings.js line ~294). Same here.
    if (!v.unknown && !v.joined && v.noProof && app && isJoinedStage(app.stage)) v = { ...v, joined: true, left: true, dnj: false, says: 'JOINED, THEN LEFT', readAsJoined: true, note: 'Drop - the application is already Joined in the app, so read as: joined, then left' };
    const cand = app ? db.cands.get(app.candidateId) || null : null;
    const req = app ? db.reqs.get(app.requirementId) || null : null;
    const client = req ? db.clients.get(req.clientId) || null : null;
    const day = app ? appDayOf(db, app) : { day: null, source: '' };
    const rec = {
      id: r.id, sheet: r.sheetCode, sheetName: r.sheetLabel, row: r.row, hidden: r.hidden ? 'yes' : '', name: oneLine(r.f.nameRaw), clientSheet: r.f.clientRaw, clientApp: client ? client.name : '',
      sheetJoinText: jc.text, sheetJoinKind: jc.kind, sheetJoinIso: jc.iso || '', sheetJoinMonth: jc.month || '', sheetJoinCell: jc.cell, sheetJoinNote: jc.how, ambiguous: jc.ambiguous,
      sheetSays: v.says, sheetStatusText: oneLine(v.text || ''), sheetNote: v.note || '',
      appId: app ? app.id : '', candidateId: app ? app.candidateId : '', appCandidate: cand ? cand.name : '', appStage: app ? app.stage : '', appJoiningStatus: app ? app.joiningStatus || '' : '',
      appDay: day.day || '', appDaySource: day.source, appTyped: app && app.joiningDate ? app.joiningDate : '', appJoinedAt: app && app.joinedAt ? app.joinedAt.toISOString() : '',
      importNoteJoin: noteJoin(fu) || '', status: '', reason: '', detail: '', neighbour: near.has(r.id) ? near.get(r.id) : null,
      // for the fix
      _app: app, _fu: fu, _day: day, _verdict: v, _jc: jc,
    };
    if (v.unknown) {
      rec.status = STATUS.NOT_FOUND; rec.reason = `row not imported: needs your decision (${v.text})`;
    } else if (!fu && !r.f.nameRaw) {
      rec.status = STATUS.NOT_FOUND; rec.reason = 'row has no candidate name (blank row), nothing imported';
    } else if (!fu) {
      rec.status = STATUS.NOT_FOUND; rec.reason = 'no import marker for this row in the database';
    } else if (!app) {
      rec.status = STATUS.NOT_FOUND; rec.reason = 'the import marker points to an application that is gone';
    } else if (v.joined) {
      if (v.readAsJoined) rec.sheetNote = v.note;
      if (!isJoinedStage(app.stage)) {
        rec.status = STATUS.NOT_JOINED; rec.reason = `sheet says ${v.says}; the application is "${app.stage}" in the app (the import never moves a final stage backwards)`;
      } else if (jc.kind !== 'DATE') {
        rec.status = STATUS.NO_SHEET_DATE;
        rec.reason = jc.kind === 'BLANK' ? 'the joining cell is empty in the sheet' : jc.kind === 'MONTH-ONLY' ? `the sheet gives only a month (${monthHuman(jc.month)}), no day` : jc.kind === 'NO-COLUMN' ? 'this sheet has no joining-date column' : `the sheet gives no usable day: "${jc.text}"${jc.how ? ` (${jc.how})` : ''}`;
      } else if (!day.day) {
        rec.status = STATUS.MISSING; rec.reason = `the sheet says ${human(jc.iso)}; the application has no joining day at all`;
      } else if (day.day === jc.iso) {
        rec.status = STATUS.MATCH; rec.reason = 'same day';
      } else {
        const dk = diffKind(day.day, jc.iso);
        rec.status = STATUS.DIFFERENT; rec.reason = `sheet ${jc.iso}, app ${day.day} (${dk.kind}, ${Math.abs(dk.days)} days apart)`;
        rec.detail = dk.kind;
      }
      if (rec.status !== STATUS.MATCH && jc.ambiguous) rec.reason += '; the sheet cell holds more than one date';
    } else if (isJoinedStage(app.stage)) {
      const others = (rowsOfApp.get(app.id) || []).filter((o) => o.id !== r.id);
      const otherSaysJoined = others.find((o) => verdictOf(o).joined);
      if (STILL_COMING.has(v.says) || otherSaysJoined) {
        rec.status = STATUS.EARLIER_STEP;
        rec.reason = `sheet row says ${v.says} ("${oneLine(v.text || '')}"), an earlier step; ${otherSaysJoined ? `another row of the same person (${otherSaysJoined.id}) says joined` : 'the app has since moved the person to Joined'}${jc.iso ? `; this row's day ${jc.iso} ${day.day === jc.iso ? 'is the same as' : 'differs from'} the app day ${day.day || 'none'}` : ''}`;
      } else {
        rec.status = STATUS.CONFLICT; rec.reason = `sheet says ${v.says} ("${oneLine(v.text || '')}")${v.dnj ? ', and the notes say the person did not join' : ''}; the application is ${app.stage} in the app`;
      }
    } else {
      rec.status = STATUS.NOT_A_JOINING; rec.reason = `sheet says ${v.says}; the application is ${app.stage}: no joining day to compare`;
    }
    out.push(rec);
  }
  // what kind of difference is it?
  const byApp = new Map();
  out.forEach((r) => { if (r.appId) { if (!byApp.has(r.appId)) byApp.set(r.appId, []); byApp.get(r.appId).push(r); } });
  out.forEach((r) => {
    if (r.status !== STATUS.DIFFERENT && r.status !== STATUS.MISSING) return;
    const mates = (byApp.get(r.appId) || []).filter((o) => o !== r);
    const agree = mates.find((o) => o.status === STATUS.MATCH && o._verdict.joined);
    if (r.status === STATUS.MISSING) r.differentKind = 'APP HAS NO DAY';
    else if (agree) r.differentKind = `APP AGREES WITH ANOTHER ROW OF THE SAME PERSON (${agree.id})`;
    else if (r.importNoteJoin && r.importNoteJoin === r.appDay) r.differentKind = 'IMPORT WROTE THE APP DAY (sheet reads differently now)';
    else if ((byApp.get(r.appId) || []).some((o) => o._jc.kind === 'MONTH-ONLY' && o._jc.month && r.appTyped === `${LEGACY_YEAR}-${o._jc.month.slice(5, 7)}-${o._jc.month.slice(2, 4)}`)) r.differentKind = 'APP DAY IS A SLIP OF THE SEPTEMBER CONVERSION (a month-only cell read as a day of 2026)';
    else r.differentKind = 'APP HAS ITS OWN DAY (not written by the import)';
  });
  return { rows: out, rowsOfApp };
}

// ------------------------------------------------------------------------------------------------ what can be fixed
// A row is fixed ONLY when ALL of these hold (the founder's rule: the sheet has one clear day, and the app's own value is empty or is
// exactly what the import wrote - never a day somebody typed afterwards):
//   * the sheet says the person joined (or joined and left), the joining cell holds ONE clear day, and the application is Joined;
//   * every OTHER sheet row of the same application that also carries a clear day gives the SAME day (else it is a conflict: asked, not fixed);
//   * the app holds NO joining day at all (nothing typed, no joined-at, no Joined step)      -> rule EMPTY
//     or the day the app shows is exactly what the import wrote (its note, its joined-at, its Joined step) -> rule IMPORT-WROTE-IT
//   * the day is a real date in 2015..today (a joining in the future is left for a person).
// Only application.joiningDate (+ the Joining & Drop record's joined-on when it holds the old day / nothing) is changed.
//   * nobody has touched the joining date since the import: no audit-log line about it after the import (humanEdited), and - when the
//     import's own undo file is at hand - the typed day is in that file as written by the import (importWroteTyped).
function planFixes(analysis, { today = new Date().toISOString().slice(0, 10), humanEdited = new Set(), importWroteTyped = null } = {}) {
  const fixes = []; const skipped = [];
  const byApp = new Map();
  analysis.rows.forEach((r) => { if (r.appId) { if (!byApp.has(r.appId)) byApp.set(r.appId, []); byApp.get(r.appId).push(r); } });
  for (const [appId, list] of byApp) {
    const wrong = list.filter((r) => [STATUS.MISSING, STATUS.DIFFERENT].includes(r.status) && !r.ambiguous);
    if (!wrong.length) continue;
    const app = wrong[0]._app;
    const clear = list.filter((r) => r._verdict.joined && r._jc.kind === 'DATE' && !r._jc.ambiguous);
    const days = [...new Set(clear.map((r) => r._jc.iso))];
    const ev = wrong[0];
    const base = { appId, candidateId: app.candidateId, candidate: ev.appCandidate || ev.name, client: ev.clientApp, rows: list.map((r) => r.id).join(' + '), evidence: `${ev.id} cell "${ev.sheetJoinText}" (${ev.sheetJoinCell})`, old: ev.appDay || '', appTyped: app.joiningDate || '' };
    if (days.length !== 1) { skipped.push({ ...base, new: days.join(' / '), why: 'the sheet rows of this person give different days - a person has to choose' }); continue; }
    const want = days[0];
    if (!(want >= '2015-01-01' && want <= today)) { skipped.push({ ...base, new: want, why: 'the sheet day is outside 2015..today - left for a person' }); continue; }
    const cur = ev._day;
    const wroteDays = new Set(list.map((r) => r.importNoteJoin).filter(Boolean));
    let rule = null;
    if (!cur.day) rule = 'EMPTY';
    else {
      // the app's day is exactly what the import wrote: the typed day equals the day in the note, or (no typed day) the joined-at / Joined step
      // was written by the import and sits on the day of its note
      const typedIsImport = cur.typed && wroteDays.has(cur.typed);
      const joinedAtIsImport = !cur.typed && cur.joinedAtDay && wroteDays.has(cur.joinedAtDay) && app.joinedAt && app.joinedAt.getTime() === at(cur.joinedAtDay).getTime();
      const eventIsImport = !cur.typed && !cur.joinedAtDay && cur.eventByImport && wroteDays.has(cur.eventDay);
      if (typedIsImport || joinedAtIsImport || eventIsImport) rule = 'IMPORT-WROTE-IT';
    }
    // The September 2026 conversion read a month-only cell "June 2025" as day 25 of the CURRENT year (2026-06-25); "December 2024" became
    // 2026-12-24. A typed day that is exactly that pattern for a month-only cell of this very person is that slip, not a person's entry.
    if (!rule && cur.typed) {
      const artefacts = new Set(list.filter((r) => r._jc.kind === 'MONTH-ONLY' && r._jc.month).map((r) => `${LEGACY_YEAR}-${r._jc.month.slice(5, 7)}-${r._jc.month.slice(2, 4)}`));
      if (artefacts.has(cur.typed) && cur.typed.slice(0, 4) !== want.slice(0, 4)) rule = 'LEGACY-YEAR-AS-DAY';
    }
    if (!rule) { skipped.push({ ...base, new: want, why: `the app's day ${cur.day} (${cur.source}) is not what the import wrote - it may be a person's own entry, so it is left as it is` }); continue; }
    if (humanEdited.has(appId)) { skipped.push({ ...base, new: want, why: 'the audit log has a change of this application after the import - left for a person' }); continue; }
    if (rule === 'IMPORT-WROTE-IT' && cur.typed && importWroteTyped && importWroteTyped(appId, cur.typed) === false) { skipped.push({ ...base, new: want, why: 'the import\'s undo file does not show that it wrote this day - left for a person' }); continue; }
    fixes.push({ ...base, new: want, rule, why: rule === 'EMPTY' ? 'the application has no joining day; the sheet has one' : (rule === 'LEGACY-YEAR-AS-DAY' ? `the app day ${cur.day} is the September conversion's slip (a month-only cell read as a day of 2026); the sheet reads ${want}` : `the app day ${cur.day} is what the import wrote; the sheet reads ${want}`), kind: ev.detail || 'MISSING', changeTyped: cur.typed !== want });
  }
  return { fixes, skipped };
}

module.exports = {
  IMPORTER, MARK, STATUS, JOINED_STAGES, isJoinedStage, joinCell, verdictOf, neighbourCheck, loadDb, appDayOf, noteJoin, diffKind, analyse, planFixes,
  human, monthHuman, at, addDays, dayN, chunks, rawRows,
};
