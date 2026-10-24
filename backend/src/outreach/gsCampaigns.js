// ---------------------------------------------------------------------------
// OMNI-CHANNEL > CAMPAIGNS (the Green Start prototype's "All Campaigns", the Create-campaign wizard, the campaign command center, analytics and the live message
// logs), built on the ONE campaign engine (campaigns.js / runner.js / suppress.js). The prototype publishes ONE master campaign to several channels: here that is a
// GROUP of campaign rows (one OutreachCampaign per channel) sharing meta.groupId. The list shows ONE row per group with channels[] and added-up numbers.
//   key      the groupId (or the id of a single campaign made before groups existed). Every function takes the key OR the id of any row of the group.
//   status   one word for the whole group: live | scheduled | notsent | completed | stopped | paused | approval (Waiting for approval) | changes (Changes needed).
//            NEVER the word "Draft". A campaign that has not gone out says "Not sent yet".
//   numbers  sent (ok) / failed / delivered / read (when a provider told us) / replied / clicked / applied, from OutreachMessage and OutreachEvent only.
//            A rehearsal (Test mode) shows its numbers WITH the word rehearsal: nothing was really sent.
// Who sees what is decided by the engine (campaigns.canSee): a login sees the campaigns of the jobs in its own area (an Admin all); a department picked in the top bar
// narrows the list further. Phone / email are masked for the masked roles (access.masked) everywhere here. Audit rows carry ids and counts only.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const Sup = require('./suppress');
const G = require('./segments');
const T = require('./templates');
const Camp = require('./campaigns');
const Appr = require('./approval');
const Act = require('./campaignActivity');
const MLog = require('./messageLog');
const Health = require('./health');
const Quiet = require('./quiet');
const adapters = require('./adapters');
const Cr = require('./credits');
const core = require('../utils/messagingCore');
const { logAudit } = require('../utils/audit');

const CH_ORDER = ['whatsapp', 'sms', 'email', 'call'];
const CH_WORDS = Camp.CH_WORDS;
const CH_CODE = { whatsapp: 'WH', sms: 'SM', email: 'EM', call: 'VO' };
const chOrder = (c) => CH_ORDER.indexOf(c);
const chanOf = Sup.chanOf;
const metaOf = Camp.metaOf;
const ph = (n) => new Array(n).fill('?').join(',');
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const IST = 5.5 * 3600 * 1000;
const istText = (ms) => (ms ? new Date(ms + IST).toISOString().replace('T', ' ').slice(0, 16) : '');

// the objectives of the wizard: the prototype's plus our staffing ones. Every one except a staff message is about ONE open job (the table rule: a job promotion names its job).
const OBJECTIVES = [
  { id: 'recruitment', label: 'Recruitment', kind: 'recruitment', type: 'job_promotion' },
  { id: 'job_promotion', label: 'Job promotion', kind: 'job_promotion', type: 'job_promotion' },
  { id: 'client', label: 'Client', kind: 'client', type: 'job_promotion' },
  { id: 'referral', label: 'Referral', kind: 'referral', type: 'job_promotion' },
  { id: 'sales', label: 'Sales', kind: null, type: 'job_promotion' },
  { id: 'lead_generation', label: 'Lead generation', kind: null, type: 'job_promotion' },
  { id: 'awareness', label: 'Awareness', kind: null, type: 'job_promotion' },
  { id: 'retention', label: 'Retention', kind: null, type: 'job_promotion' },
  { id: 'engagement', label: 'Engagement', kind: null, type: 'job_promotion' },
  { id: 'staff', label: 'Staff message (internal)', kind: null, type: 'internal' },
];
const objectiveOf = (v) => OBJECTIVES.find((o) => o.id === v || o.label === v) || null;

const STATUS = {
  live: ['live', 'Live'], scheduled: ['scheduled', 'Scheduled'], notsent: ['draft', 'Not sent yet'], completed: ['warn', 'Completed'], stopped: ['draft', 'Stopped'],
  paused: ['warn', 'Paused'], approval: ['warn', 'Waiting for approval'], changes: ['red', 'Changes needed'],
};
// the one word for a group
function groupStatus(rows) {
  const sts = rows.map((r) => r.status);
  const ap = rows[0].approval || null;
  if (sts.every((s) => s === 'draft')) return ap === 'waiting' ? 'approval' : (ap === 'changes' ? 'changes' : 'notsent');
  if (sts.some((s) => s === 'running' || s === 'preparing')) return 'live';
  if (sts.some((s) => s === 'scheduled')) return 'scheduled';
  if (sts.some((s) => s === 'paused')) return 'paused';
  if (sts.every((s) => s === 'stopped' || s === 'draft')) return sts.some((s) => s === 'stopped') ? 'stopped' : 'notsent';
  return 'completed';
}
const TAB_OF = { live: 'live', scheduled: 'scheduled', notsent: 'notsent', changes: 'notsent', completed: 'completed', stopped: 'completed', paused: 'paused', approval: 'approval' };

// ---- numbers --------------------------------------------------------------------------------------------------------------------
const zero = () => ({ total: 0, waiting: 0, ok: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, rehearsed: 0, replied: 0, clicked: 0, applied: 0, qualified: 0, engaged: 0, called: 0, noAnswer: 0, toCall: 0, callMinutes: 0 });
async function metricsFor(ids) {
  await require('./v3schema').ensure();
  const out = {}; ids.forEach((id) => { out[id] = zero(); });
  for (const part of chunk(ids, 400)) {
    const rows = await S.q(`SELECT campaignId, channel, status, COUNT(*) n, SUM(CASE WHEN readAt IS NOT NULL THEN 1 ELSE 0 END) rd, SUM(CASE WHEN repliedAt IS NOT NULL THEN 1 ELSE 0 END) rp, SUM(CASE WHEN firstClickAt IS NOT NULL THEN 1 ELSE 0 END) ck, COALESCE(SUM(callMinutes),0) cm FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) GROUP BY campaignId, channel, status`, ...part); // eslint-disable-line no-await-in-loop
    rows.forEach((r) => {
      const m = out[r.campaignId]; const n = S.num(r.n);
      if (r.channel === 'call') {
        m.total += r.status === 'skipped' || r.status === 'cancelled' ? 0 : n;
        if (r.status === 'queued') { m.toCall += n; m.waiting += n; } else if (r.status === 'sent') { m.called += n; m.ok += n; m.callMinutes += S.num(r.cm); } else if (r.status === 'failed') { m.noAnswer += n; m.failed += n; } else if (r.status === 'skipped') m.skipped += n; else if (r.status === 'cancelled') m.cancelled += n;
        return;
      }
      if (['queued', 'sending'].includes(r.status)) { m.waiting += n; m.total += n; }
      if (['sent', 'test_captured', 'delivered'].includes(r.status)) { m.ok += n; m.total += n; }
      if (r.status === 'delivered') m.delivered += n;
      if (r.status === 'test_captured') m.rehearsed += n;
      if (['failed', 'bounced', 'complained', 'unknown'].includes(r.status)) { m.failed += n; m.total += n; }
      if (r.status === 'skipped') m.skipped += n;
      if (r.status === 'cancelled') m.cancelled += n;
      m.read += S.num(r.rd); m.replied += S.num(r.rp); m.clicked += S.num(r.ck);
    });
    const ev = await S.q(`SELECT campaignId, type, COUNT(*) n FROM "OutreachEvent" WHERE campaignId IN (${ph(part.length)}) AND type IN ('applied','qualified','replied') GROUP BY campaignId, type`, ...part); // eslint-disable-line no-await-in-loop
    ev.forEach((r) => { const m = out[r.campaignId]; if (r.type === 'applied') m.applied = S.num(r.n); else if (r.type === 'qualified') m.qualified = S.num(r.n); else if (r.type === 'replied') m.replied = Math.max(m.replied, S.num(r.n)); });
    const en = await S.q(`SELECT campaignId, COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) AND channel <> 'call' AND (readAt IS NOT NULL OR repliedAt IS NOT NULL OR firstClickAt IS NOT NULL) GROUP BY campaignId`, ...part); // eslint-disable-line no-await-in-loop
    en.forEach((r) => { out[r.campaignId].engaged = S.num(r.n); });
  }
  return out;
}
const sumM = (list) => list.reduce((a, m) => { Object.keys(a).forEach((k) => { a[k] += m[k] || 0; }); return a; }, zero());
const pct1 = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

// ---- loading the groups a login may see -------------------------------------------------------------------------------------------
const deptOfRow = (r, reqs) => String(metaOf(r).department || (reqs.get(r.requirementId) || {}).department || '').trim();
async function loadGroups(user, dept) {
  await Camp.ensureKind();
  if (dept === null) return { groups: [], reqs: new Map() }; // a department this login may not see: nothing
  const rows = await S.q('SELECT * FROM "OutreachCampaign" ORDER BY createdAt DESC, id DESC');
  const reqs = await Camp.reqRows(rows.map((r) => r.requirementId));
  let vis = rows.filter((r) => Camp.canSee(user, r, reqs));
  if (dept) vis = vis.filter((r) => deptOfRow(r, reqs).toLowerCase() === String(dept).toLowerCase());
  const map = new Map();
  vis.forEach((r) => { const key = metaOf(r).groupId || r.id; if (!map.has(key)) map.set(key, { key, rows: [] }); map.get(key).rows.push(r); });
  const groups = [...map.values()].map((g) => ({ ...g, rows: g.rows.sort((a, b) => chOrder(chanOf(a)) - chOrder(chanOf(b)) || String(a.id).localeCompare(String(b.id))) }));
  return { groups, reqs };
}
async function loadOne(user, key) {
  const rows = await Camp.groupRows(key);
  if (!rows.length) return { error: 'This campaign was not found.', status: 404 };
  const reqs = await Camp.reqRows(rows.map((r) => r.requirementId));
  const vis = rows.filter((r) => Camp.canSee(user, r, reqs));
  if (!vis.length) return { error: 'This campaign was not found.', status: 404 };
  const gid = metaOf(vis[0]).groupId || vis[0].id;
  return { group: { key: gid, rows: vis.sort((a, b) => chOrder(chanOf(a)) - chOrder(chanOf(b))) }, reqs };
}

const groupName = (g) => metaOf(g.rows[0]).groupName || g.rows[0].name;
function objectiveWords(g) {
  const h = g.rows[0]; const m = metaOf(h);
  if (m.objective) return m.objective;
  if (h.type === 'internal') return 'Staff message';
  return Camp.KINDS[h.kind] ? Camp.KINDS[h.kind][0].replace(/ campaign$/, '') : 'Job promotion';
}
const createdAtOf = (g) => Math.min(...g.rows.map((r) => S.ms(r.createdAt) || 0));
function audienceOf(g) { return Math.max(0, ...g.rows.map((r) => (S.parse(r.planSummary, null) || {}).people || 0)); }

async function abilities(user, g, reqs, M) {
  const head = g.rows[0];
  const ctl = await Camp.canControl(user, head, reqs);
  const allDraft = g.rows.every((r) => r.status === 'draft');
  const ap = head.approval || null;
  const needs = await Appr.needsApproval(user);
  const why = allDraft ? await Appr.blocksSend(user, head) : null;
  const sts = g.rows.map((r) => r.status);
  const internalOk = head.type === 'internal' ? (A.kind(user) === 'admin' || (A.kind(user) === 'hr' && (await S.settings()).internalHrMaySend === true)) : A.mayCampaign(user);
  const hasCall = g.rows.some((r) => chanOf(r) === 'call');
  return {
    edit: ctl && allDraft, send: ctl && allDraft && !why, sendBlocked: ctl && allDraft ? why : null,
    submit: ctl && allDraft && (ap == null || ap === 'changes') && (needs || ap === 'changes' || metaOf(head).approvalMode === 'approval'),
    approve: A.has('mayApprove')(user) && ap === 'waiting' && allDraft, reject: A.has('mayApprove')(user) && ap === 'waiting' && allDraft,
    pause: ctl && sts.some((s) => ['running', 'scheduled'].includes(s)), resume: ctl && sts.some((s) => s === 'paused'),
    stop: ctl && sts.some((s) => ['running', 'scheduled', 'paused', 'draft', 'preparing'].includes(s)), remove: ctl && allDraft, duplicate: internalOk,
    resend: ctl && !!(M && M.failed > 0) && sts.some((s) => ['running', 'done', 'paused'].includes(s)), calls: hasCall && ctl,
    logs: true, downloadLogs: A.mayExportLog(user),
  };
}

// one row of the list / the header of a campaign
async function groupView(user, g, reqs, M, { withCan = true } = {}) {
  const head = g.rows[0]; const m = metaOf(head);
  const status = groupStatus(g.rows);
  const rq = reqs.get(head.requirementId);
  const channels = g.rows.map((r) => ({ id: r.id, channel: chanOf(r), code: CH_CODE[chanOf(r)], words: CH_WORDS[chanOf(r)], status: r.status, mode: r.mode || null }));
  const sum = sumM(g.rows.map((r) => M[r.id] || zero()));
  const hasCall = channels.some((c) => c.channel === 'call'); const onlyCall = channels.every((c) => c.channel === 'call');
  const audience = audienceOf(g);
  const rehearsal = g.rows.some((r) => r.mode === 'rehearsal');
  const info = m.approvalInfo || null;
  return {
    key: g.key, name: groupName(g), objective: objectiveWords(g), tag: m.tag || '', goal: m.goal || '', audience, channels,
    status, statusTone: STATUS[status][0], statusWords: STATUS[status][1], rehearsal, createdAt: S.iso(createdAtOf(g)), createdByName: head.createdByName || '', createdById: head.createdById || null,
    job: rq ? { id: rq.id, title: rq.title, reqCode: rq.reqCode || null } : null, type: head.type,
    numbers: {
      sent: sum.ok, failed: sum.failed, waiting: sum.waiting, delivered: sum.delivered, read: sum.read, replied: sum.replied, clicked: sum.clicked, applied: sum.applied, skipped: sum.skipped, rehearsed: sum.rehearsed,
      called: sum.called, noAnswer: sum.noAnswer, toCall: sum.toCall, engaged: sum.engaged, total: sum.total,
    },
    engagement: onlyCall ? null : pct1(sum.engaged, sum.ok - sum.called), conversions: sum.applied, hasCall, onlyCall,
    approval: head.approval || null, approvalNote: info && info.note ? info.note : '', approvalBy: info ? info.byName || '' : '', approvalAt: info && info.at ? S.iso(info.at) : null,
    ...(withCan ? { can: await abilities(user, g, reqs, sum) } : {}),
  };
}

// ---- THE LIST -------------------------------------------------------------------------------------------------------------------------
const SORTS = ['created', 'name', 'objective', 'status', 'audience', 'sent', 'engagement', 'conversions'];
function applyFilters(views, f) {
  let out = views;
  if (f.channel && f.channel !== 'all') out = out.filter((v) => v.channels.some((c) => c.channel === f.channel));
  const byChannel = out;
  if (f.status && f.status !== 'all') out = out.filter((v) => TAB_OF[v.status] === f.status);
  if (f.objective && f.objective !== 'all') out = out.filter((v) => v.objective.toLowerCase() === String(f.objective).toLowerCase());
  const needle = String(f.q || '').trim().toLowerCase();
  if (needle) out = out.filter((v) => `${v.name} ${v.objective} ${v.tag} ${v.channels.map((c) => c.words).join(' ')} ${v.job ? v.job.title : ''}`.toLowerCase().includes(needle));
  return { out, byChannel };
}
function sortViews(list, sort, dir) {
  const key = SORTS.includes(sort) ? sort : 'created';
  const sgn = dir === 'asc' ? 1 : -1;
  const val = { created: (v) => v.createdAt || '', name: (v) => v.name.toLowerCase(), objective: (v) => v.objective.toLowerCase(), status: (v) => v.statusWords, audience: (v) => v.audience, sent: (v) => v.numbers.sent, engagement: (v) => (v.engagement == null ? -1 : v.engagement), conversions: (v) => v.conversions }[key];
  return [...list].sort((a, b) => { const x = val(a); const y = val(b); const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true }); return c * sgn || String(b.createdAt || '').localeCompare(String(a.createdAt || '')); });
}
// f: { channel, status (tab), q, objective, sort, dir, page, pageSize, dept }
async function list(user, f = {}) {
  const { groups, reqs } = await loadGroups(user, f.dept);
  const needAll = ['sent', 'engagement', 'conversions'].includes(f.sort);
  const all = groups;
  // numbers for the page only (or for everything when the sort needs them)
  let M = {};
  const pre = all.map((g) => ({ g, status: groupStatus(g.rows) }));
  const quick = pre.map(({ g, status }) => ({ key: g.key, status, tab: TAB_OF[status], channels: g.rows.map((r) => chanOf(r)), objective: objectiveWords(g), name: groupName(g), tag: metaOf(g.rows[0]).tag || '', job: (reqs.get(g.rows[0].requirementId) || {}).title || '', createdAt: createdAtOf(g) }));
  // tab counts need only statuses
  const inChannel = f.channel && f.channel !== 'all' ? quick.filter((x) => x.channels.includes(f.channel)) : quick;
  const tabs = { all: inChannel.length, live: 0, scheduled: 0, notsent: 0, completed: 0, paused: 0, approval: 0 };
  inChannel.forEach((x) => { tabs[x.tab] += 1; });
  const channelCounts = { all: quick.length, whatsapp: 0, sms: 0, email: 0, rcs: 0, call: 0, facebook: 0, instagram: 0 };
  quick.forEach((x) => [...new Set(x.channels)].forEach((c) => { channelCounts[c] += 1; }));
  const objectives = [...new Set([...OBJECTIVES.map((o) => o.label), ...quick.map((x) => x.objective)])];
  // filter on the quick data, then build views for what is needed
  const needle = String(f.q || '').trim().toLowerCase();
  const keep = quick.filter((x) => (!f.status || f.status === 'all' || x.tab === f.status)
    && (!f.channel || f.channel === 'all' || x.channels.includes(f.channel))
    && (!f.objective || f.objective === 'all' || x.objective.toLowerCase() === String(f.objective).toLowerCase())
    && (!needle || `${x.name} ${x.objective} ${x.tag} ${x.channels.map((c) => CH_WORDS[c]).join(' ')} ${x.job}`.toLowerCase().includes(needle)));
  const keepKeys = new Set(keep.map((x) => x.key));
  let chosen = all.filter((g) => keepKeys.has(g.key));
  const pg = Math.max(1, Math.floor(Number(f.page)) || 1); const ps = Math.min(200, Math.max(1, Math.floor(Number(f.pageSize)) || 10));
  const wantAllMetrics = needAll || f.forExport;
  if (wantAllMetrics) M = await metricsFor(chosen.flatMap((g) => g.rows.map((r) => r.id)));
  let views;
  if (wantAllMetrics) {
    views = await Promise.all(chosen.map((g) => groupView(user, g, reqs, M, { withCan: false })));
    views = sortViews(views, f.sort, f.dir);
    const total = views.length;
    const pageViews = f.forExport ? views : views.slice((pg - 1) * ps, pg * ps);
    if (!f.forExport) for (const v of pageViews) v.can = await abilities(user, chosen.find((g) => g.key === v.key), reqs, sumM(chosen.find((g) => g.key === v.key).rows.map((r) => M[r.id] || zero()).map((m) => m))); // eslint-disable-line no-await-in-loop
    return finishList(user, { rows: pageViews, total, pg, ps, tabs, channelCounts, objectives });
  }
  // order first by the cheap keys, then numbers for the page only
  const sortKey = SORTS.includes(f.sort) ? f.sort : 'created';
  const cheap = keep.map((x) => ({ ...x, createdAt: new Date(x.createdAt).toISOString(), statusWords: STATUS[x.status][1], audience: audienceOf(all.find((g) => g.key === x.key)) }));
  const ordered = [...cheap].sort((a, b) => {
    const sgn = f.dir === 'asc' ? 1 : -1;
    const val = { created: (v) => v.createdAt, name: (v) => v.name.toLowerCase(), objective: (v) => v.objective.toLowerCase(), status: (v) => v.statusWords, audience: (v) => v.audience }[sortKey] || ((v) => v.createdAt);
    const x = val(a); const y = val(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
    return c * sgn || String(b.createdAt).localeCompare(String(a.createdAt));
  });
  const pageKeys = ordered.slice((pg - 1) * ps, pg * ps).map((x) => x.key);
  const pageGroups = pageKeys.map((k) => all.find((g) => g.key === k));
  M = await metricsFor(pageGroups.flatMap((g) => g.rows.map((r) => r.id)));
  views = await Promise.all(pageGroups.map((g) => groupView(user, g, reqs, M)));
  return finishList(user, { rows: views, total: ordered.length, pg, ps, tabs, channelCounts, objectives });
}
async function finishList(user, o) {
  const st = await S.settings();
  const approvals = await Appr.pendingCount(user);
  return { rows: o.rows, total: o.total, page: o.pg, pageSize: o.ps, tabs: o.tabs, channelCounts: o.channelCounts, objectives: o.objectives, canCreate: A.mayCampaign(user) || A.kind(user) === 'admin' || (A.kind(user) === 'hr' && st.internalHrMaySend === true), testMode: st.emailTestMode, sendingOn: st.master, approvalsWaiting: approvals, masked: A.masked(user), canExportLog: A.mayExportLog(user) };
}

const csvCell = (v) => MLog.safeCell(v);
async function exportCsv(user, f) {
  const out = await list(user, { ...f, forExport: true, page: 1, pageSize: 100000 });
  const lines = [['Campaign', 'Objective', 'Audience', 'Channels', 'Status', 'Sent', 'Engagement', 'Conversions'].map(csvCell).join(',')];
  out.rows.forEach((v) => lines.push([v.name, v.objective, v.audience || '', v.channels.map((c) => c.words).join(' | '), v.statusWords + (v.rehearsal ? ' (rehearsal)' : ''), v.numbers.sent, v.engagement == null ? '' : `${v.engagement}%`, v.conversions || ''].map(csvCell).join(',')));
  return { csv: `﻿${lines.join('\r\n')}\r\n`, count: out.rows.length };
}
async function exportRow(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const M = await metricsFor(f.group.rows.map((r) => r.id));
  const v = await groupView(user, f.group, f.reqs, M, { withCan: false });
  const lines = [['Name', 'Status', 'Channels', 'Sent', 'Delivered', 'Opened', 'Clicked', 'Replied', 'Applied'].map(csvCell).join(','), [v.name, v.statusWords + (v.rehearsal ? ' (rehearsal)' : ''), v.channels.map((c) => c.words).join(' / '), v.numbers.sent, v.numbers.delivered, v.numbers.read, v.numbers.clicked, v.numbers.replied, v.numbers.applied].map(csvCell).join(',')];
  return { csv: `﻿${lines.join('\r\n')}\r\n`, name: v.name };
}

// ---- THE COMMAND CENTER (detail) --------------------------------------------------------------------------------------------------
const sampleContact = { id: 'sample', name: 'Anita' };
async function versionsOf(g, reqs) {
  const st = await S.settings();
  const out = [];
  for (const r of g.rows) {
    const ch = chanOf(r);
    const snap = S.parse(r.templateSnapshot, null);
    const rq = reqs.get(r.requirementId);
    let subject = ''; let body = '';
    if (ch === 'call') body = metaOf(r).masterMessage || (snap && snap.body) || '';
    else if (snap) { try { const o = Camp.renderFor(snap, { contact: sampleContact, requirement: rq, message: { id: 'sample', token: r.type === 'job_promotion' ? 'SAMPLETOKEN' : null }, settings: st }, ch); subject = o.subject; body = o.body; } catch { body = snap.body || ''; } }
    out.push({ channel: ch, words: CH_WORDS[ch], campaignId: r.id, templateName: snap ? snap.name : null, waTemplateName: snap && snap.waTemplateName ? snap.waTemplateName : null, waLanguage: snap && snap.waLanguage ? snap.waLanguage : null, subject, body, sample: true });
  }
  return out;
}
async function activityOf(g) {
  const ids = g.rows.map((r) => r.id);
  const items = (await Act.listFor(ids)).map((a) => ({ at: a.at, title: ({ created: 'Campaign made', submitted: 'Asked for approval', approved: 'Approved', changes: 'Sent back for changes', scheduled: 'Scheduled', sent: 'Sent', paused: 'Paused', resumed: 'Resumed', stopped: 'Stopped', resent: 'Failed messages sent again', edited: 'Changed', copied: 'Copied' })[a.kind] || 'Update', detail: a.text, kind: a.kind }));
  g.rows.forEach((r) => {
    const ch = CH_WORDS[chanOf(r)];
    if (S.ms(r.startedAt) && !items.some((i) => i.kind === 'sent' && Math.abs(i.at - S.ms(r.startedAt)) < 120000)) items.push({ at: S.ms(r.startedAt), title: `${ch} went live`, detail: r.mode === 'rehearsal' ? 'Rehearsal: nothing was really sent.' : 'The first messages were handed to the channel.', kind: 'started' });
    if (S.ms(r.completedAt)) items.push({ at: S.ms(r.completedAt), title: `${ch} ${r.status === 'stopped' ? 'was stopped' : 'finished'}`, detail: '', kind: 'finished' });
    if (r.lastError) items.push({ at: S.ms(r.updatedAt), title: `${ch}: a problem`, detail: S.clip(r.lastError, 200), kind: 'problem' });
  });
  try {
    if (await S.quickReady()) (await S.q(`SELECT * FROM "OutreachCampaignNote" WHERE campaignId IN (${ph(ids.length)}) AND kind IN ('failed','held','finished') ORDER BY at ASC LIMIT 60`, ...ids)).forEach((n) => items.push({ at: S.num(n.at), title: ({ failed: 'A problem', held: 'On hold', finished: 'Finished' })[n.kind] || 'Update', detail: S.clip(n.text, 240), kind: n.kind }));
  } catch { /* the notes are a courtesy */ }
  return items.sort((a, b) => a.at - b.at).map((i) => ({ ...i, at: new Date(i.at).toISOString(), atWords: istText(i.at) }));
}
async function detail(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const { group: g, reqs } = f;
  const M = await metricsFor(g.rows.map((r) => r.id));
  const head = await groupView(user, g, reqs, M);
  const st = await S.settings();
  const e = await Health.env();
  const sum = sumM(g.rows.map((r) => M[r.id]));
  const statusOf = (r) => ({ draft: 'notsent', preparing: 'live', running: 'live', scheduled: 'scheduled', paused: 'paused', done: 'completed', stopped: 'stopped' }[r.status] || 'completed');
  const channels = g.rows.map((r) => {
    const m = M[r.id]; const ch = chanOf(r); const snap = S.parse(r.templateSnapshot, null);
    const hold = Health.summarize(Health.holdReasons(r, { waiting: m.waiting, sent: m.ok, failed: m.failed, cancelled: m.cancelled, skipped: m.skipped }, e, null));
    const sw = statusOf(r);
    const perChannelStatus = (r.approval === 'waiting' && r.status === 'draft') ? 'approval' : (r.approval === 'changes' && r.status === 'draft' ? 'changes' : sw);
    return {
      campaignId: r.id, channel: ch, words: CH_WORDS[ch], templateName: snap ? snap.name : (ch === 'call' ? 'Call script' : null), sent: m.ok, delivered: m.delivered, read: m.read, failed: m.failed, waiting: m.waiting, skipped: m.skipped, replied: m.replied, rehearsed: m.rehearsed, applied: m.applied, clicked: m.clicked, qualified: m.qualified,
      called: m.called, noAnswer: m.noAnswer, toCall: m.toCall, status: perChannelStatus, statusTone: STATUS[perChannelStatus][0], statusWords: STATUS[perChannelStatus][1], mode: r.mode || null,
      perMinute: r.perMinute == null ? null : S.num(r.perMinute), scheduledAt: S.iso(r.scheduledAt), why: hold.primary ? { words: hold.primary.words, fix: hold.primary.fix ? hold.primary.fix.text : '', level: hold.primary.level } : null,
    };
  });
  const delivery = channels.map((c) => ({ channel: c.channel, words: c.words, pct: c.channel === 'call' ? pct1(c.called, c.called + c.noAnswer + c.toCall) : pct1(c.delivered || c.sent, c.sent + c.failed), sent: c.sent, failed: c.failed, waiting: c.waiting, basis: c.channel === 'call' ? 'called' : (c.delivered ? 'delivered' : 'sent') }));
  const act = await activityOf(g);
  const people = head.audience;
  const liveCh = channels.filter((c) => c.status === 'live').length;
  const steps = [
    { n: 1, title: 'Audience', small: people ? `${S.num(people).toLocaleString('en-IN')} people` : (g.rows.some((r) => r.status === 'draft') ? `${S.parse(g.rows[0].segmentIds, []).length} group(s) picked` : '—'), state: 'done' },
    { n: 2, title: 'Master content', small: g.rows.every((r) => r.templateId || chanOf(r) === 'call') ? 'Ready' : 'A message is missing', state: g.rows.every((r) => r.templateId || chanOf(r) === 'call') ? 'done' : 'active' },
    { n: 3, title: 'Channel delivery', small: head.status === 'notsent' || head.status === 'approval' || head.status === 'changes' ? 'Not sent yet' : (head.status === 'live' ? `${liveCh} ${liveCh === 1 ? 'channel' : 'channels'} live` : head.statusWords), state: head.status === 'live' ? 'active' : (['completed', 'stopped', 'paused', 'scheduled'].includes(head.status) ? 'done' : '') },
    { n: 4, title: 'Measure', small: sum.ok + sum.failed > 0 ? 'Reporting live' : 'Waiting for the first send', state: sum.ok + sum.failed > 0 ? 'active' : '' },
  ];
  const rate = sum.ok > 0 ? pct1(sum.delivered, sum.ok) : null;
  return {
    campaign: head, steps, masked: A.masked(user), testMode: st.emailTestMode,
    overview: {
      reach: sum.ok - sum.called, reachNote: head.audience ? `messages to ${S.num(head.audience).toLocaleString('en-IN')} people on ${g.rows.length} ${g.rows.length === 1 ? 'channel' : 'channels'}` : '', delivered: sum.delivered, deliveredNote: sum.delivered > 0 ? `${rate}% of sent` : 'Waiting for delivery reports', engaged: sum.engaged, engagementNote: head.engagement == null ? 'Calls have no engagement figure' : `${head.engagement}% of the people messaged`,
      conversions: sum.applied, conversionsNote: sum.ok > 0 ? `${pct1(sum.applied, sum.ok) || 0}% of those sent` : '', rehearsal: head.rehearsal, called: sum.called, toCall: sum.toCall,
    },
    content: { masterMessage: metaOf(g.rows[0]).masterMessage || '', cta: metaOf(g.rows[0]).cta || '', editable: g.rows.every((r) => r.status === 'draft') && head.can.edit, versions: await versionsOf(g, reqs), delivery, activity: act.slice(-3).reverse() },
    channels, activity: act, hasCalls: head.hasCall, approval: { state: head.approval, note: head.approvalNote, by: head.approvalBy, at: head.approvalAt },
  };
}
// the master message of a campaign that was not sent yet (the Content tab's "Save source message")
async function saveMaster(user, key, text, cta) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const { group: g, reqs } = f;
  if (!(await Camp.canControl(user, g.rows[0], reqs))) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  if (g.rows.some((r) => r.status !== 'draft')) return { error: 'This campaign was already sent, so its words cannot be changed. Copy it to make a new one.', status: 409 };
  const t = S.clip(text, 2000);
  if (!t) return { error: 'The source message cannot be empty.', status: 400 };
  for (const r of g.rows) await Camp.patchMeta(r.id, { masterMessage: t, ...(cta !== undefined ? { cta: S.clip(cta, 80) } : {}) }); // eslint-disable-line no-await-in-loop
  await Act.log(g.rows[0], 'edited', `The master message was changed by ${S.clip(user.name, 60)}.`, user);
  return { ok: true };
}

// ---- AUDIENCE TAB: who this campaign was resolved against --------------------------------------------------------------------------
async function audience(user, key, { page = 1, pageSize = 10, q } = {}) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const { group: g } = f;
  const masked = A.masked(user);
  const pg = Math.max(1, Math.floor(Number(page)) || 1); const ps = Math.min(100, Math.max(1, Math.floor(Number(pageSize)) || 10));
  const ids = g.rows.map((r) => r.id);
  const needle = String(q || '').trim().slice(0, 60).toLowerCase();
  const nSql = needle ? ' AND LOWER(c.name) LIKE ?' : ''; const nPs = needle ? [`%${needle.replace(/[%_]/g, '')}%`] : [];
  const made = S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(ids.length)})`, ...ids))[0].n);
  const shape = (c) => ({ id: c.id, name: c.name || 'Contact', phone: c.phoneE164 ? (masked ? core.maskMobile(c.phoneE164) : `+${c.phoneE164}`) : '', source: c.source || '', city: c.city || '' });
  if (made > 0) {
    const total = S.num((await S.q(`SELECT COUNT(DISTINCT m.contactId) n FROM "OutreachMessage" m LEFT JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId IN (${ph(ids.length)})${nSql}`, ...ids, ...nPs))[0].n);
    const people = await S.q(`SELECT c.id, c.name, c.phoneE164, c.source, c.city FROM "OutreachMessage" m LEFT JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId IN (${ph(ids.length)})${nSql} GROUP BY m.contactId ORDER BY c.name LIMIT ? OFFSET ?`, ...ids, ...nPs, ps, (pg - 1) * ps);
    const cids = people.map((p) => p.id).filter(Boolean);
    const msgs = cids.length ? await S.q(`SELECT contactId, channel, status, reason FROM "OutreachMessage" WHERE campaignId IN (${ph(ids.length)}) AND contactId IN (${ph(cids.length)})`, ...ids, ...cids) : [];
    const words = (m) => (m.channel === 'call' ? ({ queued: 'To call', sent: 'Called', failed: 'No answer', skipped: 'Skipped', cancelled: 'Cancelled' }[m.status] || m.status) : (m.status === 'skipped' ? `Left out: ${Sup.REASON_WORDS[m.reason] || m.reason || ''}` : (MLog.RAW_WORDS[m.status] || m.status)));
    return { total, page: pg, pageSize: ps, masked, resolved: true, people: people.map((p) => ({ ...shape(p), stage: msgs.filter((m) => m.contactId === p.id).sort((a, b) => chOrder(a.channel) - chOrder(b.channel)).map((m) => `${CH_WORDS[m.channel]}: ${words(m)}`).join(' · ') })) };
  }
  // not sent yet: the people the groups hold right now (live)
  const head = g.rows[0];
  const m = await Sup.members(S.parse(head.segmentIds, []), head.type).catch(() => ({ ids: [] }));
  const all = m.ids; let total = all.length; let slice = all;
  if (needle) { const rows = []; for (const part of chunk(all, 400)) rows.push(...(await S.q(`SELECT id FROM "OutreachContact" c WHERE id IN (${ph(part.length)})${nSql}`, ...part, ...nPs))); slice = rows.map((r) => r.id); total = slice.length; } // eslint-disable-line no-await-in-loop
  const pageIds = slice.slice((pg - 1) * ps, pg * ps);
  const people = pageIds.length ? await S.q(`SELECT id, name, phoneE164, source, city FROM "OutreachContact" WHERE id IN (${ph(pageIds.length)}) ORDER BY name`, ...pageIds) : [];
  return { total, page: pg, pageSize: ps, masked, resolved: false, people: people.map((p) => ({ ...shape(p), stage: 'Not sent yet' })) };
}

// ---- REPLIES TAB --------------------------------------------------------------------------------------------------------------------------
async function replies(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const ids = f.group.rows.map((r) => r.id);
  await require('./v3schema').ensure();
  const rows = await S.q(`SELECT m.id, m.channel, m.repliedAt, c.name, (SELECT MIN(e.occurredAt) FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = 'replied') AS evAt, (SELECT e.detail FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = 'replied' LIMIT 1) AS detail
    FROM "OutreachMessage" m LEFT JOIN "OutreachContact" c ON c.id = m.contactId WHERE m.campaignId IN (${ph(ids.length)}) AND (m.repliedAt IS NOT NULL OR EXISTS (SELECT 1 FROM "OutreachEvent" e WHERE e.messageId = m.id AND e.type = 'replied')) ORDER BY COALESCE(m.repliedAt, 0) DESC LIMIT 100`, ...ids);
  return {
    total: rows.length, masked: A.masked(user),
    replies: rows.map((r) => { const d = S.parse(r.detail, null); return { id: r.id, name: r.name || 'Contact', channel: r.channel, words: CH_WORDS[r.channel] || r.channel, at: S.iso(r.repliedAt || r.evAt), text: d && typeof d.text === 'string' ? S.clip(d.text, 200) : '' }; }),
  };
}

// ---- ANALYTICS ---------------------------------------------------------------------------------------------------------------------------
const REASON_DESC = {
  no_phone: 'The person has no phone number saved, so there was nothing to send to.', no_opt_in: 'The person never agreed to get messages on this channel.', opted_out: 'The person asked to stop (or an Admin opted them out).',
  suppressed: 'The number or address is on the do-not-contact list.', already_applied: 'The person already applied to this requirement.', recently_messaged: 'The person got a message about this requirement only a few days ago.',
  bad_address: 'The address or number does not work (it bounced, or was marked bad).', invalid_email: 'There is no valid email address.', internal_contact: 'A staff contact never gets a job message.',
  rejected: 'The channel or the provider refused the message.', gave_up: 'The message could not be sent after three tries.', no_credits: 'There were not enough credits to send it.', daily_cap: 'The daily limit of the channel was reached.',
  no_answer: 'The person did not pick up the call.', skipped_call: 'The caller chose to skip this call.', hard_bounce: 'The email address does not exist.', complaint: 'The person marked the message as spam.',
  campaign_stopped: 'The campaign was stopped before this message went out.', interrupted: 'The system stopped while sending, so this one was not sent again to be safe.', gone: 'The person was removed from the list.',
};
const FAIL_COLORS = ['#de5c63', '#ef9b35', '#d6249f', '#7867d9', '#4d7ddb', '#0891b2', '#b3261e', '#5b6ee1'];
async function analytics(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const { group: g, reqs } = f;
  const ids = g.rows.map((r) => r.id);
  const M = await metricsFor(ids);
  const head = await groupView(user, g, reqs, M, { withCan: false });
  const sum = sumM(ids.map((id) => M[id]));
  const hasData = sum.ok + sum.failed > 0;
  const callOnly = head.onlyCall;
  // the six tiles
  const messaged = sum.ok + sum.failed;
  const answered = sum.read + sum.called;
  const tiles = {
    total: messaged, sent: sum.ok, delivered: sum.delivered, readAnswered: answered, failed: sum.failed, responses: sum.replied,
    labels: { sent: callOnly ? 'Calls made' : 'Successfully Sent', readAnswered: callOnly ? 'Answered' : (head.hasCall ? 'Read / Answered' : 'Read'), delivered: 'Delivered' },
  };
  const slices = [
    { label: 'Delivered', value: Math.max(0, sum.delivered - sum.read), color: '#4d7ddb' },
    { label: 'Failed/Busy', value: sum.failed, color: '#de5c63' },
    { label: 'Read/Answered', value: answered, color: '#11985a' },
    { label: 'Sent/Ringing', value: Math.max(0, sum.ok - sum.called - sum.delivered), color: '#ef9b35' },
  ];
  // why messages failed or were left out
  const rs = await S.q(`SELECT reason, status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId IN (${ph(ids.length)}) AND (reason IS NOT NULL OR status IN ('failed','bounced','complained','unknown')) AND status IN ('failed','bounced','complained','unknown','skipped') GROUP BY reason, status`, ...ids);
  const byReason = new Map();
  rs.forEach((r) => { const k = r.reason || (r.status === 'bounced' ? 'hard_bounce' : (r.status === 'complained' ? 'complaint' : 'rejected')); const cur = byReason.get(k) || { reason: k, n: 0, failed: 0, left: 0 }; cur.n += S.num(r.n); if (r.status === 'skipped') cur.left += S.num(r.n); else cur.failed += S.num(r.n); byReason.set(k, cur); });
  const reasons = [...byReason.values()].sort((a, b) => b.n - a.n).map((r, i) => ({ reason: r.reason, label: Sup.REASON_WORDS[r.reason] || r.reason, count: r.n, failed: r.failed, leftOut: r.left, color: FAIL_COLORS[i % FAIL_COLORS.length], desc: REASON_DESC[r.reason] || (Sup.REASON_WORDS[r.reason] || r.reason) }));
  // the message preview: the first channel that has words
  const versions = await versionsOf(g, reqs);
  const first = versions.find((v) => v.body) || versions[0] || null;
  const head0 = g.rows.find((r) => chanOf(r) === (first ? first.channel : '')) || g.rows[0];
  const tpl = head0 && head0.templateId ? (await S.q('SELECT category, waLanguage FROM "OutreachTemplate" WHERE id = ?', head0.templateId))[0] : null;
  return {
    campaign: head, hasData, tiles, slices, reasons, canExport: true, channelsWords: head.channels.map((c) => c.words),
    preview: first ? { channel: first.channel, words: first.words, templateName: first.waTemplateName || first.templateName || '', language: first.waLanguage ? String(first.waLanguage).toUpperCase() : '', category: tpl && tpl.category ? String(tpl.category).toUpperCase() : '', subject: first.subject, body: first.body, cta: metaOf(g.rows[0]).cta || '' } : null,
    rehearsal: head.rehearsal, rehearsed: sum.rehearsed,
  };
}
async function analyticsCsv(user, key) {
  const a = await analytics(user, key);
  if (a.error) return a;
  if (!a.hasData) return { error: 'No delivery data yet to export.', status: 409 };
  const t = a.tiles;
  const rows = [['Campaign', a.campaign.name], ['Channels', a.campaign.channels.map((c) => c.words).join(' | ')], ['Status', a.campaign.statusWords], ['Total Messages', t.total], ['Successfully Sent', t.sent], ['Delivered', t.delivered],
    ['Read / Answered', t.readAnswered], ['Sent / Ringing', a.slices[3].value], ['Failed', t.failed], ['Responses', t.responses], ...a.reasons.map((r) => [`Reason: ${r.label}`, r.count])];
  if (a.rehearsal) rows.splice(3, 0, ['Note', 'Rehearsal: nothing was really sent']);
  return { csv: `﻿${[['Metric', 'Value'].map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\r\n')}\r\n`, name: a.campaign.name };
}

// ---- LIVE MESSAGE LOGS -------------------------------------------------------------------------------------------------------------------
async function logs(user, key, f = {}) {
  const o = await loadOne(user, key);
  if (o.error) return o;
  const ids = o.group.rows.map((r) => r.id);
  const pageSize = [10, 20, 50].includes(Number(f.pageSize)) ? Number(f.pageSize) : 10;
  const out = await MLog.list(user, { campaignIds: ids, status: f.status && f.status !== 'all' ? f.status : undefined, q: f.q, channel: f.channel, page: f.page, pageSize });
  return { ...out, campaignName: groupName(o.group), channels: [...new Set(o.group.rows.map((r) => chanOf(r)))], rehearsal: o.group.rows.some((r) => r.mode === 'rehearsal') };
}
async function logsCsv(user, key, f = {}) {
  const o = await loadOne(user, key);
  if (o.error) return o;
  const ids = o.group.rows.map((r) => r.id);
  const out = await MLog.csv(user, { campaignIds: ids, status: f.status && f.status !== 'all' ? f.status : undefined, q: f.q, channel: f.channel, detailed: true });
  if (out.error) return out;
  return { ...out, name: groupName(o.group), filterWords: MLog.filterWords({ campaignId: ids[0], status: f.status, channel: f.channel, q: f.q }) };
}

// ---- WIZARD HELPERS ------------------------------------------------------------------------------------------------------------------------
const WIZ_CHANNELS = [
  { id: 'whatsapp', label: 'WhatsApp', real: true }, { id: 'sms', label: 'SMS', real: true }, { id: 'email', label: 'Email', real: true }, { id: 'call', label: 'Voice (calls)', real: true },
  { id: 'rcs', label: 'RCS', real: false, planned: true }, { id: 'facebook', label: 'Facebook', real: false }, { id: 'instagram', label: 'Instagram', real: false },
];
async function readiness(user, audience) {
  const aud = audience === 'internal' ? 'internal' : 'candidate_lead';
  const tpls = await S.q('SELECT * FROM "OutreachTemplate" WHERE audience = ? AND status = \'active\'', aud);
  const st = await S.settings();
  const out = [];
  const conn = {};
  for (const ch of ['whatsapp', 'sms', 'email']) conn[ch] = await adapters.get(ch).status(); // eslint-disable-line no-await-in-loop
  const wa = tpls.filter((t) => t.channel === 'whatsapp');
  const approved = wa.filter((t) => t.waApprovalStatus === 'approved' && t.waTemplateName).length;
  const waiting = wa.filter((t) => t.waApprovalStatus === 'pending').length;
  const rejected = wa.filter((t) => t.waApprovalStatus === 'rejected').length;
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const connWords = (ch) => (conn[ch].ready ? `${CH_WORDS[ch]} connected` : `${CH_WORDS[ch]} is not connected: only a rehearsal is possible until an Admin connects it`);
  const waNote = approved ? `${plural(approved, 'Meta-approved template')} available${waiting ? ` · ${waiting} in review` : ''}` : (waiting ? `${plural(waiting, 'template')} still in review with Meta` : (rejected ? 'All templates rejected — fix and resubmit in Manage Templates' : 'No approved template yet — create one in Manage Templates'));
  out.push({ channel: 'whatsapp', label: 'WhatsApp', ready: approved > 0, note: `${waNote} · ${connWords('whatsapp')}`, selectable: true, templates: { ready: approved, total: wa.length }, connection: { ready: conn.whatsapp.ready, reason: conn.whatsapp.reason, via: conn.whatsapp.via }, canGoLive: approved > 0 && conn.whatsapp.ready });
  const sm = tpls.filter((t) => t.channel === 'sms'); const smOk = sm.filter((t) => t.dltTemplateId && t.senderId).length;
  out.push({ channel: 'sms', label: 'SMS', ready: smOk > 0, note: `${smOk ? `${plural(smOk, 'SMS message')} with the DLT number and sender ID ready` : 'No SMS message with the DLT number and sender ID yet — add one in Manage Templates'} · ${connWords('sms')}`, selectable: true, templates: { ready: smOk, total: sm.length }, connection: { ready: conn.sms.ready, reason: conn.sms.reason, via: conn.sms.via }, canGoLive: smOk > 0 && conn.sms.ready });
  const em = tpls.filter((t) => t.channel === 'email'); const emOk = em.filter((t) => T.readiness({ ...T.view(t), status: 'active' }).ready).length;
  out.push({ channel: 'email', label: 'Email', ready: emOk > 0, note: `${emOk ? `${plural(emOk, 'email message')} ready` : 'No email message yet — create one in Manage Templates'} · ${conn.email.ready ? 'mail server set up' : `mail server is not set up: only a rehearsal is possible (${conn.email.reason || ''})`}`.replace(/\(\)$/, '').trim(), selectable: true, templates: { ready: emOk, total: em.length }, connection: { ready: conn.email.ready, reason: conn.email.reason, via: null }, canGoLive: emOk > 0 && conn.email.ready });
  out.push({ channel: 'call', label: 'Voice (calls)', ready: true, note: 'Each person becomes a call task for your team to ring and log (called, no answer, skip). Nothing is sent by the machine.', selectable: true, templates: { ready: 0, total: 0 }, connection: { ready: true }, canGoLive: true });
  out.push({ channel: 'rcs', label: 'RCS', ready: false, note: 'Planned: RCS is not connected yet. Nothing here is faked.', selectable: false, planned: true, templates: { ready: 0, total: 0 }, connection: { ready: false } });
  out.push({ channel: 'facebook', label: 'Facebook', ready: false, note: 'Not connected: connect a Page on the Facebook page of Omni-Channel to use this channel.', selectable: false, templates: { ready: 0, total: 0 }, connection: { ready: false } });
  out.push({ channel: 'instagram', label: 'Instagram', ready: false, note: 'Not connected: connect an account on the Instagram page of Omni-Channel to use this channel.', selectable: false, templates: { ready: 0, total: 0 }, connection: { ready: false } });
  void st;
  return out;
}
// the picks of the wizard
async function options(user, { audience } = {}) {
  const st = await S.settings();
  const cs = await Cr.settings();
  const internalOk = A.kind(user) === 'admin' || (A.kind(user) === 'hr' && st.internalHrMaySend === true);
  const mayCreate = A.mayCampaign(user) || internalOk;
  const aud = audience === 'internal' ? 'internal' : 'candidate_lead';
  let credits = { exempt: true, left: null, allowance: null, cost: cs.cost, enforce: cs.enforce };
  try { const p = await Cr.personOf(user.id); const exempt = Cr.isExempt(cs, p); if (!exempt) { const allowance = await Cr.allowanceOf(cs, user.id); credits = { exempt: false, allowance, left: Math.max(0, allowance - (await Cr.usedBy(user.id))), cost: cs.cost, enforce: cs.enforce }; } } catch { /* keep */ }
  const approvalRequired = await Appr.required();
  const forced = await Appr.needsApproval(user);
  return {
    canCreate: mayCreate, objectives: OBJECTIVES.filter((o) => o.type !== 'internal' || internalOk).map((o) => ({ id: o.id, label: o.label, internal: o.type === 'internal' })),
    segments: mayCreate ? (await G.list(user, { type: aud })).map((s) => ({ id: s.id, name: s.name, total: s.counts.total, reachable: s.counts.reachable, emptyRule: !!s.counts.emptyRule, createdByName: s.createdByName })) : [],
    channels: await readiness(user, aud), templates: mayCreate ? await T.list(user, { type: aud }) : [], credits, brandVoices: ['Warm & confident', 'Professional', 'Playful'],
    settings: { testMode: st.emailTestMode, sendingOn: st.master, perMinute: { email: st.emailPerMinute, whatsapp: st.waPerMinute, sms: st.smsPerMinute }, dailyCap: { email: st.emailDailyCap, whatsapp: st.waDailyCap, sms: st.smsDailyCap }, quietWords: Quiet.describe(st.quietHours), quiet: Quiet.normalize(st.quietHours) },
    approval: { required: approvalRequired, forced, canApprove: A.has('mayApprove')(user) },
    masked: A.masked(user),
  };
}
const validChannels = (list, allowEmpty) => {
  const out = [...new Set((Array.isArray(list) ? list : []).map((c) => String(c).toLowerCase()))];
  if (!allowEmpty && !out.length) return { error: 'Pick at least one channel to publish to.', status: 400 };
  const bad = out.find((c) => !Sup.CHANNELS.includes(c));
  if (bad) return { error: `${bad === 'rcs' ? 'RCS' : (bad.charAt(0).toUpperCase() + bad.slice(1))} is not connected yet, so a campaign cannot be published to it.`, status: 400, code: 'channel_not_connected' };
  return { channels: out.sort((a, b) => chOrder(a) - chOrder(b)) };
};
const typeOfBody = (b) => ((objectiveOf(b.objective) || {}).type === 'internal' || b.type === 'internal' ? 'internal' : 'job_promotion');

// step 2 / 4: who would get it, per channel, with credits. Never sends.
async function planAudience(user, b) {
  const type = typeOfBody(b);
  const vc = validChannels(b.channels, true); if (vc.error) return vc;
  const channels = vc.channels.length ? vc.channels : ['whatsapp', 'sms', 'email'];
  const v = await Camp.validate(user, { type, channel: channels[0], requirementId: b.requirementId, segmentIds: b.segmentIds }, { needTemplate: false });
  if (v.error) return v;
  const st = await S.settings();
  const m = await Sup.members(v.segmentIds, type);
  const per = []; const union = new Set(); const firstReason = new Map();
  let needed = 0;
  for (const ch of channels) {
    const camp = { id: '', type, channel: Camp.dbChannel(ch), meta: { channel: ch }, requirementId: v.requirement ? v.requirement.id : null, suppressDays: st.suppressDays };
    const res = await Sup.evaluate(camp, m.ids, { days: st.suppressDays }); // eslint-disable-line no-await-in-loop
    const t = Sup.tally(res);
    res.forEach((r) => { if (r.decision.send) union.add(r.contactId); else if (!firstReason.has(r.contactId)) firstReason.set(r.contactId, r.decision.reason); });
    const mode = ch === 'call' ? 'live' : (st.emailTestMode ? 'rehearsal' : 'live');
    const credits = await Camp.creditsFor(user.id, ch, t.willGet, { testMode: mode === 'rehearsal' }); // eslint-disable-line no-await-in-loop
    needed += credits.needed;
    per.push({ channel: ch, label: CH_WORDS[ch], willGet: t.willGet, skippedTotal: m.ids.length - t.willGet, reasons: Object.entries(t.reasons).map(([reason, n]) => ({ reason, words: Sup.REASON_WORDS[reason] || reason, n })).sort((a, c) => c.n - a.n), credits });
  }
  const gone = {}; m.ids.forEach((id) => { if (!union.has(id)) { const r = firstReason.get(id) || 'no_opt_in'; gone[r] = (gone[r] || 0) + 1; } });
  const cr0 = per[0] ? per[0].credits : { exempt: true, left: null, enforce: true };
  return {
    ok: true, type, people: m.ids.length, duplicates: m.duplicates, reach: union.size, excluded: m.ids.length - union.size, excludedReasons: Object.entries(gone).map(([reason, n]) => ({ reason, words: Sup.REASON_WORDS[reason] || reason, n })).sort((a, c) => c.n - a.n),
    perChannel: per, testMode: st.emailTestMode, consentNote: 'Only people who agreed (opted in) on a channel get a message on it. People who opted out, and the do-not-contact list, are always left out. Calls need no opt-in but skip anybody opted out.',
    credits: { needed, left: cr0.left, exempt: cr0.exempt, enforce: cr0.enforce, enough: st.emailTestMode || cr0.exempt || !cr0.enforce || needed <= cr0.left },
  };
}
const bodyFor = (b, ch, type) => ({
  type, channel: ch, requirementId: b.requirementId, segmentIds: b.segmentIds, templateId: b.templates ? b.templates[ch] : undefined, varMap: b.varMap && b.varMap[ch] ? b.varMap[ch] : (Array.isArray(b.varMap) ? b.varMap : undefined),
  script: b.masterMessage, when: b.when, at: b.at, perMinute: b.perMinute, waNumberId: b.waNumberId || undefined, // the WhatsApp number chosen in step 4
});
// step 5: the review: per channel the plan + "Check before sending"
async function review(user, b) {
  const type = typeOfBody(b);
  const vc = validChannels(b.channels); if (vc.error) return vc;
  const st = await S.settings();
  const out = []; let blocked = false; let needed = 0; let creditsLeft = null; let exempt = true; let enforce = true;
  for (const ch of vc.channels) {
    const body = bodyFor(b, ch, type);
    const plan = await Camp.plan(user, body); // eslint-disable-line no-await-in-loop
    const check = await Health.checkBeforeSending(user, body, plan); // eslint-disable-line no-await-in-loop
    if (check.error) return check;
    if (check.blocked) blocked = true;
    if (plan && plan.credits) { needed += plan.credits.needed; creditsLeft = plan.credits.left; exempt = plan.credits.exempt; enforce = plan.credits.enforce; }
    out.push({ channel: ch, label: CH_WORDS[ch], plan: plan.error ? { error: plan.error } : { willGet: plan.willGet, skippedTotal: plan.skippedTotal, reasons: Object.entries(plan.reasons || {}).map(([reason, n]) => ({ reason, words: Sup.REASON_WORDS[reason] || reason, n })), preview: plan.preview, credits: plan.credits, dailyCap: plan.dailyCap, perMinute: plan.perMinute, warnings: plan.warnings, mode: plan.mode }, check });
  }
  let quietNote = null;
  if (b.when === 'at' && b.at && Quiet.applies(st.quietHours, type)) { const at = Date.parse(b.at); if (Number.isFinite(at)) { const mv = Quiet.moveOutOfQuiet(at, st.quietHours, type); if (mv.moved) quietNote = `The time you picked is inside quiet hours, so it will start when quiet hours end (${mv.endLabel}, India time).`; } }
  return {
    ok: !blocked, blocked, channels: out, testMode: st.emailTestMode, sendingOn: st.master, quietWords: Quiet.describe(st.quietHours), quietNote,
    credits: { needed, left: creditsLeft, exempt, enforce, enough: st.emailTestMode || exempt || !enforce || needed <= (creditsLeft || 0) },
    approval: { required: await Appr.required(), forced: await Appr.needsApproval(user) },
  };
}

// ---- CREATE / EDIT / SEND ---------------------------------------------------------------------------------------------------------------
async function departmentFor(user, rq) {
  if (rq && rq.department) return String(rq.department);
  try { const p = await Cr.personOf(user.id); return (p && p.department) || ''; } catch { return ''; }
}
function gatherBody(b) {
  const o = objectiveOf(b.objective) || OBJECTIVES[1];
  return { objective: o, type: o.type === 'internal' ? 'internal' : 'job_promotion' };
}
async function createGroup(user, b) {
  if (!(await S.campaignsReady())) return { error: 'Campaigns are being set up. Please try again in a little while.', status: 503 };
  const { objective, type } = gatherBody(b);
  const name = S.clip(b.name, 80);
  if (name.length < 2) return { error: 'Give the campaign a name.', status: 400 };
  const vc = validChannels(b.channels); if (vc.error) return vc;
  const saveOnly = b.saveOnly === true;
  const groupId = S.newId('og');
  const rq = type === 'job_promotion' && b.requirementId ? await prisma.requirement.findUnique({ where: { id: String(b.requirementId) } }).catch(() => null) : null;
  const dept = await departmentFor(user, rq);
  const when = b.when === 'at' ? 'at' : 'now';
  const approvalMode = b.approvalMode === 'approval' ? 'approval' : 'auto';
  const needs = await Appr.needsApproval(user);
  // before anything is made: every channel must pass "Check before sending" (a live send of one channel must not leave another half done)
  if (!saveOnly && !(approvalMode === 'approval' || needs)) {
    for (const ch of vc.channels) {
      const chk = await Health.checkBeforeSending(user, bodyFor(b, ch, type)); // eslint-disable-line no-await-in-loop
      if (chk.error) return { error: `${CH_WORDS[ch]}: ${chk.error}`, status: chk.status || 400 };
      if (chk.blocked) { const bad = chk.checks.find((c) => c.status === 'block'); return { error: `${CH_WORDS[ch]}: ${bad ? `${bad.label}${bad.detail ? `. ${bad.detail}` : ''}` : 'It is not ready.'}`, status: bad && bad.id === 'credits' ? 402 : 400, code: 'blocked' }; }
    }
  }
  const made = [];
  for (const ch of vc.channels) {
    const body = {
      ...bodyFor(b, ch, type), name: vc.channels.length > 1 ? `${name} · ${CH_WORDS[ch]}` : name, kind: objective.kind || undefined, allowNoTemplate: saveOnly,
      meta: { groupId, groupName: name, objective: objective.label, tag: S.clip(b.tag, 60), goal: S.clip(b.goal, 600), masterMessage: S.clip(b.masterMessage, 2000), cta: S.clip(b.cta, 80), brandVoice: S.clip(b.brandVoice, 40), department: dept, approvalMode, when, at: when === 'at' ? b.at || null : null, origin: 'gs' },
    };
    const r = await Camp.create(user, body); // eslint-disable-line no-await-in-loop
    if (r.error) { for (const m of made) await Camp.removeDraft(user, m).catch(() => {}); return { ...r, error: `${CH_WORDS[ch]}: ${r.error}` }; } // eslint-disable-line no-await-in-loop
    made.push(r.id);
  }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Omni campaign made', entity: 'OutreachCampaign', entityId: made[0], toValue: `${vc.channels.join(', ')}; ${saveOnly ? 'saved, not sent' : 'to publish'}` });
  const rows = await Camp.groupRows(groupId);
  if (saveOnly) return { ok: true, key: groupId, status: 'notsent', message: `"${name}" is saved as not sent yet.` };
  if (approvalMode === 'approval' || needs) {
    const r = await Appr.submit(user, groupId);
    if (r.error) return { ok: true, key: groupId, status: 'notsent', message: `Saved, but approval could not be asked: ${r.error}` };
    return { ok: true, key: groupId, status: 'approval', message: `"${name}" is waiting for approval. A Team Lead will look at it.` };
  }
  const results = [];
  for (const r of rows) {
    const sent = await Camp.send(user, r.id, { when, at: b.at }); // eslint-disable-line no-await-in-loop
    results.push({ channel: chanOf(r), ok: !sent.error, error: sent.error || null, status: sent.status, quietNote: sent.quietNote || null, mode: sent.mode || null });
  }
  const bad = results.find((x) => !x.ok);
  const mode = (results.find((x) => x.ok) || {}).mode;
  const note = results.map((x) => x.quietNote).filter(Boolean)[0] || '';
  if (bad) return { ok: true, key: groupId, status: 'notsent', partial: true, message: `${CH_WORDS[bad.channel]} could not be sent: ${bad.error} The campaign is saved as not sent yet.`, results };
  return { ok: true, key: groupId, status: when === 'at' ? 'scheduled' : 'live', message: when === 'at' ? `"${name}" is scheduled.${note ? ` ${note}` : ''}` : `"${name}" is ${mode === 'rehearsal' ? 'running as a rehearsal (Test mode: nothing is really sent)' : 'on its way'}.`, results };
}
// the wizard's Edit: the campaign as the wizard fields
async function editShape(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const { group: g, reqs } = f;
  if (g.rows.some((r) => r.status !== 'draft')) return { error: 'This campaign was already sent, so it cannot be changed. Copy it to make a new one.', status: 409 };
  if (!(await Camp.canControl(user, g.rows[0], reqs))) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  const head = g.rows[0]; const m = metaOf(head);
  const templates = {}; const varMap = {};
  g.rows.forEach((r) => { if (r.templateId) templates[chanOf(r)] = r.templateId; const vm = metaOf(r).varMap; if (vm && vm.length) varMap[chanOf(r)] = vm; });
  const rq = reqs.get(head.requirementId);
  const o = OBJECTIVES.find((x) => x.label === m.objective) || (head.type === 'internal' ? OBJECTIVES.find((x) => x.id === 'staff') : OBJECTIVES.find((x) => x.kind && x.kind === head.kind) || OBJECTIVES[1]);
  return {
    key: g.key, name: groupName(g), objective: o.id, tag: m.tag || '', goal: m.goal || '', requirementId: head.requirementId || null, job: rq ? { id: rq.id, title: rq.title, reqCode: rq.reqCode || null } : null,
    segmentIds: S.parse(head.segmentIds, []), channels: g.rows.map((r) => chanOf(r)), templates, varMap, masterMessage: m.masterMessage || '', cta: m.cta || '', brandVoice: m.brandVoice || '',
    when: m.when || 'now', at: m.at || null, approvalMode: m.approvalMode || 'auto', perMinute: head.perMinute == null ? null : S.num(head.perMinute),
  };
}
async function updateGroup(user, key, b) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const { group: g, reqs } = f;
  if (g.rows.some((r) => r.status !== 'draft')) return { error: 'Only a campaign that was never sent can be changed.', status: 409 };
  if (!(await Camp.canControl(user, g.rows[0], reqs))) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  const { objective, type } = gatherBody(b);
  if (type !== g.rows[0].type) return { error: 'A staff message and a candidate message cannot be swapped. Make a new campaign.', status: 400 };
  const name = S.clip(b.name, 80);
  if (name.length < 2) return { error: 'Give the campaign a name.', status: 400 };
  const vc = validChannels(b.channels); if (vc.error) return vc;
  const rq = type === 'job_promotion' && b.requirementId ? await prisma.requirement.findUnique({ where: { id: String(b.requirementId) } }).catch(() => null) : null;
  const meta = { groupName: name, objective: objective.label, tag: S.clip(b.tag, 60), goal: S.clip(b.goal, 600), masterMessage: S.clip(b.masterMessage, 2000), cta: S.clip(b.cta, 80), brandVoice: S.clip(b.brandVoice, 40), department: await departmentFor(user, rq), approvalMode: b.approvalMode === 'approval' ? 'approval' : 'auto', when: b.when === 'at' ? 'at' : 'now', at: b.when === 'at' ? b.at || null : null };
  const have = new Map(g.rows.map((r) => [chanOf(r), r]));
  // channels taken out go; channels added are made; the rest are changed
  for (const [ch, r] of have) if (!vc.channels.includes(ch)) { const d = await Camp.removeDraft(user, r.id); if (d.error) return d; } // eslint-disable-line no-await-in-loop
  for (const ch of vc.channels) {
    const body = { ...bodyFor(b, ch, type), name: vc.channels.length > 1 ? `${name} · ${CH_WORDS[ch]}` : name, allowNoTemplate: b.saveOnly === true, meta: { ...meta, groupId: g.key } };
    const r = have.get(ch);
    const out = r ? await Camp.update(user, r.id, body) : await Camp.create(user, { ...body, kind: objective.kind || undefined }); // eslint-disable-line no-await-in-loop
    if (out.error) return { ...out, error: `${CH_WORDS[ch]}: ${out.error}` };
  }
  const rows = await Camp.groupRows(g.key);
  for (const r of rows) await S.run('UPDATE "OutreachCampaign" SET kind = ? WHERE id = ?', objective.kind || null, r.id).catch(() => {}); // eslint-disable-line no-await-in-loop
  await Act.log(rows[0], 'edited', `Changed by ${S.clip(user.name, 60)}.`, user);
  if (b.saveOnly === true) return { ok: true, key: g.key, status: 'notsent', message: `"${name}" is saved as not sent yet.` };
  const needs = await Appr.needsApproval(user);
  if (b.approvalMode === 'approval' || needs) { const r = await Appr.submit(user, g.key); if (r.error && r.status !== 409) return r; return { ok: true, key: g.key, status: 'approval', message: `"${name}" is waiting for approval.` }; }
  return sendGroup(user, g.key, { when: b.when === 'at' ? 'at' : 'now', at: b.at });
}

async function sendGroup(user, key, { when, at } = {}) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const drafts = f.group.rows.filter((r) => r.status === 'draft');
  if (!drafts.length) return { error: 'This campaign was already sent.', status: 409 };
  const results = [];
  for (const r of drafts) {
    const out = await Camp.send(user, r.id, { when: when === 'at' ? 'at' : 'now', at }); // eslint-disable-line no-await-in-loop
    results.push({ channel: chanOf(r), ok: !out.error, error: out.error || null, quietNote: out.quietNote || null, status: out.status, mode: out.mode || null });
  }
  const bad = results.find((x) => !x.ok);
  if (bad && results.every((x) => !x.ok)) return { error: `${CH_WORDS[bad.channel]}: ${bad.error}`, status: 409, results };
  const note = results.map((x) => x.quietNote).filter(Boolean)[0] || '';
  const mode = (results.find((x) => x.ok) || {}).mode;
  return { ok: true, key: f.group.key, status: when === 'at' ? 'scheduled' : 'live', partial: !!bad, message: `${bad ? `${CH_WORDS[bad.channel]} could not be sent: ${bad.error} ` : ''}${when === 'at' ? `Scheduled.${note ? ` ${note}` : ''}` : (mode === 'rehearsal' ? 'Running as a rehearsal (Test mode: nothing is really sent).' : 'Sending now.')}`, results };
}
// pause | resume | stop on every channel row it applies to
async function controlGroup(user, key, action) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const okFrom = { pause: ['running', 'scheduled'], resume: ['paused'], stop: ['running', 'scheduled', 'paused', 'draft', 'preparing'] }[action];
  if (!okFrom) return { error: 'Unknown action.', status: 400 };
  const rows = f.group.rows.filter((r) => okFrom.includes(r.status));
  if (!rows.length) return { error: action === 'pause' ? 'Only a running or scheduled campaign can be paused.' : (action === 'resume' ? 'Only a paused campaign can be resumed.' : 'This campaign has already finished.'), status: 409 };
  let word = ''; let err = null;
  for (const r of rows) { const out = await Camp.control(user, r.id, action); if (out.error) err = err || out; else word = out.ok; } // eslint-disable-line no-await-in-loop
  if (err && !word) return err;
  const name = groupName(f.group);
  return { ok: action === 'pause' ? `"${name}" paused — nothing further will send.` : (action === 'resume' ? `"${name}" resumed.` : `"${name}" stopped. ${word}`), key: f.group.key };
}
async function removeGroup(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  if (f.group.rows.some((r) => r.status !== 'draft')) return { error: 'Only a campaign that was never sent can be deleted. Use Stop for a running campaign.', status: 409 };
  const name = groupName(f.group);
  for (const r of f.group.rows) { const out = await Camp.removeDraft(user, r.id); if (out.error) return out; } // eslint-disable-line no-await-in-loop
  return { ok: `"${name}" deleted.` };
}
async function resendGroup(user, key) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  let total = 0; let err = null;
  for (const r of f.group.rows) { const out = await Camp.resendFailed(user, r.id); if (out.error) err = err || out; else total += out.requeued; } // eslint-disable-line no-await-in-loop
  if (!total) return err || { error: 'There are no failed messages to send again.', status: 409 };
  return { ok: `${total} failed ${total === 1 ? 'message was' : 'messages were'} put back to go again.`, requeued: total };
}
// a copy: same words, same people, NOT sent yet, zero numbers. name: asked for; must be free.
async function duplicateGroup(user, key, name) {
  const f = await loadOne(user, key);
  if (f.error) return f;
  const nm = S.clip(name, 80);
  if (!nm) return { error: 'Give the campaign a name.', status: 400 };
  const { groups } = await loadGroups(user, '');
  if (groups.some((g) => groupName(g).toLowerCase() === nm.toLowerCase())) return { error: 'A campaign with that name already exists.', status: 409 };
  const shape = { name: nm, ...(await shapeOf(f.group, f.reqs)), saveOnly: true };
  const out = await createGroup(user, shape);
  if (out.error) return out;
  const rows = await Camp.groupRows(out.key);
  if (rows.length) await Act.log(rows[0], 'copied', `Copied from "${S.clip(groupName(f.group), 60)}" by ${S.clip(user.name, 60)}.`, user);
  return { ok: `"${nm}" created as not sent yet.`, key: out.key };
}
async function shapeOf(g, reqs) {
  const head = g.rows[0]; const m = metaOf(head);
  const templates = {}; const varMap = {};
  g.rows.forEach((r) => { if (r.templateId) templates[chanOf(r)] = r.templateId; const vm = metaOf(r).varMap; if (vm && vm.length) varMap[chanOf(r)] = vm; });
  const o = OBJECTIVES.find((x) => x.label === m.objective) || (head.type === 'internal' ? OBJECTIVES.find((x) => x.id === 'staff') : OBJECTIVES.find((x) => x.kind && x.kind === head.kind) || OBJECTIVES[1]);
  return { objective: o.id, tag: m.tag || '', goal: m.goal || '', requirementId: head.requirementId || null, segmentIds: S.parse(head.segmentIds, []), channels: g.rows.map((r) => chanOf(r)), templates, varMap, masterMessage: m.masterMessage || '', cta: m.cta || '', brandVoice: m.brandVoice || '', approvalMode: m.approvalMode || 'auto', perMinute: head.perMinute == null ? null : S.num(head.perMinute) };
}

module.exports = {
  OBJECTIVES, STATUS, list, exportCsv, exportRow, detail, saveMaster, audience, replies, analytics, analyticsCsv, logs, logsCsv, options, readiness, planAudience, review, createGroup, editShape, updateGroup,
  sendGroup, controlGroup, removeGroup, resendGroup, duplicateGroup, loadOne, groupName, metricsFor, groupStatus,
};
