// Items 3 + 4: employee field visibility by role, per-record sheet, payslip reach.
module.exports = async function secFields({ check, call, mkUser, mint, prisma, API }) {
  console.log('\n--- 3: sensitive employee fields / 4: payslips ---');
  const S = {
    bank: '9988776655443322', ifsc: 'HDFC0ZZ77001', pan: 'ABCDE1234F', aadhaar: '7788', uan: '100200300400', pf: 'PF/ZZ/0099887', esi: '31001234560000999',
    line: 'ZZSentinel Street 77', emerg: 'ZZSentinelEmergency', emergPhone: '9000011122', dob: '1990-05-17', ctc: 987654,
  };
  const tgt = await mkUser('FTarget', {}, {
    designation: 'Employee', department: 'Educational', team: 'ZZTeamF', tl: 'ZZTEST Sec FTL', stl: 'ZZTEST Sec FSTL', dateOfBirth: new Date(`${S.dob}T00:00:00Z`),
    bankName: 'ZZBank', bankAccountNumber: S.bank, ifscCode: S.ifsc, panNumber: S.pan, aadhaarLast4: S.aadhaar, uanNumber: S.uan, pfNumber: S.pf, esiNumber: S.esi,
    addressLine1: S.line, address: S.line, city: 'Hyderabad', postalCode: '500099', emergencyContactName: S.emerg, emergencyContactPhone: S.emergPhone,
  });
  await prisma.salaryStructure.create({ data: { employeeId: tgt.emp.id, ctc: S.ctc, basic: 1000, hra: 400 } });
  const slip = await prisma.payslip.create({ data: { employeeId: tgt.emp.id, month: '2026-09', basic: 1000, hra: 400, allowances: 1, deductions: 1, netPay: 1400 } });
  const other = await mkUser('FOther', {}, { designation: 'Employee', department: 'Educational', team: 'ZZTeamF', bankAccountNumber: '1122334455667788' });
  const otherSlip = await prisma.payslip.create({ data: { employeeId: other.emp.id, month: '2026-09', basic: 5, hra: 5, allowances: 1, deductions: 1, netPay: 9 } });

  const L = {
    sa: await mkUser('FSA', { role: 'SUPER_ADMIN', hrmsRole: 'SUPER_ADMIN', atsRole: 'SUPER_ADMIN', accountsRole: 'SUPER_ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Super Admin' }),
    adm: await mkUser('FAdmin', { role: 'ADMIN', hrmsRole: 'ADMIN', atsRole: 'ADMIN', accountsRole: 'ADMIN', atsAccess: true, accountsAccess: true }, { designation: 'Admin' }),
    hr: await mkUser('FHR', { role: 'HR', hrmsRole: 'HR' }, { designation: 'HR' }),
    mgr: await mkUser('FMgr', { role: 'MANAGER', hrmsRole: 'MANAGER', atsRole: 'MANAGER', atsAccess: true }, { designation: 'Manager' }),
    am: await mkUser('FAM', { role: 'ASSISTANT_MANAGER', hrmsRole: 'ASSISTANT_MANAGER', atsRole: 'ASSISTANT_MANAGER', atsAccess: true }, { designation: 'Assistant Manager' }),
    stl: await mkUser('FSTL', { role: 'STL', hrmsRole: 'STL', atsRole: 'STL', atsAccess: true, atsDepartment: 'Educational', atsScopeDepartments: 'Educational' }, { designation: 'STL' }),
    tl: await mkUser('FTL', { role: 'TL', hrmsRole: 'TL', atsRole: 'TL', atsAccess: true, atsDepartment: 'Educational', atsScopeDepartments: 'Educational', atsScopeTeams: 'ZZTeamF', team: 'ZZTeamF' }, { designation: 'TL', team: 'ZZTeamF' }),
    rec: await mkUser('FRec', { role: 'RECRUITER', hrmsRole: 'EMPLOYEE', atsRole: 'RECRUITER', atsAccess: true, atsDepartment: 'Educational' }, { designation: 'Recruiter' }),
    acc: await mkUser('FAcc', { role: 'ACCOUNTANT', hrmsRole: 'EMPLOYEE', accountsRole: 'ACCOUNTANT', accountsAccess: true }, { designation: 'Accountant' }),
  };
  const T = {};
  for (const [k, v] of Object.entries(L)) T[k] = await mint(v.u);
  const Tself = await mint(tgt.u);
  const has = (r, s) => String(r.text || '').includes(s);
  const leaked = (r) => [S.bank, S.pan, S.uan, S.pf, S.esi, S.line, S.emerg, S.emergPhone, S.dob, String(S.ctc)].filter((s) => has(r, s));
  async function rawGet(p, token) {
    const r = await globalThis.__realFetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: r.status, buf: Buffer.from(await r.arrayBuffer()) };
  }

  const detail = `/api/employees/${tgt.emp.id}`;
  for (const who of ['sa', 'adm', 'hr']) {
    const r = await call('GET', detail, T[who]);
    check(`${who}: detail shows full bank / PAN / address`, r.status === 200 && has(r, S.bank) && has(r, S.pan) && has(r, S.line), r.status);
  }
  const rs = await call('GET', detail, Tself);
  check('employee sees full values on their OWN record', rs.status === 200 && has(rs, S.bank) && has(rs, S.pan), rs.status);
  const rm = await call('GET', '/api/employees/me', Tself);
  check('/employees/me (own) shows full values', rm.status === 200 && has(rm, S.pan), rm.status);

  for (const who of ['mgr', 'am', 'stl', 'tl']) {
    const d = await call('GET', detail, T[who]);
    if (d.status !== 200) {
      check(`${who}: detail refused only by scope (${d.status})`, d.status === 403 && who !== 'mgr', d.status);
    } else {
      check(`${who}: detail has no full bank / PAN / UAN / PF / ESI / address / emergency / DOB year / CTC`, leaked(d).length === 0, leaked(d));
      check(`${who}: detail shows XXXX3322, DOB day+month and the city`, has(d, 'XXXX3322') && has(d, '17 May') && has(d, 'Hyderabad'), d.text.slice(0, 150));
      check(`${who}: salary structure removed`, !d.body.salaryStructure, d.body.salaryStructure);
    }
    const l = await call('GET', '/api/employees', T[who]);
    check(`${who}: list has no full values`, l.status !== 200 || leaked(l).length === 0, leaked(l));
    const m = await call('GET', `/api/employees/management/${tgt.emp.id}`, T[who]);
    check(`${who}: management detail has no full values`, m.status !== 200 || leaked(m).length === 0, leaked(m));
  }
  const XLSX = require('xlsx');
  for (const who of ['sa', 'hr', 'mgr', 'am', 'tl']) {
    const r = await rawGet(`/api/employees/${tgt.emp.id}/export.xlsx`, T[who]);
    if (r.status !== 200) { check(`${who}: per-record sheet refused (${r.status})`, !['sa', 'hr'].includes(who)); continue; }
    const wb = XLSX.read(r.buf, { type: 'buffer' });
    const dump = JSON.stringify(wb.SheetNames.map((n) => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 })));
    if (['sa', 'hr'].includes(who)) check(`${who}: per-record sheet carries the full bank number`, dump.includes(S.bank));
    else check(`${who}: per-record sheet has no full bank / PAN / UAN / address / emergency / DOB year`, [S.bank, S.pan, S.uan, S.line, S.emerg, S.dob].every((s) => !dump.includes(s)), dump.slice(0, 200));
  }
  for (const who of ['rec', 'acc']) {
    const d = await call('GET', detail, T[who]);
    check(`${who}: employee detail refused or clean`, d.status === 403 || leaked(d).length === 0, d.status);
    const l = await call('GET', '/api/employees', T[who]);
    check(`${who}: employee list refused or clean`, l.status === 403 || leaked(l).length === 0, l.status);
  }
  const ge = await call('POST', '/api/employees/export/global', T.mgr, { fields: ['employeeCode', 'name', 'bankAccountNumber', 'panNumber'], format: 'csv', filters: {} });
  check('mgr: global export cannot take bank / PAN', ge.status === 403 || !has(ge, S.bank), ge.status);
  const gh = await call('POST', '/api/employees/export/global', T.hr, { fields: ['employeeCode', 'name', 'bankAccountNumber', 'panNumber'], format: 'csv', filters: { q: tgt.emp.employeeCode } });
  check('hr: global export may take bank / PAN', gh.status === 200 && has(gh, S.pan), gh.status);

  // ---- 4: payslips
  const own = await call('GET', '/api/payroll', Tself);
  check('employee reads own payslip list (1 row)', own.status === 200 && Array.isArray(own.body) && own.body.length === 1 && own.body[0].id === slip.id, own.status);
  for (const who of ['mgr', 'am', 'stl', 'tl', 'rec']) {
    const r = await call('GET', '/api/payroll', T[who]);
    const rows = Array.isArray(r.body) ? r.body : [];
    check(`${who}: GET /payroll shows nobody else's payslip`, r.status === 200 ? !rows.some((x) => [slip.id, otherSlip.id].includes(x.id)) : r.status === 403, `${r.status} ${rows.length}`);
    const one = await call('GET', `/api/payroll/payslips/${slip.id}`, T[who]);
    check(`${who}: another employee's payslip refused`, one.status === 403, one.status);
    const pdf = await call('GET', `/api/payroll/payslips/${slip.id}/pdf`, T[who]);
    check(`${who}: another employee's payslip PDF refused`, pdf.status === 403, pdf.status);
    for (const p of ['/api/payroll/structure', '/api/payroll/runs', '/api/payroll/reports', `/api/payroll/structure/${tgt.emp.id}`, '/api/payroll/runs/2026-09/compliance']) {
      const x = await call('GET', p, T[who]);
      check(`${who}: ${p} refused`, [403, 404].includes(x.status), x.status);
    }
  }
  for (const who of ['sa', 'adm', 'hr']) {
    const r = await call('GET', '/api/payroll', T[who]);
    check(`${who}: payroll desk still reads payslips`, r.status === 200 && Array.isArray(r.body) && r.body.some((x) => x.id === slip.id), r.status);
  }
  const mo = await call('GET', '/api/payroll', T.mgr);
  check('manager: own payslip list answers 200 (empty)', mo.status === 200 && Array.isArray(mo.body) && mo.body.length === 0, mo.status);
};
