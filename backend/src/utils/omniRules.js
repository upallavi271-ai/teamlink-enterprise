// ---------------------------------------------------------------------------
// OMNI RULES — quiet hours and which kinds of message are "promotional".
//
//   Quiet hours (Message templates -> Limits; default 21:00 - 08:00 India time, on): a PROMOTIONAL kind of
//   message (a job alert, a new-opening blast, a profile-update request) is held until morning. An interview
//   reminder, a joining reminder, a document request, a payment reminder and anything a person writes by
//   hand to one person are NOT promotional and are never held (the user, 2026-10-10: "off for urgent
//   interview reminders").
//
//   quietNow(purposeKey, { urgent, ownWords }) -> null (send) | a plain sentence (why it waits)
//   settings() / saveSettings(user, body)      the AppSetting 'omni-quiet'
// ---------------------------------------------------------------------------

const prisma = require('../db');

const KEY = 'omni-quiet';
const DEFAULTS = { enabled: true, from: '21:00', to: '08:00' };
// Purposes that are promotional by nature.
const PROMOTIONAL = [/^BULK_/, /^JOB_ALERT$/, /^NEW_OPENING$/, /^PROFILE_UPDATE$/, /^CAMPAIGN/];

const isPromotional = (purposeKey) => !!purposeKey && PROMOTIONAL.some((re) => re.test(String(purposeKey)));
const validHm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const mins = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + m; };

async function settings() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  let v = {};
  try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
  return {
    enabled: v.enabled === undefined ? DEFAULTS.enabled : !!v.enabled,
    from: validHm(v.from) ? v.from : DEFAULTS.from,
    to: validHm(v.to) ? v.to : DEFAULTS.to,
  };
}

async function saveSettings(user, body = {}) {
  const cur = await settings();
  const next = {
    enabled: body.enabled === undefined ? cur.enabled : !!body.enabled,
    from: body.from === undefined ? cur.from : body.from,
    to: body.to === undefined ? cur.to : body.to,
  };
  if (!validHm(next.from) || !validHm(next.to)) return { error: 'Write the times like 21:00 and 08:00.', status: 400 };
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(next), updatedById: user && user.id, updatedByName: user && user.name },
    update: { value: JSON.stringify(next), updatedById: user && user.id, updatedByName: user && user.name },
  });
  return { settings: next };
}

// The clock in India, as minutes since midnight.
function istMinutes(at = new Date()) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  const h = Number(p.find((x) => x.type === 'hour').value) % 24;
  return h * 60 + Number(p.find((x) => x.type === 'minute').value);
}
function inQuiet(s, at = new Date()) {
  if (!s.enabled) return false;
  const now = istMinutes(at); const a = mins(s.from); const b = mins(s.to);
  if (a === b) return false;
  return a < b ? now >= a && now < b : (now >= a || now < b);
}
const pretty = (hm) => { const [h, m] = hm.split(':').map(Number); const ap = h >= 12 ? 'pm' : 'am'; const hh = h % 12 || 12; return m ? `${hh}:${String(m).padStart(2, '0')} ${ap}` : `${hh} ${ap}`; };

async function quietNow(purposeKey, { urgent = false, ownWords = false, at = new Date() } = {}) {
  if (urgent || ownWords || !isPromotional(purposeKey)) return null;
  const s = await settings();
  if (!inQuiet(s, at)) return null;
  return `Quiet hours (${pretty(s.from)} to ${pretty(s.to)}): messages like this wait until morning. An Admin can change the hours in Message templates > Limits.`;
}

module.exports = { settings, saveSettings, quietNow, isPromotional, inQuiet, istMinutes, DEFAULTS };
