#!/usr/bin/env node
// Creates one ZZTEST login per main role on the SANDBOX for browser smoke tests and writes the 2-hour tokens to a JSON file.
//   TL_API=http://localhost:4011 node scripts/qa/ui-users.js <out.json>
// Remove them again with: node scripts/qa/zz-clean.js
const TLT = require('./tl-target');
if (!TLT.sandbox) throw new Error('sandbox only');
const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const BACK = path.resolve(__dirname, '..', '..');
require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env') });
const prisma = require(path.join(BACK, 'src/db'));
const jwt = require(path.join(BACK, 'node_modules/jsonwebtoken'));
const tag = Date.now().toString(36);
const ROLES = {
  sa: { role: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', accountsAccess: true, accountsRole: 'SUPER_ADMIN' },
  admin: { role: 'ADMIN', atsRole: 'ADMIN', hrmsRole: 'ADMIN', accountsAccess: true, accountsRole: 'ADMIN' },
  bde: { role: 'EMPLOYEE', atsRole: 'BDE', hrmsRole: 'EMPLOYEE', atsDepartment: 'Education', atsScopeDepartments: 'BDE,Education' },
  bdetl: { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', atsDepartment: 'BDE', atsScopeDepartments: 'BDE' },
  tl: { role: 'TL', atsRole: 'TL', hrmsRole: 'TL', atsDepartment: 'Education', atsScopeDepartments: 'Education' },
  rec: { role: 'EMPLOYEE', atsRole: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsDepartment: 'Education', atsScopeDepartments: 'Education' },
  hr: { role: 'HR', atsRole: 'HR', hrmsRole: 'HR', atsDepartment: 'HR', atsScopeDepartments: 'HR' },
  mgr: { role: 'MANAGER', atsRole: 'MANAGER', hrmsRole: 'MANAGER', atsDepartment: 'Education', atsScopeDepartments: 'Education' },
  acct: { role: 'ACCOUNTANT', atsRole: 'NONE', hrmsRole: 'EMPLOYEE', atsAccess: false, accountsAccess: true, accountsRole: 'ACCOUNTANT' },
};
(async () => {
  const out = { tag, users: {}, tokens: {} };
  for (const [k, d] of Object.entries(ROLES)) {
    const u = await prisma.user.create({ data: {
      name: `ZZTEST UI ${k} ${tag}`, email: `zztest.ui.${k}.${tag}@example.test`, passwordHash: `!disabled-${crypto.randomBytes(6).toString('hex')}`,
      status: 'Active', atsAccess: true, hrmsAccess: true, accountsAccess: false, ...d,
    } });
    await prisma.employee.create({ data: { employeeCode: `ZZTUI${tag}${Object.keys(ROLES).indexOf(k)}`.toUpperCase(), name: u.name, email: u.email, userId: u.id, department: d.atsDepartment || 'Education', designation: k, employmentStatus: 'Active' } });
    out.users[k] = u.id; out.tokens[k] = jwt.sign({ id: u.id }, process.env.JWT_SECRET, { expiresIn: '3h' });
  }
  fs.writeFileSync(process.argv[2] || path.join(BACK, 'test-results', 'ui-tokens.json'), JSON.stringify(out));
  console.log('ui users ready:', Object.keys(out.users).join(','));
  await prisma.$disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
