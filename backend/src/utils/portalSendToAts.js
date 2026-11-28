// ---------------------------------------------------------------------------
// The Job Portal's "Send to ATS" for a requirement that is not published on the portal (embed/send-to-ats-stub.mjs): the ticked portal candidates are
// added to the requirement's pipeline here, with the SAME code a portal application comes in through (utils/jobPortalBridge.js ingestApplication:
// the candidate is found by e-mail / phone or created, one application per candidate and requirement, a repeat changes nothing). The recruiter who
// sent them owns the application, so they see it in their ATS Candidates list.
//   sendToAts(email, { requirementId, candidates }) -> { ok, results: [{ candidateId, name, outcome: 'added'|'already'|'refused', applicationId?, reason? }] }
// ---------------------------------------------------------------------------
const prisma = require('../db');
const bridge = require('./jobPortalBridge');
const { identityFor } = require('./portalOmniMirror');

const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

async function sendToAts(email, body, deps = {}) {
  const user = await (deps.identityFor || identityFor)(email);
  if (!user || !(user.products || {}).ats) return { ok: false, status: 403, error: 'Your portal login is not linked to a TeamLink recruiter login.' };
  const b = body || {};
  const requirement = await prisma.requirement.findUnique({ where: { id: clip(b.requirementId, 60) } });
  if (!requirement) return { ok: false, status: 404, error: 'That requirement is not in the ATS.' };
  if (requirement.status === 'CLOSED') return { ok: false, status: 409, error: 'That requirement is closed in the ATS, so nobody can be added to it.' };
  const list = Array.isArray(b.candidates) ? b.candidates.slice(0, 100) : [];
  if (!list.length) return { ok: false, status: 400, error: 'Select at least one candidate.' };
  const results = [];
  for (const c of list) { // eslint-disable-line no-restricted-syntax
    const id = clip(c && c.id, 80);
    const name = clip(c && c.name, 120).trim();
    if (!name || (!c.email && !c.phone)) { results.push({ candidateId: id, name, outcome: 'refused', reason: 'no name, e-mail or phone' }); continue; }
    try {
      // eslint-disable-next-line no-await-in-loop
      const out = await (deps.ingest || bridge.ingestApplication)({
        requirementId: requirement.id,
        ownerUserId: user.id,
        application: { id: `ats_${id}_${requirement.id}`, jobId: `tl_${requirement.id}`, source: 'Job Portal' },
        candidate: { ...c, id, name },
      });
      const o = (out && out.body) || {};
      if (out.status >= 400) results.push({ candidateId: id, name, outcome: 'refused', reason: o.error || 'could not be added' });
      else results.push({ candidateId: id, name, outcome: o.duplicate ? 'already' : 'added', applicationId: o.applicationId, stage: o.stage });
    } catch (err) { results.push({ candidateId: id, name, outcome: 'refused', reason: 'could not be added' }); console.error('[send-to-ats]', err.message); } // eslint-disable-line no-console
  }
  return { ok: true, results };
}

module.exports = { sendToAts };
