#!/usr/bin/env node
/**
 * THE CRM AGENT'S EXACT ANSWERS (crm/agentRouter.js, founder 2026-11-27: "crm agent ni kuda proper ga, ye kind of questions adigina answer chesey laaga
 * train cheyyu"): on a COPY of the sandbox with the CRM sample data loaded, a wide set of questions is asked through POST /api/crm/ai/ask and each
 * answer is checked against the database itself (the counts must be the real ones). The outside AI is switched off: a question the code does not
 * answer comes back as "the AI is not available", and is listed.
 *   TEST_SOURCE_DB=<sandbox.db> [TEST_PORT=4740] [SHOW=1] node scripts/crm-agent-answers-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-agent-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4740;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-agent-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`, INTEGRATION_SECRET_KEY: 'crm-agent-key',
  GROQ_API_KEY: '', GEMINI_API_KEY: '', OPENROUTER_API_KEY: '', ANTHROPIC_API_KEY: '', AI_PROVIDER: 'none', OLLAMA_URL: 'http://127.0.0.1:1',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const n = async (sql, ...a) => Number(((await DB.one(sql, ...a)) || {}).n || 0);
const num = (text) => { const m = /:\s*(\d+)/.exec(text || ''); return m ? Number(m[1]) : null; };

(async () => {
  const admin = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: admin.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: 'ignore' });
  for (let i = 0; i < 160; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await new Promise((r) => { setTimeout(r, 500); }); } // eslint-disable-line no-await-in-loop
  const tok = jwt.sign({ ...tokenPayload(await resolveIdentity(admin.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const call = async (method, url, body) => { const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
  const load = await call('POST', '/crm/sample');
  check('the CRM sample data is loaded', load.status === 200, load.body);
  const ask = async (q) => { const r = await call('POST', '/crm/ai/ask', { question: q }); return { code: r.status === 200 && r.body.provider === 'from your CRM data', text: (r.body && (r.body.text || r.body.error)) || '', items: (r.body && r.body.items) || [], intent: r.body && r.body.intent }; };
  const today = new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  const month = today.slice(0, 7);

  // the numbers the answers must give, read straight from the tables
  const openLeads = await n('SELECT COUNT(*) AS n FROM "CrmLead" WHERE COALESCE("status", \'New\') NOT IN (\'Converted\', \'Junk\')');
  const leadsMonth = await n('SELECT COUNT(*) AS n FROM "CrmLead" WHERE substr("createdAt", 1, 7) = ?', month);
  const hotOpen = await n('SELECT COUNT(*) AS n FROM "CrmLead" WHERE "rating" = \'Hot\' AND COALESCE("status", \'New\') NOT IN (\'Converted\', \'Junk\')');
  const openDeals = await n('SELECT COUNT(*) AS n FROM "CrmDeal" WHERE "stage" NOT IN (\'Won\', \'Lost\')');
  const wonMonth = await n('SELECT COUNT(*) AS n FROM "CrmDeal" WHERE "stage" = \'Won\' AND substr(COALESCE("wonAt", "updatedAt"), 1, 7) = ?', month);
  const lostAll = await n('SELECT COUNT(*) AS n FROM "CrmDeal" WHERE "stage" = \'Lost\'');
  const accounts = await n('SELECT COUNT(*) AS n FROM "CrmAccount"');
  const tickets = await n('SELECT COUNT(*) AS n FROM "CrmTicket" WHERE "status" NOT IN (\'Resolved\', \'Closed\')');
  const late = await n('SELECT COUNT(*) AS n FROM "CrmTask" WHERE "status" = \'Open\' AND "dueDate" < ?', today);
  const someLead = await DB.one('SELECT "company" FROM "CrmLead" WHERE "company" LIKE \'Sample%\' ORDER BY "createdAt" DESC LIMIT 1');

  const QS = [
    ['how many leads do I have', (a) => num(a.text) === openLeads, `${openLeads} open leads`],
    ['how many leads this month', (a) => num(a.text) === leadsMonth, `${leadsMonth} added this month`],
    ['hot leads', (a) => num(a.text) === hotOpen, `${hotOpen} hot open leads`],
    ['leads by source', (a) => /By source/.test(a.text), 'a by-source line'],
    ['how many leads came from linkedin this month', (a) => a.code && /linkedin/i.test(a.text), 'LinkedIn filter'],
    ['show my pipeline', (a) => num(a.text) === openDeals && /Likely/.test(a.text), `${openDeals} open deals + likely value`],
    ['deals closing this month', (a) => a.code && /expected to close/.test(a.text), 'closing this month'],
    ['which deals are stuck', (a) => a.code && /nothing for/.test(a.text), 'stale deals'],
    ['deals won this month', (a) => num(a.text) === wonMonth, `${wonMonth} won this month`],
    ['revenue last month', (a) => a.code && /won/.test(a.text), 'won last month'],
    ['why did we lose deals this year', (a) => a.code && /lost/.test(a.text) && /Why/.test(a.text), 'lost reasons'],
    ['lost deals', (a) => a.code && /lost/.test(a.text), `${lostAll} lost all time (this month shown)`],
    ['how many customers do we have', (a) => a.code && /account/.test(a.text), 'accounts'],
    ['how many accounts', (a) => num(a.text) === accounts, `${accounts} accounts`],
    ['decision makers', (a) => a.code && /decision maker/.test(a.text), 'decision makers'],
    ['which follow-ups are late', (a) => num(a.text) === late, `${late} late follow-ups`],
    ['follow ups today', (a) => a.code && /Today/.test(a.text), 'today'],
    ['meetings this week', (a) => a.code && /meeting/i.test(a.text), 'meetings'],
    ['how many calls this week', (a) => a.code && /call/.test(a.text), 'calls logged'],
    ['unpaid invoices', (a) => a.code && /unpaid/.test(a.text), 'unpaid invoices'],
    ['overdue invoices', (a) => a.code && /overdue/.test(a.text), 'overdue invoices'],
    ['payments received this month', (a) => a.code && /received/.test(a.text), 'payments'],
    ['open tickets', (a) => num(a.text) === tickets, `${tickets} open tickets`],
    ['campaigns', (a) => a.code && /campaign/.test(a.text), 'campaigns'],
    ['proposals sent', (a) => a.code && /proposal/.test(a.text), 'proposals'],
    ['what products do we sell', (a) => a.code && /product/.test(a.text), 'products'],
    ['how far am I from my target this month', (a) => a.code && /target/.test(a.text), 'target'],
    ['who won the most deals this month', (a) => a.code && /by person/.test(a.text), 'leaderboard'],
    ['top salesperson by leads', (a) => a.code && /leads added by person/.test(a.text), 'leaderboard by leads'],
    [`tell me about ${someLead ? someLead.company : 'Sample'}`, (a) => a.code && a.intent === 'record', 'the lead 360'],
    ['ee nela leads entha', (a) => num(a.text) === leadsMonth, 'Telugu: leads this month'],
    ['ninna enni calls chesam', (a) => a.code, 'Telugu: calls yesterday'],
    ['leads in hyderabad', (a) => a.code, 'city filter'],
    ['new leads today', (a) => a.code && /lead/.test(a.text), 'leads today'],
    ['converted leads this month', (a) => a.code && /converted/.test(a.text), 'converted'],
    // these are not counts: they go to the model (here switched off)
    ['write a follow up email to the client', (a) => !a.code, 'goes to the model'],
    ['how should I handle a price objection', (a) => !a.code, 'goes to the model'],
    ['and the second one?', (a) => !a.code, 'goes to the model (a follow-on)'],
  ];
  const toModel = [];
  for (const [q, ok, want] of QS) {
    const a = await ask(q); // eslint-disable-line no-await-in-loop
    if (process.env.SHOW) console.log(`\n  Q: ${q}\n  ${a.text.split('\n').slice(0, 4).join('\n  ')}`);
    if (!a.code) toModel.push(q);
    check(`"${q}" -> ${want}`, ok(a), a.text.split('\n').slice(0, 3).join(' | '));
  }
  console.log(`\nSent to the model (outside AI off here): ${toModel.join(' · ') || 'none'}`);
  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.log(`FAIL  crashed: ${e.stack || e.message}`); await stop(1); });
