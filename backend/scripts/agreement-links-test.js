#!/usr/bin/env node
// ---------------------------------------------------------------------------
// AGREEMENT DRIVE LINKS (bulk) acceptance tests (user, 2026-10-12). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/agreement-links-test.js
//
// ZZTEST users: SA, Admin, Manager, BDE TL, BDE A + BDE B (Education desk), BDE M (Medical desk),
// Education TL, recruiter, Accountant, a client-portal login. Builds ZZTEST clients, removes everything again.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const Z = require('./lib/zzfix')('AL');
const { prisma, call, check } = Z;

(async () => {
  await Z.preclean();
  const touched = new Set();
  const logFile = process.env.TL_SERVER_LOG || path.join(Z.BACK, 'prisma', 'sandbox.db.log'); // TL_SERVER_LOG: the log of a private test server
  const logSize = () => { try { return fs.statSync(logFile).size; } catch { return 0; } };
  const logSince = (from) => { try { return fs.readFileSync(logFile, 'utf8').slice(from); } catch { return ''; } };
  try {
    const { RUN } = Z;
    const ok = (r) => r.status >= 200 && r.status < 300;
    const drive = (n) => `https://drive.google.com/file/d/1ZZ${RUN}${String(n).padStart(6, '0')}AbCdEfGh/view?usp=sharing`;
    const uSa = await Z.mkUser('sa', { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN' });
    const uAdmin = await Z.mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN' });
    const uMgr = await Z.mkUser('mgr', { role: 'MANAGER', atsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'Manager' });
    const uBdeTl = await Z.mkUser('bdetl', { role: 'TL', atsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' }, { designation: 'TL' });
    const uA = await Z.mkUser('bdea', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uB = await Z.mkUser('bdeb', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Education' }, { tl: uBdeTl.name });
    const uM = await Z.mkUser('bdem', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }, { tl: uBdeTl.name });
    const uTl = await Z.mkUser('tledu', { role: 'TL', atsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, { designation: 'TL' });
    const uRec = await Z.mkUser('rec', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Education', atsScopeDepartments: 'Education' }, {});
    const uAcc = await Z.mkUser('acc', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' }, {});
    const mkClient = async (tag, dept, owner, extra = {}) => {
      const c = await prisma.client.create({ data: { name: `ZZTEST AL ${tag} ${RUN}`, location: 'ZZ Town', ownerDepartment: dept, bdeOwner: owner ? owner.name : null, clientType: 'Client', contactName: 'ZZ Contact', contactEmail: `zz-al-${tag.replace(/\W/g, '')}-${RUN}@example.test`, agreementStatus: 'DRAFT', clientCode: `ZZAL${tag.replace(/\W/g, '').toUpperCase()}${RUN.toUpperCase()}`, ...extra } });
      Z.made.clients.push(c.id); return c;
    };
    const C = {
      A1: await mkClient('Greenfield Academy', 'Education', uA),
      A2: await mkClient('Blue Ridge School', 'Education', uA),
      A3: await mkClient('Sunrise Public School', 'Education', uA),
      A4: await mkClient('Lotus Valley', 'Education', uA),
      B1: await mkClient('Maple Leaf Institute', 'Education', uB),
      M1: await mkClient('Medico Hospital', 'Medical', uM),
    };
    await prisma.invoice.create({ data: { clientId: C.A2.id, invoiceNumber: `ZZAL-${RUN}`.slice(0, 30), amount: 1000, status: 'Pending', dueDate: '2026-12-01', invoiceDate: '2026-11-01' } });
    const uClient = await Z.mkUser('client', { role: 'CLIENT', atsRole: 'CLIENT', clientId: C.A1.id, portalType: 'REVIEWER' });
    const T = {};
    for (const [k, u] of Object.entries({ sa: uSa, admin: uAdmin, mgr: uMgr, bdeTl: uBdeTl, A: uA, B: uB, M: uM, tl: uTl, rec: uRec, acc: uAcc, client: uClient })) T[k] = await Z.mint(u);

    const setBde = async (moduleId, feature, action, value) => {
      const got = await call('GET', '/api/admin/role-catalog/BDE/access', T.sa);
      const mod = got.body.modules.find((m) => m.id === moduleId);
      const features = JSON.parse(JSON.stringify(mod.features));
      features[feature] = { ...(features[feature] || {}), [action]: value };
      touched.add(moduleId);
      return call('PUT', `/api/admin/role-catalog/BDE/modules/${moduleId}/features`, T.sa, { features });
    };
    const chk = (tok, lines) => call('POST', '/api/clients/agreement-links/check', tok, { lines });
    const app = (tok, lines, runId) => call('POST', '/api/clients/agreement-links/apply', tok, { lines, runId });
    const line = (row, ref, link, extra = {}) => ({ row, ref, link, ...extra });
    const one = async (tok, ref, link, extra = {}) => ((await chk(tok, [line(1, ref, link, extra)])).body.rows || [])[0] || {};
    const snapshotAgr = async () => { const c = await prisma.client.findUnique({ where: { id: C.A1.id }, select: { agreementStatus: true, agreementId: true, agreementSignedAt: true, agreementActivatedAt: true, agreementSentAt: true } }); return JSON.stringify(c); };
    const agrBefore = await snapshotAgr();
    const logStart = logSize();

    // ============================ R: rights / no button ============================
    const rightsOf = async (k) => (await call('GET', '/api/clients/agreement-links/rights', T[k])).body || {};
    for (const k of ['sa', 'admin', 'bdeTl', 'A']) check(`R1 ${k} may add agreement links`, (await rightsOf(k)).canAdd === true, await rightsOf(k));
    for (const k of ['mgr', 'tl', 'rec', 'acc', 'client']) {
      const r = await call('GET', '/api/clients/agreement-links/rights', T[k]);
      check(`R2 ${k} has no button (rights say no, or the door is closed)`, r.status === 403 || (r.body && r.body.canAdd === false), [r.status, r.body]);
    }
    const sample = [line(1, C.A1.name, drive(1))];
    for (const k of ['mgr', 'tl', 'rec', 'acc', 'client']) {
      const c1 = await chk(T[k], sample); const c2 = await app(T[k], sample, `deny-${k}-${RUN}`);
      const c3 = await call('GET', '/api/clients/agreement-links/template', T[k]);
      check(`R3 ${k}: check / apply / template are refused (403)`, c1.status === 403 && c2.status === 403 && c3.status === 403, [c1.status, c2.status, c3.status]);
    }
    // 2026-10-16 (user): the whole BDE team (desk BDE, BDE TL) adds, marks as signed copy and removes Drive links for the clients of their own area
    check('R4 Admin, the BDE TL and the desk BDE may tick "signed copy"; a TL and a recruiter may not', (await rightsOf('admin')).canMarkSigned && (await rightsOf('bdeTl')).canMarkSigned && (await rightsOf('A')).canMarkSigned && !(await rightsOf('tl')).canMarkSigned && !(await rightsOf('rec')).canMarkSigned, null);
    check('R5 Admin, the BDE TL and the desk BDE may remove a link; a TL and a recruiter may not', (await rightsOf('admin')).canRemove && (await rightsOf('bdeTl')).canRemove && (await rightsOf('A')).canRemove && !(await rightsOf('tl')).canRemove && !(await rightsOf('rec')).canRemove, null);

    // ============================ M: matching ============================
    let r = await one(T.A, C.A1.clientCode, drive(1));
    check('M1 matched by Client ID (the client code)', r.status === 'ok' && r.client && r.client.id === C.A1.id, r);
    r = await one(T.A, C.A1.id, drive(1));
    check('M2 matched by the record id too', r.status === 'ok' && r.client.id === C.A1.id, r);
    r = await one(T.A, C.A1.name.toUpperCase(), drive(1));
    check('M3 matched by exact name (any case)', r.status === 'ok' && r.client.id === C.A1.id, r);
    r = await one(T.A, `${C.A1.name} Pvt Ltd`, drive(1));
    check('M4 "Pvt Ltd" / "Limited" endings do not matter', r.status === 'ok' && r.client.id === C.A1.id, r);
    r = await one(T.A, C.A1.name.replace('Greenfield', 'Greenfeld'), drive(1));
    check('M5 a spelling slip becomes "Did you mean ...?" with the right suggestion', r.status === 'close' && (r.suggestions || []).some((s) => s.id === C.A1.id) && r.ready === false, r);
    const pinned = await one(T.A, C.A1.name.replace('Greenfield', 'Greenfeld'), drive(1), { clientId: C.A1.id });
    check('M6 confirming the suggestion makes the line ready', pinned.status === 'ok' && pinned.ready === true, pinned);
    r = await one(T.A, `ZZTEST AL Nobody Here ${RUN}`, drive(1));
    check('M7 an unknown client is "Not found"', r.status === 'notfound' && r.ready === false, r);
    r = await one(T.A, C.B1.name, drive(1));
    check('M8 [2026-10-13 desk-wide rule] a colleague same-desk client is reachable', r.status === 'ok' && r.ready === true, r);
    r = await one(T.A, C.B1.clientCode, drive(1));
    check('M9 ... also by Client ID', r.status === 'ok', r);
    r = await one(T.A, C.M1.name, drive(1));
    check('M10 another desk\'s client is simply "Not found" (not leaked)', r.status === 'notfound', r);
    r = await one(T.admin, C.B1.name, drive(1));
    check('M11 an Admin reaches every client', r.status === 'ok' && r.client.id === C.B1.id, r);
    r = await one(T.bdeTl, C.M1.name, drive(1));
    check('M12 the BDE TL reaches every client', r.status === 'ok' && r.client.id === C.M1.id, r);
    const pinNotMine = await one(T.A, 'x', drive(1), { clientId: C.B1.id });
    const pinOther = await one(T.A, 'x', drive(1), { clientId: C.M1.id });
    check('M13 a client id sent by hand reaches a same-desk client but never another desk client', pinNotMine.status === 'ok' && pinNotMine.ready === true && pinOther.status === 'notfound' && pinOther.ready === false, [pinNotMine.status, pinOther.status]);

    // ============================ L: bad links ============================
    const bads = {
      'javascript:': 'javascript:alert(1)', 'data:': 'data:text/html;base64,PHNjcmlwdD4=', 'http (not https)': 'http://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view',
      'other host': 'https://evil.example.com/file/d/1AbCdEfGhIjKlMnOpQ/view', 'look-alike host': 'https://drive.google.com.evil.example.com/file/d/1AbCdEfGhIjKlMnOpQ/view',
      empty: '', spaces: 'https://drive.google.com/file/d/1AbCdEfGh IjKl/view', 'login in url': 'https://user:pw@drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view',
      'drive home page': 'https://drive.google.com/drive/my-drive', 'not a link': 'see email',
    };
    for (const [name, link] of Object.entries(bads)) {
      const x = await one(T.A, C.A1.name, link);
      check(`L1 bad link refused: ${name}`, x.status === 'badlink' && x.ready === false, x);
    }
    for (const [name, link] of Object.entries({
      'file link': 'https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view?usp=sharing', 'open?id': 'https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQ', folder: 'https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQ?usp=sharing',
      'docs link': 'https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQ/edit', 'folder u/0': 'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQ',
    })) {
      const x = await one(T.A, C.A1.name, link);
      check(`L2 good link accepted: ${name}`, x.status === 'ok' && x.ready === true, x);
    }
    r = await one(T.A, C.A1.name, drive(1), { agreementDate: '31-13-2026' });
    check('L3 an impossible date is "Bad date"', r.status === 'baddate', r);
    r = await one(T.A, C.A1.name, drive(1), { agreementDate: '31-03-2026', endDate: '30-03-2026' });
    check('L4 an end date before the agreement date is refused', r.status === 'baddate', r);
    r = await one(T.A, C.A1.name, drive(1), { agreementDate: '31/03/26', endDate: '2027-03-30' });
    check('L5 dates are read as 31/03/26 and 2027-03-30', r.status === 'ok' && r.agreementDate === '2026-03-31' && r.endDate === '2027-03-30', r);

    // ============================ P: paste / sheet ============================
    const pasteTab = [`Client name\tDrive link\tAgreement date`, `${C.A1.name}\t${drive(11)}\t01-04-2026`, `${C.A2.clientCode}\t${drive(12)}`, '', `${C.A3.name}   ${drive(13)}`, `${C.B1.name}\t${drive(14)}`].join('\n');
    const pr = await call('POST', '/api/clients/agreement-links/check', T.A, { text: pasteTab });
    const prs = (pr.body.rows || []).map((x) => x.status);
    check('P1 a spreadsheet paste (TAB) with a header row is read, blank lines skipped, line numbers kept', ok(pr) && prs.join() === 'ok,ok,ok,ok' && pr.body.rows[0].row === 2 && pr.body.rows[3].row === 6, [pr.status, prs, (pr.body.rows || []).map((x) => x.row)]);
    const csvTxt = [`"${C.A1.name}",${drive(21)},2026-01-02,2027-01-01,"first, second"`, `${C.A2.name};${drive(22)}`].join('\n');
    const pc = await call('POST', '/api/clients/agreement-links/check', T.A, { text: csvTxt });
    check('P2 CSV with quotes (commas inside) and a semicolon line', ok(pc) && pc.body.rows.length === 2 && pc.body.rows.every((x) => x.status === 'ok') && pc.body.rows[0].input.note.includes('first'), pc.body);
    const empty = await call('POST', '/api/clients/agreement-links/check', T.A, { text: '   \n\n' });
    check('P3 an empty box answers in plain words', empty.status === 400 && /Paste at least one line/.test(empty.body.error), empty.body);

    // ============================ D: duplicates ============================
    const dup = await chk(T.A, [line(1, C.A1.name, drive(31)), line(2, C.A1.clientCode, drive(32)), line(3, C.A2.name, drive(33)), line(4, C.A2.name, drive(33))]);
    check('D1 the same client twice (by name and by ID) is "Duplicate line", the first stays', dup.body.rows[0].status === 'ok' && dup.body.rows[1].status === 'duplicate' && dup.body.rows[3].status === 'duplicate' && dup.body.rows[2].status === 'ok', dup.body.rows.map((x) => x.status));
    const dupApp = await app(T.A, [line(1, C.A1.name, drive(31)), line(2, C.A1.clientCode, drive(32))], `dup-${RUN}`);
    const docsA1 = await prisma.clientDocument.count({ where: { clientId: C.A1.id, kind: 'AGREEMENT_LINK' } });
    check('D2 even if the screen sends both lines, only one link is saved', ok(dupApp) && docsA1 === 1 && dupApp.body.results[1].outcome === 'Skipped', [dupApp.body, docsA1]);

    // ============================ E: replace vs keep ============================
    r = await one(T.A, C.A1.name, drive(41));
    check('E1 a client that already has a link is "Already has a link" with the old link\'s host and who added it', r.status === 'exists' && r.existing && r.existing.host === 'drive.google.com' && r.existing.addedByName === uA.name, r);
    const keep = await app(T.A, [line(1, C.A1.name, drive(41), { onExisting: 'keep' })], `keep-${RUN}`);
    check('E2 Keep leaves the old link alone', keep.body.results[0].outcome === 'Skipped' && (await prisma.clientDocument.count({ where: { clientId: C.A1.id, kind: 'AGREEMENT_LINK' } })) === 1, keep.body);
    const before = await call('GET', `/api/clients/${C.A1.id}/agreement-links`, T.A);
    const rep = await app(T.A, [line(1, C.A1.name, drive(42), { onExisting: 'replace', agreementDate: '01-05-2026' })], `rep-${RUN}`);
    const after = await call('GET', `/api/clients/${C.A1.id}/agreement-links`, T.A);
    check('E3 Replace saves the new link and keeps the old one in history', rep.body.results[0].outcome === 'Replaced' && after.body.current.url === drive(42) && after.body.history.length === 1 && after.body.history[0].url === drive(1 + 30) && after.body.history[0].state === 'Replaced', [rep.body, after.body.history]);
    check('E4 ... the new link carries the agreement date and who added it', after.body.current.agreementDate === '2026-05-01' && after.body.current.addedByName === uA.name, after.body.current);
    check('E5 (before: the first link was current)', before.body.current && before.body.current.url === drive(31), before.body.current);

    // ============================ A: apply — partial success / limits / audit ============================
    const runA = `run-a-${RUN}`;
    const mixed = [
      line(1, C.A2.name, drive(51), { endDate: '31-03-2027', note: 'ZZTEST AL note' }),
      line(2, 'ZZTEST AL Nobody', drive(52)),
      line(3, C.A3.clientCode, 'http://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQ/view'),
      line(4, C.B1.name, drive(54)),
      line(5, C.A4.name, drive(55)),
    ];
    const ap = await app(T.A, mixed, runA);
    const out = (ap.body.results || []).map((x) => x.outcome);
    check('A1 partial success: good lines saved, bad lines skipped with a reason', ok(ap) && out.join() === 'Added,Skipped,Skipped,Added,Added' && ap.body.results[1].reason && ap.body.results[2].reason, [ap.status, out, ap.body.results]);
    check('A2 [desk-wide rule] the same-desk colleague client got its link', (await prisma.clientDocument.count({ where: { clientId: C.B1.id, kind: 'AGREEMENT_LINK' } })) === 1, null);
    const ap2 = await app(T.A, [line(1, C.A3.name, drive(56))], runA);
    const sumRows = await prisma.auditLog.findMany({ where: { entity: 'AgreementLinkRun', entityId: runA } });
    const tot = sumRows[0] ? JSON.parse(sumRows[0].fromValue) : {};
    check('A3 two batches of one run give ONE summary audit row with the totals', ok(ap2) && sumRows.length === 1 && tot.added === 4 && tot.skipped === 2 && tot.lines === 6, [sumRows.length, tot]);
    const perLine = await prisma.auditLog.findMany({ where: { entity: 'Client', action: { startsWith: 'Agreement Drive link' }, userId: uA.id } });
    check('A4 every add / replace has its own audit row (who, client, host only, time)', perLine.length >= 5 && perLine.every((x) => x.toValue === 'drive.google.com' && x.actorName === uA.name && x.createdAt) && perLine.some((x) => x.action === 'Agreement Drive link replaced' && x.fromValue === 'drive.google.com'), perLine.map((x) => [x.action, x.fromValue, x.toValue]));
    const allAudit = JSON.stringify(await prisma.auditLog.findMany({ where: { OR: [{ userId: { in: Z.made.users } }, { entityId: { in: Z.made.clients } }] } }));
    check('A5 no audit row contains the link itself (host only)', !/file\/d\//.test(allAudit) && !allAudit.includes('1ZZ'), null);
    const big = [];
    for (let i = 1; i <= 501; i += 1) big.push(`ZZTEST AL Bulk ${i}\t${drive(i)}`);
    const over = await call('POST', '/api/clients/agreement-links/check', T.admin, { text: big.join('\n') });
    check('A6 501 lines are refused with a clear message', over.status === 400 && /up to 500/.test(over.body.error) && /501/.test(over.body.error), over.body);
    const exactly = await call('POST', '/api/clients/agreement-links/check', T.admin, { text: big.slice(0, 500).join('\n') });
    check('A7 500 lines are accepted for checking (all "Not found", nothing saved)', ok(exactly) && exactly.body.rows.length === 500 && exactly.body.summary.notfound === 500, [exactly.status, exactly.body.summary]);
    const runB = `run-b-${RUN}`;
    const mkBatch = (n) => Array.from({ length: n }, (_, i) => line(i + 1, `ZZTEST AL Ghost ${i}`, drive(i)));
    const b1 = await app(T.admin, mkBatch(400), runB); const b2 = await app(T.admin, mkBatch(101), runB);
    check('A8 a RUN is limited to 500 lines across its batches', ok(b1) && b2.status === 400 && /500/.test(b2.body.error), [b1.status, b2.status, b2.body]);
    const manyApply = await app(T.admin, mkBatch(501), `run-c-${RUN}`);
    check('A9 apply with 501 lines in one call is refused', manyApply.status === 400, manyApply.status);
    const resultCsvOk = ap.body.results.every((x) => 'row' in x && 'client' in x && 'outcome' in x && 'reason' in x);
    check('A10 each result has line, client, outcome and reason (what "Download result" prints)', resultCsvOk, ap.body.results[0]);

    // ============================ S: storage + who sees ============================
    const docsOf = async (tok, id) => (await call('GET', `/api/clients/${id}/documents`, tok));
    const dOwner = await docsOf(T.A, C.A2.id);
    const linkRow = (dOwner.body.rows || []).find((x) => x.isLink);
    check('S1 the owner BDE sees it in Documents as "Signed agreement: open in Drive" with the Drive link, date, who and when', linkRow && linkRow.name === 'Signed agreement: open in Drive' && linkRow.linkUrl === drive(51) && linkRow.uploadedByName === uA.name && linkRow.uploadedAt && linkRow.expiryDate === '2027-03-31' && linkRow.kindLabel === 'Agreement (Drive link)', linkRow);
    const dColleague = await docsOf(T.B, C.A2.id);
    check('S2 a colleague BDE (same desk) sees the link in Documents', ok(dColleague) && (dColleague.body.rows || []).some((x) => x.isLink || x.kind === 'AGREEMENT_LINK'), dColleague.body);
    const colAL = await call('GET', `/api/clients/${C.A2.id}/agreement-links`, T.B);
    check('S3 ... and in the agreement card (canSee true)', ok(colAL) && colAL.body.canSee === true && !!colAL.body.current, colAL.body);
    for (const k of ['admin', 'bdeTl', 'mgr', 'acc']) {
      const x = await call('GET', `/api/clients/${C.A2.id}/agreement-links`, T[k]);
      check(`S4 ${k} can read the link`, ok(x) && x.body.canSee === true && x.body.current && x.body.current.url === drive(51), [x.status, x.body]);
    }
    for (const k of ['mgr', 'acc']) {
      const x = await call('POST', `/api/clients/${C.A2.id}/agreement-links`, T[k], { link: drive(60), onExisting: 'replace' });
      check(`S5 ${k} is read-only (cannot add / replace)`, x.status === 403, [x.status, x.body]);
    }
    for (const k of ['tl', 'rec', 'client']) {
      const x = await call('GET', `/api/clients/${C.A2.id}/agreement-links`, T[k]);
      const body = JSON.stringify(x.body || {});
      check(`S6 ${k} never gets the link`, (x.status === 403 || x.status === 404 || x.body.canSee === false) && !body.includes('drive.google.com'), [x.status, body.slice(0, 200)]);
    }
    const docsTl = await docsOf(T.tl, C.A2.id); const docsCl = await docsOf(T.client, C.A1.id);
    check('S7 the Documents list never shows the link to a TL or the client login', !JSON.stringify(docsTl.body || {}).includes('drive.google.com') && !JSON.stringify(docsCl.body || {}).includes('drive.google.com'), [docsTl.status, docsCl.status]);
    const fileTry = await call('GET', `/api/clients/${C.A2.id}/documents/${linkRow.id}/file`, T.A);
    check('S8 the file endpoint never serves a link (no server-side fetch)', fileTry.status === 400 && /Drive link/.test(fileTry.body.error), fileTry.body);
    const patchTry = await call('PATCH', `/api/clients/${C.A2.id}/documents/${linkRow.id}`, T.A, { name: 'x' });
    check('S9 a link cannot be edited as a normal document', patchTry.status === 400, patchTry.body);
    const sum = await call('GET', '/api/clients/agreement-links/summary', T.A);
    const ids = (sum.body.rows || []).map((x) => x.clientId);
    check('S10 the list chip data: owner BDE gets own clients only', ok(sum) && ids.includes(C.A1.id) && ids.includes(C.A2.id) && !ids.includes(C.B1.id), ids);
    const sumB = await call('GET', '/api/clients/agreement-links/summary', T.B);
    check('S11 a colleague BDE gets none of A\'s', ok(sumB) && !(sumB.body.rows || []).some((x) => [C.A1.id, C.A2.id].includes(x.clientId)), sumB.body);
    const sumTl = await call('GET', '/api/clients/agreement-links/summary', T.tl);
    check('S12 a TL gets no chip data', (sumTl.status === 403) || (sumTl.body.canSee === false && !(sumTl.body.rows || []).length), [sumTl.status, sumTl.body]);
    const upKind = await (async () => {
      const fd = new FormData(); fd.append('kind', 'AGREEMENT_LINK'); fd.append('name', 'ZZTEST AL fake'); fd.append('file', new Blob([Buffer.from('%PDF-1.4 ZZ\n%%EOF')], { type: 'application/pdf' }), 'x.pdf');
      const rs = await fetch(`${Z.API}/api/clients/${C.A1.id}/documents`, { method: 'POST', headers: { Authorization: `Bearer ${T.admin}` }, body: fd }); // (2026-10-13: ordinary documents are Purna Sir's / the Admin's, so the Admin uploads)
      return { status: rs.status, body: await rs.json().catch(() => ({})) };
    })();
    check('S13 an ordinary upload can not pose as a link (kind falls back to Other)', upKind.status === 201 && upKind.body.kind === 'OTHER', upKind);

    // ============================ G: signed copy flag, e-sign untouched ============================
    const agrAfter = await snapshotAgr();
    check('G1 the e-sign agreement of the client is untouched (status, number, dates)', agrAfter === agrBefore, [agrBefore, agrAfter]);
    const mk1 = await app(T.A, [line(1, C.A4.name, drive(71), { onExisting: 'replace', markSigned: true })], `mk-a-${RUN}`);
    const a4 = await call('GET', `/api/clients/${C.A4.id}/agreement-links`, T.A);
    check('G2 a desk BDE marking a link as signed copy is kept (2026-10-16), with no warning', ok(mk1) && a4.body.current.signedCopy === true && (await one(T.A, C.A4.name, drive(71), { markSigned: true })).warnings.length === 0, a4.body.current);
    const mk2 = await app(T.admin, [line(1, C.A4.name, drive(72), { onExisting: 'replace', markSigned: true })], `mk-b-${RUN}`);
    const a4b = await call('GET', `/api/clients/${C.A4.id}/agreement-links`, T.admin);
    check('G3 an Admin\'s "Mark as signed copy" is kept (who and when)', ok(mk2) && a4b.body.current.signedCopy === true && a4b.body.current.signedCopyByName === uAdmin.name, a4b.body.current);
    const pA = await call('PATCH', `/api/clients/${C.A4.id}/agreement-links/${a4b.body.current.id}`, T.A, { signedCopy: false });
    check('G4 the desk BDE can untick it too', ok(pA) && pA.body.current.signedCopy === false, [pA.status, pA.body]);
    const pT = await call('PATCH', `/api/clients/${C.A4.id}/agreement-links/${a4b.body.current.id}`, T.bdeTl, { signedCopy: false });
    check('G5 the BDE TL can', ok(pT) && pT.body.current.signedCopy === false, pT.body);
    const pT2 = await call('PATCH', `/api/clients/${C.A4.id}/agreement-links/${a4b.body.current.id}`, T.bdeTl, { signedCopy: true });
    check('G6 ... and tick it again', ok(pT2) && pT2.body.current.signedCopy === true, pT2.body);
    check('G7 the e-sign agreement is still untouched after ticking', (await snapshotAgr()) === agrBefore, null);

    // ============================ X: role catalog tick, single client, remove ============================
    await setBde('clients', 'Client Documents', 'create', false);
    const noTick = await app(T.A, [line(1, C.A3.name, drive(81), { onExisting: 'replace' })], `tick-${RUN}`);
    const noTickR = await rightsOf('A');
    check('X1 untick "Upload documents" in the Role Catalog: the BDE team still adds (the Catalog tick no longer takes it away, 2026-10-16) and keeps the button', ok(noTick) && noTickR.canAdd === true, [noTick.status, noTick.body]);
    await setBde('clients', 'Client Documents', 'create', true);
    check('X2 tick it again and it works', (await rightsOf('A')).canAdd === true, null);
    const single = await call('POST', `/api/clients/${C.A3.id}/agreement-links`, T.A, { link: drive(82), onExisting: 'replace', agreementDate: '2026-06-01' });
    check('X3 one client from its own page: replaced, message in plain words', single.status === 201 && /Replaced/.test(single.body.message), single.body);
    const singleBad = await call('POST', `/api/clients/${C.A3.id}/agreement-links`, T.A, { link: 'javascript:alert(1)', onExisting: 'replace' });
    check('X4 ... a bad link is a 400 with the reason', singleBad.status === 400 && singleBad.body.status === 'badlink', singleBad.body);
    const singleNo = await call('POST', `/api/clients/${C.B1.id}/agreement-links`, T.A, { link: drive(83) });
    check('X5 ... a same-desk colleague client is NOT refused (201 or 409 exists)', [201, 409].includes(singleNo.status), [singleNo.status, singleNo.body]);
    const singleKeep = await call('POST', `/api/clients/${C.A3.id}/agreement-links`, T.A, { link: drive(84) });
    check('X6 ... an existing link without "replace" answers 409', singleKeep.status === 409, singleKeep.status);
    const delA = await call('DELETE', `/api/clients/${C.A3.id}/agreement-links/${single.body.link.id}`, T.tl);
    const delT = await call('DELETE', `/api/clients/${C.A3.id}/agreement-links/${single.body.link.id}`, T.rec);
    const delDocA = await call('DELETE', `/api/clients/${C.A3.id}/documents/${single.body.link.id}`, T.tl);
    check('X7 a TL and a Recruiter can not remove a link; the generic document delete refuses a TL too', [delA.status, delT.status, delDocA.status].every((x) => [401, 403, 404].includes(x)), [delA.status, delT.status, delDocA.status]);
    const delAdmin = await call('DELETE', `/api/clients/${C.A3.id}/agreement-links/${single.body.link.id}`, T.A, { reason: 'ZZTEST AL wrong file' }); // the desk BDE removes (soft), like an Admin
    const a3 = await call('GET', `/api/clients/${C.A3.id}/agreement-links`, T.admin);
    check('X8 the desk BDE removes it (soft): no current link, history shows Removed, the row stays', ok(delAdmin) && !a3.body.current && a3.body.history.some((h) => h.state === 'Removed' && h.url === drive(82)) && (await prisma.clientDocument.count({ where: { id: single.body.link.id } })) === 1, a3.body);
    const afterRemove = await one(T.A, C.A3.name, drive(85));
    check('X9 after removal the client is "Matched" again (not "Already has a link")', afterRemove.status === 'ok', afterRemove);
    check('X10 the removal is audited (host only)', (await prisma.auditLog.count({ where: { action: 'Agreement Drive link removed', entityId: C.A3.id, fromValue: 'drive.google.com' } })) === 1, null);

    // ============================ F: files / template ============================
    const tplA = await fetch(`${Z.API}/api/clients/agreement-links/template`, { headers: { Authorization: `Bearer ${T.A}` } });
    const tplAdmin = await fetch(`${Z.API}/api/clients/agreement-links/template`, { headers: { Authorization: `Bearer ${T.admin}` } });
    const XLSX = require(path.join(Z.BACK, 'node_modules/xlsx'));
    const headOf = async (rs) => { const wb = XLSX.read(Buffer.from(await rs.arrayBuffer()), { type: 'buffer' }); return { sheets: wb.SheetNames, head: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 })[0] }; };
    const hA = await headOf(tplA); const hAd = await headOf(tplAdmin);
    check('F1 the template downloads; both the BDE template and the Admin template have the "Mark as signed copy" column (2026-10-16)', tplA.status === 200 && hA.head.length === 6 && hAd.head.length === 6 && hA.head[5] === 'Mark as signed copy' && hAd.head[5] === 'Mark as signed copy' && hA.sheets.includes('How to fill'), [hA, hAd]);
    const csvT = await call('GET', '/api/clients/agreement-links/template?format=csv', T.A);
    check('F2 and as CSV', csvT.status === 200 && /Drive link/.test(csvT.text), csvT.status);
    const sheet = XLSX.utils.aoa_to_sheet([['Client name or Client ID', 'Drive link', 'Agreement date', 'End date', 'Note'], [C.A1.name, drive(91), 46112, '', 'from excel'], ['', '', '', '', ''], [C.A2.clientCode, '']]);
    sheet.B3 = { t: 's', v: 'View', l: { Target: drive(92) } };
    sheet.A3 = { t: 's', v: C.A4.name };
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, sheet, 'Agreement links');
    const xbuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const fd = new FormData(); fd.append('file', new Blob([xbuf]), 'links.xlsx');
    const rf = await fetch(`${Z.API}/api/clients/agreement-links/read-file`, { method: 'POST', headers: { Authorization: `Bearer ${T.A}` }, body: fd });
    const rfj = await rf.json();
    const ck = await call('POST', '/api/clients/agreement-links/check', T.A, { text: rfj.text });
    check('F3 an Excel upload becomes the same text as a paste; Excel dates and "View" hyperlinks are understood', rf.status === 200 && ck.body.rows.length === 3 && ck.body.rows[0].agreementDate === '2026-03-31' && ck.body.rows[1].link && ck.body.rows[1].link.href === drive(92) && ck.body.rows[2].status === 'badlink', [rfj, ck.body.rows && ck.body.rows.map((x) => [x.row, x.status])]);
    const fd2 = new FormData(); fd2.append('file', new Blob([`${C.A1.name},${drive(93)}\n`]), 'links.csv');
    const rf2 = await fetch(`${Z.API}/api/clients/agreement-links/read-file`, { method: 'POST', headers: { Authorization: `Bearer ${T.A}` }, body: fd2 });
    check('F4 a CSV upload is read as it is', rf2.status === 200 && (await rf2.json()).text.includes(C.A1.name), rf2.status);
    const fd3 = new FormData(); fd3.append('file', new Blob(['%PDF-1.4 zz']), 'x.pdf');
    const rf3 = await fetch(`${Z.API}/api/clients/agreement-links/read-file`, { method: 'POST', headers: { Authorization: `Bearer ${T.A}` }, body: fd3 });
    check('F5 a PDF is refused in plain words', rf3.status === 400 && /PDF/.test((await rf3.json()).error), rf3.status);
    const fdMgr = new FormData(); fdMgr.append('file', new Blob(['a,b']), 'x.csv');
    const rfm = await fetch(`${Z.API}/api/clients/agreement-links/read-file`, { method: 'POST', headers: { Authorization: `Bearer ${T.mgr}` }, body: fdMgr });
    check('F6 a Manager can not upload a list (403)', rfm.status === 403, rfm.status);

    // ============================ N: never fetches the link ============================
    const srcFiles = ['src/utils/agreementDriveLinks.js', 'src/routes/agreementDriveLinkRoutes.js'].map((f) => fs.readFileSync(path.join(Z.BACK, f), 'utf8'));
    const code = srcFiles.map((s) => s.replace(/\/\/.*$/gm, '')).join('\n');
    check('N1 the code has no http / https / fetch / axios / net / mailer / dns', !/require\(['"](https?|net|tls|dns|axios|node-fetch|undici|nodemailer)['"]\)/.test(code) && !/\bfetch\(/.test(code) && !/\.\.\/utils\/(mailer|messaging|notify)/.test(code), null);
    const blocked = logSince(logStart).split('\n').filter((l) => /BLOCKED outbound/.test(l) && /google|drive|dropbox|onedrive|sharepoint/i.test(l));
    check('N2 the sandbox log shows no blocked outbound attempt for any Drive link during this run', blocked.length === 0, blocked.slice(0, 3));
  } catch (e) {
    Z.fail += 1; console.error('TEST SCRIPT ERROR', (e && e.stack) || e);
  } finally {
    try {
      if (touched.size) await prisma.roleAccess.deleteMany({ where: { role: 'BDE', moduleId: { in: [...touched] } } });
      const left = await Z.cleanup([
        (p) => p.appSetting.deleteMany({ where: { key: { startsWith: 'agrlink.' }, updatedByName: { contains: 'ZZTEST AL' } } }),
        (p) => p.auditLog.deleteMany({ where: { entity: 'AgreementLinkRun', actorName: { contains: 'ZZTEST AL' } } }),
      ]);
      const orphan = await prisma.appSetting.count({ where: { key: { startsWith: 'agrlink.' }, updatedByName: { contains: 'ZZTEST AL' } } });
      console.log('leftovers after cleanup:', JSON.stringify({ ...left, linkMeta: orphan }));
      Z.check('Z cleanup: nothing ZZTEST AL is left in the sandbox', Object.values(left).every((n) => n === 0) && orphan === 0, left);
    } catch (e) { console.error('cleanup problem:', e.message); }
    await Z.finish();
  }
})();
