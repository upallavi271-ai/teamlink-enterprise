// ---------------------------------------------------------------------------
// BUSINESS DEVELOPMENT INSIDE ATS CLIENTS (market benchmark 06.02 / 06.04 / 06.05 / 06.06 / 06.15) - ATS -> Clients -> "Business
// development". NOT the CRM (a separate application): this is the BDE's own list of target companies before they become clients.
//
//   06.05 ACCOUNT PROSPECTING   a list of target companies with contacts, notes and an owner BDE (no duplicate of a client / prospect)
//   06.02 BD PIPELINE           Prospect -> Meeting -> Proposal -> Agreement -> Won (linked to the real client) / Lost (with a reason)
//   06.06 HIRING SIGNALS        the company's own job postings (typed in, or the jobs it already gave us), our candidates working there,
//                               recent activity -> a 0-100 score with the reasons; for existing clients the requirement trend
//   06.15 AI CLIENT SUMMARY     facts built in code from the client's own record (jobs, joinings, follow-ups) -> utils/fastAi.js writes a
//                               short summary and a pitch; when the model is down the code's own words are shown. No candidate details.
//   06.04 OUTREACH CAMPAIGNS    a sequence of mails (day 0, day 3, ...) to the prospects' contacts, started by hand or when a prospect
//                               reaches a stage. OFF until an Admin switches it on; in the sandbox nothing is ever sent.
//
// Who: a BDE sees and works their own prospects (and the ones nobody owns); a BDE TL and an Admin see every prospect; a Manager /
// Assistant Manager sees everything and changes nothing. Recruiters and recruitment TLs have no BD list.
// ---------------------------------------------------------------------------
const express = require('express');
const prisma = require('../../db');
const { clientWhere, isBdeTl, atsViewRole } = require('../scope');
const { logAudit } = require('../audit');
const S = require('./store');

const STAGES = ['PROSPECT', 'MEETING', 'PROPOSAL', 'AGREEMENT', 'WON', 'LOST'];
const STAGE_LABEL = { PROSPECT: 'Prospect', MEETING: 'Meeting', PROPOSAL: 'Proposal', AGREEMENT: 'Agreement', WON: 'Won (client)', LOST: 'Lost' };
const norm = (s) => String(s || '').toLowerCase().replace(/\b(pvt|private|ltd|limited|llp|inc|india|technologies|technology|solutions|services)\b/g, '').replace(/[^a-z0-9]/g, '');

function bdAccess(u) {
  const v = atsViewRole(u);
  if (v === 'admin') return { all: true, write: true };
  if (v === 'mgmt') return { all: true, write: false };
  if (isBdeTl(u)) return { all: true, write: true };
  if (v === 'bde') return { all: false, write: true };
  return null;
}
function guard(req, res, next) {
  const a = bdAccess(req.user);
  if (!a) return res.status(403).json({ error: 'Business development is for the BDE team.' });
  req.bd = a;
  if (req.method !== 'GET' && (!a.write || req.viewAs)) return res.status(403).json({ error: 'You can see business development but not change it.' });
  return next();
}
const mine = (req, p) => req.bd.all || !p.ownerId || p.ownerId === req.user.id;

async function owners() {
  return prisma.user.findMany({ where: { status: 'Active', OR: [{ atsRole: 'BDE' }, { atsDepartment: 'BDE' }] }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
}

// ------------------------------------------------------------------ 06.06 signals -> score
async function scoreOf(p) {
  const reasons = []; let score = 0;
  const since90 = Date.now() - 90 * 86400000;
  const posts = (p.postings || []).filter((x) => new Date(x.postedAt || x.at || 0).getTime() >= since90);
  if (posts.length) {
    const openings = posts.reduce((a, x) => a + (Number(x.openings) || 1), 0);
    const pts = Math.min(40, posts.length * 8 + Math.min(openings, 20));
    score += pts; reasons.push(`${posts.length} job posting(s) in the last 90 days, ${openings} opening(s) (+${pts})`);
    const fresh = posts.filter((x) => new Date(x.postedAt || x.at || 0).getTime() >= Date.now() - 21 * 86400000).length;
    if (fresh) { score += 10; reasons.push(`${fresh} posted in the last 3 weeks (+10)`); }
    const roles = new Set(posts.map((x) => String(x.department || x.title || '').toLowerCase().split(/\s+/)[0]));
    if (roles.size >= 3) { score += 5; reasons.push(`hiring across ${roles.size} kinds of roles (+5)`); }
  }
  const key = norm(p.title);
  if (key.length >= 3) {
    const working = await prisma.candidate.count({ where: { currentCompany: { contains: p.title.split(/\s+/)[0] } } }).catch(() => 0);
    if (working) { const pts = Math.min(15, working); score += pts; reasons.push(`${working} of our candidates work there now - warm contacts (+${pts})`); }
  }
  if (p.clientId) {
    const reqs = await prisma.requirement.count({ where: { clientId: p.clientId, createdAt: { gte: new Date(since90) } } });
    if (reqs) { const pts = Math.min(20, reqs * 5); score += pts; reasons.push(`${reqs} requirement(s) with us in 90 days (+${pts})`); }
  }
  if ((p.contacts || []).some((c) => c.email || c.phone)) { score += 10; reasons.push('a hiring contact is known (+10)'); }
  const last = (p.notes || []).map((n) => n.at).sort().pop();
  if (last && new Date(last).getTime() >= Date.now() - 30 * 86400000) { score += 5; reasons.push('spoken to in the last 30 days (+5)'); }
  if (/expan|new office|funding|raised|launch|scal|new plant|growing/i.test([(p.notes || []).map((n) => n.text).join(' '), p.about || ''].join(' '))) { score += 10; reasons.push('notes mention expansion / funding (+10)'); }
  const stagePts = { MEETING: 5, PROPOSAL: 10, AGREEMENT: 15 }[p.status] || 0;
  if (stagePts) { score += stagePts; reasons.push(`already at ${STAGE_LABEL[p.status]} (+${stagePts})`); }
  score = Math.min(100, score);
  return { score, band: score >= 60 ? 'Hot' : score >= 30 ? 'Warm' : 'Cold', reasons: reasons.length ? reasons : ['No hiring signal yet. Add the job postings you see (Naukri, LinkedIn, their careers page).'] };
}
async function clientSignals(viewer) {
  const clients = await prisma.client.findMany({ where: clientWhere(viewer), select: { id: true, name: true, industry: true } });
  if (!clients.length) return [];
  const now = Date.now(); const d90 = new Date(now - 90 * 86400000); const d180 = new Date(now - 180 * 86400000);
  const reqs = await prisma.requirement.findMany({ where: { clientId: { in: clients.map((c) => c.id) }, createdAt: { gte: d180 } }, select: { clientId: true, createdAt: true, openings: true } });
  return clients.map((c) => {
    const mineR = reqs.filter((r) => r.clientId === c.id);
    const recent = mineR.filter((r) => r.createdAt >= d90); const before = mineR.filter((r) => r.createdAt < d90);
    const reasons = []; let score = 0;
    if (recent.length) { const pts = Math.min(50, recent.length * 10); score += pts; reasons.push(`${recent.length} new requirement(s) in 90 days (+${pts})`); }
    if (recent.length > before.length) { score += 20; reasons.push(`more than the 90 days before (${before.length}) - growing (+20)`); }
    if (!recent.length && before.length) reasons.push(`quiet: ${before.length} requirement(s) 3-6 months ago, none since - a call is due`);
    const openings = recent.reduce((a, r) => a + (Number(r.openings) || 1), 0);
    if (openings >= 5) { score += 15; reasons.push(`${openings} openings (+15)`); }
    return { clientId: c.id, name: c.name, industry: c.industry, score: Math.min(100, score), trend: recent.length - before.length, reasons };
  }).filter((x) => x.reasons.length).sort((a, b) => b.score - a.score).slice(0, 200);
}

// ------------------------------------------------------------------ 06.15 AI summary / pitch
async function clientFacts(viewer, clientId) {
  const c = await prisma.client.findFirst({ where: { AND: [{ id: clientId }, clientWhere(viewer)] }, select: { id: true, name: true, industry: true, location: true, agreementStatus: true, createdAt: true } });
  if (!c) return null;
  const reqs = await prisma.requirement.findMany({ where: { clientId }, select: { id: true, title: true, status: true, openings: true, createdAt: true, department: true }, orderBy: { createdAt: 'desc' }, take: 300 });
  const ids = reqs.map((r) => r.id);
  const joined = ids.length ? await prisma.application.count({ where: { requirementId: { in: ids }, stage: 'JOINED' } }) : 0;
  const shared = ids.length ? await prisma.applicationStageEvent.count({ where: { toStage: 'SHARED_WITH_CLIENT', application: { requirementId: { in: ids } } } }) : 0;
  const interviews = ids.length ? await prisma.applicationStageEvent.count({ where: { toStage: 'INTERVIEW_SCHEDULED', application: { requirementId: { in: ids } } } }) : 0;
  const LIVE = ['OPEN', 'RECRUITER_ASSIGNED', 'SOURCING', 'CANDIDATES_AVAILABLE'];
  const titles = {}; reqs.forEach((r) => { const t = String(r.title || '').trim(); if (t) titles[t] = (titles[t] || 0) + 1; });
  const year = reqs.filter((r) => r.createdAt >= new Date(Date.now() - 365 * 86400000));
  return {
    client: c.name, industry: c.industry || 'not set', city: c.location || 'not set', agreement: c.agreementStatus || 'not set', since: c.createdAt.toISOString().slice(0, 10),
    requirements: reqs.length, live: reqs.filter((r) => LIVE.includes(r.status)).length, lastYear: year.length, lastRequirement: reqs[0] ? reqs[0].createdAt.toISOString().slice(0, 10) : null,
    topRoles: Object.entries(titles).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t, n]) => `${t} (${n})`),
    sharedProfiles: shared, interviews, joinings: joined,
    interviewRate: shared ? Math.round((interviews * 100) / shared) : null, joinRate: shared ? Math.round((joined * 100) / shared) : null,
  };
}
function codeSummary(f) {
  const s = `${f.client} (${f.industry}, ${f.city}) has worked with us since ${f.since}: ${f.requirements} requirement(s), ${f.live} live now, ${f.lastYear} in the last 12 months. `
    + `We shared ${f.sharedProfiles} profile(s); ${f.interviews} got interviews and ${f.joinings} joined${f.joinRate !== null ? ` (${f.joinRate}% of shared)` : ''}. `
    + (f.topRoles.length ? `Roles they hire most: ${f.topRoles.join(', ')}.` : '');
  const pitch = `Dear ${f.client} team, over ${f.lastYear || f.requirements} recent requirement(s) we delivered ${f.joinings} joining(s)${f.topRoles.length ? `, mostly ${f.topRoles[0].replace(/ \(\d+\)$/, '')} roles` : ''}. `
    + `${f.live ? `We are working on ${f.live} open position(s) for you now. ` : 'We would like to support your next hiring. '}We can share screened profiles within 48 hours of a new requirement. Could we set up a 20-minute call this week?`;
  return { summary: s.trim(), pitch };
}
async function aiWrite(facts, user, kind) {
  const base = codeSummary(facts);
  try {
    const FA = require('../fastAi'); // eslint-disable-line global-require
    if (require('../sandbox').isSandbox() && !require('../sandbox').allowAi()) return { ...base, by: 'code', note: 'Written from the record (the AI is off in the test sandbox).' }; // eslint-disable-line global-require
    const r = await FA.chat('You write for a recruitment agency\'s business development team in India. Use ONLY the FACTS. Plain English, no made-up numbers. Reply as JSON {"summary": "...3 sentences...", "pitch": "...a short mail of 4-6 sentences to the client..."}.',
      [{ role: 'user', content: `FACTS:\n${JSON.stringify(facts)}` }], { json: true, maxTokens: 600, temperature: 0.2, timeoutMs: 15000, deadlineMs: 25000 });
    const j = JSON.parse(String(r.text).replace(/^```json|```$/g, '').trim());
    if (!j.summary || !j.pitch) throw new Error('empty');
    await logAudit({ userId: user.id, action: `AI ${kind} written`, entity: 'Client', entityId: facts.clientId || null, toValue: `${r.provider} ${r.model}` });
    return { summary: String(j.summary).slice(0, 2000), pitch: String(j.pitch).slice(0, 3000), by: `AI (${r.provider})` };
  } catch (e) {
    return { ...base, by: 'code', note: 'The AI did not answer, so this is written from the record.' };
  }
}

// ------------------------------------------------------------------ 06.04 campaigns
const OUTREACH_KEY = 'bdOutreach';
async function outreachSettings() { return S.settings.get(OUTREACH_KEY, { enabled: false, dailyLimit: 50 }); }
function fill(text, p, contact) {
  return String(text || '').replace(/\{\{\s*(company|name|owner)\s*\}\}/g, (_, k) => ({ company: p.title, name: (contact && contact.name) || 'there', owner: p.ownerName || 'our team' }[k]));
}
// due mails of every ACTIVE campaign; dryRun = say what would go, send nothing
async function runCampaigns({ dryRun = false, user = null } = {}) {
  const set = await outreachSettings();
  const out = { enabled: !!set.enabled, sandbox: S.sandbox(), due: [], sent: 0, skipped: 0 };
  const camps = await S.items.list('bd-campaign', { status: 'ACTIVE' });
  for (const c of camps) {
    for (const enr of (c.enrolled || [])) {
      const p = await S.items.get(enr.prospectId, 'prospect'); // eslint-disable-line no-await-in-loop
      if (!p || ['WON', 'LOST'].includes(p.status) || p.optOut) continue; // eslint-disable-line no-continue
      const done = new Set(enr.sentSteps || []);
      const startAt = new Date(enr.at).getTime();
      const step = (c.steps || []).find((s, i) => !done.has(i) && Date.now() >= startAt + (Number(s.day) || 0) * 86400000);
      if (!step) continue; // eslint-disable-line no-continue
      const idx = c.steps.indexOf(step);
      const contact = (p.contacts || []).find((x) => x.email);
      if (!contact) { out.skipped += 1; continue; } // eslint-disable-line no-continue
      const mail = { campaignId: c.id, prospectId: p.id, company: p.title, to: contact.email, subject: fill(step.subject, p, contact), step: idx };
      out.due.push(mail);
      if (dryRun || !set.enabled || out.sent >= (Number(set.dailyLimit) || 50)) continue; // eslint-disable-line no-continue
      let status = 'SANDBOX - not sent';
      if (!S.sandbox()) {
        const r = await require('../mailer').sendMail({ to: contact.email, subject: mail.subject, text: fill(step.body, p, contact) }).catch((e) => ({ ok: false, error: e.message })); // eslint-disable-line global-require, no-await-in-loop
        status = r.ok ? 'SENT' : `NOT SENT: ${r.error || 'mail is not set up'}`;
      }
      enr.sentSteps = [...done, idx];
      await S.items.create('bd-send', { refType: 'Prospect', refId: p.id, status, campaignId: c.id, to: contact.email, subject: mail.subject, step: idx }, user); // eslint-disable-line no-await-in-loop
      out.sent += 1;
    }
    if (!dryRun && out.enabled) await S.items.update(c.id, { enrolled: c.enrolled }); // eslint-disable-line no-await-in-loop
  }
  return out;
}
// a prospect reaching a stage joins every active campaign that starts on that stage
async function stageTrigger(p, stage) {
  const camps = await S.items.list('bd-campaign', { status: 'ACTIVE' });
  for (const c of camps.filter((x) => x.startOnStage === stage)) {
    const enrolled = c.enrolled || [];
    if (enrolled.some((e) => e.prospectId === p.id)) continue; // eslint-disable-line no-continue
    await S.items.update(c.id, { enrolled: [...enrolled, { prospectId: p.id, at: new Date().toISOString(), sentSteps: [] }] }); // eslint-disable-line no-await-in-loop
  }
}
let timer = null;
function startWorker() {
  if (timer || S.sandbox()) return;
  timer = setInterval(async () => { try { if ((await outreachSettings()).enabled) await runCampaigns(); } catch (e) { console.error('[bd-outreach]', e.message); } }, 15 * 60000);
  if (timer.unref) timer.unref();
}

// ------------------------------------------------------------------ routes
const router = express.Router();
const send = (res, r) => res.status(r.status || 200).json(r);
function cleanProspect(b, partial) {
  const o = {};
  if (!partial || 'name' in b) { const n = String(b.name || '').trim(); if (n.length < 2) return { error: 'Type the company name.' }; o.title = n.slice(0, 120); }
  ['industry', 'city', 'website', 'about', 'nextStep', 'source', 'size'].forEach((k) => { if (k in b) o[k] = String(b[k] || '').trim().slice(0, 500) || null; });
  if ('nextDate' in b) o.nextDate = /^\d{4}-\d{2}-\d{2}$/.test(String(b.nextDate || '')) ? b.nextDate : null;
  if ('value' in b) { const v = Number(b.value); o.value = Number.isFinite(v) && v >= 0 ? Math.round(v) : null; }
  if ('currency' in b) o.currency = /^[A-Z]{3}$/.test(String(b.currency || '')) ? b.currency : 'INR';
  if ('contacts' in b) o.contacts = (Array.isArray(b.contacts) ? b.contacts : []).slice(0, 10).map((c) => ({ name: String(c.name || '').slice(0, 80), role: String(c.role || '').slice(0, 80), email: String(c.email || '').trim().slice(0, 120), phone: String(c.phone || '').replace(/[^\d+]/g, '').slice(0, 15) })).filter((c) => c.name || c.email || c.phone);
  if ('optOut' in b) o.optOut = !!b.optOut;
  return { value: o };
}
async function view(p) { const s = await scoreOf(p); return { ...p, stageLabel: STAGE_LABEL[p.status] || p.status, ...s }; }

router.get('/bd/meta', guard, S.wrap(async (req, res) => res.json({ stages: STAGES.map((k) => ({ key: k, label: STAGE_LABEL[k] })), owners: await owners(), canWrite: req.bd.write && !req.viewAs, all: req.bd.all, outreach: await outreachSettings(), canSwitch: S.isAdmin(req.user) && !req.viewAs })));
router.get('/bd/prospects', guard, S.wrap(async (req, res) => {
  let rows = await S.items.list('prospect', {});
  rows = rows.filter((p) => mine(req, p));
  if (req.query.stage) rows = rows.filter((p) => p.status === req.query.stage);
  if (req.query.owner) rows = rows.filter((p) => p.ownerId === req.query.owner);
  if (req.query.q) { const q = String(req.query.q).toLowerCase(); rows = rows.filter((p) => `${p.title} ${p.industry || ''} ${p.city || ''}`.toLowerCase().includes(q)); }
  const out = []; for (const p of rows) out.push(await view(p)); // eslint-disable-line no-await-in-loop
  const board = STAGES.map((k) => ({ key: k, label: STAGE_LABEL[k], count: out.filter((p) => p.status === k).length, value: out.filter((p) => p.status === k).reduce((a, p) => a + (p.value || 0), 0) }));
  res.json({ rows: out.sort((a, b) => b.score - a.score), board });
}));
router.post('/bd/prospects', guard, S.wrap(async (req, res) => {
  const b = req.body || {};
  const c = cleanProspect(b, false);
  if (c.error) return res.status(400).json({ error: c.error });
  const key = norm(c.value.title);
  if (!b.force) {
    const clients = await prisma.client.findMany({ select: { id: true, name: true } });
    const hitC = clients.find((x) => norm(x.name) === key);
    if (hitC) return res.status(409).json({ error: `${hitC.name} is already a client. Open it from Clients instead.`, clientId: hitC.id, code: 'IS_CLIENT' });
    const hitP = (await S.items.list('prospect', {})).find((x) => norm(x.title) === key);
    if (hitP) return res.status(409).json({ error: `${hitP.title} is already on the prospect list${hitP.ownerName ? ` (owner: ${hitP.ownerName})` : ''}.`, prospectId: hitP.id, code: 'DUPLICATE' });
  }
  let ownerId = req.user.id; let ownerName = req.user.name;
  if (b.ownerId && req.bd.all) { const o = await prisma.user.findUnique({ where: { id: String(b.ownerId) }, select: { id: true, name: true } }); if (o) { ownerId = o.id; ownerName = o.name; } }
  const p = await S.items.create('prospect', { ...c.value, status: 'PROSPECT', ownerId, ownerName, notes: [], postings: [], history: [{ at: new Date().toISOString(), by: req.user.name, to: 'PROSPECT' }] }, req.user);
  await logAudit({ userId: req.user.id, action: 'BD prospect added', entity: 'Prospect', entityId: p.id, toValue: p.title });
  res.status(201).json(await view(p));
}));
async function load(req, res) {
  const p = await S.items.get(req.params.id, 'prospect');
  if (!p || !mine(req, p)) { res.status(404).json({ error: 'That prospect is not in your list.' }); return null; }
  return p;
}
router.get('/bd/prospects/:id', guard, S.wrap(async (req, res) => { const p = await load(req, res); if (p) res.json(await view(p)); }));
router.put('/bd/prospects/:id', guard, S.wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const c = cleanProspect(req.body || {}, true);
  if (c.error) return res.status(400).json({ error: c.error });
  const patch = { ...c.value };
  if ((req.body || {}).ownerId && req.bd.all) { const o = await prisma.user.findUnique({ where: { id: String(req.body.ownerId) }, select: { id: true, name: true } }); if (o) { patch.ownerId = o.id; patch.ownerName = o.name; } }
  res.json(await view(await S.items.update(p.id, patch)));
}));
router.post('/bd/prospects/:id/stage', guard, S.wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const b = req.body || {}; const to = String(b.stage || '');
  if (!STAGES.includes(to)) return res.status(400).json({ error: 'Pick a stage.' });
  const note = String(b.note || '').trim();
  if (to === 'LOST' && note.length < 3) return res.status(400).json({ error: 'Say why it was lost.' });
  let clientId = p.clientId || null;
  if (to === 'WON') {
    if (!b.clientId) return res.status(400).json({ error: 'Won means they are a client now: pick the client (add it in Clients first if it is new).' });
    const cl = await prisma.client.findUnique({ where: { id: String(b.clientId) }, select: { id: true } });
    if (!cl) return res.status(400).json({ error: 'That client is not there.' });
    clientId = cl.id;
  }
  const history = [...(p.history || []), { at: new Date().toISOString(), by: req.user.name, from: p.status, to, note: note || null }];
  const out = await S.items.update(p.id, { status: to, history, clientId, lostReason: to === 'LOST' ? note : (p.lostReason || null) });
  await logAudit({ userId: req.user.id, action: `BD prospect moved to ${STAGE_LABEL[to]}`, entity: 'Prospect', entityId: p.id, fromValue: p.status, toValue: to, reason: note || null });
  await stageTrigger(out, to);
  res.json(await view(out));
}));
router.post('/bd/prospects/:id/notes', guard, S.wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const text = String((req.body || {}).text || '').trim();
  if (text.length < 2) return res.status(400).json({ error: 'Write the note.' });
  res.json(await view(await S.items.update(p.id, { notes: [...(p.notes || []), { at: new Date().toISOString(), by: req.user.name, text: text.slice(0, 2000) }] })));
}));
router.post('/bd/prospects/:id/postings', guard, S.wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const b = req.body || {};
  const title = String(b.title || '').trim();
  if (title.length < 2) return res.status(400).json({ error: 'Type the job title they posted.' });
  const postedAt = /^\d{4}-\d{2}-\d{2}$/.test(String(b.postedAt || '')) ? b.postedAt : new Date().toISOString().slice(0, 10);
  const row = { title: title.slice(0, 120), department: String(b.department || '').slice(0, 60) || null, openings: Math.max(1, Math.min(500, Number(b.openings) || 1)), source: String(b.source || 'Typed in').slice(0, 60), url: /^https?:\/\//.test(String(b.url || '')) ? String(b.url).slice(0, 300) : null, postedAt, by: req.user.name };
  res.json(await view(await S.items.update(p.id, { postings: [...(p.postings || []), row] })));
}));
router.delete('/bd/prospects/:id', guard, S.wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  if (!req.bd.all && p.ownerId !== req.user.id) return res.status(403).json({ error: 'Only the owner or a BDE TL removes a prospect.' });
  await S.items.remove(p.id);
  await logAudit({ userId: req.user.id, action: 'BD prospect removed', entity: 'Prospect', entityId: p.id, toValue: p.title, reason: String((req.body || {}).reason || '').slice(0, 200) || null });
  res.json({ ok: true });
}));
router.get('/bd/signals/clients', guard, S.wrap(async (req, res) => res.json({ rows: await clientSignals(req.user), note: 'Existing clients scored on their own requirements: more new jobs than the 3 months before = growing; quiet ones are flagged for a call.' })));
router.get('/bd/clients/:id/summary', guard, S.wrap(async (req, res) => {
  const f = await clientFacts(req.user, req.params.id);
  if (!f) return res.status(404).json({ error: 'That client is not in your list.' });
  res.json({ facts: f, ...(await aiWrite({ ...f, clientId: req.params.id }, req.user, 'client summary')) });
}));
router.get('/bd/prospects/:id/pitch', guard, S.wrap(async (req, res) => {
  const p = await load(req, res); if (!p) return;
  const s = await scoreOf(p);
  const facts = { client: p.title, industry: p.industry || 'not set', city: p.city || 'not set', since: 'new prospect', requirements: 0, live: 0, lastYear: 0, topRoles: (p.postings || []).map((x) => x.title).slice(0, 5), sharedProfiles: 0, interviews: 0, joinings: 0, joinRate: null, signals: s.reasons };
  const w = await aiWrite(facts, req.user, 'prospect pitch');
  if (w.by === 'code') w.pitch = `Dear ${p.title} team, we noticed you are hiring${facts.topRoles.length ? ` for ${facts.topRoles.slice(0, 3).join(', ')}` : ''}. We are a recruitment partner with a ready pool of screened candidates in ${p.city || 'your city'} and can share profiles within 48 hours. Could we set up a 20-minute call this week?`;
  res.json({ ...w, score: s });
}));
// campaigns
router.get('/bd/campaigns', guard, S.wrap(async (req, res) => {
  const rows = await S.items.list('bd-campaign', {});
  const sends = await S.items.list('bd-send', {}, { limit: 500 });
  res.json({ rows: rows.map((c) => ({ ...c, enrolledCount: (c.enrolled || []).length, sent: sends.filter((s) => s.campaignId === c.id).length })), recent: sends.slice(0, 50), settings: await outreachSettings() });
}));
router.post('/bd/campaigns', guard, S.wrap(async (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (name.length < 3) return res.status(400).json({ error: 'Name the campaign.' });
  const steps = (Array.isArray(b.steps) ? b.steps : []).slice(0, 8).map((s) => ({ day: Math.max(0, Math.min(90, Number(s.day) || 0)), subject: String(s.subject || '').slice(0, 200), body: String(s.body || '').slice(0, 5000) })).filter((s) => s.subject && s.body);
  if (!steps.length) return res.status(400).json({ error: 'Add at least one mail (subject and text).' });
  const c = await S.items.create('bd-campaign', { title: name.slice(0, 120), status: 'DRAFT', steps, startOnStage: STAGES.includes(b.startOnStage) ? b.startOnStage : null, enrolled: [], ownerId: req.user.id }, req.user);
  await logAudit({ userId: req.user.id, action: 'BD campaign created', entity: 'Campaign', entityId: c.id, toValue: c.title });
  res.status(201).json(c);
}));
router.post('/bd/campaigns/:id/enrol', guard, S.wrap(async (req, res) => {
  const c = await S.items.get(req.params.id, 'bd-campaign'); if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  const ids = (Array.isArray((req.body || {}).prospectIds) ? req.body.prospectIds : []).map(String);
  const enrolled = [...(c.enrolled || [])];
  for (const id of ids) {
    const p = await S.items.get(id, 'prospect'); // eslint-disable-line no-await-in-loop
    if (p && mine(req, p) && !enrolled.some((e) => e.prospectId === id)) enrolled.push({ prospectId: id, at: new Date().toISOString(), sentSteps: [] });
  }
  res.json(await S.items.update(c.id, { enrolled }));
}));
router.post('/bd/campaigns/:id/status', guard, S.wrap(async (req, res) => {
  const c = await S.items.get(req.params.id, 'bd-campaign'); if (!c) return res.status(404).json({ error: 'Campaign not found.' });
  const st = String((req.body || {}).status || '');
  if (!['DRAFT', 'ACTIVE', 'PAUSED'].includes(st)) return res.status(400).json({ error: 'Active, Paused or Draft.' });
  await logAudit({ userId: req.user.id, action: `BD campaign ${st.toLowerCase()}`, entity: 'Campaign', entityId: c.id, toValue: c.title });
  res.json(await S.items.update(c.id, { status: st }));
}));
router.post('/bd/campaigns/run', guard, S.wrap(async (req, res) => {
  const dry = !!(req.body || {}).dryRun;
  if (!dry && !S.isAdmin(req.user)) return res.status(403).json({ error: 'Only an Admin sends the due mails by hand.' });
  res.json(await runCampaigns({ dryRun: dry, user: req.user }));
}));
router.put('/bd/outreach-settings', S.adminOnly, S.wrap(async (req, res) => {
  const b = req.body || {}; const cur = await outreachSettings();
  const next = { enabled: 'enabled' in b ? !!b.enabled : cur.enabled, dailyLimit: Math.max(1, Math.min(500, Number(b.dailyLimit) || cur.dailyLimit || 50)) };
  await S.settings.set(OUTREACH_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: `BD outreach mails ${next.enabled ? 'switched ON' : 'switched OFF'}`, entity: 'AtsPlusSetting', entityId: OUTREACH_KEY, toValue: JSON.stringify(next) });
  res.json(next);
}));

module.exports = { router, scoreOf, clientSignals, clientFacts, runCampaigns, startWorker, STAGES };
