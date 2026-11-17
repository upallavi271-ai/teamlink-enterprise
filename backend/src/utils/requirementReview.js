// ---------------------------------------------------------------------------
// A LIVE REQUIREMENT'S KEY DETAILS CHANGED -> THE BDE TL LOOKS AGAIN (ATS audit E32 / Q24 / Q27, founder 2026-11-17 "build what is not
// built"). When somebody other than the BDE TL / an Admin changes what the client asked for on a live job - title, description, salary,
// openings, experience, skills, location, qualification, specialization, department, job type - the job keeps running (recruiters are
// not stopped), but the change waits for the BDE TL: a bell to every BDE TL, a banner on the requirement with what changed (old -> new),
// and two buttons: "Approve the change" or "Undo the change" (puts the old values back). Audited both ways.
// Raw table "RequirementReview" (one open review per requirement; later edits add to it). No migration.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('./audit');

const KEY = /^(title|description|jd|jobDescription|salary|minSalary|maxSalary|salaryMin|salaryMax|ctc\w*|openings|vacancies|experience\w*|minExperience|maxExperience|skills|mustHaveSkills|location|qualificationId|specialisationId|specialisation|department|departments|jobType|employmentType)$/i;
let READY = null;
function ensure() {
  if (!READY) {
    READY = prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS "RequirementReview" ("requirementId" TEXT PRIMARY KEY, "changes" TEXT NOT NULL, "byId" TEXT, "byName" TEXT,
      "at" TEXT NOT NULL)`).catch((e) => { READY = null; throw e; });
  }
  return READY;
}
const keyChanges = (changes) => (changes || []).filter((c) => KEY.test(String(c.field || '')));

async function of(requirementId) {
  await ensure();
  const [r] = await prisma.$queryRawUnsafe('SELECT * FROM "RequirementReview" WHERE "requirementId" = ?', String(requirementId));
  return r ? { ...r, changes: JSON.parse(r.changes) } : null;
}

// called after an edit is saved (routes/requirements.js PUT /:id)
async function afterEdit({ requirement, changes, user, exempt }) {
  const key = keyChanges(changes);
  if (!key.length || exempt) return null;
  await ensure();
  const prev = await of(requirement.id);
  // the first "from" of a field is kept: Undo goes back to what the BDE TL last approved
  const merged = new Map((prev ? prev.changes : []).map((c) => [c.field, c]));
  key.forEach((c) => { const o = merged.get(c.field); merged.set(c.field, { field: c.field, label: c.label, from: o ? o.from : c.from, to: c.to }); });
  const list = [...merged.values()].filter((c) => String(c.from ?? '') !== String(c.to ?? ''));
  if (!list.length) { await prisma.$executeRawUnsafe('DELETE FROM "RequirementReview" WHERE "requirementId" = ?', requirement.id); return null; }
  await prisma.$executeRawUnsafe('INSERT INTO "RequirementReview" ("requirementId","changes","byId","byName","at") VALUES (?,?,?,?,?) ON CONFLICT("requirementId") DO UPDATE SET "changes"=excluded."changes","byId"=excluded."byId","byName"=excluded."byName","at"=excluded."at"',
    requirement.id, JSON.stringify(list), user && user.id, user && user.name, new Date().toISOString());
  await logAudit({ userId: user && user.id, action: 'Requirement change sent to the BDE TL', entity: 'Requirement', entityId: requirement.id, toValue: list.map((c) => c.label).join(', ') });
  try {
    const tls = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', atsDepartment: 'BDE' }, select: { id: true } });
    await require('./notify').notifyUsers(tls.map((t) => t.id), { // eslint-disable-line global-require
      title: `✏️ ${requirement.reqCode || requirement.title}: changes to approve`,
      message: `${user ? user.name : 'Someone'} changed ${list.map((c) => c.label).join(', ')} on a live requirement. Approve or undo it on the requirement. Open: /requirements/${requirement.id}`,
    });
  } catch { /* the banner still shows */ }
  return list;
}

async function approve(requirementId, user) {
  const r = await of(requirementId);
  if (!r) return { error: 'There is nothing waiting for approval on this requirement.' };
  await prisma.$executeRawUnsafe('DELETE FROM "RequirementReview" WHERE "requirementId" = ?', String(requirementId));
  await logAudit({ userId: user && user.id, action: 'Requirement change approved by the BDE TL', entity: 'Requirement', entityId: requirementId, toValue: r.changes.map((c) => c.label).join(', '), reason: `Changed by ${r.byName || '—'}` });
  return { ok: true };
}
// Undo: the plain columns go back to their old values (lists such as departments / team leads are left as they are and said so)
async function undo(requirementId, user) {
  const r = await of(requirementId);
  if (!r) return { error: 'There is nothing waiting for approval on this requirement.' };
  const cols = new Set(Object.keys((await prisma.requirement.findUnique({ where: { id: String(requirementId) } })) || {}));
  const data = {}; const skipped = [];
  r.changes.forEach((c) => { if (cols.has(c.field)) data[c.field] = c.from; else skipped.push(c.label); });
  if (Object.keys(data).length) await prisma.requirement.update({ where: { id: String(requirementId) }, data });
  await prisma.$executeRawUnsafe('DELETE FROM "RequirementReview" WHERE "requirementId" = ?', String(requirementId));
  await logAudit({ userId: user && user.id, action: 'Requirement change undone by the BDE TL', entity: 'Requirement', entityId: requirementId, toValue: Object.keys(data).join(', '), reason: skipped.length ? `Not undone (change by hand): ${skipped.join(', ')}` : null });
  return { ok: true, undone: Object.keys(data), skipped };
}

module.exports = { of, afterEdit, approve, undo, keyChanges };
