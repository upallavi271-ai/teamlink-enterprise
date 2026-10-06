// ---------------------------------------------------------------------------
// DUPLICATE JOB CHECK (ATS-100 B9.1) — the import-time rule
// (routes/atsIo.js RULES.requirements: same client + same job title) applied
// to the Add job / Edit job forms as well, with the location added so the
// same role in two cities is two jobs:
//
//   same client + same title (case / spacing ignored)
//   + same location (when both name one)        among jobs that are still OPEN
//
// The form shows the existing job and offers "Create anyway" with a reason,
// which is recorded in the audit trail. Never applied to Save Draft.
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { REQUIREMENT_LIVE_STATUSES } = require('./atsVocab');

const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
// The first city of "Hyderabad, Bengaluru" / "Hyderabad / Pune".
const cityOf = (v) => norm(String(v || '').split(/[,/|]/)[0]);

// Still open = live, or parked at the agreement gate (it becomes live on its own).
const OPEN_STATUSES = [...new Set([...REQUIREMENT_LIVE_STATUSES, 'AGREEMENT_CHECK'])];

async function findDuplicateJob({ clientId, title, location, excludeId = null }) {
  const t = norm(title);
  if (!clientId || !t) return null;
  const rows = await prisma.requirement.findMany({
    where: { clientId, status: { in: OPEN_STATUSES }, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, reqCode: true, title: true, location: true, status: true, createdAt: true, openings: true, recruiterId: true },
    orderBy: { createdAt: 'desc' },
  });
  const loc = cityOf(location);
  return rows.find((r) => norm(r.title) === t && (!loc || !cityOf(r.location) || cityOf(r.location) === loc)) || null;
}

// What the form gets back (409). The reason the caller gives on "Create
// anyway" has to say something (5+ characters).
function duplicateRefusal(existing, { editing = false } = {}) {
  const where = existing.location ? ` in ${existing.location}` : '';
  return {
    code: 'DUPLICATE_JOB',
    error: `A job called "${existing.title}"${where} is already open for this client (${existing.reqCode || existing.id}). ${editing ? 'Save anyway' : 'Create anyway'} only if this really is a second job — say why.`,
    existing: {
      id: existing.id, reqCode: existing.reqCode, title: existing.title, location: existing.location, status: existing.status, openings: existing.openings,
    },
  };
}

const overrideReasonOf = (body) => String((body && body.duplicateReason) || '').trim().slice(0, 300);
const overrideOk = (body) => !!body && body.duplicateOverride === true && overrideReasonOf(body).length >= 5;

// Did a title / location edit actually change the job's identity (spacing
// and case ignored)? A trailing space is not a rename.
const identityChanged = (data, before) => (
  ('title' in data && norm(data.title) !== norm(before.title))
  || ('location' in data && cityOf(data.location) !== cityOf(before.location))
);

module.exports = {
  findDuplicateJob, duplicateRefusal, overrideOk, overrideReasonOf, OPEN_STATUSES, identityChanged, norm, cityOf,
};
