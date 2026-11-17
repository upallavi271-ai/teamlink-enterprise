// ---------------------------------------------------------------------------
// OFFER COUNTERS, BACKGROUND VERIFICATION (BGV), INDUSTRY TEMPLATES and
// GENDER / AGE CRITERIA (founder ATS audit, 2026-11-17 — all Mandatory).
//
//   Counter-offer   the candidate asks for more (CTC, joining date, other terms, a competing offer) -> recorded on the offer,
//                   then decided: Accepted / Revised offer / Refused. Every counter is kept (history). Table "OfferCounter".
//   BGV             per application: five checks (education, employment, address, criminal, identity), each Pending /
//                   In progress / Clear / Discrepancy / Not needed, the vendor, an optional report link; the overall status is
//                   worked out from the checks. Table "ApplicationBgv". A joining WARNS (never blocks) when the requirement
//                   says BGV is needed and the overall is not Clear.
//   Industry        a data-driven template per industry (Medical, Education, Manufacturing, IT ...) whose items land on the
//                   application's checklist, grouped by step (Interview / Offer / Joining). Admin edits the templates.
//                   Tables "IndustryTemplate" and "ApplicationChecklist".
//   Criteria        optional preferred gender / age min-max on a requirement, with a mandatory reason (lawful use only). The
//                   fit score never reads them — only a Match / Mismatch / Not known flag is shown. Audited when set.
//                   One row per requirement in "RequirementExtra" (template, BGV needed, criteria).
// Raw tables, created on first use (no migration) — the utils/offerHold.js pattern.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../db');

const BGV_CHECKS = [
  ['education', 'Education'], ['employment', 'Employment'], ['address', 'Address'], ['criminal', 'Criminal'], ['identity', 'Identity'],
];
const BGV_STATES = ['Pending', 'In progress', 'Clear', 'Discrepancy', 'Not needed'];
const COUNTER_DECISIONS = ['Accepted', 'Revised offer', 'Refused'];
const STEPS = ['Interview', 'Offer', 'Joining'];
const GENDERS = ['Any', 'Male', 'Female'];

// The four starting templates (Admin may change them, or add more industries).
const item = (key, label, step, required = true) => ({ key, label, step, required });
const SEED = [
  {
    id: 'medical', industry: 'Medical', name: 'Medical / Hospital', match: 'medic|hospital|health|pharma|clinic|nursing|diagnos',
    items: [
      item('reg_number', 'Medical registration number', 'Interview'),
      item('reg_council', 'Registration council (state / national)', 'Interview'),
      item('license_expiry', 'License expiry date checked', 'Offer'),
      item('vaccination', 'Vaccination record (Hepatitis B etc.)', 'Joining'),
    ],
  },
  {
    id: 'education', industry: 'Education', name: 'Education / Teaching', match: 'educat|school|college|universit|academ|teach|institute|coaching',
    items: [
      item('qual_certs', 'Qualification certificates seen', 'Interview'),
      item('net_set_phd', 'NET / SET / PhD (where the post needs it)', 'Interview', false),
      item('demo_class', 'Demo class done', 'Interview'),
      item('cert_copies', 'Certificate copies collected', 'Joining'),
    ],
  },
  {
    id: 'manufacturing', industry: 'Manufacturing', name: 'Manufacturing / Plant', match: 'manufactur|factory|plant|industr|production|automobile|automotive|steel|textile',
    items: [
      item('trade_cert', 'Trade certificate (ITI / Diploma)', 'Interview'),
      item('shift_ok', 'Willing to work shifts', 'Interview'),
      item('safety_training', 'Safety training done / booked', 'Joining'),
    ],
  },
  {
    id: 'it', industry: 'IT', name: 'IT / Software', match: '\\bit\\b|software|information technology|tech|saas|digital|computer',
    items: [
      item('tech_round', 'Technical round cleared', 'Interview'),
      item('coding_test', 'Coding test done', 'Interview'),
      item('notice_buyout', 'Notice period / buyout agreed', 'Offer'),
    ],
  },
];

let READY = null;
function ensure() {
  if (!READY) {
    READY = (async () => {
      const ddl = [
        'CREATE TABLE IF NOT EXISTS "OfferCounter" ("id" TEXT PRIMARY KEY, "applicationId" TEXT NOT NULL, "ctcAsked" REAL, "joiningAsked" TEXT, "otherTerms" TEXT, "competingCompany" TEXT, "competingCtc" REAL, "decision" TEXT, "revisedCtc" REAL, "revisedJoining" TEXT, "decisionNote" TEXT, "byId" TEXT, "byName" TEXT, "at" TEXT NOT NULL, "decidedById" TEXT, "decidedByName" TEXT, "decidedAt" TEXT)',
        'CREATE INDEX IF NOT EXISTS "OfferCounter_app" ON "OfferCounter" ("applicationId")',
        'CREATE TABLE IF NOT EXISTS "ApplicationBgv" ("applicationId" TEXT PRIMARY KEY, "checks" TEXT NOT NULL, "vendor" TEXT, "reportLink" TEXT, "note" TEXT, "overall" TEXT NOT NULL, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS "IndustryTemplate" ("id" TEXT PRIMARY KEY, "industry" TEXT NOT NULL, "name" TEXT NOT NULL, "match" TEXT, "items" TEXT NOT NULL, "active" INTEGER NOT NULL DEFAULT 1, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS "RequirementExtra" ("requirementId" TEXT PRIMARY KEY, "templateId" TEXT, "bgvNeeded" INTEGER NOT NULL DEFAULT 0, "prefGender" TEXT, "ageMin" INTEGER, "ageMax" INTEGER, "criteriaReason" TEXT, "criteriaByName" TEXT, "criteriaAt" TEXT, "byName" TEXT, "at" TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS "ApplicationChecklist" ("applicationId" TEXT NOT NULL, "itemKey" TEXT NOT NULL, "done" INTEGER NOT NULL DEFAULT 0, "note" TEXT, "byName" TEXT, "at" TEXT NOT NULL, PRIMARY KEY ("applicationId", "itemKey"))',
      ];
      for (const s of ddl) await prisma.$executeRawUnsafe(s); // eslint-disable-line no-await-in-loop
      const now = new Date().toISOString();
      for (const t of SEED) {
        // eslint-disable-next-line no-await-in-loop
        await prisma.$executeRawUnsafe('INSERT OR IGNORE INTO "IndustryTemplate" ("id","industry","name","match","items","active","byName","at") VALUES (?,?,?,?,?,1,?,?)',
          t.id, t.industry, t.name, t.match, JSON.stringify(t.items), 'TeamLink (starting template)', now);
      }
    })().catch((e) => { READY = null; throw e; });
  }
  return READY;
}

const txt = (v, n = 500) => { const s = v == null ? '' : String(v).trim(); return s ? s.slice(0, n) : null; };
const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) && !Number.isNaN(new Date(v).getTime());
const placeholders = (list) => list.map(() => '?').join(',');

// ---------------------------------------------------------------- templates
const shapeTemplate = (r) => ({
  id: r.id, industry: r.industry, name: r.name, match: r.match || '', active: Number(r.active) === 1,
  items: (() => { try { return JSON.parse(r.items) || []; } catch { return []; } })(), byName: r.byName, at: r.at,
});
async function templates({ all = false } = {}) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "IndustryTemplate" ${all ? '' : 'WHERE "active" = 1'} ORDER BY "industry"`);
  return rows.map(shapeTemplate);
}
async function template(id) {
  if (!id) return null;
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "IndustryTemplate" WHERE "id" = ?', String(id));
  return r ? shapeTemplate(r) : null;
}
// Checks an Admin's template before it is saved: { value } | { error }.
function cleanTemplate(body) {
  const industry = txt(body.industry, 60);
  const name = txt(body.name, 100) || industry;
  if (!industry) return { error: 'Enter the industry (for example "Medical").' };
  const list = Array.isArray(body.items) ? body.items : [];
  const seen = new Set();
  const items = [];
  for (const it of list) {
    const label = txt(it && it.label, 150);
    if (!label) continue; // a blank line is skipped
    const step = STEPS.includes(it.step) ? it.step : 'Joining';
    let key = txt(it.key, 40) || label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
    if (!key) key = `item_${items.length + 1}`;
    while (seen.has(key)) key = `${key}_2`;
    seen.add(key);
    items.push({ key, label, step, required: it.required !== false });
  }
  if (!items.length) return { error: 'Add at least one checklist item.' };
  if (items.length > 30) return { error: 'Keep a template to 30 items or fewer.' };
  let match = txt(body.match, 200) || '';
  try { if (match) new RegExp(match, 'i'); } catch { match = ''; } // eslint-disable-line no-new
  return { value: { industry, name, items, match, active: body.active !== false } };
}
async function saveTemplate(id, value, byName) {
  await ensure();
  const tid = id || `t_${crypto.randomUUID().slice(0, 12)}`;
  await prisma.$executeRawUnsafe('INSERT INTO "IndustryTemplate" ("id","industry","name","match","items","active","byName","at") VALUES (?,?,?,?,?,?,?,?) ON CONFLICT("id") DO UPDATE SET "industry"=excluded."industry","name"=excluded."name","match"=excluded."match","items"=excluded."items","active"=excluded."active","byName"=excluded."byName","at"=excluded."at"',
    tid, value.industry, value.name, value.match || '', JSON.stringify(value.items), value.active ? 1 : 0, byName || null, new Date().toISOString());
  return template(tid);
}
// The template a requirement gets when nobody picked one: from the client's industry (or the job's department).
async function defaultTemplateFor(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const list = await templates();
  return list.find((t) => t.industry.toLowerCase() === s.toLowerCase())
    || list.find((t) => { try { return t.match && new RegExp(t.match, 'i').test(s); } catch { return false; } })
    || null;
}

// ---------------------------------------------------------------- requirement extras
async function reqExtraRow(requirementId) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "RequirementExtra" WHERE "requirementId" = ?', String(requirementId));
  return r || null;
}
function criteriaOf(r) {
  if (!r) return null;
  const g = r.prefGender && r.prefGender !== 'Any' ? r.prefGender : null;
  const min = r.ageMin == null ? null : Number(r.ageMin);
  const max = r.ageMax == null ? null : Number(r.ageMax);
  if (!g && min == null && max == null) return null;
  return { prefGender: g || 'Any', ageMin: min, ageMax: max, reason: r.criteriaReason, byName: r.criteriaByName, at: r.criteriaAt };
}
// Everything the requirement card shows. `requirement` needs { id, department, client: { industry } }.
async function requirementExtras(requirement) {
  const row = await reqExtraRow(requirement.id);
  const clientIndustry = requirement.client ? requirement.client.industry || null : null;
  const fallback = (await defaultTemplateFor(clientIndustry)) || (await defaultTemplateFor(requirement.department));
  const picked = row && row.templateId ? await template(row.templateId) : null;
  const tpl = row && row.templateId === 'none' ? null : (picked || fallback);
  return {
    templateId: row && row.templateId ? row.templateId : null,
    template: tpl,
    templateFrom: row && row.templateId ? (row.templateId === 'none' ? 'none' : 'picked') : (fallback ? 'client industry' : 'none'),
    defaultTemplateId: fallback ? fallback.id : null,
    industryText: clientIndustry,
    bgvNeeded: !!(row && Number(row.bgvNeeded) === 1),
    criteria: criteriaOf(row),
  };
}
// Checks and saves { templateId, bgvNeeded, prefGender, ageMin, ageMax, criteriaReason }. -> { before, after } | { error }
async function saveRequirementExtras(requirementId, body, user) {
  const before = await reqExtraRow(requirementId);
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  let templateId = before ? before.templateId : null;
  if (has('templateId')) {
    templateId = txt(body.templateId, 60);
    if (templateId && templateId !== 'none' && !(await template(templateId))) return { error: 'That industry template does not exist.' };
  }
  const bgvNeeded = has('bgvNeeded') ? (body.bgvNeeded ? 1 : 0) : (before ? Number(before.bgvNeeded) : 0);
  let prefGender = before ? before.prefGender : null;
  let ageMin = before && before.ageMin != null ? Number(before.ageMin) : null;
  let ageMax = before && before.ageMax != null ? Number(before.ageMax) : null;
  let reason = before ? before.criteriaReason : null;
  const touchesCriteria = ['prefGender', 'ageMin', 'ageMax', 'criteriaReason'].some(has);
  if (touchesCriteria) {
    prefGender = has('prefGender') ? (txt(body.prefGender, 10) || 'Any') : (prefGender || 'Any');
    if (!GENDERS.includes(prefGender)) return { error: 'Preferred gender is Any, Male or Female.' };
    if (has('ageMin')) ageMin = num(body.ageMin);
    if (has('ageMax')) ageMax = num(body.ageMax);
    for (const [v, w] of [[ageMin, 'Minimum age'], [ageMax, 'Maximum age']]) {
      if (v != null && (!Number.isInteger(v) || v < 18 || v > 70)) return { error: `${w} must be a whole number between 18 and 70.` };
    }
    if (ageMin != null && ageMax != null && ageMin > ageMax) return { error: 'Minimum age cannot be more than the maximum age.' };
    if (has('criteriaReason')) reason = txt(body.criteriaReason, 500);
    const set = prefGender !== 'Any' || ageMin != null || ageMax != null;
    if (set && (!reason || reason.length < 10)) {
      return { error: 'Say why this gender / age criteria is needed (a lawful reason, for example "Warden for a women\'s hostel"). At least 10 letters.' };
    }
    if (!set) reason = null;
  }
  const now = new Date().toISOString();
  const nOrNull = (v) => (v == null ? null : Number(v));
  const criteriaChanged = touchesCriteria && JSON.stringify([before && before.prefGender !== 'Any' ? before.prefGender || null : null, before ? nOrNull(before.ageMin) : null, before ? nOrNull(before.ageMax) : null, before ? before.criteriaReason || null : null])
    !== JSON.stringify([prefGender !== 'Any' ? prefGender || null : null, ageMin, ageMax, reason]);
  const crBy = criteriaChanged ? (user && user.name) || null : (before ? before.criteriaByName : null);
  const crAt = criteriaChanged ? now : (before ? before.criteriaAt : null);
  await prisma.$executeRawUnsafe('INSERT INTO "RequirementExtra" ("requirementId","templateId","bgvNeeded","prefGender","ageMin","ageMax","criteriaReason","criteriaByName","criteriaAt","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT("requirementId") DO UPDATE SET "templateId"=excluded."templateId","bgvNeeded"=excluded."bgvNeeded","prefGender"=excluded."prefGender","ageMin"=excluded."ageMin","ageMax"=excluded."ageMax","criteriaReason"=excluded."criteriaReason","criteriaByName"=excluded."criteriaByName","criteriaAt"=excluded."criteriaAt","byName"=excluded."byName","at"=excluded."at"',
    String(requirementId), templateId, bgvNeeded, prefGender, ageMin, ageMax, reason, crBy, crAt, (user && user.name) || null, now);
  return { before, after: await reqExtraRow(requirementId), criteriaChanged };
}

// ---------------------------------------------------------------- the criteria flag (never part of the fit score)
function ageOf(dob, today = new Date()) {
  const s = String(dob || '').trim();
  let y; let m; let d;
  let x = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (x) [, y, m, d] = x.map(Number);
  else {
    x = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
    if (x) { d = Number(x[1]); m = Number(x[2]); y = Number(x[3]); } else return null;
  }
  if (!y || y < 1900 || m < 1 || m > 12) return null;
  let age = today.getUTCFullYear() - y;
  if (today.getUTCMonth() + 1 < m || (today.getUTCMonth() + 1 === m && today.getUTCDate() < d)) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}
const genderOf = (g) => {
  const s = String(g || '').trim().toLowerCase();
  if (/^(m|male|man)$/.test(s)) return 'Male';
  if (/^(f|female|woman)$/.test(s)) return 'Female';
  return s ? 'Other' : null;
};
// -> null (no criteria) | { flag: 'Match' | 'Mismatch' | 'Not known', why: [..] }
function criteriaFlag(criteria, candidate) {
  if (!criteria) return null;
  const why = [];
  let unknown = false;
  let bad = false;
  if (criteria.prefGender && criteria.prefGender !== 'Any') {
    const g = genderOf(candidate && candidate.gender);
    if (!g) { unknown = true; why.push('Gender not on the profile'); } else if (g !== criteria.prefGender) { bad = true; why.push(`Gender is ${g}; the job prefers ${criteria.prefGender}`); }
  }
  if (criteria.ageMin != null || criteria.ageMax != null) {
    const a = ageOf(candidate && candidate.dob);
    if (a == null) { unknown = true; why.push('Date of birth not on the profile'); } else if ((criteria.ageMin != null && a < criteria.ageMin) || (criteria.ageMax != null && a > criteria.ageMax)) {
      bad = true; why.push(`Age ${a}; the job asks ${criteria.ageMin ?? 'any'}–${criteria.ageMax ?? 'any'}`);
    }
  }
  // eslint-disable-next-line no-nested-ternary
  return { flag: bad ? 'Mismatch' : unknown ? 'Not known' : 'Match', why };
}

// ---------------------------------------------------------------- checklist (from the industry template)
async function checklistOf(applicationId, tpl) {
  if (!tpl) return [];
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "ApplicationChecklist" WHERE "applicationId" = ?', String(applicationId));
  const by = new Map(rows.map((r) => [r.itemKey, r]));
  return tpl.items.map((it) => {
    const r = by.get(it.key);
    return { ...it, done: !!(r && Number(r.done) === 1), note: r ? r.note : null, byName: r ? r.byName : null, at: r ? r.at : null };
  });
}
async function tick(applicationId, itemKey, done, note, byName) {
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "ApplicationChecklist" ("applicationId","itemKey","done","note","byName","at") VALUES (?,?,?,?,?,?) ON CONFLICT("applicationId","itemKey") DO UPDATE SET "done"=excluded."done","note"=excluded."note","byName"=excluded."byName","at"=excluded."at"',
    String(applicationId), String(itemKey), done ? 1 : 0, txt(note, 300), byName || null, new Date().toISOString());
}

// ---------------------------------------------------------------- BGV
function overallOf(checks) {
  const v = BGV_CHECKS.map(([k]) => checks[k] || 'Pending');
  if (v.includes('Discrepancy')) return 'Discrepancy';
  if (v.every((s) => s === 'Not needed')) return 'Not needed';
  if (v.every((s) => s === 'Clear' || s === 'Not needed')) return 'Clear';
  if (v.every((s) => s === 'Pending' || s === 'Not needed')) return 'Pending';
  return 'In progress';
}
const shapeBgv = (r) => {
  if (!r) return null;
  let checks = {};
  try { checks = JSON.parse(r.checks) || {}; } catch { checks = {}; }
  return {
    checks: BGV_CHECKS.map(([key, label]) => ({ key, label, status: checks[key] || 'Pending' })),
    vendor: r.vendor, reportLink: r.reportLink, note: r.note, overall: r.overall, byName: r.byName, at: r.at,
  };
};
async function bgvMap(ids) {
  await ensure();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!list.length) return new Map();
  const out = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "ApplicationBgv" WHERE "applicationId" IN (${placeholders(part)})`, ...part);
    rows.forEach((r) => out.set(r.applicationId, shapeBgv(r)));
  }
  return out;
}
async function bgvOf(id) { return (await bgvMap([id])).get(id) || null; }
// body: { checks: { education: 'Clear', ... }, vendor, reportLink, note } -> { value } | { error }
function cleanBgv(body, before) {
  const prev = {};
  if (before) before.checks.forEach((c) => { prev[c.key] = c.status; });
  const checks = {};
  const given = (body && body.checks) || {};
  for (const [k, label] of BGV_CHECKS) {
    const s = given[k] === undefined ? (prev[k] || 'Pending') : given[k];
    if (!BGV_STATES.includes(s)) return { error: `${label} check: pick Pending, In progress, Clear, Discrepancy or Not needed.` };
    checks[k] = s;
  }
  const reportLink = body.reportLink === undefined ? (before ? before.reportLink : null) : txt(body.reportLink, 500);
  if (reportLink && !/^https?:\/\/[^\s]+$/i.test(reportLink)) return { error: 'The report link must start with http:// or https://' };
  return {
    value: {
      checks,
      vendor: body.vendor === undefined ? (before ? before.vendor : null) : txt(body.vendor, 120),
      reportLink,
      note: body.note === undefined ? (before ? before.note : null) : txt(body.note, 500),
      overall: overallOf(checks),
    },
  };
}
async function saveBgv(applicationId, value, byName) {
  await ensure();
  await prisma.$executeRawUnsafe('INSERT INTO "ApplicationBgv" ("applicationId","checks","vendor","reportLink","note","overall","byName","at") VALUES (?,?,?,?,?,?,?,?) ON CONFLICT("applicationId") DO UPDATE SET "checks"=excluded."checks","vendor"=excluded."vendor","reportLink"=excluded."reportLink","note"=excluded."note","overall"=excluded."overall","byName"=excluded."byName","at"=excluded."at"',
    String(applicationId), JSON.stringify(value.checks), value.vendor, value.reportLink, value.note, value.overall, byName || null, new Date().toISOString());
  return bgvOf(applicationId);
}
async function bgvNeededMap(requirementIds) {
  await ensure();
  const list = [...new Set((requirementIds || []).filter(Boolean))];
  if (!list.length) return new Set();
  const rows = await prisma.$queryRawUnsafe(`SELECT "requirementId" FROM "RequirementExtra" WHERE "bgvNeeded" = 1 AND "requirementId" IN (${placeholders(list)})`, ...list);
  return new Set(rows.map((r) => r.requirementId));
}
async function bgvRequirementIds() {
  await ensure();
  return (await prisma.$queryRawUnsafe('SELECT "requirementId" FROM "RequirementExtra" WHERE "bgvNeeded" = 1')).map((r) => r.requirementId);
}
async function bgvApplicationIds() {
  await ensure();
  return (await prisma.$queryRawUnsafe('SELECT "applicationId" FROM "ApplicationBgv"')).map((r) => r.applicationId);
}

// What a joining should be warned about (never a block). app needs { id, requirementId, requirement: { id, department, client } }.
async function joiningWarnings(app) {
  const out = [];
  try {
    const ex = await requirementExtras(app.requirement || { id: app.requirementId });
    if (ex.bgvNeeded) {
      const b = await bgvOf(app.id);
      const overall = b ? b.overall : 'Not started';
      if (overall !== 'Clear') out.push(`Background verification is not clear (${overall}) — this job needs BGV.`);
    }
    if (ex.template) {
      const open = (await checklistOf(app.id, ex.template)).filter((c) => c.required && !c.done && c.step === 'Joining');
      if (open.length) out.push(`Joining checklist not done: ${open.map((c) => c.label).join(', ')}.`);
    }
  } catch { /* a warning is a courtesy */ }
  return out;
}

// ---------------------------------------------------------------- counter-offers
const shapeCounter = (r) => ({
  id: r.id, ctcAsked: r.ctcAsked == null ? null : Number(r.ctcAsked), joiningAsked: r.joiningAsked, otherTerms: r.otherTerms,
  competingCompany: r.competingCompany, competingCtc: r.competingCtc == null ? null : Number(r.competingCtc),
  decision: r.decision || null, status: r.decision || 'Waiting for decision',
  revisedCtc: r.revisedCtc == null ? null : Number(r.revisedCtc), revisedJoining: r.revisedJoining, decisionNote: r.decisionNote,
  byName: r.byName, at: r.at, decidedByName: r.decidedByName, decidedAt: r.decidedAt,
});
async function countersOf(applicationId) {
  await ensure();
  const rows = await prisma.$queryRawUnsafe('SELECT * FROM "OfferCounter" WHERE "applicationId" = ? ORDER BY "at" DESC', String(applicationId));
  return rows.map(shapeCounter);
}
async function latestCounterMap(ids) {
  await ensure();
  const list = [...new Set((ids || []).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < list.length; i += 400) {
    const part = list.slice(i, i + 400);
    // eslint-disable-next-line no-await-in-loop
    const rows = await prisma.$queryRawUnsafe(`SELECT * FROM "OfferCounter" WHERE "applicationId" IN (${placeholders(part)}) ORDER BY "at" DESC`, ...part);
    rows.forEach((r) => {
      if (!out.has(r.applicationId)) out.set(r.applicationId, { ...shapeCounter(r), count: 0 });
      out.get(r.applicationId).count += 1;
    });
  }
  return out;
}
function cleanCounter(body) {
  const ctcAsked = num(body.ctcAsked);
  const competingCtc = num(body.competingCtc);
  if (ctcAsked != null && (ctcAsked <= 0 || ctcAsked > 1e9)) return { error: 'The CTC asked must be a yearly amount in rupees.' };
  if (competingCtc != null && (competingCtc <= 0 || competingCtc > 1e9)) return { error: 'The competing offer CTC must be a yearly amount in rupees.' };
  const joiningAsked = txt(body.joiningAsked, 10);
  if (joiningAsked && !isDay(joiningAsked)) return { error: 'The joining date asked must be a date.' };
  const otherTerms = txt(body.otherTerms, 1000);
  if (ctcAsked == null && !joiningAsked && !otherTerms) return { error: 'Enter what the candidate asked for: a CTC, a joining date or other terms.' };
  return {
    value: {
      ctcAsked, joiningAsked, otherTerms, competingCompany: txt(body.competingCompany, 150), competingCtc,
    },
  };
}
async function addCounter(applicationId, v, user) {
  await ensure();
  const id = crypto.randomUUID();
  await prisma.$executeRawUnsafe('INSERT INTO "OfferCounter" ("id","applicationId","ctcAsked","joiningAsked","otherTerms","competingCompany","competingCtc","byId","byName","at") VALUES (?,?,?,?,?,?,?,?,?,?)',
    id, String(applicationId), v.ctcAsked, v.joiningAsked, v.otherTerms, v.competingCompany, v.competingCtc, (user && user.id) || null, (user && user.name) || null, new Date().toISOString());
  return id;
}
async function counterById(id) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "OfferCounter" WHERE "id" = ?', String(id));
  return r ? { ...shapeCounter(r), applicationId: r.applicationId } : null;
}
function cleanDecision(body) {
  const decision = COUNTER_DECISIONS.find((d) => d.toLowerCase() === String(body.decision || '').trim().toLowerCase());
  if (!decision) return { error: 'Pick the decision: Accepted, Revised offer or Refused.' };
  const revisedCtc = num(body.revisedCtc);
  const revisedJoining = txt(body.revisedJoining, 10);
  if (revisedJoining && !isDay(revisedJoining)) return { error: 'The revised joining date must be a date.' };
  if (decision === 'Revised offer' && revisedCtc == null && !revisedJoining) return { error: 'A revised offer needs the new CTC or the new joining date.' };
  if (revisedCtc != null && (revisedCtc <= 0 || revisedCtc > 1e9)) return { error: 'The revised CTC must be a yearly amount in rupees.' };
  const note = txt(body.note, 500);
  if (decision === 'Refused' && (!note || note.length < 3)) return { error: 'Say why the counter was refused.' };
  return { value: { decision, revisedCtc: decision === 'Revised offer' ? revisedCtc : null, revisedJoining: decision === 'Revised offer' ? revisedJoining : null, note } };
}
async function decideCounter(id, v, user) {
  await ensure();
  await prisma.$executeRawUnsafe('UPDATE "OfferCounter" SET "decision"=?,"revisedCtc"=?,"revisedJoining"=?,"decisionNote"=?,"decidedById"=?,"decidedByName"=?,"decidedAt"=? WHERE "id"=?',
    v.decision, v.revisedCtc, v.revisedJoining, v.note, (user && user.id) || null, (user && user.name) || null, new Date().toISOString(), String(id));
  return counterById(id);
}

module.exports = {
  ensure, BGV_CHECKS, BGV_STATES, COUNTER_DECISIONS, STEPS, GENDERS, SEED,
  templates, template, cleanTemplate, saveTemplate, defaultTemplateFor,
  requirementExtras, saveRequirementExtras, criteriaOf, criteriaFlag, ageOf,
  checklistOf, tick,
  overallOf, bgvMap, bgvOf, cleanBgv, saveBgv, bgvNeededMap, bgvRequirementIds, bgvApplicationIds, joiningWarnings,
  countersOf, latestCounterMap, cleanCounter, addCounter, counterById, cleanDecision, decideCounter,
};
