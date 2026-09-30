// ---------------------------------------------------------------------------
// The sending worker for candidate messages (stage-change notices).
//
// It picks up CandidateMessage rows that are waiting to go out, hands them to
// the channel's provider — SMTP for Email, the SMS gateway, the WhatsApp Cloud
// API (utils/messaging.js) — and writes back what the provider actually said.
//
// THE STATUS VOCABULARY IS HONEST. A row is only SENT when the provider
// accepted it, and it carries the provider's own message id as proof.
//
//   NOT_SENT_NO_PROVIDER  recorded, not transmitted. The correct state when
//                         the row's channel is not configured — NOT an error;
//                         the worker leaves such rows as they are.
//   QUEUED                a provider exists and this row is waiting its turn.
//   RETRY                 the provider failed temporarily; nextAttemptAt says
//                         when to try again.
//   SENT                  the provider accepted it. providerRef + sentAt set.
//   FAILED                the provider refused it, the address is unusable,
//                         or the retries ran out. lastError says why.
//
// SMS / WHATSAPP ROWS recorded while no provider existed are NOT swept up and
// sent days later when one is configured — only rows from the last day are
// re-queued (requeueHeldMessages). A stale "your interview is tomorrow" text
// is worse than none. Email keeps its original behaviour.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { emailConfig } = require('./mailer');
const { NOT_SENT, NOT_SENT_DETAIL } = require('./candidateComms');

const QUEUED = 'QUEUED';
const RETRY = 'RETRY';
const SENT = 'SENT';
const FAILED = 'FAILED';

const CHANNELS = ['Email', 'SMS', 'WhatsApp'];
// Email also picks up NOT_SENT (its long-standing behaviour); SMS / WhatsApp
// only rows that were queued while their provider was configured.
const PICKUP = { Email: [NOT_SENT, QUEUED, RETRY], SMS: [QUEUED, RETRY], WhatsApp: [QUEUED, RETRY] };

const MAX_ATTEMPTS = Number(process.env.MAIL_MAX_ATTEMPTS || 5);
const BATCH = Number(process.env.MAIL_BATCH_SIZE || 10);
// Exponential-ish backoff, in minutes, indexed by attempt number.
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];
const FRESH_MS = 24 * 3600 * 1000;

function backoffFor(attempt) {
  const m = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + m * 60 * 1000);
}

let running = false;
let timer = null;
let lastRun = null;

async function configuredChannels() {
  // eslint-disable-next-line global-require
  const status = await require('./messaging').channelStatus().catch(() => null);
  if (status) return status;
  const cfg = await emailConfig().catch(() => ({ configured: false }));
  return { Email: { configured: cfg.configured }, SMS: { configured: false }, WhatsApp: { configured: false } };
}

async function processRow(row, summary) {
  if (!row.recipient || !String(row.recipient).trim()) {
    await prisma.candidateMessage.update({
      where: { id: row.id },
      data: {
        status: FAILED,
        statusDetail: `No ${row.channel === 'Email' ? 'email address' : 'mobile number'} on this candidate's record.`,
        lastError: 'No recipient address', lastAttemptAt: new Date(), nextAttemptAt: null,
      },
    });
    summary.failed += 1;
    return;
  }
  // eslint-disable-next-line global-require
  const result = await require('./messaging').send(row.channel, {
    to: row.recipient,
    kind: 'bulk',
    subject: row.subject || row.templateLabel || 'A message about your application',
    text: row.body || '',
    vars: [row.body || ''],
    senderEmail: row.senderEmail,
    senderName: row.senderName,
  });
  const attempts = (row.attempts || 0) + 1;
  if (result.ok) {
    await prisma.candidateMessage.update({
      where: { id: row.id },
      data: {
        status: SENT,
        statusDetail: `Accepted by the provider${result.response ? ` — ${result.response}` : ''}`.slice(0, 500),
        providerRef: result.providerRef, sentAt: new Date(), attempts,
        lastAttemptAt: new Date(), nextAttemptAt: null, lastError: null,
      },
    });
    summary.sent += 1;
    return;
  }
  if (result.notConfigured) { summary.held += 1; return; }
  const retryable = result.transient && attempts < MAX_ATTEMPTS;
  await prisma.candidateMessage.update({
    where: { id: row.id },
    data: {
      status: retryable ? RETRY : FAILED,
      statusDetail: retryable
        ? `Temporary provider failure — attempt ${attempts} of ${MAX_ATTEMPTS}. ${result.error}`.slice(0, 500)
        : `Not delivered: ${result.error}`.slice(0, 500),
      lastError: String(result.error || '').slice(0, 500),
      attempts, lastAttemptAt: new Date(), nextAttemptAt: retryable ? backoffFor(attempts) : null,
    },
  });
  if (retryable) summary.retried += 1; else summary.failed += 1;
}

// One pass. Returns a small summary so the route and the tests can assert on
// it without reading the log.
async function runOnce({ limit = BATCH } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const summary = {
    considered: 0, sent: 0, retried: 0, failed: 0, held: 0, configured: false, channels: {},
  };
  try {
    const status = await configuredChannels();
    summary.configured = !!status.Email.configured;
    const now = new Date();
    // eslint-disable-next-line no-restricted-syntax
    for (const channel of CHANNELS) {
      summary.channels[channel] = !!status[channel].configured;
      if (!status[channel].configured) {
        // No provider: "recorded, not transmitted" is the TRUE state, so every
        // waiting row goes back to it rather than sitting in a fake queue.
        // eslint-disable-next-line no-await-in-loop
        const held = await prisma.candidateMessage.updateMany({
          where: { channel, status: { in: [QUEUED, RETRY] } },
          data: { status: NOT_SENT, statusDetail: NOT_SENT_DETAIL, nextAttemptAt: null },
        });
        summary.held += held.count;
        // eslint-disable-next-line no-continue
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const due = await prisma.candidateMessage.findMany({
        where: {
          channel,
          status: { in: PICKUP[channel] },
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      });
      summary.considered += due.length;
      // eslint-disable-next-line no-restricted-syntax
      for (const row of due) {
        // eslint-disable-next-line no-await-in-loop
        await processRow(row, summary);
      }
    }
    return summary;
  } catch (err) {
    // Never let a worker pass take the process down. The message is the
    // worker's own, not a provider secret.
    console.error('[mail-worker]', err && err.message ? err.message : err);
    summary.error = String((err && err.message) || err);
    return summary;
  } finally {
    running = false;
    lastRun = new Date();
  }
}

// Called right after a stage change writes rows, so a message goes out in
// seconds rather than on the next tick. Fire-and-forget by design.
function kick() {
  setTimeout(() => { runOnce().catch(() => {}); }, 250);
}

// The interval loop. MAIL_WORKER_INTERVAL_MS=0 switches it off (tests do).
function start() {
  const ms = Number(process.env.MAIL_WORKER_INTERVAL_MS == null ? 60000 : process.env.MAIL_WORKER_INTERVAL_MS);
  if (!ms) return null;
  if (timer) return timer;
  timer = setInterval(() => { runOnce().catch(() => {}); }, ms);
  if (timer.unref) timer.unref();
  // One pass shortly after boot, so a restart drains whatever was waiting.
  setTimeout(() => { runOnce().catch(() => {}); }, 5000).unref?.();
  return timer;
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

// When a provider is configured, waiting rows should say "queued", not
// "recorded, not transmitted". Called by Integrations on save. `channel`
// limits it to one channel; SMS / WhatsApp only re-queue the last day's rows.
async function requeueHeldMessages(channel = 'Email') {
  const status = await configuredChannels();
  if (!status[channel] || !status[channel].configured) return { requeued: 0 };
  const r = await prisma.candidateMessage.updateMany({
    where: {
      channel,
      status: NOT_SENT,
      ...(channel === 'Email' ? {} : { createdAt: { gte: new Date(Date.now() - FRESH_MS) } }),
    },
    data: { status: QUEUED, statusDetail: 'Queued for sending.', nextAttemptAt: null },
  });
  return { requeued: r.count };
}

module.exports = {
  QUEUED, RETRY, SENT, FAILED, MAX_ATTEMPTS,
  runOnce, kick, start, stop, requeueHeldMessages,
  status: () => ({ running, lastRun }),
};
