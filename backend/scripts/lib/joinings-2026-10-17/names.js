// ---------------------------------------------------------------------------
// Name helpers shared by the importer: the client key (a copy of src/utils/clientDedupe.js fullKey so the script never loads the
// application database layer), a conservative name matcher for people, and a few small string tools.
// ---------------------------------------------------------------------------
const CORP = new Set(['pvt', 'private', 'ltd', 'limited', 'lmt', 'lts', 'llp', 'inc', 'pvtltd', 'ltdd']);
const PL = { hospitals: 'hospital', hostipal: 'hospital', constructions: 'construction', clinics: 'clinic', industries: 'industry', womens: 'women', colleges: 'college', clg: 'college' };
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
  .filter((t, i) => t && !CORP.has(t) && !(i === 0 && t === 'the'))
  .map((t) => PL[t] || t);
const fullKey = (n) => tok(clean(n)).join('');

// letters-and-digits only, lower case: "are these the same words typed differently"
const nkey = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
const sp = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

// ---- people (recruiters / TLs written in the sheets -> employees) -----------------------------------
// "S.Uma", "D.Kavya Lahari", "Mani deep" -> the employee, ONLY when exactly one employee fits.
const skel = (w) => w.replace(/h/g, '').replace(/ee/g, 'i').replace(/(.)\1+/g, '$1').replace(/y/g, 'i');
function nameParts(s) {
  const toks = String(s || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean).map((x) => (/^(rathnya|ratnya|rathna)/.test(x) ? x.replace(/^(rathnya|ratnya|rathna)/, 'ratna') : x));
  return { main: toks.filter((x) => x.length >= 3), init: toks.filter((x) => x.length < 3).map((x) => x[0]), all: toks };
}
function makePersonMatcher(employees) {
  const EMP = employees.map((e) => ({ e, p: nameParts(e.name) })).map((x) => ({ ...x, joined: x.p.all.join(''), skelJoined: skel(x.p.all.join('')) }));
  const cache = new Map();
  function match(raw) {
    const k = sp(raw);
    if (cache.has(k)) return cache.get(k);
    const { main, init } = nameParts(k);
    let res;
    if (!main.length && !init.length) res = { status: 'blank', hits: [] };
    else if (!main.length) res = { status: 'UNMAPPED', hits: [] };
    else {
      const hits = EMP.filter(({ p, joined, skelJoined }) => {
        const all = [...p.main, ...p.init];
        const ok = main.every((w) => p.main.some((x) => x === w || skel(x) === skel(w) || (w.length >= 5 && x.startsWith(w))) || (w.length >= 6 && (joined.includes(w) || skelJoined.includes(skel(w)))));
        if (!ok) return false;
        return init.every((i) => all.some((x) => x[0] === i));
      }).map((x) => x.e);
      const dep = hits.filter((e) => /(education|bde)/i.test(e.department || ''));
      res = { status: hits.length === 0 ? 'UNMAPPED' : (hits.length === 1 ? 'unique' : (dep.length === 1 ? 'unique-in-Edu/BDE' : 'AMBIGUOUS')), hits: dep.length === 1 && hits.length > 1 ? dep : hits };
    }
    cache.set(k, res);
    return res;
  }
  return match;
}

// ---- candidates: is this the same person? (a phone typed against the wrong person is not a match) --------------
const nameWords = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !['mrs', 'miss', 'smt'].includes(w));
function lev(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  if (!m || !n) return m || n;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur = [i];
    for (let j = 1; j <= n; j += 1) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const lettersOnly = (s) => String(s || '').toLowerCase().replace(/^(dr|mr|mrs|ms)\b\.?\s*/, '').replace(/[^a-z]/g, '');
function samePerson(a, b) {
  const A = nameWords(a); const B = nameWords(b);
  if (A.some((w) => B.some((x) => x === w || skel(x) === skel(w) || (Math.min(x.length, w.length) >= 5 && lev(x, w) <= 1)))) return true;
  const ka = lettersOnly(a); const kb = lettersOnly(b);
  return ka.length >= 4 && kb.length >= 4 && (ka.slice(0, 4) === kb.slice(0, 4) || skel(ka).slice(0, 4) === skel(kb).slice(0, 4));
}
// the same full name once spaces, dots, titles and case are ignored
const sameFullName = (a, b) => { const ka = lettersOnly(a); const kb = lettersOnly(b); return ka.length >= 6 && ka === kb; };

module.exports = { fullKey, clean, nkey, sp, makePersonMatcher, nameParts, samePerson, sameFullName, lettersOnly, lev, skel };
