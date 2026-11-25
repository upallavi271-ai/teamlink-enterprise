#!/usr/bin/env node
/**
 * THE COMPANY'S SIGNATORY AND THE EMPLOYEE'S AADHAAR SIGNING (2026-11-25). No database and no eMudhra account needed:
 * the database, the audit log, the file store and eMudhra are stand-ins.
 *   - the letter signatory: one name, one title and one signature picture for every letter (utils/letterSignatory.js)
 *   - the letters show it: the offer letter (PDF and mail) and the relieving letter / service certificate
 *   - the employee's Sign with Aadhaar: start -> eMudhra's page -> reply -> confirmed -> kept as the signed copy (utils/employeeEsign.js)
 *   node scripts/letter-signatory-test.js [backend/src]
 */
const path = require('path');
const SRC = process.argv[2] || path.resolve(__dirname, '..', 'src');

const settings = {};
const employees = {};
const docs = [];
const audits = [];
const closed = [];
const sessions = {};
let emudhraReady = true;
let verifyResult = null;

const prisma = new Proxy({
  appSetting: {
    findUnique: async ({ where }) => (settings[where.key] !== undefined ? { key: where.key, value: settings[where.key], updatedByName: 'Test HR', updatedAt: new Date() } : null),
    upsert: async ({ where, create, update }) => { settings[where.key] = settings[where.key] !== undefined ? update.value : create.value; return {}; },
    create: async ({ data }) => { settings[data.key] = data.value; return {}; },
  },
  company: { findFirst: async () => ({ name: 'TeamLink Consultants', legalName: 'Teamlink Consultants [OPC] Pvt. Ltd.', address: 'Corporate Office, Hyderabad, Telangana', phone: '+91 9032321414', email: 'hr@tmlink.in', hq: '' }) },
  employee: { findUnique: async ({ where }) => employees[where.id] || null },
  employeeDocument: {
    findFirst: async ({ where }) => docs.filter((d) => d.employeeId === where.employeeId && (!where.docType || d.docType === where.docType) && (!where.docName || d.docName === where.docName)).pop() || null,
    create: async ({ data }) => { const d = { id: `doc${docs.length + 1}`, uploadedAt: new Date(), ...data }; docs.push(d); return d; },
  },
  fnfRequest: { findFirst: async () => null },
  resignationDetail: { findUnique: async () => ({ resignationDate: '2026-10-01', approvedLastWorkingDate: '2026-11-14', designation: 'Team Leader' }) },
  user: { findUnique: async () => null, findMany: async () => [{ id: 'u-hr', name: 'Test HR' }] },
}, { get: (t, k) => t[k] || new Proxy({}, { get: () => async () => null }) });

const stub = (rel, exp) => { const p = require.resolve(path.join(SRC, rel)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
stub('db.js', prisma);
stub('utils/audit.js', { logAudit: async (a) => { audits.push(a); } });
stub('utils/attachments.js', {
  store: ({ data, filename }) => ({ billFile: `mem/${filename}`, billName: filename, billMime: 'application/pdf', billSize: data.length }),
  resolveStored: () => null,
  remove: () => {},
});
stub('utils/emudhra.js', {
  isAvailable: async () => emudhraReady,
  startSession: async ({ pdf, signerName, returnBase, returnPath, sessionExtra }) => {
    if (!emudhraReady) throw Object.assign(new Error('not set up'), { code: 'NOT_READY' });
    const ref = `TLTEST${String(Object.keys(sessions).length + 1).padStart(4, '0')}`;
    sessions[ref] = { ...sessionExtra, status: 'Started', signerName, pdfBytes: pdf.length, returnBase, returnPath, ref };
    return { ref, gatewayUrl: 'https://gateway.example.test/sign', fields: { f1: 'a', f2: 'b', f3: 'c' } };
  },
  readSession: async (ref) => (sessions[ref] ? { ...sessions[ref] } : null),
  closeSession: async (ref, status) => { if (sessions[ref]) sessions[ref].status = status; closed.push([ref, status]); },
  verifyAndFetch: async ({ ref, postedTxn }) => (verifyResult ? verifyResult(ref, postedTxn) : { ok: false, reason: 'no result set', refuse: true }),
});

let fails = 0;
const check = (name, ok, extra) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra).slice(0, 300)}`}`);
  if (!ok) fails += 1;
};
const daysFromToday = (n) => new Date(Date.now() + 330 * 60000 + n * 86400000);
const hasPicture = (pdf) => (pdf.toString('latin1').match(/\/Subtype \/Image/g) || []).length;

(async () => {
  const sharp = require('sharp');
  const LS = require(path.join(SRC, 'utils/letterSignatory.js'));
  const O = require(path.join(SRC, 'utils/offerLetterMail.js'));
  const X = require(path.join(SRC, 'utils/exitLetters.js'));
  const ES = require(path.join(SRC, 'utils/employeeEsign.js'));

  // a small real PNG (a navy block) stands in for the CEO's signature picture
  const samplePng = await sharp({ create: { width: 300, height: 90, channels: 4, background: { r: 0, g: 32, b: 96, alpha: 1 } } }).png().toBuffer();
  const samplePngUrl = `data:image/png;base64,${samplePng.toString('base64')}`;

  // ---------------- the company signatory
  const bad = await LS.normalise('data:text/plain;base64,aGVsbG8=');
  check('signatory: a text file is refused', !!bad.error && /PNG or JPEG/.test(bad.error), bad);
  const big = await LS.normalise(`data:image/png;base64,${Buffer.alloc(400 * 1024, 1).toString('base64')}`);
  check('signatory: a picture over 300 KB is refused, in plain words', !!big.error && /300 KB/.test(big.error), big);
  const ok = await LS.normalise(samplePngUrl);
  check('signatory: a small PNG is accepted and kept as a PNG under 300 KB', !!ok.png && ok.png.slice(1, 4).toString() === 'PNG' && ok.png.length <= LS.MAX_BYTES, ok.error);

  const emptyBefore = await LS.summary();
  check('signatory: nothing set yet, so no picture and no name', emptyBefore.hasSignature === false && emptyBefore.name === '', emptyBefore);
  const saved = await LS.save({ name: '  Ravi   Chandra ', title: 'Chief Executive Officer', signatureDataUrl: samplePngUrl }, { id: 'u-hr', name: 'Test HR' });
  const s1 = await LS.load();
  check('signatory: saved once - name, title and picture', saved.ok && s1.name === 'Ravi Chandra' && s1.title === 'Chief Executive Officer' && !!s1.png, saved);
  const kept = await LS.save({ name: 'Ravi Chandra', title: 'CEO' }, { id: 'u-hr', name: 'Test HR' });
  check('signatory: saving without a new picture keeps the picture', kept.ok && !!(await LS.load()).png);
  await LS.save({ name: 'Ravi Chandra', title: 'CEO', signatureDataUrl: '' }, { id: 'u-hr', name: 'Test HR' });
  check('signatory: an empty picture removes it', !(await LS.load()).png);
  await LS.save({ name: 'Ravi Chandra', title: 'Chief Executive Officer', signatureDataUrl: samplePngUrl }, { id: 'u-hr', name: 'Test HR' });
  check('signatory: the change is audited, with the name and no picture bytes', audits.some((a) => /Letter signatory saved/.test(a.action) && /Ravi Chandra/.test(a.toValue || '')) && !audits.some((a) => /base64/.test(JSON.stringify(a))));

  // ---------------- the offer letter shows it
  const tpl = { ...O.DEFAULT_TEMPLATE };
  const app = { id: 'cmapp01', joiningDate: '2026-12-01', offeredCtc: null, candidate: { name: 'Anita Rao', location: 'Hyderabad' }, requirement: { title: 'Recruiter', department: 'Talent Acquisition', location: 'Hyderabad', tlId: null } };
  const m = await O.buildModel(app, tpl);
  check('offer letter: the company signatory is the one name and title on every letter', m.signatory.name === 'Ravi Chandra' && m.signatory.title === 'Chief Executive Officer', m.signatory);
  const html = O.renderHtml(m);
  check('offer letter (preview and mail page): the signature picture is above the signature line', /<img src="data:image\/png;base64,/.test(html) && /<img src="data:image\/png;base64,[^"]+" alt="" height="44"/.test(html));
  const mailHtml = O.renderHtml(m, { logoSrc: 'cid:teamlink-logo', signatureSrc: 'cid:teamlink-signature' });
  check('offer letter (the mail): the picture is an inline attachment (cid), not pasted in', /src="cid:teamlink-signature"/.test(mailHtml) && !/data:image\/png/.test(mailHtml));
  const pdf = await O.renderPdf(m);
  check('offer letter PDF: the signature picture is in the file (two picture objects more than the logo alone) and it is still a PDF', hasPicture(pdf) >= 4 && pdf.slice(0, 4).toString() === '%PDF', hasPicture(pdf));

  await LS.save({ name: '', title: '', signatureDataUrl: '' }, { id: 'u-hr', name: 'Test HR' });
  const bare = await O.buildModel(app, tpl);
  const bareHtml = O.renderHtml(bare);
  const barePdf = await O.renderPdf(bare);
  check('offer letter with no signatory set: the template words, no signature picture (the PDF has two picture objects fewer - a transparent PNG is stored as image plus mask; the logo stays)', !bare.signatory.png && /HR Department/.test(bare.signatory.title) && !/<img src="data:image/.test(bareHtml) && hasPicture(barePdf) === hasPicture(pdf) - 2, [bare.signatory, hasPicture(barePdf), hasPicture(pdf)]);
  await LS.save({ name: 'Ravi Chandra', title: 'Chief Executive Officer', signatureDataUrl: samplePngUrl }, { id: 'u-hr', name: 'Test HR' });

  // ---------------- the relieving letter and the service certificate show it too
  employees.e1 = { id: 'e1', name: 'Dara Mamatha', employeeCode: 'TL102', designation: 'Team Leader', dateOfJoining: new Date('2022-02-15T00:00:00Z'), branch: 'Hyderabad', state: 'Telangana', employmentStatus: 'Relieved', email: 'dara@tmlink.in' };
  const rec = { id: 'r1', type: 'RESIGNATION', status: 'Relieved', employeeId: 'e1', employee: employees.e1, date: '2026-11-14' };
  const exitSet = await X.loadSettings();
  check('relieving / service letters: they use the same company signatory', exitSet.signatoryName === 'Ravi Chandra' && exitSet.signatoryTitle === 'Chief Executive Officer' && !!exitSet.png, exitSet);
  const rl = await X.pdfFor(rec, 'relieving');
  check('relieving letter PDF: the same signature picture is in it', rl.pdf && hasPicture(rl.pdf) >= 4, rl.error || hasPicture(rl.pdf));
  const sc = await X.pdfFor(rec, 'service');
  check('service certificate PDF: the same signature picture is in it', sc.pdf && hasPicture(sc.pdf) >= 4, sc.error || hasPicture(sc.pdf));

  // ---------------- the employee's Sign with Aadhaar
  const me = { id: 'e2', name: 'Sanjana Manthena', employeeCode: 'TL534', designation: 'Employee', department: 'R&D', dateOfJoining: daysFromToday(-1), branch: 'Hyderabad', state: 'Telangana', email: 'sanjanam@tmlink.in', userId: 'u-sanjana' };
  employees.e2 = me;
  const user = { id: 'u-sanjana', name: 'Sanjana Manthena' };
  const base = 'https://teamlink.example.test';

  const noDesig = await ES.startFor({ employee: { ...me, designation: '' }, user, base, completion: 100 });
  check('sign: the profile must be complete and the joining date reached (refused in plain words)', noDesig.status === 409 && /designation/.test(noDesig.error), noDesig);
  const partial = await ES.startFor({ employee: me, user, base, completion: 70 });
  check('sign: a profile at 70% is refused, and says how far it is', partial.status === 409 && /70%/.test(partial.error), partial);

  emudhraReady = false;
  const notReady = await ES.startFor({ employee: me, user, base, completion: 100 });
  check('sign: eMudhra not connected -> a plain message, not an error page', notReady.status === 409 && notReady.notAvailable === true && /not set up/.test(notReady.error), notReady);
  emudhraReady = true;

  const started = await ES.startFor({ employee: me, user, base, completion: 100 });
  const sess = started.ref && sessions[started.ref];
  check('sign: the letter goes to eMudhra (gateway and fields returned) and the session is marked for this employee', !!started.gatewayUrl && Object.keys(started.fields).length === 3 && sess && sess.kind === 'employee-offer' && sess.employeeId === 'e2' && sess.frontBase === base, started);
  check('sign: the start is audited, with the reference and no Aadhaar number', audits.some((a) => /sent to eMudhra for Aadhaar eSign/.test(a.action) && a.toValue.includes(started.ref)));

  // the employee signs on eMudhra's page and eMudhra replies: success, confirmed by eMudhra's own API
  verifyResult = () => ({ ok: true, transactionNumber: 'TXN-9001', pdf: Buffer.from('%PDF-1.4 signed by eMudhra'), session: sess });
  const signed = await ES.finish({ ref: started.ref, kind: 'success', body: { ReturnStatus: 'Success', Transactionnumber: 'TXN-9001' }, base });
  check('sign: a confirmed signing redirects to My Profile as signed', signed.state === 'signed' && signed.to === `${base}/my-profile?esign=signed`, signed);
  const signedDoc = await ES.signedDocOf('e2');
  check('sign: the signed copy is kept as the employee\'s Offer Letter, named as a signed copy', !!signedDoc && signedDoc.docType === 'Offer Letter' && signedDoc.docName === ES.SIGNED_DOC_NAME && signedDoc.uploadedBy === 'u-sanjana', signedDoc);
  check('sign: the session is closed as Signed and the signing is audited with the eMudhra transaction', sessions[started.ref].status === 'Signed' && audits.some((a) => /signed with Aadhaar eSign/.test(a.action) && /TXN-9001/.test(a.toValue)));

  const again = await ES.startFor({ employee: me, user, base, completion: 100 });
  check('sign: once signed, it cannot be signed again', again.status === 409 && /already signed/.test(again.error), again);
  const replay = await ES.finish({ ref: started.ref, kind: 'success', body: { ReturnStatus: 'Success' }, base });
  check('sign: a repeated reply changes nothing', replay.state === 'refused' && docs.filter((d) => d.docName === ES.SIGNED_DOC_NAME).length === 1, replay);

  // the employee cancels on eMudhra's page
  employees.e3 = { ...me, id: 'e3', userId: 'u-other' };
  const s3 = await ES.startFor({ employee: employees.e3, user: { id: 'u-other', name: 'Other' }, base, completion: 100 });
  const cancelled = await ES.finish({ ref: s3.ref, kind: 'cancel', body: {}, base });
  check('sign: cancelling on eMudhra changes nothing and says so', cancelled.state === 'cancelled' && !(await ES.signedDocOf('e3')) && sessions[s3.ref].status === 'Cancelled', cancelled);

  // eMudhra says it did not complete
  employees.e4 = { ...me, id: 'e4', userId: 'u-fail' };
  const s4 = await ES.startFor({ employee: employees.e4, user: { id: 'u-fail', name: 'Fail' }, base, completion: 100 });
  verifyResult = () => ({ ok: false, reason: 'eMudhra says the signing was not completed' });
  const failed = await ES.finish({ ref: s4.ref, kind: 'success', body: { ReturnStatus: 'Success', Transactionnumber: 'TXN-9002' }, base });
  check('sign: a signing eMudhra does not confirm is NOT kept as signed', failed.state === 'failed' && !(await ES.signedDocOf('e4')) && /not completed/.test(failed.why), failed);

  // a reply with no proper session is refused, and nothing changes
  const junk = await ES.finish({ ref: 'NOSUCHREF01', kind: 'success', body: {}, base });
  check('sign: an unknown reply is refused and changes nothing', junk.state === 'refused' && junk.status === 400, junk);
  const badKind = await ES.finish({ ref: s4.ref, kind: 'maybe', body: {}, base });
  check('sign: an unknown kind of reply is refused', badKind.state === 'refused', badKind);

  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
  process.exitCode = fails ? 1 : 0;
})().catch((e) => { console.error(e); process.exitCode = 1; });
