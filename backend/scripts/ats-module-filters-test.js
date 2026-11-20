#!/usr/bin/env node
/**
 * THE FOUR PERSON FILTERS IN EVERY ATS MODULE (founder 2026-11-17: "ee filters anni, ATS lo vunna prathi module lo vundali"):
 *   Interview Feedback, Offers, Joining (utils/intJoinList.js facets + filters), the Interview Calendar (each row carries `person`),
 *   Clients (each client carries its requirements' specializations / qualifications / designations).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4067.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-module-filters-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-module-filters-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = Number(process.env.TEST_PORT) || 4067;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'module-filters-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
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
  // offers: a few people at an offer step with a known specialization
  const offerApps = await prisma.application.findMany({ where: { stage: { in: ['SELECTED', 'OFFER', 'OFFER_ACCEPTED'] } }, select: { id: true, candidateId: true, requirementId: true }, take: 3 });
  for (const a of offerApps) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.candidate.update({ where: { id: a.candidateId }, data: { specialization: 'zz radiology', specialisationId: null, experienceYears: 6, currentDesignation: 'zz staff nurse', education: 'zz bsc nursing', qualificationId: null } });
  }
  await prisma.requirement.update({ where: { id: offerApps[0].requirementId }, data: { specialisation: 'zz cardiology', specialisationId: null } });
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

  console.log('1. Offers / Joining / Feedback (the shared list engine)');
  const o = await get('/ats/offers?page=1&pageSize=50&window=all');
  const f = (o.body && o.body.facets) || {};
  check('Offers: Specialization, Qualification, Designation and Experience come with counts', ['spec', 'qual', 'desig', 'expBand'].every((k) => Array.isArray(f[k]) && f[k].length > 0), Object.keys(f));
  check('our people count under "Zz Radiology" (tidied)', (f.spec || []).some((x) => x.value === 'Zz Radiology' && x.count >= offerApps.length), (f.spec || []).slice(0, 5));
  const o2 = await get('/ats/offers?page=1&pageSize=200&window=all&spec=Zz%20Radiology');
  const mine = new Set(offerApps.map((a) => a.candidateId));
  check('picking it lists only our people (each of their offer-stage applications)', o2.status === 200 && o2.body.total >= offerApps.length && (o2.body.rows || []).every((r) => mine.has(r.candidate.id)), [o2.body && o2.body.total]);
  const o3 = await get('/ats/offers?page=1&pageSize=200&window=all&expBand=5-10&desig=Zz%20Staff%20Nurse');
  check('Experience 5-10 + Designation Staff Nurse narrows the same way', o3.body.total === o2.body.total && (o3.body.rows || []).every((r) => mine.has(r.candidate.id)), o3.body && o3.body.total);
  check('picking it narrows the Client options too', (o2.body.facets.client || []).length <= (f.client || []).length && (o2.body.facets.client || []).length >= 1);
  const j = await get('/ats/joining?page=1&pageSize=20&window=all');
  check('Joining has the same four filters', ['spec', 'qual', 'desig', 'expBand'].every((k) => Array.isArray((j.body.facets || {})[k])), Object.keys(j.body.facets || {}));
  const fb = await get('/ats/feedback?page=1&pageSize=20&window=all');
  check('Interview Feedback has the same four filters', ['spec', 'qual', 'desig', 'expBand'].every((k) => Array.isArray((fb.body.facets || {})[k])), Object.keys(fb.body.facets || {}));

  console.log('2. Interview Calendar rows carry the four values');
  const iv = await get('/ats/calendar');
  const rows = Array.isArray(iv.body) ? iv.body : ((iv.body && (iv.body.recruitment || iv.body.rows)) || []);
  check('each interview row has person { spec, qual, desig, expBand }', rows.length > 0 && rows.every((r) => r.person && 'spec' in r.person && 'expBand' in r.person), rows[0] && Object.keys(rows[0]));

  console.log('3. Clients carry what their requirements ask for');
  const cl = await get('/clients?archived=1');
  const list = Array.isArray(cl.body) ? cl.body : ((cl.body && (cl.body.clients || cl.body.rows)) || []);
  const reqClient = (await prisma.requirement.findUnique({ where: { id: offerApps[0].requirementId }, select: { clientId: true } })).clientId;
  const c = list.find((x) => x.id === reqClient);
  check('every client row has reqSpecs / reqQuals / reqTitles', list.length > 0 && list.every((x) => Array.isArray(x.reqSpecs) && Array.isArray(x.reqQuals) && Array.isArray(x.reqTitles)), list[0] && Object.keys(list[0]).slice(0, 12));
  check('the client of our requirement lists "Zz Cardiology"', c && c.reqSpecs.includes('Zz Cardiology'), c && c.reqSpecs);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
