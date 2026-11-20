// ---------------------------------------------------------------------------
// JOINING & DROP - WHO REPLACED WHOM (founder 2026-11-20: "where a candidate was replaced, the name of that candidate (who was replaced / who
// replaced) must be clearly visible").
//
// The link itself is one column on the DROPPED person's JoiningRecord (replacementApplicationId, written by core.linkReplacement). Nothing
// new is stored: the other direction ("Replacement for <name>") is read from the same column, so the two names can never disagree.
//
//   enrich(user, rt, recs)      for raw JoiningRecord rows: Map(recordId -> { replacedBy, replacementFor[], state, words })
//   forApplications(user, rt, appIds)   Map(applicationId -> [ "Replacement for ..." items ])  (the replacement person may not have joined yet)
//   waitingFor(user, rt, appId)  the dropped people of the SAME client still waiting for a replacement (the "Who is this a replacement for?" list)
//   tally(rows, today)          replaced / pending / expired / declined counts
//   table(rows, today)          the Replacement table of the report (dropped -> replacement, dates, days to replace)
//
// A name is shown only to a login that may open that person's application (the same scope rule as everywhere); otherwise the line says
// "another candidate" and keeps the dates. A client login only ever sees its own company's people (the link is always inside one client).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./schema');
const V = require('./vocab');
const A = require('./access');

const JOINED = ['JOINED', 'HIRED'];
const chunks = (list, n = 400) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };
const marks = (n) => new Array(n).fill('?').join(',');
const istDay = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60000).toISOString().slice(0, 10) : null);

async function appInfo(ids) {
  const out = new Map();
  for (const part of chunks([...new Set(ids.filter(Boolean))])) {
    // eslint-disable-next-line no-await-in-loop
    const got = await prisma.application.findMany({
      where: { id: { in: part } },
      select: {
        id: true, stage: true, joiningDate: true, joinedAt: true, candidateId: true, requirementId: true, rollStatus: true,
        candidate: { select: { id: true, name: true } }, requirement: { select: { id: true, title: true, reqCode: true, clientId: true, client: { select: { name: true } } } },
      },
    });
    got.forEach((a) => out.set(a.id, a));
  }
  return out;
}
async function recordsOf(appIds) {
  const out = new Map();
  for (const part of chunks([...new Set(appIds.filter(Boolean))])) {
    // eslint-disable-next-line no-await-in-loop
    (await S.rows(`SELECT * FROM "JoiningRecord" WHERE "applicationId" IN (${marks(part.length)})`, ...part)).forEach((r) => out.set(r.applicationId, r));
  }
  return out;
}
async function linkedTo(appIds) {
  const rows = [];
  for (const part of chunks([...new Set(appIds.filter(Boolean))])) {
    // eslint-disable-next-line no-await-in-loop
    rows.push(...await S.rows(`SELECT * FROM "JoiningRecord" WHERE "replacementApplicationId" IN (${marks(part.length)})`, ...part));
  }
  return rows;
}

// May this login read these applications' names? (Admin / client of the same company / the listed HR: yes; everyone else: the scope rule.)
async function mayName(user, rt, appIds) {
  const ids = [...new Set(appIds.filter(Boolean))];
  if (!ids.length) return new Set();
  if (rt.kind === 'admin' || rt.kind === 'client' || (rt.kind === 'hr' && rt.hrOn)) return new Set(ids);
  if (rt.kind === 'none') return new Set();
  const { applicationWhere } = require('../utils/scope'); // eslint-disable-line global-require
  const ok = new Set();
  for (const part of chunks(ids)) {
    // eslint-disable-next-line no-await-in-loop
    (await prisma.application.findMany({ where: { id: { in: part }, ...applicationWhere(user) }, select: { id: true } })).forEach((a) => ok.add(a.id));
  }
  return ok;
}

// The day the replacement joined: its own joining record, else the application's joining date / joined time.
const joinedDayOf = (app, rec) => (rec && rec.joinedOn) || (app && JOINED.includes(app.stage) ? (String(app.joiningDate || '').slice(0, 10) || istDay(app.joinedAt)) : null) || null;

// The one sentence about a DROPPED record's replacement (state + words). Staff get who owns the task; a client login never reads a TeamLink name.
function describe(rec, by, { task = null, today = V.todayIst(), client = false } = {}) {
  if (!rec || rec.status !== 'Dropped') return { state: null, words: null };
  const periodEnds = rec.guaranteeEndsOn || null;
  const dueBy = rec.replacementExpectedOn || (task && task.endDate) || (task && task.dueOn) || periodEnds || null;
  const owner = !client && task && task.assigneeName ? task.assigneeName : (!client && task && task.assignee ? task.assignee : null);
  if (by) {
    const who = by.hidden ? 'another candidate' : by.candidateName;
    const where = by.jobTitle ? `, ${by.jobTitle}` : '';
    if (by.joined) return { state: 'REPLACED', words: `Replaced by ${who} (joined on ${V.dmy(by.joinedOn)}${where})` };
    return { state: 'ADDED', words: `Replacement ${who} added${where} - not joined yet${dueBy ? `, due by ${V.dmy(dueBy)}` : ''}` };
  }
  if (rec.replacementDecision === 'NOT_NEEDED' || rec.replacementStatus === V.REPL.NOT_NEEDED) return { state: 'DECLINED', words: 'The client said no replacement is needed' };
  if (rec.replacementStatus === V.REPL.CLOSED) return { state: 'CLOSED', words: 'The replacement was closed by hand (no candidate was linked)' };
  const within = rec.dropWithinGuarantee === 1;
  if (within || rec.replacementDecision === 'NEEDED') {
    if (periodEnds && today > periodEnds && rec.replacementDecision !== 'NEEDED') {
      return { state: 'EXPIRED', words: `The replacement period ended on ${V.dmy(periodEnds)} and nobody replaced ${client ? 'this person' : rec.candidateName || 'this person'}` };
    }
    const asked = rec.replacementDecision === 'NEEDED' ? 'the client asked for a replacement' : (rec.replacementDecision === 'LATER' ? 'the client will decide later' : 'waiting for the client\'s answer');
    return { state: 'DUE', words: `Replacement due by ${dueBy ? V.dmy(dueBy) : 'a date not set'} - not yet replaced (${asked}${owner ? `; with ${owner}` : ''})` };
  }
  if (rec.dropWithinGuarantee === 0) return { state: 'NOT_OWED', words: 'Dropped after the replacement period - no replacement is owed' };
  return { state: 'UNKNOWN', words: 'Not yet replaced' };
}

// "Replacement for <name> (dropped on <date>, <client>, <requirement>)"
function forWords(f) {
  const who = f.hidden ? 'another candidate' : f.candidateName;
  return `Replacement for ${who} (dropped on ${V.dmy(f.droppedOn)}${f.clientName ? `, ${f.clientName}` : ''}${f.jobTitle ? `, ${f.jobTitle}` : ''})`;
}

function forItem(r, canName, { client = false } = {}) {
  const hidden = !canName.has(r.applicationId);
  return {
    recordId: r.id, applicationId: r.applicationId, candidateId: hidden || client ? undefined : r.candidateId, candidateName: hidden ? null : r.candidateName,
    hidden, droppedOn: r.droppedOn || null, clientName: r.clientName || null, jobTitle: r.jobTitle || null, jobCode: r.jobCode || null,
    requirementId: r.requirementId || null, linkedAt: r.replacementLinkedAt || null, status: r.status,
  };
}

async function enrich(user, rt, recs) {
  const out = new Map();
  const list = (recs || []).filter(Boolean);
  if (!list.length) return out;
  const client = rt.kind === 'client';
  const repIds = list.map((r) => r.replacementApplicationId).filter(Boolean);
  const [apps, repRecs, back] = await Promise.all([appInfo(repIds), recordsOf(repIds), linkedTo(list.map((r) => r.applicationId))]);
  const canName = await mayName(user, rt, [...repIds, ...back.map((b) => b.applicationId)]);
  const taskIds = list.map((r) => r.replacementTaskId).filter(Boolean);
  const tasks = taskIds.length ? new Map((await prisma.task.findMany({ where: { id: { in: [...new Set(taskIds)] } }, select: { id: true, assigneeName: true, endDate: true, status: true } })).map((t) => [t.id, t])) : new Map();
  const today = V.todayIst();
  list.forEach((r) => {
    let replacedBy = null;
    if (r.replacementApplicationId) {
      const a = apps.get(r.replacementApplicationId);
      const rr = repRecs.get(r.replacementApplicationId);
      const joinedOn = joinedDayOf(a, rr);
      const hidden = !canName.has(r.replacementApplicationId);
      replacedBy = {
        applicationId: r.replacementApplicationId, candidateId: hidden || client ? undefined : (a && a.candidateId) || undefined,
        candidateName: hidden ? null : ((a && a.candidate && a.candidate.name) || (rr && rr.candidateName) || null), hidden,
        joined: !!(a && JOINED.includes(a.stage)) || !!(rr && rr.status), joinedOn, linkedAt: r.replacementLinkedAt || null,
        jobTitle: (a && a.requirement && a.requirement.title) || (rr && rr.jobTitle) || null, jobCode: (a && a.requirement && a.requirement.reqCode) || null,
        requirementId: a ? a.requirementId : null,
        daysToReplace: joinedOn && r.droppedOn ? V.daysBetween(r.droppedOn, joinedOn) : null,
      };
    }
    const replacementFor = back.filter((b) => b.replacementApplicationId === r.applicationId).map((b) => { const it = forItem(b, canName, { client }); return { ...it, words: forWords(it) }; });
    const d = describe(r, replacedBy, { task: r.replacementTaskId ? tasks.get(r.replacementTaskId) : null, today, client });
    out.set(r.id, { replacedBy, replacementFor, state: d.state, words: d.words });
  });
  return out;
}

// The "Replacement for ..." lines of applications (a replacement who has not joined has no record of their own yet).
async function forApplications(user, rt, appIds) {
  const out = new Map();
  const ids = [...new Set((appIds || []).filter(Boolean))];
  if (!ids.length) return out;
  const back = await linkedTo(ids);
  if (!back.length) return out;
  const canName = await mayName(user, rt, back.map((b) => b.applicationId));
  back.forEach((b) => {
    const it = forItem(b, canName, { client: rt.kind === 'client' });
    // a client login only ever reads its own company's lines
    if (rt.kind === 'client' && b.clientId !== user.clientId) return;
    if (!out.has(b.replacementApplicationId)) out.set(b.replacementApplicationId, []);
    out.get(b.replacementApplicationId).push({ ...it, words: forWords(it) });
  });
  return out;
}

// The dialog "Who is this a replacement for?": the dropped people of the SAME client still waiting for a replacement (the same requirement first).
async function waitingFor(user, rt, applicationId) {
  const app = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, candidateId: true, requirementId: true, requirement: { select: { clientId: true, internal: true, client: { select: { name: true } } } }, candidate: { select: { name: true } } },
  });
  if (!app) return null;
  const req = app.requirement || {};
  if (req.internal || !req.clientId) return { application: app, clientName: null, records: [] };
  const rows = await S.rows(
    'SELECT * FROM "JoiningRecord" WHERE "clientId" = ? AND "status" = ? AND COALESCE("replacementStatus", \'\') NOT IN (?, ?, ?) AND "applicationId" <> ? AND "candidateId" <> ? AND "replacementApplicationId" IS NULL',
    req.clientId, 'Dropped', V.REPL.CLOSED, V.REPL.LINKED, V.REPL.NOT_NEEDED, app.id, app.candidateId,
  );
  const waiting = rows.filter((r) => r.hiringType !== 'TeamLink Internal Hire' && r.replacementDecision !== 'NOT_NEEDED'
    && (r.dropWithinGuarantee === 1 || r.replacementDecision === 'NEEDED' || r.replacementTaskState === 'Open'));
  const vis = await A.visible(user, waiting, rt);
  const tasks = await A.taskStates(vis.map((r) => r.replacementTaskId));
  const records = vis.map((r) => {
    const t = r.replacementTaskId ? tasks.get(r.replacementTaskId) : null;
    return {
      id: r.id, candidateName: r.candidateName, droppedOn: r.droppedOn, dropReason: r.dropReason, requirementId: r.requirementId, jobTitle: r.jobTitle, jobCode: r.jobCode,
      sameRequirement: !!app.requirementId && r.requirementId === app.requirementId, dueBy: r.replacementExpectedOn || (t && t.endDate) || r.guaranteeEndsOn || null,
      decision: r.replacementDecision || null,
    };
  }).sort((a, b) => (b.sameRequirement ? 1 : 0) - (a.sameRequirement ? 1 : 0) || String(b.droppedOn || '').localeCompare(String(a.droppedOn || '')));
  return { application: app, clientName: req.client ? req.client.name : null, records };
}

// replaced / pending / expired (+ declined, not owed) over DROPPED rows. `byRec` = enrich()'s map (so a link to a replacement who joined counts as replaced
// even if the record's own status was not closed yet).
function tally(rows, byRec, today = V.todayIst()) {
  const t = { dropped: 0, replaced: 0, added: 0, pending: 0, expired: 0, declined: 0, notOwed: 0 };
  rows.filter((r) => r.status === 'Dropped').forEach((r) => {
    t.dropped += 1;
    const e = byRec.get(r.id) || describe(r, null, { today });
    const s = e.state;
    if (s === 'REPLACED') t.replaced += 1;
    else if (s === 'ADDED') { t.added += 1; t.pending += 1; } else if (s === 'DUE') t.pending += 1;
    else if (s === 'EXPIRED') t.expired += 1;
    else if (s === 'DECLINED') t.declined += 1;
    else if (s === 'NOT_OWED' || s === 'CLOSED') t.notOwed += 1;
  });
  return t;
}

// The Replacement table: every dropped person who OWES or HAS a replacement, with both names and the days it took.
function table(rows, byRec, { client = false } = {}) {
  return rows.filter((r) => r.status === 'Dropped').map((r) => {
    const e = byRec.get(r.id) || {};
    return { r, e };
  }).filter(({ e }) => ['REPLACED', 'ADDED', 'DUE', 'EXPIRED'].includes(e.state)).map(({ r, e }) => ({
    id: r.id, droppedCandidate: r.candidateName, replacementCandidate: e.replacedBy ? (e.replacedBy.hidden ? 'another candidate' : e.replacedBy.candidateName) : null,
    clientName: r.clientName, jobTitle: r.jobTitle, droppedOn: r.droppedOn || null, replacementJoinedOn: e.replacedBy && e.replacedBy.joined ? e.replacedBy.joinedOn : null,
    daysToReplace: e.replacedBy && e.replacedBy.joined ? e.replacedBy.daysToReplace : null, state: e.state, words: e.words,
    ...(client ? {} : { recruiterName: r.recruiterName || null }),
  })).sort((a, b) => String(b.droppedOn || '').localeCompare(String(a.droppedOn || '')));
}

// The compact tags a LIST row carries: Map(applicationId -> { replacedBy, replacementWords, replacementState, replacementFor[] }).
//   tags(user, appIds)   for these applications only (a page of a list): every dropped person with the sentence about their replacement
//                        (due / replaced by / expired ...), and every replacement person with "Replacement for ..."
//   linkIndex(user)      for EVERY linked pair (a big list builds this once): the same tags, linked people only
function pack(e) { return { replacedBy: e.replacedBy || undefined, replacementWords: e.words || undefined, replacementState: e.state || undefined }; }
async function tags(user, appIds, rtIn) {
  const rt = rtIn || await A.rights(user);
  const ids = [...new Set((appIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  const recs = [...(await recordsOf(ids)).values()].filter((r) => r.status === 'Dropped');
  const e = await enrich(user, rt, recs);
  recs.forEach((r) => { out.set(r.applicationId, { ...pack(e.get(r.id) || {}), replacementFor: [] }); });
  (await forApplications(user, rt, ids)).forEach((lines, appId) => { out.set(appId, { ...(out.get(appId) || {}), replacementFor: lines }); });
  return out;
}
async function linkIndex(user, rtIn) {
  const rt = rtIn || await A.rights(user);
  const rows = await S.rows('SELECT * FROM "JoiningRecord" WHERE "replacementApplicationId" IS NOT NULL');
  const out = new Map();
  if (!rows.length) return out;
  const e = await enrich(user, rt, rows);
  const canName = await mayName(user, rt, rows.map((r) => r.applicationId));
  rows.forEach((r) => {
    out.set(r.applicationId, { ...pack(e.get(r.id) || {}), replacementFor: out.has(r.applicationId) ? out.get(r.applicationId).replacementFor : [] });
    const it = forItem(r, canName, { client: rt.kind === 'client' });
    if (rt.kind === 'client' && r.clientId !== user.clientId) return;
    const cur = out.get(r.replacementApplicationId) || { replacementFor: [] };
    out.set(r.replacementApplicationId, { ...cur, replacementFor: [...(cur.replacementFor || []), { ...it, words: forWords(it) }] });
  });
  return out;
}
// the tags of one application onto a row (the same field names everywhere, so one chip component reads them all)
function put(row, tg) {
  if (!row || !tg) return row;
  if (tg.replacedBy) row.replacedBy = tg.replacedBy;
  if (tg.replacementWords) row.replacementWords = tg.replacementWords;
  if (tg.replacementState) row.replacementState = tg.replacementState;
  if (tg.replacementFor && tg.replacementFor.length) row.replacementFor = tg.replacementFor;
  return row;
}

// The Replacement section of a History page / report: counts (replaced / pending / expired ...) and the table (dropped -> replacement, dates, days to replace)
// over the dropped people among these applications.
async function sectionFor(user, appIds, rtIn) {
  const rt = rtIn || await A.rights(user);
  const recs = [...(await recordsOf(appIds)).values()].filter((r) => r.status === 'Dropped');
  const e = await enrich(user, rt, recs);
  return { ...tally(recs, e), table: table(recs, e, { client: rt.kind === 'client' }) };
}

module.exports = { sectionFor, tags, linkIndex, put, enrich, forApplications, waitingFor, tally, table, describe, forWords, joinedDayOf };
