// ---------------------------------------------------------------------------
// THE CREATION GUARD — one helper for EVERY door that makes a job (the Add job form · "Request a job" / the client portal's
// request · Copy job · Excel / data import · ATS import · API). "This looks like a job you already have."
//
//   guardCreate(body, { user, door, silent })
//        -> { block: { status: 409, body } | null, matches, override }
//     * a CERTAIN twin blocks the save until one of the buttons is used: Open the existing job · Add openings to the existing job ·
//       Create anyway (different job, a short reason) · Cancel.   -> 409 DUPLICATE_JOB with the matches.
//     * a LIKELY twin shows the same card; "Create anyway" needs no reason.
//     * silent (an import): never blocks. The twin is found later in Jobs > Duplicate jobs (nothing is held, nobody is bothered).
//   afterCreate(newJob, matches, { user, reason, door })   remembers 'Not a duplicate' for the pair after "Create anyway".
//
// The body fields are the ones the form already sends: duplicateOverride (true) + duplicateReason (text).
// NEVER throws: if anything fails the job is saved as before. Needs no table (the memory of "Not a duplicate" needs the migration).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const D = require('./jobDupes');

const reasonOf = (body) => String((body && body.duplicateReason) || '').trim().slice(0, 300);
const overrideOn = (body) => !!body && (body.duplicateOverride === true || body.duplicateOverride === 'true');

async function counts(ids) {
  const map = new Map(ids.map((i) => [i, 0]));
  if (!ids.length) return map;
  try {
    const rows = await prisma.application.groupBy({ by: ['requirementId'], where: { requirementId: { in: ids } }, _count: { _all: true } });
    rows.forEach((r) => map.set(r.requirementId, r._count._all));
  } catch { /* zero */ }
  return map;
}

// the cards (what the screen shows) for a draft
async function cardFor(draft, { excludeId = null } = {}) {
  let found = [];
  try { found = await D.matchesForNew(draft, { excludeId }); } catch { return []; }
  const relevant = found.filter((m) => ['CERTAIN', 'LIKELY', 'CLOSED'].includes(m.level)).slice(0, 3);
  if (!relevant.length) return [];
  const n = await counts(relevant.map((m) => m.job.id));
  return relevant.map((m) => ({
    id: m.job.id, reqCode: m.job.reqCode, title: m.job.title, status: m.job.status, openings: m.job.openings, location: m.job.location || null,
    createdAt: m.job.createdAt, candidates: n.get(m.job.id) || 0, level: m.level, reasons: m.reasons,
    canAddOpenings: m.job.status !== 'CLOSED',
  }));
}

function cardText(m) {
  const when = m.createdAt ? new Date(m.createdAt).toISOString().slice(0, 10) : '';
  return `This looks like a requirement you already have: ${m.title} (${m.reqCode || 'no code'}), ${String(m.status || '').toLowerCase().replace(/_/g, ' ')}, ${m.candidates} ${m.candidates === 1 ? 'person' : 'people'} on it, opened ${when}.`;
}

async function guardCreate(body, { user, door = 'Add requirement', silent = false, excludeId = null } = {}) {
  const none = { block: null, matches: [], override: false };
  try {
    const draft = {
      clientId: body.clientId, title: body.title, specialisation: body.specialisation, location: body.location, openings: body.openings,
      experience: body.experience, salary: body.salary, employmentType: body.employmentType, skills: body.skills,
      jobDescription: body.jobDescription, description: body.description, department: body.department, internal: !!body.internal,
    };
    const matches = await cardFor(draft, { excludeId });
    const live = matches.filter((m) => m.level !== 'CLOSED');
    if (!live.length) return { ...none, matches };
    if (silent) return { block: null, matches: live, override: false, silent: true };
    const worst = live.some((m) => m.level === 'CERTAIN') ? 'CERTAIN' : 'LIKELY';
    const reason = reasonOf(body);
    const override = overrideOn(body) && (worst === 'LIKELY' || reason.length >= 5);
    if (override) return { block: null, matches: live, override: true, reason };
    const first = live[0];
    return {
      block: {
        status: 409,
        body: {
          code: 'DUPLICATE_JOB', level: worst, error: cardText(first), matches: live, needsReason: worst === 'CERTAIN', door,
          existing: { id: first.id, reqCode: first.reqCode, title: first.title, location: first.location, status: first.status, openings: first.openings },
          buttons: ['open', 'add-openings', 'create-anyway', 'cancel'],
        },
      },
      matches: live, override: false,
    };
  } catch (e) {
    return none; // the job is saved as before
  }
}

async function afterCreate(job, matches, { user, reason, door } = {}) {
  try {
    if (!job || !matches || !matches.length) return;
    for (const m of matches) {
      // eslint-disable-next-line no-await-in-loop
      await D.rememberNotDuplicate(job.id, m.id, { reason: reason || 'Created anyway: a different requirement', user, door });
    }
  } catch { /* the memory is a courtesy */ }
}

// A quiet audit line for a door that does not block (an import): the twin is on the worklist.
async function noteSilent(job, matches, { user, door } = {}) {
  try {
    if (!job || !matches || !matches.length) return;
    const { logAudit } = require('./audit'); // eslint-disable-line global-require
    await logAudit({ userId: user ? user.id : null, actorName: user ? user.name : null, action: 'Possible duplicate requirement noticed', entity: 'Requirement', entityId: job.id, toValue: matches.map((m) => m.reqCode || m.id).join(','), reason: `Saved by ${door || 'an import'}; it looks like ${matches[0].reqCode || matches[0].title}. See Requirements > Duplicate requirements.` });
  } catch { /* quiet */ }
}

module.exports = { guardCreate, afterCreate, noteSilent, cardFor, cardText };
