// ---------------------------------------------------------------------------
// CLIENT LIFECYCLE HISTORY (read-only): "what happened with this client, date by date" + a small strip of counts.
//
//   Sources (all already on file):
//     Client (created, agreement dates, BDE), AuditLog (who created it; each agreement step; the portal login made / invite sent / re-sent;
//     "Signed in" for the first login), User (the client's logins: created, last sign-in), Requirement (posted: date, title, openings, who),
//     ApplicationStageEvent (candidates sent to the client), InterviewEvent (interviews done), JoiningRecord / JoiningEvent (joinings, drops,
//     replacement requests), Invoice (raised / paid - only for a login that may see invoices).
//
//   WHO SEES WHAT
//     admin / mgmt / BDE team / accounts   everything above that their screens already show (agreement steps, logins, invoices when allowed)
//     TL / STL / Recruiter / HR            NO agreement steps (not even the word), no logins, no invoices: the rest
//     the client (portal)                  ONLY its own jobs posted, candidates sent, interviews, joinings, drops and replacement requests:
//                                          no TeamLink people's names, no internal notes, no agreement, no invoices, never another client
//   The caller (routes/joinDrop.js, routes/portal.js) has already proved the login may open this client.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const V = require('./vocab');
const S = require('./schema');
const A = require('./access');

const IST = 330 * 60000;
const istDay = (d) => (d ? new Date(new Date(d).getTime() + IST).toISOString().slice(0, 10) : null);
const iso = (d) => (d ? new Date(d).toISOString() : null);
const dayOnly = (s) => (V.isDay(String(s || '').slice(0, 10)) ? String(s).slice(0, 10) : null);
const isTest = (s) => !require('../utils/sandbox').isSandbox() && /zztest|example\.test/i.test(String(s || '')); // eslint-disable-line global-require

const AGREEMENT_AUDIT = /^Agreement (created|document generated|document uploaded|sent|resent|signed|activated|auto-activated|expired|reopened|rejected|viewed)/i;
const AGREEMENT_LABEL = [
  [/created/i, 'Agreement made'], [/document generated|document uploaded/i, 'Agreement document prepared'], [/resent/i, 'Agreement sent again'], [/sent/i, 'Agreement sent to the client'],
  [/viewed/i, 'Agreement opened by the client'], [/signed/i, 'Agreement signed'], [/auto-activated|activated/i, 'Agreement active'], [/expired/i, 'Agreement closed'], [/reopened/i, 'Agreement reopened'], [/rejected/i, 'Agreement returned by the client'],
];
const agreementLabel = (a) => (AGREEMENT_LABEL.find(([re]) => re.test(a)) || [null, a])[1];

// kind: 'client' | 'blind' (TL / STL / Recruiter / HR) | 'full'
async function build(user, clientId, { kind = 'full' } = {}) {
  const client = await prisma.client.findUnique({ where: { id: clientId } });
  if (!client) return null;
  const portal = kind === 'client';
  const blind = kind === 'blind';
  const showAgreement = kind === 'full';
  const showLogins = kind === 'full';
  let showInvoices = false;
  if (kind === 'full') { try { showInvoices = !!(await require('../middleware/auth').can(user, 'accounts', 'accounts', 'Invoices', 'view')); } catch { showInvoices = false; } } // eslint-disable-line global-require
  const ev = [];
  const push = (e) => { if (e.day || e.at) ev.push({ ...e, day: e.day || istDay(e.at), at: e.at || null }); };

  // --- created / onboarded ---
  const created = await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: clientId, action: { startsWith: 'Client created' } }, orderBy: { createdAt: 'asc' } });
  if (!portal) {
    push({
      group: 'Client', title: 'Client added to TeamLink', at: iso(client.createdAt), who: (created && created.actorName) || null,
      detail: `${client.bdeOwner ? `Owner BDE: ${client.bdeOwner}` : 'Owner BDE: not recorded'}${client.ownerDepartment ? ` · ${client.ownerDepartment}` : ''}`,
    });
  }

  // --- agreement ---
  if (showAgreement) {
    const rows = await prisma.auditLog.findMany({ where: { entity: 'Client', entityId: clientId, action: { startsWith: 'Agreement' } }, orderBy: { createdAt: 'asc' } });
    const seen = new Set();
    rows.filter((r) => AGREEMENT_AUDIT.test(r.action)).forEach((r) => {
      const key = `${agreementLabel(r.action)}|${istDay(r.createdAt)}`;
      if (seen.has(key)) return;
      seen.add(key);
      push({ group: 'Agreement', title: agreementLabel(r.action), at: iso(r.createdAt), who: r.actorName || null, detail: null });
    });
    // dates kept on the client itself, when no audit row says it (older clients): never invented
    [['agreementSentAt', 'Agreement sent to the client'], ['agreementSignedAt', 'Agreement signed'], ['agreementActivatedAt', 'Agreement active']].forEach(([f, label]) => {
      if (client[f] && !ev.some((e) => e.group === 'Agreement' && e.title === label)) push({ group: 'Agreement', title: label, at: iso(client[f]), who: null, detail: 'From the client record' });
    });
  }

  // --- logins ---
  let loginSummary = null;
  if (showLogins) {
    const users = (await prisma.user.findMany({ where: { clientId, OR: [{ role: 'CLIENT' }, { atsRole: 'CLIENT' }] }, select: { id: true, name: true, email: true, createdAt: true, lastLoginAt: true, status: true } })).filter((u) => !isTest(`${u.name} ${u.email}`));
    const ids = users.map((u) => u.id);
    users.forEach((u) => push({ group: 'Login', title: 'Client login created', at: iso(u.createdAt), who: null, detail: `${u.name || u.email}` }));
    const au = await prisma.auditLog.findMany({
      where: { OR: [{ entity: 'Client', entityId: clientId, action: { startsWith: 'Client portal' } }, ...(ids.length ? [{ entity: 'User', entityId: { in: ids }, action: 'Signed in' }] : [])] },
      orderBy: { createdAt: 'asc' }, take: 400,
    });
    au.filter((r) => r.entity === 'Client').forEach((r) => {
      let title = null;
      if (/invite link re-sent/i.test(r.action)) title = 'Set-password link sent again';
      else if (/login (approved \+ )?created/i.test(r.action) || /login created/i.test(r.action)) title = 'Client login made (credentials created)';
      else if (/switched off/i.test(r.action) && !/requested/i.test(r.action)) title = 'Client login switched off';
      else if (/switched on again/i.test(r.action)) title = 'Client login switched on again';
      if (title) push({ group: 'Login', title, at: iso(r.createdAt), who: r.actorName || null, detail: String(r.toValue || '').split('·')[1] ? `Mail: ${String(r.toValue).split('·')[1].trim()}` : null });
    });
    const signIns = au.filter((r) => r.entity === 'User' && r.action === 'Signed in');
    const firstSign = signIns[0] ? iso(signIns[0].createdAt) : null;
    const lastSign = users.map((u) => u.lastLoginAt).filter(Boolean).sort().pop() || null;
    if (firstSign) push({ group: 'Login', title: 'First sign-in', at: firstSign, who: null, detail: null });
    loginSummary = { logins: users.length, firstLoginOn: istDay(firstSign) || null, lastLoginOn: istDay(lastSign) || null };
  }

  // --- jobs posted ---
  const reqs = await prisma.requirement.findMany({
    where: { clientId, internal: false }, select: { id: true, title: true, openings: true, status: true, createdAt: true, department: true }, orderBy: { createdAt: 'asc' },
  });
  const reqIds = reqs.map((r) => r.id);
  const madeBy = reqIds.length ? await prisma.auditLog.findMany({ where: { entity: 'Requirement', entityId: { in: reqIds }, action: { in: ['Requirement created', 'Requirement requested'] } }, orderBy: { createdAt: 'asc' } }) : [];
  const whoOf = new Map();
  madeBy.forEach((r) => { if (!whoOf.has(r.entityId)) whoOf.set(r.entityId, r.actorName || null); });
  const { requirementIsLive } = require('../utils/atsVocab'); // eslint-disable-line global-require
  reqs.forEach((r) => push({
    group: 'Requirement', title: `Requirement posted: ${r.title}`, at: iso(r.createdAt), who: portal ? null : (whoOf.get(r.id) || null), detail: `${r.openings || 1} opening${(r.openings || 1) === 1 ? '' : 's'}${portal ? '' : ` · ${r.department || ''}`}`.replace(/ · $/, ''),
  }));
  const perMonth = new Map();
  reqs.forEach((r) => { const m = istDay(r.createdAt).slice(0, 7); perMonth.set(m, (perMonth.get(m) || 0) + 1); });

  // --- candidates sent, interviews done ---
  let sentTotal = 0; let interviewsDone = 0;
  if (reqIds.length) {
    const sent = await prisma.applicationStageEvent.findMany({ where: { toStage: 'SHARED_WITH_CLIENT', applicationId: { in: (await prisma.application.findMany({ where: { requirementId: { in: reqIds } }, select: { id: true } })).map((a) => a.id) } }, select: { applicationId: true, createdAt: true, requirementTitle: true }, orderBy: { createdAt: 'asc' } });
    const first = new Map();
    sent.forEach((e) => { if (!first.has(e.applicationId)) first.set(e.applicationId, e); });
    sentTotal = first.size;
    const byDay = new Map();
    [...first.values()].forEach((e) => { const d = istDay(e.createdAt); if (!byDay.has(d)) byDay.set(d, { n: 0, jobs: new Set(), at: e.createdAt }); const g = byDay.get(d); g.n += 1; if (e.requirementTitle) g.jobs.add(e.requirementTitle); });
    byDay.forEach((g, d) => push({ group: 'Candidates', title: `${g.n} candidate${g.n === 1 ? '' : 's'} sent to the client`, day: d, at: iso(g.at), who: null, detail: [...g.jobs].slice(0, 3).join(', ') || null }));
    const done = await prisma.interviewEvent.findMany({ where: { status: 'COMPLETED', application: { requirementId: { in: reqIds } } }, select: { applicationId: true, createdAt: true }, orderBy: { createdAt: 'asc' } });
    const dApps = new Set(done.map((d) => d.applicationId));
    interviewsDone = dApps.size;
    const iday = new Map();
    done.forEach((d) => { const k = istDay(d.createdAt); iday.set(k, (iday.get(k) || 0) + 1); });
    iday.forEach((n, d) => push({ group: 'Interview', title: `${n} interview${n === 1 ? '' : 's'} done`, day: d, who: null, detail: null }));
  }

  // --- joinings, drops, replacements (this feature) ---
  const recs = await S.rows('SELECT * FROM "JoiningRecord" WHERE "clientId" = ? ORDER BY COALESCE("joinedOn", \'\') ASC', clientId);
  const liveRecs = recs.filter((r) => !isTest(r.candidateName));
  liveRecs.forEach((r) => {
    if (r.joinedOn) push({ group: 'Joining', title: `${r.candidateName} joined as ${r.designation || r.jobTitle || 'the job'}`, day: r.joinedOn, who: null, detail: `${r.location || 'Place not recorded'}${r.guaranteeEndsOn ? ` · replacement period until ${V.dmy(r.guaranteeEndsOn)}` : ''}` });
    if (r.status === 'Dropped' && r.droppedOn) push({ group: 'Drop', title: `${r.candidateName} dropped`, day: r.droppedOn, who: portal ? null : r.dropReportedByName, detail: `Reason: ${r.dropReason || 'Not recorded'}${r.dropWithinGuarantee === 1 ? ' · inside the replacement period' : ''}` });
    if (r.replacementDecision) push({ group: 'Replacement', title: `Replacement: ${V.DECISIONS[r.replacementDecision].label} (${r.candidateName})`, at: r.replacementDecidedAt, who: portal ? null : r.replacementDecidedByName, detail: r.replacementComment || null });
    if (r.replacementStatus === V.REPL.CLOSED) push({ group: 'Replacement', title: `Replacement joined for ${r.candidateName}`, at: r.updatedAt, who: null, detail: null });
  });

  // --- invoices ---
  let invoiceSummary = null;
  if (showInvoices) {
    const inv = await prisma.invoice.findMany({ where: { clientId, NOT: { status: 'Cancelled' } }, select: { invoiceNumber: true, invoiceDate: true, status: true, paidDate: true, amount: true }, orderBy: { invoiceDate: 'asc' } });
    inv.forEach((i) => {
      if (dayOnly(i.invoiceDate)) push({ group: 'Invoice', title: `Invoice raised${i.invoiceNumber ? ` (${i.invoiceNumber})` : ''}`, day: dayOnly(i.invoiceDate), who: null, detail: null });
      if (i.status === 'Paid' && dayOnly(i.paidDate)) push({ group: 'Invoice', title: `Invoice paid${i.invoiceNumber ? ` (${i.invoiceNumber})` : ''}`, day: dayOnly(i.paidDate), who: null, detail: null });
    });
    invoiceSummary = { raised: inv.length, paid: inv.filter((i) => i.status === 'Paid').length };
  }

  ev.sort((a, b) => String(a.at || a.day).localeCompare(String(b.at || b.day)));
  const open = reqs.filter((r) => requirementIsLive(r.status)).length;
  const summary = {
    addedOn: portal ? null : istDay(client.createdAt),
    jobsTotal: reqs.length, jobsOpen: open, jobsClosed: reqs.filter((r) => ['CLOSED', 'Closed'].includes(r.status)).length,
    jobsPerMonth: [...perMonth.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, 12).map(([month, count]) => ({ month, count })),
    candidatesSent: sentTotal, interviewsDone,
    joined: liveRecs.length, dropped: liveRecs.filter((r) => r.status === 'Dropped').length,
    replacementRequests: liveRecs.filter((r) => r.replacementDecision === 'NEEDED').length,
    ...(loginSummary || {}), ...(invoiceSummary ? { invoicesRaised: invoiceSummary.raised, invoicesPaid: invoiceSummary.paid } : {}),
  };
  void blind;
  return { clientId, clientName: client.name, kind, summary, events: ev };
}

// Which cut of the history this login gets. null = it may not open it.
function kindFor(user, rt) {
  if (rt.kind === 'client') return 'client';
  if (['tl', 'stl', 'recruiter', 'hr'].includes(rt.kind) && A.blind(user)) return 'blind';
  if (['admin', 'mgmt', 'bde', 'accounts'].includes(rt.kind) || !A.blind(user)) return 'full';
  return 'blind';
}

module.exports = { build, kindFor };
