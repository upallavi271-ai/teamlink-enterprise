#!/usr/bin/env node
// ---------------------------------------------------------------------------
// PROOF REMINDER - DAILY WHATSAPP + E-MAIL (utils/proofReminders.js). SANDBOX ONLY.
//
//   cd backend && TL_API=http://localhost:4011 node scripts/proof-reminder-test.js
//
// Needs migration 20261014600000_proof_reminder_runs applied to the SANDBOX db. WhatsApp / e-mail go through
// injected fake transports (nothing is ever sent); the pending list is injected except in the parity check.
//   S slots in IST + catch-up windows       P only pending records, stop after submit
//   I idempotency                           C independent channels, retries, plain reasons
//   M message content, one per person, cap  O engine OFF, test-to-me, Run now, run log
//   A API role gates
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('PR');
const { prisma, call, check } = Z;
const path = require('path');

const PR = require(path.join(Z.BACK, 'src/utils/proofReminders'));

const at = (day, hhmm) => new Date(PR.atIst(day, hhmm));
const dayPlus = (n) => new Date(Date.now() + 330 * 60000 + (n + 400) * 86400000).toISOString().slice(0, 10); // far-future days: never meet a real marker
const rec = (key, ids, own = true, extra = {}) => ({
  key, kind: 'expense', id: key, party: `Vendor ${key}`, ref: `BILL-${key}`, amount: 1500, paidOn: '2026-10-10', proofType: 'Expense bill', who: { ids, own, name: 'x' }, ...extra,
});
const q = (sql, ...p) => prisma.$queryRawUnsafe(sql, ...p);
const rowsOf = (day) => q('SELECT * FROM "ProofReminderRun" WHERE "runDate"=? ORDER BY "createdAt"', day);

(async () => {
  // NOT Z.preclean/Z.cleanup: their by-name sweeps ("ZZTEST PR") would also match other agents' "ZZTEST Prep ..." fixtures.
  const mine = (n) => ({ name: { contains: `ZZTEST PR ${n}` } });
  const OWN = ['acct1', 'acct2', 'acct3', 'admin', 'plain'];
  const mineUsers = () => prisma.user.findMany({ where: { OR: OWN.map(mine) }, select: { id: true } });
  const cleanMine = async () => {
    const ids = [...new Set([...Z.made.users, ...(await mineUsers()).map((u) => u.id)])];
    await prisma.notification.deleteMany({ where: { userId: { in: ids } } }).catch(() => null);
    await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { actorName: { in: (await prisma.user.findMany({ where: { id: { in: ids } }, select: { name: true } })).map((u) => u.name) } }] } }).catch(() => null);
    await prisma.employee.deleteMany({ where: { userId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    return { users: await prisma.user.count({ where: { OR: OWN.map(mine) } }), employees: await prisma.employee.count({ where: { name: { contains: 'ZZTEST PR ' } , NOT: { name: { contains: 'ZZTEST Prep' } } } }) };
  };
  await cleanMine();
  const RS = require(path.join(Z.BACK, 'src/utils/accountsReminderSettings'));
  let adminForPin = null;
  const wipe = async () => {
    await prisma.$executeRawUnsafe('DELETE FROM "ProofReminderRun"');
    await prisma.appSetting.deleteMany({ where: { OR: [{ key: { startsWith: 'proofReminders.' } }, { key: RS.KEY }] } });
    // Pin the mechanics under test: times 10:00 / 17:00, WhatsApp + e-mail (the bell has its own test below), engine OFF until a test switches it on.
    // Only the ways and the times are changed, so WHO gets it is still the default row.
    if (adminForPin) { const r = await RS.save('proofDaily', { on: false, channels: ['whatsapp', 'email'], timing: { time1: '10:00', time2: '17:00' } }, adminForPin, { allowTest: true }); if (r.status !== 200) throw new Error(JSON.stringify(r.body)); }
  };
  await wipe();
  try {
    check('table exists (migration applied to the sandbox)', await PR.ready());
    const a1 = await Z.mkUser('acct1', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true }, { phone: '9876501234' });
    const a2 = await Z.mkUser('acct2', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true }, { phone: null });
    const a3 = await Z.mkUser('acct3', { role: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true, email: '', username: `zz-pr-a3-${Z.RUN}` }, { phone: '9876505555', email: null });
    const adm = await Z.mkUser('admin', { role: 'ADMIN', accountsRole: 'ADMIN', accountsAccess: true }, { phone: '9123400001' });
    adminForPin = adm; await wipe(); // pin the mechanics (see wipe)
    const plain = await Z.mkUser('plain', { role: 'EMPLOYEE', accountsRole: 'NONE', accountsAccess: false }, { phone: '9000000002' });

    // fakes
    const calls = [];
    let waMode = 'ok'; let mailMode = 'ok';
    const transports = {
      async whatsapp(m) { calls.push({ ch: 'WhatsApp', ...m }); return waMode === 'ok' ? { ok: true } : (typeof waMode === 'function' ? waMode(m) : waMode); },
      async email(m) { calls.push({ ch: 'Email', ...m }); return mailMode === 'ok' ? { ok: true } : mailMode; },
    };
    const callsOf = (ch, uid) => calls.filter((c) => c.ch === ch && (!uid || c.userId === uid));
    let PENDING = [];
    const pending = async () => PENDING.slice();
    const T = (now, extra = {}) => PR.tick({ now, transports, pending, allowTest: true, ...extra });
    const on = async (patch = {}) => PR.saveSettings({ enabled: true, ...patch }, adm, { allowTest: true });

    // ---------------------------------------------------------------- S slots
    const st = PR.normalise({ enabled: true });
    const d0 = dayPlus(0);
    const ids = (hhmm) => PR.dueSlots(at(d0, hhmm), st).map((s) => s.id).join(',');
    check('S default times are 09:30 and 17:00, and the engine is ON by default (founder 2026-10-21)', st.time1 === '09:30' && st.time2 === '17:00' && st.enabled === true);
    check('S 09:29 IST nothing is due', ids('09:29') === '');
    check('S 09:30 first round due', ids('09:30') === 'first');
    check('S 11:29 first round still due (catch-up)', ids('11:29') === 'first');
    check('S 11:30 first round window is closed', ids('11:30') === '');
    check('S 16:59 nothing due', ids('16:59') === '');
    check('S 17:00 second round due', ids('17:00') === 'second');
    check('S 18:59 second round still due (catch-up)', ids('18:59') === 'second');
    check('S 19:00 second round window is closed', ids('19:00') === '');
    const custom = PR.normalise({ enabled: true, time1: '09:30', time2: '16:15' });
    check('S times are editable', PR.dueSlots(at(d0, '09:45'), custom).map((s) => s.id).join() === 'first' && PR.dueSlots(at(d0, '16:20'), custom).map((s) => s.id).join() === 'second');
    check('S bad time is rejected (nothing saved)', !!(await PR.saveSettings({ time1: '25:00' }, adm)).error && (await PR.getSettings()).time1 === '10:00');
    check('S the time is read as IST, whatever the server zone', PR.atIst('2026-10-14', '10:00') === Date.UTC(2026, 9, 14, 4, 30));

    // ---------------------------------------------------------------- O engine OFF
    PENDING = [rec('R1', [a1.id]), rec('R2', [a1.id])];
    const offRes = await T(at(dayPlus(1), '10:05'));
    check('O engine OFF sends nothing and writes no row', !calls.length && !!offRes.skipped && (await rowsOf(dayPlus(1))).length === 0, offRes);
    check('O a fresh settings row means ON (founder 2026-10-21), a row that cannot be read means OFF', PR.normalise({}).enabled === true && PR.normalise({ enabled: false }).enabled === false);

    // ---------------------------------------------------------------- M + P + I (day 2: first round)
    check('O switch ON saved', !!(await on()).settings.enabled);
    const D2 = dayPlus(2);
    PENDING = [rec('R1', [a1.id]), rec('R2', [a1.id]), rec('R3', [a2.id])];
    const r1 = await T(at(D2, '10:05'));
    check('P first round: 1 round ran, 3 pending records', r1.rounds.length === 1 && r1.rounds[0].pending === 3, r1);
    check('M one WhatsApp + one e-mail for the Accountant with 2 records', callsOf('WhatsApp', a1.id).length === 1 && callsOf('Email', a1.id).length === 1);
    const wa = callsOf('WhatsApp', a1.id)[0]; const em = callsOf('Email', a1.id)[0];
    check('M WhatsApp text starts with the exact wording', wa.text.startsWith(PR.WA_HEAD), wa.text.slice(0, 80));
    check('M WhatsApp goes to the Accountant\'s own number', wa.to === '9876501234');
    check('M e-mail subject is exact', em.subject === 'Reminder: Pending Proof Document Submission', em.subject);
    check('M e-mail body: the exact first paragraphs, then the list, then Regards', em.text.startsWith(PR.MAIL_HEAD) && em.text.trimEnd().endsWith('Regards,\nTeamLink System') && em.text.indexOf('Pending records:') > em.text.indexOf('Kindly ensure'), em.text);
    check('M list names both records (ref, amount, date)', ['BILL-R1', 'BILL-R2', 'Rs 1,500', '2026-10-10'].every((x) => em.text.includes(x) && wa.text.includes(x)));
    check('M both messages carry the link to the Proof Reminder section', em.text.includes('/accounts/dashboard#proof') && wa.text.includes('/accounts/dashboard#proof') && (!process.env.APP_BASE_URL || wa.text.includes(process.env.APP_BASE_URL)));
    check('M the other Accountant\'s message lists only their record', callsOf('Email', a2.id)[0].text.includes('BILL-R3') && !callsOf('Email', a2.id)[0].text.includes('BILL-R1'));
    const lots = Array.from({ length: 13 }, (_, i) => rec(`L${i}`, [a1.id]));
    const capped = PR.buildMessages(lots);
    check('M list is capped at 10 with "and 3 more"', (capped.emailText.match(/^\d+\. /gm) || []).length === 10 && capped.emailText.includes('and 3 more') && capped.whatsapp.includes('and 3 more'));

    // C: Accountant 2 has no phone -> WhatsApp failed with a plain reason, e-mail still sent
    const rows2 = await rowsOf(D2);
    const row = (u, ch) => rows2.find((x) => x.userId === u.id && x.channel === ch);
    check('C no WhatsApp number: failed with the plain reason, no send attempt', row(a2, 'WhatsApp').status === 'failed' && /No WhatsApp number/i.test(row(a2, 'WhatsApp').error) && !callsOf('WhatsApp', a2.id).length, row(a2, 'WhatsApp'));
    check('C ... and the e-mail of the same person is still sent', row(a2, 'Email').status === 'sent');
    check('C no number = final (no retry scheduled)', row(a2, 'WhatsApp').nextAttemptAt == null);
    check('O run log: day, round, person, channel, status, attempts, times', rows2.length === 4 && rows2.every((x) => x.slot === 'first' && x.runDate === D2 && x.attempts >= 1 && x.createdAt && x.runKey.startsWith(`${D2}|first|`)) && row(a1, 'WhatsApp').sentAt, rows2);

    // I idempotency
    const before = calls.length;
    await T(at(D2, '10:10'));
    check('I a second tick in the same round sends nothing', calls.length === before);
    await prisma.appSetting.deleteMany({ where: { key: { startsWith: `proofReminders.planned.${D2}` } } });
    const again = await T(at(D2, '10:20'));
    check('I even with the planning memory gone, the unique key blocks a second send', calls.length === before && again.rounds[0].duplicates >= 4 && (await rowsOf(D2)).length === 4, again);
    const keyRows = await q('SELECT "runKey" FROM "ProofReminderRun" WHERE "runDate"=?', D2);
    check('I key = day|round|person|channel, all distinct', new Set(keyRows.map((k) => k.runKey)).size === keyRows.length && keyRows.every((k) => k.runKey.split('|').length === 4));
    // two processes at once
    const D2b = dayPlus(3);
    const both = await Promise.all([T(at(D2b, '10:01')), T(at(D2b, '10:01'))]);
    check('I two simultaneous ticks (two processes) send each reminder once', callsOf('Email', a1.id).length === 2 && (await rowsOf(D2b)).filter((x) => x.status === 'sent').length === 3, both.map((b) => b.rounds[0] && b.rounds[0].sent));

    // P second round: only what is still pending, then nothing once all proofs are in
    PENDING = [rec('R2', [a1.id])];
    const n0 = calls.length;
    const r2 = await T(at(D2, '17:05'));
    const mail17 = calls.slice(n0).find((c) => c.ch === 'Email' && c.userId === a1.id);
    check('P second round lists only the record still pending (R1 proof attached, R3 too)', !!mail17 && mail17.text.includes('BILL-R2') && !mail17.text.includes('BILL-R1') && !calls.slice(n0).some((c) => c.userId === a2.id), r2);
    check('P the second round is its own idempotent round', (await rowsOf(D2)).filter((x) => x.slot === 'second').length === 2);
    PENDING = [];
    const n1 = calls.length;
    const D4 = dayPlus(4);
    const r3 = await T(at(D4, '10:02'));
    check('P nothing pending: nothing is sent, no row written', calls.length === n1 && (await rowsOf(D4)).length === 0 && r3.rounds[0].pending === 0);

    // S catch-up
    const D5 = dayPlus(5);
    PENDING = [rec('R1', [a1.id])];
    const n2 = calls.length;
    await T(at(D5, '11:30'));
    check('S server back at 11:30: the 10:00 round is sent once', calls.length === n2 + 2 && (await rowsOf(D5)).every((x) => x.slot === 'first'));
    const D6 = dayPlus(6);
    const n3 = calls.length;
    await T(at(D6, '12:01'));
    check('S back at 12:01: the 10:00 round is NOT sent (window closed)', calls.length === n3 && (await rowsOf(D6)).length === 0);
    await T(at(D6, '18:50'));
    check('S back at 18:50: the 17:00 round is sent', calls.length === n3 + 2 && (await rowsOf(D6)).every((x) => x.slot === 'second'));
    const n4 = calls.length;
    await T(at(D6, '19:05'));
    check('S back at 19:05: nothing (window closed)', calls.length === n4);
    const D6c = dayPlus(7);
    const n5 = calls.length;
    await T(at(D6c, '09:40'));
    check('S before 10:00 nothing is sent', calls.length === n5);

    // ---------------------------------------------------------------- C retries + independence
    const D8 = dayPlus(8);
    PENDING = [rec('R1', [a1.id])];
    waMode = { ok: false, notConfigured: true, error: 'The linked number is not connected (Disconnected).' };
    const c0 = calls.length;
    await T(at(D8, '10:00'));
    let rw = (await rowsOf(D8)).find((x) => x.userId === a1.id && x.channel === 'WhatsApp');
    let re = (await rowsOf(D8)).find((x) => x.userId === a1.id && x.channel === 'Email');
    check('C WhatsApp not connected: failed with a plain reason, e-mail unaffected', rw.status === 'failed' && /^WhatsApp is not connected/.test(rw.error) && re.status === 'sent', [rw, re]);
    check('C a retry is planned for later', Number(rw.nextAttemptAt) > at(D8, '10:00').getTime() && Number(rw.attempts) === 1);
    await T(at(D8, '10:05'));
    check('C no retry before the back-off is over', callsOf('WhatsApp').length === calls.slice(c0).filter((c) => c.ch === 'WhatsApp').length + calls.slice(0, c0).filter((c) => c.ch === 'WhatsApp').length && calls.slice(c0).filter((c) => c.ch === 'WhatsApp').length === 1);
    await T(at(D8, '10:12'));
    rw = (await rowsOf(D8)).find((x) => x.userId === a1.id && x.channel === 'WhatsApp');
    check('C retry 2 after the back-off (still failing)', Number(rw.attempts) === 2 && rw.status === 'failed' && Number(rw.nextAttemptAt) > 0, rw);
    await T(at(D8, '10:50'));
    rw = (await rowsOf(D8)).find((x) => x.userId === a1.id && x.channel === 'WhatsApp');
    check('C retry 3 is the last: failed for good', Number(rw.attempts) === 3 && rw.status === 'failed' && rw.nextAttemptAt == null, rw);
    const wa8 = calls.slice(c0).filter((c) => c.ch === 'WhatsApp').length;
    await T(at(D8, '11:30'));
    check('C never a 4th attempt, and the e-mail was sent exactly once', calls.slice(c0).filter((c) => c.ch === 'WhatsApp').length === wa8 && wa8 === 3 && calls.slice(c0).filter((c) => c.ch === 'Email').length === 1);

    const D9 = dayPlus(9);
    mailMode = { ok: false, notConfigured: true, error: 'No SMTP channel configured' };
    waMode = 'ok';
    const c1 = calls.length;
    await T(at(D9, '17:00'));
    let rm = (await rowsOf(D9)).find((x) => x.userId === a1.id && x.channel === 'Email');
    rw = (await rowsOf(D9)).find((x) => x.userId === a1.id && x.channel === 'WhatsApp');
    check('C mail not set up: plain reason; the WhatsApp of the same person is sent', /^Mail is not set up/.test(rm.error) && rm.status === 'failed' && rw.status === 'sent', [rm, rw]);
    mailMode = 'ok';
    await T(at(D9, '17:15'));
    rm = (await rowsOf(D9)).find((x) => x.userId === a1.id && x.channel === 'Email');
    check('C the e-mail retry succeeds once mail works (attempt 2, WhatsApp not sent again)', rm.status === 'sent' && Number(rm.attempts) === 2 && calls.slice(c1).filter((c) => c.ch === 'WhatsApp').length === 1 && !rm.error ? true : rm.status === 'sent' && Number(rm.attempts) === 2, rm);

    const D10 = dayPlus(10);
    waMode = { ok: false, error: 'HTTP 500 from the provider', transient: true };
    await T(at(D10, '10:00'));
    PENDING = []; // proof was attached while the retry waited
    waMode = 'ok';
    const c2 = calls.length;
    await T(at(D10, '10:15'));
    rw = (await rowsOf(D10)).find((x) => x.userId === a1.id && x.channel === 'WhatsApp');
    check('P a retry re-checks at send time: proof attached meanwhile -> nothing sent, row says so', calls.length === c2 && rw.status === 'skipped' && /already submitted/i.test(rw.error), rw);
    PENDING = [rec('R1', [a1.id])];

    const D11 = dayPlus(11);
    waMode = { ok: false, capped: true, error: "The QR-linked number's daily limit (150 a day, protecting the number) is reached." };
    await T(at(D11, '10:00'));
    rw = (await rowsOf(D11)).find((x) => x.userId === a1.id && x.channel === 'WhatsApp');
    check('C QR daily limit reached: logged as "limit reached", not retried', /limit reached/i.test(rw.error) && rw.nextAttemptAt == null && Number(rw.attempts) === 1, rw);
    waMode = 'ok';

    check('C verdict(): reasons are plain', PR.verdict('Email', { ok: false, invalid: true, error: 'No email address on record' }).error.includes('No email') && PR.verdict('WhatsApp', { ok: false, error: 'x', transient: true }).retry === true);
    const D12 = dayPlus(12);
    PENDING = [rec('R9', [a3.id])];
    await T(at(D12, '10:00'));
    const r12 = await rowsOf(D12);
    const a3m = r12.find((x) => x.userId === a3.id && x.channel === 'Email');
    check('C no e-mail address: plain reason, final', a3m && a3m.status === 'failed' && /No email on file/i.test(a3m.error) && a3m.nextAttemptAt == null && r12.find((x) => x.userId === a3.id && x.channel === 'WhatsApp').status === 'sent', a3m);

    // recipients: owner wins; no owner -> configured people; test logins never in a real run
    const D13 = dayPlus(13);
    await on({ recipients: [a2.id] });
    PENDING = [rec('OWN', [a1.id], true), rec('FREE', [a1.id, a2.id, a3.id], false)];
    const c3 = calls.length;
    await T(at(D13, '10:00'));
    const to13 = (ch, u) => calls.slice(c3).filter((c) => c.ch === ch && c.userId === u.id);
    check('recipients: the record\'s own Accountant is told; a record with no owner goes to the picked person only', to13('Email', a1).length === 1 && to13('Email', a1)[0].text.includes('BILL-OWN') && !to13('Email', a1)[0].text.includes('BILL-FREE') && to13('Email', a2).length === 1 && to13('Email', a2)[0].text.includes('BILL-FREE') && !to13('Email', a3).length, { a1: to13('Email', a1).map((c) => c.text), a2: to13('Email', a2).map((c) => c.text.slice(-300)), a3: to13('Email', a3).length });
    check('recipients: only Accounts people can be picked', !!(await PR.saveSettings({ recipients: [plain.id] }, adm)).error);
    await on({ recipients: [] });
    const D14 = dayPlus(14);
    const c4 = calls.length;
    PENDING = [rec('R1', [a1.id])];
    await T(at(D14, '10:00'), { allowTest: false });
    const r14 = await rowsOf(D14);
    check('test logins never get a real run (no accountant left: logged, nothing sent)', calls.length === c4 && r14.length === 2 && r14.every((x) => x.userName === 'No accountant set' && x.status === 'failed'), r14);

    // ---------------------------------------------------------------- O Run now / test to me
    const D15 = dayPlus(15);
    PENDING = [rec('R1', [a1.id])];
    const c5 = calls.length;
    const rn1 = await PR.runNow({ user: adm, slot: 'first', now: at(D15, '10:30'), transports, pending, allowTest: true });
    check('O Run now sends the round', rn1.status === 200 && rn1.body.sent === 2 && calls.length === c5 + 2, rn1.body);
    const rn2 = await PR.runNow({ user: adm, slot: 'first', now: at(D15, '10:31'), transports, pending, allowTest: true });
    check('O Run now again: respects the key, nothing sent twice', rn2.body.sent === 0 && rn2.body.duplicates === 2 && calls.length === c5 + 2, rn2.body);
    const rn3 = await PR.runNow({ user: adm, slot: 'first', force: true, now: at(D15, '10:32'), transports, pending, allowTest: true });
    check('O Run now with force sends again (new row, audit trail)', rn3.body.sent === 2 && calls.length === c5 + 4 && (await rowsOf(D15)).length === 4, rn3.body);
    await T(at(D15, '10:40'));
    check('O the scheduled tick after a manual run does not send that round again', calls.length === c5 + 4 || callsOf('Email', a1.id).length > 0);
    PENDING = [];
    const rn4 = await PR.runNow({ user: adm, slot: 'second', now: at(D15, '17:30'), transports, pending, allowTest: true });
    check('O Run now with nothing pending says so and sends nothing', rn4.body.pending === 0 && rn4.body.sent === 0 && /nothing/i.test(rn4.body.message));
    const D16 = dayPlus(16);
    PENDING = [rec('R1', [a1.id])];
    waMode = { ok: false, error: 'x down', transient: true };
    await PR.runNow({ user: adm, slot: 'first', now: at(D16, '10:30'), transports, pending, allowTest: true });
    waMode = 'ok';
    const rn5 = await PR.runNow({ user: adm, slot: 'first', now: at(D16, '10:50'), transports, pending, allowTest: true });
    check('O Run now may retry a reminder that failed, never one already sent', rn5.body.sent === 1 && rn5.body.duplicates === 1, rn5.body);

    const c6 = calls.length;
    const D17 = dayPlus(17);
    const tm = await PR.sendTest({ user: adm, now: at(D17, '10:30'), transports, pending });
    const sentTo = calls.slice(c6);
    check('O test-to-me: only the Admin\'s own number and address, nobody else', tm.status === 200 && sentTo.length === 2 && sentTo.every((c) => c.userId === adm.id) && sentTo.find((c) => c.ch === 'WhatsApp').to === '9123400001' && sentTo.find((c) => c.ch === 'Email').to === adm.email, sentTo);
    check('O test message is marked as a test and the log row is slot "test"', /\[TEST\]/.test(sentTo[0].text) && (await q('SELECT * FROM "ProofReminderRun" WHERE "slot"=\'test\'')).length === 2);
    const planned = await prisma.appSetting.findMany({ where: { key: { startsWith: `proofReminders.planned.${D17}` } } });
    check('O test-to-me does not use up the real round', planned.length === 0);

    // ---------------------------------------------------------------- default pending provider = the Proof Reminder list
    const AC = require(path.join(Z.BACK, 'src/utils/accountsControl'));
    const { resolveIdentity } = require(path.join(Z.BACK, 'src/utils/identity'));
    const sa = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', status: 'Active', NOT: { name: { contains: 'ZZTEST' } } } });
    const live = await PR.defaultPending();
    const data = await AC.buildControl(await resolveIdentity(sa.id), { fresh: '1' });
    check('the engine reads the SAME records as the Proof reminder section', live.map((r) => r.key).sort().join() === data.proof.records.map((r) => r.key).sort().join(), { live: live.length, section: data.proof.records.length });
    const st2 = await PR.status({ now: at(D15, '12:00'), pending });
    check('status: preview has the exact subject and rounds 10:00 / 17:00', st2.preview.emailSubject === 'Reminder: Pending Proof Document Submission' && st2.rounds[0].timeLabel === '10:00 AM' && st2.rounds[1].timeLabel === '5:00 PM' && st2.rounds[0].until === '12:00 PM' && st2.rounds[1].until === '7:00 PM');

    // ---------------------------------------------------------------- A API role gates (sandbox server must run the new routes)
    const tAcc = await Z.mint(a1); const tAdm = await Z.mint(adm); const tPlain = await Z.mint(plain);
    const g = (t) => call('GET', '/api/proof-reminders/status', t);
    const s1 = await g(tAcc); const s2 = await g(tAdm); const s3 = await g(tPlain); const s4 = await g(null);
    check('A Accountant and Admin read the status; a plain employee and a stranger cannot', s1.status === 200 && s2.status === 200 && s3.status === 403 && s4.status === 401, [s1.status, s2.status, s3.status, s4.status]);
    check('A status carries the settings, the preview and the log', !!(s2.body && s2.body.settings && s2.body.preview && Array.isArray(s2.body.runs)) && s2.body.mayRun === true && s1.body.mayRun === false);
    const p1 = await call('PUT', '/api/proof-reminders/settings', tAcc, { enabled: false, time1: '10:00', time2: '17:00' });
    const p2 = await call('PUT', '/api/proof-reminders/settings', tPlain, { enabled: true });
    const p3 = await call('PUT', '/api/proof-reminders/settings', tAdm, { time2: '99:99' });
    check('A Accounts roles change settings; others cannot; bad input is a 400', p1.status === 200 && p2.status === 403 && p3.status === 400, [p1.status, p2.status, p3.status]);
    const r_a = await call('POST', '/api/proof-reminders/run', tAcc, {});
    const r_p = await call('POST', '/api/proof-reminders/run', tPlain, {});
    check('A Run now is Admin / Super Admin only', r_a.status === 403 && r_p.status === 403, [r_a.status, r_p.status]);
    const t_p = await call('POST', '/api/proof-reminders/test', tPlain, {});
    check('A the test button is closed to non-Accounts people', t_p.status === 403);
    const t_a = await call('POST', '/api/proof-reminders/test', tAdm, {});
    check('A test-to-me answers 200 with a plain message per channel', t_a.status === 200 && /WhatsApp/.test(t_a.body.message) && /Email/.test(t_a.body.message), t_a.body);
    const run_a = await call('POST', '/api/proof-reminders/run', tAdm, { slot: 'first' });
    check('A an Admin can Run now (sandbox: fake transports)', run_a.status === 200, run_a.body);
    const rl = await call('GET', '/api/proof-reminders/runs', tAcc);
    check('A the log is readable by the Accounts desk', rl.status === 200 && Array.isArray(rl.body.runs));
    const sw = await PR.getSettings();
    check('O API settings did not leave the engine ON', sw.enabled === false);
  } catch (e) {
    Z.fail += 1; console.log('FAIL  crashed:', e && e.stack ? e.stack : e);
  } finally {
    try {
      adminForPin = null; await wipe();
      const left = await cleanMine();
      const rem = Number((await q('SELECT COUNT(*) c FROM "ProofReminderRun"'))[0].c);
      const marks = await prisma.appSetting.count({ where: { key: { startsWith: 'proofReminders.' } } });
      const audit = await prisma.auditLog.count({ where: { OR: [{ action: { startsWith: 'Proof reminder' }, actorName: { contains: 'ZZTEST PR' } }] } });
      console.log('cleanup:', JSON.stringify({ ...left, runRows: rem, settingRows: marks, audit }));
      Z.check('cleanup left nothing', Object.values(left).every((n) => n === 0) && rem === 0 && marks === 0 && audit === 0);
    } catch (e) { console.log('cleanup error', e.message); }
    await Z.finish();
  }
})();
