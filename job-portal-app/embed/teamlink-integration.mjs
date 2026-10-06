/**
 * TeamLink.Enterprise <-> Job Portal, server to server (portal side).
 *
 * Lives OUTSIDE the portal folder on purpose: the portal (../job_portal-main)
 * is the customer's application and is kept byte-for-byte as supplied. The
 * host (./host.mjs) puts this router in front of the portal app at start-up.
 * It reads and writes the portal's database through the portal's OWN modules
 * (api/src/db.js withUser, shapes.js, storage.js), so row-level security and
 * the portal's triggers still apply exactly as they do for its own routes.
 *
 * TeamLink.Enterprise is the ATS the recruiters work in. Its requirements are
 * the jobs this portal advertises, and the applications made here are
 * pipeline rows over there. Two directions, each with its own shared secret:
 *
 *   TeamLink -> portal   JOB_PORTAL_SYNC_TOKEN, header `x-teamlink-token`
 *     PUT  /api/integrations/teamlink/jobs/:requirementId   upsert one job
 *     POST /api/integrations/teamlink/jobs/sync             upsert many, close the rest
 *     GET  /api/integrations/teamlink/applications          catch-up pull
 *     GET  /api/integrations/teamlink/applications/:id/resume   the resume file
 *     POST /api/integrations/teamlink/applications/stages   ATS status back
 *
 *   portal -> TeamLink   JOB_PORTAL_PUSH_SECRET, header `x-job-portal-secret`
 *     POST {TEAMLINK_API_URL}/api/public/job-portal/applications
 *     sent within seconds of an application: the router sees every successful
 *     POST /api/applications* the portal answers and pushes the new
 *     application(s) on TeamLink jobs; a 15 s sweep catches anything missed.
 *     TeamLink's ingest is idempotent, so a second delivery changes nothing.
 *
 * A TeamLink job is an ordinary row in `jobs`, keyed `tl_<requirement id>`,
 * owned by the agency's own company (TEAMLINK_COMPANY_ID, default `tmlink`,
 * "TeamLink Consultants"); the client is never named on the public board.
 * With no token configured every route answers 503.
 *
 * (Adapted from the api/src/integrations/teamlink.js that the previous
 * portal copy carried - kept in backups/job-portal-before-v2-*.)
 */
import { timingSafeEqual } from 'node:crypto';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const SYSTEM = { userId: '', role: 'admin' };
const PREFIX = 'tl_';

const syncToken = () => process.env.JOB_PORTAL_SYNC_TOKEN || '';
const pushSecret = () => process.env.JOB_PORTAL_PUSH_SECRET || '';
const teamlinkApi = () => String(process.env.TEAMLINK_API_URL || 'http://127.0.0.1:4010').replace(/\/+$/, '');
const companyId = () => process.env.TEAMLINK_COMPANY_ID || 'tmlink';
// Job alerts to the portal's own candidates when an ATS job opens. OFF unless
// asked for: TeamLink keeps candidate e-mails switched off by default.
const jobAlertsOn = () => /^(1|true|yes|on)$/i.test(String(process.env.TEAMLINK_JOB_ALERTS || ''));

export const jobIdFor = (requirementId) => PREFIX + String(requirementId);
export const requirementIdOf = (jobId) =>
  (String(jobId || '').startsWith(PREFIX) ? String(jobId).slice(PREFIX.length) : null);

const log = (...a) => console.log(new Date().toISOString(), '[teamlink]', ...a);

/* The portal's own modules, imported LAZILY: api/src/config.js reads the
   environment once at import, and dev-server.mjs sets it (DATABASE_URL for
   the embedded database, AUTH_SECRET, PUBLIC_ORIGIN ...) only after it has
   started. By the time a request arrives, it has. */
let ROOT = '';
let mods = null;
async function portal() {
  if (mods) return mods;
  const at = (p) => import(pathToFileURL(join(ROOT, 'api', 'src', p)).href);
  const [db, errors, shapes, storage] = await Promise.all([at('db.js'), at('errors.js'), at('shapes.js'), at('storage.js')]);
  let alerts = null;
  try { alerts = await at('notify/job-alerts.js'); } catch { alerts = null; }
  mods = { withUser: db.withUser, ApiError: errors.ApiError, toCandidate: shapes.toCandidate, getStorage: storage.getStorage, alerts };
  return mods;
}

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
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
  if (!title || title.length < 2) throw new HttpError(400, 'VALIDATION_FAILED', 'A job title is required.');
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

function kickAlerts(jobId) {
  if (!jobAlertsOn() || !mods || !mods.alerts || !mods.alerts.runJobAlertsInBackground) return;
  try { mods.alerts.runJobAlertsInBackground(jobId); } catch (err) { log('job alerts not started:', err.message); }
}

/* ------------------------------------------------------------------ *
 * where an applicant came from (ATS-100 B6, 2026-10-06)
 *
 * The portal records ONE source per application (its own ?src= / ?ref= /
 * utm_source capture, kept in the browser). TeamLink also wants the rest
 * of a campaign link - utm_medium, utm_campaign, utm_content - and the
 * referral code (?ref=<code>). Without touching the portal: when a page is
 * opened with any of those in its address, this host sets a small
 * session cookie (tl_attr, HttpOnly, the tab's visit only), and when the
 * portal accepts POST /api/applications it remembers that cookie against
 * the new application id. shapeApplication() sends it as `attribution`.
 * Remembered in run/attribution.json so a restart does not lose it.
 * ------------------------------------------------------------------ */
const ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'ref', 'src'];
const ATTR_COOKIE = 'tl_attr';
const ATTR_FILE = join(process.env.JP_PIDFILE ? dirname(process.env.JP_PIDFILE) : join(import.meta.dirname, '..', 'run'), 'attribution.json');
const ATTR_MAX = 5000;
let attrMap = null;
function attrStore() {
  if (attrMap) return attrMap;
  attrMap = new Map();
  try { Object.entries(JSON.parse(readFileSync(ATTR_FILE, 'utf8'))).forEach(([k, v]) => attrMap.set(k, v)); } catch { /* none yet */ }
  return attrMap;
}
function attrSave() {
  try {
    const m = attrStore();
    while (m.size > ATTR_MAX) m.delete(m.keys().next().value);
    mkdirSync(dirname(ATTR_FILE), { recursive: true });
    const tmp = `${ATTR_FILE}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)));
    renameSync(tmp, ATTR_FILE);
  } catch (err) { log('attribution not saved:', err.message); }
}
const attrClean = (v) => String(v == null ? '' : v).replace(/[^\p{L}\p{N} ._+\-/:&]/gu, '').trim().slice(0, 100);
/** The attribution keys in a query object, cleaned; null when there are none. */
export function attributionFromQuery(q) {
  const out = {};
  ATTR_KEYS.forEach((k) => { const v = attrClean(q && q[k]); if (v) out[k] = v; });
  return Object.keys(out).length ? out : null;
}
export function attributionFromCookie(header) {
  const m = new RegExp(`(?:^|;\\s*)${ATTR_COOKIE}=([^;]+)`).exec(String(header || ''));
  if (!m) return null;
  try { return attributionFromQuery(JSON.parse(Buffer.from(decodeURIComponent(m[1]), 'base64url').toString('utf8'))); } catch { return null; }
}
export function rememberAttribution(applicationId, attr) {
  if (!applicationId || !attr) return;
  attrStore().set(String(applicationId), { ...attr, at: new Date().toISOString() });
  attrSave();
}
const attributionOf = (applicationId) => attrStore().get(String(applicationId)) || null;

/** Middleware: set the cookie on arrival; remember it when an application is made. */
export function attributionMiddleware(req, res, next) {
  try {
    if (req.method === 'GET' && req.query) {
      const a = attributionFromQuery(req.query);
      if (a) {
        const prefix = String(req.get('x-forwarded-prefix') || '').replace(/[^/a-z0-9_-]/gi, '') || '/';
        const val = encodeURIComponent(Buffer.from(JSON.stringify(a)).toString('base64url'));
        res.append('Set-Cookie', `${ATTR_COOKIE}=${val}; Path=${prefix}; HttpOnly; SameSite=Lax`);
      }
    } else if (req.method === 'POST' && /^\/api\/applications\/?$/.test(req.path)) {
      const a = attributionFromCookie(req.get('cookie'));
      if (a) {
        const json = res.json.bind(res);
        res.json = (body) => {
          try {
            if (res.statusCode >= 200 && res.statusCode < 300) {
              const id = body && body.application && body.application.id;
              if (id) rememberAttribution(id, a);
            }
          } catch { /* never in the way of the answer */ }
          return json(body);
        };
      }
    }
  } catch (err) { log('attribution middleware:', err.message); }
  next();
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
  const { toCandidate } = await portal();
  const cand = (await c.query(`select * from candidates where id=$1`, [row.candidate_id])).rows[0];
  if (!cand) return null;
  const k = toCandidate(cand);
  const hasResume = !!(row.resume_path || cand.resume_storage_path);
  // ATS-100 B5: the applicant's own consent answers on the portal (0109
  // candidate_consent_current). In a savepoint: an older portal database
  // without the view must not abort the caller's transaction.
  let consent = null;
  try {
    await c.query('savepoint tl_consent');
    consent = (await c.query(
      `select kind, status, version, created_at from candidate_consent_current where candidate_id=$1`, [row.candidate_id])).rows
      .map((x) => ({ kind: x.kind, status: x.status, version: x.version, at: x.created_at ? new Date(x.created_at).toISOString() : null }));
    await c.query('release savepoint tl_consent');
  } catch {
    try { await c.query('rollback to savepoint tl_consent'); } catch { /* no transaction */ }
    consent = null;
  }
  return {
    event: 'application.created',
    requirementId: requirementIdOf(row.job_id),
    consent,
    attribution: attributionOf(row.id),
    application: {
      id: row.id,
      reference: row.reference || null,
      jobId: row.job_id,
      jobTitle: row.job_title || null,
      stage: row.stage,
      source: row.source || null,
      matchScore: row.match_score == null ? null : Number(row.match_score),
      appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
      // Fetched by TeamLink from GET .../applications/:id/resume (token).
      resume: hasResume ? { fileName: k.resumeFile || cand.resume_file || 'resume', path: `/api/integrations/teamlink/applications/${encodeURIComponent(row.id)}/resume` } : null,
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
 * not fail a candidate's application; the sweep and TeamLink's own pull
 * pick up anything that did not get through.
 */
async function pushOne(row) {
  const { withUser } = await portal();
  const payload = await withUser(SYSTEM, (c) => shapeApplication(c, row));
  if (!payload) return { status: 'skipped' };
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
      log(`application ${row.id} refused by TeamLink: ${res.status} ${text.slice(0, 200)}`);
      return { status: 'failed', code: res.status };
    }
    return { status: 'delivered' };
  } catch (err) {
    log(`application ${row.id} not pushed: ${err.name === 'AbortError' ? 'TeamLink did not answer in time' : err.message}`);
    return { status: 'failed', detail: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// Delivered ids (this process). After a restart the last WINDOW is re-sent;
// TeamLink answers "duplicate" for those and writes nothing.
const delivered = new Set();
const WINDOW_MIN = 30;
let pushing = null;
let again = false;
async function pushRecent() {
  if (!pushSecret()) return;
  if (pushing) { again = true; return; }
  pushing = (async () => {
    try {
      const { withUser } = await portal();
      const rows = await withUser(SYSTEM, (c) => c.query(
        `${APPLICATION_SQL} and a.applied_at >= now() - interval '${WINDOW_MIN} minutes' order by a.applied_at`)).then((r) => r.rows);
      for (const row of rows) {
        if (delivered.has(row.id)) continue;
        // eslint-disable-next-line no-await-in-loop
        const out = await pushOne(row);
        if (out.status === 'delivered' || out.status === 'skipped') delivered.add(row.id);
      }
      if (delivered.size > 5000) [...delivered].slice(0, 2500).forEach((id) => delivered.delete(id));
    } catch (err) {
      log('push sweep failed:', err.message);
    }
  })();
  await pushing;
  pushing = null;
  if (again) { again = false; setTimeout(pushRecent, 200); }
}

/* ------------------------------------------------------------------ *
 * the router
 * ------------------------------------------------------------------ */

export function teamlinkFrontRouter({ root, express }) {
  ROOT = root;
  const r = express.Router();
  const json = express.json({ limit: '5mb' });
  const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  // ATS-100 B6: utm_* / ?ref= remembered for the application (see above).
  r.use(attributionMiddleware);

  // An application the portal has just accepted goes to TeamLink at once.
  r.use((req, res, next) => {
    if (req.method === 'POST' && /^\/api\/applications(\/|$)/.test(req.path)) {
      res.on('finish', () => { if (res.statusCode >= 200 && res.statusCode < 300) setTimeout(pushRecent, 150); });
    }
    next();
  });

  r.use('/api/integrations/teamlink', (req, res, next) => {
    if (!syncToken()) return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'JOB_PORTAL_SYNC_TOKEN is not set on the job portal.' } });
    if (!sameSecret(req.get('x-teamlink-token'), syncToken())) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid integration token.' } });
    }
    res.set('Cache-Control', 'no-store');
    return next();
  }, json);

  r.get('/api/integrations/teamlink/ping', (_req, res) => res.json({ ok: true, host: 'teamlink-embed', pid: process.pid }));

  r.put('/api/integrations/teamlink/jobs/:requirementId', wrap(async (req, res) => {
    const { withUser } = await portal();
    const out = await withUser(SYSTEM, (c) => upsertJob(c, req.params.requirementId, req.body));
    if (out.opened) kickAlerts(out.id);
    res.json({ job: out });
  }));

  /**
   * The full picture from TeamLink: every job it lists is upserted, and with
   * `closeOthers` every other open TeamLink job is closed - so a requirement
   * unpublished or closed while this portal was down is still taken off the
   * board on the next sync. `pruneMissing` + `knownIds` removes a tl_* job
   * whose requirement was DELETED in TeamLink, but only if nobody applied.
   */
  r.post('/api/integrations/teamlink/jobs/sync', wrap(async (req, res) => {
    const { withUser } = await portal();
    const jobs = Array.isArray(req.body?.jobs) ? req.body.jobs : [];
    const closeOthers = req.body?.closeOthers === true;
    const out = await withUser(SYSTEM, async (c) => {
      const results = [];
      for (const j of jobs) {
        if (!j || !j.requirementId) continue;
        await c.query('savepoint upsert_job');
        try {
          results.push({ requirementId: j.requirementId, ...(await upsertJob(c, j.requirementId, j)) });
          await c.query('release savepoint upsert_job');
        } catch (err) {
          await c.query('rollback to savepoint upsert_job');
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
      const pruned = [];
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
    out.results.filter((x) => x.opened).forEach((x) => kickAlerts(x.id));
    res.json(out);
  }));

  /**
   * Status back from TeamLink, already in this portal's stage ids, so the
   * applicant sees their progress here. Only TeamLink jobs (tl_*), only valid
   * stages; an application already at that stage is left alone. No
   * notification is raised from here: the ATS owns candidate messaging.
   */
  r.post('/api/integrations/teamlink/applications/stages', wrap(async (req, res) => {
    const { withUser } = await portal();
    const updates = Array.isArray(req.body?.updates) ? req.body.updates.slice(0, 5000) : [];
    const results = await withUser(SYSTEM, async (c) => {
      const valid = new Set((await c.query(`select id from stages`)).rows.map((x) => x.id));
      const out = [];
      for (const u of updates) {
        const id = str(u && u.id, 64);
        const stage = str(u && u.stage, 40);
        if (!id || !stage) { out.push({ id, error: 'id and stage are required' }); continue; }
        if (!valid.has(stage)) { out.push({ id, error: `"${stage}" is not a portal stage` }); continue; }
        const cur = await c.query(`select stage from applications where id=$1 and job_id like 'tl\\_%'`, [id]);
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

  r.get('/api/integrations/teamlink/applications', wrap(async (req, res) => {
    const { withUser } = await portal();
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

  /** The resume a TeamLink application was made with (or the candidate's current one). */
  r.get('/api/integrations/teamlink/applications/:id/resume', wrap(async (req, res) => {
    const { withUser, getStorage } = await portal();
    const row = await withUser(SYSTEM, async (c) => (await c.query(
      `select a.resume_path, c.resume_storage_path, c.resume_file, c.resume_mime
         from applications a join candidates c on c.id = a.candidate_id
        where a.id=$1 and a.job_id like 'tl\\_%'`, [req.params.id])).rows[0]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such TeamLink application.' } });
    const key = row.resume_path || row.resume_storage_path;
    if (!key) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No resume on this application.' } });
    const buf = await getStorage().get(key);
    const name = String(row.resume_file || key.split('/').pop() || 'resume').replace(/["\r\n]/g, '');
    res.setHeader('content-type', row.resume_mime || 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('x-file-name', encodeURIComponent(name));
    return res.end(buf);
  }));

  // Errors from these routes only (anything else falls through to the portal).
  // eslint-disable-next-line no-unused-vars
  r.use('/api/integrations/teamlink', (err, _req, res, _next) => {
    const status = err.status || (err.statusCode) || 500;
    if (status >= 500) log('route error:', err.message);
    res.status(status).json({ error: { code: err.code || 'INTERNAL', message: status >= 500 ? 'The job portal could not do that.' : err.message } });
  });

  // The sweep: anything the instant push missed (TeamLink was restarting, ...).
  const t = setInterval(pushRecent, 15_000);
  t.unref();
  setTimeout(pushRecent, 5000).unref();
  log(`TeamLink sync ready (ATS at ${teamlinkApi()}, token ${syncToken() ? 'set' : 'NOT set'}, push secret ${pushSecret() ? 'set' : 'NOT set'})`);
  return r;
}
