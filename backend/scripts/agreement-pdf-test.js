#!/usr/bin/env node
// ---------------------------------------------------------------------------
// CLIENT'S OWN AGREEMENT AS A FILE (PDF first) - COPY DATABASE ONLY.
//
//   cd backend
//   sqlite3 prisma/dev.db "VACUUM INTO 'C:/tmp/agr-copy.db'"      (or copy via the sandbox script)
//   COPY_DB=C:/tmp/agr-copy.db node scripts/agreement-pdf-test.js
//
// Starts its OWN throw-away API process (port 4093, TEST_MODE=1, uploads in a temp folder) on the copy, so
// no running server is touched and prisma/dev.db is never opened. Checks, through the real routes:
//   PDF accepted, stored, listed, downloaded (application/pdf, same bytes, inline + attachment, safe name);
//   a fake .pdf (not %PDF-) refused in plain words; a too-big file refused in plain words;
//   Word / PNG / JPG still accepted; an unknown type (.exe, .html) refused; an old text upload still works;
//   the agreement stays hidden from a TL / Recruiter (upload and download refused); the generic client
//   documents uploader (kind AGREEMENT) still takes a PDF.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
const PORT = Number(process.env.TEST_PORT || 4093);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'agr-pdf-uploads-'));
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
process.env.UPLOAD_DIR = UPLOADS;
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const RUN = Date.now().toString(36);
const made = { users: [], emps: [], clients: [] };

// a tiny but valid one-page PDF made here (no library)
function tinyPdf(text = 'Hello agreement') {
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = `BT /F1 14 Tf 20 100 Td (${text}) Tj ET`;
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n'; const offs = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 2)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 3)]);

async function http(method, p, token, body) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null; try { json = JSON.parse(buf.toString('utf8')); } catch { /* not json */ }
  return { status: r.status, headers: r.headers, buf, body: json };
}
function form(buf, filename, type = 'application/octet-stream') {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type }), filename);
  return fd;
}

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
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST AGPDF ${tag} ${RUN}`, email: `zz-agpdf-${tag}-${RUN}@example.test`, username: `zz-agpdf-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id);
      if (empExtra) {
        const e = await prisma.employee.create({ data: { employeeCode: `ZZTEST-AGPDF-${tag}-${RUN}`.slice(0, 40), name: u.name, userId: u.id, designation: 'Employee', employmentStatus: 'Active', department: extra.atsDepartment || null, email: u.email, ...empExtra } });
        made.emps.push(e.id);
      }
      return u;
    };
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const admin = await mk('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const tl = await mk('tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const rec = await mk('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { tl: tl.name });
    const tAdmin = await tokenOf(admin); const tTl = await tokenOf(tl); const tRec = await tokenOf(rec);
    const client = await prisma.client.create({ data: { name: `ZZTEST AGPDF Client ${RUN}`, location: 'ZZ Town', ownerDepartment: 'Education', clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-agpdf-${RUN}@example.test`, agreementStatus: 'DRAFT', agreementFeePercent: 8.33, clientCode: `ZZAGP${RUN.toUpperCase()}` } });
    made.clients.push(client.id);
    const up = `/api/clients/${client.id}/agreement/upload-file`;

    // 1. PDF accepted
    const pdf = tinyPdf('ZZTEST agreement pdf');
    let r = await http('POST', up, tAdmin, form(pdf, 'Orbit MSA (signed).pdf', 'application/pdf'));
    check('PDF is accepted', r.status === 200, r.body || r.status);
    check('the client now shows the client\'s own agreement, DRAFT', r.body && r.body.agreementSource === 'Uploaded' && r.body.agreementStatus === 'DRAFT', r.body && [r.body.agreementSource, r.body.agreementStatus]);
    check('there is agreement text (so the signing page is never empty)', r.body && String(r.body.agreementDocument || '').length > 20, r.body && r.body.agreementDocument);
    const rowCount = await prisma.clientDocument.count({ where: { clientId: client.id, kind: 'AGREEMENT' } });
    check('one AGREEMENT file row is kept', rowCount === 1, rowCount);

    // 2. info + download
    r = await http('GET', `/api/agreement/${client.id}/own-file/info`, tAdmin);
    check('info says there is a PDF that a browser can show', r.status === 200 && r.body.has && r.body.mime === 'application/pdf' && r.body.canShow, r.body);
    r = await http('GET', `/api/agreement/${client.id}/own-file`, tAdmin);
    check('view returns Content-Type application/pdf', /^application\/pdf/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
    check('view is inline with a safe file name', /^inline; filename="[\w.-]+\.pdf"$/.test(r.headers.get('content-disposition') || ''), r.headers.get('content-disposition'));
    check('the bytes are the same as uploaded', Buffer.compare(r.buf, pdf) === 0, `${r.buf.length} vs ${pdf.length}`);
    check('nosniff is set', r.headers.get('x-content-type-options') === 'nosniff');
    r = await http('GET', `/api/agreement/${client.id}/own-file?download=1`, tAdmin);
    check('download is an attachment, still application/pdf', /^attachment; filename="[\w.-]+\.pdf"$/.test(r.headers.get('content-disposition') || '') && /^application\/pdf/.test(r.headers.get('content-type') || ''), [r.headers.get('content-disposition'), r.headers.get('content-type')]);
    check('download bytes equal', Buffer.compare(r.buf, pdf) === 0);

    // 3. refusals
    r = await http('POST', up, tAdmin, form(Buffer.from('<html><script>alert(1)</script></html>'), 'fake.pdf', 'application/pdf'));
    check('a fake .pdf is refused in plain words', r.status === 400 && /not a real PDF/i.test(r.body && r.body.error), r.body);
    r = await http('POST', up, tAdmin, form(Buffer.concat([pdf, Buffer.alloc(10 * 1024 * 1024 + 50000, 0x20)]), 'huge.pdf', 'application/pdf')).catch((e) => ({ status: 0, body: { error: String(e.message) } }));
    check('a file over 10 MB is refused in plain words', r.status === 413 && /too big\. The limit is 10 MB/.test(r.body && r.body.error), r.body);
    r = await http('POST', up, tAdmin, form(Buffer.from('MZ....'), 'virus.exe', 'application/x-msdownload'));
    check('an .exe is refused: only PDF, Word or image', r.status === 400 && /Only PDF, Word or image/.test(r.body && r.body.error), r.body);
    r = await http('POST', up, tAdmin, form(Buffer.from('<html></html>'), 'page.html', 'text/html'));
    check('an .html is refused', r.status === 400 && /Only PDF, Word or image/.test(r.body && r.body.error), r.body);
    r = await http('POST', up, tAdmin, form(Buffer.from('plain'), 'note.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    check('a fake .docx is refused', r.status === 400 && /not a real/i.test(r.body && r.body.error), r.body);
    r = await http('GET', `/api/agreement/${client.id}/own-file`, tAdmin);
    check('the refused uploads did not replace the PDF', Buffer.compare(r.buf, pdf) === 0);

    // 4. other types still accepted
    r = await http('POST', up, tAdmin, form(DOCX, 'agreement.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'));
    check('Word .docx accepted (no readable text: says so, does not crash)', r.status === 200 && /could not read/i.test(r.body && r.body.agreementDocument), r.body && (r.body.error || r.body.agreementDocument));
    r = await http('GET', `/api/agreement/${client.id}/own-file/info`, tAdmin);
    check('a Word file is offered as download, not shown in the browser', r.body.has && r.body.canShow === false, r.body);
    r = await http('GET', `/api/agreement/${client.id}/own-file`, tAdmin);
    check('a Word file is always sent as an attachment', /^attachment/.test(r.headers.get('content-disposition') || '') && Buffer.compare(r.buf, DOCX) === 0, r.headers.get('content-disposition'));
    r = await http('POST', up, tAdmin, form(PNG, 'scan.png', 'image/png'));
    check('PNG accepted', r.status === 200, r.body);
    r = await http('POST', up, tAdmin, form(JPG, 'scan.jpg', ''));
    check('JPG accepted even when the browser sends no type', r.status === 200, r.body);
    r = await http('POST', up, tAdmin, form(pdf, 'back-to-pdf.PDF', 'application/octet-stream'));
    check('PDF accepted when the browser sends a generic type and a capital .PDF', r.status === 200, r.body);
    check('only the latest file is kept (no pile-up)', (await prisma.clientDocument.count({ where: { clientId: client.id, kind: 'AGREEMENT', name: "Client's own agreement" } })) === 1);
    check('older files are removed from disk', fs.readdirSync(UPLOADS).length === 1, fs.readdirSync(UPLOADS));
    // old text upload still works
    r = await http('POST', `/api/clients/${client.id}/agreement/upload`, tAdmin, { document: 'ZZTEST pasted text', fileName: 'x.pdf' });
    check('the old paste-the-text upload still works', r.status === 200 && r.body.agreementDocument === 'ZZTEST pasted text', r.body);
    // generic client documents uploader (kind AGREEMENT) still takes a PDF
    const fd = form(pdf, 'signed.pdf', 'application/pdf'); fd.append('kind', 'AGREEMENT'); fd.append('name', 'ZZTEST signed copy');
    r = await http('POST', `/api/clients/${client.id}/documents`, tAdmin, fd);
    check('Client documents (kind AGREEMENT) accepts a PDF', r.status === 201, r.body);
    if (r.status === 201) {
      const f = await http('GET', `/api/clients/${client.id}/documents/${r.body.id}/file`, tAdmin);
      check('...and serves it as application/pdf, inline, same bytes', /^application\/pdf/.test(f.headers.get('content-type') || '') && /^inline/.test(f.headers.get('content-disposition') || '') && Buffer.compare(f.buf, pdf) === 0, [f.status, f.headers.get('content-type')]);
    }

    // 5. privacy: TL / Recruiter refused
    for (const [who, tk] of [['TL', tTl], ['Recruiter', tRec]]) {
      r = await http('POST', up, tk, form(pdf, 'x.pdf', 'application/pdf'));
      check(`${who}: upload refused`, r.status === 401 || r.status === 403 || r.status === 404, r.status);
      r = await http('GET', `/api/agreement/${client.id}/own-file`, tk);
      check(`${who}: download refused`, r.status === 403 && !r.buf.equals(pdf), r.status);
      r = await http('GET', `/api/agreement/${client.id}/own-file/info`, tk);
      check(`${who}: info refused`, r.status === 403, r.status);
    }
    r = await http('POST', up, undefined, form(pdf, 'x.pdf', 'application/pdf'));
    check('no login: refused', r.status === 401, r.status);
  } catch (e) {
    fail += 1; console.log('FAIL  test crashed:', e && e.stack ? e.stack : e);
  } finally {
    try {
      await prisma.clientDocument.deleteMany({ where: { clientId: { in: made.clients } } });
      await prisma.auditLog.deleteMany({ where: { OR: [{ entityId: { in: made.clients } }, { userId: { in: made.users } }] } });
      await prisma.client.deleteMany({ where: { id: { in: made.clients } } });
      await prisma.employee.deleteMany({ where: { id: { in: made.emps } } });
      await prisma.user.deleteMany({ where: { id: { in: made.users } } });
      const left = await prisma.client.count({ where: { name: { contains: 'ZZTEST AGPDF' } } }) + await prisma.user.count({ where: { name: { contains: 'ZZTEST AGPDF' } } });
      check('every ZZTEST AGPDF row is cleaned from the copy', left === 0, left);
    } catch (e) { console.log('cleanup problem:', e.message); }
    try { if (server) server.kill(); } catch { /* gone */ }
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* temp */ }
    await prisma.$disconnect();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
