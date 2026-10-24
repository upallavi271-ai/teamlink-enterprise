// ---------------------------------------------------------------------------
// CAMPAIGNS (Phase 3, widened 2026-10-17 for the Green Start rebuild). A campaign = what is promoted (a JOB, or an internal staff message), who gets it
// (groups), the way (Email | WhatsApp | SMS | Call), the words (a template) and when. Pressing Send turns it into one queue row per person
// (OutreachMessage); the worker (runner.js) sends. ONE campaign row has ONE channel. The prototype publishes ONE master campaign to several channels:
// that is a GROUP of campaign rows sharing meta.groupId (outreach/gsCampaigns.js makes and lists them); the engine below only knows single rows.
//
//   status   draft -> preparing (rows are being made) -> running | scheduled -> done | stopped,  and paused (resume goes back)
//            "Waiting for approval" / "Changes needed" are NOT statuses: the column `approval` says it (outreach/approval.js); the status stays draft.
//   mode     fixed when Send is pressed: 'rehearsal' while Test mode is on (all rows and logs, NOTHING handed to a provider) or 'live'. A CALL campaign is always 'live'
//            (a person rings; nothing is sent by the machine).
//   WHO MAY   create / send a job promotion: Admin, BDE, BDE TL, TL / STL, only for a job in their own area (jobPublish/access.inScope).
//            Manager / AM look. Recruiter looks at the campaigns of the jobs assigned to them, no buttons. HR desk: internal campaigns
//            only, and only if an Admin ticked "Internal HR may send". Opt-in again stays Admin only (consent.js).
//   CHANNELS email: template with subject + {{unsubscribe}}.  whatsapp: a Meta-APPROVED template (waTemplateName; variables go by ORDER of the {{words}} in the
//            text to Meta's positional {{1}} {{2}}: campaign meta.varMap).  sms: DLT template id + sender id on the template.  call: no template; each person
//            becomes a CALL TASK (OutreachMessage channel 'call', status 'queued' = "To call"); a person logs it (markCall); the runner never claims a call row.
//            OutreachCampaign.channel only allows email | whatsapp | sms (table CHECK): a call campaign keeps 'sms' there and 'call' in meta.channel (suppress.chanOf).
//   LINKS    a job promotion message carries a SHORT link on our own domain (/r/<token>) that counts the first human click and redirects to the
//            job portal apply URL <portal>/?cid=<campaign code>&ctk=<token>&ch=<e|w|s>#/job/tl_<job>. The target is ALWAYS built here from the
//            campaign's job, never from the URL asked for. INTERNAL campaigns never get a token, a tracked link or a funnel event.
//   TEXT     the client's name is never put in a message: {{company}} is the sender's own name (Outreach "From name", default TeamLink).
//   CREDITS  plan() / send() work out credits needed (cost per message x people who will get it) against the creator's credits left; a LIVE send is blocked
//            when not enough (an exempt login has no limit). Test mode costs nothing.
// Audit rows carry ids and counts only (no phone, no email).
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');
const S = require('./store');
const A = require('./access');
const G = require('./segments');
const T = require('./templates');
const L = require('./links');
const Sup = require('./suppress');
const Quiet = require('./quiet');
const Ev = require('./events');
const Health = require('./health');
const Act = require('./campaignActivity');
const adapters = require('./adapters');
const core = require('../utils/messagingCore');
const { logAudit } = require('../utils/audit');

const STATUS_WORDS = { draft: 'Not sent yet', preparing: 'Getting ready', scheduled: 'Scheduled', running: 'Running', paused: 'Paused', done: 'Done', stopped: 'Stopped' };
const WAITING = ['queued', 'sending'];
const SENT_LIKE = ['sent', 'test_captured', 'delivered', 'bounced', 'complained'];
const CH_WORDS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS', call: 'Voice (calls)' };
const chanOf = Sup.chanOf;
const dbChannel = (ch) => (ch === 'call' ? 'sms' : ch); // the table only allows email | whatsapp | sms
const v3 = () => require('./v3schema').ensure(); // eslint-disable-line global-require

const jobAccess = () => require('../jobPublish/access'); // eslint-disable-line global-require
const bridge = () => require('../utils/jobPortalBridge'); // eslint-disable-line global-require
const base = () => String(process.env.APP_BASE_URL || '').replace(/\/+$/, '');
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || '';
const metaOf = (r) => { const m = S.parse(r && r.meta, null); return m && typeof m === 'object' ? m : {}; };

// ---- the links in a message -------------------------------------------------------------
// the short link in the text. /r/<token> is mounted at the site root AND under /api/public/outreach (a dev site proxies /api only);
// OUTREACH_SHORT_PATH=root puts the pure /r/<token> form in messages once the host forwards /r to the API.
function shortLink(token) {
  return process.env.OUTREACH_SHORT_PATH === 'root' ? L.shortUrl(base(), token) : `${base()}/api/public/outreach/r/${token}`;
}
// where a click goes: built from the campaign's own job, never from the request
function targetUrl(campaign, message) {
  return L.applyUrl(bridge().jobUrl(campaign.requirementId), { campaignCode: campaign.code, token: message.token, channel: message.channel || chanOf(campaign) || 'email' });
}
function companyName(st) { return (st && st.fromName) || 'TeamLink'; }

// fill the template for one person. `message.token` is null for internal campaigns (no apply link at all).
// channel 'email' (default) -> { subject, body, unsubscribeUrl }.  'whatsapp' | 'sms' -> { subject: '', body, vars } (vars = the positional values for Meta, by snapshot.varMap).
function renderFor(snapshot, { contact, requirement, message, settings }, channel = 'email') {
  const apply = message && message.token ? shortLink(message.token) : '';
  const values = { name: firstName(contact.name) || 'there', job_title: requirement ? requirement.title : '', company: companyName(settings), apply_link: apply };
  if (channel === 'whatsapp' || channel === 'sms') {
    const out = T.render({ channel, subject: '', body: snapshot.body }, values); // {{unsubscribe}} -> "Reply STOP to opt out"
    const order = Array.isArray(snapshot.varMap) && snapshot.varMap.length ? snapshot.varMap : varOrder(snapshot.body);
    return { subject: '', body: out.body, vars: order.map((v) => String(values[v] == null ? '' : values[v])) };
  }
  const t = { channel: 'email', subject: snapshot.subject, body: snapshot.body };
  const unsub = L.unsubscribeUrl(base(), L.mintUnsubscribe(contact.id, 'email', message && message.id));
  const out = T.render(t, { ...values, unsubscribe: unsub });
  return { subject: out.subject, body: out.body, unsubscribeUrl: unsub };
}
// the {{words}} of a text in the order they first appear, without {{unsubscribe}} (that one is a fixed line, not a Meta variable)
function varOrder(body) {
  const seen = [];
  [...String(body || '').matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].forEach((m) => { if (T.VARS.includes(m[1]) && m[1] !== 'unsubscribe' && !seen.includes(m[1])) seen.push(m[1]); });
  return seen;
}

// ---- views ----------------------------------------------------------------------------------
// v2 (2026-10-17): campaign types and promotion types are LABELS on the one campaign engine (column OutreachCampaign.kind, added by migration 20261016200000_omni_sequences and self-provisioned below)
const KINDS = {
  recruitment: ['Recruitment campaign', 'campaign'], job: ['Requirement campaign', 'campaign'], client: ['Client campaign', 'campaign'], referral: ['Referral campaign', 'campaign'],
  job_promotion: ['Job promotion', 'promotion'], walkin: ['Walk-in drive', 'promotion'], hiring_event: ['Hiring event', 'promotion'], candidate_promotion: ['Candidate promotion', 'promotion'], referral_promotion: ['Referral promotion', 'promotion'],
};
const TABS = { active: ['running', 'paused', 'preparing'], scheduled: ['scheduled'], notsent: ['draft'], completed: ['done', 'stopped'] };
let kindOk = false;
async function ensureKind() {
  try { await v3(); } catch { /* never stops a screen */ }
  if (kindOk) return;
  try {
    const cols = await S.q('PRAGMA table_info("OutreachCampaign")');
    if (cols.length && !cols.some((c) => c.name === 'kind')) await S.run('ALTER TABLE "OutreachCampaign" ADD COLUMN "kind" TEXT');
    kindOk = cols.length > 0;
  } catch { /* the campaign tables are not there yet */ }
}
const kindOf = (r) => (r.kind && KINDS[r.kind] ? r.kind : (r.type === 'internal' ? null : 'job'));
const view = (r) => ({
  kind: kindOf(r), kindWords: kindOf(r) ? KINDS[kindOf(r)][0] : 'Staff message', kindGroup: kindOf(r) ? KINDS[kindOf(r)][1] : 'campaign',
  id: r.id, code: r.code, name: r.name, type: r.type, status: r.status, statusWords: STATUS_WORDS[r.status] || r.status, mode: r.mode || null,
  requirementId: r.requirementId || null, segmentIds: S.parse(r.segmentIds, []), channel: chanOf(r), channelWords: CH_WORDS[chanOf(r)], templateId: r.templateId || null,
  templateName: (S.parse(r.templateSnapshot, null) || {}).name || null, scheduledAt: S.iso(r.scheduledAt), startedAt: S.iso(r.startedAt), completedAt: S.iso(r.completedAt),
  suppressDays: r.suppressDays, summary: S.parse(r.planSummary, null), lastError: r.lastError || null, createdById: r.createdById, createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt),
  groupId: metaOf(r).groupId || null, approval: r.approval || null, perMinute: r.perMinute == null ? null : S.num(r.perMinute),
});
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
const ph = (n) => new Array(n).fill('?').join(',');

// per campaign: waiting / sent (sent-like) / delivered / read / replied / clicked / applied / failed / skipped / cancelled / total, plus rehearsed (nothing really sent) and called
async function countsFor(ids) {
  await v3();
  const out = {};
  ids.forEach((id) => { out[id] = { waiting: 0, sent: 0, delivered: 0, read: 0, replied: 0, clicked: 0, applied: 0, failed: 0, skipped: 0, cancelled: 0, rehearsed: 0, total: 0 }; });
  for (const part of chunk(ids, 400)) {
    const rows = await S.q(`SELECT campaignId, status, COUNT(*) n, SUM(CASE WHEN firstClickAt IS NOT NULL THEN 1 ELSE 0 END) c, SUM(CASE WHEN readAt IS NOT NULL THEN 1 ELSE 0 END) rd, SUM(CASE WHEN repliedAt IS NOT NULL THEN 1 ELSE 0 END) rp FROM "OutreachMessage" WHERE campaignId IN (${ph(part.length)}) GROUP BY campaignId, status`, ...part); // eslint-disable-line no-await-in-loop
    rows.forEach((r) => {
      const c = out[r.campaignId]; const n = S.num(r.n);
      c.total += n; c.clicked += S.num(r.c); c.read += S.num(r.rd); c.replied += S.num(r.rp);
      if (WAITING.includes(r.status)) c.waiting += n;
      if (SENT_LIKE.includes(r.status)) c.sent += n;
      if (r.status === 'delivered') c.delivered += n;
      if (r.status === 'test_captured') c.rehearsed += n;
      if (['failed', 'bounced', 'complained', 'unknown'].includes(r.status)) c.failed += n;
      if (r.status === 'skipped') c.skipped += n;
      if (r.status === 'cancelled') c.cancelled += n;
    });
    const ap = await S.q(`SELECT campaignId, COUNT(*) n FROM "OutreachEvent" WHERE type = 'applied' AND campaignId IN (${ph(part.length)}) GROUP BY campaignId`, ...part); // eslint-disable-line no-await-in-loop
    ap.forEach((r) => { out[r.campaignId].applied = S.num(r.n); });
  }
  return out;
}

// ---- who sees / controls what ----------------------------------------------------------------------
async function reqRows(ids) {
  const uniq = [...new Set(ids.filter(Boolean))];
  const out = new Map();
  for (const part of chunk(uniq, 400)) (await prisma.requirement.findMany({ where: { id: { in: part } } })).forEach((r) => out.set(r.id, r)); // eslint-disable-line no-await-in-loop
  return out;
}
const jobScopeOk = (user, r) => !!(r && jobAccess().inScope(user, r));
async function internalMayRun(user) {
  const k = A.kind(user);
  if (k === 'admin') return true;
  return k === 'hr' && (await S.settings()).internalHrMaySend === true;
}
// may this login SEE the campaign
function canSee(user, row, reqs) {
  const k = A.kind(user);
  if (k === 'none') return false;
  if (k === 'admin') return true;
  if (row.type === 'internal') return k === 'hr';
  if (k === 'hr') return false;
  if (row.createdById === user.id && A.mayCampaign(user)) return true;
  return jobScopeOk(user, reqs.get(row.requirementId));
}
// may this login send / pause / stop it (the people who may run a job promotion, for a job in their area; or its creator; or an Admin)
async function canControl(user, row, reqs) {
  const k = A.kind(user);
  if (k === 'admin') return true;
  if (row.type === 'internal') return k === 'hr' && (await internalMayRun(user)) && row.createdById === user.id;
  if (!A.mayCampaign(user)) return false;
  return jobScopeOk(user, reqs.get(row.requirementId)) || row.createdById === user.id;
}

async function list(user, { status, q, page = 1, pageSize = 20, type, tab, kind, group } = {}) {
  await ensureKind();
  const rows = await S.q('SELECT * FROM "OutreachCampaign" ORDER BY createdAt DESC, id DESC');
  const reqs = await reqRows(rows.map((r) => r.requirementId));
  let vis = rows.filter((r) => canSee(user, r, reqs));
  if (type) vis = vis.filter((r) => r.type === type);
  if (group) vis = vis.filter((r) => (kindOf(r) ? KINDS[kindOf(r)][1] : 'campaign') === group);
  if (kind && KINDS[kind]) vis = vis.filter((r) => kindOf(r) === kind);
  const tabs = {}; Object.keys(TABS).forEach((t) => { tabs[t] = vis.filter((r) => TABS[t].includes(r.status)).length; });
  if (tab && TABS[tab]) vis = vis.filter((r) => TABS[tab].includes(r.status));
  const facets = {};
  vis.forEach((r) => { facets[r.status] = (facets[r.status] || 0) + 1; });
  if (status) vis = vis.filter((r) => r.status === status);
  const needle = String(q || '').trim().toLowerCase();
  if (needle) vis = vis.filter((r) => `${r.name} ${(reqs.get(r.requirementId) || {}).title || ''}`.toLowerCase().includes(needle));
  const total = vis.length;
  const pg = Math.max(1, Math.floor(Number(page)) || 1); const ps = Math.min(100, Math.max(1, Math.floor(Number(pageSize)) || 20));
  const slice = vis.slice((pg - 1) * ps, pg * ps);
  const counts = await countsFor(slice.map((r) => r.id));
  const out = [];
  const e = slice.length ? await Health.env() : null; // one look at the settings for the whole page: why each campaign is held
  for (const r of slice) {
    const rq = reqs.get(r.requirementId);
    out.push({ ...view(r), counts: counts[r.id], health: Health.summarize(Health.holdReasons(r, counts[r.id], e, null)), job: rq ? { id: rq.id, title: rq.title, reqCode: rq.reqCode || null } : null, can: await abilities(user, r, reqs) }); // eslint-disable-line no-await-in-loop
  }
  const st = await S.settings();
  return { campaigns: out, total, page: pg, pageSize: ps, facets, tabs, canCreate: A.mayCampaign(user), sendingOn: st.master, testMode: st.emailTestMode };
}
async function abilities(user, row, reqs) {
  const ctl = await canControl(user, row, reqs);
  return {
    send: ctl && row.status === 'draft', pause: ctl && ['running', 'scheduled'].includes(row.status), resume: ctl && row.status === 'paused',
    stop: ctl && ['running', 'scheduled', 'paused', 'draft'].includes(row.status), remove: ctl && row.status === 'draft',
  };
}
async function rowFor(user, id) {
  const row = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', id))[0];
  if (!row) return { error: 'This campaign was not found.', status: 404 };
  const reqs = await reqRows([row.requirementId]);
  if (!canSee(user, row, reqs)) return { error: 'This campaign was not found.', status: 404 };
  return { row, reqs };
}
async function get(user, id) {
  await ensureKind();
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row, reqs } = f;
  const rq = reqs.get(row.requirementId);
  const counts = (await countsFor([row.id]))[row.id];
  const funnel = await Ev.funnel(row.id);
  const reasons = (await S.q('SELECT reason, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND reason IS NOT NULL GROUP BY reason ORDER BY n DESC', row.id)).map((r) => ({ reason: r.reason, words: Sup.REASON_WORDS[r.reason] || r.reason, group: Sup.groupOf(r.reason), n: S.num(r.n) }));
  const segs = [];
  for (const sid of S.parse(row.segmentIds, [])) { const s = (await S.q('SELECT id, name FROM "OutreachSegment" WHERE id = ?', sid))[0]; if (s) segs.push(s); }
  const st = await S.settings();
  return {
    campaign: { ...view(row), job: rq ? { id: rq.id, title: rq.title, reqCode: rq.reqCode || null } : null, segments: segs },
    counts, funnel, reasons, can: await abilities(user, row, reqs), masked: A.masked(user),
    health: Health.summarize(Health.holdReasons(row, counts, await Health.env(), await Health.lastNote(row.id))),
    notes: { sendingOff: !st.master, testMode: st.emailTestMode, rehearsal: row.mode === 'rehearsal' },
  };
}

// the campaigns this login may see (rows), for the message log
async function visibleRows(user) {
  const rows = await S.q('SELECT * FROM "OutreachCampaign" ORDER BY createdAt DESC, id DESC');
  const reqs = await reqRows(rows.map((r) => r.requirementId));
  return rows.filter((r) => canSee(user, r, reqs));
}
// one campaign's message log: the same function as the global log (messageLog.js), narrowed to this campaign
async function messages(user, id, { status, reason, q, page = 1, pageSize = 50, channel, from, to } = {}) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  return require('./messageLog').list(user, { campaignId: id, status, reason, q, page, pageSize, channel, from, to }); // eslint-disable-line global-require
}

// ---- the job picker ------------------------------------------------------------------------------------
async function jobs(user, { q } = {}) {
  if (!A.mayCampaign(user)) return { jobs: [] };
  const where = { AND: [{ status: 'OPEN' }, require('../utils/scope').requirementWhere(user)] }; // eslint-disable-line global-require
  const needle = String(q || '').trim();
  if (needle) where.AND.push({ OR: [{ title: { contains: needle } }, { reqCode: { contains: needle } }, { department: { contains: needle } }, { location: { contains: needle } }] });
  const rows = await prisma.requirement.findMany({ where, orderBy: { createdAt: 'desc' }, take: 60 });
  return {
    jobs: rows.filter((r) => jobScopeOk(user, r)).map((r) => ({ id: r.id, title: r.title, reqCode: r.reqCode || null, department: r.department || '', location: r.location || '', openings: r.openings, onPortal: !!r.portalPublished })),
  };
}

// ---- credits: what a send needs against what the creator has left ---------------------------------------------
// -> { cost, needed, left (null = no limit), exempt, enforce, enough, testMode }.  Test mode costs nothing; an exempt login or "not enforced" is never short.
async function creditsFor(userId, channel, people, { testMode = false } = {}) {
  const Cr = require('./credits'); // eslint-disable-line global-require
  const cs = await Cr.settings();
  const cost = cs.cost[channel] || 0;
  const needed = testMode ? 0 : cost * people;
  let exempt = true; let left = null;
  try {
    await Cr.ensureTables();
    const p = await Cr.personOf(userId);
    exempt = Cr.isExempt(cs, p);
    if (!exempt) { const allowance = await Cr.allowanceOf(cs, userId); left = Math.max(0, allowance - (await Cr.usedBy(userId))); }
  } catch { exempt = true; }
  return { cost, needed, left, exempt, enforce: cs.enforce, testMode, enough: testMode || exempt || !cs.enforce || !cost || needed <= left };
}

// ---- checks shared by the plan, the draft and the send ---------------------------------------------------------
// returns { error, status } or { type, channel, requirement, segmentIds, template, snapshot, varMap }
async function validate(user, b, { needSegments = true, needName = false, needTemplate = true } = {}) {
  const type = b.type === 'internal' ? 'internal' : 'job_promotion';
  const channel = b.channel === undefined || b.channel === null || b.channel === '' ? 'email' : String(b.channel).toLowerCase();
  if (!Sup.CHANNELS.includes(channel)) return { error: 'Pick Email, WhatsApp, SMS or Voice (calls) for this campaign.', status: 400, code: 'channel_unknown' };
  if (type === 'internal') { if (!(await internalMayRun(user))) return { error: A.kind(user) === 'hr' ? 'An Admin has not allowed the HR desk to send. Ask an Admin to tick "Internal HR may send".' : 'Only an Admin or the HR desk can send internal messages.', status: 403 }; } else if (!A.mayCampaign(user)) return { error: 'You can look at campaigns, but only the BDE team, Team Leads and Admins can send them.', status: 403 };
  let requirement = null;
  if (type === 'job_promotion') {
    if (!b.requirementId) return { error: 'Pick the requirement you want to promote.', status: 400 };
    requirement = await prisma.requirement.findUnique({ where: { id: String(b.requirementId) } });
    if (!requirement || !jobScopeOk(user, requirement)) return { error: 'This requirement is not in your area.', status: 403 };
    if (!require('../utils/atsVocab').requirementIsLive(requirement.status) || requirement.status !== 'OPEN') return { error: 'This requirement is not open, so there is nothing to promote.', status: 400 }; // eslint-disable-line global-require
  }
  const segmentIds = [...new Set((Array.isArray(b.segmentIds) ? b.segmentIds : []).map(String))].slice(0, 20);
  if (needSegments && !segmentIds.length) return { error: 'Pick at least one group of people.', status: 400 };
  for (const sid of segmentIds) {
    const seg = await G.get(user, sid);
    if (!seg) return { error: 'One of the groups was not found, or is not yours.', status: 403 };
    if (type === 'job_promotion' && seg.contactType !== 'candidate_lead') return { error: 'Promotion messages cannot go to an internal group.', status: 403, code: 'internal_contact' };
    if (type === 'internal' && seg.contactType !== 'internal') return { error: 'This group is not an internal group.', status: 403, code: 'not_internal' };
  }
  if (channel === 'call') { // no template: a person rings, with this script in front of them
    return { type, channel, requirement, segmentIds, template: null, snapshot: { name: 'Call script', subject: '', body: S.clip(b.script || b.masterMessage, 2000) }, varMap: [] };
  }
  if (!b.templateId && !needTemplate) return { type, channel, requirement, segmentIds, template: null, snapshot: null, varMap: [] };
  if (!b.templateId) return { error: 'Pick the message to send.', status: 400 };
  const tr = (await S.q('SELECT * FROM "OutreachTemplate" WHERE id = ?', String(b.templateId)))[0];
  if (!tr || tr.status !== 'active') return { error: 'This message template was not found.', status: 404 };
  { // the shared template library (outreach/omni/library.js): this app may use it, it is approved, and this login may see it (department)
    let g = null;
    try { g = await require('./omni/library').gateOutreach(user, tr.id, 'Omni-Channel'); } catch (e) { g = { error: 'The template library could not be checked just now. Please try again.', status: 503, code: 'tpl_check' }; } // eslint-disable-line global-require
    if (g) return { error: g.error, status: g.status, code: g.code };
  }
  const want = type === 'internal' ? 'internal' : 'candidate_lead';
  if (tr.audience !== want) return { error: type === 'internal' ? 'Pick an internal message template.' : 'Pick a message template for job promotions (not an internal one).', status: 400 };
  if (tr.channel !== channel) return { error: channel === 'email' ? 'Pick an email message.' : `Pick a ${CH_WORDS[channel]} message.`, status: 400 };
  const tv = T.view(tr);
  if (channel === 'whatsapp') {
    if (tr.waApprovalStatus !== 'approved') return { error: 'WhatsApp has not approved this message yet. Pick an approved one, or wait for Meta to approve it.', status: 400, code: 'wa_not_approved' };
    if (!S.clip(tr.waTemplateName, 120)) return { error: 'This WhatsApp message has no template name. Open it in Manage Templates and add the name Meta approved.', status: 400, code: 'wa_no_name' };
  } else if (channel === 'sms') {
    if (!(tr.dltTemplateId && tr.senderId)) return { error: 'Add the DLT template number and the sender ID to this SMS message first.', status: 400, code: 'sms_no_dlt' };
  } else if (!tv.ready) return { error: tv.why, status: 400 };
  const probs = T.problems({ ...tv, audience: tr.audience, promotional: true });
  const vars = [...String(`${tr.body} ${tr.subject || ''}`).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)].map((m) => m[1]);
  if (channel === 'email' && !vars.includes('unsubscribe')) probs.unshift('The message must tell people how to stop it. Add {{unsubscribe}} to the message.');
  if (type === 'job_promotion' && !vars.includes('apply_link')) probs.unshift('The message needs the apply link. Add {{apply_link}} to the message.');
  if (probs.length) return { error: probs[0], problems: probs, status: 400, code: 'template' };
  if (needName && S.clip(b.name, 80).length < 2 && type === 'internal') return { error: 'Give the campaign a name.', status: 400 };
  // WhatsApp: the {{words}} go to Meta's positional variables in the order picked (default = the order they appear in the text)
  let varMap = [];
  if (channel === 'whatsapp') {
    const given = Array.isArray(b.varMap) ? b.varMap.map(String) : null;
    if (given && (given.some((v) => !T.VARS.includes(v) || v === 'unsubscribe'))) return { error: 'One of the WhatsApp variables is not a known word.', status: 400, code: 'varmap' };
    varMap = given && given.length ? given : varOrder(tr.body);
  }
  const snapshot = { name: tr.name, subject: tr.subject || '', body: tr.body };
  if (channel === 'whatsapp') { snapshot.waTemplateName = tr.waTemplateName; snapshot.waLanguage = tr.waLanguage || 'en'; snapshot.varMap = varMap; }
  if (channel === 'sms') { snapshot.dltTemplateId = tr.dltTemplateId; snapshot.senderId = tr.senderId; }
  return { type, channel, requirement, segmentIds, template: tr, snapshot, varMap };
}

// ---- the plan (live counts) ---------------------------------------------------------------------------------
async function plan(user, b) {
  const v = await validate(user, b, { needTemplate: !!b.templateId && b.channel !== 'call' });
  if (v.error) return v;
  const st = await S.settings();
  const m = await Sup.members(v.segmentIds, v.type);
  const camp = { id: '', type: v.type, channel: dbChannel(v.channel), meta: { channel: v.channel }, requirementId: v.requirement ? v.requirement.id : null, suppressDays: st.suppressDays };
  const res = await Sup.evaluate(camp, m.ids, { days: st.suppressDays });
  const t = Sup.tally(res);
  const adapter = await adapters.get(v.channel).status();
  const warnings = [];
  if (v.requirement && !v.requirement.portalPublished) warnings.push('This job is not on the Job Portal yet, so the apply link will not open a job page. Publish the job first.');
  if (!st.master && v.channel !== 'call') warnings.push('Outreach sending is switched OFF by an Admin. You can get everything ready, but nothing goes out until an Admin switches it on.');
  if (!adapter.ready && !st.emailTestMode && v.channel !== 'call') warnings.push(`${CH_WORDS[v.channel]} is not ready: ${adapter.reason}`);
  const sample = res.find((r) => r.decision.send && r.contact) || res.find((r) => r.contact) || null;
  let out = { subject: '', body: '' };
  const sampleContact = { id: 'sample', name: sample && sample.contact ? sample.contact.name : 'Anita' };
  if (v.snapshot && v.channel !== 'call') out = renderFor(v.snapshot, { contact: sampleContact, requirement: v.requirement, message: { id: 'sample', token: v.type === 'job_promotion' ? 'SAMPLETOKEN' : null }, settings: st }, v.channel);
  else if (v.snapshot) out = { subject: '', body: v.snapshot.body };
  const cap = v.channel === 'email' ? st.emailDailyCap : (v.channel === 'whatsapp' ? st.waDailyCap : (v.channel === 'sms' ? st.smsDailyCap : null));
  const perMinute = v.channel === 'email' ? st.emailPerMinute : (v.channel === 'whatsapp' ? st.waPerMinute : (v.channel === 'sms' ? st.smsPerMinute : null));
  const mode = v.channel === 'call' ? 'live' : (st.emailTestMode ? 'rehearsal' : 'live');
  return {
    ok: true, channel: v.channel, mode, people: m.ids.length, willGet: t.willGet, skipped: t.skipped, skippedTotal: m.ids.length - t.willGet, reasons: t.reasons, duplicates: m.duplicates,
    groupWords: Sup.GROUP_WORDS, suppressDays: st.suppressDays, testMode: st.emailTestMode, sendingOn: st.master, dailyCap: cap, perMinute, sentToday: adapter.sentToday, warnings,
    credits: await creditsFor(user.id, v.channel, t.willGet, { testMode: mode === 'rehearsal' }),
    preview: { subject: out.subject, body: out.body, sampleName: firstName(sample && sample.contact && sample.contact.name) || 'Anita' },
    job: v.requirement ? { id: v.requirement.id, title: v.requirement.title } : null,
  };
}

// ---- create (a draft) -----------------------------------------------------------------------------------------------------
// b.meta: extra things kept with the campaign (groupId, groupName, objective, tag, goal, masterMessage, cta, department, approvalMode, when, at ...). b.perMinute: this campaign's own speed.
async function create(user, b) {
  if (!(await S.campaignsReady())) return { error: 'Campaigns are being set up. Please try again in a little while.', status: 503 };
  await ensureKind();
  const v = await validate(user, b, { needName: true, needTemplate: b.channel !== 'call' && !b.allowNoTemplate }); // allowNoTemplate: "Save for later" before every message is picked (Send checks it again)
  if (v.error) return v;
  const st = await S.settings();
  const name = S.clip(b.name, 80) || (v.requirement ? `${S.clip(v.requirement.title, 50)} - ${new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10)}` : 'Staff message');
  const id = S.newId('oc'); const now = Date.now();
  let code = '';
  for (let i = 0; i < 5; i += 1) { code = crypto.randomBytes(6).toString('base64url'); if (!(await S.q('SELECT 1 x FROM "OutreachCampaign" WHERE code = ?', code)).length) break; } // eslint-disable-line no-await-in-loop
  const extra = b.meta && typeof b.meta === 'object' ? b.meta : {};
  const meta = { ...extra, channel: v.channel, varMap: v.varMap, origin: extra.origin || 'engine' };
  // WHATSAPP NUMBER (utils/waNumbers.js): the maker's own number, or one they may use; it stays on the campaign
  if (v.channel === 'whatsapp') {
    try {
      const wr = await require('../utils/waNumbers').planNumber(user, { requestedNumberId: b.waNumberId || extra.waNumberId || null }); // eslint-disable-line global-require
      if (!wr.legacy && !wr.ok) return { error: wr.error, status: wr.status || 409, code: wr.code };
      if (wr.ok) {
        meta.waNumberId = wr.number.id; meta.waNumberLabel = wr.number.label;
        // the same template for every number: it must be approved in THIS number's WhatsApp account (plain words instead of Meta's error 132001)
        const bad = v.template && v.template.waTemplateName ? await require('../utils/whatsappCloud').templateAccountProblem(wr.cfg, v.template.waTemplateName) : null; // eslint-disable-line global-require
        if (bad) return { error: bad, status: 409, code: 'TEMPLATE_OTHER_ACCOUNT' };
      }
    } catch { /* no list of numbers: the old single connection */ }
  }
  const chanMax = v.channel === 'email' ? st.emailPerMinute : (v.channel === 'whatsapp' ? st.waPerMinute : (v.channel === 'sms' ? st.smsPerMinute : null));
  const pm = chanMax && Number.isFinite(Math.floor(Number(b.perMinute))) && Math.floor(Number(b.perMinute)) > 0 ? Math.min(Math.floor(Number(b.perMinute)), chanMax) : null;
  await S.run(`INSERT INTO "OutreachCampaign" (id, code, name, type, requirementId, segmentIds, channel, templateId, templateSnapshot, status, suppressDays, createdById, createdByName, createdAt, updatedAt, meta, perMinute)
    VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,?,?,?)`, id, code, name, v.type, v.requirement ? v.requirement.id : null, JSON.stringify(v.segmentIds), dbChannel(v.channel), v.template ? v.template.id : null, JSON.stringify(v.snapshot), st.suppressDays, user.id, user.name, now, now, JSON.stringify(meta), pm);
  if (b.kind && KINDS[b.kind] && v.type !== 'internal') { try { await S.run('UPDATE "OutreachCampaign" SET kind = ? WHERE id = ?', b.kind, id); } catch { /* the label is optional */ } }
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach campaign created', entity: 'OutreachCampaign', entityId: id, toValue: `${v.type}, ${v.channel}, ${v.segmentIds.length} group(s)` });
  await Act.log({ id, meta }, 'created', `Made by ${S.clip(user.name, 60)} (${CH_WORDS[v.channel]}).`, user, now);
  return { id, campaign: (await get(user, id)).campaign };
}

// change a campaign that was never sent (the wizard's Edit): the same checks as create
async function update(user, id, b) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row, reqs } = f;
  if (row.status !== 'draft') return { error: 'Only a campaign that was never sent can be changed.', status: 409 };
  if (!(await canControl(user, row, reqs))) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  const cur = metaOf(row);
  const v = await validate(user, { type: row.type, channel: chanOf(row), requirementId: b.requirementId !== undefined ? b.requirementId : row.requirementId, segmentIds: b.segmentIds || S.parse(row.segmentIds, []), templateId: b.templateId !== undefined ? b.templateId : row.templateId, varMap: b.varMap || cur.varMap, script: b.script || b.masterMessage || cur.masterMessage, name: b.name || row.name }, { needTemplate: chanOf(row) !== 'call' && !b.allowNoTemplate });
  if (v.error) return v;
  const st = await S.settings();
  const meta = { ...cur, ...(b.meta && typeof b.meta === 'object' ? b.meta : {}), channel: v.channel, varMap: v.varMap };
  const chanMax = v.channel === 'email' ? st.emailPerMinute : (v.channel === 'whatsapp' ? st.waPerMinute : (v.channel === 'sms' ? st.smsPerMinute : null));
  let pm = row.perMinute == null ? null : S.num(row.perMinute);
  if (b.perMinute !== undefined) pm = chanMax && Number.isFinite(Math.floor(Number(b.perMinute))) && Math.floor(Number(b.perMinute)) > 0 ? Math.min(Math.floor(Number(b.perMinute)), chanMax) : null;
  await S.run('UPDATE "OutreachCampaign" SET name = ?, requirementId = ?, segmentIds = ?, templateId = ?, templateSnapshot = ?, meta = ?, perMinute = ?, updatedAt = ? WHERE id = ? AND status = \'draft\'',
    S.clip(b.name, 80) || row.name, v.requirement ? v.requirement.id : null, JSON.stringify(v.segmentIds), v.template ? v.template.id : null, JSON.stringify(v.snapshot), JSON.stringify(meta), pm, Date.now(), id);
  await Act.log(row, 'edited', `Changed by ${S.clip(user.name, 60)}.`, user);
  return { ok: true, campaign: (await get(user, id)).campaign };
}

// ---- send: make the queue rows (batches, safe to repeat), then run / schedule ----------------------------------------------
const BATCH = 200;
// builds the rows of a campaign in 'preparing' status. INSERT OR IGNORE on UNIQUE(campaignId, contactId): running it twice (a restart
// in the middle) makes the missing rows and nothing else. Returns the counts. A CALL campaign makes call tasks (channel 'call', status 'queued').
async function materialize(campaignId, { now = Date.now(), failAfterBatches = null, batch = BATCH } = {}) {
  const c = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', campaignId))[0];
  if (!c) throw new S.OutreachError('no_campaign', 'Campaign not found.', 404);
  const channel = chanOf(c);
  const m = await Sup.members(S.parse(c.segmentIds, []), c.type);
  const when = c.scheduledAt ? S.ms(c.scheduledAt) : now;
  let queued = 0; let skipped = 0; let batches = 0;
  const reasons = {};
  for (const part of chunk(m.ids, batch)) {
    const res = await Sup.evaluate(c, part, { days: c.suppressDays, now }); // eslint-disable-line no-await-in-loop
    for (const r of res) {
      const key = `${c.id}:${r.contactId}:${channel}`;
      const exists = (await S.q('SELECT id, status FROM "OutreachMessage" WHERE campaignId = ? AND contactId = ?', c.id, r.contactId))[0]; // eslint-disable-line no-await-in-loop
      if (exists) { if (exists.status === 'skipped') { skipped += 1; reasons[exists.reason] = 1 + (reasons[exists.reason] || 0); } else queued += 1; continue; } // eslint-disable-line no-continue
      const mid = S.newId('om');
      if (r.decision.send) {
        const token = c.type === 'job_promotion' && channel !== 'call' ? L.mintTracked({ contactType: r.contact.contactType, campaignType: c.type }) : null; // internal and call: no tracked link
        await S.run('INSERT OR IGNORE INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, token, idempotencyKey, nextRunAt, queuedAt) VALUES (?,?,?,?,?,\'queued\',?,?,?,?)', mid, c.id, r.contactId, channel, c.requirementId, token, key, channel === 'call' ? 0 : when, now); // eslint-disable-line no-await-in-loop
        queued += 1;
      } else {
        await S.run('INSERT OR IGNORE INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, reason, idempotencyKey, nextRunAt, queuedAt) VALUES (?,?,?,?,?,\'skipped\',?,?,?,?)', mid, c.id, r.contactId, channel, c.requirementId, r.decision.reason, key, 0, now); // eslint-disable-line no-await-in-loop
        skipped += 1; reasons[r.decision.reason] = 1 + (reasons[r.decision.reason] || 0);
        await Ev.record('skipped', { id: mid, contactId: r.contactId, campaignId: c.id, requirementId: c.requirementId, channel }, c, { detail: { reason: r.decision.reason }, at: now }); // eslint-disable-line no-await-in-loop
      }
    }
    batches += 1;
    if (failAfterBatches && batches >= failAfterBatches) throw new Error('simulated stop while making the rows'); // used by the crash test only
  }
  return { people: m.ids.length, queued, skipped, reasons, duplicates: m.duplicates };
}

// press Send: when = 'now' | 'at' (at = epoch ms or ISO)
async function send(user, id, b = {}) {
  if (!(await S.campaignsReady())) return { error: 'Campaigns are being set up. Please try again in a little while.', status: 503 };
  await ensureKind();
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row, reqs } = f;
  if (!(await canControl(user, row, reqs))) return { error: 'You can look at this campaign, but you cannot send it.', status: 403 };
  if (row.status !== 'draft') return { error: 'This campaign was already sent.', status: 409 };
  const channel = chanOf(row);
  // approval: a campaign waiting for a Team Lead (or one a BDE has not had approved while the Admin switch is on) cannot be sent
  const blocked = await require('./approval').blocksSend(user, row); // eslint-disable-line global-require
  if (blocked) return { error: blocked, status: 409, code: 'needs_approval' };
  // the same checks as the plan (a job may have closed since the draft was saved; a template may have changed)
  const meta = metaOf(row);
  const v = await validate(user, { type: row.type, channel, requirementId: row.requirementId, segmentIds: S.parse(row.segmentIds, []), templateId: row.templateId, varMap: meta.varMap, script: meta.masterMessage });
  if (v.error) return v;
  const st = await S.settings();
  const mode = channel === 'call' ? 'live' : (st.emailTestMode ? 'rehearsal' : 'live');
  if (mode === 'live' && channel !== 'call') { const a = await adapters.get(channel).status(); if (!a.ready) return { error: `${CH_WORDS[channel]} is not ready: ${a.reason}`, status: 400 }; }
  // credits: a LIVE send needs enough credits (Test mode costs nothing; an exempt login has no limit)
  if (mode === 'live' && channel !== 'call') {
    const m0 = await Sup.members(v.segmentIds, v.type);
    const will = Sup.tally(await Sup.evaluate({ ...row, channel: dbChannel(channel), meta: { channel } }, m0.ids, { days: st.suppressDays })).willGet;
    const cr = await creditsFor(row.createdById, channel, will, { testMode: false });
    if (!cr.enough) return { error: `Not enough credits: this send needs ${cr.needed} and ${cr.left} are left. Ask an Admin for more credits.`, status: 402, code: 'no_credits', credits: cr };
  }
  let at = null;
  if (b.when === 'at' && channel !== 'call') {
    at = typeof b.at === 'number' ? b.at : Date.parse(b.at);
    if (!Number.isFinite(at) || at < Date.now() + 60000) return { error: 'Pick a time at least a minute from now.', status: 400 };
    if (at > Date.now() + 90 * 86400000) return { error: 'You can schedule up to 90 days ahead.', status: 400 };
  }
  // quiet hours: a time inside them is moved to the end of quiet hours (India time), with a plain note
  let quietNote = null;
  if (at != null) { const qh = Quiet.moveOutOfQuiet(at, st.quietHours, row.type); if (qh.moved) { at = qh.at; quietNote = `The time you picked is inside quiet hours, so it will start when quiet hours end (${qh.endLabel}, India time).`; } }
  const now = Date.now();
  const claim = await S.run('UPDATE "OutreachCampaign" SET status = \'preparing\', mode = ?, scheduledAt = ?, suppressDays = ?, templateSnapshot = ?, updatedAt = ? WHERE id = ? AND status = \'draft\'', mode, at, st.suppressDays, JSON.stringify(v.snapshot), now, id);
  if (!claim) return { error: 'This campaign was already sent.', status: 409 };
  let sum;
  try { sum = await materialize(id, { now }); } catch (e) {
    await S.run('UPDATE "OutreachCampaign" SET lastError = ?, updatedAt = ? WHERE id = ?', S.clip(e.message, 200), Date.now(), id); // stays 'preparing': the worker finishes the rows
    await Health.announce(row, 'failed', 'The list of people could not be made completely. It will finish by itself in a moment; tell an Admin if it does not.', { key: `failed:${id}:prepare`, reason: 'prepare_failed', exceptUserId: user.id });
    return { error: 'The send could not be prepared fully. It will finish by itself in a moment.', status: 500 };
  }
  await finishPreparing(id, sum, { at });
  await logAudit({ userId: user.id, actorName: user.name, action: at ? 'Outreach campaign scheduled' : 'Outreach campaign sent', entity: 'OutreachCampaign', entityId: id, toValue: `${channel}; ${mode}; ${sum.queued} queued, ${sum.skipped} skipped${at ? `; at ${new Date(at).toISOString()}` : ''}` });
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach campaign skip summary', entity: 'OutreachCampaign', entityId: id, toValue: Object.entries(sum.reasons).map(([k, n]) => `${k}: ${n}`).join(', ') || 'none skipped' });
  await Act.log(row, at ? 'scheduled' : 'sent', channel === 'call' ? `${sum.queued} call tasks were made by ${S.clip(user.name, 60)}.` : (at ? `Scheduled by ${S.clip(user.name, 60)} for ${new Date(at + 5.5 * 3600000).toISOString().replace('T', ' ').slice(0, 16)} (India time): ${sum.queued} people${mode === 'rehearsal' ? ', rehearsal' : ''}.` : `Sent by ${S.clip(user.name, 60)}: ${sum.queued} people${mode === 'rehearsal' ? ' (rehearsal: nothing really sent)' : ''}.`), user, now);
  try { require('./runner').ensureTimer(); } catch { /* the runner starts with the server */ } // eslint-disable-line global-require
  return { ok: true, queued: sum.queued, skipped: sum.skipped, mode, scheduledAt: at ? new Date(at).toISOString() : null, quietNote, status: at ? 'scheduled' : 'running', campaign: (await get(user, id)).campaign };
}
// preparing -> scheduled | running (once, only from 'preparing')
async function finishPreparing(id, sum, { at } = {}) {
  const now = Date.now();
  const c = (await S.q('SELECT scheduledAt FROM "OutreachCampaign" WHERE id = ?', id))[0];
  const when = at != null ? at : (c && c.scheduledAt ? S.ms(c.scheduledAt) : null);
  const summary = JSON.stringify({ people: sum.people, queued: sum.queued, skipped: sum.skipped, reasons: sum.reasons, duplicates: sum.duplicates });
  if (when && when > now) await S.run('UPDATE "OutreachCampaign" SET status = \'scheduled\', planSummary = ?, lastError = NULL, updatedAt = ? WHERE id = ? AND status = \'preparing\'', summary, now, id);
  else await S.run('UPDATE "OutreachCampaign" SET status = \'running\', startedAt = COALESCE(startedAt, ?), planSummary = ?, lastError = NULL, updatedAt = ? WHERE id = ? AND status = \'preparing\'', now, summary, now, id);
}

// ---- pause / resume / stop / delete a draft -----------------------------------------------------------------------------------
async function control(user, id, action) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row, reqs } = f;
  if (!(await canControl(user, row, reqs))) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  const now = Date.now();
  let done = 0; let word = '';
  if (action === 'pause') {
    if (!['running', 'scheduled'].includes(row.status)) return { error: 'Only a running or scheduled campaign can be paused.', status: 409 };
    done = await S.run('UPDATE "OutreachCampaign" SET status = \'paused\', updatedAt = ? WHERE id = ? AND status IN (\'running\',\'scheduled\')', now, id); word = 'Paused. Nobody else gets a message until you press Resume.';
  } else if (action === 'resume') {
    if (row.status !== 'paused') return { error: 'Only a paused campaign can be resumed.', status: 409 };
    const sch = row.scheduledAt && S.ms(row.scheduledAt) > now ? 'scheduled' : 'running';
    done = await S.run('UPDATE "OutreachCampaign" SET status = ?, startedAt = CASE WHEN ? = \'running\' THEN COALESCE(startedAt, ?) ELSE startedAt END, updatedAt = ? WHERE id = ? AND status = \'paused\'', sch, sch, now, now, id); word = sch === 'scheduled' ? 'Resumed. It will start at the time you picked.' : 'Sending again.';
    try { require('./runner').ensureTimer(); } catch { /* ok */ } // eslint-disable-line global-require
  } else if (action === 'stop') {
    if (!['running', 'scheduled', 'paused', 'draft', 'preparing'].includes(row.status)) return { error: 'This campaign has already finished.', status: 409 };
    done = await S.run('UPDATE "OutreachCampaign" SET status = \'stopped\', completedAt = ?, updatedAt = ? WHERE id = ? AND status IN (\'running\',\'scheduled\',\'paused\',\'draft\',\'preparing\')', now, now, id);
    if (done) await S.run('UPDATE "OutreachMessage" SET status = \'cancelled\', reason = \'campaign_stopped\' WHERE campaignId = ? AND status = \'queued\'', id);
    word = 'Stopped. People who were not messaged yet will not get it.';
  } else return { error: 'Unknown action.', status: 400 };
  if (!done) return { error: 'It just changed. Refresh and try again.', status: 409 };
  await logAudit({ userId: user.id, actorName: user.name, action: `Outreach campaign ${action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'resumed'}`, entity: 'OutreachCampaign', entityId: id, toValue: `from ${row.status}` });
  await Act.log(row, action === 'stop' ? 'stopped' : action === 'pause' ? 'paused' : 'resumed', `${action === 'stop' ? 'Stopped' : action === 'pause' ? 'Paused' : 'Resumed'} by ${S.clip(user.name, 60)}.`, user, now);
  if (action === 'stop' || action === 'pause') { // the bell: the creator and the Admins (not the person who pressed the button)
    const n = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND status = \'cancelled\'', id))[0].n);
    await Health.announce(row, action === 'stop' ? 'stopped' : 'paused', action === 'stop' ? `Stopped by ${S.clip(user.name, 60)}. ${n} ${n === 1 ? 'person' : 'people'} did not get the message.` : `Paused by ${S.clip(user.name, 60)}. Nobody else gets a message until someone presses Resume.`, { key: `${action === 'stop' ? 'stopped' : 'paused'}:${id}:${now}`, exceptUserId: user.id, reason: action });
  }
  return { ok: word, campaign: (await get(user, id)).campaign };
}
async function removeDraft(user, id) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  if (f.row.status !== 'draft') return { error: 'Only a campaign that was never sent can be deleted. Use Stop for a running campaign.', status: 409 };
  if (!(await canControl(user, f.row, f.reqs))) return { error: 'You cannot delete this campaign.', status: 403 };
  await S.run('DELETE FROM "OutreachCampaign" WHERE id = ? AND status = \'draft\'', id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach campaign deleted (never sent)', entity: 'OutreachCampaign', entityId: id });
  return { ok: 'Deleted.' };
}

// ---- resend the failed ones --------------------------------------------------------------------------------------------------------------
// failed rows (not bounced / marked as spam: those addresses are bad for good) go back in the queue; the engine checks the person again before each send.
// A finished campaign starts again. A CALL task that got "no answer" becomes "To call" again.
async function resendFailed(user, id) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row, reqs } = f;
  if (!(await canControl(user, row, reqs))) return { error: 'You can look at this campaign, but you cannot change it.', status: 403 };
  if (!['running', 'done', 'paused'].includes(row.status)) return { error: 'Only a campaign that has gone out can resend the failed ones.', status: 409 };
  const now = Date.now();
  const back = await S.run('UPDATE "OutreachMessage" SET status = \'queued\', attempts = 0, lockedBy = NULL, lockedAt = NULL, sendStartedAt = NULL, error = NULL, reason = NULL, failedAt = NULL, nextRunAt = ?, queuedAt = ? WHERE campaignId = ? AND status = \'failed\'', now, now, id);
  if (!back) return { error: 'There are no failed messages to send again.', status: 409 };
  if (row.status === 'done') await S.run('UPDATE "OutreachCampaign" SET status = \'running\', completedAt = NULL, updatedAt = ? WHERE id = ? AND status = \'done\'', now, id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach campaign: failed messages sent again', entity: 'OutreachCampaign', entityId: id, toValue: `${back} messages` });
  await Act.log(row, 'resent', `${back} failed ${back === 1 ? 'message was' : 'messages were'} put back to go again (by ${S.clip(user.name, 60)}).`, user, now);
  try { require('./runner').ensureTimer(); } catch { /* ok */ } // eslint-disable-line global-require
  return { ok: true, requeued: back, campaign: (await get(user, id)).campaign };
}

// ---- CALL TASKS -----------------------------------------------------------------------------------------------------------------------------
// the tasks of a call campaign: name, phone (masked for the masked roles), what happened. status 'queued' = To call.
async function callTasks(user, id, { status, q, page = 1, pageSize = 25 } = {}) {
  const f = await rowFor(user, id);
  if (f.error) return f;
  const { row } = f;
  if (chanOf(row) !== 'call') return { error: 'This campaign has no call tasks.', status: 400 };
  const masked = A.masked(user);
  const where = ['m.campaignId = ?']; const ps = [id];
  if (status === 'todo') where.push('m.status = \'queued\''); else if (status === 'called') where.push('m.status = \'sent\''); else if (status === 'noanswer') where.push('m.status = \'failed\''); else if (status === 'skipped') where.push('m.status IN (\'skipped\',\'cancelled\')');
  const needle = String(q || '').trim().slice(0, 60).toLowerCase();
  if (needle) { where.push('LOWER(c.name) LIKE ?'); ps.push(`%${needle.replace(/[%_]/g, '')}%`); }
  const pg = Math.max(1, Math.floor(Number(page)) || 1); const sz = Math.min(100, Math.max(1, Math.floor(Number(pageSize)) || 25));
  const base2 = `FROM "OutreachMessage" m LEFT JOIN "OutreachContact" c ON c.id = m.contactId WHERE ${where.join(' AND ')}`;
  const total = S.num((await S.q(`SELECT COUNT(*) n ${base2}`, ...ps))[0].n);
  const rows = await S.q(`SELECT m.id, m.status, m.reason, m.sentAt, m.failedAt, m.callMinutes, c.name, c.phoneE164, c.city, c.company ${base2} ORDER BY CASE m.status WHEN 'queued' THEN 0 ELSE 1 END, c.name LIMIT ? OFFSET ?`, ...ps, sz, (pg - 1) * sz);
  const tally = {}; (await S.q('SELECT status, COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? GROUP BY status', id)).forEach((r) => { tally[r.status] = S.num(r.n); });
  const ph2 = (p) => (p ? (masked ? core.maskMobile(p) : `+${p}`) : '');
  return {
    total, page: pg, pageSize: sz, masked, can: await canControl(user, row, f.reqs), script: metaOf(row).masterMessage || (S.parse(row.templateSnapshot, null) || {}).body || '',
    counts: { todo: tally.queued || 0, called: tally.sent || 0, noAnswer: tally.failed || 0, skipped: (tally.skipped || 0) + (tally.cancelled || 0) },
    tasks: rows.map((r) => ({ id: r.id, name: r.name || '(removed)', phone: ph2(r.phoneE164), city: r.city || '', company: r.company || '', status: r.status, statusWords: r.status === 'queued' ? 'To call' : (r.status === 'sent' ? 'Called' : (r.status === 'failed' ? 'No answer' : 'Skipped')), minutes: r.callMinutes == null ? null : S.num(r.callMinutes), at: S.iso(r.sentAt || r.failedAt) })),
  };
}
// log one call: outcome 'called' (minutes) | 'no_answer' | 'skip'. Only from "To call". sentAt = now; the ledger row (call credits, default 0) is written once.
async function markCall(user, messageId, { outcome, minutes, note } = {}) {
  const m = (await S.q('SELECT * FROM "OutreachMessage" WHERE id = ?', String(messageId || '')))[0];
  if (!m || m.channel !== 'call') return { error: 'This call task was not found.', status: 404 };
  const f = await rowFor(user, m.campaignId);
  if (f.error) return { error: 'This call task was not found.', status: 404 };
  const { row, reqs } = f;
  if (!(await canControl(user, row, reqs))) return { error: 'You can look at this campaign, but you cannot log its calls.', status: 403 };
  if (!['running', 'paused'].includes(row.status)) return { error: 'This campaign is not taking calls right now.', status: 409 };
  if (m.status !== 'queued') return { error: 'This call was already logged.', status: 409 };
  const now = Date.now();
  let did = 0;
  if (outcome === 'called') {
    const mins = Math.floor(Number(minutes));
    if (!Number.isFinite(mins) || mins < 0 || mins > 600) return { error: 'Type how many minutes the call took (0 to 600).', status: 400 };
    did = await S.run('UPDATE "OutreachMessage" SET status = \'sent\', sentAt = ?, callMinutes = ?, error = ?, lockedBy = NULL WHERE id = ? AND status = \'queued\'', now, mins, S.clip(note, 200) || null, m.id);
    if (did) { await Ev.record('sent', m, row, { at: now, detail: { call: 1 } }); require('./credits').record({ userId: user.id, channel: 'call', mode: 'live', ok: true, campaignId: row.id, templateLabel: 'Call', source: 'campaign', now }).catch(() => {}); } // eslint-disable-line global-require
  } else if (outcome === 'no_answer') {
    did = await S.run('UPDATE "OutreachMessage" SET status = \'failed\', reason = \'no_answer\', failedAt = ?, error = ? WHERE id = ? AND status = \'queued\'', now, S.clip(note, 200) || 'No answer', m.id);
    if (did) await Ev.record('failed', m, row, { at: now, detail: { reason: 'no_answer' } });
  } else if (outcome === 'skip') {
    did = await S.run('UPDATE "OutreachMessage" SET status = \'skipped\', reason = \'skipped_call\' WHERE id = ? AND status = \'queued\'', m.id);
    if (did) await Ev.record('skipped', m, row, { at: now, detail: { reason: 'skipped_call' } });
  } else return { error: 'Pick what happened: Called, No answer or Skip.', status: 400 };
  if (!did) return { error: 'It just changed. Refresh and try again.', status: 409 };
  // the last task done: the campaign is finished
  const left = S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage" WHERE campaignId = ? AND status IN (\'queued\',\'sending\')', row.id))[0].n);
  if (left === 0 && row.status === 'running') await S.run('UPDATE "OutreachCampaign" SET status = \'done\', completedAt = ?, updatedAt = ? WHERE id = ? AND status = \'running\'', now, now, row.id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach call logged', entity: 'OutreachMessage', entityId: m.id, toValue: `${outcome}${outcome === 'called' ? `, ${Math.floor(Number(minutes))} min` : ''}` });
  return { ok: true, left };
}

// ---- "Send a small test to myself first" -------------------------------------------------------------------------------------------
const testHits = new Map();
// Goes to the SENDER'S OWN address only (never to a contact), never carries a real tracked link, still obeys test mode and the daily limit. Email only.
async function testSend(user, b, { mailSender } = {}) {
  if (b && b.channel && b.channel !== 'email') return { error: 'A test to yourself is for email only.', status: 400 };
  const v = await validate(user, b, { needSegments: false });
  if (v.error) return v;
  const now = Date.now();
  const hits = (testHits.get(user.id) || []).filter((t) => now - t < 3600000);
  if (hits.length >= 10) return { error: 'You have sent 10 tests this hour. Please wait a little.', status: 429 };
  const st = await S.settings();
  if (!st.emailTestMode && !st.master) return { error: 'Outreach sending is switched OFF, so a real test cannot go out.', status: 400 };
  const own = await prisma.user.findUnique({ where: { id: user.id }, select: { email: true, name: true } });
  const to = own && own.email;
  if (!core.validEmail(to)) return { error: 'Your login has no email address, so there is nowhere to send the test.', status: 400 };
  const plain = v.requirement ? bridge().jobUrl(v.requirement.id) : '';
  const t = { channel: 'email', subject: v.snapshot.subject, body: v.snapshot.body };
  const out = T.render(t, { name: firstName(own.name) || 'there', job_title: v.requirement ? v.requirement.title : '', company: companyName(st), apply_link: plain, unsubscribe: '(the stop-these-emails link appears here)' });
  const r = await adapters.get('email').send({ id: `self:${user.id}`, contactType: 'self', email: to }, { subject: `[TEST] ${out.subject}`, body: `${out.body}\n\n(This is a test sent only to you. The apply link here is the plain job link; real messages carry each person's own tracked link.)`, kind: 'self_test', promotional: false }, { selfTest: true, settings: st, mailSender });
  testHits.set(user.id, [...hits, now]);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach test email to self', entity: 'OutreachCampaign', entityId: 'test', toValue: r.status });
  if (r.status === 'test_captured') return { ok: true, status: r.status, words: 'Test mode is ON, so nothing was really sent. A copy of your test was saved in the send log (Channels tab).' };
  if (r.status === 'sent') return { ok: true, status: r.status, words: `Sent to your own address (${core.maskEmail(to)}). Check your inbox.` };
  return { error: r.status === 'refused' ? `Not sent: ${Sup.REASON_WORDS[r.reason] || r.reason}.` : `Not sent: ${r.error || 'the mail server did not accept it'}`, status: 400 };
}

// ---- group helpers (a master campaign = rows that share meta.groupId) ----------------------------------------------------------------------
const GROUP_ID = /^[A-Za-z0-9_-]{4,60}$/;
// every campaign row of the group `id` (a groupId OR the id of one row of it / of a single campaign). [] when there is none.
async function groupRows(id) {
  const key = String(id || '');
  if (!GROUP_ID.test(key)) return [];
  const own = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', key))[0];
  const gid = own ? metaOf(own).groupId : key;
  if (!own && !gid) return [];
  if (!gid) return [own];
  return S.q('SELECT * FROM "OutreachCampaign" WHERE meta LIKE ? ORDER BY createdAt, id', `%"groupId":"${gid}"%`);
}
async function patchMeta(id, patch) {
  const r = (await S.q('SELECT meta FROM "OutreachCampaign" WHERE id = ?', id))[0];
  if (!r) return false;
  const next = { ...metaOf(r), ...patch };
  await S.run('UPDATE "OutreachCampaign" SET meta = ?, updatedAt = ? WHERE id = ?', JSON.stringify(next), Date.now(), id);
  return true;
}

// ---- click tracking ------------------------------------------------------------------------------------------------------------------------
const BOT = /bot|crawl|spider|slurp|preview|scanner|monitor|proofpoint|mimecast|barracuda|safelinks|symantec|forcepoint|trend ?micro|fireeye|sophos|ironport|urlscan|virustotal|headless|phantom|puppeteer|playwright|selenium|curl|wget|python|java\/|go-http|okhttp|axios|node-fetch|libwww|httpclient|facebookexternalhit|whatsapp|telegram|slack|skype|discord|twitter|linkedin|embedly|quora|pinterest|google-?safety|googleimageproxy|apple-?mail|bingpreview|yahoo|outlook|ms-office|microsoft office/i;
// the class only (we keep no user-agent string, no IP)
function uaClass(ua) {
  const u = String(ua || '');
  if (!u.trim()) return 'bot';
  if (BOT.test(u)) return 'bot';
  if (/mobile|android|iphone|ipad/i.test(u)) return 'mobile';
  if (/mozilla|chrome|safari|firefox|edg/i.test(u)) return 'desktop';
  return 'other';
}
const FIRST_SECONDS = 3000; // a click this soon after the send is a mail scanner, not a person
// -> { status: 404 } | { redirect, counted }
async function resolveClick(token, { ua, method = 'GET', now = Date.now() } = {}) {
  if (!L.verifyTracked(token)) return { status: 404 };
  if (!(await S.campaignsReady())) return { status: 404 };
  const m = (await S.q('SELECT * FROM "OutreachMessage" WHERE token = ?', String(token)))[0];
  if (!m) return { status: 404 };
  const c = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', m.campaignId))[0];
  if (!c || c.type !== 'job_promotion' || !c.requirementId) return { status: 404 }; // internal campaigns have no tracked link
  const redirect = targetUrl(c, m); // built here, from the campaign's job. The URL asked for contributes nothing but the token.
  const cls = uaClass(ua);
  const sentAt = S.ms(m.sentAt);
  if (String(method).toUpperCase() === 'HEAD' || cls === 'bot' || !sentAt || now - sentAt < FIRST_SECONDS) return { redirect, counted: false, uaClass: cls };
  const changed = await S.run('UPDATE "OutreachMessage" SET firstClickAt = ? WHERE id = ? AND firstClickAt IS NULL', now, m.id);
  if (changed) await Ev.record('clicked', m, c, { detail: { ua: cls }, at: now });
  return { redirect, counted: !!changed, uaClass: cls };
}

module.exports = {
  KINDS, TABS, CH_WORDS, ensureKind, STATUS_WORDS, list, get, messages, jobs, plan, create, update, send, control, removeDraft, resendFailed, callTasks, markCall, testSend, materialize, finishPreparing,
  renderFor, varOrder, shortLink, targetUrl, resolveClick, uaClass, validate, canSee, canControl, abilities, rowFor, reqRows, countsFor, view, visibleRows, creditsFor, groupRows, patchMeta, metaOf, chanOf, dbChannel,
};
