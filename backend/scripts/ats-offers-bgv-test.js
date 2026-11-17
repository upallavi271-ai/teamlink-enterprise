#!/usr/bin/env node
/**
 * ATS OFFERS / BGV round (founder audit 2026-11-17): counter-offers on an offer, background verification per application
 * (joining warns, never blocks), industry templates (Admin edits; a job's checklist), gender / age criteria (reason + audit,
 * never in the fit score), Tally XML + Zoho Books CSV export of invoices, and the "Profiles verified" monthly target.
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4083.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/ats-offers-bgv-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-offbgv-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = 4083;
const API = `http://localhost:${PORT}/api`;
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'offbgv-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const { SaxesParser } = require('saxes');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const raw = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, type: r.headers.get('content-type') || '', disp: r.headers.get('content-disposition') || '', text: await r.text() };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
const P = process.pid;
const audited = async (entityId, re) => !!(await prisma.auditLog.findMany({ where: { entityId }, select: { action: true }, take: 200 })).find((a) => re.test(a.action));

(async () => {
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const BDE = await prisma.user.create({ data: { name: `Ob bde ${P}`, email: `ob.bde.${P}@ob-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const live = await prisma.requirement.findMany({ where: { status: { in: ['OPEN', 'RECRUITER_ASSIGNED'] }, internal: false }, select: { id: true, clientId: true, title: true }, take: 50 });
  const j1 = live[0];
  await prisma.requirement.update({ where: { id: j1.id }, data: { bdeId: BDE.id } });
  await prisma.client.update({ where: { id: j1.clientId }, data: { industry: 'Multi-speciality Hospital' } });
  const C = await prisma.candidate.create({ data: { name: `Ravi Kumar ${P}`, phone: `8${String(P).padStart(9, '3').slice(-9)}`, email: `ob.person.${P}@ob-test.in`, gender: 'Male', dob: '1994-05-10' } });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tB = await tok(BDE.id);

  // ---- setup: the person on job 1, at the Offer step
  const a1 = await call('POST', '/applications', { candidateId: C.id, requirementId: j1.id, overrideReason: 'test setup reason' }, tA);
  const appId = a1.body && (a1.body.id || (a1.body.application && a1.body.application.id));
  check('setup: the person is on job 1', [200, 201].includes(a1.status) && !!appId, a1.body);
  await prisma.application.update({ where: { id: appId }, data: { stage: 'OFFER', offerStatus: 'Offer Released', offeredCtc: 600000, offerDate: '2026-11-10' } });

  // ---- industry templates
  const tl = await call('GET', '/ats/industry-templates', null, tA);
  const ids = (tl.body && tl.body.rows || []).map((t) => t.id);
  check('the four starting industry templates are there (Medical, Education, Manufacturing, IT)', tl.status === 200 && ['medical', 'education', 'manufacturing', 'it'].every((k) => ids.includes(k)) && tl.body.canEdit === true, tl.body);
  const med = tl.body.rows.find((t) => t.id === 'medical');
  check('Medical has registration number, council, license expiry, vaccination', ['reg_number', 'reg_council', 'license_expiry', 'vaccination'].every((k) => med.items.some((i) => i.key === k)), med);
  const edu = tl.body.rows.find((t) => t.id === 'education'); const mfg = tl.body.rows.find((t) => t.id === 'manufacturing'); const it = tl.body.rows.find((t) => t.id === 'it');
  check('Education / Manufacturing / IT carry their items (demo class, safety training, coding test, notice buyout)', edu.items.some((i) => i.key === 'demo_class') && edu.items.some((i) => i.key === 'net_set_phd') && mfg.items.some((i) => i.key === 'safety_training') && mfg.items.some((i) => i.key === 'shift_ok') && it.items.some((i) => i.key === 'coding_test') && it.items.some((i) => i.key === 'notice_buyout'));
  check('a non-Admin cannot change a template', (await call('PUT', '/ats/industry-templates/medical', { ...med }, tB)).status === 403);
  const medEdit = await call('PUT', '/ats/industry-templates/medical', { ...med, items: [...med.items, { label: 'Police verification letter', step: 'Joining', required: true }] }, tA);
  check('Admin adds an item to the Medical template (audited)', medEdit.status === 200 && medEdit.body.template.items.some((i) => /Police verification/.test(i.label)) && await audited('medical', /Industry template changed/), medEdit.body);
  check('a template with no items is refused', (await call('PUT', '/ats/industry-templates/medical', { ...med, items: [] }, tA)).status === 400);
  const newT = await call('POST', '/ats/industry-templates', { industry: `Hospitality ${P}`, name: 'Hotels', items: [{ label: 'FSSAI food handler card', step: 'Joining' }] }, tA);
  check('Admin adds a new industry template', newT.status === 201 && newT.body.template.items.length === 1, newT.body);

  // ---- requirement: template from the client industry, BGV needed, criteria
  const ri0 = await call('GET', `/requirements/${j1.id}/industry`, null, tA);
  check('a job takes its template from the client industry (Hospital -> Medical) by default', ri0.status === 200 && ri0.body.template && ri0.body.template.id === 'medical' && ri0.body.templateFrom === 'client industry', ri0.body);
  const before = await call('GET', `/requirements/${j1.id}/matching-candidates`, null, tA);
  const noReason = await call('PUT', `/requirements/${j1.id}/industry`, { prefGender: 'Female', ageMin: 25, ageMax: 40, criteriaReason: '' }, tA);
  check('gender / age criteria without a reason is refused', noReason.status === 400 && /reason/i.test(noReason.body.error || ''), noReason.body);
  check('an age outside 18-70 is refused', (await call('PUT', `/requirements/${j1.id}/industry`, { ageMin: 12, criteriaReason: 'Some lawful reason here' }, tA)).status === 400);
  const setC = await call('PUT', `/requirements/${j1.id}/industry`, { bgvNeeded: true, prefGender: 'Female', ageMin: 25, ageMax: 40, criteriaReason: "Warden for a women's hostel" }, tA);
  check('criteria + BGV needed are saved with the reason', setC.status === 200 && setC.body.bgvNeeded === true && setC.body.criteria && setC.body.criteria.prefGender === 'Female' && setC.body.criteria.ageMax === 40 && /hostel/.test(setC.body.criteria.reason), setC.body);
  check('setting the criteria is audited with its reason', !!(await prisma.auditLog.findFirst({ where: { entityId: j1.id, action: 'Gender / age criteria set', reason: { contains: 'hostel' } } })));
  check('...and BGV needed is audited', await audited(j1.id, /Background verification needed/));
  const after = await call('GET', `/requirements/${j1.id}/matching-candidates`, null, tA);
  const fitOf = (b) => JSON.stringify(((b && (b.rows || b.candidates)) || []).map((r) => [r.id, r.match, r.overall, r.score]));
  check('the fit score is the same before and after the criteria (not used silently)', before.status === after.status && fitOf(before.body) === fitOf(after.body), { b: fitOf(before.body).slice(0, 200), a: fitOf(after.body).slice(0, 200) });
  const recruiterView = await call('GET', `/requirements/${j1.id}/industry`, null, tB);
  check('the job\'s owner team sees the criteria and its reason', recruiterView.status === 200 && recruiterView.body.criteria && /hostel/.test(recruiterView.body.criteria.reason), recruiterView.body);

  // ---- the application: checklist, criteria flag
  let ex = await call('GET', `/ats/applications/${appId}/extras`, null, tA);
  check('the application shows the Medical checklist by step', ex.status === 200 && ex.body.template && ex.body.template.id === 'medical' && ex.body.checklist.some((c) => c.key === 'reg_number' && c.step === 'Interview') && ex.body.checklist.some((c) => c.step === 'Joining'), ex.body);
  check('a male candidate shows "Mismatch" on a female-only job (a flag, not a score)', ex.body.criteria && ex.body.criteria.flag === 'Mismatch' && ex.body.criteria.why.some((w) => /Gender/.test(w)), ex.body.criteria);
  await prisma.candidate.update({ where: { id: C.id }, data: { gender: 'F' } });
  ex = await call('GET', `/ats/applications/${appId}/extras`, null, tA);
  check('the same candidate as female aged 32 shows "Match"', ex.body.criteria && ex.body.criteria.flag === 'Match', ex.body.criteria);
  await prisma.candidate.update({ where: { id: C.id }, data: { dob: null } });
  ex = await call('GET', `/ats/applications/${appId}/extras`, null, tA);
  check('no date of birth shows "Not known"', ex.body.criteria && ex.body.criteria.flag === 'Not known', ex.body.criteria);
  const tk = await call('PUT', `/ats/applications/${appId}/checklist/reg_number`, { done: true, note: 'TSMC 12345' }, tA);
  check('ticking "Medical registration number" is saved', tk.status === 200 && tk.body.checklist.find((c) => c.key === 'reg_number').done === true && await audited(appId, /Checklist: Medical registration number done/), tk.body);
  check('an item not on the job\'s checklist is refused', (await call('PUT', `/ats/applications/${appId}/checklist/no_such_item`, { done: true }, tA)).status === 404);

  // ---- counter-offer
  check('a counter-offer with nothing asked is refused', (await call('POST', `/ats/offers/${appId}/counter`, {}, tA)).status === 400);
  const co = await call('POST', `/ats/offers/${appId}/counter`, { ctcAsked: 720000, joiningAsked: '2026-12-15', otherTerms: 'Two days work from home', competingCompany: 'Apollo', competingCtc: 700000 }, tA);
  check('the candidate\'s counter is recorded (CTC, joining date, terms, competing offer)', co.status === 201 && co.body.counter.ctcAsked === 720000 && co.body.counter.competingCompany === 'Apollo' && co.body.counter.status === 'Waiting for decision', co.body);
  check('a second counter while one waits is refused', (await call('POST', `/ats/offers/${appId}/counter`, { ctcAsked: 750000 }, tA)).status === 409);
  check('a revised offer needs the new CTC or date', (await call('POST', `/ats/offers/${appId}/counter/${co.body.counter.id}/decide`, { decision: 'Revised offer' }, tA)).status === 400);
  const dec = await call('POST', `/ats/offers/${appId}/counter/${co.body.counter.id}/decide`, { decision: 'Revised offer', revisedCtc: 680000, note: 'Met half way' }, tA);
  check('the decision "Revised offer" is saved with the new CTC', dec.status === 200 && dec.body.counter.decision === 'Revised offer' && dec.body.counter.revisedCtc === 680000 && /Change offer/.test(dec.body.next || ''), dec.body);
  check('a decided counter cannot be decided again', (await call('POST', `/ats/offers/${appId}/counter/${co.body.counter.id}/decide`, { decision: 'Accepted' }, tA)).status === 409);
  const co2 = await call('POST', `/ats/offers/${appId}/counter`, { ctcAsked: 700000 }, tA);
  check('refusing needs a reason', (await call('POST', `/ats/offers/${appId}/counter/${co2.body.counter.id}/decide`, { decision: 'Refused' }, tA)).status === 400);
  await call('POST', `/ats/offers/${appId}/counter/${co2.body.counter.id}/decide`, { decision: 'Refused', note: 'Above the client budget' }, tA);
  const hist = await call('GET', `/ats/offers/${appId}/counter`, null, tA);
  check('the history keeps both counters, newest first', hist.status === 200 && hist.body.rows.length === 2 && hist.body.rows[0].decision === 'Refused' && hist.body.rows[1].decision === 'Revised offer', hist.body);
  check('counter-offers are audited', await audited(appId, /Counter-offer recorded/) && await audited(appId, /Counter-offer revised offer/) && await audited(appId, /Counter-offer refused/));
  const offers = await call('GET', '/ats/offers', null, tA);
  const orow = (offers.body.rows || []).find((r) => r.id === appId);
  check('the Offers row shows the latest counter (2 in all) and BGV', !!orow && orow.counterOffer && orow.counterOffer.status === 'Refused' && orow.counterOffer.count === 2 && orow.bgv && orow.bgv.needed === true, orow && { c: orow.counterOffer, b: orow.bgv });

  // ---- BGV
  check('a BGV check with an unknown state is refused', (await call('PUT', `/ats/bgv/${appId}`, { checks: { education: 'Maybe' } }, tA)).status === 400);
  check('a report link must be http(s)', (await call('PUT', `/ats/bgv/${appId}`, { reportLink: 'javascript:alert(1)' }, tA)).status === 400);
  let bg = await call('PUT', `/ats/bgv/${appId}`, { checks: { education: 'Clear', employment: 'Clear', address: 'In progress', criminal: 'Pending', identity: 'Clear' }, vendor: 'AuthBridge', reportLink: 'https://example.org/report/1' }, tA);
  check('BGV saved: overall "In progress" with the vendor and report link', bg.status === 200 && bg.body.bgv.overall === 'In progress' && bg.body.bgv.vendor === 'AuthBridge' && bg.body.bgv.checks.length === 5, bg.body);
  bg = await call('PUT', `/ats/bgv/${appId}`, { checks: { address: 'Discrepancy' } }, tA);
  check('one Discrepancy makes the overall Discrepancy (other checks kept)', bg.body.bgv.overall === 'Discrepancy' && bg.body.bgv.checks.find((c) => c.key === 'education').status === 'Clear', bg.body);
  check('BGV changes are audited', await audited(appId, /Background verification updated/));
  let list = await call('GET', '/ats/bgv-list?status=open', null, tA);
  check('the TL / HR BGV list shows the person as not clear', list.status === 200 && list.body.rows.some((r) => r.id === appId && r.overall === 'Discrepancy' && r.bgvNeeded), list.body && list.body.counts);
  ex = await call('GET', `/ats/applications/${appId}/extras`, null, tA);
  check('the profile warns: BGV not clear on a job that needs it', ex.body.warnings.some((w) => /Background verification is not clear/.test(w)), ex.body.warnings);

  // ---- joining warns, never blocks
  await prisma.application.update({ where: { id: appId }, data: { stage: 'OFFER_ACCEPTED', offerStatus: 'Offer Accepted', offerAcceptedAt: new Date() } });
  const sch = await call('POST', `/ats/joining/${appId}/schedule`, { joiningDate: '2026-11-16' }, tA);
  check('joining is scheduled although BGV is not clear — with a warning', sch.status === 200 && (sch.body.warnings || []).some((w) => /Background verification/.test(w)), { s: sch.status, b: sch.body && (sch.body.warnings || sch.body.error) });
  const jl = await call('GET', '/ats/joining', null, tA);
  const jrow = (jl.body.rows || []).find((r) => r.id === appId);
  check('the Joining row carries the BGV warning', !!jrow && jrow.bgv && jrow.bgv.warn === true, jrow && jrow.bgv);
  await call('PUT', `/ats/bgv/${appId}`, { checks: { address: 'Clear', criminal: 'Clear' } }, tA);
  ex = await call('GET', `/ats/applications/${appId}/extras`, null, tA);
  check('all checks Clear: overall Clear, the BGV warning is gone', ex.body.bgv.overall === 'Clear' && !ex.body.warnings.some((w) => /Background verification/.test(w)), ex.body.warnings);
  list = await call('GET', '/ats/bgv-list?status=Clear', null, tA);
  check('the BGV list filter "Clear" finds them', list.body.rows.some((r) => r.id === appId));
  const jn = await call('POST', `/ats/joining/${appId}/joined`, {}, tA);
  check('joined (warnings only list the open joining checklist items)', jn.status === 200 && Array.isArray(jn.body.warnings) && !jn.body.warnings.some((w) => /Background/.test(w)) && jn.body.warnings.some((w) => /Joining checklist not done/.test(w)), { s: jn.status, b: jn.body && (jn.body.warnings || jn.body.error) });

  // ---- accounting export
  const reg = await call('GET', '/invoices/register?period=all', null, tA);
  const liveRows = ((reg.body && reg.body.rows) || []).filter((r) => r.status !== 'Cancelled');
  check('setup: the register has invoices to export', reg.status === 200 && liveRows.length > 0, { s: reg.status, n: liveRows.length });
  const tx = await raw('POST', '/invoices/register/tally.xml', { period: 'all', company: 'TeamLink & Co' }, tA);
  let wellFormed = true; let vouchers = 0; let unbalanced = 0; let cur = null; let inAmount = false; let amtText = '';
  try {
    const sp = new SaxesParser();
    sp.on('error', (e) => { throw e; });
    sp.on('opentag', (t) => { if (t.name === 'VOUCHER') { vouchers += 1; cur = 0; } if (t.name === 'AMOUNT') { inAmount = true; amtText = ''; } });
    sp.on('text', (t) => { if (inAmount) amtText += t; });
    sp.on('closetag', (t) => {
      if (t.name === 'AMOUNT') { inAmount = false; cur += Math.round(Number(amtText) * 100); }
      if (t.name === 'VOUCHER') { if (cur !== 0) unbalanced += 1; cur = null; }
    });
    sp.write(tx.text).close();
  } catch (e) { wellFormed = false; console.log('      XML error:', e.message); }
  check('Tally XML downloads as a file', tx.status === 200 && /xml/.test(tx.type) && /attachment; filename="tally-vouchers-/.test(tx.disp), { s: tx.status, t: tx.type, d: tx.disp });
  check('the Tally XML is well-formed (strict XML parser)', wellFormed && /^<\?xml version="1.0"/.test(tx.text) && /<TALLYREQUEST>Import Data<\/TALLYREQUEST>/.test(tx.text) && /TeamLink &amp; Co/.test(tx.text));
  check('one Sales voucher per invoice shown (cancelled left out)', vouchers === liveRows.length, { vouchers, rows: liveRows.length });
  check('every voucher balances (debits = credits)', unbalanced === 0, { unbalanced });
  const one = liveRows[0];
  const txOne = await raw('POST', '/invoices/register/tally.xml', { period: 'all', ids: [one.id] }, tA);
  check('only the invoices on screen are exported (ids)', (txOne.text.match(/<VOUCHER /g) || []).length === 1 && txOne.text.includes(`<VOUCHERNUMBER>${String(one.invoiceNumber).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</VOUCHERNUMBER>`));
  const zc = await raw('POST', '/invoices/register/zoho.csv', { period: 'all' }, tA);
  const lines = zc.text.replace(/^﻿/, '').trim().split(/\r\n/);
  check('Zoho Books CSV downloads with the import headers', zc.status === 200 && /text\/csv/.test(zc.type) && /zoho-books-invoices-/.test(zc.disp) && lines[0].startsWith('Invoice Date,Invoice Number,Invoice Status,Customer Name') && lines[0].includes('Item Price'), lines[0]);
  check('one CSV row per invoice shown', lines.length - 1 >= liveRows.length, { lines: lines.length - 1, rows: liveRows.length });
  check('a login without Accounts cannot export', (await raw('POST', '/invoices/register/tally.xml', { period: 'all' }, tB)).status === 403);
  check('the export is audited', !!(await prisma.auditLog.findFirst({ where: { action: { startsWith: 'Invoices exported for Tally' } } })));

  // ---- profiles verified target
  // A recruiter (with an employee record) on job 1, a "Profiles verified" target of 25, and one profile they verified today.
  const recUsers = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'RECRUITER' }, select: { id: true, name: true, email: true }, take: 200 });
  const emps = await prisma.employee.findMany({ where: { userId: { in: recUsers.filter((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`)).map((u) => u.id) } }, select: { id: true, userId: true }, take: 1 });
  const emp = emps[0] || await prisma.employee.findFirst({ where: { userId: { not: null } }, select: { id: true, userId: true } });
  const recUser = await prisma.user.findUnique({ where: { id: emp.userId }, select: { id: true, name: true } });
  await prisma.requirement.update({ where: { id: j1.id }, data: { recruiterId: emp.userId } });
  await prisma.application.update({ where: { id: appId }, data: { ownerRecruiterId: emp.userId } });
  await prisma.applicationStageEvent.create({ data: { applicationId: appId, candidateId: C.id, fromStage: 'RECRUITER_REVIEW', toStage: 'TL_REVIEW', actorUserId: emp.userId, actorName: recUser.name, action: 'Sent to TL' } });
  const month = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 7);
  await prisma.employeeRecord.create({ data: { type: 'TARGET', employeeId: emp.id, title: 'Profiles verified', unit: 'profiles', amount: 25, date: month, status: 'In Progress' } });
  const rp = await call('GET', '/ats-reports/targets', null, tA);
  const sec = rp.body && (rp.body.sections || []).find((s) => s.id === 'targets' || s.key === 'targets') || (rp.body && (rp.body.sections || [])[0]);
  const colKeys = sec ? (sec.columns || []).map((c) => c.key) : [];
  const rowsArr = sec ? (Array.isArray(sec.rows) ? sec.rows : Object.values(sec.rows || {})) : [];
  const mine = rowsArr.find((r) => (r.key || r.id) === `u:${emp.userId}`);
  // a row is { key, c: [cells in column order] } (or { cells } on older payloads)
  const cellOf = (row, k) => { if (!row) return null; if (Array.isArray(row.c)) return row.c[colKeys.indexOf(k)]; return row.cells ? row.cells[k] : row[k]; };
  const tval = cellOf(mine, 't_verified');
  check('Results vs target has a "Profiles verified" column and its target', rp.status === 200 && colKeys.includes('verified') && colKeys.includes('t_verified'), { s: rp.status, cols: colKeys, err: rp.body && rp.body.error });
  check('the recruiter\'s "Profiles verified" target (25) shows next to the other targets', tval === 25, { mine: mine && (mine.cells || mine), n: rowsArr.length });
  const vcell = cellOf(mine, 'verified');
  const vn = vcell && typeof vcell === 'object' ? (vcell.n ?? vcell.value ?? (Array.isArray(vcell.ids) ? vcell.ids.length : null)) : vcell;
  check('the profile they verified today is counted for them', Number(vn) >= 1, { vcell });
  check('the tile says how many verified against the target', (rp.body.tiles || []).some((t) => (t.key === 'verified' || /verified/i.test(t.label || '')) && t.target === 25), rp.body.tiles);
  const dm = await call('GET', '/ats-daily/month', null, tA);
  check('the recruiter daily report counts "Profiles verified"', dm.status === 200 && (dm.body.metrics || []).some((m) => m.key === 'verified') && dm.body.totals && dm.body.totals.verified !== undefined, { s: dm.status, e: dm.body && dm.body.error });

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
