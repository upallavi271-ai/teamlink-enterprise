// ---------------------------------------------------------------------------
// "ASK THE CLIENT MANAGER TO BOOK" (user, 2026-10-12).
//
// Only the BDE books an interview. A Recruiter / TL whose candidate is Sent to client (or later) cannot book,
// so they press one plain button, "Ask the client manager to book". That
//   * sends a bell (and a mail, when company mail is connected) to the job's BDE - the client's BDE, else the
//     BDE of the job's desk, else the BDE TL - with the candidate's name and the job (never a phone, an email
//     or a salary),
//   * puts "Book the interview" on that BDE's follow-ups for today (workspace "Follow-ups due"),
//   * is remembered, so the candidate row reads "Interview requested by <recruiter>" until it is booked,
//   * can be pressed ONCE PER CANDIDATE PER DAY (a second press says who already asked).
// Nothing new is stored in the schema: the request is an audit row (action 'Interview requested').
// ---------------------------------------------------------------------------
const prisma = require('../db');

const ACTION = 'Interview requested';
const ASKABLE_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'];
const LIVE_SLOT = ['SCHEDULED', 'CONFIRMED', 'STARTED', 'RESCHEDULED'];
const TEST_RE = /zztest|example\.test/i;

const istDay = (d = new Date()) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
const istDayStart = (d = new Date()) => new Date(`${istDay(d)}T00:00:00+05:30`);

// Can this application still be asked for? (a stage where an interview is the next thing, no slot booked)
function askState(app) {
  if (!app) return { ok: false, reason: 'Not found.' };
  if (!ASKABLE_STAGES.includes(app.stage)) return { ok: false, reason: 'Send the candidate to the client first. Then you can ask the client manager to book the interview.' };
  if (LIVE_SLOT.includes(app.interviewStatus)) return { ok: false, reason: 'An interview is already booked for this candidate.' };
  // after feedback / completion only another round makes sense; an INTERVIEW_COMPLETED row with no feedback is not asked for
  if (app.stage === 'INTERVIEW_COMPLETED' && app.interviewStatus !== 'FEEDBACK_SUBMITTED') return { ok: false, reason: 'Add the interview feedback first. Then you can ask for the next round.' };
  if (app.stage === 'INTERVIEW_SCHEDULED' && !['CANCELLED', 'NO_SHOW', 'FEEDBACK_SUBMITTED'].includes(app.interviewStatus)) return { ok: false, reason: 'This interview is already booked.' };
  return { ok: true };
}

// Who is asked: the client's BDE(s), else the BDE of the job's desk, else the BDE TL. -> { ids, via }
async function recipientsFor(requirement) {
  const CB = require('./clientBdes'); // eslint-disable-line global-require
  const owners = await CB.ownerBdeIds(requirement).catch(() => []);
  if (owners.length) return { ids: owners, via: 'client' };
  try {
    const { bdeDirectory } = require('./bdeSeats'); // eslint-disable-line global-require
    const { canonicalDepartment } = require('./bdeDesk'); // eslint-disable-line global-require
    const dept = canonicalDepartment(requirement.department || (requirement.client && requirement.client.ownerDepartment));
    if (dept) {
      const dir = await bdeDirectory();
      const desk = dir.all().filter((i) => i.userId && i.active && !i.isTl && i.desk === dept).map((i) => i.userId);
      const live = desk.length ? await prisma.user.findMany({ where: { id: { in: desk }, status: 'Active' }, select: { id: true, name: true, email: true } }) : [];
      const ok = live.filter((u) => process.env.TEST_MODE || !TEST_RE.test(`${u.name} ${u.email}`)).map((u) => u.id);
      if (ok.length) return { ids: ok, via: 'desk' };
    }
  } catch { /* fall through to the BDE TL */ }
  return { ids: await CB.bdeTlIds().catch(() => []), via: 'tl' };
}

// Standing requests for these applications (ids): Map(applicationId -> { by, at }). Only while the application still
// waits for an interview: no booking since the request, no live slot. One audit query for the whole page.
async function requestsFor(applicationIds) {
  const ids = [...new Set((applicationIds || []).map((x) => (x && typeof x === 'object' ? x.id : x)).filter(Boolean).map(String))];
  const out = new Map();
  if (!ids.length) return out;
  const since = new Date(Date.now() - 30 * 86400000);
  const chunk = (list, n = 400) => { const c = []; for (let i = 0; i < list.length; i += n) c.push(list.slice(i, i + n)); return c; };
  for (const part of chunk(ids)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.auditLog.findMany({ where: { action: ACTION, entity: 'Application', entityId: { in: part }, createdAt: { gte: since } }, select: { entityId: true, toValue: true, createdAt: true }, orderBy: { createdAt: 'desc' } }).catch(() => []);
    rows.forEach((r) => { if (!out.has(r.entityId)) out.set(r.entityId, { by: r.toValue || null, at: r.createdAt }); });
  }
  if (!out.size) return out;
  const asked = [...out.keys()];
  const [apps, events] = await Promise.all([
    prisma.application.findMany({ where: { id: { in: asked } }, select: { id: true, stage: true, interviewStatus: true } }).catch(() => []),
    prisma.interviewEvent.findMany({ where: { applicationId: { in: asked }, status: { in: ['SCHEDULED', 'RESCHEDULED'] }, createdAt: { gte: since } }, select: { applicationId: true, createdAt: true } }).catch(() => []),
  ]);
  const bookedAt = new Map();
  events.forEach((e) => { if (!bookedAt.has(e.applicationId) || bookedAt.get(e.applicationId) < e.createdAt) bookedAt.set(e.applicationId, e.createdAt); });
  const byId = new Map(apps.map((a) => [a.id, a]));
  asked.forEach((id) => {
    const a = byId.get(id);
    const req = out.get(id);
    const settled = bookedAt.has(id) && bookedAt.get(id) > req.at;
    if (!a || !ASKABLE_STAGES.includes(a.stage) || settled || LIVE_SLOT.includes(a.interviewStatus)) out.delete(id);
  });
  return out;
}

// Put "Interview requested by <name>" on rows / cards that carry an application id (key 'id' by default).
async function attachTo(items, idKey = 'id') {
  try {
    const list = (items || []).filter((x) => x && x[idKey]);
    if (!list.length) return items;
    const map = await requestsFor(list.map((x) => x[idKey]));
    list.forEach((x) => { const r = map.get(String(x[idKey])); if (r) x.interviewRequest = { by: r.by, at: r.at, line: lineOf(r) }; });
  } catch { /* the marker is a courtesy */ }
  return items;
}

// The words on the candidate row.
const lineOf = (r) => (r ? `Interview requested${r.by ? ` by ${r.by}` : ''}` : null);

// Once per candidate per day. -> the earlier request of today, or null
async function askedToday(candidateId) {
  const row = await prisma.auditLog.findFirst({ where: { action: ACTION, fromValue: String(candidateId), createdAt: { gte: istDayStart() } }, orderBy: { createdAt: 'desc' }, select: { toValue: true, createdAt: true, entityId: true } });
  return row || null;
}

async function ask(user, appId) {
  const { logAudit } = require('./audit'); // eslint-disable-line global-require
  const app = await prisma.application.findUnique({
    where: { id: appId },
    include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: true, recruiter: true, bde: true } } },
  });
  if (!app) return { status: 404, body: { error: 'Application not found' } };
  const r = app.requirement || {};
  if (r.internal) return { status: 409, body: { error: 'This is TeamLink\'s own hiring. HR books those interviews.' } };
  const st = askState(app);
  if (!st.ok) return { status: 409, body: { error: st.reason } };
  const prior = await askedToday(app.candidateId);
  if (prior) {
    return { status: 200, body: { ok: true, already: true, by: prior.toValue || null, message: `Already asked today${prior.toValue ? ` by ${prior.toValue}` : ''}. The client manager has it.` } };
  }
  const to = await recipientsFor(r);
  const people = to.ids.length ? await prisma.user.findMany({ where: { id: { in: to.ids }, status: 'Active' }, select: { id: true, name: true, email: true } }) : [];
  const name = app.candidate ? app.candidate.name : 'A candidate';
  const job = r.reqCode ? `${r.reqCode} · ${r.title}` : r.title;
  const client = (r.client && r.client.name) || '';
  const title = `Interview to book: ${name}`;
  const message = `${user.name} asks you to book the interview for ${name} - ${job}${client ? ` (${client})` : ''}.\nOpen: /ats/calendar?book=${app.id}`;
  const bells = [];
  for (const p of people) {
    if (p.id === user.id) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    bells.push(await prisma.notification.create({ data: { userId: p.id, title, message, channel: 'In-App', recipient: `interview-ask|${app.id}|${p.id}`, status: 'Sent' } }));
  }
  // mail, only when company mail is connected (the sandbox mailer is a fake transport)
  const mailed = [];
  try {
    const ch = await require('./messaging').channelStatus().catch(() => ({})); // eslint-disable-line global-require
    if (ch.Email && ch.Email.configured) {
      for (const p of people) {
        if (!p.email || p.id === user.id) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        const m = await require('./interviewNotices').mailTo(p.email, title, `Hello ${p.name},\n\n${user.name} asks you to book the interview for ${name} - ${job}${client ? ` (${client})` : ''}.\n\nOpen TeamLink -> Interview Calendar -> Book.\n\n- TeamLink`); // eslint-disable-line global-require
        if (m && m.ok) mailed.push(p.id);
      }
    }
  } catch { /* the bell is the sure part */ }
  // "Follow-ups due": Book the interview, today
  try {
    const FU = require('./followups'); // eslint-disable-line global-require
    const target = people.find((p) => p.id !== user.id) || null;
    if (target) {
      const open = await prisma.applicationFollowUp.findMany({ where: { applicationId: app.id, completedAt: null }, orderBy: { createdAt: 'desc' } });
      const mine = open.find((f) => to.ids.includes(f.ownerUserId));
      const note = `Interview requested by ${user.name}.`;
      if (mine) {
        await prisma.applicationFollowUp.update({ where: { id: mine.id }, data: { nextAction: 'Book the interview', purpose: mine.purpose || 'Interview request', dueDate: istDay(), notes: [mine.notes, note].filter(Boolean).join('\n').slice(0, 4000) } });
      } else {
        const names = await FU.resolveNames([r]);
        const snap = FU.chainSnapshot(app, r, names);
        await prisma.applicationFollowUp.create({
          data: {
            applicationId: app.id, candidateId: app.candidateId, requirementId: app.requirementId, ...snap,
            ownerUserId: target.id, ownerName: target.name, ownerRole: 'BDE',
            purpose: 'Interview request', nextAction: 'Book the interview', dueDate: istDay(), notes: note,
            createdById: user.id, createdByName: user.name,
          },
        });
      }
    }
  } catch (err) { console.error('[interview request] follow-up not written:', err.message); } // eslint-disable-line no-console
  await logAudit({ userId: user.id, actorName: user.name, action: ACTION, entity: 'Application', entityId: app.id, fromValue: String(app.candidateId), toValue: user.name, reason: `Asked ${people.map((p) => p.name).join(', ') || 'nobody'} (${to.via})` });
  const who = people.filter((p) => p.id !== user.id).map((p) => p.name);
  return {
    status: 201,
    body: {
      ok: true, by: user.name, told: who, via: to.via, mailed: mailed.length,
      message: who.length ? `Asked ${who.join(', ')} to book the interview.` : 'Saved. No client manager is named for this requirement yet, so nobody was told.',
    },
  };
}

module.exports = { ACTION, ASKABLE_STAGES, askState, recipientsFor, requestsFor, attachTo, lineOf, askedToday, ask };
