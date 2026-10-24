// ---------------------------------------------------------------------------
// THE SENDING WORKER. A loop inside the API process (started by index.js, NEVER in the sandbox) that takes queued OutreachMessage rows and
// hands them to the channel adapter (Email, WhatsApp, SMS), one at a time. Call tasks (channel 'call') are for a PERSON: the runner never claims them.
//
//   SWITCH       settings.master ("Outreach sending", default OFF). Off = the loop does nothing at all (not even a rehearsal).
//   LEASE        OutreachRunnerLease row 'sender': one loop at a time across processes (atomic upsert-where-expired, 30 s, renewed every tick).
//   CLAIM        ONE atomic UPDATE ... WHERE id = (SELECT ... queued, due, this channel, campaign running, minute-rate not exceeded) RETURNING *: two workers
//                can never get the same row, and the per-minute rate is enforced inside the same statement. Each channel has its OWN speed and day limit
//                (email emailPerMinute / emailDailyCap, WhatsApp waPerMinute / waDailyCap, SMS smsPerMinute / smsDailyCap) and a campaign may have its own
//                lower speed (OutreachCampaign.perMinute: never above the channel's).
//   AT MOST ONCE sendStartedAt is written just before the provider is called. A row stuck 'sending' WITHOUT it never reached the provider
//                and goes back to the queue; WITH it the outcome is unknown, so it becomes 'unknown' (reason 'interrupted') and is NEVER
//                sent again by the machine (a missed message is better than a duplicate job promotion).
//   RETRY        a transient error retries with backoff (2 min, 10 min); the 3rd failure = 'failed' (gave_up). A definitive refusal
//                (bad address, provider said no) is 'failed' at once and never retried.
//   AGAIN        the suppression engine runs once more just before the send: a STOP that arrived while the message waited is honoured.
//   CREDITS      a LIVE message needs a credit of the person who launched the campaign (credits.guard); with none left it is not sent. Test mode costs nothing.
//   PAUSE / STOP are checked after every claim (a message in flight finishes; the next one is not taken).
//   MODE         a campaign started as a REHEARSAL always rehearses (Test mode is forced for it: the row becomes 'test_captured', a send-log row and a ledger
//                row with mode 'test'; NOTHING is ever handed to a provider). A LIVE campaign is held while the global Test mode is ON.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const os = require('os');
const prisma = require('../db');
const S = require('./store');
const Sup = require('./suppress');
const Ev = require('./events');
const adapters = require('./adapters');
const Camp = require('./campaigns');
const Health = require('./health');
const Quiet = require('./quiet');

const WORKER = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const MAX_ATTEMPTS = 3;
const BACKOFF = [2 * 60000, 10 * 60000];
const STALE_MS = 10 * 60000;
const LEASE_MS = 30000;
const IST = 5.5 * 3600 * 1000;
const nextDayStart = (now) => Math.floor((now + IST) / 86400000) * 86400000 - IST + 86400000;
const SENDERS = ['email', 'whatsapp', 'sms']; // the channels the machine sends on (call tasks are done by a person)
const capOf = (st, ch) => (ch === 'whatsapp' ? st.waDailyCap : (ch === 'sms' ? st.smsDailyCap : st.emailDailyCap));
const perMinuteOf = (st, ch) => (ch === 'whatsapp' ? st.waPerMinute : (ch === 'sms' ? st.smsPerMinute : st.emailPerMinute));
const WORDS = { email: 'Email', whatsapp: 'WhatsApp', sms: 'SMS' };

// ---- the lease -----------------------------------------------------------------------------------
async function acquireLease(holder = WORKER, { now = Date.now(), ttl = LEASE_MS } = {}) {
  await S.run('INSERT INTO "OutreachRunnerLease" (name, holder, expiresAt) VALUES (\'sender\', ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expiresAt = excluded.expiresAt WHERE "OutreachRunnerLease".expiresAt < ? OR "OutreachRunnerLease".holder = ?', holder, now + ttl, now, holder);
  const r = (await S.q('SELECT holder FROM "OutreachRunnerLease" WHERE name = \'sender\''))[0];
  return !!r && r.holder === holder;
}
async function releaseLease(holder = WORKER) { await S.run('DELETE FROM "OutreachRunnerLease" WHERE name = \'sender\' AND holder = ?', holder); }

// ---- claim ----------------------------------------------------------------------------------------
async function claimOne(workerId, { now = Date.now(), perMinute = 30, types = null, channel = 'email' } = {}) {
  // types: only campaigns of these kinds (quiet hours hold job promotions back and let staff messages through)
  // channel: one channel at a time, each with its own speed. Call tasks are never claimed (not in SENDERS).
  if (!SENDERS.includes(channel)) return null;
  try { await require('./v3schema').ensure(); } catch { /* the campaign's own speed needs the column; without it the channel speed still applies */ } // eslint-disable-line global-require
  const tc = types && types.length ? ` AND k.type IN (${types.map(() => '?').join(',')})` : '';
  const rows = await S.q(`UPDATE "OutreachMessage" SET status = 'sending', lockedBy = ?, lockedAt = ?, attempts = attempts + 1, sendStartedAt = NULL
    WHERE status = 'queued' AND id = (
      SELECT m.id FROM "OutreachMessage" m JOIN "OutreachCampaign" k ON k.id = m.campaignId
      WHERE m.status = 'queued' AND m.channel = ? AND m.nextRunAt <= ? AND k.status = 'running'${tc}
        AND (SELECT COUNT(*) FROM "OutreachMessage" x WHERE x.channel = ? AND x.lockedAt >= ?) < ?
        AND (k.perMinute IS NULL OR k.perMinute >= ? OR (SELECT COUNT(*) FROM "OutreachMessage" y WHERE y.campaignId = k.id AND y.lockedAt >= ?) < k.perMinute)
      ORDER BY m.nextRunAt, m.queuedAt, m.id LIMIT 1)
    RETURNING *`, workerId, now, channel, now, ...(types && types.length ? types : []), channel, now - 60000, perMinute, perMinute, now - 60000);
  return rows[0] || null;
}

// ---- moving one row on (every update says who holds the row: a row taken over by someone else is left alone) ----
const mine = (msg) => ['id = ?', 'lockedBy = ?', "status = 'sending'"].join(' AND ');
async function release(msg, { delayMs = 0, now = Date.now() } = {}) {
  return S.run(`UPDATE "OutreachMessage" SET status = 'queued', lockedBy = NULL, sendStartedAt = NULL, attempts = MAX(attempts - 1, 0), nextRunAt = ? WHERE ${mine()}`, now + delayMs, msg.id, msg.lockedBy);
}
async function finish(msg, status, f = {}) {
  const sets = ['status = ?']; const ps = [status];
  Object.entries(f).forEach(([k, v]) => { sets.push(`${k} = ?`); ps.push(v); });
  return S.run(`UPDATE "OutreachMessage" SET ${sets.join(', ')} WHERE ${mine()}`, ...ps, msg.id, msg.lockedBy);
}

// ---- one message ------------------------------------------------------------------------------------
async function processOne(msg, ctx) {
  const { now } = ctx;
  const camp = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', msg.campaignId))[0];
  if (!camp) { await finish(msg, 'cancelled', { reason: 'campaign_stopped' }); return 'cancelled'; }
  if (camp.status === 'stopped') { await finish(msg, 'cancelled', { reason: 'campaign_stopped' }); return 'cancelled'; }
  if (camp.status !== 'running') { await release(msg, { now }); return 'released'; } // paused between the claim and the send
  const st = ctx.st;
  const channel = SENDERS.includes(msg.channel) ? msg.channel : 'email';
  if (Sup.chanOf(camp) !== channel) { await finish(msg, 'cancelled', { reason: 'campaign_stopped' }); return 'cancelled'; } // a row that does not belong to its campaign's channel is never sent
  if (camp.mode === 'live' && st.emailTestMode) { await release(msg, { delayMs: 60000, now }); (ctx.heldTest = ctx.heldTest || new Set()).add(camp.id); return 'held'; }
  const rehearsal = camp.mode !== 'live';
  const mode = rehearsal ? 'test' : 'live';

  // the engine once more, right before the send
  const [res] = await Sup.evaluate(camp, [msg.contactId], { days: camp.suppressDays, now });
  if (!res || !res.decision.send) {
    const reason = res ? res.decision.reason : 'gone';
    await finish(msg, 'skipped', { reason });
    await Ev.record('skipped', msg, camp, { detail: { reason, late: true }, at: now });
    return 'skipped';
  }
  const adapter = adapters.get(channel);
  const cap = capOf(st, channel);
  if ((await adapter.sentToday(mode, now)) >= cap) { await release(msg, { delayMs: nextDayStart(now) - now, now }); ctx.capHit = true; (ctx.caps = ctx.caps || new Set()).add(channel); return 'cap'; }

  const contact = res.contact;
  let requirement = null;
  if (camp.requirementId) {
    if (!ctx.reqs.has(camp.requirementId)) ctx.reqs.set(camp.requirementId, await prisma.requirement.findUnique({ where: { id: camp.requirementId } }));
    requirement = ctx.reqs.get(camp.requirementId);
  }
  const snapshot = S.parse(camp.templateSnapshot, null);
  if (!snapshot) { await finish(msg, 'failed', { reason: 'rejected', error: 'No message text saved with the campaign.', failedAt: now }); return 'failed'; }
  const out = Camp.renderFor(snapshot, { contact, requirement, message: { id: msg.id, token: camp.type === 'job_promotion' ? msg.token : null }, settings: st }, channel);

  // WHATSAPP NUMBER chosen for this campaign: switched off / taken from its maker = the message waits (with the reason), it never leaves from another number
  const campMeta = S.parse(camp.meta, {}) || {};
  if (channel === 'whatsapp' && !rehearsal && campMeta.waNumberId) {
    const ck = await require('../utils/waNumbers').recheck(campMeta.waNumberId, camp.createdById).catch(() => ({ ok: true })); // eslint-disable-line global-require
    if (!ck.ok) {
      await S.run('UPDATE "OutreachMessage" SET status = \'queued\', lockedBy = NULL, sendStartedAt = NULL, attempts = MAX(attempts - 1, 0), nextRunAt = ?, error = ? WHERE id = ? AND lockedBy = ? AND status = \'sending\'', now + 5 * 60000, S.clip(ck.error, 200), msg.id, msg.lockedBy);
      (ctx.notConnected = ctx.notConnected || new Set()).add(camp.id);
      return 'held';
    }
  }
  // OMNI CREDITS (credits.js): a LIVE message uses the credit(s) of the person who launched the campaign; with none left it is not sent (Test mode never uses credits)
  const Cr = require('./credits'); // eslint-disable-line global-require
  if (!rehearsal && camp.createdById) {
    const g = await Cr.guard({ userId: camp.createdById, channel, mode: 'live', now });
    if (!g.ok) { await finish(msg, 'failed', { reason: 'no_credits', error: S.clip(g.message, 200), failedAt: now }); await Ev.record('failed', msg, camp, { detail: { reason: 'no_credits' }, at: now }); return 'failed'; }
  }
  // from here a crash means "unknown", never "send again"
  const started = await S.run('UPDATE "OutreachMessage" SET sendStartedAt = ? WHERE id = ? AND lockedBy = ? AND status = \'sending\'', now, msg.id, msg.lockedBy);
  if (!started) return 'lost';
  const kind = camp.type === 'internal' ? 'internal' : 'job_promotion';
  const allowNoOptIn = res.decision.basis === 'ats_applied'; // the Admin's "applied to our job" rule: a JOB message only; an opt-out already won above
  let r;
  if (channel === 'email') {
    r = await adapter.send(
      { id: contact.id, contactType: contact.contactType, name: contact.name, email: contact.email },
      { subject: out.subject, body: out.body, kind, promotional: true, unsubscribeUrl: out.unsubscribeUrl, extraHeaders: { 'X-Entity-Ref-ID': msg.idempotencyKey } },
      { settings: { ...st, emailTestMode: rehearsal }, mailSender: ctx.mailSender, now, allowNoOptIn },
    );
  } else {
    const wa = channel === 'whatsapp';
    r = await adapter.send(
      { id: contact.id, contactType: contact.contactType, name: contact.name, phoneE164: contact.phoneE164 },
      {
        text: out.body, vars: out.vars, kind, actorUserId: camp.createdById || null, ...(wa && campMeta.waNumberId ? { numberId: campMeta.waNumberId } : {}),
        template: wa ? { name: snapshot.waTemplateName, language: snapshot.waLanguage || 'en', vars: out.vars } : null,
        templateId: wa ? null : snapshot.dltTemplateId, senderId: wa ? null : snapshot.senderId,
        meta: { template: snapshot.name || camp.name, purpose: 'campaign', campaignId: camp.id, source: 'campaign' },
      },
      { settings: { ...st, emailTestMode: rehearsal }, messageSender: ctx.messageSender, now, allowNoOptIn },
    );
  }
  if (r.status === 'test_captured' || r.status === 'sent') {
    // the ledger row: a rehearsal and an email are written here; a LIVE WhatsApp / SMS message was already written by utils/messaging.js send() (with this campaign's id), so it is not written twice
    if (rehearsal || channel === 'email') Cr.record({ userId: camp.createdById || null, channel, mode: rehearsal ? 'test' : 'live', ok: true, campaignId: camp.id, templateLabel: (snapshot && snapshot.name) || camp.name, source: 'campaign', now }).catch(() => {});
    await finish(msg, r.status, { providerRef: r.providerId || null, sentAt: now, error: null });
    await Ev.record('sent', msg, camp, { detail: rehearsal ? { rehearsal: 1 } : null, at: now });
    return r.status;
  }
  if (r.status === 'refused') {
    if (r.reason === 'daily_cap') { await release(msg, { delayMs: nextDayStart(now) - now, now }); ctx.capHit = true; (ctx.caps = ctx.caps || new Set()).add(channel); return 'cap'; }
    const skipReasons = ['opted_out', 'suppressed', 'no_opt_in', 'bad_address', 'internal_contact', 'no_address', 'gone'];
    const reason = skipReasons.includes(r.reason) ? r.reason : 'rejected';
    if (skipReasons.includes(r.reason)) { await finish(msg, 'skipped', { reason }); await Ev.record('skipped', msg, camp, { detail: { reason, late: true }, at: now }); return 'skipped'; }
    await finish(msg, 'failed', { reason: 'rejected', error: S.clip(r.reason, 200), failedAt: now });
    await Ev.record('failed', msg, camp, { detail: { reason: 'rejected' }, at: now });
    return 'failed';
  }
  // the provider said no
  if (r.notConfigured) { // the channel is not connected (yet): nothing was sent; keep the message and say why (the campaign banner shows it)
    await S.run('UPDATE "OutreachMessage" SET status = \'queued\', lockedBy = NULL, sendStartedAt = NULL, attempts = MAX(attempts - 1, 0), nextRunAt = ?, error = ? WHERE id = ? AND lockedBy = ? AND status = \'sending\'', now + 5 * 60000, S.clip(r.error, 200), msg.id, msg.lockedBy);
    (ctx.notConnected = ctx.notConnected || new Set()).add(camp.id);
    return 'held';
  }
  if (r.creditsBlocked) { await finish(msg, 'failed', { reason: 'no_credits', error: S.clip(r.error, 200), failedAt: now }); await Ev.record('failed', msg, camp, { detail: { reason: 'no_credits' }, at: now }); return 'failed'; }
  const attempts = S.num(msg.attempts);
  if (r.transient && attempts < MAX_ATTEMPTS) {
    await S.run('UPDATE "OutreachMessage" SET status = \'queued\', lockedBy = NULL, sendStartedAt = NULL, nextRunAt = ?, error = ? WHERE id = ? AND lockedBy = ? AND status = \'sending\'', now + (ctx.backoff[attempts - 1] != null ? ctx.backoff[attempts - 1] : BACKOFF[BACKOFF.length - 1]), S.clip(r.error, 200), msg.id, msg.lockedBy);
    return 'retry';
  }
  await finish(msg, 'failed', { reason: r.transient ? 'gave_up' : 'rejected', error: S.clip(r.error, 200), failedAt: now });
  await Ev.record('failed', msg, camp, { detail: { reason: r.transient ? 'gave_up' : 'rejected' }, at: now });
  return 'failed';
}

// ---- housekeeping ---------------------------------------------------------------------------------------------
async function recoverStale({ now = Date.now(), staleMs = STALE_MS } = {}) {
  const back = await S.run('UPDATE "OutreachMessage" SET status = \'queued\', lockedBy = NULL, nextRunAt = ?, attempts = MAX(attempts - 1, 0) WHERE status = \'sending\' AND sendStartedAt IS NULL AND lockedAt < ?', now, now - staleMs);
  const unsure = await S.run('UPDATE "OutreachMessage" SET status = \'unknown\', reason = \'interrupted\', lockedBy = NULL WHERE status = \'sending\' AND sendStartedAt IS NOT NULL AND lockedAt < ?', now - staleMs);
  return { back, unsure };
}
// st (the settings) is optional: with it, a scheduled campaign that is due INSIDE quiet hours is moved to the end of quiet hours (its waiting
// messages too) instead of starting, and the campaign shows a plain note.
async function startDue(now = Date.now(), st = null) {
  if (st && Quiet.normalize(st.quietHours).enabled) {
    const due = await S.q("SELECT * FROM \"OutreachCampaign\" WHERE status = 'scheduled' AND scheduledAt IS NOT NULL AND scheduledAt <= ?", now);
    for (const c of due) {
      const qs = Quiet.state(now, st.quietHours, c.type);
      if (!qs.active) continue; // eslint-disable-line no-continue
      const moved = await S.run("UPDATE \"OutreachCampaign\" SET scheduledAt = ?, updatedAt = ? WHERE id = ? AND status = 'scheduled'", qs.resumeAt, now, c.id); // eslint-disable-line no-await-in-loop
      if (moved) await S.run("UPDATE \"OutreachMessage\" SET nextRunAt = ? WHERE campaignId = ? AND status = 'queued'", qs.resumeAt, c.id); // eslint-disable-line no-await-in-loop
    }
  }
  return S.run('UPDATE "OutreachCampaign" SET status = \'running\', startedAt = COALESCE(startedAt, ?), updatedAt = ? WHERE status = \'scheduled\' AND scheduledAt IS NOT NULL AND scheduledAt <= ?', now, now, now);
}
// a send that stopped while the rows were being made: make the missing rows, then go on (safe to repeat)
async function finishPreparing(now = Date.now(), olderMs = 15000) {
  const rows = await S.q('SELECT id FROM "OutreachCampaign" WHERE status = \'preparing\' AND updatedAt < ?', now - olderMs);
  for (const r of rows) {
    try { const sum = await Camp.materialize(r.id, { now }); await Camp.finishPreparing(r.id, sum); } catch (e) { await S.run('UPDATE "OutreachCampaign" SET lastError = ?, updatedAt = ? WHERE id = ?', S.clip(e.message, 200), now, r.id); const row = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', r.id))[0]; if (row) await Health.announce(row, 'failed', 'The list of people could not be made completely. It will be tried again by itself; tell an Admin if it does not finish.', { key: `failed:${r.id}:prepare`, reason: 'prepare_failed' }); } // eslint-disable-line no-await-in-loop
  }
  return rows.length;
}
// running campaigns with nothing left waiting -> done. Each one that really changes rings the bell ONCE (creator + Admins): finished, or "has a problem"
// when nothing at all could be sent. The notes table makes a repeat tick announce nothing twice. A call campaign is done when every call task is logged.
async function completeFinished(now = Date.now()) {
  const due = await S.q('SELECT * FROM "OutreachCampaign" WHERE status = \'running\' AND NOT EXISTS (SELECT 1 FROM "OutreachMessage" m WHERE m.campaignId = "OutreachCampaign".id AND m.status IN (\'queued\',\'sending\'))');
  let changed = 0;
  for (const c of due) {
    const did = await S.run('UPDATE "OutreachCampaign" SET status = \'done\', completedAt = ?, updatedAt = ? WHERE id = ? AND status = \'running\'', now, now, c.id); // eslint-disable-line no-await-in-loop
    if (!did) continue; // eslint-disable-line no-continue
    changed += did;
    try {
      const k = (await Camp.countsFor([c.id]))[c.id]; // eslint-disable-line no-await-in-loop
      const rehearsal = c.mode === 'rehearsal';
      if (k.failed > 0 && k.sent === 0) await Health.announce(c, 'failed', `Finished, but nothing could be sent: ${k.failed} failed, ${k.skipped} skipped. Open the campaign to see why.`, { reason: 'all_failed' }); // eslint-disable-line no-await-in-loop
      else await Health.announce(c, 'finished', `Finished: ${k.sent} ${rehearsal ? 'rehearsed (nothing really sent)' : (Sup.chanOf(c) === 'call' ? 'called' : 'sent')}, ${k.skipped} skipped, ${k.failed} failed.`, { reason: 'finished' }); // eslint-disable-line no-await-in-loop
    } catch { /* the notice is a courtesy; the campaign is done either way */ }
  }
  return changed;
}
// a campaign that cannot go on right now (the day's limit, or live while Test mode is on, or the channel is not connected): the banner shows it live; the bell rings once (per day for the limit)
async function noteHolds(ctx, now = Date.now()) {
  try {
    const day = Math.floor((now + 5.5 * 3600000) / 86400000);
    for (const ch of ctx.caps || []) {
      const rows = await S.q('SELECT * FROM "OutreachCampaign" WHERE status = \'running\' AND EXISTS (SELECT 1 FROM "OutreachMessage" m WHERE m.campaignId = "OutreachCampaign".id AND m.channel = ? AND m.status = \'queued\')', ch);
      for (const c of rows.filter((x) => Sup.chanOf(x) === ch)) await Health.announce(c, 'held', `The daily limit of ${capOf(ctx.st, ch)} ${WORDS[ch]} messages is reached. The rest will go out after midnight (India time), by itself.`, { key: `held:daily_cap:${c.id}:${day}`, reason: 'daily_cap' }); // eslint-disable-line no-await-in-loop
    }
    for (const id of ctx.heldTest || []) {
      const c = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', id))[0]; // eslint-disable-line no-await-in-loop
      if (c) await Health.announce(c, 'held', `This campaign is live, but ${WORDS[Sup.chanOf(c)] || 'the channel'} is in test mode, so it is on hold. An Admin turns test mode off in the Channels tab, or stops the campaign.`, { key: `held:test_mode:${id}`, reason: 'test_mode_hold' }); // eslint-disable-line no-await-in-loop
    }
    for (const id of ctx.notConnected || []) {
      const c = (await S.q('SELECT * FROM "OutreachCampaign" WHERE id = ?', id))[0]; // eslint-disable-line no-await-in-loop
      if (c) await Health.announce(c, 'held', `${WORDS[Sup.chanOf(c)] || 'The channel'} is not connected, so nothing could be sent. An Admin connects it in Administration > Integrations, then it goes on by itself.`, { key: `held:not_connected:${id}:${day}`, reason: 'not_connected' }); // eslint-disable-line no-await-in-loop
    }
  } catch { /* a notice never stops the sender */ }
}

// ---- one pass ----------------------------------------------------------------------------------------------------
// opts: { workerId, now, maxMessages (per channel), mailSender / messageSender (test mocks), backoff, ignoreSwitch, channels (default all three) }
async function tick(opts = {}) {
  const now = opts.now || Date.now();
  const out = { skippedTick: null, test_captured: 0, sent: 0, skipped: 0, failed: 0, retry: 0, released: 0, held: 0, cap: 0, cancelled: 0, lost: 0 };
  if (!(await S.campaignsReady())) { out.skippedTick = 'not_ready'; return out; }
  try { await require('./v3schema').ensure(); } catch { /* the columns are made on the first request too */ } // eslint-disable-line global-require
  const st = await S.settings();
  if (!st.master && !opts.ignoreSwitch) { out.skippedTick = 'sending_off'; return out; }
  await recoverStale({ now, staleMs: opts.staleMs });
  await startDue(now, st);
  await finishPreparing(now, opts.preparingOlderMs);
  // quiet hours: job promotions wait (staff messages too when the Admin ticked that); the loop below only takes the kinds that may go
  const qPromo = Quiet.state(now, st.quietHours, 'job_promotion');
  const qStaff = Quiet.state(now, st.quietHours, 'internal');
  let types = null;
  if (qPromo.active) types = qStaff.active ? [] : ['internal'];
  if (qPromo.active) out.quiet = { active: true, endLabel: qPromo.endLabel, resumeAt: new Date(qPromo.resumeAt).toISOString(), staffHeld: qStaff.active };
  const ctx = { now, st, reqs: new Map(), mailSender: opts.mailSender, messageSender: opts.messageSender, backoff: opts.backoff || BACKOFF, capHit: false, caps: new Set() };
  const workerId = opts.workerId || WORKER;
  const max = opts.maxMessages || 25;
  const chans = (opts.channels || SENDERS).filter((c) => SENDERS.includes(c));
  for (const ch of chans) {
    for (let i = 0; i < max; i += 1) {
      if (ctx.caps.has(ch)) break;
      if (types && !types.length) break;
      const msg = await claimOne(workerId, { now, perMinute: perMinuteOf(st, ch), types, channel: ch }); // eslint-disable-line no-await-in-loop
      if (!msg) break;
      let r;
      try { r = await processOne(msg, ctx); } catch (e) { // eslint-disable-line no-await-in-loop
        // an unexpected error before the provider was called: leave the row for recoverStale (it never reached the provider when sendStartedAt is empty)
        r = 'released'; await S.run('UPDATE "OutreachMessage" SET error = ? WHERE id = ?', S.clip(e && e.message, 200), msg.id); // eslint-disable-line no-await-in-loop
      }
      out[r] = (out[r] || 0) + 1;
      if (opts.afterEach) await opts.afterEach(msg, r); // eslint-disable-line no-await-in-loop
    }
  }
  await noteHolds(ctx, now);
  if (!opts.noComplete) await completeFinished(now);
  return out;
}

// ---- the loop in the API process -------------------------------------------------------------------------------------
let timer = null;
let busy = false;
async function loop() {
  if (busy) return;
  busy = true;
  try {
    if (!(await S.campaignsReady())) return;
    const any = await S.q('SELECT 1 x FROM "OutreachCampaign" WHERE status IN (\'running\',\'scheduled\',\'preparing\') LIMIT 1');
    if (!any.length) return;
    if (!(await S.settings()).master) return;
    if (!(await acquireLease())) return;
    await tick({});
  } catch (e) { console.error('[outreach] sender loop:', e && e.message); } finally { busy = false; } // eslint-disable-line no-console
}
function ensureTimer() {
  try { require('./scheduled').ensureTimer(); } catch { /* scheduled messages start with the server */ } // eslint-disable-line global-require
  if (timer) return;
  if (require('../utils/sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(loop, 5000);
  if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; }
const start = ensureTimer;

module.exports = { tick, claimOne, acquireLease, releaseLease, recoverStale, startDue, finishPreparing, completeFinished, ensureTimer, start, stop, WORKER, MAX_ATTEMPTS, BACKOFF, processOne, SENDERS };
