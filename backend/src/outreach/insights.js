// ---------------------------------------------------------------------------
// OMNI-CHANNEL INSIGHTS (founder structure plan 2026-10-17): Performance, Credits usage, ROI, funnel and joining reports.
// Everything is READ from real rows: the credit ledger, campaigns and their messages, the Inbox (conversations), ATS stage events and the HRMS
// joinings count. Where a link cannot be PROVEN the screen says "not linked", never a guess:
//   * a campaign's people -> ATS applications: matched by phone (last 10 digits) or email to a candidate who has an application on the campaign's
//     own job, made after the campaign started (the same match the "already applied" rule uses).
//   * replies cannot be tied to one campaign (a reply belongs to a person's conversation), so they are shown per person, not per campaign.
// Scope (same word as the dashboard): Admin and Manager = everyone; Department Head (STL) = their department; Team Lead / BDE TL = their team;
// everybody else = themselves.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const Cr = require('./credits');
const Camp = require('./campaigns');
const { logAudit } = require('../utils/audit');

const num = (v) => (typeof v === 'bigint' ? Number(v) : (v == null ? 0 : Number(v)));
const JOINED = ['JOINED', 'HIRED'];
const digits10 = (v) => String(v || '').replace(/\D/g, '').slice(-10);
const CHANNELS = ['email', 'whatsapp', 'sms', 'call'];

// who this login may count (the one scope word for every insight)
async function scopeOf(user) {
  const l = A.level(user);
  if (l === 'admin' || (l === 'depthead' && A.deptScope(user).all)) return { all: true, words: 'Everyone' };
  if (l === 'depthead') { const d = A.deptScope(user); return { all: false, departments: d.departments, words: `Department: ${d.departments.join(', ') || 'none'}` }; }
  if (l === 'teamlead') {
    const ids = await require('../utils/conversations').myTeamIds(user); // eslint-disable-line global-require
    return { all: false, userIds: new Set([user.id, ...ids]), words: 'Your team' };
  }
  return { all: false, onlyUserId: user.id, words: 'Only you' };
}
const actOpts = (sc) => (sc.all ? { all: true } : (sc.departments ? { departments: sc.departments } : (sc.userIds ? { userIds: sc.userIds } : { onlyUserId: sc.onlyUserId })));
const unitOf = (st, ch) => (ch === 'call' ? st.unitCost.callPerMinute : st.unitCost[ch]) || 0;

// ---- PERFORMANCE: recruiter, team, department ---------------------------------------------------
async function performance(user, month) {
  const sc = await scopeOf(user);
  const act = await Cr.activity(month, actOpts(sc));
  const byDept = new Map();
  act.rows.forEach((r) => {
    const k = r.department || 'No department';
    const o = byDept.get(k) || { name: k, people: 0, used: 0, sent: 0, followUps: 0, promotions: 0, joinings: 0 };
    o.people += 1; ['used', 'sent', 'followUps', 'promotions', 'joinings'].forEach((f) => { o[f] += r[f] || 0; });
    byDept.set(k, o);
  });
  const reports = await require('./overview').reports(user, { days: 30 }); // eslint-disable-line global-require
  const { ids, ...out } = act; // eslint-disable-line no-unused-vars
  return { ...out, scopeWords: sc.words, byDepartment: [...byDept.values()].sort((a, b) => b.sent - a.sent), campaignTotals: reports.totals || {}, topCampaigns: (reports.campaigns || []).slice().sort((a, b) => b.sent - a.sent).slice(0, 8) };
}

// ---- CREDITS usage (Admin + Finance): usage, consumption, recharges, cost -------------------------------
async function usage(month) {
  await Cr.ensureTables();
  const m = Cr.isMonth(month) ? month : Cr.thisMonth();
  const { from, to } = Cr.range(m);
  const st = await Cr.settings();
  const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
  const per = await q('SELECT channel, mode, COUNT(*) n, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND result <> \'failed\' GROUP BY channel, mode', from, to);
  const chan = {}; CHANNELS.forEach((c) => { chan[c] = { channel: c, messages: 0, credits: 0, testMessages: 0, cost: 0 }; });
  per.forEach((r) => { const o = chan[r.channel]; if (!o) return; if (r.mode === 'live') { o.messages += num(r.n); o.credits += num(r.c); } else o.testMessages += num(r.n); });
  CHANNELS.forEach((c) => { chan[c].cost = Math.round(chan[c].messages * unitOf(st, c) * 100) / 100; });
  const rech = await q('SELECT channel, COALESCE(SUM(amount),0) a, COALESCE(SUM(costRupees),0) r FROM "OmniRecharge" GROUP BY channel');
  const usedAll = await q('SELECT channel, COALESCE(SUM(credits),0) c, COUNT(*) n FROM "OmniCreditLedger" WHERE mode = \'live\' AND result <> \'failed\' GROUP BY channel');
  const balance = CHANNELS.map((c) => {
    const rc = rech.find((r) => r.channel === c); const us = usedAll.find((r) => r.channel === c);
    const bought = rc ? num(rc.a) : 0; const used = c === 'call' ? 0 : (us ? num(us.c) : 0);
    return { channel: c, bought, used, left: c === 'call' ? bought : bought - used, spent: rc ? Math.round(num(rc.r) * 100) / 100 : 0, minutesTracked: c === 'call' ? false : undefined };
  });
  const byDept = await q('SELECT COALESCE(department, \'No department\') d, channel, COUNT(*) n, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND mode = \'live\' AND result <> \'failed\' GROUP BY d, channel', from, to);
  const dm = new Map();
  byDept.forEach((r) => { const o = dm.get(r.d) || { name: r.d, messages: 0, credits: 0, cost: 0 }; o.messages += num(r.n); o.credits += num(r.c); o.cost += num(r.n) * unitOf(st, r.channel); dm.set(r.d, o); });
  const byPerson = await q('SELECT COALESCE(userName, \'System\') u, COUNT(*) n, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE at >= ? AND at < ? AND mode = \'live\' AND result <> \'failed\' GROUP BY userId, userName ORDER BY c DESC LIMIT 15', from, to);
  const recharges = (await q('SELECT id, CAST(at AS TEXT) at, channel, amount, costRupees, note, byName FROM "OmniRecharge" ORDER BY at DESC LIMIT 50')).map((r) => ({ id: r.id, at: S.iso(Number(r.at)), channel: r.channel, amount: num(r.amount), costRupees: num(r.costRupees), note: r.note || '', byName: r.byName || '' }));
  const totalCost = Object.values(chan).reduce((n, c) => n + c.cost, 0);
  return {
    month: m, channels: Object.values(chan), balance, byDepartment: [...dm.values()].map((d) => ({ ...d, cost: Math.round(d.cost * 100) / 100 })).sort((a, b) => b.credits - a.credits),
    byPerson: byPerson.map((r) => ({ name: r.u, messages: num(r.n), credits: num(r.c) })), recharges, unitCost: st.unitCost, totalCost: Math.round(totalCost * 100) / 100,
    notes: ['Credits are the message credits Omni-Channel counts (see Configuration > Permissions > Credits rules). Calling minutes are not recorded by the calling provider link yet, so only calls logged and recharges are shown.', 'Cost = messages sent x the unit cost you typed for that way. Unit costs start at 0 until an Admin types them.'],
  };
}
async function addRecharge(user, b) {
  await Cr.ensureTables();
  const channel = String(b.channel || '').toLowerCase();
  if (!CHANNELS.includes(channel)) return { error: 'Choose Email, WhatsApp, SMS or Calls.', status: 400 };
  const amount = Math.floor(Number(b.amount));
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return { error: 'Type how many credits (or minutes) were added.', status: 400 };
  const cost = Number(b.costRupees || 0);
  if (!Number.isFinite(cost) || cost < 0 || cost > 1e9) return { error: 'Type the amount paid in rupees (or leave it empty).', status: 400 };
  const at = b.at && Number.isFinite(Date.parse(b.at)) ? Date.parse(b.at) : Date.now();
  const id = S.newId('orc');
  await prisma.$executeRawUnsafe('INSERT INTO "OmniRecharge" (id, at, channel, amount, costRupees, note, byId, byName) VALUES (?,?,?,?,?,?,?,?)', id, at, channel, amount, cost, S.clip(b.note, 200) || null, user.id, user.name);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni-Channel recharge recorded', entity: 'OmniRecharge', entityId: id, toValue: `${channel} +${amount}, Rs ${cost}` });
  return { ok: 'Saved.', id };
}

// replies that came back in the chats each person handles ("Handled by" in the Inbox): candidates' replies (CandidateMessage, RECEIVED) and replies in the one inbox
// (ConversationMessage, IN). Raw SQL: the Prisma client has no Conversation model. Times are stored as milliseconds.
async function repliesByOwner(ids, from, to) {
  const out = new Map();
  if (!ids.length) return out;
  const ph = ids.map(() => '?').join(',');
  const add = (rows) => rows.forEach((r) => { if (r.u) out.set(r.u, (out.get(r.u) || 0) + num(r.n)); });
  try { add(await prisma.$queryRawUnsafe(`SELECT c.ownerUserId u, COUNT(*) n FROM "CandidateMessage" m JOIN "Conversation" c ON c.personType = 'CANDIDATE' AND c.personId = m.candidateId WHERE m.status = 'RECEIVED' AND m.createdAt >= ? AND m.createdAt < ? AND c.ownerUserId IN (${ph}) GROUP BY c.ownerUserId`, from, to, ...ids)); } catch { /* no table yet */ }
  try { add(await prisma.$queryRawUnsafe(`SELECT c.ownerUserId u, COUNT(*) n FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m.conversationId WHERE m.direction = 'IN' AND m.createdAt >= ? AND m.createdAt < ? AND c.ownerUserId IN (${ph}) GROUP BY c.ownerUserId`, from, to, ...ids)); } catch { /* no table yet */ }
  return out;
}

// ---- ROI -----------------------------------------------------------------------------------------------------------------
async function campaignRoi(user, { days = 90 } = {}) {
  if (!(await S.campaignsReady())) return { ready: false, campaigns: [] };
  const st = await Cr.settings();
  const from = Date.now() - Math.max(1, Math.min(365, Number(days) || 90)) * 86400000;
  const rows = (await Camp.visibleRows(user)).filter((r) => r.type === 'job_promotion' && (S.num(r.createdAt) >= from));
  const out = [];
  for (const c of rows) {
    const msgs = await S.q('SELECT m.status, ct.phoneKey, ct.emailKey FROM "OutreachMessage" m JOIN "OutreachContact" ct ON ct.id = m.contactId WHERE m.campaignId = ?', c.id); // eslint-disable-line no-await-in-loop
    const real = msgs.filter((m) => ['sent', 'delivered'].includes(m.status));
    const phones = new Set(real.map((m) => m.phoneKey).filter(Boolean)); const emails = new Set(real.map((m) => String(m.emailKey || '').toLowerCase()).filter(Boolean));
    const clicks = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND firstClickAt IS NOT NULL', c.id))[0].n); // eslint-disable-line no-await-in-loop
    const led = (await prisma.$queryRawUnsafe('SELECT COALESCE(SUM(credits),0) c, COUNT(*) n FROM "OmniCreditLedger" WHERE campaignId = ? AND mode = \'live\' AND result <> \'failed\'', c.id))[0]; // eslint-disable-line no-await-in-loop
    let matched = null; let interviews = null; let joined = null; const joinedNames = [];
    if (c.requirementId) {
      const since = new Date(S.num(c.startedAt) || S.num(c.createdAt));
      // eslint-disable-next-line no-await-in-loop
      const apps = await prisma.application.findMany({ where: { requirementId: c.requirementId, createdAt: { gte: since } }, select: { id: true, stage: true, candidate: { select: { name: true, phone: true, email: true } }, stageEvents: { select: { toStage: true } } } }).catch(() => []);
      const hit = apps.filter((a) => a.candidate && ((digits10(a.candidate.phone) && phones.has(digits10(a.candidate.phone))) || (a.candidate.email && emails.has(String(a.candidate.email).toLowerCase()))));
      matched = hit.length;
      interviews = hit.filter((a) => a.stageEvents.some((e) => e.toStage === 'INTERVIEW_SCHEDULED')).length;
      const j = hit.filter((a) => JOINED.includes(a.stage)); joined = j.length; j.forEach((a) => joinedNames.push(a.candidate.name));
    }
    const credits = num(led.c);
    out.push({
      id: c.id, name: c.name, channel: c.channel, owner: c.createdByName || '', status: Camp.STATUS_WORDS[c.status] || c.status, live: c.mode === 'live',
      people: msgs.length, sent: real.length, opened: clicks, credits, cost: Math.round(credits * unitOf(st, c.channel) * 100) / 100,
      applied: matched, interviews, joined, joinedNames: joinedNames.slice(0, 10), replies: 'not linked',
      note: c.mode === 'live' ? (matched === null ? 'not linked' : '') : 'Rehearsal: nothing really sent, so nothing can be linked.',
    });
  }
  return { ready: true, campaigns: out };
}

async function roi(user, month) {
  const sc = await scopeOf(user);
  const m = Cr.isMonth(month) ? month : Cr.thisMonth();
  const st = await Cr.settings();
  const act = await Cr.activity(m, actOpts(sc));
  const { from, to } = Cr.range(m);
  const ids = act.rows.map((r) => r.userId);
  // replies in the conversations each person handles, interviews they booked (ATS stage events)
  const replyBy = await repliesByOwner(ids, from, to);
  const intBy = new Map();
  try {
    const ev = await prisma.applicationStageEvent.groupBy({ by: ['actorUserId'], where: { toStage: 'INTERVIEW_SCHEDULED', actorUserId: { in: ids }, createdAt: { gte: new Date(from), lt: new Date(to) } }, _count: { _all: true } });
    ev.forEach((x) => intBy.set(x.actorUserId, x._count._all));
  } catch { /* none */ }
  const persons = act.rows.map((r) => {
    const cost = Math.round((r.email * unitOf(st, 'email') + r.whatsapp * unitOf(st, 'whatsapp') + r.sms * unitOf(st, 'sms')) * 100) / 100;
    const resp = replyBy.get(r.userId) || 0; const iv = intBy.get(r.userId) || 0;
    return { userId: r.userId, name: r.name, department: r.department, credits: r.used, cost, replies: resp, interviews: iv, joinings: r.joinings, perJoining: r.joinings > 0 ? Math.round((cost / r.joinings) * 100) / 100 : null };
  });
  const dm = new Map();
  persons.forEach((p) => { const k = p.department || 'No department'; const o = dm.get(k) || { name: k, people: 0, credits: 0, cost: 0, replies: 0, interviews: 0, joinings: 0 }; o.people += 1; ['credits', 'cost', 'replies', 'interviews', 'joinings'].forEach((f) => { o[f] += p[f]; }); dm.set(k, o); });
  const camps = await campaignRoi(user, { days: 90 });
  return {
    month: m, scopeWords: sc.words, persons, departments: [...dm.values()].map((d) => ({ ...d, cost: Math.round(d.cost * 100) / 100 })), campaigns: camps.campaigns,
    notes: [
      'People table: the same month for each person. Replies = messages that came back in the conversations they handle. Interviews = interviews they booked in the ATS. Joinings = the HRMS recruiter-joinings count. These are numbers of the same period, not a proof that one caused the other.',
      'Campaign table: applied, interviews and joined are counted only for candidates matched by phone or email to people the campaign really messaged, who applied to the campaign\'s own requirement after it started. Rehearsals link nothing. Replies cannot be tied to one campaign: "not linked".',
      'Cost uses the unit cost per way typed in Configuration (it starts at 0).',
    ],
  };
}

// conversion funnel + joining report (campaigns of the last `days` days this login may see)
async function funnel(user, days = 90) {
  const c = await campaignRoi(user, { days });
  if (!c.ready) return { ready: false };
  const sum = (k) => c.campaigns.reduce((n, x) => n + (typeof x[k] === 'number' ? x[k] : 0), 0);
  const steps = [['People in the campaigns', sum('people')], ['Messages really sent', sum('sent')], ['Opened the apply link', sum('opened')], ['Applied (matched to the ATS)', sum('applied')], ['Interview booked', sum('interviews')], ['Joined', sum('joined')]];
  return { ready: true, days: Number(days) || 90, steps: steps.map(([label, n]) => ({ label, n })), joinings: c.campaigns.filter((x) => x.joined > 0).map((x) => ({ campaign: x.name, owner: x.owner, joined: x.joined, names: x.joinedNames })) };
}

// ===========================================================================
// v3 (Green Start rebuild, 2026-10-17): the ANALYTICS & REPORTS page (Communication Analytics, Conversion Funnel) and the ATS links the dashboard needs.
// Same honesty rules as above: sent / delivered / failed are counted from the queue; "engaged" = clicked the apply link OR replied (there is no
// per-message "read" receipt, so the screen never says "read"); applied / interview / offer / joined are linked to a campaign only by the proven
// phone-or-email match to a candidate who applied to the campaign's own job after it started, and only for campaigns that REALLY sent (a rehearsal
// links nothing). Where a link cannot be proven the number is null ("not linked"), never a guess.
// ===========================================================================
const IST_MS = 5.5 * 3600 * 1000;
const OFFER_STAGES = ['OFFER', 'OFFER_ACCEPTED', 'SELECTED', 'JOINED', 'HIRED'];
const FAIL_STATUS = ['failed', 'bounced', 'complained', 'unknown'];
const CH_WORDS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', call: 'Voice' };
const CH_COLORS = { whatsapp: '#11985a', sms: '#4d7ddb', email: '#ef9b35', call: '#7867d9' };
const chunkOf = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const phs = (n) => new Array(n).fill('?').join(',');
const ENGAGED_SQL = '(m.firstClickAt IS NOT NULL OR m.repliedAt IS NOT NULL OR EXISTS (SELECT 1 FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = \'replied\'))';

// India day string (YYYY-MM-DD) -> the start / end of that day in milliseconds
const dayMs = (v, end) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? Date.parse(`${v}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`) : null);
const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
// the applied date range: { from, to (inclusive end of day), fromDay, toDay, days, preset }. Default = the last 30 days. At most 366 days.
function rangeFrom(q = {}, now = Date.now()) {
  const today = new Date(now + IST_MS).toISOString().slice(0, 10);
  const toDay0 = /^\d{4}-\d{2}-\d{2}$/.test(String(q.to || '')) ? String(q.to) : today;
  const fromDay0 = /^\d{4}-\d{2}-\d{2}$/.test(String(q.from || '')) ? String(q.from) : new Date(Date.parse(`${toDay0}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  let fromDay = fromDay0 <= toDay0 ? fromDay0 : toDay0; const toDay = fromDay0 <= toDay0 ? toDay0 : fromDay0;
  if (dayDiff(fromDay, toDay) + 1 > 366) fromDay = new Date(Date.parse(`${toDay}T00:00:00Z`) - 365 * 86400000).toISOString().slice(0, 10);
  return { from: dayMs(fromDay, false), to: dayMs(toDay, true), fromDay, toDay, days: dayDiff(fromDay, toDay) + 1, preset: S.clip(q.preset, 30) || null };
}

// campaigns -> ATS: for every campaign that REALLY sent a job promotion, the applications made after it started by people it messaged (phone / email match).
// opts.from / opts.to (ms) keep only applications made in that window. Returns totals and per campaign; linkable = how many campaigns could be linked at all.
async function linkApplications(rows, opts = {}) {
  const out = { linkable: 0, applied: 0, interviews: 0, offers: 0, joined: 0, byCampaign: {} };
  for (const c of rows || []) {
    if (c.type !== 'job_promotion' || !c.requirementId || c.mode !== 'live') continue; // eslint-disable-line no-continue
    const msgs = await S.q('SELECT m.status, ct.phoneKey, ct.emailKey FROM "OutreachMessage" m JOIN "OutreachContact" ct ON ct.id = m.contactId WHERE m.campaignId = ?', c.id); // eslint-disable-line no-await-in-loop
    const real = msgs.filter((m) => ['sent', 'delivered'].includes(m.status));
    if (!real.length) continue; // eslint-disable-line no-continue
    out.linkable += 1;
    const phones = new Set(real.map((m) => m.phoneKey).filter(Boolean)); const emails = new Set(real.map((m) => String(m.emailKey || '').toLowerCase()).filter(Boolean));
    const since = Math.max(S.num(c.startedAt) || S.num(c.createdAt), opts.from || 0);
    const createdAt = { gte: new Date(since) }; if (opts.to) createdAt.lt = new Date(opts.to);
    // eslint-disable-next-line no-await-in-loop
    const apps = await prisma.application.findMany({ where: { requirementId: c.requirementId, createdAt }, select: { id: true, stage: true, candidate: { select: { phone: true, email: true } }, stageEvents: { select: { toStage: true } } } }).catch(() => []);
    const hit = apps.filter((a) => a.candidate && ((digits10(a.candidate.phone) && phones.has(digits10(a.candidate.phone))) || (a.candidate.email && emails.has(String(a.candidate.email).toLowerCase()))));
    const iv = hit.filter((a) => a.stageEvents.some((e) => e.toStage === 'INTERVIEW_SCHEDULED') || OFFER_STAGES.includes(a.stage)).length;
    const of = hit.filter((a) => OFFER_STAGES.includes(a.stage) || a.stageEvents.some((e) => OFFER_STAGES.includes(e.toStage))).length;
    const jn = hit.filter((a) => JOINED.includes(a.stage)).length;
    out.byCampaign[c.id] = { applied: hit.length, interviews: iv, offers: of, joined: jn };
    out.applied += hit.length; out.interviews += iv; out.offers += of; out.joined += jn;
  }
  return out;
}

// who the credit ledger may be counted for (the same scope word as every other insight), optionally narrowed to one department (null = not allowed = nothing)
async function ledgerScope(user, dept) {
  const sc = await scopeOf(user);
  const conds = []; const params = [];
  if (!sc.all) {
    if (sc.departments) { const d = sc.departments.map((x) => String(x).toLowerCase()); conds.push(`LOWER(COALESCE(department, '')) IN (${phs(Math.max(1, d.length))})`); params.push(...(d.length ? d : ['\u0000'])); }
    else if (sc.userIds) { const ids = [...sc.userIds]; conds.push(`userId IN (${phs(Math.max(1, ids.length))})`); params.push(...(ids.length ? ids : ['\u0000'])); }
    else { conds.push('userId = ?'); params.push(sc.onlyUserId); }
  }
  if (dept) { conds.push('LOWER(COALESCE(department, \'\')) = ?'); params.push(String(dept).toLowerCase()); }
  if (dept === null) conds.push('1 = 0');
  return { where: conds.length ? ` AND ${conds.join(' AND ')}` : '', params };
}
// the Voice number: calls logged in the window (calls are not campaigns; they are logged one by one)
async function callsLogged(user, from, to, dept) {
  try {
    await Cr.ensureTables();
    const sc = await ledgerScope(user, dept);
    return num((await prisma.$queryRawUnsafe(`SELECT COUNT(*) n FROM "OmniCreditLedger" WHERE channel = 'call' AND mode = 'live' AND at >= ? AND at <= ?${sc.where}`, from, to, ...sc.params))[0].n);
  } catch { return 0; }
}

// the date a campaign counts on: the day it started, else the day it is scheduled, else the day it was made
const campaignDay = (c) => S.num(c.startedAt) || S.num(c.scheduledAt) || S.num(c.createdAt);

// ---- COMMUNICATION ANALYTICS ---------------------------------------------------------------------------------------------
async function commAnalytics(user, q = {}) {
  const Ov = require('./overview'); // eslint-disable-line global-require
  const Sup = require('./suppress'); // eslint-disable-line global-require
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const rg = rangeFrom(q);
  const dept = q.dept === undefined ? '' : q.dept;
  const all = await Ov.scopedCampaigns(user, dept);
  const inRange = all.filter((c) => { const d = campaignDay(c); return d >= rg.from && d <= rg.to; });
  const ids = inRange.map((c) => c.id);
  const per = {}; ids.forEach((id) => { per[id] = { total: 0, sent: 0, delivered: 0, engaged: 0, failed: 0, rehearsed: 0, waiting: 0, skipped: 0 }; });
  const byCh = {}; ['whatsapp', 'sms', 'email'].forEach((c) => { byCh[c] = { total: 0, sent: 0, delivered: 0, engaged: 0, failed: 0, rehearsed: 0, waiting: 0 }; });
  const slices = { delivered: 0, engaged: 0, failed: 0, sent: 0, rehearsed: 0, waiting: 0 };
  let skipped = 0;
  const reasonMap = new Map();
  for (const part of chunkOf(ids, 400)) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await S.q(`SELECT m.campaignId cid, m.channel ch, m.status st, ${ENGAGED_SQL} AS eng, COUNT(*) n FROM "OutreachMessage" m WHERE m.campaignId IN (${phs(part.length)}) GROUP BY m.campaignId, m.channel, m.status, eng`, ...part);
    rows.forEach((r) => {
      const n = num(r.n); const p = per[r.cid]; const c = byCh[r.ch];
      if (r.st === 'cancelled') return;
      if (r.st === 'skipped') { p.skipped += n; skipped += n; return; }
      p.total += n; if (c) c.total += n;
      const eng = num(r.eng) > 0;
      if (['sent', 'delivered'].includes(r.st)) {
        p.sent += n; if (c) c.sent += n;
        if (r.st === 'delivered') { p.delivered += n; if (c) c.delivered += n; }
        if (eng) { p.engaged += n; if (c) c.engaged += n; slices.engaged += n; } else if (r.st === 'delivered') slices.delivered += n; else slices.sent += n;
      } else if (r.st === 'test_captured') { p.rehearsed += n; if (c) c.rehearsed += n; slices.rehearsed += n; }
      else if (FAIL_STATUS.includes(r.st)) { p.failed += n; if (c) c.failed += n; slices.failed += n; }
      else { p.waiting += n; if (c) c.waiting += n; slices.waiting += n; } // queued / sending
    });
    // eslint-disable-next-line no-await-in-loop
    const bad = await S.q(`SELECT m.campaignId cid, m.reason reason, SUBSTR(COALESCE(m.error, ''), 1, 60) err, COUNT(*) n FROM "OutreachMessage" m WHERE m.campaignId IN (${phs(part.length)}) AND m.status IN ('failed','bounced','complained','unknown') GROUP BY m.campaignId, m.reason, err`, ...part);
    bad.forEach((b) => {
      const key = b.reason ? `r:${b.reason}` : `e:${b.err || ''}`;
      const o = reasonMap.get(key) || { key, words: b.reason ? (Sup.REASON_WORDS[b.reason] || b.reason) : (b.err || 'The provider did not accept it'), group: b.reason ? ((Sup.GROUP_WORDS && Sup.GROUP_WORDS[Sup.groupOf(b.reason)]) || '') : '', count: 0, campaignIds: [] };
      o.count += num(b.n); if (!o.campaignIds.includes(b.cid)) o.campaignIds.push(b.cid);
      reasonMap.set(key, o);
    });
  }
  const tot = Object.values(per).reduce((o, p) => { Object.keys(p).forEach((k) => { o[k] = (o[k] || 0) + p[k]; }); return o; }, {});
  const calls = await callsLogged(user, rg.from, rg.to, dept);
  const COLORS = ['#de5c63', '#ef9b35', '#7867d9', '#4d7ddb', '#11985a'];
  const failures = [...reasonMap.values()].sort((a, b) => b.count - a.count).slice(0, 5).map((f, i) => ({ ...f, color: COLORS[i % COLORS.length], desc: f.group || f.words }));
  const activity = inRange.slice().sort((a, b) => campaignDay(b) - campaignDay(a)).map((c) => ({
    id: c.id, name: c.name, channel: c.channel, channelWords: CH_WORDS[c.channel] || c.channel, status: c.status, statusWords: Camp.STATUS_WORDS[c.status] || c.status,
    live: c.mode === 'live', rehearsal: c.mode === 'rehearsal', at: S.iso(campaignDay(c)), ...per[c.id],
  }));
  return {
    ready: true, range: { from: rg.fromDay, to: rg.toDay, days: rg.days, preset: rg.preset }, campaignsTotal: all.length, campaignsInRange: inRange.length,
    totals: { total: tot.total || 0, sent: tot.sent || 0, delivered: tot.delivered || 0, engaged: tot.engaged || 0, failed: tot.failed || 0, rehearsed: tot.rehearsed || 0, waiting: tot.waiting || 0, skipped },
    slices, channels: [...['whatsapp', 'sms', 'email'].map((id) => ({ id, label: CH_WORDS[id], color: CH_COLORS[id], ...byCh[id] })), { id: 'call', label: 'Voice', color: CH_COLORS.call, total: calls, calls: true }],
    failures, activity,
    notes: [
      'A campaign counts on the day it started (or the day it is scheduled for, or the day it was made).',
      'Engaged = the person clicked the apply link or replied. There is no per-message "read" receipt, so nothing here says "read".',
      'Rehearsed = Test mode: the message was made but NOT really sent. It is never counted as sent.',
      'Voice = calls logged by people in this period (calls are not campaigns).',
    ],
  };
}

// the Analytics export: one row per way, then one row per campaign in the range (numbers only: no phone, no email)
function reportCsvFull(rep) {
  const MLog = require('./messageLog'); // eslint-disable-line global-require
  const e = (v) => String(MLog.safeCell(v));
  const lines = [['Channel', 'Total', 'Sent', 'Delivered', 'Engaged', 'Failed', 'Rehearsed (not really sent)', 'Waiting'].map(e).join(',')];
  rep.channels.forEach((c) => lines.push([c.label, c.total, c.calls ? '' : c.sent, c.calls ? '' : c.delivered, c.calls ? '' : c.engaged, c.calls ? '' : c.failed, c.calls ? '' : c.rehearsed, c.calls ? '' : c.waiting].map(e).join(',')));
  lines.push('');
  lines.push(['Campaign', 'Way', 'Status', 'Date (India)', 'Total', 'Sent', 'Delivered', 'Engaged', 'Failed', 'Rehearsed', 'Waiting'].map(e).join(','));
  rep.activity.forEach((a) => lines.push([a.name, a.channelWords, a.statusWords, a.at ? new Date(new Date(a.at).getTime() + IST_MS).toISOString().slice(0, 10) : '', a.total, a.sent, a.delivered, a.engaged, a.failed, a.rehearsed, a.waiting].map(e).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// ---- CONVERSION FUNNEL (people -> sent -> delivered -> opened link -> replied -> applied -> interview -> offer -> joined) ------------------------
async function funnelFull(user, q = {}) {
  const Ov = require('./overview'); // eslint-disable-line global-require
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const rg = rangeFrom(q);
  const dept = q.dept === undefined ? '' : q.dept;
  const channel = ['whatsapp', 'sms', 'email'].includes(String(q.channel)) ? String(q.channel) : '';
  const all = await Ov.scopedCampaigns(user, dept);
  const rows = all.filter((c) => { const d = campaignDay(c); return d >= rg.from && d <= rg.to && (!channel || c.channel === channel); });
  const ids = rows.map((c) => c.id);
  const contacts = new Set(); let people = 0; let sent = 0; let delivered = 0; let opened = 0; let replied = 0; let rehearsed = 0;
  for (const part of chunkOf(ids, 400)) {
    // eslint-disable-next-line no-await-in-loop
    const ms = await S.q(`SELECT m.contactId c, m.status st, CASE WHEN m.firstClickAt IS NOT NULL THEN 1 ELSE 0 END k, CASE WHEN (m.repliedAt IS NOT NULL OR EXISTS (SELECT 1 FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = 'replied')) THEN 1 ELSE 0 END r FROM "OutreachMessage" m WHERE m.campaignId IN (${phs(part.length)}) AND m.status NOT IN ('skipped','cancelled')`, ...part);
    ms.forEach((m) => {
      contacts.add(m.c); people += 1;
      if (['sent', 'delivered'].includes(m.st)) { sent += 1; if (m.st === 'delivered') delivered += 1; if (num(m.k)) opened += 1; if (num(m.r)) replied += 1; } else if (m.st === 'test_captured') rehearsed += 1;
    });
  }
  const link = await linkApplications(rows, {});
  const linked = link.linkable > 0;
  // cost = credits really used by these campaigns x the unit cost typed in Configuration (it starts at 0)
  const st = await Cr.settings();
  let cost = 0;
  try {
    for (const part of chunkOf(ids, 400)) {
      // eslint-disable-next-line no-await-in-loop
      (await prisma.$queryRawUnsafe(`SELECT channel, COALESCE(SUM(credits),0) c FROM "OmniCreditLedger" WHERE campaignId IN (${phs(part.length)}) AND mode = 'live' AND result <> 'failed' GROUP BY channel`, ...part)).forEach((r) => { cost += num(r.c) * unitOf(st, r.channel); });
    }
  } catch { cost = 0; }
  const stage = (id, label, note, n, isLink) => ({ id, label, note, n: isLink && !linked ? null : n, linked: !isLink || linked });
  const steps = [
    stage('people', 'People', 'Messages made for them (people skipped are not counted)', people, false),
    stage('sent', 'Sent', 'Really handed to the provider', sent, false),
    stage('delivered', 'Delivered', 'Confirmed by the provider (some never confirm, so this can look low)', delivered, false),
    stage('opened', 'Opened the link', 'Tapped the apply link', opened, false),
    stage('replied', 'Replied', 'Wrote back', replied, false),
    stage('applied', 'Applied', 'Applied to the requirement after the message (matched by phone or email)', link.applied, true),
    stage('interview', 'Interview', 'Interview booked', link.interviews, true),
    stage('offer', 'Offer', 'Offer or selected', link.offers, true),
    stage('joined', 'Joined', 'Joined the company', link.joined, true),
  ];
  return {
    ready: true, range: { from: rg.fromDay, to: rg.toDay, days: rg.days }, channel, campaigns: rows.length, uniquePeople: contacts.size, steps, linked, rehearsed,
    tiles: { replyRate: sent ? Math.round((replied / sent) * 1000) / 10 : null, applyRate: linked && sent ? Math.round((link.applied / sent) * 1000) / 10 : null, joinedPer100: linked && sent ? Math.round((link.joined / sent) * 10000) / 100 : null, cost: Math.round(cost * 100) / 100, perJoining: linked && link.joined > 0 && cost > 0 ? Math.round((cost / link.joined) * 100) / 100 : null },
    notes: [
      linked ? 'Applied, Interview, Offer and Joined are counted only for people the campaign really messaged who then applied to its own requirement (matched by phone or email).' : 'Applied, Interview, Offer and Joined are "not linked": no job campaign in this range has really sent a message yet (a rehearsal links nothing).',
      'There is no revenue figure here: revenue is the invoices Accounts raise for the whole company and is not tied to one campaign.',
    ],
  };
}

module.exports = { repliesByOwner, actOpts, scopeOf, performance, usage, addRecharge, roi, campaignRoi, funnel, rangeFrom, campaignDay, linkApplications, ledgerScope, callsLogged, commAnalytics, reportCsvFull, funnelFull, CH_WORDS, CH_COLORS };
