// ---------------------------------------------------------------------------
// MANY VALUES IN ONE FILTER (founder 2026-11-20: "in every filter there are dropdowns: give checkboxes so several can be selected at a time").
// ONE parser for every list, count and export that takes a filter:
//
//   parseMulti(raw)            -> ['a', 'b']   a comma list ("a,b,c"), a repeated parameter (["a","b"]) or one value; trims, de-duplicates
//                              (case kept, first spelling wins), ignores empties, caps at 200. A comma INSIDE a value is written %2C.
//   hasMulti(raw)              -> true when at least one value is asked
//   multiHas(raw, value)       -> true when no value is asked, or the row's value is one of them. Backwards compatible: a single OLD link such
//                              as ?location=Hyderabad, Telangana (a comma inside one value) still matches that exact value.
//   multiHasAny(raw, values[]) -> the row carries several values (skills, departments): true when any is asked
//   multiCsv(raw)              -> the cleaned comma list again (cache keys, links)
//
// Inside ONE filter the values are OR-ed; the filters are AND-ed (each caller does that, as before).
// ---------------------------------------------------------------------------
const MAX_VALUES = 200;

function parseMulti(raw) {
  if (raw === undefined || raw === null) return [];
  const parts = Array.isArray(raw) ? raw : [raw];
  const out = [];
  const seen = new Set();
  parts.forEach((p) => {
    // a comma followed by a space belongs to ONE value ("Hyderabad, Telangana": an old link, or data written that way); the checkbox dropdowns write %2C anyway
    String(p === undefined || p === null ? '' : p).split(/,(?!\s)/).forEach((x) => {
      const v = x.replace(/%2C/gi, ',').trim();
      if (!v) return;
      const k = v.toLowerCase();
      if (seen.has(k)) return;
      seen.add(k);
      if (out.length < MAX_VALUES) out.push(v);
    });
  });
  return out;
}
const hasMulti = (raw) => parseMulti(raw).length > 0;

function multiHas(raw, value) {
  if (raw === undefined || raw === null || raw === '' || (Array.isArray(raw) && !raw.length)) return true;
  const v = value === undefined || value === null ? '' : String(value);
  // an old single link that holds a comma inside the one value
  if (!Array.isArray(raw) && String(raw) === v) return true;
  return parseMulti(raw).includes(v);
}
function multiHasAny(raw, values) {
  if (!hasMulti(raw)) return true;
  const want = parseMulti(raw);
  return (values || []).some((v) => want.includes(String(v)) || (!Array.isArray(raw) && String(raw) === String(v)));
}
const multiCsv = (raw) => parseMulti(raw).map((v) => v.replace(/,/g, '%2C')).join(',');

module.exports = { parseMulti, hasMulti, multiHas, multiHasAny, multiCsv, MAX_VALUES };
