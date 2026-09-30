/**
 * TeamLink.Enterprise <-> Job Portal, server to server.
 *
 * TeamLink.Enterprise is the ATS the recruiters work in. Its requirements
 * are the jobs this portal advertises, and the applications made here are
 * pipeline rows over there. Two directions, each with its own shared secret
 * so a leak of one does not open the other:
 *
 *   TeamLink -> portal   JOB_PORTAL_SYNC_TOKEN, sent as `x-teamlink-token`
 *     PUT  /api/integrations/teamlink/jobs/:requirementId   upsert one job
 *     POST /api/integrations/teamlink/jobs/sync             upsert many, close the rest
 *     GET  /api/integrations/teamlink/applications          catch-up pull
 *
 *   portal -> TeamLink   JOB_PORTAL_PUSH_SECRET, sent as `x-job-portal-secret`
 *     POST {TEAMLINK_API_URL}/api/public/job-portal/applications
 *     fired after an application commits (pushApplicationToTeamLink)
 *
 * A TeamLink job is an ordinary row in `jobs`, keyed `tl_<requirement id>`,
 * so it is found again on every sync and never duplicated. It belongs to the
 * agency's own company (TEAMLINK_COMPANY_ID, default `tmlink`, "TeamLink
 * Consultants"); the client is never named on the public board, which is
 * how the TeamLink feeds already behave.
 *
 * The token routes run as the `admin` database role - RLS still applies,
 * the admin branch of it. There is no session and no CSRF cookie: nothing
 * here rides on a browser, and without a session the CSRF guard has nothing
 * to protect. With no token configured every route answers 503 rather than
 * accepting anything.
 */
import { Router } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { withUser } from '../db.js';
import { wrap, ApiError, badRequest } from '../errors.js';
import { toCandidate } from '../shapes.js';
import { runJobAlertsInBackground } from '../notify/job-alerts.js';

const SYSTEM = { userId: '', role: 'admin' };
const PREFIX = 'tl_';

const syncToken = () => process.env.JOB_PORTAL_SYNC_TOKEN || '';
const pushSecret = () => process.env.JOB_PORTAL_PUSH_SECRET || '';
const teamlinkApi = () => String(process.env.TEAMLINK_API_URL || 'http://localhost:4010').replace(/\/+$/, '');
const companyId = () => process.env.TEAMLINK_COMPANY_ID || 'tmlink';

export const jobIdFor = (requirementId) => PREFIX + String(requirementId);
export const requirementIdOf = (jobId) =>
  (String(jobId || '').startsWith(PREFIX) ? String(jobId).slice(PREFIX.length) : null);

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

function requireToken(req, _res, next) {
  if (!syncToken()) {
    return next(new ApiError(503, 'NOT_CONFIGURED', 'JOB_PORTAL_SYNC_TOKEN is not set on the job portal.'));
  }
  if (!sameSecret(req.get('x-teamlink-token'), syncToken())) {
    return next(new ApiError(401, 'UNAUTHENTICATED', 'Invalid integration token.'));
  }
  next();
}

/* ------------------------------------------------------------------ *
 * jobs
 * ------------------------------------------------------------------ */

const str = (v, max = 200) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);
const list = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,\n]/))
  .map((s) => String(s).trim()).filter(Boolean).slice(0, 60).map((s) => s.slice(0, 200));

function cleanJob(body) {
  const b = body || {};
  const title = str(b.title, 160);
  if (!title || title.length < 2) throw badRequest('A job title is required.');
  const status = b.status === 'open' ? 'open' : 'closed';
  const openings = Math.max(1, Math.min(9999, parseInt(b.openings, 10) || 1));
  return {
    title,
    location: str(b.location, 120),
    mode: str(b.mode, 40),
    exp_label: str(b.exp, 40),
    pay_label: str(b.pay, 60),
    employment_type: str(b.type, 40),
    hiring_type: str(b.hiringType, 40),
    openings,
    department: str(b.department, 80),
    education: str(b.education, 120),
    skills: list(b.skills),
    description: b.desc == null ? null : String(b.desc).slice(0, 20000),
    responsibilities: list(b.responsibilities),
    requirements: list(b.requirements),
    status,
  };
}

async function ensureCompany(c) {
  await c.query(
    `insert into companies (id, name) values ($1, 'TeamLink Consultants') on conflict (id) do nothing`,
    [companyId()]);
}

/** Insert or update one TeamLink job. Returns { id, status, opened }. */
async function upsertJob(c, requirementId, body) {
  const id = jobIdFor(requirementId);
  const j = cleanJob(body);
  const before = await c.query(`select status from jobs where id=$1`, [id]);
  const was = before.rows[0] ? before.rows[0].status : null;

  // A closed requirement that never reached the portal has nothing to close.
  if (!was && j.status !== 'open') return { id, status: null, opened: false, skipped: true };

  const cols = Object.keys(j);
  const vals = cols.map((k) => j[k]);
  if (!was) {
    await ensureCompany(c);
    await c.query(
      `insert into jobs (id, company_id, source, posting_kind, easy_apply, published_at, ${cols.join(',')})
       values ($1, $2, 'teamlink', 'job', true, now(), ${cols.map((_, i) => `$${i + 3}`).join(',')})`,
      [id, companyId(), ...vals]);
  } else {
    await c.query(
      `update jobs set ${cols.map((k, i) => `${k}=$${i + 2}`).join(',')},
              paused = false, archived = false,
              published_at = case when $${cols.length + 2}='open' and published_at is null then now()
                                  else published_at end
        where id=$1`,
      [id, ...vals, j.status]);
  }
  return { id, status: j.status, opened: j.status === 'open' && was !== 'open', skipped: false };
}

/* ------------------------------------------------------------------ *
 * applications, shaped for TeamLink
 * ------------------------------------------------------------------ */

const APPLICATION_SQL = `
  select a.*, j.title as job_title
    from applications a
    join jobs j on j.id = a.job_id
   where a.job_id like 'tl\\_%'`;

async function shapeApplication(c, row) {
  const cand = (await c.query(`select * from candidates where id=$1`, [row.candidate_id])).rows[0];
  if (!cand) return null;
  const k = toCandidate(cand);
  return {
    event: 'application.created',
    requirementId: requirementIdOf(row.job_id),
    application: {
      id: row.id,
      reference: row.reference || null,
      jobId: row.job_id,
      jobTitle: row.job_title || null,
      stage: row.stage,
      source: row.source || null,
      matchScore: row.match_score == null ? null : Number(row.match_score),
      appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
    },
    candidate: {
      id: k.id,
      name: k.name,
      email: k.email || null,
      phone: k.phone || null,
      location: k.location || null,
      title: k.title || null,
      currentCompany: k.currentCompany || null,
      expYears: k.expYears == null ? null : k.expYears,
      skills: k.skills || [],
      education: k.education || null,
      noticePeriod: k.noticePeriod || null,
      expectedCtc: k.expectedCtc == null ? null : k.expectedCtc,
      resumeFile: k.resumeFile || null,
    },
  };
}

/**
 * Send one application to TeamLink. Never throws: an ATS being down must
 * not fail a candidate's application, and the hourly pull from TeamLink
 * picks up anything that did not get through.
 */
export async function pushApplicationToTeamLink(applicationId) {
  try {
    if (!pushSecret()) return { status: 'not_configured' };
    const payload = await withUser(SYSTEM, async (c) => {
      const row = (await c.query(`${APPLICATION_SQL} and a.id=$1`, [applicationId])).rows[0];
      return row ? shapeApplication(c, row) : null;
    });
    if (!payload) return { status: 'skipped', detail: 'not a TeamLink job' };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15_000);
    try {
      const res = await fetch(`${teamlinkApi()}/api/public/job-portal/applications`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-job-portal-secret': pushSecret() },
        body: JSON.stringify(payload),
      });
      const text = await res.text().catch(() => '');
      if (!res.ok) {
        console.error(`[teamlink] application ${applicationId} refused: ${res.status} ${text.slice(0, 200)}`);
        return { status: 'failed', code: res.status };
      }
      return { status: 'delivered' };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error(`[teamlink] application ${applicationId} not pushed: ${err.message}`);
    return { status: 'failed', detail: err.message };
  }
}

/* ------------------------------------------------------------------ *
 * routes
 * ------------------------------------------------------------------ */

export default function teamlinkIntegrationRoutes() {
  const r = Router();
  r.use('/integrations/teamlink', requireToken);

  r.put('/integrations/teamlink/jobs/:requirementId', wrap(async (req, res) => {
    const out = await withUser(SYSTEM, (c) => upsertJob(c, req.params.requirementId, req.body));
    if (out.opened) runJobAlertsInBackground(out.id);
    res.json({ job: out });
  }));

  /**
   * The full picture from TeamLink: every job it lists is upserted, and
   * with `closeOthers` every other open TeamLink job is closed - so a
   * requirement unpublished or closed while this portal was down is still
   * taken off the board on the next sync.
   */
  r.post('/integrations/teamlink/jobs/sync', wrap(async (req, res) => {
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    const closeOthers = req.body?.closeOthers === true;
    const out = await withUser(SYSTEM, async (c) => {
      const results = [];
      for (const j of jobs) {
        if (!j || !j.requirementId) continue;
        try {
          results.push({ requirementId: j.requirementId, ...(await upsertJob(c, j.requirementId, j)) });
        } catch (err) {
          results.push({ requirementId: j.requirementId, error: err.message });
        }
      }
      let closed = [];
      if (closeOthers) {
        const keep = results.filter((x) => x.status === 'open').map((x) => x.id);
        closed = (await c.query(
          `update jobs set status='closed'
            where id like 'tl\\_%' and status='open' and not (id = any($1::text[]))
          returning id`, [keep])).rows.map((x) => x.id);
      }
      /*
       * Requirements DELETED in TeamLink: `knownIds` is every requirement
       * TeamLink has ever published. A tl_* job outside it has no ATS record
       * behind it any more; if nobody applied to it, it is removed rather
       * than left as a closed orphan on the board. A job with applications
       * is never removed (it only stays closed). Each delete is its own
       * savepoint, so one job another table still points at cannot fail the
       * sync.
       */
      let pruned = [];
      const known = Array.isArray(req.body?.knownIds) ? req.body.knownIds.map((x) => jobIdFor(x)) : [];
      if (req.body?.pruneMissing === true && known.length) {
        const orphans = (await c.query(
          `select j.id from jobs j
            where j.id like 'tl\\_%' and not (j.id = any($1::text[]))
              and not exists (select 1 from applications a where a.job_id = j.id)`, [known])).rows.map((x) => x.id);
        for (const id of orphans) {
          await c.query('savepoint prune_job');
          try {
            await c.query(`delete from jobs where id=$1`, [id]);
            await c.query('release savepoint prune_job');
            pruned.push(id);
          } catch {
            await c.query('rollback to savepoint prune_job');
          }
        }
      }
      return { results, closed, pruned };
    });
    out.results.filter((x) => x.opened).forEach((x) => runJobAlertsInBackground(x.id));
    res.json(out);
  }));

  /**
   * Status back from TeamLink: where each application stands in the ATS,
   * already translated to this portal's stage ids, so the applicant sees
   * their progress here. Only TeamLink jobs (tl_*) are touched, only valid
   * stages are accepted, and an application already at that stage is left
   * alone - so a re-sync changes nothing and writes no second history row.
   * No notification is raised from here: the ATS owns candidate messaging.
   */
  r.post('/integrations/teamlink/applications/stages', wrap(async (req, res) => {
    const updates = Array.isArray(req.body?.updates) ? req.body.updates.slice(0, 5000) : [];
    const results = await withUser(SYSTEM, async (c) => {
      const valid = new Set((await c.query(`select id from stages`)).rows.map((x) => x.id));
      const out = [];
      for (const u of updates) {
        const id = str(u && u.id, 64);
        const stage = str(u && u.stage, 40);
        if (!id || !stage) { out.push({ id, error: 'id and stage are required' }); continue; }
        if (!valid.has(stage)) { out.push({ id, error: `"${stage}" is not a portal stage` }); continue; }
        const cur = await c.query(
          `select stage from applications where id=$1 and job_id like 'tl\\_%'`, [id]);
        if (!cur.rowCount) { out.push({ id, error: 'no such TeamLink application on the portal' }); continue; }
        if (cur.rows[0].stage === stage) { out.push({ id, changed: false, stage }); continue; }
        await c.query(`select set_config('app.stage_note', $1, true)`, [str(u.note, 500) || 'Updated from TeamLink']);
        await c.query(`update applications set stage=$1 where id=$2`, [stage, id]);
        out.push({ id, changed: true, from: cur.rows[0].stage, stage });
      }
      return out;
    });
    res.json({ results });
  }));

  r.get('/integrations/teamlink/applications', wrap(async (req, res) => {
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 500, 2000);
    const rows = await withUser(SYSTEM, async (c) => {
      const params = [];
      let sql = APPLICATION_SQL;
      if (since && !Number.isNaN(since.getTime())) {
        params.push(since.toISOString());
        sql += ` and a.applied_at >= $${params.length}`;
      }
      params.push(limit);
      sql += ` order by a.applied_at desc limit $${params.length}`;
      const found = (await c.query(sql, params)).rows;
      const shaped = [];
      for (const row of found) {
        const s = await shapeApplication(c, row);
        if (s) shaped.push(s);
      }
      return shaped;
    });
    res.json({ applications: rows });
  }));

  return r;
}
