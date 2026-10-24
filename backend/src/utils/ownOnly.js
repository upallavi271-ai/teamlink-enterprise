// ---------------------------------------------------------------------------
// A RECRUITER SEES ONLY THEIR OWN NUMBERS IN REPORTS (user, 2026-10-12: "Recruiter ki Reports lo, only
// valla Reports matrame visible").
//
// One rule, enforced on the SERVER, whatever the screen shows and whatever filter, id or person the URL
// or the body asks for:
//   * a plain Recruiter (ATS role Recruiter) gets rows and people = themselves only;
//   * no team totals, no other recruiter's name / id / number, no company totals, no comparison or
//     ranking against others, no client revenue / cash;
//   * a TL, STL, Manager, Assistant Manager, Admin, HR, BDE, BDE TL keep exactly what they had.
//
// This file holds the rule and the small helpers every report route uses, so the "who is own-only"
// question has ONE answer (utils/scope.js atsViewRole() === 'recruiter', the same word reportPack.js and
// dailyReport.js already use for "see only yourself").
// ---------------------------------------------------------------------------
const { atsViewRole } = require('./scope');

const OWN_ONLY_MESSAGE = 'Your reports show only your own numbers. Open "My results" to see them.';
const OWN_ONLY_PLAIN = 'Team, client-wise, source-wise and money reports are for team leads and managers. Your own numbers are under My results.';

// The ATS reports a recruiter may open (every one is cut to their own people before it is counted):
//   funnel      my steps: applied -> screened -> sent -> interview -> selected -> joined
//   candidates  where my candidates are now
//   interviews  my interviews
//   followups   my follow-ups
//   joining     my joinings
const OWN_REPORTS = ['funnel', 'candidates', 'interviews', 'followups', 'joining'];

// Query keys that name a person, a team or a seat: a recruiter's own request never carries them.
const PEOPLE_KEYS = ['recruiter', 'recruiterId', 'tl', 'tlId', 'stl', 'stlId', 'bde', 'bdeId', 'team', 'person', 'owner', 'ownerId',
  'positionCode', 'section', 'people', 'seat', 'userId'];

function isOwnOnly(user) {
  if (!user) return false;
  try { return atsViewRole(user) === 'recruiter'; } catch { return false; }
}

const keyOf = (user) => `u:${user.id}`;

// The query a recruiter's report is read with: people filters removed, then themselves put in.
// (Mutates and returns the object the router gave, so downstream code reading req.query sees it.)
function ownQuery(user, query, keep = []) {
  const q = query || {};
  PEOPLE_KEYS.forEach((k) => { if (!keep.includes(k)) delete q[k]; });
  q.recruiter = `id:${user.id}`;
  return q;
}

// Express middleware: from here on, this request is the recruiter's own.
function forceOwnQuery(req, res, next) {
  if (isOwnOnly(req.user)) ownQuery(req.user, req.query);
  return next();
}

// Express middleware: this router is not for a recruiter at all.
function refuseOwnOnly(message = OWN_ONLY_PLAIN) {
  return (req, res, next) => (isOwnOnly(req.user) ? res.status(403).json({ error: message }) : next());
}

// A list of people options ({ id | value , label }) cut to the recruiter alone.
function onlySelf(user, list, idOf = (o) => o.value || o.id) {
  const self = String(user.id);
  return (list || []).filter((o) => {
    const v = String(idOf(o) || '');
    return v === `u:${self}` || v === self || v === `id:${self}`;
  });
}

// The applications that are THIS recruiter's own work (utils/workers.js attribute(), the rule every report uses), as a Set of ids;
// null for anyone who is not own-only. The AI assistant's lists and counts use it, so a recruiter is never told a colleague's numbers.
async function ownApplicationIds(user) {
  if (!isOwnOnly(user)) return null;
  const ctx = await require('../routes/atsReports').packContext(user, { recruiter: `id:${user.id}` }, 'createdAt'); // eslint-disable-line global-require
  return new Set(ctx.apps.map((x) => x.id));
}

// The Team page's payloads (GET /ats/team ...) for a recruiter: a job they share names its co-recruiters, a list of next steps may belong to a
// colleague. Other recruiters' names / rows are taken out; the recruiter's own jobs, candidates and team lead stay.
let OTHERS = { at: 0, map: new Map() };
async function otherRecruiters(user) {
  if (Date.now() - OTHERS.at > 60000) {
    const rows = await require('../db').user.findMany({ where: { atsRole: 'RECRUITER' }, select: { id: true, name: true } }); // eslint-disable-line global-require
    OTHERS = { at: Date.now(), map: new Map(rows.map((r) => [r.id, r.name])) };
  }
  const names = new Set();
  const ids = new Set();
  OTHERS.map.forEach((name, id) => { if (id !== user.id) { ids.add(id); names.add(String(name).trim().toLowerCase()); } });
  return { ids, names };
}
async function scrubTeamPayload(user, body) {
  if (!isOwnOnly(user) || !body || typeof body !== 'object') return body;
  const { ids, names } = await otherRecruiters(user);
  const isOther = (name) => names.has(String(name || '').trim().toLowerCase());
  const NAME_FIELDS = ['recruiter', 'recruiterName', 'owner', 'ownerName'];
  const walk = (v, key) => {
    if (Array.isArray(v)) {
      if (key === 'recruiters') return v.filter((x) => !(x && (ids.has(x.id) || ids.has(x.userId) || isOther(x.name)))).map((x) => walk(x));
      if (key === 'rows') return v.filter((x) => !(x && typeof x === 'object' && (ids.has(x.ownerUserId) || ids.has(x.userId)))).map((x) => walk(x));
      return v.map((x) => walk(x));
    }
    if (v && typeof v === 'object') {
      const o = {};
      Object.keys(v).forEach((k) => { o[k] = walk(v[k], k); });
      return o;
    }
    if (typeof v === 'string' && NAME_FIELDS.includes(key)) {
      const kept = v.split(',').map((s) => s.trim()).filter((s) => s && !isOther(s));
      return kept.length ? kept.join(', ') : null;
    }
    return v;
  };
  return walk(body);
}
function scrubTeamMiddleware(req, res, next) {
  if (isOwnOnly(req.user)) {
    const json = res.json.bind(res);
    res.json = (body) => { scrubTeamPayload(req.user, body).then((out) => json(out), () => json(body)); return res; };
  }
  next();
}

// Questions a recruiter's assistant must not answer from the team's or the company's numbers.
const TEAM_QUESTION = /(other recruiters?|whole team|team('s)? (total|report|performance|numbers?|joinings?|calls?)|how is (my|the) team|company (total|numbers?)|recruiter[- ]?wise|each recruiter|all recruiters|(top|best|worst|lowest|highest) recruiter|rank(ing)?|leaderboard|compare (me|with|to)|who (is|has|did) (the )?(best|most|least|highest|lowest|top)|revenue|client[- ]?wise|source[- ]?wise)/i;
const TEAM_REFUSAL = 'Your reports show only your own numbers, so I can only answer about your own work. Open "My reports" to see them.';

module.exports = {
  scrubTeamPayload, scrubTeamMiddleware, ownApplicationIds, TEAM_QUESTION, TEAM_REFUSAL,
  OWN_ONLY_MESSAGE, OWN_ONLY_PLAIN, OWN_REPORTS, PEOPLE_KEYS, isOwnOnly, keyOf, ownQuery, forceOwnQuery, refuseOwnOnly, onlySelf,
};
