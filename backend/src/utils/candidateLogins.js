// ---------------------------------------------------------------------------
// CANDIDATE LOGINS FOR EVERY CANDIDATE (founder 2026-11-02: "candidate nii add chesina ledhaa import chesina ledhaa naukri and shine
// nunchii candidates ochina vallakiii login credientials vellaliii ... candidates kii onlyy candidate page mathram aa kanipinchaliiii
// job portal loo").
//
// A candidate typed, imported or brought in from Naukri / Shine in TeamLink is a row here; the Job Portal is where they sign in (its
// candidate pages only: Applied Jobs, My Applications, the AI interview). The portal's OWN invitation does the work - it makes the
// candidate account, sends a temporary password by email / SMS / WhatsApp (changed at the first sign-in), never twice for one person,
// skips do-not-contact, says "sent" only when a provider accepted the message. TeamLink hands people over through the bridge
// (job-portal-app/embed/teamlink-integration.mjs POST .../candidates/invite); no password ever passes through TeamLink.
//
//   NEW candidates   a sweep every few minutes sends every candidate created since the switch was turned on (settings.cursor), whichever
//                    door they came through (manual, import, Naukri / Shine, a requirement upload). A failed one is tried again 3 times.
//   EARLIER ones     the backlog: everybody on file BEFORE the switch who has no login yet. Never sent on its own: the Administrator is
//                    shown the count first and starts it with that count (backlog() / sendBacklog({ expected })).
//   Naukri / Shine  mails the portal imports itself: the same switch turns the portal's own import message on (bridge .../candidates/auto).
//
//   INTERESTED ONLY (founder 2026-11-04: "import chesina data lo interested ani unte ney login pampali, not interested ani cheppite
//                    pettodhu, malli sheets pedithe aa candidate interested ani cheppite interested ani ravali, duplicates create cheyyodhu"):
//                    a candidate whose recruiter sheet says Not Interested, or an imported row with no answer, is never sent a login. When a
//                    later sheet marks someone already on file Interested, the import calls queue() and the next pass sends it (once).
//                    Candidates typed by hand or from Naukri / Shine (no interest recorded) are sent as before.
// Kept in the Integration table as an internal row (the pattern of utils/portalSettings.js), no schema change.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const STORE_ID = 'candidate-logins';
const BRIDGE = '/integrations/teamlink/candidates';
const CHUNK = 100;
const MAX_TRIES = 3;
const RETRY_AFTER_MS = 25 * 3600 * 1000; // the portal itself writes to one person at most once a day after a failed try (its migration 0024)

const parse = (row) => { try { return row && row.values ? JSON.parse(row.values) : {}; } catch { return {}; } };

async function settings() {
  const row = await prisma.integration.findUnique({ where: { id: STORE_ID } }).catch(() => null);
  const v = parse(row);
  return {
    auto: v.auto !== false, // ON unless an Administrator switched it off
    offAt: v.offAt || null,
    since: v.since || null, // when the switch first ran: candidates created before it are the backlog
    cursor: v.cursor || null, // { at, id }: the last new candidate handed over
    retry: Array.isArray(v.retry) ? v.retry.slice(0, 500) : [], // [{ id, tries, after }]
    lastRunAt: v.lastRunAt || null,
    last: v.last || null,
  };
}
async function save(next) {
  const values = JSON.stringify(next);
  await prisma.integration.upsert({ where: { id: STORE_ID }, create: { id: STORE_ID, enabled: true, state: 'Internal', values }, update: { values } });
  return next;
}

// Who may be written to at all: has an email or a mobile number, is not do-not-contact, has not withdrawn consent.
const reachable = () => ({
  AND: [
    { OR: [{ email: { not: null } }, { phone: { not: null } }] },
    { doNotContact: false },
    { OR: [{ consentStatus: null }, { consentStatus: { not: 'WITHDRAWN' } }] },
    // the recruiter's sheet: only Interested, or nothing recorded at all (typed by hand, Naukri / Shine ...)
    { OR: [{ interestStatus: null }, { interestStatus: 'INTERESTED' }] },
  ],
});
const person = (c) => ({ ref: c.id, name: c.name, email: c.email || undefined, phone: c.phone || undefined });
const bridge = () => require('./jobPortalBridge'); // eslint-disable-line global-require
const isSandbox = () => require('./sandbox').isSandbox(); // eslint-disable-line global-require

const sumCounts = (into, from) => { Object.entries(from || {}).forEach(([k, n]) => { into[k] = (into[k] || 0) + n; }); return into; };

// Hands candidates to the portal in chunks. dryRun (the default there too) only says what WOULD happen.
async function hand(candidates, { dryRun }) {
  const counts = {};
  const results = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    // eslint-disable-next-line no-await-in-loop
    const out = await bridge().portalFetch(`${BRIDGE}/invite`, { method: 'POST', body: { people: candidates.slice(i, i + CHUNK).map(person), dryRun }, timeoutMs: 180000 });
    sumCounts(counts, out.counts);
    results.push(...(out.results || []));
  }
  return { counts, results };
}

// Candidates created after the cursor, oldest first (createdAt, then id: a bulk import with one timestamp is never cut in half).
function afterCursor(cursor) {
  if (!cursor) return {};
  const at = new Date(cursor.at);
  return { OR: [{ createdAt: { gt: at } }, { createdAt: at, id: { gt: cursor.id } }] };
}

let sweeping = false;
// One pass. Never throws; a portal that is down just means the next pass tries again.
async function sweep({ limit = 200 } = {}) {
  if (sweeping || isSandbox()) return { skipped: true };
  sweeping = true;
  try {
    const s = await settings();
    if (!s.auto) return { skipped: true, reason: 'switched off' };
    if (!s.since) { // first run ever: everybody on file now is the backlog, only newcomers are sent on their own
      const now = new Date().toISOString();
      const newest = await prisma.candidate.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
      await save({ ...s, since: now, cursor: newest ? { at: newest.createdAt.toISOString(), id: newest.id } : { at: now, id: '' } });
      await setPortalAuto(true);
      return { started: true };
    }
    await setPortalAuto(true);
    const fresh = await prisma.candidate.findMany({
      where: { AND: [reachable(), afterCursor(s.cursor)] }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit,
      select: { id: true, name: true, email: true, phone: true, createdAt: true },
    });
    // the cursor moves over everybody looked at, reachable or not (a candidate with no contact is not retried every pass)
    const seen = await prisma.candidate.findMany({
      where: afterCursor(s.cursor), orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: limit, select: { id: true, createdAt: true },
    });
    const due = s.retry.filter((r) => !r.after || new Date(r.after) <= new Date());
    const retryRows = due.length ? await prisma.candidate.findMany({ where: { id: { in: due.map((r) => r.id) }, ...reachable() }, select: { id: true, name: true, email: true, phone: true } }) : [];
    const todo = [...retryRows, ...fresh.filter((c) => !retryRows.some((r) => r.id === c.id))];
    let counts = {};
    let retry = s.retry; // nothing handed over this pass: the waiting list stays as it is
    if (todo.length) {
      const out = await hand(todo, { dryRun: false });
      counts = out.counts;
      const tries = new Map(s.retry.map((r) => [r.id, r.tries]));
      const after = new Date(Date.now() + RETRY_AFTER_MS).toISOString();
      // a failed send is tried again once a day, three times in all; 'retry-later' = the portal already tried within the day (not our failure to count)
      retry = out.results.filter((x) => (x.result === 'not-sent' || x.result === 'retry-later') && (tries.get(x.ref) || 0) + (x.result === 'not-sent' ? 1 : 0) < MAX_TRIES)
        .map((x) => ({ id: x.ref, tries: (tries.get(x.ref) || 0) + (x.result === 'not-sent' ? 1 : 0) || 1, after }));
      // still waiting for their day (not due yet) stay in the list
      retry.push(...s.retry.filter((r) => r.after && new Date(r.after) > new Date()));
    }
    const lastSeen = seen[seen.length - 1];
    const next = {
      ...s, retry, lastRunAt: new Date().toISOString(),
      cursor: lastSeen ? { at: lastSeen.createdAt.toISOString(), id: lastSeen.id } : s.cursor,
      last: todo.length ? { at: new Date().toISOString(), counts } : s.last,
    };
    await save(next);
    return { handled: todo.length, counts };
  } catch (err) {
    return { error: String((err && err.message) || err).slice(0, 200) };
  } finally {
    sweeping = false;
  }
}

// The portal's own Naukri / Shine import message follows the same switch. Never throws.
async function setPortalAuto(on) {
  try { await bridge().portalFetch(`${BRIDGE}/auto`, { method: 'POST', body: { on } }); return true; } catch { return false; }
}

async function setAuto(on, userId) {
  const s = await settings();
  const next = { ...s, auto: !!on };
  if (!on) next.offAt = new Date().toISOString();
  else if (s.offAt || s.auto === false) {
    // switched back on: whoever arrived while it was off is part of the backlog (nothing is sent without the Administrator seeing the count)
    const newest = await prisma.candidate.findFirst({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { id: true, createdAt: true } });
    next.since = new Date().toISOString();
    next.cursor = newest ? { at: newest.createdAt.toISOString(), id: newest.id } : s.cursor;
    next.offAt = null;
  }
  await save(next);
  const portal = await setPortalAuto(!!on);
  return { settings: next, portal, by: userId };
}

// The earlier candidates and who of them would get a login right now (a dry run: nothing is made or sent).
async function backlogCount() {
  const s = await settings();
  if (!s.since) return { ready: false, total: 0, wouldInvite: 0, counts: {} };
  const where = { AND: [reachable(), { createdAt: { lte: new Date(s.since) } }] };
  const total = await prisma.candidate.count({ where });
  const counts = {};
  let after = null;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.candidate.findMany({ where, orderBy: { id: 'asc' }, take: 500, ...(after ? { cursor: { id: after }, skip: 1 } : {}), select: { id: true, name: true, email: true, phone: true } });
    if (!rows.length) break;
    // eslint-disable-next-line no-await-in-loop
    sumCounts(counts, (await hand(rows, { dryRun: true })).counts);
    after = rows[rows.length - 1].id;
    if (rows.length < 500) break;
  }
  return { ready: true, total, wouldInvite: counts['would-invite'] || 0, counts };
}

let job = null;
const progress = () => (job ? { ...job } : { running: false, total: 0, done: 0, invited: 0, notSent: 0 });

// Starts the backlog run IN THE BACKGROUND, only with the count the Administrator was shown.
async function sendBacklog({ expected, by }) {
  if (job && job.running) return { started: false, reason: 'a run is already in progress' };
  const b = await backlogCount();
  if (!b.ready) return { started: false, reason: 'the switch has not run yet - wait a few minutes' };
  if (Number(expected) !== b.wouldInvite) return { started: false, reason: `the number waiting changed from ${expected} to ${b.wouldInvite} - please look at it again`, total: b.wouldInvite };
  const s = await settings();
  job = { running: true, startedAt: new Date().toISOString(), total: b.wouldInvite, done: 0, invited: 0, notSent: 0, finishedAt: null, by: by || null };
  (async () => {
    try {
      const where = { AND: [reachable(), { createdAt: { lte: new Date(s.since) } }] };
      let after = null;
      for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const rows = await prisma.candidate.findMany({ where, orderBy: { id: 'asc' }, take: 25, ...(after ? { cursor: { id: after }, skip: 1 } : {}), select: { id: true, name: true, email: true, phone: true } });
        if (!rows.length) break;
        // eslint-disable-next-line no-await-in-loop
        const out = await hand(rows, { dryRun: false });
        job.done += rows.length;
        job.invited += out.counts.invited || 0;
        job.notSent += out.counts['not-sent'] || 0;
        after = rows[rows.length - 1].id;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { setTimeout(r, 300); });
        if (rows.length < 25) break;
      }
    } catch (err) {
      job.error = String((err && err.message) || err).slice(0, 200);
    } finally {
      job.running = false;
      job.finishedAt = new Date().toISOString();
    }
  })();
  return { started: true, total: b.wouldInvite };
}

// Someone already on file was marked Interested (a later import sheet): sent on the next pass, once (the portal never invites twice).
async function queue(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return { queued: 0 };
  const s = await settings();
  const have = new Set(s.retry.map((r) => r.id));
  const add = list.filter((id) => !have.has(id)).map((id) => ({ id, tries: 0, after: null }));
  if (add.length) await save({ ...s, retry: [...add, ...s.retry].slice(0, 500) });
  return { queued: add.length };
}

let timer = null;
function startSchedule() {
  if (timer || process.env.NODE_ENV === 'test') return;
  const tick = () => { sweep().catch(() => {}); };
  setTimeout(tick, 90 * 1000);
  timer = setInterval(tick, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { STORE_ID, settings, setAuto, sweep, backlogCount, sendBacklog, progress, startSchedule, reachable, afterCursor, queue };
