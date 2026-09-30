// ---------------------------------------------------------------------------
// DUPLICATE CLIENTS — detection and merge.
//
// Three import batches created copies of the same company under different
// spellings ("(5CNetwork Private Limited)", "5C Network (India) PVT.LTD,
// Bangalore, BTM Layout.", "5C Netwrok PVT.LTD", "5c Network Pvt.LTD"). This
// file finds those groups in the CURRENT Client table (never from a cached
// file) and merges a group into one surviving client in one transaction.
//
// Grouping (ported from the read-only analysis, g5.js):
//   strict  the whole name normalises to the same key (case, punctuation,
//           Pvt/Ltd/Limited, "(India)", brackets and noise words ignored)
//   tail    the part before the first "," "(" "-" "@" "|" is the same
//           (the rest is an address / branch / job note)
//   typo    that head part differs by 1-2 letters (Netwrok / Network)
// Class:
//   SAFE       strict/tail links only and nothing contradicts
//   NEAR       a typo link was needed — a person must look (Sankhya/Sandhya)
//   AMBIGUOUS  something contradicts: different places in the name, location
//              field, department, email domain, phone, or two ACTIVE
//              agreements with different terms — usually real branches
//
// Only SAFE groups may be merged in bulk. Everything else is one group at a
// time, by a Super Admin / Admin, from Clients > Duplicate clients.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { Prisma } = require('@prisma/client');
const prisma = require('../db');
const { normalizeAgreementStatus, requirementIsLive } = require('./atsVocab');

// --- Name normalisation ------------------------------------------------------
const CORP = new Set(['pvt', 'private', 'ltd', 'limited', 'lmt', 'lts', 'llp', 'inc', 'pvtltd', 'ltdd']);
const PL = { hospitals: 'hospital', hostipal: 'hospital', constructions: 'construction', clinics: 'clinic', industries: 'industry', womens: 'women', colleges: 'college', clg: 'college' };
const GEN = new Set(['college', 'engineering', 'eng', 'institute', 'of', 'and', 'technology', 'science', 'sciences', 'university', 'group', 'for', 'hospital', 'autonomous', 'campus', 'technical', 'management', 'research', 'medical', 'multi', 'super', 'speciality', 'specialty', 'centre', 'center', 'clinic', 'care', 'health', 'healthcare']);
const NOISE = /\b(full ?-?time|part ?-?time|onroll|ot scrub nurse|assistant manager|quality control engineer|office timings[^,)]*|cnc milling|navya|2nd round|second round|screening interview|replacement profile|job locations?|locations?|nabh accredited|mbbs|\d+ bedded|bedded)\b/gi;
const APOS = /[’‘`]/g;

function clean(name) {
  let s = String(name || '').trim().replace(APOS, "'");
  if (/^\(.*\)$/.test(s)) s = s.slice(1, -1);
  s = s.replace(/\(\s*india\s*\)/ig, ' ').replace(NOISE, ' ').replace(/\(\s*\)?/g, (m) => (m.length > 1 ? ' ' : m)).replace(/[-\s]+$/, '');
  return s;
}
const tok = (s) => String(s || '').toLowerCase().replace(/'/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim()
  .split(/\s+/)
  .filter((t) => t && !CORP.has(t))
  .map((t) => PL[t] || t)
  .filter((t, i) => !(i === 0 && t === 'the'));
// The key a client name is known by. Also the ClientAlias.aliasKey.
const fullKey = (n) => tok(clean(n)).join('');
const SEP = /,|\(|@| - | -|- |–|\|/;
const headOf = (n) => clean(n).split(SEP)[0];
const tailOf = (n) => { const c = clean(n); const m = c.match(SEP); return m ? c.slice(m.index + 1) : ''; };
const baseKey = (n) => tok(headOf(n)).join('');
const coreKey = (n) => tok(headOf(n)).filter((t) => !GEN.has(t)).join('');
const STOPPLACE = ['india', 'dist', 'dt', 'district', 'ts', 'road', 'x', 'location', 'branch', 'office', 'corporate', 'the', 'and'];
const placeToks = (n) => new Set(tok(tailOf(n).replace(NOISE, ' ')).filter((t) => !STOPPLACE.includes(t) && !/^\d+$/.test(t)));

// Optimal-string-alignment distance; 9 when the lengths are too far apart.
function osa(a, b) {
  if (Math.abs(a.length - b.length) > 3) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => { const r = new Array(b.length + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
const thr = (n) => (n >= 12 ? 2 : n >= 6 ? 1 : 0);

// --- Rows that are not a company at all --------------------------------------
// A sheet column mapped wrongly created clients called "Just Dial", "online",
// "Hyderabad", "Account Name"… They are listed for review, never grouped and
// never merged automatically.
const JUNK_KEYS = new Set([
  'justdial', 'online', 'offline', 'accountname', 'jobseekerid', 'jobseeker', 'naukri', 'naukricom', 'indeed', 'linkedin',
  'monster', 'shine', 'walkin', 'walkins', 'reference', 'referral', 'test', 'testing', 'na', 'nil', 'none', 'unknown',
  'client', 'clientname', 'company', 'companyname', 'others', 'other', 'self', 'direct', 'sample', 'demo', 'dummy', 'tbd',
]);
const PLACES = new Set([
  'hyderabad', 'hyd', 'hyderebad', 'hydrabad', 'secunderabad', 'bangalore', 'banglore', 'bengaluru', 'chennai', 'mumbai', 'pune',
  'delhi', 'new', 'kolkata', 'vizag', 'visakhapatnam', 'vijayawada', 'warangal', 'karimnagar', 'khammam', 'nizamabad', 'kurnool',
  'karnool', 'guntur', 'nellore', 'tirupati', 'kadapa', 'kakinada', 'kakinadha', 'rajahmundry', 'eluru', 'ongole', 'ongle',
  'narsaraopeta', 'narasaraopeta', 'bapatla', 'kuppam', 'medchal', 'nagole', 'uppal', 'ghatkesar', 'ibrahimpatnam', 'lb', 'nagar',
  'kukatpally', 'bachupally', 'miyapur', 'gachibowli', 'madhapur', 'ameerpet', 'dilsukhnagar', 'coimbatore', 'madurai', 'salem',
  'erode', 'kochi', 'calicut', 'trivandrum', 'mangalore', 'mysore', 'goa', 'nagpur', 'nashik', 'india', 'telangana', 'andhra',
  'pradesh', 'ap', 'ts', 'karnataka', 'tamilnadu', 'tamil', 'nadu', 'kerala', 'maharashtra', 'maharasthra', 'maharastra',
  'gujarat', 'odisha', 'mahabubnagar',
]);
function junkReason(name) {
  const t = tok(clean(name));
  const k = t.join('');
  if (!k) return 'Empty name';
  if (JUNK_KEYS.has(k)) return 'A source / sheet header, not a company';
  if (t.every((x) => PLACES.has(x))) return 'A place name only';
  if (t.length === 1 && /\d{5,}/.test(k) && /[a-z]/.test(k)) return 'Looks like an ID / code';
  return null;
}
// The TeamLink internal-hiring client is never grouped and never merged.
const isInternalClient = (c) => !!c && (c.clientType === 'Internal' || (/teamlink/i.test(String(c.name)) && /internal/i.test(String(c.name))));

// --- Helpers -------------------------------------------------------------------
const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const uniq = (a) => [...new Set(a.filter((v) => v !== null && v !== undefined && v !== ''))];
const dom = (e) => ((e && e.includes('@')) ? e.split('@')[1].toLowerCase().replace(/[/\s]+$/, '') : null);
const dig = (s) => (s ? String(s).replace(/\D/g, '').slice(-10) : null);
const agrRank = (s) => ({ ACTIVE: 3, SIGNED: 2 }[normalizeAgreementStatus(s)] || 0);
const iso = (d) => (d instanceof Date ? d.toISOString() : String(d || ''));
const groupIdOf = (ids) => crypto.createHash('sha1').update(ids.slice().sort().join(',')).digest('hex').slice(0, 12);

function subsetChain(sets) {
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) {
      const A = sets[i]; const B = sets[j];
      const aInB = [...A].every((x) => B.has(x)); const bInA = [...B].every((x) => A.has(x));
      if (!aInB && !bInA) return false;
    }
  }
  return true;
}

// What stops a group from being SAFE. Each entry is a sentence for the screen.
function assess(g) {
  const c = [];
  const od = uniq(g.map((r) => r.ownerDepartment)); if (od.length > 1) c.push(`Different departments: ${od.join(' / ')}`);
  const places = g.map((r) => placeToks(r.name)).filter((s) => s.size);
  if (places.length > 1 && !subsetChain(places)) c.push(`Different places in the name: ${uniq(g.map((r) => [...placeToks(r.name)].join(' '))).join(' | ')}`);
  const locs = g.map((r) => new Set(tok(r.location || ''))).filter((s) => s.size);
  if (locs.length > 1 && !subsetChain(locs)) c.push(`Different location field: ${uniq(g.map((r) => r.location)).join(' | ')}`);
  const d = uniq(g.map((r) => dom(r.contactEmail))).filter((x) => !/gmail|yahoo|rediff|hotmail|outlook/.test(x));
  if (d.length > 1) c.push(`Different email domains: ${d.join(' / ')}`);
  const ph = uniq(g.map((r) => dig(r.contactPhone))); if (ph.length > 1) c.push('Different contact phones');
  const act = g.filter((r) => normalizeAgreementStatus(r.agreementStatus) === 'ACTIVE');
  const fee = uniq(act.map((r) => r.agreementFeePercent)); if (fee.length > 1) c.push(`ACTIVE agreements with different fee %: ${fee.join(' / ')}`);
  const gu = uniq(act.map((r) => (r.guaranteePeriod || '').replace(/30 days/i, '1 Month')));
  if (gu.length > 1) c.push(`ACTIVE agreements with different guarantee: ${gu.join(' / ')}`);
  return c;
}

// The client that survives: an ACTIVE agreement first (ACTIVE before SIGNED),
// then most requirements, applications, invoices, and the oldest record.
function comparePrimary(a, b) {
  return agrRank(b.agreementStatus) - agrRank(a.agreementStatus)
    || b.reqs - a.reqs || b.apps - a.apps || b.invs - a.invs
    || iso(a.createdAt).localeCompare(iso(b.createdAt));
}
const pickPrimary = (g) => g.slice().sort(comparePrimary)[0];

// A clean display name: no brackets, no address tail, not ALL CAPS, the
// corporate suffix written one way, and the spelling most of the group (by
// requirements) uses — so "Netwrok" loses to "Network". The user can edit it.
const SMALL = new Set(['of', 'and', 'the', 'for', 'in', 'at', 'on', '&']);
function tidyName(raw) {
  let x = headOf(raw).replace(/[()[\]{}]/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.,;:\-–]+|[\s.,;:\-–]+$/g, '').trim();
  x = x.replace(/\bpvt\.?\s*(ltd|lmt|lts)\b\.?/ig, 'Pvt Ltd').replace(/\bprivate\s+limited\b/ig, 'Private Limited')
    .replace(/\bpvt\b\.?/ig, 'Pvt').replace(/\b(ltd|lmt|lts)\b\.?/ig, 'Ltd').replace(/\blimited\b/ig, 'Limited').replace(/\bllp\b/ig, 'LLP');
  const words = x.split(' ');
  const alpha = words.filter((w) => /[A-Za-z]{2,}/.test(w) && !/^(Pvt|Ltd|LLP|Private|Limited)$/.test(w));
  const allCaps = alpha.length >= 2 && alpha.every((w) => w.replace(/[^A-Za-z]/g, '') === w.replace(/[^A-Za-z]/g, '').toUpperCase());
  return words.map((w, i) => {
    const letters = w.replace(/[^A-Za-z]/g, '');
    if (!letters) return w;
    if (letters === letters.toUpperCase()) {
      return allCaps && letters.length > 3 && !/\d/.test(w) ? w.charAt(0) + w.slice(1).toLowerCase() : w;
    }
    if (letters === letters.toLowerCase()) {
      if (i > 0 && SMALL.has(w)) return w;
      const k = w.search(/[a-z]/);
      return w.slice(0, k) + w.charAt(k).toUpperCase() + w.slice(k + 1);
    }
    return w;
  }).join(' ').trim();
}
function proposeName(members, primary) {
  const votes = {};
  members.forEach((m) => { const k = baseKey(m.name); votes[k] = (votes[k] || 0) + 1 + (m.reqs || 0); });
  const pk = baseKey(primary.name);
  const best = Object.keys(votes).sort((a, b) => votes[b] - votes[a] || (b === pk) - (a === pk))[0];
  // A member whose name has no separator at all is a whole name; when it
  // extends the winning spelling ("Nile li cycle pvt ltd" vs "Nile Li -Cycle")
  // it is a candidate too, so a dash inside a name does not truncate it.
  const cands = uniq(members.filter((m) => baseKey(m.name) === best
    || (!SEP.test(clean(m.name)) && !/[-–]/.test(m.name) && baseKey(m.name).startsWith(best))).map((m) => tidyName(m.name)));
  const score = (s) => s.split(' ').length * 10 + (s.match(/\b[A-Z0-9][a-z]/g) || []).length * 2
    + (/\b(Pvt|Ltd|Limited|LLP)\b/.test(s) ? 1 : 0) - (s.match(/\b[A-Z]{5,}\b/g) || []).length;
  const pick = cands.sort((a, b) => score(b) - score(a) || b.length - a.length)[0];
  return pick || tidyName(primary.name) || primary.name;
}

// --- Reading the table ---------------------------------------------------------
const ANALYSIS_SELECT = {
  id: true, name: true, status: true, ownerDepartment: true, industry: true, location: true, createdAt: true,
  contactName: true, contactPhone: true, contactEmail: true, secondaryContactName: true, secondaryContactPhone: true,
  secondaryContactEmail: true, agreementStatus: true, agreementFeePercent: true, guaranteePeriod: true, clientCode: true,
  clientType: true,
};

async function countsByClient(db = prisma) {
  const N = (v) => (typeof v === 'bigint' ? Number(v) : Number(v || 0));
  const [reqs, invs, apps, evs, fbs, users] = await Promise.all([
    db.requirement.groupBy({ by: ['clientId', 'status'], _count: { _all: true } }),
    db.invoice.groupBy({ by: ['clientId'], _count: { _all: true } }),
    db.$queryRawUnsafe('SELECT r.clientId AS clientId, COUNT(*) AS n FROM Application a JOIN Requirement r ON r.id = a.requirementId GROUP BY r.clientId'),
    db.applicationStageEvent.groupBy({ by: ['clientId'], where: { clientId: { not: null } }, _count: { _all: true } }),
    db.interviewFeedback.groupBy({ by: ['clientId'], where: { clientId: { not: null } }, _count: { _all: true } }),
    db.user.groupBy({ by: ['clientId'], where: { clientId: { not: null } }, _count: { _all: true } }),
  ]);
  const m = new Map();
  const get = (id) => { if (!m.has(id)) m.set(id, { reqs: 0, openReqs: 0, invs: 0, apps: 0, events: 0, feedback: 0, users: 0 }); return m.get(id); };
  reqs.forEach((r) => { const o = get(r.clientId); o.reqs += r._count._all; if (requirementIsLive(r.status)) o.openReqs += r._count._all; });
  invs.forEach((r) => { get(r.clientId).invs = r._count._all; });
  apps.forEach((r) => { get(r.clientId).apps = N(r.n); });
  evs.forEach((r) => { get(r.clientId).events = r._count._all; });
  fbs.forEach((r) => { get(r.clientId).feedback = r._count._all; });
  users.forEach((r) => { get(r.clientId).users = r._count._all; });
  return m;
}

function shapeMember(r) {
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    ownerDepartment: r.ownerDepartment,
    industry: r.industry,
    location: r.location,
    createdAt: r.createdAt,
    reqs: r.reqs,
    openReqs: r.openReqs,
    invs: r.invs,
    apps: r.apps,
    events: r.events,
    feedback: r.feedback,
    users: r.users,
    agreementStatus: normalizeAgreementStatus(r.agreementStatus),
    agreementFeePercent: r.agreementFeePercent,
    guaranteePeriod: r.guaranteePeriod,
    clientCode: r.clientCode,
    contactName: r.contactName,
    contactPhone: r.contactPhone,
    contactEmail: r.contactEmail,
    contacts: [r.contactName, r.contactPhone, r.contactEmail, r.secondaryContactName, r.secondaryContactPhone, r.secondaryContactEmail].filter((v) => !blank(v)).length,
  };
}

// The whole picture, computed from the live table on every call.
// opts.only: keep only rows it accepts (the recommended plan leaves ZZTEST test
// rows out); opts.withSingles: also return pool rows that are in no group.
async function computeGroups(db = prisma, opts = {}) {
  const [clients, counts] = await Promise.all([
    db.client.findMany({ select: ANALYSIS_SELECT, orderBy: { createdAt: 'asc' } }),
    countsByClient(db),
  ]);
  const zero = { reqs: 0, openReqs: 0, invs: 0, apps: 0, events: 0, feedback: 0, users: 0 };
  const rows = clients.map((c) => ({ ...c, ...(counts.get(c.id) || zero) })).filter((r) => !opts.only || opts.only(r));

  const internal = []; const junk = []; const pool = [];
  rows.forEach((r) => {
    if (isInternalClient(r)) { internal.push(r); return; }
    const why = junkReason(r.name);
    if (why) { junk.push({ ...shapeMember(r), reason: why }); return; }
    pool.push(r);
  });

  const K = pool.map((r) => ({ id: r.id, f: fullKey(r.name), b: baseKey(r.name), c: coreKey(r.name) }));
  const links = [];
  for (let i = 0; i < K.length; i++) {
    for (let j = i + 1; j < K.length; j++) {
      const x = K[i]; const y = K[j];
      if (x.f && x.f === y.f) { links.push([x.id, y.id, 'strict']); continue; }
      if (x.b.length >= 4 && x.b === y.b) { links.push([x.id, y.id, 'tail']); continue; }
      const t = thr(Math.min(x.b.length, y.b.length));
      if (t && x.b.slice(0, 2) === y.b.slice(0, 2) && osa(x.b, y.b) <= t) {
        const tc = thr(Math.min(x.c.length, y.c.length));
        if (x.c && y.c && (x.c === y.c || (tc && x.c.slice(0, 2) === y.c.slice(0, 2) && osa(x.c, y.c) <= tc))) links.push([x.id, y.id, 'typo']);
      }
    }
  }
  const parent = {};
  const find = (x) => { if (parent[x] === undefined) parent[x] = x; return parent[x] === x ? x : (parent[x] = find(parent[x])); };
  links.forEach(([a, b]) => { parent[find(a)] = find(b); });
  const byRoot = {};
  pool.forEach((r) => { (byRoot[find(r.id)] ||= []).push(r); });
  const linksOf = {};
  links.forEach((l) => { (linksOf[find(l[0])] ||= []).push(l); });

  const groups = Object.entries(byRoot).filter(([, g]) => g.length > 1).map(([root, g]) => {
    const lt = uniq((linksOf[root] || []).map((l) => l[2]));
    const conflicts = assess(g);
    const cls = conflicts.length ? 'AMBIGUOUS' : (lt.includes('typo') ? 'NEAR' : 'SAFE');
    const primary = pickPrimary(g);
    const members = g.slice().sort((a, b) => (a.id === primary.id ? -1 : b.id === primary.id ? 1 : comparePrimary(a, b))).map(shapeMember);
    return {
      id: groupIdOf(g.map((r) => r.id)),
      cls,
      linkTypes: lt,
      conflicts,
      primaryId: primary.id,
      proposedName: proposeName(g, primary),
      departments: uniq(g.map((r) => r.ownerDepartment)),
      removable: g.length - 1,
      totals: {
        reqs: g.reduce((s, r) => s + r.reqs, 0),
        openReqs: g.reduce((s, r) => s + r.openReqs, 0),
        invs: g.reduce((s, r) => s + r.invs, 0),
        apps: g.reduce((s, r) => s + r.apps, 0),
      },
      members,
    };
  });
  const order = { SAFE: 0, NEAR: 1, AMBIGUOUS: 2 };
  groups.sort((a, b) => order[a.cls] - order[b.cls] || b.members.length - a.members.length || a.proposedName.localeCompare(b.proposedName));

  const summ = (arr) => ({ groups: arr.length, rows: arr.reduce((s, x) => s + x.members.length, 0), removable: arr.reduce((s, x) => s + x.removable, 0) });
  return {
    generatedAt: new Date().toISOString(),
    totalClients: rows.length,
    summary: {
      all: summ(groups),
      SAFE: summ(groups.filter((x) => x.cls === 'SAFE')),
      NEAR: summ(groups.filter((x) => x.cls === 'NEAR')),
      AMBIGUOUS: summ(groups.filter((x) => x.cls === 'AMBIGUOUS')),
    },
    groups,
    junk: junk.sort((a, b) => a.name.localeCompare(b.name)),
    internal: internal.map((r) => ({ id: r.id, name: r.name })),
    ...(opts.withSingles ? { singles: Object.values(byRoot).filter((g) => g.length === 1).map((g) => shapeMember(g[0])) } : {}),
  };
}

// --- Merging -------------------------------------------------------------------
const CLIENT_SCALARS = Prisma.dmmf.datamodel.models.find((m) => m.name === 'Client').fields
  .filter((f) => f.kind === 'scalar').map((f) => f.name);
const UNIQUE_FIELDS = ['agreementId', 'esignToken', 'clientCode'];
// The executed agreement travels as ONE block — mixing the signature of one
// agreement with the document of another would be worse than either.
const AGREEMENT_BLOCK = CLIENT_SCALARS.filter((f) => f.startsWith('agreement') || f === 'esignToken');
const NEVER_FILL = new Set(['id', 'name', 'createdAt', 'status', 'commercialNotes', 'clientCode', ...AGREEMENT_BLOCK]);
const FILLABLE = CLIENT_SCALARS.filter((f) => !NEVER_FILL.has(f));

class MergeError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const fmtVal = (v) => (v instanceof Date ? v.toISOString() : v);

// Works out everything a merge would do. Read-only; `db` is a transaction
// client when called from mergeClients().
async function planMerge(db, { primaryId, donorIds, name, extras }) {
  const ids = uniq((donorIds || []).map(String)).filter((id) => id !== primaryId);
  if (!primaryId) throw new MergeError('Choose the main client');
  if (!ids.length) throw new MergeError('Choose at least one client to merge into the main client');
  const rows = await db.client.findMany({ where: { id: { in: [primaryId, ...ids] } } });
  const byId = new Map(rows.map((r) => [r.id, r]));
  const missing = [primaryId, ...ids].filter((id) => !byId.has(id));
  if (missing.length) {
    const past = await db.clientMerge.findMany({ select: { primaryName: true, donorIds: true } });
    const hit = missing.map((id) => {
      const m = past.find((p) => p.donorIds.split(',').includes(id));
      return m ? `already merged into "${m.primaryName}"` : 'not found';
    });
    throw new MergeError(`A client in this group no longer exists (${uniq(hit).join('; ')}). Reload the list.`, 409);
  }
  const primary = byId.get(primaryId);
  const donors = ids.map((id) => byId.get(id));
  if (isInternalClient(primary) || donors.some(isInternalClient)) {
    throw new MergeError('The TeamLink internal-hiring client can never be merged');
  }
  const finalName = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 200) || primary.name;

  // Donors in the order their values are preferred.
  const counts = await countsByClient(db);
  const zero = { reqs: 0, openReqs: 0, invs: 0, apps: 0 };
  const cOf = (id) => counts.get(id) || zero;
  const ordered = donors.map((d) => ({ ...d, ...cOf(d.id) })).sort(comparePrimary);

  const primaryUpdate = {};
  const donorNulls = {}; // donorId -> { field: null } for unique columns that move
  const filled = [];
  const kept = [];

  // Blank fields on the main client are filled from the first donor that has one.
  FILLABLE.forEach((f) => {
    const src = ordered.find((d) => !blank(d[f]));
    if (!src) return;
    if (blank(primary[f])) {
      primaryUpdate[f] = src[f];
      filled.push({ field: f, value: fmtVal(src[f]), fromId: src.id, fromName: src.name });
    } else {
      const differ = uniq(ordered.map((d) => d[f]).filter((v) => !blank(v)).map((v) => String(fmtVal(v))))
        .filter((v) => v !== String(fmtVal(primary[f])));
      if (differ.length) kept.push({ field: f, kept: fmtVal(primary[f]), dropped: differ });
    }
  });

  // Client code — unique, so it is taken off the donor first.
  if (blank(primary.clientCode)) {
    const src = ordered.find((d) => !blank(d.clientCode));
    if (src) {
      primaryUpdate.clientCode = src.clientCode;
      (donorNulls[src.id] ||= {}).clientCode = null;
      filled.push({ field: 'clientCode', value: src.clientCode, fromId: src.id, fromName: src.name });
    }
  }

  // The agreement. Only when the main client has no signed/active agreement
  // and a donor does is the donor's whole agreement block moved across.
  let agreementFrom = null;
  if (agrRank(primary.agreementStatus) === 0) {
    const src = ordered.filter((d) => agrRank(d.agreementStatus) > 0)
      .sort((a, b) => agrRank(b.agreementStatus) - agrRank(a.agreementStatus) || comparePrimary(a, b))[0];
    if (src) {
      agreementFrom = { id: src.id, name: src.name, status: normalizeAgreementStatus(src.agreementStatus), feePercent: src.agreementFeePercent };
      AGREEMENT_BLOCK.forEach((f) => { primaryUpdate[f] = src[f]; });
      ['agreementId', 'esignToken'].forEach((f) => { if (!blank(src[f])) (donorNulls[src.id] ||= {})[f] = null; });
      filled.push({
        field: 'agreement', value: `${agreementFrom.status}${src.agreementFeePercent != null ? ` · ${src.agreementFeePercent}%` : ''}`,
        fromId: src.id, fromName: src.name, previous: { agreementStatus: primary.agreementStatus, agreementId: primary.agreementId },
      });
    }
  }

  // Commercial notes are appended, never replaced.
  const notes = uniq(ordered.map((d) => (d.commercialNotes || '').trim())).filter((n) => n && n !== (primary.commercialNotes || '').trim());
  if (notes.length) {
    const parts = [];
    ordered.forEach((d) => {
      const n = (d.commercialNotes || '').trim();
      if (n && notes.includes(n) && !parts.some((p) => p.n === n)) parts.push({ n, from: d.name });
    });
    const base = (primary.commercialNotes || '').trim();
    primaryUpdate.commercialNotes = [base, ...parts.map((p) => `[From merged client "${p.from}"]\n${p.n}`)].filter(Boolean).join('\n\n');
    filled.push({ field: 'commercialNotes', value: `${parts.length} note(s) appended`, fromId: null, fromName: parts.map((p) => p.from).join(', ') });
  }

  // Status: Active if any member is Active and the merged client has open work.
  const openAfter = [primary, ...donors].reduce((s, r) => s + (cOf(r.id).openReqs || 0), 0);
  const anyActive = [primary, ...donors].some((r) => r.status === 'Active');
  if (anyActive && openAfter > 0 && primary.status !== 'Active') {
    primaryUpdate.status = 'Active';
    filled.push({ field: 'status', value: 'Active', previous: primary.status, fromId: null, fromName: 'a merged client is Active and has open requirements' });
  }
  if (finalName !== primary.name) primaryUpdate.name = finalName;
  // Recommended-plan extras: branch places into a blank location, and a note.
  if (extras && extras.locationIfBlank && blank(primary.location) && blank(primaryUpdate.location)) {
    primaryUpdate.location = String(extras.locationIfBlank).slice(0, 190);
    filled.push({ field: 'location', value: primaryUpdate.location, fromId: null, fromName: 'branch places of the merged records' });
  }
  if (extras && extras.appendNote) {
    const cur = primaryUpdate.commercialNotes !== undefined ? primaryUpdate.commercialNotes : (primary.commercialNotes || '');
    if (!String(cur).includes(extras.appendNote)) {
      primaryUpdate.commercialNotes = [String(cur).trim(), extras.appendNote].filter(Boolean).join('\n\n');
      filled.push({ field: 'branchNote', value: extras.appendNote.slice(0, 80), fromId: null, fromName: 'recommended plan' });
    }
  }

  // What moves.
  const inDonors = { in: ids };
  const scopeUsers = (await db.user.findMany({
    where: { OR: ids.map((id) => ({ atsScopeClients: { contains: id } })) },
    select: { id: true, atsScopeClients: true },
  })).filter((u) => String(u.atsScopeClients || '').split(',').map((s) => s.trim()).some((s) => ids.includes(s)));
  const [requirements, invoices, users, events, feedback, auditRows, aliases] = await Promise.all([
    db.requirement.count({ where: { clientId: inDonors } }),
    db.invoice.count({ where: { clientId: inDonors } }),
    db.user.count({ where: { clientId: inDonors } }),
    db.applicationStageEvent.count({ where: { clientId: inDonors } }),
    db.interviewFeedback.count({ where: { clientId: inDonors } }),
    db.auditLog.count({ where: { entity: 'Client', entityId: inDonors } }),
    db.clientAlias.count({ where: { clientId: inDonors } }),
  ]);
  const applications = ids.reduce((s, id) => s + (cOf(id).apps || 0), 0);

  // Names the survivor will also be known by. A key another surviving client
  // already answers to is skipped, so an import can never be steered away
  // from a real, separate client.
  const others = await db.client.findMany({ where: { id: { notIn: [primaryId, ...ids] } }, select: { id: true, name: true } });
  const otherKeys = new Set(others.map((o) => fullKey(o.name)).filter(Boolean));
  const aliasPlan = [];
  const seen = new Set();
  const wanted = [
    ...donors.map((d) => ({ alias: d.name, source: 'merge' })),
    ...(finalName !== primary.name ? [{ alias: primary.name, source: 'merge-renamed' }] : []),
    { alias: finalName, source: 'merge-primary' },
  ];
  // eslint-disable-next-line no-restricted-syntax
  for (const w of wanted) {
    const key = fullKey(w.alias);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    if (otherKeys.has(key)) { aliasPlan.push({ ...w, aliasKey: key, skip: 'another client already has this name' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const existing = await db.clientAlias.findUnique({ where: { aliasKey: key } });
    if (existing) {
      const mine = existing.clientId === primaryId || ids.includes(existing.clientId);
      aliasPlan.push({ ...w, aliasKey: key, skip: mine ? 'already an alias' : 'already an alias of another client' });
      continue;
    }
    aliasPlan.push({ ...w, aliasKey: key });
  }

  return {
    primary, donors, ids, finalName, primaryUpdate, donorNulls, filled, kept, agreementFrom, scopeUsers, aliasPlan,
    moved: { requirements, applications, invoices, users, stageEvents: events, feedback, auditRows, scopeUsers: scopeUsers.length, aliases },
  };
}

function publicPlan(plan) {
  return {
    primary: { id: plan.primary.id, name: plan.primary.name },
    finalName: plan.finalName,
    donors: plan.donors.map((d) => ({ id: d.id, name: d.name })),
    moved: plan.moved,
    filled: plan.filled,
    kept: plan.kept,
    agreementFrom: plan.agreementFrom,
    aliases: plan.aliasPlan.filter((a) => !a.skip).map((a) => a.alias),
    aliasesSkipped: plan.aliasPlan.filter((a) => a.skip).map((a) => ({ alias: a.alias, why: a.skip })),
  };
}

async function previewMerge(args) {
  return publicPlan(await planMerge(prisma, args));
}

// ONE transaction: every reference repointed, blanks filled, aliases stored,
// history written, donors deleted, audit row — or nothing at all.
async function mergeClients({ primaryId, donorIds, name, splitOut, note, user, extras, _failForTest }) {
  return prisma.$transaction(async (tx) => {
    const plan = await planMerge(tx, { primaryId, donorIds, name, extras });
    const { ids } = plan;
    const inDonors = { in: ids };

    const snapshot = plan.donors.map((d) => {
      const o = { ...d };
      delete o.agreementOtpHash; // a hash of a one-time code has no business in history
      return o;
    });

    const moved = {};
    moved.requirements = (await tx.requirement.updateMany({ where: { clientId: inDonors }, data: { clientId: primaryId } })).count;
    moved.applications = plan.moved.applications; // they follow their requirement
    moved.invoices = (await tx.invoice.updateMany({ where: { clientId: inDonors }, data: { clientId: primaryId } })).count;
    moved.users = (await tx.user.updateMany({ where: { clientId: inDonors }, data: { clientId: primaryId } })).count;
    // clientId only — the clientName on a stage event is a snapshot of what it said at the time.
    moved.stageEvents = (await tx.applicationStageEvent.updateMany({ where: { clientId: inDonors }, data: { clientId: primaryId } })).count;
    moved.feedback = (await tx.interviewFeedback.updateMany({ where: { clientId: inDonors }, data: { clientId: primaryId } })).count;
    moved.auditRows = (await tx.auditLog.updateMany({ where: { entity: 'Client', entityId: inDonors }, data: { entityId: primaryId } })).count;
    moved.aliases = (await tx.clientAlias.updateMany({ where: { clientId: inDonors }, data: { clientId: primaryId } })).count;
    moved.scopeUsers = 0;
    // eslint-disable-next-line no-restricted-syntax
    for (const u of plan.scopeUsers) {
      const next = uniq(String(u.atsScopeClients || '').split(',').map((s) => s.trim()).map((s) => (ids.includes(s) ? primaryId : s)));
      // eslint-disable-next-line no-await-in-loop
      await tx.user.update({ where: { id: u.id }, data: { atsScopeClients: next.join(',') || null } });
      moved.scopeUsers += 1;
    }

    // Unique columns come off the donor before they go on the survivor.
    // eslint-disable-next-line no-restricted-syntax
    for (const [id, data] of Object.entries(plan.donorNulls)) {
      // eslint-disable-next-line no-await-in-loop
      await tx.client.update({ where: { id }, data });
    }
    if (Object.keys(plan.primaryUpdate).length) {
      await tx.client.update({ where: { id: primaryId }, data: plan.primaryUpdate });
    }

    const aliasesCreated = [];
    // eslint-disable-next-line no-restricted-syntax
    for (const a of plan.aliasPlan.filter((x) => !x.skip)) {
      // eslint-disable-next-line no-await-in-loop
      await tx.clientAlias.create({ data: { clientId: primaryId, alias: a.alias, aliasKey: a.aliasKey, source: a.source } });
      aliasesCreated.push(a.alias);
    }

    const left = uniq((splitOut || []).map(String)).filter((id) => id !== primaryId && !ids.includes(id));
    let leftNames = [];
    if (left.length) leftNames = (await tx.client.findMany({ where: { id: { in: left } }, select: { name: true } })).map((c) => c.name);
    const noteText = [note, leftNames.length ? `Left out of the merge (kept separate): ${leftNames.join(' | ')}` : null].filter(Boolean).join('\n') || null;

    const record = await tx.clientMerge.create({
      data: {
        primaryId,
        primaryName: plan.finalName,
        donorIds: ids.join(','),
        donorSnapshot: JSON.stringify(snapshot),
        moved: JSON.stringify({ ...moved, aliasesCreated: aliasesCreated.length }),
        filledFields: JSON.stringify({ filled: plan.filled, kept: plan.kept, previousName: plan.primary.name, aliases: aliasesCreated }),
        note: noteText,
        mergedById: (user && user.id) || null,
        mergedByName: (user && user.name) || null,
      },
    });

    if (_failForTest === 'beforeDelete') throw new Error('test failure before delete');
    const deleted = (await tx.client.deleteMany({ where: { id: inDonors } })).count;
    if (deleted !== ids.length) throw new MergeError('A client changed while merging — nothing was changed. Reload and try again.', 409);

    await tx.auditLog.create({
      data: {
        userId: (user && user.id) || null,
        actorName: (user && user.name) || null,
        action: 'Client merged',
        entity: 'Client',
        entityId: primaryId,
        fromValue: plan.donors.map((d) => d.name).join(' | ').slice(0, 2000),
        toValue: plan.finalName,
        reason: `Merged ${ids.length} duplicate client(s): ${moved.requirements} requirement(s), ${moved.invoices} invoice(s) moved. Merge record ${record.id}`,
      },
    });
    if (_failForTest === 'end') throw new Error('test failure at end');

    return {
      ok: true,
      mergeId: record.id,
      primaryId,
      name: plan.finalName,
      deleted,
      moved,
      filled: plan.filled,
      aliases: aliasesCreated,
    };
  }, { maxWait: 15000, timeout: 120000 });
}

// Every SAFE group (or the ones named), each in its own transaction, with the
// proposed main client and name. A group whose membership changed since the
// screen loaded has a different id and is reported, not guessed at.
async function mergeSafeGroups({ groupIds, user }) {
  const { groups } = await computeGroups();
  const safe = groups.filter((g) => g.cls === 'SAFE');
  const want = Array.isArray(groupIds) && groupIds.length ? groupIds.map(String) : null;
  const targets = want ? safe.filter((g) => want.includes(g.id)) : safe;
  const results = [];
  if (want) {
    want.filter((id) => !targets.some((g) => g.id === id)).forEach((id) => {
      const g = groups.find((x) => x.id === id);
      results.push({ groupId: id, ok: false, error: g ? `Not a SAFE group (${g.cls}) — merge it one group at a time` : 'This group changed since the list was loaded — reload' });
    });
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const g of targets) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await mergeClients({
        primaryId: g.primaryId,
        donorIds: g.members.filter((m) => m.id !== g.primaryId).map((m) => m.id),
        name: g.proposedName,
        note: 'Merged with "Merge all SAFE groups"',
        user,
      });
      results.push({ groupId: g.id, ok: true, name: r.name, deleted: r.deleted, moved: r.moved, mergeId: r.mergeId });
    } catch (err) {
      results.push({ groupId: g.id, ok: false, name: g.proposedName, error: err.message });
    }
  }
  return {
    merged: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    removed: results.filter((r) => r.ok).reduce((s, r) => s + r.deleted, 0),
    results,
  };
}

async function mergeHistory(limit = 200) {
  const rows = await prisma.clientMerge.findMany({ orderBy: { createdAt: 'desc' }, take: limit });
  const parse = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
  return rows.map((r) => ({
    id: r.id,
    primaryId: r.primaryId,
    primaryName: r.primaryName,
    donorIds: r.donorIds.split(',').filter(Boolean),
    donorNames: parse(r.donorSnapshot, []).map((d) => d.name),
    moved: parse(r.moved, {}),
    filled: (parse(r.filledFields, {}) || {}).filled || [],
    note: r.note,
    mergedByName: r.mergedByName,
    createdAt: r.createdAt,
  }));
}

// ---------------------------------------------------------------------------
// THE RECOMMENDED PLAN. Deterministic: the same client table always gives the
// same merge sets, so the plan applied here re-runs identically on another
// copy of the data ("Merge all recommended" on the Duplicate clients page).
//
//   SAFE       merge the group.
//   NEAR       merge the group, except known false name matches (Sankhya vs
//              Sandhya, Sharada vs Sharad, CMR vs CME), which are split first.
//   AMBIGUOUS  by place (name tail after , ( - @ |, plus the location field;
//              spelling variants of one place count as one):
//     a) one place, or no place at all      -> merge the group
//     b) several places, an EDUCATION name  -> one client per place,
//        "Name – Place"; members with no place join the place that holds
//        the ACTIVE agreement, else the one with most requirements
//     c) several places, a hospital / clinic / company chain -> ONE client,
//        branch places written into a blank location and into the notes
//     d) any set holding 2+ ACTIVE agreements with DIFFERENT terms (fee % or
//        guarantee) is split per agreement: conflicting contracts are never
//        merged. Members without an agreement follow their place.
//   Department differences are ignored (invoice-import copies carried the
//   wrong department). Never merged: the internal client, not-a-company rows,
//   ZZTEST rows. An education per-place client also absorbs a separate group
//   / single record that is the same name + that place ("Siddhartha
//   Ibrahimpatnam" joins "Siddhartha – Ibrahimpatnam").
// ---------------------------------------------------------------------------
const FALSE_PAIRS = [['sankhya', 'sandhya'], ['sharada', 'sharad'], ['cmr', 'cme']];
const EDU_RE = /\b(college|colleges|clg|school|institute|institution|university|univeristy|academy|engineering|pharmacy|degree|junior|vidyalaya|polytechnic)\b/i;
const CHAIN_RE = /\b(hospitals?|hostipal|clinics?|health|healthcare|care|medicare|pvt|ltd|limited|private|industr\w*|labs?|technolog\w*|solutions?|services?|diagnostics?)\b/i;
const PLACE_STOP = new Set([...STOPPLACE, 'super', 'speciality', 'specialty', 'specialitytamil', 'hospital', 'hospitals', 'research', 'institute',
  'engineering', 'college', 'autonomous', 'onroll', 'ot', 'scrub', 'nurse', 'job', 'max', 'group', 'ncr', 'bec', 'full', 'part', 'time',
  'medical', 'gastro', 'near', 'village', 'tah', 'rd', 'market', 'gate', 'railway', 'no', 'cbsc', 'cbse', 'nabh', 'accredited', 'clinic',
  'health', 'care', 'pvt', 'ltd', 'of', 'locations', 'mbbs', 'ece', 'women', 'hospitalandresearchinstitute', 'po', 'opp', 'beside', 'behind',
  'floor', 'tower', 'building', 'plot', 'h', 'rhl', 'multi', 'specialty']);
const PLACE_GENERIC = new Set(['nagar', 'hills', 'road', 'puram', 'colony', 'layout', 'city', 'town', 'centre', 'center', 'cross', 'main', 'park', 'estate', 'industrial']);
const REGION = new Set(['hyderabad', 'secunderabad', 'telangana', 'andhra', 'pradesh', 'madhya', 'madhyapradesh', 'tamil', 'nadu', 'tamilnadu',
  'kerala', 'karnataka', 'maharashtra', 'maharasthra', 'maharastra', 'west', 'bengal', 'india', 'ts', 'ap', 'tn', 'tirupati', 'rangareddy',
  'ranga', 'reddy', 'warangal', 'ms', 'dist', 'dt']);
const PLACE_ALIAS = { ib: 'ibrahimpatnam', ibm: 'ibrahimpatnam', ibp: 'ibrahimpatnam', banglore: 'bangalore', bengaluru: 'bangalore', cochin: 'kochi' };

const skel = (s) => s.replace(/[aeiouhy]/g, '').replace(/(.)\1+/g, '$1');
function fuzzyTok(a, b) {
  if (a === b) return true;
  if (a.length < 5 || b.length < 5 || a[0] !== b[0]) return false;
  if (osa(a, b) <= 1) return true;
  const sa = skel(a); const sb = skel(b);
  return sa.length >= 3 && sb.length >= 3 && osa(sa, sb) <= 1;
}
const cleanPlaceToks = (arr) => arr.map((t) => PLACE_ALIAS[t] || t)
  .filter((t) => t && t.length > 1 && !PLACE_STOP.has(t) && !REGION.has(t) && !/^\d+$/.test(t));
function placeOf(m) {
  const tail = cleanPlaceToks(tok(tailOf(m.name).replace(NOISE, ' ')));
  const loc = cleanPlaceToks(tok(String(m.location || '').replace(/\(.*?\)/g, ' ').replace(NOISE, ' ')));
  const match = new Set([...tail, ...loc].filter((t) => !PLACE_GENERIC.has(t)));
  const label = (loc.length ? loc : tail).filter((t) => match.has(t) || PLACE_GENERIC.has(t));
  return { match, label, fromLoc: loc.length > 0 };
}
const placesMatch = (A, B) => [...A].some((a) => [...B].some((b) => fuzzyTok(a, b)));
const titlePlace = (toks) => toks.map((t) => (t.length <= 2 ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1))).join(' ');

const guarNorm = (g) => {
  if (blank(g)) return null;
  const s = String(g).toLowerCase().replace(/\s+/g, ' ').trim();
  if (/^(30 days|1 months?|one month)$/.test(s)) return '1 month';
  if (/^(60 days|2 months)$/.test(s)) return '2 months';
  if (/^(90 days|3 months)$/.test(s)) return '3 months';
  return s;
};
const isActive = (m) => m.agreementStatus === 'ACTIVE';
function termsConflict(ms) {
  const act = ms.filter(isActive);
  if (uniq(act.map((m) => m.agreementFeePercent)).length > 1) return true;
  return uniq(act.map((m) => guarNorm(m.guaranteePeriod))).length > 1;
}
const termsLabel = (m) => `${m.agreementFeePercent != null ? `${m.agreementFeePercent}%` : '?%'}${guarNorm(m.guaranteePeriod) ? ` / ${m.guaranteePeriod}` : ''}`;
const firstTok = (m) => tok(headOf(m.name))[0] || '';

// Known false matches: split the members by which of the two names they are closer to.
function splitFalsePairs(members) {
  let parts = [members];
  FALSE_PAIRS.forEach(([a, b]) => {
    const next = [];
    parts.forEach((part) => {
      const f = part.map(firstTok);
      if (!f.includes(a) || !f.includes(b)) { next.push(part); return; }
      const A = []; const B = [];
      part.forEach((m) => { const t = firstTok(m); (osa(t, b) < osa(t, a) ? B : A).push(m); });
      next.push(A, B);
    });
    parts = next;
  });
  return parts.filter((p) => p.length);
}

// Place clusters inside a set of members (spelling variants joined).
function placeClusters(ms) {
  const withP = ms.map((m) => ({ m, p: placeOf(m) }));
  const placed = withP.filter((x) => x.p.match.size);
  const parent = placed.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      if (placesMatch(placed[i].p.match, placed[j].p.match)) parent[find(i)] = find(j);
    }
  }
  const by = {};
  placed.forEach((x, i) => { (by[find(i)] ||= []).push(x); });
  const clusters = Object.values(by).map((xs) => {
    const best = xs.slice().sort((a, b) => (b.p.fromLoc - a.p.fromLoc) || (b.m.reqs - a.m.reqs))[0];
    return {
      members: xs.map((x) => x.m),
      match: new Set(xs.flatMap((x) => [...x.p.match])),
      label: titlePlace(best.p.label.length ? best.p.label : [...best.p.match]),
    };
  });
  const noPlace = withP.filter((x) => !x.p.match.size).map((x) => x.m);
  return { clusters, noPlace };
}
const sumReqs = (ms) => ms.reduce((s, m) => s + (m.reqs || 0), 0);

// Rule d: one set per distinct ACTIVE agreement; members without an agreement
// follow their place, else the main agreement (the one on a record without a
// place, else the one with most requirements).
function splitByTerms(ms) {
  const tcs = [];
  ms.filter(isActive).sort(comparePrimary).forEach((m) => {
    const g = guarNorm(m.guaranteePeriod);
    let c = tcs.find((x) => x.fee === m.agreementFeePercent && (!x.guar || !g || x.guar === g));
    if (!c) { c = { fee: m.agreementFeePercent, guar: g, members: [] }; tcs.push(c); }
    if (!c.guar && g) c.guar = g;
    c.members.push(m);
  });
  const main = tcs.find((c) => c.members.some((m) => !placeOf(m).match.size))
    || tcs.slice().sort((a, b) => sumReqs(b.members) - sumReqs(a.members))[0];
  ms.filter((m) => !isActive(m)).forEach((m) => {
    const p = placeOf(m).match;
    const hit = p.size ? tcs.find((c) => c.members.some((x) => placesMatch(p, placeOf(x).match))) : null;
    (hit || main).members.push(m);
  });
  return tcs.map((c) => ({ members: c.members, isMain: c === main, terms: termsLabel(c.members.find(isActive)) }));
}

function isEducation(ms, base) {
  if (EDU_RE.test(base)) return true;
  if (CHAIN_RE.test(base)) return false;
  const edu = ms.filter((m) => m.ownerDepartment === 'Education').length;
  return edu * 2 > ms.length;
}

// Does this record's name read "<stem> <place>" (no separator needed)?
function matchesStemPlace(name, stem, place) {
  const K = fullKey(name);
  const lim = stem.length >= 8 ? 2 : 1;
  const placeKeys = [...place.match, place.labelKey].filter(Boolean);
  for (let L = Math.max(3, stem.length - 2); L <= stem.length + 2 && L < K.length; L++) {
    if (osa(K.slice(0, L), stem) <= lim) {
      const suffix = K.slice(L);
      if (placeKeys.some((t) => fuzzyTok(suffix, t))) return true;
    }
  }
  return false;
}

// Location / note for a per-agreement set: one place and no record without a
// place -> that place is the location; otherwise the places go into the notes.
function agreementExtras(ms) {
  const { clusters, noPlace } = placeClusters(ms);
  const labels = clusters.map((c) => c.label);
  if (!labels.length) return undefined;
  if (labels.length === 1 && !noPlace.length) return { locationIfBlank: labels[0] };
  return { appendNote: `Branches (from merged duplicate records): ${labels.join(', ')}` };
}

const planKeyOf = (ids) => groupIdOf(ids);
const RULES = {
  SAFE: 'SAFE — same name',
  NEAR: 'NEAR — typo variants',
  SAME_PLACE: 'AMBIGUOUS — one place (or none)',
  EDU_PLACE: 'AMBIGUOUS — education, one client per place',
  CHAIN: 'AMBIGUOUS — hospital / company chain, one client',
  AGREEMENT: 'AMBIGUOUS — split per ACTIVE agreement',
};

async function computePlan(db = prisma, { testOnly = false } = {}) {
  const isTest = (r) => /zztest/i.test(String(r.name));
  const data = await computeGroups(db, { only: (r) => (testOnly ? isTest(r) : !isTest(r)), withSingles: true });
  const sets = []; // { rule, name, members, extras, groupId, cls, stem?, place? }
  const outcomes = []; // per group: what becomes of it

  data.groups.forEach((g) => {
    const out = { groupId: g.id, cls: g.cls, name: g.proposedName, members: g.members.length, clients: [], notes: [] };
    outcomes.push(out);
    const parts = splitFalsePairs(g.members);
    if (parts.length > 1) out.notes.push(`False name match split: ${parts.map((p) => tidyName(p[0].name)).join(' ≠ ')}`);
    parts.forEach((part) => {
      const base = proposeName(part, pickPrimary(part));
      const emit = (members, rule, name, extras, meta = {}) => {
        sets.push({ rule, name, members, extras, groupId: g.id, cls: g.cls, ...meta });
        out.clients.push({ name, records: members.length, rule });
      };
      if (part.length < 2) { out.clients.push({ name: part[0].name, records: 1, rule: 'KEEP' }); return; }

      let candidates; // [{ members, rule, name, extras, meta }]
      if (g.cls !== 'AMBIGUOUS') {
        candidates = [{ members: part, rule: g.cls, name: base }];
      } else {
        const { clusters, noPlace } = placeClusters(part);
        const edu = isEducation(part, base);
        if (clusters.length <= 1) {
          candidates = [{ members: part, rule: 'SAME_PLACE', name: base, extras: clusters[0] ? { locationIfBlank: clusters[0].label } : undefined }];
        } else if (edu) {
          const withActive = clusters.filter((c) => c.members.some(isActive))
            .sort((a, b) => comparePrimary(a.members.filter(isActive).sort(comparePrimary)[0], b.members.filter(isActive).sort(comparePrimary)[0]));
          const home = withActive[0] || clusters.slice().sort((a, b) => sumReqs(b.members) - sumReqs(a.members))[0];
          home.members.push(...noPlace);
          candidates = clusters.map((c) => ({
            members: c.members, rule: 'EDU_PLACE', name: `${base} – ${c.label}`, extras: { locationIfBlank: c.label },
            meta: { stem: baseKey(base), place: { match: c.match, labelKey: c.label.toLowerCase().replace(/[^a-z0-9]/g, '') } },
          }));
          out.notes.push(`Education institution at ${clusters.length} places: ${clusters.map((c) => c.label).join(', ')}`);
        } else {
          const labels = clusters.map((c) => c.label);
          candidates = [{
            members: part, rule: 'CHAIN', name: base,
            extras: { locationIfBlank: labels.join(', '), appendNote: `Branches (from merged duplicate records): ${labels.join(', ')}` },
          }];
        }
      }
      candidates.forEach((c) => {
        if (!termsConflict(c.members)) {
          if (c.members.length >= 2) emit(c.members, c.rule, c.name, c.extras, c.meta);
          else {
            // A one-record campus stays as it is, but can still absorb its own spelling variants below.
            if (c.rule === 'EDU_PLACE') sets.push({ rule: 'EDU_PLACE', name: c.name, members: c.members, extras: c.extras, groupId: g.id, cls: g.cls, ...c.meta });
            out.clients.push({ name: c.members[0].name, records: 1, rule: 'KEEP' });
          }
          return;
        }
        const tsets = splitByTerms(c.members);
        out.notes.push(`Different ACTIVE agreement terms kept apart: ${tsets.map((t) => t.terms).join(' vs ')}`);
        tsets.forEach((t) => {
          let name = c.name;
          if (!t.isMain) {
            const { clusters } = placeClusters(t.members);
            name = clusters[0] ? `${c.name.split(' – ')[0]} – ${clusters[0].label}` : `${c.name} (${t.terms})`;
          }
          if (t.members.length >= 2) emit(t.members, 'AGREEMENT', name, agreementExtras(t.members));
          else out.clients.push({ name: t.members[0].name, records: 1, rule: 'KEEP' });
        });
      });
    });
  });

  // An education per-place client absorbs other sets / single records that are
  // the same name at that place.
  const absorbed = new Set();
  sets.filter((s) => s.rule === 'EDU_PLACE').forEach((P) => {
    sets.forEach((S) => {
      if (S === P || absorbed.has(S) || S.groupId === P.groupId || S.rule === 'EDU_PLACE') return;
      if (S.members.every((m) => matchesStemPlace(m.name, P.stem, P.place))) {
        P.members.push(...S.members); absorbed.add(S);
        P.absorbed = [...(P.absorbed || []), ...S.members.map((m) => m.name)];
      }
    });
    data.singles.forEach((m) => {
      if (P.members.some((x) => x.id === m.id)) return;
      if (matchesStemPlace(m.name, P.stem, P.place)) { P.members.push(m); P.absorbed = [...(P.absorbed || []), m.name]; }
    });
  });

  const final = sets.filter((s) => !absorbed.has(s) && s.members.length >= 2).map((s) => {
    const primary = pickPrimary(s.members);
    return {
      key: planKeyOf(s.members.map((m) => m.id)),
      rule: s.rule,
      ruleLabel: RULES[s.rule],
      cls: s.cls,
      groupId: s.groupId,
      name: s.name,
      primaryId: primary.id,
      primaryName: primary.name,
      donorIds: s.members.filter((m) => m.id !== primary.id).map((m) => m.id),
      members: s.members.map((m) => ({ id: m.id, name: m.name, reqs: m.reqs, invs: m.invs, agreementStatus: m.agreementStatus })),
      absorbed: s.absorbed || [],
      extras: s.extras,
    };
  });
  const byRule = {};
  final.forEach((s) => { byRule[s.rule] ||= { sets: 0, removable: 0 }; byRule[s.rule].sets += 1; byRule[s.rule].removable += s.donorIds.length; });
  return {
    generatedAt: new Date().toISOString(),
    totalClients: data.totalClients,
    summary: {
      sets: final.length,
      removable: final.reduce((s, x) => s + x.donorIds.length, 0),
      clientsAfter: data.totalClients - final.reduce((s, x) => s + x.donorIds.length, 0),
      byRule,
    },
    sets: final,
    outcomes: outcomes.filter((o) => o.notes.length || o.clients.length > 1),
    junk: data.junk,
  };
}

// Applies the plan (or the sets named by key), each set in its own
// transaction. Recomputed from the live table, so a stale screen cannot
// apply a set whose membership has changed.
async function applyPlan({ keys, user, testOnly = false } = {}) {
  const plan = await computePlan(prisma, { testOnly });
  const want = Array.isArray(keys) && keys.length ? new Set(keys.map(String)) : null;
  const todo = want ? plan.sets.filter((s) => want.has(s.key)) : plan.sets;
  const results = [];
  if (want) {
    [...want].filter((k) => !plan.sets.some((s) => s.key === k))
      .forEach((k) => results.push({ key: k, ok: false, error: 'This set changed since the plan was loaded — reload' }));
  }
  // eslint-disable-next-line no-restricted-syntax
  for (const s of todo) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await mergeClients({
        primaryId: s.primaryId, donorIds: s.donorIds, name: s.name, extras: s.extras, user,
        note: `Recommended plan — ${s.ruleLabel}${s.absorbed.length ? ` (also joined: ${s.absorbed.join(' | ')})` : ''}`,
      });
      results.push({ key: s.key, ok: true, rule: s.rule, name: r.name, deleted: r.deleted, moved: r.moved, mergeId: r.mergeId });
    } catch (err) {
      results.push({ key: s.key, ok: false, rule: s.rule, name: s.name, error: err.message });
    }
  }
  return {
    merged: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    removed: results.filter((r) => r.ok).reduce((a, r) => a + r.deleted, 0),
    results,
  };
}

module.exports = {
  clean, tok, fullKey, baseKey, coreKey, headOf, tidyName, junkReason, isInternalClient,
  computeGroups, previewMerge, mergeClients, mergeSafeGroups, mergeHistory, MergeError, computePlan, applyPlan,
  // Read-only helpers reused by utils/clientDuplicates.js (Add Client duplicate check).
  osa, thr, dig,
};
