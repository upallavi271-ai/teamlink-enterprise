// ---------------------------------------------------------------------------
// OMNI-CHANNEL > JOB PROMOTIONS > DISTRIBUTION: the jobs in the viewer's own area, each with how many places it is posted on, waiting for and expired on.
// NO duplicate logic: it asks the job Posting tracker (jobDist/tracker.js, the same numbers as the Jobs list "Posting tracker") for the job x place rows and
// only groups them per job. Scope = the same requirement scope the tracker uses (jobPublish/access.scopedIds): a Recruiter / TL / BDE sees their own jobs.
//   posted    marked posted and not expiring     expiring  expires within the reminder days     expired   the expiry date passed
//   waiting   an open job that is not on that place yet (the tracker's "pending")     takenDown  taken down
// The tracker lists at most 1000 job x place rows per call; if there are more, `partial` is true and the screen says so.
// Places TeamLink posts by itself (careers page, Telegram, Facebook ...) are not in the tracker, so they are not counted here (said on the screen).
// If job distribution is not switched on (its migration is not applied) the answer is { notReady: true } and the screen says so in plain words.
// ---------------------------------------------------------------------------
const A = require('./access');

async function summary(user, { q } = {}) {
  if (!A.seesDistribution(user)) return { error: 'Your login cannot open Distribution.', status: 403 };
  let Plat; let Track; let access;
  try { Plat = require('../jobDist/platforms'); Track = require('../jobDist/tracker'); access = require('../jobPublish/access'); } catch { return { notReady: true, jobs: [], counts: {} }; } // eslint-disable-line global-require
  let ready = false;
  try { ready = await Plat.ready(); } catch { ready = false; }
  if (!ready) return { notReady: true, jobs: [], counts: {} };
  const ids = await access.scopedIds(user);
  const f = { limit: 1000, q: q ? String(q).slice(0, 80) : undefined };
  const all = await Track.tracker(user, f, ids);
  let pend = await Track.tracker(user, { ...f, status: 'pending' }, ids);
  // the tracker lists at most 1000 job x place rows per call: when there are more, ask place by place (each call lists up to 1000 jobs) so every job is counted
  if ((pend.total || 0) > (pend.rows || []).length) {
    const rows = []; const seen = new Set();
    for (const p of all.byPlatform || []) {
      const one = await Track.tracker(user, { ...f, status: 'pending', platform: p.key }, ids); // eslint-disable-line no-await-in-loop
      (one.rows || []).forEach((r) => { const k = `${r.requirementId}|${r.platform}`; if (!seen.has(k)) { seen.add(k); rows.push(r); } });
      if ((one.total || 0) > (one.rows || []).length) pend = { ...pend, truncatedPlace: true };
    }
    pend = { ...pend, rows, total: pend.truncatedPlace ? pend.total : rows.length };
  }
  const jobs = new Map();
  const job = (r) => { if (!jobs.has(r.requirementId)) jobs.set(r.requirementId, { id: r.requirementId, title: r.title, reqCode: r.reqCode || null, jobStatus: r.jobStatus || null, posted: 0, expiring: 0, expired: 0, waiting: 0, takenDown: 0, applicants: 0 }); return jobs.get(r.requirementId); };
  (all.rows || []).forEach((r) => { const j = job(r); if (r.status === 'posted') j.posted += 1; else if (r.status === 'expiring') j.expiring += 1; else if (r.status === 'expired') j.expired += 1; else if (r.status === 'taken_down') j.takenDown += 1; j.applicants += r.applicants || 0; });
  (pend.rows || []).forEach((r) => { job(r).waiting += 1; });
  const list = [...jobs.values()].sort((a, b) => (b.expired - a.expired) || (b.expiring - a.expiring) || (b.waiting - a.waiting) || String(a.title).localeCompare(String(b.title)));
  const partial = (all.total || 0) > (all.rows || []).length || (pend.total || 0) > (pend.rows || []).length;
  return {
    notReady: false, openJobs: all.openJobs || 0, reminderDays: all.reminderDays, partial, places: (all.byPlatform || []).length,
    counts: { posted: all.counts.posted || 0, expiring: all.counts.expiring || 0, expired: all.counts.expired || 0, waiting: all.counts.pending || 0, jobsNotPosted: all.counts.jobsNotPosted || 0 },
    jobs: list.slice(0, 300), total: list.length,
  };
}
module.exports = { summary };
