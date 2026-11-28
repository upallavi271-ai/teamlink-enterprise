// ---------------------------------------------------------------------------
// DOCUMENT EXPIRY AND AGREEMENTS (founder 2026-11-25, from the HR audit questionnaire: Q35 document expiry dates, Q36 NDA and
// confidentiality agreements, Q220 "show employees with expired documents").
//
// ADDITIVE. One new table (TrackedDocument); the Employee row and the employee's uploaded files (EmployeeDocument) are not touched.
// HR adds an item for a person: a document with an expiry date (passport, visa, licence, certificate ...) or an NDA / agreement, and can
// link it to a file already uploaded for that person. The list shows what is Expired, Due soon, Valid or has No expiry, who has no NDA on
// record, and every renewal is kept in the item's history.
//
// REMINDERS are OFF until HR switches them on (AppSetting "docregister.settings"). Once on, a bell notice goes to HR 60, 30 and 7 days
// before an expiry, on the day, and every 7 days while it is overdue; each goes once. The employee is told too only if HR ticks
// "Also remind the employee". The nightly job also asks utils/policyRegister.js for the policy review reminders.
// The test sandbox runs no timers (index.js); sweep() is exported for tests.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');
const { NOT_SYSTEM_EMPLOYEE } = require('./systemAccounts');
const { EXITED } = require('./audience');

const SETTINGS_KEY = 'docregister.settings';
const STATE_KEY = 'docregister.sweep';
const KINDS = ['Document', 'NDA', 'Confidentiality agreement', 'Bond / service agreement', 'Other agreement'];

// --- dates (a day is "YYYY-MM-DD" in India time, stored as that day at 00:00 UTC) ---------------------------------------------
const IST = 330 * 60000;
const dayOfDate = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? new Date(d.getTime() + IST).toISOString().slice(0, 10) : null);
const istToday = (now = Date.now()) => new Date(now + IST).toISOString().slice(0, 10);
const istHour = (now = Date.now()) => new Date(now + IST).getUTCHours();
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const toDate = (day) => new Date(`${day}T00:00:00Z`);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const pretty = (day) => (day ? new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '');
const cleanLine = (v, n) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanText = (v, n) => String(v == null ? '' : v).replace(/\r/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim().slice(0, n);

// --- settings ----------------------------------------------------------------------------------------------------------------
async function getSettings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  const soonDays = Number.isInteger(v.soonDays) && v.soonDays >= 1 && v.soonDays <= 90 ? v.soonDays : 30;
  // the employee is reminded too unless HR switched that off (founder 2026-11-25: "hr and employee too")
  return { enabled: v.enabled === true, soonDays, tellEmployee: v.tellEmployee === undefined ? true : v.tellEmployee === true, enabledAt: v.enabledAt || null, enabledByName: v.enabledByName || null };
}
/** body: { enabled?, soonDays?, tellEmployee? } -> { settings } | { error, status } */
async function saveSettings(body, user) {
  const cur = await getSettings();
  const b = body || {};
  const next = { ...cur };
  if (b.soonDays !== undefined) {
    const n = Number(b.soonDays);
    if (!Number.isInteger(n) || n < 1 || n > 90) return { error: '"Due soon" is a whole number of days, 1 to 90.', status: 400 };
    next.soonDays = n;
  }
  if (b.tellEmployee !== undefined) next.tellEmployee = b.tellEmployee === true || b.tellEmployee === 'true';
  if (b.enabled !== undefined) {
    const on = b.enabled === true || b.enabled === 'true';
    if (on && !cur.enabled) { next.enabledAt = new Date().toISOString(); next.enabledByName = user ? user.name : null; }
    next.enabled = on;
  }
  const who = user ? { updatedById: user.id, updatedByName: user.name } : {};
  await prisma.appSetting.upsert({ where: { key: SETTINGS_KEY }, create: { key: SETTINGS_KEY, value: JSON.stringify(next), ...who }, update: { value: JSON.stringify(next), ...who } });
  await logAudit({ userId: user ? user.id : null, action: `Document and policy reminders saved${b.enabled !== undefined ? (next.enabled ? ' (switched ON)' : ' (switched OFF)') : ''}`, entity: 'DocRegister', entityId: SETTINGS_KEY, toValue: `due soon ${next.soonDays} days, employee reminded: ${next.tellEmployee ? 'yes' : 'no'}` });
  return { settings: await getSettings() };
}

// --- who is told -----------------------------------------------------------------------------------------------------------------
async function hrUserIds() {
  const users = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: 'HR' }, { hrmsRole: 'HR' }] }, select: { id: true } });
  return users.map((u) => u.id);
}

// --- items -------------------------------------------------------------------------------------------------------------------------
function historyOf(it) { try { const h = JSON.parse(it.history || '[]'); return Array.isArray(h) ? h : []; } catch { return []; } }
function pushHistory(it, by, action, extra = {}) {
  const h = historyOf(it);
  h.push({ at: new Date().toISOString(), by: by ? by.name : 'System', action, ...extra });
  return JSON.stringify(h.slice(-60));
}
function statusOf(it, today, soon) {
  const end = dayOfDate(it.expiresOn);
  if (!end) return { status: 'No expiry', daysLeft: null };
  const left = daysBetween(today, end);
  return { status: left < 0 ? 'Expired' : left <= soon ? 'Due soon' : 'Valid', daysLeft: left };
}
function shape(it, today, soon, files) {
  const s = statusOf(it, today, soon);
  const f = it.documentId && files ? files.get(it.documentId) : null;
  return {
    id: it.id, employeeId: it.employeeId, employeeCode: it.employeeCode, name: it.employeeName, department: it.department,
    kind: it.kind, title: it.title, issuedOn: dayOfDate(it.issuedOn), expiresOn: dayOfDate(it.expiresOn), note: it.note || null,
    status: s.status, daysLeft: s.daysLeft, documentId: it.documentId || null,
    file: f ? { fileName: f.fileName, docType: f.docType, uploadedAt: f.uploadedAt.toISOString() } : null,
    history: historyOf(it).slice().reverse(),
    createdBy: it.createdByName || null,
  };
}
const BUCKETS = {
  expired: (s) => s.status === 'Expired',
  soon: (s) => s.status === 'Due soon',
  valid: (s) => s.status === 'Valid',
  noExpiry: (s) => s.status === 'No expiry',
  agreements: (s) => s.kind !== 'Document',
  documents: (s) => s.kind === 'Document',
  all: () => true,
};

async function filesFor(items) {
  const ids = [...new Set(items.map((i) => i.documentId).filter(Boolean))];
  if (!ids.length) return new Map();
  const docs = await prisma.employeeDocument.findMany({ where: { id: { in: ids } }, select: { id: true, docType: true, fileName: true, uploadedAt: true } });
  return new Map(docs.map((d) => [d.id, d]));
}

/** -> { settings, counts, rows } */
async function list({ bucket = 'expired', q = '', kind = '' } = {}) {
  const st = await getSettings();
  const today = istToday();
  const all = await prisma.trackedDocument.findMany({ where: { status: 'Active' }, orderBy: [{ expiresOn: 'asc' }, { employeeName: 'asc' }] });
  const files = await filesFor(all);
  const rows = all.map((i) => shape(i, today, st.soonDays, files));
  const counts = Object.fromEntries(Object.entries(BUCKETS).map(([k, fn]) => [k, rows.filter(fn).length]));
  const needle = cleanLine(q, 80).toLowerCase();
  const out = rows.filter(BUCKETS[bucket] || BUCKETS.expired)
    .filter((r) => !kind || r.kind === kind)
    .filter((r) => !needle || `${r.name} ${r.employeeCode || ''} ${r.title}`.toLowerCase().includes(needle));
  // soonest expiry first, the ones with no date last
  out.sort((a, b) => (a.daysLeft === null) - (b.daysLeft === null) || (a.daysLeft || 0) - (b.daysLeft || 0) || a.name.localeCompare(b.name));
  return { settings: st, bucket: BUCKETS[bucket] ? bucket : 'expired', counts, kinds: KINDS, rows: out };
}

/** Active people with no NDA on record (Q36). -> { rows } */
async function noNda({ q = '' } = {}) {
  const have = new Set((await prisma.trackedDocument.findMany({ where: { status: 'Active', kind: 'NDA' }, select: { employeeId: true } })).map((r) => r.employeeId));
  const needle = cleanLine(q, 80).toLowerCase();
  const people = await prisma.employee.findMany({
    where: { AND: [{ employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE] },
    select: { id: true, employeeCode: true, name: true, department: true, designation: true, dateOfJoining: true }, orderBy: { name: 'asc' },
  });
  const rows = people.filter((p) => !have.has(p.id)).filter((p) => !needle || `${p.name} ${p.employeeCode}`.toLowerCase().includes(needle))
    .map((p) => ({ employeeId: p.id, employeeCode: p.employeeCode, name: p.name, department: p.department, designation: p.designation, joined: dayOfDate(p.dateOfJoining) }));
  return { rows, total: people.length, covered: people.length - people.filter((p) => !have.has(p.id)).length };
}

async function peopleFind(q) {
  const needle = cleanLine(q, 60);
  if (needle.length < 2) return { rows: [] };
  const rows = await prisma.employee.findMany({
    where: { AND: [{ employmentStatus: { notIn: EXITED } }, NOT_SYSTEM_EMPLOYEE, { OR: [{ name: { contains: needle } }, { employeeCode: { contains: needle } }] }] },
    select: { id: true, employeeCode: true, name: true, department: true, designation: true }, orderBy: { name: 'asc' }, take: 15,
  });
  return { rows: rows.map((r) => ({ employeeId: r.id, employeeCode: r.employeeCode, name: r.name, department: r.department, designation: r.designation })) };
}
async function documentsOf(employeeId) {
  const docs = await prisma.employeeDocument.findMany({ where: { employeeId: String(employeeId) }, orderBy: { uploadedAt: 'desc' }, select: { id: true, docType: true, docName: true, fileName: true, uploadedAt: true } });
  return { rows: docs.map((d) => ({ id: d.id, docType: d.docType, fileName: d.fileName, uploadedAt: d.uploadedAt.toISOString() })) };
}

function readDates(b, cur) {
  const out = {};
  for (const k of ['issuedOn', 'expiresOn']) {
    if (b[k] === undefined) continue; // eslint-disable-line no-continue
    if (b[k] === null || b[k] === '') { out[k] = null; continue; } // eslint-disable-line no-continue
    const day = String(b[k]).slice(0, 10);
    if (!isDay(day)) return { error: `The ${k === 'issuedOn' ? 'issue' : 'expiry'} date is not valid.`, status: 400 };
    out[k] = day;
  }
  const issued = out.issuedOn !== undefined ? out.issuedOn : dayOfDate(cur && cur.issuedOn);
  const expires = out.expiresOn !== undefined ? out.expiresOn : dayOfDate(cur && cur.expiresOn);
  if (issued && expires && expires < issued) return { error: 'The expiry date is before the issue date.', status: 400 };
  return { dates: out };
}

/** body: { employeeId, kind, title, documentId?, issuedOn?, expiresOn?, note? } -> { item } | { error, status } */
async function createItem(user, body) {
  const b = body || {};
  const emp = await prisma.employee.findFirst({ where: { AND: [{ id: String(b.employeeId || '') }, NOT_SYSTEM_EMPLOYEE] } });
  if (!emp) return { error: 'Choose the employee first.', status: 400 };
  const kind = String(b.kind || 'Document');
  if (!KINDS.includes(kind)) return { error: 'Choose what this is: Document, NDA or an agreement.', status: 400 };
  const title = cleanLine(b.title, 120) || (kind === 'Document' ? '' : kind);
  if (!title) return { error: 'Give the document a name, for example "Passport" or "Driving licence".', status: 400 };
  let documentId = null;
  if (b.documentId) {
    const d = await prisma.employeeDocument.findFirst({ where: { id: String(b.documentId), employeeId: emp.id } });
    if (!d) return { error: 'That file does not belong to this employee.', status: 400 };
    documentId = d.id;
  }
  const r = readDates(b, null);
  if (r.error) return r;
  if (kind === 'Document' && !r.dates.expiresOn) return { error: 'A document needs an expiry date. (An NDA or agreement may have none.)', status: 400 };
  const it = await prisma.trackedDocument.create({
    data: {
      employeeId: emp.id, employeeCode: emp.employeeCode, employeeName: emp.name, department: emp.department || null, kind, title, documentId,
      issuedOn: r.dates.issuedOn ? toDate(r.dates.issuedOn) : null, expiresOn: r.dates.expiresOn ? toDate(r.dates.expiresOn) : null,
      note: cleanText(b.note, 500) || null, createdByName: user ? user.name : null,
      history: JSON.stringify([{ at: new Date().toISOString(), by: user ? user.name : 'System', action: 'Added', to: r.dates.expiresOn || null }]),
    },
  });
  await logAudit({ userId: user ? user.id : null, action: `Document tracker: ${kind} added`, entity: 'TrackedDocument', entityId: it.id, toValue: `${emp.name}: ${title}${r.dates.expiresOn ? `, expires ${r.dates.expiresOn}` : ''}` });
  const st = await getSettings();
  return { item: shape(it, istToday(), st.soonDays, await filesFor([it])) };
}

async function loadActive(id) {
  const it = await prisma.trackedDocument.findUnique({ where: { id: String(id) } });
  if (!it || it.status !== 'Active') return null;
  return it;
}
async function finish(id) {
  const st = await getSettings();
  const it = await prisma.trackedDocument.findUnique({ where: { id } });
  return { item: shape(it, istToday(), st.soonDays, await filesFor([it])) };
}

/** Change the name, dates, note or linked file. body: { title?, issuedOn?, expiresOn?, note?, documentId? } */
async function updateItem(user, id, body) {
  const it = await loadActive(id);
  if (!it) return { error: 'There is no such item.', status: 404 };
  const b = body || {};
  const data = {};
  const said = [];
  if (b.title !== undefined) { const t = cleanLine(b.title, 120); if (!t) return { error: 'The name cannot be empty.', status: 400 }; if (t !== it.title) { data.title = t; said.push('name'); } }
  if (b.note !== undefined) { data.note = cleanText(b.note, 500) || null; }
  if (b.documentId !== undefined) {
    if (b.documentId) {
      const d = await prisma.employeeDocument.findFirst({ where: { id: String(b.documentId), employeeId: it.employeeId } });
      if (!d) return { error: 'That file does not belong to this employee.', status: 400 };
      data.documentId = d.id;
    } else data.documentId = null;
  }
  const r = readDates(b, it);
  if (r.error) return r;
  if (it.kind === 'Document' && r.dates.expiresOn === null) return { error: 'A document needs an expiry date.', status: 400 };
  let from = null; let to = null;
  if (r.dates.issuedOn !== undefined) { data.issuedOn = r.dates.issuedOn ? toDate(r.dates.issuedOn) : null; said.push('issue date'); }
  if (r.dates.expiresOn !== undefined && r.dates.expiresOn !== dayOfDate(it.expiresOn)) {
    from = dayOfDate(it.expiresOn); to = r.dates.expiresOn; data.expiresOn = to ? toDate(to) : null; data.remindState = null; said.push('expiry date');
  }
  if (!Object.keys(data).length) return finish(id);
  data.history = pushHistory(it, user, 'Edited', { from, to, note: said.length ? `Changed: ${said.join(', ')}` : undefined });
  await prisma.trackedDocument.update({ where: { id: it.id }, data });
  await logAudit({ userId: user ? user.id : null, action: 'Document tracker: item edited', entity: 'TrackedDocument', entityId: it.id, toValue: `${it.employeeName}: ${it.title}` });
  return finish(it.id);
}

/** A new expiry date after the document was renewed. body: { expiresOn, issuedOn?, note? } */
async function renewItem(user, id, body) {
  const it = await loadActive(id);
  if (!it) return { error: 'There is no such item.', status: 404 };
  const b = body || {};
  const day = String(b.expiresOn || '').slice(0, 10);
  if (!isDay(day)) return { error: 'Give the new expiry date.', status: 400 };
  const before = dayOfDate(it.expiresOn);
  if (before && day <= before) return { error: 'The new expiry date must be later than the old one.', status: 400 };
  const data = { expiresOn: toDate(day), remindState: null };
  if (b.issuedOn) { const i = String(b.issuedOn).slice(0, 10); if (!isDay(i)) return { error: 'The issue date is not valid.', status: 400 }; data.issuedOn = toDate(i); }
  if (b.documentId) {
    const d = await prisma.employeeDocument.findFirst({ where: { id: String(b.documentId), employeeId: it.employeeId } });
    if (!d) return { error: 'That file does not belong to this employee.', status: 400 };
    data.documentId = d.id;
  }
  data.history = pushHistory(it, user, 'Renewed', { from: before, to: day, note: cleanText(b.note, 300) || undefined });
  await prisma.trackedDocument.update({ where: { id: it.id }, data });
  await logAudit({ userId: user ? user.id : null, action: 'Document tracker: renewed', entity: 'TrackedDocument', entityId: it.id, fromValue: before, toValue: `${it.employeeName}: ${it.title} until ${day}` });
  return finish(it.id);
}

async function removeItem(user, id, body) {
  const it = await loadActive(id);
  if (!it) return { error: 'There is no such item.', status: 404 };
  await prisma.trackedDocument.update({ where: { id: it.id }, data: { status: 'Removed', history: pushHistory(it, user, 'Removed', { note: cleanText((body || {}).note, 300) || undefined }) } });
  await logAudit({ userId: user ? user.id : null, action: 'Document tracker: item removed', entity: 'TrackedDocument', entityId: it.id, toValue: `${it.employeeName}: ${it.title}` });
  return { ok: true };
}

// --- reminders ---------------------------------------------------------------------------------------------------------------------
function milestoneOf(left) {
  if (left < 0) return { kind: 'overdue', mark: `o${Math.floor(-left / 7)}` };
  if (left === 0) return { kind: 'today', mark: 'm0' };
  if (left <= 7) return { kind: 'soon', mark: 'm7' };
  if (left <= 30) return { kind: 'month', mark: 'm30' };
  if (left <= 60) return { kind: 'two', mark: 'm60' };
  return null;
}

/** One pass of the expiry reminders. -> { told } | { skipped } */
async function remindExpiry({ now = Date.now(), notify, force = false } = {}) {
  const st = await getSettings();
  if (!st.enabled) return { skipped: true, reason: 'Reminders are switched off.' };
  const today = istToday(now);
  const send = notify || require('./notify').notifyUsers; // eslint-disable-line global-require
  const items = await prisma.trackedDocument.findMany({ where: { status: 'Active', expiresOn: { not: null } } });
  const emps = await prisma.employee.findMany({ where: { id: { in: [...new Set(items.map((i) => i.employeeId))] } }, select: { id: true, userId: true, employmentStatus: true } });
  const empOf = new Map(emps.map((e) => [e.id, e]));
  const hr = await hrUserIds();
  const told = [];
  for (const it of items) {
    const e = empOf.get(it.employeeId);
    if (!e || EXITED.includes(e.employmentStatus)) continue; // eslint-disable-line no-continue
    const end = dayOfDate(it.expiresOn);
    const left = daysBetween(today, end);
    const m = milestoneOf(left);
    if (!m) continue; // eslint-disable-line no-continue
    let marks = {};
    try { marks = it.remindState ? JSON.parse(it.remindState) : {}; } catch { marks = {}; }
    if (marks[m.mark]) continue; // eslint-disable-line no-continue
    const who = `${it.employeeName}${it.department ? ` (${it.department})` : ''}`;
    const what = `${it.title}${it.kind !== 'Document' && it.title !== it.kind ? ` (${it.kind})` : ''}`;
    let title; let message;
    if (m.kind === 'overdue') { title = `⏰ Expired: ${what}, ${it.employeeName}`; message = `${what} of ${who} expired on ${pretty(end)} (${-left} day${-left === 1 ? '' : 's'} ago). Renew it and update the date.`; }
    else if (m.kind === 'today') { title = `📄 Expires today: ${what}, ${it.employeeName}`; message = `${what} of ${who} expires today (${pretty(end)}).`; }
    else { title = `📄 Expires in ${left} day${left === 1 ? '' : 's'}: ${what}, ${it.employeeName}`; message = `${what} of ${who} expires on ${pretty(end)}. Ask for the renewed copy and update the date.`; }
    if (hr.length) await send(hr, { title, message, open: '/employee-services?tab=documents&section=expiry' }).catch(() => null); // eslint-disable-line no-await-in-loop
    if (st.tellEmployee && e.userId) {
      const mine = m.kind === 'overdue'
        ? { title: `⏰ Your ${it.title} has expired`, message: `Your ${what} expired on ${pretty(end)}. Please get it renewed and give the new copy to HR.` }
        : { title: `📄 Your ${it.title} expires ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}`, message: `Your ${what} expires on ${pretty(end)}. Please get it renewed and give the new copy to HR.` };
      await send([e.userId], mine).catch(() => null); // eslint-disable-line no-await-in-loop
    }
    marks[m.mark] = today;
    await prisma.trackedDocument.update({ where: { id: it.id }, data: { remindState: JSON.stringify(marks) } }); // eslint-disable-line no-await-in-loop
    told.push({ id: it.id, kind: m.kind });
  }
  void force;
  return { told };
}

/** The nightly job: expiry reminders and policy review reminders, once a day after 9 am IST. */
async function sweep({ now = Date.now(), notify, force = false } = {}) {
  const st = await getSettings();
  if (!st.enabled) return { skipped: true };
  const today = istToday(now);
  let state = {};
  try { const r = await prisma.appSetting.findUnique({ where: { key: STATE_KEY } }); state = r ? JSON.parse(r.value) : {}; } catch { state = {}; }
  if (!force && (state.lastRun === today || istHour(now) < 9)) return { skipped: true };
  const expiry = await remindExpiry({ now, notify, force });
  let reviews = { told: [] };
  try { reviews = await require('./policyRegister').remindReviews({ now, notify, hrUserIds }); } catch (e) { reviews = { error: e.message, told: [] }; } // eslint-disable-line global-require
  const value = JSON.stringify({ lastRun: today });
  await prisma.appSetting.upsert({ where: { key: STATE_KEY }, update: { value }, create: { key: STATE_KEY, value } }).catch(() => null);
  return { expiry, reviews };
}

let timer = null;
function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const tick = () => { sweep().catch((e) => console.error('[doc-register]', e.message)); }; // eslint-disable-line no-console
  setTimeout(tick, 4 * 60 * 1000);
  timer = setInterval(tick, 60 * 60 * 1000); // hourly; it acts once a day after 9 am
  if (timer.unref) timer.unref();
}

module.exports = {
  KINDS, getSettings, saveSettings, list, noNda, peopleFind, documentsOf, createItem, updateItem, renewItem, removeItem, remindExpiry, sweep, startSchedule,
  // shared with utils/policyRegister.js and the tests
  dayOfDate, istToday, isDay, toDate, daysBetween, pretty, cleanLine, cleanText, hrUserIds, milestoneOf, statusOf,
};
