// ---------------------------------------------------------------------------
// QUALITY OF HIRE (12.12, 2026-11-21) - the client rates the person we placed, 30 / 60 / 90 days after joining.
//
// A survey is one row per joined application and day (AtsQohSurvey). Its link is the row id signed with the server secret
// (60 days; no login - /api/public/qoh/:token, routes/qohPublic.js): opening it only SHOWS the form, the POST records
// the answer once. The client sees the person's name, the job title and four questions - nothing else.
// A team lead / BDE / HR / Admin makes a link by hand (to send it themselves) at any time.
// AUTOMATIC SENDING IS OFF BY DEFAULT: only when an Admin switches "Quality-of-hire surveys" on does the daily check
// create the 30 / 60 / 90-day surveys and e-mail the client's recruitment contact (sandbox: never sent).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const C = require('./core');
const M = require('./metrics');
const { logAudit } = require('../audit');

const DAYS = [30, 60, 90];
const LINK_DAYS = 60;
const secret = () => String(process.env.JWT_SECRET || 'teamlink-ats-qoh');
const sig = (v) => crypto.createHmac('sha256', secret()).update(`ats-qoh:${v}`).digest('base64url').slice(0, 24);
function tokenOf(id, now = Date.now()) {
  const body = `${id}.${Math.floor(now / 1000) + LINK_DAYS * 86400}`;
  return `${Buffer.from(body).toString('base64url')}.${sig(body)}`;
}
function idOfToken(token) {
  const [b, s] = String(token || '').split('.');
  if (!b || !s) return null;
  let body = '';
  try { body = Buffer.from(b, 'base64url').toString('utf8'); } catch { return null; }
  const a = Buffer.from(sig(body)); const c = Buffer.from(s);
  if (a.length !== c.length || !crypto.timingSafeEqual(a, c)) return null;
  const [id, exp] = body.split('.');
  if (!id || !(Number(exp) > Math.floor(Date.now() / 1000))) return null;
  return id;
}
const base = (req) => { try { return require('../offerLink').publicBase(req); } catch { return String(process.env.APP_BASE_URL || 'http://localhost:5183').replace(/\/+$/, ''); } }; // eslint-disable-line global-require
const linkFor = (req, id) => `${base(req)}/api/public/qoh/${tokenOf(id)}`;

async function makeSurvey(app, day, by) {
  await C.ensure();
  const exists = await prisma.$queryRawUnsafe('SELECT * FROM "AtsQohSurvey" WHERE "applicationId" = ? AND "day" = ?', app.id, day);
  if (exists.length) return exists[0];
  const id = C.newId('qoh');
  const jd = C.isoDay(app.joiningDate) || C.istDay(app.joinedAt);
  await prisma.$executeRawUnsafe('INSERT INTO "AtsQohSurvey" ("id","applicationId","candidateId","requirementId","clientId","day","dueOn","createdById","createdByName","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, app.id, app.candidateId, app.requirementId, app.clientId || null, day, jd ? C.addDays(jd, day) : null, by ? by.id : null, by ? by.name || null : 'Automatic', new Date().toISOString());
  return (await prisma.$queryRawUnsafe('SELECT * FROM "AtsQohSurvey" WHERE "id" = ?', id))[0];
}

// A link by hand.
async function createLink(req, body = {}) {
  const user = req.user;
  const acc = await C.access(user);
  if (acc.viewOnly || acc.ownOnly || !(acc.admin || acc.lead || acc.bde)) return { status: 403, error: 'A team lead, a BDE, HR or an Admin makes the quality-of-hire link.' };
  const day = DAYS.includes(Number(body.day)) ? Number(body.day) : 30;
  const ctx = await C.ctxFor(user, {});
  const x = ctx.apps.find((a) => a.id === String(body.applicationId || ''));
  if (!x) return { status: 404, error: 'That joining is not in your area.' };
  if (!x.joined) return { status: 400, error: 'Only a person who joined can be rated.' };
  const s = await makeSurvey({ id: x.id, candidateId: x.a.candidateId, requirementId: x.req.id, clientId: x.req.internal ? null : x.req.clientId, joiningDate: x.a.joiningDate, joinedAt: x.a.joinedAt }, day, user);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Quality-of-hire link made', entity: 'Application', entityId: x.id, toValue: `${day}-day survey` });
  return { ok: true, id: s.id, day, link: linkFor(req, s.id), answered: !!s.answeredAt };
}

// For the public page.
async function forPage(id) {
  await C.ensure();
  const [s] = await prisma.$queryRawUnsafe('SELECT * FROM "AtsQohSurvey" WHERE "id" = ?', String(id));
  if (!s) return null;
  const [cand, req] = await Promise.all([
    s.candidateId ? prisma.candidate.findUnique({ where: { id: s.candidateId }, select: { name: true } }) : null,
    s.requirementId ? prisma.requirement.findUnique({ where: { id: s.requirementId }, select: { title: true, client: { select: { name: true } } } }) : null,
  ]);
  return { ...s, personName: cand ? cand.name : 'the person', jobTitle: req ? req.title : '', clientName: req && req.client ? req.client.name : '' };
}
async function answer(id, b = {}) {
  const s = await forPage(id);
  if (!s) return { error: 'gone' };
  if (s.answeredAt) return { error: 'already' };
  const r = Math.round(Number(b.rating));
  if (!(r >= 1 && r <= 5)) return { error: 'Please choose a rating from 1 to 5.' };
  const sk = Math.round(Number(b.skills)); const at = Math.round(Number(b.attendance));
  const rehire = ['yes', 'no', 'maybe'].includes(String(b.rehire)) ? String(b.rehire) : null;
  const n = await prisma.$executeRawUnsafe('UPDATE "AtsQohSurvey" SET "answeredAt" = ?, "rating" = ?, "skills" = ?, "attendance" = ?, "rehire" = ?, "comment" = ?, "answeredBy" = ? WHERE "id" = ? AND "answeredAt" IS NULL',
    new Date().toISOString(), r, sk >= 1 && sk <= 5 ? sk : null, at >= 1 && at <= 5 ? at : null, rehire, String(b.comment || '').slice(0, 2000) || null, String(b.name || '').slice(0, 100) || null, s.id);
  return n ? { ok: true } : { error: 'already' };
}

// The report: surveys of the joinings in this login's scope.
async function report(user) {
  await C.ensure();
  const ctx = await C.ctxFor(user, {});
  const byApp = new Map(ctx.apps.filter((x) => x.joined || x.pipe.id === 'dropped').map((x) => [x.id, x]));
  const all = await prisma.$queryRawUnsafe('SELECT * FROM "AtsQohSurvey" ORDER BY "createdAt" DESC LIMIT 5000');
  const mine = all.filter((s) => byApp.has(s.applicationId));
  const names = await C.namesOf(mine.map((s) => s.candidateId));
  const rows = mine.map((s) => {
    const x = byApp.get(s.applicationId);
    return {
      id: s.id, applicationId: s.applicationId, candidate: names.get(s.candidateId) || '—', requirement: M.reqLabel(x.req), client: x.req.clientName, recruiter: (x.recruiter && x.recruiter.label) || '—',
      day: Number(s.day), dueOn: s.dueOn, sentAt: s.sentAt, sendStatus: s.sendStatus, answeredAt: s.answeredAt, rating: C.num(s.rating), skills: C.num(s.skills), attendance: C.num(s.attendance), rehire: s.rehire, comment: s.comment,
      stillThere: x.joined,
    };
  });
  const answered = rows.filter((r) => r.answeredAt);
  const avg = (list, k) => { const v = list.map((r) => r[k]).filter((n) => n); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null; };
  const group = (key) => {
    const m = new Map();
    answered.forEach((r) => { const l = m.get(r[key]) || []; l.push(r); m.set(r[key], l); });
    return [...m.entries()].map(([k, l]) => ({ name: k, answers: l.length, rating: avg(l, 'rating'), rehire: Math.round((l.filter((r) => r.rehire === 'yes').length / l.length) * 100) })).sort((a, b) => b.answers - a.answers);
  };
  // joinings that could be asked now and are not yet (for the "make a link" list)
  const t0 = C.today();
  const asked = new Set(mine.map((s) => `${s.applicationId}|${s.day}`));
  const pending = [];
  ctx.apps.forEach((x) => {
    if (!x.joined || x.req.internal) return;
    const jd = C.joinDayOf(x);
    if (!jd) return;
    const since = C.dayDiff(jd, t0);
    DAYS.forEach((d) => { if (since >= d && since < d + 60 && !asked.has(`${x.id}|${d}`)) pending.push({ applicationId: x.id, candidateId: x.a.candidateId, requirement: M.reqLabel(x.req), client: x.req.clientName, joinedOn: jd, day: d }); });
  });
  const pNames = await C.namesOf(pending.map((p) => p.candidateId));
  pending.forEach((p) => { p.candidate = pNames.get(p.candidateId) || '—'; delete p.candidateId; });
  const sw = await C.switches();
  return {
    rows, pending: pending.slice(0, 200),
    totals: { surveys: rows.length, answered: answered.length, rating: avg(answered, 'rating'), skills: avg(answered, 'skills'), attendance: avg(answered, 'attendance'), rehire: answered.length ? Math.round((answered.filter((r) => r.rehire === 'yes').length / answered.length) * 100) : null },
    byClient: group('client'), byRecruiter: group('recruiter'), byDay: DAYS.map((d) => ({ day: d, answers: answered.filter((r) => r.day === d).length, rating: avg(answered.filter((r) => r.day === d), 'rating') })),
    automatic: sw.qoh,
  };
}

// The daily check (only with the switch on): make the due surveys and e-mail the client's recruitment contact.
async function sweep() {
  const sw = await C.switches();
  if (!sw.qoh) return { skipped: 'Quality-of-hire surveys are switched off.' };
  await C.ensure();
  const sys = await require('../atsWork/targets').systemViewer(); // eslint-disable-line global-require
  if (!sys) return { skipped: 'No Super Admin login to read the joinings with.' };
  const ctx = await C.ctxFor(sys, {}, true);
  const t0 = C.today();
  const { sendMail } = require('../mailer'); // eslint-disable-line global-require
  let made = 0; let sent = 0;
  const clients = new Map();
  for (const x of ctx.apps) {
    if (!x.joined || x.req.internal || !x.req.clientId) continue; // eslint-disable-line no-continue
    const jd = C.joinDayOf(x);
    if (!jd) continue; // eslint-disable-line no-continue
    const since = C.dayDiff(jd, t0);
    const day = DAYS.find((d) => since >= d && since < d + 7);
    if (!day) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const s = await makeSurvey({ id: x.id, candidateId: x.a.candidateId, requirementId: x.req.id, clientId: x.req.clientId, joiningDate: x.a.joiningDate, joinedAt: x.a.joinedAt }, day, null);
    if (s.sentAt || s.answeredAt) continue; // eslint-disable-line no-continue
    made += 1;
    if (!clients.has(x.req.clientId)) {
      // eslint-disable-next-line no-await-in-loop
      clients.set(x.req.clientId, await prisma.client.findUnique({ where: { id: x.req.clientId }, select: { recruitmentContactEmail: true, contactEmail: true, recruitmentContactName: true, contactName: true } }));
    }
    const cl = clients.get(x.req.clientId) || {};
    const to = cl.recruitmentContactEmail || cl.contactEmail;
    // eslint-disable-next-line no-await-in-loop
    const p = await forPage(s.id);
    const link = linkFor(null, s.id);
    // eslint-disable-next-line no-await-in-loop
    const r = to ? await sendMail({
      to, subject: `${day} days with ${p.personName}: one minute for a rating`, useEmployeeFrom: false, fromName: 'TeamLink Consultants',
      text: `Dear ${cl.recruitmentContactName || cl.contactName || 'Sir / Madam'},\n\n${p.personName} joined you as ${p.jobTitle} ${day} days ago. How are they doing? Four quick questions:\n${link}\n\nThank you,\nTeamLink Consultants`,
    }) : { ok: false, error: 'No client e-mail' };
    // eslint-disable-next-line no-await-in-loop
    await prisma.$executeRawUnsafe('UPDATE "AtsQohSurvey" SET "sentAt" = ?, "sentTo" = ?, "sendStatus" = ? WHERE "id" = ?', r.ok ? new Date().toISOString() : null, to ? to.replace(/^(.).*(@.*)$/, '$1•••$2') : null, r.ok ? 'Sent' : (r.notConfigured ? 'E-mail not set up' : String(r.error || 'Not sent').slice(0, 120)), s.id);
    if (r.ok) sent += 1;
  }
  return { made, sent };
}
let TIMER = null;
function startSweep() {
  if (TIMER || require('../sandbox').isSandbox()) return; // eslint-disable-line global-require
  TIMER = setInterval(() => { sweep().catch((e) => console.error('[insights qoh]', e.message)); }, 6 * 3600000); // eslint-disable-line no-console
  if (TIMER.unref) TIMER.unref();
}

module.exports = { createLink, forPage, answer, report, sweep, startSweep, tokenOf, idOfToken, DAYS };
