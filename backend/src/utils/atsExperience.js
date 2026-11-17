// ---------------------------------------------------------------------------
// CANDIDATE & CLIENT EXPERIENCE (founder ATS audit 2026-11-17, "build what is not built").
//
//   SURVEYS  One short survey per event, never two (dedupeKey is UNIQUE):
//     candidate  after the interview is done  (Interview completed, or the decision straight after an interview)
//                after the offer is released  (stage Offer)
//                after joining                (stage Joined / Hired)
//     client     after each joining (client placements), and once a quarter (Admin / BDE TL press "Send", or the
//                quarterly switch sends it in the first days of a quarter on the real server)
//     The link is the survey id signed with the server secret (HMAC, 45 days): no login, a changed letter = "not valid".
//     Candidate: 1-5 stars + "would you recommend us 0-10" + comment. Client: 0-10 + comment. Either may raise a complaint.
//     The candidate's link goes out through the candidate message queue (interviewNotices.queueCandidateMessage: Email +
//     WhatsApp, the "Candidate emails" switch, do-not-contact, test people) and the client's by email (mailer); the sandbox
//     transports are fake, so a test never reaches anybody. What happened is written on the survey row (sendStatus).
//   NPS      promoters (9-10) minus detractors (0-6), as a % of the answers; average stars. By month / recruiter / client / stage.
//   COMPLAINTS one table for both sides:
//     candidate  raised from the survey page or logged by a recruiter / TL; owner = the recruiter, due in 48 hours; once late
//                it goes to the job's TL (level 2) and the TL is told. Open / In progress / Resolved.
//     client     raised from the client portal or by the BDE; follows the client's ESCALATION MATRIX: level 1 -> 2 -> 3, each
//                with a person and the hours it may stay there (default: recruiter 24 h -> TL 24 h -> BDE TL / manager 48 h).
//   APPLY FUNNEL the public job-portal form says "started" when it opens and how much is filled as the person types; the
//                application marks it submitted. Started / submitted / abandoned / completion rate per job and per source.
//   RETENTION  active clients by month (an open requirement or a joining in the 90 days before the month end), retained /
//                churned / new, joinings and invoices by client, lost clients (no activity 90+ days or marked lost) with the last
//                reason.
// Tables are raw SQL, created on first use (no migration), like utils/recycleBin.js.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const sandbox = require('./sandbox');

const HOUR = 3600000;
const DAY = 24 * HOUR;
const CAND_DUE_HOURS = 48;
const SURVEY_DAYS = 45;
const DEFAULT_LEVEL_HOURS = [24, 24, 48];
const STATUSES = ['Open', 'In progress', 'Resolved'];
const EVENTS = { interview: 'Interview', offer: 'Offer', joining: 'Joining', quarterly: 'Quarterly' };
const isTest = (s) => /zztest|example\.test/i.test(String(s || ''));
const skipPerson = (s) => !sandbox.isSandbox() && isTest(s);
const nowIso = (t = Date.now()) => new Date(t).toISOString();
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const plain = (rows) => (rows || []).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, num(v)])));
const clip = (s, n) => (s === null || s === undefined ? null : String(s).trim().slice(0, n) || null);

// --- tables ------------------------------------------------------------------
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AtsSurvey" ("id" TEXT PRIMARY KEY, "side" TEXT NOT NULL, "event" TEXT NOT NULL,
        "dedupeKey" TEXT NOT NULL UNIQUE, "applicationId" TEXT, "candidateId" TEXT, "clientId" TEXT, "requirementId" TEXT,
        "recruiterId" TEXT, "recruiterName" TEXT, "tlId" TEXT, "bdeId" TEXT, "bdeName" TEXT, "clientName" TEXT, "requirementTitle" TEXT,
        "personName" TEXT, "contactEmail" TEXT, "contactPhone" TEXT, "period" TEXT, "createdAt" TEXT NOT NULL, "createdByName" TEXT,
        "sendStatus" TEXT, "sentAt" TEXT, "answeredAt" TEXT, "stars" INTEGER, "nps" INTEGER, "comment" TEXT, "complaintId" INTEGER)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "AtsSurvey_side_answered" ON "AtsSurvey" ("side", "answeredAt")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AtsComplaint" ("id" INTEGER PRIMARY KEY AUTOINCREMENT, "side" TEXT NOT NULL,
        "source" TEXT, "surveyId" TEXT, "applicationId" TEXT, "candidateId" TEXT, "clientId" TEXT, "requirementId" TEXT,
        "personName" TEXT, "clientName" TEXT, "requirementTitle" TEXT, "subject" TEXT NOT NULL, "details" TEXT,
        "status" TEXT NOT NULL DEFAULT 'Open', "level" INTEGER NOT NULL DEFAULT 1, "ownerId" TEXT, "ownerName" TEXT,
        "tlId" TEXT, "levelPeople" TEXT, "dueAt" TEXT, "escalatedAt" TEXT, "resolvedAt" TEXT, "resolution" TEXT,
        "createdAt" TEXT NOT NULL, "createdById" TEXT, "createdByName" TEXT, "updatedAt" TEXT, "history" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "AtsComplaint_status" ON "AtsComplaint" ("status", "dueAt")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "AtsEscalationMatrix" ("clientId" TEXT PRIMARY KEY,
        "l1UserId" TEXT, "l1Hours" INTEGER, "l2UserId" TEXT, "l2Hours" INTEGER, "l3UserId" TEXT, "l3Hours" INTEGER,
        "updatedAt" TEXT, "updatedByName" TEXT)`);
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ApplyFunnel" ("session" TEXT PRIMARY KEY, "jobId" TEXT NOT NULL,
        "source" TEXT, "startedAt" TEXT NOT NULL, "lastAt" TEXT, "filled" INTEGER DEFAULT 0, "total" INTEGER DEFAULT 0,
        "pct" INTEGER DEFAULT 0, "submittedAt" TEXT, "applicationId" TEXT)`);
      await prisma.$executeRawUnsafe('CREATE INDEX IF NOT EXISTS "ApplyFunnel_job" ON "ApplyFunnel" ("jobId", "startedAt")');
      await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "ClientLostMark" ("clientId" TEXT PRIMARY KEY, "lostAt" TEXT NOT NULL,
        "reason" TEXT, "notes" TEXT, "byName" TEXT, "clearedAt" TEXT)`);
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const q = async (sql, ...p) => { await ensure(); return plain(await prisma.$queryRawUnsafe(sql, ...p)); };
const x = async (sql, ...p) => { await ensure(); return prisma.$executeRawUnsafe(sql, ...p); };

// --- the signed link -----------------------------------------------------------
const secret = () => String(process.env.JWT_SECRET || 'teamlink-ats-survey');
const sig = (v) => crypto.createHmac('sha256', secret()).update(`ats-survey:${v}`).digest('base64url').slice(0, 24);
function surveyToken(id, days = SURVEY_DAYS, now = Date.now()) {
  const body = `${id}.${Math.floor(now / 1000) + days * 86400}`;
  return `${Buffer.from(body).toString('base64url')}.${sig(body)}`;
}
function surveyOfToken(token) {
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
function baseUrl(req) {
  try { return require('./offerLink').publicBase(req); } catch { return String(process.env.APP_BASE_URL || 'http://localhost:5183').replace(/\/+$/, ''); } // eslint-disable-line global-require
}
const surveyUrl = (id, req) => `${baseUrl(req)}/api/public/feedback/${surveyToken(id)}`;

// --- NPS math --------------------------------------------------------------------
function npsOf(rows) {
  const scored = rows.filter((r) => r.nps !== null && r.nps !== undefined && r.nps !== '');
  const promoters = scored.filter((r) => Number(r.nps) >= 9).length;
  const detractors = scored.filter((r) => Number(r.nps) <= 6).length;
  const passives = scored.length - promoters - detractors;
  const starred = rows.filter((r) => Number(r.stars) >= 1);
  return {
    responses: rows.length,
    promoters,
    passives,
    detractors,
    nps: scored.length ? Math.round(((promoters - detractors) * 100) / scored.length) : null,
    avgStars: starred.length ? Math.round((starred.reduce((n, r) => n + Number(r.stars), 0) / starred.length) * 100) / 100 : null,
  };
}

// --- people ----------------------------------------------------------------------
async function userName(id) {
  if (!id) return null;
  const u = await prisma.user.findUnique({ where: { id }, select: { name: true } }).catch(() => null);
  return u ? u.name : null;
}
async function appContext(applicationId) {
  return prisma.application.findUnique({
    where: { id: applicationId },
    include: {
      candidate: true,
      requirement: { select: { id: true, title: true, clientId: true, internal: true, recruiterId: true, tlId: true, bdeId: true, client: { select: { id: true, name: true, bdeOwner: true, secondaryBde: true, contactName: true, contactEmail: true, recruitmentContactName: true, recruitmentContactEmail: true, status: true, clientType: true } } } },
    },
  });
}
async function bdeOf(requirement) {
  const r = requirement || {};
  let id = r.bdeId || null;
  if (!id) {
    try { id = (await require('./clientBdes').ownerBdeIds(r))[0] || null; } catch { id = null; } // eslint-disable-line global-require
  }
  const name = (id && await userName(id)) || (r.client && r.client.bdeOwner) || null;
  return { id, name };
}

// --- surveys ---------------------------------------------------------------------
const newId = () => crypto.randomBytes(12).toString('hex');
async function insertSurvey(row) {
  const cols = Object.keys(row);
  const n = await x(`INSERT OR IGNORE INTO "AtsSurvey" (${cols.map((c) => `"${c}"`).join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map((c) => row[c]));
  return Number(n) > 0;
}
const WORDS = {
  interview: { label: 'Interview experience survey', ask: 'how was your interview experience' },
  offer: { label: 'Offer experience survey', ask: 'how was your experience of receiving the offer' },
  joining: { label: 'Joining experience survey', ask: 'how was your joining experience' },
};

// One survey for this application and event; a second call finds the first and sends nothing. Never throws.
async function ensureCandidateSurvey(applicationId, event, { user = null, req = null } = {}) {
  try {
    if (!WORDS[event]) return { error: 'Unknown survey' };
    const app = await appContext(applicationId);
    if (!app || !app.candidate) return { error: 'Application not found' };
    const r = app.requirement || {};
    const key = `cand:${event}:${app.id}`;
    const [have] = await q('SELECT "id" FROM "AtsSurvey" WHERE "dedupeKey" = ?', key);
    if (have) return { existing: true, id: have.id };
    if (skipPerson(`${app.candidate.name} ${app.candidate.email}`)) return { skipped: 'test person' };
    const recruiterId = app.ownerRecruiterId || r.recruiterId || null;
    const bde = await bdeOf(r);
    const id = newId();
    const made = await insertSurvey({
      id, side: 'candidate', event, dedupeKey: key, applicationId: app.id, candidateId: app.candidateId, clientId: r.clientId || null,
      requirementId: r.id || null, recruiterId, recruiterName: await userName(recruiterId), tlId: r.tlId || null, bdeId: bde.id, bdeName: bde.name,
      clientName: r.internal ? 'TeamLink Internal' : (r.client && r.client.name) || null, requirementTitle: r.title || null,
      personName: app.candidate.name, contactEmail: app.candidate.email || null, contactPhone: app.candidate.phone || null,
      createdAt: nowIso(), createdByName: user ? user.name : 'TeamLink',
    });
    if (!made) return { existing: true };
    const link = surveyUrl(id, req);
    const w = WORDS[event];
    const first = String(app.candidate.name || '').split(/\s+/)[0] || 'there';
    const body = `Hi ${first}, ${w.ask} with TeamLink${r.title ? ` (${r.title})` : ''}? It takes one minute: ${link}\nThank you - TeamLink Consultants`;
    let status = 'Recorded';
    try {
      const IN = require('./interviewNotices'); // eslint-disable-line global-require
      const rows = await IN.queueCandidateMessage(app, {
        template: `SURVEY_${event.toUpperCase()}`, label: w.label, subject: `${w.label} - one minute`, body, actor: user,
        channels: ['Email', 'WhatsApp'], trigger: `Experience survey: ${EVENTS[event]}`,
      });
      status = rows.length ? rows.map((m) => `${m.channel}: ${String(m.status).replace(/_/g, ' ').toLowerCase()}`).join('; ') : 'Not sent: the candidate asked not to be contacted';
    } catch (e) { status = `Not sent: ${String(e.message).slice(0, 120)}`; }
    await x('UPDATE "AtsSurvey" SET "sendStatus" = ?, "sentAt" = ? WHERE "id" = ?', status, nowIso(), id);
    return { created: true, id, link, sendStatus: status };
  } catch (e) {
    console.error('[ats-experience] candidate survey:', e.message); // eslint-disable-line no-console
    return { error: e.message };
  }
}

function quarterOf(t = Date.now()) {
  const d = new Date(t + 330 * 60000);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
function clientContacts(c) {
  const out = [];
  const add = (name, email) => { const e = String(email || '').trim(); if (e && !out.some((o) => o.email.toLowerCase() === e.toLowerCase())) out.push({ name: name || c.name, email: e }); };
  add(c.contactName, c.contactEmail);
  add(c.recruitmentContactName, c.recruitmentContactEmail);
  return out;
}
async function mailClient(c, subject, text) {
  const to = clientContacts(c);
  if (!to.length) return 'Not sent: no contact email on the client';
  if (skipPerson(`${c.name} ${to.map((t) => t.email).join(' ')}`)) return 'Not sent: test client';
  const mailer = require('./mailer'); // eslint-disable-line global-require
  const said = [];
  for (const t of to) {
    // eslint-disable-next-line no-await-in-loop
    const r = await mailer.sendMail({ to: t.email, subject, text, useEmployeeFrom: false, fromName: 'TeamLink Consultants' }).catch((e) => ({ ok: false, error: e.message }));
    said.push(`${t.email}: ${r && r.ok ? 'sent' : `not sent (${(r && (r.error || (r.notConfigured ? 'email not set up' : 'refused'))) || 'refused'})`}`);
  }
  return said.join('; ');
}
// event 'joining' (applicationId) or 'quarterly' (period). One per client per joining / per quarter.
async function ensureClientSurvey(clientId, event, { applicationId = null, period = null, user = null, req = null } = {}) {
  try {
    const c = await prisma.client.findUnique({ where: { id: clientId } });
    if (!c || c.clientType === 'Internal') return { skipped: 'internal or missing client' };
    const per = event === 'quarterly' ? (period || quarterOf()) : null;
    const key = event === 'quarterly' ? `client:quarterly:${clientId}:${per}` : `client:joining:${applicationId}`;
    const [have] = await q('SELECT "id" FROM "AtsSurvey" WHERE "dedupeKey" = ?', key);
    if (have) return { existing: true, id: have.id };
    let app = null;
    if (applicationId) app = await appContext(applicationId);
    const r = (app && app.requirement) || (await prisma.requirement.findFirst({ where: { clientId }, orderBy: { createdAt: 'desc' }, select: { id: true, title: true, clientId: true, bdeId: true, recruiterId: true, tlId: true, internal: true } })) || { clientId };
    const bde = await bdeOf({ ...r, client: c });
    const contact = clientContacts(c)[0] || {};
    const id = newId();
    const made = await insertSurvey({
      id, side: 'client', event, dedupeKey: key, applicationId: applicationId || null, candidateId: app ? app.candidateId : null, clientId,
      requirementId: r.id || null, recruiterId: (app && (app.ownerRecruiterId || r.recruiterId)) || r.recruiterId || null, recruiterName: null, tlId: r.tlId || null,
      bdeId: bde.id, bdeName: bde.name, clientName: c.name, requirementTitle: r.title || null, personName: contact.name || c.contactName || c.name,
      contactEmail: contact.email || null, contactPhone: c.contactPhone || null, period: per, createdAt: nowIso(), createdByName: user ? user.name : 'TeamLink',
    });
    if (!made) return { existing: true };
    const link = surveyUrl(id, req);
    const why = event === 'quarterly' ? `this quarter (${per})` : `the joining of ${app && app.candidate ? app.candidate.name : 'our candidate'}${r.title ? ` for ${r.title}` : ''}`;
    const text = `Dear ${contact.name || 'Sir / Madam'},\n\nHow likely are you to recommend TeamLink Consultants to a colleague? Please tell us about ${why} - one question and a comment, one minute:\n${link}\n\nThank you,\nTeamLink Consultants`;
    const status = await mailClient(c, 'How are we doing? One question from TeamLink', text).catch((e) => `Not sent: ${e.message}`);
    await x('UPDATE "AtsSurvey" SET "sendStatus" = ?, "sentAt" = ? WHERE "id" = ?', status, nowIso(), id);
    return { created: true, id, link, sendStatus: status };
  } catch (e) {
    console.error('[ats-experience] client survey:', e.message); // eslint-disable-line no-console
    return { error: e.message };
  }
}

// The pipeline hook: applyStageMove (routes/applications.js) and recordWorkflowMove (utils/stageEvents.js) call this after every move.
const INTERVIEW_STAGES = ['INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED'];
async function onStage({ applicationId, fromStage, toStage, user = null }) {
  const out = [];
  try {
    if (!applicationId || !toStage || fromStage === toStage) return out;
    if (toStage === 'INTERVIEW_COMPLETED' || (['SELECTED', 'REJECTED', 'HOLD'].includes(toStage) && INTERVIEW_STAGES.includes(fromStage))) {
      out.push(await ensureCandidateSurvey(applicationId, 'interview', { user }));
    }
    if (toStage === 'OFFER') out.push(await ensureCandidateSurvey(applicationId, 'offer', { user }));
    if (['JOINED', 'HIRED'].includes(toStage)) {
      out.push(await ensureCandidateSurvey(applicationId, 'joining', { user }));
      const a = await prisma.application.findUnique({ where: { id: applicationId }, select: { requirement: { select: { clientId: true, internal: true } } } });
      if (a && a.requirement && !a.requirement.internal) out.push(await ensureClientSurvey(a.requirement.clientId, 'joining', { applicationId, user }));
    }
  } catch (e) { console.error('[ats-experience] onStage:', e.message); } // eslint-disable-line no-console
  return out;
}

async function surveyForPage(id) {
  const [s] = await q('SELECT * FROM "AtsSurvey" WHERE "id" = ?', id);
  return s || null;
}
// The answer from the public page. Once only.
async function answerSurvey(id, body = {}) {
  const s = await surveyForPage(id);
  if (!s) return { status: 404, error: 'This link is not valid.' };
  if (s.answeredAt) return { status: 409, error: 'already', survey: s };
  const nps = Number(body.nps);
  if (!Number.isInteger(nps) || nps < 0 || nps > 10) return { status: 400, error: 'Please choose a number from 0 to 10.' };
  let stars = null;
  if (s.side === 'candidate') {
    stars = Number(body.stars);
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) return { status: 400, error: 'Please choose 1 to 5 stars.' };
  }
  const comment = clip(body.comment, 2000);
  const n = await x('UPDATE "AtsSurvey" SET "answeredAt" = ?, "stars" = ?, "nps" = ?, "comment" = ? WHERE "id" = ? AND "answeredAt" IS NULL', nowIso(), stars, nps, comment, id);
  if (!Number(n)) return { status: 409, error: 'already', survey: s };
  let complaint = null;
  const wants = /^(1|yes|on|true)$/i.test(String(body.complain || '')) && String(body.complaint || '').trim();
  if (wants) {
    complaint = await createComplaint({
      side: s.side, source: s.side === 'client' ? 'Client survey' : 'Candidate survey', surveyId: s.id, applicationId: s.applicationId, clientId: s.clientId,
      subject: `${s.side === 'client' ? 'Client' : 'Candidate'} complaint from the ${EVENTS[s.event].toLowerCase()} survey`, details: String(body.complaint),
    }, null);
    if (complaint && complaint.id) await x('UPDATE "AtsSurvey" SET "complaintId" = ? WHERE "id" = ?', complaint.id, s.id);
  }
  // A detractor's answer reaches the people who can act on it (in-app only).
  if (nps <= 6) {
    try {
      const { notifyUsers } = require('./notify'); // eslint-disable-line global-require
      await notifyUsers([s.side === 'client' ? s.bdeId : s.recruiterId, s.tlId].filter(Boolean), {
        title: `Low score (${nps}/10) from ${s.personName || (s.side === 'client' ? 'a client' : 'a candidate')}`,
        message: `${EVENTS[s.event]} survey${s.clientName ? ` · ${s.clientName}` : ''}${comment ? ` - "${comment.slice(0, 140)}"` : ''}`,
      });
    } catch { /* the report still shows it */ }
  }
  return { ok: true, complaint };
}

// --- complaints / escalations ---------------------------------------------------
async function matrixFor(clientId) {
  const [m] = clientId ? await q('SELECT * FROM "AtsEscalationMatrix" WHERE "clientId" = ?', clientId) : [];
  // Defaults: the client's latest job's recruiter -> its TL -> the BDE TL (or the owner BDE).
  const r = clientId ? await prisma.requirement.findFirst({ where: { clientId, OR: [{ recruiterId: { not: null } }, { tlId: { not: null } }] }, orderBy: { createdAt: 'desc' }, select: { recruiterId: true, tlId: true, bdeId: true, clientId: true } }).catch(() => null) : null;
  let bdeTl = null;
  try { bdeTl = (await require('./clientBdes').bdeTlIds())[0] || null; } catch { bdeTl = null; } // eslint-disable-line global-require
  const bde = r ? await bdeOf(r) : { id: null };
  const def = [(r && r.recruiterId) || null, (r && r.tlId) || null, bdeTl || bde.id || null];
  const levels = [1, 2, 3].map((n, i) => {
    const uid = (m && m[`l${n}UserId`]) || def[i];
    const h = (m && Number(m[`l${n}Hours`])) || DEFAULT_LEVEL_HOURS[i];
    return { level: n, userId: uid || null, hours: h, fromDefault: !(m && m[`l${n}UserId`]) };
  });
  for (const l of levels) l.name = await userName(l.userId); // eslint-disable-line no-await-in-loop
  return { clientId, levels, updatedAt: m ? m.updatedAt : null, updatedByName: m ? m.updatedByName : null };
}
async function saveMatrix(clientId, levels, user) {
  const L = [1, 2, 3].map((n) => (Array.isArray(levels) ? levels.find((l) => Number(l.level) === n) : null) || {});
  for (const l of L) {
    const h = Number(l.hours);
    if (l.hours !== undefined && l.hours !== '' && (!Number.isFinite(h) || h < 1 || h > 720)) return { status: 400, error: 'Hours must be from 1 to 720.' };
    if (l.userId) {
      // eslint-disable-next-line no-await-in-loop
      const u = await prisma.user.findUnique({ where: { id: String(l.userId) }, select: { id: true, status: true } });
      if (!u) return { status: 400, error: 'One of the people picked is not a user.' };
    }
  }
  const v = L.map((l, i) => [l.userId ? String(l.userId) : null, l.hours ? Math.round(Number(l.hours)) : DEFAULT_LEVEL_HOURS[i]]);
  await x(`INSERT INTO "AtsEscalationMatrix" ("clientId","l1UserId","l1Hours","l2UserId","l2Hours","l3UserId","l3Hours","updatedAt","updatedByName") VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT("clientId") DO UPDATE SET "l1UserId"=excluded."l1UserId","l1Hours"=excluded."l1Hours","l2UserId"=excluded."l2UserId","l2Hours"=excluded."l2Hours","l3UserId"=excluded."l3UserId","l3Hours"=excluded."l3Hours","updatedAt"=excluded."updatedAt","updatedByName"=excluded."updatedByName"`,
  clientId, v[0][0], v[0][1], v[1][0], v[1][1], v[2][0], v[2][1], nowIso(), user ? user.name : null);
  return matrixFor(clientId);
}
const hist = (row, entry) => { let h = []; try { h = JSON.parse(row && row.history ? row.history : '[]'); } catch { h = []; } h.push({ at: nowIso(), ...entry }); return JSON.stringify(h.slice(-60)); };

async function notify(ids, title, message) {
  try { await require('./notify').notifyUsers([...new Set(ids.filter(Boolean))], { title, message }); } catch { /* the list shows it */ } // eslint-disable-line global-require
}

// side 'candidate' (applicationId) or 'client' (clientId). Returns the row.
async function createComplaint(input, user, { now = Date.now() } = {}) {
  const side = input.side === 'client' ? 'client' : 'candidate';
  const subject = clip(input.subject, 200);
  const details = clip(input.details, 4000);
  if (!subject) return { status: 400, error: 'Say in a few words what the complaint is about.' };
  let app = null; let clientId = input.clientId || null; let personName = clip(input.personName, 120);
  if (input.applicationId) {
    app = await appContext(input.applicationId);
    if (!app) return { status: 404, error: 'That application was not found.' };
    clientId = clientId || (app.requirement && app.requirement.clientId) || null;
  }
  if (side === 'candidate' && !app) return { status: 400, error: 'Pick the candidate\'s application the complaint is about.' };
  const client = clientId ? await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } }) : null;
  if (side === 'client' && !client) return { status: 400, error: 'Pick the client.' };
  const r = (app && app.requirement) || {};
  let ownerId; let tlId = r.tlId || null; let dueAt; let levelPeople = null;
  if (side === 'candidate') {
    ownerId = app.ownerRecruiterId || r.recruiterId || r.tlId || null;
    dueAt = nowIso(now + CAND_DUE_HOURS * HOUR);
    personName = personName || app.candidate.name;
  } else {
    const m = await matrixFor(clientId);
    levelPeople = JSON.stringify(m.levels.map((l) => ({ level: l.level, userId: l.userId, name: l.name, hours: l.hours })));
    ownerId = m.levels[0].userId || m.levels[1].userId || m.levels[2].userId;
    tlId = m.levels[1].userId || tlId;
    dueAt = nowIso(now + m.levels[0].hours * HOUR);
    personName = personName || client.name;
  }
  const ownerName = await userName(ownerId);
  const at = nowIso(now);
  const [ins] = await q(`INSERT INTO "AtsComplaint" ("side","source","surveyId","applicationId","candidateId","clientId","requirementId","personName","clientName","requirementTitle","subject","details","status","level","ownerId","ownerName","tlId","levelPeople","dueAt","createdAt","createdById","createdByName","updatedAt","history")
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'Open',1,?,?,?,?,?,?,?,?,?,?) RETURNING "id"`,
  side, clip(input.source, 60) || (user ? 'Logged by our team' : 'Survey'), input.surveyId || null, app ? app.id : null, app ? app.candidateId : null, clientId,
  r.id || null, personName, client ? client.name : null, r.title || null, subject, details, ownerId, ownerName, tlId, levelPeople, dueAt, at,
  user ? user.id : null, user ? user.name : (side === 'client' ? 'Client' : 'Candidate'), at,
  JSON.stringify([{ at, by: user ? user.name : 'Raised by the person', what: `Raised. Owner: ${ownerName || 'nobody yet'}; due ${dueAt.slice(0, 16).replace('T', ' ')} UTC.` }]));
  const c = await getComplaint(ins.id);
  await notify([ownerId], `New ${side} complaint: ${subject}`, `${personName || ''}${client ? ` · ${client.name}` : ''} - due in ${side === 'candidate' ? CAND_DUE_HOURS : Math.round((Date.parse(dueAt) - now) / HOUR)} hours`);
  try { await require('./audit').logAudit({ userId: user ? user.id : null, action: `${side === 'client' ? 'Client escalation' : 'Candidate complaint'} raised`, entity: 'AtsComplaint', entityId: String(c.id), toValue: subject }); } catch { /* optional */ } // eslint-disable-line global-require
  return c;
}

async function getComplaint(id) {
  const [c] = await q('SELECT * FROM "AtsComplaint" WHERE "id" = ?', Number(id));
  return c || null;
}
async function updateComplaint(id, body, user) {
  const c = await getComplaint(id);
  if (!c) return { status: 404, error: 'Complaint not found.' };
  const status = body.status ? String(body.status) : c.status;
  if (!STATUSES.includes(status)) return { status: 400, error: `Status must be ${STATUSES.join(', ')}.` };
  const note = clip(body.note || body.resolution, 2000);
  if (status === 'Resolved' && c.status !== 'Resolved' && !note) return { status: 400, error: 'Say how it was resolved.' };
  let ownerId = c.ownerId; let ownerName = c.ownerName;
  if (body.ownerId && body.ownerId !== c.ownerId) {
    const u = await prisma.user.findUnique({ where: { id: String(body.ownerId) }, select: { id: true, name: true } });
    if (!u) return { status: 400, error: 'That person was not found.' };
    ownerId = u.id; ownerName = u.name;
  }
  const at = nowIso();
  const what = [status !== c.status ? `Status ${c.status} -> ${status}` : null, ownerId !== c.ownerId ? `Owner -> ${ownerName}` : null, note].filter(Boolean).join('. ') || 'Updated';
  await x('UPDATE "AtsComplaint" SET "status" = ?, "ownerId" = ?, "ownerName" = ?, "resolvedAt" = ?, "resolution" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ?',
    status, ownerId, ownerName, status === 'Resolved' ? (c.resolvedAt || at) : null, status === 'Resolved' ? (note || c.resolution) : c.resolution, at, hist(c, { by: user ? user.name : '-', what }), c.id);
  if (ownerId !== c.ownerId) await notify([ownerId], `Complaint #${c.id} is now yours`, c.subject);
  return getComplaint(c.id);
}

// LATE -> UP ONE LEVEL. candidate: owner (48 h) -> the TL. client: the matrix, level by level, each with its own hours.
// Run by the sweep (real server), on every list load, and by tests with a future `now`. Returns what moved.
async function runEscalations({ now = Date.now() } = {}) {
  const open = await q('SELECT * FROM "AtsComplaint" WHERE "status" != \'Resolved\' AND "dueAt" IS NOT NULL AND "dueAt" < ?', nowIso(now));
  const moved = [];
  for (const c of open) {
    let next = null;
    if (c.side === 'candidate') {
      if (Number(c.level) >= 2) continue;
      next = { level: 2, ownerId: c.tlId || c.ownerId, hours: CAND_DUE_HOURS };
    } else {
      if (Number(c.level) >= 3) continue;
      let people = [];
      try { people = JSON.parse(c.levelPeople || '[]'); } catch { people = []; }
      const lv = people.find((p) => Number(p.level) === Number(c.level) + 1) || {};
      next = { level: Number(c.level) + 1, ownerId: lv.userId || c.ownerId, hours: Number(lv.hours) || DEFAULT_LEVEL_HOURS[Number(c.level)] };
    }
    // eslint-disable-next-line no-await-in-loop
    const ownerName = (await userName(next.ownerId)) || c.ownerName;
    const due = nowIso(now + next.hours * HOUR);
    // eslint-disable-next-line no-await-in-loop
    const n = await x('UPDATE "AtsComplaint" SET "level" = ?, "ownerId" = ?, "ownerName" = ?, "dueAt" = ?, "escalatedAt" = ?, "updatedAt" = ?, "history" = ? WHERE "id" = ? AND "level" = ?',
      next.level, next.ownerId, ownerName, due, nowIso(now), nowIso(now), hist(c, { by: 'TeamLink', what: `Late - escalated to level ${next.level} (${ownerName || 'nobody named'}); due ${due.slice(0, 16).replace('T', ' ')} UTC.` }), c.id, c.level);
    if (!Number(n)) continue;
    moved.push({ id: c.id, level: next.level, ownerId: next.ownerId });
    // eslint-disable-next-line no-await-in-loop
    await notify([next.ownerId, c.ownerId], `⏰ Late ${c.side === 'client' ? 'client escalation' : 'candidate complaint'} #${c.id} - now level ${next.level}`, `${c.subject}${c.clientName ? ` · ${c.clientName}` : ''}${c.personName ? ` · ${c.personName}` : ''}`);
  }
  return { moved };
}

// --- apply funnel (public job portal) ------------------------------------------
const SESSION_RE = /^[A-Za-z0-9_-]{12,64}$/;
async function applyProgress({ session, jobId, filled, total, source }) {
  if (!SESSION_RE.test(String(session || '')) || !jobId) return { error: 'bad' };
  const t = Math.max(0, Math.min(40, Math.round(Number(total) || 0)));
  const f = Math.max(0, Math.min(t || 40, Math.round(Number(filled) || 0)));
  const pct = t ? Math.round((f * 100) / t) : 0;
  const at = nowIso();
  await x(`INSERT INTO "ApplyFunnel" ("session","jobId","source","startedAt","lastAt","filled","total","pct") VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT("session") DO UPDATE SET "lastAt" = excluded."lastAt", "filled" = MAX("ApplyFunnel"."filled", excluded."filled"), "total" = excluded."total",
    "pct" = MAX("ApplyFunnel"."pct", excluded."pct") WHERE "ApplyFunnel"."submittedAt" IS NULL AND "ApplyFunnel"."jobId" = excluded."jobId"`,
  String(session), String(jobId), clip(source, 60), at, at, f, t, pct);
  return { ok: true, pct };
}
async function applySubmitted({ session, jobId, applicationId, source }) {
  const at = nowIso();
  const s = SESSION_RE.test(String(session || '')) ? String(session) : `direct-${applicationId}`;
  await x(`INSERT INTO "ApplyFunnel" ("session","jobId","source","startedAt","lastAt","filled","total","pct","submittedAt","applicationId") VALUES (?,?,?,?,?,0,0,100,?,?)
    ON CONFLICT("session") DO UPDATE SET "submittedAt" = excluded."submittedAt", "applicationId" = excluded."applicationId", "pct" = 100, "lastAt" = excluded."lastAt"`,
  s, String(jobId), clip(source, 60), at, at, at, applicationId);
}

module.exports = {
  ensure, q, x, STATUSES, EVENTS, CAND_DUE_HOURS, DEFAULT_LEVEL_HOURS, surveyToken, surveyOfToken, surveyUrl, npsOf, quarterOf,
  ensureCandidateSurvey, ensureClientSurvey, onStage, surveyForPage, answerSurvey, matrixFor, saveMatrix, createComplaint, getComplaint,
  updateComplaint, runEscalations, applyProgress, applySubmitted, clientContacts, DAY, HOUR,
};
