// ---------------------------------------------------------------------------
// THE CONFIRMATION STORE (spec 12).
//
// When an action needs a Confirm click, the EXACT validated parameters are
// stored here under a random id. The Confirm click carries only that id - never
// the parameters, never the typed text - so:
//
//   * what runs is what the card showed (the stored parameters, deep-frozen);
//   * it is bound to the user who asked: anybody else presenting the id is
//     refused (and that refusal is audited by the caller);
//   * it is ONE-TIME: the first Confirm flips it to 'executing' in the same
//     tick (no await in between), so a double-click or a replay can never run
//     it twice - the second call gets the first call's stored result back;
//   * it EXPIRES (10 minutes) - an old card cannot be pressed days later.
//
// In memory, per process, on purpose: a pending action is a few minutes old at
// most, and a restart losing it is safe (the user just asks again). Nothing
// here touches the database.
// ---------------------------------------------------------------------------

const crypto = require('crypto');

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const MAX_PER_USER = 25;
const KEEP_AFTER_MS = 60 * 60 * 1000; // settled / expired records stay an hour so a replay gets a clear answer

const store = new Map(); // id -> record

function ttl() {
  const n = Number(process.env.AI_CONFIRM_TTL_MS);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TTL_MS;
}

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    Object.values(o).forEach(deepFreeze);
  }
  return o;
}

function sweep(now = Date.now()) {
  for (const [id, rec] of store) {
    if (now > rec.expiresAt + KEEP_AFTER_MS) store.delete(id);
  }
}

function create({
  user, tool, module, params, display, summary, steps, level, voice = null,
}) {
  sweep();
  // At most MAX_PER_USER open cards per person: the oldest goes.
  const mine = [...store.values()].filter((r) => r.userId === user.id && r.status === 'pending').sort((a, b) => a.createdAt - b.createdAt);
  while (mine.length >= MAX_PER_USER) {
    const old = mine.shift();
    old.status = 'replaced';
  }
  const now = Date.now();
  const rec = {
    id: crypto.randomBytes(16).toString('hex'),
    userId: user.id,
    userName: user.name || user.email || null,
    tool,
    module,
    params: deepFreeze(JSON.parse(JSON.stringify(params || {}))),
    display: deepFreeze(JSON.parse(JSON.stringify(display || {}))),
    summary: summary || '',
    level,
    voice,
    steps: JSON.parse(JSON.stringify(steps || [])),
    createdAt: now,
    expiresAt: now + ttl(),
    status: 'pending', // pending -> executing -> done | failed ; or cancelled | expired | replaced
    result: null,
  };
  store.set(rec.id, rec);
  return rec;
}

const view = (rec) => (rec ? {
  id: rec.id, tool: rec.tool, status: rec.status, expiresAt: new Date(rec.expiresAt).toISOString(), createdAt: new Date(rec.createdAt).toISOString(),
} : null);

// Claim a pending record for execution. Synchronous on purpose: the check and
// the flip happen in one tick, so two simultaneous Confirms cannot both win.
//   -> { ok:true, rec } | { ok:false, code, message, rec? }
function claim(user, id) {
  const rec = store.get(String(id || ''));
  if (!rec) return { ok: false, code: 'unknown', message: 'That confirmation is not there any more (it may have been used, or the server restarted). Ask again and I will prepare it afresh.' };
  if (rec.userId !== user.id) {
    return { ok: false, code: 'other_user', message: 'That confirmation belongs to someone else. Nothing was done.', rec };
  }
  if (rec.status === 'executing') return { ok: false, code: 'in_progress', message: 'That is already running - one moment.', rec };
  if (rec.status === 'done' || rec.status === 'failed') {
    return { ok: false, code: 'already', message: 'That was already done - it is not run a second time.', rec };
  }
  if (rec.status === 'cancelled') return { ok: false, code: 'cancelled', message: 'You cancelled that one. Nothing was changed.', rec };
  if (rec.status === 'replaced') return { ok: false, code: 'expired', message: 'That confirmation was replaced by newer ones. Ask again.', rec };
  if (Date.now() > rec.expiresAt || rec.status === 'expired') {
    rec.status = 'expired';
    return { ok: false, code: 'expired', message: 'That confirmation ran out of time (10 minutes). Nothing was changed - ask again.', rec };
  }
  rec.status = 'executing';
  return { ok: true, rec };
}

function settle(rec, ok, result) {
  rec.status = ok ? 'done' : 'failed';
  rec.result = result;
  rec.settledAt = Date.now();
}

function release(rec) { if (rec.status === 'executing') rec.status = 'pending'; }

function cancel(user, id) {
  const rec = store.get(String(id || ''));
  if (!rec) return { ok: false, message: 'That confirmation is not there any more.' };
  if (rec.userId !== user.id) return { ok: false, code: 'other_user', message: 'That confirmation belongs to someone else. Nothing was done.', rec };
  if (rec.status !== 'pending') return { ok: false, message: rec.status === 'cancelled' ? 'Already cancelled.' : 'It is already finished, so it cannot be cancelled.', rec };
  rec.status = 'cancelled';
  return { ok: true, rec };
}

function listFor(user) {
  sweep();
  return [...store.values()].filter((r) => r.userId === user.id && r.status === 'pending' && Date.now() <= r.expiresAt).map(view);
}

function get(id) { return store.get(String(id || '')) || null; }

// Test-only helpers (the route that calls them exists only in a sandbox).
function _expireNow(id) { const r = store.get(String(id)); if (r) r.expiresAt = Date.now() - 1; return !!r; }
function _size() { return store.size; }

module.exports = {
  create, claim, settle, release, cancel, listFor, get, view, ttl, _expireNow, _size, DEFAULT_TTL_MS,
};
