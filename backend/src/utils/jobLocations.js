// ---------------------------------------------------------------------------
// THE LOCATION LIST A JOB'S "PREFERRED LOCATION" IS PICKED FROM (user, 2026-10-13).
//
// One list, merged from what the company already knows:
//   office     the offices / branches on Employee (branch, location) - TeamLink's real places
//   managed    places added by hand (AppSetting 'ats.jobLocations', JSON list) - the BDE team and Admin add these inline
//   used       places already typed on earlier jobs (Requirement.location) - nothing is lost
//   city       the common Indian cities, so the list is never empty
// plus two special choices that are not places: "Remote" and "Any location".
// ---------------------------------------------------------------------------
const prisma = require('../db');

const KEY = 'ats.jobLocations';
const SPECIAL = ['Remote', 'Any location'];
const COMMON = [
  'Hyderabad', 'Bengaluru', 'Chennai', 'Mumbai', 'Pune', 'Delhi NCR', 'Kolkata', 'Ahmedabad', 'Visakhapatnam', 'Vijayawada',
  'Warangal', 'Coimbatore', 'Kochi', 'Thiruvananthapuram', 'Mysuru', 'Mangaluru', 'Nagpur', 'Indore', 'Jaipur', 'Lucknow',
  'Chandigarh', 'Bhubaneswar', 'Noida', 'Gurugram', 'Guntur', 'Tirupati', 'Nellore', 'Karimnagar', 'Nizamabad', 'Khammam',
  'Secunderabad', 'Kakinada', 'Rajahmundry', 'Gajwel', 'Kottayam', 'Delhi', 'Navi Mumbai', 'Thane', 'Faridabad', 'Ghaziabad', 'Patna', 'Ranchi',
  'Raipur', 'Bhopal', 'Surat', 'Vadodara', 'Rajkot', 'Madurai', 'Tiruchirappalli', 'Salem', 'Hubballi', 'Belagavi', 'Vizianagaram', 'Ongole',
  'Kurnool', 'Anantapur', 'Kadapa', 'Eluru', 'Bhimavaram', 'Machilipatnam', 'Sangareddy', 'Medchal', 'Patancheru', 'Siddipet', 'Mahabubnagar', 'Nalgonda',
];
// Other spellings of the same place: matched case / spacing insensitively, so "Bangalore" or "Hyderabad, Telangana" is NOT "custom".
const ALIASES = {
  bangalore: 'Bengaluru', bengaluru: 'Bengaluru', bombay: 'Mumbai', madras: 'Chennai', calcutta: 'Kolkata', vizag: 'Visakhapatnam',
  visakhapatnam: 'Visakhapatnam', vishakapatnam: 'Visakhapatnam', vijayawada: 'Vijayawada', 'delhi ncr': 'Delhi NCR', ncr: 'Delhi NCR', gurgaon: 'Gurugram',
  trivandrum: 'Thiruvananthapuram', cochin: 'Kochi', mysore: 'Mysuru', mangalore: 'Mangaluru', tirupathi: 'Tirupati', ahemadabad: 'Ahmedabad',
  belgaum: 'Belagavi', hubli: 'Hubballi', trichy: 'Tiruchirappalli', hyd: 'Hyderabad', pune: 'Pune',
};

const tidy = (v) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, 60);
const keyOf = (v) => tidy(v).toLowerCase();
// The proper name for a spelling ("Bangalore" -> "Bengaluru"), or the tidied text itself.
const canon = (v) => { const t = tidy(v); const a = ALIASES[t.toLowerCase().replace(/[^a-z ]/g, '').trim()]; return a || t; };

async function managed() {
  const row = await prisma.appSetting.findUnique({ where: { key: KEY } }).catch(() => null);
  if (!row) return [];
  try { const v = JSON.parse(row.value); return Array.isArray(v) ? v.map(tidy).filter(Boolean) : []; } catch { return []; }
}

async function list() {
  const out = new Map(); // lower -> { name, source }
  const put = (name, source) => {
    const n = tidy(name);
    if (!n || SPECIAL.some((s) => s.toLowerCase() === n.toLowerCase())) return;
    if (/^(any|none|—|-)$/i.test(n)) return;
    const c = canon(n);
    if (!out.has(c.toLowerCase())) out.set(c.toLowerCase(), { name: c, source });
  };
  const [branches, places, used, mine, clientPlaces] = await Promise.all([
    prisma.employee.findMany({ where: { branch: { not: null } }, distinct: ['branch'], select: { branch: true }, take: 100 }).catch(() => []),
    prisma.employee.findMany({ where: { location: { not: null } }, distinct: ['location'], select: { location: true }, take: 100 }).catch(() => []),
    prisma.requirement.findMany({ where: { location: { not: null } }, distinct: ['location'], select: { location: true }, take: 300 }).catch(() => []),
    managed(),
    prisma.client.findMany({ where: { location: { not: null } }, distinct: ['location'], select: { location: true }, take: 300 }).catch(() => []),
  ]);
  branches.forEach((b) => put(b.branch, 'office'));
  places.forEach((b) => put(b.location, 'office'));
  mine.forEach((n) => put(n, 'managed'));
  COMMON.forEach((n) => put(n, 'city'));
  clientPlaces.forEach((b) => { if (b.location && !/[,/;()]/.test(b.location) && b.location.length <= 30 && b.location.split(' ').length <= 3) put(b.location, 'used'); });
  used.forEach((b) => { if (b.location && !/[,/;]/.test(b.location) && b.location.length <= 40) put(b.location, 'used'); });
  const rank = { office: 0, managed: 1, city: 2, used: 3 };
  const places2 = [...out.values()].sort((a, b) => (rank[a.source] - rank[b.source]) || a.name.localeCompare(b.name));
  return { special: SPECIAL, locations: places2 };
}

async function add(name, user) {
  const n = canon(tidy(String(name || '').replace(/<[^>]*>/g, ' ')));
  if (n.length < 2) return { error: 'Write the place name (at least 2 letters).', status: 400 };
  if (/[<>{}]/.test(n)) return { error: 'Use letters and numbers only.', status: 400 };
  const cur = await managed();
  const have = (await list()).locations.some((x) => keyOf(x.name) === keyOf(n));
  if (!cur.some((x) => keyOf(x) === keyOf(n)) && !have) {
    require('./audit').logAudit({ userId: user.id, action: 'Added to list', entity: 'Job location', entityId: n, toValue: n }); // eslint-disable-line global-require
    const next = [...cur, n];
    await prisma.appSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
      update: { value: JSON.stringify(next), updatedById: user.id, updatedByName: user.name },
    });
  }
  return { ok: true, name: n };
}

module.exports = { list, add, tidy, canon, SPECIAL };
