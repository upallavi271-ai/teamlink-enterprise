// ---------------------------------------------------------------------------
// CLIENT SEARCH THAT KNOWS THE OLD NAMES (2026-10-17)
//
// A client is stored under its OFFICIAL legal name (Client.name). The names it
// was known by before ("VCare" for "Prabs VCare Health Clinic", a spelling merged
// away by Duplicate clients) live in ClientAlias (clientId, alias, aliasKey =
// fullKey(alias) from utils/clientDedupe.js). Typing an old name must still find
// the client, but every screen shows the OFFICIAL name only: an alias is for
// MATCHING, never for display.
//
// ONE place for it. Use these in every route that searches clients by name:
//
//   const CS = require('../utils/clientSearch');
//
//   // 1. Prisma where fragment on the Client model
//   const w = await CS.clientTermWhere('vcare');                       // name OR any alias
//   const w2 = await CS.clientTermWhere(q, { legalName: true, clientCode: true, agreementId: true });
//
//   // 2. the same fragment for a model that has a `client` relation (Requirement, Invoice ...)
//   and.push({ OR: [{ title: { contains: s } }, await CS.clientRelationTerm(s)] });
//   //   -> { client: { OR: [ {name contains}, {id in <alias hits>} ] } }
//
//   // 3. ids only
//   const ids = await CS.aliasClientIds('vcare');                      // clients whose alias matches
//
//   // 4. ship the old names with a client list the browser filters itself
//   await CS.attachAliases(rows);                                      // rows[i].aliases = ['VCare', ...]
//   const map = await CS.aliasMap();                                   // Map<clientId, string[]>
//   const byName = await CS.aliasNameMap();                            // Map<lower-case official name, string[]> (rows with a name only)
//
//   // 5. in-memory matching (a list already loaded in the server)
//   CS.nameOrAliasMatches(map.get(row.clientId), row.clientName, term) // true / false
//
// It never widens access: it only produces a WHERE fragment about the NAME. The
// caller still ANDs it with the role's own scope (clientWhere / requirementWhere
// ...), so a login that cannot see a client cannot find it through an alias.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { fullKey } = require('./clientDedupe');

const clean = (v) => String(v === undefined || v === null ? '' : v).trim();

// aliasKey is the normalised name (no spaces / punctuation / Pvt / Ltd); look the typed text up both ways.
function keyOf(term) {
  try { return fullKey(term); } catch { return ''; }
}

// Client ids whose ClientAlias matches the typed text (case-insensitive, anywhere in the alias).
async function aliasClientIds(term, { max = 2000 } = {}) {
  const t = clean(term);
  if (!t) return [];
  const key = keyOf(t);
  const or = [{ alias: { contains: t } }];
  if (key.length >= 2) or.push({ aliasKey: { contains: key } });
  const rows = await prisma.clientAlias.findMany({ where: { OR: or }, select: { clientId: true }, take: max }).catch(() => []);
  return [...new Set(rows.map((r) => r.clientId))];
}

// Client ids that carry EXACTLY this old name (case, spaces and punctuation ignored): for a stored name that must resolve to one client.
async function aliasClientIdsExact(name) {
  const key = keyOf(name);
  if (!key) return [];
  const rows = await prisma.clientAlias.findMany({ where: { aliasKey: key }, select: { clientId: true } }).catch(() => []);
  return [...new Set(rows.map((r) => r.clientId))];
}

// Prisma `where` fragment on the Client model: the official name (and, when asked, legal name / code / agreement number)
// OR an old name. Empty text -> {} (matches everything).
async function clientTermWhere(term, { legalName = false, clientCode = false, agreementId = false, gst = false } = {}) {
  const t = clean(term);
  if (!t) return {};
  const or = [{ name: { contains: t } }];
  // 2026-10-22 one company, many locations: "palnadu narasaraopet" finds Palnadu Hospital at Narasaraopet - every word in the name
  // or the location, and at least one word in the NAME (so a single word still searches names only, as before).
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    or.push({ AND: [{ OR: words.map((w) => ({ name: { contains: w } })) }, ...words.map((w) => ({ OR: [{ name: { contains: w } }, { location: { contains: w } }] }))] });
  }
  if (legalName) or.push({ legalName: { contains: t } });
  if (clientCode) or.push({ clientCode: { contains: t } });
  if (agreementId) or.push({ agreementId: { contains: t } });
  if (gst) or.push({ gst: { contains: t.toUpperCase() } });
  const ids = await aliasClientIds(t);
  if (ids.length) or.push({ id: { in: ids } });
  return { OR: or };
}

// The same for a model with a `client` relation: { client: { OR: [...] } }.
async function clientRelationTerm(term, opts = {}) {
  const w = await clientTermWhere(term, opts);
  if (!w.OR) return {};
  return { client: w };
}

// A model that stores only a clientId (no relation): { clientId: { in: [...] } }. Includes name hits.
async function clientIdTerm(term, opts = {}) {
  const w = await clientTermWhere(term, opts);
  if (!w.OR) return {};
  const rows = await prisma.client.findMany({ where: w, select: { id: true }, take: 5000 }).catch(() => []);
  return { clientId: { in: rows.map((r) => r.id) } };
}

// --- aliases shipped with a list ----------------------------------------------------------------
// One small query (a few hundred rows); a 20 s cache so a list request does not pay for it every time.
let cache = { at: 0, map: null };
const TTL_MS = 20000;
async function aliasMap({ fresh = false } = {}) {
  if (!fresh && cache.map && Date.now() - cache.at < TTL_MS) return cache.map;
  const rows = await prisma.clientAlias.findMany({ select: { clientId: true, alias: true }, orderBy: { alias: 'asc' } }).catch(() => []);
  const map = new Map();
  rows.forEach((r) => {
    const a = clean(r.alias);
    if (!a) return;
    if (!map.has(r.clientId)) map.set(r.clientId, []);
    map.get(r.clientId).push(a);
  });
  cache = { at: Date.now(), map };
  return map;
}
const forgetAliasCache = () => { cache = { at: 0, map: null }; nameCache = { at: 0, map: null }; };

// For a list that carries only the client's NAME (a row built in memory, no client id): Map<lower-case official name, old names[]>.
let nameCache = { at: 0, map: null };
async function aliasNameMap({ fresh = false } = {}) {
  if (!fresh && nameCache.map && Date.now() - nameCache.at < TTL_MS) return nameCache.map;
  const byId = await aliasMap({ fresh });
  const out = new Map();
  const ids = [...byId.keys()];
  for (let i = 0; i < ids.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    const cl = await prisma.client.findMany({ where: { id: { in: ids.slice(i, i + 500) } }, select: { id: true, name: true } }).catch(() => []);
    cl.forEach((c) => {
      const k = clean(c.name).toLowerCase();
      const own = (byId.get(c.id) || []).filter((x) => x.toLowerCase() !== k);
      if (k && own.length) out.set(k, [...(out.get(k) || []), ...own]);
    });
  }
  nameCache = { at: Date.now(), map: out };
  return out;
}

// rows[i].aliases = old names of the client (only those that differ from the official name). `idOf` finds the client id on a row.
async function attachAliases(rows, idOf = (r) => r.id, nameOf = (r) => r.name) {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const map = await aliasMap();
  rows.forEach((r) => {
    const id = idOf(r);
    const own = clean(nameOf(r)).toLowerCase();
    r.aliases = (id && map.get(id) || []).filter((a) => a.toLowerCase() !== own);
  });
  return rows;
}

// In-memory test: does the typed text match the official name or one of the old names? Same idea as the browser's
// matchesText: every typed word appears, or the squashed text appears.
const squash = (s) => clean(s).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
function textMatches(text, term) {
  const ws = clean(term).toLowerCase().split(/\s+/).filter(Boolean);
  if (!ws.length) return true;
  const low = clean(text).toLowerCase();
  if (ws.every((w) => low.includes(w))) return true;
  const k = squash(term);
  return !!k && squash(text).includes(k);
}
function nameOrAliasMatches(aliases, name, term) {
  if (textMatches(name, term)) return true;
  return (aliases || []).some((a) => textMatches(a, term));
}

module.exports = {
  aliasClientIds, aliasClientIdsExact, clientTermWhere, clientRelationTerm, clientIdTerm,
  aliasMap, aliasNameMap, attachAliases, forgetAliasCache, nameOrAliasMatches, textMatches,
};
