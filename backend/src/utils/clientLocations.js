// ---------------------------------------------------------------------------
// ONE COMPANY, MANY LOCATIONS (user, 2026-10-22).
//
// The same client company can have several branches (Palnadu Hospital at
// Narasaraopet, Guntur ...). Each branch is its OWN Client row: its own
// agreement and renewal date, its own requirements, invoices and logins. The
// rows are told apart by Client.location (the "Location (city / branch)" box at
// the top of Add client). Nothing is merged and no ClientAlias is made between
// two locations of one company.
//
// This file is the plain rules, in one place:
//   * placeKey / samePlace        - is it the same location?
//   * buildQuestion(dup, input)   - the friendly "This client already exists ...
//                                   do you still want to add another one?" box
//                                   (the SAME text for the live check and the 409)
//   * confirmProblem(q, body)     - what a confirmed add still needs (location /
//                                   one-line reason)
//   * placeLabelsFor(rows)        - "Name - Location" labels, only for names that
//                                   more than one client carries
// Nothing here writes a client.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { fullKey } = require('./clientDedupe');

const SAME_NAME_CODES = new Set(['NAME', 'LEGAL_NAME', 'ALIAS']);

const placeKey = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();

// Same location: the same place text (spaces, case, punctuation ignored), and the same state when both are known.
function samePlace(aLoc, aState, bLoc, bState) {
  const a = placeKey(aLoc);
  const b = placeKey(bLoc);
  if (!a || !b || a !== b) return false;
  const sa = placeKey(aState);
  const sb = placeKey(bState);
  return !sa || !sb || sa === sb;
}

// A long address in the Location box ("Survey No. 563, Near Forest Academy, Dulapally, Kompally, ...") is cut from the
// FRONT (street level first) until it is short enough for a label.
function shortPlace(loc, max = 40) {
  const s = clean(loc);
  if (s.length <= max) return s;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && parts.join(', ').length > max) parts.shift();
  const out = parts.join(', ');
  return out.length > max ? `${out.slice(0, max - 1).trim()}…` : out;
}

// rows: [{ id, name, location, state, clientCode }] -> Map(id -> "Name - Location") for every client whose name
// (spelling, case, Pvt/Ltd ignored) is carried by more than one row. Unique names are not in the map (nothing changes for them).
// When two labels would still look the same, the client number is added: "Name - Kompally (CL-ABC123)".
function placeLabelsFor(rows) {
  const groups = new Map();
  (rows || []).forEach((r) => {
    const k = fullKey(r.name) || clean(r.name).toLowerCase();
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const out = new Map();
  const labelOf = (r, max) => { const place = shortPlace(r.location, max) || clean(r.state); return place ? `${clean(r.name)} - ${place}` : clean(r.name); };
  // two rows look alike when their name AND place read the same once spelling / case / Pvt Ltd are ignored
  const sig = (r, max) => `${fullKey(r.name)}|${placeKey(shortPlace(r.location, max) || r.state)}`;
  groups.forEach((list) => {
    if (list.length < 2) return;
    const cut = new Map(list.map((r) => [r.id, 40]));
    const tally = () => { const m = new Map(); list.forEach((r) => { const k = sig(r, cut.get(r.id)); m.set(k, (m.get(k) || 0) + 1); }); return m; };
    let seen = tally();
    // a long address that was cut and now looks like another one: show more of it before adding the number
    list.forEach((r) => { if (seen.get(sig(r, cut.get(r.id))) > 1 && clean(r.location).length > 40) cut.set(r.id, 90); });
    seen = tally();
    list.forEach((r) => {
      const max = cut.get(r.id);
      const label = labelOf(r, max);
      const code = r.clientCode || (r.id ? `CL-${String(r.id).slice(-6).toUpperCase()}` : '');
      out.set(r.id, seen.get(sig(r, max)) > 1 && code ? `${label} (${code})` : label);
    });
  });
  return out;
}

// The labels for EVERY client (a login that sees one of two locations still gets "Name - Location" for its own: the label shows only
// that client's own place). Kept 20 seconds; forgetLabels() after a client is added / renamed / moved.
let labelCache = { at: 0, map: null };
async function labelMap({ db = prisma, fresh = false } = {}) {
  if (!fresh && labelCache.map && Date.now() - labelCache.at < 20000) return labelCache.map;
  const rows = await db.client.findMany({ select: { id: true, name: true, location: true, state: true, clientCode: true } }).catch(() => []);
  labelCache = { at: Date.now(), map: placeLabelsFor(rows) };
  return labelCache.map;
}
const forgetLabels = () => { labelCache = { at: 0, map: null }; };

// The same-name clients among `where`-matched ones: rows for the browser's label registry.
async function placeRows(where = {}, db = prisma) {
  const [map, rows] = await Promise.all([labelMap({ db }), db.client.findMany({ where, select: { id: true, name: true, location: true } })]);
  return rows.filter((r) => map.has(r.id)).map((r) => ({ id: r.id, name: r.name, label: map.get(r.id), location: r.location || null }));
}

// A facet / option list [{ value: <client id>, label, count }]: the label of a same-name client gets its place.
async function labelClientOptions(options, { db = prisma } = {}) {
  if (!Array.isArray(options) || !options.length) return options;
  const map = await labelMap({ db });
  if (!map.size) return options;
  return options.map((o) => (o && map.has(String(o.value)) ? { ...o, label: map.get(String(o.value)) } : o));
}

// ---- the question --------------------------------------------------------------
const joinWords = (list) => (list.length <= 1 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const shownPlace = (m) => clean(m.place || '') || clean(m.location || '');
const nameWithPlace = (m) => `${m.name}${shownPlace(m) ? `, ${shortPlace(shownPlace(m), 50)}` : ''}`;

// Why a match matched, in plain words (the chips). Code -> text.
const REASON_WORDS = {
  NAME: 'Same name', LEGAL_NAME: 'Same legal name', ALIAS: 'Same name as an older spelling',
  GSTIN: 'Same GST number', PAN: 'Same PAN', PAN_IN_GSTIN: 'Same PAN (inside the GST number)',
  PHONE: 'Same phone number', EMAIL: 'Same email', NAME_BRANCH: 'Same name, other place in the name',
  NAME_TYPO: 'Name looks almost the same', ALIAS_TYPO: 'Name looks like an older spelling', DOMAIN: 'Same company email address ending',
  ADDRESS: 'Same address',
};
// One chip per idea: when the name matched, "same legal name" / "older spelling" add nothing.
const plainReasons = (m) => {
  const codes = new Set((m.reasons || []).map((r) => r.code));
  return (m.reasons || [])
    .filter((r) => !(codes.has('NAME') && (r.code === 'LEGAL_NAME' || r.code === 'ALIAS')))
    .map((r) => ({ code: r.code, strength: r.strength, label: REASON_WORDS[r.code] || r.label }));
};

/**
 * The friendly question for a create / rename that matches an existing client. null = nothing to ask.
 *   input: { name, location, state, ... } the client being added
 *   dup:   findClientDuplicates() result (its matches carry sameName / sameLocation)
 * level: 'sameName' (another location / branch?), 'likelySame' (same name AND same location: really a different client?),
 *        'sameId' (same GST / PAN under another name).
 */
async function buildQuestion(dup, input = {}, { db = prisma } = {}) {
  const hard = (dup && dup.matches ? dup.matches : []).filter((m) => m.blocking);
  if (!hard.length) return null;
  const sameNames = hard.filter((m) => m.sameName);
  const likely = sameNames.filter((m) => m.sameLocation);
  const level = likely.length ? 'likelySame' : (sameNames.length ? 'sameName' : 'sameId');
  const shown = (level === 'sameId' ? hard : [...likely, ...sameNames.filter((m) => !m.sameLocation), ...hard.filter((m) => !m.sameName)]).slice(0, 6);
  // how many requirements each one has (the card says it)
  const counts = new Map();
  try {
    const g = await db.requirement.groupBy({ by: ['clientId'], where: { clientId: { in: shown.map((m) => m.id) } }, _count: { _all: true } });
    g.forEach((x) => counts.set(x.clientId, x._count._all));
  } catch { /* the card then simply has no number */ }
  const cards = shown.map((m) => ({
    id: m.id,
    name: m.name,
    displayCode: m.displayCode,
    location: shownPlace(m) || null,
    state: m.state || null,
    agreementStatus: m.agreementStatus || null,
    requirementsCount: counts.get(m.id) || 0,
    sameName: !!m.sameName,
    sameLocation: !!m.sameLocation,
    reasons: plainReasons(m),
  }));
  const hasLocation = !!clean(input.location);
  const first = shown[0];
  let q;
  if (level === 'likelySame') {
    const m = likely[0];
    const codes = new Set((m.reasons || []).map((r) => r.code));
    const parts = ['name', 'location'];
    if (codes.has('GSTIN') || codes.has('PAN') || codes.has('PAN_IN_GSTIN')) parts.push('GST number');
    if (codes.has('PHONE')) parts.push('phone number');
    if (codes.has('EMAIL')) parts.push('email');
    q = {
      title: 'A client with the same name and location already exists',
      text: `A client with the same ${joinWords(parts)} already exists (${nameWithPlace(m)}). Are you sure it is a different one?`,
      yesLabel: 'Add as separate client',
      needsLocation: false,
      needsReason: true,
      reasonLabel: 'In one line: why is this a different client?',
    };
  } else if (level === 'sameName') {
    const names = sameNames.slice(0, 2).map(nameWithPlace);
    const more = sameNames.length > 2 ? ` and ${sameNames.length - 2} more` : '';
    q = {
      title: 'This client already exists',
      text: `This client already exists (${names.join('; ')}${more}). Do you still want to add another one? For example another location or branch of the same client.`,
      yesLabel: 'Yes, add another location',
      needsLocation: !hasLocation,
      needsReason: false,
    };
  } else {
    const codes = new Set(first.reasons.map((r) => r.code));
    const what = codes.has('GSTIN') || codes.has('PAN_IN_GSTIN') ? 'GST number' : 'PAN';
    q = {
      title: `A client with this ${what} already exists`,
      text: `${nameWithPlace(first)} already has the same ${what}. Do you still want to add another client? For example another location of the same company.`,
      yesLabel: 'Yes, add another client',
      needsLocation: false,
      needsReason: false,
    };
  }
  return {
    level,
    ...q,
    noLabel: 'No, open the existing client',
    hint: level === 'sameName' ? 'A client with this name already exists. Choose Yes to add another location.' : 'A client like this already exists. Choose Yes to add it as a separate client.',
    locationHint: 'Tell us the location so we can tell them apart.',
    matches: cards,
  };
}

// What a CONFIRMED add still needs. null = fine. { status, body } = refuse with a plain sentence (never a bare error).
function confirmProblem(question, body = {}, location = '') {
  if (!question) return null;
  if (question.level === 'sameName' && !clean(location)) {
    const error = 'Tell us the location so we can tell them apart.';
    return { status: 400, body: { error, code: 'NEEDS_LOCATION', errors: [{ field: 'location', error }], question: { ...question, needsLocation: true } } };
  }
  if (question.level === 'likelySame' && clean(reasonOf(body)).length < 3) {
    const error = 'Write one line on why this is a different client.';
    return { status: 400, body: { error, code: 'NEEDS_REASON', errors: [{ field: 'separateReason', error }], question } };
  }
  return null;
}
const reasonOf = (body) => String((body && (body.separateReason || body.duplicateNote)) || '').trim().slice(0, 500);
const isConfirmed = (body) => !!body && (body.confirmSeparate === true || body.allowDuplicate === true);

// The 409 a save sends when a match exists and the caller has not confirmed.
function questionResponse(question, dup) {
  const first = question.matches[0];
  const error = question.level === 'sameName'
    ? `This client already exists (${first ? nameWithPlace(first) : 'same name'}). Do you still want to add another one (another location / branch)?`
    : question.text;
  return {
    error,
    code: 'DUPLICATE_CLIENT',
    blocking: true,
    needsConfirm: true,
    question,
    duplicates: dup.matches, // kept for the older callers
  };
}

// Ids of the OTHER clients that carry the same name as `client` (a sibling location) - for an edit / the HR step, where a
// same-name sibling at ANOTHER location is expected and must not stop the save.
async function siblingsOf(client, db = prisma) {
  const k = fullKey(client.name);
  if (!k) return [];
  const rows = await db.client.findMany({ select: { id: true, name: true, location: true, state: true } });
  return rows.filter((r) => r.id !== client.id && fullKey(r.name) === k);
}

// Remove from a duplicate result the same-name siblings at another location (expected), and recompute `blocking`.
function withoutOtherLocations(dup, client, siblings, newPlace) {
  const sib = new Map(siblings.map((s) => [s.id, s]));
  const here = newPlace || { location: client.location, state: client.state };
  const matches = dup.matches.filter((m) => {
    const s = sib.get(m.id);
    if (!s) return true;
    return samePlace(here.location, here.state, s.location, s.state);
  });
  return { matches, total: matches.length, blocking: matches.some((m) => m.blocking) };
}

module.exports = {
  SAME_NAME_CODES, placeKey, samePlace, shortPlace, placeLabelsFor, placeRows, labelMap, forgetLabels, labelClientOptions, buildQuestion, confirmProblem,
  questionResponse, isConfirmed, reasonOf, siblingsOf, withoutOtherLocations, REASON_WORDS,
};
