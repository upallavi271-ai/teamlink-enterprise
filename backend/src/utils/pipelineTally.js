// ---------------------------------------------------------------------------
// THE TALLY OF CANDIDATES & PIPELINE — ONE definition of every count on the
// screen (the user, 2026-10-10: "tally the count properly").
//
// TWO KINDS OF COUNT, NEVER MIXED:
//   APPLICATIONS  one row per (person, job). A person on three jobs is three
//                 applications. Every number on the pipeline strip, the tiles,
//                 the Applications list and its total counts APPLICATIONS.
//   PEOPLE        distinct candidates (one row per person). Only the "People"
//                 tab and the "N people" line count people.
//   Plain labels everywhere: "applications" and "people", never "candidates"
//   for an application count.
//
// WHAT AN APPLICATION IS COUNTED AS (exactly one of these, so the parts add up):
//   Active   = Recruiter check + TL / BDE check + Sent to client + Client
//              shortlisted + Interview + Selected / offer      (still moving)
//   Joined   = the person started the job (stage Joined / HRMS employee)
//   On hold  = stage Hold                  (paused, not moving, not Active)
//   Rejected = stage Rejected              (closed, never deleted, not Active)
//   Active + Joined + On hold + Rejected = ALL applications (always).
//
// The sum is computed over the rows that match the login's AREA (its scope)
// and every filter on the screen EXCEPT the step / tab / quick queue the
// person clicked (so a click never changes its own number). A login that sees
// a smaller area, or has a filter on, therefore sees a smaller total: the
// equation holds for every login and every filter, and the screen says
// "filters on" whenever the total is narrowed.
//
// EVERY NUMBER OPENS ITS OWN LIST with exactly that many rows: a step is the
// stage filter of its keys (list tab "All"), Hold / Rejected / Joined are the
// list tabs of the same name, Active is the Active tab.
//
// IMPORTED AT A LATER STEP: rows imported from spreadsheets straight at
// Interview (or later) never went through "Sent to client" / "Client
// shortlisted" in TeamLink. importedAt() counts, per step, the applications
// that have NO stage event into Shared with client / Client review / Client
// shortlisted, so the funnel is not misread as "everyone was shown to a
// client first". The set of applications that DO have such an event is read
// with one GROUP BY and kept per data version.
//
// Other screens that count the same things (and how they differ, in plain
// words): the ATS dashboard "In process" (people with a live application:
// utils/atsHome.js, counted per PERSON), the Reports funnel (applications that
// EVER REACHED a step: cumulative, so each step includes later ones), and the
// job's Candidates tab (applications of that one job). See each screen's tooltip.
// ---------------------------------------------------------------------------
const prisma = require('../db');

// The seven steps, left to right. keys = the list's stage keys (stageKeyOf in
// routes/candidates.js). The frontend adds icon / colour; the words are here.
const STEPS = [
  { id: 'recruiter', label: 'Recruiter check', keys: ['recruiter_review'], hint: 'A person applied and the recruiter is checking them' },
  { id: 'lead', label: 'TL / BDE check', keys: ['tl_review', 'bde_review'], hint: 'Waiting for the team lead or the client manager (BDE) check' },
  { id: 'sent', label: 'Sent to client', keys: ['client_submitted'], hint: 'We sent the person to the client, and the client is looking' },
  { id: 'short', label: 'Client shortlisted', keys: ['client_shortlisted'], hint: 'The client shortlisted the person' },
  { id: 'interview', label: 'Interview', keys: ['interview_scheduled', 'interview_completed', 'feedback_pending'], hint: 'Interview booked or done, feedback awaited' },
  { id: 'offer', label: 'Selected / offer', keys: ['selected', 'offer'], hint: 'Selected, and the job offer is made' },
  { id: 'joined', label: 'Joined', keys: ['joined', 'hrms'], hint: 'The person started the job' },
];
const ACTIVE_STEP_IDS = STEPS.filter((s) => s.id !== 'joined').map((s) => s.id);
const STEP_OF_KEY = new Map();
STEPS.forEach((s) => s.keys.forEach((k) => STEP_OF_KEY.set(k, s.id)));
// Steps a person normally reaches only AFTER the client has seen them.
const AFTER_CLIENT = ['interview', 'offer', 'joined'];
const CLIENT_SEEN_STAGES = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED'];

// --- applications that went through a client step in TeamLink -------------------
let SEEN = { key: null, at: 0, ids: null };
let seenBuild = null;
const SEEN_MAX_AGE_MS = 10 * 60 * 1000;
async function clientSeenIds(version) {
  if (SEEN.ids && SEEN.key === version && Date.now() - SEEN.at < SEEN_MAX_AGE_MS) return SEEN.ids;
  if (seenBuild && seenBuild.key === version) return seenBuild.promise;
  const promise = (async () => {
    const rows = await prisma.applicationStageEvent.groupBy({ by: ['applicationId'], where: { toStage: { in: CLIENT_SEEN_STAGES } } });
    const ids = new Set(rows.map((r) => r.applicationId));
    SEEN = { key: version, at: Date.now(), ids };
    return ids;
  })().finally(() => { if (seenBuild && seenBuild.key === version) seenBuild = null; });
  seenBuild = { key: version, promise };
  return promise;
}

// rows = the list's rows with every filter on EXCEPT the step (see above).
// Returns the whole tally; `ok` is the equation (always true, asserted by the tests).
function tally(rows, seenIds = null) {
  const step = {};
  STEPS.forEach((s) => { step[s.id] = 0; });
  let hold = 0;
  let rejected = 0;
  let other = 0; // active, but at a step the strip does not know (should stay 0)
  const imported = {};
  AFTER_CLIENT.forEach((id) => { imported[id] = 0; });
  const people = new Set();
  rows.forEach((r) => {
    people.add(r.candidateId);
    if (r.pipelineStatus === 'Rejected') { rejected += 1; return; }
    if (r.pipelineStatus === 'Hold') { hold += 1; return; }
    const id = STEP_OF_KEY.get(r.stageKey);
    if (!id) { other += 1; return; }
    step[id] += 1;
    if (seenIds && AFTER_CLIENT.includes(id) && !seenIds.has(r.applicationId || r.id)) imported[id] += 1;
  });
  const active = ACTIVE_STEP_IDS.reduce((n, id) => n + step[id], 0) + other;
  const joined = step.joined;
  const total = rows.length;
  return {
    applications: total,
    people: people.size,
    active,
    joined,
    hold,
    rejected,
    other,
    steps: STEPS.map((s) => ({ id: s.id, label: s.label, hint: s.hint, keys: s.keys, count: step[s.id], importedCount: AFTER_CLIENT.includes(s.id) && seenIds ? imported[s.id] : null })),
    // Interview step: how many came in from imported sheets with no client step in TeamLink.
    importedAtInterview: seenIds ? imported.interview : null,
    ok: active + joined + hold + rejected === total,
  };
}

module.exports = { STEPS, STEP_OF_KEY, CLIENT_SEEN_STAGES, clientSeenIds, tally };
