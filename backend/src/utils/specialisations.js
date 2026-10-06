// ---------------------------------------------------------------------------
// SPECIALISATIONS — Department -> Qualification -> Specialisation (spec D,
// 2026-10-03).
//
// "Requirements have no specialization field. Candidates have free text only
// ('Dermatology' vs 'Dermatologist'), so counts are wrong."
//
// THE MASTER is the curated list an Admin maintains (Administration ->
// Specializations):
//   Qualification     one row per department ("MBBS", "MD", "B.Ed", …)
//   Specialisation    isMaster = true rows of the existing Specialisation
//                     table, each under one qualification. The table already
//                     held ~1,000 values the data import wrote (isMaster =
//                     false); those stay as the import's vocabulary and are
//                     never offered in a dropdown. A master row with the same
//                     name ADOPTS the legacy row, so the import keeps working.
// Both carry `aliases` (JSON array): "Dermatologist", "Derma" -> Dermatology.
// Nothing is ever hard-deleted once a requirement or candidate uses it —
// it is deactivated instead.
//
// THE SUGGESTION RULES (suggest()) read a record's old free text — the old
// specialisation value, the job title / designation, the education text and,
// on a candidate profile, the resume text — and name the master
// specialisation (and qualification) it most likely means, with a
// confidence and the reason. They only ever SUGGEST: the back-fill queue
// (SpecialisationSuggestion) writes nothing to a requirement or candidate
// until a person clicks Accept in the review screen.
// ---------------------------------------------------------------------------
const prisma = require('../db');

// --- The starter list (the user's examples; the Admin maintains it after) ----
// [qualification, aliases, [[specialisation, aliases], …]]
const SEED = {
  Medical: [
    ['MBBS', ['M.B.B.S'], [
      ['Duty Medical Officer', ['Duty Doctor', 'DMO', 'RMO', 'CMO', 'Medical Officer', 'MBBS Doctor', 'Casualty Medical Officer', 'Resident Medical Officer']],
    ]],
    ['MD', ['M.D', 'Doctor of Medicine'], [
      ['General Medicine', ['Physician', 'Internal Medicine', 'General Physician']],
      ['Dermatology', ['Dermatologist', 'Derma', 'DVL', 'Skin']],
      ['Paediatrics', ['Pediatrics', 'Pediatrician', 'Paediatrician', 'Peadiatrics', 'Peadtrician', 'Child Specialist']],
      ['Radiology', ['Radiologist', 'Radio Diagnosis', 'Radiodiagnosis']],
      ['Anaesthesia', ['Anesthesia', 'Anaesthesiology', 'Anesthesiology', 'Anaesthetist', 'Anesthetist', 'Anesthesiologist']],
      ['Pathology', ['Pathologist']],
      ['Psychiatry', ['Psychiatrist', 'Neuropsychiatry']],
      ['Pulmonology', ['Pulmonologist', 'Chest Physician', 'Respiratory Medicine']],
      ['Emergency Medicine', ['Emergency Physician', 'Casualty']],
      ['Anatomy', []],
      ['Physiology', []],
      ['Biochemistry', []],
      ['Pharmacology', ['Pharmacologist', 'Pharamcology']],
      ['Microbiology', ['Microbiologist']],
      ['Forensic Medicine', ['FMT', 'Forensic']],
      ['Community Medicine', ['SPM', 'PSM', 'Preventive and Social Medicine']],
    ]],
    ['MS', ['M.S', 'Master of Surgery'], [
      ['General Surgery', ['General Surgeon', 'Surgeon']],
      ['Orthopaedics', ['Orthopedics', 'Orthopaedician', 'Orthopedician', 'Ortho', 'Orthopaedic']],
      ['ENT', ['Otorhinolaryngology', 'ENT Specialist']],
      ['Ophthalmology', ['Ophthalmologist', 'Eye Specialist']],
      ['Obstetrics & Gynaecology', ['OBG', 'OBGYN', 'Gynaecology', 'Gynecology', 'Gynaecologist', 'Gynecologist', 'Gynae']],
    ]],
    ['DM / MCh', ['DM', 'MCh', 'M.Ch', 'Super Speciality'], [
      ['Cardiology', ['Cardiologist', 'Interventional Cardiology', 'Cardio']],
      ['Neurology', ['Neurologist', 'Neuro Physician']],
      ['Gastroenterology', ['Gastroenterologist', 'Gastro', 'Gastrologist', 'Medical Gastro']],
      ['Nephrology', ['Nephrologist']],
      ['Urology', ['Urologist']],
      ['Neurosurgery', ['Neuro Surgeon', 'Neurosurgeon']],
    ]],
    ['BDS', ['B.D.S', 'MDS', 'Dental'], [
      ['Orthodontics', ['Orthodontist']],
      ['Prosthodontics', ['Prosthodontist']],
      ['Endodontics', ['Endodontist', 'Conservative Dentistry']],
      ['Oral Surgery', ['Oral and Maxillofacial Surgery', 'OMFS']],
      ['General Dentistry', ['Dentist', 'Dental Surgeon']],
    ]],
    ['Nursing', ['GNM', 'B.Sc Nursing', 'BSc Nursing', 'ANM', 'M.Sc Nursing', 'Post Basic B.Sc Nursing'], [
      ['ICU Nursing', ['ICU Nurse', 'ICU Staff Nurse', 'Critical Care Nursing', 'ICU']],
      ['Ward Nursing', ['Ward Nurse', 'Staff Nurse Ward']],
      ['OT Nursing', ['OT Nurse', 'OT Staff Nurse', 'Operation Theatre Nurse']],
      ['Paediatric Nursing', ['Pediatric Nurse', 'Paediatric Nurse', 'NICU Nurse', 'PICU Nurse']],
      ['Emergency Nursing', ['ER Nurse', 'Emergency Nurse', 'Casualty Nurse']],
      ['General Nursing', ['Staff Nurse', 'Nursing', 'Nurse', 'Staff Nurses']],
    ]],
  ],
  Education: [
    ['B.Ed', ['BEd', 'Bachelor of Education'], [
      ['Mathematics', ['Maths', 'Math', 'Mathametics']],
      ['Physics', []],
      ['Chemistry', []],
      ['Biology', ['Botany', 'Zoology']],
      ['English', []],
      ['Commerce', []],
      ['Social Studies', ['Social']],
    ]],
    ['M.Tech / M.E.', ['M.Tech', 'MTech', 'M.E', 'Master of Technology'], [
      ['Computer Science (CSE)', ['CSE', 'CS', 'Computer Science', 'Computers', 'Computer', 'Software Engineering', 'SE', 'CSE(IT)']],
      ['Information Technology', ['IT', 'IT(CSE)']],
      ['Electronics & Communication (ECE)', ['ECE', 'Electronics']],
      ['Electrical & Electronics (EEE)', ['EEE', 'Electrical']],
      ['Mechanical', ['Mech', 'Mechanical Engineering', 'Mecanical']],
      ['Civil', ['Civil Engineering']],
      ['AI & ML', ['AI', 'AIML', 'Artificial Intelligence', 'Machine Learning']],
      ['Data Science', []],
      ['Cyber Security', ['Cybersecurity']],
    ]],
    ['MBA', ['PGDM'], [
      ['Finance', []],
      ['HR', ['Human Resources']],
      ['Marketing', []],
    ]],
    ['M.Pharm', ['M.Pharmacy', 'MPharm'], [
      ['Pharmaceutics', []],
      ['Pharmacology', ['Pharamcology']],
      ['Pharmaceutical Chemistry', []],
      ['Pharmaceutical Analysis', []],
    ]],
  ],
  IT: [
    ['B.Tech / B.E.', ['B.Tech', 'BTech', 'B.E', 'BE'], [
      ['Java', ['Core Java', 'J2EE', 'Java Developer']],
      ['.NET', ['dotnet', 'dot net', 'ASP.NET', 'C#']],
      ['Testing', ['QA', 'Quality Assurance', 'Manual Testing', 'Automation Testing', 'Selenium', 'Software Testing', 'Tester']],
      ['Python', ['Django']],
      ['Full Stack', ['MERN', 'MEAN', 'Fullstack', 'React+ Node']],
      ['Frontend', ['React', 'Angular', 'UI Developer']],
      ['DevOps', ['AWS', 'Cloud']],
    ]],
    ['MCA', [], []],
  ],
};

// --- Text helpers --------------------------------------------------------------
const norm = (v) => String(v == null ? '' : v).toLowerCase()
  .replace(/&/g, ' and ')
  .replace(/\.net\b/g, ' dotnet ')
  .replace(/c#/g, ' csharp ')
  .replace(/[^a-z0-9+]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
const squash = (v) => norm(v).replace(/ /g, '');
function parseAliases(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (!v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map((x) => String(x).trim()).filter(Boolean) : [];
  } catch {
    return String(v).split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  }
}
const cleanAliases = (list) => {
  const seen = new Set();
  return parseAliases(list).filter((a) => {
    const k = squash(a);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// --- The master, cached ---------------------------------------------------------
let cache = null;
let cacheAt = 0;
const CACHE_MS = 60 * 1000;
function invalidate() { cache = null; }

// { departments: [{ id, name, qualifications: [...], specialisations: [...] }],
//   specById, qualById, deptById }  — master rows only, inactive included
//   (callers filter on .active).
async function loadMaster({ fresh = false } = {}) {
  if (cache && !fresh && Date.now() - cacheAt < CACHE_MS) return cache;
  const [depts, quals, specs] = await Promise.all([
    prisma.department.findMany({ select: { id: true, name: true, active: true }, orderBy: { name: 'asc' } }),
    prisma.qualification.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.specialisation.findMany({ where: { isMaster: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
  ]);
  const deptById = new Map(depts.map((d) => [d.id, d]));
  const qualById = new Map();
  const specById = new Map();
  // Department.active (item 18, owned by HRMS): a switched-off department keeps
  // its master rows but is never offered in a dropdown (callers filter on it).
  const departments = depts.map((d) => ({ id: d.id, name: d.name, active: d.active !== false, qualifications: [], specialisations: [] }));
  const byDept = new Map(departments.map((d) => [d.id, d]));
  quals.forEach((q) => {
    const row = {
      id: q.id, name: q.name, departmentId: q.departmentId, department: deptById.get(q.departmentId)?.name || null,
      active: q.active, aliases: parseAliases(q.aliases), sortOrder: q.sortOrder,
    };
    qualById.set(q.id, row);
    if (byDept.has(q.departmentId)) byDept.get(q.departmentId).qualifications.push(row);
  });
  specs.forEach((s) => {
    const row = {
      id: s.id, name: s.name, departmentId: s.departmentId, department: deptById.get(s.departmentId)?.name || null,
      qualificationId: s.qualificationId || null,
      qualification: s.qualificationId && qualById.get(s.qualificationId) ? qualById.get(s.qualificationId).name : null,
      active: s.active, aliases: parseAliases(s.aliases), sortOrder: s.sortOrder,
    };
    specById.set(s.id, row);
    if (byDept.has(s.departmentId)) byDept.get(s.departmentId).specialisations.push(row);
  });
  cache = { departments, specById, qualById, deptById, deptByName: new Map(depts.map((d) => [d.name.toLowerCase(), d])) };
  cacheAt = Date.now();
  return cache;
}

// Names for ids (lists, facets, reports).
async function labelsFor() {
  const m = await loadMaster();
  return {
    spec: (id) => (id && m.specById.get(id) ? m.specById.get(id).name : null),
    qual: (id) => (id && m.qualById.get(id) ? m.qualById.get(id).name : null),
    specRow: (id) => (id ? m.specById.get(id) || null : null),
    qualRow: (id) => (id ? m.qualById.get(id) || null : null),
  };
}

// --- Seed (idempotent) ------------------------------------------------------------
// Creates what is missing, never renames, re-activates or overwrites what the
// Admin has already changed. A legacy (isMaster = false) row with the same
// department + name is ADOPTED rather than duplicated.
async function seedMaster({ dry = false } = {}) {
  const out = { qualificationsCreated: 0, specialisationsCreated: 0, specialisationsAdopted: 0, skippedDepartments: [] };
  for (const [deptName, quals] of Object.entries(SEED)) {
    // eslint-disable-next-line no-await-in-loop
    const dept = await prisma.department.findFirst({ where: { name: deptName } });
    if (!dept) { out.skippedDepartments.push(deptName); continue; } // departments come from the existing list
    let qOrder = 0;
    for (const [qName, qAliases, specs] of quals) {
      qOrder += 10;
      // eslint-disable-next-line no-await-in-loop
      let q = await prisma.qualification.findFirst({ where: { departmentId: dept.id, name: qName } });
      if (!q) {
        out.qualificationsCreated += 1;
        if (!dry) {
          // eslint-disable-next-line no-await-in-loop
          q = await prisma.qualification.create({
            data: { departmentId: dept.id, name: qName, aliases: JSON.stringify(cleanAliases(qAliases)), sortOrder: qOrder, updatedAt: new Date() },
          });
        }
      }
      let sOrder = 0;
      for (const [sName, sAliases] of specs) {
        sOrder += 10;
        // eslint-disable-next-line no-await-in-loop
        const existing = await prisma.specialisation.findFirst({ where: { departmentId: dept.id, name: sName } });
        if (existing && existing.isMaster) continue;
        if (existing) out.specialisationsAdopted += 1; else out.specialisationsCreated += 1;
        if (dry) continue;
        const data = {
          isMaster: true, active: true, qualificationId: q ? q.id : null,
          aliases: JSON.stringify(cleanAliases(sAliases)), sortOrder: sOrder, updatedAt: new Date(),
        };
        // eslint-disable-next-line no-await-in-loop
        if (existing) await prisma.specialisation.update({ where: { id: existing.id }, data });
        // eslint-disable-next-line no-await-in-loop
        else await prisma.specialisation.create({ data: { ...data, departmentId: dept.id, name: sName } });
      }
    }
  }
  invalidate();
  return out;
}

// --- The suggestion rules -----------------------------------------------------------
// Terms: every active master specialisation's name and aliases, normalised.
// A term of three letters or fewer ("IT", "ENT", "CS", "QA") is only trusted
// when it IS the old value (or a whole word of it) — never inside a title,
// where "it" is an English word.
function termsOf(rows) {
  const out = [];
  rows.forEach((r) => {
    if (!r.active) return;
    [r.name, ...r.aliases].forEach((t, i) => {
      const n = norm(t);
      if (!n) return;
      out.push({ row: r, term: t, n, key: n.replace(/ /g, ''), isName: i === 0, short: n.replace(/ /g, '').length <= 3 });
    });
  });
  // Longest first: "General Surgery" before "Surgery".
  return out.sort((a, b) => b.key.length - a.key.length);
}
const hasWords = (hayN, n) => !!hayN && (` ${hayN} `).includes(` ${n} `);
// "Dermat" -> Dermatology: a 6-letter stem of a long term, at a word start.
const hasStem = (hayN, key) => key.length >= 7 && !!hayN && new RegExp(`(^| )${key.slice(0, 6)}`).test(hayN);

// sources: [{ label, text, weight }] in priority order. Returns the best
// specialisation hit: { spec, confidence, reason, sourceText } or null.
function bestSpec(terms, sources) {
  const LEVELS = [
    // [test, confidence, describe]
    ['exact', 95],
    ['words', 85],
    ['stem', 65],
  ];
  for (const [level, base] of LEVELS) {
    for (const src of sources) {
      const n = norm(src.text);
      if (!n) continue;
      const key = n.replace(/ /g, '');
      const hits = [];
      terms.forEach((t) => {
        if (src.title && t.short) return; // short terms never from a title / resume
        let ok = false;
        if (level === 'exact') ok = key === t.key;
        else if (level === 'words') ok = hasWords(n, t.n);
        else ok = !t.short && hasStem(n, t.key);
        if (ok) hits.push(t);
      });
      if (!hits.length) continue;
      const specs = [...new Map(hits.map((h) => [h.row.id, h])).values()];
      const top = specs[0];
      let confidence = base - (src.penalty || 0);
      let reason = level === 'exact'
        ? `${src.label} "${String(src.text).trim().slice(0, 60)}" = ${top.isName ? top.row.name : `alias "${top.term}"`}`
        : level === 'words'
          ? `${src.label} contains "${top.term}"`
          : `${src.label} starts like "${top.term}" ("${top.key.slice(0, 6)}…")`;
      if (specs.length > 1 && specs[1].key.length === top.key.length) {
        confidence -= 20;
        reason += `; also matches ${specs.slice(1, 3).map((s) => s.row.name).join(', ')}`;
      }
      return { spec: top.row, confidence: Math.max(5, confidence), reason, sourceText: String(src.text).trim().slice(0, 200) };
    }
  }
  return null;
}

function bestQualification(master, deptId, texts, spec) {
  // The master is a tree: a specialisation sits under ONE qualification, so
  // that is the qualification (education text like "M.Tech / M.Pharm" used to
  // pick M.Tech for Pharmacology). Text decides only for a loose one.
  if (spec && spec.qualificationId && master.qualById.get(spec.qualificationId)) return master.qualById.get(spec.qualificationId);
  const dept = master.departments.find((d) => d.id === deptId);
  if (!dept) return null;
  const qTerms = termsOf(dept.qualifications);
  const found = [];
  texts.forEach((txt) => {
    const n = norm(txt);
    const key = n.replace(/ /g, '');
    if (!n) return;
    qTerms.forEach((t) => { if (key === t.key || hasWords(n, t.n)) found.push(t.row); });
  });
  if (spec && spec.qualificationId && found.some((q) => q.id === spec.qualificationId)) return master.qualById.get(spec.qualificationId);
  if (found.length) return found[0];
  return spec && spec.qualificationId ? master.qualById.get(spec.qualificationId) || null : null;
}

// suggest({ departmentNames, oldValue, title, education, extra })
//   departmentNames  the record's department(s); [] = any department
//   oldValue         the old free-text specialisation
//   title            job title / current designation
//   education        education / qualification text
//   extra            further text (resume) — only whole words, lower confidence
// -> { specialisationId, specialisation, qualificationId, qualification,
//      departmentId, department, confidence, reason, sourceText } | null
async function suggest(input, masterIn) {
  const master = masterIn || await loadMaster();
  const wanted = (input.departmentNames || []).map((d) => String(d || '').toLowerCase()).filter(Boolean);
  const pools = [];
  if (wanted.length) {
    pools.push(master.departments.filter((d) => wanted.includes(d.name.toLowerCase())));
    if (input.anyDepartmentFallback) pools.push(master.departments.filter((d) => !wanted.includes(d.name.toLowerCase())));
  } else pools.push(master.departments);
  const sources = [
    { label: 'Old value', text: input.oldValue },
    { label: 'Title', text: input.title, title: true },
    { label: 'Qualification text', text: input.qualificationsText, title: true, penalty: 5 },
    { label: 'Resume', text: input.extra, title: true, penalty: 15 },
  ].filter((s) => s.text && String(s.text).trim());
  for (let i = 0; i < pools.length; i += 1) {
    const terms = termsOf(pools[i].flatMap((d) => d.specialisations));
    if (!terms.length) continue;
    const hit = bestSpec(terms, sources);
    if (!hit) continue;
    const q = bestQualification(master, hit.spec.departmentId, [input.education, input.qualificationsText], hit.spec);
    // Outside the record's own department(s): say so, and trust it less.
    const confidence = i > 0 ? Math.max(5, hit.confidence - 25) : hit.confidence;
    return {
      specialisationId: hit.spec.id,
      specialisation: hit.spec.name,
      qualificationId: q ? q.id : null,
      qualification: q ? q.name : null,
      departmentId: hit.spec.departmentId,
      department: hit.spec.department,
      confidence,
      reason: i > 0 ? `${hit.reason} (department ${hit.spec.department})` : hit.reason,
      sourceText: hit.sourceText,
    };
  }
  return null;
}

// --- The back-fill scan ---------------------------------------------------------------
// Re-computes the PENDING queue for every requirement and candidate that has
// no master specialisation yet. A row someone SKIPPED or ACCEPTED is left as
// it is. Writes ONLY SpecialisationSuggestion rows.
async function scanSuggestions() {
  const master = await loadMaster({ fresh: true });
  const started = Date.now();
  const decided = await prisma.specialisationSuggestion.findMany({
    where: { status: { not: 'PENDING' } }, select: { entityType: true, entityId: true },
  });
  const done = new Set(decided.map((d) => `${d.entityType}:${d.entityId}`));
  const rows = [];

  const reqs = await prisma.requirement.findMany({
    where: { specialisationId: null },
    select: { id: true, title: true, department: true, specialisation: true, education: true, qualifications: true },
  });
  for (const r of reqs) {
    if (done.has(`REQUIREMENT:${r.id}`)) continue;
    // eslint-disable-next-line no-await-in-loop
    const s = await suggest({
      departmentNames: r.department ? [r.department] : [],
      oldValue: r.specialisation, title: r.title, education: r.education, qualificationsText: r.qualifications,
    }, master);
    if (s) rows.push({ entityType: 'REQUIREMENT', entityId: r.id, ...pickSuggestion(s) });
  }

  // A candidate has no department of their own: the departments of the
  // requirements they were put forward for, else any department.
  const cands = await prisma.candidate.findMany({
    where: { specialisationId: null },
    select: {
      id: true, specialization: true, currentDesignation: true, education: true,
      applications: { select: { requirement: { select: { department: true } } } },
    },
  });
  for (const c of cands) {
    if (done.has(`CANDIDATE:${c.id}`)) continue;
    const depts = [...new Set(c.applications.map((a) => a.requirement && a.requirement.department).filter(Boolean))];
    // eslint-disable-next-line no-await-in-loop
    const s = await suggest({
      departmentNames: depts, anyDepartmentFallback: true,
      oldValue: c.specialization, title: c.currentDesignation, education: c.education,
    }, master);
    if (s) rows.push({ entityType: 'CANDIDATE', entityId: c.id, ...pickSuggestion(s) });
  }

  await prisma.specialisationSuggestion.deleteMany({ where: { status: 'PENDING' } });
  for (let i = 0; i < rows.length; i += 500) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.specialisationSuggestion.createMany({ data: rows.slice(i, i + 500) });
  }
  return {
    requirementsScanned: reqs.length,
    candidatesScanned: cands.length,
    suggestions: rows.length,
    requirementSuggestions: rows.filter((r) => r.entityType === 'REQUIREMENT').length,
    candidateSuggestions: rows.filter((r) => r.entityType === 'CANDIDATE').length,
    ms: Date.now() - started,
  };
}
function pickSuggestion(s) {
  return {
    departmentId: s.departmentId,
    qualificationId: s.qualificationId,
    specialisationId: s.specialisationId,
    confidence: s.confidence,
    reason: s.reason ? s.reason.slice(0, 300) : null,
    sourceText: s.sourceText,
    status: 'PENDING',
  };
}

// A requirement edit's field trail names the qualification / specialisation,
// not its id (routes/requirements.js PUT /:id). Mutates `changes` in place.
async function nameChanges(changes) {
  if (!Array.isArray(changes) || !changes.some((c) => c.field === 'qualificationId' || c.field === 'specialisationId')) return;
  try {
    const l = await labelsFor();
    changes.forEach((c) => {
      if (c.field === 'qualificationId') { c.from = l.qual(c.from) || null; c.to = l.qual(c.to) || null; }
      if (c.field === 'specialisationId') { c.from = l.spec(c.from) || null; c.to = l.spec(c.to) || null; }
    });
  } catch { /* the ids stay */ }
}

module.exports = {
  SEED, norm, squash, parseAliases, cleanAliases,
  loadMaster, labelsFor, invalidate, seedMaster, suggest, scanSuggestions, nameChanges,
};
