// ---------------------------------------------------------------------------
// OPEN VOCABULARY (user, 2026-10-14): "in a dropdown, if what I need is not in the list, there must be an option to TYPE it".
//
// A typed value is NEVER refused with "not in the list". What happens to it:
//   - it is tidied (HTML removed, spaces collapsed, at most 80 characters, capitalisation kept)
//   - a case-insensitive match with an existing value uses THAT value (no "react" / "React" twins)
//   - typed by the client manager (BDE) team or an Admin -> it joins the shared list (audit 'Added to list')
//   - typed by anybody else -> it stays on that record only and is flagged 'not in the list'
//
// Shared lists live in AppSetting 'ats.openList.<key>' (JSON array), so there is no schema change.
// Qualification / Specialization are the Admin master (Department -> Qualification -> Specialisation);
// applyJob() adds a typed one to that master for the BDE team / Admin (isMaster, active) and otherwise keeps the text
// on the job (Requirement.specialisation / .qualifications).
// ---------------------------------------------------------------------------
const prisma = require('../db');

const MAX = 80;
const PREFIX = 'ats.openList.';
const KEY_RE = /^[a-z][a-zA-Z0-9_.-]{1,40}$/;

// Starting values of the lists the job form offers (the shared list adds to these).
const BASE = {
  education: ['Any Degree', 'B.Tech', 'B.E', 'MCA', 'MBA', 'M.Tech', 'MBBS', 'B.Pharm', 'B.Sc', 'M.Sc', 'Diploma'],
  employmentType: ['Full Time', 'Part Time', 'Contract', 'Temporary', 'Internship'],
  industry: [],
};

// Trim, collapse spaces, remove anything that looks like HTML, cap the length. Capitalisation is kept.
function clean(v, max = MAX) {
  return String(v == null ? '' : v)
    .replace(/<[^>]*>/g, ' ').replace(/[<>]/g, ' ').replace(/[\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, max).trim();
}
const lc = (v) => clean(v).toLowerCase();

function isTeam(user) {
  const kind = require('./jobCreateRule').kindOf(user); // eslint-disable-line global-require
  return ['admin', 'bde', 'bdeTl'].includes(kind);
}

async function readList(key) {
  const row = await prisma.appSetting.findUnique({ where: { key: PREFIX + key } }).catch(() => null);
  if (!row) return [];
  try { const v = JSON.parse(row.value); return Array.isArray(v) ? v.map((x) => clean(x)).filter(Boolean) : []; } catch { return []; }
}

async function listOf(key) {
  const out = []; const seen = new Set();
  [...(BASE[key] || []), ...(await readList(key))].forEach((x) => { if (!seen.has(lc(x))) { seen.add(lc(x)); out.push(x); } });
  return out;
}

// -> { value, added, flagged }. `value` is what to store on the record.
async function consider(key, raw, user) {
  const v = clean(raw);
  if (!v) return { value: '', added: false, flagged: false };
  const have = await listOf(key);
  const hit = have.find((x) => lc(x) === v.toLowerCase());
  if (hit) return { value: hit, added: false, flagged: false };
  if (!isTeam(user)) return { value: v, added: false, flagged: true };
  const cur = await readList(key);
  const next = [...cur, v];
  await prisma.appSetting.upsert({
    where: { key: PREFIX + key },
    create: { key: PREFIX + key, value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
    update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
  });
  await require('./audit').logAudit({ userId: user.id, action: 'Added to list', entity: 'Open list', entityId: key, toValue: v }); // eslint-disable-line global-require
  return { value: v, added: true, flagged: false };
}

// "Java, java , React" -> "Java, React"
function cleanSkills(raw) {
  const seen = new Set(); const out = [];
  String(raw == null ? '' : raw).split(/[,;\n]/).map((x) => clean(x)).filter(Boolean).forEach((x) => {
    if (!seen.has(x.toLowerCase())) { seen.add(x.toLowerCase()); out.push(x); }
  });
  return out.join(', ');
}

const sq = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9+]+/g, '');

// A typed Qualification / Specialization on a job. Mutates `data` (the columns about to be saved).
// body.qualificationCustom / body.specialisationCustom carry the typed text; flags say what stayed on the record only.
async function applyQualSpec(user, body, data, before) {
  const qc = clean(body.qualificationCustom);
  const sc = clean(body.specialisationCustom);
  const flags = {};
  if (!qc && !sc) return flags;
  const SP = require('./specialisations'); // eslint-disable-line global-require
  const m = await SP.loadMaster({ fresh: true });
  const deptName = String(data.department || (before && before.department) || '').toLowerCase();
  const dept = m.departments.find((d) => d.name.toLowerCase() === deptName);
  const team = isTeam(user);
  if (team && dept) {
    let qid = data.qualificationId !== undefined ? data.qualificationId : (before && before.qualificationId) || null;
    if (qc) {
      let q = dept.qualifications.find((x) => sq(x.name) === sq(qc) || x.aliases.some((a) => sq(a) === sq(qc)));
      if (!q) {
        const row = await prisma.qualification.create({ data: { departmentId: dept.id, name: qc, aliases: '[]', sortOrder: 900, updatedAt: new Date() } });
        await require('./audit').logAudit({ userId: user.id, action: 'Added to list', entity: 'Qualification', entityId: row.id, toValue: `${qc} (${dept.name})` }); // eslint-disable-line global-require
        q = { id: row.id };
      }
      qid = q.id; data.qualificationId = q.id;
    }
    if (sc) {
      let s = dept.specialisations.find((x) => sq(x.name) === sq(sc) || x.aliases.some((a) => sq(a) === sq(sc)));
      if (!s) {
        const legacy = await prisma.specialisation.findFirst({ where: { departmentId: dept.id, name: sc } });
        const base = { isMaster: true, active: true, qualificationId: qid || null, aliases: '[]', sortOrder: 900, updatedAt: new Date() };
        const row = legacy
          ? await prisma.specialisation.update({ where: { id: legacy.id }, data: base })
          : await prisma.specialisation.create({ data: { ...base, departmentId: dept.id, name: sc } });
        await require('./audit').logAudit({ userId: user.id, action: 'Added to list', entity: 'Specialization', entityId: row.id, toValue: `${sc} (${dept.name})` }); // eslint-disable-line global-require
        s = { id: row.id };
      }
      data.specialisationId = s.id;
      data.specialisation = null;
    }
    SP.invalidate();
    return flags;
  }
  // Everybody else (or a job with no department): the text stays on this job and is flagged.
  if (sc) {
    const hit = dept && dept.specialisations.find((x) => sq(x.name) === sq(sc));
    if (hit) { data.specialisationId = hit.id; data.specialisation = null; } else { data.specialisationId = null; data.specialisation = sc; flags.specialisation = sc; }
  }
  if (qc) {
    const hit = dept && dept.qualifications.find((x) => sq(x.name) === sq(qc));
    if (hit) data.qualificationId = hit.id;
    else {
      data.qualificationId = null;
      const cur = clean(data.qualifications !== undefined ? data.qualifications : (before && before.qualifications) || '', 2000);
      if (!cur.toLowerCase().includes(qc.toLowerCase())) data.qualifications = cur ? `${cur}; ${qc}` : qc;
      flags.qualification = qc;
    }
  }
  return flags;
}

// The job form: Education, Employment type, Skills, typed Qualification / Specialization. Mutates `data`.
async function applyJob(req, data, before) {
  const user = req.user;
  for (const k of ['education', 'employmentType']) {
    if (data[k] === undefined || data[k] === null || data[k] === '' || /^other$/i.test(String(data[k]).trim())) continue;
    if (before && String(before[k] || '') === String(data[k])) continue; // unchanged on an edit: leave it as it was
    // eslint-disable-next-line no-await-in-loop
    const r = await consider(k, data[k], user);
    data[k] = r.value || null;
  }
  if (data.skills !== undefined && data.skills !== null) data.skills = cleanSkills(data.skills) || null;
  if (data.goodToHaveSkills !== undefined && data.goodToHaveSkills !== null) data.goodToHaveSkills = cleanSkills(data.goodToHaveSkills) || null;
  if (data.qualifications !== undefined && data.qualifications !== null) data.qualifications = clean(data.qualifications, 2000) || null;
  if (data.specialisation !== undefined && data.specialisation !== null) data.specialisation = clean(data.specialisation) || null;
  const flags = await applyQualSpec(user, req.body || {}, data, before);
  req.customFlags = flags;
  return flags;
}

// A typed value that only differs by capitalisation from one already on other records uses THAT spelling ("it" vs "IT").
async function canonicalColumn(model, field, raw) {
  const v = clean(raw);
  if (!v) return v;
  try {
    const rows = await prisma[model].findMany({ where: { [field]: { not: null } }, distinct: [field], select: { [field]: true }, take: 2000 });
    const hit = rows.map((r) => r[field]).find((x) => String(x).trim().toLowerCase() === v.toLowerCase());
    return hit ? String(hit).trim() : v;
  } catch { return v; }
}

async function allLists() {
  const out = {};
  for (const k of Object.keys(BASE)) out[k] = await listOf(k); // eslint-disable-line no-await-in-loop
  return out;
}

module.exports = { canonicalColumn, clean, cleanSkills, consider, listOf, allLists, applyJob, applyQualSpec, isTeam, KEY_RE, BASE };
