// ---------------------------------------------------------------------------
// ONE COMPANY, MANY LOCATIONS (2026-10-22) - the plain pieces the screens share. No React, no network.
//
// The same company can be a client several times (Palnadu Hospital at Narasaraopet, at Guntur ...). Each
// location is its OWN client: its own agreement, renewal date and requirements. They are told apart by the
// client's Location. So wherever a client is CHOSEN, a name that more than one client carries reads
// "Name - Location"; a name only one client has is shown exactly as before.
//
//   clientLabel(c)             "Name - Location" for a same-name client, else the name (c = { id, name, placeLabel? })
//   registerClientPlaces(rows) the server's list of same-name clients (GET /clients/aliases -> places), loaded once
//   placeLabelsFor(rows)       the same rule on a list already loaded in the browser (Map id -> label)
//   shortPlace / samePlace     one place text / the same place?
//   REASON_WORDS               why a client matched, in plain words (the chips)
//   gateConfirm(question, ...) what a confirmed add still needs - the same sentences the server uses
//
// utils/clientLocation.js and backend/src/utils/clientLocations.js carry the same rule; the tests of both hold the
// same cases (scripts/client-add-location-test.js, frontend/scripts/client-location-test.mjs).
// ---------------------------------------------------------------------------
const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
export const placeKey = (v) => String(v == null ? '' : v).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

// The name as the server compares it: case, punctuation and Pvt / Ltd ignored (the server's fullKey is the strict rule;
// this is for a list already in the browser).
const CORP = new Set(['pvt', 'private', 'ltd', 'limited', 'llp', 'inc']);
export const nameKey = (n) => String(n == null ? '' : n).toLowerCase().replace(/['’‘`]/g, '').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter((t) => t && !CORP.has(t)).join('');

export function samePlace(aLoc, aState, bLoc, bState) {
  const a = placeKey(aLoc);
  const b = placeKey(bLoc);
  if (!a || !b || a !== b) return false;
  const sa = placeKey(aState);
  const sb = placeKey(bState);
  return !sa || !sb || sa === sb;
}

// A long address is cut from the FRONT (street first) until it fits a label.
export function shortPlace(loc, max = 40) {
  const s = clean(loc);
  if (s.length <= max) return s;
  const parts = s.split(',').map((p) => p.trim()).filter(Boolean);
  while (parts.length > 1 && parts.join(', ').length > max) parts.shift();
  const out = parts.join(', ');
  return out.length > max ? `${out.slice(0, max - 1).trim()}…` : out;
}

// rows: [{ id, name, location, state, clientCode, displayCode }] -> Map(id -> "Name - Location") for names carried by 2+ clients.
export function placeLabelsFor(rows) {
  const groups = new Map();
  (rows || []).forEach((r) => {
    const k = nameKey(r.name) || clean(r.name).toLowerCase();
    if (!k) return;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  });
  const out = new Map();
  const labelOf = (r, max) => { const place = shortPlace(r.location, max) || clean(r.state); return place ? `${clean(r.name)} - ${place}` : clean(r.name); };
  const sig = (r, max) => `${nameKey(r.name)}|${placeKey(shortPlace(r.location, max) || r.state)}`;
  groups.forEach((list) => {
    if (list.length < 2) return;
    const cut = new Map(list.map((r) => [r.id, 40]));
    const tally = () => { const m = new Map(); list.forEach((r) => { const k = sig(r, cut.get(r.id)); m.set(k, (m.get(k) || 0) + 1); }); return m; };
    let seen = tally();
    list.forEach((r) => { if (seen.get(sig(r, cut.get(r.id))) > 1 && clean(r.location).length > 40) cut.set(r.id, 90); });
    seen = tally();
    list.forEach((r) => {
      const max = cut.get(r.id);
      const label = labelOf(r, max);
      const code = r.clientCode || r.displayCode || (r.id ? `CL-${String(r.id).slice(-6).toUpperCase()}` : '');
      out.set(r.id, seen.get(sig(r, max)) > 1 && code ? `${label} (${code})` : label);
    });
  });
  return out;
}

// ---- the label registry (filled once after sign-in) --------------------------------------------------------
let places = new Map(); // client id -> "Name - Location"
let version = 0;
const listeners = new Set();
export function registerClientPlaces(rows) {
  places = new Map((Array.isArray(rows) ? rows : []).filter((r) => r && r.id && r.label).map((r) => [String(r.id), String(r.label)]));
  version += 1;
  listeners.forEach((f) => { try { f(); } catch { /* a listener must not stop the others */ } });
}
export const clientPlacesVersion = () => version;
export function onClientPlacesChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// What a dropdown shows for a client. c = { id, name, placeLabel? }: the row's own label (the server put it there) wins,
// then the registry; a unique name is returned exactly as it is.
export function clientLabel(c) {
  if (!c) return '';
  return c.placeLabel || (c.id != null && places.get(String(c.id))) || c.name || '';
}
// The same for a client id + name pair (a requirement's client, an invoice's client ...).
export const clientLabelOf = (id, name) => clientLabel({ id, name });

// ---- the question box: plain words -------------------------------------------------------------------------
export const REASON_WORDS = {
  NAME: 'Same name', LEGAL_NAME: 'Same legal name', ALIAS: 'Same name as an older spelling',
  GSTIN: 'Same GST number', PAN: 'Same PAN', PAN_IN_GSTIN: 'Same PAN (inside the GST number)',
  PHONE: 'Same phone number', EMAIL: 'Same email', NAME_BRANCH: 'Same name, other place in the name',
  NAME_TYPO: 'Name looks almost the same', ALIAS_TYPO: 'Name looks like an older spelling', DOMAIN: 'Same company email address ending',
  ADDRESS: 'Same address',
};
export const chipText = (r) => (r && (REASON_WORDS[r.code] || r.label)) || '';

export const NEEDS_LOCATION = 'Tell us the location so we can tell them apart.';
export const NEEDS_REASON = 'Write one line on why this is a different client.';

// Pressing the big "Yes" button: what is still missing before the save can go? { ok } or { ok:false, field, error }.
export function gateConfirm(question, { location = '', reason = '' } = {}) {
  if (!question) return { ok: true };
  if (question.level === 'sameName' && !clean(location)) return { ok: false, field: 'location', error: NEEDS_LOCATION };
  if (question.level === 'likelySame' && clean(reason).length < 3) return { ok: false, field: 'separateReason', error: NEEDS_REASON };
  return { ok: true };
}

// The text under the form instead of the old red "This client may already exist ..." line.
export function pendingLine(question) {
  if (!question) return '';
  return question.hint || (question.level === 'sameName'
    ? 'A client with this name already exists. Choose Yes to add another location.'
    : 'A client like this already exists. Choose Yes to add it as a separate client.');
}

// The words of a card line: "Narasaraopet - Agreement active - 3 requirements".
export function cardFacts(m, agreementWords = (s) => s) {
  return [
    m.location || 'No location written yet',
    m.agreementStatus ? `Agreement: ${agreementWords(m.agreementStatus)}` : 'No agreement yet',
    `${m.requirementsCount || 0} requirement${m.requirementsCount === 1 ? '' : 's'}`,
  ];
}
