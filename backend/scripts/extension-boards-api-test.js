// EXTENSION 2.0 API (routes/mktPublic.js /api/public/mkt/ext): Naukri / Shine / foundit profiles, the requirement list, "Add to a requirement".
// On a COPY of a database, with its own server.
//   TEST_SOURCE_DB=<a .db file> node scripts/extension-boards-api-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SRC = process.env.TEST_SOURCE_DB;
if (!SRC || !fs.existsSync(SRC)) { console.log('Set TEST_SOURCE_DB to a .db file to copy.'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `ext-boards-test-${Date.now()}.db`);
fs.copyFileSync(SRC, COPY);
const DB_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.DATABASE_URL = DB_URL;
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
process.env.DATABASE_URL = DB_URL;
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'ext-boards-test-only-secret';
const PORT = 4000 + Math.floor(Math.random() * 900) + 50;
const API = `http://localhost:${PORT}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

(async () => {
  const { PrismaClient } = require(path.join(__dirname, '..', 'node_modules/@prisma/client'));
  const p = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, DATABASE_URL: DB_URL, PORT: String(PORT), NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i += 1) { try { up = (await fetch(`${API}/health`)).ok; } catch { /* not yet */ } if (!up) await sleep(1000); }
    if (!up) throw new Error(`server did not start\n${log.slice(-600)}`);
    const jwt = require('jsonwebtoken');
    const sa = await p.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active' } });
    await p.user.update({ where: { id: sa.id }, data: { passwordChangedAt: new Date() } });
    const tok = jwt.sign({ id: sa.id }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const mk = await fetch(`${API}/ats/mkt/extension-key`, { method: 'POST', headers: { Authorization: `Bearer ${tok}` } }).then((r) => r.json());
    check('a Super Admin gets an extension key', /^tlx_/.test(mk.key || ''), mk);
    const ext = async (method, url, body) => { const r = await fetch(`${API}/public/mkt/ext${url}`, { method, headers: { 'X-TeamLink-Key': mk.key, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { s: r.status, j: await r.json().catch(() => ({})) }; };

    const reqs = await ext('GET', '/requirements');
    check('the requirement list comes back with labels', reqs.s === 200 && Array.isArray(reqs.j.rows) && reqs.j.rows.length > 0 && reqs.j.rows[0].label, reqs);
    // an open requirement of an active client that takes people (no refusal)
    const A = require(path.join(__dirname, '..', 'src', 'routes', 'applications.js'));
    let req = null;
    for (const r of reqs.j.rows.slice(0, 40)) {
      const full = await p.requirement.findUnique({ where: { id: r.id } });
      if (full && !(await A.jobRefusalFor(full).catch(() => ({ x: 1 })))) { req = full; break; }
    }
    if (!req) throw new Error('no requirement on the copy takes new applications');

    const stamp = Date.now();
    const url = `https://resdex.naukri.com/v3/preview?uniqId=zz${stamp}&sid=1`;
    const email = `zz.ext.${stamp}@example.com`;
    const first = await ext('GET', `/check?url=${encodeURIComponent(url)}`);
    check('a new Naukri profile is not known', first.s === 200 && first.j.known === false, first);
    const add = await ext('POST', '/profile', {
      site: 'naukri', profileUrl: url, name: 'Zz Extension Test', email, phone: '', headline: 'Java Developer', currentCompany: 'Acme', location: 'Hyderabad',
      experienceYears: 4.5, currentSalary: '8 Lacs', expectedSalary: '11 Lacs', noticePeriod: '15 Days', education: 'B.Tech', skills: ['Java', 'Spring'], requirementId: req.id,
    });
    check('added: 201 with the site', add.s === 201 && add.j.created && add.j.site === 'naukri', add);
    const c = add.j.candidate ? await p.candidate.findUnique({ where: { id: add.j.candidate.id } }) : null;
    check('the source says Naukri (browser extension)', c && c.source === 'Naukri' && c.firstSource === 'Naukri (browser extension)', c && [c.source, c.firstSource]);
    check('CTC, expected CTC, notice and education are kept', c && c.currentSalary === '8 Lacs' && c.expectedSalary === '11 Lacs' && c.noticePeriod === '15 Days' && c.education === 'B.Tech' && c.experienceYears === 4.5, c);
    const app = c ? await p.application.findFirst({ where: { candidateId: c.id, requirementId: req.id } }) : null;
    check('put on the chosen requirement', !!app && add.j.attached && add.j.attached.applicationId === app.id, add.j.attached);

    const again = await ext('GET', `/check?url=${encodeURIComponent(url.replace('sid=1', 'sid=7'))}`);
    check('the same profile with another session id is known', again.j.known === true && again.j.candidate && again.j.candidate.id === c.id, again.j);
    const byMail = await ext('GET', `/check?url=${encodeURIComponent(`https://recruiter.shine.com/candidate/profile/zz${stamp}`)}&email=${encodeURIComponent(email)}`);
    check('a Shine page with the same email is known (no duplicate)', byMail.j.known === true && byMail.j.candidate && byMail.j.candidate.id === c.id, byMail.j);
    const shine = await ext('POST', '/profile', { site: 'shine', profileUrl: `https://recruiter.shine.com/candidate/profile/zz${stamp}`, name: 'Zz Extension Test', email, requirementId: req.id });
    check('adding it from Shine finds the same candidate', shine.s === 200 && shine.j.existing && shine.j.candidate.id === c.id, shine.j);
    check('and says it is already on that requirement', shine.j.attached && /already on/i.test(shine.j.attached.error || ''), shine.j.attached);
    const count = await p.candidate.count({ where: { email } });
    check('still one candidate with that email', count === 1, count);
    const bad = await ext('POST', '/profile', { profileUrl: 'https://example.com/someone', name: 'Zz Nobody' });
    check('another site is refused', bad.s === 400, bad);
  } catch (e) {
    failed += 1; total += 1; console.log(`FAIL  crashed: ${e.stack || e.message}`);
  } finally {
    await p.$disconnect();
    server.kill(); await sleep(500);
    try { fs.unlinkSync(COPY); } catch { /* in use */ }
  }
  console.log(`\n${total - failed}/${total} passed`);
  process.exit(failed ? 1 : 0);
})();
