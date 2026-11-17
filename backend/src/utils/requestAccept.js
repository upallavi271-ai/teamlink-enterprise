// ---------------------------------------------------------------------------
// THE ACCEPT STEP OF A CLIENT'S REQUIREMENT REQUEST (founder, 2026-10-23).
//
//   client sends a request  ->  state 'requested'  (the draft requirement exists, nobody has taken it)
//   the client's BDE / BDE TL (or a Manager / Admin) presses Accept  ->  'accepted' (who + when)
//   only then does "Create requirement" (fill the rest, Save & Post) open for them.
//
// One small AppSetting row per request (key reqreq.<requirementId>), no schema change. A draft with NO row (made before this step existed, or a job a
// person started themselves) counts as accepted: nothing that already works is blocked.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const key = (id) => `reqreq.${id}`;
async function get(id) {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: key(id) } });
    return row ? JSON.parse(row.value) : null;
  } catch { return null; }
}
async function put(id, value) {
  const v = JSON.stringify(value);
  await prisma.appSetting.upsert({ where: { key: key(id) }, create: { key: key(id), value: v }, update: { value: v } });
  return value;
}
const markRequested = (id, via, user = null) => put(id, { state: 'requested', via: via || null, at: new Date().toISOString(), ...(user ? { requestedBy: user.id, requestedByName: user.name || null } : {}) });
const accept = async (id, user) => {
  const cur = (await get(id)) || {};
  return put(id, { ...cur, state: 'accepted', by: user.id, byName: user.name || null, acceptedAt: new Date().toISOString(), at: cur.at || null });
};
// 'requested' | 'accepted' | 'rejected' | null  (null = no row = counts as accepted)
async function stateOf(id) { const s = await get(id); return s ? s.state : null; }

// REJECT A REQUEST (founder ATS audit 2026-11-17): the BDE TL / a Manager / an Admin says no, with a reason from the list and a
// note. The draft stays (state 'rejected', who / when / why); the BDE is told, edits it and re-submits it, which puts it back to
// 'requested' for a fresh decision. Every earlier rejection is kept in `history`.
const REJECT_REASONS = [
  'Agreement not in place / not active',
  'Duplicate of an open requirement',
  'Details missing or unclear',
  'Salary / budget not workable',
  'Client on hold or not responding',
  'Not a role we hire for',
  'Other',
];
const rejectedText = (s) => (s && s.state === 'rejected' ? `Rejected: ${s.rejectReason || 'no reason'}${s.rejectNote ? ` (${s.rejectNote})` : ''}` : null);
async function reject(id, user, reason, note) {
  const cur = (await get(id)) || { state: 'requested', at: null };
  const history = Array.isArray(cur.history) ? cur.history : [];
  history.push({ reason, note: note || null, by: user.id, byName: user.name || null, at: new Date().toISOString() });
  return put(id, {
    ...cur, state: 'rejected', rejectReason: reason, rejectNote: note || null, rejectedBy: user.id, rejectedByName: user.name || null, rejectedAt: new Date().toISOString(), history: history.slice(-20),
  });
}
// Who may re-submit: the person who asked, the requirement's BDE, the BDE TL / Manager / Admin side (they may also decide).
function mayResubmit(user, requirement, s) {
  if (!user || !s || s.state !== 'rejected') return false;
  if ([s.requestedBy, requirement && requirement.bdeId].filter(Boolean).includes(user.id)) return true;
  const JC = require('./jobCreateRule'); // eslint-disable-line global-require
  return ['bdeTl', 'manager', 'am', 'admin'].includes(JC.kindOf(user));
}
async function resubmit(id, user, note) {
  const cur = (await get(id)) || {};
  return put(id, {
    ...cur, state: 'requested', resubmittedAt: new Date().toISOString(), resubmittedBy: user.id, resubmittedByName: user.name || null, resubmitNote: note || null, resubmits: (Number(cur.resubmits) || 0) + 1,
  });
}

module.exports = { get, markRequested, accept, stateOf, REJECT_REASONS, rejectedText, reject, mayResubmit, resubmit };
