// ---------------------------------------------------------------------------
// PEOPLE DATA (ATS wave 2 Y): the candidate profile graph (09.04), contact finding (09.06), enrichment (03.12) - OUR OWN DATA FIRST,
// then (only with the founder's account AND the Admin switch "outsideLookups") a licensed people-data provider.
//
//   graph(user, id)       who-knows-whom from TeamLink's own records: people at the same employer now, people who worked at the same
//                         company in the same years (career history), the same college, who referred them / whom they referred, and the
//                         TeamLink staff who worked with them (application owners, calls). Only people in the viewer's own scope are named.
//   ownContacts(id)       e-mail / phone the person gave us elsewhere: their resume text, another TeamLink record of the same person,
//                         messages already sent to them, the alternate phone
//   findContacts(...)     ownContacts + the provider's verified work e-mail / phone (POST <base>/v1/people/contact)
//   searchOutside(...)    the provider's profile search (POST <base>/v1/people/search) -> "add to a requirement" (no contact details)
//   enrichOutside(...)    the provider's view of a profile (POST <base>/v1/people/enrich) -> proposals for EMPTY fields; a different
//                         employer is recorded as a job change (utils/atsY/jobWatch.js)
// Provider contract: Bearer <API key>; the onboarding of the chosen provider maps its fields to these (only read*() would change).
// Every outside look-up is logged (AtsYLookup) with who and why; a monthly limit on the Integrations card (default 500).
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');

const { q, x, nowIso, newId, txt, lower } = C;
const LABEL = 'People data provider';
const scopeW = (u) => require('../scope').candidateWhere(u); // eslint-disable-line global-require
const yearOf = (m) => { const n = Number(String(m || '').slice(0, 4)); return n > 1950 && n < 2100 ? n : null; };

// ================================================================== 09.04 the graph from our own data
async function graph(user, candidateId) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: candidateId }] }, select: { id: true, name: true, currentCompany: true, currentDesignation: true, education: true, referredByEmployeeId: true, referredByName: true } });
  if (!c) return { status: 404, error: 'Candidate not found (or not in your scope).' };
  const PD = require('../candidateProfileDepth'); // eslint-disable-line global-require
  await PD.ensure();
  const groups = [];
  const seen = new Set([c.id]);
  let hidden = 0;
  const visible = async (ids) => {
    if (!ids.length) return new Map();
    const rows = await prisma.candidate.findMany({ where: { AND: [scopeW(user), { id: { in: ids.slice(0, 400) } }] }, select: { id: true, name: true, currentDesignation: true, currentCompany: true } });
    hidden += ids.length - rows.length;
    return new Map(rows.map((r) => [r.id, r]));
  };
  // 1. the same employer now
  const co = C.normCo(c.currentCompany);
  if (co.length >= 3) {
    const word = String(c.currentCompany).trim().split(/\s+/)[0];
    const near = await prisma.candidate.findMany({ where: { currentCompany: { contains: word }, id: { not: c.id } }, select: { id: true, currentCompany: true }, take: 400 });
    const ids = near.filter((n) => C.normCo(n.currentCompany) === co).map((n) => n.id);
    const vis = await visible(ids);
    const people = ids.filter((i) => vis.has(i)).slice(0, 25).map((i) => ({ ...vis.get(i), why: `works at ${c.currentCompany} now` }));
    people.forEach((p) => seen.add(p.id));
    if (people.length) groups.push({ key: 'employer', label: `Also at ${c.currentCompany} now`, people });
  }
  // 2. worked at the same company in the same years (career history)
  const mine = await PD.employmentOf(c.id).catch(() => []);
  const together = [];
  for (const j of mine.slice(0, 10)) {
    const k = C.normCo(j.company);
    if (k.length < 3) continue; // eslint-disable-line no-continue
    const from = yearOf(j.fromMonth) || 1950; const to = j.isCurrent ? 2100 : (yearOf(j.toMonth) || from);
    const word = String(j.company).trim().split(/\s+/)[0];
    // eslint-disable-next-line no-await-in-loop
    const rows = await q('SELECT "candidateId","company","fromMonth","toMonth","isCurrent" FROM "CandidateEmployment" WHERE "candidateId" <> ? AND "company" LIKE ? LIMIT 400', c.id, `%${word}%`);
    rows.filter((r) => C.normCo(r.company) === k).forEach((r) => {
      const f2 = yearOf(r.fromMonth) || 1950; const t2 = Number(r.isCurrent) ? 2100 : (yearOf(r.toMonth) || f2);
      if (f2 <= to && t2 >= from) together.push({ id: r.candidateId, why: `worked at ${j.company} at the same time (${Math.max(from, f2)}${Math.min(to, t2) >= 2100 ? '-now' : `-${Math.min(to, t2)}`})` });
    });
  }
  if (together.length) {
    const ids = [...new Set(together.map((t) => t.id))].filter((i) => !seen.has(i));
    const vis = await visible(ids);
    const people = ids.filter((i) => vis.has(i)).slice(0, 25).map((i) => ({ ...vis.get(i), why: together.find((t) => t.id === i).why }));
    people.forEach((p) => seen.add(p.id));
    if (people.length) groups.push({ key: 'colleagues', label: 'Worked together before', people });
  }
  // 3. the same college
  const ed = await q('SELECT "institute" FROM "CandidateEducation" WHERE "candidateId" = ? AND "institute" IS NOT NULL', c.id).catch(() => []);
  const insts = [...new Set(ed.map((e) => lower(e.institute).replace(/[^a-z0-9 ]/g, '').trim()).filter((s) => s.length >= 6))].slice(0, 3);
  if (insts.length) {
    const rows = [];
    for (const i of insts) rows.push(...await q('SELECT "candidateId","institute" FROM "CandidateEducation" WHERE "candidateId" <> ? AND lower("institute") LIKE ? LIMIT 200', c.id, `%${i.slice(0, 40)}%`)); // eslint-disable-line no-await-in-loop
    const ids = [...new Set(rows.map((r) => r.candidateId))].filter((i) => !seen.has(i));
    const vis = await visible(ids);
    const people = ids.filter((i) => vis.has(i)).slice(0, 15).map((i) => ({ ...vis.get(i), why: `studied at ${rows.find((r) => r.candidateId === i).institute}` }));
    people.forEach((p) => seen.add(p.id));
    if (people.length) groups.push({ key: 'college', label: 'Same college', people });
  }
  // 4. referrals: who referred them, whom they referred
  const refs = [];
  if (c.referredByEmployeeId || c.referredByName) refs.push({ id: null, name: c.referredByName || 'A TeamLink employee', why: 'referred this person', staff: !!c.referredByEmployeeId });
  const theyReferred = c.name && c.name.length > 3 ? await prisma.candidate.findMany({ where: { referredByName: c.name, id: { not: c.id } }, select: { id: true }, take: 50 }) : [];
  if (theyReferred.length) {
    const vis = await visible(theyReferred.map((r) => r.id));
    theyReferred.filter((r) => vis.has(r.id)).forEach((r) => refs.push({ ...vis.get(r.id), why: `was referred by ${c.name}` }));
  }
  if (refs.length) groups.push({ key: 'referrals', label: 'Referrals', people: refs.slice(0, 25) });
  // 5. TeamLink staff who know this person
  const owners = await prisma.application.findMany({ where: { candidateId: c.id, ownerRecruiterId: { not: null } }, select: { ownerRecruiterId: true, updatedAt: true }, take: 50 });
  const callers = await prisma.candidateMessage.findMany({ where: { candidateId: c.id, senderUserId: { not: null } }, select: { senderUserId: true, senderName: true, channel: true, sentAt: true }, orderBy: { sentAt: 'desc' }, take: 100 }).catch(() => []);
  const staffIds = [...new Set([...owners.map((o) => o.ownerRecruiterId), ...callers.map((m) => m.senderUserId)])];
  const staff = staffIds.length ? await prisma.user.findMany({ where: { id: { in: staffIds } }, select: { id: true, name: true } }) : [];
  if (staff.length) {
    groups.push({ key: 'staff', label: 'Who in TeamLink knows them', people: staff.map((s) => {
      const n = callers.filter((m) => m.senderUserId === s.id).length;
      return { staffId: s.id, name: s.name, why: [owners.some((o) => o.ownerRecruiterId === s.id) ? 'their recruiter' : null, n ? `${n} message(s) / call(s)` : null].filter(Boolean).join(', ') };
    }) });
  }
  const outside = await outsideState();
  return { candidate: { id: c.id, name: c.name, currentCompany: c.currentCompany, currentDesignation: c.currentDesignation }, groups, hiddenOutsideScope: hidden, total: groups.reduce((a, g) => a + g.people.length, 0), outside, note: 'From TeamLink\'s own records only. People outside your own view are counted, never named.' };
}

// ================================================================== the outside provider
async function config() { return C.provider('people-data', ['API base URL', 'API key'], LABEL); }
async function outsideState() {
  const cfg = await config();
  return { switchOn: await C.switchOn('outsideLookups'), ready: !!cfg.ready, hint: cfg.ready ? null : cfg.hint, provider: cfg.values ? (cfg.values['Provider name'] || null) : null, usedThisMonth: await usedThisMonth(), monthlyLimit: cfg.ready ? limitOf(cfg) : null };
}
const limitOf = (cfg) => { const n = Number(String(cfg.values['Monthly lookup limit'] || '').replace(/\D/g, '')); return n > 0 ? Math.min(n, 100000) : 500; };
async function usedThisMonth() { await C.ensure(); const m = `${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7)}-01`; const r = (await q('SELECT COUNT(*) AS n FROM "AtsYLookup" WHERE "at" >= ? AND "outcome" <> \'refused\'', m))[0]; return Number((r && r.n) || 0); }
async function lookup(kind, user, path, body, candidateId = null) {
  if (!(await C.switchOn('outsideLookups'))) return C.SWITCH_OFF('outsideLookups');
  const cfg = await config();
  if (!cfg.ready) return C.NEEDS(LABEL, cfg.hint);
  if (await usedThisMonth() >= limitOf(cfg)) return { status: 429, error: `This month's look-ups (${limitOf(cfg)}) are used up (Administration > Integrations > People & company data provider).` };
  const r = await C.out(LABEL, C.joinUrl(cfg.values['API base URL'], path), { method: 'POST', headers: { authorization: `Bearer ${String(cfg.values['API key']).trim()}` }, json: body, secrets: [cfg.values['API key']] });
  await C.ensure();
  const results = r.ok ? Number(Array.isArray(r.body && (r.body.people || r.body.companies)) ? (r.body.people || r.body.companies).length : (r.body ? 1 : 0)) : 0;
  await x('INSERT INTO "AtsYLookup" ("id","kind","candidateId","query","results","outcome","userId","userName","at") VALUES (?,?,?,?,?,?,?,?,?)', newId(), kind, candidateId, JSON.stringify(body).slice(0, 400), results, r.ok ? 'ok' : 'failed', user.id, C.who(user), nowIso());
  if (!r.ok) return { status: 502, error: r.error };
  return { ok: true, body: r.body || {}, provider: cfg.values['Provider name'] || LABEL };
}
function readPerson(p) {
  const o = p && typeof p === 'object' ? p : {};
  const skills = Array.isArray(o.skills) ? o.skills.map((s) => txt(s, 40)).filter(Boolean) : String(o.skills || '').split(',').map((s) => txt(s, 40)).filter(Boolean);
  const exp = Number(o.experienceYears != null ? o.experienceYears : o.yearsOfExperience);
  return { id: txt(o.id, 80) || null, name: txt(o.name || [o.firstName, o.lastName].filter(Boolean).join(' '), 100), title: txt(o.title || o.jobTitle, 120) || null, company: txt(o.company || o.companyName, 120) || null, location: txt(o.location, 120) || null, skills, education: txt(o.education, 120) || null, experienceYears: Number.isFinite(exp) ? exp : null, profileUrl: txt(o.profileUrl || o.linkedinUrl, 300) || null };
}
async function searchOutside(user, f) {
  const body = { query: txt(f.query, 200), title: txt(f.title, 120) || null, company: txt(f.company, 120) || null, location: txt(f.location, 120) || null, skills: String(f.skills || '').split(',').map((s) => txt(s, 40)).filter(Boolean).slice(0, 10), limit: 25 };
  if (!body.query && !body.title && !body.skills.length) return { status: 400, error: 'Type the skills or job title to look for.' };
  const r = await lookup('search', user, '/v1/people/search', body);
  if (r.error) return r;
  const people = ((r.body.people || r.body.results || []).slice(0, 50)).map(readPerson).filter((p) => p.name);
  // already with us? (by the profile link, then by name + company)
  await require('../mkt/core').ensure(); // eslint-disable-line global-require
  for (const p of people) {
    // eslint-disable-next-line no-await-in-loop
    const hit = p.profileUrl ? (await q('SELECT "candidateId" FROM "MktCandLink" WHERE "url" = ?', p.profileUrl))[0] : null;
    p.inTeamLink = hit ? hit.candidateId : null;
  }
  return { provider: r.provider, people };
}
async function addFromOutside(user, person, requirementId, overrideReason) {
  const p = readPerson(person);
  if (!p.name) return { status: 400, error: 'Which person?' };
  const job = requirementId ? await prisma.requirement.findFirst({ where: { AND: [{ id: String(requirementId) }, require('../scope').requirementWhere(user)] }, select: { id: true, title: true } }) : null; // eslint-disable-line global-require
  if (!job) return { status: 400, error: 'Pick the requirement this person is for (they land in its pipeline).' };
  await require('../mkt/core').ensure(); // eslint-disable-line global-require
  let candidateId = p.profileUrl ? ((await q('SELECT "candidateId" FROM "MktCandLink" WHERE "url" = ?', p.profileUrl))[0] || {}).candidateId : null;
  const existed = !!candidateId;
  if (!candidateId) {
    const c = await prisma.candidate.create({ data: { name: p.name, currentDesignation: p.title, currentCompany: p.company, location: p.location, skills: p.skills.join(', ') || null, education: p.education, experienceYears: p.experienceYears, source: `Sourced (${txt(person && person.provider, 40) || LABEL})` } });
    candidateId = c.id;
    if (p.profileUrl) await x('INSERT OR IGNORE INTO "MktCandLink" ("candidateId","kind","url","createdAt","createdBy") VALUES (?,?,?,?,?)', c.id, /linkedin\.com/i.test(p.profileUrl) ? 'linkedin' : 'profile', p.profileUrl, nowIso(), C.who(user));
  }
  const a = await C.asUser(user, 'POST', '/applications', { candidateId, requirementId: job.id, comment: 'Sourced from the people-data provider', overrideReason: overrideReason ? txt(overrideReason, 300) : undefined });
  await C.logAudit({ userId: user.id, action: 'Sourced profile added (outside people data)', entity: 'Candidate', entityId: candidateId, toValue: job.title });
  return { ok: true, candidateId, existed, application: a.status < 300 ? { ok: true } : { ok: false, status: a.status, error: (a.body && a.body.error) || 'Not added to the requirement.', code: a.body && a.body.code, needsReason: /say why/i.test(String(a.body && a.body.error)) } };
}

// ================================================================== 09.06 contact finding
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_RE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/g;
const digits = (p) => String(p || '').replace(/\D/g, '').slice(-10);
async function ownContacts(c) {
  const have = { email: lower(c.email), phone: digits(c.phone), alt: digits(c.alternatePhone) };
  const out = [];
  const add = (kind, value, from, verified = false) => {
    const v = kind === 'email' ? lower(value).trim() : digits(value);
    if (!v || (kind === 'email' ? v === have.email : (v === have.phone || v === have.alt)) || out.some((o) => o.kind === kind && o.value === v)) return;
    if (kind === 'phone' && v.length !== 10) return;
    out.push({ kind, value: v, from, verified });
  };
  const res = await prisma.candidateResume.findFirst({ where: { candidateId: c.id, kind: 'ORIGINAL', hiddenAt: null }, orderBy: { createdAt: 'desc' }, select: { text: true } }).catch(() => null);
  const text = String((res && res.text) || '');
  (text.match(EMAIL_RE) || []).slice(0, 5).forEach((e) => add('email', e, 'their own resume'));
  (text.match(PHONE_RE) || []).slice(0, 5).forEach((p) => add('phone', p, 'their own resume'));
  // another TeamLink record of the same person: the same profile link, or the same name at the same employer
  await require('../mkt/core').ensure(); // eslint-disable-line global-require
  const links = await q('SELECT "url" FROM "MktCandLink" WHERE "candidateId" = ?', c.id);
  const twins = new Set();
  for (const l of links) (await q('SELECT "candidateId" FROM "MktCandLink" WHERE "url" = ? AND "candidateId" <> ?', l.url, c.id)).forEach((r) => twins.add(r.candidateId)); // eslint-disable-line no-await-in-loop
  if (c.currentCompany && c.name) {
    const same = await prisma.candidate.findMany({ where: { name: c.name, id: { not: c.id } }, select: { id: true, currentCompany: true }, take: 20 });
    same.filter((s) => C.normCo(s.currentCompany) && C.normCo(s.currentCompany) === C.normCo(c.currentCompany)).forEach((s) => twins.add(s.id));
  }
  if (twins.size) {
    const rows = await prisma.candidate.findMany({ where: { id: { in: [...twins] } }, select: { email: true, phone: true } });
    rows.forEach((r) => { add('email', r.email, 'another TeamLink record of the same person'); add('phone', r.phone, 'another TeamLink record of the same person'); });
  }
  const sent = await prisma.candidateMessage.findMany({ where: { candidateId: c.id, status: { in: ['SENT', 'DELIVERED', 'READ'] } }, select: { recipient: true, channel: true }, take: 50 }).catch(() => []);
  sent.forEach((m) => { if (/@/.test(m.recipient || '')) add('email', m.recipient, `a ${m.channel} TeamLink sent before`); else add('phone', m.recipient, `a ${m.channel} TeamLink sent before`); });
  if (c.alternatePhone && !c.phone) add('phone', c.alternatePhone, 'the alternate phone on the profile');
  return out;
}
async function findContacts(user, candidateId, { outside = false } = {}) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: candidateId }] }, select: { id: true, name: true, email: true, phone: true, alternatePhone: true, currentCompany: true, currentDesignation: true } });
  if (!c) return { status: 404, error: 'Candidate not found (or not in your scope).' };
  const found = await ownContacts(c);
  let provider = null; let outsideError = null;
  if (outside) {
    const links = await q('SELECT "url" FROM "MktCandLink" WHERE "candidateId" = ? AND "kind" = \'linkedin\' LIMIT 1', c.id).catch(() => []);
    const r = await lookup('contact', user, '/v1/people/contact', { name: c.name, company: c.currentCompany || null, title: c.currentDesignation || null, linkedinUrl: (links[0] || {}).url || null }, c.id);
    if (r.error) outsideError = r.error; else {
      provider = r.provider;
      const list = (v) => (Array.isArray(v) ? v : []);
      list(r.body.emails).forEach((e) => { const v = lower(e && (e.value || e.email)); if (v && v !== lower(c.email) && !found.some((f) => f.value === v)) found.push({ kind: 'email', value: v, from: provider, verified: !!(e.verified || e.status === 'verified') }); });
      list(r.body.phones).forEach((p) => { const v = digits(p && (p.value || p.number)); if (v.length === 10 && v !== digits(c.phone) && !found.some((f) => f.value === v)) found.push({ kind: 'phone', value: v, from: provider, verified: !!(p.verified || p.status === 'verified') }); });
    }
  }
  return { candidate: { id: c.id, name: c.name, hasEmail: !!c.email, hasPhone: !!c.phone }, found, provider, outsideError, outside: await outsideState(), note: 'Our own records are looked at first. Nothing is saved until you press Save.' };
}
async function saveContact(user, candidateId, { kind, value }) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: candidateId }] }, select: { id: true, email: true, phone: true, alternatePhone: true } });
  if (!c) return { status: 404, error: 'Candidate not found (or not in your scope).' };
  let data = null;
  if (kind === 'email') { const v = lower(value).trim(); if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(v)) return { status: 400, error: 'That is not an e-mail address.' }; data = c.email ? null : { email: v }; if (!data) return { status: 409, error: 'The profile already has an e-mail. Change it on the profile if this one is right.' }; }
  else if (kind === 'phone') { const v = digits(value); if (v.length !== 10) return { status: 400, error: 'A mobile number is 10 digits.' }; data = !c.phone ? { phone: v } : (!c.alternatePhone ? { alternatePhone: v } : null); if (!data) return { status: 409, error: 'The profile already has a phone and an alternate phone.' }; }
  else return { status: 400, error: 'E-mail or phone.' };
  await prisma.candidate.update({ where: { id: c.id }, data });
  try { require('../candidateListCache').markCandidateDirty(c.id); } catch { /* optional */ } // eslint-disable-line global-require
  await C.logAudit({ userId: user.id, action: `Contact found and saved (${Object.keys(data)[0]})`, entity: 'Candidate', entityId: c.id, toValue: kind === 'email' ? C.maskMail(Object.values(data)[0]) : C.maskPhone(Object.values(data)[0]) });
  return { ok: true, saved: Object.keys(data)[0] };
}

// ================================================================== 03.12 enrichment from outside
const FIELDS = { location: 'location', currentCompany: 'company', currentDesignation: 'title', education: 'education', experienceYears: 'experienceYears', skills: 'skills' };
async function enrichOutside(user, candidateId) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: candidateId }] } });
  if (!c) return { status: 404, error: 'Candidate not found (or not in your scope).' };
  await require('../mkt/core').ensure(); // eslint-disable-line global-require
  const links = await q('SELECT "url" FROM "MktCandLink" WHERE "candidateId" = ? AND "kind" = \'linkedin\' LIMIT 1', c.id).catch(() => []);
  const r = await lookup('enrich', user, '/v1/people/enrich', { name: c.name, email: c.email || null, company: c.currentCompany || null, title: c.currentDesignation || null, linkedinUrl: (links[0] || {}).url || null }, c.id);
  if (r.error) return r;
  const p = readPerson(r.body.person || r.body.profile || r.body);
  const proposals = [];
  Object.entries(FIELDS).forEach(([field, key]) => {
    let v = p[key];
    if (field === 'skills') {
      const have = new Set(String(c.skills || '').split(',').map((s) => lower(s.trim())).filter(Boolean));
      const more = (p.skills || []).filter((s) => !have.has(lower(s))).slice(0, 10);
      if (!more.length) return;
      v = [...String(c.skills || '').split(',').map((s) => s.trim()).filter(Boolean), ...more].join(', ');
      proposals.push({ field, current: c.skills || null, value: v, from: `${r.provider} (${more.length} more)` });
      return;
    }
    if (v == null || v === '') return;
    if (c[field] == null || c[field] === '') proposals.push({ field, current: null, value: v, from: r.provider });
  });
  // a different employer / title than ours: a job change to look at (never applied on its own)
  let change = null;
  if ((p.company && c.currentCompany && C.normCo(p.company) !== C.normCo(c.currentCompany)) || (p.title && c.currentDesignation && lower(p.title) !== lower(c.currentDesignation))) {
    change = await require('./jobWatch').record(c, { company: p.company || c.currentCompany, title: p.title || c.currentDesignation }, r.provider, 'Seen at the people-data provider'); // eslint-disable-line global-require
  }
  if (p.profileUrl) await x('INSERT OR IGNORE INTO "MktCandLink" ("candidateId","kind","url","createdAt","createdBy") VALUES (?,?,?,?,?)', c.id, /linkedin\.com/i.test(p.profileUrl) ? 'linkedin' : 'profile', p.profileUrl, nowIso(), r.provider);
  return { provider: r.provider, proposals, jobChange: change, note: 'Only EMPTY fields are proposed. Nothing is saved until you press Save.' };
}
async function applyOutside(user, candidateId, fields, provider) {
  const c = await prisma.candidate.findFirst({ where: { AND: [scopeW(user), { id: candidateId }] } });
  if (!c) return { status: 404, error: 'Candidate not found (or not in your scope).' };
  const data = {};
  Object.entries(fields || {}).forEach(([k, v]) => {
    if (!FIELDS[k]) return;
    if (k === 'experienceYears') { const n = Number(v); if (Number.isFinite(n) && n >= 0 && n < 60 && c[k] == null) data[k] = n; return; }
    const s = txt(v, k === 'skills' ? 1000 : 120);
    if (s && (k === 'skills' || !c[k])) data[k] = s;
  });
  if (!Object.keys(data).length) return { status: 400, error: 'Nothing to save (only empty fields are filled).' };
  await prisma.candidate.update({ where: { id: c.id }, data });
  try { require('../candidateListCache').markCandidateDirty(c.id); } catch { /* optional */ } // eslint-disable-line global-require
  await C.logAudit({ userId: user.id, action: `Profile enriched from ${txt(provider, 60) || 'the people-data provider'}`, entity: 'Candidate', entityId: c.id, fromValue: JSON.stringify(Object.fromEntries(Object.keys(data).map((k) => [k, c[k]]))).slice(0, 300), toValue: JSON.stringify(data).slice(0, 300) });
  return { ok: true, updated: Object.keys(data) };
}

// ================================================================== 06.05 companies (prospecting uses the same provider)
async function companiesOutside(user, f) {
  const body = { industry: txt(f.industry, 80) || null, location: txt(f.location, 80) || null, hiringFor: txt(f.hiringFor, 120) || null, size: txt(f.size, 40) || null, limit: 25 };
  const r = await lookup('companies', user, '/v1/companies/search', body);
  if (r.error) return r;
  const list = (r.body.companies || r.body.results || []).slice(0, 50).map((o) => ({
    name: txt(o.name, 120), website: txt(o.website || o.domain, 200) || null, industry: txt(o.industry, 80) || null, city: txt(o.city || o.location, 80) || null, size: txt(o.size || o.employees, 40) || null,
    openJobs: Number(o.openJobs || o.jobCount) || 0,
    contacts: (Array.isArray(o.contacts) ? o.contacts : []).slice(0, 5).map((p) => ({ name: txt(p.name, 80), role: txt(p.title || p.role, 80), email: txt(p.email, 120), phone: txt(p.phone, 20), verified: !!p.verified })),
  })).filter((o) => o.name);
  return { provider: r.provider, companies: list };
}

module.exports = { graph, ownContacts, findContacts, saveContact, searchOutside, addFromOutside, enrichOutside, applyOutside, companiesOutside, outsideState, readPerson };
