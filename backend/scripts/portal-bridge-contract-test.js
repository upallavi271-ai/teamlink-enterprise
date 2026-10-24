#!/usr/bin/env node
/**
 * Job Portal <-> TeamLink bridge contract test.
 *
 * Runs against a SANDBOX portal (never the live one, never a real database):
 *   - the portal is started separately on its own port with a COPY of the data,
 *     with TEAMLINK_API_URL pointing at this script's mock ATS (default 4019),
 *     JOB_PORTAL_SYNC_TOKEN / JOB_PORTAL_PUSH_SECRET set to the values below.
 *   - this script plays TeamLink (token calls) and the ATS (receives the push),
 *     and plays a candidate (registers a ZZTEST account on the sandbox, applies).
 *
 * Usage:
 *   node scripts/portal-bridge-contract-test.js [--portal http://127.0.0.1:4324]
 *        [--token testtoken] [--secret testsecret] [--mock-port 4019]
 *
 * Checks: ping auth; job upsert + public visibility; jobs/sync (+ one bad row
 * isolated); utm/ref attribution (tl_attr cookie -> push payload);
 * application push to the ATS with the right secret and payload shape;
 * GET applications; stage push-back incl. every stage id TeamLink maps to
 * (the interview events), and rejection of an unknown stage; resume 404;
 * the portal's new v11 routes exist and need a login.
 * Exit code 0 = all passed.
 */
const http = require('http');

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const PORTAL = arg('portal', 'http://127.0.0.1:4324');
const TOKEN = arg('token', 'testtoken');
const SECRET = arg('secret', 'testsecret');
const MOCK_PORT = parseInt(arg('mock-port', '4019'), 10);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? `  -> ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 300)}` : ''}`);
}

// ---- mock ATS --------------------------------------------------------------
const pushed = [];
const mock = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    let json = null; try { json = JSON.parse(body); } catch { /* */ }
    pushed.push({ url: req.url, secret: req.headers['x-job-portal-secret'], body: json });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: 'created' }));
  });
});

// ---- tiny http client with a cookie jar ------------------------------------
function client() {
  const jar = {};
  async function call(method, path, { body, headers = {}, raw } = {}) {
    const h = { ...headers, cookie: Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '), origin: PORTAL };
    if (jar.tl_csrf) h['x-csrf-token'] = decodeURIComponent(jar.tl_csrf);
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(PORTAL + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    (res.headers.getSetCookie ? res.headers.getSetCookie() : []).forEach((c) => {
      const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    const text = await res.text();
    let json = null; try { json = JSON.parse(text); } catch { /* */ }
    return { status: res.status, json, text: raw ? text : undefined, headers: res.headers };
  }
  return { call, jar };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tl = (c, method, path, body, token = TOKEN) => c.call(method, `/api/integrations/teamlink${path}`, { body, headers: token == null ? {} : { 'x-teamlink-token': token } });

(async () => {
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const tag = `ZZTEST${Date.now().toString(36)}`;
  const c = client();

  // 1. ping / auth
  let r = await tl(c, 'GET', '/ping', undefined, null);
  check('ping without token is refused (401)', r.status === 401, r.status);
  r = await tl(c, 'GET', '/ping', undefined, 'wrong-token');
  check('ping with a wrong token is refused (401)', r.status === 401, r.status);
  r = await tl(c, 'GET', '/ping');
  check('ping with the right token answers ok', r.status === 200 && r.json && r.json.ok === true, r);

  // 2. one job
  const reqId = `${tag}-A`;
  r = await tl(c, 'PUT', `/jobs/${reqId}`, { title: `${tag} Teacher`, location: 'Hyderabad', mode: 'Work From Office', status: 'open', skills: ['Maths'], desc: 'sandbox', openings: 2 });
  const jobId = r.json && r.json.job && r.json.job.id;
  check('PUT job creates an open tl_ job', r.status === 200 && /^tl_/.test(jobId || '') && r.json.job.status === 'open', r);
  r = await c.call('GET', '/api/bootstrap');
  const pub = r.json && r.json.data && r.json.data.jobs;
  check('the job is visible on the public portal (bootstrap)', Array.isArray(pub) && pub.some((j) => j.id === jobId), r.status);
  const live = pub.find((j) => j.id === jobId);
  check('public job keeps title/location/mode', live && live.title === `${tag} Teacher` && live.location === 'Hyderabad', live);

  // 3. sync, with one bad row that must not break the others
  r = await tl(c, 'POST', '/jobs/sync', { jobs: [{ requirementId: `${tag}-B`, title: `${tag} Clerk`, status: 'open' }, { requirementId: `${tag}-BAD`, title: '' }, { requirementId: reqId, title: `${tag} Teacher`, status: 'open' }], closeOthers: false });
  const res = (r.json && r.json.results) || [];
  check('jobs/sync upserts good rows and isolates the bad one', r.status === 200 && res.length === 3 && res[0].status === 'open' && !!res[1].error && res[2].status === 'open', r);
  // closeOthers closes a ZZTEST-only job that is not listed (sandbox data only)
  r = await tl(c, 'PUT', `/jobs/${tag}-C`, { title: `${tag} Closeme`, status: 'open' });
  const closeId = r.json && r.json.job && r.json.job.id;
  const keepIds = [jobId, res[0] && res[0].id];
  r = await tl(c, 'POST', '/jobs/sync', { jobs: [{ requirementId: reqId, title: `${tag} Teacher`, status: 'open' }, { requirementId: `${tag}-B`, title: `${tag} Clerk`, status: 'open' }], closeOthers: true });
  check('jobs/sync closeOthers closes the unlisted tl_ job', r.status === 200 && Array.isArray(r.json.closed) && r.json.closed.includes(closeId), r.json);

  // 4. a candidate arrives from a campaign link, registers (sandbox only) and applies
  await c.call('GET', `/?utm_source=${tag}src&utm_campaign=${tag}camp&ref=${tag}ref`);
  check('tl_attr attribution cookie is set on a campaign link', !!c.jar.tl_attr, Object.keys(c.jar));
  await c.call('GET', '/api/csrf');
  const email = `${tag.toLowerCase()}@example.com`;
  r = await c.call('POST', '/api/auth/register', { body: { name: `${tag} Candidate`, email, password: 'Zztest1234', confirmPassword: 'Zztest1234', phone: '9876543210', preferredLocation: 'Hyderabad', expectedCtc: 3, noticePeriod: 'Immediate', preferredWorkModes: ['Work From Office'], consent: { terms: true, communication: true, resumeProcessing: true } } });
  check('sandbox candidate registers', r.status >= 200 && r.status < 300, r);
  if (!(r.status >= 200 && r.status < 300)) { r = await c.call('POST', '/api/auth/login', { body: { email, password: 'Zztest1234' } }); }
  await c.call('GET', '/api/csrf');
  r = await c.call('POST', '/api/applications', { body: { jobId, source: 'Portal' } });
  const appId = r.json && r.json.application && r.json.application.id;
  check('candidate applies to the TeamLink job', (r.status === 200 || r.status === 201) && !!appId, r);

  // 5. the push reaches the ATS within seconds, with the right secret and attribution
  for (let i = 0; i < 30 && !pushed.length; i += 1) await sleep(500);
  const p = pushed.find((x) => x.body && x.body.application && x.body.application.id === appId) || pushed[0];
  check('application pushed to the ATS (POST /api/public/job-portal/applications)', !!p && /\/api\/public\/job-portal\/applications$/.test(p.url), pushed.length);
  check('push carries the shared secret', p && p.secret === SECRET, p && p.secret);
  const pb = (p && p.body) || {};
  check('push payload: application id, job id, candidate name/email', pb.application && pb.application.id === appId && pb.application.jobId === jobId && pb.candidate && pb.candidate.email === email, pb);
  const at = pb.attribution;
  check('push payload: utm / ref attribution (tl_attr)', at && at.utm_source === `${tag}src` && at.utm_campaign === `${tag}camp` && at.ref === `${tag}ref`, at);

  // 6. pull side
  r = await tl(c, 'GET', '/applications?limit=50');
  const got = r.json && r.json.applications;
  check('GET applications lists the new application, shaped', Array.isArray(got) && got.some((a) => a.application && a.application.id === appId), r.status);
  r = await tl(c, 'GET', `/applications/${appId}/resume`);
  check('resume of an application without a resume is 404', r.status === 404, r.status);

  // 7. status push-back: every stage id TeamLink maps to must exist in the portal
  let stages = ['ai_screening', 'ai_interview_done', 'shortlisted', 'with_bde', 'client_review', 'interview_scheduled', 'selected', 'offer_extended'];
  try { const m = require('../src/utils/jobPortalBridge'); if (m.PORTAL_STAGE_OF) stages = [...new Set(Object.values(m.PORTAL_STAGE_OF))]; } catch { /* keep the list */ }
  const errs = [];
  for (const st of stages) {
    // eslint-disable-next-line no-await-in-loop
    r = await tl(c, 'POST', '/applications/stages', { updates: [{ id: appId, stage: st, note: 'contract test' }] });
    const x = r.json && r.json.results && r.json.results[0];
    if (!x || x.error) errs.push(`${st}: ${x && x.error}`);
  }
  check(`stage push-back accepts all ${stages.length} stage ids TeamLink maps to`, !errs.length, errs);
  r = await tl(c, 'POST', '/applications/stages', { updates: [{ id: appId, stage: 'not_a_stage' }] });
  check('an unknown stage is rejected for that row only', r.status === 200 && r.json.results[0].error, r.json);

  // 8. v11 additions are present and protected
  r = await c.call('POST', '/api/ats/send-to-pipeline', { body: { candidateIds: [] } });
  check('v11 POST /api/ats/send-to-pipeline exists and is for recruiters only (candidate gets 403, not 404)', r.status === 403 || r.status === 401 || r.status === 400, r.status);
  r = await fetch(`${PORTAL}/api/health`).then((x) => x.status).catch(() => 0);
  check('portal health endpoint answers', r === 200, r);

  mock.close();
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Sandbox rows are tagged ${tag}.`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('test crashed:', e); try { mock.close(); } catch { /* */ } process.exit(2); });
