// ---------------------------------------------------------------------------
// A NAUKRI / SHINE MAILBOX BELONGS TO A POSITION, NOT A PERSON (founder 2026-10-29: "The mailbox must be permanently mapped to the
// Manufacturing department/position, not to an individual recruiter. Whenever a new recruiter joins or replaces someone in that
// position, automatically continue using the same configured Shine mailbox for the new recruiter ... Keep the existing mailbox
// connection and app password unchanged").
//
// The mailbox engine is the Job Portal's own (one connection = one recruiter, routes/portalMailboxes.js). TeamLink keeps which HRMS
// SEAT each connection belongs to (AppSetting "portalMailbox.seats": { <connection id>: { seat, setBy, setAt } }) and reconcile()
// keeps the connection on that seat's CURRENT holder (utils/jobPortalRecruiters.js, the HRMS seat rule): when the holder changes,
// the portal's own reassign moves the connection to the new holder's portal login - the same connection, its sealed app password
// and its settings untouched, no second connection. New imports and replies then go to the new holder; candidates imported
// earlier stay with the recruiter who had them (the portal never moves history). An empty seat leaves the mailbox where it is.
// Runs RIGHT AFTER any HRMS change of who holds a seat (db.js seat_ hook, afterWrite), before the mailbox screen lists, before
// "Sync now", and on every Job Portal sync (hourly, which also catches a tenure dated to start or end on a later day).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const KEY = 'portalMailbox.seats';
const CONN = '/integrations/teamlink/mailboxes/intake/source-connections';
const RECS = '/integrations/teamlink/mailboxes/recruiters';

async function loadMap() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    const v = row ? JSON.parse(row.value) : {};
    return v && typeof v === 'object' ? v : {};
  } catch { return {}; }
}
async function saveMap(map) {
  const value = JSON.stringify(map);
  await prisma.appSetting.upsert({ where: { key: KEY }, create: { key: KEY, value }, update: { value } });
}

// Today's seats with the portal recruiter id of each holder (holderRecruiterId null = empty seat or no portal login yet).
async function seatsWithRecruiters(recruiters = null) {
  const { portalFetch } = require('./jobPortalBridge'); // eslint-disable-line global-require
  const R = require('./jobPortalRecruiters'); // eslint-disable-line global-require
  const recs = recruiters || ((await portalFetch(RECS, { timeoutMs: 20000 })).recruiters || []);
  const byEmail = new Map(recs.map((r) => [String(r.email || '').toLowerCase(), r]));
  return (await R.seatList()).map((s) => {
    const rec = s.holder ? byEmail.get(s.holder.email) : null;
    return { ...s, holderRecruiterId: rec ? rec.id : null };
  });
}

// Keep every mapped connection on its seat's current holder. apply=false: only says what would move.
// Returns [{ id, address, source, seat, from, fromName, to, toName, result: moved | would-move | seat-empty | ok | failed, error? }].
async function reconcile({ apply = true, actor = null, onlyId = null } = {}) {
  const { portalFetch } = require('./jobPortalBridge'); // eslint-disable-line global-require
  const map = await loadMap();
  const ids = Object.keys(map).filter((id) => !onlyId || id === onlyId);
  if (!ids.length) return [];
  const [conns, recs] = await Promise.all([portalFetch(CONN, { timeoutMs: 20000 }), portalFetch(RECS, { timeoutMs: 20000 })]);
  const seats = new Map((await seatsWithRecruiters(recs.recruiters || [])).map((s) => [s.code, s]));
  const names = new Map((recs.recruiters || []).map((r) => [r.id, r.name]));
  const out = [];
  for (const c of conns.connections || []) {
    if (!ids.includes(c.id) || c.status === 'disconnected') continue; // eslint-disable-line no-continue
    const seat = seats.get(map[c.id].seat);
    const row = { id: c.id, address: c.address, source: c.source, seat: map[c.id].seat, from: c.recruiterId, fromName: c.recruiterName || names.get(c.recruiterId) || null };
    if (!seat || !seat.holderRecruiterId) { out.push({ ...row, result: 'seat-empty' }); continue; } // eslint-disable-line no-continue
    if (seat.holderRecruiterId === c.recruiterId) { out.push({ ...row, result: 'ok' }); continue; } // eslint-disable-line no-continue
    const move = { ...row, to: seat.holderRecruiterId, toName: seat.holder.name };
    if (!apply) { out.push({ ...move, result: 'would-move' }); continue; } // eslint-disable-line no-continue
    try {
      // eslint-disable-next-line no-await-in-loop
      await portalFetch(`${CONN}/${encodeURIComponent(c.id)}/reassign`, { method: 'POST', body: { recruiterId: seat.holderRecruiterId, confirm: true } });
      // eslint-disable-next-line no-await-in-loop
      await logAudit({ userId: actor ? actor.id : null, actorName: actor ? actor.name : 'System (HRMS seat change)', action: `Portal mailbox follows its position ${move.seat}`, entity: 'PortalMailbox', entityId: c.id, fromValue: move.fromName || move.from, toValue: move.toName }).catch(() => {});
      out.push({ ...move, result: 'moved' });
    } catch (err) { out.push({ ...move, result: 'failed', error: err.message }); }
  }
  return out;
}

// For the automatic runs: never throws, one at a time.
let running = null;
function reconcileQuietly() {
  if (running) return running;
  running = reconcile({ apply: true }).catch(() => []).finally(() => { running = null; });
  return running;
}

// RIGHT AFTER AN HRMS CHANGE OF WHO HOLDS A SEAT (db.js seat_ hook): a seat tenure added / ended / moved, a seat changed, or a
// person's employment status (exit, relieving), joining date, team or email changed. Debounced: a burst of writes (an import, a
// transfer that ends one tenure and starts another) is one run, 1.5 s after the last write. Only when some mailbox is mapped.
const PERSON_FIELDS = ['employmentStatus', 'dateOfJoining', 'team', 'email', 'userId'];
let timer = null;
let mapped = null; // cached "is any mailbox mapped?" (re-read every minute), so ordinary writes cost nothing
let mappedAt = 0;
function touchesSeats(params) {
  if (params.model === 'PositionAssignment' || params.model === 'Position') return true;
  if (params.model === 'Employee' || params.model === 'User') {
    const d = (params.args && (params.args.data || params.args.update || params.args.create)) || {};
    return params.action.startsWith('delete') || params.action === 'create' || PERSON_FIELDS.some((k) => k in d);
  }
  return false;
}
function afterWrite(params) {
  if (!params || !touchesSeats(params) || process.env.MAILBOX_SEATS_HOOK === '0') return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    timer = null;
    try {
      if (mapped === null || Date.now() - mappedAt > 60000) { mapped = Object.keys(await loadMap()).length > 0; mappedAt = Date.now(); }
      if (!mapped) return;
      await require('./jobPortalRecruiters').ensureQuietly(); // eslint-disable-line global-require
      const moved = (await reconcileQuietly()).filter((r) => r.result === 'moved');
      if (moved.length) console.log(`[mailboxes] ${moved.length} mailbox(es) moved to their position's new holder`);
    } catch { /* the hourly run catches up */ }
  }, 1500);
  if (timer.unref) timer.unref();
}

async function setSeat(connectionId, seat, user) {
  mapped = true; mappedAt = Date.now();
  const map = await loadMap();
  map[String(connectionId)] = { seat: String(seat), setBy: user ? user.name || user.email || user.id : null, setAt: new Date().toISOString() };
  await saveMap(map);
}

module.exports = { KEY, loadMap, saveMap, setSeat, seatsWithRecruiters, reconcile, reconcileQuietly, afterWrite, touchesSeats };
