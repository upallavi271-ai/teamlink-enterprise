// ---------------------------------------------------------------------------
// LOCAL MOCK JOB PORTAL (tests only). Never a real site, never a real login.
//
// A tiny HTTP server on a random local port that behaves like three job boards (/naukri, /foundit, /shine), each with
// its OWN page layout (different field names), so the real adapters are tested end to end with real Playwright + local
// Chrome. Every address in the pages is local.
//
// The one valid test login:   recruiter@mock.test  /  MockPass#1   (a made-up value that exists only here)
// Other usernames pick a SCENARIO:
//   captcha-user   the sign-in answers with a CAPTCHA page                       -> NEEDS_HUMAN
//   otp-user       ... an "enter the OTP" page WITH a box; the code 246810 is accepted -> a person types it (human in the loop); no code in time -> NEEDS_HUMAN
//   twofactor-user ... a 2-step verification page                                 -> NEEDS_HUMAN
//   unusual-user   ... "unusual activity" page                                    -> NEEDS_HUMAN
//   blocked-user   the sign-in answers HTTP 429 "too many requests"                -> NEEDS_HUMAN
//   slow-user      the sign-in hangs for 8 s                                       -> TIMEOUT (retryable)
//   any user + any other password  "Invalid username or password"                 -> WRONG_PASSWORD
// The job's TITLE picks a posting scenario (the word in the title):
//   NOID        accepted, success page WITHOUT a job id or link                   -> NEEDS_CHECK (never "Published")
//   GHOST       accepted with an id, but the listing page says "not found"        -> NEEDS_CHECK
//   REJECT      the form comes back with a field error                            -> FAILED, not retried
//   SLOWPOST    the post answers after 30 s                                        -> NEEDS_HUMAN (after Submit)
//   (anything else is a normal post: id like NK-1001)
//
// Page changes (for the tests of selector self-healing):  POST /__control/mode?portal=naukri&mode=drift|break|off
//   drift   the job-title box is renamed (name="job_title_v2"); its label and id stay      -> a fallback selector still finds it (selector drift)
//   break   the job-title box is gone and the page is full of made-up personal text        -> SELECTOR_MISSING + a page snapshot without that text
// Control (for the tests):  GET /__control/state   POST /__control/reset   POST /__control/expire-sessions
// ---------------------------------------------------------------------------
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const D = require('../../src/jobPublish/defaultMappings');

const VALID_USER = 'recruiter@mock.test';
const VALID_PASS = 'MockPass#1';
const OTP_CODE = '246810';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const mapped = (portal, field) => D.rows().filter((r) => r.portal === portal && r.field === field).map((r) => r.portalValue);
const uniq = (a) => [...new Set(a)];
const cityLabels = uniq(D.rows().filter((r) => r.portal === 'shine' && r.field === 'location').map((r) => r.portalValue));
const nums = (n) => Array.from({ length: n + 1 }, (_, i) => String(i));

const SITES = {
  naukri: { prefix: 'NK', name: 'Naukri (mock)' },
  foundit: { prefix: 'FD', name: 'Foundit (mock)' },
  shine: { prefix: 'SH', name: 'Shine (mock)' },
};

function start({ port = 0, host = '127.0.0.1' } = {}) {
  const state = {
    sessions: new Set(), modes: {}, otpTries: 0, jobs: new Map(), counter: { naukri: 1000, foundit: 2000, shine: 3000 }, requests: [], posts: 0, logins: 0,
  };
  const page = (title, body, extraHead = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>${extraHead}</head><body>${body}</body></html>`;
  const send = (res, code, html, headers = {}) => { res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', ...headers }); res.end(html); };
  const redirect = (res, to, headers = {}) => { res.writeHead(302, { location: to, ...headers }); res.end(); };
  const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });
  const form = (b) => Object.fromEntries(new URLSearchParams(b));
  const sessionOf = (req) => { const m = /mock_session=([a-f0-9]+)/.exec(req.headers.cookie || ''); return m && state.sessions.has(m[1]) ? m[1] : null; };

  // ---------------------------------------------------------------- pages
  const loginPage = (p, err) => {
    const id = { naukri: ['usernameField', 'passwordField', 'email'], foundit: ['u', 'p', 'username'], shine: ['id_email', 'id_password', 'email'] }[p];
    const errCls = { naukri: 'error-message', foundit: 'error', shine: 'errorlist' }[p];
    return page(`${SITES[p].name} login`, `<h1>${esc(SITES[p].name)} recruiter login</h1>${err ? `<div class="${errCls}">${esc(err)}</div>` : ''}
<form method="post" action="/${p}/login"><input id="${id[0]}" name="${id[2]}" type="text" placeholder="Email"><input id="${id[1]}" name="password" type="password"><button type="submit">Login</button></form>`);
  };
  const dashboard = (p) => page(`${SITES[p].name} dashboard`, `<h1>Dashboard</h1><a href="/${p}/post-job">Post a Job</a> <a href="/${p}/my-jobs">My Jobs</a> <a href="/${p}/logout">Logout</a>`);
  const challenge = (p, kind) => {
    const body = {
      captcha: '<h1>Security check</h1><div class="g-recaptcha">CAPTCHA</div><p>Please complete the CAPTCHA to prove you are not a robot.</p>',
      otp: `<h1>Verify it is you</h1><p>Enter the one-time password (OTP) sent to your phone.</p><form method="post" action="/${p}/otp"><input name="otp" type="text" autocomplete="one-time-code"><button type="submit">Verify</button></form>`,
      twofactor: '<h1>2-step verification</h1><p>Open your authenticator app and enter the code.</p>',
      unusual: '<h1>Unusual activity detected</h1><p>We noticed unusual activity on your account.</p>',
    }[kind];
    return page(`${SITES[p].name} check`, body);
  };

  const opt = (list) => list.map((v) => `<option>${esc(v)}</option>`).join('');
  const val = (v) => esc(v || '');
  // the job form: a different layout per portal
  function postForm(p, action, job = null, err = '') {
    const j = job || {};
    const errBox = err ? `<div class="field-error">${esc(err)}</div>` : '';
    const sugg = `<ul id="sugg" style="display:none"></ul><script>
var CITIES=${JSON.stringify(cityLabels)};
function wireLoc(el){var u=document.getElementById('sugg');el.addEventListener('input',function(){var q=el.value.toLowerCase();u.innerHTML='';if(!q){u.style.display='none';return;}
CITIES.filter(function(c){return c.toLowerCase().indexOf(q.slice(0,4))>=0;}).forEach(function(c){var li=document.createElement('li');li.setAttribute('role','option');li.textContent=c;li.onclick=function(){el.value=c;u.style.display='none';};u.appendChild(li);});u.style.display='block';});}
function wireTags(el,hid){el.addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();var v=el.value.trim();if(v){hid.value=(hid.value?hid.value+',':'')+v;var s=document.createElement('span');s.className='chip';s.textContent=v+' ';document.getElementById('chips').appendChild(s);el.value='';}}});}
</script>`;
    if (p === 'naukri') {
      return page('Post a job', `<h1>Post a job</h1>${errBox}<form method="post" action="${action}">
${state.modes.naukri === 'break' ? '<h1>Hello Jane Doe</h1><p>Contact jane.doe@example.com or 9876543210012 about SECRETVALUE</p><textarea>SECRETVALUE typed text</textarea>' : `<label for="jt">Job title</label><input id="jt" name="${state.modes.naukri === 'drift' ? 'job_title_v2' : 'jobTitle'}" value="${val(j.title)}">`}
<div id="keySkills"><div id="chips"></div><input placeholder="Key skills" id="ks"><input type="hidden" name="skills" id="skills"></div>
<input name="minExp"><input name="maxExp">
<input name="location" id="loc" autocomplete="off">${sugg}
<select name="employmentType"><option value="">--</option>${opt(mapped('naukri', 'employmentType'))}</select>
<input name="minSalary"><input name="maxSalary"><input name="vacancies">
<select name="industry"><option value="">--</option>${opt(mapped('naukri', 'industry'))}</select>
<select name="functionalArea"><option value="">--</option>${opt(mapped('naukri', 'functionalArea'))}</select>
<input name="education"><textarea name="jobDescription">${val(j.description)}</textarea><input name="contactEmail">
<button type="button" id="pv" onclick="document.getElementById('pvbox').style.display='block'">Preview</button><div id="pvbox" style="display:none">Preview ok</div>
<button type="submit">Post Job</button></form><script>wireLoc(document.getElementById('loc'));wireTags(document.getElementById('ks'),document.getElementById('skills'));</script>`);
    }
    if (p === 'foundit') {
      return page('Post a job', `<h1>Post a job</h1>${errBox}<form method="post" action="${action}">
<input name="title" value="${val(j.title)}">
<div><div id="chips"></div><input placeholder="Add skills" id="ks"><input type="hidden" name="skills" id="skills"></div>
<select name="minExperience"><option value="">--</option>${opt(nums(40))}</select><select name="maxExperience"><option value="">--</option>${opt(nums(40))}</select>
<input name="location" id="loc" autocomplete="off">${sugg}
<div id="emp">${mapped('foundit', 'employmentType').filter((v, i, a) => a.indexOf(v) === i).map((v) => `<label><input type="radio" name="employmentType" value="${esc(v)}">${esc(v)}</label>`).join('')}</div>
<input name="salary"><input name="openings">
<select name="industry"><option value="">--</option>${opt(mapped('foundit', 'industry'))}</select>
<select name="category"><option value="">--</option>${opt(mapped('foundit', 'functionalArea'))}</select>
<textarea name="description">${val(j.description)}</textarea><input name="contactEmail">
<button type="submit">Publish</button></form><script>wireLoc(document.getElementById('loc'));wireTags(document.getElementById('ks'),document.getElementById('skills'));</script>`);
    }
    // shine: two steps
    return page('Post a job', `<h1>Post a job</h1>${errBox}<form method="post" action="${action}">
<div id="s1"><input name="job_title" id="id_job_title" value="${val(j.title)}">
<select name="location"><option value="">--</option>${opt(cityLabels)}</select>
<select name="min_exp"><option value="">--</option>${opt(nums(40))}</select><select name="max_exp"><option value="">--</option>${opt(nums(40))}</select>
<select name="min_sal"><option value="">--</option>${opt(nums(100))}</select><select name="max_sal"><option value="">--</option>${opt(nums(100))}</select>
<select name="job_type"><option value="">--</option>${opt(mapped('shine', 'employmentType'))}</select>
<select name="industry"><option value="">--</option>${opt(mapped('shine', 'industry'))}</select>
<select name="functional_area"><option value="">--</option>${opt(mapped('shine', 'functionalArea'))}</select>
<input name="vacancies"><textarea name="job_description">${val(j.description)}</textarea>
<button type="button" onclick="document.getElementById('s1').style.display='none';document.getElementById('s2').style.display='block'">Next</button></div>
<div id="s2" style="display:none"><div id="chips"></div><input placeholder="Add skills" id="ks"><input type="hidden" name="skills" id="skills"><input name="education">
<button type="submit">Post Job</button></div></form>${sugg}<script>wireTags(document.getElementById('ks'),document.getElementById('skills'));</script>`);
  }

  const postedPage = (p, id, withId = true) => page('Job posted', `<h1>Job posted successfully</h1>${withId ? `<p>Job ID: ${esc(id)}</p><span data-job-id="${esc(id)}"></span><a href="/${p}/job/${esc(id)}">View job</a>` : '<p>Thank you. We will email you.</p>'}`);
  const myJobs = (p) => {
    const rows = [...state.jobs.values()].filter((j) => j.portal === p).map((j) => `<tr data-job-id="${esc(j.id)}"><td>${esc(j.id)}</td><td>${esc(j.title)}</td><td>${esc(j.status)}</td><td><button class="close" onclick="this.nextElementSibling.style.display='inline';this.style.display='none'">Close job</button><button class="confirm" style="display:none" onclick="doClose('${esc(j.id)}')">Confirm</button></td></tr>`).join('');
    const script = `<script>function doClose(id){fetch('/${p}/job/'+id+'/close',{method:'POST'}).then(function(){document.body.insertAdjacentHTML('beforeend','<p>Job closed successfully</p>');});}</script>`;
    return page('My jobs', `<h1>My jobs</h1><table>${rows}</table>${script}`);
  };

  // ---------------------------------------------------------------- the server
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    state.requests.push({ at: Date.now(), method: req.method, path: u.pathname, host: req.headers.host });
    try {
      if (u.pathname === '/__control/state') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ jobs: [...state.jobs.values()], requests: state.requests, posts: state.posts, logins: state.logins, sessions: state.sessions.size })); }
      if (u.pathname === '/__control/mode') { const pp = u.searchParams.get('portal'); const mm = u.searchParams.get('mode'); if (mm === 'off') delete state.modes[pp]; else state.modes[pp] = mm; res.writeHead(200); return res.end('ok'); }
      if (u.pathname === '/__control/reset') { state.sessions.clear(); state.modes = {}; state.otpTries = 0; state.jobs.clear(); state.requests.length = 0; state.posts = 0; state.logins = 0; res.writeHead(200); return res.end('ok'); }
      if (u.pathname === '/__control/expire-sessions') { state.sessions.clear(); res.writeHead(200); return res.end('ok'); }
      const m = /^\/(naukri|foundit|shine)\/(.*)$/.exec(u.pathname);
      if (!m) return send(res, 404, page('Not found', '<h1>Not found</h1>'));
      const p = m[1]; const rest = m[2];
      const authed = !!sessionOf(req);
      const needLogin = () => redirect(res, `/${p}/login`);

      if (rest === 'login' && req.method === 'GET') return send(res, 200, loginPage(p));
      if (rest === 'login' && req.method === 'POST') {
        const f = form(await readBody(req));
        const user = String(f.email || f.username || '').trim();
        state.logins += 1;
        if (user === 'captcha-user') return send(res, 200, challenge(p, 'captcha'));
        if (user === 'otp-user') return send(res, 200, challenge(p, 'otp'));
        if (user === 'twofactor-user') return send(res, 200, challenge(p, 'twofactor'));
        if (user === 'unusual-user') return send(res, 200, challenge(p, 'unusual'));
        if (user === 'blocked-user') return send(res, 429, page('Too many requests', '<h1>Too many requests</h1>'));
        if (user === 'slow-user') { await sleep(8000); return send(res, 200, loginPage(p)); }
        if (user === VALID_USER && f.password === VALID_PASS) {
          const tok = crypto.randomBytes(8).toString('hex');
          state.sessions.add(tok);
          return redirect(res, `/${p}/dashboard`, { 'set-cookie': `mock_session=${tok}; Path=/; HttpOnly; Max-Age=3600` });
        }
        return send(res, 200, loginPage(p, 'Invalid username or password'));
      }
      if (rest === 'otp' && req.method === 'POST') {
        const f = form(await readBody(req));
        state.otpTries += 1;
        if (String(f.otp || '').trim() === OTP_CODE) {
          const tok = crypto.randomBytes(8).toString('hex');
          state.sessions.add(tok);
          return redirect(res, `/${p}/dashboard`, { 'set-cookie': `mock_session=${tok}; Path=/; HttpOnly; Max-Age=3600` });
        }
        return send(res, 200, challenge(p, 'otp').replace('</h1>', '</h1><div class="error">Invalid OTP</div>'));
      }
      if (rest === 'logout') { return redirect(res, `/${p}/login`, { 'set-cookie': 'mock_session=; Path=/; Max-Age=0' }); }
      if (!authed) return needLogin();
      if (rest === 'dashboard') return send(res, 200, dashboard(p));
      if (rest === 'post-job' && req.method === 'GET') return send(res, 200, postForm(p, `/${p}/post-job`));
      if (rest === 'post-job' && req.method === 'POST') {
        const f = form(await readBody(req));
        const title = f.jobTitle || f.title || f.job_title || f.job_title_v2 || '';
        const desc = f.jobDescription || f.description || f.job_description || '';
        state.posts += 1;
        if (/REJECT/.test(title)) return send(res, 200, postForm(p, `/${p}/post-job`, { title, description: desc }, 'Salary is required for this job'));
        if (/SLOWPOST/.test(title)) await sleep(30000);
        state.counter[p] += 1;
        const id = `${SITES[p].prefix}-${state.counter[p]}`;
        state.jobs.set(id, {
          id, portal: p, title, description: desc, status: 'live', fields: f, ghost: /GHOST/.test(title),
        });
        if (/NOID/.test(title)) return redirect(res, `/${p}/posted`);
        return redirect(res, `/${p}/posted?jid=${id}`);
      }
      if (rest === 'posted') return send(res, 200, postedPage(p, u.searchParams.get('jid'), !!u.searchParams.get('jid')));
      let mm;
      if ((mm = /^edit\/([\w-]+)$/.exec(rest))) {
        const j = state.jobs.get(mm[1]);
        if (!j) return send(res, 404, page('Not found', '<h1>Job not found</h1>'));
        if (req.method === 'POST') {
          const f = form(await readBody(req));
          j.title = f.jobTitle || f.title || f.job_title || j.title;
          j.description = f.jobDescription || f.description || f.job_description || j.description;
          j.edits = (j.edits || 0) + 1;
          return redirect(res, `/${p}/posted?jid=${j.id}`);
        }
        return send(res, 200, postForm(p, `/${p}/edit/${j.id}`, j));
      }
      if ((mm = /^job\/([\w-]+)$/.exec(rest))) {
        const j = state.jobs.get(mm[1]);
        if (!j || j.ghost || j.status !== 'live') return send(res, 404, page('Not found', '<h1>Job not found</h1><p>This job is no longer available.</p>'));
        return send(res, 200, page(j.title, `<h1>${esc(j.title)}</h1><p>Job ID ${esc(j.id)}</p><p>${esc(j.description)}</p>`));
      }
      if ((mm = /^job\/([\w-]+)\/close$/.exec(rest)) && req.method === 'POST') { const j = state.jobs.get(mm[1]); if (j) j.status = 'closed'; res.writeHead(200); return res.end('ok'); }
      if (rest === 'my-jobs') return send(res, 200, myJobs(p));
      return send(res, 404, page('Not found', '<h1>Not found</h1>'));
    } catch (err) {
      res.writeHead(500); return res.end(String(err && err.message));
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const origin = `http://${host}:${server.address().port}`;
      resolve({
        origin, state, server, port: server.address().port,
        close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }),
      });
    });
  });
}

module.exports = { start, VALID_USER, VALID_PASS, OTP_CODE };

if (require.main === module) {
  const port = Number((process.argv.find((a) => a.startsWith('--port=')) || '').split('=')[1]) || 0;
  start({ port }).then((m) => { console.log(`mock portal listening on ${m.origin}`); }); // eslint-disable-line no-console
}
