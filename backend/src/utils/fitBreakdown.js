// ---------------------------------------------------------------------------
// THE FIT BREAKDOWN — "Fit 82% = Resume 90 · AI 80 · Location 100 · Salary 60".
//
// One place turns the numbers of utils/matching.js computeMatch() into the four
// small labelled chips every screen shows (candidate list / board / profile /
// Matching candidates / job list), and decides WHO may see how much:
//
//   full        recruiter, TL, STL, Manager, Assistant Manager, Admin, Super Admin:
//               the total, the four chips with their numbers and what each counted for.
//               The Salary chip is a FIT % (100 = inside the budget), never rupees.
//   restricted  the BDE team (BDE, BDE TL) and any login without the "Candidate
//               contact & salary" switch: only the total ROUNDED to the nearest 10,
//               a label (Great / Good / Partial / Weak fit) and one Salary chip that
//               is only a WORD: Within budget / Slightly above / Above budget / Not
//               known. No per-part numbers, no AI score, no rupees, no reasons.
//   nothing     client and candidate logins never reach these endpoints (internal
//               only); an external login is given no breakdown by the callers.
//
// Pure functions (no database). The words are the app's everyday ones (Fit, Job).
// ---------------------------------------------------------------------------
const LABELS = {
  resume: 'Resume', ai: 'AI', location: 'Location', salary: 'Salary',
};
const ICONS = {
  resume: '📄', ai: '🤖', location: '📍', salary: '₹',
};
// What each part means, one line (the ? tooltip).
const HELP = {
  resume: 'How well the skills, experience and education fit the requirement (read from the resume when there is one).',
  ai: "The person's AI interview score. It is counted in the Fit only if Admin gives it points in Fit settings.",
  location: 'Same city is 100. A nearby or preferred city is a little less.',
  salary: "How the pay the person wants fits the client's budget: 100 = inside the budget.",
};

const fitLabel = (n) => {
  if (n == null) return null;
  if (n >= 85) return 'Great fit';
  if (n >= 70) return 'Good fit';
  if (n >= 50) return 'Partial fit';
  return 'Weak fit';
};
const round10 = (n) => Math.max(0, Math.min(100, Math.round(Number(n) / 10) * 10));
const toneOf = (pct) => {
  if (pct == null) return 'grey';
  if (pct >= 70) return 'green';
  if (pct >= 50) return 'yellow';
  return 'red';
};
const SAL_TONE = { within: 'green', slightly: 'yellow', above: 'red' };

// Restricted login: the word only.
function salaryWord(m) {
  return m && m.salKnown ? m.salWord : 'Not known';
}

// The full breakdown for a viewer who may see the numbers.
function fullBreakdown(m) {
  const sh = m.shares || {};
  const aiHas = m.aiPct != null;
  const chips = [
    {
      key: 'resume', label: LABELS.resume, icon: ICONS.resume, pct: m.resumePct, tone: toneOf(m.resumePct), share: sh.resume ?? null, counted: true, help: HELP.resume,
    },
    {
      key: 'ai', label: LABELS.ai, icon: ICONS.ai, pct: aiHas ? m.aiPct : null, tone: toneOf(aiHas ? m.aiPct : null), share: sh.ai ?? 0, counted: !!m.aiCounted,
      word: aiHas ? (m.aiCounted ? null : 'Not counted') : 'No interview yet', help: HELP.ai,
    },
    {
      key: 'location', label: LABELS.location, icon: ICONS.location, pct: m.locPct != null ? m.locPct : m.locationPct, tone: toneOf(m.locPct != null ? m.locPct : m.locationPct), share: sh.location ?? null, counted: true, help: HELP.location,
    },
    {
      key: 'salary', label: LABELS.salary, icon: ICONS.salary, pct: m.salKnown ? m.salPct : null, tone: m.salKnown ? (SAL_TONE[m.salBand] || toneOf(m.salPct)) : 'grey', share: sh.salary ?? 0, counted: !!m.salKnown,
      word: m.salKnown ? m.salWord : 'Not known', why: m.salKnown ? null : m.salWhy, help: HELP.salary,
    },
  ];
  const parts = [`Resume ${m.resumePct}`];
  if (m.aiCounted) parts.push(`AI ${m.aiPct}`);
  parts.push(`Location ${m.locPct != null ? m.locPct : m.locationPct}`);
  parts.push(m.salKnown ? `Salary ${m.salPct}` : 'Salary: not known');
  return {
    restricted: false,
    total: m.overall,
    label: fitLabel(m.overall),
    text: `Fit ${m.overall}% = ${parts.join(' · ')}`,
    salaryKnown: !!m.salKnown,
    // Said once in plain words when a part was left out.
    note: m.salKnown ? null : 'Salary is not known, so it is left out and the other parts count a little more. This person is not marked down for it.',
    chips,
    shares: { resume: sh.resume ?? 0, ai: sh.ai ?? 0, location: sh.location ?? 0, salary: sh.salary ?? 0, other: sh.other ?? 0 },
  };
}

// The BDE team's version: rounded total + label + the Salary WORD. Nothing else.
function restrictedBreakdown(m) {
  const t = round10(m.overall);
  const word = salaryWord(m);
  return {
    restricted: true,
    approx: true,
    total: t,
    label: fitLabel(t),
    text: `Fit about ${t}% · Salary: ${word}`,
    salaryKnown: !!m.salKnown,
    chips: [{
      key: 'salary', label: LABELS.salary, icon: ICONS.salary, word, tone: m.salKnown ? (SAL_TONE[m.salBand] || 'grey') : 'grey', help: HELP.salary,
    }],
  };
}

const breakdownOf = (m, restricted) => (restricted ? restrictedBreakdown(m) : fullBreakdown(m));

// Is this login a "restricted" viewer? (BDE / BDE TL / no Candidate contact & salary switch.)
// Same rule as salaryFit.viewerFor + clientRedact.privacyFlagsFor — one answer, here.
function isRestricted(user) {
  if (!user) return true; // when in doubt, show less
  // eslint-disable-next-line global-require
  const flags = require('./clientRedact').privacyFlagsFor(user);
  return !!(flags && (flags.bde || flags.contact));
}

// A computeMatch() / threeNumbers() object for a viewer: the full match plus .breakdown, or for a
// restricted viewer a tiny object (no parts, no reasons, no AI, no rupees).
function shapeMatch(m, restricted) {
  if (!m) return m;
  const breakdown = breakdownOf(m, restricted);
  if (!restricted) return { ...m, breakdown };
  return {
    overall: breakdown.total,
    approx: true,
    label: breakdown.label,
    eligible: m.eligible === undefined ? undefined : m.eligible,
    reason: m.reason,
    minFit: m.minFit,
    breakdown,
  };
}

// Salary buckets of a list of matches, for the filter chips: { within, slightly, above, unknown }.
function salaryCounts(matches) {
  const c = {
    within: 0, slightly: 0, above: 0, unknown: 0,
  };
  matches.forEach((m) => {
    if (!m || !m.salKnown) c.unknown += 1;
    else c[m.salBand] += 1;
  });
  return c;
}

module.exports = {
  LABELS, ICONS, HELP, fitLabel, round10, toneOf, salaryWord, breakdownOf, fullBreakdown, restrictedBreakdown, isRestricted, shapeMatch, salaryCounts,
};
