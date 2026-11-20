// ---------------------------------------------------------------------------
// THE FOLLOW-UP REPORT (founder 2026-11-20: "a TL has several recruiters under them ... if the TL wants to check all those
// recruiters' daily, weekly and monthly follow-up reports at once, in one place, how?").
//
// WHO is in the report is decided by utils/followUpScope.js (the one scope function); this file only counts. It reads the
// records the app already writes - no second store:
//
//   TASK      ApplicationFollowUp          a follow-up on an application with a due date; closed with what happened
//   COMMENT   appSetting candlog.* / clientlog.*   "What happened?" lines written on a candidate or a client (+ the call-back day,
//                                          the FollowUpReminder row of the person who wrote it)
//   LOGGED    CandidateMessage QUICK_LOG   a call / mail / WhatsApp logged with the quick buttons
//
// THE ONE RULE FOR CREDIT: a thing is credited to the person who DID it, with the day it was done (IST day, 00:00-23:59).
//   added                  the person who wrote the comment / created the task (createdById). A task raised by the system itself
//                          (a stage change, nobody's act) is nobody's "added". A historical import (createdByName "Imported ...",
//                          no login) is credited to the follow-up's owner on its own date and flagged "imported".
//   done                   the person who closed the task (completedById), on completedAt's IST day. A recruiter who has left stays
//                          credited; a handover moves only the OPEN tasks to the new owner (utils/handover.js), never the closed ones.
//   logged                 the sender of the quick log, on that IST day
//   candidates contacted   unique candidates a person logged, wrote a candidate comment for or closed a task of
//   call-backs promised    follow-ups a person set a call-back date for (task due date / "Call back on" of a comment) falling in the days
//   kept on time           ... of those, done on or before that day (a task closed, or the reminder answered "Done")
//   overdue                every follow-up owed by the person (set by anyone, system ones included) whose day fell in the days, is
//                          before today and was not done by that day (still open, or done later)
//   carried over           owed by the person, due BEFORE the first day and still not done at the start of it
//   interested / not interested / no answer   the recorded outcome of a logged call or closed task
// "Owed by" = the person who closed it, else its owner now, else who created it (a handover moves the open ones to the new owner).
// One follow-up is one row of the list and counts once in each column; the Totals row adds the people up, except "candidates
// contacted", which is unique across the team.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const FS = require('./followUpScope');

const DAY = 86400000;
const IST = 330 * 60000;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const PREFIXES = ['candlog.', 'clientlog.'];
const istDay = (v) => {
  if (!v) return null;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : new Date(t + IST).toISOString().slice(0, 10);
};
const today = () => istDay(new Date());
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dayStartUtc = (d) => new Date(Date.parse(`${d}T00:00:00Z`) - IST);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dm = (d) => `${Number(d.slice(8, 10))} ${MON[Number(d.slice(5, 7)) - 1]}`;
const dmy = (d) => (d ? `${d.slice(8, 10)}-${d.slice(5, 7)}-${d.slice(0, 4)}` : '');
const MAX_DAYS = 400;

// the columns, in the order of every row's `m` array
const FIELDS = ['added', 'done', 'logged', 'contacted', 'promised', 'kept', 'overdue', 'carried', 'interested', 'notInterested', 'noAnswer'];
const LABELS = {
  added: 'Follow-ups added', done: 'Follow-ups done', logged: 'Calls / messages logged', contacted: 'Candidates contacted',
  promised: 'Call-backs promised', kept: 'Call-backs kept on time', overdue: 'Overdue', carried: 'Carried over',
  interested: 'Interested', notInterested: 'Not interested', noAnswer: 'No answer',
};
const HELP = {
  added: 'Follow-ups the person wrote or set on this day',
  done: 'Follow-ups the person closed',
  logged: 'Calls, mails and WhatsApps logged with the quick buttons',
  contacted: 'Different candidates the person called, wrote about or closed a follow-up of',
  promised: 'Follow-ups where the person set a call-back date that falls in these days',
  kept: 'Call-backs promised and done on or before the date',
  overdue: 'Follow-ups owed by the person whose date fell in these days and were not done by that date',
  carried: 'Follow-ups due before the first day and still not done at the start of it',
  interested: 'Logged calls and closed follow-ups with the answer Interested',
  notInterested: 'Logged calls and closed follow-ups with the answer Not interested',
  noAnswer: 'Not picked, busy, switched off, wrong number or no response',
};

// ---- the days asked for ----------------------------------------------------------------------------------------------
function monday(d) { const w = new Date(`${d}T00:00:00Z`).getUTCDay(); return addDays(d, -((w + 6) % 7)); }
function endOfMonth(d) { const x = new Date(`${d.slice(0, 7)}-01T00:00:00Z`); x.setUTCMonth(x.getUTCMonth() + 1); return addDays(x.toISOString().slice(0, 10), -1); }

/** -> { from, to, period } or { error } . period = day | week | month: the columns of the day-by-day table (and the default days). */
function rangeOf(q = {}) {
  const t = today();
  const period = ['day', 'week', 'month'].includes(String(q.period || '')) ? String(q.period) : 'day';
  let from = q.from ? String(q.from) : '';
  let to = q.to ? String(q.to) : '';
  if ((from && !YMD.test(from)) || (to && !YMD.test(to))) return { error: 'Choose the days as dates (year-month-day).' };
  if (from && Number.isNaN(Date.parse(`${from}T00:00:00Z`))) return { error: 'The first day is not a real date.' };
  if (to && Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return { error: 'The last day is not a real date.' };
  if (!from && !to) {
    if (period === 'day') { from = t; to = t; } else if (period === 'week') { from = monday(t); to = addDays(from, 6); } else { from = `${t.slice(0, 7)}-01`; to = endOfMonth(t); }
  } else { from = from || to; to = to || from; }
  if (from > to) return { error: 'The first day is after the last day. Swap them.' };
  if (daysBetween(from, to) + 1 > MAX_DAYS) return { error: `Choose at most ${MAX_DAYS} days at a time.` };
  return { from, to, period };
}

/** The columns of the day-by-day table: days, weeks (Monday to Sunday) or months, clipped to the range. */
function bucketsOf(from, to, period) {
  const n = daysBetween(from, to) + 1;
  // a long range in day columns would be unreadable: step up one level
  let g = period;
  if (g === 'day' && n > 62) g = 'week';
  if (g === 'week' && n > 210) g = 'month';
  const out = [];
  if (g === 'day') {
    for (let d = from; d <= to; d = addDays(d, 1)) out.push({ from: d, to: d, label: dm(d), long: dmy(d) });
  } else if (g === 'week') {
    for (let s = monday(from); s <= to; s = addDays(s, 7)) {
      const f = s < from ? from : s; const e = addDays(s, 6) > to ? to : addDays(s, 6);
      out.push({ from: f, to: e, label: `${dm(f)} - ${dm(e)}`, long: `${dmy(f)} to ${dmy(e)}` });
    }
  } else {
    for (let s = `${from.slice(0, 7)}-01`; s <= to; s = addDays(endOfMonth(s), 1)) {
      const f = s < from ? from : s; const eom = endOfMonth(s); const e = eom > to ? to : eom;
      out.push({ from: f, to: e, label: `${MON[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`, long: `${dmy(f)} to ${dmy(e)}` });
    }
  }
  return { granularity: g, buckets: out };
}

// ---- outcome words ---------------------------------------------------------------------------------------------------
function outcomeClass(text) {
  const t = String(text || '').toLowerCase();
  if (!t) return null;
  if (/not\s+interested/.test(t)) return 'notInterested';
  if (/interested/.test(t)) return 'interested';
  if (/not\s+(picked|answered)|no\s+(response|answer)|busy|switched\s*off|wrong\s+number|unreachable/.test(t)) return 'noAnswer';
  return null;
}
const OUTCOME_WORD = { interested: 'Interested', notInterested: 'Not interested', noAnswer: 'No answer' };

const parseJson = (row) => { try { const v = JSON.parse(row.value); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const chunks = (list, n = 400) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const isImportedTask = (t) => !t.createdById && /^imported\b/i.test(String(t.createdByName || ''));

// ---- reading the records ---------------------------------------------------------------------------------------------
async function readTasks(ids, from, to) {
  const startUtc = dayStartUtc(from);
  const endUtc = dayStartUtc(addDays(to, 1));
  const out = [];
  for (const part of chunks(ids, 300)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.applicationFollowUp.findMany({
      where: {
        AND: [
          { OR: [{ ownerUserId: { in: part } }, { createdById: { in: part } }, { completedById: { in: part } }] },
          { createdAt: { lt: endUtc } },
          { OR: [{ completedAt: null }, { completedAt: { gte: startUtc } }] },
        ],
      },
      select: {
        id: true, candidateId: true, applicationId: true, ownerUserId: true, ownerName: true, createdById: true, createdByName: true, createdAt: true,
        completedAt: true, completedById: true, completedNote: true, dueDate: true, outcome: true, purpose: true, nextAction: true, notes: true, autoCreated: true,
        application: { select: { candidate: { select: { id: true, name: true } }, requirement: { select: { title: true, reqCode: true, internal: true, client: { select: { name: true } } } } } },
      },
    });
    out.push(...rows);
  }
  const seen = new Set();
  return out.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
}

async function readQuick(ids, from, to) {
  const startUtc = dayStartUtc(from);
  const endUtc = dayStartUtc(addDays(to, 1));
  const out = [];
  for (const part of chunks(ids, 300)) {
    // eslint-disable-next-line no-await-in-loop
    out.push(...await prisma.candidateMessage.findMany({
      where: { template: 'QUICK_LOG', senderUserId: { in: part }, createdAt: { gte: startUtc, lt: endUtc } },
      select: { id: true, candidateId: true, applicationId: true, channel: true, body: true, templateLabel: true, senderUserId: true, createdAt: true },
    }));
  }
  return out;
}

// the comments of these people: candlog.<candidate>.<id> and clientlog.<client>.<id>, found by who wrote them (byId in the line),
// whoever last saved the row. Lines imported from a sheet are not credited to anybody here.
async function readComments(ids) {
  const out = [];
  for (const part of chunks(ids, 60)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.appSetting.findMany({
      where: { AND: [{ OR: PREFIXES.map((p) => ({ key: { startsWith: p } })) }, { OR: part.map((id) => ({ value: { contains: `"byId":"${id}"` } })) }] },
      select: { key: true, value: true },
    });
    rows.forEach((r) => { const e = parseJson(r); if (e && e.source !== 'sheet' && e.byId && ids.includes(e.byId) && YMD.test(String(e.onDate || ''))) out.push(e); });
  }
  const seen = new Set();
  return out.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
}

// the call-back of a comment = the reminder row of the person who wrote it
async function readCallBacks(entries) {
  const out = new Map();
  const ids = [...new Set(entries.map((e) => e.id))];
  for (const part of chunks(ids, 400)) {
    let rows = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      rows = await prisma.$queryRawUnsafe(`SELECT entryId, userId, remindOn, status, doneAt FROM "FollowUpReminder" WHERE entryId IN (${part.map(() => '?').join(',')})`, ...part);
    } catch { rows = []; } // the table is made with the first reminder
    rows.forEach((r) => { out.set(`${r.entryId}|${r.userId}`, r); });
  }
  return out;
}

async function labelsOf({ candidateIds, clientIds, applicationIds, requirementIds }) {
  const [cands, clients, apps, reqs] = await Promise.all([
    candidateIds.length ? prisma.candidate.findMany({ where: { id: { in: candidateIds } }, select: { id: true, name: true } }) : [],
    clientIds.length ? prisma.client.findMany({ where: { id: { in: clientIds } }, select: { id: true, name: true } }) : [],
    applicationIds.length ? prisma.application.findMany({ where: { id: { in: applicationIds } }, select: { id: true, requirement: { select: { title: true, reqCode: true, internal: true, client: { select: { name: true } } } } } }) : [],
    requirementIds.length ? prisma.requirement.findMany({ where: { id: { in: requirementIds } }, select: { id: true, title: true, reqCode: true, internal: true, client: { select: { name: true } } } }) : [],
  ]);
  const reqText = (r) => ({ requirement: r ? [r.reqCode, r.title].filter(Boolean).join(' · ') : null, client: r ? (r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null) : null });
  return {
    cand: Object.fromEntries(cands.map((c) => [c.id, c.name])),
    client: Object.fromEntries(clients.map((c) => [c.id, c.name])),
    app: Object.fromEntries(apps.map((a) => [a.id, reqText(a.requirement)])),
    req: Object.fromEntries(reqs.map((r) => [r.id, reqText(r)])),
  };
}

// ---- the items: ONE row per follow-up -------------------------------------------------------------------------------
// item = { key, type, kind, addedBy, addedDay, doneBy, doneDay, owedBy, callBackDay, promisedBy (a person set the date), outcome,
//          imported, candidateId, ... text fields }
async function loadItems(ids, from, to) {
  const [tasks, quick, comments] = await Promise.all([readTasks(ids, from, to), readQuick(ids, from, to), readComments(ids)]);
  const callBacks = await readCallBacks(comments);
  const lab = await labelsOf({
    candidateIds: [...new Set([...quick.map((m) => m.candidateId), ...comments.map((e) => e.candidateId)].filter(Boolean))],
    clientIds: [...new Set(comments.map((e) => e.clientId).filter(Boolean))],
    applicationIds: [...new Set([...quick.map((m) => m.applicationId), ...comments.map((e) => e.applicationId)].filter(Boolean))],
    requirementIds: [...new Set(comments.map((e) => e.requirementId).filter(Boolean))],
  });
  const items = [];

  tasks.forEach((t) => {
    const imported = isImportedTask(t);
    const system = !t.createdById && !imported;
    const addedBy = imported ? (t.ownerUserId || null) : (t.createdById || null);
    const doneBy = t.completedAt ? (t.completedById || t.ownerUserId || null) : null;
    const req = t.application && t.application.requirement;
    const due = YMD.test(String(t.dueDate || '')) ? t.dueDate : null;
    const what = t.completedAt
      ? [t.outcome, t.completedNote || t.notes].filter(Boolean).join(': ') || t.purpose || t.nextAction || 'Follow-up done'
      : `${t.purpose || t.nextAction || 'Follow-up'}${due ? ` (due ${dmy(due)})` : ''}`;
    items.push({
      key: `t${t.id}`, type: 'Task', kind: 'Candidate', source: system ? 'system' : imported ? 'import' : 'manual',
      addedBy: system ? null : addedBy, addedDay: system ? null : istDay(t.createdAt), createdDay: istDay(t.createdAt),
      doneBy, doneDay: t.completedAt ? istDay(t.completedAt) : null,
      owedBy: doneBy || t.ownerUserId || t.createdById || null,
      callBackDay: due, promisedBy: !system && !imported && due ? addedBy : null,
      outcome: outcomeClass(t.outcome), outcomeText: t.outcome || null, imported,
      candidateId: t.candidateId, candidateName: t.application && t.application.candidate ? t.application.candidate.name : null,
      requirement: req ? [req.reqCode, req.title].filter(Boolean).join(' · ') : null,
      client: req ? (req.internal ? 'TeamLink Internal' : (req.client && req.client.name) || null) : null,
      what, link: `/candidates/${t.candidateId}?tab=followups`,
    });
  });

  quick.forEach((m) => {
    const where = lab.app[m.applicationId] || {};
    items.push({
      key: `q${m.id}`, type: 'Logged contact', kind: 'Candidate', source: 'manual',
      addedBy: null, addedDay: null, createdDay: istDay(m.createdAt), doneBy: null, doneDay: null, loggedBy: m.senderUserId, loggedDay: istDay(m.createdAt),
      owedBy: m.senderUserId, callBackDay: null, promisedBy: null, outcome: outcomeClass(m.body), outcomeText: m.body || null, imported: false,
      candidateId: m.candidateId, candidateName: lab.cand[m.candidateId] || null, requirement: where.requirement || null, client: where.client || null,
      what: `${m.channel === 'Email' ? 'Mail' : m.channel}: ${m.body || 'logged'}`, link: `/candidates/${m.candidateId}?tab=followups`,
    });
  });

  comments.forEach((e) => {
    const cand = !!e.candidateId;
    const w = cand ? (lab.app[e.applicationId] || {}) : (lab.req[e.requirementId] || {});
    const cb = callBacks.get(`${e.id}|${e.byId}`);
    const cbDay = cb && YMD.test(String(cb.remindOn || '')) ? cb.remindOn : null;
    const answered = cb && cb.status !== 'OPEN';
    items.push({
      key: `c${e.id}`, type: 'Comment', kind: cand ? 'Candidate' : 'Client', source: 'manual',
      addedBy: e.byId, addedDay: e.onDate, createdDay: e.onDate,
      doneBy: answered ? e.byId : null, doneDay: answered ? (istDay(cb.doneAt) || cbDay) : null, doneIsReminder: true,
      owedBy: e.byId, callBackDay: cbDay, promisedBy: cbDay ? e.byId : null, outcome: null, outcomeText: null, imported: false,
      candidateId: e.candidateId || null, candidateName: cand ? (lab.cand[e.candidateId] || null) : (lab.client[e.clientId] || null),
      requirement: w.requirement || null, client: cand ? (w.client || null) : (lab.client[e.clientId] || null),
      what: e.note, link: cand ? `/candidates/${e.candidateId}?tab=followups` : `/clients/${e.clientId}?tab=followups`,
    });
  });
  return items;
}

// ---- counting --------------------------------------------------------------------------------------------------------
function newCell() { return { m: Object.fromEntries(FIELDS.map((f) => [f, 0])), cands: new Set() }; }

/**
 * Count every column for every person, per column of the day-by-day table and for the whole range.
 *   -> { byPerson: Map(personId -> { total: cell, buckets: [cell...] }), totals: { total: cell, buckets: [cell...] } }
 * `credit(personId, day)` says whether that person's follow-ups of that day belong to the team (a former seat holder: only their days).
 */
function count(items, { from, to, buckets, credit, now = today() }) {
  const idx = new Map();
  buckets.forEach((b, i) => { for (let d = b.from; d <= b.to; d = addDays(d, 1)) idx.set(d, i); });
  const byPerson = new Map();
  const totals = { total: newCell(), buckets: buckets.map(newCell) };
  const person = (id) => { let p = byPerson.get(id); if (!p) { p = { total: newCell(), buckets: buckets.map(newCell) }; byPerson.set(id, p); } return p; };
  const bump = (id, day, field, candidateId) => {
    if (!id || !day || day < from || day > to || !credit(id, day)) return;
    const i = idx.get(day);
    if (i === undefined) return;
    const p = person(id);
    [[p.total, totals.total], [p.buckets[i], totals.buckets[i]]].forEach(([cell, tcell]) => {
      if (field === 'contacted') {
        if (!candidateId) return;
        if (!cell.cands.has(candidateId)) { cell.cands.add(candidateId); cell.m.contacted += 1; }
        if (!tcell.cands.has(candidateId)) { tcell.cands.add(candidateId); tcell.m.contacted += 1; }
      } else { cell.m[field] += 1; tcell.m[field] += 1; }
    });
  };
  const carried = (id, d0, cellOf) => { if (id && credit(id, d0)) { const c = cellOf(person(id)); c.m.carried += 1; } };

  items.forEach((it) => {
    // added / done / logged, on their own days
    if (it.addedBy) bump(it.addedBy, it.addedDay, 'added');
    if (it.type === 'Task' && it.doneBy) {
      bump(it.doneBy, it.doneDay, 'done');
      if (it.kind === 'Candidate') bump(it.doneBy, it.doneDay, 'contacted', it.candidateId);
      if (it.outcome) bump(it.doneBy, it.doneDay, it.outcome);
    }
    if (it.type === 'Logged contact') {
      bump(it.loggedBy, it.loggedDay, 'logged');
      bump(it.loggedBy, it.loggedDay, 'contacted', it.candidateId);
      if (it.outcome) bump(it.loggedBy, it.loggedDay, it.outcome);
    }
    if (it.type === 'Comment' && it.kind === 'Candidate') bump(it.addedBy, it.addedDay, 'contacted', it.candidateId);
    // call-backs: counted on the call-back day
    if (it.callBackDay) {
      if (it.promisedBy) {
        bump(it.promisedBy, it.callBackDay, 'promised');
        if (it.doneDay && it.doneDay <= it.callBackDay) bump(it.promisedBy, it.callBackDay, 'kept');
      }
      const late = it.callBackDay < now && (!it.doneDay || it.doneDay > it.callBackDay);
      if (late && it.type !== 'Logged contact') bump(it.owedBy, it.callBackDay, 'overdue');
    }
  });

  // carried over: due before the start, not done at the start. Per column of the table and for the whole range (from its first day).
  items.forEach((it) => {
    if (!it.callBackDay || it.type === 'Logged contact' || !it.owedBy) return;
    if (it.createdDay && it.createdDay > from) { /* created inside: handled by its own day */ }
    const open = (d0) => it.callBackDay < d0 && (!it.doneDay || it.doneDay >= d0) && (!it.createdDay || it.createdDay < d0);
    if (open(from)) carried(it.owedBy, from, (p) => p.total);
    buckets.forEach((b, i) => { if (open(b.from)) carried(it.owedBy, b.from, (p) => p.buckets[i]); });
  });
  // the totals' carried = the people's carried added up
  byPerson.forEach((p) => {
    totals.total.m.carried += p.total.m.carried;
    p.buckets.forEach((c, i) => { totals.buckets[i].m.carried += c.m.carried; });
  });
  return { byPerson, totals };
}

const arr = (cell) => FIELDS.map((f) => cell.m[f]);
const sumActivity = (cell) => cell.m.added + cell.m.done + cell.m.logged;

// ---- THE REPORT ------------------------------------------------------------------------------------------------------
const TABLE_HEAD = ['Recruiter', 'Role', 'TL', ...FIELDS.map((f) => LABELS[f])];

function filterItems(items, q) {
  const imp = String(q.imported || 'include');
  const kind = ['Candidate', 'Client'].includes(q.kind) ? q.kind : null;
  return items.filter((it) => (imp === 'exclude' ? !it.imported : imp === 'only' ? it.imported : true) && (!kind || it.kind === kind));
}

/** The summary: one row per person, totals, the day-by-day matrix. `scope` comes from followUpScope.resolve(). */
async function summary(scope, q = {}) {
  const r = rangeOf(q);
  if (r.error) return { status: 400, body: { error: r.error } };
  const { granularity, buckets } = bucketsOf(r.from, r.to, r.period);
  const members = scope.members;
  const byId = new Map(members.map((m) => [m.id, m]));
  const ids = members.map((m) => m.id);
  const items = filterItems(ids.length ? await loadItems(ids, r.from, r.to) : [], q);
  const credit = (id, day) => FS.inWindow(byId.get(id), day);
  const counted = count(items, { from: r.from, to: r.to, buckets, credit });

  const rows = members.map((m) => {
    const p = counted.byPerson.get(m.id) || { total: newCell(), buckets: buckets.map(newCell) };
    return {
      id: m.id, name: m.name, role: m.role, leadName: m.leadName || null, former: !!m.former, active: m.active, employmentStatus: m.employmentStatus,
      m: arr(p.total), activity: sumActivity(p.total), buckets: p.buckets.map(arr), trend: p.buckets.map(sumActivity),
    };
  }).filter((x) => x.active || x.activity > 0 || x.m[FIELDS.indexOf('carried')] > 0 || x.m[FIELDS.indexOf('overdue')] > 0)
    .sort((a, b) => b.activity - a.activity || String(a.name).localeCompare(String(b.name)));
  const total = { m: arr(counted.totals.total), activity: sumActivity(counted.totals.total), buckets: counted.totals.buckets.map(arr), trend: counted.totals.buckets.map(sumActivity) };
  const table = tableOf(scope, rows, total);
  return {
    status: 200,
    body: {
      from: r.from, to: r.to, period: r.period, granularity, today: today(), mode: scope.mode, kind: scope.kind, label: scope.label,
      fields: FIELDS, labels: FIELDS.map((f) => LABELS[f]), help: FIELDS.map((f) => HELP[f]),
      buckets, rows, total, table,
      leads: scope.leads, departments: scope.departments, teams: scope.teams, leadId: scope.leadId,
      imported: items.filter((i) => i.imported).length,
    },
  };
}

function tableOf(scope, rows, total) {
  const showLead = scope.mode === 'team' && scope.kind !== 'tl';
  const headers = TABLE_HEAD.filter((h, i) => (i === 2 ? showLead : true));
  const line = (name, role, lead, m) => [name, role, lead, ...m].filter((v, i) => (i === 2 ? showLead : true));
  return {
    headers,
    rows: [
      ...rows.map((r) => line(`${r.name}${r.former ? ' (left)' : ''}`, r.role, r.leadName || '', r.m)),
      ...(scope.mode === 'team' ? [line('Total', '', '', total.m)] : []),
    ],
  };
}

// ---- THE LIST: every follow-up of the people in scope, once --------------------------------------------------------
function statusOf(it, now) {
  if (it.type === 'Logged contact') return 'Logged';
  if (it.doneDay) return it.callBackDay && it.doneDay > it.callBackDay ? 'Done late' : 'Done';
  if (it.callBackDay) return it.callBackDay < now ? 'Overdue' : it.callBackDay === now ? 'Due today' : 'Upcoming';
  return it.type === 'Comment' ? 'Written' : 'Open';
}

async function list(scope, q = {}, { all = false } = {}) {
  const r = rangeOf(q);
  if (r.error) return { status: 400, body: { error: r.error } };
  const members = scope.members;
  const byId = new Map(members.map((m) => [m.id, m]));
  const ids = members.map((m) => m.id);
  const now = today();
  const items = filterItems(ids.length ? await loadItems(ids, r.from, r.to) : [], q);
  const credit = (id, day) => !!id && byId.has(id) && FS.inWindow(byId.get(id), day);
  // who may be NAMED: the people of this scope. Anyone else a follow-up passed through is "Someone outside your team".
  const global = ['admin', 'mgmt'].includes(scope.kind);
  const outside = await (global ? require('../db').user.findMany({ where: { id: { in: [...new Set(items.flatMap((i) => [i.addedBy, i.doneBy, i.loggedBy, i.owedBy]).filter((x) => x && !byId.has(x)))] } }, select: { id: true, name: true } }) : []);
  const outName = new Map(outside.map((u) => [u.id, u.name]));
  const nameOf = (id) => (!id ? null : byId.has(id) ? byId.get(id).name : global ? (outName.get(id) || 'Someone else') : 'Someone outside the team');
  const roleOf = (id) => (id && byId.has(id) ? byId.get(id).role : null);

  const rows = [];
  items.forEach((it) => {
    const inRange = (d) => d && d >= r.from && d <= r.to;
    const addedIn = it.addedBy && credit(it.addedBy, it.addedDay) && inRange(it.addedDay);
    const doneIn = it.doneBy && it.type === 'Task' && credit(it.doneBy, it.doneDay) && inRange(it.doneDay);
    const loggedIn = it.loggedBy && credit(it.loggedBy, it.loggedDay) && inRange(it.loggedDay);
    const callIn = it.callBackDay && credit(it.owedBy, it.callBackDay) && inRange(it.callBackDay);
    const carriedIn = it.callBackDay && it.type !== 'Logged contact' && credit(it.owedBy, r.from) && it.callBackDay < r.from && (!it.doneDay || it.doneDay >= r.from) && (!it.createdDay || it.createdDay < r.from);
    if (!(addedIn || doneIn || loggedIn || callIn || carriedIn)) return;
    // the person this row is for: who did it (closed / logged / wrote), else who owes it
    const doer = loggedIn ? it.loggedBy : doneIn ? it.doneBy : addedIn ? it.addedBy : it.owedBy;
    const day = loggedIn ? it.loggedDay : doneIn ? it.doneDay : addedIn ? it.addedDay : it.callBackDay;
    const people = [it.addedBy, it.doneBy, it.loggedBy, it.owedBy].filter((x) => x && byId.has(x));
    rows.push({
      id: it.key, day, type: it.type, kind: it.kind, imported: it.imported,
      byId: doer, byName: nameOf(doer), byRole: roleOf(doer),
      addedByName: nameOf(it.addedBy), doneByName: nameOf(it.doneBy),
      candidateId: it.candidateId, candidateName: it.candidateName, requirement: it.requirement, client: it.client,
      what: it.what, addedDay: it.addedDay || it.loggedDay || null, doneDay: it.doneDay, callBackDay: it.callBackDay,
      outcome: it.outcomeText || (it.outcome ? OUTCOME_WORD[it.outcome] : null), outcomeClass: it.outcome,
      status: statusOf(it, now), carried: !!carriedIn && !addedIn && !doneIn && !callIn, link: it.link,
      people: [...new Set(people)],
    });
  });

  // the filters: a recruiter (of the people in scope), what kind, the outcome, the status, a search
  const personId = q.personId ? String(q.personId) : '';
  let out = rows;
  if (personId) out = out.filter((x) => x.people.includes(personId));
  if (q.status) { const want = String(q.status).split(',').map((s) => s.trim()).filter(Boolean); out = out.filter((x) => want.includes(x.status)); }
  if (q.outcome) out = out.filter((x) => x.outcomeClass === String(q.outcome));
  if (q.type) out = out.filter((x) => x.type === String(q.type));
  const words = String(q.q || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length) {
    out = out.filter((x) => {
      const t = `${x.what} ${x.candidateName || ''} ${x.requirement || ''} ${x.client || ''} ${x.byName || ''} ${x.addedByName || ''} ${x.doneByName || ''}`.toLowerCase();
      return words.every((w) => t.includes(w));
    });
  }
  out.sort((a, b) => String(b.day).localeCompare(String(a.day)) || String(a.byName).localeCompare(String(b.byName)));
  const total = out.length;
  const limit = Math.min(1000, Math.max(1, Number(q.limit) || 300));
  const offset = Math.max(0, Number(q.offset) || 0);
  const page = all ? out : out.slice(offset, offset + limit);
  const clean = page.map(({ people, ...x }) => x);
  return { status: 200, body: { from: r.from, to: r.to, total, offset: all ? 0 : offset, rows: clean, imported: out.filter((x) => x.imported).length } };
}

const LIST_HEAD = ['Date', 'Recruiter', 'Role', 'Type', 'Candidate / client', 'Requirement', 'Client', 'What happened', 'Added on', 'Call back on', 'Done on', 'Outcome', 'Status', 'Imported'];
function listRows(rows) {
  return rows.map((x) => [dmy(x.day), x.byName || '', x.byRole || '', x.type, x.candidateName || '', x.requirement || '', x.client || '', x.what || '', dmy(x.addedDay), dmy(x.callBackDay), dmy(x.doneDay), x.outcome || '', x.carried ? `${x.status} (carried over)` : x.status, x.imported ? 'Imported' : '']);
}

/** One person's day-by-day table (every column per day / week / month) for the drill-down. */
async function person(scope, q = {}) {
  const s = await summary(scope, q);
  if (s.status !== 200) return s;
  const row = s.body.rows.find((x) => x.id === scope.personId) || s.body.rows[0] || null;
  return {
    status: 200,
    body: {
      from: s.body.from, to: s.body.to, period: s.body.period, granularity: s.body.granularity, fields: s.body.fields, labels: s.body.labels, help: s.body.help,
      buckets: s.body.buckets, person: row ? { id: row.id, name: row.name, role: row.role, leadName: row.leadName, former: row.former } : null,
      total: row ? row.m : null, byBucket: row ? row.buckets : [],
    },
  };
}

module.exports = {
  rangeOf, bucketsOf, summary, list, person, listRows, LIST_HEAD, TABLE_HEAD, FIELDS, LABELS, outcomeClass, istDay, today, isImportedTask, tableOf,
};
