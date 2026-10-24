// ---------------------------------------------------------------------------
// DEFAULT PORTAL MAPPINGS (seed for the PortalMapping table).
//
// "ATS value -> the word / code the portal's own form uses." One row per
// (portal, field, atsValue). The Admin can change every row (GET/PUT
// /api/job-publish/mappings); these are only SENSIBLE STARTING POINTS.
//
// UNVERIFIED: the portal-side labels below come from what the boards' public
// pages show and from general knowledge of their forms. They have NOT been
// checked against the boards' real post-job forms (that needs the company's own
// account: see docs/job-publishing/PLAYWRIGHT.md, "DRY RUN"). A wrong label is
// harmless: the DRY RUN screenshot shows it, and the Admin fixes the row.
//
// Fields
//   employmentType  Full Time | Part Time | Contract | Temporary | Internship
//   workMode        Work From Office | Work From Home | Hybrid
//   experience      a band "min-max" in years (the adapters pick the band that holds the job's range)
//   salary          a band "min-max" in LAKHS per year (LPA)
//   location        the canonical city (utils/locationMatch.js) -> the portal's city label / code
//   industry        TeamLink department -> the portal's industry
//   functionalArea  TeamLink department -> the portal's functional area / category
// ---------------------------------------------------------------------------

const PORTALS = ['naukri', 'foundit', 'shine', 'linkedin'];

const EMPLOYMENT = {
  naukri: { 'Full Time': 'Full Time, Permanent', 'Part Time': 'Part Time, Permanent', Contract: 'Full Time, Temporary/Contractual', Temporary: 'Full Time, Temporary/Contractual', Internship: 'Internship' },
  foundit: { 'Full Time': 'Full Time', 'Part Time': 'Part Time', Contract: 'Contract', Temporary: 'Contract', Internship: 'Internship' },
  shine: { 'Full Time': 'Full Time', 'Part Time': 'Part Time', Contract: 'Contract', Temporary: 'Contract', Internship: 'Internship' },
  linkedin: { 'Full Time': 'Full-time', 'Part Time': 'Part-time', Contract: 'Contract', Temporary: 'Temporary', Internship: 'Internship' },
};
const WORK_MODE = {
  naukri: { 'Work From Office': 'Work from office', 'Work From Home': 'Work from home', Hybrid: 'Hybrid' },
  foundit: { 'Work From Office': 'On-site', 'Work From Home': 'Remote', Hybrid: 'Hybrid' },
  shine: { 'Work From Office': 'Work from office', 'Work From Home': 'Work from home', Hybrid: 'Hybrid' },
  linkedin: { 'Work From Office': 'On-site', 'Work From Home': 'Remote', Hybrid: 'Hybrid' },
};
const EXPERIENCE_BANDS = ['0-1', '1-3', '3-5', '5-8', '8-12', '12-20', '20-40'];
const SALARY_BANDS = ['0-3', '3-6', '6-10', '10-15', '15-25', '25-50', '50-100'];

// canonical city -> [label, code]
const CITIES = {
  Hyderabad: ['Hyderabad / Secunderabad', 'HYD'], Bengaluru: ['Bengaluru / Bangalore', 'BLR'], Visakhapatnam: ['Visakhapatnam', 'VTZ'],
  Vijayawada: ['Vijayawada', 'VGA'], Chennai: ['Chennai', 'MAA'], Mumbai: ['Mumbai', 'BOM'], Delhi: ['Delhi / NCR', 'DEL'],
  Pune: ['Pune', 'PNQ'], Kolkata: ['Kolkata', 'CCU'], Ahmedabad: ['Ahmedabad', 'AMD'], Gurugram: ['Gurgaon / Gurugram', 'GGN'],
  Noida: ['Noida', 'NOI'], Jaipur: ['Jaipur', 'JAI'], Lucknow: ['Lucknow', 'LKO'], Kochi: ['Kochi / Cochin', 'COK'],
  Coimbatore: ['Coimbatore', 'CJB'], Indore: ['Indore', 'IDR'], Nagpur: ['Nagpur', 'NAG'], Chandigarh: ['Chandigarh', 'IXC'],
  Bhubaneswar: ['Bhubaneswar', 'BBI'], Warangal: ['Warangal', 'WGC'], Karimnagar: ['Karimnagar', 'KRM'], Khammam: ['Khammam', 'KHM'],
  Nizamabad: ['Nizamabad', 'NZB'], Tirupati: ['Tirupati', 'TIR'], Guntur: ['Guntur', 'GNT'], Mysuru: ['Mysore / Mysuru', 'MYQ'],
};
const INDUSTRY = {
  Education: ['Education / Teaching / Training', 'Teaching & Training'],
  Medical: ['Medical / Healthcare / Hospitals', 'Healthcare & Life Sciences'],
  Manufacturing: ['Industrial Products / Heavy Machinery', 'Production, Manufacturing & Engineering'],
  IT: ['IT-Software / Software Services', 'IT Software'],
  BDE: ['Recruitment / Staffing / RPO', 'Sales & Business Development'],
  HR: ['Recruitment / Staffing / RPO', 'Human Resources'],
  Accounts: ['Accounting / Finance', 'Accounting & Finance'],
};

function rows() {
  const out = [];
  PORTALS.forEach((portal) => {
    let n = 0;
    const add = (field, atsValue, portalValue, portalCode = null) => { out.push({ portal, field, atsValue, portalValue, portalCode, sortOrder: n += 1 }); };
    Object.entries(EMPLOYMENT[portal]).forEach(([a, p]) => add('employmentType', a, p));
    Object.entries(WORK_MODE[portal]).forEach(([a, p]) => add('workMode', a, p));
    EXPERIENCE_BANDS.forEach((b) => { const [lo, hi] = b.split('-'); add('experience', b, `${lo} - ${hi} Years`, b); });
    SALARY_BANDS.forEach((b) => { const [lo, hi] = b.split('-'); add('salary', b, `${lo} - ${hi} Lakhs`, b); });
    Object.entries(CITIES).forEach(([a, [label, code]]) => add('location', a, label, code));
    Object.entries(INDUSTRY).forEach(([a, [ind]]) => add('industry', a, ind));
    Object.entries(INDUSTRY).forEach(([a, [, fa]]) => add('functionalArea', a, fa));
  });
  return out;
}

// A stable id, so a re-seed never makes a second row.
const idOf = (r) => `pm_${r.portal}_${r.field}_${String(r.atsValue).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

module.exports = { rows, idOf, PORTALS, EXPERIENCE_BANDS, SALARY_BANDS, CITIES };
