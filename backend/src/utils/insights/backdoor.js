// ---------------------------------------------------------------------------
// BACKDOOR HIRING (12.11, 2026-11-21) - people we sent to a client who then joined that client without us.
//
// SUSPECTED (found in code, in this login's scope): a person was SENT to client X, did not join X through TeamLink,
// and then one of these is true:
//   * the application says Rejected / Hold / Dropped but its joining fields say they joined (status conflict),
//   * the person's current company (profile, or a "current" job in the Career tab) is client X.
// MARKED (stored, AtsBackdoorFlag): anyone who works the record marks it "Suspected"; a team lead, a BDE or an Admin
// marks it "Confirmed" or "Not backdoor". A client-confirmed list (the client tells us who joined them directly: names,
// phones or e-mails, one per line) is matched against the people we sent to that client and stored as Confirmed.
// Phones / e-mails are matched on the server and never returned. Manager / Assistant Manager only read.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');
const M = require('./metrics');
const { logAudit } = require('../audit');

const normCo = (s) => String(s || '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|co|company|the|india|hospitals?|healthcare|group|technologies|solutions)\b/g, ' ')
  .replace(/[^a-z0-9]+/g, '').trim();
const sameCompany = (a, b) => { const x = normCo(a); const y = normCo(b); return x.length >= 3 && y.length >= 3 && (x === y || x.includes(y) || y.includes(x)); };
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const STATUS_LABEL = { suspected: 'Suspected', confirmed: 'Confirmed backdoor', dismissed: 'Not backdoor' };

async function flagsMap() {
  await C.ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "AtsBackdoorFlag"');
  return new Map(rows.map((r) => [`${r.candidateId}|${r.clientId}`, r]));
}

async function report(user, { status = '' } = {}) {
  const acc = await C.access(user);
  const ctx = await C.ctxFor(user, {});
  // per candidate + client: the applications we sent there
  const pairs = new Map();
  ctx.apps.forEach((x) => {
    if (x.req.internal || !x.req.clientId) return;
    const k = `${x.a.candidateId}|${x.req.clientId}`;
    const p = pairs.get(k) || { candidateId: x.a.candidateId, clientId: x.req.clientId, client: x.req.clientName, apps: [] };
    p.apps.push(x); pairs.set(k, p);
  });
  const sent = [...pairs.values()].filter((p) => p.apps.some((x) => x.reached('shared')) && !p.apps.some((x) => x.joined));
  const candIds = [...new Set(sent.map((p) => p.candidateId))];
  const [cands, jobs] = await Promise.all([
    candIds.length ? prisma.candidate.findMany({ where: { id: { in: candIds } }, select: { id: true, name: true, currentCompany: true } }) : [],
    candIds.length ? prisma.$queryRawUnsafe(`SELECT "candidateId","company","isCurrent","fromMonth" FROM "CandidateEmployment" WHERE "candidateId" IN (${candIds.map(() => '?').join(',')})`, ...candIds).catch(() => []) : [],
  ]);
  const candBy = new Map(cands.map((c) => [c.id, c]));
  const jobsBy = new Map();
  jobs.forEach((j) => { const l = jobsBy.get(j.candidateId) || []; l.push(j); jobsBy.set(j.candidateId, l); });
  const flags = await flagsMap();
  const rows = [];
  sent.forEach((p) => {
    const cand = candBy.get(p.candidateId) || {};
    const lastSent = p.apps.filter((x) => x.reached('shared')).sort((a, b) => b.a.createdAt - a.a.createdAt)[0];
    const signals = [];
    p.apps.forEach((x) => {
      if (['REJECTED', 'HOLD'].includes(x.a.stage) && (x.a.joiningStatus === 'Joined' || x.a.joinedAt)) signals.push('Closed as not joined, but the joining fields say Joined');
    });
    if (cand.currentCompany && sameCompany(cand.currentCompany, p.client)) signals.push(`Current company on the profile: ${String(cand.currentCompany).slice(0, 60)}`);
    (jobsBy.get(p.candidateId) || []).forEach((j) => { if (Number(j.isCurrent) && sameCompany(j.company, p.client)) signals.push(`Career tab: works at ${String(j.company).slice(0, 60)} now`); });
    const flag = flags.get(`${p.candidateId}|${p.clientId}`);
    if (!signals.length && !flag) return;
    const outcome = lastSent.a.stage === 'REJECTED' ? 'Rejected' : (lastSent.pipe && lastSent.pipe.label) || lastSent.a.stage;
    rows.push({
      key: `${p.candidateId}|${p.clientId}`, candidateId: p.candidateId, candidate: cand.name || '—', clientId: p.clientId, client: p.client,
      applicationId: lastSent.id, requirement: M.reqLabel(lastSent.req), sentOn: C.istDay((lastSent.crossedAt && lastSent.crossedAt.shared) || lastSent.a.createdAt),
      outcome, signals: [...new Set(signals)],
      status: flag ? flag.status : 'suspected', statusLabel: STATUS_LABEL[flag ? flag.status : 'suspected'], marked: !!flag,
      source: flag ? flag.source : 'auto', note: flag ? flag.note : null, markedBy: flag ? (flag.decidedByName || flag.markedByName) : null,
    });
  });
  // a stored flag whose application is in scope but no longer matches the rules above is still listed (handled above)
  const filtered = status ? rows.filter((r) => r.status === status) : rows;
  const fees = acc.money ? new Map((await prisma.client.findMany({ where: { id: { in: [...new Set(filtered.map((r) => r.clientId))] } }, select: { id: true, feeType: true, feeAmount: true, agreementFeePercent: true } })).map((c) => [c.id, c])) : null;
  if (fees) filtered.forEach((r) => { const c = fees.get(r.clientId); r.feeAtRisk = c && c.feeAmount && c.feeType !== 'PERCENT_CTC' ? `Rs ${Number(c.feeAmount).toLocaleString('en-IN')}` : `${c && c.agreementFeePercent != null ? c.agreementFeePercent : 8.33}% of CTC`; });
  filtered.sort((a, b) => ({ confirmed: 0, suspected: 1, dismissed: 2 }[a.status] - { confirmed: 0, suspected: 1, dismissed: 2 }[b.status]) || String(b.sentOn).localeCompare(String(a.sentOn)));
  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    rows: filtered,
    totals: { suspected: count('suspected'), confirmed: count('confirmed'), dismissed: count('dismissed'), checked: sent.length },
    canMark: !acc.viewOnly, canDecide: !acc.viewOnly && (acc.admin || acc.lead || acc.bde),
    note: 'Suspected = sent to the client, did not join through us, and the record now points at that client. Confirm only after checking with the candidate or the client.',
  };
}

async function inScopeApp(user, applicationId) {
  const ctx = await C.ctxFor(user, {});
  return ctx.apps.find((x) => x.id === String(applicationId)) || null;
}
async function mark(user, body = {}) {
  const acc = await C.access(user);
  if (acc.viewOnly) return { status: 403, error: 'Your role can only read this report.' };
  const status = ['suspected', 'confirmed', 'dismissed'].includes(body.status) ? body.status : 'suspected';
  if (status !== 'suspected' && !(acc.admin || acc.lead || acc.bde)) return { status: 403, error: 'A team lead, a BDE or an Admin confirms or clears a backdoor hire.' };
  const x = await inScopeApp(user, body.applicationId);
  if (!x || x.req.internal) return { status: 404, error: 'That candidate is not in your area.' };
  if (!x.reached('shared')) return { status: 400, error: 'Only a person we sent to the client can be a backdoor hire.' };
  const note = String(body.note || '').trim().slice(0, 500);
  if (status === 'confirmed' && note.length < 5) return { status: 400, error: 'Say how it was confirmed (for example "client HR said on call").' };
  await C.ensure();
  const flags = await flagsMap();
  const key = `${x.a.candidateId}|${x.req.clientId}`;
  const cur = flags.get(key);
  const now = new Date().toISOString();
  if (cur) {
    await prisma.$executeRawUnsafe('UPDATE "AtsBackdoorFlag" SET "status" = ?, "note" = COALESCE(?, "note"), "decidedById" = ?, "decidedByName" = ?, "decidedAt" = ?, "applicationId" = ? WHERE "id" = ?',
      status, note || null, user.id, user.name || null, now, x.id, cur.id);
  } else {
    await prisma.$executeRawUnsafe('INSERT INTO "AtsBackdoorFlag" ("id","applicationId","candidateId","clientId","status","source","note","markedById","markedByName","createdAt","decidedById","decidedByName","decidedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      C.newId('bdr'), x.id, x.a.candidateId, x.req.clientId, status, 'manual', note || null, user.id, user.name || null, now,
      status === 'suspected' ? null : user.id, status === 'suspected' ? null : user.name || null, status === 'suspected' ? null : now);
  }
  await logAudit({ userId: user.id, actorName: user.name, action: `Backdoor hire marked: ${STATUS_LABEL[status]}`, entity: 'Application', entityId: x.id, fromValue: cur ? STATUS_LABEL[cur.status] : null, toValue: `${x.req.clientName}${note ? ` - ${note}` : ''}` });
  return { ok: true, status };
}

// The client's own list of people who joined them directly.
async function clientList(user, body = {}) {
  const acc = await C.access(user);
  if (acc.viewOnly || !(acc.admin || acc.lead || acc.bde)) return { status: 403, error: 'A team lead, a BDE or an Admin records the client\'s list.' };
  const clientId = String(body.clientId || '');
  const lines = String(body.text || '').split(/[\r\n;]+/).map((l) => l.trim()).filter(Boolean).slice(0, 500);
  if (!clientId || !lines.length) return { status: 400, error: 'Pick the client and paste the names, phones or e-mails (one per line).' };
  const ctx = await C.ctxFor(user, {});
  const apps = ctx.apps.filter((x) => x.req.clientId === clientId && !x.req.internal && x.reached('shared'));
  if (!apps.length) return { status: 404, error: 'Nobody in your area was sent to this client.' };
  const byCand = new Map();
  apps.forEach((x) => { if (!byCand.has(x.a.candidateId) || x.a.createdAt > byCand.get(x.a.candidateId).a.createdAt) byCand.set(x.a.candidateId, x); });
  const joinedThroughUs = new Set(ctx.apps.filter((x) => x.req.clientId === clientId && x.joined).map((x) => x.a.candidateId));
  const cands = await prisma.candidate.findMany({ where: { id: { in: [...byCand.keys()] } }, select: { id: true, name: true, phone: true, email: true } });
  const matched = []; const missed = [];
  lines.forEach((line) => {
    const d = digits(line); const mail = (/[\w.+-]+@[\w-]+\.[\w.]+/.exec(line) || [])[0];
    const nameOnly = line.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '').replace(/[\d+()-]/g, '').trim().toLowerCase();
    const hit = cands.find((c) => (d.length === 10 && (digits(c.phone) === d))
      || (mail && String(c.email || '').toLowerCase() === mail.toLowerCase())
      || (!d && !mail && nameOnly.length >= 3 && String(c.name || '').trim().toLowerCase() === nameOnly));
    if (hit && !joinedThroughUs.has(hit.id)) matched.push(hit); else missed.push(line.replace(/\d(?=\d{4})/g, '•').slice(0, 60));
  });
  await C.ensure();
  const flags = await flagsMap();
  const now = new Date().toISOString();
  const uniq = [...new Map(matched.map((c) => [c.id, c])).values()];
  for (const c of uniq) {
    const x = byCand.get(c.id);
    const cur = flags.get(`${c.id}|${clientId}`);
    if (cur) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('UPDATE "AtsBackdoorFlag" SET "status" = \'confirmed\', "source" = \'client-list\', "decidedById" = ?, "decidedByName" = ?, "decidedAt" = ? WHERE "id" = ?', user.id, user.name || null, now, cur.id);
    } else {
      // eslint-disable-next-line no-await-in-loop
      await prisma.$executeRawUnsafe('INSERT INTO "AtsBackdoorFlag" ("id","applicationId","candidateId","clientId","status","source","note","markedById","markedByName","createdAt","decidedById","decidedByName","decidedAt") VALUES (?,?,?,?,\'confirmed\',\'client-list\',?,?,?,?,?,?,?)',
        C.newId('bdr'), x.id, c.id, clientId, 'On the list the client confirmed', user.id, user.name || null, now, user.id, user.name || null, now);
    }
  }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Backdoor hires: client list recorded', entity: 'Client', entityId: clientId, toValue: `${lines.length} line(s), ${uniq.length} matched` });
  return { ok: true, lines: lines.length, matched: uniq.map((c) => ({ candidateId: c.id, name: c.name })), notMatched: missed };
}

module.exports = { report, mark, clientList, sameCompany, normCo };
