#!/usr/bin/env node
/**
 * MY DASHBOARD LAYOUT (founder audit 2026-11-17: drag-and-drop dashboard widgets) + the Admin AI fairness API.
 *   Layout: save / read / reset per login, isolation between logins, bad input refused, the Super Admin's
 *   "Dashboard of" reads another login's layout but cannot change it, /ats/home carries cardLayout.
 *   AI fairness: GET / POST /api/candidate-resumes/fairness-test (Admin only, result kept).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4086.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-dashboard-layout-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-layout-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4086;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'layout-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 500)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const mk = (tag) => prisma.user.create({
    data: {
      name: `Lay ${tag} ${P}`, email: `lay.${tag}.${P}@lay-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'IT', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3),
    },
  });
  const A = await mk('a'); const B = await mk('b');
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tS = await tok(adminRow.id); const tA = await tok(A.id); const tB = await tok(B.id);
  const L = '/dashboard/ats/home/layout';

  // ---- layout: empty to begin with
  let g = await call('GET', L, null, tA);
  check('a new login has no saved layout (the usual order)', g.status === 200 && g.body.layout === null, g);

  // ---- save + read back
  const mine = { order: ['row2', 'kpis', 'quick', 'attention', 'requirements', 'fold:tls'], hidden: ['money', 'fold:cleanup'] };
  const put = await call('PUT', L, mine, tA);
  check('saving a layout works', put.status === 200 && put.body.ok && same(put.body.layout.order, mine.order) && same(put.body.layout.hidden, mine.hidden), put);
  g = await call('GET', L, null, tA);
  check('reading it back gives the same order and hidden cards', g.status === 200 && same(g.body.layout.order, mine.order) && same(g.body.layout.hidden, mine.hidden) && !!g.body.layout.updatedAt, g.body);
  const home = await call('GET', '/dashboard/ats/home?range=month', null, tA);
  check('the dashboard itself carries the saved layout (cardLayout)', home.status === 200 && home.body.cardLayout && same(home.body.cardLayout.hidden, mine.hidden), { status: home.status, cl: home.body && home.body.cardLayout, err: home.body && home.body.error });
  const again = await call('PUT', L, { order: ['kpis', 'row2'], hidden: [] }, tA);
  g = await call('GET', L, null, tA);
  check('saving again replaces it (one row per login, not a second one)', again.status === 200 && same(g.body.layout.order, ['kpis', 'row2']) && g.body.layout.hidden.length === 0, g.body);
  const rows = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "DashboardLayout" WHERE "userId" = ?', A.id);
  check('...stored once in DashboardLayout', Number(rows[0].n) === 1, rows);
  const dup = await call('PUT', L, { order: ['kpis', 'kpis', 'row2'], hidden: ['money', 'money'] }, tA);
  check('repeated card names are kept once', dup.status === 200 && same(dup.body.layout.order, ['kpis', 'row2']) && same(dup.body.layout.hidden, ['money']), dup.body);

  // ---- per-login isolation
  g = await call('GET', L, null, tB);
  check('another login does not see it (still the usual order)', g.status === 200 && g.body.layout === null, g.body);
  await call('PUT', L, { order: ['below', 'kpis'], hidden: ['quick'] }, tB);
  const gA = await call('GET', L, null, tA); const gB = await call('GET', L, null, tB);
  check('each login keeps its own layout', same(gA.body.layout.order, ['kpis', 'row2']) && same(gB.body.layout.order, ['below', 'kpis']) && same(gB.body.layout.hidden, ['quick']), { a: gA.body, b: gB.body });

  // ---- bad input
  check('order that is not a list is refused', (await call('PUT', L, { order: 'kpis' }, tA)).status === 400);
  check('a card name with odd characters is refused', (await call('PUT', L, { order: ['<script>'] }, tA)).status === 400);
  check('too many cards is refused', (await call('PUT', L, { order: Array.from({ length: 200 }, (_, i) => `c${i}`) }, tA)).status === 400);
  g = await call('GET', L, null, tA);
  check('...and the saved layout is unchanged after a refusal', same(g.body.layout.order, ['kpis', 'row2']), g.body);
  check('no login, no layout', (await fetch(API + L).then((r) => r.status)) === 401);

  // ---- Super Admin "Dashboard of": reads that login's layout, cannot change it
  g = await call('GET', `${L}?asUser=${A.id}`, null, tS);
  check('Dashboard of: the Super Admin sees that login\'s layout', g.status === 200 && same(g.body.layout.order, ['kpis', 'row2']), g);
  const sp = await call('PUT', `${L}?asUser=${A.id}`, { order: ['row4'], hidden: [] }, tS);
  const sd = await call('DELETE', `${L}?asUser=${A.id}`, null, tS);
  g = await call('GET', L, null, tA);
  check('...but cannot change or reset it', sp.status === 403 && sd.status === 403 && same(g.body.layout.order, ['kpis', 'row2']), { sp: sp.status, sd: sd.status, g: g.body });
  check('a recruiter cannot read another login\'s layout with ?asUser', (await call('GET', `${L}?asUser=${B.id}`, null, tA)).status === 403);

  // ---- reset
  const del = await call('DELETE', L, null, tA);
  g = await call('GET', L, null, tA);
  check('Reset layout: back to the usual order', del.status === 200 && g.body.layout === null, { del: del.body, g: g.body });
  const gB2 = await call('GET', L, null, tB);
  check('...the other login\'s layout is untouched', same(gB2.body.layout.order, ['below', 'kpis']), gB2.body);

  // ---- AI fairness API (Admin only)
  const F = '/candidate-resumes/fairness-test';
  check('AI fairness: a recruiter cannot see it', (await call('GET', F, null, tA)).status === 403);
  check('AI fairness: a recruiter cannot run it', (await call('POST', F, null, tA)).status === 403);
  let f = await call('GET', F, null, tS);
  check('AI fairness: the Admin can read the last run (none yet on this copy, or an earlier one)', f.status === 200 && 'last' in f.body, f);
  f = await call('POST', F, null, tS);
  const last = f.body && f.body.last;
  check('AI fairness: the Admin runs it, every attribute passes', f.status === 200 && last && last.pass === true && last.attributes.length >= 10 && last.attributes.every((a) => a.pass), last && { pass: last.pass, bad: (last.attributes || []).filter((a) => !a.pass) });
  check('AI fairness: the four-fifths check passes and every group has the same rate', !!(last && last.fourFifths && last.fourFifths.pass && last.fourFifths.identical && last.fourFifths.minRatio >= 0.8), last && last.fourFifths);
  f = await call('GET', F, null, tS);
  check('AI fairness: the run is kept (date, result, who ran it)', f.status === 200 && f.body.last && f.body.last.pass === true && !!f.body.last.ranAt && !!f.body.last.ranByName, f.body.last && { ranAt: f.body.last.ranAt, by: f.body.last.ranByName });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
