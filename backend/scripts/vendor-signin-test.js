#!/usr/bin/env node
// ---------------------------------------------------------------------------
// VENDOR SIGN-IN TEST (2026-10-19) - COPY DATABASE ONLY, NO REAL EMAIL.
//   cd backend
//   node scripts/vendor-signin-test.js                          makes its own VACUUM INTO copy of the real database (read-only on the source)
//   COPY_DB=C:/tmp/vsi-copy.db node scripts/vendor-signin-test.js   use a copy you made (never prisma/dev.db)
//
// THE FOUNDER'S BUG: "Vendor login details are correct but it says incorrect."
// This test does what a vendor does: Admin presses Create login, the email arrives (captured by the fake transport), the vendor COPIES the
// login ID and the temporary password out of the email (from the HTML twin with tags stripped and entities decoded, and from the plain-text
// twin) and signs in with exactly those. It runs for the three kinds of vendor (finance, Assets, ID Cards) and then walks every cause that used
// to be answered with the same "Invalid credentials.":
//   A  the email: same password in text and HTML, plain copy-friendly boxes, no hidden characters, newest-email wording, subject number
//   B  copy-paste and typing noise (spaces, line breaks, non-breaking space, zero-width, quotes, capitals, <angle brackets>)
//   C  the three kinds: first sign-in with the temporary password works AT ONCE, forced change, then normal sign-in, then the old password
//   D  the login ID: capitals, login email vs the vendor's contact email
//   E  Resend: the OLD email's password says "replaced by a newer email", is not a wrong try, the newest works
//   F  Edit email on a waiting login: the old Login ID and the old password are explained
//   G  wrong password / unknown ID look the same; the lock (5 tries) reads the same for real and unknown IDs; Resend / Unlock open it
//   H  expired temporary password, login switched off, vendor switched off: told to somebody with the right password only
//   I  the link route still works, and afterwards the temporary password says "already chose your own"
//   J  the Admin screen: newest invitation number and "older emails no longer work"
//   K  no password anywhere in the database; the mark is not the password; generator never makes a look-alike / HTML-sensitive character
//   L  the server log stays clean
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const BACK = path.resolve(__dirname, '..');
const REAL = path.resolve(BACK, 'prisma', 'dev.db');
let copy = process.env.COPY_DB;
if (copy && path.resolve(copy).toLowerCase() === REAL.toLowerCase()) { console.error('Refusing: COPY_DB is the real database.'); process.exit(2); }
if (!copy) {
  copy = path.join(os.tmpdir(), `vsi-${Date.now().toString(36)}.db`);
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(REAL, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
if (!fs.existsSync(copy)) { console.error(`Refusing: ${copy} does not exist.`); process.exit(2); }
const PORT = Number(process.env.TEST_PORT || 4075);
if (PORT === 4010 || PORT === 4045 || PORT < 4011 || PORT > 4099) { console.error('Refusing: use a free port 4011-4099 (not 4010 or 4045).'); process.exit(2); }
const API = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const CAPTURE = path.join(os.tmpdir(), `vsi-mail-${RUN}.jsonl`);
const BASE = 'https://app.example.test';
const DB_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.DATABASE_URL = DB_URL;
process.env.TEST_MODE = '1';
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false });
process.env.DATABASE_URL = DB_URL;
process.env.APP_BASE_URL = BASE;
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const bcrypt = require(path.join(BACK, 'node_modules/bcryptjs'));
const prisma = require(path.join(BACK, 'src/db'));
const { resolveIdentity, tokenPayload } = require(path.join(BACK, 'src/utils/identity'));
const MAIL = require(path.join(BACK, 'src/utils/vendorMail'));
const VC = require(path.join(BACK, 'src/utils/vendorConfig'));

let pass = 0; let fail = 0;
const check = (g, n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  [${g}] ${n}${!ok && d != null ? `  -> ${String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 700)}` : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randIp = () => `10.${crypto.randomInt(250)}.${crypto.randomInt(250)}.${crypto.randomInt(250)}`;
const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const ZW = String.fromCodePoint(0x200B); // zero-width space
const ZWNJ = String.fromCodePoint(0x200C);
const BOM = String.fromCodePoint(0xFEFF);
const NBSP = String.fromCodePoint(0xA0);
const LQ = String.fromCodePoint(0x201C);
const RQ = String.fromCodePoint(0x201D);
const PW = (t) => `Qv#7${t}Lm!${RUN}9`;

async function http(method, p, token, body, opt = {}) {
  const h = { 'X-Forwarded-For': opt.ip || randIp(), ...(opt.headers || {}) };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) { h['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body: payload, redirect: 'manual', signal: AbortSignal.timeout(60000) });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body: json, text };
}
const mails = () => (fs.existsSync(CAPTURE) ? fs.readFileSync(CAPTURE, 'utf8').split(LF).filter(Boolean).map((l) => JSON.parse(l)) : []);
const mailsTo = (addr) => mails().filter((m) => m.to.map((x) => x.toLowerCase()).includes(String(addr).toLowerCase()));
const newestTo = (addr) => { const l = mailsTo(addr); return l[l.length - 1]; };
async function waitMails(addr, n, ms = 12000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { if (mailsTo(addr).length >= n) return true; await sleep(150); }
  return mailsTo(addr).length >= n;
}
// What a person sees in the email's HTML, as text: tags gone, line breaks kept, entities decoded.
function htmlToText(html) {
  const body = String(html).replace(/<head[\s\S]*?<\/head>/i, '').replace(/<br\s*\/?>/gi, LF).replace(/<\/(p|div|tr|h\d)>/gi, LF).replace(/<[^>]+>/g, '');
  return body.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;|&apos;/g, "'").replace(/&amp;/g, '&');
}
// "Your login ID: x" and "Temporary password: y" as a person would copy them.
const copyOut = (txt) => {
  const id = /Your login ID:\s*(\S+)/.exec(txt);
  const pw = /Temporary password:\s*(\S+)/.exec(txt);
  return { loginId: id ? id[1] : null, password: pw ? pw[1] : null };
};
const fromText = (m) => copyOut(m.text);
const fromHtml = (m) => copyOut(htmlToText(m.html));
const raw = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p).then((rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'bigint' ? Number(v) : v]))));
async function dbHas(needle, tables) {
  const hits = [];
  for (const t of tables) {
    const cols = (await raw(`PRAGMA table_info("${t}")`)).map((c) => c.name);
    if (!cols.length) continue; // eslint-disable-line no-continue
    const where = cols.map((c) => `instr(CAST("${c}" AS TEXT), ?) > 0`).join(' OR '); // instr: a % in a password is not a wildcard
    // eslint-disable-next-line no-await-in-loop
    const n = (await raw(`SELECT COUNT(*) AS n FROM "${t}" WHERE ${where}`, ...cols.map(() => needle)))[0].n;
    if (n) hits.push(t);
  }
  return hits;
}
const TABLES = ['VendorMailLog', 'VendorLoginToken', 'VendorEmailChange', 'AuditLog', 'AssetAuditLog', 'Notification', 'VendorUser', 'AppSetting', 'MessageTemplate', 'MessageTemplateVersion', 'VendorSession'];

const made = { users: [], vendors: [] };
(async () => {
  let server; let serverLog = '';
  try {
    fs.writeFileSync(CAPTURE, '');
    server = spawn(process.execPath, ['src/index.js'], {
      cwd: BACK, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(PORT), TEST_MAIL_CAPTURE: CAPTURE, APP_BASE_URL: BASE },
    });
    server.stdout.on('data', (d) => { serverLog += d; }); server.stderr.on('data', (d) => { serverLog += d; });
    let healthy = false;
    for (let i = 0; i < 90 && !healthy; i += 1) {
      try { healthy = (await fetch(`${API}/api/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { await sleep(1000); }
    }
    if (!healthy) { console.error('The throw-away server did not start.\n', serverLog.slice(-1500)); process.exit(3); }

    // ------------------------------------------------------------------ fixtures (the copy only)
    const base = { passwordHash: 'x', hrmsRole: 'NONE', accountsRole: 'NONE', hrmsAccess: false, accountsAccess: false, atsAccess: false, status: 'Active' };
    const mkUser = async (tag, extra) => {
      const u = await prisma.user.create({ data: { ...base, name: `ZZTEST VSI ${tag} ${RUN}`, email: `zz-vsi-${tag}-${RUN}@example.test`, username: `zz-vsi-${tag}-${RUN}@example.test`, ...extra } });
      made.users.push(u.id); return u;
    };
    const uAdmin = await mkUser('admin', { role: 'ADMIN', atsRole: 'ADMIN', atsAccess: true, hrmsAccess: true, accountsAccess: true });
    const T = jwt.sign(tokenPayload(await resolveIdentity(uAdmin.id)), process.env.JWT_SECRET, { expiresIn: '2h' });
    const mkVendor = async (tag, category, extra = {}) => {
      const v = await prisma.officeVendor.create({ data: { name: `ZZTEST VSI ${tag} ${RUN}`, companyName: `ZZTEST VSI Company ${tag} ${RUN}`, isActive: true, category, ...extra } });
      made.vendors.push(v.id); return v;
    };
    const VEN = {
      finance: await mkVendor('Finance', 'Internet', { email: `zz-vsi-contact-fin-${RUN}@example.test` }),
      assets: await mkVendor('Assets', 'IT / Hardware / AMC / Service'),
      idcards: await mkVendor('IdCards', 'ID Cards'),
    };
    const addr = (t) => `zz-vsi-${t}-${RUN}@example.test`;
    const emailValues = JSON.stringify({ 'SMTP host': 'smtp.example.test', Port: '587', 'Encryption (SSL / STARTTLS / None)': 'STARTTLS', Username: 'zz', 'From address': 'noreply@teamlink.example.test', 'Default from name': 'TeamLink' });
    await prisma.integration.upsert({ where: { id: 'email' }, update: { enabled: true, connected: true, state: 'Connected', values: emailValues }, create: { id: 'email', enabled: true, connected: true, state: 'Connected', values: emailValues } });
    await prisma.appSetting.upsert({ where: { key: 'vendorPortal.settings' }, update: { value: JSON.stringify({ emailsEnabled: true, supportEmail: 'support@teamlink.example.test', supportPhone: '+91 90000 00000' }) }, create: { key: 'vendorPortal.settings', value: JSON.stringify({ emailsEnabled: true, supportEmail: 'support@teamlink.example.test', supportPhone: '+91 90000 00000' }) } });
    const create = (body) => http('POST', '/api/vendor-logins', T, body);
    const resend = (id) => http('POST', `/api/vendor-logins/${id}/resend-invitation`, T, {});
    const getRow = async (id) => ((await http('GET', '/api/vendor-logins', T)).body.rows || []).find((r) => r.id === id);
    const login = (email, password, opt) => http('POST', '/api/vendor-portal/login', null, { email, password }, opt);
    const vu = (id) => prisma.vendorUser.findUnique({ where: { id } });
    // Create a login for a vendor kind and read the email as a person would. -> { id, email, mail, html, text, pw, loginId }
    async function newLogin(tag, kind) {
      const email = addr(tag);
      const r = await create({ vendorId: VEN[kind].id, name: `ZZTEST Contact ${tag}`, email });
      if (r.status !== 201) throw new Error(`create ${tag}: ${r.status} ${r.text.slice(0, 200)}`);
      await waitMails(email, 1);
      const mail = newestTo(email);
      return { id: r.body.login.id, email, mail, html: fromHtml(mail), text: fromText(mail), reply: r.body };
    }
    async function nextMail(L) {
      const n = mailsTo(L.email).length;
      const r = await resend(L.id);
      if (r.status !== 200) throw new Error(`resend ${L.email}: ${r.status} ${r.text.slice(0, 200)}`);
      await waitMails(L.email, n + 1);
      const mail = newestTo(L.email);
      return { mail, html: fromHtml(mail), text: fromText(mail) };
    }

    // =============================================================== A  the email itself
    const LA = await newLogin('a1', 'finance');
    check('A', 'the email arrives at the LOGIN email and shows a Login ID and a temporary password', !!LA.mail && !!LA.text.loginId && !!LA.text.password, LA.mail && LA.mail.text);
    check('A', 'the plain-text twin and the HTML twin carry the SAME login ID and the SAME password', LA.text.loginId === LA.html.loginId && LA.text.password === LA.html.password && !!LA.html.password, [LA.text, LA.html]);
    check('A', 'the Login ID in the email is exactly the login email stored (and the one the sign-in accepts)', LA.text.loginId === LA.email, LA.text.loginId);
    const pwA = LA.text.password;
    check('A', 'the password is 12 readable characters: no 0 O 1 l I, no space, nothing HTML would change (& < > " \')', pwA.length === 12 && !/[0O1lI\s&<>"']/.test(pwA), pwA);
    const invisible = new RegExp(`[${ZW}${ZWNJ}${BOM}${String.fromCodePoint(0xAD)}${String.fromCodePoint(0x2060)}${NBSP}]`);
    check('A', 'neither twin holds a hidden character (zero-width, soft hyphen, non-breaking space)', !invisible.test(LA.mail.text) && !invisible.test(LA.mail.html), 'found');
    const boxRe = new RegExp(`<span style="([^"]*)">${pwA.replace(/[.*+?^${}()|[\]]/g, m => `\\${m}`)}</span>`);
    const bx = boxRe.exec(LA.mail.html);
    check('A', 'the HTML shows the password in ONE plain monospace box (own element, no letter-spacing, nothing inside it but the password)', !!bx && /monospace/.test(bx[1]) && !/letter-spacing/.test(bx[1]), bx && bx[1]);
    check('A', 'the Login ID sits in its own box too', new RegExp(`<span style="[^"]*monospace[^"]*">${LA.email.replace(/[.*+?^${}()|[\]]/g, m => `\\${m}`)}</span>`).test(LA.mail.html));
    check('A', 'the email says: invitation number, time, "use only the newest email", "older passwords stop working"', /invitation number 1/i.test(LA.mail.text) && /newest email/i.test(LA.mail.text) && /older passwords/i.test(LA.mail.text), LA.mail.text);
    check('A', 'the subject carries the invitation number', /\(invitation #1\)/.test(LA.mail.subject), LA.mail.subject);
    const n1 = await nextMail(LA);
    check('A', 'a second email has a different password AND a different subject (#2) so the newest is obvious', n1.text.password !== pwA && /\(invitation #2\)/.test(n1.mail.subject) && /invitation number 2/i.test(n1.mail.text), [n1.mail.subject]);
    check('A', 'the two twins of the second email agree as well', n1.text.password === n1.html.password && n1.text.loginId === n1.html.loginId);
    const gen = []; for (let i = 0; i < 400; i += 1) gen.push(MAIL.generateTempPassword({ email: 'someone@example.test', name: 'Some One' }));
    check('A', '400 generated passwords: all 12 long, one of each kind, none with a look-alike, space or HTML-sensitive character', gen.every((p) => p.length === 12 && /[A-Z]/.test(p) && /[a-z]/.test(p) && /\d/.test(p) && /[^A-Za-z0-9]/.test(p) && !/[0O1lI\s&<>"'\\]/.test(p)), gen.find((p) => /[0O1lI\s&<>"'\\]/.test(p)));
    check('A', '...and they are different from each other', new Set(gen).size === gen.length);

    // =============================================================== C  the three kinds, exactly as a vendor does it
    const LAND = { finance: '/vendor/dashboard', assets: '/vendor/asset-portal/dashboard', idcards: '/vendor/idcard-portal/dashboard' };
    const OVERVIEW = { finance: '/api/vendor-portal/records/overview', assets: '/api/vendor-portal/asset-portal/overview', idcards: '/api/vendor-portal/idcard-portal/overview' };
    for (const kind of ['finance', 'assets', 'idcards']) {
      const L = await newLogin(`k-${kind}`, kind);
      const copiedHtml = L.html; const copiedText = L.text;
      check('C', `${kind}: the email has the Login ID and the password (HTML copy = text copy)`, !!copiedHtml.password && copiedHtml.password === copiedText.password && copiedHtml.loginId === L.email, [copiedHtml, copiedText]);
      let r = await login(copiedHtml.loginId, copiedHtml.password);
      check('C', `${kind}: sign in with the Login ID + password copied from the HTML email works AT ONCE (account is still "waiting for activation")`, r.status === 200 && !!r.body.token && r.body.vendor.mustChangePassword === true, r.body);
      check('C', `${kind}: ...and lands on the right portal (${LAND[kind]})`, r.body && r.body.landing === LAND[kind], r.body && r.body.landing);
      const tok1 = r.body && r.body.token;
      r = await login(copiedText.loginId, copiedText.password);
      check('C', `${kind}: the same with the credentials copied from the plain-text email`, r.status === 200 && !!r.body.token, r.body);
      r = await http('GET', '/api/vendor-portal/me', tok1);
      check('C', `${kind}: the session works and says "change your password" (nothing else is blocked wrongly as "incorrect")`, r.status === 200 && r.body.mustChangePassword === true && r.body.landing === LAND[kind], r.body);
      const u0 = await vu(L.id);
      check('C', `${kind}: signing in did not activate the login, did not touch the counters, and left the temporary password working`, u0.mustChangePassword === true && !u0.passwordChangedAt && u0.failedLoginAttempts === 0 && !u0.lockedUntil);
      const mine = PW(`n${kind}`);
      r = await http('POST', '/api/vendor-portal/change-password', tok1, { currentPassword: copiedHtml.password, newPassword: mine, confirmPassword: mine });
      check('C', `${kind}: the forced password change accepts the temporary password`, r.status === 200 && r.body.ok === true, r.body);
      r = await login(L.email, mine);
      check('C', `${kind}: sign in with the new password: no more forced change`, r.status === 200 && r.body.vendor.mustChangePassword === false && r.body.landing === LAND[kind], r.body);
      const tok2 = r.body.token;
      r = await http('GET', OVERVIEW[kind], tok2);
      check('C', `${kind}: the portal of its own kind opens (${OVERVIEW[kind].split('/api/vendor-portal')[1]})`, r.status === 200, [r.status, r.text.slice(0, 160)]);
      r = await login(L.email, copiedHtml.password);
      check('C', `${kind}: afterwards the old temporary password says "you already chose your own password" (not a bare "incorrect")`, r.status === 401 && r.body.code === 'ALREADY_ACTIVE' && /already chosen your own password/i.test(r.body.error), r.body);
      r = await login(L.email, mine);
      check('C', `${kind}: ...and was not counted as a wrong try (own password still works)`, r.status === 200);
      Object.assign(VEN[kind], { lastLogin: L });
    }

    // =============================================================== B  noise a person adds when copying / typing
    const LB = await newLogin('b1', 'finance');
    const pwB = LB.text.password;
    const noise = [
      ['a space before and after', ` ${pwB} `],
      ['a line break at the end (copied with the line)', `${pwB}${LF}`],
      ['Windows line break', `${pwB}${CR}${LF}`],
      ['a non-breaking space at the end', `${pwB}${NBSP}`],
      ['a zero-width space inside', `${pwB.slice(0, 5)}${ZW}${pwB.slice(5)}`],
      ['a zero-width non-joiner and a BOM at the start', `${ZWNJ}${BOM}${pwB}`],
      ['curly quotes around it', `${LQ}${pwB}${RQ}`],
      ['straight quotes around it', `"${pwB}"`],
      ['a full stop at the end (sentence copy)', `${pwB}.`],
      ['a space in the middle (wrapped line)', `${pwB.slice(0, 6)} ${pwB.slice(6)}`],
      ['a line break in the middle', `${pwB.slice(0, 6)}${LF}${pwB.slice(6)}`],
    ];
    for (const [label, typed] of noise) {
      const r = await login(LB.email, typed);
      check('B', `password with ${label}: signs in`, r.status === 200 && !!r.body.token, [r.status, r.body && r.body.error]);
    }
    const idNoise = [
      ['CAPITAL letters', LB.email.toUpperCase()],
      ['Mixed capitals', LB.email.replace(/^./, (c) => c.toUpperCase())],
      ['spaces around', `  ${LB.email}  `],
      ['a line break', `${LB.email}${LF}`],
      ['zero-width characters', `${ZW}${LB.email}${ZW}`],
      ['angle brackets (copied from a mail header)', `<${LB.email}>`],
      ['mailto:', `mailto:${LB.email}`],
    ];
    for (const [label, typed] of idNoise) {
      const r = await login(typed, pwB);
      check('B', `login ID with ${label}: signs in`, r.status === 200 && !!r.body.token, [r.status, r.body && r.body.error]);
    }
    let r = await login(LB.email, `${pwB.slice(0, 6)}${pwB.slice(7)}`);
    check('B', 'a genuinely wrong password (one character missing) is still refused', r.status === 401 && r.body.code === 'INVALID', r.body);
    r = await login(LB.email, pwB.toLowerCase() === pwB ? pwB.toUpperCase() : pwB.toLowerCase());
    check('B', 'the password is still case-sensitive', r.status === 401 && r.body.code === 'INVALID', r.body);
    r = await login(LB.email, ' ');
    check('B', 'an empty / blank password is a plain "enter your login ID and password"', r.status === 400, r.body);
    // (only the two real wrong tries above - one missing character, wrong case - count; every noisy-but-right try signed in and cleared the counter)
    check('B', 'noise is not a wrong try: only the two genuinely wrong passwords were counted', (await vu(LB.id)).failedLoginAttempts === 2, (await vu(LB.id)).failedLoginAttempts);
    const phone = await login(LB.email, pwB);
    check('B', 'a correct sign-in clears the counter', phone.status === 200 && (await vu(LB.id)).failedLoginAttempts === 0);
    // a chosen password is stored exactly as typed: noise-tolerance never changes what is saved
    const tokB = phone.body.token;
    const chosenB = `${PW('Bb')}${NBSP}x`; // contains a real non-breaking space: legal, kept
    r = await http('POST', '/api/vendor-portal/change-password', tokB, { currentPassword: ` ${pwB}${LF}`, newPassword: chosenB, confirmPassword: chosenB });
    check('B', 'the forced change accepts the temporary password even pasted with spaces / a line break', r.status === 200, r.body);
    r = await login(LB.email, chosenB);
    check('B', 'a chosen password is stored EXACTLY as typed (it signs in as typed)', r.status === 200, r.body);

    // =============================================================== D  login email vs the vendor's contact email
    const LD = await newLogin('d1', 'finance');
    const contact = VEN.finance.email;
    r = await login(contact, LD.text.password);
    check('D', 'the vendor record\'s CONTACT email is not a login ID: refused like any unknown ID', r.status === 401 && r.body.code === 'INVALID', r.body);
    check('D', 'the invitation went to the LOGIN email, not to the contact email', mailsTo(LD.email).length === 1 && mailsTo(contact).length === 0);
    check('D', 'a try with the contact email touched no login counter', (await vu(LD.id)).failedLoginAttempts === 0);
    const rowD = await getRow(LD.id);
    check('D', 'the Admin list shows the login email AND the contact email separately', rowD.email === LD.email && rowD.vendorContactEmail === contact, [rowD.email, rowD.vendorContactEmail]);
    r = await login(LD.email, LD.text.password);
    check('D', 'with the login email it works', r.status === 200);
    // plus-addressing is a different login ID (never guessed)
    const plus = LD.email.replace('@', '+x@');
    r = await login(plus, LD.text.password);
    check('D', 'a +tag address is a different ID and is not guessed', r.status === 401 && r.body.code === 'INVALID', r.body);

    // =============================================================== E  Resend: older emails
    const LE = await newLogin('e1', 'finance');
    const e1 = LE.text.password;
    const e2 = await nextMail(LE);
    const e3 = await nextMail(LE);
    check('E', 'three emails, three different passwords', new Set([e1, e2.text.password, e3.text.password]).size === 3);
    r = await login(LE.email, e1);
    check('E', 'the password of the FIRST email: "replaced by a newer email", names invitation #1 and the newest #3', r.status === 401 && r.body.code === 'OLD_PASSWORD' && /replaced by a newer email/i.test(r.body.error) && /#1/.test(r.body.error) && /#3/.test(r.body.error) && /NEWEST email/.test(r.body.error), r.body);
    r = await login(LE.email, e2.text.password);
    check('E', 'the password of the SECOND email: the same clear message (#2, newest #3)', r.status === 401 && r.body.code === 'OLD_PASSWORD' && /#2/.test(r.body.error) && /#3/.test(r.body.error), r.body);
    for (let i = 0; i < 8; i += 1) await login(LE.email, e1);
    const uE = await vu(LE.id);
    check('E', 'ten tries with older passwords are NOT wrong tries: counter 0, not locked', uE.failedLoginAttempts === 0 && !uE.lockedUntil, [uE.failedLoginAttempts, uE.lockedUntil]);
    r = await login(LE.email, e3.text.password);
    check('E', 'the NEWEST email\'s password signs in at once (right after all those old tries)', r.status === 200 && r.body.vendor.mustChangePassword === true, r.body);
    r = await login(LE.email, ` ${e1}${LF}`);
    check('E', 'an old password pasted with noise is still recognised as old', r.status === 401 && r.body.code === 'OLD_PASSWORD', r.body);
    r = await login(LE.email, e1.slice(0, -1) + (e1.endsWith('x') ? 'y' : 'x'));
    check('E', 'a password that merely LOOKS like an old one (last character changed) is a plain wrong password', r.status === 401 && r.body.code === 'INVALID', r.body);
    // a stranger who types an old password for an ID that is not the login's: nothing is learned
    r = await login(addr('nobody-e'), e1);
    check('E', 'an old password for an UNKNOWN login ID reveals nothing (generic)', r.status === 401 && r.body.code === 'INVALID', r.body);
    // an older mail from before this fix has no mark: it can only be a generic answer, and it is counted
    await raw('UPDATE "VendorMailLog" SET "credMark" = NULL WHERE "vendorUserId" = ? AND "attemptNo" = 1', LE.id);
    r = await login(LE.email, e1);
    check('E', 'an old email from before this fix (no mark kept) falls back to the generic answer', r.status === 401 && r.body.code === 'INVALID', r.body);
    const rowE = await getRow(LE.id);
    check('E', 'the Admin list says which invitation is the newest and that older ones no longer work (J)', rowE.newestInvitation && rowE.newestInvitation.attemptNo === 3 && /older emails no longer do/i.test(rowE.newestInvitation.note), rowE.newestInvitation);
    check('E', 'the Admin history numbers the emails #1 #2 #3', (await http('GET', `/api/vendor-logins/${LE.id}/emails`, T)).text.includes('"attemptNo":3'));

    // =============================================================== F  Edit email on a waiting login
    const LF1 = await newLogin('f1', 'finance');
    const f1 = LF1.text.password;
    const newAddr = addr('f1-new');
    r = await http('PATCH', `/api/vendor-logins/${LF1.id}`, T, { email: newAddr });
    check('F', 'Admin changes the email of a waiting login: same login, a new invitation goes to the NEW address', r.status === 200 && mailsTo(newAddr).length === 1, r.body);
    await waitMails(newAddr, 1);
    const fMail = newestTo(newAddr);
    const f2 = fromHtml(fMail);
    check('F', 'the new email shows the NEW login ID and a new password, numbered #2', f2.loginId === newAddr && f2.password && f2.password !== f1 && /\(invitation #2\)/.test(fMail.subject), [f2.loginId, fMail.subject]);
    r = await login(LF1.email, f1);
    check('F', 'the OLD login ID + the OLD password: "your login ID was changed", names the new address (shortened), not a bare "incorrect"', r.status === 401 && r.body.code === 'LOGIN_ID_CHANGED' && /login ID was changed/i.test(r.body.error) && /\*/.test(r.body.error), r.body);
    check('F', '...and the full new address is not revealed in that answer', !r.text.includes(newAddr), r.text);
    r = await login(LF1.email, 'Some-Other#9password');
    check('F', 'the OLD login ID with a made-up password: generic (an old ID proves nothing)', r.status === 401 && r.body.code === 'INVALID', r.body);
    r = await login(newAddr, f1);
    check('F', 'the NEW login ID + the OLD password: "replaced by a newer email"', r.status === 401 && r.body.code === 'OLD_PASSWORD', r.body);
    r = await login(newAddr, f2.password);
    check('F', 'the NEW login ID + the NEW password: signs in', r.status === 200 && r.body.vendor.email === newAddr, r.body);
    // wrong tries made against the old address do not follow the login to the new one
    const LF2 = await newLogin('f2', 'finance');
    for (let i = 0; i < 3; i += 1) await login(LF2.email, `Wrong#${i}passWord9`);
    check('F', 'three wrong tries counted before the change', (await vu(LF2.id)).failedLoginAttempts === 3);
    const newAddr2 = addr('f2-new');
    await http('PATCH', `/api/vendor-logins/${LF2.id}`, T, { email: newAddr2 });
    check('F', 'changing the email starts the counters clean', (await vu(LF2.id)).failedLoginAttempts === 0);

    // =============================================================== G  wrong password, unknown ID, the lock
    const LG = await newLogin('g1', 'finance');
    const unknown = addr('g-unknown');
    const wrongOnce = await login(LG.email, 'Totally#Wrong9pass');
    const unkOnce = await login(unknown, 'Totally#Wrong9pass');
    check('G', 'wrong password for a real ID and any password for an unknown ID: the SAME status, words and code', wrongOnce.status === 401 && wrongOnce.status === unkOnce.status && wrongOnce.text === unkOnce.text && wrongOnce.body.code === 'INVALID', [wrongOnce.body, unkOnce.body]);
    check('G', 'the generic answer helps without leaking: tells to check the ID and use the NEWEST email, and says the lock rule', /NEWEST email/.test(wrongOnce.body.hint) && /30 minutes/.test(wrongOnce.body.hint), wrongOnce.body.hint);
    check('G', 'the real login counted ONE wrong try', (await vu(LG.id)).failedLoginAttempts === 1);
    for (let i = 0; i < 3; i += 1) await login(LG.email, `Wrong#${i}passWord9`);
    const fifth = await login(LG.email, 'Wrong#5passWord9');
    check('G', 'the 5th wrong try locks the login and says so, with the minutes', fifth.status === 401 && fifth.body.code === 'LOCKED' && /paused for \d+ more minutes?/.test(fifth.body.error) && fifth.body.minutes >= 29, fifth.body);
    check('G', 'the lock is stored (30 minutes)', !!(await vu(LG.id)).lockedUntil);
    const lockedRight = await login(LG.email, LG.text.password);
    check('G', 'while locked, even the RIGHT password gets the lock message (not "incorrect"), and no session', lockedRight.status === 401 && lockedRight.body.code === 'LOCKED' && !lockedRight.body.token, lockedRight.body);
    const lockedWrong = await login(LG.email, 'Wrong#6passWord9');
    check('G', 'the lock message does not depend on the password typed (right or wrong: same words)', lockedRight.text === lockedWrong.text, [lockedRight.text, lockedWrong.text]);
    // an UNKNOWN id locks the same way after the same number of tries, with the same words
    const ghostId = addr('g-ghost');
    const ghostAnswers = [];
    for (let i = 0; i < 5; i += 1) ghostAnswers.push(await login(ghostId, `Wrong#${i}passWord9`));
    check('G', 'an UNKNOWN login ID: 4 plain refusals, then the same lock message (same words, same status) on the 5th try', ghostAnswers.slice(0, 4).every((x) => x.body.code === 'INVALID') && ghostAnswers[4].body.code === 'LOCKED' && ghostAnswers[4].status === fifth.status && ghostAnswers[4].body.error === fifth.body.error && ghostAnswers[4].body.minutes === fifth.body.minutes, ghostAnswers.map((x) => x.body.code));
    const ghostNext = await login(ghostId, PW('anything'));
    check('G', '...and the unknown ID stays locked whatever is typed (nothing to learn from a lock)', ghostNext.body.code === 'LOCKED' && ghostNext.status === lockedRight.status, ghostNext.body);
    const rowG = await getRow(LG.id);
    check('G', 'the Admin list shows Locked with a hint that Resend invitation opens it', rowG.accountStatus === 'locked' && rowG.locked === true, [rowG.accountStatus]);
    r = await resend(LG.id);
    const newG = await (async () => { await waitMails(LG.email, 2); return fromHtml(newestTo(LG.email)); })();
    check('G', 'Admin presses Resend invitation: the lock and the counter are cleared at once', r.status === 200 && !(await vu(LG.id)).lockedUntil && (await vu(LG.id)).failedLoginAttempts === 0, r.body);
    r = await login(LG.email, newG.password);
    check('G', '...and the newest password signs in', r.status === 200, r.body);
    // Unlock button
    for (let i = 0; i < 5; i += 1) await login(LG.email, `Wrong#${i}passWord9`);
    check('G', 'locked again by five wrong tries', !!(await vu(LG.id)).lockedUntil);
    r = await http('POST', `/api/vendor-logins/${LG.id}/unlock`, T, {});
    r = await login(LG.email, newG.password);
    check('G', 'Admin Unlock works as before', r.status === 200, r.body);
    check('G', 'a lock is audited with the IP (as before)', !!(await prisma.assetAuditLog.findFirst({ where: { vendorUserId: LG.id, action: 'Login locked' } })));
    // the per-device limit says what it is
    const fixedIp = randIp(); let tooMany = null;
    for (let i = 0; i < 12 && !tooMany; i += 1) { const x = await login(addr('g-limit'), 'Nope#Nope9passw', { ip: fixedIp }); if (x.status === 429) tooMany = x; }
    check('G', 'too many tries from one device: 429 with plain words and a code', !!tooMany && tooMany.body.code === 'TOO_MANY' && /15 minutes/.test(tooMany.body.error), tooMany && tooMany.body);

    // =============================================================== H  right password, but the login cannot be used
    const LH = await newLogin('h1', 'finance');
    await prisma.vendorUser.update({ where: { id: LH.id }, data: { tempPasswordExpiresAt: new Date(Date.now() - 60000) } });
    r = await login(LH.email, LH.text.password);
    check('H', 'expired temporary password (right ID, right password): "has expired, ask for a new invitation"', r.status === 401 && r.body.code === 'TEMP_EXPIRED' && /expired/i.test(r.body.error) && /new invitation/i.test(r.body.error), r.body);
    r = await login(LH.email, 'Wrong#Wrong9pass');
    check('H', '...but a wrong password on that same login is still just generic', r.status === 401 && r.body.code === 'INVALID', r.body);
    check('H', 'the expired answer is not a wrong try', (await vu(LH.id)).failedLoginAttempts === 1 /* only the generic one above */);
    const hMail2 = await nextMail(LH);
    r = await login(LH.email, hMail2.text.password);
    check('H', 'Resend makes a fresh temporary password that works at once', r.status === 200, r.body);
    await prisma.vendorUser.update({ where: { id: LH.id }, data: { status: 'Inactive' } });
    r = await login(LH.email, hMail2.text.password);
    check('H', 'login switched off (right password): "This login is switched off"', r.status === 401 && r.body.code === 'SWITCHED_OFF' && /switched off/i.test(r.body.error), r.body);
    r = await login(LH.email, 'Wrong#Wrong9pass');
    check('H', '...a wrong password on a switched-off login stays generic (nothing leaks)', r.status === 401 && r.body.code === 'INVALID', r.body);
    await prisma.vendorUser.update({ where: { id: LH.id }, data: { status: 'Active', failedLoginAttempts: 0, lockedUntil: null } });
    await prisma.officeVendor.update({ where: { id: VEN.finance.id }, data: { isActive: false } });
    r = await login(LH.email, hMail2.text.password);
    check('H', 'vendor switched off (right password): "This vendor account is switched off"', r.status === 401 && r.body.code === 'VENDOR_OFF', r.body);
    await prisma.officeVendor.update({ where: { id: VEN.finance.id }, data: { isActive: true } });
    r = await login(LH.email, hMail2.text.password);
    check('H', 'switched back on: signs in again', r.status === 200, r.body);

    // =============================================================== I  the secure-link route still works
    const LI = await newLogin('i1', 'finance');
    const linkM = /https?:\/\/[^\s"<>]*vendor-login\?invite=([A-Za-z0-9_-]+)/.exec(LI.mail.text);
    check('I', 'the email still carries the secure link', !!linkM);
    const mineI = PW('Link');
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: linkM[1], newPassword: mineI, confirmPassword: mineI });
    check('I', 'the link sets the vendor\'s own password and signs in', r.status === 200 && !!r.body.token, r.body);
    r = await login(LI.email, LI.text.password);
    check('I', 'after the link, the temporary password says "already chose your own password"', r.status === 401 && r.body.code === 'ALREADY_ACTIVE', r.body);
    r = await login(LI.email, mineI);
    check('I', '...and the chosen password signs in', r.status === 200 && r.body.vendor.mustChangePassword === false, r.body);
    // the other way round: temp password first, then the (revoked) link
    const LI2 = await newLogin('i2', 'finance');
    const link2 = /vendor-login\?invite=([A-Za-z0-9_-]+)/.exec(LI2.mail.text)[1];
    const li2 = await login(LI2.email, LI2.text.password);
    const own2 = PW('Tmp');
    await http('POST', '/api/vendor-portal/change-password', li2.body.token, { currentPassword: LI2.text.password, newPassword: own2, confirmPassword: own2 });
    r = await http('POST', '/api/vendor-portal/invite/accept', null, { token: link2, newPassword: PW('Later'), confirmPassword: PW('Later') });
    check('I', 'temporary password used first -> the unused link is dead (as before)', r.status === 400 && r.body.linkProblem === true, r.body);

    // =============================================================== J  Admin screen
    const LJ = await newLogin('j1', 'assets');
    await nextMail(LJ);
    const rowJ = await getRow(LJ.id);
    check('J', 'Admin list: "Newest invitation: #2 ... Only its password and link work; older emails no longer do."', rowJ.newestInvitation && rowJ.newestInvitation.attemptNo === 2 && /Newest invitation: #2/.test(rowJ.newestInvitation.note) && /older emails no longer do/.test(rowJ.newestInvitation.note), rowJ.newestInvitation);
    check('J', 'the newest invitation line names where it went (the login email)', rowJ.newestInvitation.toEmail === LJ.email);
    check('J', 'the last attempt carries its number (for the screen)', rowJ.lastAttempt && rowJ.lastAttempt.attemptNo === 2, rowJ.lastAttempt);
    const tj = await login(LJ.email, newestTo(LJ.email) && fromHtml(newestTo(LJ.email)).password);
    const own = PW('Jj');
    await http('POST', '/api/vendor-portal/change-password', tj.body.token, { currentPassword: fromHtml(newestTo(LJ.email)).password, newPassword: own, confirmPassword: own });
    const rowJ2 = await getRow(LJ.id);
    check('J', 'once the vendor has activated, the "newest invitation" line is gone', rowJ2.activated === true && rowJ2.newestInvitation === null, rowJ2.newestInvitation);

    // =============================================================== K  secrets
    const everyPw = [pwA, n1.text.password, e1, e2.text.password, e3.text.password, f1, f2.password, LA.text.password, ...gen.slice(0, 3)];
    const leaks = [];
    for (const p of everyPw) { const h = await dbHas(p, TABLES); if (h.length) leaks.push([p.slice(0, 2) + '***', h]); }
    check('K', 'no temporary password appears in clear in any table (mail log, tokens, audit, notifications, users, settings, templates, sessions)', leaks.length === 0, leaks);
    const marks = await raw('SELECT "credMark","vendorUserId" FROM "VendorMailLog" WHERE "credMark" IS NOT NULL AND "toEmail" LIKE ?', `%${RUN}%`);
    check('K', 'the kept mark is a 64-character keyed fingerprint, not the password and not a plain sha256 of it', marks.length > 5 && marks.every((m) => /^[0-9a-f]{64}$/.test(m.credMark)) && !marks.some((m) => m.credMark === crypto.createHash('sha256').update(pwA).digest('hex')) && !marks.some((m) => m.credMark === crypto.createHash('sha256').update(`${m.vendorUserId}|${pwA}`).digest('hex')));
    const keys = await raw('PRAGMA table_info("VendorMailLog")');
    check('K', 'the mail log has no body / link / password column', !keys.some((c) => /body|text|html|link|password/i.test(c.name) && c.name !== 'linkExpiresAt'), keys.map((c) => c.name));
    const hashRow = await vu(LA.id);
    check('K', 'the password column is a bcrypt hash of the NEWEST password only (the first email\'s password no longer matches it)', /^\$2[aby]\$/.test(hashRow.passwordHash) && bcrypt.compareSync(n1.text.password, hashRow.passwordHash) && !bcrypt.compareSync(pwA, hashRow.passwordHash));
    const apiSweep = [(await http('GET', '/api/vendor-logins', T)).text, (await http('GET', `/api/vendor-logins/${LA.id}/emails`, T)).text].join(' ');
    check('K', 'no API answer for Admin carries a password', !everyPw.some((p) => apiSweep.includes(p)));
    check('K', 'the sign-in answers never carry the typed password or a hash', !JSON.stringify([wrongOnce.body, fifth.body]).includes('Wrong#') && !/\$2[aby]\$/.test(JSON.stringify([wrongOnce.body, fifth.body])));
    const aud = (await raw('SELECT "action","status","newValue" FROM "AssetAuditLog" WHERE "vendorUserId" IN (?,?,?)', LE.id, LF1.id, LG.id)).map((a) => `${a.action} ${a.status || ''} ${a.newValue || ''}`).join(' | ');
    check('K', 'the vendor event log names the cause (old password / wrong password / locked) and never a password', /old password \(invitation #1, newest is #3\)/.test(aud) && /wrong password/.test(aud) && /locked/.test(aud) && !everyPw.some((p) => aud.includes(p)), aud.slice(0, 300));

    // =============================================================== L  server log
    const bad = serverLog.split(LF).filter((l) => /error|P\d{4}|unhandled|timed out/i.test(l) && !/TEST_MODE|sandbox/i.test(l)).slice(0, 8);
    check('L', 'the throw-away server logged no errors', bad.length === 0, bad);
    check('L', 'the server log holds no temporary password', !everyPw.some((p) => serverLog.includes(p)));
  } catch (err) {
    fail += 1; console.log('FAIL  [crash]', err && err.stack || err);
  } finally {
    // clean up the ZZTEST rows from the COPY (the copy is thrown away anyway)
    try {
      for (const v of made.vendors) {
        const ids = (await prisma.vendorUser.findMany({ where: { vendorId: v }, select: { id: true } })).map((x) => x.id);
        for (const id of ids) {
          await prisma.vendorSession.deleteMany({ where: { vendorUserId: id } }).catch(() => {});
          await prisma.vendorLoginToken.deleteMany({ where: { vendorUserId: id } }).catch(() => {});
          await prisma.$executeRawUnsafe('DELETE FROM "VendorMailLog" WHERE "vendorUserId" = ?', id).catch(() => {});
          await prisma.$executeRawUnsafe('DELETE FROM "VendorEmailChange" WHERE "vendorUserId" = ?', id).catch(() => {});
        }
      }
    } catch { /* the copy is disposable */ }
    if (server) server.kill();
    await prisma.$disconnect().catch(() => {});
    console.log(`\n${pass} passed, ${fail} failed`);
    console.log(`copy database: ${copy} (a throw-away copy; the real database was only read)`);
    process.exit(fail ? 1 : 0);
  }
})();
