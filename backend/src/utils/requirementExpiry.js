// ---------------------------------------------------------------------------
// REQUIREMENT EXPIRY ALERTS (ATS audit 2026-11-17, Q129 / Q418: "Requirement expiry alert undha?").
// Once a day (after 9 am India time) every OPEN requirement whose closing date (or, when there is none, its target joining date) is
//   - 3 days away or nearer  -> "closes on <date>"      to its recruiters, TL, STL and BDEs
//   - already past           -> "closing date passed"   to the same people, so it is extended, put on hold or closed
// Each requirement is told once per milestone and date: changing the date tells again. A bell notice only; nothing is changed on the requirement.
// The test sandbox runs no timers (index.js); sweep() is exported for tests.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'reqExpiry.notified';
const SOON_DAYS = 3;
let timer = null;

const istToday = (now) => new Date(now + 5.5 * 3600e3).toISOString().slice(0, 10);
const istHour = (now) => new Date(now + 5.5 * 3600e3).getUTCHours();
/** A requirement date as YYYY-MM-DD: accepts 2026-11-20, 20-11-2026 and 20/11/2026; anything else is skipped. */
function ymd(v) {
  const s = String(v || '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
const pretty = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

async function readState() {
  try { const r = await prisma.appSetting.findUnique({ where: { key: KEY } }); return r ? JSON.parse(r.value) : { sent: {} }; } catch { return { sent: {} }; }
}
async function saveState(st) {
  const value = JSON.stringify(st);
  await prisma.appSetting.upsert({ where: { key: KEY }, update: { value }, create: { key: KEY, value } });
}

async function recipientsOf(r) {
  const ids = [r.recruiterId, ...String(r.recruiterIds || '').split(',').map((x) => x.trim()), r.tlId, r.stlId];
  try { ids.push(...await require('./clientBdes').ownerBdeIds(r)); } catch { /* the BDEs are a helper */ } // eslint-disable-line global-require
  return [...new Set(ids.filter(Boolean))];
}

/** One pass. -> { told: [{ id, kind, date, to }] }. `force` skips the once-a-day / after-9-am guard (tests, a manual run). */
async function sweep({ now = Date.now(), notify, force = false } = {}) {
  const today = istToday(now);
  const st = await readState();
  if (!force && (st.lastRun === today || istHour(now) < 9)) return { told: [], skipped: true };
  const send = notify || require('./notify').notifyUsers; // eslint-disable-line global-require
  const open = await prisma.requirement.findMany({
    where: { status: 'OPEN', OR: [{ closingDate: { not: null } }, { targetDate: { not: null } }] },
    select: { id: true, title: true, reqCode: true, closingDate: true, targetDate: true, recruiterId: true, recruiterIds: true, tlId: true, stlId: true, clientId: true, bdeId: true, internal: true, client: { select: { name: true, bdeOwner: true, secondaryBde: true } } },
  });
  const told = []; const keep = {};
  for (const r of open) {
    const date = ymd(r.closingDate) || ymd(r.targetDate);
    if (!date) continue; // eslint-disable-line no-continue
    const left = daysBetween(today, date);
    const kind = left < 0 ? 'passed' : (left <= SOON_DAYS ? 'soon' : null);
    const mark = `${r.id}:${kind}:${date}`;
    Object.keys(st.sent || {}).filter((k) => k.startsWith(`${r.id}:`)).forEach((k) => { keep[k] = st.sent[k]; });
    if (!kind || (st.sent || {})[mark]) continue; // eslint-disable-line no-continue
    // eslint-disable-next-line no-await-in-loop
    const to = await recipientsOf(r);
    if (!to.length) continue; // eslint-disable-line no-continue
    const name = `${r.reqCode ? `${r.reqCode} ` : ''}${r.title}${r.client && r.client.name ? ` (${r.client.name})` : ''}`;
    const title = kind === 'passed' ? `⏰ Closing date passed: ${name}` : `⏳ Closes ${left === 0 ? 'today' : `in ${left} day${left === 1 ? '' : 's'}`}: ${name}`;
    const message = kind === 'passed'
      ? `Its closing date was ${pretty(date)} and it is still open. Extend the date, put it on hold, or close it.`
      : `It closes on ${pretty(date)}. Send the remaining profiles before then, or ask the client to extend it.`;
    // eslint-disable-next-line no-await-in-loop
    await send(to, { title, message }).catch(() => null);
    keep[mark] = today;
    told.push({ id: r.id, kind, date, to });
  }
  await saveState({ lastRun: today, sent: keep }).catch(() => null);
  return { told };
}

function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const tick = () => { sweep().catch((e) => console.error('[requirement-expiry]', e.message)); }; // eslint-disable-line no-console
  setTimeout(tick, 2 * 60 * 1000);
  timer = setInterval(tick, 60 * 60 * 1000); // hourly; it acts once a day after 9 am
  if (timer.unref) timer.unref();
}

module.exports = { sweep, startSchedule, ymd };
