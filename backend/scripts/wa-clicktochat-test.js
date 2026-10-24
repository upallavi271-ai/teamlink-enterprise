// ---------------------------------------------------------------------------
// WHATSAPP CLICK-TO-CHAT: acceptance test. SANDBOX ONLY (API 4011, prisma/sandbox.db). Nothing is ever sent or opened: the feature only builds
// wa.me links in the browser; the server never contacts WhatsApp. Run once:
//   node scripts/wa-clicktochat-apply-sandbox.js        (the four tables, sandbox only)
//   TL_API=http://localhost:4011 node scripts/wa-clicktochat-test.js
// Covers: number cleaning, buildWaLink encoding, placeholders, the FRONTEND helper (esbuild + node, same answers), template CRUD + system protection,
// log append / filters / masking per role / CSV audit, bulk queue (create / resume / mark-sent / summary with invalid, duplicate, not-opted-in,
// do-not-contact skips), opt-in set / unset audit, role gates, master switch, per-module switch, country code, daily limit warning.
// Tag "ZZTEST WA": every row made here is removed at the end (the real dev.db is never opened).
// ---------------------------------------------------------------------------
/* eslint-disable no-console, no-await-in-loop */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');

if (!process.env.TL_API) process.env.TL_API = 'http://localhost:4011';
const Z = require('./lib/zzfix')('WA');
const { BACK, prisma, RUN } = Z;
const W = require(path.join(BACK, 'src/utils/waLink'));
const WA = require(path.join(BACK, 'src/utils/waChat'));
const C = '/api/wa';
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ------------------------------------------------------------------ 1. the pure helper (no server)
  const cn = (raw, cc) => W.cleanNumber(raw, cc);
  Z.check('N1 spaces, +, -, brackets are removed', cn('+91 (98765) 43-210').digits === '919876543210' && cn('+91 (98765) 43-210').valid);
  Z.check('N2 a leading 0 is removed and a 10-digit number gets 91', cn('098765 43210').digits === '919876543210');
  Z.check('N3 a plain 10-digit number gets 91', cn('9876543210').digits === '919876543210');
  Z.check('N4 00 international prefix is removed', cn('0044 7911 123456').digits === '447911123456' && cn('0044 7911 123456').valid);
  Z.check('N5 too short (9 digits) is invalid', !cn('987654321').valid);
  Z.check('N6 10 digits after the code is the minimum for 11: "12345678901" valid, "1234567890" gets 91', cn('12345678901').valid && cn('1234567890').digits === '911234567890');
  Z.check('N7 15 digits valid, 16 invalid', cn('123456789012345').valid && !cn('1234567890123456').valid);
  Z.check('N8 letters are invalid, empty is invalid', !cn('call me').valid && !cn('').valid && !cn(null).valid);
  Z.check('N9 default country code is configurable', cn('9876543210', '44').digits === '449876543210' && cn('9876543210', '+971').digits === '9719876543210');
  const msg = 'Hello Ravi, రేపు 10 గంటలకు & #1\nline two?';
  const link = W.buildWaLink('+91 98765-43210', msg);
  Z.check('L1 link is https://wa.me/<digits>?text=<encoded>', link === `https://wa.me/919876543210?text=${encodeURIComponent(msg)}`, link);
  Z.check('L2 Telugu, newline, & and # are encoded', /%E0%B0/.test(link) && /%0A/.test(link) && /%26/.test(link) && /%23/.test(link) && !/[&#\s]/.test(link.split('?text=')[1]));
  Z.check('L3 invalid number gives no link', W.buildWaLink('123', 'hi') === null);
  const f1 = W.fillPlaceholders('Hi {name}, invoice {invoice_no} for {amount} due {due_date}. {bogus} {month}', { name: 'Ravi', invoice_no: 'INV-1', amount: '', month: 'October 2026', bogus: 'x' });
  Z.check('P1 known values fill; empty and unknown stay as {word} and are listed as missing', f1.text === 'Hi Ravi, invoice INV-1 for {amount} due {due_date}. {bogus} October 2026' && eq(f1.missing, ['amount', 'due_date', 'bogus']), f1);
  Z.check('P2 leftoverPlaceholders sees what is still in braces', eq(W.leftoverPlaceholders(f1.text), ['amount', 'due_date', 'bogus']) && W.leftoverPlaceholders('plain {not a token} text').length === 0);
  Z.check('P3 seven placeholders', eq(W.WA_PLACEHOLDERS, ['name', 'amount', 'invoice_no', 'due_date', 'job_title', 'interview_date', 'month']));

  // the frontend mirror: bundled with esbuild, run with node, same answers
  try {
    const out = path.join(os.tmpdir(), `wa-front-helper-${RUN}.mjs`);
    const esb = path.join(BACK, '..', 'frontend', 'node_modules', 'esbuild', 'bin', 'esbuild');
    execFileSync(process.execPath, [esb, path.join(BACK, '..', 'frontend', 'src', 'utils', 'waLink.js'), '--format=esm', `--outfile=${out}`, '--log-level=error'], { stdio: 'pipe' });
    const F = await import(`file:///${out.split(path.sep).join('/')}`);
    const cases = ['+91 (98765) 43-210', '098765 43210', '9876543210', '0044 7911 123456', '987654321', '12345678901', '1234567890123456', 'call me', '', null];
    Z.check('F1 frontend cleanNumber gives the same answer as the backend for 10 cases', cases.every((c) => eq(F.cleanNumber(c), W.cleanNumber(c))));
    Z.check('F2 frontend cleanNumber with another country code', eq(F.cleanNumber('9876543210', '44'), W.cleanNumber('9876543210', '44')));
    Z.check('F3 frontend buildWaLink identical (Telugu, newline, & #)', F.buildWaLink('+91 98765-43210', msg) === link && F.buildWaLink('12', 'x') === null);
    const f2 = F.fillPlaceholders('Hi {name}, invoice {invoice_no} for {amount} due {due_date}. {bogus} {month}', { name: 'Ravi', invoice_no: 'INV-1', amount: '', month: 'October 2026', bogus: 'x' });
    Z.check('F4 frontend fillPlaceholders identical + leftover', eq(f2, f1) && eq(F.leftoverPlaceholders(f2.text), ['amount', 'due_date', 'bogus']));
    fs.unlinkSync(out);
  } catch (e) { Z.check('F0 frontend helper bundled and run', false, String(e.message).slice(0, 300)); }

  // ------------------------------------------------------------------ 2. fixtures
  console.log('preclean', JSON.stringify(await Z.preclean()));
  const wipeWa = async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "WaTemplate" WHERE name LIKE \'ZZTEST WA%\'').catch(() => {});
    const us = (await prisma.user.findMany({ where: { name: { contains: 'ZZTEST WA' } }, select: { id: true } })).map((u) => u.id);
    for (const id of us) {
      await prisma.$executeRawUnsafe('DELETE FROM "WaLog" WHERE userId = ?', id).catch(() => {});
      await prisma.$executeRawUnsafe('DELETE FROM "WaBulkSession" WHERE userId = ?', id).catch(() => {});
    }
    await prisma.$executeRawUnsafe('DELETE FROM "WaLog" WHERE recipientName LIKE \'%ZZTEST WA%\'').catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM "WaOptIn" WHERE setByName LIKE \'ZZTEST WA%\'').catch(() => {});
    await prisma.officeVendor.deleteMany({ where: { name: { contains: 'ZZTEST WA' } } }).catch(() => {});
  };
  await wipeWa();
  const ready = await WA.ready();
  Z.check('R0 the four WhatsApp tables exist in the sandbox', ready, 'run: node scripts/wa-clicktochat-apply-sandbox.js');
  if (!ready) { await Z.finish(); return; }
  const settingsBefore = await prisma.appSetting.findUnique({ where: { key: 'wa.settings' } });
  const restoreSettings = async () => {
    if (settingsBefore) await prisma.appSetting.update({ where: { key: 'wa.settings' }, data: { value: settingsBefore.value } });
    else await prisma.appSetting.deleteMany({ where: { key: 'wa.settings' } });
  };
  await prisma.appSetting.deleteMany({ where: { key: 'wa.settings' } });

  const uAdmin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' }, {});
  const uHr = await Z.mkUser('hr', { role: 'HR', atsRole: 'HR', hrmsRole: 'HR', hrmsAccess: true }, { phone: '9000000401' });
  const uAcc = await Z.mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' }, {});
  const uMgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', hrmsAccess: true, hrmsRole: 'MANAGER' }, {});
  const uTl = await Z.mkUser('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL', phone: '9000000402' });
  const uRec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { phone: '9000000403' });
  const uRecOther = await Z.mkUser('recother', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }, {});
  const uBde = await Z.mkUser('bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, {});
  const T = {};
  for (const [k, u] of Object.entries({ admin: uAdmin, hr: uHr, acc: uAcc, mgr: uMgr, tl: uTl, rec: uRec, recOther: uRecOther, bde: uBde })) T[k] = await Z.mint(u);
  const emps = await prisma.employee.findMany({ where: { userId: { in: [uHr.id, uRec.id, uTl.id] } }, select: { id: true, userId: true } });
  const empOf = (u) => emps.find((e) => e.userId === u.id);

  const client = await prisma.client.create({
    data: {
      name: `ZZTEST WA Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', bdeOwner: uBde.name, clientType: 'Client',
      contactName: 'Meena Rao', contactPhone: '9000000501', billingContactName: 'Suresh Billing', billingContactPhone: '9000000502',
    },
  });
  Z.made.clients.push(client.id);
  const req = await prisma.requirement.create({ data: { title: `ZZTEST WA Job ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Education', recruiterId: uRec.id, tlId: uTl.id, bdeId: uBde.id, openings: 3 } });
  Z.made.reqs.push(req.id);
  const reqMed = await prisma.requirement.create({ data: { title: `ZZTEST WA Job Med ${RUN}`, clientId: client.id, status: 'OPEN', department: 'Medical', recruiterId: uRecOther.id, openings: 1 } });
  Z.made.reqs.push(reqMed.id);
  const mkCand = async (n, phone, over = {}, reqId = req.id) => {
    const c = await prisma.candidate.create({ data: { name: `ZZTEST WA Cand ${n} ${RUN}`, email: `zz-wa-c${n}-${RUN}@example.test`, phone, location: 'ZZ', ...over } });
    Z.made.cands.push(c.id);
    const a = await prisma.application.create({ data: { candidateId: c.id, requirementId: reqId, stage: 'NEW' } });
    Z.made.apps.push(a.id);
    return c;
  };
  const c1 = await mkCand(1, '9000000601');
  const c2 = await mkCand(2, '+91 90000-00602', { consentStatus: 'GIVEN', consentPurposes: 'Recruitment,Messages', consentSource: 'recruiter' }); // consent on the record = opted in
  const c3 = await mkCand(3, '12345'); // invalid number
  const c4 = await mkCand(4, '090000 00601'); // same number as c1 once cleaned
  const c5 = await mkCand(5, '9000000605'); // not opted in
  const c6 = await mkCand(6, '9000000606', { doNotContact: true, consentStatus: 'WITHDRAWN' }); // do not contact
  const c7 = await mkCand(7, '9000000607'); // on the Omni-Channel STOP list
  const cOut = await mkCand(8, '9000000608', {}, reqMed.id); // outside the recruiter's area
  const cIds = [c1, c2, c3, c4, c5, c6, c7].map((c) => c.id);
  const vendor = await prisma.officeVendor.create({ data: { name: `ZZTEST WA Vendor ${RUN}`, contactPerson: 'Ravi Vendor', phone: '9000000701' } });
  const vendorNoPhone = await prisma.officeVendor.create({ data: { name: `ZZTEST WA Vendor2 ${RUN}` } });
  const inv = await prisma.invoice.create({ data: { clientId: client.id, amount: 10000, gst: 1800, status: 'Pending', invoiceDate: '2026-10-01', dueDate: '2026-10-20', invoiceNumber: `ZZWA-${RUN}` } });

  // a STOP reply recorded by Omni-Channel (do-not-contact list), when that module's tables are here
  let stopMade = null;
  try {
    const S = require(path.join(BACK, 'src/outreach/store'));
    if (await S.ready()) {
      stopMade = S.hashAddress('phone', '919000000607');
      await S.run('INSERT OR IGNORE INTO "OutreachSuppression" (addressHash, channel, reason, at, source) VALUES (?,?,?,?,?)', stopMade, 'whatsapp', 'stop_reply', Date.now(), 'ZZTEST WA');
    }
  } catch (e) { console.log('(outreach suppression fixture skipped:', String(e.message).slice(0, 80), ')'); }

  const call = Z.call;
  const created = { tpl: [] };
  try {
    // ------------------------------------------------------------------ 3. config + gates + master switch
    let r = await call('GET', `${C}/config`, T.admin);
    Z.check('G1 config: ready, quick chat ON by default, country code 91, daily limit 200', r.status === 200 && r.body.ready && r.body.settings.enabled && r.body.settings.defaultCountryCode === '91' && r.body.settings.dailyBulkLimit === 200, r.body);
    Z.check('G2 config has the plain safety note', /restrict numbers/i.test(r.body.safetyNote || ''));
    r = await call('GET', `${C}/config`, T.bde);
    Z.check('G3 BDE: candidate WhatsApp not allowed (they never see candidate numbers), client allowed', r.body.gates.candidate.ok === false && /BDE team/.test(r.body.gates.candidate.reason) && r.body.gates.client.ok === true, r.body.gates);
    r = await call('GET', `${C}/config`, T.rec);
    Z.check('G4 recruiter: candidate yes; employee, vendor, invoice no', r.body.gates.candidate.ok && !r.body.gates.employee.ok && !r.body.gates.vendor.ok && !r.body.gates.invoice.ok, r.body.gates);
    r = await call('GET', `${C}/config`, T.hr);
    Z.check('G5 HR: employee yes; vendor / invoice no', r.body.gates.employee.ok && !r.body.gates.vendor.ok && !r.body.gates.invoice.ok, r.body.gates);
    r = await call('GET', `${C}/config`, T.acc);
    Z.check('G6 Accounts: vendor + invoice yes; candidate no', r.body.gates.vendor.ok && r.body.gates.invoice.ok && !r.body.gates.candidate.ok, r.body.gates);
    r = await call('PUT', `${C}/settings`, T.bde, { enabled: false });
    Z.check('G7 BDE cannot change settings (403)', r.status === 403, r.body);
    r = await call('PUT', `${C}/settings`, T.rec, { enabled: false });
    Z.check('G8 recruiter cannot change settings (403)', r.status === 403, r.body);

    // ------------------------------------------------------------------ 4. templates
    r = await call('GET', `${C}/templates`, T.rec);
    const names = (r.body.templates || []).map((t) => t.name);
    Z.check('T1 five pre-built templates for every staff login', r.status === 200 && ['Payslip ready', 'Interview schedule', 'Invoice due reminder', 'Payment received', 'Document request'].every((n) => names.includes(n)), names);
    const sys = r.body.templates.filter((t) => t.isSystem);
    const tInterview = sys.find((t) => t.systemKey === 'interview_schedule');
    const tDoc = sys.find((t) => t.systemKey === 'document_request');
    const tDue = sys.find((t) => t.systemKey === 'invoice_due');
    const tPay = sys.find((t) => t.systemKey === 'payslip_ready');
    Z.check('T2 pre-built wording follows the rules (no client name or salary in candidate messages; invoice has amount + number)', !/client\}|\{client|salary|ctc/i.test(tInterview.body) && /\{amount\}/.test(tDue.body) && /\{invoice_no\}/.test(tDue.body) && !/\{amount\}|salary/i.test(tPay.body), [tInterview.body, tPay.body]);
    r = await call('POST', `${C}/templates`, T.rec, { name: 'ZZTEST WA nope', module: 'ATS', body: 'x' });
    Z.check('T3 a recruiter cannot add a template (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/templates`, T.acc, { name: `ZZTEST WA Own ${RUN}`, module: 'Accounts', body: 'Hi {name}, thanks {month}' });
    Z.check('T4 Accounts adds a template', r.status === 201 && r.body.template && !r.body.template.isSystem, r.body);
    const own = r.body.template; created.tpl.push(own.id);
    r = await call('POST', `${C}/templates`, T.acc, { name: `zztest wa own ${RUN}`, module: 'Accounts', body: 'dup' });
    Z.check('T5 the same name twice is refused (409)', r.status === 409, r.body);
    r = await call('POST', `${C}/templates`, T.acc, { name: '', body: 'x' });
    Z.check('T6 an empty name is refused (400, plain words)', r.status === 400 && /name/i.test(r.body.error), r.body);
    r = await call('PUT', `${C}/templates/${own.id}`, T.hr, { body: 'Hi {name}, edited by HR' });
    Z.check('T7 HR edits a template', r.status === 200 && r.body.template.body === 'Hi {name}, edited by HR', r.body);
    const docBefore = tDoc.body;
    r = await call('PUT', `${C}/templates/${tDoc.id}`, T.admin, { body: `${docBefore} (ZZTEST WA edit)` });
    Z.check('T8 a system template can be edited', r.status === 200 && /ZZTEST WA edit/.test(r.body.template.body) && r.body.template.isSystem, r.body);
    await call('PUT', `${C}/templates/${tDoc.id}`, T.admin, { body: docBefore }); // put the wording back
    r = await call('DELETE', `${C}/templates/${tDoc.id}`, T.admin);
    Z.check('T9 a system template cannot be deleted (409)', r.status === 409 && /cannot be deleted/.test(r.body.error), r.body);
    r = await call('DELETE', `${C}/templates/${own.id}`, T.rec);
    Z.check('T10 a recruiter cannot delete (403)', r.status === 403, r.body);
    r = await call('DELETE', `${C}/templates/${own.id}`, T.acc);
    Z.check('T11 Accounts deletes its own template', r.status === 200, r.body);
    r = await call('GET', `${C}/templates?module=Accounts`, T.acc);
    Z.check('T12 module filter keeps that module + General', r.body.templates.every((t) => ['Accounts', 'General'].includes(t.module)) && !r.body.templates.some((t) => t.id === own.id), r.body.templates.map((t) => t.module));
    const tsAudit = await prisma.auditLog.count({ where: { entity: 'WaTemplate', entityId: { in: [own.id, tDoc.id] } } });
    Z.check('T13 template add / edit / delete are audited', tsAudit >= 4, tsAudit);

    // ------------------------------------------------------------------ 5. recipients (scope, privacy, placeholders)
    r = await call('POST', `${C}/recipients`, T.bde, { entityType: 'candidate', ids: cIds });
    Z.check('A1 BDE cannot WhatsApp candidates (403) and no number leaks', r.status === 403 && !/9000000/.test(JSON.stringify(r.body)), r.body);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'candidate', ids: [...cIds, cOut.id] });
    const byId = new Map((r.body.recipients || []).map((p) => [p.id, p]));
    Z.check('A2 recruiter gets their candidates, not the one outside their area', r.status === 200 && byId.size === 7 && !byId.has(cOut.id), [r.status, byId.size]);
    Z.check('A3 number cleaned to 91 + 10 digits, invalid flagged', byId.get(c1.id).cleaned === '919000000601' && byId.get(c2.id).cleaned === '919000000602' && byId.get(c3.id).valid === false && byId.get(c3.id).numberProblem, [...byId.values()].map((p) => p.cleaned));
    Z.check('A4 opt-in: consent on record counts, nothing else does', byId.get(c2.id).optedIn === true && byId.get(c1.id).optedIn === false && byId.get(c1.id).optInRequired === true);
    Z.check('A5 do-not-contact: candidate flag counts; the Omni-Channel STOP list counts (when present)', byId.get(c6.id).dnc === true && (stopMade ? byId.get(c7.id).dnc === true : true) && byId.get(c1.id).dnc === false, [byId.get(c6.id).dnc, byId.get(c7.id).dnc]);
    Z.check('A6 placeholder values: name (first name), job title, month; no client name', byId.get(c1.id).vars.name === 'ZZTEST' && byId.get(c1.id).vars.job_title === req.title && !!byId.get(c1.id).vars.month && !JSON.stringify(r.body).includes(client.name), byId.get(c1.id).vars);
    r = await call('POST', `${C}/recipients`, T.recOther, { entityType: 'candidate', ids: [c1.id] });
    Z.check('A7 another department recruiter gets nobody for these ids', r.status === 200 && r.body.recipients.length === 0, r.body);
    r = await call('POST', `${C}/recipients`, T.hr, { entityType: 'employee', ids: [empOf(uRec).id, empOf(uTl).id] });
    Z.check('A8 HR can WhatsApp employees (number + first name)', r.status === 200 && r.body.recipients.length === 2 && r.body.recipients.every((p) => p.valid && p.vars.name && !p.optInRequired), r.body);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'employee', ids: [empOf(uTl).id] });
    Z.check('A9 a recruiter cannot WhatsApp employees (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/recipients`, T.acc, { entityType: 'vendor', ids: [vendor.id, vendorNoPhone.id] });
    const vb = new Map((r.body.recipients || []).map((p) => [p.id, p]));
    Z.check('A10 Accounts can WhatsApp vendors; a vendor with no phone is flagged', r.status === 200 && vb.get(vendor.id).valid && !vb.get(vendorNoPhone.id).valid && vb.get(vendor.id).optInRequired, r.body);
    r = await call('POST', `${C}/recipients`, T.hr, { entityType: 'vendor', ids: [vendor.id] });
    Z.check('A11 HR cannot WhatsApp vendors (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/recipients`, T.acc, { entityType: 'invoice', ids: [inv.id] });
    const ip = (r.body.recipients || [])[0] || {};
    Z.check('A12 Accounts invoice: client billing contact, {amount} {invoice_no} {due_date} filled', r.status === 200 && ip.cleaned === '919000000502' && ip.vars.invoice_no === `ZZWA-${RUN}` && /11,800/.test(ip.vars.amount) && /20 Oct 2026/.test(ip.vars.due_date), ip);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'invoice', ids: [inv.id] });
    Z.check('A13 a recruiter cannot WhatsApp about invoices (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/recipients`, T.bde, { entityType: 'client', ids: [client.id] });
    Z.check('A14 BDE can WhatsApp their client contact', r.status === 200 && r.body.recipients.length === 1 && r.body.recipients[0].cleaned === '919000000501', r.body);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'planet', ids: ['x'] });
    Z.check('A15 unknown kind of person is refused', r.status === 403 || r.status === 400, r.status);

    // ------------------------------------------------------------------ 6. one send + log (append-only, filters, masking, CSV)
    r = await call('POST', `${C}/log`, T.rec, { entityType: 'candidate', entityId: c5.id, number: '99999 00000', templateId: tDoc.id, messageLength: 90 });
    Z.check('S1 individual send is logged ("Opened") and warns when not opted in', r.status === 201 && /Not opted in/.test(r.body.warning || ''), r.body);
    r = await call('POST', `${C}/log`, T.rec, { entityType: 'candidate', entityId: c2.id, templateId: tDoc.id, messageLength: 80 });
    Z.check('S2 an opted-in person: logged without a warning (number taken from the record)', r.status === 201 && !r.body.warning, r.body);
    r = await call('POST', `${C}/log`, T.rec, { entityType: 'candidate', entityId: c6.id, templateId: tDoc.id });
    Z.check('S3 do-not-contact: individual send refused (409)', r.status === 409, r.body);
    r = await call('POST', `${C}/log`, T.rec, { entityType: 'candidate', entityId: c1.id, number: '12', templateId: tDoc.id });
    Z.check('S4 a bad number typed in the box is refused (400)', r.status === 400, r.body);
    r = await call('POST', `${C}/log`, T.bde, { entityType: 'candidate', entityId: c1.id, templateId: tDoc.id });
    Z.check('S5 BDE cannot log a candidate send (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/log`, T.recOther, { entityType: 'candidate', entityId: c1.id, templateId: tDoc.id });
    Z.check('S6 a recruiter outside the candidate\'s area cannot log (404)', r.status === 404, r.body);
    r = await call('POST', `${C}/log`, T.hr, { entityType: 'employee', entityId: empOf(uTl).id, templateId: tPay.id, messageLength: 60 });
    Z.check('S7 HR logs an employee send', r.status === 201, r.body);
    r = await call('POST', `${C}/log`, T.acc, { entityType: 'invoice', entityId: inv.id, templateId: tDue.id, messageLength: 120 });
    Z.check('S8 Accounts logs an invoice send', r.status === 201, r.body);
    r = await call('POST', `${C}/log`, T.acc, { entityType: 'vendor', entityId: vendor.id, messageLength: 20 });
    Z.check('S9 Accounts logs a vendor send, typed by hand (no template)', r.status === 201, r.body);
    await call('POST', `${C}/log`, T.rec, { entityType: 'candidate', entityId: c1.id, templateId: tInterview.id, messageLength: 10 });
    await call('PUT', `${C}/log/x`, T.admin, {});
    r = await call('DELETE', `${C}/log/anything`, T.admin);
    Z.check('S10 the log is append-only: no edit or delete route exists', r.status === 404, r.status);

    r = await call('GET', `${C}/log`, T.rec);
    const recRows = r.body.rows || [];
    Z.check('M1 the recruiter sees only their own rows, with the full number', r.status === 200 && recRows.length === 3 && recRows.every((x) => x.sentBy === uRec.name && !x.numberMasked && /^\+91/.test(x.number)) && /does not tell/i.test(r.body.note), r.body);
    Z.check('M2 every row says Opened', recRows.every((x) => x.status === 'Opened'));
    r = await call('GET', `${C}/log`, T.admin);
    Z.check('M3 admin sees everyone\'s rows with full numbers', r.body.total >= 6 && r.body.rows.every((x) => !x.numberMasked), r.body.total);
    r = await call('GET', `${C}/log`, T.mgr);
    Z.check('M4 a manager sees all rows but numbers are masked', r.body.total >= 6 && r.body.rows.every((x) => x.numberMasked && /•/.test(x.number) && !/9000000/.test(x.number)), r.body.rows[0]);
    r = await call('GET', `${C}/log`, T.hr);
    Z.check('M5 HR sees employee rows (full number) and no candidate or invoice rows of others', r.body.rows.length >= 1 && r.body.rows.every((x) => x.entityType === 'employee'), r.body.rows.map((x) => x.entityType));
    r = await call('GET', `${C}/log`, T.acc);
    Z.check('M6 Accounts sees vendor + invoice rows, not candidate rows', r.body.rows.length >= 2 && r.body.rows.every((x) => ['vendor', 'invoice', 'client'].includes(x.entityType)), r.body.rows.map((x) => x.entityType));
    r = await call('GET', `${C}/log`, T.tl);
    Z.check('M7 a team lead sees only their own rows (none yet)', r.status === 200 && r.body.total === 0, r.body.total);
    r = await call('GET', `${C}/log?module=ATS`, T.admin);
    Z.check('M8 filter: module', r.body.rows.length >= 3 && r.body.rows.every((x) => x.module === 'ATS'), r.body.rows.map((x) => x.module));
    r = await call('GET', `${C}/log?templateId=${tDoc.id}`, T.admin);
    Z.check('M9 filter: template', r.body.rows.length >= 2 && r.body.rows.every((x) => x.templateId === tDoc.id), r.body.rows.length);
    const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
    r = await call('GET', `${C}/log?from=${today}&to=${today}`, T.admin);
    const nToday = r.body.total;
    r = await call('GET', `${C}/log?from=2020-01-01&to=2020-01-31`, T.admin);
    Z.check('M10 filter: date range (today finds rows, an old month finds none)', nToday >= 6 && r.body.total === 0, [nToday, r.body.total]);
    r = await call('GET', `${C}/log/export.csv`, T.rec);
    Z.check('X1 a recruiter cannot export (403)', r.status === 403, r.status);
    r = await call('GET', `${C}/log/export.csv`, T.mgr);
    Z.check('X2 a manager cannot export (403)', r.status === 403, r.status);
    r = await call('GET', `${C}/log/export.csv?module=ATS`, T.admin);
    Z.check('X3 admin exports a CSV (header, Opened, number, template)', r.status === 200 && /text\/csv/.test(r.headers.get('content-type')) && /Date and time/.test(r.text) && /Opened/.test(r.text) && /Document request/.test(r.text), r.text.slice(0, 200));
    const exAudit = await prisma.auditLog.count({ where: { action: 'WhatsApp log exported', userId: uAdmin.id } });
    Z.check('X4 the export is audited', exAudit >= 1, exAudit);
    r = await call('GET', `${C}/log/export.csv`, T.acc);
    Z.check('X5 Accounts CSV has no candidate rows', r.status === 200 && !/ZZTEST WA Cand/.test(r.text) && /Vendor|Client|Suresh/.test(r.text), r.text.slice(0, 300));

    // ------------------------------------------------------------------ 7. opt-in flag
    r = await call('POST', `${C}/optin`, T.rec, { entityType: 'candidate', ids: [c1.id, c5.id], optedIn: true });
    Z.check('O1 marking opted in needs a source (400)', r.status === 400 && /where the permission/i.test(r.body.error), r.body);
    r = await call('POST', `${C}/optin`, T.rec, { entityType: 'candidate', ids: [c1.id, c3.id, c4.id, cOut.id], optedIn: true, source: 'ZZTEST WA asked on a call' });
    Z.check('O2 bulk "Mark opted in": only people in their reach change (3 of 4)', r.status === 200 && r.body.changed === 3 && r.body.skipped === 1, r.body);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'candidate', ids: [c1.id] });
    Z.check('O3 the flag shows with its source', r.body.recipients[0].optedIn === true && /asked on a call/.test(r.body.recipients[0].optInSource), r.body.recipients[0]);
    r = await call('POST', `${C}/optin`, T.bde, { entityType: 'candidate', ids: [c1.id], optedIn: true, source: 'x' });
    Z.check('O4 BDE cannot set candidate opt-in (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/optin`, T.acc, { entityType: 'vendor', ids: [vendor.id], optedIn: true, source: 'ZZTEST WA vendor agreed by mail' });
    Z.check('O5 Accounts marks a vendor opted in', r.status === 200 && r.body.changed === 1, r.body);
    r = await call('POST', `${C}/optin`, T.acc, { entityType: 'employee', ids: [empOf(uTl).id], optedIn: true, source: 'x' });
    Z.check('O6 employees have no opt-in flag (internal: allowed)', r.status === 400, r.body);
    const optAudit = await prisma.auditLog.count({ where: { action: 'WhatsApp opt-in marked', entityId: { in: [c1.id, c3.id, c4.id, vendor.id] } } });
    Z.check('O7 every opt-in change is audited', optAudit === 4, optAudit);

    // ------------------------------------------------------------------ 8. bulk queue
    r = await call('POST', `${C}/bulk`, T.bde, { entityType: 'candidate', ids: cIds, templateId: tDoc.id });
    Z.check('B0 BDE cannot start a candidate bulk (403)', r.status === 403, r.body);
    r = await call('POST', `${C}/bulk`, T.rec, { entityType: 'candidate', ids: cIds, templateId: tInterview.id });
    Z.check('B1 a template whose details are missing for everybody leaves nobody to send (409, plain reason)', r.status === 409 && /missing/i.test(r.body.error), r.body);
    r = await call('POST', `${C}/bulk`, T.rec, { entityType: 'candidate', ids: [...cIds, cOut.id], templateId: tDoc.id });
    const s1 = (r.body || {}).session;
    const cts = s1 && s1.counts;
    // c1 ok, c2 ok (consent), c3 invalid, c4 opted-in but duplicate of c1, c5 not opted in, c6 dnc, c7 stop list (dnc, or not opted in when the module is absent), out-of-reach 1
    Z.check('B2 queue created: 2 will be sent', r.status === 201 && cts.pending === 2 && cts.sent === 0, r.body);
    Z.check('B3 skips: invalid (number + the one out of reach), duplicate, not opted in, do not contact', cts.skipped.invalid === 2 && cts.skipped.duplicate === 1 && cts.skipped.not_opted_in === (stopMade ? 1 : 2) && cts.skipped.dnc === (stopMade ? 2 : 1), cts);
    Z.check('B4 summary words are plain', s1.reasons.not_opted_in === 'Not opted in' && s1.reasons.dnc === 'Do not contact');
    r = await call('GET', `${C}/bulk/active`, T.rec);
    Z.check('B5 the Resume banner finds the open list', r.body.session && r.body.session.id === s1.id && r.body.session.counts.pending === 2, r.body);
    r = await call('GET', `${C}/bulk/${s1.id}`, T.rec);
    const open = r.body.session;
    const pend = open.items.filter((i) => i.state === 'pending');
    Z.check('B6 the list gives each pending person a number and their own message preview', pend.length === 2 && pend.every((p) => /^91900000060[12]$/.test(p.number) && /ZZTEST/.test(p.message) && !/\{/.test(p.message)), pend);
    Z.check('B7 skipped people carry no number', open.items.filter((i) => i.state === 'skipped').every((i) => !i.number && !i.message));
    r = await call('GET', `${C}/bulk/${s1.id}`, T.tl);
    Z.check('B8 another login cannot open my list (404)', r.status === 404, r.status);
    r = await call('POST', `${C}/bulk/${s1.id}/sent`, T.rec, { personId: c5.id });
    Z.check('B9 a skipped person cannot be marked sent (409)', r.status === 409, r.body);
    r = await call('POST', `${C}/bulk/${s1.id}/sent`, T.rec, { personId: c1.id });
    Z.check('B10 Send -> marked Sent (1 of 2)', r.status === 200 && r.body.session.counts.sent === 1 && r.body.session.counts.pending === 1 && r.body.session.status === 'open', r.body);
    r = await call('POST', `${C}/bulk/${s1.id}/sent`, T.rec, { personId: c1.id });
    Z.check('B11 marking the same person twice is harmless (still 1 sent, one log row)', r.status === 200 && r.body.already && r.body.session.counts.sent === 1, r.body);
    r = await call('GET', `${C}/log?templateId=${tDoc.id}`, T.admin);
    Z.check('B12 the bulk send is in the log as a bulk row with the batch', r.body.rows.filter((x) => x.source === 'bulk').length === 1, r.body.rows.map((x) => x.source));
    // close and reopen: state persists
    r = await call('GET', `${C}/bulk/active`, T.rec);
    Z.check('B13 closing and reopening keeps "1/2 sent"', r.body.session && r.body.session.counts.sent === 1 && r.body.session.counts.total === 8, r.body.session && r.body.session.counts);
    r = await call('POST', `${C}/bulk/${s1.id}/sent`, T.rec, { personId: c2.id });
    Z.check('B14 last person sent -> list is done, summary has the skips', r.status === 200 && r.body.session.status === 'done' && r.body.session.counts.sent === 2 && r.body.session.counts.skippedTotal === 6, r.body.session && [r.body.session.status, r.body.session.counts]);
    r = await call('GET', `${C}/bulk/active`, T.rec);
    Z.check('B15 no Resume banner once done', r.body.session === null, r.body);
    r = await call('POST', `${C}/bulk`, T.rec, { entityType: 'candidate', ids: [c1.id, c2.id], templateId: tDoc.id });
    const s2 = r.body.session;
    r = await call('POST', `${C}/bulk`, T.rec, { entityType: 'candidate', ids: [c1.id], templateId: tDoc.id });
    const s3 = r.body.session;
    r = await call('GET', `${C}/bulk/active`, T.rec);
    Z.check('B16 a new list closes the older open one (one Resume banner)', r.body.session.id === s3.id && s2.id !== s3.id, r.body);
    r = await call('POST', `${C}/bulk/${s3.id}/discard`, T.rec);
    Z.check('B17 discard closes it', r.status === 200 && r.body.session.status === 'discarded', r.body);
    r = await call('POST', `${C}/bulk`, T.acc, { entityType: 'invoice', ids: [inv.id], templateId: tDue.id });
    Z.check('B18 Accounts: invoice reminder queue works (amount, number, due date filled)', r.status === 201 && r.body.session.counts.pending === 1, r.body);
    const sInv = r.body.session;
    r = await call('GET', `${C}/bulk/${sInv.id}`, T.acc);
    const ipend = r.body.session.items.find((i) => i.state === 'pending');
    Z.check('B19 the invoice message is complete (no braces left)', ipend && /ZZWA-/.test(ipend.message) && /11,800/.test(ipend.message) && !/\{/.test(ipend.message), ipend);
    await call('POST', `${C}/bulk/${sInv.id}/discard`, T.acc);
    r = await call('POST', `${C}/bulk`, T.acc, { entityType: 'vendor', ids: [vendor.id, vendorNoPhone.id], templateId: tDoc.id });
    Z.check('B20 vendors: opted-in one queued, no-phone one skipped (invalid)', r.status === 201 && r.body.session.counts.pending === 1 && r.body.session.counts.skipped.invalid === 1, r.body);
    await call('POST', `${C}/bulk/${r.body.session.id}/discard`, T.acc);
    r = await call('POST', `${C}/bulk`, T.hr, { entityType: 'employee', ids: [empOf(uRec).id, empOf(uTl).id], templateId: tPay.id });
    Z.check('B21 HR employees: no opt-in needed (internal), queue of 2', r.status === 201 && r.body.session.counts.pending === 2, r.body);
    await call('POST', `${C}/bulk/${r.body.session.id}/discard`, T.hr);

    // ------------------------------------------------------------------ 9. daily limit (soft warning), country code, switches
    r = await call('PUT', `${C}/settings`, T.acc, { dailyBulkLimit: 1 });
    Z.check('D1 Accounts can change the daily limit', r.status === 200 && r.body.settings.dailyBulkLimit === 1, r.body);
    r = await call('POST', `${C}/bulk`, T.rec, { entityType: 'candidate', ids: [c1.id, c2.id], templateId: tDoc.id });
    Z.check('D2 over the daily limit: a soft warning, the queue still opens', r.status === 201 && r.body.session.limit.overLimit === true && r.body.session.limit.sentToday >= 2 && r.body.session.limit.dailyBulkLimit === 1, r.body);
    await call('POST', `${C}/bulk/${r.body.session.id}/discard`, T.rec);
    r = await call('PUT', `${C}/settings`, T.admin, { dailyBulkLimit: 0 });
    Z.check('D3 a silly limit is refused in plain words', r.status === 400 && /1 to 5000/.test(r.body.error), r.body);
    await call('PUT', `${C}/settings`, T.admin, { dailyBulkLimit: 200 });
    r = await call('PUT', `${C}/settings`, T.hr, { defaultCountryCode: '44' });
    Z.check('D4 HR changes the default country code', r.status === 200 && r.body.settings.defaultCountryCode === '44', r.body);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'candidate', ids: [c1.id] });
    Z.check('D5 a 10-digit number now gets the new code', r.body.recipients[0].cleaned === '449000000601', r.body.recipients[0]);
    r = await call('PUT', `${C}/settings`, T.hr, { defaultCountryCode: 'abc' });
    Z.check('D6 a bad country code is refused', r.status === 400, r.body);
    await call('PUT', `${C}/settings`, T.hr, { defaultCountryCode: '91' });
    r = await call('PUT', `${C}/settings`, T.admin, { modules: { ats: false } });
    Z.check('D7 module switch: ATS off', r.status === 200 && r.body.settings.modules.ats === false && r.body.settings.modules.hrms === true, r.body);
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'candidate', ids: [c1.id] });
    const offAts = r.status;
    r = await call('POST', `${C}/recipients`, T.hr, { entityType: 'employee', ids: [empOf(uTl).id] });
    Z.check('D8 ATS off blocks candidates (403) but HRMS employees still work', offAts === 403 && r.status === 200, [offAts, r.status]);
    await call('PUT', `${C}/settings`, T.admin, { modules: { ats: true } });
    r = await call('PUT', `${C}/settings`, T.admin, { enabled: false });
    Z.check('D9 master switch OFF saved', r.status === 200 && r.body.settings.enabled === false, r.body);
    const offCalls = [];
    offCalls.push((await call('POST', `${C}/recipients`, T.rec, { entityType: 'candidate', ids: [c1.id] })).status);
    offCalls.push((await call('POST', `${C}/recipients`, T.hr, { entityType: 'employee', ids: [empOf(uTl).id] })).status);
    offCalls.push((await call('POST', `${C}/recipients`, T.acc, { entityType: 'invoice', ids: [inv.id] })).status);
    offCalls.push((await call('POST', `${C}/log`, T.rec, { entityType: 'candidate', entityId: c1.id })).status);
    offCalls.push((await call('POST', `${C}/bulk`, T.rec, { entityType: 'candidate', ids: [c1.id], templateId: tDoc.id })).status);
    offCalls.push((await call('POST', `${C}/bulk`, T.admin, { entityType: 'employee', ids: [empOf(uTl).id], templateId: tPay.id })).status);
    Z.check('D10 master switch OFF blocks every send, even for Admin (all 403)', offCalls.every((s) => s === 403), offCalls);
    r = await call('GET', `${C}/config`, T.rec);
    Z.check('D11 config tells the screens to hide the buttons (gates all closed)', r.body.settings.enabled === false && Object.values(r.body.gates).every((g) => !g.ok), r.body.gates);
    r = await call('GET', `${C}/log`, T.admin);
    Z.check('D12 the log and the templates stay readable while it is off', r.status === 200 && (await call('GET', `${C}/templates`, T.admin)).status === 200);
    await call('PUT', `${C}/settings`, T.admin, { enabled: true });
    r = await call('POST', `${C}/recipients`, T.rec, { entityType: 'candidate', ids: [c1.id] });
    Z.check('D13 switched back ON works again', r.status === 200, r.status);
    const setAudit = await prisma.auditLog.count({ where: { action: 'WhatsApp quick chat settings changed', userId: { in: [uAdmin.id, uHr.id, uAcc.id] } } });
    Z.check('D14 settings changes are audited', setAudit >= 6, setAudit);
    r = await call('GET', `${C}/config`, T.admin);
    Z.check('D15 nothing was sent anywhere: this module has no outbound call (no fetch / http in its files)', ['waChat.js', 'waLink.js'].every((f) => !/fetch\(|https?\.request|require\('(axios|node-fetch|https?)'\)/.test(fs.readFileSync(path.join(BACK, 'src/utils', f), 'utf8'))) && !/fetch\(|require\('axios'\)/.test(fs.readFileSync(path.join(BACK, 'src/routes/waChat.js'), 'utf8')));
    Z.check('D16 no number travels in a URL: no route takes a number in the path or query', !/:number|:phone|query\.(number|phone)/.test(fs.readFileSync(path.join(BACK, 'src/routes/waChat.js'), 'utf8')));
  } finally {
    // ------------------------------------------------------------------ cleanup
    await restoreSettings();
    const uids = Z.made.users;
    for (const id of uids) {
      await prisma.$executeRawUnsafe('DELETE FROM "WaLog" WHERE userId = ?', id).catch(() => {});
      await prisma.$executeRawUnsafe('DELETE FROM "WaBulkSession" WHERE userId = ?', id).catch(() => {});
    }
    await prisma.$executeRawUnsafe('DELETE FROM "WaOptIn" WHERE setByName LIKE \'ZZTEST WA%\'').catch(() => {});
    await prisma.$executeRawUnsafe('DELETE FROM "WaTemplate" WHERE name LIKE \'ZZTEST WA%\'').catch(() => {});
    await prisma.auditLog.deleteMany({ where: { entity: { in: ['WaTemplate', 'WaSettings', 'WaLog'] }, OR: [{ userId: { in: uids } }, { actorName: { contains: 'ZZTEST WA' } }] } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: [vendor.id, vendorNoPhone.id] } }, { toValue: { contains: 'ZZTEST WA' } }] } }).catch(() => {});
    if (stopMade) { try { const S = require(path.join(BACK, 'src/outreach/store')); await S.run('DELETE FROM "OutreachSuppression" WHERE addressHash = ?', stopMade); } catch { /* none */ } }
    await prisma.officeVendor.deleteMany({ where: { name: { contains: 'ZZTEST WA' } } }).catch(() => {});
    const left = await Z.cleanup();
    console.log('cleanup left', JSON.stringify(left));
    const rem = {};
    rem.templates = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WaTemplate" WHERE name LIKE \'ZZTEST WA%\''))[0].n;
    rem.logs = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WaLog" WHERE recipientName LIKE \'%ZZTEST WA%\' OR userName LIKE \'ZZTEST WA%\''))[0].n;
    rem.optin = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WaOptIn" WHERE setByName LIKE \'ZZTEST WA%\''))[0].n;
    rem.sessions = (await prisma.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WaBulkSession" WHERE userName LIKE \'ZZTEST WA%\''))[0].n;
    rem.vendors = await prisma.officeVendor.count({ where: { name: { contains: 'ZZTEST WA' } } });
    const nz = Object.values(rem).map(Number).reduce((a, b) => a + b, 0) + Object.values(left).reduce((a, b) => a + b, 0);
    Z.check('Z1 cleanup: zero ZZTEST WA rows left in the sandbox', nz === 0, { rem, left });
  }
  await Z.finish();
})().catch(async (e) => { console.error('FATAL', e); try { await prisma.$disconnect(); } catch { /* ignore */ } process.exit(1); });
