// ---------------------------------------------------------------------------
// SMS PUSH PLATFORM DELIVERY REPORTS BY ASKING (2026-10-27).
//
// The provider's manual documents a Pull DLR API: GET https://web.smsgw.in/dlrresponse/dlrresp.jsp?ackid=<ackid> (utils/smsGateway.js
// pullDelivery). Every SMS it accepted keeps its ackid on its record (channels/store.js). This asks about the ones still "Submitted":
//   * older than 10 minutes, younger than 3 days, at most 25 per pass, every 10 minutes;
//   * one ackid is asked at most 12 times, with growing gaps (10, 20, 40 ... minutes), then left alone;
//   * a report changes a message ONLY through the shared delivery path (utils/messageDelivery.applyStatus: never backwards, "failed" wins,
//     a repeat is harmless), and only for DELIVRD / DELIVERED (delivered) or UNDELIV / FAILED / EXPIRED / REJECTD (failed). SUBMITTED and
//     unknown words change nothing - "Accepted by the provider" is never shown as "Delivered".
// Off in the test sandbox and when SMS_PUSH_DLR_PULL=off. Never throws.
// NOT VERIFIED against the real gateway (no real account was used): whether the reply words match the manual exactly.
// ---------------------------------------------------------------------------
const store = require('../channels/store');

const MIN_AGE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 3 * 86400000;
const PER_PASS = 25;
const MAX_TRIES = 12;
const EVERY_MS = 10 * 60 * 1000;

const gapAfter = (tries) => Math.min(6 * 60, 10 * (2 ** Math.max(0, tries - 1))) * 60 * 1000;

// Ask about ONE record now. Returns { asked, applied, reports, error }.
async function pullOne(rec) {
  if (!rec || !rec.ackId) return { asked: false, applied: 0, error: 'This SMS has no acknowledgement id, so its delivery cannot be asked about.' };
  const sms = require('./smsGateway'); // eslint-disable-line global-require
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  const out = await sms.pullDelivery(rec.ackId).catch((e) => ({ ok: false, error: e.message }));
  const tries = (rec.dlrPullCount || 0) + 1;
  if (rec.providerRef) await store.patch(rec.providerRef, { dlrPullCount: tries, dlrPulledAt: new Date().toISOString() }).catch(() => null);
  if (!out.ok) return { asked: true, applied: 0, error: out.error };
  let applied = 0;
  const DR = require('./smsPushDlrReport'); // eslint-disable-line global-require
  for (const r of out.reports) {
    // the record asked about is the one matched (a pulled report needs no number check: we asked by its own ackid)
    // eslint-disable-next-line no-await-in-loop
    const viaReader = await DR.applyReport({ ok: true, ref: rec.providerRef || r.msgid, status: r.status, word: r.word, msisdn: '', senderId: '', dlrCode: '', deliveredAt: DR.parseProviderTime(r.at), submitAt: null, error: r.status === 'failed' ? `SMS ${r.word.toLowerCase()} (delivery report)` : null }, 'pull').catch(() => null);
    if (viaReader && ['applied', 'duplicate', 'kept'].includes(viaReader.outcome)) { applied += 1; continue; } // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const res = await delivery.applyStatus({ channel: 'SMS', providerRef: r.msgid, status: r.status, at: new Date(), error: r.status === 'failed' ? `SMS ${r.word.toLowerCase()} (delivery report)` : null }).catch(() => ({ matched: 0 }));
    // the record may be filed under the ackid (no msgid in the send reply): try that too
    if (!(res && res.matched) && rec.providerRef && rec.providerRef !== r.msgid) {
      // eslint-disable-next-line no-await-in-loop
      await delivery.applyStatus({ channel: 'SMS', providerRef: rec.providerRef, status: r.status, at: new Date(), error: r.status === 'failed' ? `SMS ${r.word.toLowerCase()} (delivery report)` : null }).catch(() => null);
    }
    applied += 1;
  }
  return { asked: true, applied, reports: out.reports.map((r) => ({ status: r.status, word: r.word })) };
}

async function pass() {
  const now = Date.now();
  const rows = await store.list({ channel: 'SMS', provider: 'sms.gateway', status: 'sent', from: new Date(now - MAX_AGE_MS), to: new Date(now) }, { limit: 5000 }).catch(() => []);
  const due = rows.filter((r) => r.ackId && r.direction === 'OUT'
    && now - new Date(r.at).getTime() >= MIN_AGE_MS
    && (r.dlrPullCount || 0) < MAX_TRIES
    && (!r.dlrPulledAt || now - new Date(r.dlrPulledAt).getTime() >= gapAfter(r.dlrPullCount || 0)))
    .slice(0, PER_PASS);
  let applied = 0;
  for (const r of due) {
    // eslint-disable-next-line no-await-in-loop
    const out = await pullOne(r);
    applied += out.applied || 0;
  }
  return { asked: due.length, applied };
}

let timer = null;
function start() {
  if (timer) return;
  if (String(process.env.SMS_PUSH_DLR_PULL || '').toLowerCase() === 'off') return;
  if (require('./sandbox').isSandbox()) return; // eslint-disable-line global-require
  timer = setInterval(async () => {
    try {
      const cfg = await require('./smsGateway').smsConfig(); // eslint-disable-line global-require
      if (cfg.provider === 'SMSGW') await pass();
    } catch { /* the next pass tries again */ }
  }, EVERY_MS);
  if (timer.unref) timer.unref();
}

module.exports = { start, pass, pullOne, gapAfter, MAX_TRIES };
