#!/usr/bin/env node
/**
 * THE AI MEETING ANSWERS WHAT IS ASKED (founder 2026-11-17, lead L-0013: "it does not answer what is asked, it says whatever it likes").
 * Sandbox (no model): the written answers must answer the founder's questions and the usual client / HR ones at once, never a menu list,
 * never "one click to Naukri / LinkedIn", never the same answer for a different question; a catalogue written before (with the false
 * posting answer, a menu-list answer and "Vannet search") is corrected by itself; the claim guard drops what the product text does not say.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4079.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-meeting-answers-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-meetans-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4079;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'meetans-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, PUBLIC_BASE_URL: `http://localhost:${PORT}` };
delete env.TEST_ALLOW_AI;
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const PS = require('../src/crm/productSales');
const { QUESTIONS, problemsOf } = require('./lib/meetingQuestions');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}

(async () => {
  // the catalogue as it was on live before the fix: the old seed answer, a menu-list answer from the video, "Vannet search"
  await prisma.$executeRawUnsafe('DROP TABLE IF EXISTS "CrmProduct"').catch(() => {});
  const { ensure } = PS;
  await ensure();
  await prisma.$executeRawUnsafe('UPDATE "CrmProduct" SET "faq" = ?, "features" = ? WHERE "key" = \'ATS\'',
    'Q: Can we post jobs to Naukri and LinkedIn?\nA: Yes. Jobs go to your careers page and Google Jobs automatically, and to Naukri, Shine, Indeed and LinkedIn with one click.\n\nQ: Can our clients see the shortlisted candidates?\nA: Yes. Each client gets a client portal login to shortlist and give feedback.\n\nQ: What features does TeamLink ATS offer?\nA: TeamLink ATS offers a range of features including dashboard, clients and requirements, requirements, agreements, candidates and pipeline, new job order, people, sources, track lists, review calendar, feedback, reports, team, job portal, AI co-pilot, jobs, applications, talent pool, advanced search, Vannet search, and reports.',
    JSON.stringify(['Clients and requirements lists every client', 'Job portal, careers page and Google Jobs posting; one-click posting to Naukri, Shine, Indeed, LinkedIn and others', 'Vannet search saves searches']));
  await PS.fixWrittenText();
  const [ats] = await prisma.$queryRawUnsafe('SELECT "faq","features" FROM "CrmProduct" WHERE "key" = \'ATS\'');
  check('1 the catalogue written before is corrected: no one-click Naukri / LinkedIn, no menu-list answer, no "Vannet", the client workflow added',
    !/one[- ]click/i.test(ats.faq + ats.features) && !/offers a range of features/i.test(ats.faq) && !/vannet/i.test(ats.faq + ats.features) && /How do clients come into the ATS\?/.test(ats.faq) && /department team lead/i.test(ats.faq) && /Can our clients see the shortlisted candidates/.test(ats.faq), ats);
  await PS.fixWrittenText();
  const [ats2] = await prisma.$queryRawUnsafe('SELECT "faq" FROM "CrmProduct" WHERE "key" = \'ATS\'');
  check('2 running the correction again changes nothing (no doubled answers)', ats2.faq === ats.faq);

  // the claim guard and the reading of the question
  const kn = 'job portal careers website google jobs naukri shine client portal';
  const g = PS.guardClaims('You can post jobs to Naukri and LinkedIn with one click. Each client gets a portal login. We also integrate with SAP.', kn);
  check('3 claim guard: one-click job boards become the true posting sentence; an integration the text does not name is dropped', /Job Portal/.test(g) && !/one click/i.test(g) && !/SAP/.test(g) && /portal login/.test(g), g);
  check('4 "ads" in an ATS meeting is read as ATS (but not in an Omni-Channel meeting)', /ATS/.test(PS.readQuestion('how clients come into the ads', [{ key: 'ATS' }])) && /ads/.test(PS.readQuestion('how do ads work', [{ key: 'OMNI' }])));

  // the meeting itself (no model in the sandbox: the written answers)
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => { setTimeout(r, 500); }); // eslint-disable-line no-await-in-loop
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const meetFor = async (product) => {
    const L = await call('POST', '/crm/leads', { company: `ZZTEST MA ${product} ${process.pid}`, contactName: 'Pallavi Test', source: 'Website' }, tA);
    await call('POST', `/crm/leads/${L.body.lead.id}/products`, { products: [product] }, tA);
    const m = await call('POST', `/crm/leads/${L.body.lead.id}/ai-meeting`, {}, tA);
    return m.body.url.split('/').pop();
  };
  const rooms = { ATS: await meetFor('ATS'), HRMS: await meetFor('HRMS') };
  const answers = {};
  for (const item of QUESTIONS) {
    const r = await call('POST', `/crm-public/meet/${rooms[item.product]}/say`, { text: item.q, lang: item.lang }); // eslint-disable-line no-await-in-loop
    answers[item.id] = r.body.reply;
    const probs = problemsOf(item.lang === 'te-IN' ? { ...item, lang: 'en-IN' } : item, r.body.reply); // the sandbox has no model to write Telugu
    if (item.written) check(`${item.id} "${item.q}" -> answered from the written Q&A with the key facts`, r.status === 200 && probs.length === 0, { reply: r.body.reply, probs });
    else check(`${item.id} "${item.q}" -> no false claim, no menu list (written answer or "our team will confirm")`, r.status === 200 && problemsOf({ ...item, must: [], lang: 'en-IN' }, r.body.reply).length === 0, { reply: r.body.reply });
  }
  check('F2 and F3 (different questions) get different answers', answers.F2 !== answers.F3, [answers.F2, answers.F3]);
  check('F1 ("ads") gets the same right answer as F2 ("ats")', answers.F1 === answers.F2, [answers.F1, answers.F2]);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
