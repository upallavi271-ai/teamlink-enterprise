// ---------------------------------------------------------------------------
// ONE PERSON, SEVERAL LOGINS, ONE COPY (founder, 2026-10-21).
//
// When a notice goes to "everyone with role X", a person who has two or three separate logins on the same email (or the same registered
// mobile) would be written to once PER LOGIN. The bell stays per login (each login has its own bell and its own relevant notices) - but an
// EMAIL or a WhatsApp message goes to a mailbox / a phone, and a person must get it once.
//
// Done at the two places every message passes through (utils/mailer.js sendMail and utils/whatsappCloud.js sendWhatsApp), so no screen
// needs to be touched: the SAME text to the SAME address (or number) inside DEDUPE_MINUTES is not sent again - but only when that address
// (or number) really belongs to more than one login. Every other message, to everybody else, is exactly as before.
// A reset or activation e-mail is different for every login (its own link), so it is never mistaken for a repeat.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const WINDOW_MS = Number(process.env.SHARED_DEDUPE_MINUTES || 10) * 60000;
const seen = new Map(); // key -> timestamp
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const normAddr = (a) => String(a || '').trim().toLowerCase();
const digits10 = (p) => String(p || '').replace(/\D/g, '').slice(-10);

// A send that FAILED must not count as sent (the retry has to go out): give the key back.
function release(key) { if (key) seen.delete(key); }

// True the FIRST time a key is seen inside the window; false for a repeat.
function claim(key) {
  const now = Date.now();
  const at = seen.get(key);
  if (at && now - at < WINDOW_MS) return false;
  seen.set(key, now);
  if (seen.size > 5000) seen.forEach((t, k) => { if (now - t >= WINDOW_MS) seen.delete(k); });
  return true;
}

// ---- which addresses / numbers belong to more than one login? (cached for 30 s; a failed read means "not shared": nothing is held back)
const sharedCache = { at: 0, emails: new Set(), phones: new Set() };
async function refresh() {
  if (Date.now() - sharedCache.at < 30000) return;
  sharedCache.at = Date.now();
  try {
    const emails = await prisma.$queryRawUnsafe('SELECT lower(trim("email")) AS e, COUNT(*) AS n FROM "User" GROUP BY lower(trim("email")) HAVING COUNT(*) > 1');
    sharedCache.emails = new Set(emails.map((r) => r.e));
    // People: an Employee counts its primary login plus its extra logins; two employees with the same phone count together.
    const emps = await prisma.employee.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true, userId: true } });
    let extra = new Map();
    try {
      const rows = await prisma.$queryRawUnsafe('SELECT "employeeId", COUNT(*) AS n FROM "EmployeeLogin" GROUP BY "employeeId"');
      extra = new Map(rows.map((r) => [r.employeeId, Number(r.n)]));
    } catch { /* the table does not exist yet: no extra logins */ }
    const byPhone = new Map();
    emps.forEach((e) => {
      const d = digits10(e.phone);
      if (d.length < 10) return;
      byPhone.set(d, (byPhone.get(d) || 0) + (e.userId ? 1 : 0) + (extra.get(e.id) || 0));
    });
    sharedCache.phones = new Set([...byPhone.entries()].filter(([, n]) => n > 1).map(([d]) => d));
  } catch { /* keep the previous answer */ }
}
const forget = () => { sharedCache.at = 0; };

// -> { skip: true } when this e-mail must NOT be sent again (the same message already went to this shared address a moment ago);
//    otherwise { skip: false, key } (key = hand it to release() if the send fails; null when the address is not shared).
async function checkEmail({ to, subject, text, html }) {
  const addr = normAddr(to);
  if (!addr || addr.includes(',')) return { skip: false, key: null };
  await refresh();
  if (!sharedCache.emails.has(addr)) return { skip: false, key: null };
  const key = `mail|${addr}|${sha(`${subject}|${text}|${html || ''}`)}`;
  return claim(key) ? { skip: false, key } : { skip: true, key: null };
}

// Same for WhatsApp, to a number several logins share.
async function checkWhatsApp({ e164, text, vars, kind }) {
  const d = digits10(e164);
  if (d.length < 10) return { skip: false, key: null };
  await refresh();
  if (!sharedCache.phones.has(d)) return { skip: false, key: null };
  const key = `wa|${d}|${sha(`${kind}|${text || ''}|${JSON.stringify(vars || [])}`)}`;
  return claim(key) ? { skip: false, key } : { skip: true, key: null };
}

// A plain helper for code that builds its own recipient list: one entry per normalised email (or mobile), the first one wins.
function uniqueRecipients(list, { email = (x) => x.email, mobile = (x) => x.mobile || x.phone } = {}) {
  const seenE = new Set();
  const seenM = new Set();
  return (list || []).filter((x) => {
    const e = normAddr(email(x));
    const m = digits10(mobile(x));
    if ((e && seenE.has(e)) || (m.length >= 10 && seenM.has(m))) return false;
    if (e) seenE.add(e);
    if (m.length >= 10) seenM.add(m);
    return true;
  });
}

module.exports = { checkEmail, checkWhatsApp, release, uniqueRecipients, forget, claim, WINDOW_MS };
