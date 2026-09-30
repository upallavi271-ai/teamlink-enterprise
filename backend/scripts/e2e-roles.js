// ---------------------------------------------------------------------------
// ROLE-BY-ROLE END-TO-END TEST.
//
// The workflow test proved the SPINE works. It ran entirely as Super Admin, so
// it proved nothing about scope — and scope is most of what this application
// is. This one signs in as every role in turn and asks two questions of each:
//
//   WHAT CAN THEY SEE?   clients, requirements, candidates, applications —
//                        counted against what a Super Admin sees, because
//                        "fewer" is the whole point and "the same" is a bug.
//   WHAT CAN THEY DO?    the stage moves their role owns must succeed, and
//                        the ones it does not own must be refused. A role that
//                        can move a candidate through somebody else's stage
//                        has no workflow at all.
//
// TEST LOGINS ARE CREATED AND DELETED BY THIS SCRIPT. The 40 imported people
// have randomly generated passwords that were mailed and never stored, so they
// cannot be used — and borrowing a real person's account to run a test is not
// something to do to somebody's audit trail anyway.
//
// Everything is prefixed ZZROLE and removed at the end. --keep leaves it.
// ---------------------------------------------------------------------------

const bcrypt = require('bcryptjs');
const prisma = require('../src/db');

const BASE = process.env.TL_API || 'http://127.0.0.1:4010/api';
const ADMIN_EMAIL = process.env.TL_EMAIL || 'admin@teamlink.com';
const ADMIN_PW = process.env.TL_PASSWORD || 'password123';
const KEEP = process.argv.includes('--keep');
const TAG = 'ZZROLE';
const PW = 'RoleTest-2026';

const tick = '✓';
const cross = '✗';

// One login per role. `dept` and `team` decide what the scope engine should
// narrow them to; leaving them null means company-wide.
const ROLES = [
  { role: 'SUPER_ADMIN', dept: null, team: null, expect: 'everything' },
  { role: 'ADMIN', dept: null, team: null, expect: 'everything' },
  { role: 'MANAGER', dept: 'HR', team: null, expect: 'wide, view-only' },
  { role: 'ASSISTANT_MANAGER', dept: 'HR', team: null, expect: 'wide, view-only' },
  { role: 'STL', dept: 'HR', team: null, expect: 'their department' },
  { role: 'TL', dept: 'HR', team: null, expect: 'their team' },
  { role: 'RECRUITER', dept: 'HR', team: null, expect: 'their own work' },
  { role: 'BDE', dept: 'HR', team: null, expect: 'their clients' },
  { role: 'ACCOUNTANT', dept: null, team: null, expect: 'finance' },
  { role: 'HR', dept: 'HR', team: null, expect: 'HRMS only' },
  { role: 'EMPLOYEE', dept: 'HR', team: null, expect: 'own records' },
];

// Which stage each ATS role owns, per utils/permissions.js STAGE_OWNERS. The
// test asserts the engine agrees with this table rather than trusting it.
const OWNED_STAGE = {
  RECRUITER: 'TL_REVIEW', // a recruiter sends TO tl review
  TL: 'WITH_BDE',
  BDE: 'SHARED_WITH_CLIENT',
};
// A stage each role must NOT be able to move into.
const FORBIDDEN_STAGE = {
  RECRUITER: 'SHARED_WITH_CLIENT',
  TL: 'JOINED',
  BDE: 'TL_REVIEW',
  EMPLOYEE: 'TL_REVIEW',
  ACCOUNTANT: 'TL_REVIEW',
  HR: 'TL_REVIEW',
};

async function api(token, method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { raw: text.slice(0, 200) }; }
  return { status: res.status, ok: res.ok, body: payload };
}

const count = (b) => (Array.isArray(b) ? b.length : (Array.isArray(b?.rows) ? b.rows.length : null));
const pad = (s, n) => String(s ?? '').padEnd(n);

(async () => {
  console.log('ROLE-BY-ROLE WORKFLOW TEST\n' + '='.repeat(78));

  // --- create one login per role -------------------------------------------
  const hash = await bcrypt.hash(PW, 10);
  const made = [];
  for (const spec of ROLES) {
    const email = `${TAG}.${spec.role.toLowerCase()}@example.invalid`;
    // eslint-disable-next-line no-await-in-loop
    await prisma.user.deleteMany({ where: { email } });
    // eslint-disable-next-line no-await-in-loop
    const u = await prisma.user.create({
      data: {
        name: `${TAG} ${spec.role}`,
        email,
        username: email,
        passwordHash: hash,
        status: 'Active',
        role: spec.role,
        hrmsRole: spec.role,
        atsRole: spec.role,
        accountsRole: spec.role === 'ACCOUNTANT' ? 'ACCOUNTANT' : null,
        hrmsAccess: true,
        atsAccess: spec.role !== 'ACCOUNTANT',
        accountsAccess: ['ACCOUNTANT', 'SUPER_ADMIN', 'ADMIN'].includes(spec.role),
        atsDepartment: spec.dept,
        atsScopeDepartments: spec.dept,
        atsScopeTeams: spec.team,
      },
    });
    made.push({ ...spec, email, id: u.id });
  }
  console.log(`created ${made.length} test logins\n`);

  // --- the Super Admin baseline --------------------------------------------
  const admin = await api(null, 'POST', '/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW });
  if (!admin.ok) { console.error('cannot sign in as the baseline admin'); await cleanup(); process.exit(1); }
  const adminTok = admin.body.token;
  const base = {};
  for (const [k, path] of Object.entries({ clients: '/clients', requirements: '/requirements', candidates: '/candidates', applications: '/applications' })) {
    // eslint-disable-next-line no-await-in-loop
    base[k] = count((await api(adminTok, 'GET', path)).body);
  }
  console.log('SUPER ADMIN BASELINE (what "everything" means here)');
  console.log('  clients ' + base.clients + '   requirements ' + base.requirements
    + '   candidates ' + base.candidates + '   applications ' + base.applications + '\n');

  // --- visibility ----------------------------------------------------------
  console.log('WHAT EACH ROLE SEES');
  console.log('  ' + pad('ROLE', 20) + pad('CLIENTS', 10) + pad('REQS', 10) + pad('CANDS', 10) + pad('APPS', 10) + 'PRODUCTS');
  const findings = [];
  const tokens = {};
  for (const m of made) {
    // eslint-disable-next-line no-await-in-loop
    const login = await api(null, 'POST', '/auth/login', { email: m.email, password: PW });
    if (!login.ok) {
      console.log('  ' + pad(m.role, 20) + 'LOGIN FAILED  ' + JSON.stringify(login.body).slice(0, 80));
      findings.push({ role: m.role, issue: 'cannot sign in' });
      continue;
    }
    tokens[m.role] = login.body.token;
    const seen = {};
    for (const [k, path] of Object.entries({ clients: '/clients', requirements: '/requirements', candidates: '/candidates', applications: '/applications' })) {
      // eslint-disable-next-line no-await-in-loop
      const r = await api(login.body.token, 'GET', path);
      seen[k] = r.status === 403 ? 'denied' : count(r.body);
    }
    const p = login.body.user?.products || {};
    console.log('  ' + pad(m.role, 20) + pad(seen.clients, 10) + pad(seen.requirements, 10)
      + pad(seen.candidates, 10) + pad(seen.applications, 10)
      + Object.entries(p).filter(([, v]) => v).map(([k]) => k).join('+'));

    // A non-admin role seeing the FULL company set is the bug this is for.
    if (!['SUPER_ADMIN', 'ADMIN'].includes(m.role)) {
      const wide = ['clients', 'requirements', 'candidates', 'applications']
        .filter((k) => typeof seen[k] === 'number' && base[k] > 0 && seen[k] === base[k]);
      if (wide.length) findings.push({ role: m.role, issue: `sees ALL ${wide.join(', ')} — same as Super Admin` });
    }
  }

  // --- stage ownership -----------------------------------------------------
  console.log('\nSTAGE OWNERSHIP  (may this role move a candidate into this stage?)');
  console.log('  ' + pad('ROLE', 20) + pad('OWNS', 24) + pad('RESULT', 12) + pad('MUST NOT', 22) + 'RESULT');
  for (const m of made) {
    const tok = tokens[m.role];
    if (!tok) continue;
    const owns = OWNED_STAGE[m.role];
    const forbidden = FORBIDDEN_STAGE[m.role];
    if (!owns && !forbidden) continue;

    // The engine's own answer, no pipeline mutation needed.
    // eslint-disable-next-line no-await-in-loop
    const me = await api(tok, 'GET', '/auth/me');
    const allowed = me.body?.workflow?.allowedStages || [];
    const ownsOk = owns ? allowed.includes(owns) : null;
    const forbidOk = forbidden ? !allowed.includes(forbidden) : null;

    console.log('  ' + pad(m.role, 20) + pad(owns || '—', 24) + pad(owns ? (ownsOk ? tick + ' allowed' : cross + ' DENIED') : '', 12)
      + pad(forbidden || '—', 22) + (forbidden ? (forbidOk ? tick + ' refused' : cross + ' ALLOWED') : ''));

    if (owns && !ownsOk) findings.push({ role: m.role, issue: `cannot move into ${owns}, which it owns` });
    if (forbidden && !forbidOk) findings.push({ role: m.role, issue: `CAN move into ${forbidden}, which it must not` });
  }

  // --- administration ------------------------------------------------------
  console.log('\nADMINISTRATION  (only Super Admin and Admin may reach these)');
  console.log('  ' + pad('ROLE', 20) + pad('/admin/users', 16) + pad('/employees', 14) + '/admin/roles');
  for (const m of made) {
    const tok = tokens[m.role];
    if (!tok) continue;
    // eslint-disable-next-line no-await-in-loop
    const users = await api(tok, 'GET', '/admin/users');
    // eslint-disable-next-line no-await-in-loop
    const emps = await api(tok, 'GET', '/employees');
    // eslint-disable-next-line no-await-in-loop
    const roles = await api(tok, 'GET', '/admin/roles');
    const f = (r) => (r.status === 403 ? 'denied' : (r.ok ? `${count(r.body) ?? 'ok'}` : r.status));
    console.log('  ' + pad(m.role, 20) + pad(f(users), 16) + pad(f(emps), 14) + f(roles));
    if (!['SUPER_ADMIN', 'ADMIN'].includes(m.role) && users.ok) {
      findings.push({ role: m.role, issue: 'can read /admin/users' });
    }
  }

  // --- verdict -------------------------------------------------------------
  console.log('\n' + '='.repeat(78));
  if (!findings.length) {
    console.log('NO SCOPE OR OWNERSHIP PROBLEMS FOUND.');
  } else {
    console.log(`${findings.length} FINDING(S):`);
    findings.forEach((f) => console.log(`  ${cross} ${pad(f.role, 20)} ${f.issue}`));
  }

  await cleanup();
  process.exit(findings.length ? 1 : 0);
})().catch(async (e) => { console.error('\nHARNESS ERROR:', e.message); await cleanup(); process.exit(1); });

async function cleanup() {
  if (KEEP) { console.log('\n--keep: test logins left in place.'); return; }
  try {
    const gone = await prisma.user.deleteMany({ where: { email: { startsWith: TAG.toLowerCase() } } });
    const gone2 = await prisma.user.deleteMany({ where: { name: { startsWith: TAG } } });
    console.log(`\ncleaned up ${gone.count + gone2.count} test login(s).`);
  } catch (err) {
    console.log('\ncleanup failed: ' + String(err.message).slice(0, 140));
  }
}
