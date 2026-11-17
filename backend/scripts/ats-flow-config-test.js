#!/usr/bin/env node
/**
 * ATS FLOW SETTINGS (founder ATS audit 2026-11-17, Mandatory): admin-renamed stages, custom sub-statuses, "Reject requirement" with a
 * reason (and re-submit), the checklist before a profile goes to the client, and the fee type on joining invoices (fixed / slab).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> [TEST_PORT=4131] node scripts/ats-flow-config-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-flowcfg-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4131;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'flowcfg-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 600)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.31.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const err = (r) => (r ? [r.status, r.body && (r.body.error || r.body.code)] : 'none');
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const RUN = `${P}${Date.now().toString(36).slice(-4)}`;

(async () => {
  const DEPT = 'IT';
  const mk = async (tag, data, emp) => {
    const u = await prisma.user.create({
      data: {
        name: `ZZ Flow ${tag} ${RUN}`, email: `zz-flow-${tag}-${RUN}@example.test`, username: `zz-flow-${tag}-${RUN}@example.test`, passwordHash: 'x', status: 'Active',
        hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3), ...data,
      },
    });
    if (emp) await prisma.employee.create({ data: { employeeCode: `ZZ-FL-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: data.atsDepartment || null, email: u.email, ...emp } });
    return u;
  };
  const SA = await mk('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' });
  const BDETL = await mk('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL', department: 'BDE' });
  const BDE = await mk('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: `BDE,${DEPT}` }, { tl: BDETL.name, department: 'BDE' });
  const TL = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { designation: 'TL', department: DEPT });
  const REC = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: DEPT, atsScopeDepartments: DEPT }, { tl: TL.name, department: DEPT });

  const client = await prisma.client.create({ data: { name: `ZZ Flow Client ${RUN}`, agreementStatus: 'ACTIVE', bdeOwner: BDE.name, ownerDepartment: DEPT, industry: 'Information Technology', contactName: 'ZZ Person', contactEmail: `zz-flow-cl-${RUN}@example.test`, contactPhone: '9000000131', agreementFeePercent: 8.33, status: 'Active' } });
  const job = await prisma.requirement.create({ data: { title: `ZZ Flow Java Dev ${RUN}`, clientId: client.id, department: DEPT, status: 'OPEN', bdeId: BDE.id, tlId: TL.id, tl: TL.name, recruiterId: REC.id, internal: false, hiringType: 'Client Placement', description: 'ZZ flow test', openings: 2 } });
  const person = async (tag, extra = {}) => prisma.candidate.create({ data: { name: `ZZ Flow ${tag} ${RUN}`, phone: `7${String(Math.floor(Math.random() * 1e9)).padStart(9, '3')}`, email: `zz-flow-${tag}-${RUN}@example.test`, currentSalary: '600000', expectedSalary: '800000', noticePeriod: '30 Days', resumeName: `zz-${tag}.pdf`, consentStatus: 'GIVEN', ...extra } });
  const appAt = async (cand, stage) => prisma.application.create({ data: { candidateId: cand.id, requirementId: job.id, stage } });

  // another server already on this port would answer with a different secret (every call 401): say so instead
  if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { console.log(`FAIL  port ${PORT} is already in use - set TEST_PORT to a free port`); await stop(1); return; }
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  let up = false;
  for (let i = 0; i < 240; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) { up = true; break; }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  if (!up) { console.log('FAIL  the sandbox server did not answer /api/health'); await stop(1); return; }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (u) => jwt.sign({ ...tokenPayload(await resolveIdentity(u.id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const T = { sa: await tok(SA), bdeTl: await tok(BDETL), bde: await tok(BDE), tl: await tok(TL), rec: await tok(REC) };
  const C = (m, p, who, body) => call(m, p, body, T[who]);

  // =============================== 1. stage names
  console.log('\n--- 1. Stage names');
  const NEW_NAME = `Interview fixed ${RUN}`;
  const l0 = await C('GET', '/ats/stage-labels', 'rec');
  check('everyone reads the stage names (built-in words first)', l0.status === 200 && l0.body.labels.INTERVIEW_SCHEDULED === 'Interview booked' && l0.body.codes.includes('HIRED'), err(l0));
  check('a recruiter cannot rename a stage (403)', (await C('PUT', '/ats/stage-labels', 'rec', { labels: { INTERVIEW_SCHEDULED: 'Hack' } })).status === 403);
  check('a BDE TL cannot rename a stage either (403)', (await C('PUT', '/ats/stage-labels', 'bdeTl', { labels: { INTERVIEW_SCHEDULED: 'Hack' } })).status === 403);
  check('an unknown stage code is refused (codes are never added)', (await C('PUT', '/ats/stage-labels', 'sa', { labels: { MY_NEW_STAGE: 'Mine' } })).status === 400);
  check('two stages cannot share a name', (await C('PUT', '/ats/stage-labels', 'sa', { labels: { INTERVIEW_SCHEDULED: 'Selected' } })).status === 400);
  const rn = await C('PUT', '/ats/stage-labels', 'sa', { labels: { INTERVIEW_SCHEDULED: NEW_NAME } });
  check('the Admin renames "Interview booked"', rn.status === 200 && rn.body.labels.INTERVIEW_SCHEDULED === NEW_NAME && rn.body.renamed.includes('INTERVIEW_SCHEDULED'), err(rn));
  const audit1 = await prisma.auditLog.findFirst({ where: { action: 'Stage name changed', entityId: 'INTERVIEW_SCHEDULED' }, orderBy: { createdAt: 'desc' } });
  check('the rename is audited (old -> new)', !!audit1 && audit1.fromValue === 'Interview booked' && audit1.toValue === NEW_NAME, audit1);
  check('GET /ats/stage-labels (recruiter) says the new name', (await C('GET', '/ats/stage-labels', 'rec')).body.labels.INTERVIEW_SCHEDULED === NEW_NAME);
  const CI = await person('iv');
  const appIv = await appAt(CI, 'INTERVIEW_SCHEDULED');
  const cd = await C('GET', `/candidates/${CI.id}`, 'sa');
  const cdApp = cd.body && (cd.body.applications || []).find((a) => a.id === appIv.id);
  check('the candidate profile names the stage with the new name', cd.status === 200 && !!cdApp && cdApp.stageLabel === NEW_NAME, [err(cd), cdApp && cdApp.stageLabel]);
  const stCand = await C('GET', `/candidates/${CI.id}`, 'sa');
  check('...and the person\'s "current stage" too', stCand.body && (stCand.body.currentStageLabel === NEW_NAME || (stCand.body.candidate && stCand.body.candidate.currentStageLabel === NEW_NAME) || JSON.stringify(stCand.body).includes(NEW_NAME)), stCand.body && stCand.body.currentStageLabel);
  const tt = await C('GET', `/requirements/${job.id}`, 'sa');
  check('the requirement page\'s refusal / step words come from the same list (code stays INTERVIEW_SCHEDULED)', tt.status === 200 && (tt.body.applications || []).some((a) => a.id === appIv.id && a.stage === 'INTERVIEW_SCHEDULED'), err(tt));
  const words = await C('POST', `/candidates/applications/${appIv.id}/return`, 'tl', { reason: 'zz flow test' });
  check('a server message names the stage with the new name too ("this one is at ...")', words.status === 409 && (words.body.error || '').includes(NEW_NAME), err(words));

  // =============================== 2. sub-statuses
  console.log('\n--- 2. Sub-statuses');
  check('a recruiter cannot add a sub-status (403)', (await C('POST', '/ats/sub-statuses', 'rec', { stage: 'INTERVIEW_SCHEDULED', label: '2nd round' })).status === 403);
  const s1 = await C('POST', '/ats/sub-statuses', 'sa', { stage: 'INTERVIEW_SCHEDULED', label: '2nd round', order: 2 });
  const s2 = await C('POST', '/ats/sub-statuses', 'sa', { stage: 'INTERVIEW_SCHEDULED', label: 'Technical round', order: 1 });
  const s3 = await C('POST', '/ats/sub-statuses', 'sa', { stage: 'INTERVIEW_SCHEDULED', label: 'HR round', order: 3 });
  const sOther = await C('POST', '/ats/sub-statuses', 'sa', { stage: 'CLIENT_REVIEW', label: 'Waiting for hiring manager' });
  check('the Admin adds sub-statuses under "Interview booked" (and one under Client checking)', [s1, s2, s3, sOther].every((r) => r.status === 201), [s1, s2, s3, sOther].map(err));
  check('the same name twice under one stage is refused', (await C('POST', '/ats/sub-statuses', 'sa', { stage: 'INTERVIEW_SCHEDULED', label: '2nd Round' })).status === 409);
  const lst = await C('GET', '/ats/stage-labels', 'bde');
  const order = (lst.body.subStatuses.INTERVIEW_SCHEDULED || []).map((s) => s.label);
  check('they come back in the Admin\'s order', JSON.stringify(order) === JSON.stringify(['Technical round', '2nd round', 'HR round']), order);
  const bdeSet = await C('PUT', `/ats/applications/${appIv.id}/sub-status`, 'bde', { subStatusId: s1.body.id });
  check('the BDE (owner of "Interview booked") sets "2nd round"', bdeSet.status === 200 && bdeSet.body.subStatus && bdeSet.body.subStatus.label === '2nd round', err(bdeSet));
  const recSet = await C('PUT', `/ats/applications/${appIv.id}/sub-status`, 'rec', { subStatusId: s3.body.id });
  check('the recruiter (not the stage owner) is refused (403)', recSet.status === 403 && recSet.body.code === 'NOT_STAGE_OWNER', err(recSet));
  const tlSet = await C('PUT', `/ats/applications/${appIv.id}/sub-status`, 'tl', { subStatusId: s3.body.id });
  check('the TL (not the stage owner) is refused too', tlSet.status === 403, err(tlSet));
  const wrong = await C('PUT', `/ats/applications/${appIv.id}/sub-status`, 'bde', { subStatusId: sOther.body.id });
  check('a sub-status of another stage is refused (the words use the renamed stage)', wrong.status === 400 && (wrong.body.error || '').includes(NEW_NAME), err(wrong));
  const appRow = (await C('GET', `/applications?requirementId=${job.id}`, 'sa')).body.find((a) => a.id === appIv.id);
  check('the application carries the chip (2nd round)', appRow && appRow.subStatus && appRow.subStatus.label === '2nd round', appRow && appRow.subStatus);
  const flt = await C('GET', `/applications?subStatus=${s1.body.id}`, 'sa');
  check('the list filters on the sub-status', flt.status === 200 && flt.body.rows.some((a) => a.id === appIv.id) && flt.body.rows.every((a) => a.subStatus && a.subStatus.id === s1.body.id), err(flt));
  const flt2 = await C('GET', `/applications?subStatus=${s3.body.id}`, 'sa');
  check('...and another sub-status does not list this person', flt2.status === 200 && !flt2.body.rows.some((a) => a.id === appIv.id));
  const reqRow = (await C('GET', `/requirements/${job.id}`, 'sa')).body.applications.find((a) => a.id === appIv.id);
  check('the requirement page shows the chip next to the stage', reqRow && reqRow.subStatus && reqRow.subStatus.label === '2nd round', reqRow && reqRow.subStatus);
  const hist = (await C('GET', `/candidates/${CI.id}`, 'sa')).body.pipelineHistory || [];
  check('the change is on the timeline', hist.some((h) => h.subStatus && /2nd round/.test(h.action)), hist.slice(0, 3));
  const ev = await prisma.applicationStageEvent.count({ where: { applicationId: appIv.id } });
  check('...and is not a stage move (no stage event written)', ev === 0, ev);
  const au2 = await prisma.auditLog.findFirst({ where: { action: 'Sub-status set', entityId: appIv.id } });
  check('the sub-status is audited', !!au2 && au2.toValue === '2nd round', au2);
  const own = await C('PATCH', `/applications/${appIv.id}/stage`, 'rec', { stage: 'INTERVIEW_COMPLETED', comment: 'zz' });
  check('a sub-status never changes who may move the stage (the recruiter still cannot)', own.status === 403, err(own));
  await prisma.application.update({ where: { id: appIv.id }, data: { stage: 'INTERVIEW_COMPLETED' } });
  const moved = (await C('GET', `/applications?requirementId=${job.id}`, 'sa')).body.find((a) => a.id === appIv.id);
  check('after the stage moves on, the old sub-status no longer shows', moved && !moved.subStatus, moved && moved.subStatus);
  const off = await C('DELETE', `/ats/sub-statuses/${s1.body.id}`, 'sa');
  check('removing a sub-status that was used switches it off (history kept)', off.status === 200 && off.body.switchedOff === true, off.body);

  // =============================== 3. reject a requirement request
  console.log('\n--- 3. Reject a requirement request');
  const rq = await C('POST', '/requirements/requests', 'bde', { title: `ZZ Flow Request ${RUN}`, clientId: client.id, department: DEPT, openings: 1, location: 'Hyderabad', jobDescription: 'ZZ flow request', skills: 'Java', experience: '2-5' });
  const rid = rq.body && rq.body.id;
  check('setup: the BDE sends a requirement request (DRAFT)', rq.status === 201 && !!rid, err(rq));
  check('the BDE cannot reject (403)', (await C('POST', `/requirements/${rid}/reject-request`, 'bde', { reason: 'Other', note: 'nope nope' })).status === 403);
  const noWhy = await C('POST', `/requirements/${rid}/reject-request`, 'bdeTl', {});
  check('Reject without a reason is refused (400, the reasons listed)', noWhy.status === 400 && Array.isArray(noWhy.body.reasons) && noWhy.body.reasons.length >= 3, err(noWhy));
  check('"Other" without a note is refused', (await C('POST', `/requirements/${rid}/reject-request`, 'bdeTl', { reason: 'Other' })).status === 400);
  check('a reason not on the list is refused', (await C('POST', `/requirements/${rid}/reject-request`, 'bdeTl', { reason: 'Because' })).status === 400);
  const rj = await C('POST', `/requirements/${rid}/reject-request`, 'bdeTl', { reason: 'Details missing or unclear', note: 'Salary band not given' });
  check('the BDE TL rejects it with a reason + note', rj.status === 200 && rj.body.requestState === 'rejected' && /Rejected: Details missing or unclear/.test(rj.body.requestRejection.text), err(rj));
  const det = await C('GET', `/requirements/${rid}`, 'bde');
  check('the requirement shows "Rejected: <reason>"', det.status === 200 && det.body.requestState === 'rejected' && /^Rejected: Details missing or unclear/.test(det.body.requestRejection.text) && det.body.requestCanResubmit === true, [err(det), det.body && det.body.requestRejection]);
  const bell = await prisma.notification.findFirst({ where: { userId: BDE.id, title: { contains: 'rejected' } }, orderBy: { createdAt: 'desc' } });
  check('the BDE gets a bell with the reason', !!bell && /Details missing or unclear/.test(bell.message), bell);
  const auR = await prisma.auditLog.findFirst({ where: { action: 'Requirement request rejected', entityId: rid } });
  check('the rejection is audited', !!auR, auR);
  check('a rejected request cannot be accepted', (await C('POST', `/requirements/${rid}/accept-request`, 'bdeTl', {})).status === 409);
  check('...nor opened', (await C('POST', `/requirements/${rid}/activate`, 'bdeTl', {})).status === 409);
  check('rejecting it twice is refused', (await C('POST', `/requirements/${rid}/reject-request`, 'bdeTl', { reason: 'Other', note: 'again again' })).status === 409);
  const early = await C('POST', `/requirements/${rid}/resubmit-request`, 'bde', {});
  check('re-submit with no edit and no note is refused (EDIT_FIRST)', early.status === 400 && early.body.code === 'EDIT_FIRST', err(early));
  check('a recruiter cannot re-submit it', (await C('POST', `/requirements/${rid}/resubmit-request`, 'rec', { note: 'I fixed it' })).status === 403);
  await new Promise((r) => { setTimeout(r, 30); });
  await prisma.requirement.update({ where: { id: rid }, data: { salary: '6-9 LPA' } }); // the BDE's edit (the edit form's own rules are tested elsewhere)
  const rs = await C('POST', `/requirements/${rid}/resubmit-request`, 'bde', { note: 'Added the salary band' });
  check('after the edit the BDE re-submits it -> waiting again', rs.status === 200 && rs.body.requestState === 'requested', err(rs));
  const bell2 = await prisma.notification.findFirst({ where: { userId: BDETL.id, title: { contains: 're-submitted' } } });
  check('the BDE TL who rejected it is told', !!bell2, bell2);
  const ac = await C('POST', `/requirements/${rid}/accept-request`, 'bdeTl', {});
  check('...and it can be accepted now', ac.status === 200 && ac.body.requestState === 'accepted', err(ac));
  const det2 = await C('GET', `/requirements/${rid}`, 'bde');
  check('no "Rejected" line any more; the re-submit is remembered', !det2.body.requestRejection && det2.body.requestResubmitted && det2.body.requestResubmitted.times === 1, [det2.body.requestRejection, det2.body.requestResubmitted]);

  // =============================== 4. the checklist before the client
  console.log('\n--- 4. Share checklist');
  const CS = await person('share');
  const appS = await appAt(CS, 'BDE_APPROVED');
  const gl = await C('GET', `/ats/share-checklist/${appS.id}`, 'bdeTl');
  const keys = (gl.body.items || []).map((i) => i.key);
  check('the checklist for this person: resume, CTC, notice, consent, contact (+ the IT template\'s Interview items)', gl.status === 200 && gl.body.needed && ['resume', 'ctc', 'notice', 'consent', 'contact'].every((k) => keys.includes(k)), [err(gl), keys]);
  const tplKeys = keys.filter((k) => k.startsWith('tpl:'));
  check('the industry template\'s required Interview items are on it (IT: technical round, coding test)', tplKeys.includes('tpl:tech_round') && tplKeys.includes('tpl:coding_test'), tplKeys);
  const noTick = await C('PATCH', `/applications/${appS.id}/stage`, 'bdeTl', { stage: 'SHARED_WITH_CLIENT', comment: 'zz' });
  check('sending with nothing ticked is blocked with the list', noTick.status === 409 && noTick.body.code === 'SHARE_CHECKLIST' && noTick.body.missing.length === keys.length, err(noTick));
  check('...and the message names what is missing', /Resume attached and current/.test(noTick.body.error || '') && /Notice period/.test(noTick.body.error || ''), noTick.body && noTick.body.error);
  const allTicks = Object.fromEntries(keys.map((k) => [k, true]));
  const part = { ...allTicks }; delete part.consent;
  const partR = await C('PATCH', `/applications/${appS.id}/stage`, 'bdeTl', { stage: 'SHARED_WITH_CLIENT', comment: 'zz', shareChecklist: part });
  check('one item not ticked (consent) still blocks, and only that one is listed', partR.status === 409 && partR.body.missing.length === 1 && partR.body.missing[0].key === 'consent', err(partR));
  const CN = await person('noresume', { resumeName: null, noticePeriod: '' });
  const appN = await appAt(CN, 'BDE_APPROVED');
  const glN = await C('GET', `/ats/share-checklist/${appN.id}`, 'bdeTl');
  const allN = Object.fromEntries((glN.body.items || []).map((i) => [i.key, true]));
  const factR = await C('PATCH', `/applications/${appN.id}/stage`, 'bdeTl', { stage: 'SHARED_WITH_CLIENT', comment: 'zz', shareChecklist: allN });
  check('a tick does not cover a fact that is not on file (no resume, no notice period)', factR.status === 409 && factR.body.missing.map((m) => m.key).sort().join(',') === 'notice,resume', err(factR) && factR.body.missing);
  const okR = await C('PATCH', `/applications/${appS.id}/stage`, 'bdeTl', { stage: 'SHARED_WITH_CLIENT', comment: 'zz', shareChecklist: allTicks });
  const sNow = (await prisma.application.findUnique({ where: { id: appS.id } })).stage;
  check('with everything ticked the profile goes to the client', okR.status === 200 && sNow === 'SHARED_WITH_CLIENT', [err(okR), sNow]);
  const tplSaved = await C('GET', `/ats/share-checklist/${appS.id}`, 'bdeTl');
  check('the template items ticked here are saved on the person\'s industry checklist', tplSaved.status === 200, err(tplSaved));
  check('a recruiter cannot switch checklist items off (403)', (await C('PUT', '/ats/share-checklist/settings', 'rec', { resume: false })).status === 403);
  const offR = await C('PUT', '/ats/share-checklist/settings', 'sa', { resume: false, notice: false });
  check('the Admin switches "resume" and "notice" off', offR.status === 200 && offR.body.on.resume === false && offR.body.on.notice === false && offR.body.on.ctc === true, err(offR));
  const auC = await prisma.auditLog.count({ where: { action: 'Share checklist item switched' } });
  check('...audited per item', auC >= 2, auC);
  const glN2 = await C('GET', `/ats/share-checklist/${appN.id}`, 'bdeTl');
  const allN2 = Object.fromEntries((glN2.body.items || []).map((i) => [i.key, true]));
  const okN = await C('PATCH', `/applications/${appN.id}/stage`, 'bdeTl', { stage: 'SHARED_WITH_CLIENT', comment: 'zz', shareChecklist: allN2 });
  check('with those switched off the second person can go (the rest ticked)', okN.status === 200 && !(glN2.body.items || []).some((i) => ['resume', 'notice'].includes(i.key)), err(okN));
  const rsC = await C('POST', '/ats/share-checklist/settings/reset', 'sa', {});
  check('reset puts every item back on', rsC.status === 200 && Object.values(rsC.body.on).every(Boolean), err(rsC));

  // =============================== 5. fee types on joining invoices
  console.log('\n--- 5. Fee types');
  const mkJoin = async (tag, cli) => {
    const jb = await prisma.requirement.create({ data: { title: `ZZ Flow Fee job ${tag} ${RUN}`, clientId: cli.id, department: DEPT, status: 'OPEN', bdeId: BDE.id, internal: false, hiringType: 'Client Placement', description: 'zz' } });
    const cc = await person(`fee-${tag}`);
    return prisma.application.create({ data: { candidateId: cc.id, requirementId: jb.id, stage: 'JOINED', joiningDate: new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10) } });
  };
  const fixedCl = await prisma.client.create({ data: { name: `ZZ Flow Fixed ${RUN}`, agreementStatus: 'ACTIVE', ownerDepartment: DEPT, agreementFeePercent: 8.33, feeType: 'FIXED', feeAmount: 50000, status: 'Active' } });
  const slabCl = await prisma.client.create({ data: { name: `ZZ Flow Slab ${RUN}`, agreementStatus: 'ACTIVE', ownerDepartment: DEPT, agreementFeePercent: 8.33, feeType: 'PERCENT_CTC', status: 'Active' } });
  // an invoice raised BEFORE the slab terms: untouched afterwards
  const oldApp = await mkJoin('old', slabCl);
  const oldInv = await C('POST', `/invoices/joinings/${oldApp.id}/raise`, 'sa', { offeredCtc: 600000 });
  const oldRow = oldInv.body && (oldInv.body.invoice || oldInv.body);
  check('setup: a % invoice raised before (8.33% of 6 L = 49,980)', [200, 201].includes(oldInv.status) && Math.round(Number(oldRow.amount)) === 49980, [err(oldInv), oldRow && oldRow.amount]);
  check('a recruiter cannot set fee slabs (403)', (await C('PUT', `/ats/fee-slabs/${slabCl.id}`, 'rec', { slabs: [{ upTo: 500000, percent: 6 }] })).status === 403);
  check('a bad slab (fee 80%) is refused', (await C('PUT', `/ats/fee-slabs/${slabCl.id}`, 'sa', { slabs: [{ upTo: 500000, percent: 80 }] })).status === 400);
  const ps = await C('PUT', `/ats/fee-slabs/${slabCl.id}`, 'sa', { slabs: [{ upTo: 500000, percent: 6 }, { upTo: 1000000, percent: 8 }, { upTo: null, percent: 10 }] });
  check('the Admin sets slabs: up to 5 L 6%, up to 10 L 8%, above 10%', ps.status === 200 && ps.body.slabs.length === 3, err(ps));
  const setType = await C('PUT', `/clients/${slabCl.id}`, 'sa', { feeType: 'SLAB' });
  check('the client form saves the fee type "Slab"', setType.status === 200 && (await prisma.client.findUnique({ where: { id: slabCl.id } })).feeType === 'SLAB', err(setType));
  const gs = await C('GET', `/ats/fee-slabs/${slabCl.id}`, 'sa');
  check('GET fee-slabs reads them back with the words', gs.status === 200 && gs.body.feeType === 'SLAB' && /6%/.test(gs.body.text), gs.body);
  const fApp = await mkJoin('fixed', fixedCl);
  const fInv = await C('POST', `/invoices/joinings/${fApp.id}/raise`, 'sa', { offeredCtc: 900000 });
  const fRow = fInv.body && (fInv.body.invoice || fInv.body);
  check('FIXED fee: the invoice is ₹50,000 whatever the CTC (9 L here)', [200, 201].includes(fInv.status) && Number(fRow.amount) === 50000 && fRow.feePercent == null, [err(fInv), fRow && { amount: fRow.amount, pct: fRow.feePercent }]);
  const s1App = await mkJoin('slab1', slabCl);
  const s1Inv = await C('POST', `/invoices/joinings/${s1App.id}/raise`, 'sa', { offeredCtc: 400000 });
  const s1Row = s1Inv.body && (s1Inv.body.invoice || s1Inv.body);
  check('SLAB fee: a 4 L CTC falls in "up to 5 L" -> 6% = ₹24,000', [200, 201].includes(s1Inv.status) && Number(s1Row.amount) === 24000 && Number(s1Row.feePercent) === 6, [err(s1Inv), s1Row && { amount: s1Row.amount, pct: s1Row.feePercent }]);
  const s2App = await mkJoin('slab2', slabCl);
  const s2Inv = await C('POST', `/invoices/joinings/${s2App.id}/raise`, 'sa', { offeredCtc: 1200000 });
  const s2Row = s2Inv.body && (s2Inv.body.invoice || s2Inv.body);
  check('SLAB fee: a 12 L CTC falls in "above" -> 10% = ₹1,20,000', [200, 201].includes(s2Inv.status) && Number(s2Row.amount) === 120000 && Number(s2Row.feePercent) === 10, [err(s2Inv), s2Row && { amount: s2Row.amount, pct: s2Row.feePercent }]);
  const s3App = await mkJoin('slab3', slabCl);
  const s3Inv = await C('POST', `/invoices/joinings/${s3App.id}/raise`, 'sa', { offeredCtc: 500000 });
  const s3Row = s3Inv.body && (s3Inv.body.invoice || s3Inv.body);
  check('SLAB fee: exactly 5 L is still the first band (6% = ₹30,000)', [200, 201].includes(s3Inv.status) && Number(s3Row.amount) === 30000, [err(s3Inv), s3Row && s3Row.amount]);
  const oldAfter = await prisma.invoice.findUnique({ where: { id: oldRow.id } });
  check('the invoice raised before the slab terms is untouched', Math.round(Number(oldAfter.amount)) === 49980 && Number(oldAfter.feePercent) === 8.33, oldAfter && { amount: oldAfter.amount, pct: oldAfter.feePercent });
  const F = require('../src/utils/atsFlowConfig');
  const noCtc = F.feeFor({ feeType: 'FIXED', feeAmount: 75000 }, null);
  check('a fixed fee does not wait for the CTC (feeFor)', noCtc.amount === 75000, noCtc);
  const slabNo = F.feeFor({ feeType: 'SLAB' }, null, { slabs: ps.body.slabs });
  check('a slab fee with no CTC waits (amount filled later)', slabNo.amount === null && slabNo.feeType === 'SLAB', slabNo);

  // =============================== 6. resets
  console.log('\n--- 6. Reset to defaults');
  check('a recruiter cannot reset the names (403)', (await C('POST', '/ats/stage-labels/reset', 'rec', {})).status === 403);
  const rsL = await C('POST', '/ats/stage-labels/reset', 'sa', {});
  check('reset puts "Interview booked" back', rsL.status === 200 && rsL.body.labels.INTERVIEW_SCHEDULED === 'Interview booked' && rsL.body.renamed.length === 0, err(rsL));
  const cdBack = await C('GET', `/candidates/${CI.id}`, 'sa');
  check('...everywhere (the candidate profile reads the built-in word again)', !JSON.stringify(cdBack.body).includes(NEW_NAME));
  const rsS = await C('POST', '/ats/sub-statuses/reset', 'sa', {});
  check('sub-statuses reset (switched off, kept for the history)', rsS.status === 200 && Object.keys((await C('GET', '/ats/stage-labels', 'bde')).body.subStatuses).length === 0, err(rsS));

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
