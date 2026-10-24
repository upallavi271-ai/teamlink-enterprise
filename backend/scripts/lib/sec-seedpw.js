// Item 8: forced password change for accounts still on a starting (seed / demo) password.
module.exports = async function secSeedPw({ check, call, mkUser, mint, made, prisma, RUN }) {
  console.log('\n--- 8: starting password gate ---');
  const bcrypt = require('bcryptjs');
  const SEED = 'password123'; // the well-known demo value; used here only to build the ZZTEST account
  const seeded = await mkUser('SeedPw', { passwordChangedAt: null, passwordHash: await bcrypt.hash(SEED, 10) }, { designation: 'Employee' });
  const changed = await mkUser('SeedPwChanged', { passwordHash: await bcrypt.hash(SEED, 10) }, { designation: 'Employee' }); // changed date set by mkUser
  const randomOne = await mkUser('SeedPwRandom', { passwordChangedAt: null, passwordHash: await bcrypt.hash(`Zz-${RUN}-Random-Pass-77!`, 10) }, { designation: 'Employee' });
  const sa = await mkUser('SeedPwSA', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Super Admin' });
  const adm = await mkUser('SeedPwAdmin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Admin' });
  const tS = await mint(seeded.u);

  let r = await call('GET', '/api/employees/me', tS);
  check('a starting-password account is stopped on every API (403 PASSWORD_CHANGE_REQUIRED)', r.status === 403 && r.body && r.body.code === 'PASSWORD_CHANGE_REQUIRED', `${r.status} ${r.text.slice(0, 100)}`);
  r = await call('GET', '/api/dashboard', tS);
  check('...also on the dashboard', r.status === 403 && r.body && r.body.code === 'PASSWORD_CHANGE_REQUIRED', r.status);
  r = await call('GET', '/api/auth/me', tS);
  check('/auth/me still answers and says mustChange = true', r.status === 200 && r.body.passwordStatus && r.body.passwordStatus.mustChange === true, r.text.slice(0, 160));
  check('the answer never contains the starting password', !r.text.includes(SEED));
  r = await call('POST', '/api/auth/login', undefined, { email: seeded.u.email, password: SEED });
  check('signing in with the starting password works but carries mustChange', r.status === 200 && r.body.user.passwordStatus.mustChange === true && !String(r.text).includes(`"${SEED}"`), r.status);
  const tLogin = r.body && r.body.token;
  r = await call('GET', '/api/employees/me', tLogin);
  check('the token from that login is held at the gate too', r.status === 403 && r.body.code === 'PASSWORD_CHANGE_REQUIRED', r.status);

  // other accounts are not touched
  for (const [name, u, mustBlock] of [['changed the password (has a changed date)', changed.u, false], ['random hash, never changed', randomOne.u, false]]) {
    // eslint-disable-next-line no-await-in-loop
    const rr = await call('GET', '/api/employees/me', await mint(u));
    check(`an account that ${name} is NOT stopped`, !(rr.status === 403 && rr.body && rr.body.code === 'PASSWORD_CHANGE_REQUIRED') && !mustBlock, rr.status);
  }
  // wrong current password / weak new password keep the gate
  r = await call('POST', '/api/auth/change-password', tS, { currentPassword: 'wrong-password-1', newPassword: `Zz-${RUN}-New-Pass-88!`, confirmPassword: `Zz-${RUN}-New-Pass-88!` });
  check('a wrong current password is refused', r.status === 400, r.status);
  r = await call('POST', '/api/auth/change-password', tS, { currentPassword: SEED, newPassword: 'password123', confirmPassword: 'password123' });
  check('the same starting password (or any weak one) is refused as the new password', r.status === 400, r.status);
  // banner (Super Admin only, names only)
  r = await call('GET', '/api/admin/users/starting-password', await mint(sa.u));
  check('Super Admin banner lists the account by name (no password, no hash)', r.status === 200 && r.body.count >= 1 && r.body.accounts.some((a) => a.name === seeded.u.name) && !/hash|password"/i.test(JSON.stringify(r.body.accounts)), r.text.slice(0, 160));
  r = await call('GET', '/api/admin/users/starting-password', await mint(adm.u));
  check('Admin does not get the banner list (403)', r.status === 403, r.status);
  // the change flow opens the gate
  const NEWPW = `Zz-${RUN}-New-Pass-88!`;
  r = await call('POST', '/api/auth/change-password', tS, { currentPassword: SEED, newPassword: NEWPW, confirmPassword: NEWPW });
  check('changing the password through the normal flow succeeds', r.status === 200, `${r.status} ${r.text.slice(0, 120)}`);
  const tAfter = r.body && r.body.token ? r.body.token : await mint(seeded.u);
  r = await call('GET', '/api/employees/me', tAfter);
  check('after the change the account is no longer stopped', !(r.status === 403 && r.body && r.body.code === 'PASSWORD_CHANGE_REQUIRED'), r.status);
  r = await call('GET', '/api/auth/me', tAfter);
  check('/auth/me now says mustChange = false', r.status === 200 && r.body.passwordStatus.mustChange === false, r.text.slice(0, 120));
  // seed.js: random password outside test mode, fixed one in test mode
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'prisma', 'seed.js'), 'utf8');
  check('seed.js makes a random one-time password outside test mode and keeps the fixed one only in TEST_MODE', /randomBytes\(9\)/.test(src) && /TEST_MODE \? 'password123'/.test(src) && !/console\.log\('DEMO PASSWORD for every login below: password123'\)/.test(src));
};
