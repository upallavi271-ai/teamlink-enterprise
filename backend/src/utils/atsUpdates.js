// ---------------------------------------------------------------------------
// CLIENT UPDATES, POP-UPS, MAILS AND THE "UPDATES & REPORTS" CENTRE (founder 2026-11-23:
// "1. Information that comes from a CLIENT must pop up for everyone concerned; if anyone has interviews, it must pop up on
//  the dashboard. 2. MAIL and POPUP both. 3. Every report and every notification must be displayed on the dashboard.").
//
// ONE EVENT, MANY PEOPLE. A client-side event (feedback on a candidate, a comment, a new / changed requirement, an
// interview request, an offer / joining confirmation, a portal login request, a signed agreement) is written ONCE in
// "AtsUpdateEvent" and fanned out to everyone concerned (recipientsFor below):
//   the client's BDE(s) and the BDE TL(s), the job's TL(s) and recruiters and response recipients, the candidate's owning
//   recruiter, and the Admins / Super Admins (an Admin can switch themselves off: Profile > Client updates).
// Each person is checked against their OWN scope first (applicationWhere / requirementWhere), so nobody hears about a
// record they cannot open; an agreement event never reaches a TL / recruiter / HR (utils/agreementPrivacy.js rule).
// The words never carry a candidate's phone, e-mail or salary (a client's typed note is masked too), so a BDE's limited
// view stays limited.
//
// For each person, "AtsUpdateRecipient" keeps: the pop-up (shown on any ATS page until "Got it" or Open; unseen ones come
// back at the next login), the bell row (Notification, recipient "cu|<event>"), and the mail (one per event, or ONE digest
// when several come within the digest window, 15 minutes by default). That row is the light audit: sent / seen / opened.
//
// SETTINGS (Administration > Step timing > Client updates): per event type pop-up ON/OFF and mail ON/OFF - DEFAULT ON for
// both (the founder asked for them), the digest minutes, the interview mails / pop-ups. Per person: "Mute my mails"
// (Profile). Mail goes through utils/messaging.js (the sandbox never sends; a failure is recorded, never thrown).
//
// INTERVIEWS: the pop-ups 60 and 15 minutes before stay in the existing interview pop-up (utils/interviewHourly.js,
// components/InterviewPopup.jsx) - this file adds the "Your interviews today" list (dashboard + one card a day in the
// pop-up stack) and, while the interview reminder plan itself does not mail the team, the 08:00 morning mail and the mail
// 60 minutes before (sweepInterviewMails), each once per person (AtsUpdateClaim).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const MIN = 60000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const IST = 330 * MIN;
const SETTINGS_KEY = 'ats-updates-settings';
const LIVE = ['SCHEDULED', 'CONFIRMED', 'RESCHEDULED'];
const DECIDED = ['SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMIN'];

// ---- the event types ---------------------------------------------------------------------------------------------------
const TYPES = {
  client_feedback: { label: 'Client feedback on a candidate', hint: 'Shortlist, reject, hold, or interview feedback from the client' },
  client_message: { label: 'Client comment or message', hint: 'A concern or message the client wrote in the portal' },
  client_requirement: { label: 'Client raised or changed a requirement', hint: 'A new job request, or the client confirming / asking to change one' },
  client_interview: { label: 'Client interview request or slot', hint: 'The client asked for an interview or picked a time' },
  client_offer: { label: 'Client confirmed an offer or joining', hint: 'Offer / joining letter released, acknowledged, joined, or a drop' },
  client_login: { label: 'Client portal login request', hint: 'A portal login was asked for a client person' },
  client_agreement: { label: 'Agreement signed by the client', hint: 'BDE side and Admins only' },
  // the TEAM's own changes (utils/teamPopups.js, founder 2026-11-27): pop-up for everyone concerned, no mail unless an Admin switches it on
  team_candidate: { label: 'New candidate on a requirement', hint: 'Added, applied, imported or synced onto a job', mailDefault: false },
  team_requirement: { label: 'New requirement', hint: 'A requirement was added', mailDefault: false },
  team_client: { label: 'New client', hint: 'A client was added', mailDefault: false },
  team_interview: { label: 'Interview booked or moved', hint: 'An interview was booked or its time changed', mailDefault: false },
  team_joined: { label: 'Candidate joined', hint: 'A candidate joined', mailDefault: false },
  team_rejected: { label: 'Candidate rejected', hint: 'A candidate was rejected', mailDefault: false },
  team_move: { label: 'Candidate moved a step', hint: 'Any other step move (sent to client, shortlisted, offer, hold, joining dropped ...)', mailDefault: false },
};
const DEFAULTS = {
  types: Object.fromEntries(Object.keys(TYPES).map((k) => [k, { popup: true, mail: TYPES[k].mailDefault !== false }])),
  digestMinutes: 15,
  interviews: { todayPopup: true, morningMail: true, morningAt: '08:00', hourMail: true, min15Popup: true },
};

const now0 = () => new Date();
const iso = (d) => new Date(d).toISOString();
const istDay = (d = new Date()) => new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10);
const istStart = (day) => new Date(`${day}T00:00:00+05:30`);
const istMinutes = (d) => { const x = new Date(new Date(d).getTime() + IST); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
const hmToMin = (hm) => { const [h, m] = String(hm || '08:00').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
const split = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
const newId = () => `cu${Date.now().toString(36)}${Math.random().toString(36).slice(2, 9)}`;
const isSandbox = () => require('./sandbox').isSandbox(); // eslint-disable-line global-require
const TEST_RE = /zztest|example\.test/i;
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
// A client's typed note may hold a phone number or an e-mail: never passed on (a BDE's limited view stays limited).
const maskContact = (s) => String(s || '')
  .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail hidden]')
  .replace(/(\+?\d[\d\s-]{8,}\d)/g, (m) => (m.replace(/\D/g, '').length >= 10 ? '[number hidden]' : m));

// ---- tables (raw SQL, self-provisioned) ------------------------------------------------------------------------------
let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const sql = [
        'CREATE TABLE IF NOT EXISTS "AtsUpdateEvent" ("id" TEXT PRIMARY KEY, "type" TEXT NOT NULL, "title" TEXT NOT NULL, "summary" TEXT, "open" TEXT, "actorUserId" TEXT, "actorName" TEXT, "clientId" TEXT, "requirementId" TEXT, "applicationId" TEXT, "candidateId" TEXT, "createdAt" TEXT NOT NULL)',
        'CREATE INDEX IF NOT EXISTS "AtsUpdateEvent_at" ON "AtsUpdateEvent" ("createdAt")',
        'CREATE TABLE IF NOT EXISTS "AtsUpdateRecipient" ("eventId" TEXT NOT NULL, "userId" TEXT NOT NULL, "roles" TEXT, "popup" INTEGER NOT NULL DEFAULT 1, "mail" TEXT, "mailAt" TEXT, "seenAt" TEXT, "openedAt" TEXT, "notificationId" TEXT, "createdAt" TEXT NOT NULL, PRIMARY KEY ("eventId", "userId"))',
        'CREATE INDEX IF NOT EXISTS "AtsUpdateRecipient_user" ON "AtsUpdateRecipient" ("userId", "createdAt")',
        'CREATE TABLE IF NOT EXISTS "AtsUpdateRead" ("userId" TEXT NOT NULL, "key" TEXT NOT NULL, "readAt" TEXT NOT NULL, PRIMARY KEY ("userId", "key"))',
        'CREATE TABLE IF NOT EXISTS "AtsUpdatePref" ("userId" TEXT PRIMARY KEY, "muteMail" INTEGER NOT NULL DEFAULT 0, "adminOff" INTEGER NOT NULL DEFAULT 0, "at" TEXT)',
        'CREATE TABLE IF NOT EXISTS "AtsUpdateClaim" ("key" TEXT PRIMARY KEY, "at" TEXT NOT NULL)',
      ];
      for (const s of sql) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const q = async (sql, ...a) => { await ensure(); return prisma.$queryRawUnsafe(sql, ...a); };
const x = async (sql, ...a) => { await ensure(); return prisma.$executeRawUnsafe(sql, ...a); };
async function claim(key, at = new Date()) {
  return Number(await x('INSERT OR IGNORE INTO "AtsUpdateClaim" ("key", "at") VALUES (?, ?)', key, iso(at))) === 1;
}

// ---- settings ---------------------------------------------------------------------------------------------------------
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
function normalise(v = {}) {
  const t = v.types && typeof v.types === 'object' ? v.types : {};
  const iv = v.interviews && typeof v.interviews === 'object' ? v.interviews : {};
  const dm = Number(v.digestMinutes);
  return {
    types: Object.fromEntries(Object.keys(TYPES).map((k) => [k, { popup: bool(t[k] && t[k].popup, true), mail: bool(t[k] && t[k].mail, TYPES[k].mailDefault !== false) }])),
    digestMinutes: Number.isFinite(dm) && dm >= 0 && dm <= 240 ? Math.round(dm) : DEFAULTS.digestMinutes,
    interviews: {
      todayPopup: bool(iv.todayPopup, true),
      morningMail: bool(iv.morningMail, true),
      morningAt: /^([01]\d|2[0-3]):[0-5]\d$/.test(String(iv.morningAt || '')) ? iv.morningAt : DEFAULTS.interviews.morningAt,
      hourMail: bool(iv.hourMail, true),
      min15Popup: bool(iv.min15Popup, true),
    },
  };
}
async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return normalise(v);
}
async function saveSettings(user, body = {}) {
  const cur = await settings();
  const next = normalise({
    types: { ...cur.types, ...Object.fromEntries(Object.entries(body.types || {}).filter(([k]) => TYPES[k]).map(([k, val]) => [k, { ...cur.types[k], ...(val || {}) }])) },
    digestMinutes: body.digestMinutes === undefined ? cur.digestMinutes : body.digestMinutes,
    interviews: { ...cur.interviews, ...(body.interviews || {}) },
  });
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
    create: { key: SETTINGS_KEY, value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
  });
  await require('./audit').logAudit({ userId: user.id, action: 'Client update settings changed', entity: 'Setting', entityId: SETTINGS_KEY, toValue: JSON.stringify(next).slice(0, 500) }).catch(() => {}); // eslint-disable-line global-require
  return next;
}
async function prefOf(userId) {
  const [r] = await q('SELECT * FROM "AtsUpdatePref" WHERE "userId" = ?', userId);
  return { muteMail: !!(r && Number(r.muteMail)), adminOff: !!(r && Number(r.adminOff)) };
}
async function savePref(user, body = {}) {
  const cur = await prefOf(user.id);
  const muteMail = typeof body.muteMail === 'boolean' ? body.muteMail : cur.muteMail;
  const admin = ADMIN_ROLES.includes(user.role) || ADMIN_ROLES.includes(user.atsRole);
  const adminOff = admin && typeof body.adminOff === 'boolean' ? body.adminOff : cur.adminOff;
  await x('INSERT INTO "AtsUpdatePref" ("userId", "muteMail", "adminOff", "at") VALUES (?, ?, ?, ?) ON CONFLICT("userId") DO UPDATE SET "muteMail" = excluded."muteMail", "adminOff" = excluded."adminOff", "at" = excluded."at"',
    user.id, muteMail ? 1 : 0, adminOff ? 1 : 0, iso(now0()));
  return { muteMail, adminOff, admin };
}

// ---- who is concerned -------------------------------------------------------------------------------------------------
// -> Map userId -> roles[]
async function recipientsFor({ type, clientId, requirementId, applicationId }) {
  const want = new Map();
  const add = (id, role) => { if (!id) return; const a = want.get(id) || []; if (!a.includes(role)) a.push(role); want.set(id, a); };
  const BD = require('./clientBdes'); // eslint-disable-line global-require
  let app = null; let reqRow = null;
  if (applicationId) {
    app = await prisma.application.findUnique({ where: { id: applicationId }, select: { id: true, requirementId: true, candidateId: true, ownerRecruiterId: true } }).catch(() => null);
  }
  const rid = requirementId || (app && app.requirementId);
  if (rid) reqRow = await prisma.requirement.findUnique({ where: { id: rid }, include: { client: { select: { id: true, bdeOwner: true, secondaryBde: true } } } }).catch(() => null);
  const cid = clientId || (reqRow && reqRow.clientId);
  const agreement = type === 'client_agreement';
  if (reqRow && !agreement) {
    [reqRow.recruiterId, ...split(reqRow.recruiterIds)].forEach((id) => add(id, 'Recruiter'));
    try { await require('./reqTeamLeads').ensure(); } catch { /* the extras index loads on the next request */ } // eslint-disable-line global-require
    require('./reqTeamLeads').tlsOf(reqRow).forEach((id) => add(id, 'Team lead')); // eslint-disable-line global-require
    if (!reqRow.tlId && reqRow.stlId) add(reqRow.stlId, 'Team lead');
    const rr = await require('./responseRecipients').get(reqRow.id).catch(() => null); // eslint-disable-line global-require
    ((rr && rr.ids) || []).forEach((id) => add(id, 'Response recipient'));
  }
  if (app && app.ownerRecruiterId && !agreement) add(app.ownerRecruiterId, 'Candidate owner');
  const bdes = reqRow ? await BD.ownerBdeIds(reqRow).catch(() => []) : (cid ? await BD.ownerBdeIds({ clientId: cid }).catch(() => []) : []);
  bdes.forEach((id) => add(id, 'Client BDE'));
  (await BD.bdeTlIds().catch(() => [])).forEach((id) => add(id, 'BDE TL'));
  const admins = await prisma.user.findMany({ where: { status: 'Active', OR: [{ role: { in: ADMIN_ROLES } }, { atsRole: { in: ADMIN_ROLES } }] }, select: { id: true } }).catch(() => []);
  admins.forEach((u) => add(u.id, 'Admin'));
  return { want, app, reqRow, clientId: cid };
}

// May this person see the record the event is about? (their OWN scope)
async function mayHear(user, { type, applicationId, requirementId }) {
  if (ADMIN_ROLES.includes(user.role) || ADMIN_ROLES.includes(user.atsRole)) return true;
  if (type === 'client_agreement') {
    const tlRoles = ['TL', 'STL', 'RECRUITER', 'HR'];
    const held = [user.role, user.atsRole];
    if (held.some((r) => tlRoles.includes(r))) {
      const bdeTl = held.includes('TL') && (user.atsDepartment === 'BDE' || /(^|,)\s*BDE\s*(,|$)/.test(user.atsScopeDepartments || ''));
      if (!bdeTl) return false;
    }
  }
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const S = require('./scope'); // eslint-disable-line global-require
  const who = await resolveIdentity(user.id).catch(() => null);
  if (!who) return false;
  try {
    if (applicationId) return (await prisma.application.count({ where: { AND: [{ id: applicationId }, S.applicationWhere(who)] } })) > 0;
    if (requirementId) return (await prisma.requirement.count({ where: { AND: [{ id: requirementId }, S.requirementWhere(who)] } })) > 0;
  } catch { return false; }
  // client-level events: the BDE side and the Admins only
  const r = S.atsViewRole(who);
  return r === 'bde' || r === 'admin' || S.isBdeTl(who);
}

// ---- publish ---------------------------------------------------------------------------------------------------------
// ev: { type, title, summary, open, actor: { id, name }, clientId, requirementId, applicationId, candidateId, now }
async function publish(ev) {
  try {
    if (!ev || !TYPES[ev.type] || !ev.title) return null;
    await ensure();
    const now = ev.now ? new Date(ev.now) : now0();
    const st = await settings();
    const conf = st.types[ev.type];
    const { want, app } = await recipientsFor(ev);
    if (ev.actor && ev.actor.id) want.delete(ev.actor.id);
    if (!want.size) return { id: null, recipients: [] };
    const users = await prisma.user.findMany({
      where: { id: { in: [...want.keys()] }, status: 'Active' },
      select: { id: true, name: true, email: true, role: true, atsRole: true, atsDepartment: true, atsScopeDepartments: true, clientId: true },
    });
    const id = newId();
    const summary = maskContact(clip(ev.summary, 600));
    const title = maskContact(clip(ev.title, 200));
    const open = typeof ev.open === 'string' && /^\/(?!\/)\S*$/.test(ev.open) ? ev.open : null;
    const candidateId = ev.candidateId || (app && app.candidateId) || null;
    const out = [];
    for (const u of users) {
      if (u.clientId || [u.role, u.atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r))) continue; // eslint-disable-line no-continue
      if (!isSandbox() && TEST_RE.test(`${u.name} ${u.email}`)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const pref = await prefOf(u.id);
      const roles = want.get(u.id) || [];
      const adminOnly = roles.length === 1 && roles[0] === 'Admin';
      if (pref.adminOff && (adminOnly || ADMIN_ROLES.includes(u.role))) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (!(await mayHear(u, { type: ev.type, applicationId: ev.applicationId || null, requirementId: ev.requirementId || (app && app.requirementId) || null }))) continue; // eslint-disable-line no-continue
      const by = ev.actor && ev.actor.name ? `By ${ev.actor.name}` : '';
      const message = [summary, by].filter(Boolean).join(' · ') + (open ? `\nOpen: ${open}` : '');
      // eslint-disable-next-line no-await-in-loop
      const n = await prisma.notification.create({ data: { userId: u.id, title, message, channel: 'In-App', recipient: `cu|${id}`, status: 'Sent' } });
      let mail = 'off';
      if (conf.mail) mail = pref.muteMail ? 'muted' : (u.email ? 'pending' : 'no-email');
      // eslint-disable-next-line no-await-in-loop
      await x('INSERT OR IGNORE INTO "AtsUpdateRecipient" ("eventId","userId","roles","popup","mail","notificationId","createdAt") VALUES (?,?,?,?,?,?,?)',
        id, u.id, roles.join(', '), conf.popup ? 1 : 0, mail, n.id, iso(now));
      out.push({ userId: u.id, name: u.name, roles, popup: conf.popup, mail });
    }
    // the event row last: every pop-up (they join on it) appears at the same moment
    await x('INSERT INTO "AtsUpdateEvent" ("id","type","title","summary","open","actorUserId","actorName","clientId","requirementId","applicationId","candidateId","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      id, ev.type, title, summary, open, (ev.actor && ev.actor.id) || null, (ev.actor && ev.actor.name) || null, ev.clientId || null, ev.requirementId || (app && app.requirementId) || null, ev.applicationId || null, candidateId, iso(now));
    // mails: one per event, or the digest when this person already had one within the window
    for (const r of out.filter((o) => o.mail === 'pending')) {
      // eslint-disable-next-line no-await-in-loop
      r.mail = await mailOne(id, r.userId, { now, st });
    }
    await require('./audit').logAudit({ // eslint-disable-line global-require
      userId: (ev.actor && ev.actor.id) || null, actorName: (ev.actor && ev.actor.name) || (ev.type.startsWith('team_') ? 'TeamLink' : 'Client'), action: `${ev.type.startsWith('team_') ? 'Team update' : 'Client update'}: ${TYPES[ev.type].label}`,
      entity: ev.applicationId ? 'Application' : ev.requirementId ? 'Requirement' : 'Client', entityId: ev.applicationId || ev.requirementId || ev.clientId || id,
      toValue: `${title} · told ${out.length} (${out.filter((o) => o.popup).length} pop-ups, ${out.filter((o) => o.mail === 'sent').length} mails, ${out.filter((o) => o.mail === 'digest').length} in digest)`.slice(0, 480),
    }).catch(() => {});
    return { id, recipients: out };
  } catch (err) {
    console.error('[ats-updates] publish:', err.message); // eslint-disable-line no-console
    return null;
  }
}

const OUTCOME = { Sent: 'sent', 'Not configured': 'not-configured', Skipped: 'skipped', Failed: 'failed' };
async function sendMail(to, subject, text) {
  try {
    const r = await require('./messaging').send('Email', { to, subject, text, fromName: 'TeamLink Updates' }); // eslint-disable-line global-require
    if (r.outcome === 'Failed') console.error('[ats-updates] mail failed:', String(r.error || '').slice(0, 200)); // eslint-disable-line no-console
    return OUTCOME[r.outcome] || 'failed';
  } catch (err) {
    console.error('[ats-updates] mail:', err.message); // eslint-disable-line no-console
    return 'failed';
  }
}
const SITE = () => String(process.env.PUBLIC_APP_URL || process.env.APP_URL || '').replace(/\/+$/, '');
const fmtWhen = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true });
function eventLines(e) {
  return [`• ${e.title}`, e.summary ? `  ${e.summary}` : null, `  ${[e.actorName ? `By ${e.actorName}` : null, fmtWhen(e.createdAt)].filter(Boolean).join(' · ')}`, e.open ? `  Open: ${SITE()}${e.open}` : null].filter(Boolean);
}
async function mailOne(eventId, userId, { now, st }) {
  const win = (st.digestMinutes || 0) * MIN;
  if (win > 0) {
    const since = iso(new Date(now.getTime() - win));
    const [{ n } = { n: 0 }] = await q('SELECT COUNT(*) AS "n" FROM "AtsUpdateRecipient" WHERE "userId" = ? AND "eventId" <> ? AND (("mail" = \'digest\') OR ("mail" IN (\'sent\',\'not-configured\',\'failed\',\'skipped\') AND "mailAt" >= ?))', userId, eventId, since);
    if (Number(n) > 0) {
      await x('UPDATE "AtsUpdateRecipient" SET "mail" = \'digest\' WHERE "eventId" = ? AND "userId" = ?', eventId, userId);
      return 'digest';
    }
  }
  const [e] = await q('SELECT * FROM "AtsUpdateEvent" WHERE "id" = ?', eventId);
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true } });
  const outcome = await sendMail(u.email, `TeamLink: ${e.title}`.slice(0, 180), [`Hello ${String(u.name || '').split(' ')[0] || ''},`, '', 'A client update for you:', '', ...eventLines(e), '', 'It is also on your TeamLink dashboard under Updates & reports.', '', '— TeamLink'].join('\n'));
  await x('UPDATE "AtsUpdateRecipient" SET "mail" = ?, "mailAt" = ? WHERE "eventId" = ? AND "userId" = ?', outcome, iso(now), eventId, userId);
  return outcome;
}
// The digest: every person whose oldest waiting update is older than the window gets ONE mail with all of them.
async function flushDigests({ now = now0(), force = false } = {}) {
  const st = await settings();
  const win = (st.digestMinutes || 0) * MIN;
  const rows = await q('SELECT r."userId", r."eventId", r."createdAt" FROM "AtsUpdateRecipient" r WHERE r."mail" = \'digest\' ORDER BY r."createdAt"');
  const by = new Map();
  rows.forEach((r) => { const a = by.get(r.userId) || []; a.push(r); by.set(r.userId, a); });
  const out = [];
  for (const [userId, list] of by) {
    if (!force && new Date(list[0].createdAt).getTime() > now.getTime() - win) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const u = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, email: true, status: true } });
    // eslint-disable-next-line no-await-in-loop
    const pref = await prefOf(userId);
    const ids = list.map((r) => r.eventId);
    // eslint-disable-next-line no-await-in-loop
    const evs = await q(`SELECT * FROM "AtsUpdateEvent" WHERE "id" IN (${ids.map(() => '?').join(',')}) ORDER BY "createdAt"`, ...ids);
    let outcome = 'muted';
    if (u && u.email && u.status === 'Active' && !pref.muteMail) {
      // eslint-disable-next-line no-await-in-loop
      outcome = await sendMail(u.email, `TeamLink: ${evs.length} client updates`, [`Hello ${String(u.name || '').split(' ')[0] || ''},`, '', `${evs.length} client updates came in together:`, '', ...evs.flatMap(eventLines), '', 'They are also on your TeamLink dashboard under Updates & reports.', '', '— TeamLink'].join('\n'));
    }
    // eslint-disable-next-line no-await-in-loop
    await x(`UPDATE "AtsUpdateRecipient" SET "mail" = ?, "mailAt" = ? WHERE "userId" = ? AND "mail" = 'digest' AND "eventId" IN (${ids.map(() => '?').join(',')})`, outcome === 'sent' ? 'sent-digest' : outcome, iso(now), userId, ...ids);
    out.push({ userId, count: ids.length, outcome });
  }
  return out;
}

// ---- the pop-ups ------------------------------------------------------------------------------------------------------
async function popupsFor(userId, { now = now0() } = {}) {
  const rows = await q(`SELECT e.*, r."roles" FROM "AtsUpdateRecipient" r JOIN "AtsUpdateEvent" e ON e."id" = r."eventId"
    WHERE r."userId" = ? AND r."popup" = 1 AND r."seenAt" IS NULL AND r."createdAt" >= ? ORDER BY r."createdAt" DESC LIMIT 20`, userId, iso(new Date(now.getTime() - 14 * DAY)));
  return rows.map((e) => ({
    eventId: e.id, type: e.type, typeLabel: TYPES[e.type] ? TYPES[e.type].label : 'Client update', title: e.title, summary: e.summary, open: e.open, by: e.actorName, at: e.createdAt, roles: e.roles,
  }));
}
async function seen(userId, ids, { opened = false, now = now0() } = {}) {
  const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 100);
  if (!list.length) return 0;
  const ph = list.map(() => '?').join(',');
  const n = await x(`UPDATE "AtsUpdateRecipient" SET "seenAt" = COALESCE("seenAt", ?)${opened ? ', "openedAt" = COALESCE("openedAt", ?)' : ''} WHERE "userId" = ? AND "eventId" IN (${ph})`,
    ...(opened ? [iso(now), iso(now)] : [iso(now)]), userId, ...list);
  await prisma.notification.updateMany({ where: { userId, read: false, recipient: { in: list.map((i) => `cu|${i}`) } }, data: { read: true } }).catch(() => {});
  return Number(n);
}

// ---- "Your interviews today" --------------------------------------------------------------------------------------------
const MODE_WORD = (a) => { const m = String(a.interviewMode || '').toLowerCase(); return m.includes('person') ? 'In person' : (m.includes('tele') || m.includes('phone')) ? 'By phone' : 'Online'; };
async function interviewsToday(user, { now = now0() } = {}) {
  const day = istDay(now);
  const start = istStart(day);
  const S = require('./scope'); // eslint-disable-line global-require
  const TELL = require('./interviewTell'); // eslint-disable-line global-require
  const apps = await prisma.application.findMany({
    where: { AND: [S.applicationWhere(user), { interviewStatus: { in: LIVE }, interviewAt: { gte: start, lt: new Date(start.getTime() + DAY) }, stage: { notIn: DECIDED } }] },
    include: { candidate: { select: { id: true, name: true } }, requirement: { include: { client: { select: { name: true, bdeOwner: true, secondaryBde: true } } } } },
    orderBy: { interviewAt: 'asc' },
    take: 100,
  });
  const items = [];
  for (const a of apps) {
    // eslint-disable-next-line no-await-in-loop
    const ps = await TELL.partiesOf(a).catch(() => []);
    const me = ps.find((p) => p.userId === user.id);
    if (!me) continue; // eslint-disable-line no-continue
    const r = a.requirement || {};
    const mode = MODE_WORD(a);
    items.push({
      applicationId: a.id, candidateId: a.candidateId, at: a.interviewAt,
      time: new Date(a.interviewAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true }),
      candidate: a.candidate ? a.candidate.name : 'Candidate', job: r.title || 'Requirement', requirementId: r.id || null,
      client: r.internal ? 'TeamLink' : (r.client && r.client.name) || '', round: a.interviewRound || 1,
      mode, link: mode === 'Online' ? (a.interviewMeetingLink || null) : null, venue: mode === 'In person' ? (a.interviewLocation || null) : null,
      noLink: mode === 'Online' && !a.interviewMeetingLink, roles: me.roles, past: new Date(a.interviewAt).getTime() < now.getTime() - 30 * MIN,
    });
  }
  const [ack] = await q('SELECT "readAt" FROM "AtsUpdateRead" WHERE "userId" = ? AND "key" = ?', user.id, `iv-today|${day}`);
  const st = await settings();
  return { day, items, popup: st.interviews.todayPopup && items.some((i) => !i.past) && !ack };
}
async function markRead(userId, keys, now = now0()) {
  for (const k of keys) await x('INSERT OR IGNORE INTO "AtsUpdateRead" ("userId", "key", "readAt") VALUES (?, ?, ?)', userId, String(k).slice(0, 200), iso(now)); // eslint-disable-line no-await-in-loop
}

// ---- interview mails to the team (only while the interview reminder plan itself does not mail them) ---------------------
async function planMailsTeam() {
  try {
    const IN = require('./interviewNotices'); // eslint-disable-line global-require
    const PLAN = require('./interviewReminderPlan'); // eslint-disable-line global-require
    const [st, plan] = await Promise.all([IN.loadSettings(), PLAN.load()]);
    return st.enabled === true && plan.armed === true;
  } catch { return false; }
}
async function sweepInterviewMails({ now = now0(), dryRun = false } = {}) {
  const st = await settings();
  const out = { morning: 0, hour: 0, skipped: null };
  if (await planMailsTeam()) { out.skipped = 'The interview reminder plan mails the team itself.'; return out; }
  const staffSt = await require('./interviewNotices').loadStaffSettings(); // eslint-disable-line global-require
  if (staffSt.enabled === false) { out.skipped = 'Team interview reminders are switched off.'; return out; }
  const TELL = require('./interviewTell'); // eslint-disable-line global-require
  const IN = require('./interviewNotices'); // eslint-disable-line global-require
  const t = now.getTime();
  const row = (a) => {
    const r = a.requirement || {};
    const where = MODE_WORD(a) === 'In person' ? `In person${a.interviewLocation ? ` at ${a.interviewLocation}` : ''}` : MODE_WORD(a) === 'By phone' ? 'By phone' : `Online${a.interviewMeetingLink ? ` - ${a.interviewMeetingLink}` : ' - no link yet'}`;
    return `${new Date(a.interviewAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true })} · ${a.candidate ? a.candidate.name : 'Candidate'} · Round ${a.interviewRound || 1} · ${r.title || 'Requirement'} (${r.internal ? 'TeamLink' : (r.client && r.client.name) || ''}) · ${where}`;
  };
  const include = { candidate: { select: { id: true, name: true } }, requirement: { include: { client: true } } };
  // the morning list, once a day per person
  if (st.interviews.morningMail && istMinutes(now) >= hmToMin(st.interviews.morningAt)) {
    const day = istDay(now);
    const start = istStart(day);
    const apps = await prisma.application.findMany({ where: { interviewStatus: { in: LIVE }, interviewAt: { gte: new Date(Math.max(start.getTime(), t - 30 * MIN)), lt: new Date(start.getTime() + DAY) }, stage: { notIn: DECIDED } }, include, orderBy: { interviewAt: 'asc' }, take: 500 });
    const per = new Map();
    for (const a of apps) {
      if (IN.skipPerson(a.candidate && a.candidate.name)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      (await TELL.partiesOf(a).catch(() => [])).forEach((p) => { if (!p.email) return; const e = per.get(p.key) || { p, apps: [] }; e.apps.push(a); per.set(p.key, e); });
    }
    for (const { p, apps: list } of per.values()) {
      // eslint-disable-next-line no-await-in-loop
      if (p.userId && (await prefOf(p.userId)).muteMail) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (dryRun || !(await claim(`ivm|day|${p.key}|${day}`, now))) { if (dryRun) out.morning += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      await sendMail(p.email, `Your interviews today: ${list.length}`, ['Hello,', '', 'Your interviews today:', '', ...list.map((a) => `• ${row(a)}`), '', 'Open TeamLink → Interview Calendar for the details.', '', '— TeamLink'].join('\n'));
      out.morning += 1;
    }
  }
  // 60 minutes before, once per interview slot per person
  if (st.interviews.hourMail) {
    const apps = await prisma.application.findMany({ where: { interviewStatus: { in: LIVE }, interviewAt: { gt: now, lte: new Date(t + HOUR) }, stage: { notIn: DECIDED } }, include, take: 300 });
    for (const a of apps) {
      if (IN.skipPerson(a.candidate && a.candidate.name)) continue; // eslint-disable-line no-continue
      const slot = a.interviewAt.toISOString();
      // eslint-disable-next-line no-await-in-loop
      const ps = (await TELL.partiesOf(a).catch(() => [])).filter((p) => p.email);
      for (const p of ps) {
        // eslint-disable-next-line no-await-in-loop
        if (p.userId && (await prefOf(p.userId)).muteMail) continue; // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        if (dryRun || !(await claim(`ivm|hour|${a.id}|${slot}|${p.key}`, now))) { if (dryRun) out.hour += 1; continue; } // eslint-disable-line no-continue
        const mins = Math.max(1, Math.round((a.interviewAt.getTime() - t) / MIN));
        // eslint-disable-next-line no-await-in-loop
        await sendMail(p.email, `Interview in ${mins} minutes: ${a.candidate ? a.candidate.name : 'Candidate'}`, ['Hello,', '', `An interview starts in ${mins} minutes:`, '', `• ${row(a)}`, '', 'Open TeamLink → Interview Calendar for the details.', '', '— TeamLink'].join('\n'));
        out.hour += 1;
      }
    }
  }
  return out;
}

// ---- THE UPDATES & REPORTS CENTRE ---------------------------------------------------------------------------------------
const KINDS = {
  client: 'Client updates', interview: 'Interviews', followup: 'Follow-ups & overdue', alert: 'Metric alerts', report: 'Reports',
  approval: 'Approvals waiting', system: 'System notices',
};
function kindOf(n) {
  const r = String(n.recipient || '');
  const t = String(n.title || '');
  if (r.startsWith('cu|')) return 'client';
  if (r.startsWith('report|')) return 'report';
  if (r.startsWith('interview') || /interview/i.test(t)) return 'interview';
  if (/^alert:/i.test(t)) return 'alert';
  if (/follow[- ]?up|overdue|call back|call-back|not followed/i.test(t)) return 'followup';
  if (/report|digest|summary/i.test(t)) return 'report';
  if (/approv|waiting for you|to confirm|request/i.test(t)) return 'approval';
  return 'system';
}
const OPEN_RE = /\nOpen: (\/\S*)\s*$/;
// ATS ONLY (founder 2026-11-23: "why do these show on the ATS dashboard?"): the centre on the ATS dashboard lists recruitment things only.
// The bell keeps everything; CRM follow-ups, AI Marketing / Omni-Channel approvals, tasks and timesheets (HRMS), invoices (Accounts) and
// developer error notices stay out of here.
const NOT_ATS_OPEN = /^\/(employee-services|hrms|hr|attendance|leave|payroll|accounts|invoices?|billing|crm|omni|marketing|ai-marketing|monitoring|admin\/monitoring|lms|tasks?)(\/|\?|#|$)/i;
const NOT_ATS_TITLE = /\bcrm\b|\btasks?\b|timesheet|invoice|payroll|\bleave\b|attendance|reminder - \d|screen keeps failing|content calendar|marketing|client approved "/i;
const NOT_ATS_TEXT = /omni-channel|ai marketing|content calendar|employee-services|timesheet|\bcrm\b/i;
const ATS_OPEN = /^\/(candidates?|requirements?|clients?|ats|reports\/ats|interviews?|jobs?|applications?|pipeline|followups?|call-lists?|search)(\/|\?|#|$)/i;
const ATS_TITLE = /^alert:|candidate|requirement|\breq-\d|application|response|interview|follow[- ]?up|joining|joined|offer|shortlist|submission|client|agreement|resume|\bcv\b|job portal|naukri|shine|linkedin|whatsapp reply|recruiter|screening|dropped/i;
function isAtsNote(n, open) {
  const r = String(n.recipient || '');
  if (r.startsWith('cu|') || r.startsWith('report|') || r.startsWith('interview')) return true;
  const t = String(n.title || ''); const m = String(n.message || '');
  if (open && NOT_ATS_OPEN.test(open)) return false;
  if (NOT_ATS_TITLE.test(t) || NOT_ATS_TEXT.test(m)) return false;
  if (open && ATS_OPEN.test(open)) return true;
  return ATS_TITLE.test(t);
}
const reportBase = () => ({ kind: 'report', virtual: true });
// The reports a person has today: the same screens they already open, one line each, read state per day.
async function reportItems(user, { now = now0() } = {}) {
  const day = istDay(now);
  const S = require('./scope'); // eslint-disable-line global-require
  const role = S.atsViewRole(user);
  const lead = ['admin', 'mgmt', 'tl', 'stl'].includes(role) || ['MANAGER', 'TL', 'STL'].includes(user.atsRole);
  const at = new Date(Math.min(now.getTime(), istStart(day).getTime() + 9 * HOUR)).toISOString();
  const items = [
    { ...reportBase(), key: `rep|daily|${day}`, title: 'Daily report', text: `Your ${lead ? "team's" : ''} day: calls, submissions, interviews, joinings`.replace('  ', ' '), open: '/reports/ats?tab=daily', at },
    { ...reportBase(), key: `rep|followup|${day}`, title: 'Follow-up report', text: 'Follow-ups due, done and overdue', open: '/ats/followups', at },
    { ...reportBase(), key: `rep|reminders|${day}`, title: 'Reminders going out', text: 'Messages scheduled to candidates today and tomorrow', open: '/ats/dashboard#reminders', at },
  ];
  if (lead) items.push({ ...reportBase(), key: `rep|eod|${day}`, title: 'End-of-day team report', text: 'Each person of your team: today in one page', open: '/reports/ats?tab=teamwise', at });
  // the scheduled reports / dashboards mailed to this person arrive as their own bell rows (recipient report|sched|<id>, utils/insights/schedules.js)
  return items;
}
async function feed(user, { type = '', from = '', to = '', read = '', limit = 50, offset = 0, now = now0() } = {}) {
  await ensure();
  const since = new Date(now.getTime() - 60 * DAY);
  const notes = await prisma.notification.findMany({
    where: { userId: user.id, createdAt: { gte: since }, OR: [{ channel: null }, { channel: { not: 'Email' } }] },
    orderBy: { createdAt: 'desc' }, take: 600,
    select: { id: true, title: true, message: true, read: true, createdAt: true, recipient: true, channel: true },
  });
  const evIds = notes.filter((n) => String(n.recipient || '').startsWith('cu|')).map((n) => n.recipient.slice(3));
  const evs = evIds.length ? await q(`SELECT "id", "type", "actorName" FROM "AtsUpdateEvent" WHERE "id" IN (${evIds.map(() => '?').join(',')})`, ...evIds) : [];
  const evBy = new Map(evs.map((e) => [e.id, e]));
  let items = notes.filter((n) => { const mm = String(n.message || '').match(OPEN_RE); return isAtsNote(n, mm ? mm[1] : null); }).map((n) => {
    const m = String(n.message || '').match(OPEN_RE);
    const kind = kindOf(n);
    const e = kind === 'client' ? evBy.get(n.recipient.slice(3)) : null;
    return {
      id: `n:${n.id}`, kind, sub: e ? e.type : null, subLabel: e && TYPES[e.type] ? TYPES[e.type].label : null, title: n.title,
      text: String(n.message || '').replace(OPEN_RE, '').trim(), open: m ? m[1] : null, at: n.createdAt.toISOString(), read: !!n.read,
      download: String(n.recipient || '').startsWith('report|sched|') && /scheduled report/i.test(n.message || '') ? `/ats-updates/report-file/${n.recipient.split('|')[2]}` : null,
    };
  });
  const virt = await reportItems(user, { now });
  const keys = virt.map((v) => v.key);
  const readRows = keys.length ? await q(`SELECT "key" FROM "AtsUpdateRead" WHERE "userId" = ? AND "key" IN (${keys.map(() => '?').join(',')})`, user.id, ...keys) : [];
  const readSet = new Set(readRows.map((r) => r.key));
  items = items.concat(virt.map((v) => ({ id: `v:${v.key}`, kind: 'report', title: v.title, text: v.text, open: v.open, download: v.download || null, at: v.at, read: readSet.has(v.key), virtual: true })));
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  const counts = Object.fromEntries(Object.keys(KINDS).map((k) => [k, { label: KINDS[k], total: 0, unread: 0 }]));
  items.forEach((i) => { counts[i.kind].total += 1; if (!i.read) counts[i.kind].unread += 1; });
  const okDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
  let rows = items;
  if (type && KINDS[type]) rows = rows.filter((i) => i.kind === type);
  if (okDay(from)) rows = rows.filter((i) => istDay(i.at) >= from);
  if (okDay(to)) rows = rows.filter((i) => istDay(i.at) <= to);
  if (read === 'unread') rows = rows.filter((i) => !i.read);
  if (read === 'read') rows = rows.filter((i) => i.read);
  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);
  return {
    kinds: KINDS, counts, unread: items.filter((i) => !i.read).length, total: rows.length, rows: rows.slice(off, off + lim),
  };
}
async function markItems(user, ids) {
  const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 500);
  const nIds = list.filter((i) => i.startsWith('n:')).map((i) => i.slice(2));
  const vKeys = list.filter((i) => i.startsWith('v:')).map((i) => i.slice(2));
  let n = 0;
  if (nIds.length) {
    const rows = await prisma.notification.findMany({ where: { userId: user.id, id: { in: nIds } }, select: { id: true, recipient: true } });
    n += (await prisma.notification.updateMany({ where: { userId: user.id, id: { in: rows.map((r) => r.id) } }, data: { read: true } })).count;
    const evIds = rows.filter((r) => String(r.recipient || '').startsWith('cu|')).map((r) => r.recipient.slice(3));
    if (evIds.length) await seen(user.id, evIds);
  }
  if (vKeys.length) { await markRead(user.id, vKeys); n += vKeys.length; }
  return n;
}
async function markAll(user, filter = {}) {
  const f = await feed(user, { ...filter, read: 'unread', limit: 200 });
  let total = 0;
  let rows = f.rows;
  // up to 600 rows a press (the feed reads that many)
  for (let i = 0; i < 3 && rows.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    total += await markItems(user, rows.map((r) => r.id));
    // eslint-disable-next-line no-await-in-loop
    rows = (await feed(user, { ...filter, read: 'unread', limit: 200 })).rows;
  }
  return total;
}

// ---- the sweep (real server only) ------------------------------------------------------------------------------------------
let TIMER = null;
function startSweep() {
  if (TIMER || isSandbox()) return;
  TIMER = setInterval(() => {
    flushDigests().catch((e) => console.error('[ats-updates] digests:', e.message)); // eslint-disable-line no-console
    sweepInterviewMails().catch((e) => console.error('[ats-updates] interview mails:', e.message)); // eslint-disable-line no-console
  }, 5 * MIN);
  if (TIMER.unref) TIMER.unref();
}

module.exports = {
  TYPES, KINDS, DEFAULTS, SETTINGS_KEY, ensure, settings, saveSettings, prefOf, savePref, recipientsFor, mayHear, publish, flushDigests,
  popupsFor, seen, interviewsToday, markRead, sweepInterviewMails, feed, markItems, markAll, kindOf, isAtsNote, maskContact, startSweep, istDay, claim,
};
