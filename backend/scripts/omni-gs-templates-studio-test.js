#!/usr/bin/env node
// ---------------------------------------------------------------------------
// OMNI-CHANNEL GREEN START: Templates + Content Studio + Library TEST (2026-10-17) - COPY DATABASE ONLY.
//   cd backend
//   COPY_DB=C:/tmp/omni-v3-copy.db TEST_PORT=4104 node scripts/omni-gs-templates-studio-test.js
// Makes its OWN working copy (<name>-work.db), starts its OWN API (TEST_MODE, own upload folder) and checks:
//   L  library: upload / link / list / public share link / permissions / delete
//   T  templates: tree, list, create / edit / duplicate / archive, category, layout, WhatsApp variable mapping, policy check, approval rules, Meta (never called)
//   R  RCS assistants + templates, F WhatsApp Flows, V voice scripts
//   S  content studio
//   X  role visibility (Super Admin, TL, BDE, Recruiter, HR, Accounts, Client), no word "Draft" in what people read
// NOTHING real is sent: test mode, no Meta call, own upload folder.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const copy = process.env.COPY_DB;
if (!copy || /prisma[\\/]dev\.db$/i.test(path.resolve(copy))) { console.error('Refusing: set COPY_DB to a COPY of the database, never prisma/dev.db.'); process.exit(2); }
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const BACK = path.resolve(__dirname, '..');
const WORK = path.resolve(copy).replace(/\.db$/i, '-gstpl-work.db');
fs.copyFileSync(path.resolve(copy), WORK);
const PORT = Number(process.env.TEST_PORT || 4104);
if (PORT === 4010) process.exit(2);
const API = `http://127.0.0.1:${PORT}`;
const UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'omni-gs-uploads-'));
process.env.UPLOAD_DIR = UPLOADS;
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = `file:${WORK.split(path.sep).join('/')}?socket_timeout=60`;
process.env.UPLOAD_DIR = UPLOADS;

{ // the Omni-Channel base tables (the copy may lack them): applied to the WORKING copy only
  const db = new DatabaseSync(WORK);
  db.exec('PRAGMA busy_timeout = 30000');
  const has = (n) => !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(n);
  [['OutreachContact', '20261014100000_outreach_core'], ['OutreachCampaign', '20261014200000_outreach_campaigns'], ['OutreachCampaignNote', '20261014900000_outreach_quickwins']].forEach(([t, dir]) => {
    if (!has(t)) db.exec(fs.readFileSync(path.join(BACK, 'prisma', 'migrations', dir, 'migration.sql'), 'utf8'));
  });
  db.close();
}
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));

let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 500)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RUN = Date.now().toString(36);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

async function http(method, p, token, body, raw) {
  const h = { 'X-Forwarded-For': `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (raw) payload = raw; else if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(120000) });
  const buf = Buffer.from(await r.arrayBuffer());
  const text = buf.toString('utf8');
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text, buf, type: r.headers.get('content-type') || '', headers: r.headers };
}
const form = (bytes, type, filename, fields = {}) => { const fd = new FormData(); fd.append('file', new Blob([bytes], { type }), filename); Object.entries(fields).forEach(([k, v]) => fd.append(k, v)); return fd; };

(async () => {
  let server; let log = '';
  try {
    const A0 = require(path.join(BACK, 'src/outreach/access'));
    const first = async (where) => prisma.user.findFirst({ where: { status: 'Active', NOT: { email: { contains: 'example.test' } }, ...where } });
    const live = { employee: { is: { employmentStatus: 'Active' } } };
    const sa = await first({ role: 'SUPER_ADMIN' });
    let tl = null;
    for (const c of await prisma.user.findMany({ where: { status: 'Active', atsRole: 'TL', ...live }, take: 12 })) { // eslint-disable-line no-await-in-loop
      if (A0.kind(await resolveIdentity(c.id)) === 'tl') { tl = c; break; } // eslint-disable-line no-await-in-loop
    }
    const bde = await first({ atsRole: 'BDE', ...live });
    const hr = await first({ atsRole: 'HR', ...live });
    const recEmps = await prisma.employee.findMany({ where: { employmentStatus: 'Active', user: { atsRole: 'RECRUITER', status: 'Active' }, department: { not: null } }, include: { user: true }, take: 60 });
    const rec = recEmps[0];
    check('0 the copy has the people the test needs (Super Admin, TL, BDE, HR, a recruiter with a department)', !!(sa && tl && bde && hr && rec), { sa: !!sa, tl: !!tl, bde: !!bde, hr: !!hr, rec: !!rec });
    await prisma.user.updateMany({ where: { id: { in: [sa, tl, bde, hr, rec.user].filter(Boolean).map((u) => u.id) } }, data: { passwordHash: 'x' } });
    const recU = rec.user;
    const base = { passwordHash: 'x', hrmsAccess: false, atsAccess: true, accountsRole: 'NONE', accountsAccess: false, status: 'Active' };
    const client = await prisma.user.create({ data: { ...base, name: `ZZTEST client ${RUN}`, email: `zz-gst-client-${RUN}@example.test`, username: `zz-gst-client-${RUN}@example.test`, role: 'CLIENT', atsRole: 'CLIENT' } });
    const acct = await prisma.user.create({ data: { ...base, name: `ZZTEST accounts ${RUN}`, email: `zz-gst-acct-${RUN}@example.test`, username: `zz-gst-acct-${RUN}@example.test`, role: 'EMPLOYEE', atsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true } });

    server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', (d) => { log += d; }); server.stderr.on('data', (d) => { log += d; });
    let healthy = false;
    for (let i = 0; i < 120 && !healthy; i += 1) { try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); } }
    if (!healthy) { console.error('The throw-away server did not start.\n', log.slice(-1500)); process.exit(3); }
    const tokenOf = async (u) => jwt.sign(tokenPayload(await resolveIdentity(u.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const T = { sa: await tokenOf(sa), tl: await tokenOf(tl), bde: await tokenOf(bde), hr: await tokenOf(hr), rec: await tokenOf(recU), client: await tokenOf(client), acct: await tokenOf(acct) };
    const G = '/api/outreach/gs';

    // ================================================================ X: who gets in
    for (const [k, p] of [['client', 'templates/meta'], ['client', 'library'], ['client', 'studio/meta'], ['acct', 'templates/tree'], ['acct', 'library'], ['acct', 'studio/content']]) {
      const r = await http('GET', `${G}/${p}`, T[k]);
      check(`X1 ${k} is refused on ${p} (403)`, r.status === 403, r.status);
    }
    check('X2 no login at all is refused (401)', (await http('GET', `${G}/templates/meta`)).status === 401);

    // ================================================================ L: library
    const up1 = await http('POST', `${G}/library/upload`, T.sa, undefined, form(PNG, 'image/png', `zztest-${RUN}.png`, { note: 'ZZTEST picture' }));
    check('L1 a Super Admin saves a PNG into the Library (item with a share address, no stored path)', up1.status === 200 && up1.body.item && up1.body.item.mediaType === 'image' && /^\/api\/public\/outreach\/library\/[a-f0-9]{48}\//.test(up1.body.item.url) && !/stored/.test(up1.text), up1.text.slice(0, 300));
    const item1 = up1.body.item;
    const pub = await http('GET', item1.url);
    check('L2 the public share link streams the file without a login (right type, nosniff)', pub.status === 200 && pub.type.startsWith('image/png') && pub.buf.equals(PNG) && pub.headers.get('x-content-type-options') === 'nosniff', { s: pub.status, t: pub.type });
    check('L3 a wrong token gets a plain 404', (await http('GET', `/api/public/outreach/library/${'a'.repeat(48)}/x.png`)).status === 404 && (await http('GET', '/api/public/outreach/library/short/x.png')).status === 404);
    const bad1 = await http('POST', `${G}/library/upload`, T.sa, undefined, form(Buffer.from('<html>hi</html>'), 'text/html', 'x.html'));
    const bad2 = await http('POST', `${G}/library/upload`, T.sa, undefined, form(Buffer.from('not really a png at all'), 'image/png', 'x.png'));
    const bad3 = await http('POST', `${G}/library/upload`, T.sa, undefined, form(Buffer.concat([PNG, Buffer.alloc(5.5 * 1024 * 1024)]), 'image/png', 'big.png'));
    check('L4 a web page is refused (400), a fake PNG is refused (400), a file over 5 MB is refused (413)', bad1.status === 400 && bad2.status === 400 && bad3.status === 413, [bad1.status, bad2.status, bad3.status]);
    const pdf = await http('POST', `${G}/library/upload`, T.bde, undefined, form(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'), 'application/pdf', `zztest-${RUN}.pdf`, { department: 'ZZTestDept' }));
    check('L5 a BDE may save a file; a department the BDE does not belong to is refused (403)', pdf.status === 403, pdf.text.slice(0, 200));
    const pdf2 = await http('POST', `${G}/library/upload`, T.bde, undefined, form(Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF'), 'application/pdf', `zztest-${RUN}.pdf`));
    check('L6 the BDE saves a PDF with no department (everybody who uses Omni-Channel sees it) and it is a "document"', pdf2.status === 200 && pdf2.body.item.mediaType === 'document' && pdf2.body.item.isMine && pdf2.body.item.canDelete, pdf2.text.slice(0, 200));
    const docx = await http('POST', `${G}/library/upload`, T.sa, undefined, form(Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(40)]), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', `zztest-${RUN}.docx`));
    check('L7 a Word file (DOCX) is accepted (allowWord)', docx.status === 200 && docx.body.item.mediaType === 'document', docx.text.slice(0, 200));
    const recUp = await http('POST', `${G}/library/upload`, T.rec, undefined, form(PNG, 'image/png', 'rec.png'));
    check('L8 a Recruiter can look at the Library but not add (403)', recUp.status === 403, recUp.text.slice(0, 160));
    const lnk = await http('POST', `${G}/library/link`, T.sa, { name: `ZZTEST video ${RUN}`, url: 'https://www.youtube.com/watch?v=zztest', note: 'ZZTEST' });
    const lnkBad = await http('POST', `${G}/library/link`, T.sa, { url: 'javascript:alert(1)' });
    const lnkBad2 = await http('POST', `${G}/library/link`, T.sa, { url: 'ftp://x.test/a' });
    check('L9 a link is saved as a "video" link; javascript: and ftp: addresses are refused (400)', lnk.status === 200 && lnk.body.item.kind === 'link' && lnk.body.item.mediaType === 'video' && lnkBad.status === 400 && lnkBad2.status === 400, [lnk.text.slice(0, 160), lnkBad.status, lnkBad2.status]);
    const lr = await http('GET', `${G}/library`, T.rec);
    check('L10 a Recruiter sees the items with no department, with counts per type', lr.status === 200 && lr.body.items.some((i) => i.id === item1.id) && lr.body.counts.all >= 4 && lr.body.counts.image >= 1 && lr.body.counts.document >= 2 && lr.body.counts.video >= 1 && lr.body.canUpload === false, lr.text.slice(0, 250));
    const lrImg = await http('GET', `${G}/library?type=image`, T.rec); const lrQ = await http('GET', `${G}/library?q=${encodeURIComponent('ZZTEST picture')}`, T.rec);
    check('L11 the type filter and the search work', lrImg.body.items.length >= 1 && lrImg.body.items.every((i) => i.mediaType === 'image') && lrQ.body.items.some((i) => i.id === item1.id) && !lrQ.body.items.some((i) => i.id === lnk.body.item.id), [lrImg.body.items.length, lrQ.body.items.length]);
    // a department item: made by the Super Admin for a department the Recruiter is NOT in
    const recDept = String(rec.department);
    const otherDept = `ZZOther${RUN}`;
    const dUp = await http('POST', `${G}/library/upload`, T.sa, undefined, form(PNG, 'image/png', 'dept.png', { department: otherDept }));
    const dOwn = await http('POST', `${G}/library/upload`, T.sa, undefined, form(PNG, 'image/png', 'dept2.png', { department: recDept }));
    const lrR = await http('GET', `${G}/library`, T.rec); const lrB = await http('GET', `${G}/library`, T.bde); const lrS = await http('GET', `${G}/library`, T.sa);
    check('L12 a department item is seen by that department and the Admin only', dUp.status === 200 && !lrR.body.items.some((i) => i.id === dUp.body.item.id) && lrR.body.items.some((i) => i.id === dOwn.body.item.id) && lrS.body.items.some((i) => i.id === dUp.body.item.id) && !lrB.body.items.some((i) => i.id === dUp.body.item.id), [dUp.status, dOwn.status]);
    const lf = await http('POST', `${G}/library/links-for`, T.rec, { ids: [item1.id, dUp.body.item.id, 'nope', pdf2.body.item.id] });
    check('L13 linksFor gives the links of what this person may see, and skips the rest', lf.status === 200 && lf.body.links.length === 2 && lf.body.links.every((l) => l.url.includes('/api/public/outreach/library/')) && !lf.body.links.some((l) => l.id === dUp.body.item.id), lf.text.slice(0, 250));
    const delOther = await http('DELETE', `${G}/library/${item1.id}`, T.bde);
    check('L14 a BDE cannot delete somebody else\'s item (403)', delOther.status === 403, delOther.text.slice(0, 120));
    const storedFile = fs.readdirSync(UPLOADS).length;
    const delOwn = await http('DELETE', `${G}/library/${pdf2.body.item.id}`, T.bde);
    check('L15 the owner deletes their own item: the file is removed from disk and the item leaves the list', delOwn.status === 200 && fs.readdirSync(UPLOADS).length === storedFile - 1 && !(await http('GET', `${G}/library`, T.sa)).body.items.some((i) => i.id === pdf2.body.item.id), delOwn.text);
    const delAdmin = await http('DELETE', `${G}/library/${item1.id}`, T.sa);
    check('L16 an Admin deletes any item; its public link then gives 404', delAdmin.status === 200 && (await http('GET', item1.url)).status === 404, delAdmin.text);
    const ren = await http('PUT', `${G}/library/${docx.body.item.id}`, T.sa, { name: `ZZTEST renamed ${RUN}` });
    check('L17 the owner renames an item', ren.status === 200 && ren.body.item.name.startsWith('ZZTEST renamed'), ren.text.slice(0, 160));

    // ================================================================ T: templates
    const meta = await http('GET', `${G}/templates/meta`, T.sa);
    check('T1 meta: categories, languages, variables, WhatsApp connection words (no token), flags', meta.status === 200 && meta.body.categories.join() === 'Marketing,Utility,Authentication' && meta.body.languages.length === 3 && meta.body.variables.length === 5 && typeof meta.body.whatsapp.connected === 'boolean' && !/token|secret/i.test(JSON.stringify(meta.body.whatsapp)) && meta.body.canEdit === true, meta.text.slice(0, 300));
    const tree = await http('GET', `${G}/templates/tree`, T.sa);
    const gk = (tree.body.groups || []).map((g) => g.key).join();
    check('T2 the tree has WhatsApp, SMS, RCS, Voice, Email with accounts and counts, plus the approval queue', tree.status === 200 && gk === 'whatsapp,sms,rcs,voice,email' && tree.body.groups.every((g) => Array.isArray(g.families)) && tree.body.queue && typeof tree.body.queue.pending === 'number', tree.text.slice(0, 300));
    const waBody = 'Hi {{name}}, {{company}} has a new opening for {{job_title}}. Apply here {{apply_link}} Reply STOP to opt out';
    const mk = async (tok, b) => http('POST', `${G}/templates/outreach`, tok, b);
    const wa1 = await mk(T.sa, { name: `ZZTEST wa one ${RUN}`, channel: 'whatsapp', body: waBody, promotional: true, extra: { headerType: 'text', headerText: 'New job for {{name}}', footer: 'Reply STOP to unsubscribe', buttons: [{ type: 'url', label: 'Apply now', url: 'https://example.org/apply' }, { type: 'reply', label: 'Interested' }] } });
    check('T3 a WhatsApp template is created: category Marketing by default, layout kept, Meta name made, not approved', wa1.status === 200 && wa1.body.template && wa1.body.template.category === 'Marketing' && wa1.body.template.extra.buttons.length === 2 && wa1.body.template.extra.headerType === 'text' && /^zztest_wa_one_/.test(wa1.body.template.waTemplateName) && wa1.body.template.waApprovalStatus === 'draft' && wa1.body.template.ready === false, wa1.text.slice(0, 400));
    const tw = wa1.body.template;
    check('T4 the Meta numbering ({{1}} {{2}}) is shown with what each number stands for', tw.waMap && tw.waMap.text.startsWith('Hi {{1}}, {{2}} has') && tw.waMap.params.map((p) => p.name).join() === 'name,company,job_title,apply_link', tw.waMap);
    const utilT = await mk(T.sa, { name: `ZZTEST util ${RUN}`, channel: 'email', subject: 'Hello', body: 'Your update, {{name}}.', promotional: false });
    check('T5 a template that is not a promotion gets category Utility (derived); a picked category is kept', utilT.status === 200 && utilT.body.template.category === 'Utility', utilT.text.slice(0, 200));
    const authT = await mk(T.sa, { name: `ZZTEST auth ${RUN}`, channel: 'sms', body: 'Your verification code is {{name}} to verify.', promotional: false, category: 'Authentication', senderId: 'GRNSRT', dltTemplateId: '1107162345678901234' });
    check('T6 SMS keeps category Authentication, sender ID and DLT number', authT.status === 200 && authT.body.template.category === 'Authentication' && authT.body.template.senderId === 'GRNSRT', authT.text.slice(0, 250));
    const badSms = await mk(T.sa, { name: `ZZTEST sms bad ${RUN}`, channel: 'sms', body: 'Hello {{name}} Reply STOP to opt out', senderId: 'AB C' });
    const badDlt = await mk(T.sa, { name: `ZZTEST sms bad2 ${RUN}`, channel: 'sms', body: 'Hello {{name}} Reply STOP to opt out', dltTemplateId: '12ab' });
    const badCat = await mk(T.sa, { name: `ZZTEST cat bad ${RUN}`, channel: 'email', subject: 's', body: 'Hello {{name}} {{unsubscribe}}', category: 'Spam' });
    check('T7 SMS sender ID and DLT number are checked (400), an unknown category is refused (400)', badSms.status === 400 && badDlt.status === 400 && badCat.status === 400, [badSms.text.slice(0, 120), badDlt.status, badCat.status]);
    const badVar = await mk(T.sa, { name: `ZZTEST var ${RUN}`, channel: 'whatsapp', body: 'Hello {{1}} Reply STOP to opt out', promotional: true });
    check('T8 a Meta-style {{1}} is refused with the names we do know (400)', badVar.status === 400 && /known word/.test(badVar.body.error), badVar.text.slice(0, 200));
    const chk = await http('POST', `${G}/templates/check`, T.bde, { channel: 'whatsapp', name: 'Sale', category: 'Utility', body: '{{name}} BIG SALE FREE OFFER http://bit.ly/x', promotional: false, extra: { buttons: [{ type: 'reply', label: 'A' }, { type: 'reply', label: 'A' }] } });
    const codes = (chk.body.policy ? chk.body.policy.issues : []).map((i) => i.code);
    check('T9 the policy check names the problems in plain words (promotional words under Utility, short link, repeated label, starts with a variable)', chk.status === 200 && chk.body.policy.verdict === 'fail' && codes.includes('TAG_CONTENT_MISMATCH') && chk.body.policy.issues.some((i) => /Shortened links/.test(i.message)) && chk.body.policy.issues.some((i) => /same label/.test(i.message)) && chk.body.policy.issues.some((i) => /cannot start with a variable/.test(i.message)) && chk.body.policy.issues.every((i) => i.message && (i.severity === 'info' || i.fix !== undefined)), chk.text.slice(0, 400));
    const chkOk = await http('POST', `${G}/templates/check`, T.sa, { channel: 'whatsapp', name: 'zztest_ok', category: 'Marketing', body: waBody, promotional: true, extra: { footer: 'Reply STOP to unsubscribe' } });
    check('T10 a good WhatsApp template meets the rules (no errors) and the check never saves anything', chkOk.status === 200 && chkOk.body.policy.errors === 0 && chkOk.body.map.params.length === 4 && chkOk.body.ready === false, chkOk.text.slice(0, 300));
    // approval rules
    const bdeEdit = await http('PUT', `${G}/templates/outreach/${tw.id}`, T.bde, { waApprovalStatus: 'approved', name: tw.name });
    check('T11 a BDE cannot approve a template: the status stays "not sent to Meta"', bdeEdit.status === 200 && bdeEdit.body.template.waApprovalStatus === 'draft', bdeEdit.text.slice(0, 200));
    const admApprove = await http('PUT', `${G}/templates/outreach/${tw.id}`, T.sa, { waApprovalStatus: 'approved' });
    check('T12 an Admin sets the approval; the template is then ready to use', admApprove.status === 200 && admApprove.body.template.waApprovalStatus === 'approved' && admApprove.body.template.ready === true, admApprove.text.slice(0, 200));
    const reedit = await http('PUT', `${G}/templates/outreach/${tw.id}`, T.bde, { body: `${waBody} Thank you.` });
    check('T13 changing the words of an approved template sends it back to "not sent to Meta" (WhatsApp must approve again)', reedit.status === 200 && reedit.body.resubmit === true && reedit.body.template.waApprovalStatus === 'draft' && reedit.body.template.ready === false, reedit.text.slice(0, 250));
    const forged = await http('PUT', `${G}/templates/outreach/${tw.id}`, T.bde, { extra: { headerType: 'none', review: { verdict: 'PASS' }, meta: { status: 'APPROVED' } } });
    const got = await http('GET', `${G}/templates/item/${tw.id}`, T.bde);
    check('T14 a screen can never write the review or Meta records (they are the server\'s only)', forged.status === 200 && !got.body.template.extra.review && !got.body.template.extra.meta, got.body.template.extra);
    // Meta is never called in a test
    const sub = await http('POST', `${G}/templates/outreach/${tw.id}/submit`, T.sa);
    const syn = await http('POST', `${G}/templates/outreach/${tw.id}/sync`, T.sa);
    check('T15 "Send to Meta" and "Check with Meta" call nothing in test mode (409 "test mode") and keep the status', sub.status === 409 && /test mode/i.test(sub.body.error) && syn.status === 409 && (await http('GET', `${G}/templates/item/${tw.id}`, T.sa)).body.template.waApprovalStatus === 'draft', [sub.text.slice(0, 200), syn.text.slice(0, 200)]);
    const subBad = await mk(T.sa, { name: `ZZTEST wa bad ${RUN}`, channel: 'whatsapp', body: 'Hi {{name}}, get a free offer from us today. Reply STOP to opt out', promotional: true, category: 'Utility' });
    const subBadRes = await http('POST', `${G}/templates/outreach/${subBad.body.template.id}/submit`, T.sa);
    check('T16 a template that breaks the policy is refused before anything is sent (400, with the issues)', subBadRes.status === 400 && Array.isArray(subBadRes.body.issues) && /^Cannot send yet/.test(subBadRes.body.error), subBadRes.text.slice(0, 250));
    // the list
    const lw = await http('GET', `${G}/templates/list?channel=whatsapp&where=Omni-Channel`, T.sa);
    const row = (lw.body.items || []).find((i) => i.id === tw.id);
    check('T17 the WhatsApp list has our template with category, status words, language, Edit right, in plain words', lw.status === 200 && row && row.category === 'Marketing' && row.statusWord === 'Not sent to Meta' && row.canEdit === true && row.waLanguage === 'en_US', row);
    const lq = await http('GET', `${G}/templates/list?channel=whatsapp&where=Omni-Channel&approval=queue`, T.sa);
    check('T18 the approval queue lists WhatsApp templates that are not approved yet', lq.status === 200 && lq.body.items.some((i) => i.id === tw.id) && lq.body.items.every((i) => i.wa && ['None', 'Pending'].includes(i.wa.status)), lq.text.slice(0, 200));
    const ls = await http('GET', `${G}/templates/list?channel=sms`, T.sa); const le = await http('GET', `${G}/templates/list?channel=email`, T.sa);
    check('T19 SMS and Email lists hold their own templates only', ls.body.items.some((i) => i.id === authT.body.template.id) && ls.body.items.every((i) => i.channel === 'SMS') && le.body.items.some((i) => i.id === utilT.body.template.id) && le.body.items.every((i) => i.channel === 'Email'));
    const treeAfter = await http('GET', `${G}/templates/tree`, T.sa);
    const waCount = treeAfter.body.groups[0].families[0].accounts[0].count;
    check('T20 the tree counts are the real counts (WhatsApp number = rows in the list)', waCount === (await http('GET', `${G}/templates/list?channel=whatsapp&where=Omni-Channel`, T.sa)).body.total, waCount);
    // duplicate / archive
    const dup = await http('POST', `${G}/templates/outreach/${tw.id}/duplicate`, T.sa);
    check('T21 duplicate makes a copy with a free name, back to "not sent to Meta", layout kept', dup.status === 200 && /\(copy\)$/.test(dup.body.template.name) && dup.body.template.waApprovalStatus === 'draft' && dup.body.template.extra.headerType === 'none' && dup.body.template.category === 'Marketing', dup.text.slice(0, 250));
    const arch = await http('DELETE', `${G}/templates/outreach/${dup.body.template.id}`, T.sa);
    check('T22 archive removes it from the list', arch.status === 200 && !(await http('GET', `${G}/templates/list?channel=whatsapp`, T.sa)).body.items.some((i) => i.id === dup.body.template.id), arch.text);
    // roles
    const recMk = await mk(T.rec, { name: `ZZTEST rec ${RUN}`, channel: 'email', subject: 's', body: 'Hello {{name}} {{unsubscribe}}' });
    check('T23 a Recruiter can read templates but not write them (403)', recMk.status === 403 && (await http('GET', `${G}/templates/list?channel=whatsapp`, T.rec)).status === 200, recMk.text.slice(0, 160));
    const recList = await http('GET', `${G}/templates/list?channel=whatsapp`, T.rec);
    check('T24 a Recruiter\'s rows say they cannot edit (the Edit button opens read-only)', recList.body.items.length > 0 && recList.body.items.every((i) => i.canEdit === false), recList.body.items.slice(0, 1));
    const hrMk = await mk(T.hr, { name: `ZZTEST hr ${RUN}`, channel: 'email', subject: 'Staff notice', body: 'Hello {{name}} {{unsubscribe}}', promotional: false });
    check('T25 HR writes STAFF-side templates only (audience internal)', hrMk.status === 200 && hrMk.body.template.audience === 'internal', hrMk.text.slice(0, 200));
    const hrList = await http('GET', `${G}/templates/list?channel=email`, T.hr); const hrWa = await http('GET', `${G}/templates/list?channel=whatsapp`, T.hr);
    check('T26 HR sees staff-side templates only (not the job campaign ones)', hrList.body.items.some((i) => i.id === hrMk.body.template.id) && !hrList.body.items.some((i) => i.id === utilT.body.template.id) && !hrWa.body.items.some((i) => i.id === tw.id), [hrList.body.items.length]);
    const bdeSee = await http('GET', `${G}/templates/list?channel=email`, T.bde);
    check('T27 a BDE does not see the HR staff-side template', !bdeSee.body.items.some((i) => i.id === hrMk.body.template.id) && bdeSee.body.items.some((i) => i.id === utilT.body.template.id));
    const bdeWa = await mk(T.bde, { name: `ZZTEST bde wa ${RUN}`, channel: 'whatsapp', body: 'Hi {{name}}, a new opening for {{job_title}} is open. Reply STOP to opt out', promotional: true });
    check('T28 a BDE writes job-side WhatsApp templates; and the template holds no phone / email (nothing personal)', bdeWa.status === 200 && !/\d{10}|@/.test(JSON.stringify(bdeWa.body.template)), bdeWa.text.slice(0, 200));

    // ================================================================ R: RCS
    const assistant = (name, over = {}) => ({ data: { name, category: 'Promotional', billing: 'Basic Message', description: 'Sends job alerts and updates.', theme: '#11985a', cover: { libraryId: 'x', url: '/a.png', name: 'c.png' }, icon: { libraryId: 'y', url: '/b.png', name: 'i.png' }, contact: { name: 'Anil', mobile: '9876543210', designation: 'Manager', email: 'anil@example.test' }, phones: [{ label: 'Support', number: '9876543210' }], websites: [{ url: 'https://example.org' }], emails: [{ email: 'help@example.test' }], privacyUrl: 'https://example.org/privacy', termsUrl: 'https://example.org/terms', brand: 'ZZTEST Pvt Ltd', brandSite: '', testers: ['+91 98765 43210'], ...over } });
    const aBad = await http('POST', `${G}/templates/rcs/agents`, T.sa, assistant(`ZZ`, {}));
    check('R1 an assistant with a short name is refused with the step\'s own sentence (400)', aBad.status === 400 && /at least 3 characters/.test(aBad.body.error) && aBad.body.step === 1, aBad.text.slice(0, 200));
    const aBad3 = await http('POST', `${G}/templates/rcs/agents`, T.sa, assistant(`ZZTEST rcs bad ${RUN}`, { privacyUrl: 'http://x' }));
    check('R2 a privacy link without https is refused (step 3)', aBad3.status === 400 && /Privacy policy/.test(aBad3.body.error) && aBad3.body.step === 3, aBad3.text.slice(0, 200));
    const ck = await http('POST', `${G}/templates/rcs/agents/check`, T.sa, { step: 2, data: { theme: 'red' } });
    check('R3 the step check names missing branding', ck.status === 200 && ck.body.errors.length === 3, ck.text);
    const ag = await http('POST', `${G}/templates/rcs/agents`, T.sa, assistant(`ZZTEST rcs ${RUN}`));
    check('R4 a valid assistant is saved: "saved here, not sent to a carrier" (never "verified")', ag.status === 200 && ag.body.agent.status === 'saved' && /not sent to a carrier/.test(ag.body.agent.statusWord) && !/verified|live/i.test(ag.body.agent.statusWord), ag.text.slice(0, 250));
    const agent = ag.body.agent;
    check('R5 the same assistant name again is refused (409)', (await http('POST', `${G}/templates/rcs/agents`, T.sa, assistant(`zztest RCS ${RUN}`))).status === 409);
    const rt = await http('POST', `${G}/templates/rcs/templates`, T.sa, { agentId: agent.id, name: `ZZTEST card ${RUN}`, type: 'card' });
    check('R6 an RCS template is created under the assistant as "Not sent yet"', rt.status === 200 && rt.body.template.status === 'draft' && rt.body.template.statusWord === 'Not sent yet' && rt.body.template.typeWord === 'Standalone Card', rt.text.slice(0, 250));
    const rtId = rt.body.template.id;
    const rtBad = await http('PUT', `${G}/templates/rcs/templates/${rtId}`, T.sa, { form: { title: '', description: '', actions: [] } });
    check('R7 saving an empty card is refused with the sentence (400)', rtBad.status === 400 && /title or a description/.test(rtBad.body.error), rtBad.text);
    const rtBad2 = await http('PUT', `${G}/templates/rcs/templates/${rtId}`, T.sa, { form: { title: 'Hi', actions: [{ type: 'url', label: 'Open', url: '' }] } });
    check('R8 a button without its address is refused by name', rtBad2.status === 400 && /Button "Open" needs/.test(rtBad2.body.error), rtBad2.text);
    const rtOk = await http('PUT', `${G}/templates/rcs/templates/${rtId}`, T.sa, { form: { title: 'New job', description: 'ICU nurse needed', orientation: 'vertical', mediaHeight: 'medium', actions: [{ type: 'url', label: 'Apply', url: 'https://example.org/apply' }, { type: 'reply', label: 'Yes' }] } });
    check('R9 a good card is saved ("Saved") and its actions are kept', rtOk.status === 200 && rtOk.body.template.status === 'saved' && rtOk.body.template.form.actions.length === 2, rtOk.text.slice(0, 250));
    const rn = await http('PUT', `${G}/templates/rcs/templates/${rtId}`, T.sa, { name: `ZZTEST card renamed ${RUN}` });
    check('R10 a rename alone keeps the saved fields', rn.status === 200 && rn.body.template.form.title === 'New job', rn.text.slice(0, 200));
    const rd = await http('POST', `${G}/templates/rcs/templates/${rtId}/duplicate`, T.sa);
    check('R11 duplicate is named "<name> copy" and is "Not sent yet"', rd.status === 200 && / copy$/.test(rd.body.template.name) && rd.body.template.status === 'draft', rd.text.slice(0, 200));
    const rcar = await http('POST', `${G}/templates/rcs/templates`, T.sa, { agentId: agent.id, name: `ZZTEST carousel ${RUN}`, type: 'carousel' });
    const rcarBad = await http('PUT', `${G}/templates/rcs/templates/${rcar.body.template.id}`, T.sa, { form: { cards: [{ title: 'only one' }, {}] } });
    check('R12 a carousel needs two cards with content (400)', rcarBad.status === 400 && /at least 2 cards/.test(rcarBad.body.error), rcarBad.text);
    const pl = await http('POST', `${G}/templates/rcs/payload`, T.sa, { type: 'card', form: rtOk.body.template.form });
    check('R13 the preview JSON is the carrier shape (standaloneCard, suggestions) and nothing is sent', pl.status === 200 && pl.body.payload.data.content.standaloneCard.cardContent.suggestions.length === 2 && pl.body.payload.agentID === 'PREVIEW_AGENT_ID', pl.text.slice(0, 250));
    const rl = await http('GET', `${G}/templates/rcs/templates?agentId=${agent.id}`, T.sa);
    check('R14 the gallery list returns the templates of the assistant', rl.body.templates.length === 3, rl.body.templates.length);
    check('R15 an assistant that still has templates cannot be deleted (409)', (await http('DELETE', `${G}/templates/rcs/agents/${agent.id}`, T.sa)).status === 409);
    check('R16 the Recruiter cannot make RCS things (403) and the staff-side rule keeps the HR from the job-side assistant', (await http('POST', `${G}/templates/rcs/agents`, T.rec, assistant(`ZZTEST rec rcs ${RUN}`))).status === 403 && !(await http('GET', `${G}/templates/rcs/agents`, T.hr)).body.agents.some((a) => a.id === agent.id));
    for (const t of rl.body.templates) await http('DELETE', `${G}/templates/rcs/templates/${t.id}`, T.sa); // eslint-disable-line no-await-in-loop
    check('R17 after the templates are gone the assistant can be deleted', (await http('GET', `${G}/templates/rcs/templates?agentId=${agent.id}`, T.sa)).body.templates.length === 0 && (await http('DELETE', `${G}/templates/rcs/agents/${agent.id}`, T.sa)).status === 200);

    // ================================================================ F: flows
    const fl = await http('POST', `${G}/templates/flows`, T.sa, { name: `ZZTEST flow ${RUN}` });
    check('F1 a new Flow has two screens and the status says publishing is planned', fl.status === 200 && fl.body.flow.screens.length === 2 && /planned/i.test(fl.body.flow.statusWord), fl.text.slice(0, 250));
    const flow = fl.body.flow;
    check('F2 the same Flow name again is refused (409), an empty name too (400)', (await http('POST', `${G}/templates/flows`, T.sa, { name: `zztest FLOW ${RUN}` })).status === 409 && (await http('POST', `${G}/templates/flows`, T.sa, { name: ' ' })).status === 400);
    const fu = await http('PUT', `${G}/templates/flows/${flow.id}`, T.sa, { screens: [{ name: 'Pick a role', type: 'Dropdown' }, { name: 'Date', type: 'Date picker' }, { name: 'Done', type: 'Terminal' }] });
    check('F3 screens are saved in order', fu.status === 200 && fu.body.flow.screens.map((s) => s.type).join() === 'Dropdown,Date picker,Terminal', fu.text.slice(0, 200));
    check('F4 a Flow needs two screens (400) and every screen a title (400)', (await http('PUT', `${G}/templates/flows/${flow.id}`, T.sa, { screens: [{ name: 'one', type: 'Question' }] })).status === 400 && (await http('PUT', `${G}/templates/flows/${flow.id}`, T.sa, { screens: [{ name: '', type: 'Question' }, { name: 'b', type: 'Terminal' }] })).status === 400);
    check('F5 the Recruiter cannot change a Flow (403); the Flow is in the tree', (await http('PUT', `${G}/templates/flows/${flow.id}`, T.rec, { name: 'x' })).status === 403 && (await http('GET', `${G}/templates/tree`, T.rec)).body.groups[0].flows.some((f) => f.id === flow.id));
    check('F6 a Flow is deleted', (await http('DELETE', `${G}/templates/flows/${flow.id}`, T.sa)).status === 200 && !(await http('GET', `${G}/templates/flows`, T.sa)).body.flows.some((f) => f.id === flow.id));

    // ================================================================ V: voice
    const vs = await http('POST', `${G}/templates/voice`, T.sa, { name: `ZZTEST voice ${RUN}`, category: 'Utility', language: 'en_US', script: 'Hello, this is a message about your application.' });
    const vList = await http('GET', `${G}/templates/list?channel=voice`, T.sa);
    check('V1 a saved voice script appears next to the read-only built-in call scripts', vs.status === 200 && vList.body.items.some((i) => i.id === vs.body.item.id && i.canEdit) && vList.body.items.some((i) => i.source === 'script' && i.canEdit === false && i.statusWord === 'Built in'), vList.text.slice(0, 250));
    check('V2 an empty script or short name is refused (400)', (await http('POST', `${G}/templates/voice`, T.sa, { name: 'ok name', script: ' ' })).status === 400 && (await http('POST', `${G}/templates/voice`, T.sa, { name: 'a', script: 'x' })).status === 400);
    const vu = await http('PUT', `${G}/templates/voice/${vs.body.item.id}`, T.sa, { script: 'Changed script text here.', category: 'Marketing' });
    check('V3 the script is edited', vu.status === 200 && vu.body.item.body === 'Changed script text here.' && vu.body.item.category === 'Marketing', vu.text.slice(0, 200));
    check('V4 a Recruiter cannot add a voice script (403)', (await http('POST', `${G}/templates/voice`, T.rec, { name: 'rec voice', script: 'x' })).status === 403);
    check('V5 the voice script is deleted', (await http('DELETE', `${G}/templates/voice/${vs.body.item.id}`, T.sa)).status === 200 && !(await http('GET', `${G}/templates/list?channel=voice`, T.sa)).body.items.some((i) => i.id === vs.body.item.id));

    // ================================================================ S: studio
    const sm = await http('GET', `${G}/studio/meta`, T.sa);
    check('S1 studio meta lists WhatsApp, SMS, Email and the social versions with limits', sm.status === 200 && sm.body.channels.length === 9 && sm.body.channels.find((c) => c.key === 'x').limit === 280 && sm.body.voices.length === 4, sm.text.slice(0, 200));
    const master = 'Your weekend just got better\nMembers get 20% off selected products until Sunday midnight.\nTap below to shop now.';
    const ad = await http('POST', `${G}/studio/adapt`, T.sa, { master, name: 'Weekend Rewards', cta: 'Shop now' });
    check('S2 the rule-based rewrite gives one version per channel inside each limit and says it is rules, not AI', ad.status === 200 && ad.body.method === 'rules' && Object.keys(ad.body.adaptations).length === 9 && ad.body.adaptations.x.length <= 280 && /#WeekendRewards/.test(ad.body.adaptations.instagram) && /Reply STOP/.test(ad.body.adaptations.whatsapp), ad.text.slice(0, 300));
    const sv = await http('POST', `${G}/studio/content`, T.sa, { name: `ZZTEST content ${RUN}`, voice: 'Playful', cta: 'Shop now', master, adaptations: ad.body.adaptations, libraryIds: [docx.body.item.id], subject: 'Weekend' });
    check('S3 content is saved (status "ready"), with its media ids and a version per channel', sv.status === 200 && sv.body.updated === false && sv.body.content.status === 'ready' && sv.body.content.libraryIds.length === 1 && Object.keys(sv.body.content.adaptations).length === 9 && sv.body.content.canEdit, sv.text.slice(0, 250));
    const sv2 = await http('POST', `${G}/studio/content`, T.sa, { name: `zztest CONTENT ${RUN}`, master: 'Changed', adaptations: { x: 'short' } });
    check('S4 saving the same name again updates it (no double)', sv2.status === 200 && sv2.body.updated === true && sv2.body.content.id === sv.body.content.id && sv2.body.content.master === 'Changed', sv2.text.slice(0, 200));
    const over = await http('POST', `${G}/studio/content`, T.sa, { name: `ZZTEST over ${RUN}`, master: 'x', adaptations: { x: 'a'.repeat(300) } });
    check('S5 a version over its limit is refused with the channel named (400); no name is refused (400)', over.status === 400 && /X version/.test(over.body.error) && (await http('POST', `${G}/studio/content`, T.sa, { name: ' ', master: 'x' })).status === 400, over.text);
    const gl = await http('GET', `${G}/studio/content/${sv.body.content.id}`, T.tl);
    check('S6 content can be loaded by id (for "Send to campaign"), with its media links', gl.status === 200 && gl.body.content.id === sv.body.content.id && gl.body.media.length === 1 && gl.body.media[0].url.includes('/api/public/outreach/library/'), gl.text.slice(0, 250));
    const sl = await http('GET', `${G}/studio/content`, T.rec);
    check('S7 a Recruiter sees saved content but cannot save or delete (403)', sl.status === 200 && sl.body.items.some((i) => i.id === sv.body.content.id) && sl.body.canSave === false && (await http('POST', `${G}/studio/content`, T.rec, { name: 'rec c', master: 'x' })).status === 403 && (await http('DELETE', `${G}/studio/content/${sv.body.content.id}`, T.rec)).status === 403);
    const tlSave = await http('POST', `${G}/studio/content`, T.tl, { name: `zztest content ${RUN}`, master: 'tl try' });
    check('S8 a Team Lead cannot overwrite somebody else\'s content under the same name (403)', tlSave.status === 403, tlSave.text.slice(0, 200));
    check('S9 posts: honestly empty when nothing was posted', (await http('GET', `${G}/studio/posts`, T.sa)).status === 200 && Array.isArray((await http('GET', `${G}/studio/posts`, T.sa)).body.items));
    const sd = await http('DELETE', `${G}/studio/content/${sv.body.content.id}`, T.sa);
    check('S10 content is deleted and is gone from the list and from load-by-id', sd.status === 200 && !(await http('GET', `${G}/studio/content`, T.sa)).body.items.some((i) => i.id === sv.body.content.id) && (await http('GET', `${G}/studio/content/${sv.body.content.id}`, T.sa)).status === 404);
    const hrContent = await http('POST', `${G}/studio/content`, T.hr, { name: `ZZTEST hr content ${RUN}`, master: 'Staff notice' });
    check('S11 HR may save content', hrContent.status === 200, hrContent.text.slice(0, 160));

    // ================================================================ X: words
    const shown = [];
    const lists = ['whatsapp', 'sms', 'email', 'voice'];
    for (const ch of lists) { const r = await http('GET', `${G}/templates/list?channel=${ch}&where=all`, T.sa); (r.body.items || []).forEach((i) => shown.push(i.statusWord)); } // eslint-disable-line no-await-in-loop
    const treeTxt = JSON.stringify((await http('GET', `${G}/templates/tree`, T.sa)).body.groups.map((g) => [g.label, g.families.map((f) => [f.label, f.accounts.map((a) => [a.name, a.sub])])]));
    check('X3 no word "Draft" in any status, account or family words people read', !shown.some((w) => /draft/i.test(String(w))) && !/draft/i.test(treeTxt), shown.filter((w) => /draft/i.test(String(w))));
    check('X4 the Meta check never claims "approved" on its own: no template of ours is approved by a test call', (await http('GET', `${G}/templates/list?channel=whatsapp`, T.sa)).body.items.filter((i) => i.name.startsWith('ZZTEST') && i.statusWord === 'Approved').length === 0);

    // cleanup of what the test made in the working copy (the copy is thrown away anyway)
    await prisma.$executeRawUnsafe("DELETE FROM \"OutreachTemplate\" WHERE name LIKE 'ZZTEST%'").catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [client.id, acct.id] } } }).catch(() => {});
  } catch (e) {
    fail += 1; console.log('FAIL  unexpected error', e && e.stack);
  } finally {
    if (fail && log) console.log(`---- server log (tail) ----\n${log.slice(-2500)}`);
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    try { fs.rmSync(UPLOADS, { recursive: true, force: true }); } catch { /* fine */ }
    console.log(`\n${pass} passed, ${fail} failed.  (working copy: ${WORK} - delete it when done)`);
    process.exit(fail ? 1 : 0);
  }
})();
