#!/usr/bin/env node
/**
 * CRM WAVE A (2026-11-24): automation, integrations & API, reports & dashboards. One section per feature ID of crm-gaps-A.
 *   08.07 webhooks · 15.09 Slack / Teams · 15.01 API keys · 15.03 Zapier REST hooks · 15.12 MCP CRM tools · 08.01 / 08.05 rules + field updates
 *   08.02 date rules + delays (SLA / escalation) · 08.08 multi-step approvals · 08.09 builder graph + try-on-a-record · 08.12 scripts
 *   10.02 report builder · 10.03 my dashboard · 10.05 leaderboard · 10.08 scheduled reports · 10.13 trends / cohorts
 *   15.04 / 15.05 calendar feed + vCard · 15.08 apps catalogue — and wrong-role refusals and scope everywhere.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database. Webhook / Slack / Teams posts go to a local mock server; mail goes to
 * the sandbox's fake transport (captured to a file). Nothing reaches a real person.
 *   TEST_SOURCE_DB=<sandbox.db> TEST_PORT=4xxx node scripts/crm-A-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-A-${process.pid}.db`);
const MAIL = path.join(os.tmpdir(), `zz-crm-A-mail-${process.pid}.jsonl`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const dbx = new DatabaseSync(COPY);
dbx.exec('DELETE FROM "AppSetting" WHERE "key" IN (\'crm.settings\', \'crm.website\', \'crm.wave\')');
dbx.close();

const PORT = Number(process.env.TEST_PORT) || 4321;
const MOCK = PORT + 1;
const API = `http://localhost:${PORT}/api`;
const env = {
  ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'crm-A-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}`,
  ALLOW_PRIVATE_FETCH: '1', TEST_MOCK_PORTS: String(MOCK), INTEGRATION_SECRET_KEY: crypto.randomBytes(32).toString('hex'), TEST_MAIL_CAPTURE: MAIL, APP_BASE_URL: 'https://crm.example.test',
};
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const DB = require('../src/crm/schema');
const W = require('../src/crm/waveSchema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token, { binary, headers = {}, raw } = {}) => {
  const r = await fetch((raw ? `http://localhost:${PORT}` : API) + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const type = r.headers.get('content-type') || '';
  if (binary && !/json/.test(type)) return { status: r.status, type, buf: Buffer.from(await r.arrayBuffer()) };
  if (/text\/(calendar|vcard|plain)/.test(type)) return { status: r.status, type, text: await r.text() };
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j, type };
};
const key = (k) => ({ headers: { Authorization: `Bearer ${k}` } });
const tokenOf = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
const mkUser = (tag, data) => prisma.user.create({ data: { name: `ZZ A ${tag}`, email: `zz.crma.${tag}.${process.pid}@example.test`, passwordHash: 'x', status: 'Active', passwordChangedAt: new Date(Date.now() - 3600e3), ...data } });
const ymd = (offset) => new Date(Date.now() + 5.5 * 3600000 + offset * 86400000).toISOString().slice(0, 10);
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
async function until(fn, ms = 6000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await sleep(150); } } // eslint-disable-line no-await-in-loop

// the mock outside world: every POST is kept
const got = [];
const mock = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => { let j = null; try { j = JSON.parse(b); } catch { /* */ } got.push({ path: req.url, headers: req.headers, raw: b, body: j }); res.writeHead(req.url.includes('/fail') ? 500 : 200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
});
const hits = (p, pred = () => true) => got.filter((g) => g.path.startsWith(p) && pred(g));

let server;
async function stop(code) {
  if (server) server.kill();
  mock.close();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } try { fs.unlinkSync(MAIL); } catch { /* none */ } process.exit(code); }, 800);
}
const mails = () => { try { return fs.readFileSync(MAIL, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

(async () => {
  await new Promise((r) => mock.listen(MOCK, '127.0.0.1', r));
  await DB.ensure(); await W.ensure();
  const A = await mkUser('repA', { role: 'EMPLOYEE' });
  const B = await mkUser('repB', { role: 'EMPLOYEE' });
  const M = await mkUser('mgr', { role: 'EMPLOYEE' });
  const V = await mkUser('viewer', { role: 'EMPLOYEE' });
  const N = await mkUser('nobody', { role: 'EMPLOYEE' });
  const X = await mkUser('admin', { role: 'SUPER_ADMIN' });
  const tk = {}; for (const [k, u] of Object.entries({ A, B, M, V, N, X })) tk[k] = await tokenOf(u.id); // eslint-disable-line no-await-in-loop
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 240; i += 1) { if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break; await sleep(1000); } // eslint-disable-line no-await-in-loop
  await sleep(800);

  const own = { create: true, edit: true, delete: false, import: false, export: false, reports: false };
  const put = await call('PUT', '/crm/settings', { salesTeam: [
    { userId: A.id, name: A.name, role: 'rep', rights: own }, { userId: B.id, name: B.name, role: 'rep', rights: own }, { userId: M.id, name: M.name, role: 'manager' }, { userId: V.id, name: V.name, role: 'viewer' },
  ] }, tk.X);
  check('setup: two salespeople, a Sales manager, a viewer', put.status === 200, put.body);
  const mkLead = async (tok, extra = {}) => (await call('POST', '/crm/leads', { company: `ZZ A Co ${crypto.randomBytes(3).toString('hex')}`, contactName: 'Asha', phone: phone(), email: `asha.${crypto.randomBytes(3).toString('hex')}@example.test`, source: 'LinkedIn', ...extra }, tok)).body;
  const mkAccDeal = async (tok, value = 100000, extra = {}) => {
    const acc = (await call('POST', '/crm/accounts', { name: `ZZ A Acc ${crypto.randomBytes(3).toString('hex')}`, force: true }, tok)).body.account;
    return (await call('POST', '/crm/deals', { title: `ZZ A Deal ${crypto.randomBytes(3).toString('hex')}`, accountId: acc.id, value, ...extra }, tok)).body.deal;
  };

  console.log('access: nobody outside the CRM team, salespeople not into the set-up');
  check('a non-CRM login is refused the rules', (await call('GET', '/crm/automation/rules', null, tk.N)).status === 403);
  check('a salesperson cannot see the rules', (await call('GET', '/crm/automation/rules', null, tk.A)).status === 403);
  check('a viewer cannot see the webhooks', (await call('GET', '/crm/wave/webhooks', null, tk.V)).status === 403);
  const sw0 = await call('GET', '/crm/wave/switches', null, tk.M);
  check('every switch starts OFF', sw0.status === 200 && ['rulesOn', 'scriptsOn', 'webhooksOn', 'chatOn', 'apiOn', 'mcpCrm', 'mcpWrite', 'schedulesOn', 'calendarFeed'].every((k) => sw0.body.switches[k] === false) && sw0.body.canChange === false, sw0.body);
  check('a Sales manager cannot turn a switch on (Admin only)', (await call('PUT', '/crm/wave/switches', { webhooksOn: true }, tk.M)).status === 403);

  console.log('08.07 outbound webhooks');
  const hk = await call('POST', '/crm/wave/webhooks', { url: `http://127.0.0.1:${MOCK}/hook`, events: ['lead.created', 'deal.won', 'invoice.paid'], label: 'Our ERP' }, tk.M);
  check('a Sales manager adds a webhook; the signing secret is shown once', hk.status === 200 && /^whsec_/.test(hk.body.secret) && hk.body.hook.events.length === 3, hk.body);
  check('a salesperson cannot add one', (await call('POST', '/crm/wave/webhooks', { url: `http://127.0.0.1:${MOCK}/x` }, tk.A)).status === 403);
  check('an unknown event is refused', (await call('POST', '/crm/wave/webhooks', { url: `http://127.0.0.1:${MOCK}/x`, events: ['lead.exploded'] }, tk.M)).status === 400);
  const secret = hk.body.secret;
  const stored = await W.one('SELECT "secret" FROM "CrmWebhook" WHERE "id" = ?', hk.body.hook.id);
  check('the secret is kept encrypted', stored && stored.secret && !stored.secret.includes(secret), stored);
  const L0 = await mkLead(tk.A);
  await sleep(700);
  check('switch off: nothing is sent', hits('/hook').length === 0, got.length);
  check('the Admin turns webhooks on', (await call('PUT', '/crm/wave/switches', { webhooksOn: true }, tk.X)).status === 200);
  const L1 = await mkLead(tk.A);
  const h1 = await until(() => hits('/hook', (g) => g.body && g.body.event === 'lead.created' && g.body.data.record.id === L1.lead.id)[0]);
  check('lead.created reaches the address', !!h1, got.map((g) => g.body && g.body.event));
  check('signed: X-TeamLink-Signature = sha256 HMAC of the body', h1 && h1.headers['x-teamlink-signature'] === `sha256=${crypto.createHmac('sha256', secret).update(h1.raw).digest('hex')}`, h1 && h1.headers);
  check('no phone or email unless the address was set to include them', h1 && h1.body.data.record.phone === undefined && h1.body.data.record.email === undefined && h1.body.data.record.company === L1.lead.company, h1 && h1.body);
  void L0; // eslint-disable-line no-void
  await call('PUT', `/crm/wave/webhooks/${hk.body.hook.id}`, { includeContact: true }, tk.M);
  const L2 = await mkLead(tk.A);
  const h2 = await until(() => hits('/hook', (g) => g.body && g.body.data && g.body.data.record && g.body.data.record.id === L2.lead.id)[0]);
  check('with "include phone and email" ticked they are sent', h2 && h2.body.data.record.phone === L2.lead.phone, h2 && h2.body);
  const D1 = await mkAccDeal(tk.A, 200000);
  await sleep(500);
  check('deal.created is not sent (not ticked)', !hits('/hook', (g) => g.body && g.body.event === 'deal.created').length);
  const won1 = await call('POST', `/crm/deals/${D1.id}/stage`, { stage: 'Won' }, tk.A);
  const hw = await until(() => hits('/hook', (g) => g.body && g.body.event === 'deal.won' && g.body.data.record.id === D1.id)[0]);
  check('deal.won reaches the address with the stage before', won1.status === 200 && hw && hw.body.data.record.stage === 'Won' && hw.body.data.before.stage === 'Prospecting', hw && hw.body);
  const inv = won1.body.invoice;
  await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Sent' }, tk.A);
  await call('POST', `/crm/invoices/${inv.id}/status`, { status: 'Paid' }, tk.A);
  check('invoice.paid reaches the address', !!(await until(() => hits('/hook', (g) => g.body && g.body.event === 'invoice.paid' && g.body.data.record.id === inv.id)[0])));
  const tst = await call('POST', `/crm/wave/webhooks/${hk.body.hook.id}/test`, null, tk.M);
  check('Test sends a ping', tst.status === 200 && tst.body.ok === true && hits('/hook', (g) => g.body && g.body.event === 'ping').length === 1, tst.body);
  const lst = await call('GET', '/crm/wave/webhooks', null, tk.M);
  check('the list shows the delivery log', lst.status === 200 && lst.body.log.length >= 4 && lst.body.hooks[0].lastStatus.startsWith('Delivered'), lst.body && lst.body.log && lst.body.log.length);
  const bad = await call('POST', '/crm/wave/webhooks', { url: 'ftp://example.com/x' }, tk.M);
  check('a non-https address is refused', bad.status === 400, bad.body);

  console.log('15.09 Slack / Microsoft Teams');
  for (const id of ['slack', 'teams']) {
    // eslint-disable-next-line no-await-in-loop
    const cf = await call('PUT', `/admin/integrations/${id}/configure`, { values: { 'Incoming webhook URL (secret)': `http://127.0.0.1:${MOCK}/${id}`, 'Channel name (shown only)': '#sales' } }, tk.X);
    check(`Administration > Integrations keeps the ${id} URL (encrypted)`, cf.status === 200, cf.body);
  }
  const intg = await prisma.integration.findUnique({ where: { id: 'slack' } });
  check('the Slack URL is not stored in plain text', intg && !String(intg.values || '').includes(`/slack`), intg && intg.values);
  const ct = await call('POST', '/crm/wave/chat/test', { tool: 'teams' }, tk.M);
  check('"Send a test" posts to Teams', ct.status === 200 && ct.body.ok === true && hits('/teams').length === 1, ct.body);
  await call('PUT', '/crm/wave/switches', { slackEvents: ['deal.won'], teamsEvents: ['lead.created'] }, tk.M);
  const L3 = await mkLead(tk.A);
  await sleep(700);
  check('switch off: nothing is posted', hits('/slack').length === 0 && hits('/teams').length === 1);
  await call('PUT', '/crm/wave/switches', { chatOn: true }, tk.X);
  const L4 = await mkLead(tk.A, { source: 'Referral' });
  const tm = await until(() => hits('/teams', (g) => g.body && /New lead/.test(g.body.text) && g.body.text.includes(L4.lead.company))[0]);
  check('a new lead is posted to Teams as text + an Adaptive Card', tm && tm.body.attachments[0].contentType === 'application/vnd.microsoft.card.adaptive' && /Referral/.test(tm.body.text), tm && tm.body);
  const D2 = await mkAccDeal(tk.A, 150000);
  await call('POST', `/crm/deals/${D2.id}/stage`, { stage: 'Won' }, tk.A);
  const sl = await until(() => hits('/slack', (g) => g.body && /Deal won/.test(g.body.text) && g.body.text.includes(D2.title))[0]);
  check('a won deal is posted to Slack with its value and a link', sl && /₹1,50,000/.test(sl.body.text) && /crm\.example\.test\/crm\/deals\?open=deal:/.test(sl.body.text), sl && sl.body);
  check('a new lead is NOT posted to Slack (not ticked there)', !hits('/slack', (g) => g.body && /New lead/.test(g.body.text)).length);
  void L3; // eslint-disable-line no-void
  const at = await call('POST', '/api/admin/integrations/slack/test'.replace('/api', ''), null, tk.X);
  check('Administration > Integrations > Slack > Test posts a line', at.status === 200 && /Posted to Slack/.test(at.body.result || ''), at.body);

  console.log('15.01 CRM API keys');
  check('a salesperson cannot make keys', (await call('POST', '/crm/wave/api-keys', { label: 'x' }, tk.A)).status === 403);
  const kr = await call('POST', '/crm/wave/api-keys', { label: 'A read', userId: A.id, scope: 'read' }, tk.M);
  const kw = await call('POST', '/crm/wave/api-keys', { label: 'A write', userId: A.id, scope: 'write' }, tk.M);
  check('a Sales manager makes a read key and a write key for salesperson A (shown once)', kr.status === 200 && /^crmk_/.test(kr.body.key) && kw.body.apiKey.scope === 'write', kr.body);
  const krow = await W.one('SELECT "keyHash" FROM "CrmApiKey" WHERE "id" = ?', kr.body.apiKey.id);
  check('only the key\'s SHA-256 is kept', krow.keyHash === crypto.createHash('sha256').update(kr.body.key).digest('hex'));
  check('API switched off: 403', (await call('GET', '/crm-api/v1/me', null, null, key(kr.body.key))).status === 403);
  await call('PUT', '/crm/wave/switches', { apiOn: true }, tk.X);
  const me = await call('GET', '/crm-api/v1/me', null, null, key(kr.body.key));
  check('on: the key acts as A (salesperson, read)', me.status === 200 && me.body.userId === A.id && me.body.role === 'bde' && me.body.scope === 'read', me.body);
  check('no key / a wrong key: 401', (await call('GET', '/crm-api/v1/leads')).status === 401 && (await call('GET', '/crm-api/v1/leads', null, null, key('crmk_wrongwrongwrongwrongwrongwrong'))).status === 401);
  const LB = await mkLead(tk.B);
  const ll = await call('GET', '/crm-api/v1/leads?limit=500', null, null, key(kr.body.key));
  check('A\'s key lists A\'s leads only (scope as on the screen)', ll.status === 200 && ll.body.rows.some((l) => l.id === L1.lead.id) && !ll.body.rows.some((l) => l.id === LB.lead.id), ll.body && ll.body.total);
  check('B\'s lead is not readable with A\'s key', (await call('GET', `/crm-api/v1/leads/${LB.lead.id}`, null, null, key(kr.body.key))).status === 404);
  check('a read key cannot add', (await call('POST', '/crm-api/v1/leads', { company: 'ZZ nope' }, null, key(kr.body.key))).status === 403);
  const al = await call('POST', '/crm-api/v1/leads', { company: `ZZ A API ${process.pid}`, contactName: 'Api', phone: phone(), source: 'Website' }, null, key(kw.body.key));
  check('a write key adds a lead, owned by A', al.status === 200 && al.body.lead.ownerId === A.id, al.body);
  const pl = await call('PATCH', `/crm-api/v1/leads/${al.body.lead.id}`, { city: 'Hyderabad' }, null, key(kw.body.key));
  check('PATCH changes it', pl.status === 200 && pl.body.lead.city === 'Hyderabad', pl.body);
  const since = await call('GET', `/crm-api/v1/leads?since=${encodeURIComponent(al.body.lead.createdAt)}`, null, null, key(kr.body.key));
  check('?since= gives only the new ones (polling trigger)', since.status === 200 && since.body.rows.length >= 1 && since.body.rows.every((r) => r.createdAt >= al.body.lead.createdAt), since.body);
  const act = await call('POST', '/crm-api/v1/activities', { kind: 'call', subject: 'API call', leadId: al.body.lead.id }, null, key(kw.body.key));
  const tsk = await call('POST', '/crm-api/v1/tasks', { title: 'API follow-up', dueDate: ymd(1), leadId: al.body.lead.id }, null, key(kw.body.key));
  check('activities and follow-ups can be added', act.status === 200 && tsk.status === 200, [act.body, tsk.body]);
  const pip = await call('GET', '/crm-api/v1/pipeline', null, null, key(kr.body.key));
  check('/v1/pipeline answers in A\'s scope', pip.status === 200 && Array.isArray(pip.body.open), pip.body);
  const oa = await call('GET', '/crm-api/v1/openapi.json');
  check('the OpenAPI file is published', oa.status === 200 && oa.body.openapi === '3.0.3' && oa.body.paths['/leads'] && oa.body.paths['/hooks'], oa.body && Object.keys(oa.body.paths || {}));
  const kip = await call('POST', '/crm/wave/api-keys', { label: 'ip locked', userId: A.id, ips: '203.0.113.7' }, tk.M);
  check('a key locked to another address is refused here', (await call('GET', '/crm-api/v1/me', null, null, key(kip.body.key))).status === 403);
  await call('DELETE', `/crm/wave/api-keys/${kip.body.apiKey.id}`, null, tk.M);
  check('a revoked key stops at once', (await call('GET', '/crm-api/v1/me', null, null, key(kip.body.key))).status === 401);

  console.log('15.03 Zapier / Make / n8n: REST hooks');
  const km = await call('POST', '/crm/wave/api-keys', { label: 'Zapier', scope: 'write' }, tk.M);
  check('a salesperson\'s key cannot subscribe hooks', (await call('POST', '/crm-api/v1/hooks', { url: `http://127.0.0.1:${MOCK}/zap`, event: 'deal.won' }, null, key(kw.body.key))).status === 403);
  const zs = await call('POST', '/crm-api/v1/hooks', { url: `http://127.0.0.1:${MOCK}/zap`, event: 'deal.won', source: 'zapier' }, null, key(km.body.key));
  check('Zapier subscribes to deal.won (201 + id + secret)', zs.status === 201 && zs.body.id && zs.body.secret, zs.body);
  const D3 = await mkAccDeal(tk.A, 50000);
  await call('POST', `/crm/deals/${D3.id}/stage`, { stage: 'Won' }, tk.A);
  check('the Zap gets the won deal', !!(await until(() => hits('/zap', (g) => g.body && g.body.data.record.id === D3.id)[0])));
  const smp = await call('GET', '/crm-api/v1/samples/deal.won', null, null, key(km.body.key));
  check('a sample payload for the Zap editor', smp.status === 200 && smp.body[0].event === 'deal.won' && smp.body[0].data.record.id, smp.body);
  const hl = await call('GET', '/crm/wave/webhooks', null, tk.M);
  check('the subscription shows in the CRM list as Zapier', hl.body.hooks.some((h) => h.id === zs.body.id && h.source === 'zapier'));
  check('Zapier unsubscribes', (await call('DELETE', `/crm-api/v1/hooks/${zs.body.id}`, null, null, key(km.body.key))).status === 200);
  const D4 = await mkAccDeal(tk.A, 10000);
  await call('POST', `/crm/deals/${D4.id}/stage`, { stage: 'Won' }, tk.A);
  await sleep(700);
  check('after that nothing goes to it', !hits('/zap', (g) => g.body && g.body.data.record.id === D4.id).length);

  console.log('15.12 MCP: CRM tools for outside AI');
  const MK = require('../src/utils/mktb/store');
  await MK.saveSetting('mcp.on', true, 'test');
  const mt = await call('POST', '/crm/wave/mcp/tokens', { label: 'Claude Desktop' }, tk.A);
  check('A makes an MCP token from the CRM screen', mt.status === 201 && /^mcp_/.test(mt.body.token), mt.body);
  const rpc = (method, params, t = mt.body.token) => call('POST', '/mcp', { jsonrpc: '2.0', id: 1, method, params }, t);
  let tl = await rpc('tools/list', {});
  check('"Outside AI reads the CRM" off: no CRM tools', tl.status === 200 && !tl.body.result.tools.some((t) => t.name.startsWith('crm_')), tl.body);
  await call('PUT', '/crm/wave/switches', { mcpCrm: true }, tk.X);
  tl = await rpc('tools/list', {});
  const names = tl.body.result.tools.map((t) => t.name);
  check('on: the CRM read tools are listed, the write tools are not', names.includes('crm_search_leads') && names.includes('crm_pipeline') && !names.includes('crm_log_note'), names);
  const sr = await rpc('tools/call', { name: 'crm_search_leads', arguments: { query: 'ZZ A' } });
  const found = sr.body.result.structuredContent;
  check('crm_search_leads gives A\'s leads, never phone or email', found.leads.some((l) => l.id === L1.lead.id) && !found.leads.some((l) => l.id === LB.lead.id) && found.leads.every((l) => l.phone === undefined && l.email === undefined), found);
  const gr = await rpc('tools/call', { name: 'crm_get_record', arguments: { kind: 'lead', id: LB.lead.id } });
  check('B\'s lead is out of A\'s scope', gr.body.result.isError === true, gr.body);
  const gm = await rpc('tools/call', { name: 'crm_get_record', arguments: { kind: 'lead', id: L1.lead.id } });
  check('A\'s own lead comes without phone or email', !gm.body.result.isError && gm.body.result.structuredContent.record.phone === undefined && gm.body.result.structuredContent.record.company === L1.lead.company, gm.body);
  check('a write tool is unknown while writing is off', (await rpc('tools/call', { name: 'crm_log_note', arguments: { kind: 'lead', id: L1.lead.id, note: 'x' } })).body.error.code === -32602);
  await call('PUT', '/crm/wave/switches', { mcpWrite: true }, tk.X);
  const wn = await rpc('tools/call', { name: 'crm_log_note', arguments: { kind: 'lead', id: L1.lead.id, note: 'From Claude' } });
  check('writing on: a note on A\'s own lead', !wn.body.result.isError && wn.body.result.structuredContent.ok, wn.body);
  const wb = await rpc('tools/call', { name: 'crm_add_follow_up', arguments: { kind: 'lead', id: LB.lead.id, title: 'x', dueDate: ymd(1) } });
  check('not on B\'s lead', wb.body.result.isError === true, wb.body);
  const mv = await call('POST', '/crm/wave/mcp/tokens', { label: 'v' }, tk.V);
  const vtl = await rpc('tools/list', {}, mv.body.token);
  check('a viewer\'s token gets read tools only', vtl.body.result.tools.some((t) => t.name === 'crm_pipeline') && !vtl.body.result.tools.some((t) => t.name === 'crm_log_note'));
  await call('PUT', '/crm/wave/switches', { mcpWrite: false, mcpCrm: false }, tk.X);

  console.log('08.01 / 08.05 the admins\' own rules and field updates');
  const meta = await call('GET', '/crm/automation/meta', null, tk.M);
  check('the builder\'s lists: triggers, fields, actions, templates', meta.status === 200 && meta.body.triggers.length >= 15 && meta.body.actions.length === 11 && meta.body.templates.length >= 5 && meta.body.canScript === false, meta.body && Object.keys(meta.body));
  const bad1 = await call('POST', '/crm/automation/rules', { name: 'x', trigger: 'lead.created', actions: [{ type: 'update_field', field: 'company', value: 'X' }] }, tk.M);
  check('a field a rule may not change is refused', bad1.status === 400 && /cannot change/.test(bad1.body.error), bad1.body);
  check('a Sales manager cannot put a script in a rule', (await call('POST', '/crm/automation/rules', { name: 'x', trigger: 'lead.created', actions: [{ type: 'script', code: 'return null' }] }, tk.M)).status === 400);
  check('a salesperson cannot add a rule', (await call('POST', '/crm/automation/rules', { name: 'x', trigger: 'lead.created', actions: [{ type: 'add_note', text: 'x' }] }, tk.A)).status === 403);
  const graph = { nodes: [{ id: 't', x: 10, y: 10 }, { id: 'a1', x: 10, y: 120 }] };
  const r1 = await call('POST', '/crm/automation/rules', { name: 'Website leads are hot', on: true, trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Website' }], actions: [
    { type: 'update_field', field: 'rating', value: 'Hot' }, { type: 'create_task', title: 'Call {name} today', inDays: 0, taskType: 'Call', priority: 'High', to: 'owner' },
    { type: 'add_note', text: 'Rule says: a website lead' }, { type: 'notify', to: 'managers', title: 'Website lead {name}', text: 'Owner {owner}' },
  ], graph }, tk.M);
  check('a Sales manager saves a rule (with its builder layout)', r1.status === 200 && r1.body.rule.on && r1.body.rule.actions.length === 4 && r1.body.rule.graph.nodes.length === 2, r1.body);
  const W1 = await mkLead(tk.A, { source: 'Website' });
  await sleep(700);
  check('"Rules run by themselves" off: nothing happens', (await call('GET', `/crm/leads/${W1.lead.id}`, null, tk.A)).body.lead.rating == null);
  await call('PUT', '/crm/wave/switches', { rulesOn: true }, tk.X);
  const W2 = await mkLead(tk.A, { source: 'Website' });
  const W2d = await until(async () => { const d = (await call('GET', `/crm/leads/${W2.lead.id}`, null, tk.A)).body; return d.lead.rating === 'Hot' && d.tasks && d.tasks.some((t) => /^Call ZZ A Co/.test(t.title)) ? d : null; });
  check('on: rating set to Hot (field update) and a High follow-up for the owner today', W2d && W2d.tasks.find((t) => /^Call/.test(t.title)).priority === 'High' && W2d.tasks.find((t) => /^Call/.test(t.title)).ownerId === A.id, W2d && W2d.tasks);
  check('the note and the change are on the timeline, by the rule', W2d && W2d.activities.some((a) => a.subject === 'Rule says: a website lead') && W2d.activities.some((a) => /set rating to Hot/.test(a.subject || '')));
  const bell = await until(() => prisma.notification.findFirst({ where: { userId: M.id, title: { contains: W2.lead.company } } }));
  check('the Sales manager got the bell with the record link', bell && /Open: \/crm\/leads\?open=lead:/.test(bell.message), bell);
  const W3 = await mkLead(tk.A, { source: 'Referral' });
  await sleep(700);
  check('a lead that does not match is left alone', (await call('GET', `/crm/leads/${W3.lead.id}`, null, tk.A)).body.lead.rating == null);
  const r2 = await call('POST', '/crm/automation/rules', { name: 'Cold lead city', on: true, trigger: 'lead.updated', conditions: [{ field: 'rating', op: 'changed_to', value: 'Cold' }], actions: [{ type: 'update_field', field: 'city', value: 'Recheck' }] }, tk.M);
  check('a rule on a change ("rating changed to Cold")', r2.status === 200, r2.body);
  await call('PUT', `/crm/leads/${W3.lead.id}`, { rating: 'Cold' }, tk.A);
  check('changed to Cold: the city is set', !!(await until(async () => (await call('GET', `/crm/leads/${W3.lead.id}`, null, tk.A)).body.lead.city === 'Recheck')));
  await sleep(500);
  const runs2 = await call('GET', `/crm/automation/runs?ruleId=${r2.body.rule.id}`, null, tk.M);
  check('the rule\'s own change does not start it again (no loop): one run', runs2.body.runs.length === 1 && runs2.body.runs[0].status === 'done', runs2.body.runs);
  const r3 = await call('POST', '/crm/automation/rules', { name: 'Deal probability up', on: true, trigger: 'deal.updated', conditions: [{ field: 'probability', op: 'changed' }, { field: 'probability', op: 'gte', value: '70' }], actions: [{ type: 'update_field', field: 'nextStep', value: 'Send the contract' }, { type: 'update_field', field: 'expectedClose', value: 'today+7' }] }, tk.M);
  const D5 = await mkAccDeal(tk.A, 300000);
  await call('PUT', `/crm/deals/${D5.id}`, { probability: 75 }, tk.A);
  const d5 = await until(async () => { const d = (await call('GET', `/crm/deals/${D5.id}`, null, tk.A)).body.deal; return d.nextStep === 'Send the contract' ? d : null; });
  check('deal rule: next step and expected close (today + 7) set', r3.status === 200 && d5 && d5.expectedClose === ymd(7), d5);
  check('changed conditions are refused on an "added" rule', (await call('POST', '/crm/automation/rules', { name: 'x', trigger: 'lead.created', conditions: [{ field: 'rating', op: 'changed' }], actions: [{ type: 'add_note', text: 'x' }] }, tk.M)).status === 400);
  const r4 = await call('POST', '/crm/automation/rules', { name: 'Give Website leads to B', on: true, trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Event' }], actions: [{ type: 'assign', to: B.id }] }, tk.M);
  const E1 = await mkLead(tk.M, { source: 'Event' });
  check('assign: the lead goes to B', r4.status === 200 && !!(await until(async () => (await call('GET', `/crm/leads/${E1.lead.id}`, null, tk.M)).body.lead.ownerId === B.id)));

  console.log('08.02 date rules, delays, SLA and escalation');
  const r5 = await call('POST', '/crm/automation/rules', { name: 'Closing in 3 days', on: true, trigger: 'time', time: { kind: 'deal', field: 'expectedClose', days: 3, direction: 'before' }, conditions: [{ field: 'stage', op: 'ne', value: 'Won' }], actions: [{ type: 'notify', to: 'owner', title: 'Closing soon: {name}', text: 'In 3 days' }] }, tk.M);
  const D6 = await mkAccDeal(tk.A, 40000, { expectedClose: ymd(3) });
  const D7 = await mkAccDeal(tk.A, 40000, { expectedClose: ymd(9) });
  const t1 = await call('POST', '/crm/automation/tick', null, tk.M);
  check('the clock runs the date rule', r5.status === 200 && t1.status === 200 && t1.body.dated >= 1, t1.body);
  check('the deal closing in 3 days is told to its owner', !!(await prisma.notification.findFirst({ where: { userId: A.id, title: `Closing soon: ${D6.title}` } })));
  check('the deal closing in 9 days is not', !(await prisma.notification.findFirst({ where: { userId: A.id, title: `Closing soon: ${D7.title}` } })));
  await call('POST', '/crm/automation/tick', null, tk.M);
  check('once per record and date (a second pass does not repeat it)', (await prisma.notification.count({ where: { userId: A.id, title: `Closing soon: ${D6.title}` } })) === 1);
  const r6 = await call('POST', '/crm/automation/rules', { name: 'Quiet deal', on: true, trigger: 'time', time: { kind: 'deal', field: 'lastActivityAt', days: 10, direction: 'after' }, conditions: [], actions: [{ type: 'notify', to: 'managers', title: 'Quiet: {name}', text: 'no activity 10 days' }] }, tk.M);
  const D8 = await mkAccDeal(tk.A, 40000);
  await DB.run('UPDATE "CrmDeal" SET "createdAt" = ? WHERE "id" = ?', new Date(Date.now() - 11 * 86400000).toISOString(), D8.id);
  await call('POST', '/crm/automation/tick', null, tk.M);
  check('"no activity for 10 days" escalates to the managers', r6.status === 200 && !!(await prisma.notification.findFirst({ where: { userId: M.id, title: `Quiet: ${D8.title}` } })));
  const r7 = await call('POST', '/crm/automation/rules', { name: 'SLA: contact a new lead within 30 minutes', on: true, trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Cold call' }], actions: [{ type: 'wait', amount: 30, unit: 'minutes', onlyIf: [{ field: 'stage', op: 'eq', value: 'New' }] }, { type: 'notify', to: 'managers', title: 'SLA missed: {name}', text: 'not contacted in 30 minutes' }] }, tk.M);
  const S1 = await mkLead(tk.A, { source: 'Cold call' });
  const S2 = await mkLead(tk.A, { source: 'Cold call' });
  const waiting = await until(async () => { const r = (await call('GET', `/crm/automation/runs?ruleId=${r7.body.rule.id}`, null, tk.M)).body.runs; return r.filter((x) => x.status === 'waiting').length === 2 ? r : null; });
  check('both leads wait 30 minutes', !!waiting, waiting);
  await call('POST', '/crm/activities', { kind: 'call', subject: 'Reached', leadId: S2.lead.id, outcome: 'Spoke' }, tk.A);
  await W.run('UPDATE "CrmRuleRun" SET "dueAt" = ? WHERE "ruleId" = ?', new Date(Date.now() - 1000).toISOString(), r7.body.rule.id);
  const t2 = await call('POST', '/crm/automation/tick', null, tk.M);
  check('time up: the uncontacted lead is escalated', t2.body.resumed === 2 && !!(await prisma.notification.findFirst({ where: { userId: M.id, title: `SLA missed: ${S1.lead.company}` } })), t2.body);
  const rs = (await call('GET', `/crm/automation/runs?ruleId=${r7.body.rule.id}`, null, tk.M)).body.runs;
  check('the contacted one stops by itself ("only if still New")', rs.find((x) => x.entityId === S2.lead.id).status === 'stopped' && !(await prisma.notification.findFirst({ where: { title: `SLA missed: ${S2.lead.company}` } })), rs);

  console.log('08.08 multi-step approvals');
  const r8 = await call('POST', '/crm/automation/rules', { name: 'Big deal approvals', on: true, trigger: 'deal.created', conditions: [{ field: 'value', op: 'gte', value: '500000' }], actions: [{ type: 'approval', title: 'Big deal {name}', steps: [{ approver: 'managers', label: 'Sales manager' }, { approver: 'admins', label: 'Admin' }], holdWon: true }, { type: 'add_note', text: 'Approved by both' }] }, tk.M);
  const BD = await mkAccDeal(tk.A, 600000);
  const ap = await until(async () => (await call('GET', '/crm/automation/approvals', null, tk.M)).body.approvals.find((x) => x.entityId === BD.id));
  check('a 6 lakh deal waits for a two-step approval', r8.status === 200 && ap && ap.steps.length === 2 && ap.status === 'Pending' && ap.canDecide === true && ap.holdWon, ap);
  check('the manager got a bell for step 1', !!(await prisma.notification.findFirst({ where: { userId: M.id, title: { contains: 'Approval needed: Big deal' } } })));
  const ww = await call('POST', `/crm/deals/${BD.id}/stage`, { stage: 'Won' }, tk.A);
  check('the deal cannot be won while it waits', ww.status === 409 && /must be approved first/.test(ww.body.error), ww.body);
  check('the salesperson cannot decide (and does not see it)', (await call('POST', `/crm/automation/approvals/${ap.id}`, { decision: 'approve' }, tk.A)).status === 403 && !(await call('GET', '/crm/automation/approvals', null, tk.A)).body.approvals.length);
  const s1 = await call('POST', `/crm/automation/approvals/${ap.id}`, { decision: 'approve', note: 'ok from sales' }, tk.M);
  check('step 1 approved by the manager: step 2 waits', s1.status === 200 && s1.body.approval.step === 1 && s1.body.approval.status === 'Pending', s1.body);
  check('the manager cannot do the Admin step', (await call('POST', `/crm/automation/approvals/${ap.id}`, { decision: 'approve' }, tk.M)).status === 403);
  const s2 = await call('POST', `/crm/automation/approvals/${ap.id}`, { decision: 'approve' }, tk.X);
  check('the Admin approves step 2: Approved', s2.status === 200 && s2.body.approval.status === 'Approved', s2.body);
  check('the rule went on after the approval (its next step ran)', !!(await until(async () => (await call('GET', `/crm/deals/${BD.id}`, null, tk.A)).body.activities.some((a) => a.subject === 'Approved by both'))));
  check('now the deal can be won', (await call('POST', `/crm/deals/${BD.id}/stage`, { stage: 'Won' }, tk.A)).status === 200);
  const r9 = await call('POST', '/crm/automation/rules', { name: 'Two managers', on: true, trigger: 'deal.created', conditions: [{ field: 'value', op: 'eq', value: '777777' }], actions: [{ type: 'approval', title: 'Twice {name}', steps: [{ approver: 'managers' }, { approver: 'managers' }] }] }, tk.M);
  const TD = await mkAccDeal(tk.A, 777777);
  const ap2 = await until(async () => (await call('GET', '/crm/automation/approvals', null, tk.X)).body.approvals.find((x) => x.entityId === TD.id && /^Twice/.test(x.title)));
  await call('POST', `/crm/automation/approvals/${ap2.id}`, { decision: 'approve' }, tk.X);
  check('the same person cannot approve two steps', r9.status === 200 && (await call('POST', `/crm/automation/approvals/${ap2.id}`, { decision: 'approve' }, tk.X)).status === 409);
  const rj = await call('POST', `/crm/automation/approvals/${ap2.id}`, { decision: 'reject', note: 'too much' }, tk.M);
  const run9 = (await call('GET', `/crm/automation/runs?ruleId=${r9.body.rule.id}`, null, tk.M)).body.runs[0];
  check('a rejection stops the rule\'s run', rj.status === 200 && rj.body.approval.status === 'Rejected' && run9.status === 'stopped', [rj.body, run9]);

  const r9b = await call('POST', '/crm/automation/rules', { name: 'A approves', on: true, trigger: 'deal.created', conditions: [{ field: 'value', op: 'eq', value: '333333' }], actions: [{ type: 'approval', title: 'A says {name}', steps: [{ approver: A.id }] }] }, tk.M);
  await mkAccDeal(tk.B, 333333);
  const apA = await until(async () => (await call('GET', '/crm/automation/approvals', null, tk.A)).body.approvals.find((x) => /^A says/.test(x.title)));
  check('a salesperson named as the approver sees it (and only theirs) and decides it', r9b.status === 200 && apA && apA.canDecide && (await call('GET', '/crm/automation/approvals', null, tk.A)).body.waitingForMe === 1 && (await call('POST', `/crm/automation/approvals/${apA.id}`, { decision: 'approve' }, tk.A)).body.approval.status === 'Approved', apA);
  check('another salesperson cannot decide it', !(await call('GET', '/crm/automation/approvals', null, tk.B)).body.approvals.some((x) => /^A says/.test(x.title)));

  console.log('08.09 the visual builder: layout kept, try it on a record');
  const tr = await call('POST', `/crm/automation/rules/${r1.body.rule.id}/try`, { recordId: W3.lead.id }, tk.M);
  check('"Try on a record": each condition true / false and what it would do, nothing changed', tr.status === 200 && tr.body.pass === false && tr.body.conditions[0].pass === false && tr.body.conditions[0].now === 'Referral' && tr.body.actions.length === 4, tr.body);
  const tr2 = await call('POST', `/crm/automation/rules/${r1.body.rule.id}/try`, { recordId: W2.lead.id }, tk.M);
  check('on a matching record it passes', tr2.body.pass === true);
  const rl = await call('GET', '/crm/automation/rules', null, tk.M);
  check('the list returns the layout and run counts', rl.body.rules.find((r) => r.id === r1.body.rule.id).graph.nodes.length === 2 && rl.body.rules.find((r) => r.id === r1.body.rule.id).runs >= 1);
  check('a rule is switched off with one call', (await call('PUT', `/crm/automation/rules/${r1.body.rule.id}`, { on: false }, tk.M)).body.rule.on === false);

  console.log('08.12 scripts in a rule (Admin only, own switch, sandboxed)');
  const r10 = await call('POST', '/crm/automation/rules', { name: 'Script: big leads', on: true, trigger: 'lead.created', conditions: [{ field: 'source', op: 'eq', value: 'Email campaign' }], actions: [{ type: 'script', code: "if (Number(record.expectedValue) > 100000) return { set: { rating: 'Hot', industry: 'Big ' + record.company.slice(0, 5) }, note: 'big one', task: { title: 'Call the big one', inDays: 1 } };\nreturn { note: 'small' };" }] }, tk.X);
  check('the Admin saves a script rule', r10.status === 200, r10.body);
  check('a script that does not read right is refused', (await call('POST', '/crm/automation/rules', { name: 'bad', trigger: 'lead.created', actions: [{ type: 'script', code: 'return {' }] }, tk.X)).status === 400);
  const SC1 = await mkLead(tk.A, { source: 'Email campaign', expectedValue: 250000 });
  await sleep(800);
  const sc1run = (await call('GET', `/crm/automation/runs?ruleId=${r10.body.rule.id}`, null, tk.M)).body.runs[0];
  check('scripts switched off: the step is skipped', sc1run && /scripts are switched off/.test(sc1run.log) && (await call('GET', `/crm/leads/${SC1.lead.id}`, null, tk.A)).body.lead.rating == null, sc1run);
  await call('PUT', '/crm/wave/switches', { scriptsOn: true }, tk.X);
  const SC2 = await mkLead(tk.A, { source: 'Email campaign', expectedValue: 250000 });
  const sc2 = await until(async () => { const d = (await call('GET', `/crm/leads/${SC2.lead.id}`, null, tk.A)).body; return d.lead.rating === 'Hot' ? d : null; });
  check('on: the script sets fields, writes a note and adds a follow-up', sc2 && /^Big /.test(sc2.lead.industry) && sc2.activities.some((a) => /big one/.test(a.subject || '')) && sc2.tasks.some((t) => t.title === 'Call the big one' && t.dueDate === ymd(1)), sc2 && [sc2.lead, sc2.tasks]);
  check('a Sales manager may not change a script rule', (await call('PUT', `/crm/automation/rules/${r10.body.rule.id}`, { name: 'mine now' }, tk.M)).status === 403);
  const AUTO = require('../src/crm/automation');
  let esc = null; try { AUTO.runScript('return { p: typeof process, r: typeof require, g: (function(){ return this; })() === undefined };', {}, null, 'x'); esc = AUTO.runScript('return { p: typeof process, r: typeof require };', {}, null, 'x'); } catch (e) { esc = { error: e.message }; }
  check('the script box has no process / require', esc && esc.p === 'undefined' && esc.r === 'undefined', esc);
  let esc2 = null; try { esc2 = AUTO.runScript('return record.constructor.constructor("return typeof process")();', { a: 1 }, null, 'x'); } catch (e) { esc2 = `refused: ${e.message}`; }
  check('the record cannot be used to reach the server', esc2 === 'undefined' || /refused/.test(String(esc2)), esc2);
  let loop = null; try { AUTO.runScript('while (true) {}', {}, null, 'x'); } catch (e) { loop = e.message; }
  check('an endless script is stopped (200 ms)', /timed out/i.test(String(loop)), loop);

  console.log('10.02 report builder');
  const bm = await call('GET', '/crm/builder/meta', null, tk.A);
  check('the builder lists six sources with their fields', bm.status === 200 && bm.body.sources.length === 6 && bm.body.sources.find((s) => s.key === 'deals').fields.some((f) => f.key === 'weighted'), bm.body && bm.body.sources.map((s) => s.key));
  const spec = { source: 'deals', groupBy: 'stage', measure: { fn: 'sum', field: 'value' }, chart: 'bar', filters: [{ field: 'title', op: 'contains', value: 'ZZ A Deal' }] };
  const pvM = await call('POST', '/crm/builder/preview', spec, tk.M);
  const pvA = await call('POST', '/crm/builder/preview', spec, tk.A);
  const wonA = await DB.one('SELECT COALESCE(SUM("value"), 0) AS "v" FROM "CrmDeal" WHERE "stage" = \'Won\' AND "title" LIKE \'ZZ A Deal%\' AND "ownerId" = ?', A.id);
  check('grouped by stage, sum of value: matches the database (A\'s scope)', pvA.status === 200 && pvA.body.grouped && Math.round(pvA.body.rows.find((r) => r.group === 'Won').value) === Math.round(wonA.v), [pvA.body, wonA]);
  const BDeal = await mkAccDeal(tk.B, 12345);
  const pvB = await call('POST', '/crm/builder/preview', { source: 'deals', columns: ['title', 'value', 'ownerName'], filters: [{ field: 'value', op: 'eq', value: '12345' }] }, tk.A);
  check('a salesperson\'s report never shows another\'s deals', pvB.status === 200 && pvB.body.rows.length === 0 && (await call('POST', '/crm/builder/preview', { source: 'deals', columns: ['title'], filters: [{ field: 'value', op: 'eq', value: '12345' }] }, tk.M)).body.rows.some((r) => r.title === BDeal.title), pvB.body);
  check('the manager sees more', pvM.body.rows.length >= pvA.body.rows.length);
  const lm = await call('POST', '/crm/builder/preview', { source: 'leads', groupBy: 'createdAt', groupDate: 'month', chart: 'line', dateField: 'createdAt', period: 'this_month' }, tk.M);
  check('leads by month this month (line chart)', lm.status === 200 && lm.body.rows.length === 1 && lm.body.rows[0].group === ymd(0).slice(0, 7), lm.body);
  check('a bad spec is refused', (await call('POST', '/crm/builder/preview', { source: 'salaries' }, tk.M)).status === 400 && (await call('POST', '/crm/builder/preview', { source: 'deals', groupBy: 'stage', measure: { fn: 'sum' } }, tk.M)).status === 400);
  check('a salesperson cannot share a report with the team', (await call('POST', '/crm/builder/reports', { name: 'mine', spec, shared: true }, tk.A)).status === 403);
  const rep = await call('POST', '/crm/builder/reports', { name: 'Pipeline by stage', spec, shared: true }, tk.M);
  check('the manager saves and shares it', rep.status === 200 && rep.body.report.shared, rep.body);
  const runA = await call('GET', `/crm/builder/reports/${rep.body.report.id}/run`, null, tk.A);
  check('A opens the shared report and sees A\'s numbers only', runA.status === 200 && JSON.stringify(runA.body.rows) === JSON.stringify(pvA.body.rows), [runA.body.rows, pvA.body.rows]);
  check('A cannot delete it', (await call('DELETE', `/crm/builder/reports/${rep.body.report.id}`, null, tk.A)).status === 404);
  check('Excel needs the export right', (await call('GET', `/crm/builder/reports/${rep.body.report.id}/xlsx`, null, tk.A)).status === 403);
  const xl = await call('GET', `/crm/builder/reports/${rep.body.report.id}/xlsx`, null, tk.M, { binary: true });
  check('the manager downloads it as Excel (and it is in the download log)', xl.status === 200 && xl.buf.slice(0, 2).toString() === 'PK' && (await call('GET', '/crm/export-log', null, tk.M)).body.rows.some((x) => /Built report: Pipeline by stage/.test(x.what)), xl.status);
  const own1 = await call('POST', '/crm/builder/reports', { name: 'My follow-ups', spec: { source: 'tasks', columns: ['title', 'dueDate', 'status'], filters: [{ field: 'status', op: 'eq', value: 'Open' }] } }, tk.A);
  check('A saves a private report; B does not see it', own1.status === 200 && !(await call('GET', '/crm/builder/reports', null, tk.B)).body.reports.some((r) => r.id === own1.body.report.id));

  console.log('10.03 my dashboard');
  const md0 = await call('GET', '/crm/my-dashboard', null, tk.A);
  check('a person starts with the four ready numbers', md0.status === 200 && md0.body.widgets.length === 4 && md0.body.from === 'default', md0.body);
  const mdp = await call('PUT', '/crm/my-dashboard', { widgets: [{ type: 'report', reportId: rep.body.report.id, size: 'full', chart: 'pie' }, { type: 'kpi', key: 'followupsDue', size: 'small' }] }, tk.A);
  const md1 = await call('GET', '/crm/my-dashboard', null, tk.A);
  check('A puts the shared report (as a pie) and one number on it', mdp.status === 200 && md1.body.from === 'mine' && md1.body.widgets[0].data.chart === 'pie' && md1.body.widgets[0].data.rows.length && md1.body.widgets[1].data.value >= 1, md1.body);
  check('B cannot put A\'s private report on B\'s dashboard', (await call('PUT', '/crm/my-dashboard', { widgets: [{ type: 'report', reportId: own1.body.report.id }] }, tk.B)).status === 400);
  check('a salesperson cannot set the team dashboard', (await call('PUT', '/crm/my-dashboard', { team: true, widgets: [] }, tk.A)).status === 403);
  await call('PUT', '/crm/my-dashboard', { team: true, widgets: [{ type: 'kpi', key: 'toCollect', size: 'half' }, { type: 'report', reportId: rep.body.report.id, size: 'half' }] }, tk.M);
  const mdB = await call('GET', '/crm/my-dashboard', null, tk.B);
  check('B (no own layout) gets the team default', mdB.body.from === 'team' && mdB.body.widgets[0].key === 'toCollect', mdB.body);
  await call('PUT', '/crm/my-dashboard', { reset: true }, tk.A);
  check('A resets to the team default', (await call('GET', '/crm/my-dashboard', null, tk.A)).body.from === 'team');

  console.log('10.05 leaderboard');
  const lb = await call('GET', '/crm/leaderboard?period=month', null, tk.M);
  const la = lb.body.rows.find((r) => r.id === A.id);
  check('the manager sees the whole board with points and ranks', lb.status === 200 && la && lb.body.rows.length >= 3 && la.rank === 1 && la.points > 0, lb.body.rows);
  const wonN = await DB.one('SELECT COUNT(*) AS "n", COALESCE(SUM(COALESCE("finalValue", "value")), 0) AS "v" FROM "CrmDeal" WHERE "ownerId" = ? AND "stage" = \'Won\'', A.id);
  check('A\'s won deals and value are counted', la.wonDeals === Number(wonN.n) && Math.round(la.wonValue) === Math.round(wonN.v), [la, wonN]);
  check('badges: Top closer and First win for A', la.badges.some((b) => b.key === 'closer') && la.badges.some((b) => b.key === 'first'), la.badges);
  const lbA = await call('GET', '/crm/leaderboard?period=month', null, tk.A);
  check('a salesperson sees only their own line and rank', lbA.body.rows.length === 1 && lbA.body.rows[0].id === A.id && lbA.body.me.rank === 1 && lbA.body.full === false, lbA.body);
  await call('PUT', '/crm/wave/switches', { repsSeeBoard: true }, tk.X);
  const lbB = await call('GET', '/crm/leaderboard?period=month', null, tk.B);
  const aFromB = lbB.body.rows.find((r) => r.id === A.id);
  check('switch on: B sees names, points and badges, never A\'s money', aFromB && aFromB.points === la.points && aFromB.wonValue === undefined && aFromB.hidden, aFromB);

  console.log('10.08 scheduled reports');
  const em = await call('PUT', '/admin/integrations/email/configure', { values: { 'SMTP host': 'smtp.zz-test.invalid', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'Password / app key': 'zz-pass', 'From address': 'crm@zz-test.invalid', 'Default from name': 'TeamLink' } }, tk.X);
  check('setup: the company mailbox is connected (the sandbox never sends)', em.status === 200, em.body);
  check('a salesperson without the reports right cannot schedule', (await call('POST', '/crm/builder/schedules', { reportId: own1.body.report.id, frequency: 'daily', time: '09:00', recipients: [A.id] }, tk.A)).status === 403);
  check('only people on the CRM team can get it', (await call('POST', '/crm/builder/schedules', { reportId: rep.body.report.id, frequency: 'weekly', day: 1, time: '09:00', recipients: [N.id] }, tk.M)).status === 400);
  const sc = await call('POST', '/crm/builder/schedules', { reportId: rep.body.report.id, frequency: 'weekly', day: 1, time: '09:00', recipients: [M.id, A.id] }, tk.M);
  check('weekly on Monday 09:00 to the manager and A; the next time is a Monday 09:00 India time', sc.status === 200 && new Date(Date.parse(sc.body.schedule.nextAt) + 5.5 * 3600000).getUTCDay() === 1 && new Date(Date.parse(sc.body.schedule.nextAt) + 5.5 * 3600000).toISOString().slice(11, 16) === '09:00', sc.body);
  await W.run('UPDATE "CrmReportSchedule" SET "nextAt" = ? WHERE "id" = ?', new Date(Date.now() - 60000).toISOString(), sc.body.schedule.id);
  const before = mails().length;
  await call('POST', '/crm/automation/tick', null, tk.M);
  check('switch off: it is not mailed by itself', mails().length === before);
  await call('PUT', '/crm/wave/switches', { schedulesOn: true }, tk.X);
  const tk3 = await call('POST', '/crm/automation/tick', null, tk.M);
  const got2 = await until(() => { const m = mails().slice(before).filter((x) => /CRM report: Pipeline by stage/.test(x.subject)); return m.length >= 2 ? m : null; });
  check('on: mailed to both, the table in the mail and the Excel attached', tk3.body.mailed === 1 && got2 && got2.every((m) => /<table/.test(m.html) && m.attachments[0].filename.endsWith('.xlsx') && m.attachments[0].size > 0), got2 || mails().slice(before));
  const scRow = await W.one('SELECT * FROM "CrmReportSchedule" WHERE "id" = ?', sc.body.schedule.id);
  check('it moved to the next Monday and says what happened', Date.parse(scRow.nextAt) > Date.now() && /Sent to 2 of 2/.test(scRow.lastResult), scRow);
  const b2 = mails().length;
  const sn = await call('POST', `/crm/builder/schedules/${sc.body.schedule.id}/send-now`, null, tk.M);
  check('"Send me a copy now" mails only the person pressing it', sn.status === 200 && !!(await until(() => mails().slice(b2).length === 1)) && mails().slice(b2)[0].to.includes(M.email), mails().slice(b2));

  console.log('10.13 trends, snapshots, cohorts');
  const tdeal = await mkAccDeal(tk.A, 70000);
  await call('POST', `/crm/deals/${tdeal.id}/stage`, { stage: 'Negotiation' }, tk.A);
  await DB.run('UPDATE "CrmDeal" SET "createdAt" = ? WHERE "id" = ?', new Date(Date.now() - 20 * 86400000).toISOString(), tdeal.id);
  await DB.run('UPDATE "CrmActivity" SET "at" = ? WHERE "dealId" = ? AND "subject" LIKE \'Stage:%\'', new Date(Date.now() - 10 * 86400000).toISOString(), tdeal.id);
  const trn = await call('GET', `/crm/trends?weeks=4&owner=${A.id}`, null, tk.M);
  const ser = trn.body.series;
  const stageAt = (s) => (s.stages.find((x) => x.stage === 'Negotiation') || { count: 0 }).count;
  const pros = (s) => (s.stages.find((x) => x.stage === 'Prospecting') || { count: 0 }).count;
  check('the trend has 4 weekly points, today from a snapshot', trn.status === 200 && ser.length === 4 && ser[3].source === 'snapshot' && ser[0].source === 'rebuilt', ser && ser.map((s) => [s.day, s.source]));
  check('rebuilt history: the deal was Prospecting 14 days ago and Negotiation now', pros(ser[1]) >= 1 && stageAt(ser[3]) >= 1 && stageAt(ser[1]) === 0, ser.map((s) => [s.day, s.stages]));
  const snapN = await W.one('SELECT COUNT(*) AS "n" FROM "CrmPipelineSnapshot" WHERE "day" = ?', ymd(0));
  check('today\'s snapshot is written once', Number(snapN.n) >= 1 && (await call('POST', '/crm/trends/snapshot', null, tk.M)).body.taken === false);
  check('a salesperson cannot take snapshots', (await call('POST', '/crm/trends/snapshot', null, tk.A)).status === 403);
  const trA = await call('GET', '/crm/trends?weeks=4', null, tk.A);
  check('a salesperson\'s trend is their own', trA.status === 200 && trA.body.scope === 'owner');
  const co = await call('GET', '/crm/cohorts?months=3', null, tk.M);
  const thisM = co.body.leads.find((x) => x.month === ymd(0).slice(0, 7));
  const leadsNow = await DB.one('SELECT COUNT(*) AS "n" FROM "CrmLead" WHERE substr(date(datetime("createdAt", \'+330 minutes\')), 1, 7) = ?', ymd(0).slice(0, 7));
  check('lead cohorts: this month\'s count matches the database', co.status === 200 && co.body.leads.length === 3 && thisM.leads === Number(leadsNow.n), [thisM, leadsNow]);
  check('deal cohorts: won within 30 / 60 / 90 days', co.body.deals.length === 3 && co.body.deals.some((d) => d.won30 >= 1), co.body.deals);

  console.log('15.04 / 15.05 calendar feed and contacts for Google / Outlook');
  const fd = await call('GET', '/crm/wave/calendar-feed', null, tk.A);
  check('A gets a private feed link', fd.status === 200 && /\/api\/crm-api\/calendar\/.+\.ics$/.test(fd.body.path), fd.body);
  const icsPath = fd.body.path.replace('/api', '');
  check('feed switched off: 403', (await call('GET', icsPath)).status === 403);
  await call('PUT', '/crm/wave/switches', { calendarFeed: true }, tk.X);
  const ics = await call('GET', icsPath);
  check('on: an iCalendar file with A\'s open follow-ups', ics.status === 200 && /BEGIN:VCALENDAR/.test(ics.text) && /SUMMARY:Call: Call ZZ A Co/.test(ics.text), ics.text && ics.text.slice(0, 300));
  check('a wrong link: 404', (await call('GET', `/crm-api/calendar/${A.id}.WRONGWRONGWRONGWRONGWRONGWRONGWR.ics`)).status === 404);
  check('vCard: a salesperson without the export right cannot download', (await call('GET', '/crm/wave/contacts.vcf', null, tk.A)).status === 403);
  const acc9 = (await call('POST', '/crm/accounts', { name: `ZZ A Vcard ${process.pid}`, force: true }, tk.M)).body.account;
  await call('POST', '/crm/contacts', { accountId: acc9.id, name: 'Ravi Kumar', designation: 'HR head', phone: phone(), email: 'ravi@example.test' }, tk.M);
  const vc = await call('GET', '/crm/wave/contacts.vcf', null, tk.M);
  check('the manager downloads the contacts as vCard', vc.status === 200 && /BEGIN:VCARD/.test(vc.text) && /FN:Ravi Kumar/.test(vc.text) && new RegExp(`ORG:ZZ A Vcard ${process.pid}`).test(vc.text), vc.text && vc.text.slice(0, 300));

  console.log("15.07 a proposal signed with Aadhaar eSign (eMudhra; the account is the founder's own - here a stub key, nothing reaches eMudhra)");
  const pd = await mkAccDeal(tk.A, 90000);
  const pr = (await call('POST', `/crm/deals/${pd.id}/proposals`, { roles: [{ title: 'Java developer', openings: 2, ctc: 600000 }], feePercent: 8.33, company: 'ZZ A eSign Co', toName: 'Ravi', toEmail: 'ravi@example.test', fromName: 'Vasu' }, tk.A)).body.proposal;
  await prisma.$executeRawUnsafe(`UPDATE "CrmProposal" SET "status" = 'Sent', "sentAt" = ?, "sentTo" = ? WHERE "id" = ?`, new Date().toISOString(), 'ravi@example.test', pr.id);
  const ptBody = `${pr.id}.${Math.floor(Date.now() / 1000) + 86400}`;
  const ptok = `${Buffer.from(ptBody).toString('base64url')}.${crypto.createHmac('sha256', env.JWT_SECRET).update(`crm-proposal-link:${ptBody}`).digest('base64url').slice(0, 24)}`;
  const pg0 = await fetch(`http://localhost:${PORT}/api/crm-public/proposal/${ptok}`).then((r) => r.text());
  check('eMudhra not set up: the page has Accept / Decline only', /value="accept"/.test(pg0) && !/Aadhaar eSign/.test(pg0), pg0.slice(0, 300));
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const es = await call('PUT', '/admin/integrations/esign/configure', { values: { Environment: 'Sandbox', 'Gateway URL': 'https://testgateway.emsigner.com/eMsecure/V3_0/Index', 'Status / download API base URL': 'https://testgateway.emsigner.com/api', 'Auth token': 'zz-stub-token', 'eMudhra public certificate (PEM)': publicKey.export({ type: 'spki', format: 'pem' }), 'POST field names (Parameter 1,2,3)': 'Parameter1,Parameter2,Parameter3' } }, tk.X);
  check('setup: a stub eMudhra connection', es.status === 200, es.body);
  const pg1 = await fetch(`http://localhost:${PORT}/api/crm-public/proposal/${ptok}`).then((r) => r.text());
  check('set up: the page offers "Accept and sign with Aadhaar eSign"', /Accept and sign with Aadhaar eSign/.test(pg1) && new RegExp(`/proposal/${ptok.replace(/[.]/g, '\.')}/esign`).test(pg1));
  const gw = await fetch(`http://localhost:${PORT}/api/crm-public/proposal/${ptok}/esign`, { method: 'POST' }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const ref = (await prisma.appSetting.findFirst({ where: { key: { startsWith: 'emudhraSession:' }, value: { contains: pr.id } } }) || {}).key;
  check('the button builds the encrypted gateway form (posted by the browser to eMudhra)', gw.status === 200 && /action="https:\/\/testgateway\.emsigner\.com/.test(gw.text) && /name="Parameter1"/.test(gw.text) && /name="Parameter3"/.test(gw.text) && !!ref, gw.text.slice(0, 300));
  const r0 = ref.replace('emudhraSession:', '');
  const fake = await fetch(`http://localhost:${PORT}/api/crm-public/proposal-esign/return/${r0}/success`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'ReturnStatus=Success&Transactionnumber=TXN12345' }).then(async (r) => ({ status: r.status, text: await r.text() }));
  const prAfter = await DB.one('SELECT "status" FROM "CrmProposal" WHERE "id" = ?', pr.id);
  check('a posted "Success" is never trusted: eMudhra is asked, cannot confirm, nothing changes', fake.status === 200 && /could not be confirmed with eMudhra/.test(fake.text) && prAfter.status === 'Sent', [fake, prAfter]);
  check('the same reply again is refused (session closed)', (await fetch(`http://localhost:${PORT}/api/crm-public/proposal-esign/return/${r0}/success`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'ReturnStatus=Success&Transactionnumber=TXN12345' })).status === 409);
  check('an unknown reply is refused', (await fetch(`http://localhost:${PORT}/api/crm-public/proposal-esign/return/TLNOPE123/success`, { method: 'POST' })).status === 400);
  const ESN = require('../src/crm/esign');
  check('the connector reads its set-up from Administration > Integrations', (await ESN.available()) === true);

  console.log('15.08 apps catalogue');
  const apps = await call('GET', '/crm/wave/apps', null, tk.M);
  const st = (k) => (apps.body.apps.find((a) => a.key === k) || {}).status;
  check('the apps say what is on: webhooks, API, Slack, Teams on', apps.status === 200 && st('webhooks') === 'On' && st('api') === 'On' && st('slack') === 'On' && st('teams') === 'On', apps.body && apps.body.apps.map((a) => [a.key, a.status]));
  check('accounting waits for the founder; Exotel needs an account', st('tally') === 'Needs founder decision' && st('exotel') === 'Needs an account');
  check('a salesperson cannot open the catalogue', (await call('GET', '/crm/wave/apps', null, tk.A)).status === 403);

  console.log('cleanup: removing a rule withdraws what waits');
  const rr = await call('DELETE', `/crm/automation/rules/${r7.body.rule.id}`, null, tk.M);
  check('a rule is removed', rr.status === 200 && !(await call('GET', '/crm/automation/rules', null, tk.M)).body.rules.some((r) => r.id === r7.body.rule.id));
  check('a Sales manager cannot remove the Admin\'s script rule', (await call('DELETE', `/crm/automation/rules/${r10.body.rule.id}`, null, tk.M)).status === 403);
  const aud = await prisma.auditLog.count({ where: { action: { in: ['CRM rule added', 'CRM webhook added', 'CRM API key made', 'CRM automation switches changed', 'CRM approval step approved'] } } }).catch(() => -1);
  check('the set-up is audited', aud >= 5, aud);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
