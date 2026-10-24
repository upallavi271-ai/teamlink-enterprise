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
const markRequested = (id, via) => put(id, { state: 'requested', via: via || null, at: new Date().toISOString() });
const accept = async (id, user) => {
  const cur = (await get(id)) || {};
  return put(id, { ...cur, state: 'accepted', by: user.id, byName: user.name || null, acceptedAt: new Date().toISOString(), at: cur.at || null });
};
// 'requested' | 'accepted' | null  (null = no row = counts as accepted)
async function stateOf(id) { const s = await get(id); return s ? s.state : null; }

module.exports = { get, markRequested, accept, stateOf };
