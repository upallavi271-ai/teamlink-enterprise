// One matching rule for every type-to-search dropdown (2026-10-16).
// Case-insensitive, extra spaces ignored, matches ANYWHERE in the text.
// "med 1" finds "MED-1"; "hyd tel" finds "Hyderabad, Telangana" (every typed word must appear).
export const squash = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, '');
const words = (s) => String(s == null ? '' : s).toLowerCase().split(/\s+/).filter(Boolean);

// The plain rule on one text: every typed word appears, or the squashed text appears.
function plainMatch(text, query) {
  const ws = words(query);
  if (!ws.length) return true;
  const low = String(text == null ? '' : text).toLowerCase();
  if (ws.every((w) => low.includes(w))) return true;
  const k = squash(query);
  return !!k && squash(text).includes(k);
}

// ---------------------------------------------------------------------------
// OLD CLIENT NAMES (2026-10-17). A client is listed under its OFFICIAL legal name; the names it was known by
// before ("VCare" for "Prabs VCare Health Clinic") are kept server-side (ClientAlias). Typing an old name must
// still find the client in every box - while every box still SHOWS the official name only.
//   registerClientAliases([{ name, aliases: [...] }])  - called once by components/clientAliases.js (GET /clients/aliases)
//   matchesText(label, query)                          - also true when `label` is (or starts with "<name> · ", "<name> (", ...)
//                                                        a registered official name and the query matches one of its old names
//   clientAliasText(name)                              - the old names of a client as one string, for a screen that does
//                                                        its own `.includes()` search: `${c.name} ${clientAliasText(c.name)}`
// The old names are used for MATCHING only. Nothing here ever returns one for display.
// ---------------------------------------------------------------------------
let registry = [];           // [{ low: 'prabs vcare health clinic', text: 'vcare VCare Hospital' }] longest name first
let registryByName = new Map();
const labelCache = new Map(); // label -> alias text ('' when none)
const SEPARATORS = [' · ', ' — ', ' – ', ' - ', ' (', ', ', ' | '];

export function registerClientAliases(rows) {
  const by = new Map();
  (Array.isArray(rows) ? rows : []).forEach((r) => {
    const name = String((r && r.name) || '').trim().toLowerCase();
    const al = ((r && r.aliases) || []).map((a) => String(a || '').trim()).filter((a) => a && a.toLowerCase() !== name);
    if (!name || !al.length) return;
    by.set(name, [...(by.get(name) || []), ...al]);
  });
  registryByName = new Map([...by.entries()].map(([k, v]) => [k, [...new Set(v)].join(' ')]));
  registry = [...registryByName.entries()].map(([low, text]) => ({ low, text })).sort((a, b) => b.low.length - a.low.length);
  labelCache.clear();
}

// The old names that belong to a dropdown LABEL: the label is exactly a client's official name, or that name followed
// by a separator and extra words ("Name · CL-123", "Name (12)", "Name, Hyderabad").
function aliasTextOfLabel(label) {
  if (!registry.length) return '';
  const low = String(label == null ? '' : label).trim().toLowerCase();
  if (!low) return '';
  if (labelCache.has(low)) return labelCache.get(low);
  let out = registryByName.get(low) || '';
  if (!out) {
    for (const r of registry) {
      if (low.length > r.low.length && low.startsWith(r.low) && SEPARATORS.some((s) => low.startsWith(r.low + s))) { out = r.text; break; }
    }
  }
  if (labelCache.size > 5000) labelCache.clear();
  labelCache.set(low, out);
  return out;
}

export const clientAliasText = (name) => aliasTextOfLabel(name);

// text: one string (or several joined by the caller). Empty query matches everything.
export function matchesText(text, query) {
  if (plainMatch(text, query)) return true;
  if (!registry.length) return false;
  const al = aliasTextOfLabel(text);
  return !!al && plainMatch(al, query);
}

export function filterBy(list, query, textOf = (x) => x) {
  if (!words(query).length) return list;
  return list.filter((x) => matchesText(textOf(x), query));
}

export const noMatchText = (query, empty = 'No match') => {
  const q = String(query == null ? '' : query).replace(/\s+/g, ' ').trim();
  return q ? `No match for "${q}"` : empty;
};
