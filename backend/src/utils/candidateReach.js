// ---------------------------------------------------------------------------
// CANDIDATE REACH — the "tick people, then Call / Message / WhatsApp / Email"
// flow of ATS > Candidates & Pipeline (list and Progress board).
//
// Everything the app already has is REUSED, nothing is re-invented:
//   * the contact right and the "masked" rule        utils/contactAccess.js
//   * the message queue, templates, daily limits,
//     de-dupe, quiet hours, consent                  utils/bulkMessaging.js
//   * the candidate's communication log              CandidateMessage + conversations
//
// What this file adds:
//   check()      before anything is sent or dialled: of the N ticked people, who can
//                be reached on this way and who cannot, and WHY (no consent / no phone /
//                no email / duplicate / outside your access).
//   compose()    the message filled in for EVERY person, also when the channel is not
//                connected (then each person gets an "Open WhatsApp" link to use from
//                the sender's own app instead of a fake "Sent").
//   deviceLog()  one person's message was opened in the sender's own app: logged as
//                exactly that ("Opened in your app"), never as Sent.
//   callQueue()  the people to dial, one after another, with their number.
//   callLog()    how one call went (Answered / Not answered / Busy / Wrong number /
//                Call back), written to the candidate's history + the open follow-up.
//   resultOf()   a finished send job with a plain status word per person.
//
// Who: the roles that see a candidate's number (not BDE, not BDE TL, not Accounts).
// Calling needs the contact right in DIRECT mode; messaging many also needs the
// old bulk right (contactAccess.bulkAllowed). At most MAX people per action.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const access = require('./contactAccess');
const bulk = require('./bulkMessaging');
const core = require('./messagingCore');
const ctx = require('./messageContext');
const convo = require('./conversations');
const messaging = require('./messaging');
const { logAudit } = require('./audit');

const MAX = 200;
const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
const CALL_OUTCOMES = ['Answered', 'Not answered', 'Busy', 'Wrong number', 'Call back'];
// The follow-up record's own words (utils/followups.js), same map the quick log uses.
const OUTCOME_ON_FOLLOWUP = {
  Answered: 'Answered', 'Not answered': 'Not Answered', Busy: 'Busy', 'Wrong number': 'Wrong Number', 'Call back': 'Call Back',
};
const TEST_RECORD = /zztest|example\.test/i;

// One plain word per reason. The order matters (first match wins).
const WORD = {
  ok: 'Ready',
  sent: 'Sent',
  failed: 'Failed',
  opened: 'Opened in your app',
  not_connected: 'Not connected',
  no_consent: 'No consent',
  no_phone: 'No phone',
  no_email: 'No email',
  duplicate: 'Duplicate',
  limit: 'Daily limit',
  quiet: 'Quiet hours',
  opted_out: 'Said STOP',
  test: 'Test record',
  switch_off: 'Emails switched off',
  outside: 'Outside your access',
  skipped: 'Skipped',
};
const TONE = {
  ok: 'blue', sent: 'green', opened: 'green', failed: 'red', not_connected: 'orange', no_consent: 'red', no_phone: 'orange', no_email: 'orange',
  duplicate: 'orange', limit: 'orange', quiet: 'orange', opted_out: 'red', test: 'orange', switch_off: 'orange', outside: 'red', skipped: 'orange',
};

function codeOfReason(status, reason) {
  if (status === 'sent') return 'sent';
  if (status === 'queued' || status === 'sending') return 'ok';
  const t = String(reason || '');
  if (/consent withdrawn|asked not to be contacted/i.test(t)) return 'no_consent';
  if (/^Duplicate/i.test(t)) return 'duplicate';
  if (/No email address|not a valid email/i.test(t)) return 'no_email';
  if (/No mobile number|not a phone number|valid.*mobile number|placeholder number|valid Indian mobile/i.test(t)) return 'no_phone';
  if (/is not set up yet|is not set up:|no approved template|WhatsApp template ".*" is/i.test(t)) return 'not_connected';
  if (/Today's limit/i.test(t)) return 'limit';
  if (/STOP/.test(t)) return 'opted_out';
  if (/quiet hours|until the morning|held until/i.test(t)) return 'quiet';
  if (/Test record|Reserved test domain/i.test(t)) return 'test';
  if (/Candidate emails" switch/i.test(t)) return 'switch_off';
  if (status === 'failed') return 'failed';
  return 'skipped';
}

const personView = (p, extra = {}) => ({ id: p.id, name: p.name, ...extra });

// ---- who may do what ---------------------------------------------------------
// -> { ok, status, error, rule }
async function mayReach(user, { bulkSend }) {
  const rule = await access.ruleFor(user, 'candidates');
  if (!rule.allowed) return { ok: false, status: 403, error: rule.reason || 'Not available to this login' };
  if (rule.mode === 'masked') return { ok: false, status: 403, error: 'Your role does not see candidates\' phone numbers or email addresses, so it cannot call or message them from a list. Ask the recruiter.' };
  if (bulkSend && !(await bulk.mayBulkSend(user, 'candidates'))) return { ok: false, status: 403, error: 'Your role can contact one candidate at a time, but not message many at once.' };
  return { ok: true, rule };
}

const cleanIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String).filter(Boolean))];

function tooMany(ids) {
  if (!ids.length) return { status: 400, error: 'Tick at least one candidate.' };
  if (ids.length > MAX) return { status: 400, error: `You ticked ${ids.length} candidates. At most ${MAX} at a time: narrow the list, or do them in batches.` };
  return null;
}

// ---- check ---------------------------------------------------------------------
// channel: 'Call' | 'Email' | 'SMS' | 'WhatsApp'
async function check(user, body) {
  const b = body || {};
  const channel = ['Call', ...CHANNELS].includes(b.channel) ? b.channel : null;
  if (!channel) return { status: 400, error: 'Choose Call, Message (SMS), WhatsApp or Email.' };
  const g = await mayReach(user, { bulkSend: channel !== 'Call' });
  if (!g.ok) return g;
  const ids = cleanIds(b.ids);
  const bad = tooMany(ids);
  if (bad) return bad;
  const people = await ctx.recipientsFor(user, 'candidates', ids, {});
  const seen = new Map();
  const rows = people.map((e) => {
    const raw = channel === 'Email' ? e.email : e.mobile;
    let code = 'ok'; let reason = null; let key = null;
    if (e.doNotContact) { code = 'no_consent'; reason = 'Asked not to be contacted (consent withdrawn)'; } else if (channel === 'Email') {
      const addr = String(raw || '').trim();
      if (!addr) { code = 'no_email'; reason = 'No email address on record'; } else if (!core.validEmail(addr)) { code = 'no_email'; reason = `"${addr}" is not a valid email address`; } else key = addr.toLowerCase();
    } else {
      const m = core.normalizeMobile(raw);
      if (!m.ok) { code = 'no_phone'; reason = m.reason; } else key = m.e164;
    }
    if (code === 'ok' && TEST_RECORD.test(`${e.name} ${raw || ''}`) && !require('./sandbox').isSandbox()) { code = 'test'; reason = 'Test record: never contacted'; } // eslint-disable-line global-require
    if (code === 'ok' && key) {
      if (seen.has(key)) { code = 'duplicate'; reason = `Same ${channel === 'Email' ? 'address' : 'number'} as ${seen.get(key)}`; } else seen.set(key, e.name);
    }
    return personView(e, { code, word: WORD[code], tone: TONE[code], reason, applicationId: e.applicationId || null });
  });
  const known = new Set(people.map((p) => p.id));
  const outside = ids.filter((id) => !known.has(id));
  const counts = {};
  rows.forEach((r) => { counts[r.code] = (counts[r.code] || 0) + 1; });
  if (outside.length) counts.outside = outside.length;
  const status = await messaging.channelStatus();
  const connected = channel === 'Call' ? null : !!(status[channel] && status[channel].configured);
  return {
    out: {
      channel, selected: ids.length, max: MAX, canReach: counts.ok || 0, counts, outside: outside.length, connected,
      connectedReason: channel === 'Call' || connected ? null : status[channel].reason,
      people: rows,
    },
  };
}

// ---- compose (fallback messages for every person) ---------------------------------
async function compose(user, body) {
  const b = body || {};
  const channel = CHANNELS.includes(b.channel) ? b.channel : null;
  if (!channel) return { status: 400, error: 'Choose Message (SMS), WhatsApp or Email.' };
  const g = await mayReach(user, { bulkSend: true });
  if (!g.ok) return g;
  const ids = cleanIds(b.ids);
  const bad = tooMany(ids);
  if (bad) return bad;
  const built = await bulk.buildPlan(user, { ...b, audience: 'candidates', kind: 'bulk', ids, channels: [channel] });
  if (built.error) return { status: built.status || 400, error: built.error };
  const { plan } = built;
  const status = await messaging.channelStatus();
  const connected = !!(status[channel] && status[channel].configured);
  const seen = new Map();
  const rows = plan.recipients.map((r) => {
    let code = codeOfReason(r.status, r.reason);
    let reason = r.reason || null;
    let canOpen = false;
    // Not connected (or no approved WhatsApp template): the sender can still use their OWN app,
    // as long as this person can be reached at all.
    if (code === 'not_connected') {
      const m = channel === 'Email' ? null : core.normalizeMobile(r.address);
      if (channel === 'Email') {
        const a = String(r.address || '').trim();
        if (!a) { code = 'no_email'; reason = 'No email address on record'; } else if (!core.validEmail(a)) { code = 'no_email'; reason = `"${a}" is not a valid email address`; }
      } else if (!m.ok) { code = 'no_phone'; reason = m.reason; }
      if (code === 'not_connected') {
        const key = channel === 'Email' ? String(r.address).toLowerCase() : m.e164;
        if (seen.has(key)) { code = 'duplicate'; reason = `Same ${channel === 'Email' ? 'address' : 'number'} as ${seen.get(key)}`; } else if (r.missing && r.missing.length) { code = 'skipped'; reason = `Missing: ${r.missing.join(', ')}`; } else { seen.set(key, r.name); canOpen = true; }
      }
    }
    return {
      id: r.entityId, name: r.name, applicationId: r.applicationId || null, code, word: WORD[code], tone: TONE[code], reason, canOpen,
      address: r.address, subject: r.subject || null, text: r.text || '',
    };
  });
  const counts = {};
  rows.forEach((r) => { counts[r.code] = (counts[r.code] || 0) + 1; });
  const outside = plan.outOfScope || 0;
  if (outside) counts.outside = outside;
  return { out: { channel, connected, selected: ids.length, outside, counts, canOpen: rows.filter((r) => r.canOpen).length, people: rows } };
}

// ---- opened in the sender's own app -------------------------------------------
async function deviceLog(user, body) {
  const b = body || {};
  const channel = CHANNELS.includes(b.channel) ? b.channel : null;
  if (!channel) return { status: 400, error: 'Say how: Email, SMS or WhatsApp.' };
  const g = await mayReach(user, { bulkSend: false });
  if (!g.ok) return g;
  const [e] = await ctx.recipientsFor(user, 'candidates', [String(b.candidateId || '')], {});
  if (!e) return { status: 403, error: 'This candidate is outside your access.' };
  if (e.doNotContact) return { status: 409, error: 'This person asked not to be contacted (consent withdrawn).' };
  const to = channel === 'Email' ? e.email : e.mobile;
  if (!to) return { status: 400, error: `No ${channel === 'Email' ? 'email address' : 'phone number'} on this candidate.` };
  // eslint-disable-next-line global-require
  const sender = await require('./candidateComms').senderIdentity(user);
  const purpose = String(b.purpose || '').trim().slice(0, 120) || 'Message';
  const text = String(b.text || '').slice(0, 4000);
  const row = await prisma.candidateMessage.create({
    data: {
      candidateId: e.id, applicationId: e.applicationId || null, channel, template: 'BULK_DEVICE', templateLabel: purpose, trigger: 'Manual',
      recipient: String(to), subject: channel === 'Email' ? String(b.subject || purpose).slice(0, 200) : null, body: text,
      status: 'OPENED_ON_DEVICE',
      statusDetail: `Opened in the sender's own ${channel === 'Email' ? 'mail app' : channel === 'WhatsApp' ? 'WhatsApp' : 'messaging app'} from the bulk list: the app cannot see whether it was sent`,
      ...sender,
    },
  });
  await prisma.applicationFollowUp.updateMany({
    where: { candidateId: e.id, completedAt: null, ...(e.applicationId ? { applicationId: e.applicationId } : {}) },
    data: { lastContactedAt: new Date(), contactMode: channel },
  }).catch(() => {});
  await convo.recordOut({ personType: 'CANDIDATE', personId: e.id, personName: e.name, channel, body: text, templateLabel: purpose }).catch(() => {});
  await logAudit({ userId: user.id, actorName: user.name, action: `${channel} opened in the sender's own app (bulk list): ${purpose}`, entity: 'Candidate', entityId: e.id, toValue: 'The app cannot see whether it was sent' }).catch(() => {});
  return { out: { ok: true, id: row.id } };
}

// ---- call queue ---------------------------------------------------------------------
async function callQueue(user, body) {
  const b = body || {};
  const g = await mayReach(user, { bulkSend: false });
  if (!g.ok) return g;
  const items = Array.isArray(b.items) ? b.items : cleanIds(b.ids).map((id) => ({ id }));
  const order = items.map((x) => ({ id: String(x.id || x), applicationId: x.applicationId ? String(x.applicationId) : null })).filter((x) => x.id);
  const ids = cleanIds(order.map((x) => x.id));
  const bad = tooMany(ids);
  if (bad) return bad;
  const appOf = new Map(order.map((x) => [x.id, x.applicationId]));
  const people = await ctx.recipientsFor(user, 'candidates', ids, {});
  const byId = new Map(people.map((p) => [p.id, p]));
  const seen = new Map();
  const queue = []; const skipped = [];
  ids.forEach((id) => {
    const e = byId.get(id);
    if (!e) { skipped.push({ id, name: null, code: 'outside', word: WORD.outside, reason: 'Outside your access' }); return; }
    const m = core.normalizeMobile(e.mobile);
    let code = null; let reason = null;
    if (e.doNotContact) { code = 'no_consent'; reason = 'Asked not to be contacted (consent withdrawn)'; } else if (!m.ok) { code = 'no_phone'; reason = m.reason; } else if (seen.has(m.e164)) { code = 'duplicate'; reason = `Same number as ${seen.get(m.e164)}`; }
    if (code) { skipped.push({ id, name: e.name, code, word: WORD[code], reason }); return; }
    seen.set(m.e164, e.name);
    queue.push({
      id: e.id, name: e.name, phone: e.mobile, e164: m.e164, applicationId: appOf.get(id) || e.applicationId || null,
      role: (e.tokens && e.tokens.role) || null,
    });
  });
  const gw = await require('./callGateway').callConfig().catch(() => ({ configured: false })); // eslint-disable-line global-require
  return { out: { max: MAX, selected: ids.length, queue, skipped, call: { configured: !!gw.configured, provider: gw.configured ? 'Exotel' : null, recording: !!gw.record }, outcomes: CALL_OUTCOMES } };
}

// ---- call log -----------------------------------------------------------------------
async function callLog(user, body) {
  const b = body || {};
  const g = await mayReach(user, { bulkSend: false });
  if (!g.ok) return g;
  const outcome = String(b.outcome || '').trim();
  if (!CALL_OUTCOMES.includes(outcome)) return { status: 400, error: `Say how the call went: ${CALL_OUTCOMES.join(', ')}.` };
  const [e] = await ctx.recipientsFor(user, 'candidates', [String(b.candidateId || '')], {});
  if (!e) return { status: 403, error: 'This candidate is outside your access.' };
  if (e.doNotContact) return { status: 409, error: 'This person asked not to be contacted (consent withdrawn).' };
  const note = String(b.note || '').trim().slice(0, 1000);
  const purpose = String(b.purpose || '').trim().slice(0, 120) || 'Call queue';
  let appId = b.applicationId ? String(b.applicationId) : null;
  if (appId) {
    // only an application of THIS candidate that this login may see
    // eslint-disable-next-line global-require
    const { applicationWhere } = require('./scope');
    const ok = await prisma.application.findFirst({ where: { AND: [{ id: appId, candidateId: e.id }, applicationWhere(user)] }, select: { id: true } });
    if (!ok) appId = null;
  }
  // eslint-disable-next-line global-require
  const sender = await require('./candidateComms').senderIdentity(user);
  const row = await prisma.candidateMessage.create({
    data: {
      candidateId: e.id, applicationId: appId, channel: 'Call', template: 'CALL_QUEUE', templateLabel: purpose, trigger: 'Manual',
      recipient: e.mobile || null, body: `${outcome}${note ? ` — ${note}` : ''}`, status: 'LOGGED', statusDetail: `Call — ${outcome} (call queue)`, ...sender,
    },
  });
  const mapped = OUTCOME_ON_FOLLOWUP[outcome];
  const touched = await prisma.applicationFollowUp.updateMany({
    where: { candidateId: e.id, completedAt: null, ...(appId ? { applicationId: appId } : {}) },
    data: { lastContactedAt: new Date(), contactMode: 'Call', ...(mapped ? { outcome: mapped } : {}) },
  });
  await convo.recordOut({ personType: 'CANDIDATE', personId: e.id, personName: e.name, channel: 'Call', body: `Call: ${outcome}${note ? ` - ${note}` : ''}`, templateLabel: purpose }).catch(() => {});
  await logAudit({ userId: user.id, actorName: user.name, action: `Called candidate — ${outcome}`, entity: 'Candidate', entityId: e.id, toValue: `${purpose} (call queue)` }).catch(() => {});
  return { out: { ok: true, id: row.id, followUpsTouched: touched.count, applicationId: appId } };
}

// ---- send (wrapper: the cap, then the ordinary bulk job) ------------------------------
async function send(user, body) {
  const b = body || {};
  const channel = CHANNELS.includes(b.channel) ? b.channel : null;
  if (!channel) return { status: 400, error: 'Choose Message (SMS), WhatsApp or Email.' };
  const g = await mayReach(user, { bulkSend: true });
  if (!g.ok) return g;
  const ids = cleanIds(b.ids);
  const bad = tooMany(ids);
  if (bad) return bad;
  const made = await bulk.createJob(user, { ...b, audience: 'candidates', kind: 'bulk', ids, channels: [channel] });
  if (made.error) return { status: made.status || 400, error: made.error, people: made.people };
  return { out: made.job };
}

// ---- result of a job (plain word per person) ---------------------------------------------
function resultOf(user, jobId, masked) {
  const job = bulk.readJob(jobId);
  if (!job) return { status: 404, error: 'No such send.' };
  if (!bulk.canSee(user, job)) return { status: 403, error: 'Only the sender or an Admin can see this send.' };
  const s = bulk.summary(job, { withRecipients: true, masked: !!masked });
  const channel = (job.channels || [])[0];
  const people = s.recipients.map((r) => {
    const code = codeOfReason(r.status, r.reason);
    return { n: r.n, name: r.name, channel: r.channel, address: r.address, status: r.status, code, word: WORD[code], tone: TONE[code], reason: r.reason, sandbox: r.sandbox };
  });
  const counts = {};
  people.forEach((p) => { counts[p.code] = (counts[p.code] || 0) + 1; });
  if (job.outOfScope) counts.outside = job.outOfScope;
  const finished = !['queued', 'running', 'cancelling'].includes(s.status);
  return { out: { id: s.id, status: s.status, finished, channel, purpose: s.purpose, selected: (s.entities || 0) + (job.outOfScope || 0), counts, outside: job.outOfScope || 0, people } };
}

module.exports = {
  MAX, CHANNELS, CALL_OUTCOMES, WORD, TONE, codeOfReason, mayReach, check, compose, deviceLog, callQueue, callLog, send, resultOf,
};
