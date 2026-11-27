// ---------------------------------------------------------------------------
// AI MARKETING > SEO & VISIBILITY > TRUSTED LISTINGS (2026-11-27): the "trusted reference recommendations" of the Premium plan's GEO work. For each kind of business, the places where people, search
// engines and AI systems look a business up; the team ticks what it finds for a client (not there / same details / wrong details / does not apply) and keeps the listing's address. The saved ticks go
// into the monthly report with what to do next.
// HONEST: a plain list and the team's own ticks. Nothing is read from those sites, nothing is created or paid for there, and a listing promises no ranking, mention or lead. Official registers
// are only for businesses that really are registered / accredited; some listing sites sell paid places (their terms apply).
// saved: table OmniMkListing (one row per client and place); audit log "Omni-Channel AI Marketing: trusted listing saved".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const { logAudit } = require('../utils/audit');
const Packs = require('./industryPacks');

const T = 'OmniMkListing';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL, "clientKey" TEXT NOT NULL, "place" TEXT NOT NULL, "status" TEXT NOT NULL, "url" TEXT, "note" TEXT, "department" TEXT, "updatedById" TEXT, "updatedByName" TEXT, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS "${T}_one" ON "${T}"("clientKey", "place")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] listings schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const HEALTH = ['doctor', 'clinic', 'hospital'];
// kinds: the industry keys it fits ('all' = every business)
const PLACES = [
  { key: 'google', name: 'Google Business Profile', url: 'https://www.google.com/business/', kinds: 'all', why: 'Google Search and Maps' },
  { key: 'bing', name: 'Bing Places', url: 'https://www.bing.com/forbusiness/', kinds: 'all', why: 'Bing Search and Maps' },
  { key: 'apple', name: 'Apple Business', url: 'https://business.apple.com/', kinds: 'all', why: 'Apple Maps on iPhones' },
  { key: 'facebook', name: 'Facebook Page', url: 'https://www.facebook.com/pages/create', kinds: 'all', why: 'Public business page' },
  { key: 'linkedin', name: 'LinkedIn company page', url: 'https://www.linkedin.com/company/setup/new/', kinds: ['hospital', 'it', 'manufacturing', 'education', 'other'], why: 'Company facts for professionals' },
  { key: 'justdial', name: 'Justdial', url: 'https://www.justdial.com/', kinds: 'all', why: 'Local directory in India' },
  { key: 'sulekha', name: 'Sulekha', url: 'https://www.sulekha.com/', kinds: ['clinic', 'it', 'education', 'other'], why: 'Local services directory' },
  { key: 'practo', name: 'Practo', url: 'https://www.practo.com/', kinds: HEALTH, why: 'Doctor and clinic directory' },
  { key: 'nmc', name: 'Medical register (NMC / State Medical Council)', url: 'https://www.nmc.org.in/', kinds: HEALTH, why: 'Official record of each doctor: check the name and registration number', register: true },
  { key: 'nabh', name: 'NABH accredited list', url: 'https://nabh.co/', kinds: ['hospital'], why: 'Only if the hospital is really accredited', register: true },
  { key: 'shiksha', name: 'Shiksha', url: 'https://www.shiksha.com/', kinds: ['education'], why: 'College and course directory' },
  { key: 'collegedunia', name: 'Collegedunia', url: 'https://collegedunia.com/', kinds: ['education'], why: 'College and course directory' },
  { key: 'clutch', name: 'Clutch', url: 'https://clutch.co/', kinds: ['it'], why: 'Software and services directory' },
  { key: 'goodfirms', name: 'GoodFirms', url: 'https://www.goodfirms.co/', kinds: ['it'], why: 'Software and services directory' },
  { key: 'indiamart', name: 'IndiaMART', url: 'https://www.indiamart.com/', kinds: ['manufacturing', 'other'], why: 'Supplier directory' },
  { key: 'tradeindia', name: 'TradeIndia', url: 'https://www.tradeindia.com/', kinds: ['manufacturing'], why: 'Supplier directory' },
  { key: 'udyam', name: 'Udyam (MSME) registration', url: 'https://udyamregistration.gov.in/', kinds: ['manufacturing'], why: 'Only for a registered small or medium business', register: true },
];
const STATUSES = [['not', 'Not there'], ['ok', 'Listed, same details'], ['wrong', 'Listed, wrong details'], ['na', 'Does not apply']];
const STATUS_WORDS = Object.fromEntries(STATUSES);
const clean = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const keyOf = (name) => clean(name, 120).toLowerCase();
const placesFor = (industry) => PLACES.filter((p) => p.kinds === 'all' || p.kinds.includes(Packs.PACKS[industry] ? industry : 'other'));
const mine = (u, rows) => rows.filter((r) => A.mayDepartment(u, r.department || ''));

async function rowsOf(clientName) { return S.q(`SELECT * FROM "${T}" WHERE clientKey = ?`, keyOf(clientName)); }
// the list for one client with what has been saved
async function view(u, q = {}) {
  if (!(await ensure())) return { error: 'The listings could not be opened.', status: 500 };
  const clientName = clean(q.clientName, 120); const industry = Packs.PACKS[q.industry] ? q.industry : 'other';
  const saved = clientName ? mine(u, await rowsOf(clientName)) : [];
  const by = Object.fromEntries(saved.map((r) => [r.place, r]));
  const places = placesFor(industry).map((p) => { const r = by[p.key]; return { key: p.key, name: p.name, link: p.url, why: p.why, register: !!p.register, status: r ? r.status : '', url: (r && r.url) || '', note: (r && r.note) || '', byName: (r && r.updatedByName) || '', at: r ? S.iso(r.updatedAt) : null }; });
  return { clientName, industry, places, statuses: STATUSES, counts: countsOf(saved) };
}
async function save(u, b = {}) {
  if (!(await ensure())) return { error: 'It could not be saved.', status: 500 };
  const clientName = clean(b.clientName, 120); if (!clientName) return { error: 'Write the client name.', status: 400 };
  const place = PLACES.find((p) => p.key === b.place); if (!place) return { error: 'That place is not in the list.', status: 400 };
  if (!STATUS_WORDS[b.status]) return { error: 'Pick what you found.', status: 400 };
  const url = clean(b.url, 400); if (url && !/^https?:\/\/[^\s<>"']+$/i.test(url)) return { error: 'The listing address starts with https://', status: 400 };
  const note = clean(b.note, 300); const dept = clean(b.department, 60) || null;
  const old = (await S.q(`SELECT * FROM "${T}" WHERE clientKey = ? AND place = ?`, keyOf(clientName), place.key))[0];
  if (old && !A.mayDepartment(u, old.department || '')) return { error: 'That client belongs to another department.', status: 403 };
  if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  if (old) await S.run(`UPDATE "${T}" SET status=?, url=?, note=?, updatedById=?, updatedByName=?, updatedAt=? WHERE id=?`, b.status, url || null, note || null, u.id, S.clip(u.name, 80), Date.now(), old.id);
  else await S.run(`INSERT INTO "${T}" (id, clientName, clientKey, place, status, url, note, department, updatedById, updatedByName, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, S.newId('lst'), clientName, keyOf(clientName), place.key, b.status, url || null, note || null, dept, u.id, S.clip(u.name, 80), Date.now());
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: trusted listing saved', entity: T, entityId: keyOf(clientName), toValue: `${clientName}: ${place.name}: ${STATUS_WORDS[b.status]}` });
  return { ok: true };
}
function countsOf(rows) {
  const names = (st) => rows.filter((r) => r.status === st).map((r) => (PLACES.find((p) => p.key === r.place) || { name: r.place }).name);
  return { checked: rows.filter((r) => r.status !== 'na').length, same: names('ok'), wrong: names('wrong'), missing: names('not') };
}
// for the monthly report: what is saved now (null when nothing has been ticked)
async function reportCounts(u, clientName) {
  if (!(await ensure())) return null;
  const c = countsOf(mine(u, await rowsOf(clientName)));
  return c.checked ? c : null;
}
module.exports = { ensure, PLACES, STATUSES, placesFor, view, save, reportCounts };
