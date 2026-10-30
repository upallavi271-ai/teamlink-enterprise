// ---------------------------------------------------------------------------
// EXOTEL AI CALLING - THE BACKGROUND WORK, run by the EXISTING sweep (utils/interviewNotices.js startSweep, every 5 minutes on
// the real server). There is NO second scheduler: that sweep calls tick(). In the test sandbox no timer runs, so tests call
// tick({ now }) directly with a pretend clock.
//
// tick() does, in this order:
//   1. interview reminder calls  - for every live interview inside the biggest reminder window, for each reminder hour H
//                                  (default 24 and 2): when the interview is between H/2 and H hours away, ONE reminder call is
//                                  made, but only for a requirement where an Admin ticked "automatic reminders". Skipped:
//                                  cancelled / done / past interviews. One per (candidate, job, interview version, hour).
//   2. waiting calls that are due - queued for the next calling window, queued by the daily limit, or waiting for a retry.
//   3. calls stuck "calling" for 30 minutes with no word from Exotel -> failed (retried while attempts remain).
//   4. completed calls whose result never came -> "no result" recorded.
//   5. retention: transcripts / recordings older than the Admin's days are deleted.
// Nothing runs while AI calling is Off. A pretend or real failure in one step never stops the next.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const DB = require('./schema');
const settingsStore = require('./settings');
const svc = require('./callService');
const P = require('./policy');
const outcomes = require('./outcomes');

const HOUR = 3600000;

async function reminderCalls(s, t, summary) {
  const maxH = Math.max(...s.reminders);
  const apps = await prisma.application.findMany({
    where: { interviewStatus: { in: P.LIVE_INTERVIEW }, interviewAt: { gt: t, lte: new Date(t.getTime() + maxH * HOUR) }, stage: { notIn: P.CLOSED_STAGES } },
    select: { id: true, interviewAt: true, requirementId: true },
    take: 500,
  });
  for (const a of apps) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const jset = await svc.jobSetting(a.requirementId);
    if (!jset || jset.autoReminders !== 1 || jset.enabled === 0) continue; // eslint-disable-line no-continue
    const remaining = new Date(a.interviewAt).getTime() - t.getTime();
    for (const h of s.reminders) { // eslint-disable-line no-restricted-syntax
      if (!(remaining <= h * HOUR && remaining > (h * HOUR) / 2)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await svc.createCalls(null, { items: [a.id], purpose: 'Interview Reminder', confirm: true, auto: true, via: 'reminder', slot: `r${h}` });
      const res = r.results && r.results[0];
      if (res && res.ok) summary.reminders += 1;
      else if (res && res.code === 'duplicate') summary.reminderDuplicates += 1;
      else summary.reminderSkipped += 1;
    }
  }
}

async function dueCalls(t, summary) {
  const rows = await DB.all(`SELECT "id" FROM "AiCall" WHERE (("status" = 'queued') OR ("status" IN ('busy','no-answer','failed') AND "nextAttemptAt" IS NOT NULL))
    AND "nextAttemptAt" <= ? ORDER BY "nextAttemptAt" ASC LIMIT 50`, t.toISOString());
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const d = await svc.dispatch(r.id);
    if (d.status === 'calling') summary.started += 1; else summary.waiting += 1;
  }
}

async function stuckCalls(s, t, summary) {
  const cutoff = new Date(t.getTime() - 30 * 60000).toISOString();
  const rows = await DB.all('SELECT * FROM "AiCall" WHERE "status" = \'calling\' AND "startedAt" <= ? LIMIT 50', cutoff);
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    const why = 'Exotel did not report the end of this call (no confirmation after 30 minutes).';
    const more = r.attempts < r.maxAttempts;
    // eslint-disable-next-line no-await-in-loop
    await svc.setRow(r.id, {
      status: 'failed', failReason: why, endedAt: t.toISOString(), nextAttemptAt: more ? new Date(t.getTime() + svc.gapFor(s, r.attempts)).toISOString() : null, waitReason: more ? `Trying again (attempt ${r.attempts + 1} of ${r.maxAttempts}).` : null,
    });
    // eslint-disable-next-line no-await-in-loop
    await outcomes.attemptFailed(await svc.getCall(r.id), why, !more);
    summary.timedOut += 1;
  }
}

// Retention: the Admin's days. Only the words and the recording link are removed; the outcome and summary stay.
async function purge(t, summary) {
  const rows = await DB.all('SELECT "id","applicationId" FROM "AiCall" WHERE "purgeAt" IS NOT NULL AND "purgeAt" <= ? AND ("transcript" IS NOT NULL OR "recordingUrl" IS NOT NULL) LIMIT 200', t.toISOString());
  for (const r of rows) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    await svc.setRow(r.id, { transcript: null, recordingUrl: null, purgeAt: null });
    summary.purged += 1;
  }
  if (rows.length) await logAudit({ userId: null, actorName: 'AI assistant', action: 'AI call transcripts / recordings purged', entity: 'Integration', entityId: 'exotel-ai', toValue: `${rows.length} call(s) past their retention days` });
}

async function tick({ now: at } = {}) {
  if (at) svc.setClock(() => at);
  const t = at || svc.now();
  const summary = { at: t.toISOString(), reminders: 0, reminderDuplicates: 0, reminderSkipped: 0, started: 0, waiting: 0, timedOut: 0, resultsFilled: 0, purged: 0 };
  try {
    // call-back reminders to recruiters go out even when the AI calling switch is Off (they are the recruiter's own work)
    try { summary.callbacks = await require('./callbacks').tick(t); } catch (err) { console.error('[ai-calling] call-back sweep:', err.message); } // eslint-disable-line global-require, no-console
    const s = await settingsStore.load({ fresh: true });
    if (s.mode === 'Off') return { ...summary, skipped: 'AI calling is off' };
    const steps = [
      s.configured ? () => reminderCalls(s, t, summary) : null,
      s.configured ? () => dueCalls(t, summary) : null,
      () => stuckCalls(s, t, summary),
      async () => { summary.resultsFilled = await outcomes.finalizeStale(); },
      () => purge(t, summary),
    ].filter(Boolean);
    for (const step of steps) { // eslint-disable-line no-restricted-syntax
      try { await step(); } catch (err) { console.error('[ai-calling] sweep step:', err.message); } // eslint-disable-line no-await-in-loop, no-console
    }
  } finally {
    if (at) svc.setClock(null);
  }
  return summary;
}

module.exports = { tick, reminderCalls, dueCalls, stuckCalls, purge };
