// ---------------------------------------------------------------------------
// GIVE THE WORKING EMPLOYEES THEIR SIGN-IN DETAILS.
//
// The import created 40 logins with an unguessable password hash and told
// nobody, deliberately. This is the second pass: set a real password for each
// one and mail it to them, so they can sign in and fill in their own profile.
//
//   usage:
//     node scripts/send-credentials.js --url https://hrms.example.com
//     node scripts/send-credentials.js --url https://hrms.example.com --commit
//     node scripts/send-credentials.js --url ... --only TL406,TL410 --commit
//
// --url IS REQUIRED, AND IT IS THE WHOLE POINT.
//
// The mail carries a sign-in link, and a link to the wrong host is worse than
// no mail at all: the reader types credentials that are correct into a site
// that has never heard of them, and concludes the account is broken. That has
// already happened once here — an employee created on this instance was mailed
// a production link, and production has its own database. So the URL is not
// defaulted, not guessed from the environment, and not taken from
// APP_BASE_URL. Whoever runs this has to say where these accounts actually
// live, and gets shown it before anything is sent.
//
// ONE PASSWORD PER PERSON, generated here, never reused, never logged. It goes
// into the mail body and into the database as a bcrypt hash, and nowhere else
// — not to the console, not to the audit trail.
//
// Dry run by default: it prints who would be written to, and one complete
// sample mail, and sends nothing. --commit is the only thing that mails.
// ---------------------------------------------------------------------------

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const prisma = require('../src/db');

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const COMMIT = argv.includes('--commit');
const URL = flag('--url');
const ONLY = (flag('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const WORKING = ['Active', 'Notice Period'];
const pad = (s, n) => String(s ?? '').padEnd(n);

if (!URL) {
  console.error('--url is required: the address these people will actually sign in at.');
  console.error('  e.g.  node scripts/send-credentials.js --url https://hrms.tmlink.in');
  process.exit(1);
}
if (!/^https?:\/\//.test(URL)) {
  console.error(`--url must start with http:// or https:// — got "${URL}"`);
  process.exit(1);
}
if (/localhost|127\.0\.0\.1/.test(URL) && COMMIT) {
  console.error(`Refusing to mail 40 people a ${URL} link — nobody outside this machine can open it.`);
  console.error('Deploy this instance somewhere reachable and pass that address instead.');
  process.exit(1);
}

// appBaseUrl() reads this first, so the mail body carries exactly what was
// passed in rather than whatever the environment happens to hold.
process.env.APP_BASE_URL = URL.replace(/\/+$/, '');
// Required AFTER the env var is set, because employeeInvite reads it at call
// time through appBaseUrl(req).
// eslint-disable-next-line import/order
const { sendCredentials } = require('../src/utils/employeeInvite');

// Typeable on a phone: no l/1/I/0/O, and a shape people can read out loud.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyz';
const DIGITS = '23456789';
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
function newPassword() {
  const pick = (set, n) => Array.from({ length: n }, () => set[crypto.randomInt(0, set.length)]).join('');
  return `${pick(UPPER, 1)}${pick(ALPHABET, 5)}-${pick(DIGITS, 4)}`;
}

(async () => {
  const where = {
    employmentStatus: { in: WORKING },
    userId: { not: null },
    ...(ONLY.length ? { employeeCode: { in: ONLY } } : {}),
  };
  const people = await prisma.employee.findMany({
    where,
    select: {
      id: true, employeeCode: true, name: true, email: true, userId: true,
      designation: true, department: true,
    },
    orderBy: { employeeCode: 'asc' },
  });

  console.log(COMMIT ? '*** COMMIT — mail will be sent ***\n' : '*** DRY RUN — nothing sent ***\n');
  console.log('sign-in URL in the mail : ' + process.env.APP_BASE_URL);
  console.log('recipients              : ' + people.length + '\n');

  const bad = people.filter((p) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(p.email || '')));
  if (bad.length) {
    console.log('THESE ADDRESSES DO NOT LOOK VALID — they are skipped:');
    bad.forEach((p) => console.log('  ' + pad(p.employeeCode, 9) + pad(p.name, 30) + (p.email || '(none)')));
    console.log('');
  }
  const send = people.filter((p) => !bad.includes(p));

  if (!COMMIT) {
    send.forEach((p) => console.log('  ' + pad(p.employeeCode, 9) + pad(p.name.slice(0, 28), 30) + pad(p.email, 34) + p.designation));
    console.log(`\n${send.length} would be mailed from the configured HR address.`);
    console.log('\nSAMPLE OF THE MAIL (password shown here is a throwaway, not stored):');
    console.log('  Subject: Welcome to TeamLink HRMS');
    console.log('  ------------------------------------------------------------');
    console.log(`  Hi ${send[0] ? send[0].name : 'Asha'},`);
    console.log('');
    console.log('  Welcome to TeamLink. Your HRMS account is ready.');
    console.log('');
    console.log(`  Sign in here : ${process.env.APP_BASE_URL}`);
    console.log(`  Email        : ${send[0] ? send[0].email : 'asha@…'}`);
    console.log(`  Password     : ${newPassword()}`);
    console.log('');
    console.log('  Please change this password after you sign in — open My Profile to do it.');
    console.log('  ------------------------------------------------------------');
    console.log('\nDRY RUN — re-run with --commit to send.');
    process.exit(0);
  }

  // ---- send, one at a time, each failure isolated --------------------------
  const results = [];
  for (const p of send) {
    const password = newPassword();
    try {
      // eslint-disable-next-line no-await-in-loop
      await prisma.user.update({
        where: { id: p.userId },
        data: { passwordHash: await bcrypt.hash(password, 10) },
      });
      // eslint-disable-next-line no-await-in-loop
      const out = await sendCredentials({
        employee: p,
        userId: p.userId,
        actingUser: null,
        req: { headers: {} },
        password,
      });
      results.push({ p, ok: out.sent, status: out.status });
    } catch (err) {
      results.push({ p, ok: false, status: String(err.message || err).slice(0, 160) });
    }
    console.log('  ' + pad(results[results.length - 1].ok ? 'sent' : 'FAILED', 8)
      + pad(p.employeeCode, 9) + pad(p.email, 34)
      + (results[results.length - 1].ok ? '' : results[results.length - 1].status));
  }

  const sent = results.filter((r) => r.ok).length;
  console.log(`\n${sent} sent, ${results.length - sent} failed.`);
  if (sent < results.length) {
    console.log('\nFAILED — their passwords WERE changed, so re-run with --only for these:');
    console.log('  --only ' + results.filter((r) => !r.ok).map((r) => r.p.employeeCode).join(','));
  }
  process.exit(0);
})().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
