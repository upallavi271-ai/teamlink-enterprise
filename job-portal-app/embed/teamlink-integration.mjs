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
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { withRcsLogin } from './rcs-login.mjs';
import { isIP } from 'node:net';

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

/*
 * FORGOT PASSWORD FOR A CANDIDATE WHO HAS NO LOGIN YET (founder 2026-11-10: "forgot password click chestey mails povadam ledhu").
 * The portal's own POST /api/auth/forgot mails a reset link only to an ACCOUNT (users.email). A candidate who is in the portal's
 * candidates list without an account - a Naukri / Shine mail import whose login mail never left, or one never invited - got nothing,
 * while the screen still said "we've sent a link". Now such a candidate is handed to the portal's OWN inviteCandidate instead: it makes
 * the account and mails the login (email + temporary password, changed at the first sign-in), the candidate portal link and any open
 * AI interview. Somebody with an account still gets the portal's normal reset link (handled = false: the portal's route runs).
 * The answer on screen is the portal's own, the same for every address, so nobody learns who is registered. At most once in 15 minutes
 * per address, and never for do-not-contact.
 */
export const FORGOT_ANSWER = { ok: true, message: "If an account exists for this email, we've sent a password reset link." };
const FORGOT_GAP_MS = 15 * 60 * 1000;
export async function forgotWithoutLogin(emailRaw, { withUser, loadInvite, seen, now = Date.now() }) {
  const email = String(emailRaw || '').trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { handled: false, why: 'not an email' };
  const found = await withUser(SYSTEM, async (c) => {
    const u = (await c.query('select role, status, must_change_password, last_login_at from users where lower(email) = $1 limit 1', [email])).rows[0];
    if (u) return { account: { role: u.role, status: u.status, neverSignedIn: !u.last_login_at, mustChangePassword: !!u.must_change_password } };
    const cand = (await c.query(
      `select id, name, email, phone, user_id, do_not_contact from candidates where lower(email) = $1 order by created_at asc limit 1`,
      [email])).rows[0] || null;
    return { cand };
  });
  if (found.account) return { handled: false, why: 'has an account', account: found.account };
  const k = found.cand;
  if (!k) return { handled: false, why: 'not a candidate' };
  if (k.user_id) return { handled: false, why: 'has a login under another address' };
  if (k.do_not_contact) return { handled: true, result: 'do-not-contact' };
  const last = seen.get(email);
  if (last && now - last < FORGOT_GAP_MS) return { handled: true, result: 'recent' };
  seen.set(email, now);
  if (seen.size > 5000) seen.delete(seen.keys().next().value);
  const { inviteCandidate } = await loadInvite();
  const name = String(k.name || '').trim() || email.split('@')[0];
  const sent = await inviteCandidate({ id: k.id, name, email, phone: k.phone || null }, { invitedBy: 'Forgot password' });
  const result = sent.invited ? 'invited' : (sent.reason === 'already invited' ? 'already' : 'not-sent');
  log(`forgot password: candidate ${k.id} had no login -> ${result}${sent.reason ? ` (${sent.reason})` : ''}`);
  return { handled: true, result, reason: sent.reason || null, delivery: sent.delivery || null };
}

/*
 * WHAT HAPPENED TO EACH FORGOT-PASSWORD REQUEST (founder 2026-11-10: "raledhu mail"). The portal's own route says the same thing on
 * screen whatever happens and writes a failure only to its server log, so nobody could see why a reset mail did not arrive. The last
 * 30 requests are kept in memory: when, the address half hidden, which path (account -> portal reset, candidate without a login ->
 * invite, ...), the account's role / status, and the mail result (the portal's own "[auth] reset mail ..." line, or the invite's
 * per-channel delivery). Never a password, token, link or hash. Read by TeamLink's Administrators (GET .../forgot-log).
 */
const forgotLog = [];
export const maskEmail = (e) => { const [u, d] = String(e || '').trim().toLowerCase().split('@'); return d ? `${u.slice(0, 2)}***@${d}` : '(not an email)'; };
let forgotCurrent = null;
let authTap = false;
function tapAuthErrors() {
  if (authTap) return;
  authTap = true;
  const orig = console.error;
  console.error = (...a) => {
    try {
      const t = String(a[0] || '');
      if (forgotCurrent && /^\[auth\] (reset mail|could not start a password reset)/.test(t)) {
        forgotCurrent.portalError = a.map((x) => String(x)).join(' ').slice(0, 300);
      }
    } catch { /* the tap never breaks logging */ }
    return orig.apply(console, a);
  };
}
// Kept in a file too (var/teamlink-forgot-log.json), so a portal restart - several a day while TeamLink deploys - does not empty it.
let forgotFile = '';
function loadForgotLog(root) {
  forgotFile = root ? join(root, 'var', 'teamlink-forgot-log.json') : '';
  if (!forgotFile) return;
  try { const saved = JSON.parse(readFileSync(forgotFile, 'utf8')); if (Array.isArray(saved)) forgotLog.splice(0, forgotLog.length, ...saved.slice(0, 30)); } catch { /* none yet */ }
}
function saveForgotLog() {
  if (!forgotFile) return;
  try { mkdirSync(dirname(forgotFile), { recursive: true }); writeFileSync(`${forgotFile}.tmp`, JSON.stringify(forgotLog)); renameSync(`${forgotFile}.tmp`, forgotFile); } catch { /* the log never breaks a reset */ }
}
function logForgot(entry) {
  forgotLog.unshift(entry);
  if (forgotLog.length > 30) forgotLog.length = 30;
  return entry;
}
export const forgotLogEntries = () => forgotLog.slice();

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
  mods = { withUser: db.withUser, getPool: db.getPool, ApiError: errors.ApiError, toCandidate: shapes.toCandidate, getStorage: storage.getStorage, alerts };
  try { installLoginText((await at('notify/providers.js')).providers); } catch (err) { log('login text: not installed:', err && err.message); }
  return mods;
}

/*
 * THE LOGIN GOES TO THE NUMBER WHEN THERE IS NO EMAIL (founder 2026-11-10: "candidate nii import chesinappuudu valla kii emails lekapothey
 * valla numbers kii mesage vellalii login credientials and teamlink link"). The portal already makes the account of a candidate with no
 * email from the mobile number (login = the 10 digits) and sends the invitation by SMS and WhatsApp too - but its SMS said only "you have
 * been added, sign in: <link>" with NO login and NO password, and its WhatsApp called the number "Login Email". So somebody who has only a
 * phone could never get in. Here, without touching the portal's code, a message that carries a NEW password (an invitation, or new
 * credentials sent again) is rewritten on its way out: the SMS says the login, the temporary password and the TeamLink link
 * (<site>/jobs/#/login/candidate); the WhatsApp labels a number login "Login (mobile number)". Every other message passes unchanged.
 * The password is only put in the message, never logged or stored here.
 */
const isPhoneLogin = (v) => /^\d{10}$/.test(String(v || ''));
export function loginMessage(channel, args) {
  const v = args && args.vars;
  if (!v || Array.isArray(v) || !v.temporary_password || !v.login_email || typeof (args && args.text) !== 'string') return args;
  if (channel === 'sms') {
    const first = String(v.candidate_name || v.to_name || '').trim().split(/\s+/)[0] || '';
    const who = isPhoneLogin(v.login_email) ? 'Login (your mobile number)' : 'Login';
    const text = `TeamLink: Hi ${first || 'there'}, your ${v.company_name || 'TeamLink'} candidate login. `
      + `${who}: ${v.login_email} Password: ${v.temporary_password} Sign in: ${v.portal_link || ''} `
      + '(choose a new password at first sign-in)';
    return { ...args, text: text.replace(/\s+/g, ' ').trim().slice(0, 320) };
  }
  if (channel === 'whatsapp' && isPhoneLogin(v.login_email)) {
    return { ...args, text: args.text.split(`Login Email: ${v.login_email}`).join(`Login (mobile number): ${v.login_email}`) };
  }
  return args;
}
/*
 * ADD CANDIDATE WITHOUT AN EMAIL (founder 2026-11-10: "add candidates loo email compulsory anii unadhii adhii remove cehyuu", screenshot of the
 * portal's quick-add dialog). The portal's POST /api/candidates insists on an email (its createSchema), though its own database, duplicate
 * check and invitation all work with a phone alone. So, without touching the portal's code: a quick add with a phone and NO email is given a
 * one-off stand-in address for the portal's checks, saved with no login sent, then the stand-in is removed (email = null) and the portal's
 * own inviteCandidate makes the login from the mobile number and sends it by SMS / WhatsApp with the TeamLink link (loginMessage above).
 * The answer the dialog gets is the portal's own, with email null and the real delivery result.
 */
export const isPhoneOnlyAdd = (b) => !!b && typeof b === 'object' && !Array.isArray(b)
  && !String(b.email == null ? '' : b.email).trim() && String(b.phone == null ? '' : b.phone).replace(/\D/g, '').length >= 7;
export const standInEmail = () => `nomail-${randomBytes(8).toString('hex')}@phone.invalid`;
/** Removes the stand-in from anything the portal answers (an error message, a duplicate list). */
export const withoutStandIn = (body, standIn) => {
  if (!standIn || body == null) return body;
  try { return JSON.parse(JSON.stringify(body).split(standIn).join('')); } catch { return body; }
};

/*
 * THE LOGIN ALSO GOES BY RCS (founder 2026-11-10): right after the SMS of a message that carries a NEW password, the same login is handed
 * to TeamLink's RCS sender (embed/rcs-login.mjs -> backend/src/utils/rcsCandidateLogin.js). Each send function is wrapped once (marked);
 * the SMS relay below replaces smsProvider.send and calls this again, so the login text and the RCS stay on (before, turning the relay on
 * after the portal had loaded dropped the login text).
 */
const rcsOpts = () => ({ api: teamlinkApi(), secret: pushSecret() });
export function installLoginText(providers) {
  if (!providers) return false;
  let wrapped = false;
  for (const ch of ['sms', 'whatsapp']) {
    const o = providers[ch];
    if (!o || typeof o.send !== 'function' || o.send.__teamlinkLoginText) continue; // eslint-disable-line no-continue
    const send = o.send;
    const fn = ch === 'sms'
      ? async function sendWithLogin(args, ...rest) {
        const a = loginMessage(ch, args);
        let result;
        try { result = await send.call(this, a, ...rest); } catch (err) { result = { status: 'failed', provider: 'sms', error: String((err && err.message) || err).slice(0, 300) }; }
        return withRcsLogin(a, result, rcsOpts());
      }
      : function sendWithLogin(args, ...rest) { return send.call(this, loginMessage(ch, args), ...rest); };
    Object.defineProperty(fn, '__teamlinkLoginText', { value: true });
    o.send = fn;
    wrapped = true;
  }
  if (!providers.__teamlinkLoginText) Object.defineProperty(providers, '__teamlinkLoginText', { value: true });
  return wrapped;
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

  // A closed requirement that never reached the portal has nothing to close - unless it is an IMPORT STUB: a requirement that is not on the public portal but
  // that a recruiter must be able to pick when importing a list (founder 2026-11-13: "show all requirements to the recruiters"). Stubs are created closed,
  // so nobody sees them on the portal.
  if (!was && j.status !== 'open' && !(body && body.importStub === true)) return { id, status: null, opened: false, skipped: true };

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
// "Send the portal login to every candidate who arrives" (founder 2026-11-02). The portal's own mail import sends the login message
// only when INTAKE_NOTIFY_CANDIDATES=true (api/src/intake/process.js reads it on every import). TeamLink's switch writes it here, and
// this file keeps it over a restart, so the portal behaves the same before TeamLink's next call after a restart.
const AUTO_FILE = join(process.env.JP_PIDFILE ? dirname(process.env.JP_PIDFILE) : join(import.meta.dirname, '..', 'run'), 'candidate-login-auto.json');
function loadAutoLogins() {
  try {
    const v = JSON.parse(readFileSync(AUTO_FILE, 'utf8'));
    if (v && typeof v.on === 'boolean') process.env.INTAKE_NOTIFY_CANDIDATES = v.on ? 'true' : 'false';
  } catch { /* never set: the portal's own default stays */ }
}
function saveAutoLogins(on) {
  process.env.INTAKE_NOTIFY_CANDIDATES = on ? 'true' : 'false';
  try { mkdirSync(dirname(AUTO_FILE), { recursive: true }); writeFileSync(AUTO_FILE, JSON.stringify({ on, at: new Date().toISOString() })); } catch { /* the env var is already set for this run */ }
}
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
  // The portal's own AI interview for this application (0005 ai_interviews, 0015 ai_interview_due_at), so TeamLink
  // knows who still has to take it (AI reminder calls) and who already did. Same savepoint rule as consent.
  let aiInterview = null;
  try {
    await c.query('savepoint tl_ai');
    const iv = (await c.query(
      `select status, overall_percentage, completed_at, started_at from ai_interviews
        where application_id=$1 order by (status='completed') desc, coalesce(completed_at, started_at, created_at) desc limit 1`, [row.id])).rows[0];
    const due = row.ai_interview_due_at ? new Date(row.ai_interview_due_at).toISOString() : null;
    aiInterview = (iv || due) ? {
      status: iv ? iv.status : 'not_started',
      score: iv && iv.status === 'completed' && iv.overall_percentage != null ? Math.round(Number(iv.overall_percentage)) : null,
      completedAt: iv && iv.status === 'completed' && iv.completed_at ? new Date(iv.completed_at).toISOString() : null,
      dueAt: due,
    } : null;
    await c.query('release savepoint tl_ai');
  } catch {
    try { await c.query('rollback to savepoint tl_ai'); } catch { /* no transaction */ }
    aiInterview = null;
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
      aiInterview,
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

  // Forgot password: a candidate with no login yet gets their login made and mailed (forgotWithoutLogin above); anyone else falls
  // through to the portal's own reset (the parsed body stays on req for it). A failure here never blocks the portal's route.
  const forgotSeen = new Map();
  tapAuthErrors();
  loadForgotLog(ROOT);
  r.post('/api/auth/forgot', json, (req, res, next) => {
    const entry = logForgot({ at: new Date().toISOString(), email: maskEmail(req.body && req.body.email) });
    res.on('finish', () => { entry.httpStatus = res.statusCode; saveForgotLog(); setTimeout(() => { if (forgotCurrent === entry) forgotCurrent = null; }, 3000); });
    forgotWithoutLogin(req.body && req.body.email, {
      withUser: async (...a) => (await portal()).withUser(...a),
      loadInvite: () => import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'invite.js')).href),
      seen: forgotSeen,
    }).then((out) => {
      Object.assign(entry, { path: out.handled ? `invite: ${out.result}` : out.why, account: out.account || null, reason: out.reason || null,
        delivery: out.delivery || null });
      if (out.handled) return res.json(FORGOT_ANSWER);
      if (out.why === 'has an account') entry.path = 'portal reset link';
      forgotCurrent = entry;
      return next();
    }).catch((err) => {
      entry.path = 'check failed, portal reset tried';
      entry.reason = String((err && err.message) || err).slice(0, 200);
      log('forgot password check failed:', entry.reason);
      forgotCurrent = entry;
      next();
    });
  });

  // Add Candidate with a phone and no email (isPhoneOnlyAdd above). Anything else goes to the portal's route exactly as it came.
  r.post('/api/candidates', json, (req, res, next) => {
    if (!isPhoneOnlyAdd(req.body)) return next();
    const standIn = standInEmail();
    const wantLogin = req.body.sendCredentials !== false;
    const phone = String(req.body.phone);
    req.body.email = standIn;
    req.body.sendCredentials = false; // no login to the stand-in: it is sent below, to the number
    const send = res.json.bind(res);
    res.json = (body) => {
      res.json = send;
      const cand = body && body.candidate;
      if (res.statusCode >= 300 || !cand || !cand.id) return send(withoutStandIn(body, standIn));
      (async () => {
        const { withUser } = await portal();
        await withUser(SYSTEM, (c) => c.query('update candidates set email = null where id = $1 and lower(email) = $2', [cand.id, standIn]));
        const out = { ...body, candidate: { ...cand, email: null } };
        const credentials = { attempted: false, sent: false, accountCreated: false, delivery: {} };
        if (wantLogin) {
          credentials.attempted = true;
          const { inviteCandidate } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'invite.js')).href);
          const sending = inviteCandidate({ id: cand.id, name: cand.name || cand.fullName || [req.body.firstName, req.body.lastName].filter(Boolean).join(' '),
            email: null, phone: cand.phone || phone }, { invitedBy: (req.session && req.session.userId) || 'recruiter' });
          sending.catch((err) => log('add without email: the login failed after the reply:', err && err.message));
          let timer = null;
          const late = Symbol('still sending');
          const done = await Promise.race([sending, new Promise((ok) => { timer = setTimeout(() => ok(late), Number(process.env.INVITE_WAIT_MS || 4000)); })]);
          clearTimeout(timer);
          if (done === late) Object.assign(credentials, { queued: true, reason: 'still sending' });
          else Object.assign(credentials, { sent: !!done.invited, accountCreated: !!done.accountCreated, delivery: done.delivery || {}, ...(done.reason ? { reason: done.reason } : {}) });
        }
        out.credentials = credentials;
        return out;
      })().then((out) => send(out), (err) => {
        log('add without email: after the save:', err && err.message);
        send(withoutStandIn({ ...body, candidate: { ...cand, email: null },
          credentials: { attempted: true, sent: false, delivery: {}, reason: 'the login could not be sent - use Resend credentials' } }, standIn));
      });
      return res;
    };
    return next();
  });

  /*
   * ADD CANDIDATE: the email is optional in the quick-add dialog (embed/quick-add-addon.js, added to the portal's pages by the TeamLink proxy).
   */
  /*
   * THE BULK "Start AI Calls" BUTTON: Kavya places the calls (embed/kavya-campaign.mjs). The portal's own dialer is switched off
   * (OUTBOUND_CALLS_ENABLED stays off); this route answers the page's POST /api/ai-calling/campaign in the portal's own shape.
   */
  r.get('/tl-addon/kavya-bulk.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(import.meta.dirname, 'kavya-bulk-addon.js'));
  });
  r.post('/api/ai-calling/campaign', json, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const K = await import(pathToFileURL(join(import.meta.dirname, 'kavya-campaign.mjs')).href);
    const { withUser } = await portal();
    const { resolveSession } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'auth.js')).href);
    const out = await K.placeCampaign(req, { resolveSession, withUser, api: teamlinkApi(), secret: pushSecret() });
    res.status(out.status).json(out.body.error ? { ...out.body, error: { code: out.body.code || 'ERROR', message: out.body.error } , message: out.body.error } : out.body);
  }));

  r.get('/tl-addon/quick-add.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(import.meta.dirname, 'quick-add-addon.js'));
  });

  r.use('/api/integrations/teamlink', (req, res, next) => {
    if (!syncToken()) return res.status(503).json({ error: { code: 'NOT_CONFIGURED', message: 'JOB_PORTAL_SYNC_TOKEN is not set on the job portal.' } });
    if (!sameSecret(req.get('x-teamlink-token'), syncToken())) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Invalid integration token.' } });
    }
    res.set('Cache-Control', 'no-store');
    return next();
  }, json);

  /*
   * FORGOT PASSWORD THAT REALLY SENDS THE MAIL (founder 2026-11-10: "forgot password kii kuda alaney mail send ayela cheyali" - ten
   * presses, no mail, while TeamLink's own test mail reached Gmail). The portal's POST /api/auth/forgot gave up the moment its one
   * database connection was busy ("[auth] could not start a password reset: timeout exceeded when trying to connect") and logged
   * nothing when a mail did go, so nobody could tell. Same route, answered here first, the portal's own code unchanged:
   *   - the same screen, the same answer for every address (no hint whether an account exists), 5 requests per address per hour;
   *   - the link is made by the portal's OWN startPasswordReset (its table, its expiry, its one-use rule), tried 3 times when busy;
   *   - the mail is the portal's own text, sent by the portal's mail account; if that fails, by TeamLink's email account (the one
   *     whose test mail arrives), through the bridge (backend routes/jobPortalBridge.js POST /email);
   *   - every outcome is written to the portal log (address masked, never the link), so check-portal-login-on-vps.ps1 shows it.
   */
  const forgotHits = new Map();
  const forgotLimited = (key, max) => {
    const now = Date.now(); const list = (forgotHits.get(key) || []).filter((t) => now - t < 3_600_000);
    list.push(now); forgotHits.set(key, list);
    if (forgotHits.size > 5000) forgotHits.delete(forgotHits.keys().next().value);
    return list.length > max;
  };
  const maskMail = (e) => { const [u, d] = String(e).split('@'); return `${u.slice(0, 3)}***@${d || ''}`; };
  const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });
  r.post('/api/auth/forgot', json, wrap(async (req, res) => {
    const SAME = { ok: true, message: "If an account exists for this email, we've sent a password reset link." };
    const email = String((req.body && req.body.email) || '').trim();
    if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: { code: 'VALIDATION_FAILED', message: 'Please enter a valid email address.' } });
    }
    const ipRaw = String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim().replace(/^::ffff:/, '');
    const ip = isIP(ipRaw) ? ipRaw : null;
    if (forgotLimited(`em:${email.toLowerCase()}`, 5) || forgotLimited(`ip:${ip || 'unknown'}`, 30)) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many reset requests. Please wait an hour and try again.' } });
    }
    const auth = await import(pathToFileURL(join(ROOT, 'api', 'src', 'auth.js')).href);
    let issued = null; let lastErr = null;
    for (let i = 0; i < 3; i += 1) {
      try { issued = await auth.startPasswordReset({ email, ip }); lastErr = null; break; } catch (e) { lastErr = e; await pause(1500 * (i + 1)); } // eslint-disable-line no-await-in-loop
    }
    if (lastErr) { log(`forgot password: reset mail NOT sent to ${maskMail(email)} - the link could not be made after 3 tries: ${lastErr.message}`); return res.json(SAME); }
    if (!issued) { log(`forgot password: no reset mail - no active portal account for ${maskMail(email)}`); return res.json(SAME); }

    const { config } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'config.js')).href);
    const base = String(config.publicOrigin || '').replace(/\/$/, '');
    const link = `${base}/reset-password?token=${encodeURIComponent(issued.token)}`;
    const greeting = issued.name ? `Hi ${issued.name},` : 'Hi,';
    const safe = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
    const subject = 'Reset your TeamLink password';
    const text = [greeting, '', 'We received a request to reset the password on your TeamLink account.', 'Open this link to choose a new one:', '', link, '',
      `This link can be used once and expires in ${issued.minutes} minutes.`, '', "If you didn't request this, ignore this email - your password has", 'not been changed.'].join('\n');
    const html = ['<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;font-size:15px;color:#1f2933">', `<p>${safe(greeting)}</p>`,
      '<p>We received a request to reset the password on your TeamLink account.</p>',
      `<p style="margin:26px 0"><a href="${safe(link)}" style="background:#2a4bc0;color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;display:inline-block;font-weight:600">Reset password</a></p>`,
      `<p style="color:#52606d">This link can be used once and expires in ${issued.minutes} minutes.</p>`,
      '<p style="color:#52606d">If you didn&#39;t request this, ignore this email &mdash; your password has not been changed.</p>', '</div>'].join('');

    let how = null; let why = '';
    try {
      const { emailProvider } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'providers.js')).href);
      const sent = await emailProvider.send({ to: issued.email, subject, text, html });
      if (sent && (sent.status === 'sent' || sent.status === 'delivered')) how = 'the portal mail account';
      else why = `portal mail: ${(sent && (sent.error || sent.status)) || 'no answer'}`;
    } catch (e) { why = `portal mail: ${e.message}`; }
    if (!how) {
      try {
        const r2 = await fetch(`${teamlinkApi()}/api/public/job-portal/email`, {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-job-portal-secret': pushSecret() },
          body: JSON.stringify({ to: issued.email, subject, text, html }), signal: AbortSignal.timeout(30000),
        });
        const o = await r2.json().catch(() => ({}));
        if (o && o.ok) how = 'TeamLink\'s email account'; else why += `; TeamLink email: ${String((o && o.error) || `HTTP ${r2.status}`).slice(0, 200)}`;
      } catch (e) { why += `; TeamLink email: ${e.message}`; }
    }
    log(how ? `forgot password: reset mail sent to ${maskMail(issued.email)} through ${how}` : `forgot password: reset mail NOT sent to ${maskMail(issued.email)} - ${why}`);
    return res.json(SAME);
  }));

  /*
   * WHY A CANDIDATE'S SIGN-IN SAYS "INCORRECT EMAIL OR PASSWORD" (founder 2026-11-10; backend/scripts/portal-login-check.js,
   * check-portal-login-on-vps.ps1). Asked through the running portal, not with a second database connection: the live portal's own
   * database takes one connection only ("Connection terminated unexpectedly"). READ ONLY, as the portal administrator (the row rules
   * let it read accounts and login messages); never a password, hash or token.
   *   POST /api/integrations/teamlink/login-check  { find }  ->  { users: [...], candidates: [{ ..., invites: [...] }] }
   */
  //   GET /api/integrations/teamlink/forgot-log  ->  { entries: [...newest first], email: { configured, host, from } }   (see forgotLog above)
  r.get('/api/integrations/teamlink/forgot-log', wrap(async (_req, res) => {
    res.json({ entries: forgotLogEntries(), email: await emailInfo().catch(() => null) });
  }));

  /*
   * SUSPENDED AI INTERVIEWS, READ ONLY (founder 2026-11-11: "ai interview click chestey back velthundi, interview suspended ani vastundi").
   *   GET /api/integrations/teamlink/interview-suspensions -> { interviews: [...recent suspended / warned...], audit: [...their latest events...] }
   */
  r.get('/api/integrations/teamlink/interview-suspensions', wrap(async (_req, res) => {
    const { withUser } = await portal();
    const out = await withUser(SYSTEM, async (c) => {
      const interviews = (await c.query(`select id, application_id, candidate_id, attempt_number, status, integrity_status, integrity_strikes,
          suspension_code, suspension_message, suspension_question_no, detection_count, started_at, suspended_at, retake_available_at, retake_blocked
          from ai_interviews where suspended_at > now() - interval '3 days' or integrity_strikes > 0 and started_at > now() - interval '3 days'
          order by coalesce(suspended_at, started_at) desc limit 15`)).rows;
      const ids = interviews.map((i) => i.id);
      const audit = ids.length ? (await c.query(`select interview_id, action, detail, actor_role, at from ai_interview_audit
          where interview_id = any($1::text[]) order by at desc limit 40`, [ids])).rows : [];
      // what the recogniser actually delivered for the newest interviews (length and the first words only), to see whether speech is captured
      const recent = (await c.query(`select interview_id, seq, part, answered, length(coalesce(transcript,'')) as chars, left(coalesce(transcript,''), 70) as starts, submitted_at
          from ai_interview_answer_parts where interview_id in (select id from ai_interviews order by created_at desc limit 3)
          order by submitted_at desc nulls last limit 30`)).rows;
      return { interviews, audit, recent };
    });
    res.json(out);
  }));

  /* READ ONLY: what a candidate's profile holds after a resume was matched (founder 2026-11-13: "srikanth reddy ni chudu"). Names only the profile columns a resume fills.
     GET /api/integrations/teamlink/candidate-resume-check?name=<part of the name> -> { candidates: [...up to 5] } */
  r.get('/api/integrations/teamlink/candidate-resume-check', wrap(async (req, res) => {
    const q = String(req.query.name || '').trim().slice(0, 60);
    if (q.length < 3) return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'name (3+ letters) is required' } });
    const { withUser } = await portal();
    const rows = await withUser(SYSTEM, async (c) => (await c.query(
      `select id, name, exp, exp_years, relevant_exp_years, skills, title, current_company, education, location, notice_period, summary,
              resume_file, resume_uploaded_at, resume_parsed_at, resume_parser, resume_chars, resume_fields_detected, resume_parse_confidence, resume_parse_error,
              (select count(*) from candidate_experience e where e.candidate_id = c.id) as employment_rows,
              (select count(*) from candidate_education d where d.candidate_id = c.id) as education_rows,
              (case when $2 then left(resume_text, 6000) end) as text
         from candidates c where name ilike $1 order by resume_uploaded_at desc nulls last limit 5`, [`%${q}%`, req.query.text === "1"])).rows);
    res.json({ candidates: rows });
  }));

  /* READ ONLY: how many TeamLink jobs the portal holds (by status) - what the import's role picker can offer.  GET /api/integrations/teamlink/import-jobs-check */
  r.get('/api/integrations/teamlink/import-jobs-check', wrap(async (_req, res) => {
    const { withUser } = await portal();
    const out = await withUser(SYSTEM, async (c) => {
      const byStatus = (await c.query(`select status, count(*)::int as n from jobs where id like 'tl\\_%' group by 1 order by 2 desc`)).rows;
      const stubs = (await c.query(`select count(*)::int as n from jobs where id like 'tl\\_%' and status='closed' and published_at is not null`)).rows[0];
      const sample = (await c.query(`select id, title, status from jobs where id like 'tl\\_%' order by (status='open') desc, published_at desc nulls last limit 5`)).rows;
      return { byStatus, closedWithDate: stubs && stubs.n, sample };
    });
    res.json(out);
  }));

  /* One more attempt for ONE suspended interview, on the founder's word (2026-11-11: "Yes, grant retake"): the same control a recruiter has
     (interview_retake_control 'extra_attempt'), audited as retake.extra_attempt.  POST { interviewId, reason } */
  r.post('/api/integrations/teamlink/interview-retake', wrap(async (req, res) => {
    const id = String((req.body && req.body.interviewId) || '');
    const reason = String((req.body && req.body.reason) || '').slice(0, 200);
    if (!/^aiv_[a-z0-9]+$/i.test(id) || reason.length < 3) return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'interviewId and reason are required' } });
    const { withUser } = await portal();
    const row = await withUser(SYSTEM, async (c) => (await c.query(`select id, status, retake_available_at, retake_blocked from interview_retake_control($1, 'extra_attempt', $2, null)`, [id, reason])).rows[0]);
    res.json({ ok: true, interview: row });
  }));

  /*
   * JUNK CANDIDATES FROM IMPORTS (founder 2026-11-10: names showing as 7.56947364E9 after a bulk import; backend/scripts/portal-junk-candidates.js).
   * READ ONLY, asked through the running portal (its database takes one connection). A candidate whose NAME is only digits / dots / "e+" (a phone
   * or an Excel date read as a name) or has fewer than two letters. Counts and examples only; nothing is changed.
   *   GET /api/integrations/teamlink/junk-candidates  ->  { total, junk, byImport: [...], examples: [...] }
   */
  r.get('/api/integrations/teamlink/junk-candidates', wrap(async (_req, res) => {
    const { withUser } = await portal();
    const JUNK = `(coalesce(name,'') ~ '^[0-9.,eE+ -]*$' or length(regexp_replace(coalesce(name,''), '[^A-Za-z\u00C0-\uFFFF]', '', 'g')) < 2)`;
    const out = await withUser(SYSTEM, async (c) => {
      const total = Number((await c.query('select count(*) as n from candidates')).rows[0].n);
      const junk = Number((await c.query(`select count(*) as n from candidates where ${JUNK}`)).rows[0].n);
      const byImport = (await c.query(`select coalesce(import_id,'(not from an import)') as import_id, count(*) as n, min(created_at) as first_at
          from candidates where ${JUNK} group by 1 order by n desc limit 15`)).rows;
      const examples = (await c.query(`select id, name, email, phone, import_id, created_at, user_id is not null as has_login
          from candidates where ${JUNK} order by created_at desc limit 25`)).rows;
      return { total, junk, byImport, examples };
    });
    res.json(out);
  }));

  /*
   * CLEAN-UP OF THE JUNK CANDIDATES (founder 2026-11-10: "start cheyyi"). Strict on purpose, nothing else is touched:
   *   a candidate whose NAME has no letter at all (only digits, dots, "e+", punctuation: "7.56947364E9", "....") - a name written in ANY
   *   alphabet, fancy fonts included, is never matched - AND whose portal account has never signed in.
   *   GET  /api/integrations/teamlink/junk-candidates/dump              -> { rows: [full candidate + login rows] }   (read only: the backup)
   *   POST /api/integrations/teamlink/junk-candidates/delete { ids, expect } -> { deleted }   deletes the account (the candidate and its
   *        dependants go with it, ON DELETE CASCADE) of exactly those ids that STILL match, in one transaction; `expect` must equal the
   *        number of ids or nothing is done.
   */
  const JUNK_STRICT = `(coalesce(c.name,'') ~ '^[0-9.,eE+ -]*$' or coalesce(c.name,'') ~ '^[\\x01-\\x40\\x5B-\\x60\\x7B-\\x7F]*$')`;
  r.get('/api/integrations/teamlink/junk-candidates/dump', wrap(async (_req, res) => {
    const { withUser } = await portal();
    const rows = await withUser(SYSTEM, async (c) => (await c.query(`select to_jsonb(c) as candidate, to_jsonb(u) - 'password_hash' as login
        from candidates c left join users u on u.id = c.user_id
        where ${JUNK_STRICT} and (u.id is null or u.last_login_at is null) order by c.created_at`)).rows);
    res.json({ count: rows.length, rows });
  }));
  r.post('/api/integrations/teamlink/junk-candidates/delete', wrap(async (req, res) => {
    const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(String) : [];
    if (!ids.length || ids.length > 200 || Number(req.body.expect) !== ids.length) {
      return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'ids (1-200) and expect (the same number) are required' } });
    }
    // The portal's own role may not delete from `users` ("permission denied for table users"), so this one clean-up uses the pool's own
    // database login, like the reset-link read below: ONE transaction, the same strict junk rule re-checked inside it, everything rolled back
    // if the count differs or any row is left. Never reached by a browser: the TeamLink router in front of the portal guards this path.
    const { getPool } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'db.js')).href);
    const c = await getPool().connect();
    let out;
    try {
      await c.query('begin');
      const ok = (await c.query(`select c.id, c.user_id from candidates c left join users u on u.id = c.user_id
          where c.id = any($1::text[]) and ${JUNK_STRICT} and (u.id is null or u.last_login_at is null) for update of c`, [ids])).rows;
      if (ok.length !== ids.length) throw Object.assign(new Error(`only ${ok.length} of ${ids.length} still match the junk rule - nothing deleted`), { status: 409 });
      const userIds = ok.map((x) => x.user_id).filter(Boolean);
      await c.query('delete from candidates where id = any($1::text[])', [ids]);
      if (userIds.length) await c.query('delete from users where id = any($1::uuid[])', [userIds]);
      const left = Number((await c.query('select count(*) as n from candidates where id = any($1::text[])', [ids])).rows[0].n);
      if (left) throw new Error(`${left} rows are still there after the delete - rolled back`);
      await c.query('commit');
      out = { deleted: ids.length };
    } catch (e) {
      try { await c.query('rollback'); } catch { /* the connection is going away */ }
      throw e;
    } finally { c.release(); }
    res.json(out);
  }));

  r.post('/api/integrations/teamlink/login-check', wrap(async (req, res) => {
    const find = String((req.body && req.body.find) || '').trim().toLowerCase().replace(/[%_]/g, '');
    if (find.length < 4) return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'find needs at least 4 letters' } });
    const like = `%${find}%`;
    const digits = find.replace(/\D/g, '');
    const { withUser } = await portal();
    const out = await withUser(SYSTEM, async (c) => {
      const users = (await c.query(`select id, email, role, status, created_at, last_login_at, updated_at, must_change_password
          from users where lower(email) like $1 order by created_at limit 20`, [like])).rows;
      const cands = (await c.query(`select c.id, c.name, c.email, c.phone, c.user_id, c.created_at, u.email as login_email, u.status as login_status
          from candidates c left join users u on u.id = c.user_id
          where lower(coalesce(c.email,'')) like $1 or lower(c.name) like $1
             ${digits.length >= 6 ? "or regexp_replace(coalesce(c.phone,''), '\\D', '', 'g') like $2" : ''}
          order by c.created_at limit 20`, digits.length >= 6 ? [like, `%${digits}%`] : [like])).rows;
      for (const k of cands) {
        // eslint-disable-next-line no-await-in-loop
        k.invites = (await c.query(`select channel, status, to_address, provider, error, created_at from candidate_invites
            where candidate_id = $1 order by created_at desc limit 6`, [k.id]).catch(() => ({ rows: [] }))).rows;
      }
      return { users, candidates: cands };
    });
    // where the portal's mails go (Forgot password, logins): TeamLink's SMTP account, set in memory after each portal start
    out.email = await emailInfo().catch(() => null);
    // does the mail server accept the portal's login? (nodemailer verify: connects and signs in, sends nothing)
    try {
      const P = await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'providers.js')).href);
      out.smtpCheck = await P.verifySmtp();
    } catch (e) { out.smtpCheck = { ok: false, error: String((e && e.message) || e).slice(0, 200) }; }
    // the reset links made for these accounts (when, used or not; never the token). The row rule hides password_resets from every role,
    // so this one read uses the pool's own connection without dropping to the app role - read only, inside a read-only transaction.
    if (out.users.length) {
      try {
        const { getPool } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'db.js')).href);
        const c = await getPool().connect();
        try {
          await c.query('begin read only');
          // a database login that obeys the row rules would read nothing here and look like "no request": say "unknown" instead
          const free = (await c.query('select rolsuper or rolbypassrls as free from pg_roles where rolname = current_user')).rows[0];
          if (!free || !free.free) throw new Error('this database login cannot see reset links (row rules apply to it)');
          const rows = (await c.query(`select user_id, created_at, expires_at, used_at from password_resets
              where user_id = any($1::uuid[]) order by created_at desc limit 20`, [out.users.map((u) => u.id)])).rows;
          out.users.forEach((u) => { u.resets = rows.filter((x) => x.user_id === u.id).map(({ created_at, expires_at, used_at }) => ({ created_at, expires_at, used_at })); });
        } finally {
          // the portal has ONE connection: it must go back closed, never inside this read-only transaction
          let clean = true;
          try { await c.query('rollback'); } catch { clean = false; }
          c.release(clean ? undefined : true);
        }
      } catch (e) { out.resetsError = String((e && e.message) || e).slice(0, 200); }
    }
    return res.json(out);
  }));

  loadAutoLogins();
  // GET / POST .../candidates/auto  { on }  -> { on }: whether imported Naukri / Shine candidates are sent their login by the portal itself
  r.get('/api/integrations/teamlink/candidates/auto', (_req, res) => res.json({ on: /^true$/i.test(String(process.env.INTAKE_NOTIFY_CANDIDATES || '')) }));
  r.post('/api/integrations/teamlink/candidates/auto', (req, res) => {
    if (!req.body || typeof req.body.on !== 'boolean') return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'on must be true or false' } });
    saveAutoLogins(req.body.on);
    return res.json({ on: req.body.on });
  });
  /*
   * THE PORTAL SENDS WHATSAPP FROM TEAMLINK'S OWN NUMBER (founder 2026-11-02: "job portal loo kudaa ee social media accounts and whtsapp anii
   * same undalii ... intergrate avalii job portal loo ki automatic gaa"). The portal's primary WhatsApp number is read from its config on
   * every send (whatsapp/numbers.js credentialsFor), so TeamLink hands it the number it already sends from (its default WhatsApp number,
   * Administration -> Integrations -> WhatsApp) and the portal's messages (candidate logins, interview invitations) leave from the
   * same number. Nothing is stored by the portal: it lives in memory, TeamLink sends it again after every portal start and whenever the
   * number changes (backend/src/utils/portalIntegrations.js). The token is never sent back.
   *   POST .../whatsapp/primary { accessToken, phoneNumberId, businessId }  ->  { configured, phoneNumberId (last 4) }
   *   GET  .../whatsapp/primary                                             ->  { configured, phoneNumberId (last 4), pid }
   */
  const waInfo = async () => {
    const cfg = (await import(pathToFileURL(join(ROOT, 'api', 'src', 'config.js')).href)).config;
    const id = String(cfg.whatsappPhoneId || '');
    return { configured: !!(cfg.whatsappApiKey && id), phoneNumberId: id ? `…${id.slice(-4)}` : null, pid: process.pid };
  };
  r.get('/api/integrations/teamlink/whatsapp/primary', wrap(async (_req, res) => res.json(await waInfo())));
  r.post('/api/integrations/teamlink/whatsapp/primary', wrap(async (req, res) => {
    const b = req.body || {};
    const token = String(b.accessToken || '').trim();
    const phoneId = String(b.phoneNumberId || '').trim();
    if (!token || !/^\d{5,24}$/.test(phoneId)) return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'accessToken and a numeric phoneNumberId are required' } });
    const cfg = (await import(pathToFileURL(join(ROOT, 'api', 'src', 'config.js')).href)).config;
    cfg.whatsappApiKey = token;
    cfg.whatsappPhoneId = phoneId;
    process.env.WHATSAPP_API_KEY = token;
    process.env.WHATSAPP_PHONE_ID = phoneId;
    if (b.businessId) { cfg.waBusinessId = String(b.businessId).trim(); process.env.WHATSAPP_BUSINESS_ID = cfg.waBusinessId; }
    try { (await import(pathToFileURL(join(ROOT, 'api', 'src', 'whatsapp', 'numbers.js')).href)).forgetNumberCredentials(); } catch { /* the cache is only 8 s */ }
    log('whatsapp: the portal now sends from TeamLink\'s number');
    return res.json(await waInfo());
  }));

  /*
   * THE PORTAL SENDS EMAIL AND SMS THROUGH TEAMLINK'S OWN CHANNELS (founder 2026-11-02: "job portal kii anii integrations connect cheyuu").
   *   EMAIL  TeamLink's Email (SMTP) account (Administration -> Integrations -> Email) becomes the portal's SMTP: same server, same From.
   *          The portal reads config.smtp* on every send, so the values are set in memory and the cached connection is dropped.
   *   SMS    The portal speaks MSG91 / Fast2SMS / Twilio, TeamLink uses the SMS Push Platform (web.smsgw.in), which the portal cannot
   *          talk to. So the portal's SMS provider hands every message to TeamLink (POST {TEAMLINK_API_URL}/api/public/job-portal/sms with the
   *          existing bridge secret), which sends it through its own SMS channel with its own DLT templates and "proven" rule.
   * Nothing is written to the portal's database or disk. TeamLink sends these again after every portal start (backend/src/utils/
   * portalIntegrations.js). No password is ever returned.
   *   POST .../email/config { host, port, secure, encryption, user, pass, fromAddress, fromName }  ->  { configured, host, from }
   *   GET  .../email/config                                                                         ->  { configured, host, from, pid }
   *   POST .../sms/relay { on }   GET .../sms/relay                                                 ->  { relay, pid }
   */
  const emailInfo = async () => {
    const cfg = (await import(pathToFileURL(join(ROOT, 'api', 'src', 'config.js')).href)).config;
    return { configured: !!(cfg.emailFrom && cfg.smtpHost && cfg.smtpUser && cfg.smtpPass), host: cfg.smtpHost || null, from: cfg.emailFrom || null, pid: process.pid };
  };
  r.get('/api/integrations/teamlink/email/config', wrap(async (_req, res) => res.json(await emailInfo())));
  r.post('/api/integrations/teamlink/email/config', wrap(async (req, res) => {
    const b = req.body || {};
    const host = String(b.host || '').trim();
    const fromAddress = String(b.fromAddress || '').trim();
    const port = Number(b.port);
    if (!host || !fromAddress || !Number.isInteger(port) || port < 1 || port > 65535) return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'host, fromAddress and a port are required' } });
    const cfgMod = await import(pathToFileURL(join(ROOT, 'api', 'src', 'config.js')).href);
    const cfg = cfgMod.config;
    const enc = String(b.encryption || '').toUpperCase();
    cfg.smtpHost = host;
    cfg.smtpPort = port;
    cfg.smtpSecure = b.secure === true;
    cfg.smtpEncryption = enc === 'STARTTLS' ? 'STARTTLS' : enc === 'NONE' ? 'None' : 'SSL';
    cfg.smtpUser = String(b.user || '').trim();
    cfg.smtpPass = String(b.pass || '');
    cfg.emailFrom = fromAddress;
    cfg.emailFromName = String(b.fromName || '').trim();
    try { (await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'providers.js')).href)).resetSmtp(); } catch { /* the next send builds it again */ }
    log('email: the portal now sends through TeamLink\'s SMTP account');
    return res.json(await emailInfo());
  }));

  let smsRelay = false;
  const relayInfo = () => ({ relay: smsRelay, pid: process.pid });
  r.get('/api/integrations/teamlink/sms/relay', (_req, res) => res.json(relayInfo()));
  r.post('/api/integrations/teamlink/sms/relay', wrap(async (req, res) => {
    if (!req.body || typeof req.body.on !== 'boolean') return res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'on must be true or false' } });
    const { smsProvider } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'providers.js')).href);
    if (req.body.on && !smsRelay) {
      smsRelay = true;
      smsProvider.configured = () => true;
      smsProvider.send = async ({ to, text, purpose }) => {
        if (!to) return { status: 'skipped_no_address', provider: 'teamlink-sms', error: 'no phone number' };
        try {
          const res2 = await fetch(`${teamlinkApi()}/api/public/job-portal/sms`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-job-portal-secret': pushSecret() },
            body: JSON.stringify({ to, text, purpose: purpose || null }), signal: AbortSignal.timeout(20000),
          });
          const out = await res2.json().catch(() => ({}));
          if (out && out.ok) return { status: 'sent', provider: 'teamlink-sms', ref: out.providerRef || null };
          if (out && out.notConfigured) return { status: 'not_configured', provider: 'teamlink-sms', error: String(out.error || 'TeamLink SMS is not ready').slice(0, 300) };
          return { status: 'failed', provider: 'teamlink-sms', error: String((out && out.error) || `HTTP ${res2.status}`).slice(0, 300) };
        } catch (e) { return { status: 'failed', provider: 'teamlink-sms', error: String((e && e.message) || e).slice(0, 300) }; }
      };
      // the login text + the RCS login wrap the new send too (installLoginText above)
      try { installLoginText((await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'providers.js')).href)).providers); } catch { /* the plain relay still sends */ }
      log('sms: the portal now sends SMS through TeamLink\'s SMS channel');
    }
    return res.json(relayInfo());
  }));

  r.get('/api/integrations/teamlink/ping', (_req, res) => res.json({ ok: true, host: 'teamlink-embed', pid: process.pid }));

  /*
   * THE AI INTERVIEW ADD-ON (founder 2026-10-30: "score candidate kii kuda kanipinchaliii thanuu akkada m mistake chestunaroo
   * vallakii teluvalli and ekkada ee changes chesukondii anii kuda ai suuggest chyaliii inetrview complete ayinakaa").
   *   GET /tl-addon/interview.js            the browser add-on (embed/interview-addon.js), added to the portal's pages by the TeamLink
   *                                         proxy (backend/src/utils/jobPortalEmbed.js): steadier live capture, a background-voice
   *                                         check while the candidate answers, and the score + coaching screen at the end.
   *   GET /api/tl-interview/:id/coach       the candidate's OWN completed interview (their portal session; the database's row
   *                                         rules decide what they may read): the score, and per question what was missing and
   *                                         what to change - written by the portal's AI model when it has one (AI_API_KEY), by
   *                                         plain rules otherwise. Cached per interview (job-portal-app/run/coach-cache.json).
   * The portal's own code is not changed.
   */
  r.get('/tl-addon/interview.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(import.meta.dirname, 'interview-addon.js'));
  });
  /*
   * THE APPLY LINK FROM WHATSAPP (founder 2026-11-09): /tl-addon/apply-link.js (embed/apply-link-addon.js). A job link with tl_apply=1 sends a visitor
   * without a login to registration first ("You're applying for <job>"), and the portal's own apply flow sends the application after they register.
   */
  /*
   * IMPORT RESUMES THAT ALSO ADD THE NEW PEOPLE (founder 2026-11-10, embed/resume-import.mjs + embed/resume-import-addon.js): a resume of
   * somebody new makes the candidate, attaches it and sends a login with the TeamLink link; files are read a few at a time. The portal's
   * own session, CSRF and role checks guard it; the portal's own modules do the work.
   */
  r.get('/tl-addon/resume-import.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(import.meta.dirname, 'resume-import-addon.js'));
  });
  r.post('/api/tl-resumes/import', (req, res, next) => {
    import(pathToFileURL(join(import.meta.dirname, 'resume-import.mjs')).href)
      .then((m) => m.handler(ROOT))
      .then((h) => h(req, res, next), next);
  });
  r.get('/tl-addon/apply-link.js', (_req, res) => {
    res.set('Content-Type', 'application/javascript; charset=utf-8');
    res.set('Cache-Control', 'no-cache');
    res.sendFile(join(import.meta.dirname, 'apply-link-addon.js'));
  });
  r.get('/api/tl-interview/:id/coach', wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const coach = await import(pathToFileURL(join(import.meta.dirname, 'interview-coach.mjs')).href);
    const { withUser } = await portal();
    const out = await coach.coachFor({ root: ROOT, req, withUser, interviewId: String(req.params.id) });
    res.status(out.status || 200).json(out.body);
  }));

  /*
   * THE INTERVIEW IN THE CANDIDATE'S LANGUAGE (founder 2026-11-05, embed/interview-language.mjs, add-on section 5): the questions in Telugu / Hindi,
   * an answer put into English for the portal's scoring, which language was spoken and the question in that language's voice (the AI calling
   * engines on TeamLink, routes/jobPortalBridge.js). Only the candidate, only their own interview; the portal's questions and scores are not changed.
   */
  const language = () => import(pathToFileURL(join(import.meta.dirname, 'interview-language.mjs')).href);
  const voiceApi = () => ({ url: teamlinkApi(), secret: pushSecret() });
  const ownOnly = (fn) => wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const L = await language();
    const { withUser } = await portal();
    const refused = await L.ownInterview({ root: ROOT, req, withUser, interviewId: String(req.params.id) });
    if (refused) return res.status(refused.status).json(refused.body);
    const lang = L.LANGS[String((req.body || {}).lang)] ? String(req.body.lang) : 'en';
    return res.json(await fn(L, req.body || {}, lang));
  });
  r.post('/api/tl-interview/:id/translate', json, ownOnly(async (L, b, lang) => {
    const texts = (Array.isArray(b.texts) ? b.texts : []).slice(0, 40).map((t) => String(t).slice(0, 600));
    if (lang === 'en') return { items: texts.map((text) => ({ text, done: true })) };
    return { items: await Promise.all(texts.map((t) => L.translateQuestion(ROOT, t, lang))) };
  }));
  r.post('/api/tl-interview/:id/to-english', json, ownOnly(async (L, b, lang) => L.answerToEnglish(ROOT, String(b.text || ''), lang)));
  r.post('/api/tl-interview/:id/hear', json, ownOnly(async (L, b, lang) => {
    const pcm = Buffer.from(String(b.pcm || ''), 'base64');
    if (pcm.length < 16000 || pcm.length > 700000) return { ready: true, lang, changed: false };
    return L.hear(voiceApi(), pcm, lang);
  }));
  r.post('/api/tl-interview/:id/say', json, ownOnly(async (L, b, lang) => L.say(voiceApi(), String(b.text || ''), lang)));
  r.get('/api/tl-interview/audio/:key', wrap(async (req, res) => {
    const wav = (await language()).soundOf(String(req.params.key));
    if (!wav) return res.status(404).end();
    res.set('Content-Type', 'audio/wav');
    res.set('Cache-Control', 'private, max-age=600');
    return res.send(wav);
  }));

  /*
   * EVERY HRMS RECRUITER / TL IS A PORTAL RECRUITER (founder 2026-10-29: "ahh positions lo new ga add ina employee
   * kanipinchadamledhu"). TeamLink sends its active Recruiters / TLs / STLs (backend/src/utils/jobPortalRecruiters.js);
   * one without a portal login of the same email gets one through the portal's own staff_recruiter_create (0035, the
   * same as Recruiters -> Add), so they appear in the portal, its mailbox list and sign in from TeamLink (HRMS SSO).
   * An existing one gets the department / employee id of its HRMS seat (HRMS decides); nothing else of it changes.
   * The password is random and never shown: they never type it. Nothing that exists is changed or removed.
   *   POST /api/integrations/teamlink/recruiters/ensure  { people: [{ name, email, employeeId, mobile, department,
   *        designation }], dryRun }  ->  { results: [{ email, result: exists | created | would-create | updated | would-update | clash, ... }] }
   */
  r.post('/api/integrations/teamlink/recruiters/ensure', wrap(async (req, res) => {
    const people = Array.isArray(req.body && req.body.people) ? req.body.people.slice(0, 1000) : [];
    const dryRun = !(req.body && req.body.dryRun === false);
    const { withUser } = await portal();
    const { hashPassword } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'auth.js')).href);
    const { randomBytes } = await import('node:crypto');
    const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };
    const results = [];
    for (const p of people) {
      const email = txt(p && p.email, 160);
      const name = txt(p && p.name, 120);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length < 2) { results.push({ email, result: 'skipped', reason: 'no name or email' }); continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const out = await withUser(SYSTEM, async (c) => {
        const u = (await c.query(`select u.role, u.status, r.id as recruiter_id, r.department, r.employee_id from users u
                                     left join recruiters r on r.user_id = u.id where lower(u.email) = lower($1) limit 1`, [email])).rows[0];
        if (u && u.recruiter_id) {
          // HRMS decides the department and employee id (the seat's): the mailbox list and its department check read them
          const dept = txt(p.department, 80);
          const code = txt(p.employeeId, 40);
          const change = (dept && dept !== (u.department || '')) || (code && code !== (u.employee_id || ''));
          if (!change) return { email, result: 'exists', id: u.recruiter_id, active: u.status === 'active' };
          if (dryRun) return { email, result: 'would-update', id: u.recruiter_id, from: u.department || null, to: dept || u.department || null };
          await c.query(`update recruiters set department = coalesce($2, department), employee_id = coalesce($3, employee_id), updated_at = now()
                          where id = $1`, [u.recruiter_id, dept, code]);
          return { email, result: 'updated', id: u.recruiter_id, from: u.department || null, to: dept || u.department || null, active: u.status === 'active' };
        }
        if (u) return { email, result: 'clash', reason: `this email already signs in to the portal as ${u.role}` };
        if (dryRun) return { email, result: 'would-create' };
        const co = (await c.query('select id from companies where id = $1', [companyId()])).rows[0];
        const made = (await c.query('select staff_recruiter_create($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as out', [
          name, email.toLowerCase(), await hashPassword(randomBytes(24).toString('base64url')), txt(p.designation, 120) || 'Recruiter',
          co ? co.id : null, txt(p.employeeId, 40), txt(p.mobile, 32), txt(p.department, 80), null, null, 'active'])).rows[0].out;
        return { email, result: 'created', id: made && made.id, active: true };
      });
      results.push(out);
    }
    const created = results.filter((x) => x.result === 'created').length;
    if (created) log(`recruiters: ${created} portal login(s) made for TeamLink Recruiters / TLs`);
    res.json({ dryRun, results });
  }));

  /*
   * CANDIDATE LOGINS FOR TEAMLINK'S OWN CANDIDATES (founder 2026-11-02: "candidate nii add chesina ledhaa import chesina ledhaa ...
   * login credentials vellaliii"). A candidate typed or imported in the ATS (or brought in from Naukri / Shine there) is not in the
   * portal's database, so the portal's own invitation never reached them. TeamLink sends who they are; this finds the portal
   * candidate by email / phone (or makes the row, the way the portal's own import does) and hands them to the portal's OWN
   * inviteCandidate (api/src/notify/invite.js) - the same routine the portal uses for a recruiter-added candidate: it makes the
   * candidate account, sends a temporary password by email / SMS / WhatsApp (must be changed at the first sign-in), is never
   * run twice for one person, skips do-not-contact, and says "sent" only when a provider really accepted the message. The
   * password is returned to nobody. A candidate login only ever reaches the candidate pages (the portal's role rules).
   *   POST /api/integrations/teamlink/candidates/invite  { people: [{ ref, name, email, phone }], dryRun }
   *        ->  { dryRun, counts, results: [{ ref, result: would-invite | invited | not-sent | already | has-login | do-not-contact | no-contact | skipped, ... }] }
   * dryRun is the DEFAULT: nothing is made or sent unless the caller says dryRun:false.
   */
  r.post('/api/integrations/teamlink/candidates/invite', wrap(async (req, res) => {
    const people = Array.isArray(req.body && req.body.people) ? req.body.people.slice(0, 500) : [];
    const dryRun = !(req.body && req.body.dryRun === false);
    const { withUser } = await portal();
    const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };
    let inviteCandidate = null;
    let resendCredentials = null;
    let newId = null;
    if (!dryRun) {
      const inv = await import(pathToFileURL(join(ROOT, 'api', 'src', 'notify', 'invite.js')).href);
      inviteCandidate = inv.inviteCandidate;
      resendCredentials = inv.resendCredentials;
      newId = (await import(pathToFileURL(join(ROOT, 'api', 'src', 'ai', 'interview-lifecycle.js')).href)).newId;
    }
    const results = [];
    for (const p of people) {
      const ref = txt(p && p.ref, 80);
      const name = txt(p && p.name, 120);
      const emailRaw = txt(p && p.email, 160);
      const email = emailRaw && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw.toLowerCase() : null;
      const digits = String((p && p.phone) || '').replace(/\D/g, '').slice(-10);
      const phone = digits.length === 10 ? digits : null;
      if (!name || name.length < 2) { results.push({ ref, result: 'skipped', reason: 'no name' }); continue; }
      if (!email && !phone) { results.push({ ref, result: 'no-contact', reason: 'no email address or mobile number' }); continue; }
      try {
        // eslint-disable-next-line no-await-in-loop
        const out = await withUser(SYSTEM, async (c) => {
          const found = (await c.query(
            `select c.id, c.name, c.email, c.phone, c.user_id, c.do_not_contact, candidate_invited(c.id) as invited,
                    exists (select 1 from candidate_invites i where i.candidate_id = c.id and i.status = 'sent') as was_sent,
                    (u.role = 'candidate' and coalesce(u.must_change_password, false)) as never_signed_in,
                    exists (select 1 from applications a where a.candidate_id = c.id and a.import_method = 'recruiter_email') as mail_import
               from candidates c left join users u on u.id = c.user_id
              where ($1::text is not null and lower(c.email) = $1) or ($2::text is not null and right(regexp_replace(coalesce(c.phone, ''), '\\D', '', 'g'), 10) = $2)
              order by c.created_at asc limit 1`, [email, phone])).rows[0];
          if (found && found.do_not_contact) return { ref, result: 'do-not-contact' };
          // ONE person, asked for on purpose (resend:true, a single entry): a fresh login for somebody who already has an account - the portal's
          // own "resend credentials" (the new password is written only after the message was sent). Never part of a list run.
          if (found && found.user_id && p && p.resend === true && people.length === 1) {
            return dryRun ? { ref, result: 'would-resend', candidateId: found.id } : { ref, result: 'resend', candidateId: found.id };
          }
          // the portal does not write to one person twice in a day (0024): a message that really left = 'already'; one tried and failed in the last 24 h = 'retry-later'
          if (found && found.invited) return { ref, result: found.was_sent ? 'already' : 'retry-later', candidateId: found.id };
          // an account exists but nobody ever signed in to it and no message ever left (an earlier send failed): send it again - the portal's
          // resend writes the new password only AFTER it was sent, so nobody is locked out. A Naukri / Shine mail import is the portal's own list.
          if (found && found.user_id && !(found.never_signed_in && !found.mail_import)) return { ref, result: 'has-login', candidateId: found.id };
          if (found && found.user_id) {
            if (dryRun) return { ref, result: 'would-invite', candidateId: found.id };
            return { ref, result: 'resend', candidateId: found.id };
          }
          if (dryRun) return { ref, result: 'would-invite', candidateId: found ? found.id : null };
          let id = found && found.id;
          if (!id) {
            id = newId('cand');
            await c.query('insert into candidates (id, name, email, phone) values ($1,$2,$3,$4)', [id, name, email, phone]);
          }
          return { ref, result: 'make', candidateId: id };
        });
        if (out.result === 'resend') {
          // eslint-disable-next-line no-await-in-loop
          const again = await resendCredentials({ id: out.candidateId, name, email, phone }, { invitedBy: 'TeamLink' });
          results.push({ ref, candidateId: out.candidateId, result: again.sent ? 'invited' : 'not-sent', delivery: again.delivery, reason: again.reason || undefined });
          continue;
        }
        if (out.result !== 'make') { results.push(out); continue; }
        // eslint-disable-next-line no-await-in-loop
        const sent = await inviteCandidate({ id: out.candidateId, name, email, phone }, { invitedBy: 'TeamLink' });
        results.push({ ref, candidateId: out.candidateId, result: sent.invited ? 'invited' : (sent.reason === 'already invited' ? 'already' : sent.reason === 'do not contact' ? 'do-not-contact' : 'not-sent'),
          accountCreated: !!sent.accountCreated, delivery: sent.delivery, reason: sent.reason || undefined });
      } catch (err) {
        results.push({ ref, result: 'not-sent', reason: String(err && err.message || err).slice(0, 200) });
      }
    }
    const counts = {};
    for (const x of results) counts[x.result] = (counts[x.result] || 0) + 1;
    if (!dryRun && counts.invited) log(`candidates: ${counts.invited} portal login(s) sent to TeamLink candidates`);
    res.json({ dryRun, counts, results });
  }));

  /*
   * EVERY TEAMLINK ADMIN / SUPER ADMIN IS A PORTAL ADMIN (founder 2026-10-30: "admin kiii job portal access denied anii
   * ostundhii"). The HRMS sign-in (api/src/routes/hrms-sso.js) opens the portal account with the SAME EMAIL and never
   * makes one; the portal has no screen that adds an administrator (only its seed, api/src/scripts/seed-auth.js). So
   * TeamLink sends its active Admins / Super Admins (backend/src/utils/jobPortalRecruiters.js ensureAdmins) and one
   * without a portal login gets one here, the way seed-auth.js makes it: a users row (role admin, a random password
   * nobody types - they come in from TeamLink) and its admins profile. Written on the owner connection because app_api
   * cannot write users (0027). An email that already signs in as something else (a recruiter, a candidate) is left
   * alone and reported as a clash; nothing that exists is changed or removed.
   *   POST /api/integrations/teamlink/admins/ensure  { people: [{ name, email }], dryRun }
   *        ->  { results: [{ email, result: exists | created | would-create | clash | skipped, ... }] }
   */
  r.post('/api/integrations/teamlink/admins/ensure', wrap(async (req, res) => {
    const people = Array.isArray(req.body && req.body.people) ? req.body.people.slice(0, 200) : [];
    const dryRun = !(req.body && req.body.dryRun === false);
    const { getPool } = await portal();
    const { hashPassword } = await import(pathToFileURL(join(ROOT, 'api', 'src', 'auth.js')).href);
    const { randomBytes } = await import('node:crypto');
    const txt = (v, max) => { const s = String(v == null ? '' : v).trim(); return s ? s.slice(0, max) : null; };
    const results = [];
    for (const p of people) {
      const email = txt(p && p.email, 160);
      const name = txt(p && p.name, 120);
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name || name.length < 2) { results.push({ email, result: 'skipped', reason: 'no name or email' }); continue; } // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const c = await getPool().connect();
      try {
        // eslint-disable-next-line no-await-in-loop
        await c.query('begin');
        // eslint-disable-next-line no-await-in-loop
        const u = (await c.query(`select u.id, u.role, u.status, a.id as admin_id from users u left join admins a on a.user_id = u.id
                                    where lower(u.email) = lower($1) limit 1`, [email])).rows[0];
        let out;
        if (u && u.role === 'admin') {
          if (!u.admin_id && !dryRun) {
            // eslint-disable-next-line no-await-in-loop
            await c.query(`insert into admins (id, user_id, name, email, title) values ($1, $2, $3, $4, 'Administrator')`,
              [`tl_a_${randomBytes(6).toString('hex')}`, u.id, name, email.toLowerCase()]);
          }
          out = { email, result: 'exists', active: u.status === 'active' };
        } else if (u) {
          out = { email, result: 'clash', reason: `this email already signs in to the portal as ${u.role}` };
        } else if (dryRun) {
          out = { email, result: 'would-create' };
        } else {
          // eslint-disable-next-line no-await-in-loop
          const hash = await hashPassword(randomBytes(24).toString('base64url'));
          // eslint-disable-next-line no-await-in-loop
          const id = (await c.query(`insert into users (email, password_hash, role, status) values ($1, $2, 'admin', 'active') returning id`,
            [email.toLowerCase(), hash])).rows[0].id;
          const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
          // eslint-disable-next-line no-await-in-loop
          await c.query(`insert into admins (id, user_id, name, email, title, initials) values ($1, $2, $3, $4, 'Administrator', $5)`,
            [`tl_a_${randomBytes(6).toString('hex')}`, id, name, email.toLowerCase(), initials || null]);
          out = { email, result: 'created', active: true };
        }
        // eslint-disable-next-line no-await-in-loop
        await c.query('commit');
        results.push(out);
      } catch (err) {
        await c.query('rollback').catch(() => {}); // eslint-disable-line no-await-in-loop
        results.push({ email, result: 'failed', reason: err.message });
      } finally {
        c.release();
      }
    }
    const created = results.filter((x) => x.result === 'created').length;
    if (created) log(`admins: ${created} portal admin login(s) made for TeamLink Admins`);
    res.json({ dryRun, results });
  }));

  /*
   * NAUKRI & SHINE MAILBOXES, managed from TeamLink Administration -> Integrations (2026-10-29, founder).
   *
   * The mailbox engine stays the portal's own (api/src/routes/source-mailboxes.js, 0135): the real IMAP login
   * before anything is saved, the sealed app password that is never sent back, sync / reconnect / disconnect /
   * reassign / logs. Its router is mounted here unchanged under .../mailboxes, run as the portal administrator
   * (SYSTEM): TeamLink checked the person's own permission before calling. Two things are added on this side:
   *   GET  .../mailboxes/recruiters   the portal recruiters with department, employee id and an active login
   *   POST .../mailboxes/intake/source-connections   refused (422, before any login) for a recruiter whose
   *        login is not active, or who is not in the department chosen on the screen
   */
  const MAILBOXES = '/api/integrations/teamlink/mailboxes';
  let mailboxRouter = null;
  const mailboxes = async () => {
    if (!mailboxRouter) mailboxRouter = (await import(pathToFileURL(join(ROOT, 'api', 'src', 'routes', 'source-mailboxes.js')).href)).default();
    return mailboxRouter;
  };
  const RECRUITERS_SQL = `select r.id, r.name, r.email, r.employee_id, r.department, r.designation, coalesce(u.status, 'active') as login_status
                            from recruiters r left join users u on u.id = r.user_id`;
  r.get(`${MAILBOXES}/recruiters`, wrap(async (_req, res) => {
    const { withUser } = await portal();
    const rows = await withUser(SYSTEM, async (c) => (await c.query(`${RECRUITERS_SQL} order by r.name`)).rows);
    res.json({
      recruiters: rows.map((x) => ({
        id: x.id, name: x.name, email: x.email, employeeId: x.employee_id || undefined, department: x.department || undefined,
        designation: x.designation || undefined, active: x.login_status === 'active',
      })),
      departments: [...new Set(rows.map((x) => String(x.department || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    });
  }));
  r.post(`${MAILBOXES}/intake/source-connections`, wrap(async (req, _res, next) => {
    const b = req.body || {};
    if (!b.recruiterId) return next();                 // the portal's own validation answers that one
    const { withUser } = await portal();
    const rec = await withUser(SYSTEM, async (c) => (await c.query(`${RECRUITERS_SQL} where r.id = $1`, [String(b.recruiterId)])).rows[0]);
    if (!rec) return next();
    const refuse = (message) => Object.assign(new HttpError(422, 'VALIDATION_FAILED', message), { details: { recruiterId: message } });
    if (rec.login_status !== 'active') throw refuse(`${rec.name}'s login is not active, so a mailbox cannot be connected to them.`);
    const dept = String(b.department || '').trim();
    if (dept && String(rec.department || '').trim().toLowerCase() !== dept.toLowerCase()) throw refuse(`${rec.name} is not in the ${dept} department.`);
    return next();
  }));
  /*
   * NAUKRI WEBMAIL (2026-11-02): Test Connection (nothing saved) for any IMAP settings, and the company mailboxes on STARTTLS, which
   * the portal's IMAP client (SSL only) cannot open - read by ./webmail-mailbox.mjs with the portal's own processing and tables.
   *   POST .../mailboxes/webmail/test            { host, port, security, username?, address, password } -> { ok, message }
   *   GET  .../mailboxes/webmail/starttls        { ids } the STARTTLS mailboxes
   *   POST .../mailboxes/webmail/connect         { source, recruiterId, address, username?, password, host, port, takeOver? } (STARTTLS)
   *   POST .../mailboxes/webmail/:id/reconnect   { password?, username? }     POST .../mailboxes/webmail/:id/sync
   * A webmail mailbox on SSL/TLS is the portal's own "Other (IMAP)" connection (.../intake/source-connections).
   */
  let webmail = null;
  const wm = async () => {
    if (!webmail) {
      const { webmailEngine } = await import(pathToFileURL(join(import.meta.dirname, 'webmail-mailbox.mjs')).href);
      webmail = webmailEngine({ root: ROOT, withUser: (await portal()).withUser });
    }
    return webmail;
  };
  const wmSend = (fn) => async (req, res) => {
    try { res.json(await fn(await wm(), req)); } catch (err) {
      if (err && err.status && err.code) return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
      console.error('[webmail]', String((err && err.message) || err));
      return res.status(500).json({ error: { code: 'WEBMAIL_FAILED', message: 'The webmail request failed on the server.' } });
    }
    return undefined;
  };
  r.post(`${MAILBOXES}/webmail/test`, wmSend((w, req) => {
    const b = req.body || {};
    const user = String(b.username || '').trim() || String(b.address || '').trim();
    if (!String(b.host || '').trim() || !user || !b.password) {
      throw new HttpError(422, 'VALIDATION_FAILED', 'Enter the IMAP server, the username (or email address) and the password.');
    }
    return w.testLogin({ host: String(b.host).trim(), port: b.port, security: b.security === 'starttls' ? 'starttls' : 'ssl', user, password: String(b.password) });
  }));
  r.get(`${MAILBOXES}/webmail/starttls`, wmSend(async (w) => ({ ids: await w.starttlsIds() })));
  r.post(`${MAILBOXES}/webmail/connect`, wmSend((w, req) => w.connect(req.body || {})));
  r.post(`${MAILBOXES}/webmail/:id/reconnect`, wmSend((w, req) => w.reconnect(req.params.id, req.body || {})));
  r.post(`${MAILBOXES}/webmail/:id/sync`, wmSend((w, req) => w.sync(req.params.id)));
  // the STARTTLS mailboxes are read every INTAKE_SYNC_MS like the portal's own (not when DISABLE_BACKGROUND_WORK=true)
  setTimeout(() => { wm().then((w) => w.startTimer()).catch((err) => console.error('[webmail] timer not started:', String(err && err.message))); }, 5000).unref?.();

  r.use(MAILBOXES, (req, res, next) => {
    req.session = { ...SYSTEM, profileId: null };
    mailboxes().then((mr) => mr(req, res, next), next);
  });

  /*
   * The rest of the portal's Administration -> Integrations module, managed from TeamLink the same way (2026-10-29):
   *   .../job-sites   routes/job-publishing.js        /admin/integrations...         Naukri / Shine / Indeed by API or feed
   *   .../channels    routes/integration-channels.js  /admin/integration-channels... the portal's Email (SMTP), SMS, WhatsApp
   *   .../screening   routes/screening.js             /screening/settings            AI Settings: the screening questions
   * Each is the portal's own router, unchanged, run as the portal administrator. TeamLink's backend calls only the
   * administrator endpoints of each (backend/src/routes/portalAdmin.js).
   */
  for (const [name, file] of [['job-sites', 'job-publishing.js'], ['channels', 'integration-channels.js'], ['screening', 'screening.js']]) {
    let made = null;
    const router = async () => {
      if (!made) made = (await import(pathToFileURL(join(ROOT, 'api', 'src', 'routes', file)).href)).default();
      return made;
    };
    r.use(`/api/integrations/teamlink/${name}`, (req, res, next) => {
      req.session = { ...SYSTEM, profileId: null };
      router().then((pr) => pr(req, res, next), next);
    });
  }

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
        // a TeamLink job's application, or a Naukri / Shine mail response TeamLink filed in its ATS (utils/mailImports.js)
        const cur = await c.query(`select stage from applications where id=$1 and (job_id like 'tl\\_%' or import_method = 'recruiter_email')`, [id]);
        if (!cur.rowCount) { out.push({ id, error: 'no such TeamLink application on the portal' }); continue; }
        // "Pushed to ATS" (0145): TeamLink's 65% rule moved it (backend/src/utils/autoSendToAts.js); the first push stands
        if (u.pushed && ['auto_screening', 'auto_ai_interview', 'send_to_ats'].includes(u.pushed.via)) {
          await c.query('savepoint tl_pushed');
          try {
            await c.query(`update applications set ats_pushed_at = coalesce(ats_pushed_at, now()), ats_pushed_via = coalesce(ats_pushed_via, $2),
                                 ats_pushed_score = coalesce(ats_pushed_score, $3) where id = $1`, [id, u.pushed.via, Number.isFinite(Number(u.pushed.score)) ? Number(u.pushed.score) : null]);
            await c.query('release savepoint tl_pushed');
          } catch { await c.query('rollback to savepoint tl_pushed').catch(() => {}); /* an older portal without 0145 */ }
        }
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
      // ?aiSince= : only the applications whose AI interview started / finished since then, whenever they applied
      // (TeamLink asks every 2 minutes, so a finished interview shows in the ATS at once - founder 2026-11-03)
      const aiSince = req.query.aiSince ? new Date(String(req.query.aiSince)) : null;
      if (aiSince && !Number.isNaN(aiSince.getTime())) {
        params.push(aiSince.toISOString());
        sql += ` and exists (select 1 from ai_interviews i where i.application_id = a.id and coalesce(i.completed_at, i.started_at, i.created_at) >= $${params.length})`;
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

  /*
   * NAUKRI / SHINE MAIL IMPORTS -> THE ATS (founder 2026-10-30: "shine nad nauki responses oche mail sync ani click chesakkaa
   * read anii no of candiates chpistunaii kaniii applications loo kanipiyadam ledhuu"). The mailbox import puts each response on
   * a portal job matched by the mail's title - usually a job of its own ("Urgent | Hiring For ..."), not a TeamLink requirement
   * (tl_*), so the pull above never carried them. These are listed here with the job title and the mailbox recruiter's email;
   * TeamLink matches the title to a requirement and owns the matching (backend/src/utils/mailImports.js).
   */
  r.get('/api/integrations/teamlink/mail-applications', wrap(async (req, res) => {
    const { withUser } = await portal();
    const since = req.query.since ? new Date(String(req.query.since)) : null;
    const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 5000);
    const rows = await withUser(SYSTEM, async (c) => {
      const params = [];
      let sql = `select a.*, j.title as job_title, rec.email as recruiter_email, rec.name as recruiter_name
                   from applications a join jobs j on j.id = a.job_id left join recruiters rec on rec.id = a.recruiter_id
                  where a.import_method = 'recruiter_email' and a.job_id not like 'tl\\_%'`;
      if (since && !Number.isNaN(since.getTime())) { params.push(since.toISOString()); sql += ` and a.applied_at >= $${params.length}`; }
      params.push(limit);
      sql += ` order by a.applied_at desc limit $${params.length}`;
      const shaped = [];
      for (const row of (await c.query(sql, params)).rows) {
        const s = await shapeApplication(c, row);
        if (!s) continue; // eslint-disable-line no-continue
        s.event = 'application.mail';
        s.application.recruiterEmail = row.recruiter_email || null;
        s.application.recruiterName = row.recruiter_name || null;
        if (s.application.resume) s.application.resume.path = `/api/integrations/teamlink/mail-applications/${encodeURIComponent(row.id)}/resume`;
        shaped.push(s);
      }
      return shaped;
    });
    res.json({ applications: rows });
  }));
  r.get('/api/integrations/teamlink/mail-applications/:id/resume', wrap(async (req, res) => {
    const { withUser, getStorage } = await portal();
    const row = await withUser(SYSTEM, async (c) => (await c.query(
      `select a.resume_path, c.resume_storage_path, c.resume_file, c.resume_mime
         from applications a join candidates c on c.id = a.candidate_id
        where a.id=$1 and a.import_method = 'recruiter_email'`, [req.params.id])).rows[0]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such mail-imported application.' } });
    return sendResumeRow(res, row, getStorage);
  }));

  /** The resume a TeamLink application was made with (or the candidate's current one). */
  r.get('/api/integrations/teamlink/applications/:id/resume', wrap(async (req, res) => {
    const { withUser, getStorage } = await portal();
    const row = await withUser(SYSTEM, async (c) => (await c.query(
      `select a.resume_path, c.resume_storage_path, c.resume_file, c.resume_mime
         from applications a join candidates c on c.id = a.candidate_id
        where a.id=$1 and a.job_id like 'tl\\_%'`, [req.params.id])).rows[0]);
    if (!row) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such TeamLink application.' } });
    return sendResumeRow(res, row, getStorage);
  }));

  // The resume file of an application row (a TeamLink one, or a Naukri / Shine mail import) - the same answer for both routes.
  async function sendResumeRow(res, row, getStorage) {
    const key = row.resume_path || row.resume_storage_path;
    if (!key) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No resume on this application.' } });
    const buf = await getStorage().get(key);
    const name = String(row.resume_file || key.split('/').pop() || 'resume').replace(/["\r\n]/g, '');
    res.setHeader('content-type', row.resume_mime || 'application/octet-stream');
    res.setHeader('content-disposition', `attachment; filename="${name}"`);
    res.setHeader('x-file-name', encodeURIComponent(name));
    return res.end(buf);
  }

  // Errors from these routes only (anything else falls through to the portal).
  // eslint-disable-next-line no-unused-vars
  r.use('/api/integrations/teamlink', (err, _req, res, _next) => {
    const status = err.status || (err.statusCode) || 500;
    if (status >= 500) log('route error:', err.message);
    res.status(status).json({ error: {
      code: err.code || 'INTERNAL',
      message: status >= 500 ? 'The job portal could not do that.' : err.message,
      details: status < 500 && err.details ? err.details : undefined, // the field a mailbox form error belongs to
    } });
  });

  // The sweep: anything the instant push missed (TeamLink was restarting, ...).
  const t = setInterval(pushRecent, 15_000);
  t.unref();
  setTimeout(pushRecent, 5000).unref();
  log(`TeamLink sync ready (ATS at ${teamlinkApi()}, token ${syncToken() ? 'set' : 'NOT set'}, push secret ${pushSecret() ? 'set' : 'NOT set'})`);
  return r;
}
