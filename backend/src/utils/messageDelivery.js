// ---------------------------------------------------------------------------
// DELIVERY + REPLIES — what the providers tell us AFTER a message was accepted.
//
//   applyStatus()   a delivery report (WhatsApp status webhook, SMS delivery
//                   report, Call-end callback) updates the SAME message row:
//                     CandidateMessage.status  SENT -> DELIVERED -> READ  or FAILED
//                   and the bulk-send job's recipient row (report CSV / screen).
//                   A status never goes backwards (a late "sent" does not undo
//                   "delivered"); "failed" always wins and keeps the provider's words.
//   applyInbound()  a person wrote back on WhatsApp (or replied to an SMS number
//                   that forwards replies):
//                     * stored in the candidate's communication log (RECEIVED)
//                     * opens the 24-hour WhatsApp window for that number
//                       (AppSetting wa.window.<digits>) — inside it a plain
//                       text message is allowed without a template
//                     * STOP / UNSUBSCRIBE / "do not message" records an opt-out
//                       (AppSetting msg.optout.<channel>.<digits>) that every
//                       send checks.
//   windowOpen() / optedOut()  the two questions the senders ask.
//
// Nothing here is guessed: a row changes only when the provider's report names
// its message id (providerRef).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const core = require('./messagingCore');

const RANK = { SENT: 1, DELIVERED: 2, READ: 3 };
const WINDOW_PREFIX = 'wa.window.';
const OPTOUT_PREFIX = 'msg.optout.';
const DAY = 24 * 3600 * 1000;
const STOP_WORDS = /^\s*(stop|stop all|unsubscribe|cancel|opt[- ]?out|do not message|don'?t message|dont message|remove me)\s*[.!]?\s*$/i;

const digitsOf = (v) => {
  const m = core.normalizeMobile(v);
  return m.ok ? m.e164 : String(v || '').replace(/\D/g, '');
};

async function setting(key) {
  return prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
}
async function putSetting(key, value) {
  const v = typeof value === 'string' ? value : JSON.stringify(value);
  return prisma.appSetting.upsert({ where: { key }, create: { key, value: v }, update: { value: v } }).catch(() => null);
}

// ---- 24-hour window + opt-out ----------------------------------------------
async function windowOpen(to) {
  const row = await setting(`${WINDOW_PREFIX}${digitsOf(to)}`);
  return !!(row && Date.now() - new Date(row.value).getTime() < DAY);
}
// The numbers whose window is open right now (one query, for a bulk plan).
async function openWindows() {
  const rows = await prisma.appSetting.findMany({ where: { key: { startsWith: WINDOW_PREFIX }, updatedAt: { gt: new Date(Date.now() - DAY) } }, select: { key: true, value: true } }).catch(() => []);
  return new Set(rows.filter((r) => Date.now() - new Date(r.value).getTime() < DAY).map((r) => r.key.slice(WINDOW_PREFIX.length)));
}
async function optedOut(channel, to) {
  const row = await setting(`${OPTOUT_PREFIX}${channel}.${digitsOf(to)}`);
  return row ? { at: row.updatedAt } : null;
}

// ---- status reports ----------------------------------------------------------
const MAP = {
  sent: 'SENT', accepted: 'SENT', queued: 'SENT', submitted: 'SENT',
  delivered: 'DELIVERED', delivrd: 'DELIVERED', success: 'DELIVERED',
  read: 'READ', seen: 'READ',
  failed: 'FAILED', undelivered: 'FAILED', undeliv: 'FAILED', rejected: 'FAILED', expired: 'FAILED', error: 'FAILED', blocked: 'FAILED',
};
const norm = (s) => MAP[String(s || '').toLowerCase().replace(/[^a-z]/g, '')] || null;

// info: { channel, providerRef, status, at, error, detail }
async function applyStatus(info) {
  const status = norm(info.status);
  if (!info.providerRef || !status) return { matched: 0, reason: 'unknown status or no message id' };
  const at = info.at ? new Date(info.at) : new Date();
  let matched = 0;

  // 1. the candidate's communication log
  const rows = await prisma.candidateMessage.findMany({ where: { providerRef: String(info.providerRef) } }).catch(() => []);
  for (const row of rows) {
    const current = String(row.status || '').toUpperCase();
    if (status !== 'FAILED' && (RANK[current] || 0) >= RANK[status]) continue; // eslint-disable-line no-continue
    const label = status === 'DELIVERED' ? 'Delivered' : status === 'READ' ? 'Read' : status === 'FAILED' ? 'Not delivered' : 'Sent';
    const stamp = at.toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    // eslint-disable-next-line no-await-in-loop
    await prisma.candidateMessage.update({
      where: { id: row.id },
      data: {
        status,
        statusDetail: `${label} ${stamp}${status === 'FAILED' && info.error ? `: ${String(info.error).slice(0, 300)}` : ''} (${info.channel || row.channel} report)`.slice(0, 500),
        ...(status === 'FAILED' ? { lastError: String(info.error || 'The provider reported the message as not delivered').slice(0, 500) } : {}),
      },
    }).catch(() => {});
    matched += 1;
  }

  // 2. the bulk-send job's recipient row (the result screen + CSV)
  try {
    const bulk = require('./bulkMessaging'); // eslint-disable-line global-require
    matched += bulk.recordDelivery(String(info.providerRef), { status, at: at.toISOString(), error: info.error || null });
  } catch { /* the job files are optional */ }
  return { matched };
}

// ---- replies -------------------------------------------------------------------
async function findCandidateByPhone(e164) {
  const tail = String(e164).slice(-10);
  const rows = await prisma.candidate.findMany({ where: { phone: { contains: tail.slice(-8) } }, select: { id: true, name: true, phone: true }, take: 20 }).catch(() => []);
  return rows.find((c) => digitsOf(c.phone).slice(-10) === tail) || null;
}

// info: { channel:'WhatsApp'|'SMS', from, text, id, at, name }
async function applyInbound(info) {
  const channel = info.channel || 'WhatsApp';
  const e164 = digitsOf(info.from);
  if (!e164) return { stored: false };
  const at = info.at ? new Date(info.at) : new Date();
  if (channel === 'WhatsApp') await putSetting(`${WINDOW_PREFIX}${e164}`, at.toISOString());
  const stop = STOP_WORDS.test(String(info.text || ''));
  if (stop) await putSetting(`${OPTOUT_PREFIX}${channel}.${e164}`, { at: at.toISOString(), text: String(info.text).slice(0, 40) });
  const cand = await findCandidateByPhone(e164);
  const convo = require('./conversations'); // eslint-disable-line global-require
  const providerRef = info.id ? String(info.id).slice(0, 200) : null;
  if (cand) {
    // the provider re-sends a webhook when it did not hear back: one message is stored once
    const again = providerRef ? await prisma.candidateMessage.count({ where: { candidateId: cand.id, providerRef, status: 'RECEIVED' } }).catch(() => 0) : 0;
    if (again) return { stored: true, duplicate: true, stop, candidateId: cand.id };
    await prisma.candidateMessage.create({
      data: {
        candidateId: cand.id, channel, template: 'INBOUND', templateLabel: stop ? 'Asked us to stop' : 'Reply received', trigger: 'Reply',
        recipient: `+${e164}`, body: String(info.text || '').slice(0, 4000), status: 'RECEIVED',
        statusDetail: stop ? `${channel}: they asked us to stop messaging them. Nothing more will be sent on ${channel}.` : `Reply on ${channel}${info.id ? ` (${info.id})` : ''}`,
        providerRef, sentAt: at,
      },
    }).catch(() => {});
    // The Inbox: the person's conversation gets the reply (unread, reopened, owner told).
    await convo.recordIn({ personType: 'CANDIDATE', personId: cand.id, personName: cand.name, channel, body: info.text, providerRef, at, stop }).catch(() => {});
    return { stored: true, stop, candidateId: cand.id };
  }
  // Not a candidate: a client's contact or an employee writing back from the number we have on file.
  const other = await convo.findByPhone(e164).catch(() => null);
  if (other && other.type !== 'CANDIDATE') {
    await convo.recordIn({ personType: other.type, personId: other.id, personName: other.name, channel, body: info.text, providerRef, at, address: `+${e164}`, stop }).catch(() => {});
    return { stored: true, stop, candidateId: null, personType: other.type, personId: other.id };
  }
  return { stored: false, stop, candidateId: null };
}

// ---- the result of a click-to-call (utils/callGateway.js) ----------------------------
// info: { callSid, status: completed|failed|busy|no-answer, seconds, recordingUrl, ref: "audience:id", answeredBy }
const CALL_WORDS = { completed: 'Call completed', failed: 'Call failed', busy: 'The person\'s phone was busy', 'no-answer': 'Not answered' };
async function applyCall(info) {
  const st = String(info.status || '').toLowerCase();
  if (!info.callSid || !CALL_WORDS[st]) return { matched: 0 };
  const mins = info.seconds != null ? `${Math.floor(info.seconds / 60)} min ${info.seconds % 60} s` : null;
  // "completed" with no talk time = nobody picked up the second leg
  const talked = st === 'completed' && (info.seconds == null || info.seconds > 0);
  const detail = `${talked ? 'Call completed' : (st === 'completed' ? 'Connected but not answered' : CALL_WORDS[st])}${talked && mins ? ` · talked ${mins}` : ''}${info.recordingUrl ? ' · recording saved by Exotel' : ''} (Exotel report)`.slice(0, 500);
  let matched = 0;
  const rows = await prisma.candidateMessage.findMany({ where: { providerRef: String(info.callSid), channel: 'Call' } }).catch(() => []);
  for (const row of rows) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.candidateMessage.update({
      where: { id: row.id },
      data: {
        status: talked ? 'LOGGED' : 'FAILED', statusDetail: detail, ...(talked ? {} : { lastError: detail }),
        body: [row.body, info.recordingUrl ? `Recording: ${info.recordingUrl}` : null].filter(Boolean).join('\n') || null,
      },
    }).catch(() => {});
    matched += 1;
  }
  if (!rows.length && info.ref && /^(clients|employees):/.test(info.ref)) {
    const [audience, id] = info.ref.split(':');
    await require('./audit').logAudit({ // eslint-disable-line global-require
      userId: null, actorName: 'Exotel', action: 'Call through TeamLink: result', entity: audience === 'clients' ? 'Client' : 'Employee', entityId: id,
      toValue: `${detail}${info.recordingUrl ? ` · ${info.recordingUrl}` : ''}`.slice(0, 500),
    }).catch(() => {});
    matched += 1;
  }
  return { matched };
}

// ---- "is the provider really calling us?" (shown on the Channels tab) ---------------
async function markSeen(kind) {
  const row = await setting(`webhook.seen.${kind}`);
  let n = 0;
  try { n = row ? Number(JSON.parse(row.value).count) || 0 : 0; } catch { n = 0; }
  await putSetting(`webhook.seen.${kind}`, { at: new Date().toISOString(), count: n + 1 });
}
async function seenOf(kind) {
  const row = await setting(`webhook.seen.${kind}`);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}

module.exports = { markSeen, seenOf, applyCall, applyStatus, applyInbound, windowOpen, openWindows, optedOut, norm, digitsOf, WINDOW_PREFIX, OPTOUT_PREFIX, STOP_WORDS };
