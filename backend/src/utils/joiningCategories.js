// ---------------------------------------------------------------------------
// JOINING CATEGORIES (founder 2026-11-14): "these are the Medical team's targets and incentives - record them for the Medical
// department and calculate the target closing and the incentives."
//
// The Medical team's monthly count, by category (15 joinings in all):
//   MD/MS Doctors  Full Time 1 · Part Time 2        MD/MS Faculty  Full Time 1 · Part Time 4
//   MBBS Doctors   Full Time 3                      Staff Nurses   4
//
// THERE IS NO SECOND JOINING COUNT. A joining is exactly the one utils/recruiterJoinings.js counts (ATS, step Joined, joining day in the
// month, credited to whoever got the candidate Selected). This file only decides WHICH CATEGORY a counted joining belongs to, and adds
// the joinings of each category up against the target of that category.
//
// WHAT TELLS THE CATEGORY APART (checked on the data, see the founder note):
//   Qualification  the candidate's Education (free text: "MD", "MBBS, MD", "GNM", "M.Sc") plus the qualification picked from the master,
//                  when there is one. MD or MS wins over MBBS (an "MBBS, MD" doctor is an MD/MS doctor).
//   Post           the joining's designation (Joining & Drop record, which starts as the job title and can be corrected), else the job
//                  title: "Staff Nurse", "Associate Professor - Radiology", "Consultant Doctor - Dermatology".
//                  Faculty = Assistant Professor / Associate Professor / Professor / Senior Resident. Any other doctor post = Doctor.
//   Full / Part    the joining's employment type (Joining & Drop record: "Correct the joining details"), else the job's employment type.
//                  The ATS starts every job at Full Time, so Part Time shows only once somebody sets it.
// A joining that does not fit the six is never dropped silently: it shows as "Not in the six" (a post with no target, such as a
// Pharmacist or an MBBS doctor on Part Time) or "Needs a check" (the data cannot say, such as a doctor with no qualification recorded).
// Neither counts toward a category target; both are still counted in Recruiter joinings, which is unchanged.
//
// CLOSING (per category, in total, per recruiter):
//   per category   joined / target.
//   total          Sum of min(joined, target) / Sum of targets - a category that is over its target does not hide another that is short.
//                  The joinings above a target are shown beside it ("+2 above target").
//   per recruiter  how many of each category they got, and their share of the team target (their joinings in the six / the total target).
// INCENTIVE: Super Admin sets the rupees per counted joining, per category (blank = not decided: the app never invents an amount).
//   A recruiter's incentive = Sum of (their joinings in a category x that category's amount), for every counted joining.
//   Paid through the existing Recruiter joinings decision ("Give incentive"), so approval, payslip and payroll stay in one place.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const RJ = require('./recruiterJoinings');
const { logAudit } = require('./audit');

const MAX_AMOUNT = 100000; // one joining
const MAX_TARGET = 500;

const MEDICAL = {
  department: 'Medical',
  categories: [
    { key: 'MD_MS_DOCTOR_FT', label: 'MD/MS Doctors', type: 'Full Time', short: 'MD/MS Doctors · Full Time' },
    { key: 'MD_MS_DOCTOR_PT', label: 'MD/MS Doctors', type: 'Part Time', short: 'MD/MS Doctors · Part Time' },
    { key: 'MD_MS_FACULTY_FT', label: 'MD/MS Faculty', type: 'Full Time', short: 'MD/MS Faculty · Full Time', note: 'Assistant Professor / Associate Professor / Senior Resident / Professor' },
    { key: 'MD_MS_FACULTY_PT', label: 'MD/MS Faculty', type: 'Part Time', short: 'MD/MS Faculty · Part Time', note: 'Assistant Professor / Associate Professor / Senior Resident / Professor' },
    { key: 'MBBS_DOCTOR_FT', label: 'MBBS Doctors', type: 'Full Time', short: 'MBBS Doctors · Full Time' },
    { key: 'STAFF_NURSE', label: 'Staff Nurses', type: null, short: 'Staff Nurses' },
  ],
};
const DEPARTMENTS = [MEDICAL];
const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
const departmentDef = (name) => DEPARTMENTS.find((d) => same(d.department, name)) || null;
const hasCategories = (name) => !!departmentDef(name);

// --- Which category is a joining? (pure; tested on its own) -----------------------------------------------------------------------
const lower = (s) => String(s || '').toLowerCase();
// "M.D" -> md, "M.Sc" -> msc, "MBBS, MD(DVL)" -> mbbs md dvl
function words(...texts) {
  return texts.map((t) => lower(t).replace(/\./g, '')).join(' ').split(/[^a-z0-9]+/).filter(Boolean);
}
const NURSE_POST = /\bnurses?\b|\bnarsing\b/;
const NURSING_WORD = /\bnursing\b/;
const NOT_A_STAFF_NURSE = /tutor|professor|lecturer|principal|faculty|instructor|demonstrator|vice/;
const FACULTY_POST = /\b(asst|assoc|assistant|associate)\.?\s*prof|\bprofessor\b|\bsenior\s*resident\b|\bsr\.?\s*resident\b/;
const DOCTOR_POST = /\bdoctor\b|\bdr\b|medical officer|\bdmo\b|\bcmo\b|consultant|physician|surgeon|\bdermatolog|resident|professor|\bsr doctor\b|specialist/;

// facts: { education, qualificationName, specialization, designation, title, employmentType, facultyImpliesMdMs }
// -> { bucket: 'six' | 'other' | 'check', category: key | null, reason, assumed? }
// facultyImpliesMdMs is Super Admin's switch (off unless switched on): a Professor / Assistant Professor / Associate Professor / Senior Resident post whose
// candidate has NO qualification recorded is counted as an MD/MS faculty joining (assumed: true). Off, it is a joining that needs a check.
function classifyMedical(facts) {
  const f = facts || {};
  const post = lower(f.designation || f.title);
  const w = words(f.education, f.qualificationName, /doctor of medicine/i.test(f.education || '') ? 'md' : '', /master of surgery/i.test(f.education || '') ? 'ms' : '');
  let mdms = w.includes('md') || w.includes('ms');
  const mbbs = w.includes('mbbs');
  const noQualification = !String(f.education || '').trim() && !String(f.qualificationName || '').trim();
  let assumed = false;
  if (!mdms && !mbbs && noQualification && f.facultyImpliesMdMs && FACULTY_POST.test(post)) { mdms = true; assumed = true; }
  const superSpec = w.includes('dnb') || w.includes('dm') || w.includes('mch');

  // A nurse is told by the post: "Staff Nurse", "ICU Staff Nurse", "Nursing". A nursing tutor / professor is faculty of another kind: not in the six.
  if (NURSE_POST.test(post) || (NURSING_WORD.test(post) && !NOT_A_STAFF_NURSE.test(post))) {
    return { bucket: 'six', category: 'STAFF_NURSE', reason: 'Staff Nurse post' };
  }
  if (!mdms && !mbbs) {
    if (superSpec) return { bucket: 'check', category: null, reason: 'DNB / DM / MCh: say whether it counts as MD/MS' };
    // Nothing recorded about the qualification: the data cannot say. A qualification that IS recorded but is not a doctor's (M.Sc, B.Pharm ...) is a
    // post with no target.
    if (noQualification && DOCTOR_POST.test(post)) {
      return { bucket: 'check', category: null, reason: 'A doctor post, but the candidate has no qualification recorded (MD / MS / MBBS?)' };
    }
    return { bucket: 'other', category: null, reason: DOCTOR_POST.test(post) ? `Qualification "${String(f.education || f.qualificationName).trim()}" is not MD / MS / MBBS` : 'Not a doctor or nurse post' };
  }
  // Full or Part Time: the joining's own type, else the job's.
  const type = lower(f.employmentType);
  let part;
  if (/part/.test(type)) part = true;
  else if (/full|permanent/.test(type)) part = false;
  else return { bucket: 'check', category: null, reason: type ? `Employment type is "${f.employmentType}": say Full Time or Part Time` : 'Employment type is not recorded' };
  if (mdms) {
    const faculty = FACULTY_POST.test(post);
    const key = `${faculty ? 'MD_MS_FACULTY' : 'MD_MS_DOCTOR'}_${part ? 'PT' : 'FT'}`;
    const q = assumed ? 'qualification not recorded, counted as MD/MS because of the faculty post' : (w.includes('md') ? 'MD' : 'MS');
    return { bucket: 'six', category: key, assumed, reason: `${q}${faculty ? ', faculty post' : ', doctor post'}, ${part ? 'Part' : 'Full'} Time` };
  }
  // MBBS only: the one MBBS target is Full Time.
  if (part) return { bucket: 'other', category: null, reason: 'MBBS doctor on Part Time: there is no target for it' };
  return { bucket: 'six', category: 'MBBS_DOCTOR_FT', reason: 'MBBS doctor, Full Time' };
}

// --- Targets -------------------------------------------------------------------------------------------------------------------------
async function loadTargetRows() {
  try { return await prisma.joiningCategoryTarget.findMany({ orderBy: [{ department: 'asc' }, { fromMonth: 'asc' }] }); } catch { return []; } // table not migrated yet
}
// The targets in force for a department in a month: for each category the latest row starting on or before the month.
function effectiveTargets(rows, department, month) {
  const def = departmentDef(department);
  const out = new Map();
  if (!def) return out;
  def.categories.forEach((c) => {
    const row = rows.filter((r) => same(r.department, def.department) && r.category === c.key && r.fromMonth <= month)
      .sort((a, b) => b.fromMonth.localeCompare(a.fromMonth))[0];
    if (row) out.set(c.key, row);
  });
  return out;
}

// --- The numbers (pure: tested with hand-made input) ---------------------------------------------------------------------------------
// people: [{ key, name, ..., classified: [{ category|null, bucket }] }]; targets: Map(category -> { target, incentive })
function figures(def, people, targets) {
  const cats = def.categories.map((c) => {
    const t = targets.get(c.key);
    const target = t ? Number(t.target) || 0 : null;
    const incentive = t && t.incentive != null ? Number(t.incentive) : null;
    const achieved = people.reduce((n, p) => n + (p.counts[c.key] || 0), 0);
    const counted = target == null ? 0 : Math.min(achieved, target);
    return {
      ...c, target, incentive, achieved, counted,
      above: target == null ? 0 : Math.max(0, achieved - target),
      left: target == null ? null : Math.max(0, target - achieved),
      closingPct: target > 0 ? Math.round((achieved * 100) / target) : null,
      earned: incentive == null ? null : Math.round(achieved * incentive),
    };
  });
  const set = cats.some((c) => c.target != null);
  const totalTarget = cats.reduce((n, c) => n + (c.target || 0), 0);
  const counted = cats.reduce((n, c) => n + c.counted, 0);
  const raw = cats.reduce((n, c) => n + c.achieved, 0);
  const amountsSet = cats.filter((c) => c.target != null).every((c) => c.incentive != null);
  const total = {
    target: totalTarget, achieved: counted, joinedInSix: raw, above: cats.reduce((n, c) => n + c.above, 0),
    closingPct: totalTarget > 0 ? Math.round((counted * 100) / totalTarget) : null,
    closedCategories: cats.filter((c) => c.target > 0 && c.achieved >= c.target).length,
    categories: cats.filter((c) => c.target != null).length,
    incentive: cats.some((c) => c.earned != null) ? cats.reduce((n, c) => n + (c.earned || 0), 0) : null,
    amountsSet,
  };
  const recruiters = people.map((p) => {
    const inSix = def.categories.reduce((n, c) => n + (p.counts[c.key] || 0), 0);
    const cells = {};
    def.categories.forEach((c) => {
      const t = targets.get(c.key);
      cells[c.key] = { count: p.counts[c.key] || 0, pctOfTarget: t && t.target > 0 ? Math.round(((p.counts[c.key] || 0) * 100) / t.target) : null };
    });
    const missing = def.categories.some((c) => (p.counts[c.key] || 0) > 0 && (!targets.get(c.key) || targets.get(c.key).incentive == null));
    const money = def.categories.reduce((n, c) => {
      const t = targets.get(c.key);
      return n + ((t && t.incentive != null) ? (p.counts[c.key] || 0) * Number(t.incentive) : 0);
    }, 0);
    return {
      ...p.base, cells, inSix, other: p.other, check: p.check,
      sharePct: totalTarget > 0 ? Math.round((inSix * 100) / totalTarget) : null,
      incentive: Math.round(money), incentiveComplete: !missing, hasAmounts: cats.some((c) => c.incentive != null),
    };
  });
  return { set, categories: cats, total, recruiters };
}

// Super Admin's switches for the categories (AppSetting). facultyImpliesMdMs: see classifyMedical.
const SETTINGS_KEY = 'joiningCategories.settings';
async function loadSettings() {
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTINGS_KEY } });
    const v = row ? JSON.parse(row.value) : {};
    return { facultyImpliesMdMs: v.facultyImpliesMdMs === true };
  } catch { return { facultyImpliesMdMs: false }; }
}
async function saveSettings(patch, actor) {
  const before = await loadSettings();
  const next = { ...before, facultyImpliesMdMs: patch.facultyImpliesMdMs === true };
  if (next.facultyImpliesMdMs === before.facultyImpliesMdMs) return before;
  const value = JSON.stringify(next);
  await prisma.appSetting.upsert({
    where: { key: SETTINGS_KEY },
    create: { key: SETTINGS_KEY, value, updatedById: actor.id || null, updatedByName: actor.name },
    update: { value, updatedById: actor.id || null, updatedByName: actor.name },
  });
  await logAudit({
    userId: actor.id, actorName: actor.name, action: 'Joining category setting changed', entity: 'AppSetting', entityId: SETTINGS_KEY,
    fromValue: before.facultyImpliesMdMs ? 'Faculty post with no qualification counts as MD/MS faculty' : 'Faculty post with no qualification needs a check',
    toValue: next.facultyImpliesMdMs ? 'Faculty post with no qualification counts as MD/MS faculty' : 'Faculty post with no qualification needs a check',
  });
  RJ.invalidate();
  return next;
}

// The classified joinings of a list of applications: Map(applicationId -> classification).
async function classifyApplications(ids) {
  const out = new Map();
  if (!ids.length) return out;
  const settings = await loadSettings();
  const apps = [];
  for (let i = 0; i < ids.length; i += 400) {
    // eslint-disable-next-line no-await-in-loop
    apps.push(...await prisma.application.findMany({
      where: { id: { in: ids.slice(i, i + 400) } },
      select: {
        id: true,
        candidate: { select: { education: true, specialization: true, qualificationId: true } },
        requirement: { select: { title: true, employmentType: true } },
      },
    }));
  }
  const qids = [...new Set(apps.map((a) => a.candidate && a.candidate.qualificationId).filter(Boolean))];
  const quals = qids.length ? await prisma.qualification.findMany({ where: { id: { in: qids } }, select: { id: true, name: true } }) : [];
  const qname = new Map(quals.map((q) => [q.id, q.name]));
  // The joining's own details (Joining & Drop record), when there is one: they can be corrected, so they come first.
  const rec = new Map();
  try {
    const S = require('../joindrop/schema'); // eslint-disable-line global-require
    if (await S.ensure()) {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        // eslint-disable-next-line no-await-in-loop
        const got = await S.rows(`SELECT "applicationId","designation","employmentType" FROM "JoiningRecord" WHERE "applicationId" IN (${chunk.map(() => '?').join(',')})`, ...chunk);
        got.forEach((g) => rec.set(g.applicationId, g));
      }
    }
  } catch { /* the joining record is a bonus: the job's own title and type are used without it */ }
  apps.forEach((a) => {
    const c = a.candidate || {}; const r = a.requirement || {}; const jr = rec.get(a.id) || {};
    out.set(a.id, classifyMedical({
      education: c.education, specialization: c.specialization, qualificationName: qname.get(c.qualificationId) || '',
      designation: String(jr.designation || '').trim() || '', title: r.title,
      employmentType: String(jr.employmentType || '').trim() || r.employmentType,
      facultyImpliesMdMs: settings.facultyImpliesMdMs,
    }));
  });
  return out;
}

// One department for one month, from the Recruiter joinings board (the one count). `board` is RJ.monthBoard(month) (optionally already
// narrowed to the rows a viewer may see).
async function departmentBoard(def, month, board, { targetRows = null } = {}) {
  const rows = (board.rows || []).filter((r) => same(r.department, def.department));
  const ids = rows.flatMap((r) => r.joiningList.map((a) => a.id));
  const by = await classifyApplications(ids);
  const people = rows.map((r) => {
    const counts = {}; let other = 0; let check = 0; let assumed = 0;
    r.joiningList.forEach((a) => {
      const c = by.get(a.id);
      if (!c) { check += 1; return; }
      if (c.bucket === 'six') { counts[c.category] = (counts[c.category] || 0) + 1; if (c.assumed) assumed += 1; }
      else if (c.bucket === 'other') other += 1;
      else check += 1;
    });
    return {
      counts, other, check, assumed,
      base: {
        key: r.key, userId: r.userId, employeeId: r.employeeId, employeeCode: r.employeeCode, name: r.name, seat: r.seat, tlName: r.tlName,
        left: r.left, employmentStatus: r.employmentStatus, joinings: r.joinings, target: r.target, decision: r.decision || null, needsDecision: r.needsDecision,
      },
    };
  });
  const rowsAll = targetRows || await loadTargetRows();
  const eff = effectiveTargets(rowsAll, def.department, month);
  const fig = figures(def, people, eff);
  const from = [...eff.values()].map((t) => t.fromMonth).sort().slice(-1)[0] || null;
  return {
    department: def.department, month, label: RJ.monthLabel(month), ...fig, fromMonth: from,
    otherCount: people.reduce((n, p) => n + p.other, 0), checkCount: people.reduce((n, p) => n + p.check, 0), assumedCount: people.reduce((n, p) => n + (p.assumed || 0), 0),
    joinings: rows.reduce((n, r) => n + r.joinings, 0),
  };
}

// Every department that has categories, for one month.
async function monthBoards(month, board = null) {
  const b = board || await RJ.monthBoard(month);
  const targetRows = await loadTargetRows();
  const out = [];
  for (const def of DEPARTMENTS) {
    // eslint-disable-next-line no-await-in-loop
    out.push(await departmentBoard(def, month, b, { targetRows }));
  }
  return out;
}

// What the category of each joining in a recruiter's month is, for the Details list (ATS holders only).
async function categoriesOfApplications(department, ids) {
  const def = departmentDef(department);
  if (!def || !ids.length) return new Map();
  const by = await classifyApplications(ids);
  const label = new Map(def.categories.map((c) => [c.key, c.short]));
  const out = new Map();
  by.forEach((c, id) => out.set(id, {
    bucket: c.bucket, key: c.category, label: c.bucket === 'six' ? label.get(c.category) : (c.bucket === 'other' ? 'Not in the six' : 'Needs a check'), reason: c.reason, assumed: !!c.assumed,
  }));
  return out;
}

// The targets and amounts as they were set, newest month first, for the edit window.
async function history(department) {
  const rows = (await loadTargetRows()).filter((r) => same(r.department, department));
  const months = [...new Set(rows.map((r) => r.fromMonth))].sort().reverse();
  return months.map((m) => {
    const list = rows.filter((r) => r.fromMonth === m);
    return {
      fromMonth: m, fromLabel: RJ.monthLabel(m), setByName: (list.find((r) => r.setByName) || {}).setByName || null, updatedAt: list.map((r) => r.updatedAt).sort().slice(-1)[0] || null,
      items: list.map((r) => ({ category: r.category, target: r.target, incentive: r.incentive })),
    };
  });
}

// Super Admin: set the targets (and the rupees per joining) from a month. items: [{ category, target, incentive }]. All of them are
// checked first, then written together.
async function saveTargets({ department, fromMonth, items, note }, actor) {
  const def = departmentDef(department);
  if (!def) throw Object.assign(new Error('That department has no categories.'), { status: 400 });
  if (!RJ.isMonth(fromMonth)) throw Object.assign(new Error('Pick the month the targets start from.'), { status: 400 });
  if (!Array.isArray(items) || !items.length) throw Object.assign(new Error('Nothing to save.'), { status: 400 });
  const clean = [];
  for (const it of items) {
    const cat = def.categories.find((c) => c.key === it.category);
    if (!cat) throw Object.assign(new Error('Unknown category.'), { status: 400 });
    const target = Math.round(Number(it.target));
    if (!(target >= 0 && target <= MAX_TARGET)) throw Object.assign(new Error(`${cat.short}: the target must be a number from 0 to ${MAX_TARGET}.`), { status: 400 });
    let incentive = null;
    if (it.incentive !== '' && it.incentive != null) {
      incentive = Number(it.incentive);
      if (!(incentive >= 0 && incentive <= MAX_AMOUNT)) throw Object.assign(new Error(`${cat.short}: the amount must be rupees from 0 to ${MAX_AMOUNT.toLocaleString('en-IN')}, or blank.`), { status: 400 });
      incentive = Math.round(incentive * 100) / 100;
    }
    clean.push({ category: cat.key, short: cat.short, target, incentive });
  }
  const text = String(note || '').trim().slice(0, 300) || null;
  const before = new Map((await loadTargetRows()).filter((r) => same(r.department, def.department) && r.fromMonth === fromMonth).map((r) => [r.category, r]));
  for (const c of clean) {
    const where = { department_category_fromMonth: { department: def.department, category: c.category, fromMonth } };
    // eslint-disable-next-line no-await-in-loop
    await prisma.joiningCategoryTarget.upsert({
      where,
      create: { department: def.department, category: c.category, fromMonth, target: c.target, incentive: c.incentive, note: text, setById: actor.id, setByName: actor.name },
      update: { target: c.target, incentive: c.incentive, note: text, setById: actor.id, setByName: actor.name },
    });
  }
  const show = (t, i) => `${t}${i != null ? ` @ ₹${i}` : ''}`;
  await logAudit({
    userId: actor.id, actorName: actor.name, action: 'Joining category targets set', entity: 'JoiningCategoryTarget', entityId: `${def.department}|${fromMonth}`,
    fromValue: before.size ? [...before.values()].map((r) => `${r.category} ${show(r.target, r.incentive)}`).join('; ') : null,
    toValue: `${def.department} from ${fromMonth}: ${clean.map((c) => `${c.short} ${show(c.target, c.incentive)}`).join('; ')}`, reason: text,
  });
  RJ.invalidate();
  return { fromMonth, saved: clean.length };
}

// Super Admin: take away one from-month's set of targets (the earlier set applies again).
async function removeTargets({ department, fromMonth }, actor) {
  const def = departmentDef(department);
  if (!def || !RJ.isMonth(fromMonth)) throw Object.assign(new Error('Say which department and month.'), { status: 400 });
  const rows = (await loadTargetRows()).filter((r) => same(r.department, def.department) && r.fromMonth === fromMonth);
  if (!rows.length) throw Object.assign(new Error('Those targets are already gone.'), { status: 404 });
  await prisma.joiningCategoryTarget.deleteMany({ where: { department: def.department, fromMonth } });
  await logAudit({
    userId: actor.id, actorName: actor.name, action: 'Joining category targets removed', entity: 'JoiningCategoryTarget', entityId: `${def.department}|${fromMonth}`,
    fromValue: rows.map((r) => `${r.category} ${r.target}${r.incentive != null ? ` @ ₹${r.incentive}` : ''}`).join('; '),
  });
  return { removed: rows.length };
}

module.exports = {
  MEDICAL, DEPARTMENTS, MAX_AMOUNT, MAX_TARGET, hasCategories, departmentDef,
  classifyMedical, effectiveTargets, figures, loadTargetRows, classifyApplications, departmentBoard, monthBoards, categoriesOfApplications,
  history, saveTargets, removeTargets, loadSettings, saveSettings,
};
