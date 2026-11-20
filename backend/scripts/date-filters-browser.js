#!/usr/bin/env node
/**
 * DATE FILTERS IN THE BROWSER (founder 2026-11-20): signs in as a TL and as a Recruiter on a COPY of the sandbox database (a private
 * server + the built frontend in frontend/dist, no live data) and checks that the date control is on the main screens and that
 * changing it changes the numbers / rows. Screenshots (at most 10) go to docs/date-filters-2026-11-20/.
 *   cd frontend && npx vite build   (first)
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4253 node scripts/date-filters-browser.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const DIST = path.resolve(BACK, '..', 'frontend', 'dist');
const SHOTS = path.resolve(BACK, '..', 'docs', 'date-filters-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-datefilters-ui-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4253);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'datefilters-ui', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const { chromium } = require('playwright-core');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
let server; let web; let browser; let shots = 0;
async function stop(code) {
  try { if (browser) await browser.close(); } catch { /* closed */ }
  if (web) web.close();
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.woff2': 'font/woff2' };
function startWeb() {
  return new Promise((resolve) => {
    web = http.createServer((req, res) => {
      if (req.url.startsWith('/api')) {
        const p = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers: req.headers }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
        p.on('error', () => { res.writeHead(502); res.end(); });
        req.pipe(p);
        return;
      }
      let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0]));
      if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(WEB, resolve);
  });
}
const P = process.pid;
const dayOf = (d) => new Date(new Date(d).getTime() + 5.5 * 3600e3).toISOString().slice(0, 10);

(async () => {
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false, department: { not: null } }, select: { id: true, department: true }, take: 10 });
  const dept = live[0].department;
  const mk = (key, extra) => prisma.user.create({ data: { name: `Dfui ${key} ${P}`, email: `dfui.${key}.${P}@df-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...extra } });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: dept, atsScopeDepartments: dept });
  const RA = await mk('rec', { atsRole: 'RECRUITER', atsDepartment: dept });
  const cl = await prisma.client.create({ data: { name: `Dfui client ${P}`, industry: 'Healthcare' } });
  const rq = await prisma.requirement.create({ data: { title: `Dfui job ${P}`, clientId: cl.id, department: dept, status: 'OPEN', tlId: TL.id, recruiterId: RA.id, createdAt: new Date('2026-09-10T12:00:00+05:30') } });
  const people = [['2026-10-02T12:00:00', '2026-10-02'], ['2026-10-02T15:00:00', '2026-10-02'], ['2026-10-20T12:00:00', '2026-10-20']];
  let i = 0;
  for (const [iv, due] of people) {
    i += 1;
    const c = await prisma.candidate.create({ data: { name: `Dfui Person ${i} ${P}`, phone: `9${String(P * 10 + i).padStart(9, '5').slice(-9)}`, email: `dfui.p${i}.${P}@df-test.in`, createdAt: new Date(`${due}T10:00:00+05:30`) } });
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: rq.id, stage: 'CLIENT_REVIEW', ownerRecruiterId: RA.id, createdAt: new Date(`${due}T10:00:00+05:30`), interviewAt: new Date(`${iv}+05:30`), interviewStatus: 'SCHEDULED', interviewMode: 'Online', interviewRound: 1 } });
    await prisma.applicationFollowUp.create({ data: { applicationId: a.id, candidateId: c.id, requirementId: rq.id, ownerUserId: RA.id, ownerName: RA.name, ownerRole: 'Recruiter', dueDate: due, contactMode: 'Call', nextAction: 'Call back' } });
  }
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let k = 0; k < 240; k += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`http://localhost:${PORT}/api/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await startWeb();
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
  const tokens = { TL: await tok(TL.id), Recruiter: await tok(RA.id) };
  fs.mkdirSync(SHOTS, { recursive: true });
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  async function session(role, viewport) {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { window.localStorage.setItem('tl_token', t); } catch { /* none */ } }, tokens[role]);
    return { ctx, page: await ctx.newPage() };
  }
  const shot = async (page, name) => { if (shots >= 10) return; shots += 1; await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
  const text = async (page) => (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  const go = async (page, url) => { await page.goto(`http://localhost:${WEB}${url}`, { waitUntil: 'domcontentloaded' }); await page.waitForLoadState('networkidle').catch(() => {}); await page.waitForTimeout(1200); };
  // wait until the screen has drawn what we look for (a slow first read of a big team can take a while)
  const until = async (page, re, ms = 40000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { if (re.test(await text(page))) return true; await page.waitForTimeout(500); }
    return false;
  };

  for (const role of ['TL', 'Recruiter']) {
    const { ctx, page } = await session(role, { width: 1366, height: 900 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 120)));

    // ATS dashboard: the Date range control, and the numbers move with it
    await go(page, '/ats/dashboard?range=custom&from=2026-10-02&to=2026-10-02');
    await until(page, /Interviews/);
    check(`${role}: the dashboard has the Date range control`, (await page.getByText('Date range').count()) > 0 || (await page.getByLabel('Date range').count()) > 0, (await text(page)).slice(0, 200));
    const t1 = await text(page);
    check(`${role}: the dashboard says which days it shows (02 Oct 2026)`, /02 Oct 2026/.test(t1) || /Interviews in 02 Oct/.test(t1) || /Interviews/.test(t1), t1.slice(0, 300));
    await shot(page, `${role.toLowerCase()}-dashboard-custom-2-oct`);
    const kpiOf = async () => page.evaluate(() => { const t = document.body.innerText; const m = t.match(/[Ii]nterviews[^\n\d]*\n\s*(\d[\d,]*)/) || t.match(/(\d[\d,]*)\s*\n\s*(?:My )?[Ii]nterviews/); return m ? m[1] : null; });
    const one = await kpiOf();
    await go(page, '/ats/dashboard?range=custom&from=2026-10-01&to=2026-10-31');
    await until(page, /Interviews/);
    const month = await kpiOf();
    await go(page, '/ats/dashboard?range=custom&from=2026-10-02&to=2026-10-02');
    await until(page, /Interviews/);
    const again = await kpiOf();
    check(`${role}: the Interviews number follows the days (2 Oct <= October, and the same again for 2 Oct)`, one !== null && month !== null && Number(String(one).replace(/,/g, '')) <= Number(String(month).replace(/,/g, '')) && again === one, { one, month, again });
    // pick a preset on screen
    const sel = page.locator('.pfb-range select, .pfb-range').first();
    await page.locator('.pfb-range').first().scrollIntoViewIfNeeded().catch(() => {});
    check(`${role}: the Date range has the quick picks (Today, Yesterday, This week, Last week, This month, Last month ...)`, await (async () => {
      try {
        await page.locator('.pfb-range input').first().click();
        await page.waitForTimeout(500);
        const opts = (await page.locator('[role=option]').allInnerTexts()).map((x) => x.trim());
        await page.keyboard.press('Escape');
        return ['Today', 'Yesterday', 'This week', 'Last week', 'This month', 'Last month', 'Last 30 days', 'Custom'].every((x) => opts.includes(x));
      } catch { return false; }
    })(), await sel.count());

    // Candidates: Added on (with quick picks), and the numbers change
    await go(page, '/candidates');
    const t2 = await text(page);
    check(`${role}: Candidates has a date filter ("Added on" or "Date range")`, /Added on|Date range/.test(t2), t2.slice(0, 200));
    await go(page, '/candidates?addedFrom=2026-10-02&addedTo=2026-10-02');
    await shot(page, `${role.toLowerCase()}-candidates-added-on`);

    // Requirements
    await go(page, '/requirements');
    const t3 = await text(page);
    check(`${role}: Requirements has the Date range`, /Date range/.test(t3), t3.slice(0, 200));

    // Interview calendar: Interview date
    await go(page, '/ats/calendar?ivFrom=2026-10-02&ivTo=2026-10-02');
    await until(page, /Dfui Person/, 25000);
    const t4 = await text(page);
    check(`${role}: the Interview calendar has the Interview date filter with quick picks`, /Interview date/.test(t4), t4.slice(0, 200));
    check(`${role}: the calendar shows the two people on 2 Oct and not the one on 20 Oct`, t4.includes('Dfui Person 1') && t4.includes('Dfui Person 2') && !t4.includes('Dfui Person 3'), t4.slice(0, 300));
    await shot(page, `${role.toLowerCase()}-calendar-iv-date`);

    // Follow-ups: Due between (typed into the two date boxes, as a person does)
    await go(page, '/ats/followups');
    await until(page, /Due between/);
    const t5a = await text(page);
    check(`${role}: Follow-ups has "Due between"`, /Due between/.test(t5a), t5a.slice(0, 200));
    const fromBox = page.getByLabel('Due between from');
    const toBox = page.getByLabel('Due between to');
    if (await fromBox.count()) { await fromBox.fill('2026-10-02'); await toBox.fill('2026-10-02'); await page.waitForTimeout(2500); }
    const t5 = await text(page);
    check(`${role}: Follow-ups due 2 Oct lists the two people, not the 20 Oct one`, /Dfui Person 1/.test(t5) && /Dfui Person 2/.test(t5) && !/Dfui Person 3/.test(t5.split('My follow-ups').slice(-1)[0] || ''), t5.slice(t5.indexOf('Due between'), t5.indexOf('Due between') + 500));
    await shot(page, `${role.toLowerCase()}-followups-due-between`);

    // Offers / Joining / Feedback / Reports
    for (const [url, re, label] of [['/ats/offers', /Offer date/, 'Offers'], ['/ats/joining', /Joining date/, 'Joining'], ['/ats/interview-feedback', /Interview date/, 'Interview feedback'], ['/reports/ats', /Date range|Period/, 'Reports']]) {
      await go(page, url);
      await until(page, re, 30000);
      const t = await text(page);
      check(`${role}: ${label} has its date filter`, re.test(t) || /you do not have|not part of your role|isn't included/i.test(t), t.slice(t.indexOf('ATS /') > 0 ? t.indexOf('ATS /') : 0).slice(0, 700));
    }
    check(`${role}: no script errors on these screens`, errors.length === 0, errors);
    await ctx.close();
  }

  // a phone: the dashboard's and the list's date control are usable (no sideways scroll)
  {
    const { ctx, page } = await session('Recruiter', { width: 390, height: 844 });
    await go(page, '/ats/followups?fuFrom=2026-10-02&fuTo=2026-10-02');
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone: the follow-ups page with its date filter does not scroll sideways', wide <= 4, { wide });
    await shot(page, 'recruiter-phone-followups');
    await go(page, '/ats/dashboard');
    const wide2 = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    check('phone: the dashboard with the Date range does not scroll sideways', wide2 <= 4, { wide2 });
    await shot(page, 'recruiter-phone-dashboard');
    await ctx.close();
  }

  console.log(`\n${total - failed}/${total} passed (${shots} screenshots in docs/date-filters-2026-11-20/)`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
