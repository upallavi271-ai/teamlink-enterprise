// ---------------------------------------------------------------------------
// TEMPLATES PAGE: the four small tables that have no older home (self-provisioned: CREATE TABLE IF NOT EXISTS on first use; the same SQL is in the
// migration folder 20261017130000_omni_gs_templates_studio):
//   OmniRcsAgent     an RCS assistant made with the 5-step wizard (the whole wizard form is kept in `data`)
//   OmniRcsTemplate  an RCS message (plain text / card / carousel) of one agent (`form` = the editor's fields)
//   OmniWaFlow       a WhatsApp Flow definition (screens); publishing is Planned
//   OmniVoiceScript  a saved voice script (what a call says)
// Shared rules: who sees a row (audience: 'candidate_lead' = the job side, 'internal' = the staff side) and who may write it.
// ---------------------------------------------------------------------------
const S = require('./store');
const A = require('./access');

const COMMON = '"audience" TEXT NOT NULL DEFAULT \'candidate_lead\', "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0, "deletedAt" DATETIME';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "OmniRcsAgent" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'saved', "data" TEXT NOT NULL DEFAULT '{}', ${COMMON})`,
  `CREATE TABLE IF NOT EXISTS "OmniRcsTemplate" ("id" TEXT NOT NULL PRIMARY KEY, "agentId" TEXT NOT NULL, "name" TEXT NOT NULL, "type" TEXT NOT NULL DEFAULT 'text', "status" TEXT NOT NULL DEFAULT 'draft', "form" TEXT NOT NULL DEFAULT '{}', ${COMMON})`,
  'CREATE INDEX IF NOT EXISTS "OmniRcsTemplate_agent" ON "OmniRcsTemplate"("agentId", "updatedAt")',
  `CREATE TABLE IF NOT EXISTS "OmniWaFlow" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'saved', "screens" TEXT NOT NULL DEFAULT '[]', ${COMMON})`,
  `CREATE TABLE IF NOT EXISTS "OmniVoiceScript" ("id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "category" TEXT NOT NULL DEFAULT 'Utility', "language" TEXT, "script" TEXT NOT NULL DEFAULT '', "audio" TEXT, "status" TEXT NOT NULL DEFAULT 'active', ${COMMON})`,
];
let okAt = 0;
async function ensure() {
  if (okAt && Date.now() - okAt < 600000) return true;
  try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-templates] schema:', e.message); return false; } // eslint-disable-line no-await-in-loop, no-console
}
const parse = (v, d) => { try { return v ? JSON.parse(v) : d; } catch { return d; } };

// may this login write job-side / staff-side things of its own? (same people as the templates.js canEdit)
const mayWrite = (u) => A.has('canEditTemplates')(u) || A.has('canEditInternalTemplates')(u);
const audienceOfWriter = (u) => (A.kind(u) === 'hr' ? 'internal' : 'candidate_lead');
// HR sees the staff side only; Admin both; everybody else the job side. Then the department rule.
function sees(u, r) {
  if (r.deletedAt) return false;
  const k = A.kind(u);
  if (k === 'hr' && r.audience !== 'internal') return false;
  if (k !== 'admin' && k !== 'hr' && r.audience === 'internal') return false;
  return A.mayDepartment(u, r.department || '');
}
const mayChange = (u, r) => mayWrite(u) && (A.isAdmin(u) || r.createdById === u.id || !r.createdById || (A.kind(u) === 'hr' && r.audience === 'internal'));
const nameClash = async (table, name, exceptId, extra = '', ...p) => (await S.q(`SELECT id FROM "${table}" WHERE deletedAt IS NULL AND LOWER(name) = LOWER(?) AND id <> ? ${extra}`, name, exceptId || '', ...p))[0];

module.exports = { ensure, DDL, parse, mayWrite, audienceOfWriter, sees, mayChange, nameClash };
