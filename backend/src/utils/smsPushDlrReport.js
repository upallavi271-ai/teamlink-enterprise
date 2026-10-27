// ---------------------------------------------------------------------------
// SMS PUSH PLATFORM DELIVERY REPORTS - ONE REPORT, READ AND APPLIED (founder's DLR prompt 2026-10-27).
//
// Used by the Push DLR callback (routes/webhooks.js  /api/webhooks/sms/smsgw?key=<secret>) and the Pull DLR worker (smsPushDlr.js).
// The documented report fields (the provider's manual / SMSTAKE's DLR page, the same source Green Start's adapter follows):
//   message_id   the id the send answer gave (msgid "<id>,<mobile>" - the part before the comma)    REQUIRED
//   dlrstatus    DELIVRD / DELIVERED -> delivered;  UNDELIV / UNDELIVERED / FAILED / EXPIRED / REJECTD / REJECTED / BLOCKED -> failed;
//                SUBMITTED / ACCEPTD / ENROUTE / PENDING ... are not final: nothing changes             REQUIRED
//   msisdn       the mobile number - must be the number the message went to, or the report is NOT applied
//   sender_id    the header it left with (kept on the record)
//   submittime   when the provider took it      delvtime   when the phone got it (or failed)  - "YYYY-MM-DD HH:mm:ss" India time
//   dlrcode      the operator's result code (kept; shown with a failure)
// Older spellings still read (the callback has always accepted them): msgid / messageid, status, errorcode / errordesc, recipient, err_code.
//
// A report is matched to its SMS by the message id OR the ackid (channels/store.js indexes both). It changes the message only through
// the shared delivery path (utils/messageDelivery.applyStatus: never backwards, "failed" wins, the same report twice changes nothing).
// The first matched report proves delivery reports work (smsgw.dlrSeen) - automatic SMS waits for that AND an accepted test SMS.
// Logged: the status change and failures, with the number masked; never the key, a password or the full number.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const DLR_SEEN_KEY = 'smsgw.dlrSeen';
const DELIVERED = new Set(['delivrd', 'delivered']);
const FAILED = new Set(['undeliv', 'undelivered', 'failed', 'fail', 'expired', 'rejectd', 'rejected', 'blocked', 'dnd']);

// provider word -> 'delivered' | 'failed' | null (not final / unknown: nothing changes)
function dlrStatusOf(word) {
  const w = String(word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (DELIVERED.has(w)) return 'delivered';
  if (FAILED.has(w)) return 'failed';
  return null;
}

// "2026-10-27 14:05:09" (India time, the provider's format), an ISO time, or epoch seconds / ms -> Date; anything else -> null
function parseProviderTime(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  let d = null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (m) d = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || '00'}+05:30`);
  else if (/^\d{10}$/.test(s)) d = new Date(Number(s) * 1000);
  else if (/^\d{13}$/.test(s)) d = new Date(Number(s));
  else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) d = new Date(s);
  if (!d || Number.isNaN(d.getTime())) return null;
  // a time more than a day in the future or before 2020 is not believed
  if (d.getTime() > Date.now() + 86400000 || d.getFullYear() < 2020) return null;
  return d;
}

const digits = (v) => String(v || '').replace(/\D/g, '');
const mask = (v) => { const d = digits(v); return d ? `xxxxxx${d.slice(-2)}` : '-'; };
const maskRef = (v) => { const s = String(v || ''); return s.length > 6 ? `${s.slice(0, 3)}…${s.slice(-3)}` : s; };

// One report object (query string, form or JSON) -> { ok, ref, status, word, msisdn, senderId, submitAt, deliveredAt, dlrCode, error, problem }
function parseReport(obj) {
  const it = Object.fromEntries(Object.entries(obj || {}).map(([k, v]) => [String(k).toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const ref = String(it.message_id ?? it.msgid ?? it.messageid ?? it.requestid ?? it.request_id ?? it.mid ?? it.ackid ?? '').split(',')[0].trim();
  const word = String(it.dlrstatus ?? it.status ?? it.deliverystatus ?? '').trim();
  const msisdn = digits(it.msisdn ?? it.recipient ?? it.mobile ?? it.to ?? '');
  const senderId = String(it.sender_id ?? it.senderid ?? it.sender ?? '').trim();
  const dlrCode = String(it.dlrcode ?? it.err_code ?? it.errorcode ?? '').trim();
  const desc = String(it.errordesc ?? it.reason ?? it.dlrdesc ?? '').trim();
  const out = { ok: false, ref, word, msisdn, senderId, dlrCode, status: null, submitAt: parseProviderTime(it.submittime ?? it.submit_time), deliveredAt: parseProviderTime(it.delvtime ?? it.deliverytime ?? it.donetime) };
  // the inputs are checked before anything is looked up
  if (!/^[A-Za-z0-9._:-]{3,80}$/.test(ref)) return { ...out, problem: 'no readable message_id' };
  if (!/^[A-Za-z _-]{2,30}$/.test(word)) return { ...out, problem: 'no readable dlrstatus' };
  if (msisdn && (msisdn.length < 10 || msisdn.length > 15)) return { ...out, problem: 'msisdn is not a mobile number' };
  if (senderId && !/^[A-Za-z0-9-]{2,15}$/.test(senderId)) return { ...out, problem: 'sender_id is not a sender id' };
  if (dlrCode && !/^[A-Za-z0-9_-]{1,12}$/.test(dlrCode)) return { ...out, problem: 'dlrcode is not a code' };
  out.status = dlrStatusOf(word);
  if (!out.status) return { ...out, ok: true, notFinal: true };
  const codeText = dlrCode && !['000', '0', 'null'].includes(dlrCode.toLowerCase()) ? ` (code ${dlrCode})` : '';
  out.error = out.status === 'failed' ? `SMS ${word.toLowerCase()}${codeText}${desc ? `: ${desc.slice(0, 120)}` : ''} (delivery report)` : null;
  return { ...out, ok: true };
}

async function markDlrSeen(via) {
  const v = JSON.stringify({ at: new Date().toISOString(), via });
  await prisma.appSetting.upsert({ where: { key: DLR_SEEN_KEY }, create: { key: DLR_SEEN_KEY, value: v }, update: { value: v } }).catch(() => {});
}
async function dlrSeen() {
  const row = await prisma.appSetting.findUnique({ where: { key: DLR_SEEN_KEY } }).catch(() => null);
  try { return row ? JSON.parse(row.value) : null; } catch { return null; }
}
async function forgetDlrSeen() { await prisma.appSetting.deleteMany({ where: { key: DLR_SEEN_KEY } }).catch(() => {}); }

// Apply one parsed report. Returns { matched, outcome } - outcome: applied | duplicate | not-final | not-found | number-mismatch | invalid
async function applyReport(p, via = 'push') {
  if (!p || !p.ok) {
    console.warn(`[dlr] smsgw ${via}: report ignored - ${(p && p.problem) || 'unreadable'}`); // eslint-disable-line no-console
    return { matched: 0, outcome: 'invalid', problem: p && p.problem };
  }
  if (p.notFinal) return { matched: 0, outcome: 'not-final' };
  const store = require('../channels/store'); // eslint-disable-line global-require
  const rec = await store.byRef(p.ref).catch(() => null);
  if (!rec) {
    console.warn(`[dlr] smsgw ${via}: no SMS with message id ${maskRef(p.ref)} - nothing changed`); // eslint-disable-line no-console
    return { matched: 0, outcome: 'not-found' };
  }
  // a report for another number than the message went to is not applied (a wrong / replayed report never changes a record)
  if (p.msisdn && rec.to && digits(rec.to).slice(-10) !== p.msisdn.slice(-10)) {
    console.warn(`[dlr] smsgw ${via}: message id ${maskRef(p.ref)} reported for ${mask(p.msisdn)}, but it went to ${mask(rec.to)} - not applied`); // eslint-disable-line no-console
    return { matched: 0, outcome: 'number-mismatch' };
  }
  const before = rec.status;
  if (before === p.status) return { matched: 1, outcome: 'duplicate' };
  const delivery = require('./messageDelivery'); // eslint-disable-line global-require
  const extra = {
    dlrStatus: p.word.slice(0, 30), ...(p.dlrCode ? { dlrCode: p.dlrCode } : {}), ...(p.senderId ? { dlrSenderId: p.senderId } : {}),
    ...(p.submitAt ? { providerSubmitAt: p.submitAt.toISOString() } : {}), ...(p.deliveredAt ? { providerDeliveredAt: p.deliveredAt.toISOString() } : {}), dlrVia: via,
  };
  // the record is reached by ITS message id (a report may name the ackid), so the candidate log / campaign row see the same change
  const res = await delivery.applyStatus({ channel: 'SMS', providerRef: rec.providerRef || p.ref, status: p.status, at: p.deliveredAt || new Date(), error: p.error, extra });
  const after = (await store.byRef(p.ref).catch(() => null)) || {};
  if (after.status === p.status) {
    await markDlrSeen(via);
    console.log(`[dlr] smsgw ${via}: ${maskRef(p.ref)} ${before || '-'} -> ${p.status} (${rec.module || 'Other'})`); // eslint-disable-line no-console
    return { matched: Math.max(1, (res && res.matched) || 0), outcome: 'applied' };
  }
  return { matched: (res && res.matched) || 0, outcome: 'kept', reason: `the record stays ${after.status || before} (a status never goes backwards)` };
}

module.exports = { dlrStatusOf, parseProviderTime, parseReport, applyReport, markDlrSeen, dlrSeen, forgetDlrSeen, DLR_SEEN_KEY };
