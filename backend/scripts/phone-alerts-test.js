#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PHONE ALERTS (Web Push, 2026-11-17) - COPY DATABASE ONLY, nothing is ever sent to a real phone.
//
//   cd backend
//   node scripts/phone-alerts-test.js      makes its own VACUUM INTO copy of prisma/sandbox.db (or dev.db) in the temp folder
//                                          (opened READ-ONLY), runs the checks in this process with a stand-in for the push service,
//                                          and deletes the copy after
//
// Proves:
//   K  the keys are made once, kept in AppSetting, and the same pair comes back every time
//   S  subscribing: only https addresses with both keys; the same phone moves to whoever signs in on it; one person can only remove their own
//   N  a notification for a person with a phone is pushed (title, short body, the "Open:" line becomes the link); the bell's own rules apply:
//      Email / WhatsApp / SMS log rows, people with no phone, and agreement lines for a TL are NOT pushed
//   B  a burst of notifications to one person is ONE push ("4 new notifications"), and createMany rows are pushed too
//   W  the REAL sending path (web-push library, VAPID keys read back from AppSetting) to a local https stand-in for a phone's push
//      service: right headers, and the encrypted body decrypts (RFC 8291) to exactly the JSON the app worker shows
//   D  a phone that answers 410 is forgotten at once, one that fails is kept until the 5th failure, a success resets the count
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACK = path.resolve(__dirname, '..');
const SRC = [path.join(BACK, 'prisma', 'sandbox.db'), path.join(BACK, 'prisma', 'dev.db')].find((p) => fs.existsSync(p));
if (!SRC) { console.error('no prisma/sandbox.db or prisma/dev.db to copy'); process.exit(2); }
const copy = path.join(os.tmpdir(), `phonealerts-${Date.now().toString(36)}.db`);
{
  const { DatabaseSync } = require('node:sqlite');
  const src = new DatabaseSync(SRC, { readOnly: true });
  src.exec(`VACUUM INTO '${copy.split(path.sep).join('/').replace(/'/g, "''")}'`);
  src.close();
}
process.env.DATABASE_URL = `file:${path.resolve(copy).split(path.sep).join('/')}?socket_timeout=60`;
process.env.TEST_MODE = '1';
process.env.TEAMLINK_SANDBOX = '1';
process.env.PUSH_BATCH_MS = '400';

const prisma = require('../src/db');
const push = require('../src/utils/webPush');

let pass = 0; let fail = 0;
const ok = (cond, name, extra) => { if (cond) { pass += 1; console.log(`  ok   ${name}`); } else { fail += 1; console.log(`  FAIL ${name}${extra ? ` - ${extra}` : ''}`); } };
const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
// after writing notifications: long enough for the lookups, then until every waiting batch has gone out (a busy machine is slower than a quiet one)
const settle = async () => { await wait(2200); while (push._waiting.size) await wait(100); await wait(400); };

const sent = []; // what the stand-in push service received
let behave = () => ({ statusCode: 201 }); // what it answers
const stubSender = async (sub, payload) => {
  sent.push({ endpoint: sub.endpoint, payload });
  const r = behave(sub);
  if (r.statusCode >= 400) throw Object.assign(new Error(`push service said ${r.statusCode}`), { statusCode: r.statusCode });
  return r;
};
push.setSender(stubSender);

const sub = (n) => ({ endpoint: `https://push.example.test/send/${n}`, keys: { p256dh: `p256dh-${n}`, auth: `auth-${n}` } });

async function main() {
  const a = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } });
  const b = await prisma.user.findFirst({ where: { role: 'ADMIN', NOT: { id: a.id } } }) || await prisma.user.findFirst({ where: { NOT: { id: a.id }, role: { notIn: ['TL', 'STL', 'RECRUITER', 'HR'] } } });
  const { blindTo } = require('../src/utils/agreementPrivacy');
  const { resolveIdentity } = require('../src/utils/identity');
  // a login that is blind to agreement lines (a TL / STL / Recruiter / HR in the ATS), judged on its full identity like the bell does
  let tl = null; let blind = false;
  for (const u of await prisma.user.findMany({ where: { role: { in: ['TL', 'STL', 'RECRUITER', 'HR', 'MANAGER'] }, status: 'Active' }, take: 60 })) {
    const id = await resolveIdentity(u.id).catch(() => null);
    if (id && blindTo(id)) { tl = u; blind = true; break; }
    if (!tl) tl = u;
  }
  if (!a || !b || !tl) throw new Error('need a SUPER_ADMIN, another login and a TL in the copy');
  console.log(`  using ${a.role}, ${b.role}, ${tl.role} (agreement-blind: ${blind})`);
  await prisma.pushSubscription.deleteMany({});

  console.log('K  keys');
  const k1 = await push.publicKey();
  const k2 = await push.publicKey();
  ok(typeof k1 === 'string' && k1.length > 60, 'a public key is made', String(k1));
  ok(k1 === k2, 'the same key comes back');
  const row = await prisma.appSetting.findUnique({ where: { key: 'push.vapid' } });
  ok(!!row && JSON.parse(row.value).publicKey === k1, 'the pair is kept in AppSetting');
  const stored = JSON.parse(row.value).privateKey;
  ok(typeof stored === 'string' && stored.length > 20 && (require('../src/utils/secrets').secretsConfigured() ? stored.startsWith('enc:v1:') : true), 'a private key is stored (encrypted when the server has a secret key)');

  console.log('S  subscribing');
  ok((await push.subscribe(a.id, { endpoint: 'http://insecure.test/x', keys: { p256dh: 'p', auth: 'a' } })).ok === false, 'an http address is refused');
  ok((await push.subscribe(a.id, { endpoint: 'https://push.example.test/x', keys: {} })).ok === false, 'missing keys are refused');
  ok((await push.subscribe(a.id, sub(1), 'UA-1')).ok === true, 'a good subscription is saved');
  ok((await push.devicesOf(a.id)) === 1, 'one phone for the first person');
  await push.subscribe(a.id, sub(1), 'UA-1');
  ok((await push.devicesOf(a.id)) === 1, 'the same phone twice is still one');
  await push.subscribe(b.id, sub(1), 'UA-1');
  ok((await push.devicesOf(a.id)) === 0 && (await push.devicesOf(b.id)) === 1, 'the phone moves to whoever signed in on it');
  await push.subscribe(a.id, sub(1), 'UA-1');
  ok((await push.unsubscribe(b.id, sub(1).endpoint)) === 0, 'somebody else cannot remove my phone');
  ok((await push.devicesOf(a.id)) === 1, 'my phone is still there');

  console.log('N  a notification becomes a phone alert');
  sent.length = 0;
  await prisma.notification.create({ data: { userId: a.id, title: 'Leave approved', message: 'Your leave on 20 Nov was approved by HR.\nOpen: /leave?tab=mine', channel: 'In-App' } });
  await settle();
  ok(sent.length === 1, 'one push was sent', String(sent.length));
  const p = sent[0] && sent[0].payload;
  ok(p && p.title === 'Leave approved', 'the title is the notification title');
  ok(p && p.body === 'Your leave on 20 Nov was approved by HR.', 'the body is the text without the Open: line', p && p.body);
  ok(p && p.url === '/leave?tab=mine', 'the Open: line is the link', p && p.url);
  ok(sent[0] && sent[0].endpoint === sub(1).endpoint, 'it went to the person\'s phone');

  sent.length = 0;
  await prisma.notification.create({ data: { userId: a.id, title: 'Announcement: Diwali holiday', message: 'The office is closed on Friday.' } });
  await settle();
  ok(sent.length === 1 && /employee-services\?tab=announcements&open=Diwali%20holiday/.test(sent[0].payload.url), 'an announcement opens the announcement', sent[0] && sent[0].payload.url);

  sent.length = 0;
  await prisma.notification.create({ data: { userId: a.id, title: 'Mail log', message: 'x', channel: 'Email' } });
  await prisma.notification.create({ data: { userId: a.id, title: 'WA log', message: 'x', channel: 'WhatsApp' } });
  await settle();
  ok(sent.length === 0, 'Email / WhatsApp log rows are not pushed', String(sent.length));
  await prisma.notification.create({ data: { userId: b.id, title: 'Someone else', message: 'x' } });
  await settle();
  ok(sent.length === 0, 'a person with no phone gets nothing');

  await push.subscribe(tl.id, sub(2), 'UA-2');
  sent.length = 0;
  await prisma.notification.create({ data: { userId: tl.id, title: 'Agreement signed', message: 'A client agreement was signed.' } });
  await settle();
  if (blind) ok(sent.length === 0, 'an agreement line is NOT pushed to a TL (the bell hides it too)', String(sent.length));
  else console.log('  (this TL is not agreement-blind in this copy: skipped)');
  await prisma.notification.create({ data: { userId: tl.id, title: 'New candidate shared', message: 'A profile is waiting.' } });
  await settle();
  ok(sent.some((s) => s.payload.title === 'New candidate shared'), 'an ordinary line still reaches that TL');

  console.log('B  bursts and createMany');
  sent.length = 0;
  for (let i = 1; i <= 4; i += 1) await prisma.notification.create({ data: { userId: a.id, title: `Burst ${i}`, message: 'x' } });
  await settle();
  ok(sent.length === 1, 'four notifications at once are ONE push', String(sent.length));
  ok(sent[0] && sent[0].payload.title === '4 new notifications' && sent[0].payload.url === '/admin/notifications', 'it says how many and opens the list', sent[0] && sent[0].payload.title);
  sent.length = 0;
  await prisma.notification.createMany({ data: [{ userId: a.id, title: 'Bulk one', message: 'x' }] });
  await settle();
  ok(sent.length === 1 && sent[0].payload.title === 'Bulk one', 'a createMany row is pushed too', String(sent.length));

  console.log('W  the real sending path, to a local stand-in for a phone push service');
  await prisma.pushSubscription.deleteMany({});
  const crypto = require('crypto');
  const https = require('https');
  const { execFileSync } = require('child_process');
  let pems = null;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pa-cert-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    pems = { key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) };
  } catch { /* no openssl on this machine */ }
  if (!pems) { console.log('  (openssl is not available here: section skipped)'); } else {
    // the "phone": a real P-256 key pair and a 16-byte auth secret, like PushManager.subscribe() makes
    const ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const authSecret = crypto.randomBytes(16);
    const b64u = (b) => Buffer.from(b).toString('base64url');
    let got = null;
    const server = https.createServer(pems, (req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { got = { method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) }; res.statusCode = 201; res.end(); });
    });
    await new Promise((r) => { server.listen(0, '127.0.0.1', r); });
    const port = server.address().port;
    const phone = { endpoint: `https://localhost:${port}/push/phone-w`, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(authSecret) } };
    await push.subscribe(a.id, phone, 'UA-W');

    const was = { t: process.env.TEST_MODE, s: process.env.TEAMLINK_SANDBOX, tls: process.env.NODE_TLS_REJECT_UNAUTHORIZED };
    process.env.TEST_MODE = ''; process.env.TEAMLINK_SANDBOX = ''; process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'; // only for this local stand-in
    push.setSender(null);
    const sentPayload = { title: 'Leave approved', body: 'Your leave on 20 Nov was approved.', url: '/leave?tab=mine', tag: 'n-test' };
    const r2 = await push.sendToUser(a.id, sentPayload);
    process.env.TEST_MODE = was.t || ''; process.env.TEAMLINK_SANDBOX = was.s || '';
    if (was.tls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED; else process.env.NODE_TLS_REJECT_UNAUTHORIZED = was.tls;
    server.close();

    ok(r2.sent === 1 && r2.failed === 0, 'the library delivered to the stand-in service', JSON.stringify(r2));
    ok(got && got.method === 'POST' && got.url === '/push/phone-w', 'one POST to the address of that phone', got && got.url);
    const authz = String((got && got.headers.authorization) || '');
    ok(/^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=/.test(authz), 'it is signed with the VAPID keys (Authorization: vapid t=..., k=...)', authz.slice(0, 40));
    ok(authz.includes(`k=${await push.publicKey()}`), 'signed with the public key the browser subscribed to');
    ok(got && got.headers['content-encoding'] === 'aes128gcm' && String(got.headers.ttl) === '86400', 'aes128gcm, kept for a day (TTL 86400)', got && JSON.stringify({ e: got.headers['content-encoding'], ttl: got.headers.ttl }));

    // decrypt like the phone does (RFC 8291, aes128gcm) and compare
    let plain = null;
    try {
      const body = got.body;
      const salt = body.subarray(0, 16); const idlen = body[20]; const asPub = body.subarray(21, 21 + idlen); const data = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPub);
      const keyInfo = Buffer.concat([Buffer.from('WebPush: info\u0000'), ecdh.getPublicKey(), asPub]);
      const ikm = Buffer.from(crypto.hkdfSync('sha256', secret, authSecret, keyInfo, 32));
      const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\u0000'), 16));
      const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\u0000'), 12));
      const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
      d.setAuthTag(data.subarray(data.length - 16));
      const pt = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
      let end = pt.length; while (end > 0 && pt[end - 1] === 0) end -= 1; // strip the padding, then the 0x02 delimiter
      plain = JSON.parse(pt.subarray(0, end - 1).toString('utf8'));
    } catch (e) { plain = { error: e.message }; }
    ok(plain && plain.title === sentPayload.title && plain.body === sentPayload.body && plain.url === sentPayload.url && plain.tag === sentPayload.tag, 'the phone decrypts exactly the alert that was sent', JSON.stringify(plain));
    await prisma.pushSubscription.deleteMany({});
  }
  push.setSender(stubSender); // back to the stand-in for the failure cases below

  console.log('D  dead and failing phones');
  await prisma.pushSubscription.deleteMany({});
  await push.subscribe(a.id, sub(10), 'UA');
  behave = () => ({ statusCode: 410 });
  let r = await push.sendToUser(a.id, { title: 't', body: 'b', url: '/' });
  ok(r.removed === 1 && (await push.devicesOf(a.id)) === 0, 'a 410 removes the phone at once', JSON.stringify(r));
  await push.subscribe(a.id, sub(11), 'UA');
  behave = () => ({ statusCode: 500 });
  r = await push.sendToUser(a.id, { title: 't', body: 'b', url: '/' });
  const f1 = await prisma.pushSubscription.findUnique({ where: { endpoint: sub(11).endpoint } });
  ok(r.failed === 1 && f1 && f1.failCount === 1, 'one failure is counted, the phone stays', JSON.stringify(r));
  behave = () => ({ statusCode: 201 });
  await push.sendToUser(a.id, { title: 't', body: 'b', url: '/' });
  const f2 = await prisma.pushSubscription.findUnique({ where: { endpoint: sub(11).endpoint } });
  ok(f2 && f2.failCount === 0 && !!f2.lastUsedAt, 'a success resets the count');
  behave = () => ({ statusCode: 500 });
  for (let i = 0; i < 5; i += 1) await push.sendToUser(a.id, { title: 't', body: 'b', url: '/' });
  ok((await push.devicesOf(a.id)) === 0, 'the 5th failure in a row drops the phone');
}

main()
  .catch((e) => { fail += 1; console.error('ERROR', e); })
  .finally(async () => {
    await prisma.$disconnect().catch(() => {});
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(copy + ext); } catch { /* gone */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
