// ---------------------------------------------------------------------------
// CALL-BACK REMINDERS (founder 2026-10-30: "candidate ee time kii call cheyandii anii oste, ai recruiter kii remind
// cheyaliii ... recruiter call back anii click chestey aa candiate kii call vellaliii").
//
// When a call ends with "call me back" (dialogue.js: callbackRequested, callbackAt = the India-time moment the assistant
// understood and repeated back, or only words such as "later"), ONE open reminder is kept per application here: a later
// "call me at 6 instead" moves the same reminder (no duplicates). A moment outside the calling hours moves to the next
// allowed time and says so. The owner is the candidate's own recruiter (application owner), else the requirement's
// recruiter, else whoever placed the call.
//
// The sweep (reminders.tick, every few minutes) tells the owner 15 minutes before, at the time, and once it is an hour
// overdue (then the team lead too, as the backup). On the AI Calling page (Call-backs) and the candidate's AI calls card
// the recruiter presses Call back: AI (the same AI calling as always, continuing from the last talk) or by hand.
// Table AiCallCallback (calling/schema.js). Every time is stored as an ISO moment (UTC); shown in India time.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const DB = require('./schema');
const { notifyUsers } = require('../utils/notify');

const IST = 330 * 60000;
const BEFORE_MS = 15 * 60000;
const OVERDUE_MS = 60 * 60000;
const iso = (d) => (d instanceof Date ? d : new Date(d)).toISOString();
const istText = (d) => {
  const x = new Date(new Date(d).getTime() + IST);
  return `${x.toISOString().slice(0, 10)} ${x.toISOString().slice(11, 16)}`;
};
const hm = (v) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };

// "2026-10-31T17:00" (India time) -> Date
function fromIst(local) {
  const m = /^(\d{4}-\d\d-\d\d)T(\d\d):(\d\d)$/.exec(String(local || ''));
  return m ? new Date(`${m[1]}T${m[2]}:${m[3]}:00+05:30`) : null;
}
// keep inside the calling hours (settings hoursFrom / hoursTo, India time); returns { at, moved }
function intoHours(at, s) {
  const from = hm(s && s.hoursFrom) ?? 9 * 60; const to = hm(s && s.hoursTo) ?? 21 * 60;
  const local = new Date(at.getTime() + IST);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  if (mins >= from && mins < to) return { at, moved: false };
  const day = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (mins >= to ? 1 : 0)));
  return { at: new Date(day.getTime() + from * 60000 - IST), moved: true };
}

async function ownerOf(row) {
  const app = await prisma.application.findUnique({ where: { id: row.applicationId }, select: { ownerRecruiterId: true, requirement: { select: { recruiterId: true, tlId: true } } } }).catch(() => null);
  return {
    owner: (app && (app.ownerRecruiterId || (app.requirement && app.requirement.recruiterId))) || row.initiatedById || null,
    backup: (app && app.requirement && app.requirement.tlId) || null,
  };
}

// After a call's result is saved (outcomes.applyResult). Returns the reminder id or null.
async function fromResult(row, res, ctx, s) {
  if (!res || !res.callbackRequested || res.doNotCallRequested) return null;
  const now = new Date();
  let at = fromIst(res.callbackAt);
  const timeGiven = !!at;
  if (!at) { // no clear time: the next morning, 10:00 India time - the recruiter sees "no time given"
    const local = new Date(now.getTime() + IST);
    at = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1, 10, 0) - IST);
  }
  if (at < now) at = new Date(now.getTime() + 10 * 60000);
  const fit = intoHours(at, s);
  at = fit.at;
  const whenText = [res.callbackWhen || (timeGiven ? '' : 'no time given'), fit.moved ? '(moved into calling hours)' : ''].filter(Boolean).join(' ').slice(0, 160);
  const { owner } = await ownerOf(row);
  const t = iso(now);
  const open = await DB.one('SELECT "id" FROM "AiCallCallback" WHERE "applicationId" = ? AND "status" = ?', row.applicationId, 'pending');
  let id;
  if (open) {
    id = open.id;
    await DB.run(`UPDATE "AiCallCallback" SET "callId" = ?, "purpose" = ?, "dueAt" = ?, "whenText" = ?, "timeGiven" = ?, "language" = ?, "summary" = ?, "interest" = ?,
      "ownerUserId" = COALESCE(?, "ownerUserId"), "notifiedBeforeAt" = NULL, "notifiedDueAt" = NULL, "notifiedOverdueAt" = NULL, "updatedAt" = ? WHERE "id" = ?`,
    row.id, row.purpose, iso(at), whenText, timeGiven ? 1 : 0, res.language || row.language || null, String(res.summary || '').slice(0, 600), res.interest || null, owner, t, id);
  } else {
    id = `aicb_${crypto.randomBytes(9).toString('hex')}`;
    await DB.run(`INSERT INTO "AiCallCallback" ("id","applicationId","candidateId","requirementId","callId","purpose","ownerUserId","dueAt","whenText","timeGiven","status","language","summary","interest","createdAt","updatedAt")
      VALUES (?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?)`,
    id, row.applicationId, row.candidateId, row.requirementId, row.id, row.purpose, owner, iso(at), whenText, timeGiven ? 1 : 0, res.language || row.language || null, String(res.summary || '').slice(0, 600), res.interest || null, t, t);
  }
  if (owner && ctx) {
    await notifyUsers([owner], {
      title: `Call back ${ctx.candidate.name} at ${istText(at)}${timeGiven ? '' : ' (no time given)'}`,
      message: `${ctx.requirement.title}. The candidate asked the AI assistant to call back${res.callbackWhen ? ` (${res.callbackWhen})` : ''}. It is on AI Calling > Call-backs.`,
    }).catch(() => {});
  }
  return id;
}

// The sweep: before / at / overdue notices. Never throws.
async function tick(now = new Date()) {
  const out = { before: 0, due: 0, overdue: 0 };
  const rows = await DB.all('SELECT * FROM "AiCallCallback" WHERE "status" = ? AND "dueAt" <= ?', 'pending', iso(new Date(now.getTime() + BEFORE_MS)));
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const due = new Date(r.dueAt);
    // eslint-disable-next-line no-await-in-loop
    const names = await prisma.candidate.findUnique({ where: { id: r.candidateId }, select: { name: true } }).catch(() => null);
    const who = (names && names.name) || 'the candidate';
    // eslint-disable-next-line no-await-in-loop
    const { owner, backup } = await ownerOf(r);
    const tell = (ids, title) => notifyUsers(ids.filter(Boolean), { title, message: `Open AI Calling > Call-backs and press Call back. ${r.whenText ? `They said: ${r.whenText}.` : ''}`.trim() }).catch(() => {});
    const t = iso(now);
    if (!r.notifiedBeforeAt && due > now) {
      await tell([owner || r.ownerUserId], `In 15 minutes: call back ${who} (${istText(due)})`); // eslint-disable-line no-await-in-loop
      await DB.run('UPDATE "AiCallCallback" SET "notifiedBeforeAt" = ?, "updatedAt" = ? WHERE "id" = ?', t, t, r.id); out.before += 1; // eslint-disable-line no-await-in-loop
    } else if (!r.notifiedDueAt && due <= now && now - due < OVERDUE_MS) {
      await tell([owner || r.ownerUserId], `Now: call back ${who}`); // eslint-disable-line no-await-in-loop
      await DB.run('UPDATE "AiCallCallback" SET "notifiedDueAt" = ?, "updatedAt" = ? WHERE "id" = ?', t, t, r.id); out.due += 1; // eslint-disable-line no-await-in-loop
    } else if (!r.notifiedOverdueAt && now - due >= OVERDUE_MS) {
      await tell([owner || r.ownerUserId, backup], `Overdue: call back ${who} (was due ${istText(due)})`); // eslint-disable-line no-await-in-loop
      await DB.run('UPDATE "AiCallCallback" SET "notifiedOverdueAt" = ?, "updatedAt" = ? WHERE "id" = ?', t, t, r.id); out.overdue += 1; // eslint-disable-line no-await-in-loop
    }
  }
  return out;
}

const statusOf = (r, now = new Date()) => {
  if (r.status === 'done') return 'Completed';
  if (r.status === 'cancelled') return 'Cancelled';
  const due = new Date(r.dueAt).getTime();
  if (now.getTime() - due > 15 * 60000) return 'Overdue';
  if (due - now.getTime() <= 15 * 60000) return 'Due now';
  return r.createdAt !== r.updatedAt && r.callId ? 'Rescheduled' : 'Pending';
};

// The list a login may see (the applications in its scope). Phone numbers only for logins that may contact candidates.
async function list(user, { status = 'open', limit = 300 } = {}) {
  const where = status === 'open' ? '"status" = \'pending\'' : status === 'all' ? '1=1' : '"status" = ?';
  const args = status === 'open' || status === 'all' ? [] : [status];
  const rows = await DB.all(`SELECT * FROM "AiCallCallback" WHERE ${where} ORDER BY "status" = 'pending' DESC, "dueAt" ASC LIMIT ${Math.min(Number(limit) || 300, 500)}`, ...args);
  if (!rows.length) return [];
  const { applicationWhere } = require('../utils/scope'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({
    where: { AND: [{ id: { in: rows.map((r) => r.applicationId) } }, applicationWhere(user)] },
    select: { id: true, stage: true, candidate: { select: { id: true, name: true, phone: true } }, requirement: { select: { id: true, title: true, reqCode: true, internal: true, client: { select: { name: true } } } } },
  });
  const byId = new Map(apps.map((a) => [a.id, a]));
  const CA = require('../utils/contactAccess'); // eslint-disable-line global-require
  const core = require('../utils/messagingCore'); // eslint-disable-line global-require
  const rule = await CA.ruleFor(user, 'candidates').catch(() => ({ allowed: false }));
  const owners = new Map((await prisma.user.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.ownerUserId).filter(Boolean))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const now = new Date();
  return rows.filter((r) => byId.has(r.applicationId)).map((r) => {
    const a = byId.get(r.applicationId);
    return {
      id: r.id, applicationId: r.applicationId, candidateId: r.candidateId, requirementId: r.requirementId, callId: r.callId, purpose: r.purpose,
      candidate: a.candidate.name,
      phone: rule.allowed && rule.mode === 'direct' ? a.candidate.phone || null : null,
      phoneMask: core.maskMobile(a.candidate.phone),
      requirement: { code: a.requirement.reqCode || null, title: a.requirement.title, client: a.requirement.internal ? 'TeamLink' : (a.requirement.client && a.requirement.client.name) || null },
      owner: owners.get(r.ownerUserId) || null,
      dueAt: r.dueAt, dueIst: istText(r.dueAt), whenText: r.whenText, timeGiven: !!r.timeGiven,
      language: r.language, summary: r.summary, interest: r.interest,
      status: statusOf(r, now), raw: r.status, doneHow: r.doneHow, doneAt: r.doneAt, doneBy: r.doneByName, lastCallAt: r.createdAt,
    };
  });
}

async function inScope(user, id) {
  const r = await DB.one('SELECT * FROM "AiCallCallback" WHERE "id" = ?', id);
  if (!r) return null;
  const { applicationWhere } = require('../utils/scope'); // eslint-disable-line global-require
  const ok = await prisma.application.count({ where: { AND: [{ id: r.applicationId }, applicationWhere(user)] } });
  return ok ? r : null;
}

// done / cancelled / moved
async function setStatus(user, id, status, { how, dueAtIst } = {}) {
  const r = await inScope(user, id);
  if (!r) return { ok: false, status: 404, error: 'That call-back was not found.' };
  const t = iso(new Date());
  if (status === 'move') {
    const at = fromIst(dueAtIst);
    if (!at) return { ok: false, status: 400, error: 'Pick the new day and time.' };
    await DB.run('UPDATE "AiCallCallback" SET "dueAt" = ?, "whenText" = ?, "timeGiven" = 1, "status" = \'pending\', "notifiedBeforeAt" = NULL, "notifiedDueAt" = NULL, "notifiedOverdueAt" = NULL, "updatedAt" = ? WHERE "id" = ?',
      iso(at), `moved by ${user.name || 'a recruiter'}`, t, id);
  } else {
    await DB.run('UPDATE "AiCallCallback" SET "status" = ?, "doneAt" = ?, "doneById" = ?, "doneByName" = ?, "doneHow" = ?, "updatedAt" = ? WHERE "id" = ?',
      status, t, user.id, user.name || null, how || null, t, id);
  }
  const { logAudit } = require('../utils/audit'); // eslint-disable-line global-require
  await logAudit({ userId: user.id, action: `AI call-back ${status === 'move' ? 'moved' : status}`, entity: 'Application', entityId: r.applicationId, toValue: status === 'move' ? dueAtIst : (how || status) }).catch(() => {});
  return { ok: true };
}

// The call-back call itself: the SAME AI calling as always (own SIM line when it is set up, else the provider), about the
// same application and purpose. The reminder closes with the new call's id; a new "call me later" opens a new one.
async function callNow(user, id) {
  const r = await inScope(user, id);
  if (!r) return { ok: false, status: 404, error: 'That call-back was not found.' };
  if (r.status !== 'pending') return { ok: false, status: 409, error: 'This call-back is already closed.' };
  const purpose = r.purpose || 'Screening';
  let res;
  const sip = require('./voice/sipCall'); // eslint-disable-line global-require
  if (sip.config().ready) res = await sip.place(user, { applicationId: r.applicationId, purpose, confirm: true });
  else res = await require('./callService').createCalls(user, { items: [r.applicationId], purpose, confirm: true }); // eslint-disable-line global-require
  if (!res || res.ok === false) return res || { ok: false, status: 500, error: 'The call could not be placed.' };
  const first = Array.isArray(res.results) ? res.results[0] : null;
  if (first && !first.ok) return { ok: false, status: first.httpStatus || 409, code: first.code, error: first.error || 'The call could not be placed.' };
  const callId = res.callId || (res.calls && res.calls[0] && res.calls[0].id) || (res.results && res.results[0] && res.results[0].callId) || null;
  const t = iso(new Date());
  await DB.run('UPDATE "AiCallCallback" SET "status" = \'done\', "doneAt" = ?, "doneById" = ?, "doneByName" = ?, "doneHow" = ?, "nextCallId" = ?, "updatedAt" = ? WHERE "id" = ?',
    t, user.id, user.name || null, 'AI call-back', callId, t, id);
  return { ok: true, callId, message: 'The AI assistant is calling the candidate back.' };
}

// The candidate's open reminder (for the AI calls card on the profile)
async function forApplication(applicationId) {
  return DB.one('SELECT * FROM "AiCallCallback" WHERE "applicationId" = ? AND "status" = ? ORDER BY "dueAt" LIMIT 1', applicationId, 'pending');
}

module.exports = { fromResult, tick, list, setStatus, callNow, forApplication, intoHours, fromIst, istText, statusOf };
