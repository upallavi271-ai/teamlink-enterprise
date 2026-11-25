// THE ATS PROFILE SWITCH (utils/atsProfile.js, founder 2026-11-25: NISH works by hiring type, TeamLink by department).
// Pure logic, no database:  node scripts/ats-profile-test.js
let total = 0;
let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `  ${JSON.stringify(extra)}` : ''}`); } };
const fresh = () => { delete require.cache[require.resolve('../src/utils/atsProfile')]; return require('../src/utils/atsProfile'); };

delete process.env.ATS_PROFILE;
let AP = fresh();
check('no ATS_PROFILE (TeamLink): the profile is departments', AP.profile() === 'departments' && AP.itStaffing() === false);
process.env.ATS_PROFILE = '';
check('an empty ATS_PROFILE is still departments', fresh().itStaffing() === false);
process.env.ATS_PROFILE = 'something-else';
check('an unknown ATS_PROFILE is still departments', fresh().itStaffing() === false);
for (const v of ['it-staffing', 'IT Staffing', 'it_staffing', ' itstaffing ']) {
  process.env.ATS_PROFILE = v;
  check(`ATS_PROFILE="${v}" turns on IT staffing`, fresh().itStaffing() === true && fresh().profile() === 'it-staffing');
}
delete process.env.ATS_PROFILE;
AP = fresh();
check('the hiring types are Contract, Full Time, Contract to Hire', JSON.stringify(AP.HIRING_TYPES) === JSON.stringify(['Contract', 'Full Time', 'Contract to Hire']));
const map = { contract: 'Contract', Contractual: 'Contract', 'Full time': 'Full Time', 'full-time': 'Full Time', FullTime: 'Full Time', permanent: 'Full Time', C2H: 'Contract to Hire', 'contract to hire': 'Contract to Hire', 'Part Time': 'Part Time', '': '' };
const bad = Object.entries(map).filter(([k, v]) => AP.hiringTypeOf(k) !== v).map(([k, v]) => [k, v, AP.hiringTypeOf(k)]);
check('every spelling reads as its stored word (others stay as typed)', bad.length === 0, bad);
check('no ?jobType: no condition', AP.requirementHiringWhere('') === null && AP.requirementHiringWhere(undefined) === null && AP.requirementHiringWhere(',') === null);
check('?jobType=contract,full time: employmentType in [Contract, Full Time]', JSON.stringify(AP.requirementHiringWhere('contract,full time')) === JSON.stringify({ employmentType: { in: ['Contract', 'Full Time'] } }));
check('the switch does not decide the filter: a sent ?jobType is applied the same on any copy (only an it-staffing screen sends it)', JSON.stringify(AP.requirementHiringWhere('C2H')) === JSON.stringify({ employmentType: { in: ['Contract to Hire'] } }));

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
