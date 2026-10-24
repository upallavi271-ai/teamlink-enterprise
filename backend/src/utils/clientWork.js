// ---------------------------------------------------------------------------
// CLIENT WORK for the BDE (user, 2026-10-10: "everything related to a client must
// be accessible to the BDE ... from the moment a client is added, whatever happens
// for that client").
//
//   bdePending(bde)          the client work waiting on one BDE, by type, with the items
//   runBdeDigest()           the BDE's own daily digest (bell + e-mail), copied to the BDE TL
//   teamView(bdeTl)          the BDE TL's Pending-work table: the BDE desk, no recruiters
//   clientTimeline(...)      ALL ACTIVITY of one client in one place (client page → Client work)
//
// WHAT COUNTS (all from the records the client screens already use; the same scope as the
// BDE's own dashboard — utils/atsHome.js pendingLoad — so the numbers equal the screens):
//   Client has not replied    sent to the client (Shared / Client review), still no answer;
//                             "N days+" = waiting at least the set days (default 3)
//   Client shortlisted        shortlisted by the client, the interview is not fixed yet
//   Interview done, no feedback   the client interview happened and no feedback is recorded
//   Agreement not signed      clients with open jobs whose agreement is not signed:
//                             "not sent" (Draft) and "waiting for the client" (the rest)
//   Job requests waiting      draft jobs a client / BDE asked for, not opened yet
//   Invoices late (info)      the client's invoices past their due date (status only, no amounts)
//   Logins waiting            client login requests not decided yet
//
// PRIVACY (kept from the earlier rules): names of people and jobs only — never a candidate's
// phone / e-mail / salary, internal notes, panel feedback or AI score; candidates only from the
// BDE step onward; no recruiter data; the BDE TL's team is the BDE desk only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const NA = require('./nextAction');
const V = require('./atsVocab');
const M = require('./reportMailHtml');
const PW = require('./pendingWork');
const {
  clientWhere, requirementWhere, applicationWhere, isBdeTl, atsScopeOf,
} = require('./scope');

const TEST_RE = /zztest|example\.test/i;
const isTest = (s) => TEST_RE.test(String(s || ''));
const DAY_MS = 86400000;

// The BDE's pending types, in plain words.
const BDE_TYPES = [
  { id: 'noReply', label: 'Client has not replied' },
  { id: 'shortlisted', label: 'Interviews to book (client shortlisted)' },
  { id: 'feedback', label: 'Interview done, no client feedback' },
  { id: 'agreement', label: 'Agreement not signed' },
  { id: 'requests', label: 'Requirement requests waiting' },
  { id: 'invoices', label: 'Invoices past due (info)' },
  { id: 'logins', label: 'Client logins waiting' },
];

const feedbackDaysOf = (settings) => (settings && settings.bde && settings.bde.feedbackDays) || 3;

function appItem(x, today, extra = {}) {
  const r = (x.a && x.a.requirement) || {};
  const est = NA.entryEstimate(x.a);
  const waited = est && est.ms ? Math.max(0, PW.daysBetween(NA.istDay(est.ms), today)) : null;
  return {
    applicationId: x.a.id,
    candidateId: x.a.candidateId,
    candidate: x.cand || '—',
    requirementId: x.a.requirementId,
    job: r.title || '—',
    clientId: r.clientId || null,
    client: (r.client && r.client.name) || '—',
    step: require('./atsHome').stepWord(x.a.stage), // eslint-disable-line global-require
    waitedDays: waited,
    dueAt: x.na ? x.na.dueAt : null,
    status: x.na && x.na.dueStatus === 'overdue' ? 'late' : x.na && x.na.dueStatus === 'due_today' ? 'due_today' : 'later',
    ...extra,
  };
}

// The client work waiting on one BDE. `user` = the BDE's (resolved) login. Returns
// { userId, name, counts, lists, total, byClient }.
async function bdePending(user, { settings = null, fresh = false, load: given = null } = {}) {
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const st = settings || await PW.getSettings();
  const feedbackDays = feedbackDaysOf(st);
  const load = given || await AH.pendingLoad(user, { by: 'bde', fresh });
  const today = load.today;
  const w = load.world;
  const rows = load.live.filter((x) => !x.internal);
  const testViewer = isTest(`${user.name || ''} ${user.email || ''}`);
  const clients = (await prisma.client.findMany({
    where: clientWhere(user),
    select: { id: true, name: true, agreementStatus: true, status: true, ownerDepartment: true, createdAt: true },
  })).filter((c) => testViewer || !isTest(c.name));
  const clientIds = new Set(clients.map((c) => c.id));
  const live = (c) => !/archiv|pause|inactive/i.test(String(c.status || ''));

  const noReplyAll = rows.filter((x) => ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW'].includes(x.a.stage));
  const noReply = noReplyAll.map((x) => appItem(x, today)).filter((i) => (i.waitedDays || 0) >= feedbackDays).sort((a, b) => (b.waitedDays || 0) - (a.waitedDays || 0));
  const shortlisted = rows.filter((x) => x.a.stage === 'CLIENT_SHORTLISTED').map((x) => appItem(x, today));
  // "Interview requested by <recruiter>" beside the ones a Recruiter / TL has already asked the BDE to book.
  try {
    const asked = await require('./interviewRequest').requestsFor(shortlisted.map((i) => i.applicationId)); // eslint-disable-line global-require
    shortlisted.forEach((i) => { const r = asked.get(i.applicationId); if (r) { i.requestedBy = r.by; i.requestedAt = r.at; } });
    shortlisted.sort((a, b) => (b.requestedBy ? 1 : 0) - (a.requestedBy ? 1 : 0));
  } catch { /* a courtesy */ }
  const feedback = rows.filter((x) => NA.isClientFeedbackPending(x.a)).map((x) => appItem(x, today));

  // Agreements: the dashboard's rule (clients with open jobs, not signed).
  const liveJobClients = new Set(w.reqs.filter((r) => V.REQUIREMENT_LIVE_STATUSES.includes(r.status) && !r.internal).map((r) => r.clientId));
  const unsigned = clients.filter((c) => live(c) && liveJobClients.has(c.id) && !V.agreementIsSigned(c.agreementStatus))
    .map((c) => {
      const code = V.normalizeAgreementStatus(c.agreementStatus);
      return { clientId: c.id, client: c.name, agreementStatus: code, agreement: V.agreementStatusLabel(code), notSent: code === 'DRAFT' };
    });

  const requests = w.reqs.filter((r) => r.status === 'DRAFT' && !r.internal && clientIds.has(r.clientId))
    .map((r) => ({ requirementId: r.id, job: r.title, clientId: r.clientId, client: (r.client && r.client.name) || '—', since: r.createdAt }));

  const ids = [...clientIds];
  const [invoices, logins] = ids.length ? await Promise.all([
    prisma.invoice.findMany({
      where: { clientId: { in: ids }, status: { notIn: ['Paid', 'Cancelled'] }, dueDate: { lt: today } },
      select: { id: true, invoiceNumber: true, clientId: true, dueDate: true, client: { select: { name: true } } },
    }),
    prisma.portalRequest.findMany({ where: { kind: 'CLIENT_LOGIN', status: 'Pending', clientId: { in: ids } }, select: { id: true, clientId: true, name: true, createdAt: true } }),
  ]) : [[], []];
  const nameOf = new Map(clients.map((c) => [c.id, c.name]));
  const invoiceItems = invoices.map((i) => ({ invoiceId: i.id, invoiceNumber: i.invoiceNumber, clientId: i.clientId, client: (i.client && i.client.name) || nameOf.get(i.clientId) || '—', dueDate: i.dueDate, daysLate: PW.daysBetween(String(i.dueDate).slice(0, 10), today) }));
  const loginItems = logins.map((l) => ({ requestId: l.id, clientId: l.clientId, client: nameOf.get(l.clientId) || '—', who: l.name || null, since: l.createdAt }));

  const lists = { noReply, shortlisted, feedback, agreement: unsigned, requests, invoices: invoiceItems, logins: loginItems };
  const counts = {
    noReply: noReply.length, noReplyAll: noReplyAll.length, shortlisted: shortlisted.length, feedback: feedback.length,
    agreement: unsigned.length, agreementNotSent: unsigned.filter((u) => u.notSent).length,
    requests: requests.length, invoices: invoiceItems.length, logins: loginItems.length,
  };
  const total = counts.noReply + counts.shortlisted + counts.feedback + counts.agreement + counts.requests + counts.invoices + counts.logins;
  return { userId: user.id, name: user.name, today, feedbackDays, counts, lists, total, clients: clients.length };
}

// Same, cut to one client (the client page's Client work tab).
function forClient(pending, clientId) {
  const lists = {};
  const counts = {};
  Object.entries(pending.lists).forEach(([k, list]) => { lists[k] = list.filter((i) => i.clientId === clientId); counts[k] = lists[k].length; });
  return { lists, counts, total: Object.values(counts).reduce((n, v) => n + v, 0) };
}

const topLines = (p, n = 5) => {
  const L = p.lists;
  const out = [];
  L.noReply.slice(0, n).forEach((i) => out.push(`Client has not replied: ${i.candidate} — ${i.job} (${i.client}), ${i.waitedDays} days`));
  L.feedback.slice(0, n).forEach((i) => out.push(`No client feedback yet: ${i.candidate} — ${i.job} (${i.client})`));
  L.shortlisted.slice(0, n).forEach((i) => out.push(`Interview to book (client shortlisted): ${i.candidate} — ${i.job} (${i.client})${i.requestedBy ? `, requested by ${i.requestedBy}` : ''}`));
  L.agreement.slice(0, n).forEach((i) => out.push(`Agreement ${i.notSent ? 'not sent yet' : `not signed (${i.agreement})`}: ${i.client}`));
  L.requests.slice(0, n).forEach((i) => out.push(`Requirement request waiting: ${i.job} (${i.client})`));
  L.logins.slice(0, n).forEach((i) => out.push(`Client login waiting for approval: ${i.client}${i.who ? ` (${i.who})` : ''}`));
  L.invoices.slice(0, n).forEach((i) => out.push(`Invoice ${i.invoiceNumber || ''} of ${i.client} is ${i.daysLate} days past due (for your information)`));
  return out.slice(0, n * 3);
};
const countsLine = (c, days) => [
  c.noReply ? `Client has not replied ${c.noReply} (${days}+ days)` : null,
  c.feedback ? `No client feedback ${c.feedback}` : null,
  c.shortlisted ? `Shortlisted, interview not fixed ${c.shortlisted}` : null,
  c.agreement ? `Agreements not signed ${c.agreement}${c.agreementNotSent ? ` (${c.agreementNotSent} not sent)` : ''}` : null,
  c.requests ? `Requirement requests waiting ${c.requests}` : null,
  c.logins ? `Logins waiting ${c.logins}` : null,
  c.invoices ? `Invoices past due ${c.invoices}` : null,
].filter(Boolean).join(' · ');

function bdeDigestContent({ to, pending, day, copyOf = null }) {
  const title = `Client work waiting — ${PW.niceDay(day)}`;
  const c = pending.counts;
  const lines = [copyOf ? `Copy of ${copyOf}'s digest.` : `Hi ${to.name},`, '', `Your clients need ${pending.total} thing${pending.total === 1 ? '' : 's'} today.`, '', countsLine(c, pending.feedbackDays), ''];
  topLines(pending).forEach((l) => lines.push(`• ${l}`));
  lines.push('', `Open: ${PW.absolute('/ats/dashboard')}`);
  const text = lines.join('\n');
  const html = M.page(title, `${M.p(copyOf ? `Copy of ${copyOf}'s digest.` : `Hi ${to.name},`)}${M.stats([
    { label: 'Client not replied', value: c.noReply, tone: c.noReply ? 'orange' : 'green' },
    { label: 'No feedback', value: c.feedback, tone: c.feedback ? 'orange' : 'green' },
    { label: 'Agreements', value: c.agreement, tone: c.agreement ? 'red' : 'green' },
    { label: 'Requirement requests', value: c.requests, tone: c.requests ? 'blue' : 'green' },
  ])}${M.table(['What', 'Who and which requirement'], topLines(pending, 6).map((l) => { const [a, ...b] = l.split(': '); return [a, b.join(': ')]; }))}${M.button(PW.absolute('/ats/dashboard'), 'Open my clients')}`);
  return { title, subject: `TeamLink — ${title}`, text, html, bell: `${pending.total} client item${pending.total === 1 ? '' : 's'}: ${countsLine(c, pending.feedbackDays)}.`, total: pending.total };
}

// BDE logins on the desk (and the BDE TL), from the BDE directory (seat holders first).
async function bdePeople() {
  const { bdeDirectory } = require('./bdeSeats'); // eslint-disable-line global-require
  const dir = await bdeDirectory();
  const infos = dir.all().filter((i) => i.userId && i.active);
  const users = await prisma.user.findMany({ where: { id: { in: infos.map((i) => i.userId) }, status: 'Active', atsAccess: true }, select: { id: true, name: true, email: true, atsRole: true } });
  const byId = new Map(users.map((u) => [u.id, u]));
  return infos.map((i) => ({ ...i, user: byId.get(i.userId) })).filter((i) => i.user);
}

let BDE_RUNNING = false;
async function runBdeDigest({ now = new Date(), viewer = null, dryRun = false, force = false, mailer = null, testMode = false } = {}) {
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const settings = await PW.getSettings({ fresh: true });
  const day = PW.dayOfIst(now);
  const out = { day, dryRun, sent: 0, copies: 0, duplicates: 0, skippedEmpty: 0, bell: 0, emails: 0, emailsNotSent: 0, people: [] };
  if (!(settings.enabled && settings.bde.enabled) && !force) return { ...out, skipped: 'The BDE digest is switched off.' };
  const off = await PW.offDayReason(day);
  if (off && !force) return { ...out, skipped: `${off}: no digest today.` };
  if (BDE_RUNNING && !dryRun) return { ...out, skipped: 'already running' };
  BDE_RUNNING = !dryRun;
  try {
    const people = (await bdePeople()).filter((p) => (testMode || !isTest(`${p.user.name} ${p.user.email}`)) && (!viewer || true));
    const bdes = people.filter((p) => !p.isTl && p.user.atsRole === 'BDE');
    const tls = people.filter((p) => p.isTl);
    const summary = [];
    for (const b of bdes) {
      // eslint-disable-next-line no-await-in-loop
      const id = await resolveIdentity(b.user.id).catch(() => null);
      if (!id) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const pending = await bdePending(id, { settings });
      summary.push({ b, pending });
      const row = { name: b.user.name, total: pending.total, status: '' };
      out.people.push(row);
      if (!pending.total) { row.status = 'nothing pending'; out.skippedEmpty += 1; continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (!dryRun && !force && !(await PW.claim(day, 'bde', b.user.id))) { row.status = 'already sent today'; out.duplicates += 1; continue; } // eslint-disable-line no-continue
      const content = bdeDigestContent({ to: b.user, pending, day });
      // eslint-disable-next-line no-await-in-loop
      await PW.deliver({ settings, user: b.user, title: content.title, bell: content.bell, text: content.text, html: content.html, openPath: '/ats/dashboard', key: `pwr|bde|${day}`, mailer, dryRun, testMode, out });
      row.status = dryRun ? 'would send' : 'sent';
      if (!dryRun) out.sent += 1;
    }
    // ONE combined copy for the BDE TL: every BDE of the desk with their numbers.
    if (settings.bde.copyBdeTl && summary.some((s) => s.pending.total)) {
      for (const t of tls) {
        // eslint-disable-next-line no-await-in-loop
        if (!dryRun && !force && !(await PW.claim(day, 'bde', `tl:${t.user.id}`))) { out.duplicates += 1; continue; } // eslint-disable-line no-continue
        const title = `BDE desk — client work waiting — ${PW.niceDay(day)}`;
        const rows = summary.filter((s) => s.pending.total).sort((a, b) => b.pending.total - a.pending.total);
        const text = [`Hi ${t.user.name},`, '', `Client work waiting on your BDE desk today (copy of each BDE's digest):`, '',
          ...rows.flatMap((s) => [`${s.b.user.name}${s.b.position ? ` (${s.b.position})` : ''} — ${s.pending.total}: ${countsLine(s.pending.counts, s.pending.feedbackDays)}`, ...topLines(s.pending, 2).map((l) => `  • ${l}`)]),
          '', `Open: ${PW.absolute('/ats/team?view=whohas')}`].join('\n');
        const html = M.page(title, `${M.p(`Hi ${t.user.name}, client work waiting on your BDE desk (a copy of each BDE's digest).`)}${M.table(['BDE', 'Waiting', 'Client not replied', 'No feedback', 'Agreements'], rows.map((s) => [`${s.b.user.name}${s.b.position ? ` (${s.b.position})` : ''}`, s.pending.total, s.pending.counts.noReply, s.pending.counts.feedback, s.pending.counts.agreement]), { right: [1, 2, 3, 4] })}${M.button(PW.absolute('/ats/team?view=whohas'), 'Open the BDE desk')}`);
        // eslint-disable-next-line no-await-in-loop
        await PW.deliver({ settings, user: t.user, title, bell: `${rows.length} BDE${rows.length === 1 ? '' : 's'} with client work waiting: ${rows.slice(0, 3).map((s) => `${s.b.user.name} ${s.pending.total}`).join(', ')}.`, text, html, openPath: '/ats/team?view=whohas', key: `pwr|bde-tl|${day}`, mailer, dryRun, testMode, out });
        if (!dryRun) out.copies += 1;
      }
    }
    return out;
  } finally {
    if (!dryRun) BDE_RUNNING = false;
  }
}

// ---------------------------------------------------------------------------
// THE BDE TL's PENDING-WORK TABLE — her desk: each BDE with the client work waiting on them
// (and the Waiting / Due today / Late of the BDE team widget). No recruiters.
// ---------------------------------------------------------------------------
async function teamView(user, q = {}) {
  const TW = require('./teamWorkload'); // eslint-disable-line global-require
  const AH = require('./atsHome'); // eslint-disable-line global-require
  const { resolveIdentity } = require('./identity'); // eslint-disable-line global-require
  const settings = await PW.getSettings();
  const [world, load] = await Promise.all([TW.teamWorld(user), AH.pendingLoad(user, { by: 'bde', fresh: q.fresh === '1' })]);
  const testViewer = isTest(`${user.name || ''} ${user.email || ''}`);
  const by = new Map(load.people.filter((e) => e.userId).map((e) => [e.userId, e]));
  const day = PW.dayOfIst(new Date());
  const sent = await PW.readSent(day);
  const bdes = world.people.filter((p) => p.roleGroup === 'BDE' && p.status === 'Active' && (testViewer || !isTest(p.name)));
  const rows = [];
  for (const p of bdes) {
    // eslint-disable-next-line no-await-in-loop
    const id = await resolveIdentity(p.id).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    const pending = id ? await bdePending(id, { settings }) : null;
    const g = by.get(p.id);
    const items = pending ? [
      ...pending.lists.noReply.map((i) => ({ ...i, type: 'noReply', typeLabel: 'Client has not replied', text: `${i.candidate} — ${i.job} (${i.client}), ${i.waitedDays} days` })),
      ...pending.lists.feedback.map((i) => ({ ...i, type: 'feedback', typeLabel: 'Interview done, no client feedback', text: `${i.candidate} — ${i.job} (${i.client})` })),
      ...pending.lists.shortlisted.map((i) => ({ ...i, type: 'shortlisted', typeLabel: 'Interviews to book (client shortlisted)', text: `${i.candidate} — ${i.job} (${i.client})${i.requestedBy ? ` · requested by ${i.requestedBy}` : ''}` })),
      ...pending.lists.agreement.map((i) => ({ ...i, type: 'agreement', typeLabel: 'Agreement not signed', text: `${i.client}: ${i.notSent ? 'not sent yet' : i.agreement}` })),
      ...pending.lists.requests.map((i) => ({ ...i, type: 'requests', typeLabel: 'Requirement requests waiting', text: `${i.job} (${i.client})` })),
      ...pending.lists.logins.map((i) => ({ ...i, type: 'logins', typeLabel: 'Client logins waiting', text: `${i.client}${i.who ? ` (${i.who})` : ''}` })),
      ...pending.lists.invoices.map((i) => ({ ...i, type: 'invoices', typeLabel: 'Invoices past due (info)', text: `${i.invoiceNumber || 'Invoice'} of ${i.client}, ${i.daysLate} days` })),
    ] : [];
    rows.push({
      userId: p.id,
      name: p.name,
      department: p.department || null,
      seat: p.seatLabel || null,
      counts: {
        waiting: g ? g.pending.length : 0, late: g ? g.overdue.length : 0, dueToday: g ? g.dueToday.length : 0,
        notMoving: load.notMoving.get(`u:${p.id}`) || 0, followUpsLate: 0, followUpsToday: 0, jobsNoSubmission: 0,
        ...(pending ? { clientWork: pending.total } : {}),
      },
      byType: BDE_TYPES.map((t) => ({ id: t.id, label: t.label, n: pending ? (pending.counts[t.id] || 0) : 0 })).filter((t) => t.n),
      items: items.slice(0, 25),
      moreItems: Math.max(0, items.length - 25),
      mine: pending ? pending.total : 0,
      link: `/ats/dashboard`,
      reminded: sent.nudge[`${p.id}|all`] ? { at: sent.nudge[`${p.id}|all`].at, by: sent.nudge[`${p.id}|all`].byName } : null,
    });
  }
  const f = { department: String(q.department || ''), recruiter: String(q.recruiter || ''), type: String(q.type || ''), lateness: '' };
  const facet = (keyOf, labelOf, skip) => {
    const m = new Map();
    rows.forEach((r) => {
      if (skip !== 'recruiter' && f.recruiter && r.userId !== f.recruiter) return;
      if (skip !== 'type' && f.type && !r.items.some((i) => i.type === f.type)) return;
      const list = skip === 'type' ? r.items : r.items.filter((i) => !f.type || i.type === f.type);
      if (skip === 'type') list.forEach((i) => { const e = m.get(i.type) || { value: i.type, label: i.typeLabel, count: 0 }; e.count += 1; m.set(i.type, e); });
      else { const k = keyOf(r); if (k) { const e = m.get(k) || { value: k, label: labelOf(r), count: 0 }; e.count += list.length || 0; m.set(k, e); } }
    });
    return [...m.values()].sort((a, b) => b.count - a.count);
  };
  const shown = rows.filter((r) => (!f.recruiter || r.userId === f.recruiter) && (!f.type || r.items.some((i) => i.type === f.type)))
    .map((r) => (f.type ? { ...r, items: r.items.filter((i) => i.type === f.type) } : r));
  return {
    status: 200,
    body: {
      today: load.today,
      canRemind: true,
      audience: 'bde',
      filters: f,
      facets: { department: [], recruiter: facet((r) => r.userId, (r) => r.name, 'recruiter'), type: facet(null, null, 'type'), lateness: [] },
      types: BDE_TYPES,
      totals: PW.totalsOf(shown),
      rows: shown,
      note: 'Waiting / Due today / Late are the same numbers as the BDE team on the dashboard. The list under each BDE is the client work waiting on them (names of people and requirements only; no contact details, salary or internal notes).',
    },
  };
}

// ---------------------------------------------------------------------------
// ALL ACTIVITY of ONE client, newest first — every record the client screens hold, in one
// place. The caller has already passed the client scope check (routes/clients.js
// router.param). Candidates and jobs come through the caller's OWN requirement / application
// scope (BDE: own clients' jobs, BDE steps onward; BDE TL: all clients). Never a note of the
// recruiters, a panel score, an AI score or a candidate's contact / pay.
// ---------------------------------------------------------------------------
const BDE_STAGES = ['WITH_BDE', 'BDE_APPROVED', 'SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED',
  'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED', 'JOINED', 'HIRED', 'REJECTED'];
const FILTERS = ['all', 'notes', 'agreement', 'jobs', 'people', 'interviews', 'followups', 'money', 'files', 'messages', 'access'];

async function clientTimeline(user, client, { limit = 150, kind = 'all' } = {}) {
  const settings = await PW.getSettings();
  const scopeS = atsScopeOf(user);
  const unlimited = scopeS.global || isBdeTl(user) || ['MANAGER'].includes(scopeS.atsRole);
  const reqs = await prisma.requirement.findMany({
    where: { AND: [{ clientId: client.id }, unlimited ? {} : requirementWhere(user)] },
    select: { id: true, title: true, reqCode: true, status: true, createdAt: true },
  });
  const reqIds = reqs.map((r) => r.id);
  const reqLabel = new Map(reqs.map((r) => [r.id, r.reqCode || r.title]));
  const appScope = unlimited ? {} : applicationWhere(user);
  const apps = reqIds.length ? await prisma.application.findMany({
    where: { AND: [{ requirementId: { in: reqIds } }, appScope] },
    select: { id: true, candidateId: true, requirementId: true, stage: true, candidate: { select: { name: true } } },
  }) : [];
  const appIds = apps.map((a) => a.id);
  const appInfo = new Map(apps.map((a) => [a.id, { name: a.candidate ? a.candidate.name : '—', job: reqLabel.get(a.requirementId) || 'Requirement' }]));
  const events = [];
  const add = (e) => events.push(e);
  const chunk = (list, n = 400) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

  const [audits, stage, feedback, ivEvents, followUps, invoices, docs, requests, logins, merges] = await Promise.all([
    prisma.auditLog.findMany({
      where: { OR: [{ entity: 'Client', entityId: client.id }, ...(reqIds.length ? [{ entity: 'Requirement', entityId: { in: reqIds } }] : [])] },
      include: { user: { select: { name: true } } }, orderBy: { createdAt: 'desc' }, take: 300,
    }),
    Promise.all(chunk(appIds).map((ids) => prisma.applicationStageEvent.findMany({
      where: { applicationId: { in: ids }, toStage: { in: BDE_STAGES } },
      select: { id: true, applicationId: true, fromStage: true, toStage: true, action: true, actorName: true, actorSide: true, createdAt: true },
      orderBy: { createdAt: 'desc' }, take: 300,
    }))).then((r) => r.flat()),
    Promise.all(chunk(appIds).map((ids) => prisma.interviewFeedback.findMany({
      where: { applicationId: { in: ids }, kind: 'Client' },
      select: { id: true, applicationId: true, recommendation: true, overall: true, submittedBy: true, createdAt: true },
    }))).then((r) => r.flat()),
    Promise.all(chunk(appIds).map((ids) => prisma.interviewEvent.findMany({
      where: { applicationId: { in: ids } }, select: { id: true, applicationId: true, status: true, reason: true, fromSlot: true, toSlot: true, by: true, createdAt: true },
    }))).then((r) => r.flat()),
    Promise.all(chunk(appIds).map((ids) => prisma.applicationFollowUp.findMany({
      where: { applicationId: { in: ids }, ownerRole: { in: ['BDE', 'TL'] } },
      select: { id: true, applicationId: true, nextAction: true, purpose: true, dueDate: true, outcome: true, completedAt: true, completedById: true, ownerName: true, createdAt: true, createdByName: true },
      orderBy: { createdAt: 'desc' }, take: 200,
    }))).then((r) => r.flat()),
    prisma.invoice.findMany({ where: { clientId: client.id }, select: { id: true, invoiceNumber: true, invoiceDate: true, dueDate: true, status: true, paidDate: true, createdAt: true } }).catch(() => []),
    prisma.clientDocument.findMany({ where: { clientId: client.id, kind: { not: 'AGREEMENT_SIGNED' } }, select: { id: true, name: true, kind: true, uploadedByName: true, createdAt: true } }).catch(() => []),
    prisma.portalRequest.findMany({ where: { clientId: client.id }, orderBy: { createdAt: 'desc' }, take: 50 }).catch(() => []),
    prisma.user.findMany({ where: { clientId: client.id }, select: { id: true, name: true, createdAt: true, status: true, lastLoginAt: true } }).catch(() => []),
    prisma.clientMerge.findMany({ where: { OR: [{ primaryId: client.id }, { donorIds: { contains: client.id } }] }, orderBy: { createdAt: 'desc' }, take: 20 }).catch(() => []),
  ]);

  const kindOfAudit = (a) => {
    if (a.action === 'Client note') return 'notes';
    if (/agreement|e-?sign|signed|stamp/i.test(a.action)) return 'agreement';
    if (a.entity === 'Requirement') return 'jobs';
    if (/message|whatsapp|sms|e-?mail|call/i.test(a.action)) return 'messages';
    if (/login|portal|pause|archive|reactivat|restor/i.test(a.action)) return 'access';
    return 'notes';
  };
  audits.forEach((a) => add({
    id: `a-${a.id}`, at: a.createdAt, kind: kindOfAudit(a),
    title: a.action === 'Client note' ? 'Note' : a.action,
    detail: a.action === 'Client note' ? a.reason : [a.entity === 'Requirement' ? (reqLabel.get(a.entityId) || 'Requirement') : null, a.fieldLabel || a.field, a.fromValue && a.toValue ? `${String(a.fromValue).slice(0, 60)} → ${String(a.toValue).slice(0, 60)}` : (a.toValue ? String(a.toValue).slice(0, 120) : null), a.reason ? String(a.reason).slice(0, 160) : null].filter(Boolean).join(' · ') || null,
    by: a.actorName || (a.user ? a.user.name : 'System'),
  }));
  stage.forEach((e) => {
    const info = appInfo.get(e.applicationId);
    if (!info) return;
    add({
      id: `s-${e.id}`, at: e.createdAt, kind: 'people',
      title: `${info.name}: ${V.stageLabel(e.toStage)}`,
      detail: info.job, by: e.actorName || 'System',
    });
  });
  feedback.forEach((f) => {
    const info = appInfo.get(f.applicationId);
    if (!info) return;
    add({ id: `f-${f.id}`, at: f.createdAt, kind: 'interviews', title: `Client feedback on ${info.name}: ${f.recommendation}`, detail: `${info.job}${f.overall ? ` · ${String(f.overall).slice(0, 200)}` : ''}`, by: f.submittedBy || 'Client' });
  });
  ivEvents.forEach((e) => {
    const info = appInfo.get(e.applicationId);
    if (!info) return;
    add({ id: `i-${e.id}`, at: e.createdAt, kind: 'interviews', title: `Interview ${String(e.status || '').toLowerCase().replace(/_/g, ' ')} — ${info.name}`, detail: [info.job, e.fromSlot && e.toSlot ? `${e.fromSlot} → ${e.toSlot}` : (e.toSlot || null), e.reason].filter(Boolean).join(' · '), by: e.by || null });
  });
  followUps.forEach((f) => {
    const info = appInfo.get(f.applicationId);
    if (!info) return;
    add({
      id: `u-${f.id}`, at: f.completedAt || f.createdAt, kind: 'followups',
      title: `${f.completedAt ? 'Follow-up done' : 'Follow-up set'}: ${f.purpose || f.nextAction || 'Follow-up'} — ${info.name}`,
      detail: [info.job, f.outcome, f.completedAt ? null : (f.dueDate ? `due ${String(f.dueDate).slice(0, 10)}` : null)].filter(Boolean).join(' · '), by: f.ownerName || f.createdByName || null,
    });
  });
  invoices.forEach((i) => {
    add({ id: `v-${i.id}`, at: i.createdAt || i.invoiceDate, kind: 'money', title: `Invoice ${i.invoiceNumber || ''} raised`, detail: `Status: ${i.status}${i.dueDate ? ` · due ${String(i.dueDate).slice(0, 10)}` : ''}`, by: null });
    if (i.paidDate) add({ id: `vp-${i.id}`, at: new Date(`${String(i.paidDate).slice(0, 10)}T12:00:00+05:30`), kind: 'money', title: `Invoice ${i.invoiceNumber || ''} paid`, detail: null, by: null });
  });
  docs.forEach((d) => add({ id: `d-${d.id}`, at: d.createdAt, kind: 'files', title: `Document added: ${d.name}`, detail: d.kind || null, by: d.uploadedByName || null }));
  requests.forEach((r) => add({ id: `r-${r.id}`, at: r.createdAt, kind: 'access', title: `${r.kind === 'CLIENT_LOGIN' ? 'Client login asked for' : r.kind === 'CLIENT_DISABLE' ? 'Client login stop asked for' : 'Request'}${r.name ? `: ${r.name}` : ''} — ${r.status}`, detail: r.decisionNote || r.reason || null, by: r.requestedByName || null }));
  logins.forEach((u) => add({ id: `l-${u.id}`, at: u.createdAt, kind: 'access', title: `Client login created: ${u.name}`, detail: u.status === 'Active' ? null : u.status, by: null }));
  merges.forEach((m) => add({ id: `m-${m.id}`, at: m.createdAt, kind: 'access', title: m.primaryId === client.id ? 'Duplicate client(s) merged into this one' : 'This client was merged into another', detail: m.primaryId === client.id ? null : m.primaryName, by: m.mergedByName || null }));
  reqs.forEach((r) => add({ id: `j-${r.id}`, at: r.createdAt, kind: 'jobs', title: `Requirement raised: ${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`, detail: r.status === 'DRAFT' ? 'Waiting to be opened' : null, by: null }));
  add({ id: `c-${client.id}`, at: client.createdAt, kind: 'notes', title: 'Client added', detail: null, by: null });

  const wanted = FILTERS.includes(kind) ? kind : 'all';
  const sorted = events.filter((e) => e.at && (wanted === 'all' || e.kind === wanted)).sort((a, b) => new Date(b.at) - new Date(a.at));
  const counts = {};
  events.forEach((e) => { counts[e.kind] = (counts[e.kind] || 0) + 1; });
  const pending = forClient(await bdePendingForViewer(user, settings), client.id);
  return { events: sorted.slice(0, limit), total: sorted.length, counts: { all: events.length, ...counts }, pending, feedbackDays: feedbackDaysOf(settings) };
}

// The pending lists for whoever is looking (a BDE: their own; BDE TL / Admin / Manager: the world they see).
async function bdePendingForViewer(user, settings) {
  try { return await bdePending(user, { settings }); } catch (err) {
    console.error('[clientWork] pending failed:', err.message); // eslint-disable-line no-console
    const lists = Object.fromEntries(BDE_TYPES.map((t) => [t.id === 'feedback' ? 'feedback' : t.id === 'agreement' ? 'agreement' : t.id, []]));
    return { lists, counts: {}, total: 0 };
  }
}

module.exports = {
  topLines, BDE_TYPES, bdePending, forClient, bdeDigestContent, runBdeDigest, teamView, clientTimeline, bdePeople, FILTERS,
};
