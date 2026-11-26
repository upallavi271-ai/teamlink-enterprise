// EXTENSION 2.0 READERS (browser-extension/parsers.js) + the server-side address cleaner (utils/mkt/portal.js cleanProfileUrl).
//   node scripts/extension-parsers-test.js        (no database needed)
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'browser-extension', 'parsers.js'));

let total = 0; let failed = 0;
const check = (name, ok, extra) => { total += 1; if (ok) console.log(`  ok  ${name}`); else { failed += 1; console.log(`FAIL  ${name}${extra !== undefined ? `\n      ${JSON.stringify(extra).slice(0, 400)}` : ''}`); } };

// what innerText gives on the three boards: label and value on one line, or on two lines
const naukri = P.read({
  url: 'https://resdex.naukri.com/v3/preview?uniqId=abc123&sid=999#top',
  h1: 'Ravi Kumar',
  text: [
    'Ravi Kumar', 'Senior Java Developer at Infosys', 'Total Experience', '6 Years 6 Months', 'Current CTC', '12.5 Lacs',
    'Expected CTC', '16 Lacs', 'Notice Period', '30 Days', 'Current Location', 'Hyderabad',
    'Current Company', 'Infosys', 'Current Designation', 'Senior Java Developer', 'Key Skills', 'Java, Spring Boot, Microservices, AWS',
    'Highest Qualification', 'B.Tech/B.E. (Computers) - JNTU 2017', 'Contact', 'ravi.k@example.com', '+91 98480 12345',
  ].join('\n'),
  mailtos: [], tels: [],
});
check('Naukri: site', naukri && naukri.site === 'naukri', naukri);
check('Naukri: name', naukri.name === 'Ravi Kumar');
check('Naukri: 6 years 6 months = 6.5', naukri.experienceYears === 6.5, naukri.experienceYears);
check('Naukri: current / expected CTC', naukri.currentSalary === '12.5 Lacs' && naukri.expectedSalary === '16 Lacs', [naukri.currentSalary, naukri.expectedSalary]);
check('Naukri: notice, location, company, designation', naukri.noticePeriod === '30 Days' && naukri.location === 'Hyderabad' && naukri.currentCompany === 'Infosys' && naukri.headline === 'Senior Java Developer', naukri);
check('Naukri: skills list', naukri.skills.join('|') === 'Java|Spring Boot|Microservices|AWS', naukri.skills);
check('Naukri: email and phone from the text', naukri.email === 'ravi.k@example.com' && naukri.phone === '+919848012345', [naukri.email, naukri.phone]);
check('Naukri: education', /B\.Tech/.test(naukri.education));
check('Naukri: #fragment dropped from the address', naukri.profileUrl === 'https://resdex.naukri.com/v3/preview?uniqId=abc123&sid=999');

const shine = P.read({
  url: 'https://recruiter.shine.com/candidate/profile/5f1e2d/',
  h1: 'Profile',
  text: 'Experience: 3 yrs\nCurrent Salary: 4.2 LPA\nNotice: Immediate\nLocation: Bengaluru\nSkills: Sales | Lead Generation | CRM\nDesignation: Business Development Executive\nCompany: Byju\'s',
  mailtos: ['Priya.S@Example.com'], tels: ['9876543210'],
});
check('Shine: site', shine.site === 'shine', shine);
check('Shine: a heading like "Profile" is not taken as the name', shine.name === '', shine.name);
check('Shine: same-line labels', shine.experienceYears === 3 && shine.currentSalary === '4.2 LPA' && shine.noticePeriod === 'Immediate' && shine.location === 'Bengaluru', shine);
check('Shine: | separated skills', shine.skills.length === 3 && shine.skills[2] === 'CRM', shine.skills);
check('Shine: mailto / tel links win, email lower-cased', shine.email === 'priya.s@example.com' && shine.phone === '9876543210', [shine.email, shine.phone]);

const foundit = P.read({
  url: 'https://recruiter.foundit.in/edge/candidate/view?profileId=778899',
  h1: 'Anil Reddy',
  text: 'Anil Reddy\nWork Experience\n10 years\nExpected Salary\n25 LPA\nCity\nPune\nPrimary Skills\nSAP FICO, S/4HANA',
  mailtos: [], tels: [],
});
check('foundit: site and fields', foundit.site === 'foundit' && foundit.experienceYears === 10 && foundit.expectedSalary === '25 LPA' && foundit.location === 'Pune', foundit);
check('foundit: skills', foundit.skills.join('|') === 'SAP FICO|S/4HANA', foundit.skills);
check('monsterindia.com counts as foundit', P.siteOf('https://www.monsterindia.com/seeker/profile') === 'foundit');
check('another site is not read', P.read({ url: 'https://example.com/x', text: 'Name' }) === null);
check('a lookalike host is not a board', P.siteOf('https://naukri.com.evil.io/x') === null && P.siteOf('https://notnaukri.com/x') === null);
check('a label with no value on the next label line stays blank', P.read({ url: 'https://www.naukri.com/p', h1: 'X Y', text: 'Notice Period\nCurrent CTC\n5 L' }).noticePeriod === '', 'np');
check('years: "5.5 yrs", "2y 3m", "7"', P.years('5.5 yrs') === 5.5 && P.years('2y 3m') === 2.3 && P.years('7') === 7 && P.years('fresher') === null);

// server: the same address always gives the same key, so the same person is found again
const MP = require(path.join(__dirname, '..', 'src', 'utils', 'mkt', 'portal.js'));
const a = MP.cleanProfileUrl('https://resdex.naukri.com/v3/preview?sid=1&uniqId=abc123');
const b = MP.cleanProfileUrl('https://resdex.naukri.com/v3/preview/?uniqId=abc123&sid=2#x');
check('server: Naukri address kept with its profile id only', a && b && a.site === 'naukri' && a.url === b.url && /uniqId=abc123/.test(a.url) && !/sid=/.test(a.url), [a, b]);
check('server: LinkedIn still cleaned as before', MP.cleanProfileUrl('https://www.linkedin.com/in/some-one/?trk=x').site === 'linkedin');
check('server: an unknown site is refused', MP.cleanProfileUrl('https://example.com/in/x') === null);

console.log(`\n${total - failed}/${total} passed`);
process.exit(failed ? 1 : 0);
