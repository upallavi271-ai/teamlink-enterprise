// COPY of backend/src/utils/salaryFit.js for the browser (live preview of what will be saved, same messages).
// KEEP IN SYNC: backend/scripts/salary-fit-test.js fails when the two differ. Edit the backend file, then copy it here.
// ---------------------------------------------------------------------------
// SALARY + SALARY FIT — the ONE helper (user note 2026-10-10, item 3).
//
//   "Add Candidate lo ... SALARY EXPECTATION and CURRENT SALARY must & should
//    ga add cheyyali. Salary expected, and also client ichey salary tho entha
//    percent match avuthundho kuda visible avvali."
//
// UNIT. The app's unit for a yearly CTC is LAKHS PER YEAR (LPA): the job form
// says "Minimum salary (₹ lakh per year)", Requirement.salary is stored as
// "₹14L - ₹20L", offeredCtc is a yearly rupee figure. So every NEW candidate
// salary is stored as a clean "4.5 LPA" (a string - the Candidate columns stay
// strings, no migration) and a monthly entry ("45000 per month") is converted
// once, on the way in, to that yearly figure. Old, messy values already in the
// database ("35k", "1.5 LPM", "Fresher", "As per norms") are never rewritten;
// they are only READ by parseAmount() below.
//
// THE FIT % (plain, explainable - shown to a 15-20 year old as "Salary fit"):
//
//   expected pay  vs  the job's budget [min .. max]  (both in LPA)
//
//   expected is inside the budget          100 %   "Within budget"
//   expected is BELOW the budget's minimum 100 %   "Within budget" + "Below range"
//                                                  (the person is cheaper; the
//                                                  flag is shown, the % stays 100)
//   expected is ABOVE the maximum          max / expected (rounded down to a
//                                          whole %), e.g. max 25000 vs wants
//                                          30000 = 83 %
//        up to 15 % over the maximum       "Slightly above"  (fit 87 % and up)
//        more than 15 % over               "Above budget"
//   no maximum (a "₹14L+" job)             nothing to be above: 100 %
//
//   HIKE % = (expected - current) / current x 100. A fresher (current = 0) has
//   no hike (shown as "Fresher").
//
// Everything below is pure (no database), so the rules can be tested as a table.
// ---------------------------------------------------------------------------

const LAKH = 100000;
const round = (n, d = 0) => { const f = 10 ** d; return Math.round(n * f) / f; };

// ---- reading an amount ----------------------------------------------------------
const FRESHER = /^(fresher|freshers|fresh|nil|nill|nil\.|zero|none|no salary|not working|unemployed|0|0\.0+)$/;
const MONTH_RE = /(per\s*month|a\s*month|\/\s*(?:m|mo|mon|month)\b|\bp\.?\s?m\b|\bpm\b|monthly|\blpm\b|per\s*mon\b)/;
const YEAR_RE = /(per\s*(?:annum|year|yr|anum)|\/\s*(?:y|yr|year|annum|a)\b|\bp\.?\s?a\b|\bpa\b|annual|yearly|\blpa\b|\bctc\b|per\s*yr|a\s*year)/;
// "4.5", "4.5l", "4.5 lpa", "45k", "45,000", "1.2 cr", "3 lakhs"
const NUM_RE = /(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|lpa|lpm|l\b|crores?|cr\b|thousand|k\b)?/g;
const MAGNITUDE = (u) => {
  if (!u) return null;
  if (/^(lakhs?|lacs?|lpa|lpm|l)$/.test(u)) return LAKH;
  if (/^(crores?|cr)$/.test(u)) return 100 * LAKH;
  if (/^(thousand|k)$/.test(u)) return 1000;
  return null;
};

const parseCache = new Map();

// opts.unit: 'year' | 'month' - the default for an amount that says nothing
// about its own period (the toggle next to the box / the job's salary type).
// opts.force: the unit wins even over an "L" figure (a Monthly job's band).
// Returns { ok, blank, fresher, lpa, annual, unit, assumed, range, reason }
//   ok       a usable amount was read
//   lpa      the YEARLY amount in lakhs (4.5)   (a range gives its higher end)
//   annual   the same in rupees
//   unit     'year' | 'month' - the period the person WROTE
//   assumed  the period was guessed from the size of the number, not written
//   range    { lo, hi } in LPA when two amounts were written
//   reason   'blank' | 'unclear' | 'no_unit' (bare small number with a month toggle)
function parseAmount(raw, opts = {}) {
  const key = `${opts.unit || ''}${opts.force ? '!' : ''}|${raw}`;
  if (parseCache.has(key)) return parseCache.get(key);
  const out = parseAmountUncached(raw, opts);
  if (parseCache.size > 20000) parseCache.clear();
  parseCache.set(key, out);
  return out;
}

function parseAmountUncached(raw, opts) {
  if (raw === undefined || raw === null) return { ok: false, blank: true, reason: 'blank' };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { ok: false, blank: false, reason: 'unclear' };
    return parseAmountUncached(String(raw), opts);
  }
  const text = String(raw).toLowerCase().replace(/[₹]|\brs\.?|\binr\b|\brupees?\b|\/-/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return { ok: false, blank: true, reason: 'blank' };
  const compact = text.replace(/[\s.]+$/, '');
  if (FRESHER.test(compact)) return { ok: true, fresher: true, lpa: 0, annual: 0, unit: 'year', assumed: false };
  // Indian digit grouping: 1,50,000 -> 150000 (a comma between digits only).
  const flat = text.replace(/(\d),(?=\d)/g, '$1');
  const nums = [];
  let m;
  NUM_RE.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = NUM_RE.exec(flat)) && nums.length < 2) nums.push({ n: Number(m[1]), mag: MAGNITUDE(m[2]), word: m[2] || '' });
  if (!nums.length || nums.some((x) => !Number.isFinite(x.n))) return { ok: false, blank: false, reason: 'unclear' };
  // "35-40k": the first number takes the unit of the last one.
  if (nums.length === 2 && nums[0].mag === null && nums[1].mag !== null) { nums[0].mag = nums[1].mag; nums[0].word = nums[1].word; }

  const saysMonth = MONTH_RE.test(flat) || nums.some((x) => x.word === 'lpm');
  const saysYear = !saysMonth && YEAR_RE.test(flat);
  const last = nums[nums.length - 1];

  // the period of the amount
  let unit; let assumed = false;
  if (saysMonth) unit = 'month';
  else if (saysYear) unit = 'year';
  else if (opts.force && (opts.unit === 'month' || opts.unit === 'year')) unit = opts.unit; // a Monthly job: its figures are monthly
  else if (last.mag === LAKH * 100) unit = 'year';
  else if (last.mag === LAKH) unit = 'year'; // "4.5 L" is a yearly figure in this app
  else if (opts.unit === 'month' || opts.unit === 'year') unit = opts.unit;
  else if (last.mag === 1000) { unit = last.n < 100 ? 'month' : 'year'; assumed = true; } // "45k" a month, "450k" a year
  else {
    // bare number, nothing said: look at its size
    const v = last.n;
    if (v < 1000) { unit = 'year'; assumed = true; } // 4.5 -> 4.5 LPA
    else if (v < 100000) { unit = 'month'; assumed = true; } // 45000 -> a month
    else { unit = 'year'; assumed = true; } // 650000 -> a year
  }

  const rupeesOf = (x) => {
    let mag = x.mag;
    if (mag === null) {
      if (x.n < 1000) {
        // a small bare number: lakhs for a year, but for a month toggle it is not clear (45 a month?)
        if (unit === 'month') return null;
        mag = LAKH;
      } else mag = 1;
    }
    return x.n * mag;
  };
  const parts = nums.map(rupeesOf);
  if (parts.some((p) => p === null)) return { ok: false, blank: false, reason: 'no_unit' };
  const yearlyOf = (rupees) => (unit === 'month' ? rupees * 12 : rupees);
  const annualParts = parts.map(yearlyOf);
  const hi = Math.max(...annualParts);
  const lo = Math.min(...annualParts);
  const res = {
    ok: true, fresher: hi === 0, lpa: round(hi / LAKH, 3), annual: Math.round(hi), unit, assumed,
  };
  if (annualParts.length === 2 && lo !== hi) res.range = { lo: round(lo / LAKH, 3), hi: round(hi / LAKH, 3) };
  return res;
}

// "4.5 LPA" - what a new candidate salary is stored as.
function fmtLpa(lpa) {
  if (!Number.isFinite(Number(lpa))) return '';
  return `${String(round(Number(lpa), 3))} LPA`;
}
// "₹4.5L a year"  /  "Fresher (0)"
function plainLpa(lpa, { fresher = false } = {}) {
  if (!Number.isFinite(Number(lpa))) return '';
  if (Number(lpa) === 0) return fresher ? 'Fresher (0)' : '0';
  return `₹${round(Number(lpa), 2)}L a year`;
}
const rupeeStr = (n) => `₹${Math.round(n).toLocaleString('en-IN')}`;
// "₹5.4L a year (₹45,000 a month)"
function plainBoth(lpa) {
  if (!Number.isFinite(Number(lpa)) || Number(lpa) === 0) return plainLpa(lpa, { fresher: true });
  return `${plainLpa(lpa)} (${rupeeStr((Number(lpa) * LAKH) / 12)} a month)`;
}

// ---- validating what a person typed --------------------------------------------
const TOO_HIGH_LPA = 1000; // Rs 10 crore a year: a slip of the finger
const MSG = {
  currentBlank: 'Please enter current salary (0 if fresher).',
  expectedBlank: 'Please enter expected salary.',
  currentUnclear: 'Current salary is not clear. Write it like 4.5 LPA or 45000 per month (0 if fresher).',
  expectedUnclear: 'Expected salary is not clear. Write it like 6 LPA or 50000 per month.',
  currentNoUnit: 'Current salary: write the amount in rupees, like 45000 per month, or in lakhs, like 4.5 LPA.',
  expectedNoUnit: 'Expected salary: write the amount in rupees, like 50000 per month, or in lakhs, like 6 LPA.',
  currentRange: 'Current salary: please write one amount, not a range (for example 4.5 LPA).',
  expectedRange: 'Expected salary: please write one amount, not a range (for example 6 LPA).',
  expectedZero: 'Expected salary cannot be 0. Please enter the amount the person wants.',
  currentHigh: 'Current salary looks too big. Please check it (lakhs per year, for example 4.5 LPA).',
  expectedHigh: 'Expected salary looks too big. Please check it (lakhs per year, for example 6 LPA).',
};

// Soft warnings: told to the person, never block.
function sanity(currentLpa, expectedLpa) {
  const w = [];
  const cur = Number.isFinite(currentLpa) ? currentLpa : null;
  const exp = Number.isFinite(expectedLpa) ? expectedLpa : null;
  if (exp !== null && exp > 0 && exp < 1) w.push('Expected salary is under 1 LPA. Is this a monthly amount? Tick "per month" if so.');
  if (exp !== null && exp > 100) w.push('Expected salary is over 100 LPA (1 crore a year). Please double-check it.');
  if (cur !== null && cur > 100) w.push('Current salary is over 100 LPA (1 crore a year). Please double-check it.');
  if (cur !== null && cur > 0 && exp !== null && exp > 0) {
    if (exp < cur * 0.7) w.push(`Expected pay (${round(exp, 2)} LPA) is much lower than current pay (${round(cur, 2)} LPA). Is that right?`);
    if (exp > cur * 10) w.push(`Expected pay is more than 10 times the current pay (${round(cur, 2)} LPA). Is that right?`);
  }
  return w;
}

// One field. kind: 'current' | 'expected'. Returns { value, lpa, error, parsed }.
function checkOne(kind, raw, unit) {
  const cur = kind === 'current';
  const p = parseAmount(raw, { unit });
  if (p.blank) return { error: cur ? MSG.currentBlank : MSG.expectedBlank, parsed: p };
  if (!p.ok) return { error: p.reason === 'no_unit' ? (cur ? MSG.currentNoUnit : MSG.expectedNoUnit) : (cur ? MSG.currentUnclear : MSG.expectedUnclear), parsed: p };
  if (p.range) return { error: cur ? MSG.currentRange : MSG.expectedRange, parsed: p };
  if (!cur && p.lpa === 0) return { error: MSG.expectedZero, parsed: p };
  if (p.lpa > TOO_HIGH_LPA) return { error: cur ? MSG.currentHigh : MSG.expectedHigh, parsed: p };
  return { value: fmtLpa(p.lpa), lpa: p.lpa, parsed: p };
}

// body: { currentSalary, expectedSalary, currentSalaryUnit?, expectedSalaryUnit? }
// -> { ok, errors: { currentSalary?, expectedSalary? }, message, values: { currentSalary, expectedSalary }, warnings: [] }
function validateSalaries(body = {}) {
  const c = checkOne('current', body.currentSalary, body.currentSalaryUnit);
  const e = checkOne('expected', body.expectedSalary, body.expectedSalaryUnit);
  const errors = {};
  if (c.error) errors.currentSalary = c.error;
  if (e.error) errors.expectedSalary = e.error;
  const ok = !c.error && !e.error;
  return {
    ok,
    errors,
    message: errors.currentSalary || errors.expectedSalary || null,
    values: { currentSalary: c.value || null, expectedSalary: e.value || null },
    warnings: ok ? sanity(c.lpa, e.lpa) : [],
    currentLpa: c.lpa ?? null,
    expectedLpa: e.lpa ?? null,
  };
}

// For an EDIT of an existing candidate: blank stays blank when it was blank
// before (never blocks the old records); a value that is written must be
// readable; a value that existed cannot be wiped out.
function checkEdit(body, existing) {
  const errors = {};
  const values = {};
  const lpas = {};
  [['currentSalary', 'current', 'currentSalaryUnit'], ['expectedSalary', 'expected', 'expectedSalaryUnit']].forEach(([field, kind, unitKey]) => {
    if (body[field] === undefined) return;
    const was = existing ? existing[field] : null;
    const blankNow = !String(body[field] === null ? '' : body[field]).trim();
    if (blankNow) {
      if (was && String(was).trim()) errors[field] = kind === 'current' ? MSG.currentBlank : MSG.expectedBlank;
      return; // stayed blank: leave the field untouched
    }
    // the edit form sends the stored text back unchanged: an untouched value is not re-validated or rewritten
    if (was !== undefined && was !== null && String(body[field]).trim() === String(was).trim()) return;
    const r = checkOne(kind, body[field], body[unitKey]);
    if (r.error) errors[field] = r.error; else { values[field] = r.value; lpas[field] = r.lpa; }
  });
  const curL = lpas.currentSalary ?? parseAmount(existing && existing.currentSalary).lpa;
  const expL = lpas.expectedSalary ?? parseAmount(existing && existing.expectedSalary).lpa;
  return {
    ok: !Object.keys(errors).length,
    errors,
    message: errors.currentSalary || errors.expectedSalary || null,
    values,
    warnings: Object.keys(values).length && !Object.keys(errors).length ? sanity(curL, expL) : [],
  };
}

// ---- the job's budget -----------------------------------------------------------
// Requirement.salary = "₹14L - ₹20L" | "₹14L+" | "up to ₹15L" | "—" | "9-9 LPA" | "25k-30k".
// -> { state: 'set' | 'none' | 'unusable', min, max (LPA, either may be null), text }
function budgetOf(requirement) {
  const raw = requirement && requirement.salary != null ? String(requirement.salary).trim() : '';
  if (!raw || /^[-–—\s]+$/.test(raw) || !/\d/.test(raw)) return { state: 'none', min: null, max: null, text: '' };
  const type = String((requirement && requirement.salaryType) || '').toLowerCase();
  if (type.startsWith('hour')) return { state: 'unusable', min: null, max: null, text: raw, why: 'The job pays by the hour.' };
  const monthly = type.startsWith('month');
  const popts = monthly ? { unit: 'month', force: true } : {}; // an Annual job's bare number is lakhs; "25k" is read as a month
  const lower = raw.toLowerCase();
  let min = null; let max = null;
  if (/up\s*to|upto|max(?:imum)?|not more than|below|under/.test(lower)) {
    const p = parseAmount(lower.replace(/up\s*to|upto|maximum|max|not more than|below|under/g, ' '), popts);
    if (p.ok) max = p.range ? p.range.hi : p.lpa;
  } else if (/\+\s*$|and above|or more|minimum|min\b|above/.test(lower)) {
    const p = parseAmount(lower.replace(/and above|or more|minimum|min\b|above/g, ' '), popts);
    if (p.ok) min = p.range ? p.range.lo : p.lpa;
  } else {
    const p = parseAmount(lower, popts);
    if (p.ok && p.range) { min = p.range.lo; max = p.range.hi; } else if (p.ok && !p.fresher) {
      max = p.lpa;
      min = /\d\s*(?:-|–|—|to)\s*\d/.test(lower) ? p.lpa : null; // "9-9 LPA" = exactly 9
    }
  }
  if (min === null && max === null) return { state: 'none', min: null, max: null, text: raw };
  if (min !== null && max !== null && min > max) { const t = min; min = max; max = t; }
  return { state: 'set', min, max, text: raw === '—' ? '' : raw };
}

// ---- the fit --------------------------------------------------------------------
const SLIGHT = 0.15; // up to 15 % over the maximum is "Slightly above"
const BANDS = {
  within: { label: 'Within budget', tone: 'green', icon: '✓' },
  slightly: { label: 'Slightly above', tone: 'amber', icon: '▲' },
  above: { label: 'Above budget', tone: 'red', icon: '⚠' },
};
// The Filters list: key -> plain label.
const FILTER_LABELS = {
  within: 'Within budget', slightly: 'Slightly above', above: 'Above budget', missing: 'Salary missing', nobudget: 'Client budget not set',
};

// expected / current / budget in LPA numbers (null when unknown).
function fitMath(expected, current, budget) {
  const res = {
    state: 'ok', band: null, pct: null, belowRange: false, hikePct: null, fresher: current === 0,
  };
  if (current !== null && current > 0 && expected !== null) res.hikePct = round(((expected - current) / current) * 100);
  if (expected === null) { res.state = 'no-salary'; return res; }
  if (!budget || budget.state !== 'set') { res.state = 'no-budget'; return res; }
  const { min, max } = budget;
  if (max === null || expected <= max) {
    res.band = 'within'; res.pct = 100;
    if (min !== null && expected < min) res.belowRange = true;
  } else {
    res.pct = Math.floor((max / expected) * 100);
    res.band = expected <= max * (1 + SLIGHT) ? 'slightly' : 'above';
  }
  return res;
}

// Which filter buckets a fit falls into (a row can sit in more than one).
function filterKeysOf(f) {
  if (!f) return [];
  const k = [];
  if (f.band) k.push(f.band);
  if (f.missing) k.push('missing');
  if (f.state === 'no-budget') k.push('nobudget');
  return k;
}

// The whole thing for ONE candidate on ONE job, shaped for a viewer.
//   viewer.numbers  true: the candidate's figures + hike % may be shown
//   viewer.bucket   true: the % is rounded to the nearest 10 (BDE team)
// A caller that must show nothing at all (client / candidate logins) does not call this.
function fitFor(candidate, requirement, viewer = { numbers: true, bucket: false }) {
  const e = parseAmount(candidate && candidate.expectedSalary);
  const c = parseAmount(candidate && candidate.currentSalary);
  const expected = e.ok && !e.fresher ? e.lpa : null;
  const current = c.ok ? c.lpa : null;
  const budget = budgetOf(requirement);
  const m = fitMath(expected, current, budget);
  const out = { state: m.state };
  // Salary missing = either of the two cannot be read (a "Fresher" current salary counts as given).
  if (expected === null && current === null) out.missing = 'both';
  else if (expected === null) out.missing = 'expected';
  else if (current === null) out.missing = 'current';
  out.prompt = out.missing ? (viewer.numbers ? 'Add salary' : 'Ask the recruiter to add the salary') : null;
  if (m.state === 'no-salary') {
    out.label = 'Salary missing';
    out.tone = 'grey';
    out.icon = '+';
    out.budgetText = budget.state === 'set' ? budget.text : null;
    out.keys = filterKeysOf(out);
    return out;
  }
  if (m.state === 'no-budget') {
    out.label = 'Client budget not set';
    out.budgetPrompt = 'Ask the client manager (BDE) to add the job budget';
    out.tone = 'grey';
    out.icon = '–';
    out.budgetText = null;
    if (viewer.numbers) { out.expectedSalary = expected; out.currentSalary = current; out.salaryHikePct = m.hikePct; out.fresher = m.fresher; }
    out.keys = filterKeysOf(out);
    return out;
  }
  const b = BANDS[m.band];
  out.band = m.band;
  out.label = b.label;
  out.tone = b.tone;
  out.icon = b.icon;
  out.pct = viewer.bucket ? Math.round(m.pct / 10) * 10 : m.pct;
  if (viewer.bucket) out.approx = true;
  out.belowRange = m.belowRange;
  out.budgetText = budget.text;
  if (viewer.numbers) {
    out.expectedSalary = expected; // LPA numbers: removed again by clientRedact for any login without the switch
    out.currentSalary = current;
    out.salaryHikePct = m.hikePct;
    out.fresher = m.fresher;
    if (m.hikePct === null) out.hikeLabel = m.fresher ? 'Fresher' : 'No current salary';
    else out.hikeLabel = `${m.hikePct >= 0 ? '+' : '−'}${Math.abs(m.hikePct)}% hike`;
  }
  out.keys = filterKeysOf(out);
  return out;
}

// The shape of one explained sentence for the tooltip.
function explain(f) {
  if (!f) return '';
  if (f.state === 'no-salary') return 'This person\'s expected salary is not saved yet.';
  if (f.state === 'no-budget') return 'The job has no budget (salary range) from the client yet.';
  if (f.band === 'within') return f.belowRange ? 'Wants less than the client\'s minimum: within budget (below range).' : 'Wants pay inside the client\'s budget: 100%.';
  return `Wants more than the client's maximum: fit is the budget maximum divided by what the person wants (${f.pct}%).`;
}

// For feeds we do not control (job portal, imports): a readable amount becomes "4.5 LPA"; an unreadable or blank one is
// returned as null (NEVER invented) so the record shows "Salary missing" and the Submit step asks for it.
function normaliseLoose(raw, unit) {
  const p = parseAmount(raw, { unit });
  if (!p.ok || p.lpa > TOO_HIGH_LPA) return null;
  return fmtLpa(p.lpa);
}

// Salary missing: which of the two cannot be read. 'both' | 'current' | 'expected' | null.
function missingOf(candidate) {
  const e = parseAmount(candidate && candidate.expectedSalary);
  const c = parseAmount(candidate && candidate.currentSalary);
  const eOk = e.ok && !e.fresher; // an expected pay of 0 / Fresher is not a real expectation
  if (!eOk && !c.ok) return 'both';
  if (!eOk) return 'expected';
  if (!c.ok) return 'current';
  return null;
}

// Who sees what. privacy = clientRedact.privacyFlagsFor(user): null | { bde, contact }.
// External logins (client / candidate / partner / vendor) get NOTHING: the caller passes kind.
function viewerFor(privacy) {
  if (privacy && (privacy.bde || privacy.contact)) return { numbers: false, bucket: true };
  return { numbers: true, bucket: false };
}

export { parseAmount, fmtLpa, plainLpa, plainBoth, validateSalaries, checkEdit, checkOne, sanity, budgetOf, fitMath, fitFor, missingOf, normaliseLoose, filterKeysOf, explain, viewerFor,
  BANDS, FILTER_LABELS, MSG, LAKH, SLIGHT, };
