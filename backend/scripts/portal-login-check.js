#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHY DOES A CANDIDATE GET "INCORRECT EMAIL OR PASSWORD" ON THE JOB PORTAL? (founder 2026-11-10: "candidate portal lo ... gmail tho login
// ayina kani eppudu invalid ani ostundi"). READ ONLY: changes nothing, sends nothing, opens no session, prints no password, hash or token.
//   cd backend && node scripts/portal-login-check.js --find=<part of the email, name or phone>
// The portal answers "Incorrect email or password." for exactly two things (api/src/auth.js login): no account with that email / phone,
// or a wrong password. This shows which one, asked through the RUNNING portal (POST /api/integrations/teamlink/login-check,
// job-portal-app/embed/teamlink-integration.mjs) - the live portal's database takes one connection only, so a second one is refused:
//   * the portal accounts whose email looks like it - the exact spelling saved, role, status, last sign-in, temporary password
//   * the portal candidates whose email / name / phone looks like it, whether they have an account, and the login messages sent
// ---------------------------------------------------------------------------
const path = require('path');

require(path.join(__dirname, '..', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', '.env') });

const arg = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : ''; };
const find = String(arg('find') || '').trim().toLowerCase();
const when = (d) => (d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) : '-');

(async () => {
  if (find.length < 4) { console.log('Give at least 4 letters: --find=<part of the email, name or phone>'); process.exit(2); }
  const { portalFetch } = require('../src/utils/jobPortalBridge'); // eslint-disable-line global-require
  let out;
  try {
    out = await portalFetch('/integrations/teamlink/login-check', { method: 'POST', body: { find }, timeoutMs: 20000 });
  } catch (e) {
    const why = String((e && e.message) || e);
    console.log(/404/.test(why) ? 'The Job Portal has not loaded the new check yet (it restarts by itself after the deploy). Try again in 2 minutes.' : `The Job Portal did not answer: ${why}`);
    process.exit(1);
  }
  const users = out.users || []; const cands = out.candidates || [];
  console.log(`\nPORTAL ACCOUNTS with "${find}" in the email: ${users.length}`);
  users.forEach((u) => {
    console.log(`  "${u.email}"  role=${u.role}  status=${u.status}  made=${when(u.created_at)}  last sign-in=${when(u.last_login_at)}`
      + `  temporary password=${u.must_change_password ? 'yes (never changed)' : 'no'}`);
    // the account row is stamped on every change (a sign-in, a new password, a reset, an admin setting it): later than the last sign-in = changed since
    const after = u.updated_at && u.last_login_at && Date.parse(u.updated_at) - Date.parse(u.last_login_at) > 60000;
    console.log(`      account last changed=${when(u.updated_at)}${after ? '  <- AFTER the last sign-in: the password (or the account) was changed since then' : '  (nothing changed since the last sign-in)'}`);
  });
  console.log(`\nPORTAL CANDIDATES with "${find}" in the email, name or phone: ${cands.length}`);
  cands.forEach((k) => {
    console.log(`  ${k.id}  ${k.name}  email="${k.email}"  phone=${k.phone || '-'}  made=${when(k.created_at)}`
      + `  login=${k.user_id ? `"${k.login_email}" (${k.login_status})` : 'NONE - this candidate has no portal account'}`);
    (k.invites || []).forEach((i) => console.log(`      login message: ${when(i.created_at)} ${i.channel} -> ${i.to_address || '-'}  ${i.status}${i.provider ? ` via ${i.provider}` : ''}${i.error ? `  (${String(i.error).slice(0, 120)})` : ''}`));
    if (!(k.invites || []).length) console.log('      login message: none was ever sent');
  });

  const em = out.email;
  console.log(`\nPORTAL MAILS (Forgot password, logins): ${em ? (em.configured ? `ready - sent through ${em.host} from ${em.from}` : 'NOT SET UP - the portal has no mail account, so no reset mail can leave') : 'unknown'}`);
  try {
    const { LOGFILE } = require('../src/utils/jobPortalEmbed'); // eslint-disable-line global-require
    const fs = require('fs'); // eslint-disable-line global-require
    const size = fs.statSync(LOGFILE).size; const fd = fs.openSync(LOGFILE, 'r');
    const buf = Buffer.alloc(Math.min(size, 3 * 1024 * 1024)); fs.readSync(fd, buf, 0, buf.length, size - buf.length); fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n').filter((l) => /\[auth\]|reset mail|smtp|email:/i.test(l)).slice(-12);
    console.log(`Portal log, mail lines (latest ${lines.length}):`);
    lines.forEach((l) => console.log(`  ${l.slice(0, 220)}`));
    if (!lines.length) console.log('  none: no reset mail failed in the recent log (Forgot password with an email that has no account sends nothing, silently)');
  } catch (e) { console.log(`Portal log not readable here: ${e.message}`); }

  console.log('\nWHAT IT MEANS');
  if (!users.length && !cands.length) console.log('  Nothing in the Job Portal looks like this. There is no account: the candidate has to Register first (or be added and sent a login).');
  if (!users.length && cands.length) console.log('  The candidate exists but has NO portal account, so every sign-in says "Incorrect email or password". Register with this email, or send the login from TeamLink.');
  users.forEach((u) => {
    if (u.status !== 'active') console.log(`  "${u.email}" is ${u.status}: the portal says "not active", not "incorrect".`);
    else if (u.must_change_password) console.log(`  "${u.email}" has an account with a TEMPORARY password that was sent by message (see above) and never used. Use that one, or Forgot password.`);
    else console.log(`  "${u.email}" has an active account: "Incorrect" means the password typed is not this account's password (capital and small letters count). Use Forgot password.`);
  });
  if (users.length && !users.some((u) => String(u.email).toLowerCase().includes('@gmail.com'))) console.log('  None of these is a @gmail.com address: check the spelling saved above (for example gamil / gmial).');
})();
