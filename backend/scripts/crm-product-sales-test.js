#!/usr/bin/env node
/**
 * SELLING OUR PRODUCTS (founder 2026-11-17): HRMS / ATS / Omni-Channel catalogue, the lead's product interest, the demo page with only that
 * product's video, the AI meeting (no model in the sandbox: written answers / "the team will answer"), the guard against made-up prices and
 * discounts, the meeting's end (yes -> Qualified + follow-up, no -> Lost), and onboarding + renewal follow-ups after Won.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4077.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-product-sales-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-prodsales-${process.pid}.db`);
const VID = path.join(os.tmpdir(), `zz-prodsales-vid-${process.pid}`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
fs.mkdirSync(VID, { recursive: true });
fs.writeFileSync(path.join(VID, 'HRMS.mp4'), Buffer.alloc(4096, 1));
fs.writeFileSync(path.join(VID, 'ATS.mp4'), Buffer.alloc(2048, 2));
const PORT = 4077;
const BASE = `http://localhost:${PORT}`;
const API = `${BASE}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'prodsales-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, CRM_DEMO_DIR: VID, PUBLIC_BASE_URL: BASE };
delete env.TEST_ALLOW_AI;
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const PS = require('../src/crm/productSales');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, body: j, headers: r.headers };
};
const tokOf = (url) => url.split('/').pop();
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.rmSync(VID, { recursive: true, force: true }); } catch { /* none */ } process.exit(code); }, 800);
}
const P = process.pid;

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tA = jwt.sign({ ...tokenPayload(await resolveIdentity(adminRow.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });

  // ---- catalogue
  const pr = await call('GET', '/crm/products', null, tA);
  const keys = (pr.body.products || []).map((p) => p.key);
  check('1 the catalogue has HRMS, ATS and Omni-Channel, each with features and 3 plans', pr.status === 200 && ['HRMS', 'ATS', 'OMNI'].every((k) => keys.includes(k)) && pr.body.products.every((p) => p.features.length >= 5 && p.plans.length === 3), pr.body);
  check('1b every plan has a starting price and every product has Q&A (GST, billing, data)', pr.body.products.every((p) => p.plans.every((x) => /^₹/.test(x.price)) && /GST/.test(p.faq || '')), pr.body.products.map((p) => p.plans.map((x) => x.price)));
  const atsKn = `PLANS: ${pr.body.products.find((p) => p.key === 'ATS').plans.map((x) => `${x.name} ${x.price} ${x.unit}`).join('; ')}`;
  check('1c guard: the written ATS price ₹2,499 passes as written', /2,499/.test(PS.guardReply('Growth is ₹2,499 per recruiter / month.', atsKn)), PS.guardReply('Growth is ₹2,499 per recruiter / month.', atsKn));
  await PS.setVideoFile('HRMS', 'HRMS.mp4'); await PS.setVideoFile('ATS', 'ATS.mp4');
  const sv = await call('PUT', '/crm/products/HRMS', { plans: [{ name: 'Starter', price: '₹149', unit: 'per employee / month', includes: 'Attendance, leave, payroll' }], faq: 'Q: Does it work with biometric devices?\nA: Yes, eSSL and ZKTeco devices push punches straight into TeamLink attendance.' }, tA);
  check('2 the manager sets the HRMS price and a written answer', sv.status === 200 && sv.body.product.plans[0].price === '₹149' && /eSSL/.test(sv.body.product.faq), sv.body);
  check('3 a video link that is not https is refused', (await call('PUT', '/crm/products/ATS', { videoUrl: 'http://x.example/v.mp4' }, tA)).status === 400);
  check('4 an unknown product is 404', (await call('PUT', '/crm/products/ERP', { name: 'x' }, tA)).status === 404);

  // ---- a lead wants HRMS
  const L = await call('POST', '/crm/leads', { company: `ZZTEST PS Acme ${P}`, contactName: 'Ravi Kumar', phone: `97${String(Date.now()).slice(-8)}`, email: `zz-ps-${P}@example.test`, source: 'Website' }, tA);
  const lead = L.body && L.body.lead;
  check('5 setup: a lead', L.status === 200 && !!lead, L.body);
  check('6 no product picked: the demo asks which product first', (await call('POST', `/crm/leads/${lead.id}/demo`, { channel: 'link' }, tA)).status === 400);
  const sp = await call('POST', `/crm/leads/${lead.id}/products`, { products: ['hrms', 'ERP'] }, tA);
  check('7 the lead wants HRMS (unknown keys dropped)', sp.status === 200 && JSON.stringify(sp.body.products) === '["HRMS"]', sp.body);
  const dm = await call('POST', `/crm/leads/${lead.id}/demo`, { channel: 'whatsapp' }, tA);
  check('8 the demo link + a WhatsApp message ready to send', dm.status === 200 && /\/api\/crm-public\/demo\//.test(dm.body.url) && /^https:\/\/wa\.me\/91\d{10}\?text=/.test(dm.body.whatsappUrl || ''), dm.body);
  const dt = tokOf(dm.body.url);

  // ---- the demo page: only the HRMS video
  const page = await fetch(dm.body.url).then(async (r) => ({ status: r.status, html: await r.text() }));
  check('9 the demo page shows HRMS only, with its own video', page.status === 200 && /TeamLink HRMS/.test(page.html) && !/TeamLink ATS/.test(page.html) && page.html.includes(`/demo/${dt}/video/HRMS`), page.html.slice(0, 300));
  const v = await fetch(`${API}/crm-public/demo/${dt}/video/HRMS`, { headers: { Range: 'bytes=0-99' } });
  check('10 the HRMS video streams in parts (range)', v.status === 206 && Number(v.headers.get('content-length')) === 100, [v.status, v.headers.get('content-length')]);
  const va = await fetch(`${API}/crm-public/demo/${dt}/video/ATS`);
  check('11 the ATS video is NOT given on an HRMS link', va.status === 404, va.status);
  check('12 a changed link is refused', (await fetch(`${API}/crm-public/demo/${dt.slice(0, -2)}xx`)).status === 404);
  const ev1 = await call('POST', `/crm-public/demo/${dt}/event`, { kind: 'open' });
  await call('POST', `/crm-public/demo/${dt}/event`, { kind: 'open' });
  const opens = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmActivity" WHERE "leadId" = ? AND "subject" LIKE ?', lead.id, 'Demo opened%');
  check('13 the lead opened the demo: once on the timeline (not every reload)', ev1.status === 200 && Number(opens[0].n) === 1, Number(opens[0].n));
  const it = await call('POST', `/crm-public/demo/${dt}/event`, { kind: 'interested' });
  check('14 "I\'m interested" gives the AI meeting link', it.status === 200 && /\/api\/crm-public\/meet\//.test(it.body.meetUrl || ''), it.body);
  const mt = tokOf(it.body.meetUrl);

  // ---- the AI meeting
  const mp = await fetch(it.body.meetUrl).then(async (r) => ({ status: r.status, html: await r.text() }));
  check('15 the meeting room opens and says it is an AI', mp.status === 200 && /AI assistant/.test(mp.html) && /₹149/.test(mp.html), mp.html.slice(0, 200));
  const st = await call('GET', `/crm-public/meet/${mt}/state`);
  check('16 the AI greets the lead by name', st.status === 200 && st.body.status === 'Open' && /Hello Ravi/.test(st.body.transcript[0].text), st.body);
  const q1 = await call('POST', `/crm-public/meet/${mt}/say`, { text: 'Does it work with our biometric devices?' });
  check('17 a question with a written answer gets that answer (no model in the sandbox)', q1.status === 200 && /eSSL/.test(q1.body.reply) && !q1.body.unanswered, q1.body);
  const q2 = await call('POST', `/crm-public/meet/${mt}/say`, { text: 'Can you integrate with SAP SuccessFactors?' });
  check('18 a question with no written answer: the team will answer (marked open)', q2.status === 200 && q2.body.unanswered === true, q2.body);
  check('19 an empty question is refused', (await call('POST', `/crm-public/meet/${mt}/say`, { text: '  ' })).status === 400);
  const kn = 'PLANS: Starter ₹149 per employee / month';
  check('20 guard: a made-up price is replaced by "our team will quote"', /quote/.test(PS.guardReply('It costs ₹99 per user / month.', kn)), PS.guardReply('It costs ₹99 per user / month.', kn));
  check('21 guard: the written price passes', /₹149/.test(PS.guardReply('Starter is ₹149 per employee / month.', kn)));
  check('22 guard: no discount promises', !/discount/i.test(PS.guardReply('Great news. I can give you a 20% discount today. It has payroll.', kn)));

  const end = await call('POST', `/crm-public/meet/${mt}/end`, { decision: 'yes' });
  const after = await call('GET', `/crm/leads/${lead.id}`, null, tA);
  const ms = await call('GET', `/crm/leads/${lead.id}/ai-meetings`, null, tA);
  const m0 = (ms.body.meetings || [])[0];
  check('23 "Go ahead": the meeting is saved with summary, score and open questions', end.status === 200 && m0 && m0.status === 'Ended' && m0.decision === 'yes' && m0.summary && m0.summary.openQuestions.some((x) => /SAP/.test(x)) && m0.score >= 40, m0 && { s: m0.summary, sc: m0.score });
  check('24 the lead is Qualified and has a "send the proposal" follow-up', after.body.lead.stage === 'Qualified' && after.body.tasks.some((t) => /send the proposal/i.test(t.title)), { stage: after.body.lead.stage, tasks: after.body.tasks.map((t) => t.title) });
  check('25 the timeline has the demo, the interest and the meeting', ['Demo link made', 'Interested after the demo', 'AI meeting held'].every((w) => after.body.activities.some((a) => String(a.subject).startsWith(w))), after.body.activities.map((a) => a.subject));
  check('26 an ended meeting takes no more questions', (await call('POST', `/crm-public/meet/${mt}/say`, { text: 'one more thing please' })).status === 400);

  // ---- another lead says no
  const L2 = await call('POST', '/crm/leads', { company: `ZZTEST PS Beta ${P}`, contactName: 'Sita', phone: `96${String(Date.now()).slice(-8)}`, source: 'Website' }, tA);
  await call('POST', `/crm/leads/${L2.body.lead.id}/products`, { products: ['ATS', 'OMNI'] }, tA);
  const ml = await call('POST', `/crm/leads/${L2.body.lead.id}/ai-meeting`, {}, tA);
  const page2 = await fetch(ml.body.url).then((r) => r.text());
  check('27 an ATS + Omni lead: the meeting shows those two, not HRMS', /TeamLink ATS/.test(page2) && /Omni-Channel/.test(page2) && !/TeamLink HRMS/.test(page2));
  await call('POST', `/crm-public/meet/${tokOf(ml.body.url)}/end`, { decision: 'no' });
  const l2 = await call('GET', `/crm/leads/${L2.body.lead.id}`, null, tA);
  check('28 "Not for now": the lead is Lost', l2.body.lead.stage === 'Lost', l2.body.lead.stage);

  // ---- Won: onboarding + renewal
  const cv = await call('POST', `/crm/leads/${lead.id}/convert`, { value: 150000, expectedClose: new Date().toISOString().slice(0, 10) }, tA);
  const deal = cv.body && cv.body.deal;
  const won = deal ? await call('POST', `/crm/deals/${deal.id}/stage`, { stage: 'Won' }, tA) : { status: 0 };
  await new Promise((r) => { setTimeout(r, 400); });
  const tasks = deal ? await prisma.$queryRawUnsafe('SELECT "title","dueDate" FROM "CrmTask" WHERE "dealId" = ?', deal.id) : [];
  check('29 Won: onboarding (3 steps) and the renewal reminder are planned', won.status === 200 && tasks.filter((t) => /^Onboarding:/.test(t.title)).length === 3 && tasks.some((t) => /^Renewal:/.test(t.title)), { won: won.status, err: won.body && won.body.error, cv: cv.status, tasks });
  if (deal) {
    await call('POST', `/crm/deals/${deal.id}/stage`, { stage: 'Negotiation' }, tA);
    await call('POST', `/crm/deals/${deal.id}/stage`, { stage: 'Won' }, tA);
    const again = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "CrmTask" WHERE "dealId" = ? AND "title" LIKE ?', deal.id, 'Onboarding:%');
    check('30 winning it again does not plan onboarding twice', Number(again[0].n) === 3, Number(again[0].n));
  }

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
