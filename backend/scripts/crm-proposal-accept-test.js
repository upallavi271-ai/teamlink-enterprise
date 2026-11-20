#!/usr/bin/env node
/**
 * THE CUSTOMER ANSWERS A PROPOSAL FROM THE EMAIL (crm/extra.js proposalOfToken / decideByCustomer, routes/crmPublic.js /proposal/:token) - founder 2026-11-16:
 * "mail lo customer ok cheyyaganey, ikkada accepted kindha update avvali" and "customer accept chesaru ani, display meedha pop up avvali".
 * The email carries a signed link; the page only SHOWS the proposal with Accept / Decline (a mail scanner opening it changes nothing); the button (a POST) writes the answer to
 * the proposal, the deal timeline and the owner's pop-up (a 'crm-reply|' note, read by the on-screen toast). SANDBOX ONLY: a private server on a COPY of the sandbox database, port 4060.
 *   TEST_SOURCE_DB=<path to a current-schema sandbox.db> node scripts/crm-proposal-accept-test.js
 */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const BACK = path.resolve(__dirname, '..');
const SOURCE = process.env.TEST_SOURCE_DB || path.join(BACK, 'prisma', 'sandbox.db');
const COPY = path.join(os.tmpdir(), `zz-crm-propaccept-${process.pid}.db`);
const src = new DatabaseSync(SOURCE, { readOnly: true });
src.exec(`VACUUM INTO '${COPY.replace(/'/g, "''")}'`);
src.close();

const PORT = Number(process.env.TEST_PORT) || 4060;
const API = `http://localhost:${PORT}/api`;
const SECRET = 'crm-proposal-accept-test';
const env = { ...process.env, TEAMLINK_SANDBOX: '1', TEST_MODE: '1', PORT: String(PORT), JWT_SECRET: SECRET, APP_BASE_URL: `http://localhost:${PORT}`, DATABASE_URL: `file:${COPY.split(path.sep).join('/')}` };
Object.assign(process.env, env);
const jwt = require('jsonwebtoken');
const prisma = require('../src/db');
const { resolveIdentity, tokenPayload } = require('../src/utils/identity');
const SETTINGS = require('../src/crm/settings');
const DB = require('../src/crm/schema');

let failed = 0; let total = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };
let auth = {};
const call = async (method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', ...auth }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* none */ }
  return { status: r.status, body: j };
};
let server;
async function stop(code) {
  if (server) server.kill();
  await prisma.$disconnect().catch(() => {});
  setTimeout(() => { for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(COPY + s); } catch { /* none */ } } process.exit(code); }, 800);
}
// the same signing the server does (the contract of the link): the body "<proposalId>.<expires>" signed with the server secret
const sign = (body) => crypto.createHmac('sha256', SECRET).update(`crm-proposal-link:${body}`).digest('base64url').slice(0, 24);
const tokenFor = (id, exp) => { const body = `${id}.${exp}`; return `${Buffer.from(body).toString('base64url')}.${sign(body)}`; };
const PUB = `http://localhost:${PORT}/api/crm-public/proposal`;
const answer = (token, decision) => fetch(`${PUB}/${token}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `decision=${decision}` });

(async () => {
  await DB.ensure();
  const adminRow = (await prisma.user.findMany({ where: { status: 'Active', role: 'SUPER_ADMIN' }, take: 5 })).find((u) => !/zztest|example\.test/i.test(`${u.name}${u.email}`));
  await prisma.user.update({ where: { id: adminRow.id }, data: { passwordResetRequired: false, passwordChangedAt: new Date(Date.now() - 86400000) } });
  const admin = await resolveIdentity(adminRow.id);
  await SETTINGS.load({ fresh: true });
  server = spawn(process.execPath, ['src/index.js'], { cwd: BACK, env, stdio: process.env.TEST_DEBUG ? 'inherit' : 'ignore' });
  for (let i = 0; i < 160; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fetch(`${API}/health`).then((r) => r.ok).catch(() => false)) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, 500); });
  }
  await new Promise((r) => { setTimeout(r, 1100); });
  auth = { Authorization: `Bearer ${jwt.sign({ ...tokenPayload(admin), tms: Date.now() }, env.JWT_SECRET, { expiresIn: '1h' })}` };

  const acc = (await call('POST', '/crm/accounts', { name: 'ZZ Prop Accept Co' })).body.account;
  const mk = async (title) => {
    const d = (await call('POST', '/crm/deals', { title, accountId: acc.id, value: '50000', ownerId: adminRow.id })).body.deal;
    const p = (await call('POST', `/crm/deals/${d.id}/proposals`, { roles: [{ title: 'Java developer', openings: 2, ctc: 600000 }], feePercent: 8.33, company: 'ZZ Prop Accept Co', toName: 'Ravi', toEmail: 'ravi@zzaccept-co.com', fromName: 'Vasu' })).body.proposal;
    return { d, p };
  };
  const A = await mk('ZZ Prop A');
  check('a proposal exists (Draft)', A.p && A.p.status === 'Draft', A.p);
  const markSent = async (p) => { const now = new Date().toISOString(); await prisma.$executeRawUnsafe('UPDATE "CrmProposal" SET "status" = \'Sent\', "sentAt" = ?, "sentTo" = ? WHERE "id" = ?', now, 'ravi@zzaccept-co.com', p.id); };
  const exp = Math.floor(Date.now() / 1000) + 3600;

  console.log('1. The page only shows; a mail scanner opening the link changes nothing');
  await markSent(A.p);
  const tA = tokenFor(A.p.id, exp);
  const page = await fetch(`${PUB}/${tA}`);
  const html = await page.text();
  check('the link opens a page with no login: the proposal number, the company, Accept and Decline', page.status === 200 && html.includes(A.p.number) && html.includes('ZZ Prop Accept Co') && /value="accept"/.test(html) && /value="decline"/.test(html), [page.status, html.slice(0, 200)]);
  check('and says not to keep or index it', /no-store/.test(page.headers.get('cache-control') || '') && /noindex/.test(page.headers.get('x-robots-tag') || ''));
  const stillSent = (await prisma.$queryRawUnsafe('SELECT "status" FROM "CrmProposal" WHERE "id" = ?', A.p.id))[0];
  check('just opening the page (as a mail scanner does) does NOT answer the proposal', stillSent.status === 'Sent', stillSent);
  const pdf = await fetch(`${PUB}/${tA}/pdf`);
  const buf = Buffer.from(await pdf.arrayBuffer());
  check('the page links to the PDF, which opens with no login', pdf.status === 200 && buf.slice(0, 4).toString() === '%PDF', [pdf.status, buf.length]);

  console.log('2. The customer presses Accept');
  const acc1 = await answer(tA, 'accept');
  const accHtml = await acc1.text();
  check('a thank-you page says it was accepted', acc1.status === 200 && /accepted/i.test(accHtml), [acc1.status, accHtml.slice(0, 160)]);
  const dealAfter = await call('GET', `/crm/deals/${A.d.id}`);
  const props = await call('GET', `/crm/deals/${A.d.id}/proposals`);
  const row = (props.body.proposals || []).find((x) => x.id === A.p.id);
  const stamp = (await prisma.$queryRawUnsafe('SELECT "decidedAt" FROM "CrmProposal" WHERE "id" = ?', A.p.id))[0];
  check('the proposal now says Accepted, with the time', row && row.status === 'Accepted' && !!stamp.decidedAt, [row, stamp]);
  check('the deal moved on to Negotiation, on its own', dealAfter.body.deal.stage === 'Negotiation', dealAfter.body.deal.stage);
  const line = (dealAfter.body.activities || []).find((a) => /by the customer/.test(a.subject || ''));
  check('the deal timeline says the customer accepted, from the email link, with the address', line && /Accepted by the customer/.test(line.subject) && /email link/.test(line.note || '') && /Address /.test(line.note || ''), line);
  const notes = await prisma.notification.findMany({ where: { userId: adminRow.id, recipient: { startsWith: `crm-reply|${A.d.id}|` } } });
  check('the deal owner gets the POP-UP note (the on-screen toast reads crm-reply notes) with an Open path to the deal', notes.length === 1 && /accepted proposal/.test(notes[0].title) && notes[0].message.includes(`Open: /crm/deals?open=deal:${A.d.id}`) && notes[0].read === false, notes);
  const live = await call('GET', '/crm/reminders/live');
  check('and the toast feed returns it', (live.body.reminders || []).some((x) => /accepted proposal/.test(x.title) && x.message.includes(A.d.id)), live.body);

  console.log('3. A second press, a tampered link, an expired link');
  const again = await answer(tA, 'decline');
  const againHtml = await again.text();
  check('pressing again does not change the answer (it stays Accepted and says so)', again.status === 200 && /already marked/i.test(againHtml) && /Accepted/.test(againHtml), againHtml.slice(0, 200));
  const after2 = (await call('GET', `/crm/deals/${A.d.id}/proposals`)).body.proposals.find((x) => x.id === A.p.id);
  check('the stored answer is still Accepted', after2.status === 'Accepted');
  const [b, sig] = tA.split('.');
  check('a link whose signature is changed does not open or answer', (await fetch(`${PUB}/${b}.${sig.slice(0, -2)}xx`)).status === 404 && (await answer(`${b}.${sig.slice(0, -2)}xx`, 'accept')).status === 404);
  check('a link for another proposal cannot be built from this one', (await fetch(`${PUB}/${Buffer.from(`prop_other.${exp}`).toString('base64url')}.${sig}`)).status === 404);
  check('an expired link does not open or answer', (await fetch(`${PUB}/${tokenFor(A.p.id, Math.floor(Date.now() / 1000) - 10)}`)).status === 404 && (await answer(tokenFor(A.p.id, Math.floor(Date.now() / 1000) - 10), 'accept')).status === 404);
  check('nonsense does not open and does not crash', (await fetch(`${PUB}/abc`)).status === 404 && (await fetch(`${PUB}/.`)).status === 404);

  console.log('4. Decline, and a proposal that was never sent');
  const B = await mk('ZZ Prop B');
  await markSent(B.p);
  const tB = tokenFor(B.p.id, exp);
  const dec = await answer(tB, 'decline');
  check('Decline: a thank-you page says declined', dec.status === 200 && /declined/i.test(await dec.text()));
  const decRow = (await call('GET', `/crm/deals/${B.d.id}/proposals`)).body.proposals.find((x) => x.id === B.p.id);
  const dealB = await call('GET', `/crm/deals/${B.d.id}`);
  check('the proposal says Declined and the deal stage is NOT moved to Negotiation', decRow.status === 'Declined' && dealB.body.deal.stage !== 'Negotiation', [decRow.status, dealB.body.deal.stage]);
  const notesB = await prisma.notification.findMany({ where: { userId: adminRow.id, recipient: { startsWith: `crm-reply|${B.d.id}|` } } });
  check('the owner gets a pop-up for a decline too', notesB.length === 1 && /declined proposal/.test(notesB[0].title), notesB);
  const C = await mk('ZZ Prop C');
  const draft = await answer(tokenFor(C.p.id, exp), 'accept');
  check('a proposal that was never sent cannot be answered', draft.status === 400, draft.status);
  const nothing = await answer(tB, 'maybe');
  check('an answer that is neither Accept nor Decline is refused (already answered, so shown as it is)', nothing.status === 200 || nothing.status === 400);

  console.log(`\n${total - failed}/${total} passed`);
  await stop(failed ? 1 : 0);
})().catch(async (e) => { console.error(e); await stop(1); });
