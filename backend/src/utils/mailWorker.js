// ---------------------------------------------------------------------------
// The sending worker.
//
// It picks up CandidateMessage rows that are waiting to go out, hands them to
// the SMTP provider, and writes back what the provider actually said.
//
// THE STATUS VOCABULARY IS HONEST. A row is only SENT when the provider
// accepted it, and it carries the provider's own message id as proof.
//
//   NOT_SENT_NO_PROVIDER  recorded, not transmitted. The correct state when
//                         no SMTP channel is configured — it is NOT an error
//                         and the worker leaves such rows exactly as they are.
//   QUEUED                a provider exists and this row is waiting its turn.
//   RETRY                 the provider failed temporarily; nextAttemptAt says
//                         when to try again.
//   SENT                  the provider accepted it. providerRef + sentAt set.
//   FAILED                the provider refused it, or the retries ran out.
//                         lastError carries the provider's reason.
//
// SMS and WhatsApp rows are untouched: there is still no gateway for either,
// so they keep NOT_SENT_NO_PROVIDER, which remains true.
// ---------------------------------------------------------------------------

const prisma = require('../db');
const { emailConfig, sendMail } = require('./mailer');
const { NOT_SENT, NOT_SENT_DETAIL } = require('./candidateComms');

const QUEUED = 'QUEUED';
const RETRY = 'RETRY';
const SENT = 'SENT';
const FAILED = 'FAILED';

// The statuses the worker will look at. Anything else (SENT, FAILED) is final.
const PICKUP_STATUSES = [NOT_SENT, QUEUED, RETRY];

const MAX_ATTEMPTS = Number(process.env.MAIL_MAX_ATTEMPTS || 5);
const BATCH = Number(process.env.MAIL_BATCH_SIZE || 10);
// Exponential-ish backoff, in minutes, indexed by attempt number.
const BACKOFF_MINUTES = [1, 5, 15, 60, 180];

function backoffFor(attempt) {
  const m = BACKOFF_MINUTES[Math.min(attempt, BACKOFF_MINUTES.length - 1)];
  return new Date(Date.now() + m * 60 * 1000);
}

let running = false;
let timer = null;
let lastRun = null;

// One pass. Returns a small summary so the route and the tests can assert on
// it without reading the log.
async function runOnce({ limit = BATCH } = {}) {
  if (running) return { skipped: 'already running' };
  running = true;
  const summary = {
    considered: 0, sent: 0, retried: 0, failed: 0, held: 0, configured: false,
  };
  try {
    const cfg = await emailConfig();
    summary.configured = cfg.configured;

    if (!cfg.configured) {
      // No provider. "Recorded, not transmitted" is the TRUE state, so every
      // waiting row goes back to it rather than sitting in a fake queue.
      const held = await prisma.candidateMessage.updateMany({
        where: { channel: 'Email', status: { in: [QUEUED, RETRY] } },
        data: { status: NOT_SENT, statusDetail: NOT_SENT_DETAIL, nextAttemptAt: null },
      });
      summary.held = held.count;
      return summary;
    }

    const now = new Date();
    const due = await prisma.candidateMessage.findMany({
      where: {
        channel: 'Email',
        status: { in: PICKUP_STATUSES },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    summary.considered = due.length;

    for (const row of due) {
      // A row with nobody to send to can never succeed — that is a hard
      // failure with an honest reason, not something to retry forever.
      if (!row.recipient || !String(row.recipient).trim()) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.candidateMessage.update({
          where: { id: row.id },
          data: {
            status: FAILED,
            statusDetail: "No email address on this candidate's record.",
            lastError: 'No recipient address',
            lastAttemptAt: new Date(),
            nextAttemptAt: null,
          },
        });
        summary.failed += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      // eslint-disable-next-line no-await-in-loop
      const result = await sendMail({
        to: row.recipient,
        subject: row.subject || row.templateLabel || 'A message about your application',
        text: row.body || '',
        senderEmail: row.senderEmail,
        senderName: row.senderName,
      });

      const attempts = (row.attempts || 0) + 1;
      if (result.ok) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.candidateMessage.update({
          where: { id: row.id },
          data: {
            status: SENT,
            statusDetail: `Accepted by the provider${result.response ? ` — ${result.response}` : ''}`.slice(0, 500),
            providerRef: result.providerRef,
            sentAt: new Date(),
            attempts,
            lastAttemptAt: new Date(),
            nextAttemptAt: null,
            lastError: null,
          },
        });
        summary.sent += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      if (result.notConfigured) {
        // The channel went away between the check above and this row.
        summary.held += 1;
        // eslint-disable-next-line no-continue
        continue;
      }

      const retryable = result.transient && attempts < MAX_ATTEMPTS;
      // eslint-disable-next-line no-await-in-loop
      await prisma.candidateMessage.update({
        where: { id: row.id },
        data: {
          status: retryable ? RETRY : FAILED,
          statusDetail: retryable
            ? `Temporary provider failure — attempt ${attempts} of ${MAX_ATTEMPTS}. ${result.error}`.slice(0, 500)
            : `Not delivered: ${result.error}`.slice(0, 500),
          lastError: String(result.error || '').slice(0, 500),
          attempts,
          lastAttemptAt: new Date(),
          nextAttemptAt: retryable ? backoffFor(attempts) : null,
        },
      });
      if (retryable) summary.retried += 1; else summary.failed += 1;
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
// "recorded, not transmitted". Called by Integrations on save.
async function requeueHeldMessages() {
  const cfg = await emailConfig();
  if (!cfg.configured) return { requeued: 0 };
  const r = await prisma.candidateMessage.updateMany({
    where: { channel: 'Email', status: NOT_SENT },
    data: { status: QUEUED, statusDetail: 'Queued for sending.', nextAttemptAt: null },
  });
  return { requeued: r.count };
}

module.exports = {
  QUEUED, RETRY, SENT, FAILED, MAX_ATTEMPTS,
  runOnce, kick, start, stop, requeueHeldMessages,
  status: () => ({ running, lastRun }),
};
