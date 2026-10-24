#!/usr/bin/env node
// CLIENT HIRING (offer + joining letters the client sends) - SANDBOX ONLY.
//   cd backend && TL_API=http://localhost:4011 node <this file>
const path = require('path');
const BACK = 'C:/Users/user/Desktop/All_Projects/teamlink-enterprise/backend';
const API = String(process.env.TL_API || '').replace(/\/+$/, '').replace(/\/api$/, '');
if (!/^http:\/\/localhost:40(1[1-9]|[2-9][0-9])$/.test(API)) { console.error('Refusing: set TL_API=http://localhost:4011'); process.exit(2); }
const SBX = `file:${path.join(BACK, 'prisma', (process.env.TL_TEST_DB || 'sandbox.db')).split(path.sep).join('/')}`;
process.env.DATABASE_URL = SBX;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = SBX;
process.env.TEST_MODE = '1';
const realFetch = globalThis.fetch;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

const RUN = Date.now().toString(36);
let pass = 0; let fail = 0;
function check(name, ok, detail) {
  if (ok) pass += 1; else fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail != null ? `  -> ${String(typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 500)}` : ''}`);
}
async function call(method, p, token, body, raw) {
  const h = { 'X-Forwarded-For': `10.8.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) { h['Content-Type'] = raw.type; payload = raw.buf; } else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  for (let i = 0; ; i += 1) {
    try {
      const r = await realFetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(90000) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
      return { status: r.status, body: json, text, type: r.headers.get('content-type') };
    } catch (e) { if (i >= 60) throw e; await new Promise((res) => setTimeout(res, 3000)); }
  }
}
function multi(fields, file) {
  const b = `----zz${RUN}`;
  const parts = [];
  Object.entries(fields).forEach(([k, v]) => parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`)));
  if (file) parts.push(Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from('\r\n')]));
  parts.push(Buffer.from(`--${b}--\r\n`));
  return { type: `multipart/form-data; boundary=${b}`, buf: Buffer.concat(parts) };
}
const PDF = { name: 'client-offer.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') };
const TXT = { name: 'x.pdf', type: 'application/pdf', data: Buffer.from('<html>not a pdf</html>') };
const today = () => new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const future = (d) => new Date(Date.now() + d * 86400000 + 330 * 60000).toISOString().slice(0, 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const made = { users: [], emps: [], clients: [], reqs: [], cands: [], apps: [] };
  let switchRow = null; let roleRow = null;
  const CTC = 456789;
  const SECRET = { phone: '9000000077', currentSalary: '7L', expectedSalary: '9L' };
  try {
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST CT ${tag} ${RUN}`, email: `zz-ct-${tag}-${RUN}@example.test`, username: `zz-ct-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (!extra.clientId && !extra.candidateId) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-CT-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, phone: '90000' + String(Math.floor(Math.random() * 99999)).padStart(5, '0') } });
        made.emps.push(e.id);
      }
      return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' });
    const uBde = await mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' });
    const uBde2 = await mkUser('bde2', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' });
    const uRec = await mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uTl = await mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uMgr = await mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' });
    const uHr = await mkUser('hr', { role: 'EMPLOYEE', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true, atsDepartment: 'HR', atsScopeDepartments: 'HR' });
    const uAcc = await mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsRole: 'ACCOUNTANT', accountsAccess: true });

    const mkClient = async (tag, bde, extra = {}) => { const c = await prisma.client.create({ data: { name: `ZZTEST CT Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: bde ? bde.name : null, clientType: 'Client', agreementStatus: 'ACTIVE', contactEmail: `zz-ct-contact-${tag}-${RUN}@example.test`, agreementFeePercent: 8.33, ...extra } }); made.clients.push(c.id); return c; };
    const cA = await mkClient('a', uBde);
    const cB = await mkClient('b', null);
    const cInt = await mkClient('int', null, { clientType: 'Internal' });
    const uClient = await mkUser('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: cA.id, portalPerms: 'VIEW,OFFERS' });
    const uClientView = await mkUser('clientview', { role: 'CLIENT', atsRole: 'CLIENT', clientId: cA.id, portalPerms: 'VIEW' });
    const uClientB = await mkUser('clientb', { role: 'CLIENT', atsRole: 'CLIENT', clientId: cB.id, portalPerms: 'VIEW,OFFERS' });
    const mkReq = async (tag, client, extra = {}) => { const r = await prisma.requirement.create({ data: { title: `ZZTEST CT Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, tlId: uTl.id, openings: 5, ...extra } }); made.reqs.push(r.id); return r; };
    const rA = await mkReq('a', cA);
    const rB = await mkReq('b', cB);
    const rInt = await mkReq('int', cInt, { internal: true, hiringType: 'TeamLink Internal Hire' });
    const mkApp = async (tag, req, stage, extra = {}, candExtra = {}) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST CT Cand ${tag} ${RUN}`, email: `zz-ct-cand-${tag}-${RUN}@example.test`, ...SECRET, location: 'ZZ', ...candExtra } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage, ...extra } });
      made.apps.push(a.id); return { a, c };
    };
    const old = new Date(Date.now() - 12 * 86400000);
    const mkSelected = async (tag, req) => {
      const x = await mkApp(tag, req, 'SELECTED');
      await prisma.applicationStageEvent.create({ data: { applicationId: x.a.id, candidateId: x.c.id, fromStage: 'INTERVIEW_COMPLETED', toStage: 'SELECTED', action: 'Moved', actorUserId: uTl.id, actorName: uTl.name, actorSide: 'Internal', requirementId: req.id, createdAt: old } });
      return x;
    };
    const X1 = await mkSelected('x1', rA); // the main client path
    const X2 = await mkSelected('x2', rA); // decline path + BDE on behalf
    const X3 = await mkSelected('x3', rA); // BDE on behalf + staff-recorded acceptance
    const XI = await mkSelected('xi', rInt); // internal
    const XB = await mkSelected('xb', rB);
    const mint = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '1h' });
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, bdeTl: uBdeTl, bde: uBde, bde2: uBde2, rec: uRec, tl: uTl, mgr: uMgr, hr: uHr, acc: uAcc, client: uClient, clientView: uClientView, clientB: uClientB })) T[k] = await mint(u);
    const candUser = await mkUser('cand', { role: 'CANDIDATE', atsRole: 'CANDIDATE', candidateId: X1.c.id });
    T.cand = await mint(candUser);

    // the Admin "emails" switch ON for the test (restored in finally)
    switchRow = await prisma.appSetting.findUnique({ where: { key: 'interview-reminders' } });
    await prisma.appSetting.upsert({ where: { key: 'interview-reminders' }, create: { key: 'interview-reminders', value: JSON.stringify({ enabled: true }) }, update: { value: JSON.stringify({ enabled: true }) } });

    const NA = require(path.join(BACK, 'src/utils/nextAction'));
    const naOf = async (id) => {
      await sleep(5200);
      await NA.ensureNextActionContext({ fresh: true });
      const app = await prisma.application.findUnique({ where: { id }, include: { requirement: { include: { client: true, recruiter: true } } } });
      return NA.nextActionFor(app);
    };
    const bells = async (u, like) => prisma.notification.count({ where: { userId: u.id, title: { contains: like } } });
    const trackOf = async (id) => { const r = await prisma.appSetting.findUnique({ where: { key: `client-track:${id}` } }); return r ? JSON.parse(r.value) : null; };

    // ===== A. INTERNAL track unchanged =====
    const ni = await naOf(XI.a.id);
    check('A1 internal SELECTED keeps "Prepare / Send Offer" (HR)', ni.action === 'Prepare / Send Offer' && ni.ownerRole === 'HR', ni);
    const pi = await call('POST', `/api/ats/offers/${XI.a.id}/prepare`, T.admin, { offeredCtc: 300000 });
    check('A2 internal offer can still be prepared', pi.status === 200, [pi.status, pi.text.slice(0, 200)]);
    const li = await call('GET', '/api/ats/offers?page=1&view=all&window=all', T.rec);
    check('A3 offers list has no client steps on an internal row', li.status === 200 && (li.body.rows || []).filter((r) => r.id === XI.a.id).every((r) => r.clientTrack === null), li.status);
    const ri = await call('POST', `/api/ats/offers/${XI.a.id}/client-release`, T.bde, undefined, multi({ note: 'x' }, PDF));
    check('A4 internal job: client release refused (TeamLink job)', [403, 409].includes(ri.status), [ri.status, ri.text.slice(0, 150)]);

    // ===== B. CLIENT track =====
    const n1 = await naOf(X1.a.id);
    check('B1 client SELECTED: BDE chases the client (WAITING, not Prepare / Send Offer)', n1.action === 'Chase the client for the offer letter' && n1.ownerRole === 'BDE' && n1.waitingOn === 'Client', n1);
    check('B1b the recruiter is not the owner', NA.needsActionBy({ id: X1.a.id }, n1, { id: uRec.id, atsRole: 'RECRUITER' }) === false && NA.needsActionBy({ id: X1.a.id }, n1, { id: uBde.id, atsRole: 'BDE' }) === true);
    const homeRec = await call('GET', '/api/dashboard/ats/home?fresh=1', T.rec);
    const tasksOf = (r) => { const w = ((r.body && r.body.widgets) || []).find((x) => x.id === 'tasks'); return (w && w.rows) || []; };
    const tr1 = tasksOf(homeRec);
    check('B2 recruiter tasks: no "Prepare / Send Offer" on a client job (the internal one may stay)', homeRec.status === 200 && !tr1.some((r) => r.action === 'Prepare / Send Offer' && !/ xi /.test(r.candidate)) && !tr1.some((r) => r.action === 'Chase the client for the offer letter'), tr1.map((r) => [r.candidate, r.action]));
    const pr = await call('POST', `/api/ats/offers/${X1.a.id}/prepare`, T.rec, { offeredCtc: 400000 });
    check('B3 recruiter cannot prepare an offer on a client job', pr.status === 409 && pr.body.code === 'CLIENT_OFFER', [pr.status, pr.text.slice(0, 150)]);
    const ap = await call('POST', `/api/ats/offers/${X1.a.id}/approve`, T.tl, { offeredCtc: 400000 });
    check('B3b TL cannot approve & send one either', ap.status === 409 && ap.body.code === 'CLIENT_OFFER', [ap.status, ap.text.slice(0, 150)]);
    const rr = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.rec, undefined, multi({ note: 'x', joiningDate: future(10) }, PDF));
    check('B4 recruiter / TL cannot record the client letter', rr.status === 403, rr.status);
    const rt = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.tl, undefined, multi({ note: 'x', joiningDate: future(10) }, PDF));
    check('B4b TL refused', rt.status === 403, rt.status);
    const bad1 = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.bde, undefined, multi({ joiningDate: future(10) }, PDF));
    check('B5 BDE on behalf needs a note', bad1.status === 400, [bad1.status, bad1.text.slice(0, 120)]);
    const bad2 = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.bde, undefined, multi({ note: 'mail', joiningDate: future(10) }, null));
    check('B5b a file is required', bad2.status === 400, bad2.status);
    const bad3 = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.bde, undefined, multi({ note: 'mail', joiningDate: future(10) }, TXT));
    check('B5c a fake PDF is refused', bad3.status === 400, [bad3.status, bad3.text.slice(0, 120)]);
    const bad4 = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.bde, undefined, multi({ note: 'mail', joiningDate: '2203-01-01' }, PDF));
    check('B5d a silly year is refused', bad4.status === 400, [bad4.status, bad4.text.slice(0, 120)]);
    const bad5 = await call('POST', `/api/ats/offers/${X1.a.id}/client-release`, T.bde2, undefined, multi({ note: 'mail', joiningDate: future(10) }, PDF));
    check('B5e another desk\'s BDE cannot release for this client', [403, 404].includes(bad5.status), bad5.status);

    // the client releases the offer in its portal
    const rel = await call('POST', `/api/portal/client/offers/${X1.a.id}/release`, T.client, undefined, multi({ joiningDate: future(14), designation: 'Lecturer', location: 'Hyderabad', validUntil: future(9), notes: 'Probation 3 months', offeredCtc: String(CTC) }, PDF));
    check('B6 client releases the offer letter (portal, OFFERS tick)', rel.status === 200 && rel.body.offer && rel.body.offer.statusCode === 'OFFER_RELEASED', [rel.status, rel.text.slice(0, 250)]);
    const noTick = await call('POST', `/api/portal/client/offers/${X2.a.id}/release`, T.clientView, undefined, multi({ joiningDate: future(14) }, PDF));
    check('B6b a client without the OFFERS tick is refused', noTick.status === 403, noTick.status);
    const otherCl = await call('POST', `/api/portal/client/offers/${X2.a.id}/release`, T.clientB, undefined, multi({ joiningDate: future(14) }, PDF));
    check('B6c another client cannot touch this candidate', otherCl.status === 404, otherCl.status);
    const t1 = await trackOf(X1.a.id);
    check('B7 record is stored; the application stays Selected', t1 && t1.offer.state === 'RELEASED' && t1.offer.releasedBy === 'client' && !t1.offer.onBehalf, t1 && t1.offer);
    const st1 = (await prisma.application.findUnique({ where: { id: X1.a.id } })).stage;
    check('B7b stage still SELECTED', st1 === 'SELECTED', st1);
    check('B8 bell to BDE TL, BDE, TL, recruiter - once each', (await bells(uBdeTl, 'offer released by')) === 1 && (await bells(uBde, 'offer released by')) === 1 && (await bells(uTl, 'offer released by')) === 1 && (await bells(uRec, 'offer released by')) === 1, [await bells(uBdeTl, 'offer released by'), await bells(uBde, 'offer released by'), await bells(uTl, 'offer released by'), await bells(uRec, 'offer released by')]);
    check('B8b nobody else (HR, Manager, Accounts)', (await bells(uHr, 'offer released by')) + (await bells(uMgr, 'offer released by')) + (await bells(uAcc, 'offer released by')) === 0);
    const n1b = await naOf(X1.a.id);
    check('B9 recruiter now owes "Share the offer" (due today)', n1b.action === 'Share the offer with the candidate' && n1b.ownerRole === 'Recruiter' && n1b.dueAt === today() && n1b.ownerUserId === uRec.id, n1b);
    const homeRec2 = await call('GET', '/api/dashboard/ats/home?fresh=1', T.rec);
    check('B9b recruiter "My tasks today" shows it', homeRec2.status === 200 && tasksOf(homeRec2).some((r) => r.action === 'Share the offer with the candidate' && / x1 /.test(r.candidate)), tasksOf(homeRec2).map((r) => [r.candidate, r.action]));

    // visibility of the structured fields
    const offBde = await call('GET', '/api/ats/offers?page=1&view=all&window=all', T.bde);
    const offBdeTl = await call('GET', '/api/ats/offers?page=1&view=all&window=all', T.bdeTl);
    const offRec = await call('GET', '/api/ats/offers?page=1&view=all&window=all', T.rec);
    const rowOf = (r) => (r.body.rows || []).find((x) => x.id === X1.a.id);
    check('B10 BDE sees the step, no CTC, no candidate contact', offBde.status === 200 && rowOf(offBde) && rowOf(offBde).clientTrack.state.code === 'OFFER_RELEASED' && !offBde.text.includes(String(CTC)) && !offBde.text.includes(SECRET.phone) && !offBde.text.includes('zz-ct-cand-x1'), [offBde.status, rowOf(offBde) && Object.keys(rowOf(offBde))]);
    check('B10b BDE TL the same', offBdeTl.status === 200 && !offBdeTl.text.includes(String(CTC)) && !offBdeTl.text.includes(SECRET.phone));
    check('B10c recruiter sees the CTC the client typed', offRec.status === 200 && offRec.text.includes(String(CTC)));
    const fBde = await call('GET', `/api/ats/offers/${X1.a.id}/client-letter/offer`, T.bde);
    check('B11 BDE can open the client\'s letter file (default switch ON)', fBde.status === 200 && /pdf/.test(fBde.type || ''), [fBde.status, fBde.type]);
    roleRow = await prisma.roleAccess.findUnique({ where: { role_product_moduleId: { role: 'BDE', product: 'ats', moduleId: 'interviews' } } }).catch(() => null);
    const saved = roleRow && roleRow.features ? JSON.parse(roleRow.features) : {};
    saved['Offer Letter Files'] = { view: false };
    await prisma.roleAccess.upsert({ where: { role_product_moduleId: { role: 'BDE', product: 'ats', moduleId: 'interviews' } }, create: { role: 'BDE', product: 'ats', moduleId: 'interviews', moduleEnabled: true, features: JSON.stringify(saved) }, update: { features: JSON.stringify(saved) } });
    let fOff = null;
    for (let i = 0; i < 12; i += 1) { fOff = await call('GET', `/api/ats/offers/${X1.a.id}/client-letter/offer`, T.bde); if (fOff.status === 403) break; await sleep(2500); }
    check('B11b Role Catalog switch OFF -> BDE cannot open the file', fOff.status === 403, fOff.status);
    if (roleRow) await prisma.roleAccess.update({ where: { id: roleRow.id }, data: { features: roleRow.features, moduleEnabled: roleRow.moduleEnabled } });
    else await prisma.roleAccess.deleteMany({ where: { role: 'BDE', product: 'ats', moduleId: 'interviews' } });
    roleRow = 'restored';
    const fRec = await call('GET', `/api/ats/offers/${X1.a.id}/client-letter/offer`, T.rec);
    check('B11c recruiter can open it', fRec.status === 200, fRec.status);

    // recruiter shares
    const sh = await call('POST', `/api/ats/offers/${X1.a.id}/share`, T.rec, { via: 'Email' });
    check('B12 recruiter shares by Email', sh.status === 200 && sh.body.url && /\/offer\/[a-f0-9]{64}$/.test(sh.body.url), [sh.status, sh.text.slice(0, 300)]);
    const app1 = await prisma.application.findUnique({ where: { id: X1.a.id } });
    check('B12b stage OFFER, offerStatus Offer Released', app1.stage === 'OFFER' && app1.offerStatus === 'Offer Released', [app1.stage, app1.offerStatus]);
    check('B12c the message names no client', !String(sh.body.text).includes('ZZTEST CT Client') && /offer letter/.test(sh.body.text), sh.body.text);
    const ev = await prisma.applicationStageEvent.count({ where: { applicationId: X1.a.id, action: { contains: 'Offer shared with the candidate' } } });
    check('B12d timeline entry written', ev >= 1, ev);
    const dupMsg = await prisma.candidateMessage.count({ where: { candidateId: X1.c.id, trigger: { contains: 'Stage change' }, template: 'OFFER' } });
    check('B12e no automatic "Offer extended" mail on top of the share', dupMsg === 0, dupMsg);
    const sh2 = await call('POST', `/api/ats/offers/${X1.a.id}/share`, T.rec, { via: 'Link' });
    check('B12f copy the link: same link, no second version', sh2.status === 200 && sh2.body.url === sh.body.url && (await prisma.offerVersion.count({ where: { applicationId: X1.a.id } })) === 1, [sh2.status]);
    const n1c = await naOf(X1.a.id);
    check('B12g now "Follow up on the offer answer" (recruiter)', n1c.action === 'Follow up on the offer answer' && n1c.ownerRole === 'Recruiter', n1c);
    const tok = sh.body.url.split('/offer/')[1];
    const pub = await call('GET', `/api/offer-link/${tok}`, null);
    check('B13 candidate page: "our client", the client\'s file, letter text without the client name', pub.status === 200 && pub.body.company === 'our client' && pub.body.clientFile && !String(pub.body.letter).includes('ZZTEST CT Client'), [pub.status, pub.text.slice(0, 300)]);
    const pf = await call('GET', `/api/offer-link/${tok}/client-file`, null);
    check('B13b candidate opens the client\'s file', pf.status === 200 && /pdf/.test(pf.type || ''), pf.status);

    // candidate accepts on the portal
    const acc = await call('POST', `/api/portal/candidate/applications/${X1.a.id}/offer`, T.cand, { decision: 'accept' });
    check('B14 candidate accepts', acc.status === 200, [acc.status, acc.text.slice(0, 200)]);
    const t1b = await trackOf(X1.a.id);
    check('B14b state ACCEPTED, stage OFFER_ACCEPTED', t1b.offer.state === 'ACCEPTED' && (await prisma.application.findUnique({ where: { id: X1.a.id } })).stage === 'OFFER_ACCEPTED');
    check('B14c bells to recruiter, TL, BDE, BDE TL and the client login', (await bells(uRec, 'accepted the offer')) >= 1 && (await bells(uTl, 'accepted the offer')) >= 1 && (await bells(uBde, 'accepted the offer')) === 1 && (await bells(uBdeTl, 'accepted the offer')) === 1 && (await bells(uClient, 'accepted the offer')) === 1);
    const mailAud = await prisma.auditLog.count({ where: { entity: 'ClientTrack', entityId: cA.contactEmail, action: { contains: 'accepted your offer' } } });
    check('B14d email to the client contact (captured by the sandbox transport)', mailAud === 1, mailAud);
    const cp = await call('GET', '/api/portal/client', T.client);
    const offX1 = cp.body && (cp.body.offers || []).find((o) => o.applicationId === X1.a.id);
    check('B15 client portal shows "Offer accepted", can acknowledge, no candidate contact', cp.status === 200 && offX1 && offX1.statusCode === 'OFFER_ACCEPTED' && offX1.canAcknowledge === true && !cp.text.includes(SECRET.phone) && !cp.text.includes('zz-ct-cand-x1') && !cp.text.includes(SECRET.currentSalary), [cp.status, offX1]);
    const cpv = await call('GET', '/api/portal/client', T.clientView);
    const offV = cpv.body && (cpv.body.offers || []).find((o) => o.applicationId === X1.a.id);
    check('B15b a VIEW-only client sees it but cannot act', offV && offV.canAcknowledge === false && offV.canReleaseJoining === false);
    const ackV = await call('POST', `/api/portal/client/offers/${X1.a.id}/acknowledge`, T.clientView);
    check('B15c VIEW-only acknowledge refused', ackV.status === 403, ackV.status);
    const cpB = await call('GET', '/api/portal/client', T.clientB);
    check('B15d another client does not see it', cpB.status === 200 && !(cpB.body.offers || []).some((o) => o.applicationId === X1.a.id));
    const n1d = await naOf(X1.a.id);
    check('B16 BDE owes "Confirm acceptance and send the joining letter" (waiting on client)', n1d.action === 'Confirm acceptance and send the joining letter' && n1d.ownerRole === 'BDE' && n1d.waitingOn === 'Client', n1d);
    const ack = await call('POST', `/api/portal/client/offers/${X1.a.id}/acknowledge`, T.client);
    check('B17 client acknowledges', ack.status === 200 && ack.body.offer.statusCode === 'CLIENT_ACKNOWLEDGED', [ack.status, ack.text.slice(0, 200)]);
    check('B17b BDE and BDE TL told', (await bells(uBde, 'acknowledged')) === 1 && (await bells(uBdeTl, 'acknowledged')) === 1);

    // joining letter
    const jr = await call('POST', `/api/portal/client/joining/${X1.a.id}/release`, T.client, undefined, multi({ joiningDate: today(), joiningTime: '09:30', place: 'Main campus', reportingPerson: 'Ms Rao', notes: 'Bring originals' }, PDF));
    check('B18 client releases the joining letter', jr.status === 200 && jr.body.offer.statusCode === 'JOINING_RELEASED', [jr.status, jr.text.slice(0, 200)]);
    const app1b = await prisma.application.findUnique({ where: { id: X1.a.id } });
    check('B18b Joining Scheduled with the letter\'s date', app1b.joiningStatus === 'Joining Scheduled' && app1b.joiningDate === today(), [app1b.joiningStatus, app1b.joiningDate]);
    check('B18c bells to BDE TL, BDE, TL, recruiter', (await bells(uBdeTl, 'joining letter released')) === 1 && (await bells(uBde, 'joining letter released')) === 1 && (await bells(uTl, 'joining letter released')) === 1 && (await bells(uRec, 'joining letter released')) === 1);
    const n1e = await naOf(X1.a.id);
    check('B18d recruiter owes "Share the joining letter" today', n1e.action === 'Share the joining letter with the candidate' && n1e.ownerRole === 'Recruiter' && n1e.dueAt === today(), n1e);
    const js = await call('POST', `/api/ats/joining/${X1.a.id}/share`, T.rec, { via: 'Email' });
    check('B19 recruiter shares the joining letter', js.status === 200 && /\/joining\/.+\.[a-f0-9]{48}$/.test(js.body.url || ''), [js.status, js.text.slice(0, 250)]);
    const jtok = js.body.url.split('/joining/')[1];
    const jp = await call('GET', `/api/joining-link/${jtok}`, null);
    check('B19b candidate joining page works, names no client', jp.status === 200 && jp.body.company === 'our client' && jp.body.open === true && !jp.text.includes('ZZTEST CT Client'), [jp.status, jp.text.slice(0, 200)]);
    check('B19c file opens', (await call('GET', `/api/joining-link/${jtok}/file`, null)).status === 200);
    check('B19d a changed token does nothing', (await call('GET', `/api/joining-link/${jtok.slice(0, -2)}aa`, null)).status === 404 && (await call('GET', '/api/joining-link/nope', null)).status === 404);
    check('B19e confirm needs the tick', (await call('POST', `/api/joining-link/${jtok}/confirm`, null, { name: 'Cand X' })).status === 400);
    const cf = await call('POST', `/api/joining-link/${jtok}/confirm`, null, { name: 'Cand X One', agree: true });
    check('B20 candidate confirms joining', cf.status === 200 && cf.body.status === 'Confirmed', [cf.status, cf.text.slice(0, 200)]);
    check('B20b bells to recruiter, TL, BDE, BDE TL, client; client mail', (await bells(uRec, 'confirmed joining')) === 1 && (await bells(uTl, 'confirmed joining')) === 1 && (await bells(uBde, 'confirmed joining')) === 1 && (await bells(uBdeTl, 'confirmed joining')) === 1 && (await bells(uClient, 'confirmed joining')) === 1 && (await prisma.auditLog.count({ where: { entity: 'ClientTrack', entityId: cA.contactEmail, action: { contains: 'confirmed joining' } } })) === 1);
    check('B20c a second confirm is refused', (await call('POST', `/api/joining-link/${jtok}/confirm`, null, { name: 'Cand X One', agree: true })).status === 409);
    const rd = await call('POST', '/api/ats/client-track/reminders/run', T.rec, { dryRun: true });
    check('B21 a recruiter cannot run reminders', rd.status === 403, rd.status);
    const rdA = await call('POST', '/api/ats/client-track/reminders/run', T.admin, { dryRun: true });
    check('B21b dry run (Admin) counts the joining-day reminder and writes nothing', rdA.status === 200 && rdA.body.joiningReminders >= 1 && !((await trackOf(X1.a.id)).reminded || {})['joining-t0:1'], [rdA.status, rdA.text.slice(0, 200)]);
    const st = await call('GET', '/api/ats/client-track/reminders', T.admin);
    check('B21c reminders are OFF by default', st.status === 200 && st.body.armed === false, st.body);

    // joined by the recruiter -> invoice draft, Accounts told once
    const jd = await call('POST', `/api/ats/joining/${X1.a.id}/joined`, T.rec, {});
    check('B22 recruiter marks Joined', jd.status === 200, [jd.status, jd.text.slice(0, 250)]);
    const inv = await prisma.invoice.findFirst({ where: { candidateId: X1.c.id, requirementId: rA.id } });
    check('B22b invoice draft exists (Pending, no number)', inv && inv.status === 'Pending' && !inv.invoiceNumber, inv && [inv.status, inv.invoiceNumber]);
    check('B22c Accounts told once', (await bells(uAcc, 'Invoice ready')) === 1, await bells(uAcc, 'Invoice ready'));
    const joBde = await call('GET', '/api/ats/joining?page=1&window=all', T.bde);
    const jrow = (joBde.body.rows || []).find((r) => r.id === X1.a.id);
    check('B23 BDE sees "Invoice: Draft" as a status, no amounts', jrow && jrow.clientTrack.invoice && jrow.clientTrack.invoice.label === 'Draft' && jrow.invoice && jrow.invoice.amount === undefined && jrow.invoice.total === undefined, jrow && [jrow.clientTrack, jrow.invoice]);
    const joRec = await call('GET', '/api/ats/joining?page=1&window=all', T.rec);
    const jrec = (joRec.body.rows || []).find((r) => r.id === X1.a.id);
    check('B23b recruiter: Joined, no invoice amounts', jrec && jrec.invoice && jrec.invoice.amount === undefined);
    const joAd = await call('GET', '/api/ats/joining?page=1&window=all', T.admin);
    const jad = (joAd.body.rows || []).find((r) => r.id === X1.a.id);
    check('B23c Admin sees the amounts', jad && jad.invoice && Number(jad.invoice.amount) > 0);
    check('B23d Accounts has no ATS offers screen', (await call('GET', '/api/ats/offers?page=1', T.acc)).status === 403);

    // X2: decline path with the BDE on behalf of the client
    const r2 = await call('POST', `/api/ats/offers/${X2.a.id}/client-release`, T.bde, undefined, multi({ note: 'Client emailed it on 13 Oct', joiningDate: future(20), designation: 'Teacher' }, PDF));
    check('C1 BDE records the client\'s letter on its behalf', r2.status === 200 && r2.body.track.offer.onBehalf === true, [r2.status, r2.text.slice(0, 200)]);
    const aud = await prisma.auditLog.count({ where: { entityId: X2.a.id, action: { contains: 'on behalf of the client' }, reason: { contains: 'Client emailed it' } } });
    check('C1b audited "on behalf of the client" with the note', aud === 1, aud);
    const s2 = await call('POST', `/api/ats/offers/${X2.a.id}/share`, T.rec, { via: 'Link' });
    check('C2 recruiter copies the link', s2.status === 200 && s2.body.url, [s2.status, s2.text.slice(0, 200)]);
    const dec = await call('POST', `/api/offer-link/${s2.body.url.split('/offer/')[1]}/decline`, null, { reason: 'Better offer elsewhere' });
    check('C3 candidate declines on the link', dec.status === 200, [dec.status, dec.text.slice(0, 200)]);
    const t2 = await trackOf(X2.a.id);
    check('C3b DECLINED with the reason; bells incl. client', t2.offer.state === 'DECLINED' && t2.offer.declineReason === 'Better offer elsewhere' && (await bells(uClient, 'declined the offer')) === 1 && (await bells(uBdeTl, 'declined the offer')) === 1 && (await bells(uBde, 'declined the offer')) === 1, t2.offer.state);
    const n2 = await naOf(X2.a.id);
    check('C3c after a decline the BDE chases again', n2.action === 'Chase the client for the offer letter' && n2.ownerRole === 'BDE', n2);
    const r2b = await call('POST', `/api/portal/client/offers/${X2.a.id}/release`, T.client, undefined, multi({ joiningDate: future(25) }, PDF));
    check('C4 the client releases a new letter after the decline', r2b.status === 200, [r2b.status, r2b.text.slice(0, 200)]);
    const t2b = await trackOf(X2.a.id);
    check('C4b history keeps the first letter', t2b.offer.state === 'RELEASED' && (t2b.offerHistory || []).length === 1 && t2b.offer.n === 2);
    const s2b = await call('POST', `/api/ats/offers/${X2.a.id}/share`, T.rec, { via: 'Link' });
    check('C4c shared again as version 2', s2b.status === 200 && (await prisma.offerVersion.count({ where: { applicationId: X2.a.id } })) === 2, s2b.status);

    // X3: the recruiter records the candidate's yes; the BDE records the client's confirmation and joining letter
    await call('POST', `/api/ats/offers/${X3.a.id}/client-release`, T.bde, undefined, multi({ note: 'by mail', joiningDate: future(7) }, PDF));
    await call('POST', `/api/ats/offers/${X3.a.id}/share`, T.rec, { via: 'Link' });
    const yes = await call('POST', `/api/ats/offers/${X3.a.id}/accept`, T.rec, {});
    check('D1 recruiter records "candidate said yes"', yes.status === 200, [yes.status, yes.text.slice(0, 150)]);
    check('D1b BDE not allowed to ack without a note, then allowed with one', (await call('POST', `/api/ats/offers/${X3.a.id}/client-ack`, T.bde, {})).status === 400 && (await call('POST', `/api/ats/offers/${X3.a.id}/client-ack`, T.bde, { note: 'Client replied on mail' })).status === 200);
    check('D1c recruiter cannot record the client\'s confirmation', (await call('POST', `/api/ats/offers/${X3.a.id}/client-ack`, T.rec, { note: 'x' })).status === 403);
    const jb = await call('POST', `/api/ats/joining/${X3.a.id}/client-release`, T.bde, undefined, multi({ note: 'by mail', joiningDate: future(7), joiningTime: '10:00' }, PDF));
    check('D2 BDE records the joining letter on the client\'s behalf', jb.status === 200, [jb.status, jb.text.slice(0, 200)]);
    check('D2b recruiter records the candidate\'s confirmation', (await call('POST', `/api/ats/joining/${X3.a.id}/share`, T.rec, { via: 'Link' })).status === 200 && (await call('POST', `/api/ats/joining/${X3.a.id}/candidate-confirm`, T.rec, {})).status === 200);
    const jcl = await call('POST', `/api/portal/client/joining/${X3.a.id}/joined`, T.client);
    check('D3 client cannot mark Joined before the joining date', jcl.status === 409, [jcl.status, jcl.text.slice(0, 150)]);

    // a candidate / staff cannot use client routes
    check('E1 candidate cannot use the staff release route', [403, 404].includes((await call('POST', `/api/ats/offers/${XB.a.id}/client-release`, T.cand, undefined, multi({ note: 'x' }, PDF))).status));
    check('E2 candidate cannot use the client portal release', (await call('POST', `/api/portal/client/offers/${XB.a.id}/release`, T.cand, undefined, multi({ joiningDate: future(5) }, PDF))).status === 403);
    check('E3 a staff login cannot use the client portal release', (await call('POST', `/api/portal/client/offers/${XB.a.id}/release`, T.bde, undefined, multi({ joiningDate: future(5) }, PDF))).status === 403);
    const lv = await call('GET', '/api/ats/offers?page=1&view=client&window=all', T.rec);
    check('E4 Offers tab "client" lists waiting rows, "prepare" none of the client ones', lv.status === 200 && (lv.body.rows || []).some((r) => r.id === XB.a.id) && !(await call('GET', '/api/ats/offers?page=1&view=prepare&window=all', T.rec)).body.rows.some((r) => r.id === XB.a.id));
  } catch (e) { fail += 1; console.log('FAIL  exception', e && e.stack); } finally {
    try {
      if (switchRow) await prisma.appSetting.update({ where: { key: 'interview-reminders' }, data: { value: switchRow.value } });
      else await prisma.appSetting.deleteMany({ where: { key: 'interview-reminders' } });
      if (roleRow && roleRow !== 'restored') await prisma.roleAccess.update({ where: { id: roleRow.id }, data: { features: roleRow.features } });
      await prisma.appSetting.deleteMany({ where: { OR: made.apps.map((id) => ({ key: `client-track:${id}` })).concat([{ key: 'zz-none' }]) } });
      await prisma.offerVersion.deleteMany({ where: { applicationId: { in: made.apps } } });
      await prisma.invoice.deleteMany({ where: { candidateId: { in: made.cands } } });
      await prisma.candidateMessage.deleteMany({ where: { candidateId: { in: made.cands } } });
      await prisma.applicationFollowUp.deleteMany({ where: { applicationId: { in: made.apps } } });
      await prisma.applicationStageEvent.deleteMany({ where: { applicationId: { in: made.apps } } });
      await prisma.applicationStageEvent.deleteMany({ where: { candidateId: { in: made.cands } } });
      await prisma.application.deleteMany({ where: { id: { in: made.apps } } });
      const ids = [...made.apps, ...made.cands, ...made.reqs, ...made.clients, ...made.users];
      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: made.users } }, { entityId: { in: ids } }, { entity: 'ClientTrack', entityId: { contains: 'example.test' } }] } });
      await prisma.notification.deleteMany({ where: { userId: { in: made.users } } });
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } });
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
    } catch (e) { console.log('cleanup problem:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await prisma.$disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
