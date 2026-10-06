// ---------------------------------------------------------------------------
// BULK MESSAGING — one message to many candidates, clients or employees, on
// Email, SMS and/or WhatsApp, as a QUEUE with a status per recipient.
//
//   createJob()   resolves the recipients INSIDE THE CALLER'S SCOPE, drops
//                 anyone they may not reach (counted, never messaged), and
//                 for every recipient × channel decides up front:
//                   queued   will be sent
//                   skipped  no / invalid address, duplicate address, reserved
//                            test domain, or the channel is not configured —
//                            with the reason in words
//   the worker    sends the queued rows, one lane per channel so each keeps
//                 its own rate limit (utils/messagingCore.js acquire()),
//                 retries TRANSIENT provider failures with backoff
//                 (2 s, 8 s, 30 s — four attempts), and records the
//                 provider's own words on a permanent failure.
//   report        GET …/report.csv — every recipient with status and reason.
//
// WHERE THE QUEUE LIVES. One JSON file per job under MESSAGE_JOB_DIR (default
// ~/.teamlink-message-jobs, outside the repository, like uploads). A file per
// job survives the dev server restarting mid-run — nodemon restarts it every
// time a source file changes — without adding a table. Writes are atomic
// (temp file + rename). A row that was mid-send when the process died is
// marked failed "interrupted — outcome unknown" rather than sent twice.
//
// Candidate sends are ALSO written to the candidate's own communication log
// (CandidateMessage) once their outcome is known, as SENT or FAILED — never as
// a waiting row the stage-change mail worker could pick up and send again.
// ---------------------------------------------------------------------------

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const prisma = require('../db');
const messaging = require('./messaging');
const core = require('./messagingCore');
const { logAudit } = require('./audit');

const LIMIT = 500;
const MAX_ATTEMPTS = 4;
const BACKOFF_MS = (process.env.BULK_BACKOFF_MS || '2000,8000,30000').split(',').map(Number);
const AUDIENCES = ['candidates', 'clients', 'employees'];
const FINAL = ['sent', 'failed', 'skipped'];

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
function removeJob(id) {
  const f = fileOf(id);
  if (f && fs.existsSync(f)) fs.unlinkSync(f);
  const m = markerOf(id);
  if (m && fs.existsSync(m)) fs.unlinkSync(m);
}

// --- Summaries --------------------------------------------------------------
function counts(job) {
  const c = { total: job.recipients.length, queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  const byChannel = {};
  job.recipients.forEach((r) => {
    c[r.status] = (c[r.status] || 0) + 1;
    byChannel[r.channel] = byChannel[r.channel] || { queued: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
    byChannel[r.channel][r.status] += 1;
  });
  c.done = c.sent + c.failed + c.skipped;
  return { ...c, byChannel };
}
function summary(job, { withRecipients = false } = {}) {
  const out = {
    id: job.id, createdAt: job.createdAt, createdBy: job.createdBy ? job.createdBy.name : null,
    audience: job.audience, channels: job.channels, purpose: job.purpose,
    status: job.status, finishedAt: job.finishedAt || null, outOfScope: job.outOfScope || 0,
    entities: job.entities || 0, counts: counts(job),
  };
  if (withRecipients) {
    out.recipients = job.recipients.map((r) => ({
      n: r.n, name: r.name, channel: r.channel, address: r.address, status: r.status,
      reason: r.reason || null, attempts: r.attempts || 0, sentAt: r.sentAt || null, providerRef: r.providerRef || null,
    }));
  }
  return out;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
}
function reportCsv(job) {
  const head = ['#', 'Name', 'Channel', 'Address', 'Status', 'Reason', 'Attempts', 'Sent at', 'Provider reference'];
  const rows = job.recipients.map((r) => [r.n, r.name, r.channel, r.address, r.status, r.reason, r.attempts || 0, r.sentAt || '', r.providerRef || '']);
  return [head, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
}

// --- Who may send to whom ---------------------------------------------------
async function mayBulkSend(user, audience) {
  // eslint-disable-next-line global-require
  const { can } = require('./permissions');
  if (!user || ['CLIENT', 'CANDIDATE'].includes(user.role) || ['CLIENT', 'CANDIDATE'].includes(user.atsRole)) return false;
  if (audience === 'candidates') return can(user, 'ats', 'candidates', 'Candidate Master', 'edit');
  if (audience === 'clients') return can(user, 'ats', 'clients', 'Client Detail', 'edit');
  if (audience === 'employees') return can(user, 'hrms', 'hrms', 'Employee Management', 'edit');
  return false;
}

// Entities the caller asked for AND may reach, with their addresses.
async function resolveEntities(user, audience, ids) {
  // eslint-disable-next-line global-require
  const scope = require('./scope');
  const s = scope.atsScopeOf(user);
  if (audience === 'candidates') {
    const where = s.global ? { id: { in: ids } } : { AND: [{ id: { in: ids } }, { applications: { some: scope.applicationWhere(user) } }] };
    // b5_: consent withdrawn = do not contact (utils/candidateRecord.js) — skipped below with the reason.
    const dnc = require('./candidateRecord').supported(); // eslint-disable-line global-require
    const rows = await prisma.candidate.findMany({ where, select: { id: true, name: true, email: true, phone: true, ...(dnc ? { doNotContact: true, consentStatus: true } : {}) } });
    return rows.map((c) => ({
      id: c.id, name: c.name, email: c.email, mobile: c.phone, whatsapp: c.phone, doNotContact: !!(c.doNotContact || c.consentStatus === 'WITHDRAWN'),
    }));
  }
  if (audience === 'clients') {
    const rows = await prisma.client.findMany({
      where: { AND: [{ id: { in: ids } }, scope.clientWhere(user)] },
      select: { id: true, name: true, contactName: true, contactEmail: true, contactPhone: true, contactWhatsApp: true },
    });
    return rows.map((c) => ({
      id: c.id, name: c.contactName ? `${c.contactName} (${c.name})` : c.name, greet: c.contactName || c.name,
      email: c.contactEmail, mobile: c.contactPhone, whatsapp: c.contactWhatsApp || c.contactPhone,
    }));
  }
  const rows = await prisma.employee.findMany({
    where: { AND: [{ id: { in: ids } }, scope.employeeWhere(user)] },
    select: { id: true, name: true, email: true, phone: true },
  });
  return rows.map((e) => ({ id: e.id, name: e.name, email: e.email, mobile: e.phone, whatsapp: e.phone }));
}

function fill(text, name) {
  const who = String(name || 'there').trim() || 'there';
  return String(text || '').split('{name}').join(who).split('{firstName}').join(who.split(/\s+/)[0]);
}

// --- Create -----------------------------------------------------------------
async function createJob(user, input) {
  const b = input || {};
  const audience = AUDIENCES.includes(b.audience) ? b.audience : 'candidates';
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(String).filter(Boolean))];
  const channels = messaging.CHANNELS.filter((c) => (Array.isArray(b.channels) ? b.channels : []).includes(c));
  const purpose = String(b.purpose || '').trim().slice(0, 120);
  const body = String(b.body || '').trim().slice(0, 4000);
  const subject = String(b.subject || purpose).trim().slice(0, 200);
  const err = (status, error) => ({ error, status });

  if (!(await mayBulkSend(user, audience))) return err(403, `Bulk messaging to ${audience} is not available to this login.`);
  if (!ids.length) return err(400, 'Select at least one recipient.');
  if (ids.length > LIMIT) return err(400, `At most ${LIMIT} recipients per send — narrow the selection and send in batches.`);
  if (!channels.length) return err(400, 'Choose Email, SMS and/or WhatsApp.');
  if (!purpose) return err(400, 'Say what this message is for.');
  if (!body) return err(400, 'Write the message.');
  if (channels.includes('Email') && !subject) return err(400, 'Give the email a subject.');

  const entities = await resolveEntities(user, audience, ids);
  const status = await messaging.channelStatus();
  const seen = {};
  const recipients = [];
  let n = 0;
  entities.forEach((e) => {
    channels.forEach((channel) => {
      n += 1;
      const raw = channel === 'Email' ? e.email : (channel === 'WhatsApp' ? e.whatsapp : e.mobile);
      const r = { n, entityId: e.id, name: e.name, greet: e.greet || e.name, channel, address: String(raw || '').trim(), status: 'queued', attempts: 0 };
      let key = null;
      if (e.doNotContact) { r.status = 'skipped'; r.reason = 'Asked not to be contacted (consent withdrawn)'; recipients.push(r); return; }
      if (channel === 'Email') {
        if (!r.address) { r.status = 'skipped'; r.reason = 'No email address on record'; } else if (!core.validEmail(r.address)) { r.status = 'skipped'; r.reason = `"${r.address}" is not a valid email address`; } else key = r.address.toLowerCase();
        if (key && require('./mailer').isReservedTestAddress(r.address)) { r.status = 'skipped'; r.reason = 'Reserved test domain — never transmitted'; key = null; }
      } else {
        const m = core.normalizeMobile(r.address);
        if (!m.ok) { r.status = 'skipped'; r.reason = m.reason; } else { key = m.e164; r.address = `+${m.e164}`; }
      }
      if (key) {
        const dk = `${channel}:${key}`;
        if (seen[dk]) { r.status = 'skipped'; r.reason = `Duplicate — same ${channel === 'Email' ? 'address' : 'number'} as ${seen[dk]}`; } else seen[dk] = e.name;
      }
      if (r.status === 'queued' && !status[channel].configured) { r.status = 'skipped'; r.reason = `Not configured — ${status[channel].reason}`; }
      recipients.push(r);
    });
  });

  // eslint-disable-next-line global-require
  const sender = audience === 'candidates' ? await require('./candidateComms').senderIdentity(user).catch(() => ({})) : {};
  const job = {
    id: `bj_${Date.now().toString(36)}${crypto.randomBytes(5).toString('hex')}`,
    createdAt: new Date().toISOString(),
    createdBy: { id: user.id, name: user.name },
    audience, channels, purpose, subject, body,
    sender: { senderEmail: sender.senderEmail || null, senderName: sender.senderName || null, senderUserId: sender.senderUserId || null, senderEmployeeId: sender.senderEmployeeId || null },
    entities: entities.length,
    outOfScope: ids.length - entities.length,
    status: recipients.some((r) => r.status === 'queued') ? 'queued' : 'done',
    recipients,
  };
  if (job.status === 'done') job.finishedAt = new Date().toISOString();
  writeJob(job);
  const c = counts(job);
  await logAudit({
    userId: user.id, actorName: user.name, action: `Bulk ${channels.join(' + ')} to ${entities.length} ${audience}`,
    entity: 'MessageJob', entityId: job.id,
    toValue: `${purpose} · ${c.queued} queued · ${c.skipped} skipped${job.outOfScope ? ` · ${job.outOfScope} outside your access` : ''}`,
  });
  kick();
  return { job: summary(job) };
}

// --- The worker -------------------------------------------------------------
let running = false;
let timer = null;

async function sendOne(job, r) {
  const text = fill(job.body, r.greet);
  return messaging.send(r.channel, {
    to: r.address,
    kind: 'bulk',
    subject: fill(job.subject, r.greet),
    text,
    vars: [text],
    senderEmail: job.sender && job.sender.senderEmail,
    senderName: job.sender && job.sender.senderName,
  });
}

async function logToCandidates(job) {
  if (job.audience !== 'candidates' || job.loggedToCandidates) return;
  const pending = job.recipients.filter((r) => (r.status === 'sent' || r.status === 'failed') && !r.logged);
  const rows = pending.map((r) => ({
    candidateId: r.entityId,
    channel: r.channel,
    template: 'BULK',
    templateLabel: job.purpose,
    trigger: 'Bulk',
    recipient: r.address,
    subject: r.channel === 'Email' ? fill(job.subject, r.greet) : null,
    body: fill(job.body, r.greet).slice(0, 4000),
    status: r.status === 'sent' ? 'SENT' : 'FAILED',
    statusDetail: (r.status === 'sent' ? `Sent (bulk ${job.id})` : `Not delivered (bulk ${job.id}): ${r.reason || ''}`).slice(0, 500),
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
  pending.forEach((r) => { r.logged = true; });
  job.loggedToCandidates = true;
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
      Object.assign(r, { status: 'sent', sentAt: new Date().toISOString(), providerRef: res.providerRef || null, reason: null, nextAttemptAt: null });
    } else if (res.transient && r.attempts < MAX_ATTEMPTS) {
      const wait = BACKOFF_MS[Math.min(r.attempts - 1, BACKOFF_MS.length - 1)] || 2000;
      Object.assign(r, { status: 'queued', reason: `Retrying (attempt ${r.attempts} of ${MAX_ATTEMPTS} failed: ${res.error})`.slice(0, 400), nextAttemptAt: new Date(Date.now() + wait).toISOString() });
    } else if (res.outcome === 'Not configured' || res.outcome === 'Skipped') {
      Object.assign(r, { status: 'skipped', reason: `${res.outcome} — ${res.error}`.slice(0, 400), nextAttemptAt: null });
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
        job.finishedAt = job.finishedAt || new Date().toISOString();
        // eslint-disable-next-line no-await-in-loop
        await logToCandidates(job);
        writeJob(job);
        const c = counts(job);
        // eslint-disable-next-line no-await-in-loop
        await logAudit({
          userId: job.createdBy ? job.createdBy.id : null, actorName: job.createdBy ? job.createdBy.name : null,
          action: 'Bulk message finished', entity: 'MessageJob', entityId: job.id,
          toValue: `${c.sent} sent · ${c.failed} failed · ${c.skipped} skipped`,
        }).catch(() => {});
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
  if (require('./sandbox').isSandbox()) return; // TEST SANDBOX: no interval runner
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
// (a provider outage, or rows interrupted by a restart). Skipped rows stay
// skipped — their reason (no number, duplicate, not configured) has not
// changed by retrying.
async function retryFailed(id, user) {
  const job = readJob(id);
  if (!job) return null;
  if (['queued', 'running'].includes(job.status)) return { job, retried: 0, error: 'This send is still running.' };
  let n = 0;
  job.recipients.forEach((r) => {
    if (r.status === 'failed') {
      Object.assign(r, { status: 'queued', attempts: 0, nextAttemptAt: null, reason: `Retry requested${r.reason ? ` (was: ${r.reason})` : ''}`.slice(0, 400) });
      n += 1;
    }
  });
  if (n) {
    job.status = 'queued';
    job.finishedAt = null;
    job.loggedToCandidates = false;
    // Rows already written to the candidates' logs are not written twice.
    job.recipients.forEach((r) => { if (r.status === 'sent' || r.status === 'failed') r.logged = true; });
    writeJob(job);
    await logAudit({ userId: user.id, actorName: user.name, action: 'Bulk message — retry failed rows', entity: 'MessageJob', entityId: job.id, toValue: `${n} row(s) re-queued` }).catch(() => {});
    kick();
  }
  return { job, retried: n };
}

module.exports = {
  LIMIT, AUDIENCES, createJob, retryFailed, readJob, listJobs, removeJob, summary, reportCsv,
  runOnce, kick, start, canSee, cancelJob, mayBulkSend, jobDir,
};
