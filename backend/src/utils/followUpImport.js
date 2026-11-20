// ---------------------------------------------------------------------------
// IMPORT FOLLOW-UPS FROM A SHEET (founder 2026-11-20, the Overall report: "give import & export options"). The teams kept their
// candidate follow-ups in Excel before TeamLink; this brings those rows in so they count in the follow-up report.
//
//   template()                          an .xlsx with the columns and two example rows
//   preview(user, file, { mapping })    reads the sheet, resolves every row, stores the batch (nothing is written to the follow-ups)
//   check(user, batchId, choices)       the same answer again with the person's choices (a row with several matches)
//   apply(user, batchId, choices)       writes the Ready rows as ApplicationFollowUp, one batch
//   batches(user) / undo(user, id)      the recent imports; undo removes exactly that batch's rows that nobody edited since
//
// EACH ROW becomes ONE follow-up on ONE application of the candidate, always INSIDE the importing login's scope:
//   the recruiter   by employee code, e-mail or name, and only a person of the login's report scope (utils/followUpScope.js: a TL their
//                   team, an STL their TLs' teams, a Manager / Admin everyone; a recruiter only themselves)
//   the candidate   by candidate ID, phone, e-mail or name; only candidates with an application the login may see (scope.applicationWhere)
//   the application the requirement given (REQ code or title), else the candidate's application owned by that recruiter, else their latest
// The row is written the way the earlier sheet imports were (scripts/import-edu-joinings-2026-11.js): no createdById and a createdByName
// starting "Imported - ", which is the report's imported marker (utils/followUpReport.js isImportedTask): counted for the owner on the
// sheet's own date and switched with "imported include / exclude / only". createdAt = the sheet date at 12:00 IST.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const XLSX = require('xlsx');
const prisma = require('../db');
const FS = require('./followUpScope');
const S = require('./scope');
const { parseCameDate } = require('./importDates');
const { phoneKeys, emailKey } = require('./candidateDedupe');

const MAX_ROWS = 5000;
const MAX_BYTES = 5 * 1024 * 1024;
const IMPORTER = 'Imported - follow-up sheet';
const IMPORT_KINDS = ['admin', 'mgmt', 'stl', 'tl', 'recruiter'];
const IST = 330 * 60000;
const istDay = (v) => new Date(new Date(v).getTime() + IST).toISOString().slice(0, 10);
const todayIst = () => istDay(Date.now());
const hkey = (v) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
const squash = (v) => String(v ?? '').replace(/\s+/g, ' ').trim();
const low = (v) => squash(v).toLowerCase();
const dmy = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const newId = (p = 'c') => `${p}${Date.now().toString(36)}${crypto.randomBytes(9).toString('hex')}`;
const chunks = (list, n = 400) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

class ImportError extends Error { constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; } }

// ---- the columns ---------------------------------------------------------------------------------------------------
const COLUMNS = [
  { key: 'date', label: 'Date', need: true, help: 'The day of the follow-up. 12/03/2026, 12-03-2026, 12-Mar-26 and Excel dates all work (day first).',
    aliases: ['date', 'followupdate', 'dateoffollowup', 'calldate', 'dateofcall', 'calledon', 'contactdate', 'dateofcontact', 'contactedon', 'day', 'on', 'dt'] },
  { key: 'recruiter', label: 'Recruiter', need: true, help: 'The recruiter who did it: name, e-mail or employee code as in TeamLink. A recruiter importing their own sheet may leave it empty.',
    aliases: ['recruiter', 'recruitername', 'recruiteremail', 'recruitermail', 'recruitercode', 'recruiterid', 'employeecode', 'empcode', 'empid', 'employeeid', 'nameofrecruiter', 'calledby', 'doneby', 'by', 'owner', 'executive', 'hrname', 'spoc'] },
  { key: 'candidate', label: 'Candidate', need: true, help: 'Candidate ID, phone, e-mail or name. Phone or candidate ID is the surest.',
    aliases: ['candidate', 'candidatename', 'candidateid', 'nameofcandidate', 'name', 'candidatedetails', 'candidatecontact'] },
  { key: 'phone', label: 'Candidate phone', hidden: true, help: 'Optional: the candidate\'s phone, when the sheet has it in its own column.',
    aliases: ['phone', 'mobile', 'mobileno', 'phoneno', 'phonenumber', 'mobilenumber', 'contact', 'contactno', 'contactnumber', 'candidatephone', 'candidatemobile', 'number', 'cell'] },
  { key: 'email', label: 'Candidate e-mail', hidden: true, help: 'Optional: the candidate\'s e-mail, when the sheet has it in its own column.',
    aliases: ['email', 'emailid', 'mailid', 'mail', 'emailaddress', 'candidateemail', 'candidatemail'] },
  { key: 'requirement', label: 'Requirement', help: 'Optional: the REQ code or the job title. Empty = the candidate\'s application with that recruiter, else their latest.',
    aliases: ['requirement', 'req', 'reqcode', 'reqid', 'requirementcode', 'requirementid', 'job', 'jobcode', 'jobtitle', 'position', 'role', 'opening', 'profile', 'designation'] },
  { key: 'what', label: 'What happened', need: true, help: 'What was said or done. Must not be empty.',
    aliases: ['whathappened', 'notes', 'note', 'remarks', 'remark', 'comments', 'comment', 'followup', 'followupnotes', 'followupremarks', 'discussion', 'summary', 'feedback', 'details', 'statusupdate', 'update', 'conversation'] },
  { key: 'callBack', label: 'Call back on', help: 'Optional: the day to call back.',
    aliases: ['callbackon', 'callback', 'callbackdate', 'callbackday', 'nextfollowup', 'nextfollowupdate', 'nextfollowupon', 'nextdate', 'followupon', 'nextcall', 'nextcalldate', 'reminder', 'reminderdate'] },
  { key: 'answer', label: 'Answer', help: 'Optional: Interested, Not interested or No answer.',
    aliases: ['answer', 'outcome', 'result', 'response', 'callstatus', 'callresult', 'callresponse', 'interest', 'interested', 'candidatestatus', 'status'] },
  { key: 'done', label: 'Done', help: 'Optional: yes or no. Empty = done, unless the call-back day is today or later.',
    aliases: ['done', 'completed', 'closed', 'isdone', 'followupdone', 'statusdone'] },
];
const COL = Object.fromEntries(COLUMNS.map((c) => [c.key, c]));
const GUIDE_SHEETS = ['howtofill', 'instructions', 'readme', 'lists', 'help', 'guide'];

// ---- the tables (raw SQL, made on first use) ------------------------------------------------------------------------
let READY = null;
const TABLES = [
  `CREATE TABLE IF NOT EXISTS "FollowUpImportBatch" ("id" TEXT PRIMARY KEY, "byUserId" TEXT NOT NULL, "byName" TEXT, "byKind" TEXT, "fileName" TEXT,
    "createdAt" TEXT NOT NULL, "status" TEXT NOT NULL, "totalRows" INTEGER NOT NULL DEFAULT 0, "readyRows" INTEGER NOT NULL DEFAULT 0,
    "choiceRows" INTEGER NOT NULL DEFAULT 0, "refusedRows" INTEGER NOT NULL DEFAULT 0, "createdRows" INTEGER NOT NULL DEFAULT 0, "appliedAt" TEXT,
    "undoneAt" TEXT, "undoneByName" TEXT, "undoneRows" INTEGER NOT NULL DEFAULT 0, "keptRows" INTEGER NOT NULL DEFAULT 0, "payload" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "FollowUpImportBatch_by" ON "FollowUpImportBatch" ("byUserId", "status")',
  `CREATE TABLE IF NOT EXISTS "FollowUpImportRow" ("id" TEXT PRIMARY KEY, "batchId" TEXT NOT NULL, "followUpId" TEXT NOT NULL, "rowNo" INTEGER,
    "candidateId" TEXT, "ownerUserId" TEXT, "day" TEXT, "fingerprint" TEXT NOT NULL, "removedAt" TEXT)`,
  'CREATE INDEX IF NOT EXISTS "FollowUpImportRow_batch" ON "FollowUpImportRow" ("batchId")',
  'CREATE INDEX IF NOT EXISTS "FollowUpImportRow_fu" ON "FollowUpImportRow" ("followUpId")',
];
function ensure() {
  if (!READY) {
    READY = (async () => {
      for (const sql of TABLES) await prisma.$executeRawUnsafe(sql); // eslint-disable-line no-await-in-loop
      return true;
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

// ---- who may import -------------------------------------------------------------------------------------------------
function kindOf(user) { return FS.viewerKind(user); }
function mayImport(user) { return IMPORT_KINDS.includes(kindOf(user)); }
function assertMay(user) {
  if (!mayImport(user)) throw new ImportError(403, 'Importing follow-ups is for the recruiting team: Admin, Manager, STL, TL, and recruiters for their own follow-ups.');
}

// ---- the template ---------------------------------------------------------------------------------------------------
function template() {
  const wb = XLSX.utils.book_new();
  const main = COLUMNS.filter((c) => !c.hidden);
  const d1 = new Date(Date.now() - 2 * 86400000); const d2 = new Date(Date.now() - 86400000);
  const day = (d) => dmy(istDay(d));
  const ws = XLSX.utils.aoa_to_sheet([
    main.map((c) => c.label),
    [day(d1), 'Recruiter name or e-mail or employee code', '9876543210', 'REQ-0001', 'Example - Called, interested, will send the updated CV tonight', day(d2), 'Interested', 'Yes'],
    [day(d2), 'Recruiter name or e-mail or employee code', 'candidate@example.com', '', 'Example - Did not pick up, call again tomorrow', '', 'No answer', 'No'],
  ]);
  ws['!cols'] = [{ wch: 12 }, { wch: 28 }, { wch: 26 }, { wch: 16 }, { wch: 60 }, { wch: 14 }, { wch: 16 }, { wch: 8 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Follow-ups');
  const guide = XLSX.utils.aoa_to_sheet([
    ['Column', 'What to write'],
    ...COLUMNS.map((c) => [c.label + (c.need ? ' (needed)' : ' (optional)'), c.help]),
    [],
    ['Rows', `At most ${MAX_ROWS.toLocaleString('en-IN')} rows and 5 MB per file. Rows whose "What happened" starts with "Example" are skipped.`],
    ['Nothing is saved', 'until you check the preview and press Apply. Every import can be undone.'],
  ]);
  guide['!cols'] = [{ wch: 26 }, { wch: 110 }];
  XLSX.utils.book_append_sheet(wb, guide, 'How to fill');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

// ---- reading the file -----------------------------------------------------------------------------------------------
function readWorkbook(file) {
  const buf = file.data;
  if (!buf || !buf.length) throw new ImportError(400, 'Choose the sheet to import.');
  if (buf.length > MAX_BYTES) throw new ImportError(413, 'That file is over 5 MB. Split it into smaller files.');
  const head = buf.slice(0, 5).toString('latin1');
  if (head.startsWith('%PDF')) throw new ImportError(400, 'That is a PDF. Choose an Excel (.xlsx / .xls) or CSV file - download the template if you need one.');
  const bin = head.startsWith('PK') || buf.slice(0, 4).toString('hex') === 'd0cf11e0';
  try {
    return bin ? XLSX.read(buf, { type: 'buffer', cellDates: false }) : XLSX.read(buf.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true });
  } catch {
    throw new ImportError(400, 'That file could not be read as a spreadsheet. Save it as .xlsx or .csv and try again.');
  }
}

function autoMap(cells, override) {
  const keys = cells.map((h) => hkey(h));
  const map = {}; const used = new Set();
  const claim = (k, i) => { map[k] = i; used.add(i); };
  if (override && typeof override === 'object') {
    COLUMNS.forEach((c) => {
      if (!(c.key in override)) return;
      const n = Number(override[c.key]);
      if (override[c.key] === null || override[c.key] === '' || n < 0) { map[c.key] = null; return; }
      if (Number.isInteger(n) && n < cells.length && !used.has(n)) claim(c.key, n);
    });
  }
  COLUMNS.forEach((c) => { if (c.key in map) return; const i = keys.findIndex((k, idx) => k && !used.has(idx) && k === hkey(c.label)); if (i >= 0) claim(c.key, i); });
  COLUMNS.forEach((c) => { if (c.key in map) return; const i = keys.findIndex((k, idx) => k && !used.has(idx) && c.aliases.includes(k)); if (i >= 0) claim(c.key, i); });
  return map;
}
const mapScore = (cells) => Object.values(autoMap(cells, null)).filter((v) => Number.isInteger(v)).length;

const cellText = (v) => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  return squash(v);
};

/** file -> { sheet, headerRow, fileColumns, mapping, missing, rows: [{ row, ...fields }] } */
function readSheet(file, { mapping, sheet: asked, recruiterLogin }) {
  const wb = readWorkbook(file);
  const names = wb.SheetNames || [];
  const sheetName = (asked && names.includes(asked)) ? asked : (names.find((n) => hkey(n) === 'followups') || names.find((n) => !GUIDE_SHEETS.includes(hkey(n))) || names[0]);
  const xs = wb.Sheets[sheetName];
  if (!xs || !xs['!ref']) throw new ImportError(400, 'That sheet is empty.');
  const range = XLSX.utils.decode_range(xs['!ref']);
  const grid = XLSX.utils.sheet_to_json(xs, { header: 1, raw: true, defval: '', blankrows: true });
  let best = { idx: 0, score: -1 };
  for (let i = 0; i < Math.min(15, grid.length); i += 1) {
    const sc = mapScore(grid[i] || []);
    if (sc > best.score) best = { idx: i, score: sc };
  }
  const header = (grid[best.idx] || []).map((h) => squash(h));
  const map = autoMap(header, mapping);
  const fileColumns = header.map((name, index) => ({ index, name: name || `Column ${XLSX.utils.encode_col(index)}` }));
  const has = (k) => Number.isInteger(map[k]);
  const missing = [];
  if (!has('date')) missing.push('Date');
  if (!has('candidate') && !has('phone') && !has('email')) missing.push('Candidate');
  if (!has('what')) missing.push('What happened');
  if (!has('recruiter') && !recruiterLogin) missing.push('Recruiter');
  const rows = [];
  const data = grid.slice(best.idx + 1);
  const firstRow = range.s.r + 1 + best.idx + 1;
  data.forEach((cells, i) => {
    if (!cells || cells.every((v) => cellText(v) === '')) return;
    const get = (k) => (has(k) ? cells[map[k]] : '');
    rows.push({
      row: firstRow + i,
      dateRaw: get('date'), recruiter: cellText(get('recruiter')), candidate: cellText(get('candidate')), phone: cellText(get('phone')), email: cellText(get('email')),
      requirement: cellText(get('requirement')), what: String(get('what') ?? '').trim(), callBackRaw: get('callBack'), answer: cellText(get('answer')), done: cellText(get('done')),
    });
  });
  if (rows.length > MAX_ROWS) throw new ImportError(400, `That sheet has ${rows.length.toLocaleString('en-IN')} rows. At most ${MAX_ROWS.toLocaleString('en-IN')} at a time - split the file.`);
  return {
    sheet: sheetName, sheets: names, headerRow: range.s.r + 1 + best.idx, fileColumns,
    mapping: COLUMNS.map((c) => ({ key: c.key, label: c.label, need: !!c.need && !(c.key === 'recruiter' && recruiterLogin), optional: !!c.hidden, column: has(c.key) ? map[c.key] : null, columnName: has(c.key) ? fileColumns[map[c.key]].name : null })),
    missing, rows,
  };
}

// ---- reading each value -----------------------------------------------------------------------------------------------
const FAR = Date.parse('2999-01-01T00:00:00Z');
function parseRow(r) {
  const out = { row: r.row, recruiter: r.recruiter, candidate: r.candidate, phone: r.phone, email: r.email, requirement: r.requirement, what: r.what, answerRaw: r.answer, doneRaw: r.done };
  const d = parseCameDate(r.dateRaw);
  out.date = d.ok ? { day: d.day } : { error: d.ok === null ? 'empty' : d.reason, message: d.message || null };
  const cb = parseCameDate(r.callBackRaw, { now: FAR });
  out.callBack = cb.ok ? { day: cb.day } : cb.ok === null ? null : { error: 'bad', message: cb.message };
  return out;
}
function answerOf(raw) {
  const t = low(raw);
  if (!t) return null;
  if (/^(not\s*interested|ni|no\s*interest|not\s*intrested|negative|declined|rejected)\b/.test(t)) return 'Not interested';
  if (/^(no\s*answer|na|rnr|np|no\s*response|not\s*(picked|answered|reachable|responding)|busy|switched\s*off|wrong\s*number|unreachable|ringing|call\s*not\s*connected)\b/.test(t)) return 'No answer';
  if (/^(interested|yes|intrested|positive|ok|okay)\b/.test(t)) return 'Interested';
  return squash(raw).slice(0, 80); // kept as written; not counted in the answer columns
}
function doneOf(raw) {
  const t = low(raw);
  if (!t) return null;
  if (/^(yes|y|true|1|done|completed|complete|closed)$/.test(t)) return true;
  if (/^(no|n|false|0|open|pending|not\s*done)$/.test(t)) return false;
  return 'bad';
}

// ---- who is who -------------------------------------------------------------------------------------------------------
async function peopleIndex(user) {
  const kind = kindOf(user);
  const scope = await FS.resolve(user, {});
  if (!scope.ok) throw new ImportError(scope.status, scope.error);
  const members = new Map(scope.members.map((m) => [m.id, m]));
  const all = await prisma.user.findMany({ select: { id: true, name: true, email: true, username: true, atsRole: true, employee: { select: { employeeCode: true } } } });
  const by = { code: new Map(), email: new Map(), name: new Map() };
  const add = (m, k, u) => { if (!k) return; if (!m.has(k)) m.set(k, []); if (!m.get(k).includes(u)) m.get(k).push(u); };
  all.forEach((u) => {
    add(by.code, low(u.employee && u.employee.employeeCode), u);
    add(by.email, low(u.email), u); add(by.email, low(u.username), u);
    add(by.name, low(u.name), u);
  });
  return { kind, scope, members, by };
}
function findPeople(ix, raw) {
  const k = low(raw);
  if (!k) return [];
  return ix.by.code.get(k) || ix.by.email.get(k) || ix.by.name.get(k) || ix.by.name.get(k.replace(/\s*\(.*\)$/, '')) || [];
}

// candidates by id / phone / e-mail / name (one query per kind, not per row)
const looksId = (v) => /^c[a-z0-9]{20,32}$/i.test(String(v || '').trim());
function keysOf(r) {
  const vals = [r.candidate, r.phone, r.email].filter(Boolean);
  const ids = vals.filter(looksId);
  const phones = [...new Set(vals.flatMap((v) => (String(v).replace(/\D/g, '').length >= 10 && !/@/.test(v) ? phoneKeys(v) : [])))];
  const emails = [...new Set(vals.map((v) => emailKey(v)).filter(Boolean))];
  const names = r.candidate && !looksId(r.candidate) && !emailKey(r.candidate) && String(r.candidate).replace(/\D/g, '').length < 7 ? [low(r.candidate)] : [];
  return { ids, phones, emails, names };
}
const CAND_COLS = 'id, name, phone, email';
const PHONE_SQL = (col) => `substr(replace(replace(replace(replace(replace(replace(coalesce(${col},''),' ',''),'-',''),'+',''),'(',''),')',''),'.',''), -10)`;
async function candidatesFor(rows) {
  const keys = rows.map(keysOf);
  const ids = [...new Set(keys.flatMap((k) => k.ids))];
  const phones = [...new Set(keys.flatMap((k) => k.phones))];
  const emails = [...new Set(keys.flatMap((k) => k.emails))];
  const names = [...new Set(keys.flatMap((k) => k.names))];
  const found = new Map();
  const put = (list) => list.forEach((c) => found.set(c.id, c));
  for (const part of chunks(ids)) put(await prisma.candidate.findMany({ where: { id: { in: part } }, select: { id: true, name: true, phone: true, email: true } })); // eslint-disable-line no-await-in-loop
  // every "?L" is the chunk's placeholders; the parameters are the chunk once per "?L"
  const q = (sql, part) => { const n = sql.split('?L').length - 1; return prisma.$queryRawUnsafe(sql.split('?L').join(part.map(() => '?').join(',')), ...Array.from({ length: n }, () => part).flat()); };
  for (const part of chunks(phones, 300)) put(await q(`SELECT ${CAND_COLS} FROM "Candidate" WHERE ${PHONE_SQL('phone')} IN (?L)`, part)); // eslint-disable-line no-await-in-loop
  for (const part of chunks(emails)) put(await q(`SELECT ${CAND_COLS} FROM "Candidate" WHERE lower(trim(email)) IN (?L)`, part)); // eslint-disable-line no-await-in-loop
  for (const part of chunks(names)) put(await q(`SELECT ${CAND_COLS} FROM "Candidate" WHERE lower(trim(name)) IN (?L)`, part)); // eslint-disable-line no-await-in-loop
  const list = [...found.values()];
  const byPhone = new Map(); const byEmail = new Map(); const byName = new Map();
  const add = (m, k, c) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(c); };
  list.forEach((c) => { phoneKeys(c.phone).forEach((k) => add(byPhone, k, c)); add(byEmail, emailKey(c.email), c); add(byName, low(c.name), c); });
  return rows.map((r, i) => {
    const k = keys[i];
    const pick = (arr) => [...new Map(arr.map((c) => [c.id, c])).values()];
    const byIds = pick(k.ids.map((id) => found.get(id)).filter(Boolean));
    if (byIds.length) return byIds;
    const ph = pick(k.phones.flatMap((p) => byPhone.get(p) || []));
    if (ph.length) return ph;
    const em = pick(k.emails.flatMap((e) => byEmail.get(e) || []));
    if (em.length) return em;
    return pick(k.names.flatMap((n) => byName.get(n) || []));
  });
}

async function appsInScope(user, candidateIds) {
  const where = S.applicationWhere(user);
  const out = [];
  for (const part of chunks(candidateIds, 300)) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...await prisma.application.findMany({
      where: { AND: [where, { candidateId: { in: part } }] },
      select: {
        id: true, candidateId: true, requirementId: true, ownerRecruiterId: true, createdAt: true, updatedAt: true, stage: true,
        requirement: { select: { reqCode: true, title: true, internal: true, client: { select: { name: true } } } },
      },
    }));
  }
  return out;
}

const textKey = (t) => low(t);
async function existingKeys(candidateIds) {
  const keys = new Set();
  for (const part of chunks(candidateIds, 300)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.applicationFollowUp.findMany({ where: { candidateId: { in: part } }, select: { candidateId: true, ownerUserId: true, createdById: true, createdAt: true, notes: true, completedNote: true, nextAction: true } });
    rows.forEach((f) => {
      const day = istDay(f.createdAt);
      [f.ownerUserId, f.createdById].filter(Boolean).forEach((p) => [f.notes, f.completedNote, f.nextAction].filter(Boolean).forEach((t) => keys.add(`${f.candidateId}|${p}|${day}|${textKey(t)}`)));
    });
  }
  return keys;
}

const appLabel = (a, cand, people) => {
  const r = a.requirement || {};
  const client = r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || '';
  const owner = a.ownerRecruiterId && people.get(a.ownerRecruiterId);
  const tail = cand && cand.phone ? ` (...${String(cand.phone).replace(/\D/g, '').slice(-4)})` : '';
  return [`${cand ? cand.name : 'Candidate'}${tail}`, [r.reqCode, r.title].filter(Boolean).join(' '), client, owner ? `with ${owner.name}` : ''].filter(Boolean).join(' · ');
};

/**
 * Resolve every parsed row for this login. choices = { [rowNo]: id } (a recruiter's user id or an application id).
 * -> [{ row, status: 'ready' | 'choice' | 'refused', reason, day, recruiter, candidate, application, what, callBack, answer, done, choice }]
 */
async function resolveRows(user, parsed, choices = {}) {
  const ix = await peopleIndex(user);
  const self = user.id;
  const today = todayIst();
  const cands = await candidatesFor(parsed);
  const allCandIds = [...new Set(cands.flat().map((c) => c.id))];
  const apps = allCandIds.length ? await appsInScope(user, allCandIds) : [];
  const appsOf = new Map();
  apps.forEach((a) => { if (!appsOf.has(a.candidateId)) appsOf.set(a.candidateId, []); appsOf.get(a.candidateId).push(a); });
  const existing = await existingKeys(allCandIds);
  const nameOf = new Map([...ix.members.values()].map((m) => [m.id, m]));
  const seen = new Map();

  return parsed.map((r, i) => {
    const out = {
      row: r.row, status: 'refused', reason: '', day: r.date && r.date.day ? r.date.day : null, recruiter: null, candidate: null, application: null,
      what: r.what, callBack: r.callBack && r.callBack.day ? r.callBack.day : null, answer: answerOf(r.answerRaw), done: null, choice: null, chosen: choices[r.row] || null,
      input: { recruiter: r.recruiter, candidate: [r.candidate, r.phone, r.email].filter(Boolean).join(' / '), requirement: r.requirement },
    };
    const refuse = (reason) => { out.status = 'refused'; out.reason = reason; return out; };
    if (/^example\b/i.test(r.what || '')) return refuse('An example row from the template - skipped');
    if (!r.date || r.date.error) {
      if (r.date && r.date.error === 'future') return refuse(`The date ${r.date.message ? r.date.message.split(' ')[0] : ''} is in the future`.replace('  ', ' '));
      if (r.date && r.date.error === 'empty') return refuse('No date');
      return refuse(`Bad date: ${(r.date && r.date.message) || 'not a date'}`);
    }
    if (!String(r.what || '').trim()) return refuse('"What happened" is empty');
    if (r.callBack && r.callBack.error) return refuse(`Bad "Call back on" date: ${r.callBack.message}`);
    if (out.callBack && out.callBack < out.day) return refuse('The call-back day is before the follow-up date');
    const done = doneOf(r.doneRaw);
    if (done === 'bad') return refuse('"Done" must be yes or no');
    out.done = done === null ? !(out.callBack && out.callBack >= today) : done;

    // the recruiter
    let rec = null;
    if (!r.recruiter) {
      if (ix.kind === 'recruiter') rec = ix.members.get(self) || { id: self, name: user.name };
      else return refuse('No recruiter given');
    } else {
      const hits = findPeople(ix, r.recruiter);
      if (!hits.length) return refuse(`Recruiter "${r.recruiter}" not found (use the name, e-mail or employee code as in TeamLink)`);
      const inScope = hits.filter((u) => ix.members.has(u.id));
      const onDay = inScope.filter((u) => FS.inWindow(ix.members.get(u.id), out.day));
      if (!inScope.length) return refuse(ix.kind === 'recruiter' ? 'You can import only your own follow-ups' : `${hits[0].name} is not in your team`);
      if (!onDay.length) return refuse(`${inScope[0].name} was not in your team on ${dmy(out.day)}`);
      if (onDay.length === 1) rec = ix.members.get(onDay[0].id);
      else {
        const picked = onDay.find((u) => u.id === choices[r.row]);
        if (picked) rec = ix.members.get(picked.id);
        else {
          out.status = 'choice'; out.reason = `${onDay.length} people match "${r.recruiter}" - choose the recruiter`;
          out.choice = { kind: 'recruiter', options: onDay.map((u) => ({ id: u.id, label: `${u.name}${u.employee && u.employee.employeeCode ? ` (${u.employee.employeeCode})` : ''}${u.email ? ` · ${u.email}` : ''}` })) };
        }
      }
    }
    if (rec) out.recruiter = { id: rec.id, name: rec.name, role: rec.role || 'Recruiter' };

    // the candidate and the application
    const found = cands[i];
    if (!found.length) return refuse('Candidate not found');
    const visible = found.filter((c) => (appsOf.get(c.id) || []).length);
    if (!visible.length) return refuse(ix.kind === 'recruiter' ? 'This candidate is not yours' : 'This candidate is not in your team\'s work');
    if (out.status === 'choice') return out; // the recruiter first
    const want = low(r.requirement);
    const options = [];
    let reqMissed = false;
    visible.forEach((c) => {
      const list = [...appsOf.get(c.id)].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
      let picks;
      if (want) {
        picks = list.filter((a) => low(a.requirement && a.requirement.reqCode) === want);
        if (!picks.length) picks = list.filter((a) => low(a.requirement && a.requirement.title) === want);
        if (!picks.length && want.length >= 3) picks = list.filter((a) => low(a.requirement && a.requirement.title).includes(want) || low(a.requirement && a.requirement.reqCode).includes(want));
        if (!picks.length) reqMissed = true;
      } else {
        const own = list.filter((a) => a.ownerRecruiterId === rec.id);
        picks = own.length ? own : [list[0]];
      }
      picks.forEach((a) => options.push({ a, c }));
    });
    if (!options.length) return refuse(reqMissed ? `This candidate has no application on "${r.requirement}" that you can see` : 'Candidate not found');
    let hit = null;
    if (options.length === 1) hit = options[0];
    else {
      hit = options.find((o) => o.a.id === choices[r.row]) || null;
      if (!hit) {
        out.status = 'choice';
        out.reason = visible.length > 1 ? `${visible.length} candidates match - choose one` : `${options.length} applications match - choose one`;
        out.choice = { kind: 'application', options: options.map((o) => ({ id: o.a.id, label: appLabel(o.a, o.c, nameOf) })) };
        out.candidate = visible.length === 1 ? { id: visible[0].id, name: visible[0].name } : null;
        return out;
      }
    }
    out.candidate = { id: hit.c.id, name: hit.c.name };
    out.application = { id: hit.a.id, requirementId: hit.a.requirementId, label: appLabel(hit.a, hit.c, nameOf) };

    // duplicates: of a follow-up already in TeamLink, then of an earlier row of this file
    const key = `${hit.c.id}|${rec.id}|${out.day}|${textKey(r.what)}`;
    if (existing.has(key)) return refuse('Already in TeamLink: the same candidate, recruiter, date and text');
    if (seen.has(key)) return refuse(`Same as row ${seen.get(key)} of this file`);
    seen.set(key, r.row);
    out.status = 'ready'; out.reason = '';
    return out;
  });
}

const totalsOf = (rows) => ({ rows: rows.length, ready: rows.filter((r) => r.status === 'ready').length, choice: rows.filter((r) => r.status === 'choice').length, refused: rows.filter((r) => r.status === 'refused').length });

// ---- the batch --------------------------------------------------------------------------------------------------------
async function readBatch(id) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "FollowUpImportBatch" WHERE id = ?', String(id || ''));
  return rows[0] || null;
}
function ownBatch(b, user) {
  if (!b) throw new ImportError(404, 'That import was not found. Choose the file again.');
  if (b.byUserId !== user.id) throw new ImportError(403, 'That import belongs to somebody else.');
  return b;
}
const cleanChoices = (c) => (c && typeof c === 'object' ? Object.fromEntries(Object.entries(c).filter(([, v]) => typeof v === 'string' && v.length < 64).map(([k, v]) => [Number(k), v])) : {});

async function preview(user, file, { mapping = null, sheet = null } = {}) {
  assertMay(user);
  await ensure();
  const recruiterLogin = kindOf(user) === 'recruiter';
  const read = readSheet(file, { mapping, sheet, recruiterLogin });
  const info = { fileName: file.filename || 'sheet', sheet: read.sheet, sheets: read.sheets, headerRow: read.headerRow, fileColumns: read.fileColumns, mapping: read.mapping, missing: read.missing };
  if (read.missing.length) return { ok: false, ...info, totals: null, rows: [] };
  if (!read.rows.length) throw new ImportError(400, 'That sheet has no rows under the column names.');
  const parsed = read.rows.map(parseRow);
  const rows = await resolveRows(user, parsed, {});
  const totals = totalsOf(rows);
  const id = newId('fib');
  // old previews nobody applied are dropped after two days
  await prisma.$executeRawUnsafe('DELETE FROM "FollowUpImportBatch" WHERE status = \'PREVIEW\' AND "createdAt" < ?', new Date(Date.now() - 2 * 86400000).toISOString());
  await prisma.$executeRawUnsafe(
    'INSERT INTO "FollowUpImportBatch" (id, "byUserId", "byName", "byKind", "fileName", "createdAt", status, "totalRows", "readyRows", "choiceRows", "refusedRows", payload) VALUES (?, ?, ?, ?, ?, ?, \'PREVIEW\', ?, ?, ?, ?, ?)',
    id, user.id, user.name || null, kindOf(user), info.fileName.slice(0, 200), new Date().toISOString(), totals.rows, totals.ready, totals.choice, totals.refused, JSON.stringify({ parsed, info }),
  );
  return { ok: true, batchId: id, ...info, totals, rows };
}

async function check(user, batchId, choices) {
  assertMay(user);
  const b = ownBatch(await readBatch(batchId), user);
  if (b.status !== 'PREVIEW') throw new ImportError(409, 'This import was already applied. Choose the file again for a new one.');
  const { parsed, info } = JSON.parse(b.payload);
  const rows = await resolveRows(user, parsed, cleanChoices(choices));
  return { ok: true, batchId: b.id, ...info, totals: totalsOf(rows), rows };
}

const fingerprint = (f) => crypto.createHash('sha1').update(JSON.stringify([
  f.applicationId, f.ownerUserId, f.notes, f.outcome, f.dueDate, f.completedAt ? new Date(f.completedAt).toISOString() : null, f.completedById, f.completedNote, f.nextAction, f.purpose,
])).digest('hex');

async function seatsOf(userIds) {
  if (!userIds.length) return new Map();
  const rows = await prisma.positionAssignment.findMany({
    where: { toDate: null, employee: { userId: { in: userIds } } },
    select: { position: { select: { id: true, code: true } }, employee: { select: { userId: true } } },
  }).catch(() => []);
  return new Map(rows.map((r) => [r.employee.userId, r.position]));
}

async function apply(user, batchId, choices) {
  assertMay(user);
  const b = ownBatch(await readBatch(batchId), user);
  if (b.status !== 'PREVIEW') throw new ImportError(409, 'This import was already applied.');
  const taken = await prisma.$executeRawUnsafe('UPDATE "FollowUpImportBatch" SET status = \'APPLYING\' WHERE id = ? AND status = \'PREVIEW\'', b.id);
  if (!taken) throw new ImportError(409, 'This import is already being applied.');
  try {
    const { parsed } = JSON.parse(b.payload);
    const rows = await resolveRows(user, parsed, cleanChoices(choices));
    const ready = rows.filter((r) => r.status === 'ready');
    const seats = await seatsOf([...new Set(ready.map((r) => r.recruiter.id))]);
    const today = todayIst();
    const now = new Date();
    const by = `${IMPORTER} (${user.name || 'TeamLink'})`;
    const data = ready.map((r) => {
      const at = new Date(`${r.day}T12:00:00+05:30`);
      const seat = seats.get(r.recruiter.id);
      const open = !r.done;
      // an OPEN follow-up whose call-back day has already passed is old work: it shows as overdue in the report, but it must not fire the
      // escalation alerts of live work (utils/followups.js escalateOverdue) the moment a whole old sheet arrives
      const quiet = open && r.callBack && r.callBack < today;
      return {
        id: newId('c'), applicationId: r.application.id, candidateId: r.candidate.id, requirementId: r.application.requirementId || null,
        ownerUserId: r.recruiter.id, ownerName: r.recruiter.name, ownerRole: r.recruiter.role || 'Recruiter',
        ownerPositionId: seat ? seat.id : null, ownerPositionCode: seat ? seat.code : null,
        lastContactedAt: at, notes: r.what.slice(0, 4000), outcome: r.answer || null, purpose: 'Follow-up',
        dueDate: r.callBack || null, nextFollowUpAt: r.callBack || null,
        completedAt: r.done ? at : null, completedById: r.done ? r.recruiter.id : null,
        createdByName: by, createdAt: at,
        ...(quiet ? { escalatedTlAt: now, escalatedStlAt: now, escalatedAdminAt: now, escalatedSuperAdminAt: now, escalationLevel: 4 } : {}),
        _row: r.row, _day: r.day,
      };
    });
    await prisma.$transaction(async (tx) => {
      for (const part of chunks(data, 200)) {
        // eslint-disable-next-line no-await-in-loop
        await tx.applicationFollowUp.createMany({ data: part.map(({ _row, _day, ...x }) => x) });
        for (const x of part) {
          // eslint-disable-next-line no-await-in-loop
          await tx.$executeRawUnsafe('INSERT INTO "FollowUpImportRow" (id, "batchId", "followUpId", "rowNo", "candidateId", "ownerUserId", day, fingerprint) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
            newId('fir'), b.id, x.id, x._row, x.candidateId, x.ownerUserId, x._day, fingerprint(x));
        }
      }
      await tx.$executeRawUnsafe('UPDATE "FollowUpImportBatch" SET status = \'APPLIED\', "appliedAt" = ?, "createdRows" = ?, "readyRows" = ?, "choiceRows" = ?, "refusedRows" = ? WHERE id = ?',
        new Date().toISOString(), data.length, ready.length, rows.filter((r) => r.status === 'choice').length, rows.filter((r) => r.status === 'refused').length, b.id);
    }, { timeout: 120000, maxWait: 20000 });
    return {
      ok: true, batchId: b.id, created: data.length, fileName: b.fileName,
      skipped: rows.filter((r) => r.status !== 'ready').map((r) => ({ row: r.row, status: r.status, reason: r.reason })),
      people: [...new Set(ready.map((r) => r.recruiter.name))].length,
      days: ready.length ? { from: ready.map((r) => r.day).sort()[0], to: ready.map((r) => r.day).sort().pop() } : null,
    };
  } catch (e) {
    await prisma.$executeRawUnsafe('UPDATE "FollowUpImportBatch" SET status = \'PREVIEW\' WHERE id = ? AND status = \'APPLYING\'', b.id).catch(() => {});
    throw e;
  }
}

async function batches(user, { limit = 30 } = {}) {
  assertMay(user);
  await ensure();
  const admin = kindOf(user) === 'admin';
  const rows = admin
    ? await prisma.$queryRawUnsafe('SELECT * FROM "FollowUpImportBatch" WHERE status IN (\'APPLIED\', \'UNDONE\') ORDER BY "appliedAt" DESC LIMIT ?', limit)
    : await prisma.$queryRawUnsafe('SELECT * FROM "FollowUpImportBatch" WHERE status IN (\'APPLIED\', \'UNDONE\') AND "byUserId" = ? ORDER BY "appliedAt" DESC LIMIT ?', user.id, limit);
  return rows.map((b) => ({
    id: b.id, byName: b.byName, mine: b.byUserId === user.id, fileName: b.fileName, appliedAt: b.appliedAt, status: b.status,
    created: Number(b.createdRows), undone: Number(b.undoneRows), kept: Number(b.keptRows), undoneAt: b.undoneAt, undoneByName: b.undoneByName,
    canUndo: b.status === 'APPLIED' && (admin || b.byUserId === user.id),
  }));
}

async function undo(user, batchId) {
  assertMay(user);
  const b = await readBatch(batchId);
  if (!b || !['APPLIED', 'UNDONE'].includes(b.status)) throw new ImportError(404, 'That import was not found.');
  if (b.byUserId !== user.id && kindOf(user) !== 'admin') throw new ImportError(403, 'Only the person who imported it, or an Admin, can undo this import.');
  if (b.status === 'UNDONE') throw new ImportError(409, 'This import was already undone.');
  const taken = await prisma.$executeRawUnsafe('UPDATE "FollowUpImportBatch" SET status = \'UNDOING\' WHERE id = ? AND status = \'APPLIED\'', b.id);
  if (!taken) throw new ImportError(409, 'This import is already being undone.');
  try {
    const links = await prisma.$queryRawUnsafe('SELECT * FROM "FollowUpImportRow" WHERE "batchId" = ? AND "removedAt" IS NULL', b.id);
    let removed = 0; let kept = 0; let gone = 0;
    const keptRows = [];
    for (const part of chunks(links, 300)) {
      // eslint-disable-next-line no-await-in-loop
      const now = await prisma.applicationFollowUp.findMany({ where: { id: { in: part.map((l) => l.followUpId) } } });
      const byId = new Map(now.map((f) => [f.id, f]));
      const del = []; const delLinks = [];
      part.forEach((l) => {
        const f = byId.get(l.followUpId);
        if (!f) { gone += 1; delLinks.push(l.id); return; }
        if (fingerprint(f) !== l.fingerprint) { kept += 1; keptRows.push(Number(l.rowNo)); return; }
        del.push(f.id); delLinks.push(l.id);
      });
      // eslint-disable-next-line no-await-in-loop
      if (del.length) removed += (await prisma.applicationFollowUp.deleteMany({ where: { id: { in: del } } })).count;
      const at = new Date().toISOString();
      for (const id of delLinks) await prisma.$executeRawUnsafe('UPDATE "FollowUpImportRow" SET "removedAt" = ? WHERE id = ?', at, id); // eslint-disable-line no-await-in-loop
    }
    await prisma.$executeRawUnsafe('UPDATE "FollowUpImportBatch" SET status = \'UNDONE\', "undoneAt" = ?, "undoneByName" = ?, "undoneRows" = ?, "keptRows" = ? WHERE id = ?',
      new Date().toISOString(), user.name || null, removed, kept, b.id);
    return { ok: true, batchId: b.id, removed, kept, gone, keptRows: keptRows.sort((x, y) => x - y).slice(0, 50), fileName: b.fileName, byName: b.byName };
  } catch (e) {
    await prisma.$executeRawUnsafe('UPDATE "FollowUpImportBatch" SET status = \'APPLIED\' WHERE id = ? AND status = \'UNDOING\'', b.id).catch(() => {});
    throw e;
  }
}

module.exports = {
  ensure, template, preview, check, apply, batches, undo, mayImport, ImportError, MAX_ROWS, MAX_BYTES, IMPORTER, COLUMNS, answerOf, doneOf,
};
