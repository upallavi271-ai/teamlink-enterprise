// ---------------------------------------------------------------------------
// BULK + INDIVIDUAL MESSAGING — one message to one person or many (candidates,
// clients' contacts, employees), on Email, SMS and/or WhatsApp, built from the
// Message templates (utils/messageTemplates.js), as a QUEUE with a status per
// recipient. One person is simply a job of one.
//
//   buildPlan()   works out, for every recipient x channel, BEFORE anything is
//                 sent (this is what the preview shows):
//                   queued    will be sent; the exact subject / text is already
//                             filled in with that person's real values
//                   skipped   cannot be sent: no / invalid address, duplicate,
//                             a detail the message needs is missing
//                   blocked   must not be sent: consent withdrawn, the
//                             Candidate emails switch is OFF, the channel has
//                             no account, the WhatsApp template is not
//                             approved, a test record, today's limit reached
//   createJob()   writes the job (one audit row) once the caller confirmed the
//                 number of people.
//   the worker    sends the queued rows, one lane per channel, paced by the
//                 messages-per-minute setting, retries TEMPORARY provider
//                 failures with backoff and records the provider's own words
//                 on a permanent failure.
//   report        CSV and Excel of every recipient with status and reason.
//
// WHERE THE QUEUE LIVES. One JSON file per job under MESSAGE_JOB_DIR (default
// ~/.teamlink-message-jobs, outside the repository). A file per job survives
// the dev server restarting mid-run. Writes are atomic (temp file + rename).
// A row that was mid-send when the process died is marked failed
// "interrupted — outcome unknown" rather than sent twice.
//
// Candidate sends are ALSO written to the candidate's own communication log
// (CandidateMessage) once their outcome is known, as SENT / FAILED / blocked,
// never as a waiting row the stage-change mail worker could pick up again.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const messaging = require('./messaging');
const core = require('./messagingCore');
const T = require('./messageTemplates');
const ctx = require('./messageContext');
const limits = require('./messageLimits');
const { logAudit } = require('./audit');
const access = require('./contactAccess');
const convo = require('./conversations');

const LIMIT = 500;
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = (process.env.BULK_BACKOFF_MS || '2000,8000,30000').split(',').map(Number);
const AUDIENCES = ['candidates', 'clients', 'employees'];
const FINAL = ['sent', 'failed', 'skipped', 'blocked'];
const STATES = ['queued', 'sending', 'sent', 'failed', 'skipped', 'blocked'];
const ENTITY = { candidates: 'Candidate', clients: 'Client', employees: 'Employee' };
const ONE_WORD = { candidates: 'candidate', clients: 'client contact', employees: 'employee' };
const SWITCH_OFF_REASON = 'The "Candidate emails" switch is OFF, so nothing is sent to candidates. An Admin turns it on in Administration → Company Setup → Step timing.';

function jobDir() {
  const dir = process.env.MESSAGE_JOB_DIR || path.join(os.homedir() || os.tmpdir(), '.teamlink-message-jobs');
  fs.mkdirSync(dir, { recursive: true });
  return path.resolve(dir);
}
const ID_RE = /^bj_[a-z0-9]{8,40}$/;
function fileOf(id) {
  if (!ID_RE.test(String(id))) return null;
  return path.join(jobDir(), `${id}.json`);
}
function readJob(id) {
  const f = fileOf(id);
  if (!f || !fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; }
}
function writeJob(job) {
  const f = fileOf(job.id);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(job));
  fs.renameSync(tmp, f);
}
function listJobs() {
  try {
    return fs.readdirSync(jobDir()).filter((n) => /^bj_.*\.json$/.test(n)).map((n) => readJob(n.slice(0, -5))).filter(Boolean);
  } catch { return []; }
}
function markerOf(id) { const f = fileOf(id); return f ? f.replace(/\.json$/, '.cancel') : null; }
function cancelRequested(id) { const m = markerOf(id); return !!(m && fs.existsSync(m)); }
// DELIVERY REPORTS (utils/messageDelivery.js): what WhatsApp / the SMS provider
// said later about a message they accepted. A sidecar file, never a rewrite of
// the job file (the worker may be writing it at that very moment).
function deliveryFile(id) { const f = fileOf(id); return f ? f.replace(/.json$/, '.delivery') : null; }
function readDelivery(id) {
  const f = deliveryFile(id);
  if (!f || !fs.existsSync(f)) return {};
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) || {}; } catch { return {}; }
}
const DELIVERY_RANK = { SENT: 1, DELIVERED: 2, READ: 3 };
// Returns how many recipient rows this report belongs to.
function recordDelivery(providerRef, info) {
  if (!providerRef) return 0;
  let n = 0;
  const horizon = Date.now() - 45 * 86400000;
  let names = [];
  try { names = fs.readdirSync(jobDir()).filter((x) => /^bj_.*.json$/.test(x)); } catch { names = []; }
  names.forEach((name) => {
    const id = name.slice(0, -5);
    try { if (fs.statSync(path.join(jobDir(), name)).mtimeMs < horizon) return; } catch { return; }
    const job = readJob(id);
    if (!job || !job.recipients.some((r) => r.providerRef === providerRef)) return;
    const d = readDelivery(id);
    const cur = d[providerRef];
    if (info.status !== 'FAILED' && cur && (DELIVERY_RANK[cur.status] || 0) >= (DELIVERY_RANK[info.status] || 0)) { n += 1; return; }
    d[providerRef] = info;
    const f = deliveryFile(id);
    const tmp = `${f}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d));
    fs.renameSync(tmp, f);
    n += 1;
  });
  return n;
}
function removeJob(id) {
  const f = fileOf(id);
  const df = deliveryFile(id);
  if (df && fs.existsSync(df)) fs.unlinkSync(df);
  if (f && fs.existsSync(f)) fs.unlinkSync(f);
  const m = markerOf(id);
  if (m && fs.existsSync(m)) fs.unlinkSync(m);
}

// --- Summaries --------------------------------------------------------------
const blankCounts = () => Object.fromEntries(STATES.map((s) => [s, 0]));
function counts(job) {
  const c = { total: job.recipients.length, ...blankCounts() };
  const byChannel = {};
  job.recipients.forEach((r) => {
    c[r.status] = (c[r.status] || 0) + 1;
    byChannel[r.channel] = byChannel[r.channel] || blankCounts();
    byChannel[r.channel][r.status] = (byChannel[r.channel][r.status] || 0) + 1;
  });
  c.done = c.sent + c.failed + c.skipped + c.blocked;
  // After they were accepted: what the provider reported later (WhatsApp / SMS delivery reports).
  const dl = readDelivery(job.id);
  c.delivered = 0; c.read = 0; c.notDelivered = 0;
  job.recipients.forEach((r) => {
    const d = r.status === 'sent' && r.providerRef ? dl[r.providerRef] : null;
    if (!d) return;
    if (d.status === 'DELIVERED') c.delivered += 1;
    else if (d.status === 'READ') { c.delivered += 1; c.read += 1; } else if (d.status === 'FAILED') c.notDelivered += 1;
  });
  return { ...c, byChannel };
}
function summary(job, { withRecipients = false, masked = false } = {}) {
  const out = {
    id: job.id, createdAt: job.createdAt, createdBy: job.createdBy ? job.createdBy.name : null,
    kind: job.kind || 'bulk', audience: job.audience, channels: job.channels, purpose: job.purpose, language: job.language || 'English',
    templates: job.templates || {},
    status: job.status, finishedAt: job.finishedAt || null, outOfScope: job.outOfScope || 0,
    entities: job.entities || 0, counts: counts(job),
  };
  if (withRecipients) {
    const dl = readDelivery(job.id);
    out.recipients = job.recipients.map((r) => ({
      delivery: r.providerRef && dl[r.providerRef] ? dl[r.providerRef].status : null,
      deliveryAt: r.providerRef && dl[r.providerRef] ? dl[r.providerRef].at : null,
      deliveryError: r.providerRef && dl[r.providerRef] ? dl[r.providerRef].error || null : null,
      n: r.n, name: r.name, channel: r.channel, address: masked ? access.maskAddress(r.channel, r.address) : r.address, status: r.status,
      reason: r.reason || null, attempts: r.attempts || 0, sentAt: r.sentAt || null, providerRef: r.providerRef || null,
      subject: r.subject || null, text: r.text || null, sandbox: !!r.sandbox,
    }));
  }
  return out;
}

const REPORT_HEAD = ['#', 'Name', 'Channel', 'To', 'Status', 'Reason', 'Attempts', 'Sent at', 'Provider reference', 'Subject', 'Message', 'Delivery report'];
const safeCell = (v) => {
  const s = v == null ? '' : String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
};
function reportRows(job, masked = false) {
  const dl = readDelivery(job.id);
  const said = (r) => { const d = r.providerRef ? dl[r.providerRef] : null; return d ? `${d.status === 'FAILED' ? 'Not delivered' : d.status === 'READ' ? 'Read' : 'Delivered'}${d.error ? `: ${d.error}` : ''}` : ''; };
  return job.recipients.map((r) => [r.n, r.name, r.channel, masked ? access.maskAddress(r.channel, r.address) : r.address, r.status, r.reason, r.attempts || 0, r.sentAt || '', r.providerRef || '', r.subject || '', r.text || '', said(r)].map(safeCell));
}
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function reportCsv(job, masked = false) {
  return [REPORT_HEAD, ...reportRows(job, masked)].map((row) => row.map(csvCell).join(',')).join('\r\n');
}
function reportXlsx(job, masked = false) {
  // eslint-disable-next-line global-require
  return require('./tabularExport').toXlsx(REPORT_HEAD, reportRows(job, masked), 'Message result');
}

// --- Who may send to whom ---------------------------------------------------
// CONTACTING IS ITS OWN RIGHT (utils/contactAccess.js, Role Catalog "Contact (Mail / WhatsApp / SMS / Call)"),
// no longer "edit". mayContact = one person; mayBulkSend = a list (the old edit rights stay for that).
async function mayContact(user, audience) {
  if (!user || !AUDIENCES.includes(audience)) return false;
  return (await access.ruleFor(user, audience)).allowed;
}
async function mayBulkSend(user, audience) {
  if (!user || !AUDIENCES.includes(audience)) return false;
  return access.bulkAllowed(user, audience);
}

// --- Plan -------------------------------------------------------------------
const TEST_RECORD = /zztest|example\.test/i;
const labelOf = (k) => (T.TOKENS.find((t) => t.key === k) || { label: k }).label;

// What one channel will actually send, decided once per job from the chosen
// template: the wording, and HOW the provider takes it.
async function channelSpec(channel, input, language, statusMap, cfgs) {
  const own = (input.perChannel && input.perChannel[channel]) || {};
  const legacy = { subject: input.subject, body: input.body };
  let tpl = null;
  if (own.templateId || input.purposeKey) {
    tpl = await T.resolve({ purpose: input.purposeKey, channel, language, templateId: own.templateId });
  }
  const bodyAsked = own.body != null ? String(own.body) : (legacy.body != null && !tpl ? String(legacy.body) : null);
  const subjectAsked = own.subject != null ? String(own.subject) : (legacy.subject != null && !tpl ? String(legacy.subject) : null);
  const spec = {
    channel, template: tpl, mode: 'text', subject: subjectAsked != null ? subjectAsked : (tpl ? tpl.subject : ''),
    body: bodyAsked != null ? bodyAsked : (tpl ? tpl.body : ''), edited: false, block: null,
  };
  if (tpl && bodyAsked != null && bodyAsked.trim() !== tpl.body.trim()) spec.edited = true;
  if (tpl && channel === 'Email' && subjectAsked != null && subjectAsked.trim() !== String(tpl.subject).trim()) spec.edited = true;

  if (channel === 'SMS') {
    const dlt = tpl && tpl.source === 'saved' && tpl.dltTemplateId;
    if (dlt) {
      spec.mode = 'sms-dlt';
      spec.dlt = { templateId: tpl.dltTemplateId, senderId: tpl.senderId || null };
      spec.vars = T.waVarList(tpl);
      if (spec.edited) spec.error = 'This SMS uses a registered (DLT) template, so its wording cannot be edited here. Change the template instead.';
    }
  }
  if (channel === 'WhatsApp') {
    const wa = cfgs.WhatsApp;
    if (tpl && tpl.source === 'saved' && tpl.waStatus === 'Approved' && tpl.waTemplateName) {
      spec.mode = 'wa-template';
      spec.wa = { name: tpl.waTemplateName, language: tpl.waLanguageCode || undefined };
      spec.vars = T.waVarList(tpl);
      if (spec.edited) spec.error = 'WhatsApp only sends the wording Meta approved, so it cannot be edited here. Change the template instead.';
    } else if (wa && wa.templates && wa.templates.bulk) {
      spec.mode = 'wa-bulk';
    } else {
      const why = tpl && tpl.source === 'saved' && tpl.waTemplateName
        ? `The WhatsApp template "${tpl.waTemplateName}" is ${tpl.waStatus === 'Rejected' ? 'rejected by Meta' : 'not approved yet'}. WhatsApp only lets us start a chat with an approved template. An Admin sets the status to Approved in Message templates after Meta approves it.`
        : 'This WhatsApp message has no approved template. WhatsApp only lets us start a chat with a template approved by Meta. An Admin adds the template name and sets it Approved in Message templates.';
      spec.block = why;
    }
  }
  if (!String(spec.body).trim()) spec.error = spec.error || 'Write the message.';
  if (channel === 'Email' && !String(spec.subject).trim()) spec.error = spec.error || 'Give the email a subject.';
  return spec;
}

async function buildPlan(user, input) {
  const b = input || {};
  const audience = AUDIENCES.includes(b.audience) ? b.audience : 'candidates';
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))];
  const channels = messaging.CHANNELS.filter((c) => (Array.isArray(b.channels) ? b.channels : []).includes(c));
  const language = T.LANGUAGES.includes(b.language) ? b.language : 'English';
  const err = (status, error) => ({ error, status });

  const rule = await access.ruleFor(user, audience);
  const isOne = b.kind === 'individual';
  if (isOne ? !rule.allowed : !(await mayBulkSend(user, audience))) {
    return err(403, (!rule.allowed && rule.reason) || (rule.mode === 'masked' ? 'A list of people cannot be messaged from your role. Contact one person at a time.' : `Sending messages to ${audience} in bulk is not available to this login.`));
  }
  if (rule.purposes && !(b.purposeKey && rule.purposes.includes(b.purposeKey))) {
    return err(403, 'Accounts can send only the payment reminder templates, to the billing contact of a client.');
  }
  if (!ids.length) return err(400, 'Choose at least one person.');
  if (ids.length > LIMIT) return err(400, `At most ${LIMIT} people per send. Narrow the list and send in batches.`);
  if (!channels.length) return err(400, 'Choose Email, SMS and/or WhatsApp.');

  const status = await messaging.channelStatus();
  const cfgs = {};
  if (channels.includes('WhatsApp')) cfgs.WhatsApp = await require('./whatsappCloud').whatsappConfig().catch(() => null); // eslint-disable-line global-require
  // WhatsApp 24-hour window + STOP replies (utils/messageDelivery.js): a person who wrote to
  // us in the last 24 hours can be answered with plain text; a person who replied STOP is never messaged.
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  const windows = channels.includes('WhatsApp') ? await delivery.openWindows() : new Set();
  const optedOut = new Set();
  if (channels.includes('WhatsApp') || channels.includes('SMS')) {
    const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: delivery.OPTOUT_PREFIX } }, select: { key: true } }).catch(() => []);
    rows.forEach((x) => optedOut.add(x.key.slice(delivery.OPTOUT_PREFIX.length)));
  }
  const specs = {};
  for (const ch of channels) {
    // eslint-disable-next-line no-await-in-loop
    specs[ch] = await channelSpec(ch, b, language, status, cfgs);
    if (specs[ch].error) return err(400, `${ch}: ${specs[ch].error}`);
  }
  const unknown = [];
  channels.forEach((ch) => unknown.push(...T.unknownTokens(specs[ch].body), ...T.unknownTokens(specs[ch].subject)));
  if (unknown.length) return err(400, `These placeholders are not known: ${[...new Set(unknown)].map((u) => `{{${u}}}`).join(', ')}.`);

  const purposeLabel = String(b.purpose || '').trim().slice(0, 120)
    || (channels.map((c) => specs[c].template && specs[c].template.purposeLabel).find(Boolean)) || 'Message';

  const entities = await ctx.recipientsFor(user, audience, ids, { applicationId: b.applicationId, requirementId: b.requirementId, contactKind: rule.kind });
  if (b.kind === 'individual' && !entities.length) return err(403, `You cannot message this ${ONE_WORD[audience]}: they are outside your access, or no longer on the list.`);
  const sender = await ctx.senderTokens(user);
  // eslint-disable-next-line global-require
  const switchOn = audience === 'candidates' ? await require('./interviewNotices').candidateEmailsOn() : true;
  const sandbox = require('./sandbox').isSandbox(); // eslint-disable-line global-require
  const lim = await limits.load();
  const jobs = listJobs();
  const room = {};
  channels.forEach((c) => { room[c] = Math.max(0, lim[c].perDay - limits.usedToday(c, jobs)); });

  // QUIET HOURS (default 9 pm - 8 am India time): promotional kinds wait until morning; an interview reminder,
  // a document request and anything a person writes by hand are not promotional and are never held.
  const quiet = await require('./omniRules').quietNow(b.purposeKey, { urgent: !!b.urgent, ownWords: !b.purposeKey }); // eslint-disable-line global-require
  const seen = {};
  const recipients = [];
  let n = 0;
  entities.forEach((e) => {
    channels.forEach((channel) => {
      n += 1;
      const spec = specs[channel];
      const raw = channel === 'Email' ? e.email : (channel === 'WhatsApp' ? e.whatsapp : e.mobile);
      const r = { n, entityId: e.id, name: e.name, channel, address: String(raw || '').trim(), status: 'queued', attempts: 0, applicationId: e.applicationId || null };
      // Fill the message with THIS person's values FIRST, so even a message that
      // cannot be sent still shows the words (the person can copy it or open it
      // in their own mail / WhatsApp app).
      const values = { ...e.tokens, ...sender };
      const body = T.render(spec.body, values);
      const subject = channel === 'Email' ? T.render(spec.subject, values) : { text: '', missing: [] };
      const missing = [...new Set([...body.missing, ...subject.missing])];
      const varsMissing = [];
      let vars = null;
      if (spec.vars) {
        vars = spec.vars.map((k) => {
          const rr = T.render(`{{${k}}}`, values);
          if (rr.missing.length) varsMissing.push(k);
          return rr.text;
        });
      }
      const need = spec.vars ? varsMissing : missing;
      r.subject = channel === 'Email' ? subject.text : null;
      r.text = body.text;
      r.mode = spec.mode;
      r.locked = spec.mode === 'sms-dlt' || spec.mode === 'wa-template';
      if (need.length) r.missing = need;
      const skip = (why) => { r.status = 'skipped'; r.reason = why; recipients.push(r); };
      const block = (why) => { r.status = 'blocked'; r.reason = why; recipients.push(r); };
      if (e.doNotContact) { block('Asked not to be contacted (consent withdrawn)'); return; }
      if (!switchOn) { block(SWITCH_OFF_REASON); return; }
      if (quiet) { block(quiet); return; }
      if (!sandbox && (TEST_RECORD.test(String(e.name)) || TEST_RECORD.test(String(raw || '')))) { block('Test record: never messaged'); return; }
      if (!status[channel].configured) { r.notSetUp = true; block(`${channel} is not set up yet. ${status[channel].reason}`); return; }
      let viaWindow = false;
      if (spec.block) {
        if (channel === 'WhatsApp' && windows.has(delivery.digitsOf(raw))) viaWindow = true;
        else { block(spec.block); return; }
      }
      if (channel !== 'Email' && optedOut.has(`${channel}.${delivery.digitsOf(raw)}`)) { block(`They replied STOP on ${channel}, so nothing more is sent to them there.`); return; }
      let key = null;
      if (channel === 'Email') {
        if (!r.address) { skip('No email address on record'); return; }
        if (!core.validEmail(r.address)) { skip(`"${r.address}" is not a valid email address`); return; }
        // eslint-disable-next-line global-require
        if (require('./mailer').isReservedTestAddress(r.address)) { skip('Reserved test domain: never transmitted'); return; }
        key = r.address.toLowerCase();
      } else {
        const m = core.normalizeMobile(r.address);
        if (!m.ok) { skip(m.reason); return; }
        key = m.e164; r.address = `+${m.e164}`;
      }
      const dk = `${channel}:${key}`;
      if (seen[dk]) { skip(`Duplicate: same ${channel === 'Email' ? 'address' : 'number'} as ${seen[dk]}`); return; }
      seen[dk] = e.name;
      if (need.length) { skip(`Missing: ${need.map(labelOf).join(', ')}`); return; }
      if (room[channel] <= 0) { block(`Today's limit for ${channel} (${lim[channel].perDay} a day) is reached. An Admin can raise it in Message templates → Limits, or send the rest tomorrow.`); return; }
      room[channel] -= 1;
      if (spec.mode === 'sms-dlt') { r.vars = vars; r.dlt = spec.dlt; }
      if (spec.mode === 'wa-template') { r.vars = vars; r.wa = spec.wa; }
      if (spec.mode === 'wa-bulk') r.vars = [body.text];
      if (viaWindow) { r.mode = 'wa-text'; r.note = 'Plain text is allowed: they wrote to us on WhatsApp in the last 24 hours.'; }
      recipients.push(r);
    });
  });

  const tplInfo = {};
  channels.forEach((c) => {
    const t = specs[c].template;
    tplInfo[c] = { id: t && t.id, name: t ? t.name : 'Written by hand', version: t ? t.version : null, source: t ? t.source : 'typed', mode: specs[c].mode, edited: specs[c].edited };
  });
  return {
    plan: {
      audience, channels, purpose: purposeLabel, language, kind: b.kind === 'individual' ? 'individual' : 'bulk', recipients, templates: tplInfo,
      entities: entities.length, outOfScope: ids.length - entities.length, sender, switchOn, masked: rule.mode === 'masked', contactKind: rule.kind, omniNote: b.omniNote ? clipNote(b.omniNote) : null,
      limits: Object.fromEntries(channels.map((c) => [c, { perDay: lim[c].perDay, usedToday: lim[c].perDay - room[c] - recipients.filter((r) => r.channel === c && r.status === 'queued').length }])),
    },
  };
}

const clipNote = (t) => String(t).slice(0, 400);

function planView(plan) {
  const hide = plan.masked ? (r) => ({ ...r, address: access.maskAddress(r.channel, r.address) }) : (r) => r;
  // The first 3 people with something to send, with every channel they get.
  const firstThree = [...new Set(plan.recipients.filter((r) => r.status === 'queued').map((r) => r.entityId))].slice(0, 3);
  const sample = plan.recipients
    .filter((r) => r.status === 'queued' && firstThree.includes(r.entityId))
    .map((r) => ({ name: r.name, channel: r.channel, address: hide(r).address, subject: r.subject, text: r.text, mode: r.mode }));
  const by = (st) => plan.recipients.filter((r) => r.status === st);
  const reasons = {};
  plan.recipients.filter((r) => r.status === 'skipped' || r.status === 'blocked').forEach((r) => {
    const key = `${r.status}|${r.channel}|${r.reason}`;
    reasons[key] = reasons[key] || { status: r.status, channel: r.channel, reason: r.reason, names: [] };
    reasons[key].names.push(r.name);
  });
  return {
    audience: plan.audience, channels: plan.channels, purpose: plan.purpose, language: plan.language, templates: plan.templates,
    people: plan.entities, outOfScope: plan.outOfScope, switchOn: plan.switchOn, masked: !!plan.masked,
    toSend: by('queued').length, skipped: by('skipped').length, blocked: by('blocked').length,
    sendByChannel: Object.fromEntries(plan.channels.map((c) => [c, by('queued').filter((r) => r.channel === c).length])),
    peopleToSend: new Set(by('queued').map((r) => r.entityId)).size,
    sample,
    // The first person's message even when it cannot go (what to copy / open in their own app).
    first: plan.recipients[0] ? {
      status: plan.recipients[0].status, reason: plan.recipients[0].reason || null, address: hide(plan.recipients[0]).address, subject: plan.recipients[0].subject,
      text: plan.recipients[0].text, mode: plan.recipients[0].mode, locked: !!plan.recipients[0].locked, missing: plan.recipients[0].missing || [], notSetUp: !!plan.recipients[0].notSetUp,
    } : null,
    notSent: Object.values(reasons).map((x) => ({ status: x.status, channel: x.channel, reason: x.reason, count: x.names.length, names: x.names.slice(0, 8) })),
    limits: plan.limits,
  };
}

// The call script for one person, filled with their real details (a detail nobody has shows as "(not on record)").
async function renderScript(user, input) {
  const b = input || {};
  const audience = AUDIENCES.includes(b.audience) ? b.audience : 'candidates';
  const rule = await access.ruleFor(user, audience);
  if (!rule.allowed) return { error: rule.reason || 'Not available to this login.', status: 403 };
  const [e] = await ctx.recipientsFor(user, audience, [String(b.id || '')], { applicationId: b.applicationId, requirementId: b.requirementId, contactKind: rule.kind });
  if (!e) return { error: `This ${ONE_WORD[audience]} is outside your access.`, status: 403 };
  const language = T.LANGUAGES.includes(b.language) ? b.language : 'English';
  const tpl = b.purposeKey ? await T.resolve({ purpose: b.purposeKey, channel: 'Call', language }) : null;
  const sender = await ctx.senderTokens(user);
  const body = tpl ? T.render(tpl.body, { ...e.tokens, ...sender }, { blank: '(not on record)' }).text : '';
  // A role that may not see the number gets the words and a hint, never the number.
  return { script: { text: body, template: tpl ? { id: tpl.id, name: tpl.name, version: tpl.version, language: tpl.language } : null, phone: rule.mode === 'masked' ? null : (e.mobile || null), phoneHint: access.maskedHint(e.mobile), masked: rule.mode === 'masked' } };
}

async function preview(user, input) {
  const out = await buildPlan(user, input);
  if (out.error) return out;
  return { preview: planView(out.plan) };
}

// --- Create -----------------------------------------------------------------
async function createJob(user, input) {
  const out = await buildPlan(user, input);
  if (out.error) return out;
  const { plan } = out;
  const queued = plan.recipients.filter((r) => r.status === 'queued');
  const individual = plan.kind === 'individual';
  if (!individual) {
    const people = new Set(queued.map((r) => r.entityId)).size;
    if (input.confirmPeople === undefined || Number(input.confirmPeople) !== people) {
      return { error: `Please confirm: send to ${people} ${people === 1 ? 'person' : 'people'}. (The list has changed since you looked, or the number was not confirmed.)`, status: 409, people };
    }
  }
  // eslint-disable-next-line global-require
  const sender = await require('./candidateComms').senderIdentity(user).catch(() => ({}));
  const job = {
    id: `bj_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`,
    createdAt: new Date().toISOString(),
    createdBy: { id: user.id, name: user.name },
    kind: plan.kind, audience: plan.audience, channels: plan.channels, purpose: plan.purpose, language: plan.language, templates: plan.templates,
    sender: { senderEmail: sender.senderEmail || null, senderName: sender.senderName || null, senderUserId: sender.senderUserId || null, senderEmployeeId: sender.senderEmployeeId || null },
    entities: plan.entities,
    outOfScope: plan.outOfScope,
    omniNote: plan.omniNote || null,
    contactKind: plan.contactKind || 'primary',
    status: queued.length ? 'queued' : 'done',
    recipients: plan.recipients,
  };
  if (job.status === 'done') job.finishedAt = new Date().toISOString();
  writeJob(job);
  const c = counts(job);
  await logAudit({
    userId: user.id, actorName: user.name,
    action: individual ? `Message to one ${ENTITY[plan.audience].toLowerCase()} (${plan.channels.join(' + ')})` : `Bulk ${plan.channels.join(' + ')} to ${plan.entities} ${plan.audience}`,
    entity: 'MessageJob', entityId: job.id,
    toValue: `${plan.purpose} · ${c.queued} to send · ${c.skipped} skipped · ${c.blocked} blocked${job.outOfScope ? ` · ${job.outOfScope} outside your access` : ''}`,
  });
  if (job.status === 'done') await finish(job);
  kick();
  return { job: { ...summary(job, { masked: plan.masked }), masked: !!plan.masked } };
}

// --- The worker -------------------------------------------------------------
let running = false;
let timer = null;

async function sendOne(job, r) {
  await limits.pace(r.channel);
  const opts = {
    to: r.address,
    kind: 'bulk',
    subject: r.subject,
    text: r.text,
    vars: r.vars || [r.text],
    senderEmail: job.sender && job.sender.senderEmail,
    senderName: job.sender && job.sender.senderName,
  };
  if (r.mode === 'sms-dlt' && r.dlt) { opts.templateId = r.dlt.templateId; opts.senderId = r.dlt.senderId || undefined; }
  if (r.mode === 'wa-template' && r.wa) opts.template = r.wa;
  return messaging.send(r.channel, opts);
}

async function logHistory(job) {
  // A bulk send logs what went or failed; a one-person send also logs why it was blocked.
  const pending = job.recipients.filter((r) => (['sent', 'failed'].includes(r.status) || (job.kind === 'individual' && r.status === 'blocked')) && !r.logged);
  if (job.audience === 'candidates') {
    const rows = pending.map((r) => ({
      candidateId: r.entityId,
      applicationId: r.applicationId || null,
      channel: r.channel,
      template: job.kind === 'individual' ? 'MANUAL' : 'BULK',
      templateLabel: job.purpose,
      trigger: job.kind === 'individual' ? 'Manual' : 'Bulk',
      recipient: r.address,
      subject: r.channel === 'Email' ? r.subject : null,
      body: String(r.text || '').slice(0, 4000),
      status: r.status === 'sent' ? 'SENT' : (r.status === 'blocked' ? 'NOT_SENT_BLOCKED' : 'FAILED'),
      statusDetail: ((r.status === 'sent' ? `Sent (${job.kind} ${job.id})${r.sandbox ? ' - test server, not really transmitted' : ''}` : `Not delivered (${job.id}): ${r.reason || ''}`) + (job.omniNote ? ` | ${job.omniNote}` : '')).slice(0, 500),
      providerRef: r.providerRef || null,
      sentAt: r.sentAt ? new Date(r.sentAt) : null,
      attempts: r.attempts || 0,
      lastAttemptAt: r.lastAttemptAt ? new Date(r.lastAttemptAt) : null,
      lastError: r.status === 'failed' ? String(r.reason || '').slice(0, 500) : null,
      senderUserId: job.sender ? job.sender.senderUserId : null,
      senderEmployeeId: job.sender ? job.sender.senderEmployeeId : null,
      senderName: job.sender ? job.sender.senderName : null,
      senderEmail: job.sender ? job.sender.senderEmail : null,
    }));
    for (let i = 0; i < rows.length; i += 200) {
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidateMessage.createMany({ data: rows.slice(i, i + 200) }).catch((e) => console.error('[bulk] candidate log:', e.message));
    }
    // A message sent to ONE candidate is a contact: the open follow-up shows it as the last contact,
    // and the person's conversation (Inbox) moves to this message.
    if (job.kind === 'individual') {
      for (const r of pending) {
        // eslint-disable-next-line no-await-in-loop
        await convo.recordOut({ personType: 'CANDIDATE', personId: r.entityId, personName: r.name, channel: r.channel, body: r.text, templateLabel: job.purpose }).catch(() => {});
      }
      for (const r of pending.filter((x) => x.status === 'sent')) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.applicationFollowUp.updateMany({
          where: { candidateId: r.entityId, completedAt: null, ...(r.applicationId ? { applicationId: r.applicationId } : {}) },
          data: { lastContactedAt: new Date(), contactMode: r.channel },
        }).catch(() => {});
      }
    }
  } else {
    // A client contact or an employee: the person's CONVERSATION is their history (ConversationMessage), and the audit
    // log keeps its line for a one-person send.
    for (const r of pending) {
      if (job.kind === 'individual') {
        // eslint-disable-next-line no-await-in-loop
        await logAudit({
          userId: job.createdBy && job.createdBy.id, actorName: job.createdBy && job.createdBy.name,
          action: `${r.channel} message ${r.status === 'sent' ? 'sent' : (r.status === 'blocked' ? 'blocked' : 'failed')}: ${job.purpose}`,
          entity: ENTITY[job.audience], entityId: r.entityId, toValue: `${r.address}${r.reason ? ` · ${r.reason}` : ''}`.slice(0, 500),
        });
      }
      // eslint-disable-next-line no-await-in-loop
      await convo.recordOut({
        personType: convo.TYPES[job.audience], personId: r.entityId, personName: r.name, channel: r.channel, subject: r.channel === 'Email' ? r.subject : null,
        body: r.text, address: r.address, status: r.status === 'sent' ? 'SENT' : (r.status === 'blocked' ? 'NOT_SENT_BLOCKED' : 'FAILED'),
        statusDetail: (r.status === 'sent' ? `Sent (${job.kind} ${job.id})${r.sandbox ? ' - test server, not really transmitted' : ''}` : `Not delivered (${job.id}): ${r.reason || ''}`),
        providerRef: r.providerRef || null, templateLabel: job.purpose, senderUserId: job.sender ? job.sender.senderUserId : null, senderName: job.sender ? job.sender.senderName : null,
        note: job.omniNote || null, at: r.sentAt || r.lastAttemptAt || new Date(),
      }).catch((e) => console.error('[bulk] conversation log:', e.message));
    }
  }
  pending.forEach((r) => { r.logged = true; });
}

async function finish(job) {
  job.finishedAt = job.finishedAt || new Date().toISOString();
  await logHistory(job);
  writeJob(job);
  const c = counts(job);
  await logAudit({
    userId: job.createdBy ? job.createdBy.id : null, actorName: job.createdBy ? job.createdBy.name : null,
    action: 'Message send finished', entity: 'MessageJob', entityId: job.id,
    toValue: `${c.sent} sent · ${c.failed} failed · ${c.skipped} skipped · ${c.blocked} blocked`,
  }).catch(() => {});
}

// One lane: the due rows of one channel, in order, one at a time.
async function runLane(job, channel) {
  let did = 0;
  for (;;) {
    if (cancelRequested(job.id)) { job.status = 'cancelled'; return did; }
    const now = Date.now();
    const r = job.recipients.find((x) => x.channel === channel && x.status === 'queued' && (!x.nextAttemptAt || Date.parse(x.nextAttemptAt) <= now));
    if (!r) return did;
    r.status = 'sending';
    writeJob(job);
    // eslint-disable-next-line no-await-in-loop
    const res = await sendOne(job, r);
    r.attempts = (r.attempts || 0) + 1;
    r.lastAttemptAt = new Date().toISOString();
    if (res.ok) {
      Object.assign(r, { status: 'sent', sentAt: new Date().toISOString(), providerRef: res.providerRef || null, reason: null, nextAttemptAt: null, sandbox: !!res.sandbox || /sandbox/i.test(String(res.providerRef || '')) });
    } else if (res.transient && r.attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_MS[Math.min(r.attempts - 1, BACKOFF_MS.length - 1)] || 2000;
      Object.assign(r, { status: 'queued', reason: `Retrying (attempt ${r.attempts} of ${MAX_ATTEMPTS} failed: ${res.error})`.slice(0, 400), nextAttemptAt: new Date(Date.now() + wait).toISOString() });
    } else if (res.outcome === 'Not configured') {
      Object.assign(r, { status: 'blocked', reason: `${channel} is not set up: ${res.error}`.slice(0, 400), nextAttemptAt: null });
    } else if (res.outcome === 'Skipped') {
      Object.assign(r, { status: 'skipped', reason: String(res.error || 'Skipped').slice(0, 400), nextAttemptAt: null });
    } else {
      Object.assign(r, { status: 'failed', reason: `${res.error || 'Provider refused'}${r.attempts > 1 ? ` (after ${r.attempts} attempts)` : ''}`.slice(0, 400), nextAttemptAt: null });
    }
    writeJob(job);
    did += 1;
  }
}

async function runOnce() {
  if (running) return { skipped: 'already running' };
  running = true;
  try {
    const jobs = listJobs().filter((j) => j.status === 'queued' || j.status === 'running')
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const job of jobs) {
      if (job.status === 'queued') { job.status = 'running'; job.startedAt = new Date().toISOString(); writeJob(job); }
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(job.channels.map((ch) => runLane(job, ch)));
      if (job.status === 'cancelled') {
        job.recipients.forEach((r) => { if (r.status === 'queued') { r.status = 'skipped'; r.reason = 'Cancelled before sending'; } });
      }
      if (job.recipients.every((r) => FINAL.includes(r.status))) {
        if (job.status !== 'cancelled') job.status = 'done';
        else { const m = markerOf(job.id); if (m && fs.existsSync(m)) fs.unlinkSync(m); }
        // eslint-disable-next-line no-await-in-loop
        await finish(job);
      }
    }
    return { jobs: jobs.length };
  } catch (err) {
    console.error('[bulk-worker]', err && err.message);
    return { error: String(err && err.message) };
  } finally {
    running = false;
  }
}

function kick() { setTimeout(() => { runOnce().catch(() => {}); }, 100); }

// Individual send: create, then wait for the outcome so the screen can say
// Sent / Failed / Blocked at once (up to ~40 s; after that it says it is still sending).
async function sendIndividual(user, input) {
  const made = await createJob(user, { ...input, kind: 'individual', ids: [input.id], channels: [input.channel] });
  if (made.error) return made;
  const id = made.job.id;
  const until = Date.now() + 40000;
  let job = readJob(id);
  while (job && !['done', 'cancelled'].includes(job.status) && Date.now() < until) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 250); });
    job = readJob(id);
    if (!running && job && ['queued', 'running'].includes(job.status)) kick();
  }
  const row = job && job.recipients[0];
  const hideAddr = made.job && made.job.masked;
  return { jobId: id, masked: !!hideAddr, result: row ? { status: row.status, reason: row.reason || null, address: hideAddr ? access.maskAddress(row.channel, row.address) : row.address, attempts: row.attempts || 0, sandbox: !!row.sandbox, providerRef: row.providerRef || null } : null, finished: !!(job && job.status === 'done') };
}

// A row left 'sending' by a process that died cannot be known to have gone or
// not — it is failed with that reason instead of being sent twice.
function recoverInterrupted() {
  listJobs().forEach((job) => {
    let touched = false;
    job.recipients.forEach((r) => {
      if (r.status === 'sending') {
        Object.assign(r, { status: 'failed', reason: 'Interrupted by a server restart while sending — outcome unknown, not retried to avoid a duplicate.' });
        touched = true;
      }
    });
    if (touched) writeJob(job);
  });
}

function start() {
  if (timer || process.env.BULK_WORKER_INTERVAL_MS === '0') return;
  if (require('./sandbox').isSandbox()) return; // TEST SANDBOX: no interval runner  // eslint-disable-line global-require
  try { recoverInterrupted(); } catch (e) { console.error('[bulk-worker] recover:', e.message); }
  timer = setInterval(() => { runOnce().catch(() => {}); }, Number(process.env.BULK_WORKER_INTERVAL_MS || 1000));
  if (timer.unref) timer.unref();
}

function canSee(user, job) {
  if (!user || !job) return false;
  if (job.createdBy && job.createdBy.id === user.id) return true;
  // eslint-disable-next-line global-require
  return require('./scope').scopeOf(user).global;
}

function cancelJob(id) {
  const job = readJob(id);
  if (!job) return null;
  if (!['queued', 'running'].includes(job.status)) return job;
  // A marker file, not a rewrite of the job: the worker may be writing the
  // job file at this very moment and would overwrite a status change.
  fs.writeFileSync(markerOf(id), new Date().toISOString());
  if (!running) kick();
  return { ...job, status: 'cancelling' };
}

// "Retry failed": every FAILED row of a finished job goes back in the queue
// (a provider outage, or rows interrupted by a restart). Skipped and blocked
// rows stay as they are — their reason (no number, duplicate, switch off) has
// not changed by retrying.
async function retryFailed(id, user) {
  const job = readJob(id);
  if (!job) return null;
  if (['queued', 'running'].includes(job.status)) return { job, retried: 0, error: 'This send is still running.' };
  let n = 0;
  job.recipients.forEach((r) => {
    if (r.status === 'failed') {
      Object.assign(r, { status: 'queued', attempts: 0, nextAttemptAt: null, reason: `Retry requested${r.reason ? ` (was: ${r.reason})` : ''}`.slice(0, 400), logged: false });
      n += 1;
    }
  });
  if (n) {
    job.status = 'queued';
    job.finishedAt = null;
    writeJob(job);
    await logAudit({ userId: user.id, actorName: user.name, action: 'Message send: retry failed', entity: 'MessageJob', entityId: job.id, toValue: `${n} row(s) re-queued` }).catch(() => {});
    kick();
  }
  return { job, retried: n };
}

module.exports = {
  recordDelivery, LIMIT, AUDIENCES, createJob, preview, renderScript, sendIndividual, retryFailed, readJob, listJobs, removeJob, summary, reportCsv, reportXlsx,
  runOnce, kick, start, canSee, cancelJob, mayBulkSend, mayContact, jobDir, buildPlan, SWITCH_OFF_REASON,
};
