#!/usr/bin/env node
// ---------------------------------------------------------------------------
// BDE TEAM RIGHTS (founder, 2026-10-16) - COPY DATABASE ONLY.
//
//   cd backend
//   COPY_DB=C:/tmp/bde-copy.db node scripts/bde-team-rights-test.js      (a VACUUM INTO copy; never prisma/dev.db)
//
// Starts its OWN throw-away API process (port 4094, TEST_MODE=1) on the copy and checks, through the real routes:
//   D  Delete a requirement / a client / an agreement Drive link: the whole BDE team (desk BDE inside their own desk, BDE TL anywhere);
//      never TL / STL / Recruiter / HR; the guards stay (people / invoices / records); an audit row is written
//   O  Open and close an agreement (close = expire, open again = reopen / activate): BDE team yes, TL / Recruiter no,
//      another desk's BDE no
//   L  Bulk agreement links: the BDE team may add / mark / remove, a TL may not
//   J  Job form: every active department is offered to Admin and the BDE team (only them); full edit of every field,
//      the client and job type included, for Admin and the BDE team (an invoice on the job keeps the client); a TL / HR cannot
//   W  No stored status reads "Draft" in the words people see
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
const PORT = Number(process.env.TEST_PORT || 4094);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const RUN = Date.now().toString(36);
const made = { users: [], emps: [], clients: [], reqs: [], apps: [], cands: [], invoices: [] };

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const refused = (r) => [401, 403, 404].includes(r.status);

(async () => {
  let server;
  try {
    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let log = ''; server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await new Promise((r) => setTimeout(r, 1000)); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }

    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, status: 'Active' };
    const mk = async (tag, extra, empExtra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST BTR ${tag} ${RUN}`, email: `zz-btr-${tag}-${RUN}@example.test`, username: `zz-btr-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-BTR-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const uAdmin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uBdeTl = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uBdeEdu = await mk('bdeedu', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uBdeMed = await mk('bdemed', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: uBdeTl.name });
    const uTlEdu = await mk('tledu', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const uRecEdu = await mk('recedu', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uHr = await mk('hr', { role: 'EMPLOYEE', atsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' }, {});
    const T = {};
    for (const [k, u] of Object.entries({ admin: uAdmin, bdeTl: uBdeTl, bdeEdu: uBdeEdu, bdeMed: uBdeMed, tlEdu: uTlEdu, recEdu: uRecEdu, hr: uHr })) T[k] = await tokenOf(u);

    const mkClient = async (tag, dept, bde, extra = {}) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST BTR Client ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: bde ? bde.name : null, clientType: 'Client', ...extra } });
      made.clients.push(c.id); return c;
    };
    const mkReq = async (tag, client, dept, extra = {}) => {
      const r = await prisma.requirement.create({ data: { title: `ZZTEST BTR Job ${tag} ${RUN}`, clientId: client.id, status: 'OPEN', department: dept, openings: 1, ...extra } });
      made.reqs.push(r.id); return r;
    };
    const mkApp = async (req) => {
      const c = await prisma.candidate.create({ data: { name: `ZZTEST BTR Cand ${RUN}`, email: `zz-btr-c-${RUN}@example.test`, phone: '9000000088', location: 'ZZ' } });
      made.cands.push(c.id);
      const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: req.id, stage: 'WITH_BDE' } });
      made.apps.push(a.id); return a;
    };
    const cEdu = await mkClient('edu', 'Education', uBdeEdu, { agreementStatus: 'ACTIVE', agreementSignedAt: new Date(), agreementActivatedAt: new Date() });
    const cMed = await mkClient('med', 'Medical', uBdeMed);

    // ------------------------------------------------------------------ D: delete a job
    const j1 = await mkReq('del-bde', cEdu, 'Education');
    let r = await http('DELETE', `/api/requirements/${j1.id}`, T.recEdu);
    check('D1 a Recruiter cannot delete a job', refused(r), r);
    r = await http('DELETE', `/api/requirements/${j1.id}`, T.tlEdu);
    check('D2 a TL cannot delete a job', refused(r), r);
    r = await http('DELETE', `/api/requirements/${j1.id}`, T.hr);
    check('D3 HR cannot delete a job', refused(r), r);
    r = await http('DELETE', `/api/requirements/${j1.id}`, T.bdeMed);
    check('D4 a BDE of another desk cannot delete it', refused(r), r);
    r = await http('GET', `/api/requirements/${j1.id}/lifecycle`, T.bdeEdu);
    check('D5 the desk BDE is shown the Delete button for an empty job', r.status === 200 && r.body && r.body.rights && r.body.rights.delete === true, r.body && r.body.rights);
    r = await http('DELETE', `/api/requirements/${j1.id}`, T.bdeEdu);
    check('D6 the desk BDE deletes an empty job of their own desk', r.status === 200 && r.body && r.body.ok, r);
    check('D7 the job is gone', !(await prisma.requirement.findUnique({ where: { id: j1.id } })));
    const aud = await prisma.auditLog.findFirst({ where: { entity: 'Requirement', entityId: j1.id, action: 'Requirement deleted' } });
    check('D8 an audit row says who deleted it', !!aud && aud.userId === uBdeEdu.id, aud);

    const j2 = await mkReq('del-people', cEdu, 'Education'); await mkApp(j2);
    r = await http('DELETE', `/api/requirements/${j2.id}`, T.bdeEdu);
    check('D9 a job with people on it is still refused (409, close it instead)', r.status === 409, r);
    const j3 = await mkReq('del-tl', cMed, 'Medical');
    r = await http('DELETE', `/api/requirements/${j3.id}`, T.bdeTl);
    check('D10 the BDE team lead deletes any client job (no people)', r.status === 200, r);

    // ------------------------------------------------------------------ D: delete a client
    const cDelEdu = await mkClient('del-edu', 'Education', uBdeEdu);
    const delBody = (c) => ({ confirmName: c.name, reason: 'ZZTEST delete rights' });
    r = await http('DELETE', `/api/clients/${cDelEdu.id}`, T.recEdu, delBody(cDelEdu));
    check('D11 a Recruiter cannot delete a client', refused(r), r);
    r = await http('DELETE', `/api/clients/${cDelEdu.id}`, T.tlEdu, delBody(cDelEdu));
    check('D12 a TL cannot delete a client', refused(r), r);
    r = await http('DELETE', `/api/clients/${cDelEdu.id}`, T.bdeMed, delBody(cDelEdu));
    check('D13 a BDE of another desk cannot delete it', refused(r), r);
    r = await http('DELETE', `/api/clients/${cDelEdu.id}`, T.bdeEdu, { confirmName: 'wrong name', reason: 'x y z' });
    check('D14 the typed-name check stays', r.status === 400, r);
    r = await http('DELETE', `/api/clients/${cDelEdu.id}`, T.bdeEdu, delBody(cDelEdu));
    check('D15 the desk BDE deletes an empty client of their own desk', r.status === 200 && r.body && r.body.ok, r);
    check('D16 the client is gone and an audit row exists', !(await prisma.client.findUnique({ where: { id: cDelEdu.id } })) && !!(await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: cDelEdu.id, action: 'Client deleted (permanent)' } })));
    r = await http('DELETE', `/api/clients/${cEdu.id}`, T.bdeEdu, delBody(cEdu));
    const withJob = await mkReq('guard', cEdu, 'Education');
    r = await http('DELETE', `/api/clients/${cEdu.id}`, T.bdeEdu, { ...delBody(cEdu), confirmSignedAgreement: true });
    check('D17 a client that has jobs is refused (409): the guard stays', r.status === 409, r);

    // ------------------------------------------------------------------ O: open / close an agreement
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/expire`, T.tlEdu, { reason: 'x' });
    check('O1 a TL cannot close an agreement', refused(r), r);
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/expire`, T.recEdu, {});
    check('O2 a Recruiter cannot close an agreement', refused(r), r);
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/expire`, T.bdeMed, {});
    check('O3 a BDE of another desk cannot close it', refused(r), r);
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/expire`, T.bdeEdu, { reason: 'ZZTEST closing' });
    check('O4 the desk BDE closes the agreement', r.status === 200 && r.body && r.body.agreementStatus === 'EXPIRED', r);
    check('O5 the close is audited', !!(await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: cEdu.id, action: 'Agreement expired', userId: uBdeEdu.id } })));
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/reopen`, T.recEdu, {});
    check('O6 a Recruiter cannot open it again', refused(r), r);
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/reopen`, T.bdeTl, { reason: 'ZZTEST reopen' });
    check('O7 the BDE team lead opens it again', r.status === 200 && r.body && r.body.agreementStatus === 'ACTIVE', r);
    check('O8 the reopen is audited', !!(await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: cEdu.id, action: 'Agreement reopened', userId: uBdeTl.id } })));
    r = await http('POST', `/api/clients/${cEdu.id}/agreement/reopen`, T.bdeEdu, {});
    check('O9 an agreement that is not ended cannot be reopened (400)', r.status === 400, r);
    const cNever = await mkClient('never', 'Education', uBdeEdu, { agreementStatus: 'EXPIRED' });
    r = await http('POST', `/api/clients/${cNever.id}/agreement/reopen`, T.bdeEdu, {});
    check('O10 a never-signed agreement cannot be reopened (409, make a new one)', r.status === 409, r);
    const cSigned = await mkClient('signed', 'Education', uBdeEdu, { agreementStatus: 'SIGNED', agreementSignedAt: new Date() });
    r = await http('POST', `/api/clients/${cSigned.id}/agreement/activate`, T.tlEdu, {});
    check('O11 a TL cannot open (activate) an agreement', refused(r), r);
    r = await http('POST', `/api/clients/${cSigned.id}/agreement/activate`, T.bdeEdu, {});
    check('O12 the desk BDE opens (activates) a signed agreement', r.status === 200 && r.body && r.body.agreementStatus === 'ACTIVE', r);

    // ------------------------------------------------------------------ L: agreement Drive links
    r = await http('GET', '/api/clients/agreement-links/rights', T.bdeEdu);
    check('L1 the desk BDE may add and remove agreement links', r.status === 200 && r.body && r.body.canAdd === true && r.body.canRemove === true, r.body);
    r = await http('GET', '/api/clients/agreement-links/rights', T.bdeTl);
    check('L2 the BDE team lead may add and remove agreement links', r.status === 200 && r.body && r.body.canAdd === true && r.body.canRemove === true, r.body);
    r = await http('GET', '/api/clients/agreement-links/rights', T.tlEdu);
    check('L3 a TL may not add links', r.status === 200 && r.body && r.body.canAdd === false || refused(r), r.body);
    r = await http('GET', '/api/clients/agreement-links/rights', T.recEdu);
    check('L4 a Recruiter may not add links', (r.body && r.body.canAdd === false) || refused(r), r.body);
    const cLink = await mkClient('link', 'Education', uBdeEdu);
    r = await http('POST', `/api/clients/${cLink.id}/agreement-links`, T.bdeEdu, { link: 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789/view', agreementDate: '2026-04-01', endDate: '2027-03-31', markSigned: false });
    check('L5 the desk BDE adds a Drive link to a client of their desk', r.status === 201, r);
    const doc = await prisma.clientDocument.findFirst({ where: { clientId: cLink.id, kind: 'AGREEMENT_LINK' } }).catch(() => null);
    const docId = (r.body && r.body.link && r.body.link.id) || (doc && doc.id);
    r = await http('DELETE', `/api/clients/${cLink.id}/agreement-links/${docId}`, T.bdeMed, { reason: 'x' });
    check('L6 a BDE of another desk cannot remove it', refused(r), r);
    r = await http('DELETE', `/api/clients/${cLink.id}/agreement-links/${docId}`, T.tlEdu, { reason: 'x' });
    check('L7 a TL cannot remove it', refused(r), r);
    r = await http('DELETE', `/api/clients/${cLink.id}/agreement-links/${docId}`, T.bdeEdu, { reason: 'ZZTEST' });
    check('L8 the desk BDE removes the link', r.status === 200, r);
    check('L9 the removal is audited', !!(await prisma.auditLog.findFirst({ where: { entity: 'Client', entityId: cLink.id, action: 'Agreement Drive link removed', userId: uBdeEdu.id } })));

    // ------------------------------------------------------------------ J: the job form
    const names = (await prisma.department.findMany({ where: { active: true }, select: { name: true } }).catch(() => prisma.department.findMany({ select: { name: true } }))).map((d) => d.name);
    for (const [who, tok] of [['Admin', T.admin], ['the desk BDE', T.bdeEdu], ['the BDE team lead', T.bdeTl]]) {
      r = await http('GET', '/api/requirements/department-options', tok);
      const got = (r.body && r.body.departments) || [];
      check(`J1 ${who} is offered every department (${names.length})`, r.status === 200 && names.every((n) => got.includes(n)) && got.includes('BDE'), { got, names });
    }
    r = await http('GET', '/api/requirements/department-options', T.tlEdu);
    check('J2 a TL keeps their own list (the server sends none)', r.status === 200 && r.body && r.body.departments === null, r.body);
    r = await http('GET', '/api/requirements/department-options', T.hr);
    check('J3 HR keeps their own list', r.status === 200 && r.body && r.body.departments === null, r.body);

    const cEdu2 = await mkClient('edu2', 'Education', uBdeEdu, { agreementStatus: 'ACTIVE' });
    const cInactive = await mkClient('noagr', 'Education', uBdeEdu, { agreementStatus: 'DRAFT' });
    const jf = await mkReq('full', cEdu2, 'Education', { status: 'SOURCING', skills: 'Java', location: 'Hyderabad', tlId: uTlEdu.id, tl: uTlEdu.name }); await mkApp(jf);
    r = await http('GET', `/api/requirements/${jf.id}`, T.bdeEdu);
    check('J4 the job page tells the BDE team they may edit everything', r.status === 200 && r.body && r.body.permissions && r.body.permissions.fullEdit === true, r.body && r.body.permissions);
    r = await http('GET', `/api/requirements/${jf.id}`, T.tlEdu);
    check('J5 a TL is not given full edit', r.status === 200 && r.body && r.body.permissions && !r.body.permissions.fullEdit, r.body && r.body.permissions);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.bdeEdu, { title: `ZZTEST BTR Job full ${RUN} v2`, skills: 'Java, Spring', openings: 4, priority: 'High', location: 'Pune', departments: ['Education', 'Medical'], salary: '10-12 LPA' });
    check('J6 the desk BDE edits a job that is Sourcing and has a candidate', r.status === 200 && r.body && !r.body.unchanged && (r.body.changedFields || []).length >= 4, r);
    const aft = await prisma.requirement.findUnique({ where: { id: jf.id } });
    check('J7 the values really changed', aft.openings === 4 && aft.location === 'Pune' && aft.title.endsWith('v2'), aft);
    check('J8 the changed fields are in the audit log', (await prisma.auditLog.count({ where: { entity: 'Requirement', entityId: jf.id, action: 'Requirement field changed' } })) >= 4);
    const appStage = await prisma.application.findFirst({ where: { requirementId: jf.id } });
    check('J9 the candidate on the job keeps their step', appStage && appStage.stage === 'WITH_BDE', appStage);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.bdeEdu, { clientId: cInactive.id });
    const afterMove = await prisma.requirement.findUnique({ where: { id: jf.id } });
    check('J10 the desk BDE moves the job to another client of theirs', r.status === 200 && afterMove.clientId === cInactive.id, r);
    check('J11 a live job moved to a client whose agreement is not Active goes back to waiting for the agreement (never live around the gate)', afterMove.status === 'AGREEMENT_CHECK', afterMove.status);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.bdeEdu, { clientId: cMed.id });
    check('J12 a client of another desk is refused', [403, 404].includes(r.status), r);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.bdeEdu, { internal: true });
    const asInternal = await prisma.requirement.findUnique({ where: { id: jf.id } });
    check('J13 the BDE team cannot make a job TeamLink\'s own job (an Admin does that)', r.status === 403 && asInternal.internal === false, r);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.admin, { internal: true });
    const asInternal2 = await prisma.requirement.findUnique({ where: { id: jf.id } });
    check('J13b an Admin can change the job type to TeamLink\'s own job', r.status === 200 && asInternal2.internal === true && !asInternal2.bdeId, r);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.admin, { internal: false, clientId: cEdu2.id });
    check('J14 ...and back to a client job', r.status === 200, r);
    let inv = null;
    try {
      inv = await prisma.invoice.create({ data: { requirementId: jf.id, clientId: cEdu2.id, invoiceNumber: `ZZTEST-INV-${RUN}`, status: 'Pending', amount: 1000, invoiceDate: '2026-10-01' } });
      made.invoices.push(inv.id);
    } catch (e) { console.log('NOTE  could not build an invoice fixture for J15:', String(e.message).split('\n').pop().slice(0, 140)); }
    if (inv) {
      r = await http('PUT', `/api/requirements/${jf.id}`, T.bdeEdu, { clientId: cInactive.id });
      check('J15 a job that already has an invoice keeps its client (409, plain words)', r.status === 409, r);
    }
    r = await http('PUT', `/api/requirements/${jf.id}`, T.tlEdu, { clientId: cInactive.id, title: 'ZZTEST should not apply' });
    const tlTry = await prisma.requirement.findUnique({ where: { id: jf.id } });
    check('J16 a TL cannot change the client (their limits stay)', tlTry.clientId === cEdu2.id && tlTry.title !== 'ZZTEST should not apply', [r.status, tlTry.clientId]);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.admin, { skills: 'Java, Spring, SQL' });
    check('J17 Admin edits too', r.status === 200, r);
    r = await http('PUT', `/api/requirements/${jf.id}`, T.recEdu, { skills: 'x' });
    check('J18 a Recruiter cannot edit the job', refused(r), r);

    // ------------------------------------------------------------------ K: a candidate named in the "Good fit" list
    const fitCand = await prisma.candidate.create({ data: { name: `ZZTEST BTR Fit ${RUN}`, email: `zz-btr-fit-${RUN}@example.test`, phone: '9000000099', currentSalary: '7L', expectedSalary: '9L', skills: 'Java', location: 'Pune', experienceYears: 3 } });
    made.cands.push(fitCand.id);
    r = await http('GET', `/api/candidates/${fitCand.id}`, T.bdeEdu);
    check('K1 (the cause) the full candidate page refuses a BDE for a person who is in no pipeline yet', r.status === 403, r);
    r = await http('GET', `/api/candidates/${fitCand.id}/limited`, T.bdeEdu);
    check('K2 the desk BDE gets the limited view', r.status === 200 && r.body && r.body.limited === true && r.body.name.startsWith('ZZTEST BTR Fit') && r.body.skills === 'Java', r);
    check('K3 the limited view has NO phone, email or salary', !/9000000099|zz-btr-fit|7L|9L|currentSalary|expectedSalary|"phone"|"email"/.test(r.text), r.text);
    r = await http('GET', `/api/candidates/${fitCand.id}/limited`, T.bdeTl);
    check('K4 the BDE team lead gets it too', r.status === 200 && r.body && r.body.limited === true, r);
    r = await http('GET', `/api/candidates/${fitCand.id}/limited`, T.tlEdu);
    check('K5 a TL does not get the limited view', refused(r), r);
    r = await http('GET', `/api/candidates/${fitCand.id}/limited`, T.recEdu);
    check('K6 a Recruiter does not get the limited view', refused(r), r);

    // ------------------------------------------------------------------ W: no "Draft" in the words people see
    const AWF = require(path.join(BACK, 'src/utils/agreementWorkflow'));
    const V = require(path.join(BACK, 'src/utils/atsVocab'));
    const words = [AWF.labelOf('DRAFT', {}), AWF.labelOf('x', {}), V.AGREEMENT_STATUS_LABELS.DRAFT, V.REQUIREMENT_STATUS_LABELS.DRAFT, require(path.join(BACK, 'src/utils/partners')).PAYOUT_WORDS.Draft, require(path.join(BACK, 'src/utils/requirementDisplayStatus')).userLabel('DRAFT'), require(path.join(BACK, 'src/utils/creditNotes')).STATUS.join(' ')];
    check('W1 the backend words for a not-yet-live item never say Draft (except the stored credit-note code)', words.slice(0, 6).every((w) => !/draft/i.test(String(w))), words);
    r = await http('POST', '/api/requirements/zz-none/copy', T.admin, {});
    check('W2 (sanity) the server answers', r.status > 0);
  } catch (e) {
    fail += 1; console.error('TEST CRASHED', e);
  } finally {
    // clean every ZZTEST row
    try {
      await prisma.invoice.deleteMany({ where: { id: { in: made.invoices } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { id: { in: made.apps } } }).catch(() => {});
      await prisma.application.deleteMany({ where: { requirementId: { in: made.reqs } } }).catch(() => {});
      await prisma.candidate.deleteMany({ where: { id: { in: made.cands } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { id: { in: made.reqs } } }).catch(() => {});
      await prisma.requirement.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => {});
      await prisma.clientDocument.deleteMany({ where: { clientId: { in: made.clients } } }).catch(() => {});
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } }).catch(() => {});
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } }).catch(() => {});
      await prisma.user.deleteMany({ where: { id: { in: made.users } } }).catch(() => {});
    } catch { /* copy only */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
