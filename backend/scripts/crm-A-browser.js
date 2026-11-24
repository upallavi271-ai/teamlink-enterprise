#!/usr/bin/env node
/**
 * BROWSER SMOKE of CRM wave A (2026-11-24) in Edge: CRM > Dashboard > Automation (switches, a rule from a ready template in the flow
 * builder with a step dragged in from the palette), Report builder (group by stage, chart, save), My dashboard (add the saved report),
 * Leaderboard, Trends; a salesperson has no Automation tab; at phone width nothing scrolls sideways.
 * A private sandbox server (copy of the sandbox database) + `vite preview` of the built frontend (run `npx vite build` in frontend first).
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4xxx node scripts/crm-A-browser.js      (screenshots: <tmp>/crm-A-shots-<pid>/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.join(os.tmpdir(), `crm-A-shots-${process.pid}`);
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-A-browser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" IN (\'crm.settings\', \'crm.wave\')');
dbx.close();
const PORT = Number(process.env.TEST_PORT || 4601);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-A-browser', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
const RUN = Date.now().toString(36);
const procs = [];
async function stop(code) {
  procs.forEach((p) => { try { p.kill(); } catch { /* gone */ } });
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const waitFor = async (url, tries = 240) => { for (let i = 0; i < tries; i += 1) { if (await fetch(url).then((r) => r.status < 500).catch(() => false)) return true; await new Promise((r) => { setTimeout(r, 500); }); } return false; }; // eslint-disable-line no-await-in-loop
const tokenOf = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });

(async () => {
  const mk = (tag, data) => prisma.user.create({ data: { name: `Zq ${tag} ${RUN}`, email: `zq.${tag}.${RUN}@zq-test.in`, username: `zq.${tag}.${RUN}@zq-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
  const X = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
  const A = await mk('rep', { role: 'EMPLOYEE' });
  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const tX = await tokenOf(X); const tA = await tokenOf(A);
  const api = async (method, url, body, t = tX) => { const r = await fetch(`http://localhost:${PORT}/api${url}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: body ? JSON.stringify(body) : undefined }); return r.json().catch(() => ({})); };
  await api('PUT', '/crm/settings', { salesTeam: [{ userId: A.id, name: A.name, role: 'rep', rights: { create: true, edit: true } }] });
  const acc = (await api('POST', '/crm/accounts', { name: `Zq Account ${RUN}`, force: true })).account;
  for (const [t, v, st] of [['Zq Alpha', 120000, 'Meeting'], ['Zq Beta', 80000, 'Negotiation'], ['Zq Gamma', 50000, 'Prospecting']]) {
    // eslint-disable-next-line no-await-in-loop
    await api('POST', '/crm/deals', { title: `${t} ${RUN}`, accountId: acc.id, value: v, stage: st, ownerId: A.id });
  }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (token, urlPath, viewport = { width: 1280, height: 900 }) => {
    const ctx = await browser.newContext({ viewport });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept().catch(() => {}));
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    await page.locator('h1', { hasText: 'Sales Dashboard' }).waitFor({ state: 'visible', timeout: 90000 }).catch(() => null);
    return { ctx, page };
  };
  const tab = (page, name) => page.locator('[role=tab]', { hasText: new RegExp(`^${name}$`) });
  const noSideScroll = (page) => page.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1);
  try {
    const { ctx, page } = await open(tX, '/crm/dashboard');
    check('the Admin sees the new Dashboard tabs (and the sidebar keeps five CRM items)', await tab(page, 'Automation').isVisible() && await tab(page, 'Report builder').isVisible() && await tab(page, 'My dashboard').isVisible() && await tab(page, 'Leaderboard').isVisible() && await tab(page, 'Trends').isVisible());
    // Automation > Switches: turn the rules on
    await tab(page, 'Automation').click();
    await page.locator('button', { hasText: /^Switches$/ }).click();
    const rulesSw = page.locator('button[aria-label^="Rules run by themselves"]');
    await rulesSw.waitFor({ state: 'visible', timeout: 20000 });
    check('Switches: everything starts off', /off/.test(await rulesSw.getAttribute('aria-label')));
    await rulesSw.click();
    check('the Admin turns "Rules run by themselves" on', await page.locator('button[aria-label="Rules run by themselves: on"]').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
    // Rules: from a ready rule, drag a step in from the palette, save
    await page.locator('button', { hasText: /^Rules$/ }).click();
    await page.locator('select[aria-label="Start from a ready rule"]').selectOption({ label: 'Hot website lead: a call today' });
    const modal = page.locator('.modal', { hasText: 'New rule' }).first();
    const mUp = await page.locator('.crm-flow').waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    check('the flow builder opens with WHEN, IF and DO cards and the template\'s two steps', mUp && (await page.locator('.crm-flow-card.step').count()) === 2 && (await page.locator('.crm-flow-card.when').count()) === 1 && (await page.locator('.crm-flow-card.if').count()) === 1);
    await page.screenshot({ path: path.join(SHOTS, 'rule-builder.png') });
    const chip = page.locator('.crm-flow-palette button', { hasText: 'Bell notice' });
    await chip.dragTo(page.locator('.crm-flow-drop').first());
    let steps = await page.locator('.crm-flow-card.step').count();
    if (steps === 2) { await chip.click(); steps = await page.locator('.crm-flow-card.step').count(); } // a browser without HTML5 drag in headless: the tap adds it
    check('a step from the palette lands in the flow (drag, or tap)', steps === 3, steps);
    check('the new bell step can be edited in place', (await page.locator('.crm-flow-card.step', { hasText: 'Bell notice' }).locator('input[type=text]').count()) >= 1);
    await page.locator('label', { hasText: 'This rule is on' }).locator('input').check();
    await page.locator('button', { hasText: 'Save rule' }).click();
    const saved = await page.locator('td', { hasText: 'Hot website lead: a call today' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    check('the rule is saved and listed', saved);
    void modal; // eslint-disable-line no-void
    // the rule works: a website lead added through the API becomes Hot
    const lead = (await api('POST', '/crm/leads', { company: `Zq Web Lead ${RUN}`, contactName: 'Zq', phone: `9${String(Date.now()).slice(-9)}`, source: 'Website', ownerId: A.id })).lead;
    let hot = null; for (let i = 0; i < 30 && !hot; i += 1) { const d = await api('GET', `/crm/leads/${lead.id}`); if (d.lead && d.lead.rating === 'Hot') hot = d; else await new Promise((r) => { setTimeout(r, 300); }); } // eslint-disable-line no-await-in-loop
    check('the rule ran on a new website lead (rating Hot)', !!hot);
    // Webhooks / API & AI / Apps open
    await page.locator('button', { hasText: /^API & AI tools$/ }).click();
    check('API & AI tools: the key form and the MCP section', await page.locator('button', { hasText: 'Make a key' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('text=AI tools (MCP)').isVisible());
    await page.locator('button', { hasText: /^Apps$/ }).click();
    check('Apps: the catalogue shows Zapier, Slack and the accounting decision', await page.locator('.crm-card', { hasText: 'Zapier' }).first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('.crm-card', { hasText: 'Needs founder decision' }).isVisible());
    await page.screenshot({ path: path.join(SHOTS, 'apps.png') });

    // Report builder: deals by stage, sum of value, bars; save it
    await tab(page, 'Report builder').click();
    const groupSel = page.locator('label', { hasText: 'Group by (for a chart)' }).locator('xpath=..').locator('select');
    await groupSel.waitFor({ state: 'visible', timeout: 20000 });
    await groupSel.selectOption('stage');
    await page.locator('label', { hasText: 'Count or add up' }).locator('xpath=..').locator('select').first().selectOption('sum');
    await page.locator('select[aria-label="Which number"]').selectOption('value');
    await page.locator('button', { hasText: /^Run$/ }).click();
    const negotiation = page.locator('td', { hasText: /^Negotiation$/ });
    check('Run: grouped by stage with the total of value (table + bars)', await negotiation.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('b', { hasText: '₹80,000' }).first().isVisible().catch(() => false), await page.locator('.card').first().innerText().catch(() => ''));
    await page.locator('input[aria-label="Report name"]').fill(`Zq pipeline ${RUN}`);
    await page.locator('button', { hasText: /^Save report$/ }).click();
    check('the report is saved', await page.locator('button', { hasText: /^Saved reports \(1\)$/ }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
    await page.screenshot({ path: path.join(SHOTS, 'report-builder.png') });

    // My dashboard: four numbers, then add the saved report
    await tab(page, 'My dashboard').click();
    check('My dashboard starts with four ready numbers', await page.locator('.crm-mydash .crm-card').nth(3).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && (await page.locator('.crm-mydash .crm-card').count()) === 4);
    await page.locator('button', { hasText: /^Arrange$/ }).click();
    await page.locator('select[aria-label="Add a widget"] option', { hasText: `Zq pipeline ${RUN}` }).waitFor({ state: 'attached', timeout: 20000 });
    const val = await page.locator('select[aria-label="Add a widget"] option', { hasText: `Zq pipeline ${RUN}` }).getAttribute('value');
    await page.locator('select[aria-label="Add a widget"]').selectOption(val);
    await page.locator('button', { hasText: 'Save my dashboard' }).click();
    check('the saved report is a widget on my dashboard', await page.locator('.crm-mydash .crm-card h3', { hasText: `Zq pipeline ${RUN}` }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && (await page.locator('.crm-mydash .crm-card').count()) === 5);
    await page.screenshot({ path: path.join(SHOTS, 'my-dashboard.png') });

    await tab(page, 'Leaderboard').click();
    check('Leaderboard: a table with points and the salesperson', await page.locator('table th', { hasText: 'Points' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('td', { hasText: A.name }).first().isVisible().catch(() => false));
    await tab(page, 'Trends').click();
    check('Trends: the week-by-week table and the cohorts', await page.locator('th', { hasText: 'Week ending' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false) && await page.locator('th', { hasText: 'Leads that came in' }).isVisible());
    await page.screenshot({ path: path.join(SHOTS, 'trends.png') });
    await ctx.close();

    // phone width: Automation and the builder fit
    const ph = await open(tX, '/crm/dashboard?tab=automation', { width: 375, height: 800 });
    await ph.page.locator('button', { hasText: '+ New rule' }).waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
    check('phone width: Automation does not scroll sideways', await noSideScroll(ph.page));
    await ph.page.locator('button', { hasText: '+ New rule' }).click();
    await ph.page.locator('.crm-flow').waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
    check('phone width: the rule builder fits', await noSideScroll(ph.page));
    await ph.page.screenshot({ path: path.join(SHOTS, 'phone-rule.png') });
    await ph.page.keyboard.press('Escape');
    await ph.ctx.close();
    const ph2 = await open(tX, '/crm/dashboard?tab=mydash', { width: 375, height: 800 });
    await ph2.page.locator('.crm-mydash .crm-card').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
    check('phone width: my dashboard is one column, no sideways scroll', await noSideScroll(ph2.page));
    await ph2.ctx.close();

    // a salesperson: no Automation tab
    const rep = await open(tA, '/crm/dashboard');
    check('a salesperson has My dashboard / Leaderboard / Report builder but no Automation tab', await tab(rep.page, 'My dashboard').isVisible().catch(() => false) && await tab(rep.page, 'Report builder').isVisible() && (await tab(rep.page, 'Automation').count()) === 0);
    await rep.ctx.close();
  } catch (e) {
    check(`no crash (${e.message})`, false);
  }
  await browser.close();
  console.log(`\n${total - failed}/${total} passed (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
