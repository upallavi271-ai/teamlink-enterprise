#!/usr/bin/env node
/**
 * BROWSER SMOKE of the credentials vault (founder 2026-11-21): the Super Admin opens Administration > Company Setup > Credentials vault,
 * imports a 3-row sheet, sees the passwords masked, reveals one after typing their own password again, and sees the line in
 * "Who opened what". A private sandbox server (copy of the sandbox database) + vite preview of the built frontend + Edge (playwright-core).
 * Build the frontend first (npx vite build). Every value is fake.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4520 node scripts/vault-browser.js      (screenshots: <tmp>/zz-vault-shots-<pid>/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.join(os.tmpdir(), `zz-vault-shots-${process.pid}`);
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-vault-browser-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4520);
const WEB = PORT + 1;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'vault-browser', INTEGRATION_SECRET_KEY: 'fake-vault-browser-key-not-real',
  DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
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

(async () => {
  const LOGIN_PW = `Vz-Browser-Login-${RUN}`;
  const sa = await prisma.user.create({ data: { name: `Vb Admin ${RUN}`, email: `vb.admin.${RUN}@vb-test.in`, username: `vb.admin.${RUN}@vb-test.in`, passwordHash: await bcrypt.hash(LOGIN_PW, 8), status: 'Active', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'NONE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const emp = await prisma.employee.create({ data: { employeeCode: `VB-E-${RUN}`.toUpperCase(), name: `Vb Person ${RUN}`, designation: 'Employee', employmentStatus: 'Active', department: 'IT' } });
  const ROWS = [
    ['Naukri', `vb.naukri.${RUN}@example.test`, `Fake-Naukri-${RUN}-1`],
    ['Hostinger', `vb.host.${RUN}@example.test`, `Fake-Host-${RUN}-2`],
    ['Gmail', `vb.gmail.${RUN}@example.test`, `Fake-Gmail-${RUN}-3`],
  ];
  const sheetPath = path.join(os.tmpdir(), `zz-vault-import-${RUN}.xlsx`);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['Platform', 'Label', 'Login URL', 'Username / Email', 'Password', 'Employee (name / code / email)', 'Department', 'Notes', 'Renewal date', 'Extra secret'],
    ...ROWS.map(([p, u, pw]) => [p, `${p} team ${RUN}`, 'https://www.example.com/login', u, pw, emp.employeeCode, '', '', '', '']),
  ]), 'Logins');
  XLSX.writeFile(wb, sheetPath);

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  try {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(sa.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}/admin/credentials`, { waitUntil: 'commit', timeout: 120000 });
    const title = page.locator('h2', { hasText: 'Credentials vault' });
    const opened = await title.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
    check('Super Admin: Administration > Company Setup > Credentials vault opens', opened, await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
    check('it is a tab of the Company Setup strip (beside Company, Master lists ...)', await page.locator('[aria-label="Company Setup"] a', { hasText: 'Credentials vault' }).isVisible().catch(() => false));
    // import a 3-row sheet
    await page.locator('button[role=tab]', { hasText: 'Import from Excel' }).click();
    await page.locator('[data-testid=cv-import-file]').setInputFiles(sheetPath);
    const ready = await page.locator('button.cv-count.ready', { hasText: 'Ready 3' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    check('the sheet previews as Ready 3, with the employee found', ready && (await page.locator('[data-testid=cv-prev-row]', { hasText: emp.name }).count()) === 3, (await page.locator('.cv-import').innerText().catch(() => '')).slice(0, 500));
    const prevText = await page.locator('.cv-import').innerText().catch(() => '');
    check('the preview shows the passwords masked (no password text on the page)', prevText.includes('••••••••') && !ROWS.some(([, , pw]) => prevText.includes(pw)));
    await page.screenshot({ path: path.join(SHOTS, 'import-preview.png') });
    await page.locator('button', { hasText: 'Import 3 logins' }).click();
    const done = await page.locator('.cv-result', { hasText: '3 logins imported' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
    check('Import: 3 logins imported, with "Undo this import"', done && (await page.locator('.cv-result button', { hasText: 'Undo this import' }).isVisible()));
    // the list, masked
    await page.locator('button[role=tab]', { hasText: 'All logins' }).click();
    await page.locator('[data-testid=cv-row]', { hasText: ROWS[0][1] }).waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
    const listText = await page.locator('.cv-list').innerText().catch(() => '');
    check('All logins lists the 3 imported logins with masked passwords and no password text', ROWS.every(([, u]) => listText.includes(u)) && listText.includes('••••••••') && !ROWS.some(([, , pw]) => listText.includes(pw)), listText.slice(0, 400));
    await page.screenshot({ path: path.join(SHOTS, 'list-masked.png') });
    // THE FILTER ROW LINES UP (founder 2026-11-23: "align this properly"): with a department picked and its list open, every box of the
    // row has the same height and top, and nothing runs past the card
    const measure = () => page.evaluate(() => {
      const bar = document.querySelector('.cv-toolbar'); const card = bar && bar.closest('.cv-list');
      const kids = bar ? [...bar.children].filter((el) => el.offsetParent) : [];
      const box = (el) => { const t = el.matches('.cv-filter') ? el.querySelector('.mpk-chips') : (el.matches('label') ? (el.querySelector('select') || el) : el); const r = t.getBoundingClientRect(); return { cls: el.className, top: Math.round(r.top), h: Math.round(r.height), right: Math.round(r.right) }; };
      return { boxes: kids.map(box), cardRight: card ? Math.round(card.getBoundingClientRect().right) : 0 };
    });
    await page.locator('.cv-filter').nth(1).locator('.mpk-chips').click().catch(() => {});
    await page.locator('.cv-filter .mpk-opt').first().click().catch(() => {});
    const m = await measure();
    const fields = m.boxes.filter((b) => /cv-search|cv-filter|cv-sort|cv-check/.test(b.cls));
    const tops = new Set(fields.map((b) => b.top)); const hs = new Set(fields.map((b) => b.h));
    check('filter row: every box the same height and in one straight line (a department picked, its list open)', hs.size === 1 && tops.size <= 2, m);
    check('filter row: nothing runs past the right edge of the card', m.boxes.every((b) => b.right <= m.cardRight + 1), m);
    // the open list sits right under its own box and is exactly as wide as it
    const pl = await page.evaluate(() => { const f = [...document.querySelectorAll('.cv-filter')].find((x) => x.querySelector('.mpk-panel')); if (!f) return null; const b = f.querySelector('.mpk-chips').getBoundingClientRect(); const p = f.querySelector('.mpk-panel').getBoundingClientRect(); return { boxL: Math.round(b.left), boxW: Math.round(b.width), boxB: Math.round(b.bottom), pL: Math.round(p.left), pW: Math.round(p.width), pT: Math.round(p.top) }; });
    check('dropdown: the list opens right under its box, same left edge and same width', !!pl && Math.abs(pl.pL - pl.boxL) <= 1 && Math.abs(pl.pW - pl.boxW) <= 1 && pl.pT >= pl.boxB && pl.pT - pl.boxB <= 6, pl);
    await page.screenshot({ path: path.join(SHOTS, 'filters-open.png') });
    await page.keyboard.press('Escape').catch(() => {});
    await page.mouse.click(5, 5).catch(() => {});
    // reveal one after re-auth
    const row = page.locator('[data-testid=cv-row]', { hasText: ROWS[1][1] });
    await row.locator('button[aria-label="Show password"]').click();
    const ask = page.locator('[data-testid=cv-reauth-input]');
    const asked = await ask.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    check('Show asks for the Super Admin\'s own TeamLink password first', asked && (await ask.getAttribute('type')) === 'password' && (await ask.getAttribute('autocomplete')) === 'off');
    await ask.fill('this-is-wrong');
    await page.locator('.modal button[type=submit]', { hasText: 'Confirm' }).click();
    check('a wrong password says so and how many tries are left', await page.locator('.modal [role=alert]', { hasText: 'tries left' }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false));
    await ask.fill(LOGIN_PW);
    await page.locator('.modal button[type=submit]', { hasText: 'Confirm' }).click();
    const plain = row.locator('[data-testid=cv-plain]');
    const shown = await plain.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
    check('after the right password the one password shows (with a countdown), the others stay masked', shown && (await plain.innerText()) === ROWS[1][2] && /hides in \d+s/.test(await row.innerText()) && !(await page.locator('.cv-list').innerText()).includes(ROWS[0][2]));
    await page.screenshot({ path: path.join(SHOTS, 'revealed.png') });
    await row.locator('button[aria-label="Hide password"]').click();
    check('Hide masks it again', (await row.locator('[data-testid=cv-plain]').count()) === 0);
    // who opened what
    await page.locator('button[role=tab]', { hasText: 'Who opened what' }).click();
    const line = page.locator('[data-testid=cv-log-row]', { hasText: 'password shown' }).filter({ hasText: sa.name }).filter({ hasText: 'Hostinger' });
    check('"Who opened what" has the line: the Super Admin, password shown, the Hostinger login', await line.first().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false), (await page.locator('[data-testid=cv-log]').innerText().catch(() => '')).slice(0, 400));
    check('...and the wrong password and the import are there too', (await page.locator('[data-testid=cv-log-row]', { hasText: 'wrong password' }).count()) >= 1 && (await page.locator('[data-testid=cv-log-row]', { hasText: 'logins imported' }).count()) >= 1);
    await page.screenshot({ path: path.join(SHOTS, 'who-opened-what.png') });
    // Add a login: the Platform list shows the platform NAMES (founder 2026-11-21: it showed empty rows)
    await page.locator('button[role=tab]', { hasText: 'All logins' }).click();
    const addBtn = page.locator('button', { hasText: /Add login/ }).first();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      const m = page.locator('.modal', { hasText: 'Add a login' });
      await m.locator('#cv-platform').first().click().catch(() => null);
      await m.locator('.mpk-opt').first().waitFor({ state: 'visible', timeout: 10000 }).catch(() => null);
      const naukri = m.locator('.mpk-opt', { hasText: 'Naukri' }).first();
      const box = await naukri.boundingBox().catch(() => null);
      const cb = await naukri.locator('input[type=checkbox]').boundingBox().catch(() => null);
      check('Add a login: the Platform list shows the names (Naukri visible, the tick box small)', !!box && (await naukri.isVisible()) && !!cb && cb.width < 40, [box, cb]);
      await page.screenshot({ path: path.join(SHOTS, 'add-platform-list.png') });
      await page.keyboard.press('Escape').catch(() => null);
      await m.locator('button', { hasText: /^Cancel$/ }).first().click().catch(() => null);
    } else check('the Add a login button is there', false);
    // phone width: no sideways scroll of the page
    await page.setViewportSize({ width: 375, height: 800 });
    await page.locator('button[role=tab]', { hasText: 'All logins' }).click();
    await page.waitForTimeout(800);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check('at phone width the page does not scroll sideways', wide <= 2, wide);
    await page.screenshot({ path: path.join(SHOTS, 'phone.png') });
    await ctx.close();
  } finally {
    await browser.close().catch(() => {});
    try { fs.unlinkSync(sheetPath); } catch { /* none */ }
  }
  console.log(`\n${total - failed}/${total} passed (screenshots: ${SHOTS})`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
