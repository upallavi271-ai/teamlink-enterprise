#!/usr/bin/env node
// ---------------------------------------------------------------------------
// SECURITY BATCH 1 acceptance tests (2026-10-09). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/security-batch1-test.js
//
//   P  public /jobs only returns jobs really posted to the job portal
//   B  BDE / BDE TL privacy: follow-up log, candidate detail, offers
//   A  AI tools never return e-mail / phone / salary / scores without the switch
//   H  security headers, CORS, trust proxy helper
// Builds ZZTEST fixtures in sandbox.db and removes them again.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011 (the sandbox) or another sandbox port 4011-4099, never 4010.'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', process.env.TL_TEST_DB || 'sandbox.db').split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const { can } = require(path.join(BACK, 'src/utils/permissions'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body, headers) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, ...(headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual' });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text, headers: r.headers };
    } catch (e) { if (i >= 30) throw e; await new Promise((res) => setTimeout(res, 2000)); }
  }
}
const has = (o, k) => JSON.stringify(o).includes(`"${k}"`);

(async () => {
  const made = { users: [], clients: [], reqs: [], cands: [], apps: [], msgs: [] };
  try {
    const client = await prisma.client.create({ data: { name: `ZZTEST Sec Client ${RUN}`, location: 'ClientCitySecret' } });
    made.clients.push(client.id);
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST Sec ${tag} ${RUN}`, email: `zz-sec-${tag}-${RUN}@example.test`, username: `zz-sec-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBde = await mkUser('bde', { role: 'BDE', atsRole: 'BDE' });
    const uRec = await mkUser('rec', { role: 'RECRUITER', atsRole: 'RECRUITER' });
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const tAdmin = await mint(uAdmin); const tBde = await mint(uBde); const tRec = await mint(uRec);

    // requirements: A live+unpublished, B live+published(+job portal ticked), C live+published but only Naukri ticked
    const mkReq = async (tag, data) => {
      const r = await prisma.requirement.create({ data: { title: `ZZTEST Sec Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', bdeId: uBde.id, recruiterId: uRec.id, ...data } });
      made.reqs.push(r.id); return r;
    };
    const rA = await mkReq('A', { portalPublished: false });
    const rB = await mkReq('B', { portalPublished: true, portalPublishedAt: new Date(), location: 'ZZ Pune', postingSources: 'TeamLink Job Portal' });
    const rC = await mkReq('C', { portalPublished: true, portalPublishedAt: new Date(), postingSources: 'Naukri' });
    const rD = await mkReq('D', { portalPublished: true, portalPublishedAt: new Date(), postingSources: 'TeamLink Job Portal', status: 'CLOSED' });

    // ---------------- P: public jobs ----------------
    const pj = await call('GET', '/api/public/jobs');
    const ids = Array.isArray(pj.body) ? pj.body.map((j) => j.id) : [];
    check('P1 /public/jobs answers 200 with a list', pj.status === 200 && Array.isArray(pj.body), pj.status);
    check('P2 live-but-unpublished job is NOT listed', !ids.includes(rA.id));
    check('P3 published + Job Portal ticked job IS listed', ids.includes(rB.id));
    check('P4 published but Job Portal not ticked: NOT listed; closed: NOT listed', !ids.includes(rC.id) && !ids.includes(rD.id));
    const jB = pj.body && pj.body.find((j) => j.id === rB.id);
    check('P5 listed job shows its own location and the company TeamLink, never the client', jB && jB.location === 'ZZ Pune' && jB.client === 'TeamLink Consultants' && !JSON.stringify(pj.body).includes('ZZTEST Sec Client') && !JSON.stringify(pj.body).includes('ClientCitySecret'));
    check('P5b no internal priority is published', jB && !('priority' in jB));
    const cj = await call('GET', '/api/public/careers/jobs?pageSize=1000');
    const careersIds = ((cj.body && (cj.body.jobs || cj.body.items || cj.body.rows)) || []).map((j) => j.id);
    check('P6 /public/careers/jobs answers 200', cj.status === 200, cj.status);
    const pjSet = new Set(ids);
    const missingFromPublic = careersIds.filter((i) => !pjSet.has(i));
    const extraInPublic = ids.filter((i) => !careersIds.includes(i));
    check(`P7 /public/jobs and /public/careers/jobs list the SAME jobs (${ids.length} vs ${careersIds.length})`, careersIds.length > 0 && !extraInPublic.length && !missingFromPublic.length, { extraInPublic: extraInPublic.slice(0, 3), missingFromPublic: missingFromPublic.slice(0, 3) });
    const dA = await call('GET', `/api/public/jobs/${rA.id}`);
    const dB = await call('GET', `/api/public/jobs/${rB.id}`);
    check('P8 /public/jobs/:id: unpublished 404, published 200 without client location', dA.status === 404 && dB.status === 200 && dB.body.location === 'ZZ Pune', [dA.status, dB.status]);
    const aA = await call('POST', `/api/public/jobs/${rA.id}/apply`, null, { name: 'ZZTEST X', email: `zz-x-${RUN}@example.test` });
    check('P9 classic apply to an unpublished job is refused (404)', aA.status === 404, aA.status);
    const feed = await call('GET', '/api/public/jobs.feed');
    check('P10 jobs.feed unchanged (200, array)', feed.status === 200 && Array.isArray(feed.body));
    const xml = await call('GET', '/api/public/jobs.xml');
    check('P11 jobs.xml unchanged (200 xml)', xml.status === 200 && xml.text.includes('<source>'));
    const cd = await call('GET', `/api/public/careers/jobs/${rB.id}`);
    check('P12 careers job detail still 200', cd.status === 200, cd.status);

    // ---------------- B: BDE privacy ----------------
    const cand = await prisma.candidate.create({
      data: {
        name: `ZZTEST Sec Cand ${RUN}`, email: `zz-sec-cand-${RUN}@example.test`, phone: '9000000001', location: 'SecretTown', dob: '1990-01-01',
        currentCompany: 'SecretCorp', education: 'MSc', specialization: 'Chem', institute: 'SecretU', passingYear: '2012', resumeName: 'secret-cv.pdf',
        currentSalary: '9L', expectedSalary: '12L', resumeScore: 77, skills: 'java', experienceYears: 5,
      },
    });
    made.cands.push(cand.id);
    const app = await prisma.application.create({
      data: { candidateId: cand.id, requirementId: rB.id, stage: 'OFFER', offeredCtc: 1234567, offerNotes: 'Offer 12.3L plus bonus SECRETPAY', offerStatus: 'Offer Released', hiringType: 'Client Placement', matchScore: 66 },
    });
    made.apps.push(app.id);
    const msg = await prisma.candidateMessage.create({
      data: { candidateId: cand.id, applicationId: app.id, channel: 'Call', template: 'QUICK_LOG', trigger: 'Manual', recipient: 'x', body: 'Connected — SAIDSECRET he wants more money', status: 'LOGGED', senderName: 'ZZTEST Recruiter Name' },
    });
    made.msgs.push(msg.id);

    const fl = await call('GET', `/api/candidates/${cand.id}/followup-log`, tRec);
    check('B1 recruiter still reads said / by in the follow-up log', fl.status === 200 && JSON.stringify(fl.body).includes('SAIDSECRET') && JSON.stringify(fl.body).includes('ZZTEST Recruiter Name'), fl.status + fl.text.slice(0, 200));
    const flB = await call('GET', `/api/candidates/${cand.id}/followup-log`, tBde);
    check('B2 BDE gets the follow-up log WITHOUT what was said or who (said/by null)', flB.status === 200 && !flB.text.includes('SAIDSECRET') && !flB.text.includes('ZZTEST Recruiter Name') && (flB.body.entries || []).length >= 1, flB.status + flB.text.slice(0, 300));
    const dd = await call('GET', `/api/candidates/${cand.id}`, tBde);
    const dTxt = dd.text;
    const leaks = ['SecretTown', '1990-01-01', 'SecretCorp', 'secret-cv.pdf', 'SecretU', 'SECRETPAY', '1234567', 'zz-sec-cand', '9000000001', '12L', 'matchScore', 'resumeScore'].filter((k) => dTxt.includes(k));
    check('B3 BDE candidate detail (200): no location/dob/employer/education/resume name/offer pay/contact/salary/scores', dd.status === 200 && !leaks.length, { status: dd.status, leaks });
    const dr = await call('GET', `/api/candidates/${cand.id}`, tRec);
    check('B4 recruiter detail unchanged (still has location, employer, email, offer pay)', dr.status === 200 && ['SecretTown', 'SecretCorp', 'zz-sec-cand'].every((k) => dr.text.includes(k)), dr.status);
    const ofr = await call('GET', '/api/ats/offers', tBde);
    check('B5 BDE offers list: no offer notes / CTC', ofr.status === 200 && !ofr.text.includes('SECRETPAY') && !ofr.text.includes('1234567'), ofr.status);
    const ofrAdmin = await call('GET', '/api/ats/offers', tAdmin);
    check('B6 Admin offers list still carries offer notes + CTC', ofrAdmin.status === 200 && ofrAdmin.text.includes('SECRETPAY'), ofrAdmin.status);

    // ---------------- A: AI tools ----------------
    // The model is refused in the sandbox, so the TOOL FUNCTIONS are called directly with the
    // identity a request would carry (identity + caps, as middleware/auth.js builds them).
    const { runTool, shapeCandidate } = require(path.join(BACK, 'src/utils/aiAgentTools'));
    const withCaps = async (u, over) => {
      const identity = await resolveIdentity(u.id);
      identity.caps = { candidateContact: await can(identity, 'ats', 'candidates', 'Candidate Contact & Salary', 'view'), ...(over || {}) };
      return identity;
    };
    const iRec = await withCaps(uRec);
    const iBde = await withCaps(uBde);
    const iRecOff = await withCaps(uRec, { candidateContact: false });
    const sRec = await runTool(iRec, 'search_candidates', { query: 'ZZTEST Sec Cand' });
    const recRow = sRec.candidates && sRec.candidates[0];
    console.log('      recruiter search_candidates:', JSON.stringify(sRec).slice(0, 220));
    if (recRow) {
      check('A1 recruiter (switch ON) still gets email / phone / expected salary / resume score from the AI', !!recRow.email && !!recRow.phone && !!recRow.expectedSalary && recRow.resumeScore === 77, recRow);
    } else {
      check('A1 recruiter search finds the fixture (recruiter scope)', false, sRec);
    }
    const sOff = await runTool(iRecOff, 'search_candidates', { query: 'ZZTEST Sec Cand' });
    const offRow = sOff.candidates && sOff.candidates[0];
    check('A2 same recruiter with the switch OFF: no email / phone / expectedSalary in the AI answer (name stays)', !!offRow && !has(offRow, 'email') && !has(offRow, 'phone') && !has(offRow, 'expectedSalary') && offRow.name, sOff);
    const sOffEmail = await runTool(iRecOff, 'search_candidates', { query: `zz-sec-cand-${RUN}@example.test` });
    check('A3 switch OFF: searching by e-mail finds nobody (a hidden field is not searchable)', sOffEmail.count === 0, sOffEmail);
    const sBde = await runTool(iBde, 'search_candidates', { query: 'ZZTEST Sec Cand' });
    const bdeTxt = JSON.stringify(sBde);
    const bleaks = ['zz-sec-cand', '9000000001', '12L', 'resumeScore', 'SecretTown', 'SecretCorp', 'MSc'].filter((k) => bdeTxt.includes(k));
    check('A4 BDE: AI search never returns email / phone / salary / resume score / location / employer / education', !bleaks.length, { bleaks, sBde: bdeTxt.slice(0, 200) });
    const mBde = await runTool(iBde, 'summarise_candidate_against_requirement', { candidateId: cand.id, requirementId: rB.id });
    check('A5 BDE: candidate score tool refused', !!mBde.denied && !JSON.stringify(mBde).includes('overall'), mBde);
    const tmBde = await runTool(iBde, 'top_matches_for_requirement', { requirementId: rB.id });
    check('A6 BDE: top-matches tool refused (internal match scores)', !!tmBde.denied, tmBde);
    const tmRec = await runTool(iRec, 'top_matches_for_requirement', { requirementId: rB.id });
    check('A7 recruiter: top-matches still works', !tmRec.denied && Array.isArray(tmRec.matches), tmRec);
    const raw = shapeCandidate(cand);
    check('A8 shapeCandidate with no view argument answers the most restricted cut (fail closed)', !has(raw, 'email') && !has(raw, 'phone') && !has(raw, 'expectedSalary') && !has(raw, 'resumeScore') && !has(raw, 'location'), raw);
    // the Do-agent's entity pickers
    const entities = require(path.join(BACK, 'src/ai/lib/entities'));
    const fc = await entities.findCandidates(iBde, 'ZZTEST Sec Cand');
    const fcTxt = JSON.stringify(fc);
    check('A9 AI picker (findCandidates) for BDE: no email / phone / location / employer', !['zz-sec-cand', '9000000001', 'SecretTown', 'SecretCorp'].some((k) => fcTxt.includes(k)) || fc.rows.length === 0, fcTxt.slice(0, 200));
    const fcRec = await entities.findCandidates(iRec, 'ZZTEST Sec Cand');
    check('A10 AI picker for the recruiter still carries phone in the label', fcRec.rows.length > 0 && /9000000001/.test(fcRec.rows[0].label), fcRec.rows[0] && fcRec.rows[0].label);
    const fcOff = await entities.findCandidates(iRecOff, 'ZZTEST Sec Cand');
    check('A11 AI picker with the switch OFF: no phone / email in rows or labels', fcOff.rows.length > 0 && !JSON.stringify(fcOff).includes('9000000001') && !JSON.stringify(fcOff).includes('zz-sec-cand'), fcOff);
    const fa = await entities.findApplications(iBde, 'ZZTEST Sec Cand');
    check('A12 AI application picker for BDE: no candidate e-mail / phone', !JSON.stringify(fa).includes('9000000001') && !JSON.stringify(fa).includes('zz-sec-cand'), JSON.stringify(fa).slice(0, 200));

    // ---------------- H: web hardening ----------------
    const hh = await call('GET', '/api/health');
    const hd = {};
    ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'content-security-policy-report-only', 'permissions-policy', 'strict-transport-security', 'access-control-allow-origin', 'x-powered-by'].forEach((k) => { hd[k] = hh.headers.get(k); });
    console.log('      /api/health headers:', JSON.stringify(hd));
    check('H1 nosniff + frame + referrer headers present on the API', hd['x-content-type-options'] === 'nosniff' && /DENY|SAMEORIGIN/.test(hd['x-frame-options'] || '') && !!hd['referrer-policy'], hd);
    check('H2 CSP is report-only (never enforcing) and X-Powered-By is gone', !!hd['content-security-policy-report-only'] && !hh.headers.get('content-security-policy') && !hd['x-powered-by'], hd);
    check('H3 no HSTS on plain http (non-production)', !hd['strict-transport-security'], hd);
    const pre = await call('OPTIONS', '/api/auth/me', null, undefined, { Origin: 'http://localhost:5184', 'Access-Control-Request-Method': 'GET' });
    check('H4 CORS: the app\'s own localhost origin is allowed', pre.headers.get('access-control-allow-origin') === 'http://localhost:5184', [pre.status, pre.headers.get('access-control-allow-origin')]);
    const evil = await call('GET', '/api/auth/me', tRec, undefined, { Origin: 'https://evil.example' });
    check('H5 CORS: a foreign origin gets no Access-Control-Allow-Origin on a staff API', !evil.headers.get('access-control-allow-origin'), evil.headers.get('access-control-allow-origin'));
    const feedEvil = await call('GET', '/api/public/jobs.feed', null, undefined, { Origin: 'https://partner.example' });
    check('H6 CORS: the public feed stays open to any site', !!feedEvil.headers.get('access-control-allow-origin'), feedEvil.headers.get('access-control-allow-origin'));
    const careersEvil = await call('GET', '/api/public/careers/jobs', null, undefined, { Origin: 'https://partner.example' });
    check('H7 CORS: public careers API stays open (embedded apply forms)', !!careersEvil.headers.get('access-control-allow-origin'), careersEvil.headers.get('access-control-allow-origin'));
    const noOrigin = await call('GET', '/api/auth/me', tRec);
    check('H8 requests without an Origin (same-origin / curl / server to server) still work', noOrigin.status === 200, noOrigin.status);
    // production rules, unit level (env swapped for the call)
    const WS = require(path.join(BACK, 'src/utils/webSecurity'));
    const CIP = require(path.join(BACK, 'src/utils/clientIp'));
    const saveEnv = { n: process.env.NODE_ENV, c: process.env.CORS_ORIGINS, a: process.env.APP_BASE_URL };
    const fakeReq = (host) => ({ headers: { host } });
    process.env.NODE_ENV = 'production'; delete process.env.CORS_ORIGINS; process.env.APP_BASE_URL = 'https://app.example.test';
    check('H9 production: APP_BASE_URL is the fallback allow-list; localhost and strangers are refused; the site itself passes',
      WS.originAllowed(fakeReq('api.example.test'), 'https://app.example.test') && !WS.originAllowed(fakeReq('api.example.test'), 'http://localhost:5183')
      && !WS.originAllowed(fakeReq('api.example.test'), 'https://evil.example') && WS.originAllowed(fakeReq('app.example.test'), 'https://app.example.test'));
    process.env.CORS_ORIGINS = 'https://a.example.test, https://b.example.test/';
    check('H10 production: CORS_ORIGINS list wins over APP_BASE_URL (trailing slash tolerated)', WS.originAllowed(fakeReq('x'), 'https://b.example.test') && !WS.originAllowed(fakeReq('x'), 'https://app.example.test'));
    process.env.NODE_ENV = 'development'; delete process.env.CORS_ORIGINS;
    check('H11 development: localhost and a LAN phone are allowed, a stranger is not', WS.originAllowed(fakeReq('x'), 'http://localhost:5183') && WS.originAllowed(fakeReq('x'), 'http://192.168.1.20:5183') && !WS.originAllowed(fakeReq('x'), 'https://evil.example'));
    check('H12 HSTS only in production over https', (() => {
      const run = (env, req) => { process.env.NODE_ENV = env; const h = {}; WS.securityHeaders(Object.assign({ originalUrl: '/api/x' }, req), { getHeader: (k) => h[k], setHeader: (k, v) => { h[k] = v; } }, () => {}); return h['Strict-Transport-Security']; };
      return !run('development', { secure: true, headers: {} }) && !run('production', { secure: false, headers: {}, socket: { remoteAddress: '8.8.8.8' } })
        && !!run('production', { secure: true, headers: {} }) && !!run('production', { secure: false, headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '127.0.0.1' } })
        && !run('production', { secure: false, headers: { 'x-forwarded-proto': 'https' }, socket: { remoteAddress: '8.8.8.8' } });
    })());
    check('H13 a stricter header set by the vendor / partner shield is NOT weakened', (() => {
      const h = { 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' };
      WS.securityHeaders({ originalUrl: '/api/vendor-portal/x', headers: {} }, { getHeader: (k) => h[k], setHeader: (k, v) => { h[k] = v; } }, () => {});
      return h['X-Frame-Options'] === 'DENY' && h['Referrer-Policy'] === 'no-referrer';
    })());
    Object.assign(process.env, { NODE_ENV: saveEnv.n, APP_BASE_URL: saveEnv.a }); if (saveEnv.n === undefined) delete process.env.NODE_ENV; if (saveEnv.c === undefined) delete process.env.CORS_ORIGINS; else process.env.CORS_ORIGINS = saveEnv.c;
    check('H14 clientIp: X-Forwarded-For is believed only from a local proxy, and only its LAST hop', 
      CIP.ipOf({ headers: { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' }, socket: { remoteAddress: '203.0.113.9' } }) === '203.0.113.9'
      && CIP.ipOf({ headers: { 'x-forwarded-for': '6.6.6.6, 203.0.113.9' }, socket: { remoteAddress: '127.0.0.1' } }) === '203.0.113.9'
      && CIP.ipOf({ headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } }) === '127.0.0.1');
    check('H15 TRUST_PROXY: unset / 0 = off; loopback; 1 = one hop; "true" is never blind trust',
      CIP.trustProxySetting('') === undefined && CIP.trustProxySetting('0') === undefined && CIP.trustProxySetting('loopback') === 'loopback' && CIP.trustProxySetting('1') === 1 && CIP.trustProxySetting('true') === 'loopback');
  } catch (e) {
    fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      const ids = made.users;
      await prisma.candidateMessage.deleteMany({ where: { id: { in: made.msgs } } });
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: made.apps } } });
      await prisma.application.deleteMany({ where: { id: { in: made.apps } } });
      await prisma.syncLog.deleteMany({ where: { reason: { contains: 'ZZTEST' } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.notification.deleteMany({ where: { userId: { in: ids } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: [...ids, ...made.cands, ...made.clients, ...made.reqs, ...made.apps] } }] } });
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
    } catch (e) { console.error('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
