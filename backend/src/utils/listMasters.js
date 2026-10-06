// ---------------------------------------------------------------------------
// THE SIMPLE MASTER LISTS (spec 2026-10-03 §18): Sources, Reject reasons,
// Priorities, Locations — kept by an Admin in Administration -> Master lists.
//
// These values are stored as plain words on the records (Candidate.source,
// ApplicationStageEvent.reasonCategory, Requirement.priority, .location), so
// the list here only decides what the DROPDOWNS offer. It lives in one
// AppSetting row (key "masterLists"); until an Admin saves a change, the
// app's built-in lists (frontend atsVocab.js) are the list, so nothing moves.
//
// The rules (the user's): add, rename, switch off — NOTHING IN USE IS EVER
// DELETED, and a word already saved on records is not renamed either (the old
// records would keep the old word and the counts would split). Such a value
// can only be switched off; a new word is added instead. A few values the
// app's own rules depend on are LOCKED (the four priorities, "Other").
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'masterLists';
const SIDES = ['Client', 'Internal', 'Candidate'];

// The built-in lists — the same words the screens offer today
// (frontend/src/atsVocab.js CANDIDATE_SOURCES ∪ CANDIDATE_FILTER_SOURCES,
// REJECTION_REASONS_BY_SIDE, PRIORITIES, LOCS).
const DEFAULT_SOURCES = [
  'Direct', 'Referral', 'Job Portal', 'Naukri', 'Indeed', 'Shine', 'LinkedIn', 'TeamLink Website', 'Social Media',
];
const DEFAULT_REASONS_BY_SIDE = {
  Client: [
    'Skills Mismatch', 'Insufficient Experience', 'Interview Performance', 'Communication',
    'Salary Expectation', 'Location / Relocation', 'Notice Period', 'Culture Fit',
    'Not Shortlisted', 'Not Selected', 'Position Filled', 'Position Closed', 'Other',
  ],
  Internal: [
    'Profile Not Matching', 'Skills Mismatch', 'Insufficient Experience', 'Communication',
    'Salary Expectation', 'Location / Relocation', 'Notice Period', 'Culture Fit',
    'Not Eligible', 'Failed Screening', 'Low AI Interview Score',
    'Duplicate Profile', 'Background / Documentation', 'Other',
  ],
  Candidate: [
    'Not Interested', 'Did Not Attend Interview', 'Offer Declined', 'Did Not Join',
    'Accepted Another Offer', 'Salary Expectation', 'Notice Period', 'Location / Relocation',
    'Not Reachable', 'Other',
  ],
};
const DEFAULT_PRIORITIES = ['Low', 'Medium', 'High', 'Urgent'];
const DEFAULT_LOCATIONS = ['Hyderabad', 'Bengaluru', 'Pune'];

const LOCKED = {
  priorities: new Set(DEFAULT_PRIORITIES.map((x) => x.toLowerCase())),
  rejectReasons: new Set(['other']),
  sources: new Set(),
  locations: new Set(),
};
const LISTS = ['sources', 'rejectReasons', 'priorities', 'locations'];

const clean = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
const k = (v) => clean(v).toLowerCase();

function defaults() {
  const reasons = new Map();
  SIDES.forEach((side) => DEFAULT_REASONS_BY_SIDE[side].forEach((name) => {
    if (!reasons.has(k(name))) reasons.set(k(name), { name, active: true, sides: [] });
    reasons.get(k(name)).sides.push(side);
  }));
  return {
    sources: DEFAULT_SOURCES.map((name) => ({ name, active: true })),
    rejectReasons: [...reasons.values()],
    priorities: DEFAULT_PRIORITIES.map((name) => ({ name, active: true })),
    locations: DEFAULT_LOCATIONS.map((name) => ({ name, active: true })),
  };
}

let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000; // a change made elsewhere (another process) shows within a minute
async function load() {
  if (cache && Date.now() - cacheAt < CACHE_MS) return cache;
  const base = defaults();
  let saved = null;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: KEY } });
    saved = row ? JSON.parse(row.value) : null;
  } catch { saved = null; }
  const out = {};
  LISTS.forEach((l) => {
    const list = saved && Array.isArray(saved[l]) ? saved[l] : base[l];
    out[l] = list.filter((x) => x && clean(x.name)).map((x) => ({
      name: clean(x.name),
      active: x.active !== false,
      ...(l === 'rejectReasons' ? { sides: (Array.isArray(x.sides) ? x.sides : SIDES).filter((s) => SIDES.includes(s)) } : {}),
    }));
  });
  out.savedAt = saved ? saved.savedAt || null : null;
  cache = out;
  cacheAt = Date.now();
  return out;
}

async function save(lists, user) {
  const value = { ...lists, savedAt: new Date().toISOString() };
  delete value.version;
  await prisma.appSetting.upsert({
    where: { key: KEY },
    create: { key: KEY, value: JSON.stringify(value), updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
    update: { value: JSON.stringify(value), updatedById: user ? user.id : null, updatedByName: user ? user.name : null },
  });
  cache = null;
  return load();
}

// What the dropdowns read: active values only.
async function publicLists() {
  const m = await load();
  const on = (l) => m[l].filter((x) => x.active).map((x) => x.name);
  const bySide = {};
  SIDES.forEach((s) => { bySide[s] = m.rejectReasons.filter((x) => x.active && x.sides.includes(s)).map((x) => x.name); });
  return {
    sources: on('sources'),
    priorities: on('priorities'),
    locations: on('locations'),
    rejectReasons: on('rejectReasons'),
    rejectReasonsBySide: bySide,
    version: m.savedAt || 'default',
  };
}

// How many records carry each word (case-insensitive), so the screen can say
// "Used by 312" and refuse a rename / removal.
async function usage(list) {
  const counts = new Map();
  const add = (rows, field) => rows.forEach((r) => {
    const v = k(r[field]);
    if (v) counts.set(v, (counts.get(v) || 0) + r._count._all);
  });
  if (list === 'sources') {
    add(await prisma.candidate.groupBy({ by: ['source'], _count: { _all: true } }), 'source');
    add(await prisma.application.groupBy({ by: ['source'], _count: { _all: true } }), 'source');
  } else if (list === 'rejectReasons') {
    add(await prisma.applicationStageEvent.groupBy({ by: ['reasonCategory'], where: { reasonCategory: { not: null } }, _count: { _all: true } }), 'reasonCategory');
  } else if (list === 'priorities') {
    add(await prisma.requirement.groupBy({ by: ['priority'], _count: { _all: true } }), 'priority');
  } else if (list === 'locations') {
    add(await prisma.requirement.groupBy({ by: ['location'], _count: { _all: true } }), 'location');
    add(await prisma.candidate.groupBy({ by: ['location'], _count: { _all: true } }), 'location');
  }
  return counts;
}

async function adminLists() {
  const m = await load();
  const out = { savedAt: m.savedAt };
  // eslint-disable-next-line no-restricted-syntax
  for (const l of LISTS) {
    // eslint-disable-next-line no-await-in-loop
    const used = await usage(l);
    out[l] = m[l].map((x) => ({ ...x, used: used.get(k(x.name)) || 0, locked: LOCKED[l].has(k(x.name)) }));
  }
  return out;
}

const bad = (status, message) => Object.assign(new Error(message), { status });

// One change at a time: { action: 'add' | 'rename' | 'off' | 'on' | 'remove' | 'sides', name, newName, sides }
async function change(list, body, user) {
  if (!LISTS.includes(list)) throw bad(404, 'No such list.');
  const m = await load();
  const items = m[list].map((x) => ({ ...x }));
  const name = clean(body.name);
  const idx = items.findIndex((x) => k(x.name) === k(name));
  const action = String(body.action || '');
  const locked = LOCKED[list].has(k(name));
  if (action === 'add') {
    if (!name) throw bad(400, 'Type a name first.');
    if (name.length > 60) throw bad(400, 'Keep it short — 60 letters at most.');
    if (idx >= 0) {
      if (items[idx].active) throw bad(409, `"${items[idx].name}" is already on the list.`);
      items[idx].active = true; // adding a switched-off word switches it back on
    } else {
      items.push({ name, active: true, ...(list === 'rejectReasons' ? { sides: cleanSides(body.sides) } : {}) });
    }
  } else {
    if (idx < 0) throw bad(404, `"${name}" is not on the list.`);
    const used = (await usage(list)).get(k(name)) || 0;
    if (action === 'rename') {
      const to = clean(body.newName);
      if (!to) throw bad(400, 'Type the new name.');
      if (locked) throw bad(409, `"${name}" is fixed — the app's own rules use it.`);
      if (used) throw bad(409, `"${name}" is already used by ${used.toLocaleString('en-IN')} record(s), so it can't be renamed. Switch it off and add "${to}" instead.`);
      if (items.some((x, i) => i !== idx && k(x.name) === k(to))) throw bad(409, `"${to}" is already on the list.`);
      items[idx].name = to;
    } else if (action === 'off' || action === 'on') {
      if (locked && action === 'off') throw bad(409, `"${name}" is fixed — the app's own rules use it.`);
      if (action === 'off' && items.filter((x) => x.active).length <= 1) throw bad(409, 'Keep at least one value switched on.');
      items[idx].active = action === 'on';
    } else if (action === 'remove') {
      if (locked) throw bad(409, `"${name}" is fixed — the app's own rules use it.`);
      if (used) throw bad(409, `"${name}" is used by ${used.toLocaleString('en-IN')} record(s) — it can only be switched off, never removed.`);
      items.splice(idx, 1);
    } else if (action === 'sides') {
      if (list !== 'rejectReasons') throw bad(400, 'Only reject reasons have sides.');
      const sides = cleanSides(body.sides);
      if (!sides.length) throw bad(400, 'Pick at least one: Client, Our team or Candidate.');
      items[idx].sides = sides;
    } else {
      throw bad(400, 'Unknown change.');
    }
  }
  const next = {};
  LISTS.forEach((l) => { next[l] = l === list ? items : m[l]; });
  await save(next, user);
  return { list, action, name, newName: clean(body.newName) || null };
}
function cleanSides(v) {
  const list = Array.isArray(v) ? v : SIDES;
  const out = SIDES.filter((s) => list.includes(s));
  return out.length ? out : SIDES;
}

module.exports = {
  KEY, LISTS, SIDES, load, publicLists, adminLists, change, defaults,
  invalidate: () => { cache = null; },
};
