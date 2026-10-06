// ---------------------------------------------------------------------------
// LINKEDIN — Job Posting API (partner-only).
//   Docs  https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/overview
//         https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/create-jobs
//         https://learn.microsoft.com/en-us/linkedin/talent/job-postings/api/check-job-taskstatus
//         https://learn.microsoft.com/en-us/linkedin/shared/authentication/client-credentials-flow
//   IMPORTANT: the overview says LinkedIn is currently NOT accepting new
//   partnerships for the Job Posting API (new requests go to Apply Connect).
//   The other approved route, the "Basic Jobs" (Limited Listings) XML feed,
//   needs a LinkedIn contract (https://learn.microsoft.com/en-us/linkedin/talent/job-postings/xml-feeds-development-guide),
//   and LinkedIn may require paid promotion for staffing-firm jobs.
//   Partner form: https://business.linkedin.com/talent-solutions/ats-partners/partner-application
//
//   token    POST https://www.linkedin.com/oauth/v2/accessToken
//            (form: grant_type=client_credentials, client_id, client_secret)
//   publish  POST https://api.linkedin.com/rest/simpleJobPostings
//            x-restli-method: batch_create, LinkedIn-Version: <yyyymm>
//            elements[]: { externalJobPostingId = the master job id,
//            jobPostingOperationType CREATE | UPDATE | CLOSE, … }
//            -> elements[].id = urn:li:simpleJobPostingTask:…  (status 202)
//   status   GET https://api.linkedin.com/rest/simpleJobPostingTasks?ids=<task urn>
//            IN_PROGRESS | SUCCEEDED (jobPosting urn) | FAILED (+ message)
// "Posted" only when the task is SUCCEEDED.
// ---------------------------------------------------------------------------
const http = require('./http');
const { boardSettings, jobText } = require('./common');

const LABEL = 'LinkedIn';
const F = {
  org: 'Organization ID', clientId: 'Client ID', secret: 'Client secret', poster: 'Poster email', version: 'API version (LinkedIn-Version)',
};
const FIELDS = [[F.org, 'LinkedIn company page id (numbers)'], [F.clientId, ''], [F.secret, ''], [F.poster, 'recruiter@your-company'],
  [F.version, 'e.g. 202604 — from LinkedIn\'s docs']];
const NEED = [F.org, F.clientId, F.secret, F.poster, F.version];
const SETUP = 'LinkedIn posts jobs only for approved partners, and its Job Posting API is not taking new partners right now. Ask LinkedIn Talent Solutions for partner access (or a Basic Jobs feed contract), then add the Organization ID, Client ID, Client secret, poster email and API version in Administration → Integrations → LinkedIn.';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const POST_URL = 'https://api.linkedin.com/rest/simpleJobPostings';
const TASK_URL = 'https://api.linkedin.com/rest/simpleJobPostingTasks';

async function config() {
  const s = await boardSettings('linkedin', NEED, LABEL);
  if (s.ready || s.hint) return s;
  return { ...s, hint: s.missing.length >= 3 ? SETUP : `LinkedIn: fill in ${s.missing.join(', ')} in Administration → Integrations → LinkedIn.` };
}

async function token(cfg) {
  const v = cfg.values;
  const key = `linkedin|${v[F.clientId]}`;
  const have = http.cachedToken(key);
  if (have) return { ok: true, token: have };
  const res = await http.call(LABEL, TOKEN_URL, {
    method: 'POST', form: { grant_type: 'client_credentials', client_id: v[F.clientId], client_secret: v[F.secret] }, secrets: [v[F.secret]],
  });
  if (!res.ok) return { ok: false, error: res.code ? res.error : `Could not sign in to LinkedIn. ${res.error}` };
  if (!res.body || !res.body.access_token) return { ok: false, error: 'LinkedIn did not return an access token.' };
  http.rememberToken(key, res.body.access_token, res.body.expires_in);
  return { ok: true, token: res.body.access_token };
}

const EMPLOYMENT = { 'full time': 'FULL_TIME', 'part time': 'PART_TIME', contract: 'CONTRACT', intern: 'INTERNSHIP', internship: 'INTERNSHIP', temporary: 'TEMPORARY' };
const WORKPLACE = (m) => (/remote/i.test(m || '') ? 'Remote' : /hybrid/i.test(m || '') ? 'Hybrid' : 'On-site');

function element(r, cfg, op) {
  const v = cfg.values;
  return {
    company: `urn:li:company:${String(v[F.org]).trim()}`,
    companyApplyUrl: http.publicUrl(require('../jobSlug').careersPath(r, 'LinkedIn')), // eslint-disable-line global-require
    description: (jobText(r) || r.title).slice(0, 25000), // LinkedIn needs 100+ characters
    employmentStatus: EMPLOYMENT[String(r.employmentType || '').toLowerCase()] || 'FULL_TIME',
    externalJobPostingId: r.id, // the master job id
    listedAt: Date.now(),
    jobPostingOperationType: op,
    title: r.title,
    location: `${r.location || 'India'}, India`.replace(/, India, India$/, ', India'),
    workplaceTypes: [WORKPLACE(r.workMode)],
    listingType: 'BASIC',
    posterEmail: String(v[F.poster]).trim(),
  };
}

async function send(r, cfg, op) {
  const t = await token(cfg);
  if (!t.ok) return { ok: false, error: t.error };
  const res = await http.call(LABEL, POST_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${t.token}`, 'x-restli-method': 'batch_create', 'linkedin-version': String(cfg.values[F.version]).trim() },
    json: { elements: [element(r, cfg, op)] },
    secrets: [cfg.values[F.secret], t.token],
  });
  if (!res.ok) return res;
  const el = res.body && Array.isArray(res.body.elements) ? res.body.elements[0] : null;
  if (!el || !el.id || (el.status && Number(el.status) >= 400)) {
    const why = el && el.error ? (el.error.message || JSON.stringify(el.error)) : 'no task id came back';
    return { ok: false, error: `LinkedIn did not accept the job: ${http.plain(why, 160)}` };
  }
  return { ok: true, task: el.id, token: t.token };
}

async function check(cfg, task) {
  if (!task) return { status: 'Pending', errorMessage: 'Sent to LinkedIn. Waiting for LinkedIn to finish (a few minutes).' };
  const t = await token(cfg);
  if (!t.ok) return { status: 'Pending', errorMessage: `Sent to LinkedIn; could not read its status yet: ${t.error}` };
  const res = await http.call(LABEL, `${TASK_URL}?ids=${encodeURIComponent(task)}`, {
    headers: { authorization: `Bearer ${t.token}`, 'linkedin-version': String(cfg.values[F.version]).trim() }, secrets: [cfg.values[F.secret], t.token],
  });
  if (!res.ok) return { status: 'Pending', errorMessage: `Sent to LinkedIn; could not read its status yet: ${res.error}`, called: true };
  const results = res.body && res.body.results ? res.body.results : {};
  const info = results[task] || Object.values(results)[0] || null;
  const st = info ? String(info.status || '') : '';
  if (st === 'SUCCEEDED') {
    const urn = String(info.jobPosting || '');
    const num = (urn.match(/(\d+)$/) || [])[1];
    return { status: 'Posted', externalUrl: num ? `https://www.linkedin.com/jobs/view/${num}` : null, called: true };
  }
  if (st === 'FAILED') return { status: 'Failed', errorMessage: `LinkedIn refused the job: ${http.plain(info.errorMessage || 'no reason given', 160)}`, called: true };
  return { status: 'Pending', errorMessage: 'Sent to LinkedIn. Waiting for LinkedIn to finish (a few minutes).', called: true };
}

async function publish(r, row, cfg) {
  if (!http.publicUrl('/')) return { status: 'Failed', errorMessage: 'LinkedIn needs a public apply link, but APP_BASE_URL (this site\'s public address) is not set on the server.' };
  const op = row && row.status === 'Posted' ? 'UPDATE' : 'CREATE';
  const res = await send(r, cfg, op);
  if (!res.ok) return { status: row && row.status === 'Posted' ? 'Posted' : 'Failed', errorMessage: res.error, called: true };
  const st = await check(cfg, res.task);
  return { ...st, externalJobId: res.task, called: true };
}
async function remove(r, row, cfg) {
  const res = await send(r, cfg, 'CLOSE');
  if (!res.ok) return { status: 'Posted', errorMessage: `Could not take it off LinkedIn: ${res.error} Press Retry.`, called: true };
  return { status: 'Removed', externalJobId: res.task, called: true };
}
async function status(r, row, cfg) { return check(cfg, row && row.externalJobId); }

module.exports = {
  id: 'linkedin', label: LABEL, integrationId: 'linkedin', FIELDS, SETUP, config, publish, update: publish, remove, status, shownId: (x) => x,
};
