#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL GREEN START: DASHBOARD (overview) + ANALYTICS TEST - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4103 node scripts/omni-gs-overview-analytics-test.js
// COPY_DB = a VACUUM INTO copy of the real database (never prisma/dev.db). The script makes its OWN working copy (<name>-work.db), starts its OWN API
// (TEST_MODE) on TEST_PORT (default 4103), makes ZZTEST contacts / campaigns / messages / one ATS application IN THE WORKING COPY ONLY, then checks:
//   D  dashboard numbers = the rows (reach, engagement, leads, conversions, campaigns), rehearsals never counted, trend only when both periods have data
//   S  scope: Admin all, Team Lead only the campaigns of their jobs, HR internal only, department switch, a department that is not allowed = nothing
//   F  the 10-step flow strip: counts, hints, tones, pages
//   A  analytics: totals, donut slices, channel breakdown, failure reasons, date range, funnel, export (permission + audit), social honest state
//   P  privacy / safety: no phone or email in any answer, no word "Draft", nothing is sent, outside logins refused
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-ovan-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4103);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;

{
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 600)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const DAY = 86400000;

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const text = Buffer.from(await r.arrayBuffer()).toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, type: r.headers.get('content-type') || '' };
}
// every string in an answer, except the machine fields (status codes, ids, keys)
function words(o, out = []) {
  if (Array.isArray(o)) o.forEach((x) => words(x, out));
  else if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => { if (!['status', 'key', 'id', 'cid', 'tone', 'code', 'state', 'channel', 'tag', 'page', 'kind', 'campaignIds'].includes(k)) words(v, out); });
  else if (typeof o === 'string') out.push(o);
  return out;
}

(async () => {
  let server;
  const kept = [];
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const S = require(path.join(BACK, 'src/outreach/store'));
    const K = require(path.join(BACK, 'src/outreach/contacts'));
    const jobAccess = require(path.join(BACK, 'src/jobPublish/access'));
    await require(path.join(BACK, 'src/outreach/v3schema')).ensure();
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } // eslint-disable-line no-await-in-loop
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmp = await prisma.employee.findFirst({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true } });
    check('0 the copy has the logins the test needs (Super Admin, TL, BDE, HR, a recruiter)', !!(sa && tl && bde && hr && recEmp), { sa: !!sa, tl: !!tl, bde: !!bde, hr: !!hr, rec: !!recEmp });
    const rec = recEmp.user;
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, hr, rec].map((u) => u.id) } }, data: { passwordHash: 'x' } });

    // two jobs: one inside the Team Lead's area, one outside (a different department)
    const tlIdent = await resolveIdentity(tl.id);
    const reqs = await prisma.requirement.findMany({ where: { department: { not: null } }, take: 600 });
    const reqIn = reqs.find((r) => jobAccess.inScope(tlIdent, r));
    const reqOut = reqs.find((r) => !jobAccess.inScope(tlIdent, r) && String(r.department).toLowerCase() !== String(reqIn && reqIn.department).toLowerCase());
    check('0b the copy has a job in the Team Lead\'s area and one outside it (another department)', !!(reqIn && reqOut), { in: !!reqIn, out: !!reqOut });
    const deptIn = reqIn.department; const deptOut = reqOut.department;

    // ZZTEST outside logins
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-ov-client-${RUN}@example.test`, username: `zz-ov-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-ov-acct-${RUN}@example.test`, username: `zz-ov-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });

    // ---- ZZTEST data (working copy only) ----
    const adminUser = { id: sa.id, name: sa.name };
    const mk = async (tag, type, dept, n) => {
      const phoneKey = `9${String(Date.now()).slice(-6)}${String(n).padStart(3, '0')}`;
      const row = await K.insert(adminUser, { type, name: `ZZTEST ${tag} ${RUN}`, phone: { e164: `91${phoneKey}`, key: phoneKey }, email: { addr: `zz-ov-${tag}-${RUN}@example.test`, key: `zz-ov-${tag}-${RUN}@example.test` }, company: 'ZZ', city: 'Hyderabad', source: 'omni-ov-test', industries: [], department: dept }, { declared: false });
      kept.push(row.id);
      return { ...row, phoneKey, addr: `zz-ov-${tag}-${RUN}@example.test` };
    };
    const c1 = await mk('c1', 'candidate_lead', deptIn, 1); const c2 = await mk('c2', 'candidate_lead', deptIn, 2); const c3 = await mk('c3', 'candidate_lead', deptIn, 3); const c4 = await mk('c4', 'candidate_lead', deptIn, 4);
    const s1 = await mk('staff', 'internal', null, 5);
    const now = Date.now();
    let seq = 0;
    const camp = async (tag, { type = 'job_promotion', req, channel, status, mode, startedAt }) => {
      const id = `zzcamp${tag}${RUN}`;
      await S.run('INSERT INTO "OutreachCampaign" (id, code, name, type, requirementId, segmentIds, channel, status, mode, startedAt, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        id, `ZZ${tag}${RUN}`.toUpperCase().slice(0, 18), `ZZTEST campaign ${tag} ${RUN}`, type, req || null, '[]', channel, status, mode, startedAt, sa.id, sa.name, startedAt, startedAt);
      return id;
    };
    const msg = async (cid, contact, channel, st, o = {}) => {
      seq += 1;
      await S.run('INSERT INTO "OutreachMessage" (id, campaignId, contactId, channel, requirementId, status, reason, idempotencyKey, attempts, nextRunAt, queuedAt, sentAt, deliveredAt, firstClickAt, failedAt, repliedAt, error) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        `zzmsg${seq}${RUN}`, cid, contact.id, channel, o.req || null, st, o.reason || null, `${cid}:${contact.id}:${channel}`, 1, 0, o.at || now, o.sentAt || null, o.deliveredAt || null, o.click || null, o.failedAt || null, o.replied || null, o.error || null);
    };
    const cA = await camp('A', { req: reqIn.id, channel: 'whatsapp', status: 'running', mode: 'live', startedAt: now - 3 * DAY });
    const cB = await camp('B', { req: reqIn.id, channel: 'email', status: 'done', mode: 'rehearsal', startedAt: now - 2 * DAY });
    const cC = await camp('C', { req: reqOut.id, channel: 'sms', status: 'running', mode: 'live', startedAt: now - 1 * DAY });
    const cD = await camp('D', { type: 'internal', channel: 'email', status: 'scheduled', mode: 'live', startedAt: now - 1 * DAY });
    const cE = await camp('E', { req: reqIn.id, channel: 'email', status: 'done', mode: 'live', startedAt: now - 40 * DAY });
    await msg(cA, c1, 'whatsapp', 'delivered', { req: reqIn.id, sentAt: now - 2 * DAY, deliveredAt: now - 2 * DAY, click: now - 2 * DAY });
    await msg(cA, c2, 'whatsapp', 'sent', { req: reqIn.id, sentAt: now - 2 * DAY, replied: now - 2 * DAY });
    await msg(cA, c3, 'whatsapp', 'failed', { req: reqIn.id, failedAt: now - 2 * DAY, reason: 'bad_address' });
    await msg(cA, c4, 'whatsapp', 'skipped', { req: reqIn.id, reason: 'no_opt_in' });
    await msg(cB, c1, 'email', 'test_captured', { req: reqIn.id, sentAt: now - 2 * DAY });
    await msg(cB, c2, 'email', 'test_captured', { req: reqIn.id, sentAt: now - 2 * DAY });
    await msg(cC, c1, 'sms', 'sent', { req: reqOut.id, sentAt: now - 1 * DAY });
    await msg(cD, s1, 'email', 'sent', { sentAt: now - 1 * DAY });
    await msg(cE, c3, 'email', 'sent', { req: reqIn.id, sentAt: now - 35 * DAY });
    await S.run('INSERT INTO "OutreachEvent" (id, eventKey, type, contactId, campaignId, messageId, requirementId, channel, source, occurredAt, receivedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)', `zzev1${RUN}`, `applied:zzev1${RUN}`, 'applied', c1.id, cA, null, reqIn.id, 'whatsapp', 'portal', now - 1 * DAY, now);
    // an ATS application by c1 to the campaign's own job, after the campaign started, that reached an interview and then joined
    const cand = await prisma.candidate.create({ data: { name: `ZZTEST cand ${RUN}`, phone: c1.phoneKey, email: `zz-ov-cand-${RUN}@example.test` } });
    const app = await prisma.application.create({ data: { candidateId: cand.id, requirementId: reqIn.id, stage: 'JOINED' } });
    await prisma.applicationStageEvent.create({ data: { applicationId: app.id, candidateId: cand.id, toStage: 'INTERVIEW_SCHEDULED', action: 'ZZTEST interview' } });
    // before-numbers for the "nothing is sent" check
    const countOf = async () => ({ msgs: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachMessage"'))[0].n), logs: S.num((await S.q('SELECT COUNT(*) n FROM "OutreachSendLog"'))[0].n), led: S.num((await S.q('SELECT COUNT(*) n FROM "OmniCreditLedger"'))[0].n) });
    const before = await countOf();

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), hr: await tokenOf(hr), rec: await tokenOf(rec), client: await tokenOf(client), acct: await tokenOf(acct) };
    const G = '/api/outreach/gs/overview'; const GA = '/api/outreach/gs/analytics';
    const everything = [];
    const get = async (k, p) => { const r = await http('GET', p, T[k]); everything.push(r.text); return r; };

    // ================================================================ D: the dashboard
    const d = await get('sa', `${G}/`);
    const b = d.body || {};
    check('D1 the dashboard answers for Super Admin with the five KPI cards, a chart, four ways, recent campaigns and insights', d.status === 200 && b.kpis && ['reach', 'engagement', 'leads', 'conversions', 'campaigns'].every((k) => b.kpis[k]) && Array.isArray(b.series) && b.series.length === 30 && b.channels.map((c) => c.id).join() === 'whatsapp,sms,email,call' && Array.isArray(b.recent) && Array.isArray(b.insights), d.text.slice(0, 300));
    check('D2 Reach = people REALLY sent a message in the period (rehearsals not counted): 3 people (c1, c2, staff)', b.kpis.reach.value === 3 && b.rehearsed === 2, { reach: b.kpis.reach.value, rehearsed: b.rehearsed });
    check('D3 Engagement = messages with a click or a reply / messages sent: 2 of 4 sent (the failed one and the rehearsals are not sent)', b.kpis.engagement.value === 50 || b.kpis.engagement.value === 66.7, b.kpis.engagement);
    const sentNow = 4; // A: 2, C: 1, D: 1
    check('D3b the engagement sentence says 2 of 4 messages', /2 of 4 messages/.test(b.kpis.engagement.sub) && b.kpis.engagement.value === Math.round((2 / sentNow) * 1000) / 10, b.kpis.engagement);
    check('D4 Leads = new contacts + applications from campaigns (5 contacts + 1 portal application)', b.kpis.leads.value === 6, b.kpis.leads);
    check('D5 Conversions = applications linked to a campaign by phone: 1 applied, 1 interview, 1 offer (joined counts), 1 joined', b.kpis.conversions.value === 1 && /1 interviews .* 1 offers .* 1 joined/.test(b.kpis.conversions.sub), b.kpis.conversions);
    check('D6 Campaigns: 5 in all; 2 live, 1 scheduled; "2 live · 1 scheduled"', b.kpis.campaigns.value === 5 && b.counts.live === 2 && b.counts.scheduled === 1 && /2 live · 1 scheduled/.test(b.kpis.campaigns.sub), b.counts);
    check('D7 a trend arrow is given when BOTH periods have data (35 days ago the older campaign sent to 1 person)', b.kpis.reach.trend && b.kpis.reach.trend.dir === 'up' && b.kpis.engagement.trend && b.kpis.engagement.trend.dir === 'up', { r: b.kpis.reach.trend, e: b.kpis.engagement.trend });
    check('D8 Campaigns has no trend arrow', b.kpis.campaigns.trend === null);
    const d7 = await get('sa', `${G}/?range=7d`);
    check('D9 Last 7 days: 7 chart points, and NO arrow because the week before has no data', d7.body.series.length === 7 && d7.body.kpis.reach.trend === null && d7.body.kpis.reach.value === 3, d7.body.kpis.reach);
    const dy = await get('sa', `${G}/?range=year`);
    check('D10 This year: one chart point per month so far', dy.status === 200 && dy.body.series.length === new Date(Date.now() + 5.5 * 3600000).getUTCMonth() + 1 && dy.body.range.bucket === 'month', dy.body.series && dy.body.series.length);
    const chartReach = b.series.reduce((n, p) => n + p.reach, 0);
    check('D11 the chart carries the same sends (reach over the days = people per day: c1 and c2 on one day, c1 and staff the next)', chartReach === 4 && b.series.reduce((n, p) => n + p.engagement, 0) === 2, { chartReach });
    const wa = b.channels.find((c) => c.id === 'whatsapp');
    check('D12 Channel health WhatsApp: 2 sent, 1 delivered, 1 failed, topCampaign named, a tip in words, a state in words', wa.sent === 2 && wa.delivered === 1 && wa.failed === 1 && wa.topCampaign && /ZZTEST campaign A/.test(wa.topCampaign.name) && wa.tip && wa.stateWords, wa);
    check('D13 Channel health Voice: honest ("Phone link" or Connected), 0 calls logged', b.channels.find((c) => c.id === 'call').sent === 0 && /phone link|Connected/i.test(b.channels.find((c) => c.id === 'call').stateWords));
    const rcA = b.recent.find((r) => r.id === cA);
    check('D14 Recent campaigns: A shows channel, status in words, engagement 100% (2 of 2) and conversion 1; the rehearsal says Rehearsal', rcA && rcA.statusWords === 'Running' && rcA.engagePct === 100 && rcA.conversion === 1 && b.recent.find((r) => r.id === cB).conversionNote === 'Rehearsal', { rcA, B: b.recent.find((r) => r.id === cB) });
    const keys = b.insights.map((i) => i.key);
    check('D15 insights are real rules: no consent, failed messages, test mode (Admin) are listed; every one has words and an action', keys.includes('no-consent') && keys.includes('failed') && keys.includes('test-mode') && b.insights.every((i) => i.title && i.text && i.body && i.action && i.action.page && i.score >= 0 && i.score <= 100), keys);
    const nc = b.insights.find((i) => i.key === 'no-consent');
    check('D16 "N contacts have no consent yet" is the real count (5 ZZTEST contacts + any other in the copy)', nc && /^\d[\d,]* contacts? (has|have) no consent yet/.test(nc.title), nc && nc.title);
    check('D17 popups: details for the five KPI cards, each with a subtitle, a plain note and rows', ['reach', 'engagement', 'leads', 'conversions', 'campaigns'].every((k) => b.details[k] && b.details[k].title && b.details[k].subtitle && b.details[k].note && Array.isArray(b.details[k].rows)) && b.details.conversions.rows.length === 4, Object.keys(b.details));
    const dis = await http('POST', `${G}/insights/no-consent/dismiss`, T.sa);
    const d2 = await get('sa', `${G}/`);
    check('D18 Dismiss hides an insight for this person for 7 days (and only this one)', dis.status === 200 && !d2.body.insights.some((i) => i.key === 'no-consent') && d2.body.insights.some((i) => i.key === 'failed'), { dis: dis.status, keys: d2.body.insights.map((i) => i.key) });
    check('D19 a bad insight key is refused (404)', (await http('POST', `${G}/insights/x%20y/dismiss`, T.sa)).status === 404);
    const resp = await get('sa', `${G}/responses?campaignId=${cA}`);
    check('D20 Responses popup numbers are real: 1 wrote back, 1 tapped the link, 1 applied (event), 2 sent', resp.status === 200 && resp.body.total === 1 && resp.body.clicks === 1 && resp.body.applied === 1 && resp.body.sent === 2, resp.text.slice(0, 200));

    // ================================================================ S: scope
    const dTl = await get('tl', `${G}/`);
    const tlNames = (dTl.body.recent || []).map((r) => r.name).join('|');
    check('S1 Team Lead sees the campaigns of THEIR jobs only (A, B, E), not the one for another department\'s job (C) or the staff one (D)', dTl.status === 200 && dTl.body.kpis.campaigns.value === 3 && !/campaign C/.test(tlNames) && !/campaign D/.test(tlNames), { n: dTl.body.kpis.campaigns.value, names: tlNames });
    check('S2 Team Lead\'s reach counts only their campaigns (c1, c2 = 2 people, 2 messages)', dTl.body.kpis.reach.value === 2 && dTl.body.channels.find((c) => c.id === 'sms').sent === 0, dTl.body.kpis.reach);
    const dHr = await get('hr', `${G}/`);
    check('S3 HR sees the internal side only: 1 campaign (the staff one), no job conversions ("not linked")', dHr.status === 200 && dHr.body.kpis.campaigns.value === 1 && dHr.body.kpis.conversions.value === null && /Not linked/.test(dHr.body.kpis.conversions.sub), dHr.body.kpis);
    const dIn = await get('sa', `${G}/?dept=${encodeURIComponent(deptIn)}`);
    const dOut = await get('sa', `${G}/?dept=${encodeURIComponent(deptOut)}`);
    check('S4 the department switch narrows everything: only that department\'s campaigns', dIn.body.kpis.campaigns.value >= 3 && dOut.body.recent.some((r) => r.id === cC) && !dOut.body.recent.some((r) => r.id === cA) && dIn.body.recent.some((r) => r.id === cA) && !dIn.body.recent.some((r) => r.id === cC), { inN: dIn.body.kpis.campaigns.value, outN: dOut.body.kpis.campaigns.value });
    const dBad = await get('tl', `${G}/?dept=${encodeURIComponent(deptOut)}`);
    check('S5 a department the Team Lead may not see gives nothing (0 campaigns, 0 reach), never the other department\'s numbers', dBad.status === 200 && dBad.body.kpis.campaigns.value === 0 && dBad.body.kpis.reach.value === 0 && dBad.body.recent.length === 0, dBad.body.kpis);
    const dRec = await get('rec', `${G}/`);
    const dBde = await get('bde', `${G}/`);
    check('S6 Recruiter and BDE open the dashboard (200) and see only their own scope', dRec.status === 200 && dBde.status === 200 && dRec.body.kpis.campaigns.value <= 5 && dBde.body.kpis.campaigns.value <= 5);
    const respTl = await get('tl', `${G}/responses?campaignId=${cC}`);
    check('S7 Responses popup for a campaign outside the login\'s area: 404', respTl.status === 404, respTl.status);
    check('S8 Client login refused (403)', (await http('GET', `${G}/`, T.client)).status === 403);
    check('S9 Accounts / Finance login has no dashboard (403)', (await http('GET', `${G}/`, T.acct)).status === 403);

    // ================================================================ F: the flow strip
    const f = await get('sa', `${G}/flow`);
    const fb = f.body || {};
    const stepIds = (fb.steps || []).map((s) => s.id).join();
    check('F1 the strip has the 10 steps in order', f.status === 200 && stepIds === 'contacts,consent,audience,template,campaign,queue,replies,automation,conversion,analytics', stepIds);
    check('F2 every step has who, a page, a count or "not linked", a hint and a tone (ok / todo / warn)', fb.steps.every((s) => s.who && s.words && s.hint && ['ok', 'todo', 'warn'].includes(s.tone) && (s.page === null || typeof s.page === 'string') && s.n >= 1), fb.steps.map((s) => `${s.n}:${s.tone}`).join());
    const st1 = fb.steps[0]; const st2 = fb.steps[1]; const st6 = fb.steps[5]; const st9 = fb.steps[8]; const st5 = fb.steps[4];
    check('F3 step 1 counts the real contacts (5 ZZTEST), step 2 warns "N contacts have no consent yet"', st1.count >= 5 && st1.tone === 'ok' && st2.tone === 'warn' && /no consent yet/.test(st2.hint), { st1, st2 });
    check('F4 step 5 counts the campaigns (5) and says live / scheduled', st5.count === 5 && /2 live, 1 scheduled/.test(st5.hint), st5);
    check('F5 step 6 (send queue) warns "1 message failed: see why"', st6.tone === 'warn' && /1 message failed: see why/.test(st6.hint), st6);
    check('F6 step 9 (conversion) is linked: 1 applied, 1 interview, 1 joined', st9.tone === 'ok' && /1 applied, 1 interviews, 1 joined/.test(st9.hint) && st9.page === 'analytics', st9);
    check('F7 step 10 ends the flow and opens Analytics', fb.steps[9].end === true && fb.steps[9].page === 'analytics');
    check('F8 a "what to do next" step is named when something is todo / warn', !fb.next || (fb.next.n >= 1 && fb.next.hint));
    const fTl = await get('tl', `${G}/flow`);
    check('F9 Team Lead\'s flow counts only their campaigns (3)', fTl.status === 200 && fTl.body.steps[4].count === 3, fTl.body.steps && fTl.body.steps[4]);
    const fBad = await get('tl', `${G}/flow?dept=${encodeURIComponent(deptOut)}`);
    check('F10 a department that is not allowed: every count is 0', fBad.body.steps[0].count === 0 && fBad.body.steps[4].count === 0 && fBad.body.steps[2].count === 0, fBad.body.steps && fBad.body.steps.map((s) => s.count).join());
    const fHr = await get('hr', `${G}/flow`);
    check('F11 HR\'s flow opens (200) and counts the staff side (1 campaign)', fHr.status === 200 && fHr.body.steps[4].count === 1, fHr.body.steps && fHr.body.steps[4]);

    // ================================================================ A: analytics
    const an = await get('sa', `${GA}/comm`);
    const ab = an.body || {};
    check('A1 communication analytics: 4 of 5 campaigns fall in the last 30 days (the 40-day-old one does not)', an.status === 200 && ab.campaignsTotal === 5 && ab.campaignsInRange === 4, { t: ab.campaignsTotal, r: ab.campaignsInRange });
    check('A2 totals: 7 messages made, 4 really sent, 1 delivered, 2 engaged, 1 failed, 2 rehearsed, 1 person skipped (not counted)', ab.totals.total === 7 && ab.totals.sent === 4 && ab.totals.delivered === 1 && ab.totals.engaged === 2 && ab.totals.failed === 1 && ab.totals.rehearsed === 2 && ab.totals.skipped === 1, ab.totals);
    check('A3 live-status slices add up to the total (delivered 0 + engaged 2 + failed 1 + sent 2 + rehearsed 2 + waiting 0 = 7)', Object.values(ab.slices).reduce((a, c) => a + c, 0) === ab.totals.total && ab.slices.engaged === 2 && ab.slices.rehearsed === 2, ab.slices);
    const chOf = (id) => ab.channels.find((c) => c.id === id) || {};
    check('A4 channel breakdown: WhatsApp 3, SMS 1, Email 3, Voice 0 (calls logged); no RCS (we have none)', chOf('whatsapp').total === 3 && chOf('sms').total === 1 && chOf('email').total === 3 && chOf('call').total === 0 && !ab.channels.some((c) => /rcs/i.test(c.id)), ab.channels.map((c) => `${c.id}:${c.total}`));
    check('A5 top failure reasons are in plain words with a count: "Address does not work" x1, and say which campaigns', ab.failures.length === 1 && ab.failures[0].words === 'Address does not work' && ab.failures[0].count === 1 && ab.failures[0].campaignIds.includes(cA), ab.failures);
    check('A6 recent activity lists the campaigns in range with status in words and counts (4 rows, newest first)', ab.activity.length === 4 && ab.activity.every((a) => a.statusWords && a.channelWords) && ab.activity[0].at >= ab.activity[3].at, ab.activity.map((a) => a.name));
    const t3 = new Date(now - 3 * DAY + 5.5 * 3600000).toISOString().slice(0, 10);
    const one = await get('sa', `${GA}/comm?from=${t3}&to=${t3}&preset=Custom`);
    check('A7 a one-day range returns only the campaign of that day (A), with the range echoed', one.body.campaignsInRange === 1 && one.body.activity[0].id === cA && one.body.range.from === t3 && one.body.range.to === t3 && one.body.range.days === 1, { r: one.body.range, n: one.body.campaignsInRange });
    const none = await get('sa', `${GA}/comm?from=2020-01-01&to=2020-01-02`);
    check('A8 an empty range returns zeros (no demo numbers)', none.body.campaignsInRange === 0 && none.body.totals.total === 0 && none.body.failures.length === 0, none.body.totals);
    const wide = await get('sa', `${GA}/comm?from=2000-01-01&to=${new Date().toISOString().slice(0, 10)}`);
    check('A9 a range longer than a year is cut to 366 days', wide.body.range.days <= 366, wide.body.range);
    const anTl = await get('tl', `${GA}/comm`);
    check('A10 Team Lead\'s analytics hold only their campaigns (3 in range: A, B... E is old)', anTl.status === 200 && anTl.body.campaignsTotal === 3 && anTl.body.activity.every((x) => x.id !== cC && x.id !== cD), { t: anTl.body.campaignsTotal });
    const anBad = await get('tl', `${GA}/comm?dept=${encodeURIComponent(deptOut)}`);
    check('A11 a department not allowed: nothing', anBad.body.campaignsTotal === 0 && anBad.body.totals.total === 0);
    const anHr = await get('hr', `${GA}/comm`);
    check('A12 HR\'s analytics hold only the staff campaign', anHr.status === 200 && anHr.body.campaignsTotal === 1 && anHr.body.activity[0].id === cD, anHr.body.campaignsTotal);
    const fu = await get('sa', `${GA}/funnel`);
    const fs2 = (fu.body.steps || []).map((s) => s.id).join();
    check('A13 funnel has the nine steps: people, sent, delivered, opened, replied, applied, interview, offer, joined', fu.status === 200 && fs2 === 'people,sent,delivered,opened,replied,applied,interview,offer,joined', fs2);
    const n = Object.fromEntries((fu.body.steps || []).map((s) => [s.id, s.n]));
    check('A14 funnel numbers: 7 people, 4 sent, 1 delivered, 1 opened the link, 1 replied, 1 applied, 1 interview, 1 offer, 1 joined', n.people === 7 && n.sent === 4 && n.delivered === 1 && n.opened === 1 && n.replied === 1 && n.applied === 1 && n.interview === 1 && n.offer === 1 && n.joined === 1 && fu.body.linked === true, n);
    const fwa = await get('sa', `${GA}/funnel?channel=whatsapp`);
    const nw = Object.fromEntries((fwa.body.steps || []).map((s) => [s.id, s.n]));
    check('A15 funnel per channel (WhatsApp): 3 people, 2 sent, 1 delivered', nw.people === 3 && nw.sent === 2 && nw.delivered === 1 && fwa.body.channel === 'whatsapp', nw);
    const fem = await get('sa', `${GA}/funnel?channel=email`);
    const ne = Object.fromEntries((fem.body.steps || []).map((s) => [s.id, s.n]));
    check('A16 a way with no real job send says "not linked" (null), never a guess: Email in range was only rehearsed or staff', fem.body.linked === false && ne.applied === null && ne.joined === null && ne.sent === 1, { ne, linked: fem.body.linked });
    check('A17 the funnel never invents revenue: it says so in its notes', (fu.body.notes || []).some((x) => /revenue/i.test(x)) && !('revenue' in fu.body.tiles));
    const so = await get('sa', `${GA}/social`);
    check('A18 Social Media Analytics is honest: not connected, no accounts, no numbers', so.status === 200 && so.body.connected === false && so.body.accounts.length === 0);
    const csvSa = await http('GET', `${GA}/report.csv`, T.sa);
    check('A19 the export is a CSV with a row per way and per campaign (numbers only), and it is audited', csvSa.status === 200 && /text\/csv/.test(csvSa.type) && /"Channel","Total","Sent","Delivered","Engaged","Failed"/.test(csvSa.text) && csvSa.text.includes(`ZZTEST campaign A ${RUN}`) && !/example\.test/.test(csvSa.text), csvSa.text.slice(0, 200));
    const aud = await prisma.auditLog.findFirst({ where: { action: 'Omni-Channel analytics report downloaded', userId: sa.id }, orderBy: { createdAt: 'desc' } });
    check('A20 the audit row has counts only (no phone, no email)', aud && /campaigns/.test(aud.toValue || '') && !/@|\d{10}/.test(aud.toValue || ''), aud);
    check('A21 a BDE and a Recruiter cannot download the report (403)', (await http('GET', `${GA}/report.csv`, T.bde)).status === 403 && (await http('GET', `${GA}/report.csv`, T.rec)).status === 403);
    check('A22 Team Lead may download it (their own campaigns only)', await (async () => { const r = await http('GET', `${GA}/report.csv`, T.tl); return r.status === 200 && !r.text.includes(`campaign C ${RUN}`); })());
    check('A23 Client and Accounts logins are refused by analytics (403)', (await http('GET', `${GA}/comm`, T.client)).status === 403 && (await http('GET', `${GA}/comm`, T.acct)).status === 403);
    // the old routes the extra sub-tabs use still work with the same role rules
    const oldPerf = await http('GET', '/api/outreach/insights/performance', T.sa); const oldPerfBde = await http('GET', '/api/outreach/insights/performance', T.bde);
    const oldRep = await http('GET', '/api/outreach/reports', T.sa); const oldAct = await http('GET', '/api/outreach/activity', T.rec); const oldRoi = await http('GET', '/api/outreach/insights/roi', T.rec);
    check('A24 the old Team performance / Reports / My activity routes still work, with the same role rules (BDE and Recruiter have no performance / ROI)', oldPerf.status === 200 && oldPerfBde.status === 403 && oldRep.status === 200 && oldAct.status === 200 && oldRoi.status === 403, { p: oldPerf.status, pb: oldPerfBde.status, r: oldRep.status, a: oldAct.status, roi: oldRoi.status });
    const oldDash = await http('GET', '/api/outreach/dashboard', T.sa);
    check('A25 the old dashboard route still answers (kept working)', oldDash.status === 200 && Array.isArray(oldDash.body.blocks), oldDash.status);

    // ================================================================ P: privacy and safety
    const joined = everything.join('\n');
    const secrets = [c1, c2, c3, c4, s1].flatMap((c) => [c.addr, c.phoneKey]);
    check('P1 no phone number or email address appears in any dashboard / analytics answer, for any role', !secrets.some((x) => joined.includes(x)) && !/example\.test/.test(joined), secrets.filter((x) => joined.includes(x)));
    const w = words(JSON.parse(JSON.stringify(everything.map((t) => { try { return JSON.parse(t); } catch { return null; } }).filter(Boolean)))).join('\n');
    check('P2 the word "Draft" is on no screen text (status words say "Not sent yet")', !/\bdraft/i.test(w), (w.match(/.{20}\bdraft.{20}/i) || [])[0]);
    const after = await countOf();
    check('P3 nothing was sent: no message rows, send-log rows or credit-ledger rows were added by any call', after.msgs === before.msgs && after.logs === before.logs && after.led === before.led, { before, after });
    const rg = require(path.join(BACK, 'src/outreach/insights')).rangeFrom({ from: '2026-10-10', to: '2026-10-01' });
    check('P4 a range given backwards is put in order', rg.fromDay === '2026-10-01' && rg.toDay === '2026-10-10' && rg.days === 10, rg);
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    await sleep(600);
    ['', '-wal', '-shm', '-journal'].forEach((x) => { try { fs.unlinkSync(`${WORK}${x}`); } catch { /* not there */ } });
    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail ? 1 : 0);
  }
})();
