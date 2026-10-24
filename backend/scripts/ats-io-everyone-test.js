#!/usr/bin/env node
// ---------------------------------------------------------------------------
// IMPORT / EXPORT / TEMPLATE FOR EVERYBODY (founder, 2026-10-23). SANDBOX ONLY.
//   cd backend && npm run sandbox -- --restart --detach --no-watch && TL_API=http://localhost:4011 node scripts/ats-io-everyone-test.js
// The template (column names + made-up example rows) can be downloaded by every ATS login; what a role may IMPORT / EXPORT is unchanged.
// ---------------------------------------------------------------------------
const Z = require('./lib/zzfix')('IOE');

(async () => {
  try {
    const roles = [
      ['recruiter', { role: 'EMPLOYEE', atsRole: 'RECRUITER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }],
      ['tl', { role: 'TL', atsRole: 'TL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }],
      ['bde', { role: 'EMPLOYEE', atsRole: 'BDE', atsDepartment: 'BDE', atsScopeDepartments: 'BDE,Medical' }],
      ['stl', { role: 'EMPLOYEE', atsRole: 'STL', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }],
      ['asstmgr', { role: 'EMPLOYEE', atsRole: 'ASSISTANT_MANAGER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }],
      ['manager', { role: 'EMPLOYEE', atsRole: 'MANAGER', atsDepartment: 'Medical', atsScopeDepartments: 'Medical' }],
      ['admin', { role: 'ADMIN', atsRole: 'ADMIN' }],
    ];
    const kindsRes = await (async () => { const a = await Z.mkUser('probe', { role: 'ADMIN', atsRole: 'ADMIN' }); const t = await Z.mint(a); return Z.call('GET', '/api/ats-io/access', t); })();
    const kinds = Object.keys((kindsRes.body && kindsRes.body.kinds) || {}).filter((k) => k !== 'resumes');
    Z.check('A0 the server lists the import kinds', kinds.length >= 10, kinds);

    for (const [tag, u] of roles) {
      const user = await Z.mkUser(tag, u, { designation: 'Employee' });
      const tok = await Z.mint(user);
      let ok = 0; const bad = [];
      for (const k of kinds) {
        const r = await Z.call('GET', `/api/ats-io/import/${k}/template`, tok);
        const isXlsx = r.status === 200 && r.buf && r.buf.length > 1000 && r.buf[0] === 0x50 && r.buf[1] === 0x4b; // "PK": a real xlsx (zip)
        if (isXlsx) ok += 1; else bad.push(`${k}:${r.status}`);
      }
      Z.check(`T-${tag} may download the template of every import (${kinds.length})`, ok === kinds.length, bad);
    }

    // what a role may import / export did NOT change
    const rec = await Z.mkUser('rec2', roles[0][1], { designation: 'Employee' });
    const rtok = await Z.mint(rec);
    const acc = (await Z.call('GET', '/api/ats-io/access', rtok)).body;
    Z.check('R1 a recruiter still cannot IMPORT clients (the rule stands)', acc && acc.imports && acc.imports.clients === false, acc && acc.imports);
    Z.check('R2 a recruiter still cannot EXPORT clients', acc && acc.exports && acc.exports.clients === false, acc && acc.exports);
    const chk = await Z.call('POST', '/api/ats-io/import/clients/check', rtok, {});
    Z.check('R3 and a recruiter\'s import attempt for clients is still refused by the server', [401, 403].includes(chk.status), [chk.status, chk.text.slice(0, 120)]);
    // EVERYBODY: every internal role has Import (straight or by approval) and Export on the screens (own scope stays)
    for (const [tag, u] of roles) {
      const x = await Z.mkUser(`all-${tag}`, u, { designation: 'Employee' });
      const ac = (await Z.call('GET', '/api/ats-io/access', await Z.mint(x))).body;
      const modes = ac.importModes || {};
      const noImport = ['requirements', 'clients', 'candidates', 'interviews', 'offers', 'joining', 'followups'].filter((k) => !modes[k]);
      const noExport = ['requirements', 'candidates', 'team', 'interviews', 'feedback', 'offers', 'joining', 'followups', 'dashboard'].filter((m) => !ac.exports[m]);
      Z.check(`E-${tag} can import every main kind, DIRECTLY (no approval)`, tag === 'recruiter' ? noImport.length === 1 && noImport[0] === 'clients' : noImport.length === 0 && Object.values(modes).every((m) => !m || m === 'direct'), [noImport, modes]);
      Z.check(`E-${tag} can export every main screen`, noExport.length === 0, noExport);
    }
    const tl = await Z.mkUser('tl2', roles[1][1], { designation: 'TL' });
    const tacc = (await Z.call('GET', '/api/ats-io/access', await Z.mint(tl))).body;
    Z.check('E1 a TL can export Clients (the screenshot case) and import them directly', tacc.exports.clients === true && tacc.importModes.clients === 'direct', [tacc.exports.clients, tacc.importModes.clients]);
    const asst = await Z.mkUser('asst2', roles[4][1], { designation: 'Employee' });
    const aacc = (await Z.call('GET', '/api/ats-io/access', await Z.mint(asst))).body;
    Z.check('E2 an assistant manager imports directly too', aacc.importModes.candidates === 'direct' && aacc.importModes.clients === 'direct', aacc.importModes);

    // a login with NO ATS product is still refused (the template is not public)
    const acct = await Z.mkUser('acct', { role: 'EMPLOYEE', atsRole: 'NONE', atsAccess: false, accountsRole: 'ACCOUNTANT', accountsAccess: true });
    const ar = await Z.call('GET', `/api/ats-io/import/${kinds[0]}/template`, await Z.mint(acct));
    Z.check('N1 a login without the ATS product still cannot get a template', [401, 403].includes(ar.status), ar.status);
    const anon = await Z.call('GET', `/api/ats-io/import/${kinds[0]}/template`, null);
    Z.check('N2 no login, no template', anon.status === 401, anon.status);
  } catch (e) { Z.fail += 1; console.log('FAIL  crashed', e && e.stack ? e.stack.slice(0, 700) : e); } finally {
    await Z.cleanup().catch((e) => console.log('cleanup problem', String(e.message).slice(0, 160)));
    console.log(`\n${Z.pass} passed, ${Z.fail} failed`);
    await Z.prisma.$disconnect();
    process.exit(Z.fail ? 1 : 0);
  }
})();
