// WHO MAY DO WHAT (the server decides; the screens only hide buttons).
//   run (import lists, run campaigns, post everywhere): TL, BDE, BDE TL, Admin, Super Admin.
//   view only: Manager, Assistant Manager, STL (all), HR (campaigns of INTERNAL jobs only).
//   Recruiter, Accountant, client, candidate: nothing.
//   Numbers are masked for BDE and BDE TL (the server never sends them the full number).
const scope = require('../utils/scope');
const { can } = require('../middleware/auth');

const external = (u) => [u.role, u.atsRole].some((r) => ['CLIENT', 'CANDIDATE'].includes(r));
function kind(user) {
  if (!user || external(user)) return 'none';
  const v = scope.atsViewRole(user);
  if (v === 'admin') return 'admin';
  if (scope.isBdeTl(user)) return 'bdetl';
  if (v === 'bde') return 'bde';
  if (v === 'tl') return 'tl';
  if (v === 'mgmt') return 'view';
  if (v === 'stl') return 'view';
  if (v === 'hr') return 'hr';
  return 'none'; // recruiter, accountant, anything else
}
const mayRun = (u) => ['admin', 'bdetl', 'bde', 'tl'].includes(kind(u));
const mayView = (u) => ['admin', 'bdetl', 'bde', 'tl', 'view', 'hr'].includes(kind(u));
const seesAll = (u) => ['admin', 'view'].includes(kind(u));
const masked = (u) => ['bde', 'bdetl'].includes(kind(u));
const isAdmin = (u) => kind(u) === 'admin';
// HR sees internal jobs only
async function mayViewJob(user, requirement) {
  if (!requirement) return false;
  if (kind(user) === 'hr') return !!requirement.internal;
  return true;
}
async function mayPostJob(user, requirement) {
  const access = require('../jobPublish/access'); // eslint-disable-line global-require
  return !!(requirement && mayRun(user) && (await access.mayPost(user, requirement)));
}
async function mayAddCandidate(user) { return !!(await can(user, 'ats', 'candidates', 'Add Candidate', 'create').catch(() => false)); }
module.exports = { kind, mayRun, mayView, seesAll, masked, isAdmin, mayViewJob, mayPostJob, mayAddCandidate, external };
