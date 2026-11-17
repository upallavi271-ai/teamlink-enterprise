#!/usr/bin/env node
/**
 * SCANNED RESUMES - OCR (Mandatory ATS gap, 2026-11-17): a scanned PDF / a photo resume is read with tesseract when its text is
 * empty or nearly empty; without tesseract the upload still works and says why nothing was read.
 * The real tesseract / pdftoppm are NOT needed: OCR_TESSERACT_BIN / OCR_PDFTOPPM_BIN point at two tiny stand-in programs written
 * here, which print known text and log how they were called. The whole pipeline is tested: empty text -> OCR -> name / e-mail /
 * phone / skills parsed, the "eng+tel+hin" language pick and the eng fall-back, max 4 pages at 200 dpi, a text PDF never OCRed,
 * GET /api/candidate-resumes/ocr-status (Admin only), and the "not installed" path (in-process and through the server).
 * SANDBOX ONLY: a private server on a COPY of the sandbox database, port TEST_PORT (default 4141).
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/resume-ocr-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-ocr-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();
const PORT = Number(process.env.TEST_PORT) || 4141;
const API = `http://localhost:${PORT}/api`;
const P = process.pid;

// --- the stand-in programs -------------------------------------------------------------------------------------------------------
const FAKE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zz-ocr-fake-'));
const LOG = path.join(FAKE_DIR, 'calls.log');
const FAKE_TESS = path.join(FAKE_DIR, 'tesseract.js');
const FAKE_PDF = path.join(FAKE_DIR, 'pdftoppm.js');
const EMAIL = `ravi.ocr.${P}@ocr-test.in`;
const PHONE = `98${String(P).padStart(8, '7').slice(-8)}`;
fs.writeFileSync(FAKE_TESS, `
const fs = require('fs'); const path = require('path');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: 'tesseract', args: a }) + '\\n');
if (a[0] === '--version') { process.stdout.write('tesseract 5.3.4\\n leptonica-1.82.0\\n'); process.exit(0); }
if (a[0] === '--list-langs') { process.stdout.write('List of available languages in "/fake/tessdata/":\\n' + (process.env.FAKE_OCR_LANGS || 'eng\\nhin\\nosd\\ntel').replace(/,/g, '\\n') + '\\n'); process.exit(0); }
const img = path.basename(a[0] || '');
if (img === 'page-1.png' || /^in\\.(png|jpg)$/.test(img)) {
  process.stdout.write('Ravi Kumar Ocrtest\\nEmail: ${EMAIL}\\nPhone: +91 ${PHONE}\\nCurrent Location: Hyderabad\\n\\nSKILLS\\nJava, Python, SQL, Spring Boot\\n\\nTotal Experience: 5 years\\n');
} else {
  process.stdout.write('EDUCATION\\nB.Tech in Computer Science, 2016\\nProjects: payroll system in Java\\n');
}
`);
fs.writeFileSync(FAKE_PDF, `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(LOG)}, JSON.stringify({ bin: 'pdftoppm', args: a }) + '\\n');
if (a[0] === '-v') { process.stderr.write('pdftoppm version 22.02.0\\n'); process.exit(0); }
const prefix = a[a.length - 1];
fs.writeFileSync(prefix + '-1.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
fs.writeFileSync(prefix + '-2.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
`);
const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const MISSING_BIN = path.join(FAKE_DIR, 'no-such-tesseract-here');

const baseEnv = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: 'ocr-test', DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
const env = { ...baseEnv, OCR_TESSERACT_BIN: FAKE_TESS, OCR_PDFTOPPM_BIN: FAKE_PDF };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const OCR = require('../src/utils/resumeOcr');
const RP = require('../src/utils/resumeParse');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 700)}` : ''}`); } };
const ip = () => `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
const call = async (method, url, body, token) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip() }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};
const upload = async (candidateId, buf, name, type, token) => {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), name);
  const r = await fetch(`${API}/candidate-resumes/${candidateId}/upload`, { method: 'POST', body: fd, headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip() } });
  let j = null; try { j = await r.json(); } catch { /* none */ } return { status: r.status, body: j };
};

// A PDF with no text at all (a drawn box: what a scanner gives), one with a page number only, and a real text PDF.
function pdf(draw) {
  // eslint-disable-next-line global-require
  const PDFDocument = require('pdfkit');
  return new Promise((resolve) => {
    const doc = new PDFDocument({ size: 'A4' });
    const parts = [];
    doc.on('data', (d) => parts.push(d));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    draw(doc);
    doc.end();
  });
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]);

let server;
function startServer(extraEnv) {
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...env, ...extraEnv }, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
}
async function waitUp() {
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
}
async function stopServer() {
  if (!server) return;
  const s = server; server = null;
  await new Promise((r) => { s.once('exit', r); s.kill(); setTimeout(r, 4000); });
}
async function stop(code) {
  await stopServer();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => {
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } }
    try { fs.rmSync(FAKE_DIR, { recursive: true, force: true }); } catch { /* none */ }
    process.exit(code);
  }, 800);
}

(async () => {
  const scanned = await pdf((d) => { d.rect(80, 80, 400, 600).stroke(); d.rect(100, 100, 120, 20).fill('#333'); });
  const nearly = await pdf((d) => { d.fontSize(10).text('Page 1', 500, 800); d.rect(80, 80, 400, 600).stroke(); });
  const textPdf = await pdf((d) => {
    d.fontSize(12).text('Sita Devi Textpdf\nsita.text@example-text.in\nSkills: Excel, Tally, GST, Accounting, Payroll\nTotal Experience: 3 years in accounts and payroll processing for a manufacturing company in Pune.');
  });

  // ---- 1. in-process: the module itself -------------------------------------------------------------------------------------
  const st = await OCR.status({ fresh: true });
  check('status: the stand-in tesseract is found, with eng+tel+hin', st.available && st.pdf && st.use === 'eng+tel+hin' && st.version === '5.3.4', st);
  process.env.FAKE_OCR_LANGS = 'eng,osd';
  const st2 = await OCR.status({ fresh: true });
  check('status: only English installed -> falls back to eng', st2.available && st2.use === 'eng' && st2.missingLanguages.includes('tel'), st2);
  process.env.FAKE_OCR_LANGS = 'tel,osd';
  const st3 = await OCR.status({ fresh: true });
  check('status: English missing -> still asks eng first (eng+tel)', st3.use === 'eng+tel', st3);
  delete process.env.FAKE_OCR_LANGS;
  await OCR.status({ fresh: true });
  check('text extraction of the scanned PDF is empty (the reason OCR is needed)', !(await RP.extractText(scanned, 'pdf')).text);
  const n0 = calls().filter((c) => c.bin === 'tesseract' && c.args[1] === 'stdout').length;
  const ep = await RP.extractAndParse(scanned, 'pdf');
  const pdfCalls = calls().filter((c) => c.bin === 'pdftoppm' && c.args[0] !== '-v');
  const lastPdf = pdfCalls[pdfCalls.length - 1] || { args: [] };
  const tessNow = calls().filter((c) => c.bin === 'tesseract' && c.args[1] === 'stdout');
  check('scanned PDF: pages made at 200 dpi, at most 4 pages', lastPdf.args.join(' ').includes('-r 200 -f 1 -l 4 -png'), lastPdf);
  check('scanned PDF: each page read once, in eng+tel+hin', tessNow.length - n0 === 2 && tessNow.slice(-2).every((c) => c.args.join(' ').endsWith('-l eng+tel+hin')), tessNow.slice(-2));
  check('scanned PDF: name, e-mail, phone, skills, experience, education read from the OCR text',
    ep.parsed && ep.parsed.name === 'Ravi Kumar Ocrtest' && ep.parsed.emails.includes(EMAIL) && ep.parsed.phones.some((x) => x.endsWith(PHONE))
    && ['java', 'python', 'sql'].every((k) => ep.parsed.skills.includes(k)) && ep.parsed.totalExperienceYears === 5
    && ep.parsed.education.includes('B.Tech') && ep.parsed.location === 'Hyderabad' && ep.parser === 'free+ocr' && !ep.error, { parsed: ep.parsed, parser: ep.parser, error: ep.error });
  check('...and says OCR was used, on 2 pages', ep.parsed && ep.parsed.ocr && ep.parsed.ocr.used && ep.parsed.ocr.pages === 2, ep.parsed && ep.parsed.ocr);
  const ne = await RP.extractAndParse(nearly, 'pdf');
  check('a PDF with only "Page 1" on it (nearly empty) is OCRed too, and keeps its own little text', ne.parsed && ne.parsed.emails.includes(EMAIL) && /Page\s+1/.test(ne.text), { parser: ne.parser, text: String(ne.text).slice(0, 80) });
  const before = calls().length;
  const tp = await RP.extractAndParse(textPdf, 'pdf');
  check('a normal text PDF is never OCRed', calls().length === before && tp.parser === 'free' && tp.parsed.emails.includes('sita.text@example-text.in') && !tp.parsed.ocr, { parser: tp.parser, calls: calls().length - before });
  const ph = await RP.extractAndParse(PNG, 'png');
  const lastImg = calls().filter((c) => c.bin === 'tesseract' && c.args[1] === 'stdout').pop();
  check('a PNG photo is read with OCR (no page step)', ph.parsed && ph.parsed.emails.includes(EMAIL) && /in\.png$/.test(lastImg.args[0]), { parsed: ph.parsed, lastImg });
  check('a DOCX/DOC is never sent to OCR', (await RP.extractAndParse(Buffer.from('not a doc'), 'doc')).ocr === null);
  // one at a time: three at once still all finish, one after the other
  const three = await Promise.all([RP.extractAndParse(JPG, 'jpg'), RP.extractAndParse(PNG, 'png'), RP.extractAndParse(scanned, 'pdf')]);
  check('three OCR jobs at once all finish (queued one at a time)', three.every((x) => x.parsed && x.parsed.emails.includes(EMAIL)) && OCR.queueLength() === 0);

  // not installed (in-process)
  process.env.OCR_TESSERACT_BIN = MISSING_BIN;
  const ni = await OCR.status({ fresh: true });
  check('not installed: status says so, no crash', ni.available === false && /not installed/i.test(ni.why), ni);
  const ne2 = await RP.extractAndParse(scanned, 'pdf');
  check('not installed: the scanned PDF gets "Scanned resume — text could not be read (OCR not installed on the server)"', ne2.parsed === null && ne2.error === OCR.NOT_INSTALLED && ne2.ocr && ne2.ocr.notInstalled, ne2);
  const ne3 = await RP.extractAndParse(nearly, 'pdf');
  check('not installed: a nearly empty PDF keeps its little text and shows the same reason', ne3.text && ne3.error === OCR.NOT_INSTALLED, { text: ne3.text, error: ne3.error });
  process.env.OCR_TESSERACT_BIN = FAKE_TESS;
  OCR.forget();

  // ---- 2. through the server -----------------------------------------------------------------------------------------------
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const REC = await prisma.user.create({ data: { name: `Ocr rec ${P}`, email: `ocr.rec.${P}@ocr-test.in`, passwordHash: 'x', status: 'Active', role: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, passwordChangedAt: new Date(Date.now() - 3600e3) } });
  const C = await prisma.candidate.create({ data: { name: 'Ravi Kumar Ocrtest', phone: PHONE, email: EMAIL } });
  startServer({});
  await waitUp();
  const tok = async (id) => jwt.sign({ ...tokenPayload(await resolveIdentity(id)), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' });
  const tA = await tok(adminRow.id); const tR = await tok(REC.id);

  const os1 = await call('GET', '/candidate-resumes/ocr-status?fresh=1', null, tA);
  check('GET /ocr-status (Admin): available, eng+tel+hin', os1.status === 200 && os1.body.available === true && os1.body.use === 'eng+tel+hin' && os1.body.languages.includes('tel') && os1.body.languages.includes('hin'), os1.body);
  const os2 = await call('GET', '/candidate-resumes/ocr-status', null, tR);
  check('GET /ocr-status is Admin only (a recruiter gets 403)', os2.status === 403, os2);

  const u1 = await upload(C.id, scanned, 'scanned-resume.pdf', 'application/pdf', tA);
  const p1 = u1.body && u1.body.resume && u1.body.resume.parsed;
  check('upload a scanned PDF: saved, text read with OCR, fields parsed', u1.status === 201 && p1 && p1.emails.includes(EMAIL) && p1.name === 'Ravi Kumar Ocrtest' && p1.skills.includes('java') && u1.body.resume.parser === 'free+ocr' && !u1.body.extractError, u1.body);
  check('...the Resume tab is told it was OCR (pages, languages)', p1 && p1.ocr && p1.ocr.used && p1.ocr.pages === 2 && p1.ocr.languages === 'eng+tel+hin', p1 && p1.ocr);
  check('...same person: no wrong-file warning', u1.body && u1.body.ownerMismatch === false);
  const row1 = await prisma.candidateResume.findFirst({ where: { candidateId: C.id }, orderBy: { createdAt: 'desc' } });
  check('...the OCR text is stored on the resume row (search and Fit use it)', row1 && /Ravi Kumar Ocrtest/.test(row1.text || '') && row1.parser === 'free+ocr');
  const u2 = await upload(C.id, PNG, 'photo-resume.png', 'image/png', tA);
  check('upload a PNG photo of a resume: taken and read', u2.status === 201 && u2.body.resume.format === 'png' && u2.body.resume.parsed.emails.includes(EMAIL), u2.body);
  const u3 = await upload(C.id, JPG, 'photo-resume.jpeg', 'image/jpeg', tA);
  check('upload a .jpeg photo: taken as JPG and read', u3.status === 201 && u3.body.resume.format === 'jpg' && u3.body.resume.parsed.phones.length > 0, u3.body);
  const u4 = await upload(C.id, Buffer.from('<html>not a picture</html>'), 'fake.png', 'image/png', tA);
  check('a renamed non-picture ".png" is refused (contents checked)', u4.status === 400, u4.body);
  const fileRes = await fetch(`${API}/candidate-resumes/${C.id}/file/${u2.body.resume.id}?download=1`, { headers: { Authorization: `Bearer ${tA}`, 'X-Forwarded-For': ip() } });
  check('the photo downloads as image/png', fileRes.status === 200 && /image\/png/.test(fileRes.headers.get('content-type') || ''));
  const n1 = calls().length;
  const u5 = await upload(C.id, textPdf, 'text-resume.pdf', 'application/pdf', tA);
  check('upload a normal text PDF: no OCR call', u5.status === 201 && calls().length === n1 && u5.body.resume.parser === 'free', { status: u5.status, calls: calls().length - n1 });
  // A public / partner upload stays PDF / Word only (validateResumeFile without images)
  const store = require('../src/utils/resumeStore'); // eslint-disable-line global-require
  let refused = false;
  try { store.validateResumeFile({ filename: 'x.png', data: PNG }); } catch (e) { refused = e.code === 'BAD_TYPE'; }
  check('outside the Resume tab (job portal, partners) a picture is still refused', refused);
  await stopServer();

  // ---- 3. the server without tesseract -------------------------------------------------------------------------------------
  startServer({ OCR_TESSERACT_BIN: MISSING_BIN, OCR_PDFTOPPM_BIN: path.join(FAKE_DIR, 'no-such-pdftoppm') });
  await waitUp();
  const os3 = await call('GET', '/candidate-resumes/ocr-status?fresh=1', null, tA);
  check('not installed: /ocr-status says not available, points at the set-up doc', os3.status === 200 && os3.body.available === false && /OCR-SETUP/.test(os3.body.setup || '') && /not installed/i.test(os3.body.message), os3.body);
  const u6 = await upload(C.id, scanned, 'scanned-2.pdf', 'application/pdf', tA);
  check('not installed: the scanned upload is still saved (201)', u6.status === 201 && !!(u6.body.resume && u6.body.resume.id), u6.body);
  check('not installed: marked "Scanned resume — text could not be read (OCR not installed on the server)"',
    u6.body.extractError === 'Scanned resume — text could not be read (OCR not installed on the server)' && u6.body.resume.extractError === u6.body.extractError, u6.body);
  const u7 = await upload(C.id, PNG, 'photo-2.png', 'image/png', tA);
  check('not installed: a photo upload is saved with the same reason', u7.status === 201 && u7.body.extractError === OCR.NOT_INSTALLED, u7.body);
  const u8 = await upload(C.id, textPdf, 'text-2.pdf', 'application/pdf', tA);
  check('not installed: a text PDF is read as always', u8.status === 201 && !u8.body.extractError && u8.body.resume.parsed.emails.includes('sita.text@example-text.in'), u8.body);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
