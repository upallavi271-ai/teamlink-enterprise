#!/usr/bin/env node
/**
 * HIRING TYPE FILTER (NISH, IT staffing - founder 2026-11-25: "vallaki contract based & full time ani vundali ... teamlink ni em disturb cheyyoddhu").
 * Three requirements of one client - Contract, Full Time, Contract to Hire - each with one candidate. Then ?jobType= on the Requirements list,
 * Candidates & Pipeline, the ATS dashboard and ATS Reports keeps only that type, and with no ?jobType every list answers as before (all three).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> TEST_PORT=4231 node scripts/ats-hiring-type-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-hiring-type-${process.pid}.db`);
const UPLOADS = path.join(os.tmpdir(), `zz-hiring-type-uploads-${process.pid}`);
fs.mkdirSync(UPLOADS, { recursive: true });
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4231);
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'hiring-type-test', UPLOAD_DIR: UPLOADS, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
};
delete env.ATS_PROFILE; // the filter answers whenever it is sent; the switch only decides whether a screen offers it
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '2h' });
const call = async (url, token) => {
  const r = await fetch(API + url, { headers: { 'X-Forwarded-For': `10.68.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, Authorization: `Bearer ${token}` } });
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: j, text };
};
const RUN = Date.now().toString(36);
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}

(async () => {
  const sa = await prisma.user.create({
    data: {
      name: `Ht sa ${RUN}`, email: `ht.sa.${RUN}@ht-test.in`, username: `ht.sa.${RUN}@ht-test.in`, passwordHash: 'x', status: 'Active', role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN',
      hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3),
    },
  });
  const client = await prisma.client.create({ data: { name: `Htype Orbit ${RUN}`, industry: 'Information Technology', ownerDepartment: 'IT', agreementStatus: 'ACTIVE' } });
  const TYPES = { C: 'Contract', F: 'Full Time', H: 'Contract to Hire' };
  const R = {};
  const P = {};
  for (const [k, t] of Object.entries(TYPES)) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    R[k] = await prisma.requirement.create({ data: { title: `Htype ${t} Java ${RUN}`, clientId: client.id, department: 'IT', openings: 1, status: 'RECRUITER_ASSIGNED', skills: 'Java', reqCode: `HT${k}${RUN}`.toUpperCase(), employmentType: t } });
    // eslint-disable-next-line no-await-in-loop
    P[k] = await prisma.candidate.create({ data: { name: `Htperson ${k} ${RUN}`, phone: `8${String(Date.now()).slice(-6)}${String(Object.keys(R).length).padStart(3, '0')}`.slice(0, 10), email: `htp.${k}.${RUN}@ht-test.in`, skills: 'Java', location: 'Hyderabad', source: 'Naukri' } });
    // eslint-disable-next-line no-await-in-loop
    await prisma.application.create({ data: { candidateId: P[k].id, requirementId: R[k].id, stage: 'SHARED_WITH_CLIENT' } });
  }

  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('FAIL  the sandbox server did not answer /api/health (set TEST_PORT)'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const T = await tokenOf(sa.id);
  const has = (text, k) => text.includes(`Htype ${TYPES[k]} Java ${RUN}`);
  const hasP = (text, k) => text.includes(`Htperson ${k} ${RUN}`);
  const only = (text, want, f = has) => Object.keys(TYPES).every((k) => f(text, k) === want.includes(k));

  // 1. Requirements list
  const base = `/requirements?clientId=${client.id}&page=1&pageSize=100&view=all`; // the Requirements screen's paged list
  const all = await call(base, T);
  check('Requirements, no hiring type: all three jobs (as before)', all.status === 200 && only(all.text, ['C', 'F', 'H']), [all.status, all.text.slice(0, 200)]);
  const rc = await call(`${base}&jobType=Contract`, T);
  check('Requirements, Hiring type = Contract: only the contract job', rc.status === 200 && only(rc.text, ['C']), rc.body && rc.body.rows && rc.body.rows.map((r) => r.title));
  const rfh = await call(`${base}&jobType=${encodeURIComponent('Full Time,Contract to Hire')}`, T);
  check('Requirements, Full Time + Contract to Hire: those two jobs', rfh.status === 200 && only(rfh.text, ['F', 'H']), rfh.body && rfh.body.rows && rfh.body.rows.map((r) => r.title));
  check('Requirements: each row carries its hiring type', rc.body && rc.body.rows && rc.body.rows.every((r) => r.employmentType === 'Contract'));

  // 2. Candidates & Pipeline (both views)
  const cbase = `/candidates?paged=1&pageSize=100&clientId=${client.id}&search=${encodeURIComponent(`Htperson`)}`;
  for (const view of ['pipeline', 'master']) { // eslint-disable-line no-restricted-syntax
    // eslint-disable-next-line no-await-in-loop
    const ca = await call(`${cbase}&view=${view}`, T);
    // eslint-disable-next-line no-await-in-loop
    const cc = await call(`${cbase}&view=${view}&jobType=Contract`, T);
    check(`Candidates (${view}), no hiring type: all three people`, ca.status === 200 && only(ca.text, ['C', 'F', 'H'], hasP), [ca.status, ca.text.slice(0, 200)]);
    check(`Candidates (${view}), Contract: only the contract job's person`, cc.status === 200 && only(cc.text, ['C'], hasP), [cc.status, cc.text.slice(0, 200)]);
  }

  // 3. ATS dashboard (the list behind a number) - the open requirements of this client
  const dAll = await call(`/dashboard/ats/home?clientId=${client.id}`, T);
  const dC = await call(`/dashboard/ats/home?clientId=${client.id}&jobType=Contract`, T);
  check('Dashboard answers with and without the hiring type', dAll.status === 200 && dC.status === 200, [dAll.status, dC.status, dC.text.slice(0, 200)]);
  const dChanged = dAll.text !== dC.text;
  check('Dashboard, Contract: the board is narrowed (not the same answer as all types)', dChanged);

  // 4. ATS Reports - the Requirements report of this client
  const pAll = await call(`/ats-reports/requirements?clientId=${client.id}`, T);
  const pC = await call(`/ats-reports/requirements?clientId=${client.id}&jobType=Contract`, T);
  check('Reports, no hiring type: all three jobs', pAll.status === 200 && only(pAll.text, ['C', 'F', 'H']), [pAll.status, pAll.text.slice(0, 300)]);
  check('Reports, Contract: only the contract job', pC.status === 200 && only(pC.text, ['C']), [pC.status, pC.text.slice(0, 300)]);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error('CRASH', e.stack); await stop(1); });
