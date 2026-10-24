// ---------------------------------------------------------------------------
// SEGMENTS: a saved filter (industry / city / import / channel) with a LIVE count.
// THE HARD RULE: a job promotion can never reach an internal contact.
//   * a segment has a contactType; the rules can never widen it (ruleConds is always ANDed with c.contactType = <the segment's type>)
//   * resolveTargets({ purpose: 'job_promotion' }) refuses an internal segment and only ever returns candidate_lead contacts
//     (Phase 3's queue calls this and re-checks per message).
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');
const R = require('./rules');
const core = require('../utils/messagingCore');
const { logAudit } = require('../utils/audit');

const view = (r, counts) => ({
  id: r.id, name: r.name, industry: r.industry || null, contactType: r.contactType, rules: R.cleanRules(S.parse(r.filterRules, {})),
  createdByName: r.createdByName || '', createdById: r.createdById || null, createdAt: S.iso(r.createdAt), refreshedAt: S.iso(r.refreshedAt), ...(counts ? { counts } : {}),
});

// the SQL for "the people in this segment" (always the segment's own contact type, always live).
// A group with NO rule matches nobody (rules.segmentConds): it never silently means "everyone".
function membersSql(seg) {
  const rc = R.segmentConds(S.parse(seg.filterRules, seg.rules || {}));
  return { where: ["c.status = 'active'", 'c.contactType = ?', ...rc.conds].join(' AND '), params: [seg.contactType, ...rc.params], empty: rc.empty };
}
const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
// LIVE COUNTS (quick wins, T5): { total, reachable: { email, whatsapp, sms }, emptyRule }. "Can receive on a channel" is exactly what the sending
// engine (suppress.decide) would accept for that person: active, the right kind of contact (a job group never holds a staff contact: the
// group's own type is forced), a usable address, opted in on the channel, address healthy (no bounce / spam report), and not on the
// do-not-contact list (which is by hash, so it is looked up here the same way the engine does).
async function counts(seg) {
  const m = membersSql(seg);
  const per = {};
  R.CHANNELS.forEach((ch) => { per[ch] = 0; });
  if (m.empty) return { total: 0, reachable: per, emptyRule: true };
  const total = S.num((await S.q(`SELECT COUNT(*) n FROM "OutreachContact" c WHERE ${m.where}`, ...m.params))[0].n);
  for (const ch of R.CHANNELS) {
    const addr = ch === 'email' ? "c.email IS NOT NULL AND c.email <> ''" : "c.phoneE164 IS NOT NULL AND c.phoneE164 <> ''";
    const rows = await S.q(`SELECT c.id, c.email, c.phoneE164 FROM "OutreachContact" c WHERE ${m.where} AND ${addr} AND EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.channel = ? AND h.optIn = 'opted_in' AND h.health = 'ok')`, ...m.params, ch); // eslint-disable-line no-await-in-loop
    const hashOf = new Map();
    rows.forEach((r) => { if (ch === 'email' && !core.validEmail(r.email)) return; const h = S.hashAddress(ch === 'email' ? 'email' : 'phone', ch === 'email' ? r.email : r.phoneE164); if (h) hashOf.set(r.id, h); });
    const sup = new Set();
    for (const part of chunk([...new Set(hashOf.values())], 400)) (await S.q(`SELECT addressHash FROM "OutreachSuppression" WHERE channel IN (?, '*') AND addressHash IN (${R.ph(part.length)})`, ch, ...part)).forEach((r) => sup.add(r.addressHash)); // eslint-disable-line no-await-in-loop
    per[ch] = [...hashOf.values()].filter((h) => !sup.has(h)).length;
  }
  return { total, reachable: per, emptyRule: false };
}
// ten people of the group, ALWAYS masked (for every role): a quick look to check the rule picked the right kind of person
// `scope` = the viewer's own contact scope (contacts.scopeConds): the sample never shows a person the viewer could not see in Contacts.
async function peek(seg, limit = 10, scope = null) {
  const m = membersSql(seg);
  if (m.empty) return [];
  const extra = scope && scope.conds && scope.conds.length ? ` AND ${scope.conds.join(' AND ')}` : '';
  const rows = await S.q(`SELECT c.id, c.name, c.email, c.phoneE164, c.city, c.company FROM "OutreachContact" c WHERE ${m.where}${extra} ORDER BY c.createdAt DESC, c.id DESC LIMIT ${Math.min(20, Math.max(1, Number(limit) || 10))}`, ...m.params, ...(scope && scope.params ? scope.params : []));
  return rows.map((r) => ({ id: r.id, name: r.name || '', email: r.email ? (core.maskEmail(r.email) || '') : '', phone: r.phoneE164 ? core.maskMobile(r.phoneE164) : '', city: r.city || '', company: r.company || '' }));
}
// counts + the plain sentence + the ten people (what the group screen and the preview show)
async function describe(seg, scope = null) {
  const c = await counts(seg);
  return { counts: c, people: await peek(seg, 10, scope), warning: c.emptyRule ? 'This group has no rule, so it matches nobody. Pick at least one kind, city, file or permission to choose who is in it.' : null };
}

async function allRows() {
  return S.q('SELECT * FROM "OutreachSegment" WHERE deletedAt IS NULL ORDER BY createdAt DESC');
}
// the segments this login may use
async function visibleSegments(user) {
  const k = A.kind(user);
  const rows = await allRows();
  const out = [];
  const inds = await S.industries();
  const myDepts = A.departmentsOf(user);
  for (const r of rows) {
    if (!A.mayRead(user, r.contactType)) continue; // eslint-disable-line no-continue
    let ok = true;
    if (r.contactType === 'internal') ok = true;
    else if (k === 'admin' || k === 'view') ok = true;
    else if (k === 'recruiter') {
      const rules = R.cleanRules(S.parse(r.filterRules, {}));
      const deptOf = (n) => String((inds.find((i) => i.name.toLowerCase() === String(n).toLowerCase()) || {}).department || n).toLowerCase();
      const names = [...rules.industries, ...(r.industry ? [r.industry] : [])];
      ok = r.createdById === user.id || (names.length > 0 && names.every((n) => myDepts.includes(deptOf(n))));
    } else ok = r.createdById === user.id; // bde / bdetl / tl: the ones they made
    if (ok) out.push({ ...view(r), rules: R.cleanRules(S.parse(r.filterRules, {})) });
  }
  return out;
}
async function list(user, { type } = {}) {
  const want = type === 'internal' ? 'internal' : 'candidate_lead';
  const segs = (await visibleSegments(user)).filter((s) => s.contactType === want);
  const out = [];
  for (const s of segs) out.push({ ...s, counts: await counts({ filterRules: JSON.stringify(s.rules), contactType: s.contactType }) }); // eslint-disable-line no-await-in-loop
  return out;
}
// ---- the Segments page (2026-10-17): the count is kept with the time it was made ("Counted at 10:42") and made again on "Count again" ----
const SNAP_KEY = 'omni.segmentCounts';
// counts + time for one group: the saved snapshot, or a fresh count (and saved) when there is none yet or force is set
async function snapshot(seg, { force = false, snap = null, save = true } = {}) {
  const all = snap || await S.getKey(SNAP_KEY, {});
  const hit = all[seg.id];
  if (hit && !force) return { counts: hit.counts, countedAt: new Date(hit.at).toISOString(), snap: all };
  const c = await counts({ filterRules: JSON.stringify(seg.rules || S.parse(seg.filterRules, {})), contactType: seg.contactType });
  const at = Date.now();
  all[seg.id] = { at, counts: c };
  if (save) await S.putKey(SNAP_KEY, all);
  try { await S.run('UPDATE "OutreachSegment" SET refreshedAt = ? WHERE id = ?', at, seg.id); } catch { /* column not made yet: harmless */ }
  return { counts: c, countedAt: new Date(at).toISOString(), snap: all };
}
async function listWithSnapshots(user, { type } = {}) {
  const want = type === 'internal' ? 'internal' : 'candidate_lead';
  const segs = (await visibleSegments(user)).filter((s) => s.contactType === want);
  let snap = await S.getKey(SNAP_KEY, {});
  let dirty = false;
  const out = [];
  for (const s of segs) {
    const had = !!snap[s.id];
    const r = await snapshot(s, { snap, save: false }); // eslint-disable-line no-await-in-loop
    snap = r.snap; if (!had) dirty = true;
    out.push({ ...s, counts: r.counts, countedAt: r.countedAt });
  }
  if (dirty) await S.putKey(SNAP_KEY, snap);
  return out;
}
// the rule as a plain sentence. ctx: { imports: { id: name }, fields: [defs] }
function describeRules(rules, ctx = {}) {
  const r = R.cleanRules(rules); const parts = [];
  const WA = { whatsapp: 'WhatsApp', email: 'Email', sms: 'SMS', call: 'Call' };
  if (r.industries.length) parts.push(`Kind is ${r.industries.join(' or ')}`);
  if (r.cities.length) parts.push(`City is ${r.cities.join(' or ')}`);
  if (r.importIds.length) parts.push(`From the file ${r.importIds.map((i) => (ctx.imports && ctx.imports[i]) || 'an import').join(' or ')}`);
  if (r.languages.length) parts.push(`Language is ${r.languages.join(' or ')}`);
  if (r.preferred.length) parts.push(`Prefers ${r.preferred.map((c) => WA[c]).join(' or ')}`);
  if (r.reachable.length) parts.push(`Can be reached on ${r.reachable.map((c) => WA[c]).join(' or ')}`);
  r.fields.forEach((f) => { const def = (ctx.fields || []).find((x) => x.id === f.key); parts.push(`${def ? def.name : f.key} is ${f.values.join(' or ')}`); });
  return parts.length ? parts.join(' · ') : 'No rule yet, so nobody matches';
}
async function get(user, id) {
  const seg = (await visibleSegments(user)).find((s) => s.id === id);
  return seg || null;
}

async function create(user, b) {
  const type = b.contactType === 'internal' ? 'internal' : 'candidate_lead';
  if (!A.mayWrite(user, type)) return { error: 'You cannot make this kind of group.', status: 403 };
  const name = S.clip(b.name, 80);
  if (name.length < 2) return { error: 'Give the group a name.', status: 400 };
  const exists = (await allRows()).some((r) => r.name.toLowerCase() === name.toLowerCase() && r.contactType === type);
  if (exists) return { error: `There is already a group called "${name}".`, status: 409 };
  const inds = await S.industries();
  const rules = R.cleanRules(b.rules);
  const unknown = rules.industries.filter((n) => !inds.some((i) => i.name === n));
  if (unknown.length) return { error: `"${unknown[0]}" is not in the kinds list.`, status: 400 };
  const id = S.newId('os');
  const now = Date.now();
  await S.run('INSERT INTO "OutreachSegment" (id, name, industry, filterRules, contactType, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?)',
    id, name, rules.industries[0] || null, JSON.stringify(rules), type, user.id, user.name, now, now);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach group created', entity: 'OutreachSegment', entityId: id, toValue: `${name} (${type})` });
  const row = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ?', id))[0];
  const snap = await snapshot({ ...row, rules }, { force: true });
  return { segment: { ...view(row), counts: snap.counts, countedAt: snap.countedAt } };
}
async function update(user, id, b) {
  const row = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ? AND deletedAt IS NULL', id))[0];
  if (!row || !(await get(user, id))) return { error: 'This group was not found.', status: 404 };
  if (!A.mayWrite(user, row.contactType) || (!A.isAdmin(user) && row.createdById !== user.id)) return { error: 'You can change only your own groups.', status: 403 };
  const rules = b.rules ? R.cleanRules(b.rules) : R.cleanRules(S.parse(row.filterRules, {}));
  const name = b.name ? S.clip(b.name, 80) : row.name;
  if (name.length < 2) return { error: 'Give the group a name.', status: 400 };
  await S.run('UPDATE "OutreachSegment" SET name = ?, industry = ?, filterRules = ?, updatedAt = ? WHERE id = ?', name, rules.industries[0] || null, JSON.stringify(rules), Date.now(), id);
  const next = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ?', id))[0];
  const snap = await snapshot(next, { force: true });
  return { segment: { ...view(next), counts: snap.counts, countedAt: snap.countedAt } };
}
// "Duplicate": the same rules under a new name (the copy belongs to whoever pressed the button)
async function duplicate(user, id, name) {
  const seg = await get(user, id);
  if (!seg) return { error: 'This group was not found.', status: 404 };
  return create(user, { name: name || `${seg.name} copy`, contactType: seg.contactType, rules: seg.rules });
}
async function remove(user, id) {
  const row = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ? AND deletedAt IS NULL', id))[0];
  if (!row || !(await get(user, id))) return { error: 'This group was not found.', status: 404 };
  if (!A.mayWrite(user, row.contactType) || (!A.isAdmin(user) && row.createdById !== user.id)) return { error: 'You can delete only your own groups.', status: 403 };
  await S.run('UPDATE "OutreachSegment" SET deletedAt = ? WHERE id = ?', Date.now(), id);
  await logAudit({ userId: user.id, actorName: user.name, action: 'Outreach group deleted', entity: 'OutreachSegment', entityId: id, toValue: row.name });
  return { ok: true };
}

// THE TARGET RESOLVER (Phase 3 campaigns call this). Returns contact ids that may be messaged on `channel`.
//   purpose 'job_promotion': internal segments are REFUSED and only candidate_lead contacts can come out.
//   purpose 'internal': only internal segments / internal contacts.
async function resolveTargets({ segmentIds, channel, purpose }) {
  if (!['job_promotion', 'internal'].includes(purpose)) throw new S.OutreachError('bad_purpose', 'Say what the message is for.');
  const ids = [];
  for (const sid of segmentIds || []) {
    const seg = (await S.q('SELECT * FROM "OutreachSegment" WHERE id = ? AND deletedAt IS NULL', sid))[0];
    if (!seg) throw new S.OutreachError('no_segment', 'A group was not found.', 404);
    if (purpose === 'job_promotion' && seg.contactType !== 'candidate_lead') throw new S.OutreachError('internal_contact', 'Promotion messages cannot go to an internal group.', 403);
    if (purpose === 'internal' && seg.contactType !== 'internal') throw new S.OutreachError('not_internal', 'This group is not an internal group.', 403);
    const m = membersSql(seg);
    const type = purpose === 'job_promotion' ? 'candidate_lead' : 'internal';
    const chSql = channel ? ' AND EXISTS (SELECT 1 FROM "OutreachContactChannel" h WHERE h.contactId = c.id AND h.channel = ? AND h.optIn = \'opted_in\' AND h.health = \'ok\')' : '';
    const rows = await S.q(`SELECT c.id FROM "OutreachContact" c WHERE ${m.where} AND c.contactType = ?${chSql}`, ...m.params, type, ...(channel ? [channel] : []));
    rows.forEach((r) => ids.push(r.id));
  }
  return [...new Set(ids)];
}

module.exports = { list, listWithSnapshots, snapshot, describeRules, duplicate, get, create, update, remove, counts, peek, describe, visibleSegments, resolveTargets, membersSql };
