// ---------------------------------------------------------------------------
// The reports behind Reports & Team -> "Candidate experience" and "Client health" (utils/atsExperience.js holds the data).
// Every list is cut to the login's own scope the same way the ATS lists are (utils/scope.js):
//   candidate side  Admin / Manager / HR see everything; anyone else the surveys and complaints of the requirements they see
//                   (requirementWhere), plus anything they own.
//   client side     clientWhere (Admin, Manager and the BDE TL: every client; a BDE their clients; a TL their team's clients).
//   money           revenue columns only for Super Admin / Admin / Accounts (reportsPlus.mayRevenue).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const E = require('./atsExperience');
const { atsScopeOf, requirementWhere, clientWhere, isBdeTl } = require('./scope');
const { REQUIREMENT_LIVE_STATUSES } = require('./atsVocab');

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym) => { const [y, m] = String(ym).split('-'); return `${MONTHS[Number(m) - 1] || m} ${y}`; };
const ymd = (d) => new Date(d).toISOString().slice(0, 10);

function mayRevenue(user) {
  const s = atsScopeOf(user);
  return !!(s.adminGlobal || s.accountsRole === 'ACCOUNTANT');
}
function seesAllCandidates(user) {
  const s = atsScopeOf(user);
  return !!(s.global || ['MANAGER', 'HR'].includes(s.atsRole));
}
function seesAllClients(user) {
  const s = atsScopeOf(user);
  return !!(s.global || s.atsRole === 'MANAGER' || isBdeTl(user));
}
const mayEditMatrix = (user) => seesAllClients(user) || atsScopeOf(user).atsRole === 'ASSISTANT_MANAGER';

async function candidateScope(user) {
  if (seesAllCandidates(user)) return { all: true, userId: user.id };
  const reqs = await prisma.requirement.findMany({ where: requirementWhere(user), select: { id: true } });
  return { all: false, reqIds: new Set(reqs.map((r) => r.id)), userId: user.id };
}
const inCandScope = (sc, row) => sc.all || (row.requirementId && sc.reqIds.has(row.requirementId))
  || [row.ownerId, row.recruiterId, row.tlId, row.createdById].includes(sc.userId);
async function clientScope(user) {
  if (seesAllClients(user)) return { all: true, userId: user.id };
  const cs = await prisma.client.findMany({ where: clientWhere(user), select: { id: true } });
  return { all: false, ids: new Set(cs.map((c) => c.id)), userId: user.id };
}
const inClientScope = (sc, row) => sc.all || (row.clientId && sc.ids.has(row.clientId))
  || [row.ownerId, row.bdeId, row.createdById].includes(sc.userId)
  || String(row.levelPeople || '').includes(`"${sc.userId}"`);

function range(qs = {}) {
  const to = /^\d{4}-\d{2}-\d{2}$/.test(String(qs.to || '')) ? qs.to : ymd(Date.now());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(qs.from || '')) ? qs.from : ymd(Date.parse(`${to}T00:00:00Z`) - 365 * DAY);
  return { from, to, fromIso: `${from}T00:00:00.000Z`, toIso: `${to}T23:59:59.999Z` };
}

function groupNps(rows, keyOf, labelOf = (k) => k, sentRows = null) {
  const m = new Map();
  rows.forEach((r) => { const k = keyOf(r) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
  const sent = new Map();
  (sentRows || []).forEach((r) => { const k = keyOf(r) || '—'; sent.set(k, (sent.get(k) || 0) + 1); });
  const keys = new Set([...m.keys(), ...sent.keys()]);
  return [...keys].map((k) => {
    const n = E.npsOf(m.get(k) || []);
    const s = sent.get(k) || 0;
    return { key: k, label: labelOf(k), sent: s, ...n, responseRate: s ? Math.round(((m.get(k) || []).length * 100) / s) : null };
  });
}

// --- CANDIDATE EXPERIENCE ----------------------------------------------------------
async function candidateReport(user, qs = {}) {
  const R = range(qs);
  const sc = await candidateScope(user);
  const all = (await E.q('SELECT * FROM "AtsSurvey" WHERE "side" = \'candidate\' AND "createdAt" >= ? AND "createdAt" <= ?', R.fromIso, R.toIso)).filter((r) => inCandScope(sc, r));
  const answered = all.filter((r) => r.answeredAt);
  const ov = E.npsOf(answered);
  const byMonth = groupNps(answered, (r) => String(r.answeredAt).slice(0, 7), monthLabel, all.map((r) => ({ ...r, answeredAt: r.createdAt }))).sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    period: { from: R.from, to: R.to },
    overall: { sent: all.length, ...ov, responseRate: all.length ? Math.round((answered.length * 100) / all.length) : null },
    byMonth,
    byRecruiter: groupNps(answered, (r) => r.recruiterName, (k) => k, all).sort((a, b) => b.responses - a.responses),
    byClient: groupNps(answered, (r) => r.clientName, (k) => k, all).sort((a, b) => b.responses - a.responses),
    byStage: groupNps(answered, (r) => r.event, (k) => E.EVENTS[k] || k, all).sort((a, b) => ['interview', 'offer', 'joining'].indexOf(a.key) - ['interview', 'offer', 'joining'].indexOf(b.key)),
    recent: answered.sort((a, b) => (a.answeredAt < b.answeredAt ? 1 : -1)).slice(0, 50).map((r) => ({
      id: r.id, at: r.answeredAt, person: r.personName, stage: E.EVENTS[r.event], client: r.clientName, recruiter: r.recruiterName, stars: r.stars, nps: r.nps, comment: r.comment, complaintId: r.complaintId,
    })),
  };
}

async function surveyList(user, qs = {}, req = null) {
  const side = qs.side === 'client' ? 'client' : 'candidate';
  const sc = side === 'client' ? await clientScope(user) : await candidateScope(user);
  const test = side === 'client' ? inClientScope : inCandScope;
  const rows = (await E.q('SELECT * FROM "AtsSurvey" WHERE "side" = ? ORDER BY "createdAt" DESC LIMIT 2000', side)).filter((r) => test(sc, r));
  return {
    rows: rows.slice(0, 300).map((r) => ({
      id: r.id, event: E.EVENTS[r.event], person: r.personName, client: r.clientName, requirement: r.requirementTitle, recruiter: r.recruiterName, bde: r.bdeName,
      period: r.period, createdAt: r.createdAt, sendStatus: r.sendStatus, answeredAt: r.answeredAt, stars: r.stars, nps: r.nps, comment: r.comment,
      link: r.answeredAt ? null : E.surveyUrl(r.id, req),
    })),
    total: rows.length,
  };
}

// --- COMPLAINTS ----------------------------------------------------------------------
const shapeComplaint = (c, now = Date.now()) => {
  let history = []; try { history = JSON.parse(c.history || '[]'); } catch { history = []; }
  let levels = null; try { levels = c.levelPeople ? JSON.parse(c.levelPeople) : null; } catch { levels = null; }
  const late = c.status !== 'Resolved' && c.dueAt && Date.parse(c.dueAt) < now;
  return {
    id: c.id, side: c.side, source: c.source, subject: c.subject, details: c.details, status: c.status, level: c.level, owner: c.ownerName, ownerId: c.ownerId,
    person: c.personName, client: c.clientName, clientId: c.clientId, requirement: c.requirementTitle, applicationId: c.applicationId,
    dueAt: c.dueAt, late, escalatedAt: c.escalatedAt, resolvedAt: c.resolvedAt, resolution: c.resolution, createdAt: c.createdAt, createdBy: c.createdByName, history, levels,
  };
};
async function complaintList(user, qs = {}) {
  await E.runEscalations().catch(() => null); // late ones move up before anybody reads the list
  const side = qs.side === 'client' ? 'client' : 'candidate';
  const sc = side === 'client' ? await clientScope(user) : await candidateScope(user);
  const test = side === 'client' ? inClientScope : inCandScope;
  let rows = (await E.q('SELECT * FROM "AtsComplaint" WHERE "side" = ? ORDER BY "id" DESC LIMIT 3000', side)).filter((r) => test(sc, r));
  const counts = { Open: 0, 'In progress': 0, Resolved: 0, late: 0, mine: 0 };
  rows.forEach((r) => { counts[r.status] = (counts[r.status] || 0) + 1; if (r.status !== 'Resolved' && r.dueAt && Date.parse(r.dueAt) < Date.now()) counts.late += 1; if (r.ownerId === user.id && r.status !== 'Resolved') counts.mine += 1; });
  if (qs.status && E.STATUSES.includes(qs.status)) rows = rows.filter((r) => r.status === qs.status);
  if (qs.status === 'late') rows = rows.filter((r) => r.status !== 'Resolved' && r.dueAt && Date.parse(r.dueAt) < Date.now());
  if (qs.status === 'mine') rows = rows.filter((r) => r.ownerId === user.id && r.status !== 'Resolved');
  if (qs.clientId) rows = rows.filter((r) => r.clientId === qs.clientId);
  return { rows: rows.slice(0, 500).map((r) => shapeComplaint(r)), counts, total: rows.length };
}
async function complaintInScope(user, c) {
  if (!c) return false;
  if (c.side === 'client') return inClientScope(await clientScope(user), c);
  return inCandScope(await candidateScope(user), c);
}

// --- CLIENT NPS ------------------------------------------------------------------------
async function clientNps(user, qs = {}) {
  const R = range(qs);
  const sc = await clientScope(user);
  const all = (await E.q('SELECT * FROM "AtsSurvey" WHERE "side" = \'client\' AND "createdAt" >= ? AND "createdAt" <= ?', R.fromIso, R.toIso)).filter((r) => inClientScope(sc, r));
  const answered = all.filter((r) => r.answeredAt);
  return {
    period: { from: R.from, to: R.to },
    overall: { sent: all.length, ...E.npsOf(answered), responseRate: all.length ? Math.round((answered.length * 100) / all.length) : null },
    byClient: groupNps(answered, (r) => r.clientName, (k) => k, all).sort((a, b) => b.responses - a.responses),
    byBde: groupNps(answered, (r) => r.bdeName, (k) => k, all).sort((a, b) => b.responses - a.responses),
    byMonth: groupNps(answered, (r) => String(r.answeredAt).slice(0, 7), monthLabel, all.map((r) => ({ ...r, answeredAt: r.createdAt }))).sort((a, b) => (a.key < b.key ? -1 : 1)),
    byKind: groupNps(answered, (r) => r.event, (k) => (k === 'quarterly' ? 'Quarterly' : 'After a joining'), all),
    quarter: E.quarterOf(),
    maySendQuarterly: mayEditMatrix(user),
  };
}

// --- RETENTION & LOST CLIENTS ------------------------------------------------------------
const isLive = (s) => REQUIREMENT_LIVE_STATUSES.includes(s);
async function retention(user, qs = {}, { now = Date.now() } = {}) {
  const months = Math.max(2, Math.min(24, Number(qs.months) || 6));
  const sc = await clientScope(user);
  const clients = (await prisma.client.findMany({ where: { AND: [sc.all ? {} : clientWhere(user), { OR: [{ clientType: null }, { clientType: { not: 'Internal' } }] }] }, select: { id: true, name: true, status: true, bdeOwner: true, createdAt: true } }))
    .filter((c) => !/zztest/i.test(c.name) || require('./sandbox').isSandbox()); // eslint-disable-line global-require
  const ids = clients.map((c) => c.id);
  const reqs = ids.length ? await prisma.requirement.findMany({ where: { clientId: { in: ids }, internal: false }, select: { id: true, clientId: true, status: true, createdAt: true, updatedAt: true } }) : [];
  const joinsRaw = ids.length ? await prisma.application.findMany({ where: { requirement: { clientId: { in: ids } }, OR: [{ joinedAt: { not: null } }, { stage: { in: ['JOINED', 'HIRED'] } }] }, select: { joinedAt: true, updatedAt: true, requirement: { select: { clientId: true } } } }) : [];
  const joins = joinsRaw.map((j) => ({ clientId: j.requirement.clientId, at: +(j.joinedAt || j.updatedAt) }));
  const lastEv = ids.length ? await prisma.applicationStageEvent.groupBy({ by: ['clientId'], where: { clientId: { in: ids } }, _max: { createdAt: true } }).catch(() => []) : [];
  const evAt = new Map(lastEv.map((e) => [e.clientId, e._max.createdAt ? +e._max.createdAt : 0]));
  const money = mayRevenue(user);
  const invs = money && ids.length ? await prisma.invoice.findMany({ where: { clientId: { in: ids }, NOT: { status: 'Cancelled' } }, select: { clientId: true, amount: true, invoiceDate: true, createdAt: true } }) : [];
  const marks = await E.q('SELECT * FROM "ClientLostMark" WHERE "clearedAt" IS NULL');
  const markOf = new Map(marks.map((m) => [m.clientId, m]));

  const by = (arr) => { const m = new Map(); arr.forEach((r) => { if (!m.has(r.clientId)) m.set(r.clientId, []); m.get(r.clientId).push(r); }); return m; };
  const reqBy = by(reqs); const joinBy = by(joins); const invBy = by(invs);
  // ACTIVE AT A MOMENT: an open requirement then (created before it and still live, or changed after it - i.e. not closed before),
  // or a joining in the 90 days before it. A client marked lost before that moment is not active.
  const activeAt = (c, t) => {
    const m = markOf.get(c.id);
    if (m && Date.parse(m.lostAt) <= t) return false;
    if ((reqBy.get(c.id) || []).some((r) => +r.createdAt <= t && (isLive(r.status) || +r.updatedAt > t))) return true;
    return (joinBy.get(c.id) || []).some((j) => j.at <= t && j.at > t - 90 * DAY);
  };
  const ist = new Date(now + 330 * 60000);
  const monthEnds = [];
  for (let i = months - 1; i >= 0; i -= 1) {
    const y = ist.getUTCFullYear(); const mo = ist.getUTCMonth() - i;
    const start = Date.UTC(y, mo, 1) - 330 * 60000;
    const end = Math.min(Date.UTC(y, mo + 1, 1) - 330 * 60000 - 1, now);
    monthEnds.push({ key: new Date(Date.UTC(y, mo, 1)).toISOString().slice(0, 7), start, end });
  }
  const prevEnd = (m) => m.start - 1;
  const byMonth = monthEnds.map((m) => {
    let active = 0; let retained = 0; let churned = 0; let added = 0; let before = 0;
    clients.forEach((c) => {
      const a = activeAt(c, m.end); const b = activeAt(c, prevEnd(m));
      if (a) active += 1; if (b) before += 1;
      if (a && b) retained += 1; else if (b && !a) churned += 1; else if (a && !b) added += 1;
    });
    const row = { key: m.key, label: monthLabel(m.key), activeAtStart: before, active, retained, churned, new: added, retentionPct: before ? Math.round((retained * 100) / before) : null };
    if (money) row.revenue = Math.round((invs.filter((iv) => { const t = Date.parse(iv.invoiceDate || iv.createdAt); return t >= m.start && t <= m.end; }).reduce((n, iv) => n + (Number(iv.amount) || 0), 0)));
    row.joinings = joins.filter((j) => j.at >= m.start && j.at <= m.end).length;
    return row;
  });
  const winStart = monthEnds[0].start;
  const lastActivity = (c) => Math.max(evAt.get(c.id) || 0, ...(reqBy.get(c.id) || []).map((r) => +r.createdAt), ...(joinBy.get(c.id) || []).map((j) => j.at), ...(invBy.get(c.id) || []).map((iv) => +iv.createdAt), 0);
  const rows = clients.map((c) => {
    const open = (reqBy.get(c.id) || []).filter((r) => isLive(r.status)).length;
    const last = lastActivity(c);
    const m = markOf.get(c.id);
    const everWorked = (reqBy.get(c.id) || []).length > 0;
    const idle = !open && (!last || last < now - 90 * DAY);
    const state = m ? 'Lost (marked)' : (everWorked && idle ? 'Lost (no activity 90+ days)' : (activeAt(c, now) ? 'Active' : (everWorked ? 'At risk' : 'No work yet')));
    const row = {
      clientId: c.id, client: c.name, bde: c.bdeOwner || '—', status: c.status || 'Active', state, openRequirements: open,
      joinings: (joinBy.get(c.id) || []).filter((j) => j.at >= winStart).length,
      lastActivity: last ? ymd(last) : null, daysIdle: last ? Math.floor((now - last) / DAY) : null,
    };
    if (money) row.revenue = Math.round((invBy.get(c.id) || []).filter((iv) => Date.parse(iv.invoiceDate || iv.createdAt) >= winStart).reduce((n, iv) => n + (Number(iv.amount) || 0), 0));
    return row;
  }).sort((a, b) => (b.joinings - a.joinings) || ((b.revenue || 0) - (a.revenue || 0)) || a.client.localeCompare(b.client));
  const lostRows = rows.filter((r) => r.state.startsWith('Lost'));
  // The last reason: the "Mark as lost" note, else the client's last audit row that carries a reason (pause / archive / deactivate).
  const auditIds = lostRows.filter((r) => !markOf.get(r.clientId)).map((r) => r.clientId);
  const audits = auditIds.length ? await prisma.auditLog.findMany({ where: { entity: 'Client', entityId: { in: auditIds }, reason: { not: null } }, orderBy: { createdAt: 'desc' }, select: { entityId: true, reason: true, action: true, createdAt: true } }).catch(() => []) : [];
  const auditOf = new Map(); audits.forEach((a) => { if (!auditOf.has(a.entityId)) auditOf.set(a.entityId, a); });
  const lost = lostRows.map((r) => {
    const m = markOf.get(r.clientId); const a = auditOf.get(r.clientId);
    return {
      ...r, markedLostOn: m ? String(m.lostAt).slice(0, 10) : null, markedBy: m ? m.byName : null,
      reason: m ? (m.reason || '—') : (a ? `${a.action}: ${a.reason}` : 'No reason recorded'), notes: m ? m.notes : null,
    };
  });
  const cur = byMonth[byMonth.length - 1];
  return {
    months, money,
    overall: { clients: clients.length, activeNow: cur.active, retentionPct: cur.retentionPct, churnedThisMonth: cur.churned, lost: lost.length },
    byMonth, clients: rows, lost, mayMark: true,
  };
}
async function markLost(user, clientId, { reason, notes } = {}) {
  const r = String(reason || '').trim();
  if (!r) return { status: 400, error: 'Say why the client was lost.' };
  const sc = await clientScope(user);
  if (!sc.all && !sc.ids.has(clientId)) return { status: 404, error: 'Client not found.' };
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true, name: true } });
  if (!c) return { status: 404, error: 'Client not found.' };
  await E.x(`INSERT INTO "ClientLostMark" ("clientId","lostAt","reason","notes","byName","clearedAt") VALUES (?,?,?,?,?,NULL)
    ON CONFLICT("clientId") DO UPDATE SET "lostAt"=excluded."lostAt","reason"=excluded."reason","notes"=excluded."notes","byName"=excluded."byName","clearedAt"=NULL`,
  clientId, new Date().toISOString(), r.slice(0, 300), String(notes || '').trim().slice(0, 2000) || null, user.name);
  await require('./audit').logAudit({ userId: user.id, action: 'Client marked lost', entity: 'Client', entityId: clientId, toValue: c.name, reason: r.slice(0, 300) }); // eslint-disable-line global-require
  return { ok: true };
}
async function clearLost(user, clientId) {
  const sc = await clientScope(user);
  if (!sc.all && !sc.ids.has(clientId)) return { status: 404, error: 'Client not found.' };
  await E.x('UPDATE "ClientLostMark" SET "clearedAt" = ? WHERE "clientId" = ?', new Date().toISOString(), clientId);
  await require('./audit').logAudit({ userId: user.id, action: 'Client no longer marked lost', entity: 'Client', entityId: clientId }); // eslint-disable-line global-require
  return { ok: true };
}

// --- APPLY FUNNEL ------------------------------------------------------------------------
async function applyFunnel(user, qs = {}, { now = Date.now() } = {}) {
  const R = range({ ...qs, from: qs.from || ymd(now - 90 * DAY) });
  const rows = await E.q('SELECT * FROM "ApplyFunnel" WHERE "startedAt" >= ? AND "startedAt" <= ?', R.fromIso, R.toIso);
  const jobIds = [...new Set(rows.map((r) => r.jobId))];
  const all = seesAllCandidates(user);
  const jobs = jobIds.length ? await prisma.requirement.findMany({ where: { AND: [{ id: { in: jobIds } }, all ? {} : requirementWhere(user)] }, select: { id: true, title: true, client: { select: { name: true } }, internal: true } }) : [];
  const jobOf = new Map(jobs.map((j) => [j.id, j]));
  const mine = rows.filter((r) => jobOf.has(r.jobId));
  // ABANDONED = opened and not sent, and nothing typed for 30 minutes (someone still filling it in is not counted yet).
  const stale = (r) => !r.submittedAt && Date.parse(r.lastAt || r.startedAt) < now - 30 * 60000;
  const agg = (list) => {
    const started = list.length; const submitted = list.filter((r) => r.submittedAt).length; const ab = list.filter(stale);
    return {
      started, submitted, abandoned: ab.length, inProgress: started - submitted - ab.length,
      completionRate: started ? Math.round((submitted * 100) / started) : null,
      avgFilledWhenAbandoned: ab.length ? Math.round(ab.reduce((n, r) => n + Number(r.pct || 0), 0) / ab.length) : null,
    };
  };
  const group = (keyOf, labelOf) => {
    const m = new Map(); mine.forEach((r) => { const k = keyOf(r) || '—'; if (!m.has(k)) m.set(k, []); m.get(k).push(r); });
    return [...m.entries()].map(([k, list]) => ({ key: k, label: labelOf(k), ...agg(list) })).sort((a, b) => b.started - a.started);
  };
  return {
    period: { from: R.from, to: R.to },
    overall: agg(mine),
    byJob: group((r) => r.jobId, (k) => { const j = jobOf.get(k); return j ? `${j.title}${j.internal ? ' · TeamLink' : (j.client ? ` · ${j.client.name}` : '')}` : k; }),
    bySource: group((r) => r.source || 'Direct / careers page', (k) => k),
  };
}

// --- EXPORT ---------------------------------------------------------------------------------
const npsHead = ['Sent', 'Answers', 'Answer rate %', 'NPS', 'Promoters', 'Passives', 'Detractors', 'Average stars'];
const npsCells = (g) => [g.sent, g.responses, g.responseRate, g.nps, g.promoters, g.passives, g.detractors, g.avgStars];
async function exportSheets(user, name, qs) {
  if (name === 'candidate-experience') {
    const d = await candidateReport(user, qs);
    const sec = (title, first, list) => ({ name: title, headers: [first, ...npsHead], rows: list.map((g) => [g.label, ...npsCells(g)]) });
    return [
      sec('By month', 'Month', d.byMonth), sec('By recruiter', 'Recruiter', d.byRecruiter), sec('By client', 'Client', d.byClient), sec('By stage', 'Stage', d.byStage),
      { name: 'Answers', headers: ['Answered on', 'Candidate', 'Stage', 'Client', 'Recruiter', 'Stars', 'Recommend 0-10', 'Comment'], rows: d.recent.map((r) => [String(r.at).slice(0, 10), r.person, r.stage, r.client, r.recruiter, r.stars, r.nps, r.comment]) },
    ];
  }
  if (name === 'client-nps') {
    const d = await clientNps(user, qs);
    const sec = (title, first, list) => ({ name: title, headers: [first, ...npsHead.filter((h) => h !== 'Average stars')], rows: list.map((g) => [g.label, ...npsCells(g).slice(0, 7)]) });
    return [sec('By client', 'Client', d.byClient), sec('By BDE', 'BDE', d.byBde), sec('By month', 'Month', d.byMonth)];
  }
  if (name === 'complaints') {
    const d = await complaintList(user, qs);
    return [{ name: qs.side === 'client' ? 'Client escalations' : 'Candidate complaints', headers: ['#', 'Raised on', 'Person', 'Client', 'Subject', 'Status', 'Level', 'Owner', 'Due', 'Late', 'Resolved on', 'Resolution'], rows: d.rows.map((r) => [r.id, String(r.createdAt).slice(0, 10), r.person, r.client, r.subject, r.status, r.level, r.owner, String(r.dueAt || '').slice(0, 16).replace('T', ' '), r.late ? 'Yes' : 'No', String(r.resolvedAt || '').slice(0, 10), r.resolution]) }];
  }
  if (name === 'retention') {
    const d = await retention(user, qs);
    const money = d.money;
    return [
      { name: 'By month', headers: ['Month', 'Active at start', 'Active at end', 'Retained', 'Churned', 'New', 'Retention %', 'Joinings', ...(money ? ['Invoiced (Rs)'] : [])], rows: d.byMonth.map((m) => [m.label, m.activeAtStart, m.active, m.retained, m.churned, m.new, m.retentionPct, m.joinings, ...(money ? [m.revenue] : [])]) },
      { name: 'Clients', headers: ['Client', 'BDE', 'Status', 'State', 'Open requirements', `Joinings (${d.months} months)`, ...(money ? [`Invoiced (${d.months} months, Rs)`] : []), 'Last activity', 'Days idle'], rows: d.clients.map((c) => [c.client, c.bde, c.status, c.state, c.openRequirements, c.joinings, ...(money ? [c.revenue] : []), c.lastActivity, c.daysIdle]) },
      { name: 'Lost clients', headers: ['Client', 'BDE', 'State', 'Last activity', 'Days idle', 'Marked lost on', 'By', 'Last reason', 'Notes'], rows: d.lost.map((c) => [c.client, c.bde, c.state, c.lastActivity, c.daysIdle, c.markedLostOn, c.markedBy, c.reason, c.notes]) },
    ];
  }
  if (name === 'apply-funnel') {
    const d = await applyFunnel(user, qs);
    const h = ['Started', 'Submitted', 'Abandoned', 'Still filling', 'Completion rate %', 'Average % filled when abandoned'];
    const c = (g) => [g.started, g.submitted, g.abandoned, g.inProgress, g.completionRate, g.avgFilledWhenAbandoned];
    return [{ name: 'By job', headers: ['Job', ...h], rows: d.byJob.map((g) => [g.label, ...c(g)]) }, { name: 'By source', headers: ['Source', ...h], rows: d.bySource.map((g) => [g.label, ...c(g)]) }];
  }
  return null;
}

module.exports = {
  candidateReport, surveyList, complaintList, complaintInScope, clientNps, retention, markLost, clearLost, applyFunnel, exportSheets, shapeComplaint,
  seesAllCandidates, seesAllClients, mayEditMatrix, mayRevenue, candidateScope, clientScope, inCandScope, inClientScope,
};
