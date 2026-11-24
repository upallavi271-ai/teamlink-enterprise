// ---------------------------------------------------------------------------
// ACCOUNT PROSPECTING (ATS wave 2 Y, benchmark 06.05): find NEW client companies and their hiring contacts, add them to the BD list and
// start outreach - inside ATS > Clients > Business development (utils/atsPlus/bd.js). Not the CRM. OFF until an Admin turns on
// "prospecting" (AI governance > Sourcing & AI connectors).
//
//   suggestions(user)   from TeamLink's own data first: the companies our candidates work at now and worked at before (they hire the
//                       people we place), minus every client and every prospect already on the list; the score says why (how many of our
//                       people are there, how many joined recently, people there in HR / talent acquisition = hiring contacts by name and role)
//   outside(user, f)    the people & company data provider (needs the founder's account AND "outsideLookups"): companies by industry /
//                       city / the roles they hire for, with verified hiring contacts
//   add(user, s)        the company goes onto the BD prospect list through the BD list's own route (its duplicate / client checks, owner)
//   Outreach: the prospect is enrolled in a BD campaign (the BD list's own outreach, which sends ONLY when an Admin switched it on).
// Who: the BDE team, BDE TLs and Admins (a Manager sees, never adds); recruiters have no BD list.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');

const { txt } = C;
const HR_TITLE = /\b(hr|h\.r\.|human resources?|talent|recruit\w*|hiring|people (partner|operations|ops)|staffing|ta (lead|manager|partner|head)|acquisition)\b/i;
function access(user) {
  const v = C.viewRole(user);
  const bdeTl = require('../scope').isBdeTl(user); // eslint-disable-line global-require
  if (v === 'admin' || bdeTl) return { read: true, write: true };
  if (v === 'mgmt') return { read: true, write: false };
  if (v === 'bde') return { read: true, write: true };
  return null;
}

async function existingKeys() {
  const S = require('../atsPlus/store'); // eslint-disable-line global-require
  const clients = await prisma.client.findMany({ select: { name: true } });
  const prospects = await S.items.list('prospect', {}).catch(() => []);
  return new Set([...clients.map((c) => C.normCo(c.name)), ...prospects.map((p) => C.normCo(p.title))].filter(Boolean));
}

async function suggestions(user, { limit = 40 } = {}) {
  if (!(await C.switchOn('prospecting'))) return C.SWITCH_OFF('prospecting');
  const have = await existingKeys();
  const since = new Date(Date.now() - 90 * 864e5);
  const now = await prisma.candidate.findMany({ where: { currentCompany: { not: null } }, select: { id: true, name: true, currentCompany: true, currentDesignation: true, location: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 30000 });
  const by = new Map();
  const slot = (name) => {
    const k = C.normCo(name);
    if (k.length < 3 || have.has(k) || /^(fresher|na|none|self|selfemployed|freelance|notworking|student|unemployed)$/.test(k)) return null;
    if (!by.has(k)) by.set(k, { key: k, names: new Map(), now: 0, recent: 0, past: 0, cities: new Map(), contacts: [] });
    const s = by.get(k); s.names.set(name.trim(), (s.names.get(name.trim()) || 0) + 1); return s;
  };
  now.forEach((c) => {
    const s = slot(c.currentCompany); if (!s) return;
    s.now += 1; if (c.createdAt >= since) s.recent += 1;
    if (c.location) s.cities.set(c.location, (s.cities.get(c.location) || 0) + 1);
    if (HR_TITLE.test(c.currentDesignation || '') && s.contacts.length < 5) s.contacts.push({ name: c.name, role: c.currentDesignation, from: 'a candidate on file who works there' });
  });
  try {
    await require('../candidateProfileDepth').ensure(); // eslint-disable-line global-require
    const past = await C.q('SELECT "company" FROM "CandidateEmployment" WHERE "isCurrent" = 0 AND "company" IS NOT NULL LIMIT 30000');
    past.forEach((r) => { const s = slot(r.company); if (s) s.past += 1; });
  } catch { /* the career tab is optional */ }
  const rows = [...by.values()].map((s) => {
    const name = [...s.names.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const reasons = []; let score = 0;
    if (s.now) { const p = Math.min(40, s.now * 4); score += p; reasons.push(`${s.now} of our candidates work there now (+${p})`); }
    if (s.recent) { const p = Math.min(20, s.recent * 5); score += p; reasons.push(`${s.recent} joined our database in the last 90 days (+${p})`); }
    if (s.past) { const p = Math.min(15, s.past * 2); score += p; reasons.push(`${s.past} worked there before (+${p})`); }
    if (s.contacts.length) { score += 25; reasons.push(`${s.contacts.length} in HR / talent acquisition there: a hiring contact (+25)`); }
    const city = [...s.cities.entries()].sort((a, b) => b[1] - a[1])[0];
    return { company: name, city: city ? city[0] : null, score: Math.min(100, score), reasons, contacts: s.contacts, ourPeopleThere: s.now, source: 'TeamLink data' };
  }).filter((r) => r.ourPeopleThere >= 2 || r.contacts.length).sort((a, b) => b.score - a.score).slice(0, Math.min(100, limit));
  return { rows, note: 'Companies our own candidates work at (or worked at) that are not a client or on the prospect list yet. Hiring contacts are shown by name and role only.', outside: await require('./people').outsideState() }; // eslint-disable-line global-require
}

async function outside(user, f) {
  if (!(await C.switchOn('prospecting'))) return C.SWITCH_OFF('prospecting');
  const r = await require('./people').companiesOutside(user, f || {}); // eslint-disable-line global-require
  if (r.error) return r;
  const have = await existingKeys();
  return { provider: r.provider, rows: r.companies.filter((c) => !have.has(C.normCo(c.name))).map((c) => ({ company: c.name, city: c.city, industry: c.industry, website: c.website, openJobs: c.openJobs, contacts: c.contacts, source: r.provider, reasons: [c.openJobs ? `${c.openJobs} open job(s) right now` : null, c.size ? `size ${c.size}` : null].filter(Boolean) })) };
}

async function add(user, s) {
  if (!(await C.switchOn('prospecting'))) return C.SWITCH_OFF('prospecting');
  const company = txt(s && s.company, 120);
  if (!company) return { status: 400, error: 'Which company?' };
  // contacts from our own candidates: name and role only (a BDE never gets candidate contact details); a provider's contact keeps its e-mail / phone
  const contacts = (Array.isArray(s.contacts) ? s.contacts : []).slice(0, 10).map((c) => ({ name: txt(c.name, 80), role: txt(c.role, 80), email: s.source && s.source !== 'TeamLink data' ? txt(c.email, 120) : '', phone: s.source && s.source !== 'TeamLink data' ? txt(c.phone, 15) : '' }));
  const r = await C.asUser(user, 'POST', '/ats-plus/bd/prospects', { name: company, city: txt(s.city, 80) || undefined, industry: txt(s.industry, 80) || undefined, website: txt(s.website, 200) || undefined, source: `Prospecting (${txt(s.source, 40) || 'TeamLink data'})`, contacts });
  if (r.status >= 300) return { status: r.status, error: (r.body && r.body.error) || 'Not added.', code: r.body && r.body.code };
  await C.logAudit({ userId: user.id, action: 'Prospect found by prospecting', entity: 'Prospect', entityId: r.body.id, toValue: `${company} (${txt(s.source, 40) || 'TeamLink data'})` });
  if (Array.isArray(s.reasons) && s.reasons.length) await C.asUser(user, 'POST', `/ats-plus/bd/prospects/${r.body.id}/notes`, { text: `Found by prospecting (${txt(s.source, 40) || 'TeamLink data'}): ${s.reasons.join('; ')}`.slice(0, 1000) }).catch(() => null);
  return { ok: true, prospect: { id: r.body.id, title: r.body.title, score: r.body.score } };
}

async function contact(user, prospectId, campaignId) {
  if (!(await C.switchOn('prospecting'))) return C.SWITCH_OFF('prospecting');
  if (!campaignId) return { status: 400, error: 'Pick the outreach campaign.' };
  const r = await C.asUser(user, 'POST', `/ats-plus/bd/campaigns/${encodeURIComponent(campaignId)}/enrol`, { prospectIds: [prospectId] });
  if (r.status >= 300) return { status: r.status, error: (r.body && r.body.error) || 'Not enrolled.' };
  const S = require('../atsPlus/store'); // eslint-disable-line global-require
  const set = await S.settings.get('bdOutreach', { enabled: false }).catch(() => ({ enabled: false }));
  return { ok: true, enrolled: (r.body.enrolled || []).some((e) => e.prospectId === prospectId), sending: !!set.enabled, message: set.enabled ? 'Enrolled: the campaign\'s mails go out on their days.' : 'Enrolled. Outreach mails are switched OFF, so nothing is sent until an Admin turns them on (Business development > Outreach).' };
}

module.exports = { access, suggestions, outside, add, contact, HR_TITLE };
