// ---------------------------------------------------------------------------
// AI MARKETING > SEO ASSISTANT > SITES (2026-11-25). One "SEO site" per client: the website address, the kind of business, the REAL facts the copy writers need (name, city, areas, services, specialty, phone,
// address, hours, audience), up to 3 competitor websites, and how often TeamLink should audit the site by itself (off / weekly / monthly) with the score drop that rings a bell.
// Everything else of the assistant hangs on it: the saved audits (siteCheck.js table OmniMkSiteCheck, by client name), the recommendation tasks (seoTasks.js), the keywords (seoKeywords.js), the content
// (seoContent.js), the alerts (seoEvents.js) and the dashboard (seoDashboard.js). A site can start from a client plan (the name, the kind of business and the department come with it).
// HONEST BY DESIGN: the facts are typed by the team and nothing is read from Google or invented; a site that is switched off keeps its history. TeamLink never edits the client's website.
// saved: table OmniMkSeoSite; audit log "Omni-Channel AI Marketing: SEO site ...".
// ---------------------------------------------------------------------------
const S = require('../outreach/store');
const A = require('../outreach/access');
const CS = require('./clientServices');
const Site = require('./siteCheck');
const Packs = require('./industryPacks');
const Blog = require('./blogPlanner');
const Copy = require('./seoCopy');
const { logAudit } = require('../utils/audit');

const T = 'OmniMkSeoSite';
const DDL = [
  `CREATE TABLE IF NOT EXISTS "${T}" ("id" TEXT NOT NULL PRIMARY KEY, "clientName" TEXT NOT NULL DEFAULT '', "planId" TEXT, "url" TEXT NOT NULL, "industry" TEXT, "facts" TEXT, "competitors" TEXT, "schedule" TEXT NOT NULL DEFAULT 'off', "pages" INTEGER NOT NULL DEFAULT 5, "alertDrop" INTEGER NOT NULL DEFAULT 5, "nextRunAt" DATETIME NOT NULL DEFAULT 0, "lastRunAt" DATETIME NOT NULL DEFAULT 0, "lastScore" INTEGER, "lastCheckId" TEXT, "fails" INTEGER NOT NULL DEFAULT 0, "active" INTEGER NOT NULL DEFAULT 1, "department" TEXT, "createdById" TEXT, "createdByName" TEXT, "createdAt" DATETIME NOT NULL DEFAULT 0, "updatedAt" DATETIME NOT NULL DEFAULT 0)`,
  `CREATE INDEX IF NOT EXISTS "${T}_client" ON "${T}"("clientName", "active")`,
];
let okAt = 0;
async function ensure() { if (okAt && Date.now() - okAt < 600000) return true; try { for (const sql of DDL) await S.run(sql); okAt = Date.now(); return true; } catch (e) { console.error('[omni-mk] seo site schema:', e.message); return false; } } // eslint-disable-line no-await-in-loop, no-console

const SCHEDULES = { off: 0, weekly: 7, monthly: 30 }; // days between two audits
const DAY = 86400000;
const clean = Copy.clean;
const factsOut = (raw) => { const f = S.parse(raw, {}) || {}; const o = {}; for (const k of Copy.FACT_KEYS) o[k] = f[k] != null ? String(f[k]) : ''; return o; };
function rowOut(r) {
  const pack = Packs.PACKS[r.industry] || Packs.PACKS.other;
  return { id: r.id, clientName: r.clientName, planId: r.planId || null, url: r.url, industry: r.industry || 'other', industryLabel: pack.label, healthcare: pack.healthcare, facts: factsOut(r.facts), competitors: S.parse(r.competitors, []) || [],
    schedule: r.schedule || 'off', pages: S.num(r.pages) || 5, alertDrop: S.num(r.alertDrop) || 5, nextRunAt: S.num(r.nextRunAt) ? S.iso(r.nextRunAt) : null, lastRunAt: S.num(r.lastRunAt) ? S.iso(r.lastRunAt) : null,
    lastScore: r.lastScore == null ? null : S.num(r.lastScore), lastCheckId: r.lastCheckId || null, fails: S.num(r.fails), active: S.num(r.active) === 1, department: r.department || '', createdByName: r.createdByName || '', createdAt: S.iso(r.createdAt), updatedAt: S.iso(r.updatedAt) };
}
async function mine(u, id) { if (!(await ensure())) return null; const r = (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, S.clip(id, 60)))[0]; return r && A.mayDepartment(u, r.department || '') ? r : null; }
async function list(u) {
  if (!(await ensure())) return { error: 'The SEO sites could not be opened.', status: 500 };
  const rows = (await S.q(`SELECT * FROM "${T}" WHERE active = 1 ORDER BY clientName COLLATE NOCASE LIMIT 500`)).filter((r) => A.mayDepartment(u, r.department || ''));
  return { items: rows.map(rowOut), schedules: Object.keys(SCHEDULES), industries: Packs.INDUSTRIES };
}
async function get(u, id) { const r = await mine(u, id); return r ? { site: rowOut(r) } : { error: 'That SEO site was not found.', status: 404 }; }

// the facts the team already gave for a client elsewhere (the newest blog plan's inputs): a starting point for the form, never saved by itself
async function prefill(u, clientName) {
  const name = clean(clientName, 120); if (!name) return { facts: {}, industry: '', planId: null };
  let facts = {}; let industry = ''; let planId = null; let department = '';
  try {
    const r = (await S.q('SELECT inputs, industry FROM "OmniMkBlogPlan" WHERE LOWER(TRIM(clientName)) = ? ORDER BY createdAt DESC LIMIT 1', name.toLowerCase()))[0];
    if (r) { const inp = (S.parse(r.inputs, {}) || {}).inputs || {}; facts = { name: inp.name || name, city: inp.city || '', services: Array.isArray(inp.services) ? inp.services.join(', ') : (inp.services || ''), specialty: inp.specialty || '', phone: inp.phone || '' }; industry = r.industry || ''; facts.website = inp.website || ''; }
  } catch { /* no blog plan yet */ }
  for (const { raw } of await CS.activePlans()) if (raw.clientName.trim().toLowerCase() === name.toLowerCase() && A.mayDepartment(u, raw.department || '')) { planId = raw.id; department = raw.department || ''; if (!industry) industry = Blog.guessIndustry(raw.industry || ''); facts.name = facts.name || raw.clientName; if (!facts.phone && raw.contactPhone) facts.phone = raw.contactPhone; }
  return { facts, industry, planId, department, website: facts.website || '' };
}
// client plans that have no SEO site yet (to start one from)
async function fromPlans(u) {
  if (!(await ensure())) return { items: [] };
  const have = new Set((await S.q(`SELECT clientName FROM "${T}" WHERE active = 1`)).map((r) => String(r.clientName).trim().toLowerCase()));
  const items = []; for (const { raw } of await CS.activePlans()) { if (!A.mayDepartment(u, raw.department || '') || have.has(raw.clientName.trim().toLowerCase())) continue; items.push({ planId: raw.id, clientName: raw.clientName, industry: Blog.guessIndustry(raw.industry || ''), department: raw.department || '' }); }
  return { items: items.slice(0, 200) };
}

// the day of the next audit for a schedule: one period after the newest saved check of the client (an audit made today counts), else the next sweep
async function nextRun(u, clientName, schedule, now = Date.now()) {
  const days = SCHEDULES[schedule]; if (!days) return 0;
  let base = 0; try { const l = await Site.list(u, { clientName }); if (l.items && l.items[0]) base = Date.parse(l.items[0].createdAt) || 0; } catch { /* no saved check */ }
  return base ? Math.max(base + days * DAY, now) : now;
}

// b: { id?, clientName, planId, url, industry, facts: {...}, competitors: [urls], schedule, pages, alertDrop, department }
async function save(u, b = {}) {
  if (!(await ensure())) return { error: 'The SEO site could not be saved.', status: 500 };
  const old = b.id ? await mine(u, b.id) : null; if (b.id && !old) return { error: 'That SEO site was not found.', status: 404 };
  const clientName = clean(b.clientName != null ? b.clientName : old && old.clientName, 120); if (!clientName) return { error: 'Write the client name.', status: 400 };
  const cu = Site.cleanUrl(b.url != null ? b.url : old && old.url); if (cu.error) return cu;
  const dup = (await S.q(`SELECT id FROM "${T}" WHERE active = 1 AND LOWER(TRIM(clientName)) = ?`, clientName.toLowerCase()))[0]; if (dup && (!old || dup.id !== old.id)) return { error: 'That client already has an SEO site. Open it instead.', status: 409 };
  const industry = Packs.PACKS[b.industry] ? b.industry : (old && Packs.PACKS[old.industry] ? old.industry : Blog.guessIndustry(String(b.industry || '')));
  const fin = b.facts && typeof b.facts === 'object' ? b.facts : S.parse(old && old.facts, {}); const facts = {}; for (const k of Copy.FACT_KEYS) facts[k] = clean(fin[k], k === 'address' || k === 'services' || k === 'areas' || k === 'hours' ? 400 : 140);
  const compIn = Array.isArray(b.competitors) ? b.competitors : S.parse(old && old.competitors, []); const comps = [];
  for (const c of compIn.slice(0, 3)) { if (!clean(c, 300)) continue; const r = Site.cleanUrl(c); if (r.error) return { error: `Competitor website: ${r.error}`, status: 400 }; if (!comps.includes(r.url)) comps.push(r.url); }
  const schedule = SCHEDULES[b.schedule] != null ? b.schedule : (old ? old.schedule : 'off'); const pages = Math.max(1, Math.min(10, Math.round(Number(b.pages != null ? b.pages : old && old.pages)) || 5)); const alertDrop = Math.max(1, Math.min(50, Math.round(Number(b.alertDrop != null ? b.alertDrop : old && old.alertDrop)) || 5));
  const planId = b.planId != null ? (clean(b.planId, 60) || null) : (old ? old.planId : null); let dept = b.department != null ? clean(b.department, 60) : (old ? old.department : '');
  if (planId && !old) { const p = (await CS.activePlans()).find((x) => x.raw.id === planId); if (!p) return { error: 'That client plan was not found.', status: 404 }; if (!dept) dept = p.raw.department || ''; }
  if (dept && !A.mayDepartment(u, dept)) return { error: 'That department is not yours.', status: 403 };
  const now = Date.now(); const changed = !old || old.schedule !== schedule || clean(old.clientName, 120).toLowerCase() !== clientName.toLowerCase(); const next = schedule === 'off' ? 0 : (changed || !S.num(old.nextRunAt)) ? await nextRun(u, clientName, schedule, now) : S.num(old.nextRunAt);
  if (old) {
    await S.run(`UPDATE "${T}" SET clientName = ?, planId = ?, url = ?, industry = ?, facts = ?, competitors = ?, schedule = ?, pages = ?, alertDrop = ?, nextRunAt = ?, department = ?, updatedAt = ? WHERE id = ?`, clientName, planId, cu.url, industry, JSON.stringify(facts), JSON.stringify(comps), schedule, pages, alertDrop, next, dept || null, now, old.id);
    await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO site updated', entity: T, entityId: old.id, toValue: `${clientName}: ${cu.url}, audits ${schedule}` });
    return { site: rowOut((await S.q(`SELECT * FROM "${T}" WHERE id = ?`, old.id))[0]) };
  }
  const id = S.newId('sst');
  await S.run(`INSERT INTO "${T}" (id, clientName, planId, url, industry, facts, competitors, schedule, pages, alertDrop, nextRunAt, lastRunAt, department, createdById, createdByName, createdAt, updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?)`, id, clientName, planId, cu.url, industry, JSON.stringify(facts), JSON.stringify(comps), schedule, pages, alertDrop, next, dept || null, u.id, S.clip(u.name, 80), now, now);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO site added', entity: T, entityId: id, toValue: `${clientName}: ${cu.url}, audits ${schedule}` });
  return { site: rowOut((await S.q(`SELECT * FROM "${T}" WHERE id = ?`, id))[0]) };
}
// switch a site off: its history (audits, tasks, keywords) stays; it can be added again later
async function remove(u, id) {
  const r = await mine(u, id); if (!r) return { error: 'That SEO site was not found.', status: 404 };
  await S.run(`UPDATE "${T}" SET active = 0, nextRunAt = 0, updatedAt = ? WHERE id = ?`, Date.now(), r.id);
  await logAudit({ userId: u.id, actorName: u.name, action: 'Omni-Channel AI Marketing: SEO site removed', entity: T, entityId: r.id, toValue: r.clientName });
  return { ok: true };
}
// used by the audit runner and the scheduler: patch the bookkeeping columns
async function setRun(id, p) {
  const cols = []; const args = [];
  for (const [k, v] of Object.entries(p)) { if (!['lastRunAt', 'lastScore', 'lastCheckId', 'fails', 'nextRunAt'].includes(k)) continue; cols.push(`${k} = ?`); args.push(v); }
  if (!cols.length) return; await S.run(`UPDATE "${T}" SET ${cols.join(', ')}, updatedAt = ? WHERE id = ?`, ...args, Date.now(), id);
}
async function dueSites(now = Date.now(), limit = 3) { if (!(await ensure())) return []; return S.q(`SELECT * FROM "${T}" WHERE active = 1 AND schedule != 'off' AND nextRunAt > 0 AND nextRunAt <= ? ORDER BY nextRunAt LIMIT ?`, now, limit); }
async function raw(id) { if (!(await ensure())) return null; return (await S.q(`SELECT * FROM "${T}" WHERE id = ?`, id))[0] || null; }

module.exports = { ensure, list, get, save, remove, prefill, fromPlans, mine, rowOut, setRun, dueSites, raw, nextRun, SCHEDULES, DAY, factsOut };
