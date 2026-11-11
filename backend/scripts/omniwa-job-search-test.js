#!/usr/bin/env node
/**
 * WhatsApp AI job search (omniwa/tools.js searchJobs): a candidate asking for "mbbs" finds the Doctor / Consultant jobs, "nurse" finds Nursing, filler words
 * ("full time", "any vacancies", a greeting) are not subjects, and an unknown subject still finds nothing.
 * SANDBOX ONLY: works on a COPY of the database (VACUUM INTO a temp file); nothing real is read back or sent.
 *   node scripts/omniwa-job-search-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || [path.join(BACK, 'prisma', 'sandbox.db'), path.join(BACK, 'prisma', 'dev.db')].find((f) => fs.existsSync(f));
if (!SOURCE) { console.log('No database to copy (prisma/sandbox.db or prisma/dev.db).'); process.exit(2); }
const COPY = path.join(os.tmpdir(), `zz-omniwa-search-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
process.env.DATABASE_URL = `file:${COPY.split(path.sep).join('/')}`;
process.env.TEST_MODE = '1';
process.env.TEAMLINK_SANDBOX = '1';
process.env.JWT_SECRET = 'omniwa-job-search-test';

let failed = 0; let total = 0;
const ok = (name, cond, extra = '') => { total += 1; if (!cond) failed += 1; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`); };

(async () => {
  const prisma = require('../src/db');
  const T = require('../src/omniwa/tools');
  const client = await prisma.client.findFirst();
  if (!client) { console.log('The copy has no client to attach requirements to.'); process.exit(2); }
  const mk = (id, extra) => prisma.requirement.create({ data: { id, clientId: client.id, status: 'OPEN', internal: false, ...extra } });
  // the live shape: titles say Doctor / Consultant and MBBS is only in the education field
  await mk('zzj_derm', { title: 'Consultant / Doctor — Dermatologist', department: 'Medical', location: 'Hyderabad', education: 'MBBS, MD' });
  await mk('zzj_gastro', { title: 'Consultant / Doctor — Gastroenterologist', department: 'Medical', location: 'Chennai', education: 'MBBS' });
  await mk('zzj_edu', { title: 'Assistant Professor — Physiology', department: 'Education', location: 'Hyderabad', education: 'MBBS, MD (Physiology)' });
  await mk('zzj_nurse', { title: 'Staff Nurse', department: 'Medical', location: 'Hyderabad', education: 'B.Sc Nursing' });
  await mk('zzj_it', { title: 'Java Developer', department: 'IT', location: 'Bengaluru', education: 'Any Degree' });
  await mk('zzj_closed', { title: 'Consultant / Doctor — Closed one', department: 'Medical', status: 'CLOSED', education: 'MBBS' });

  const ids = async (text) => (await T.searchJobs(text, { limit: 10 }));
  const titles = (r) => r.jobs.map((j) => j.title);

  let r = await ids('i need a full time mbbs job is there nay vaccancies for that');
  ok('"i need a full time mbbs job ... vaccancies": finds the doctor jobs', r.searched && r.jobs.length >= 2 && titles(r).some((t) => /Dermatologist/.test(t)) && titles(r).some((t) => /Gastro/.test(t)), titles(r).join(' | '));
  ok('the closed job is not offered', !titles(r).some((t) => /Closed one/.test(t)));
  ok('a job with MBBS only in its education field is found too', titles(r).some((t) => /Physiology/.test(t)));
  r = await ids('mbbs');
  ok('"mbbs" alone finds jobs', r.jobs.length >= 2, `${r.total} found`);
  r = await ids('doctor');
  ok('"doctor" finds the doctor jobs', titles(r).some((t) => /Doctor/.test(t)));
  r = await ids('nurse vacancies');
  ok('"nurse vacancies" finds the Staff Nurse job first', r.jobs.length >= 1 && /Nurse/.test(titles(r)[0]), titles(r).join(' | '));
  r = await ids('hloo may i know the details of job');
  ok('a vague "details of job" is no subject: nothing is searched (the chat asks what kind of work)', r.searched === false, JSON.stringify({ searched: r.searched }));
  r = await ids('java');
  ok('"java" still finds the Java job', titles(r).includes('Java Developer'));
  r = await ids('astronaut');
  ok('an unknown subject finds nothing', r.searched && r.jobs.length === 0);

  console.log(`\n${total - failed}/${total} passed`);
  try { fs.unlinkSync(COPY); } catch { /* temp file */ }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', (e && e.stack) || e); try { fs.unlinkSync(COPY); } catch { /* temp file */ } process.exit(1); });
