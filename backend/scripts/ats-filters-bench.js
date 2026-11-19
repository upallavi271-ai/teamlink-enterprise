#!/usr/bin/env node
/**
 * ATS FILTERS - speed at 100,000 candidates (founder 2026-11-18). SANDBOX ONLY: copies the sandbox database, adds N candidates (one application
 * each) straight into the COPY, starts a private server on it and times filtered candidate lists, their option counts and the Requirements list.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4169 BENCH_N=100000 node scripts/ats-filters-bench.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-fbench-${process.pid}.db`);
const N = Number(process.env.BENCH_N || 100000);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT || 4169);
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'fbench', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

const CITIES = ['Hyderabad, Telangana', 'Bengaluru', 'Chennai', 'Pune', 'Mumbai', 'Delhi', 'Kochi', 'Vizag', 'Warangal', 'Kolkata'];
const SPECS = ['Radiology', 'Cardiology', 'Nursing', 'CSE', 'Mechanical', 'Civil', 'Pharmacy', 'Anesthesia'];
const SKILLS = ['java', 'python', 'sql', 'react', 'node', 'excel', 'tally', 'icu', 'ot', 'cnc', 'autocad', 'sap'];
const NOTICE = ['Immediate', '15 Days', '30 Days', '45 Days', '60 Days', '90 Days', 'Serving notice'];
const MODES = ['Remote', 'Hybrid', 'Work From Office'];
const rnd = (n) => Math.floor(Math.random() * n);
const time = async (label, fn) => {
  const t = process.hrtime.bigint();
  const out = await fn();
  const ms = Number(process.hrtime.bigint() - t) / 1e6;
  console.log(`${String(Math.round(ms)).padStart(6)} ms  ${label}`);
  return { ms, out };
};

(async () => {
  const db = new DatabaseSync(COPY);
  const reqs = db.prepare("SELECT id FROM Requirement WHERE status != 'CLOSED' LIMIT 40").all().map((r) => r.id);
  const t0 = db.prepare('SELECT typeof(createdAt) AS t FROM Candidate LIMIT 1').get();
  const asMs = !t0 || t0.t === 'integer';
  const now = Date.now();
  const stamp = (ms) => (asMs ? ms : new Date(ms).toISOString());
  const insC = db.prepare('INSERT INTO Candidate (id, name, email, phone, source, skills, experienceYears, createdAt, location, preferredLocation, currentDesignation, currentSalary, expectedSalary, noticePeriod, preferredWorkMode, specialization, profileStatus) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insA = db.prepare('INSERT INTO Application (id, candidateId, requirementId, stage, createdAt, updatedAt) VALUES (?,?,?,?,?,?)');
  console.log(`seeding ${N} candidates ...`);
  db.exec('BEGIN');
  for (let i = 0; i < N; i += 1) {
    const cid = `fb${i}x`;
    const exp = rnd(20);
    insC.run(cid, `Bench Person ${i}`, `bench${i}@bench.test`, `8${String(100000000 + i).slice(-9)}`, 'Naukri', `${SKILLS[rnd(12)]}, ${SKILLS[rnd(12)]}`, exp, stamp(now - rnd(400) * 86400000),
      CITIES[rnd(10)], `${CITIES[rnd(10)]}, ${CITIES[rnd(10)]}`, ['Software Engineer', 'Sr. Staff Nurse', 'Radiologist', 'Accountant'][rnd(4)], `${2 + rnd(30)} LPA`, `${3 + rnd(35)} LPA`, NOTICE[rnd(7)], MODES[rnd(3)], SPECS[rnd(8)], 'Active');
    insA.run(`fa${i}x`, cid, reqs[rnd(reqs.length)], 'NEW', stamp(now - rnd(300) * 86400000), stamp(now - rnd(30) * 86400000));
  }
  db.exec('COMMIT');
  db.close();
  console.log('seeded');

  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...env, CANDIDATE_WARMUP: '0' }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 200; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  const token = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const get = async (url) => { const r = await fetch(API + url, { headers: { Authorization: `Bearer ${token}` } }); const j = await r.json().catch(() => null); return { status: r.status, body: j }; };
  const qs = (o) => Object.entries(o).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const base = { paged: '1', view: 'pipeline', sub: 'all', pageSize: '25' };
  const rows = [];
  const run = async (label, url, pick) => { const r = await time(label, () => get(url)); rows.push({ label, ms: Math.round(r.ms), n: pick ? pick(r.out.body) : null, status: r.out.status }); };

  console.log('--- candidates (pipeline), first call builds the 100,000-row working copy');
  await run('cold: unfiltered list', `/candidates?${qs(base)}`, (b) => b && b.total);
  await run('warm: unfiltered list', `/candidates?${qs(base)}`, (b) => b && b.total);
  const F = [
    ['location Hyderabad + CTC 6-12 + experience 3-8', { locCur: 'Hyderabad', ctcCurMin: '6', ctcCurMax: '12', expMin: '3', expMax: '8' }],
    ['notice bands + work mode + skills any', { noticeBand: 'imm,d15,d30', workMode: 'Remote', skillSet: 'java,python,sql' }],
    ['skills ALL + specialization + preferred location', { skillSet: 'java,sql', skillMode: 'all', spec: 'Cardiology', locPref: 'Pune,Chennai' }],
    ['added-date range + completeness + resume', { addedFrom: '2026-06-01', addedTo: '2026-11-18', scoreMin: '40', resume: 'no' }],
  ];
  for (const [label, p] of F) {
    // eslint-disable-next-line no-await-in-loop
    await run(`list: ${label}`, `/candidates?${qs({ ...base, ...p })}`, (b) => b && b.total);
  }
  await run('People list: location + CTC + experience', `/candidates?${qs({ ...base, view: 'master', locCur: 'Hyderabad', ctcCurMin: '6', ctcCurMax: '12', expMin: '3' })}`, (b) => b && b.total);
  console.log('--- option counts (all filters\' facets in one call)');
  await run('facets: no filter', `/ats-io/facets/candidates?${qs({ view: 'pipeline', sub: 'all' })}`, (b) => b && b.total);
  await run('facets: location + CTC + experience on', `/ats-io/facets/candidates?${qs({ view: 'pipeline', sub: 'all', locCur: 'Hyderabad', ctcCurMin: '6', ctcCurMax: '12', expMin: '3', expMax: '8' })}`, (b) => b && b.total);
  console.log('--- other lists');
  await run('requirements: days open + openings left + CTC', `/requirements?${qs({ page: '1', pageSize: '25', view: 'all', daysOpenMin: '10', openLeftMin: '1', ctcMin: '3' })}`, (b) => b && b.total);
  await run('clients: requirement count + has joinings', `/clients?${qs({ reqMin: '1', hasJoinings: 'yes' })}`, (b) => (Array.isArray(b) ? b.length : null));
  console.log('\nlabel | ms | rows | status');
  rows.forEach((r) => console.log(`${r.label} | ${r.ms} | ${r.n} | ${r.status}`));
  server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(0); }, 800);
})().catch((e) => { console.error(e); process.exit(1); });
