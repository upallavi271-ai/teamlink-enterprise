// Item 9 (part 2): upload validation, CSV/Excel formula injection, SSRF guard, raw SQL, audit rows.
module.exports = async function secHarden2(ctx) {
  const {
    check, call, mkUser, mint, prisma, BACK,
  } = ctx;
  const path = require('path');

  // ---------------- uploads ----------------
  console.log('\n--- 9: upload validation ---');
  const emp = await mkUser('UpUser', {}, { designation: 'Employee' });
  const tok = await mint(emp.u);
  const docs = await call('GET', `/api/employees/${emp.emp.id}/documents`, tok);
  const docType = docs.body && docs.body.docTypes ? (docs.body.docTypes.find((t) => !/other/i.test(t)) || docs.body.docTypes[0]) : 'Aadhaar Card';
  const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(200, 0x20)]);
  const send = async (filename, ctype, data) => {
    const b = '----zzsec';
    const body = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="docType"\r\n\r\n${docType}\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="docName"\r\n\r\nZZTEST doc\r\n`),
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${ctype}\r\n\r\n`),
      data, Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    return call('POST', `/api/employees/${emp.emp.id}/documents`, tok, body, { raw: true, headers: { 'Content-Type': `multipart/form-data; boundary=${b}` } });
  };
  let r = await send('evil.pdf', 'application/pdf', Buffer.from('<html><script>alert(1)</script></html>'));
  check('HTML disguised as a PDF is refused (content sniff)', r.status === 400, `${r.status} ${r.text.slice(0, 100)}`);
  r = await send('pic.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'));
  check('an SVG with a script is refused (type not allowed)', r.status === 400, r.status);
  r = await send('page.html', 'text/html', Buffer.from('<html></html>'));
  check('an HTML file is refused', r.status === 400, r.status);
  r = await send('run.exe', 'application/octet-stream', Buffer.from('MZ\u0090\u0000\u0003'));
  check('an executable is refused', r.status === 400, r.status);
  r = await send('a.php.pdf', 'image/png', PDF);
  check('wrong MIME for the bytes is refused (PDF bytes sent as PNG)', r.status === 400, r.status);
  r = await send('big.pdf', 'application/pdf', Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(6 * 1024 * 1024, 0x20)]));
  check('an oversized file is refused', r.status === 400 || r.status === 413, r.status);
  r = await send('../../../../etc/evil.pdf', 'application/pdf', PDF);
  check('a traversal file name is refused or kept only as plain display text', [200, 201, 400, 403].includes(r.status), r.status);
  if (r.status === 200 || r.status === 201) {
    const row = await prisma.employeeDocument.findFirst({ where: { employeeId: emp.emp.id }, orderBy: { uploadedAt: 'desc' } });
    check('the saved display name has no path pieces', !!row && !/[\\/]|\.\./.test(row.fileName || ''), row && row.fileName);
    await prisma.employeeDocument.deleteMany({ where: { employeeId: emp.emp.id } });
  }
  const A = require(path.join(BACK, 'src/utils/attachments'));
  const bad = (fn) => { try { fn(); return false; } catch { return true; } };
  check('attachments.store refuses text/html', bad(() => A.store({ filename: 'x.pdf', contentType: 'text/html', data: Buffer.from('<html>1234</html>') })));
  check('attachments.store refuses image/svg+xml', bad(() => A.store({ filename: 'x.svg', contentType: 'image/svg+xml', data: Buffer.from('<svg>1234</svg>') })));
  check('attachments.store refuses a mime / content mismatch', bad(() => A.store({ filename: 'x.png', contentType: 'image/png', data: PDF })));
  check('attachments.safeDisplayName strips traversal and exotic characters', !/[\\/]|\.\./.test(A.safeDisplayName('..\\..\\a/../b<script>.pdf')) && A.safeDisplayName('../../x.pdf') === 'x.pdf');
  check('attachments.resolveStored refuses names it did not make', A.resolveStored('../../etc/passwd') === null && A.resolveStored('evil.pdf') === null);
  const R = require(path.join(BACK, 'src/utils/resumeStore'));
  check('resumeStore: HTML named .pdf refused', bad(() => R.validateResumeFile({ filename: 'cv.pdf', data: Buffer.from('<html><script>1</script></html>') })));
  check('resumeStore: .php.docx with PDF bytes refused', bad(() => R.validateResumeFile({ filename: 'cv.php.docx', data: PDF })));
  const D = require(path.join(BACK, 'src/utils/candidateDocStore'));
  check('candidateDocStore: SVG and HTML refused', bad(() => D.validateDocFile({ filename: 'a.svg', data: Buffer.from('<svg></svg>') })) && bad(() => D.validateDocFile({ filename: 'a.html', data: Buffer.from('<html></html>') })));
  check('candidateDocStore: a real PDF is accepted', !bad(() => D.validateDocFile({ filename: 'a.pdf', data: PDF })));

  // ---------------- formula injection ----------------
  console.log('\n--- 9: CSV / Excel formula injection ---');
  const T = require(path.join(BACK, 'src/utils/tabularExport'));
  const XLSX = require('xlsx');
  const evil = ['=HYPERLINK("http://x","y")', '+SUM(1,1)', '-2+3', '@cmd', '=1+1'];
  const csv = T.toCsv(['n'], evil.map((e) => [e]));
  check('CSV: cells starting with = + - @ are prefixed with an apostrophe', evil.every((e) => csv.includes(`'${e.replace(/"/g, '""')}`)), csv.slice(0, 200));
  check('CSV: normal text, real numbers and phone numbers are untouched', T.toCsv(['n'], [['Hello'], ['-12.5'], ['+919876543210']]) === 'n\r\nHello\r\n-12.5\r\n+919876543210');
  const buf = T.toXlsx(['n'], evil.map((e) => [e]), 'S');
  const wb = XLSX.read(buf, { type: 'buffer' });
  const cells = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 }).slice(1).map((x) => String(x[0]));
  check('XLSX (toXlsx): the same cells are neutralised', cells.every((c) => c.startsWith("'")), cells);
  const ws = XLSX.utils.aoa_to_sheet([['x'], ['=1+1'], ['@a']]);
  check('XLSX (any aoa_to_sheet writer in the app): neutralised too', ws.A2.v === "'=1+1" && ws.A3.v === "'@a", [ws.A2 && ws.A2.v, ws.A3 && ws.A3.v]);
  const wj = XLSX.utils.json_to_sheet([{ a: '=2+2' }]);
  check('XLSX (json_to_sheet): neutralised too', wj.A2.v === "'=2+2", wj.A2 && wj.A2.v);

  // ---------------- SSRF ----------------
  console.log('\n--- 9: SSRF guard ---');
  const S = require(path.join(BACK, 'src/utils/safeFetch'));
  const blocked = async (u) => { try { await S.assertSafeUrl(u); return false; } catch { return true; } };
  for (const u of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/', 'http://192.168.1.1/', 'http://172.20.0.1/', 'http://[::1]/', 'http://localhost:4010/', 'http://[::ffff:127.0.0.1]/', 'file:///etc/passwd', 'ftp://example.com/x', 'gopher://x']) {
    // eslint-disable-next-line no-await-in-loop
    check(`SSRF guard blocks ${u}`, await blocked(u));
  }
  check('SSRF guard lets a public address through', !(await blocked('http://8.8.8.8/')));

  // ---------------- audit rows ----------------
  console.log('\n--- 9: audit rows ---');
  const au = await mkUser('AuUser', {}, { designation: 'Employee' });
  const actor = await mkUser('AuAdmin', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Super Admin' });
  const tA = await mint(actor.u);
  const count = (where) => prisma.auditLog.count({ where });
  const wrong = await call('POST', '/api/auth/login', undefined, { email: au.u.email, password: 'definitely-wrong-1' });
  check('a wrong sign-in is refused (401)', wrong.status === 401, wrong.status);
  check('a failed sign-in is written to the audit log', (await count({ action: { contains: 'ailed sign-in' }, OR: [{ entityId: au.u.id }, { userId: au.u.id }, { toValue: { contains: au.u.email } }] })) >= 1);
  const exp = await call('GET', `/api/employees/${au.emp.id}/export.xlsx`, tA);
  check('an export answers 200', exp.status === 200, exp.status);
  check('an export is written to the audit log', (await count({ userId: actor.u.id, action: { contains: 'xported' } })) >= 1);
  await call('PUT', `/api/employees/management/${au.emp.id}/roles`, tA, { role: 'MANAGER' });
  check('a role change is written to the audit log (who, whom, old -> new)', (await count({ userId: actor.u.id, entityId: au.u.id, action: { startsWith: 'Role change' } })) >= 1);
};
