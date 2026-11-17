#!/usr/bin/env node
/**
 * SPECIALIZATION AND EXPERIENCE FILTERS WITH COUNTS (founder 2026-11-17): "specialization meedha click cheyyagane radiology 7, cardiology 8 ..., experience kuda
 * filter undali; aa specialization click chesthe aa clients names dropdown lo raavali". The candidates list gets a Specialization option list counted per person
 * (master name, else the profile's own words) and Experience bands; picking a specialization narrows the Client options.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4065.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/spec-experience-filters-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-spec-filter-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = 4065;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'spec-filter-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let auth = {};
const get = async (url) => { const r = await fetch(API + url, { headers: auth }); let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j }; };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  // a few people with the same specialization written differently, and known experience
  const apps = await prisma.application.findMany({ where: { stage: { notIn: ['REJECTED', 'JOINED', 'HIRED'] } }, select: { candidateId: true }, take: 400 });
  const ids = [...new Set(apps.map((a) => a.candidateId))].slice(0, 6);
  const words = ['radiology', 'Radiology ', 'RADIOLOGY', 'Cardiology', 'cardiology', 'CSE'];
  const years = [0.5, 2, 4, 7, 12, null];
  for (let i = 0; i < ids.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.candidate.update({ where: { id: ids[i] }, data: { specialization: words[i], specialisationId: null, experienceYears: years[i], profileStatus: 'Active' } });
  }
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };

  const f = await get('/ats-io/facets/candidates?view=pipeline&sub=all');
  const spec = (f.body && f.body.facets && f.body.facets.spec) || [];
  const rad = spec.find((o) => o.value === 'Radiology');
  const card = spec.find((o) => o.value === 'Cardiology');
  check('the Specialization options come with counts', f.status === 200 && spec.length > 0 && spec.every((o) => typeof o.count === 'number'), f.body && Object.keys(f.body.facets || {}));
  check('"radiology", "Radiology " and "RADIOLOGY" count together as Radiology (3 people)', rad && rad.count >= 3, rad);
  check('Cardiology counts its 2 people; short capitals stay (CSE)', card && card.count >= 2 && spec.some((o) => o.value === 'CSE'), spec.slice(0, 8));
  const exp = (f.body.facets.expBand || []).map((o) => o.value);
  check('Experience comes in bands with counts (0-1, 1-3, 3-5, 5-10, 10+)', ['0-1', '1-3', '3-5', '5-10', '10+'].every((b) => exp.includes(b)), exp);
  check('the bands are labelled in years', (f.body.facets.expBand || []).some((o) => o.label === '5-10 years'));

  const list = await get('/candidates?paged=1&view=pipeline&sub=all&spec=Radiology&pageSize=100');
  const rows = (list.body && list.body.rows) || [];
  const people = await prisma.candidate.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.candidateId || r.id))] } }, select: { id: true, specialization: true, specialisationId: true } });
  check('picking Radiology lists only people whose specialization is Radiology (ours among them)', list.status === 200 && people.length >= 3 && people.every((c) => /^radiology$/i.test(String(c.specialization || '').trim()) || !!c.specialisationId) && ids.slice(0, 3).every((id) => people.some((c) => c.id === id)), people.map((c) => c.specialization).slice(0, 8));
  const f2 = await get('/ats-io/facets/candidates?view=pipeline&sub=all&spec=Radiology');
  const clientsAll = (f.body.facets.clientId || []).length;
  const clientsRad = (f2.body.facets.clientId || []).length;
  check('picking Radiology narrows the Client options to the clients those people are with', clientsRad > 0 && clientsRad < clientsAll, [clientsAll, clientsRad]);
  const e = await get('/candidates?paged=1&view=pipeline&sub=all&expBand=5-10&pageSize=200');
  check('an Experience band lists only people inside it', (e.body.rows || []).length >= 1 && (e.body.rows || []).every((r) => r.experienceYears >= 5 && r.experienceYears < 10), (e.body.rows || []).map((r) => r.experienceYears).slice(0, 10));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
