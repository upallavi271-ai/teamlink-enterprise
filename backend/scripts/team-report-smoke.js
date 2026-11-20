#!/usr/bin/env node
/**
 * BROWSER SMOKE of the dashboard's 'Report of your team' (founder 2026-11-20): a TL and the Super Admin have the same 'Overall report' button (TL: their team; Admin: team leads first),
 * a recruiter has none. View opens a person's report: the candidates they added and every follow-up with its text. A private sandbox server (copy of the sandbox database) + the Vite dev server in front of it + Edge.
 * IMPORT (founder 2026-11-20 "give import & export options"): the Import button opens the import window, a small sheet previews and is imported,
 * the row shows in the recruiter's report, and Undo removes it.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4301 node scripts/team-report-smoke.js     (screenshots: docs/team-report-2026-11-20/)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const FRONT = path.resolve(BACK, '..', 'frontend');
const SHOTS = path.resolve(BACK, '..', 'docs', 'team-report-2026-11-20');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-trs-smoke-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4301);
const WEB = PORT + 1;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'trs-smoke', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
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
  const mk = (tag, data, emp) => prisma.user.create({ data: { name: `Tz ${tag} ${RUN}`, email: `tz.${tag}.${RUN}@tz-test.in`, username: `tz.${tag}.${RUN}@tz-test.in`, passwordHash: 'x', status: 'Active', hrmsRole: 'NONE', ...data } })
    .then(async (u) => { if (emp) await prisma.employee.create({ data: { employeeCode: `TZ-${tag}-${RUN}`, name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: 'IT', email: u.email, ...emp } }); return u; });
  const sa = await mk('admin', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN', atsAccess: true });
  const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'IT', atsScopeDepartments: 'IT', atsScopeTeams: `Tz Team ${RUN}` }, { designation: 'TL', department: 'IT', team: `Tz Team ${RUN}` });
  const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsScopeDepartments: 'IT' }, { tl: tl.name, department: 'IT', team: `Tz Team ${RUN}` });
  const client = await prisma.client.create({ data: { name: `Tzorbit Systems ${RUN}`, ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const req = await prisma.requirement.create({ data: { title: `Tzcloud Engineer ${RUN}`, clientId: client.id, department: 'IT', status: 'RECRUITER_ASSIGNED', tlId: tl.id, tl: tl.name, recruiterId: rec.id, reqCode: `TZ-${RUN}`.toUpperCase().slice(0, 14), openings: 1 } });
  const cand = await prisma.candidate.create({ data: { name: `Tzperson Quillfeather ${RUN}`, phone: `8${String(Date.now()).slice(-9)}`, email: `tz.${RUN}@tz-test.in`, skills: 'Kubernetes' } });
  const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: req.id, ownerRecruiterId: rec.id, stage: 'NEW' } });
  const WROTE = `Called, will confirm the interview slot tomorrow ${RUN}`;
  await prisma.applicationFollowUp.create({ data: { applicationId: app.id, candidateId: cand.id, requirementId: req.id, ownerUserId: rec.id, ownerName: rec.name, ownerRole: 'Recruiter', purpose: 'Interview confirmation', notes: WROTE, nextAction: WROTE, contactMode: 'Call', lastContactedAt: new Date(), createdByName: rec.name, createdById: rec.id } });

  const be = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(be);
  if (!(await waitFor(`http://localhost:${PORT}/api/health`))) { console.log('FAIL  the sandbox server did not answer (set TEST_PORT)'); await stop(1); return; }
  const web = spawn(process.execPath, [path.join(FRONT, 'node_modules', 'vite', 'bin', 'vite.js'), 'preview', '--port', String(WEB), '--strictPort', '--host', 'localhost'], { cwd: FRONT, env: { ...process.env, API_PROXY: `http://localhost:${PORT}` }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  procs.push(web);
  if (!(await waitFor(`http://localhost:${WEB}/`))) { console.log('FAIL  the web server did not answer'); await stop(1); return; }

  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  const open = async (user, urlPath) => {
    const token = jwt.sign({ ...tokenPayload(await resolveIdentity(user.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tl_token', t); } catch (e) { /* none */ } }, token);
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${WEB}${urlPath}`, { waitUntil: 'commit', timeout: 120000 });
    await page.locator('[data-testid="dash-search-bar"] input').waitFor({ state: 'visible', timeout: 60000 }).catch(() => null);
    return { ctx, page };
  };
  try {
    // TL: the same "Overall report" button as the Super Admin; it opens THEIR team (recruiter rows + View + team overall)
    {
      const { ctx, page } = await open(tl, '/ats/dashboard');
      const btn = page.locator('button', { hasText: 'Overall report' });
      const up = await btn.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
      check('TL: the dashboard has the "Overall report" button (no always-open card)', up && (await page.locator('.trc').count()) === 0, await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => ''));
      if (up) {
        await btn.click();
        const team = page.locator('.trd-panel', { hasText: 'Report of your team' });
        const row = team.locator('tr', { hasText: rec.name });
        const rowUp = await row.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
        check('TL: the button opens their team: one row for their recruiter, with a View button', rowUp && (await row.locator('button', { hasText: 'View' }).isVisible()));
        check('TL: Today / Yesterday / This week / This month and two date boxes are there', (await team.locator('button', { hasText: /^(Today|Yesterday|This week|This month)$/ }).count()) === 4 && (await team.locator('input[type=date]').count()) === 2);
        check('TL: the team overall line is not shown for a team of one, but the recruiter\'s numbers are', rowUp);
        await page.screenshot({ path: path.join(SHOTS, 'tl-team-panel.png') });
        await row.locator('button', { hasText: 'View' }).click();
        const panel = page.locator('.trd-panel', { hasText: 'Candidates added' }).last();
        const pv = await panel.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
        check('TL: View opens that recruiter\'s report in a side panel', pv);
        if (pv) {
          await panel.locator('td', { hasText: `Tzperson Quillfeather ${RUN}` }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
          const t = await panel.innerText();
          check('TL: the panel lists the candidate they added', t.includes(`Tzperson Quillfeather ${RUN}`) && /Candidates added/.test(t), t.slice(0, 300));
          await panel.locator('td', { hasText: WROTE }).first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
          check('TL: ...and the follow-up with the text that was written', (await panel.innerText()).includes(WROTE));
          const squeezed = await panel.evaluate((el) => [...el.querySelectorAll('.trd-scroll')].filter((x) => x.scrollHeight > x.clientHeight + 2).length);
          check('TL: no table inside the recruiter panel is squeezed into its own little scroll box (the panel scrolls as one page)', squeezed === 0, squeezed);
          // the numbers are buttons that open their own list; the lists have filters (founder 2026-11-20)
          await panel.locator('button.trd-tile', { hasText: 'Follow-ups added' }).click();
          const addedOnly = await panel.locator('h4', { hasText: /^Follow-ups added \(1/ }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
          check('TL: clicking "Follow-ups added" opens that list (the follow-up with its text), and hides the candidates list', addedOnly && (await panel.innerText()).includes(WROTE) && (await panel.locator('h4', { hasText: 'Candidates added' }).count()) === 0, (await panel.innerText()).slice(0, 400));
          await panel.locator('button.trd-tile', { hasText: 'Follow-ups done' }).click();
          const doneEmpty = await panel.locator('h4', { hasText: /^Follow-ups done \(0/ }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
          check('TL: "Follow-ups done" opens its own list (none done yet)', doneEmpty);
          await panel.locator('button.trd-tile', { hasText: 'Candidates added' }).click();
          const candOnly = await panel.locator('h4', { hasText: /^Candidates added \(1/ }).waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
          check('TL: "Candidates added" opens only the candidates list', candOnly && (await panel.locator('h4', { hasText: 'Follow-ups' }).count()) === 0);
          await panel.locator('input[type=search]').fill('nobody-matches-this');
          check('TL: the search box filters the list', await panel.locator('td', { hasText: 'No candidate matches the filters.' }).isVisible().catch(() => false));
          await panel.locator('button', { hasText: 'Clear all' }).click();
          await panel.locator('button', { hasText: 'Show everything' }).click();
          check('TL: "Show everything" brings both lists back', (await panel.locator('h4', { hasText: 'Candidates added' }).count()) === 1 && (await panel.locator('h4', { hasText: 'Follow-ups and what was written' }).count()) === 1);
          check('TL: the panel has Status / Answer / Client / Requirement filters', (await panel.locator('.msel').count()) >= 2);
          await page.screenshot({ path: path.join(SHOTS, 'tl-view-panel.png') });
          await page.keyboard.press('Escape');
          check('TL: Escape closes the recruiter panel and the team stays', await page.locator('.trd-panel', { hasText: 'Candidates added' }).count() === 0 && await team.isVisible());

          // IMPORT: a sheet of one follow-up for the recruiter, today; preview -> Import -> it shows in the recruiter's report -> Undo removes it
          page.on('dialog', (d) => d.accept().catch(() => {}));
          const IMPORTED = `Imported from the old sheet: spoke about the notice period ${RUN}`;
          const istToday = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
          const sheet = path.join(os.tmpdir(), `zz-trs-import-${RUN}.xlsx`);
          const wb = XLSX.utils.book_new();
          XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
            ['Date', 'Recruiter', 'Candidate', 'Requirement', 'What happened', 'Call back on', 'Answer', 'Done'],
            [`${istToday.slice(8, 10)}-${istToday.slice(5, 7)}-${istToday.slice(0, 4)}`, rec.email, cand.phone, '', IMPORTED, '', 'Interested', 'Yes'],
          ]), 'Follow-ups');
          XLSX.writeFile(wb, sheet);
          await team.locator('button', { hasText: /^Import$/ }).click();
          const modal = page.locator('.fui-modal');
          const mUp = await modal.waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
          check('Import: the Import button beside the days opens the import window (template, choose file, recent imports)', mUp && (await modal.locator('button', { hasText: 'Download template' }).isVisible()) && (await modal.locator('h4', { hasText: 'Recent imports' }).isVisible()));
          if (mUp) {
            await modal.locator('input[type=file]').setInputFiles(sheet);
            const ready = await modal.locator('.fui-count.ready', { hasText: 'Ready 1' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
            check('Import: the small sheet previews as 1 Ready, with the recruiter and the candidate found', ready && (await modal.locator('td', { hasText: rec.name }).count()) >= 1 && (await modal.locator('td', { hasText: `Tzperson Quillfeather ${RUN}` }).count()) >= 1, (await modal.innerText().catch(() => '')).slice(0, 500));
            await page.screenshot({ path: path.join(SHOTS, 'import-preview.png') });
            await modal.locator('button', { hasText: 'Import 1 follow-up' }).click();
            const done = await modal.locator('.fui-result', { hasText: '1 follow-up imported' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
            check('Import: Apply imports it and offers "Undo this import"', done && (await modal.locator('button', { hasText: 'Undo this import' }).isVisible()));
            await page.screenshot({ path: path.join(SHOTS, 'import-done.png') });
            await modal.locator('.modal-foot button', { hasText: 'Close' }).click();
            await row.locator('button', { hasText: 'View' }).click();
            const p2 = page.locator('.trd-panel', { hasText: 'Candidates added' }).last();
            const seen = await p2.locator('td', { hasText: IMPORTED }).first().waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
            check('Import: the imported follow-up shows in the recruiter report, on today, with what happened', seen);
            await page.keyboard.press('Escape');
            await team.locator('button', { hasText: /^Import$/ }).click();
            const undoBtn = modal.locator('.fui-recent button', { hasText: /^Undo$/ }).first();
            await undoBtn.waitFor({ state: 'visible', timeout: 20000 }).catch(() => null);
            await undoBtn.click();
            const undone = await modal.locator('.fui-recent', { hasText: '1 imported follow-up removed' }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false);
            check('Import: Undo in the recent imports removes it', undone && (await prisma.applicationFollowUp.count({ where: { notes: IMPORTED } })) === 0);
            await modal.locator('.modal-foot button', { hasText: 'Close' }).click();
            await row.locator('button', { hasText: 'View' }).click();
            const p3 = page.locator('.trd-panel', { hasText: 'Candidates added' }).last();
            await p3.locator('td', { hasText: WROTE }).first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => null);
            check('Import: after Undo the recruiter report no longer has it', (await p3.innerText()).includes(WROTE) && !(await p3.innerText()).includes(IMPORTED));
            await page.keyboard.press('Escape');
          }
          try { fs.unlinkSync(sheet); } catch { /* none */ }
        }
      }
      await ctx.close();
    }
    // Recruiter: nothing at all
    {
      const { ctx, page } = await open(rec, '/ats/dashboard');
      await page.waitForTimeout(4000);
      check('Recruiter: no team report and no Overall report button', (await page.locator('.trc').count()) === 0 && (await page.locator('button', { hasText: 'Overall report' }).count()) === 0);
      await ctx.close();
    }
    // Super Admin: the button; first page = team leads; a team lead -> that team; a recruiter -> their report
    {
      const { ctx, page } = await open(sa, '/ats/dashboard');
      const btn = page.locator('button', { hasText: 'Overall report' });
      const there = await btn.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
      check('Admin: the dashboard has the Overall report button', there);
      if (there) {
        await page.waitForTimeout(3000);
        check('Admin: no "Carried over from yesterday" and no "My end-of-day report" on the dashboard', !(await page.evaluate(() => /Carried over from yesterday|My end-of-day report/.test(document.body.innerText))));
        await btn.click();
        const panel = page.locator('.trd-panel', { hasText: 'Overall report' });
        const tlRow = panel.locator('tr', { hasText: tl.name });
        const first = await tlRow.waitFor({ state: 'visible', timeout: 90000 }).then(() => true).catch(() => false);
        const txt0 = await panel.innerText().catch(() => '');
        check('Admin: the first page lists TEAM LEADS (a team lead row, with the number of recruiters), not every recruiter', first && /team lead/i.test(txt0) && !(await panel.locator('tr td b', { hasText: rec.name }).count()), txt0.slice(0, 300));
        await page.screenshot({ path: path.join(SHOTS, 'admin-overall-tls.png') });
        check('Admin: the team-lead list has the Import button', await panel.locator('button', { hasText: /^Import$/ }).isVisible().catch(() => false));
        if (first) {
          await tlRow.locator('button', { hasText: 'View' }).click();
          const team = page.locator('.trd-panel', { hasText: `${tl.name}'s team` });
          const recRow = team.locator('tr', { hasText: rec.name });
          const second = await recRow.waitFor({ state: 'visible', timeout: 60000 }).then(() => true).catch(() => false);
          check('Admin: a team lead opens that team: their recruiters, with a way back', second && (await team.locator('button', { hasText: 'All team leads' }).isVisible()), (await team.innerText().catch(() => '')).slice(0, 300));
          await page.screenshot({ path: path.join(SHOTS, 'admin-team.png') });
          check('Admin: a team panel has the Import button too', await team.locator('button', { hasText: /^Import$/ }).isVisible().catch(() => false));
          if (second) {
            await recRow.locator('button', { hasText: 'View' }).click();
            const v = await page.locator('.trd-panel', { hasText: 'Candidates added' }).last().waitFor({ state: 'visible', timeout: 20000 }).then(() => true).catch(() => false);
            check('Admin: a recruiter opens that recruiter\'s own report', v);
            await page.keyboard.press('Escape');
            await team.locator('button', { hasText: 'All team leads' }).click();
            check('Admin: "All team leads" goes back to the team lead list', await panel.locator('tr', { hasText: tl.name }).waitFor({ state: 'visible', timeout: 30000 }).then(() => true).catch(() => false));
          }
        }
      }
      await ctx.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log('FAIL  crashed:', e && e.message); await stop(1); });
