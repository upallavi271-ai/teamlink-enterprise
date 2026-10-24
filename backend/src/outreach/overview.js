// ---------------------------------------------------------------------------
// OMNI-CHANNEL OVERVIEW + REPORTS + CONTACT TIMELINE (360 audit, 2026-10-17). Read only, held to the campaigns / contacts the login may see
// (campaigns.visibleRows, contacts.getOne). Numbers only; a contact's phone / email never leaves here (the timeline shows no address).
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const Camp = require('./campaigns');
const K = require('./contacts');
const Sup = require('./suppress');
const MLog = require('./messageLog');

const IST = 5.5 * 3600 * 1000;
const dayStart = (now = Date.now()) => Math.floor((now + IST) / 86400000) * 86400000 - IST;
const ph = (n) => new Array(n).fill('?').join(',');
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const FAIL = ['failed', 'bounced', 'complained', 'unknown'];
const CH_WORD = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };

async function visible(user) {
  if (!(await S.campaignsReady())) return [];
  return Camp.visibleRows(user);
}

async function overview(user) {
  if (!(await S.ready())) return { ready: false };
  const rows = await visible(user);
  const ids = rows.map((r) => r.id);
  const t0 = dayStart();
  let sentToday = 0; let failedToday = 0; let waiting = 0; let rehearsedToday = 0;
  const problems = [];
  for (const part of chunk(ids, 400)) {
    if (!part.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const a = await S.q(`SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) AND COALESCE(sentAt, failedAt, 0) >= ? GROUP BY status`, ...part, t0);
    a.forEach((r) => { const n = S.num(r.n); if (['sent', 'delivered'].includes(r.status)) sentToday += n; if (r.status === 'test_captured') rehearsedToday += n; if (FAIL.includes(r.status)) failedToday += n; });
    // eslint-disable-next-line no-await-in-loop
    waiting += S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) AND status IN ('queued','sending')`, ...part))[0].n);
    // eslint-disable-next-line no-await-in-loop
    const bad = await S.q(`SELECT m.campaignId, m.channel, m.status, m.reason, m.error, COALESCE(m.failedAt, m.sentAt, m.queuedAt) at FROM "OutreachMessage" m WHERE m.campaignId IN (${ph(part.length)}) AND m.status IN ('failed','bounced','complained','unknown') ORDER BY at DESC LIMIT 8`, ...part);
    bad.forEach((b) => problems.push(b));
  }
  const nameOf = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  problems.sort((x, y) => S.num(y.at) - S.num(x.at));
  let contacts = 0;
  try { contacts = (await K.list(user, { type: A.seesLeads(user) ? 'candidate_lead' : 'internal', page: 1, pageSize: 5 })).total; } catch { contacts = 0; }
  let replies = { conversations: 0 };
  try { replies = await require('../utils/conversations').unreadCount(user); } catch { /* inbox not ready */ } // eslint-disable-line global-require
  const st = await S.settings();
  return {
    ready: true,
    tiles: { contacts, campaigns: rows.length, running: rows.filter((r) => r.status === 'running').length, notSentYet: rows.filter((r) => r.status === 'draft').length, sentToday, rehearsedToday, failedToday, waiting, unreadReplies: replies.conversations || 0 },
    testMode: st.emailTestMode, sendingOn: st.master,
    problems: problems.slice(0, 8).map((b) => ({ campaign: nameOf[b.campaignId] || 'Campaign', channel: CH_WORD[b.channel] || b.channel, why: b.reason ? (Sup.REASON_WORDS[b.reason] || b.reason) : (b.error || 'The provider did not accept it'), at: S.iso(b.at) })),
  };
}

// REPORTS: per campaign, per channel, per person, per day (last `days`), for the campaigns this login may see
async function reports(user, { days = 30 } = {}) {
  if (!(await S.campaignsReady())) return { ready: false };
  const from = Date.now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86400000;
  const rows = (await visible(user)).filter((r) => S.num(r.createdAt) >= from || r.status === 'running');
  const counts = await Camp.countsFor(rows.map((r) => r.id));
  const per = rows.map((r) => {
    const c = counts[r.id] || {};
    return {
      id: r.id, name: r.name, type: r.type, channel: CH_WORD[r.channel] || r.channel, status: Camp.STATUS_WORDS[r.status] || r.status, owner: r.createdByName || '', at: S.iso(r.createdAt),
      total: c.total || 0, sent: c.sent || 0, delivered: c.delivered || 0, clicked: c.clicked || 0, applied: c.applied || 0, failed: c.failed || 0, skipped: c.skipped || 0, waiting: c.waiting || 0,
    };
  });
  const roll = (key) => {
    const m = new Map();
    per.forEach((p) => {
      const k = p[key] || '-';
      const o = m.get(k) || { name: k, campaigns: 0, total: 0, sent: 0, delivered: 0, clicked: 0, applied: 0, failed: 0 };
      o.campaigns += 1; ['total', 'sent', 'delivered', 'clicked', 'applied', 'failed'].forEach((f) => { o[f] += p[f]; });
      m.set(k, o);
    });
    return [...m.values()].sort((a, b) => b.sent - a.sent);
  };
  const trend = new Map();
  for (const part of chunk(rows.map((r) => r.id), 400)) {
    if (!part.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const t = await S.q(`SELECT sentAt s FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) AND sentAt IS NOT NULL AND sentAt >= ? AND status IN ('sent','delivered')`, ...part, from);
    t.forEach((x) => { const d = new Date(S.num(x.s) + IST).toISOString().slice(0, 10); trend.set(d, (trend.get(d) || 0) + 1); });
  }
  const totals = per.reduce((o, p) => { ['total', 'sent', 'delivered', 'clicked', 'applied', 'failed', 'skipped'].forEach((f) => { o[f] = (o[f] || 0) + p[f]; }); return o; }, { campaigns: per.length });
  return {
    ready: true, days: Number(days) || 30, totals, campaigns: per, byChannel: roll('channel'), byPerson: roll('owner'), byDay: [...trend.entries()].sort().map(([d, n]) => ({ day: d, sent: n })),
    note: 'Sent, delivered, clicked, applied and failed are counted here. Read and replied counts come from the Responses inbox and WhatsApp read receipts (not per campaign yet).',
  };
}
function reportCsv(rep) {
  const e = (v) => { const s = MLog.safeCell ? String(MLog.safeCell(v)) : String(v == null ? '' : v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const lines = [['Campaign', 'Type', 'Channel', 'Status', 'Started by', 'People', 'Sent', 'Delivered', 'Clicked', 'Applied', 'Failed', 'Skipped', 'Waiting'].join(',')];
  rep.campaigns.forEach((p) => lines.push([p.name, p.type === 'internal' ? 'Staff message' : 'Job promotion', p.channel, p.status, p.owner, p.total, p.sent, p.delivered, p.clicked, p.applied, p.failed, p.skipped, p.waiting].map(e).join(',')));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// one contact's history: messages sent to them and permission changes (no address shown)
async function timeline(user, contactId) {
  const one = await K.getOne(user, contactId);
  if (!one) return null;
  const items = [];
  if (await S.campaignsReady()) {
    const m = await S.q('SELECT m.channel, m.status, m.reason, m.sentAt, m.failedAt, m.queuedAt, k.name cname FROM "OutreachMessage" m JOIN "OutreachCampaign" k ON k.id = m.campaignId WHERE m.contactId = ? ORDER BY m.queuedAt DESC LIMIT 60', contactId);
    m.forEach((x) => items.push({ at: S.iso(x.sentAt || x.failedAt || x.queuedAt), kind: 'message', text: `${CH_WORD[x.channel] || x.channel} message in "${x.cname}": ${MLog.RAW_WORDS[x.status] || x.status}${x.reason ? ` (${Sup.REASON_WORDS[x.reason] || x.reason})` : ''}` }));
  }
  if (A.kind(user) !== 'recruiter') try { // a recruiter does not see the permission history (same rule as the contact card)
    const ev = await S.q('SELECT channel, action, source, at FROM "OutreachConsentEvent" WHERE contactId = ? ORDER BY at DESC LIMIT 40', contactId);
    ev.forEach((x) => items.push({ at: S.iso(x.at), kind: 'consent', text: `${x.action === 'opt_in' ? 'Agreed to get' : (x.action === 'opt_out' ? 'Stopped' : x.action)} ${x.channel} messages${x.source ? ` (${x.source})` : ''}` }));
  } catch { /* no consent rows */ }
  items.push({ at: one.view.createdAt, kind: 'added', text: `Added to Omni-Channel${one.view.source ? ` (${one.view.source})` : ''}` });
  return { contact: { id: one.view.id, name: one.view.name }, items: items.sort((a, b) => String(b.at).localeCompare(String(a.at))) };
}

// ===========================================================================
// v3 (Green Start rebuild, 2026-10-17): the DASHBOARD. Five KPI cards (Reach, Engagement, Leads, Conversions, Campaigns), the performance chart, channel health,
// recent campaigns and rule-based insights. Everything is READ from real rows, held to the campaigns / contacts this login may see, and to ?dept= when a
// workspace is picked. Plain meanings:
//   Reach        people who were REALLY sent a message in the period (Test-mode rehearsals are shown apart and never counted)
//   Engagement   messages (sent in the period) whose person clicked the apply link or replied, as a % of the messages sent
//   Leads        new contacts added in the period + new applications that came from campaigns (portal events)
//   Conversions  applications linked to a campaign (phone / email match to someone it messaged, who applied to the job after) ; "not linked" when nothing was really sent
//   Campaigns    how many this login sees, with "N live, M scheduled"
// A trend arrow is given only when BOTH periods have data. Insights are rules over the same numbers: nothing is invented.
// ===========================================================================
const prisma = require('../db');
const Cr = require('./credits');

const lc = (v) => String(v == null ? '' : v).trim().toLowerCase();
const safe = async (fn, d) => { try { return await fn(); } catch { return d; } };
const FAILED_ST = ['failed', 'bounced', 'complained', 'unknown'];
const REAL_ST = ['sent', 'delivered'];
const CH_ORDER = ['whatsapp', 'sms', 'email'];
const CH_NAME = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'Email', call: 'Voice' };
const nIn = (n) => Number(n || 0).toLocaleString('en-IN');
const round1 = (n) => Math.round(n * 10) / 10;

// ---- the dates (India days) -----------------------------------------------------------------------------------
function rangeOf(key, now = Date.now()) {
  const day = 86400000; const today = dayStart(now);
  const k = ['7d', 'year'].includes(key) ? key : '30d';
  if (k === 'year') {
    const y = new Date(now + IST).getUTCFullYear();
    const from = Date.UTC(y, 0, 1) - IST; const to = today + day;
    const prevFrom = Date.UTC(y - 1, 0, 1) - IST;
    return { key: k, label: 'This year', from, to, prevFrom, prevTo: Math.min(from, prevFrom + (to - from)), bucket: 'month' };
  }
  const n = k === '7d' ? 7 : 30;
  const from = today - (n - 1) * day;
  return { key: k, label: k === '7d' ? 'Last 7 days' : 'Last 30 days', from, to: today + day, prevFrom: from - n * day, prevTo: from, bucket: 'day' };
}

// ---- who and what this login may count ---------------------------------------------------------------------------
// dept: '' = every department the login may see; a name = that one; null = a department this login may not see (= nothing)
async function scopedCampaigns(user, dept) {
  if (dept === null || !(await S.campaignsReady())) return [];
  const rows = await Camp.visibleRows(user);
  if (!dept) return rows;
  const reqIds = [...new Set(rows.map((r) => r.requirementId).filter(Boolean))];
  const depOf = new Map();
  for (const part of chunk(reqIds, 400)) (await prisma.requirement.findMany({ where: { id: { in: part } }, select: { id: true, department: true } })).forEach((r) => depOf.set(r.id, r.department)); // eslint-disable-line no-await-in-loop
  const want = lc(dept);
  return rows.filter((r) => { const meta = S.parse(r.meta, {}) || {}; return lc(meta.department || depOf.get(r.requirementId) || '') === want; });
}
// SQL (alias c) that narrows contacts to one department: the contact's department, or a kind (industry tag) that belongs to it
async function deptCond(dept) {
  if (dept === null) return { conds: ['0 = 1'], params: [] };
  if (!dept) return { conds: [], params: [] };
  const d = lc(dept);
  const kinds = (await S.industries()).filter((i) => lc(i.department || i.name) === d).map((i) => i.name);
  const ors = ['LOWER(COALESCE(c.department, \'\')) = ?']; const ps = [d];
  if (kinds.length) { ors.push(`EXISTS (SELECT 1 FROM "OutreachContactTag" t WHERE t.contactId = c.id AND t.industry IN (${ph(kinds.length)}))`); ps.push(...kinds); }
  return { conds: [`(${ors.join(' OR ')})`], params: ps };
}
// the contacts this login may see (both kinds it may open), counted with an optional extra condition
async function countContacts(user, dept, { extra = '', params = [] } = {}) {
  if (!(await S.ready())) return 0;
  const dc = await deptCond(dept);
  let n = 0;
  for (const type of ['candidate_lead', 'internal']) {
    const sc = await K.scopeConds(user, type); // eslint-disable-line no-await-in-loop
    if (!sc) continue; // eslint-disable-line no-continue
    const where = ['c.status = \'active\'', ...sc.conds, ...dc.conds, ...(extra ? [extra] : [])].join(' AND ');
    n += S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachContact" c WHERE ${where}`, ...sc.params, ...dc.params, ...params))[0].n); // eslint-disable-line no-await-in-loop
  }
  return n;
}
const NO_CONSENT_SQL = 'EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.optIn = \'unknown\')';

// ---- the messages of a set of campaigns in a window --------------------------------------------------------------
// one row per message: its time (sent, else failed, else queued), channel, status, clicked (k) and replied (r: the message's repliedAt, or a 'replied' event)
async function fetchMsgs(ids, from, to) {
  const out = [];
  for (const part of chunk(ids, 400)) {
    if (!part.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const rows = await S.q(`SELECT m.id id, m.campaignId cid, m.contactId c, m.channel ch, m.status st, COALESCE(m.sentAt, m.failedAt, m.queuedAt) at,
      CASE WHEN m.firstClickAt IS NOT NULL THEN 1 ELSE 0 END k,
      CASE WHEN (m.repliedAt IS NOT NULL OR EXISTS (SELECT 1 FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = 'replied')) THEN 1 ELSE 0 END r
      FROM "OutreachMessage" m WHERE m.campaignId IN (${ph(part.length)}) AND m.status IN ('sent','delivered','test_captured','failed','bounced','complained','unknown')
      AND COALESCE(m.sentAt, m.failedAt, m.queuedAt) >= ? AND COALESCE(m.sentAt, m.failedAt, m.queuedAt) < ?`, ...part, from, to);
    rows.forEach((r) => out.push({ id: r.id, cid: r.cid, c: r.c, ch: r.ch, st: r.st, at: S.num(r.at), k: S.num(r.k), r: S.num(r.r) }));
  }
  return out;
}
function tally(rows) {
  const t = { sent: 0, delivered: 0, failed: 0, rehearsed: 0, clicks: 0, replies: 0, engaged: 0 }; const people = new Set();
  rows.forEach((m) => {
    if (REAL_ST.includes(m.st)) { t.sent += 1; people.add(m.c); if (m.st === 'delivered') t.delivered += 1; if (m.k) t.clicks += 1; if (m.r) t.replies += 1; if (m.k || m.r) t.engaged += 1; }
    else if (m.st === 'test_captured') t.rehearsed += 1;
    else t.failed += 1;
  });
  return { ...t, people: people.size, engagePct: t.sent ? round1((t.engaged / t.sent) * 100) : null };
}
const within = (rows, a, b) => rows.filter((m) => m.at >= a && m.at < b);

// ---- trend arrows: only when BOTH periods have data -----------------------------------------------------------------
function trendOf(cur, prev, hasCur, hasPrev, pts) {
  if (!hasCur || !hasPrev) return null;
  if (pts) { const d = round1(cur - prev); return { dir: d > 0 ? 'up' : (d < 0 ? 'down' : 'flat'), text: `${Math.abs(d)} pts` }; }
  if (!(prev > 0)) return null;
  const p = round1(((cur - prev) / prev) * 100);
  return { dir: p > 0 ? 'up' : (p < 0 ? 'down' : 'flat'), text: `${Math.abs(p)}%` };
}
const trendWords = (t, tail) => (t ? `${t.dir === 'up' ? '↑' : (t.dir === 'down' ? '↓' : '→')} ${t.text} ${tail}` : '');

// ---- the channel strip: is each way connected? ---------------------------------------------------------------------------
async function channelStates() {
  const out = { whatsapp: { connected: false, why: 'Not connected' }, sms: { connected: false, why: 'Not connected' }, email: { connected: false, why: 'Not connected' }, call: { connected: false, why: 'Not connected', phoneLink: true } };
  await safe(async () => {
    const st = await require('../utils/messaging').channelStatus(); // eslint-disable-line global-require
    out.whatsapp = { connected: !!st.WhatsApp.configured, why: st.WhatsApp.configured ? (st.WhatsApp.detail || 'Connected') : (st.WhatsApp.reason || 'Not connected') };
    out.sms = { connected: !!st.SMS.configured, why: st.SMS.configured ? (st.SMS.detail || 'Connected') : (st.SMS.reason || 'Not connected') };
    out.email = { connected: !!st.Email.configured, why: st.Email.configured ? (st.Email.detail || 'Connected') : (st.Email.reason || 'Not connected') };
  }, null);
  await safe(async () => {
    const gw = await require('../utils/callGateway').callConfig(); // eslint-disable-line global-require
    out.call = { connected: !!gw.configured, why: gw.configured ? 'Calling through TeamLink' : 'Not connected: calls use the phone link (your own phone dials, then you save how it went)', phoneLink: !gw.configured };
  }, null);
  return out;
}

// ---- dismissed insights (a person may hide one for 7 days) -------------------------------------------------------------
let dismissOk = false;
async function ensureDismiss() {
  if (dismissOk) return;
  await S.run('CREATE TABLE IF NOT EXISTS "OmniInsightDismiss" ("userId" TEXT NOT NULL, "key" TEXT NOT NULL, "until" INTEGER NOT NULL DEFAULT 0, "at" INTEGER NOT NULL DEFAULT 0, PRIMARY KEY ("userId", "key"))');
  dismissOk = true;
}
async function dismissInsight(user, key) {
  const k = S.clip(key, 60);
  if (!/^[a-z0-9_-]{2,60}$/i.test(k)) return { error: 'This insight was not found.', status: 404 };
  await ensureDismiss();
  const until = Date.now() + 7 * 86400000;
  await S.run('INSERT INTO "OmniInsightDismiss" (userId, key, until, at) VALUES (?,?,?,?) ON CONFLICT(userId, key) DO UPDATE SET until = excluded.until, at = excluded.at', user.id, k, until, Date.now());
  return { ok: 'Hidden for 7 days.', until: S.iso(until) };
}

// ---- the dashboard -------------------------------------------------------------------------------------------------------
async function command(user, { range = '30d', dept = '' } = {}) {
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const T = require('./templates'); // eslint-disable-line global-require
  const Ins = require('./insights'); // eslint-disable-line global-require
  const now = Date.now();
  const rg = rangeOf(range, now);
  const ready = await S.ready();
  const st = await safe(() => S.settings(), { emailTestMode: true, master: false });
  const camps = await safe(() => scopedCampaigns(user, dept), []);
  const ids = camps.map((c) => c.id);
  const nameOf = Object.fromEntries(camps.map((c) => [c.id, c.name]));
  const fetchFrom = Math.min(rg.prevFrom, dayStart(now) - 29 * 86400000);
  const msgs = await safe(() => fetchMsgs(ids, fetchFrom, rg.to), []);
  const curMsgs = within(msgs, rg.from, rg.to); const prevMsgs = within(msgs, rg.prevFrom, rg.prevTo);
  const cur = tally(curMsgs); const prev = tally(prevMsgs);

  // leads: new contacts + new applications that came from campaigns
  const newContacts = await safe(() => countContacts(user, dept, { extra: 'c.createdAt >= ? AND c.createdAt < ?', params: [rg.from, rg.to] }), 0);
  const prevContacts = await safe(() => countContacts(user, dept, { extra: 'c.createdAt >= ? AND c.createdAt < ?', params: [rg.prevFrom, rg.prevTo] }), 0);
  const importedContacts = await safe(() => countContacts(user, dept, { extra: 'c.importId IS NOT NULL AND c.createdAt >= ? AND c.createdAt < ?', params: [rg.from, rg.to] }), 0);
  const appliedEvents = async (a, b) => {
    let n = 0;
    for (const part of chunk(ids, 400)) n += S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachEvent" WHERE type = 'applied' AND campaignId IN (${ph(part.length)}) AND occurredAt >= ? AND occurredAt < ?`, ...part, a, b))[0].n); // eslint-disable-line no-await-in-loop
    return n;
  };
  const apps = await safe(() => appliedEvents(rg.from, rg.to), 0); const prevApps = await safe(() => appliedEvents(rg.prevFrom, rg.prevTo), 0);
  const leads = newContacts + apps; const prevLeads = prevContacts + prevApps;

  // conversions: linked applications -> interviews -> offers -> joined (windows by application date)
  const linkNow = await safe(() => Ins.linkApplications(camps, { from: rg.from, to: rg.to }), { linkable: 0, applied: 0, interviews: 0, offers: 0, joined: 0, byCampaign: {} });
  const linkPrev = await safe(() => Ins.linkApplications(camps, { from: rg.prevFrom, to: rg.prevTo }), { linkable: 0, applied: 0 });
  const linkable = linkNow.linkable > 0;

  // campaigns by status
  const by = (list) => camps.filter((c) => list.includes(c.status)).length;
  const counts = { total: camps.length, live: by(['running', 'preparing']), scheduled: by(['scheduled']), paused: by(['paused']), notSent: by(['draft']), completed: by(['done', 'stopped']) };

  const kpis = {
    reach: { value: cur.people, hasData: cur.sent > 0, trend: trendOf(cur.people, prev.people, cur.sent > 0, prev.sent > 0, false), sub: cur.rehearsed ? `${nIn(cur.rehearsed)} rehearsed in Test mode (not counted)` : 'People really sent a message' },
    engagement: { value: cur.engagePct, hasData: cur.sent > 0, trend: trendOf(cur.engagePct, prev.engagePct, cur.sent > 0, prev.sent > 0, true), sub: `${nIn(cur.engaged)} of ${nIn(cur.sent)} messages got a click or a reply` },
    leads: { value: leads, hasData: leads > 0, trend: trendOf(leads, prevLeads, leads > 0, prevLeads > 0, false), sub: `${nIn(newContacts)} new contacts · ${nIn(apps)} applications from campaigns` },
    conversions: { value: linkable ? linkNow.applied : null, hasData: linkable, trend: linkable ? trendOf(linkNow.applied, linkPrev.applied, true, linkPrev.linkable > 0 && linkPrev.applied > 0, false) : null, sub: linkable ? `${nIn(linkNow.interviews)} interviews · ${nIn(linkNow.offers)} offers · ${nIn(linkNow.joined)} joined` : 'Not linked: no job message was really sent yet' },
    campaigns: { value: counts.total, hasData: counts.total > 0, trend: null, sub: `${counts.live} live · ${counts.scheduled} scheduled` },
  };

  // the chart: reach (people) and engagement (messages with a click or a reply) by the day / month the message was sent
  const series = [];
  const keyOf = (ms) => new Date(ms + IST).toISOString().slice(0, rg.bucket === 'month' ? 7 : 10);
  const slots = new Map();
  if (rg.bucket === 'month') {
    const y = new Date(rg.from + IST).getUTCFullYear(); const lastM = new Date(rg.to - 1 + IST).getUTCMonth();
    for (let m = 0; m <= lastM; m += 1) slots.set(`${y}-${String(m + 1).padStart(2, '0')}`, { label: new Date(Date.UTC(y, m, 1)).toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' }), reach: new Set(), engagement: 0 });
  } else {
    for (let t = rg.from; t < rg.to; t += 86400000) { const d = new Date(t + IST); slots.set(keyOf(t), { label: `${d.getUTCDate()} ${d.toLocaleString('en-IN', { month: 'short', timeZone: 'UTC' })}`, reach: new Set(), engagement: 0 }); }
  }
  curMsgs.filter((m) => REAL_ST.includes(m.st)).forEach((m) => { const s = slots.get(keyOf(m.at)); if (!s) return; s.reach.add(m.c); if (m.k || m.r) s.engagement += 1; });
  slots.forEach((s, key) => series.push({ key, label: s.label, reach: s.reach.size, engagement: s.engagement }));

  // channel health
  const states = await channelStates();
  const camById = Object.fromEntries(camps.map((c) => [c.id, c]));
  const channels = [];
  const calls = await safe(() => Ins.callsLogged(user, rg.from, rg.to - 1, dept), 0);
  const chStats = {};
  CH_ORDER.forEach((ch) => { chStats[ch] = tally(curMsgs.filter((m) => m.ch === ch)); });
  const withData = CH_ORDER.filter((ch) => chStats[ch].sent >= 5);
  const bestCh = withData.length >= 2 ? withData.slice().sort((a, b) => chStats[b].engagePct - chStats[a].engagePct)[0] : null;
  const failWhy = {};
  const badRows = curMsgs.filter((m) => FAILED_ST.includes(m.st));
  for (const ch of CH_ORDER) {
    const ofCh = badRows.filter((m) => m.ch === ch);
    if (!ofCh.length) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const top = await safe(async () => (await S.q(`SELECT reason, SUBSTR(COALESCE(error, ''), 1, 60) err, COUNT(*) n FROM "OutreachMessage" WHERE id IN (${ph(Math.min(ofCh.length, 900))}) GROUP BY reason, err ORDER BY n DESC LIMIT 1`, ...ofCh.slice(0, 900).map((m) => m.id)))[0], null);
    if (top) failWhy[ch] = top.reason ? (Sup.REASON_WORDS[top.reason] || top.reason) : (top.err || 'The provider did not accept it');
  }
  const topCampaign = (ch) => { const c = {}; curMsgs.filter((m) => m.ch === ch && REAL_ST.includes(m.st)).forEach((m) => { c[m.cid] = (c[m.cid] || 0) + 1; }); const best = Object.entries(c).sort((a, b) => b[1] - a[1])[0]; return best ? { name: nameOf[best[0]] || 'Campaign', sent: best[1], id: best[0] } : null; };
  for (const ch of ['whatsapp', 'sms', 'email', 'call']) {
    const s = states[ch];
    if (ch === 'call') {
      channels.push({ id: 'call', name: 'Voice', short: 'VO', connected: s.connected, state: s.connected ? 'connected' : 'phone', stateWords: s.connected ? 'Connected' : 'Phone link', why: s.why, sent: calls, delivered: null, failed: 0, engagePct: null, calls: true, topCampaign: null, tip: calls ? `${nIn(calls)} calls were logged in this period.` : 'No calls were logged in this period.' });
      continue; // eslint-disable-line no-continue
    }
    const t = chStats[ch];
    const failRate = t.sent + t.failed >= 10 ? t.failed / (t.sent + t.failed) : 0;
    let state = 'connected'; let stateWords = 'Connected';
    if (!s.connected) { state = 'off'; stateWords = 'Not connected'; } else if (failRate >= 0.2) { state = 'warn'; stateWords = 'Check delivery'; } else if (st.emailTestMode) { state = 'test'; stateWords = 'Connected · Test mode'; }
    let tip;
    if (t.failed > 0) tip = `${nIn(t.failed)} ${CH_NAME[ch]} message${t.failed === 1 ? '' : 's'} failed in this period${failWhy[ch] ? `. Most common reason: ${failWhy[ch]}` : ''}. Open Analytics to see why.`;
    else if (!t.sent) tip = t.rehearsed ? `Nothing was really sent on ${CH_NAME[ch]} (${nIn(t.rehearsed)} rehearsed in Test mode).` : `Nothing was sent on ${CH_NAME[ch]} in this period.`;
    else if (bestCh === ch) tip = `${CH_NAME[ch]} has the best engagement of your ways (${t.engagePct}%).`;
    else tip = `${t.engagePct}% of the people who got a ${CH_NAME[ch]} message clicked or replied.`;
    channels.push({ id: ch, name: CH_NAME[ch], short: { whatsapp: 'WA', sms: 'SMS', email: '@' }[ch], connected: s.connected, state, stateWords, why: s.why, sent: t.sent, delivered: t.delivered, deliveredPct: t.sent ? round1((t.delivered / t.sent) * 100) : null, failed: t.failed, rehearsed: t.rehearsed, engaged: t.engaged, clicks: t.clicks, replies: t.replies, engagePct: t.engagePct, topCampaign: topCampaign(ch), failWhy: failWhy[ch] || null, tip });
  }

  // recent campaigns (the six newest this login sees)
  const recentRows = camps.slice(0, 6);
  const recentMsgs = await safe(() => fetchMsgs(recentRows.map((c) => c.id), 0, now + 86400000), []);
  const recentLink = await safe(() => Ins.linkApplications(recentRows, {}), { byCampaign: {} });
  const recent = recentRows.map((c) => {
    const t = tally(recentMsgs.filter((m) => m.cid === c.id)); const l = recentLink.byCampaign[c.id];
    return { id: c.id, name: c.name, channel: c.channel, channelName: CH_NAME[c.channel] || c.channel, status: c.status, statusWords: Camp.STATUS_WORDS[c.status] || c.status, rehearsal: c.mode === 'rehearsal', sent: t.sent, engagePct: t.sent ? t.engagePct : null, conversion: l ? l.applied : null, conversionNote: l ? '' : (c.mode === 'rehearsal' ? 'Rehearsal' : (['draft', 'scheduled', 'preparing'].includes(c.status) ? '' : 'not linked')) };
  });

  // insights
  const insights = [];
  const t30 = tally(within(msgs, dayStart(now) - 29 * 86400000, now + 86400000));
  const totalContacts = await safe(() => countContacts(user, dept), 0);
  const noConsent = await safe(() => countContacts(user, dept, { extra: NO_CONSENT_SQL }), 0);
  const tpl = await safe(async () => { let list = []; for (const type of ['candidate_lead', 'internal']) list = list.concat(await T.list(user, { type })); return list.filter((x) => x.channel === 'whatsapp'); }, []); // eslint-disable-line no-await-in-loop
  const pendingWa = tpl.filter((x) => x.waApprovalStatus === 'pending').length;
  const unread = await safe(async () => (await require('../utils/conversations').unreadCount(user)).conversations || 0, 0); // eslint-disable-line global-require
  const add = (o) => insights.push({ score: 50, tag: 'Now', ...o });
  if (noConsent > 0) add({ key: 'no-consent', title: `${nIn(noConsent)} contact${noConsent === 1 ? ' has' : 's have'} no consent yet`, tag: 'Now', text: `${nIn(noConsent)} contact${noConsent === 1 ? ' has' : 's have'} no consent yet, so they cannot be messaged.`, body: `${nIn(noConsent)} of your ${nIn(totalContacts)} contacts have no permission recorded on at least one way (WhatsApp, SMS or Email). The system will not send to a person until their permission is recorded. Open the contacts, filter by "no permission yet", and ask an Admin to record the permission you collected.`, score: totalContacts ? Math.round((noConsent / totalContacts) * 100) : 50, action: { label: 'Open contacts', page: 'customers' } });
  if (pendingWa > 0) add({ key: 'wa-pending', title: `${pendingWa} WhatsApp template${pendingWa === 1 ? ' waits' : 's wait'} for approval`, tag: 'Now', text: `${pendingWa} WhatsApp template${pendingWa === 1 ? ' waits' : 's wait'} for approval from WhatsApp, so campaigns that use ${pendingWa === 1 ? 'it' : 'them'} cannot start.`, body: 'WhatsApp must approve every promotional template before it can be used in a campaign. Check the status in Manage Templates and record the result when WhatsApp answers.', score: tpl.length ? Math.round((pendingWa / tpl.length) * 100) : 50, action: { label: 'Open templates', page: 'templates' } });
  if (t30.failed > 0) add({ key: 'failed', title: `${nIn(t30.failed)} message${t30.failed === 1 ? '' : 's'} failed: see why`, tag: 'Alert', text: `${nIn(t30.failed)} message${t30.failed === 1 ? '' : 's'} failed in the last 30 days. Open Analytics to see the reasons.`, body: `${nIn(t30.failed)} message${t30.failed === 1 ? '' : 's'} could not be sent in the last 30 days (${nIn(t30.sent)} went out). Analytics lists the most common reasons in plain words, for example an address that does not exist or a provider that refused it.`, score: t30.sent + t30.failed ? Math.round((t30.failed / (t30.sent + t30.failed)) * 100) : 50, action: { label: 'See the reasons', page: 'analytics' } });
  if (unread > 0) add({ key: 'replies-waiting', title: `${unread} repl${unread === 1 ? 'y is' : 'ies are'} waiting`, tag: 'Now', text: `${unread} conversation${unread === 1 ? ' has' : 's have'} a reply nobody has read yet.`, body: 'People who answer a message land in the Inbox. A quick answer keeps them interested, so read the new replies first.', score: Math.min(100, unread * 20), action: { label: 'Open the inbox', page: 'inbox' } });
  const clicked30 = t30.clicks; const stalled = linkable && camps.length ? Math.max(0, clicked30 - (linkNow.applied || 0)) : 0;
  if (linkable && stalled > 0 && rg.key === '30d') add({ key: 'clicked-not-applied', title: 'Follow up the people who opened the link', tag: 'New', text: `${nIn(stalled)} messages were opened (link tapped) but no application is linked to them.`, body: `${nIn(stalled)} people tapped the apply link in the last 30 days, but no application from them is linked to a campaign. A short follow-up message to them, set up as an automation, often brings some of them back.`, score: clicked30 ? Math.round((stalled / clicked30) * 100) : 50, action: { label: 'Open automations', page: 'automation' } });
  if (bestCh) add({ key: 'best-channel', title: `${CH_NAME[bestCh]} is working best`, tag: 'Tip', text: `${CH_NAME[bestCh]} gets the most clicks and replies: ${chStats[bestCh].engagePct}% of messages.`, body: `In this period ${CH_NAME[bestCh]} had ${chStats[bestCh].engagePct}% engagement against ${withData.filter((c) => c !== bestCh).map((c) => `${CH_NAME[c]} ${chStats[c].engagePct}%`).join(' and ')}. Consider using it first for your next campaign.`, score: Math.round(chStats[bestCh].engagePct), action: { label: 'Open analytics', page: 'analytics' } });
  if (counts.notSent > 0) add({ key: 'not-sent', title: `${counts.notSent} campaign${counts.notSent === 1 ? ' is' : 's are'} not sent yet`, tag: 'Tip', text: `${counts.notSent} campaign${counts.notSent === 1 ? ' is' : 's are'} ready to finish and send.`, body: 'These campaigns were started but never sent. Open Campaigns to finish them, or remove the ones you do not need.', score: counts.total ? Math.round((counts.notSent / counts.total) * 100) : 50, action: { label: 'Open campaigns', page: 'campaigns' } });
  if (A.isAdmin(user) && st.emailTestMode) add({ key: 'test-mode', title: 'Test mode is ON', tag: 'Tip', text: 'Nothing really goes out: every campaign is only rehearsed.', body: 'Test mode is the safe default. Campaigns are made and logged but no real email, WhatsApp or SMS is handed to a provider. Switch it off in Settings only when you are ready to send for real.', score: 100, action: { label: 'Open settings', page: 'settings' } });
  if (A.isAdmin(user) && !st.master) add({ key: 'sending-off', title: 'Sending is switched OFF', tag: 'Tip', text: 'The sending switch is off, so no campaign can start.', body: 'The "Outreach sending" switch is off. Campaigns can be made and checked but will not start until an Admin switches sending on in Settings.', score: 100, action: { label: 'Open settings', page: 'settings' } });
  const cred = await safe(async () => { const c = await Cr.settings(); const p = await Cr.personOf(user.id); if (Cr.isExempt(c, p)) return null; const allowance = await Cr.allowanceOf(c, user.id); const used = await Cr.usedBy(user.id, Cr.thisMonth()); return { allowance, used }; }, null);
  if (cred && cred.allowance > 0 && cred.used >= cred.allowance * 0.8) add({ key: 'credits-low', title: `Only ${Math.max(0, cred.allowance - cred.used)} credits left this month`, tag: 'Alert', text: `You used ${cred.used} of your ${cred.allowance} credits this month.`, body: `Each message costs credits. You have used ${cred.used} of the ${cred.allowance} credits given to you this month. Ask an Admin for more before you start a big campaign.`, score: Math.min(100, Math.round((cred.used / cred.allowance) * 100)), action: { label: 'Open billing', page: 'billing' } });
  await safe(ensureDismiss, null);
  const hidden = new Set((await safe(() => S.q('SELECT key FROM "OmniInsightDismiss" WHERE userId = ? AND until > ?', user.id, now), [])).map((r) => r.key));
  const shown = insights.filter((i) => !hidden.has(i.key)).sort((a, b) => b.score - a.score).slice(0, 6);

  // the popups (KPI details)
  const share = (n, tot) => (tot > 0 ? Math.round((n / tot) * 100) : 0);
  const peopleBy = (ch) => new Set(curMsgs.filter((m) => m.ch === ch && REAL_ST.includes(m.st)).map((m) => m.c)).size;
  const details = {
    reach: { title: 'Reach', subtitle: `${nIn(cur.people)} ${cur.people === 1 ? 'person' : 'people'} were sent a message${kpis.reach.trend ? ` · ${trendWords(kpis.reach.trend, 'vs last period')}` : ''}`, note: 'Reach counts the people who were really sent at least one message in this period, on any way. A person messaged on two ways counts once in the total. Test-mode rehearsals are not counted.', rows: CH_ORDER.map((ch) => ({ label: CH_NAME[ch], value: nIn(peopleBy(ch)), pct: share(peopleBy(ch), cur.people) })) },
    engagement: { title: 'Engagement', subtitle: `${cur.engagePct === null ? 'No messages were sent' : `${cur.engagePct}% of messages got a click or a reply`}${kpis.engagement.trend ? ` · ${trendWords(kpis.engagement.trend, 'vs last period')}` : ''}`, note: 'Engagement = messages whose person tapped the apply link or replied, divided by the messages really sent. A message with both counts once.', rows: [...CH_ORDER.map((ch) => ({ label: CH_NAME[ch], value: chStats[ch].engagePct === null ? '—' : `${chStats[ch].engagePct}%`, pct: chStats[ch].engagePct || 0 })), { label: 'Link taps', value: nIn(cur.clicks), pct: share(cur.clicks, cur.sent) }, { label: 'Replies', value: nIn(cur.replies), pct: share(cur.replies, cur.sent) }] },
    leads: { title: 'Leads', subtitle: `${nIn(leads)} new lead${leads === 1 ? '' : 's'} in this period${kpis.leads.trend ? ` · ${trendWords(kpis.leads.trend, 'vs last period')}` : ''}`, note: 'Leads = new contacts added in this period plus new applications that came from campaigns. Contacts are counted once; they are not matched against the ATS.', rows: [{ label: 'Imported from a file', value: nIn(importedContacts), pct: share(importedContacts, leads) }, { label: 'Added another way', value: nIn(Math.max(0, newContacts - importedContacts)), pct: share(Math.max(0, newContacts - importedContacts), leads) }, { label: 'Applied from a campaign', value: nIn(apps), pct: share(apps, leads) }] },
    conversions: { title: 'Conversions', subtitle: linkable ? `${nIn(linkNow.applied)} application${linkNow.applied === 1 ? '' : 's'} linked to campaigns${kpis.conversions.trend ? ` · ${trendWords(kpis.conversions.trend, 'vs last period')}` : ''}` : 'Not linked yet', note: linkable ? 'A conversion is a person a campaign really messaged who then applied to that campaign\'s own job (matched by phone or email), and how far they went. Anything that cannot be matched is not counted.' : 'No job campaign has really sent a message in this period (a Test-mode rehearsal links nothing), so applications cannot be linked to campaigns.', rows: linkable ? [{ label: 'Applied', value: nIn(linkNow.applied), pct: 100 }, { label: 'Interview', value: nIn(linkNow.interviews), pct: share(linkNow.interviews, linkNow.applied) }, { label: 'Offer', value: nIn(linkNow.offers), pct: share(linkNow.offers, linkNow.applied) }, { label: 'Joined', value: nIn(linkNow.joined), pct: share(linkNow.joined, linkNow.applied) }] : [] },
    campaigns: { title: 'Campaigns', subtitle: `${counts.total} campaign${counts.total === 1 ? '' : 's'} in this workspace`, note: 'Every campaign you are allowed to see, on every way and in every status.', rows: [['Live', counts.live], ['Scheduled', counts.scheduled], ['Paused', counts.paused], ['Not sent yet', counts.notSent], ['Completed', counts.completed]].map(([label, n]) => ({ label, value: nIn(n), pct: share(n, counts.total) })) },
  };

  return {
    ready, range: { key: rg.key, label: rg.label, from: S.iso(rg.from), to: S.iso(rg.to - 1), bucket: rg.bucket }, dept: dept || '', testMode: !!st.emailTestMode, sendingOn: !!st.master,
    kpis, series, channels, recent, insights: shown, details, counts, rehearsed: cur.rehearsed,
    notes: ['Reach and Engagement count only messages that were REALLY sent. Test-mode rehearsals are never counted.', 'The chart groups messages by the day (or month) they were sent.'],
  };
}

// the numbers behind the "Responses" popup on a campaign page (real: how many wrote back, tapped the link, applied)
async function responsesFor(user, campaignId) {
  const f = await Camp.get(user, campaignId);
  if (f.error) return f;
  await require('./v3schema').ensure(); // eslint-disable-line global-require
  const msgs = await fetchMsgs([campaignId], 0, Date.now() + 86400000);
  const t = tally(msgs);
  const applied = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachEvent" WHERE type = \'applied\' AND campaignId = ?', campaignId))[0].n);
  return { campaign: { id: f.campaign.id, name: f.campaign.name }, total: t.replies, sent: t.sent, clicks: t.clicks, applied, rows: [{ label: 'Wrote back', value: t.replies }, { label: 'Tapped the apply link', value: t.clicks }, { label: 'Applied from the campaign', value: applied }] };
}

module.exports = { overview, reports, reportCsv, timeline, rangeOf, scopedCampaigns, deptCond, countContacts, NO_CONSENT_SQL, fetchMsgs, tally, channelStates, command, responsesFor, dismissInsight };
