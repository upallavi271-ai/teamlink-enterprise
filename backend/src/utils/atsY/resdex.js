// ---------------------------------------------------------------------------
// NAUKRI RESDEX INSIDE THE ATS (ATS wave 2 Y, benchmark 10.08 / IN-02): search Naukri's CV database without leaving TeamLink, bring a
// profile in WITH its CV onto a requirement, never twice, and log every download.
//
// Naukri publishes no Resdex API: the founder asks the Naukri account manager for Resdex API / partner access on the Resdex plan and puts
// the API address, key and secret in Administration > Integrations > Naukri Resdex. The contract below is what this connector sends; the
// onboarding team confirms or maps it (only searchBody() / readProfile() would change):
//   POST <base>/v1/search                    { keywords, location, minExperience, maxExperience, maxNoticeDays, maxCtcLakhs, page }
//        -> { total, profiles: [{ id, name, title, company, experienceYears, location, skills, ctc, noticePeriod, lastActive }] }   (no contact)
//   POST <base>/v1/profiles/<id>/download    -> { profile: { ...the same, email, phone, education, expectedCtc }, resume: { fileName, mime, base64 } }
//   headers  Authorization: Bearer <API key>;  X-TeamLink-Signature: sha256=<HMAC-SHA256 of the body with the secret key> when a secret is set
//
// RULES
//   * Search and download: a recruiter / TL / Admin who may add candidates (never the BDE team, never a view-only Manager).
//   * A profile already brought in (the Resdex id, then the e-mail / phone) is NOT downloaded again: the existing person is used, no credit spent.
//   * A daily download limit (Integrations card, default 50) for the whole company.
//   * Every search and download is logged (AtsYResdexLog) and audited; the person lands with Source "Naukri Resdex".
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const prisma = require('../../db');
const C = require('./core');

const LABEL = 'Naukri Resdex';
const { q, x, nowIso, newId, txt } = C;
async function config() {
  const s = await C.provider('naukri-resdex', ['API base URL', 'API key'], LABEL);
  if (!s.ready && !s.configured) s.hint = 'Naukri publishes no Resdex API. Ask your Naukri account manager for Resdex API / partner access on your Resdex plan, then add the API address, key and secret in Administration > Integrations > Naukri Resdex.';
  return s;
}
function headersFor(cfg, raw) {
  const h = { authorization: `Bearer ${String(cfg.values['API key']).trim()}` };
  const sec = String(cfg.values['Secret key'] || '').trim();
  if (sec) h['x-teamlink-signature'] = `sha256=${crypto.createHmac('sha256', sec).update(raw).digest('hex')}`;
  return h;
}
async function post(cfg, path, body) {
  const raw = JSON.stringify(body);
  return C.out(LABEL, C.joinUrl(cfg.values['API base URL'], path), { method: 'POST', headers: headersFor(cfg, raw), json: body, secrets: [cfg.values['API key'], cfg.values['Secret key']] });
}
const limitOf = (cfg) => { const n = Number(String(cfg.values['Daily download limit'] || '').replace(/\D/g, '')); return n > 0 ? Math.min(n, 5000) : 50; };
const dayStart = () => { const d = new Date(Date.now() + 5.5 * 3600e3); d.setUTCHours(0, 0, 0, 0); return new Date(d.getTime() - 5.5 * 3600e3).toISOString(); };
async function usedToday() { await C.ensure(); const r = (await q('SELECT COUNT(*) AS n FROM "AtsYResdexLog" WHERE "action" = \'download\' AND "at" >= ?', dayStart()))[0]; return Number((r && r.n) || 0); }

function searchBody(f) {
  const n = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
  return { keywords: txt(f.keywords, 300), location: txt(f.location, 120) || null, minExperience: n(f.minExperience), maxExperience: n(f.maxExperience), maxNoticeDays: n(f.maxNoticeDays), maxCtcLakhs: n(f.maxCtcLakhs), page: Math.max(1, Math.min(50, Number(f.page) || 1)) };
}
function readProfile(p) {
  const o = p && typeof p === 'object' ? p : {};
  const skills = Array.isArray(o.skills) ? o.skills.map((s) => txt(s, 40)).filter(Boolean).join(', ') : txt(o.skills, 1000);
  const exp = Number(o.experienceYears != null ? o.experienceYears : o.experience);
  return {
    id: txt(o.id || o.profileId || o.resdexId, 80), name: txt(o.name, 100), title: txt(o.title || o.designation, 120) || null, company: txt(o.company || o.currentCompany, 120) || null,
    experienceYears: Number.isFinite(exp) ? exp : null, location: txt(o.location || o.city, 120) || null, skills, ctc: txt(o.ctc || o.currentCtc, 40) || null, expectedCtc: txt(o.expectedCtc, 40) || null,
    noticePeriod: txt(o.noticePeriod, 40) || null, education: txt(o.education, 120) || null, lastActive: txt(o.lastActive || o.updatedAt, 40) || null,
    email: txt(o.email, 120).toLowerCase() || null, phone: txt(o.phone || o.mobile, 30) || null,
  };
}
async function knownIds(ids) {
  if (!ids.length) return new Map();
  await require('../mkt/core').ensure(); // eslint-disable-line global-require
  const rows = await q(`SELECT "candidateId","url" FROM "MktCandLink" WHERE "kind" = 'resdex' AND "url" IN (${ids.map(() => '?').join(',')})`, ...ids.map((i) => `resdex:${i}`));
  return new Map(rows.map((r) => [r.url.slice(7), r.candidateId]));
}

async function status() {
  const cfg = await config();
  return { ready: !!cfg.ready, hint: cfg.ready ? null : cfg.hint, dailyLimit: cfg.ready ? limitOf(cfg) : null, usedToday: await usedToday() };
}
async function search(user, filters) {
  const f = searchBody(filters || {});
  if (!f.keywords) return { status: 400, error: 'Type what you are looking for (skills, job title).' };
  const cfg = await config();
  if (!cfg.ready) return C.NEEDS(LABEL, cfg.hint);
  const r = await post(cfg, '/v1/search', f);
  if (!r.ok) return { status: 502, error: r.error };
  const list = ((r.body && (r.body.profiles || r.body.results || r.body.data)) || []).slice(0, 100).map(readProfile).filter((p) => p.id && p.name);
  const known = await knownIds(list.map((p) => p.id));
  await C.ensure();
  await x('INSERT INTO "AtsYResdexLog" ("id","action","query","results","userId","userName","at") VALUES (?,?,?,?,?,?,?)', newId(), 'search', JSON.stringify(f).slice(0, 500), list.length, user.id, C.who(user), nowIso());
  // the search answer never carries contact details, even if the board sent them
  return { total: Number(r.body && r.body.total) || list.length, page: f.page, profiles: list.map(({ email, phone, ...p }) => ({ ...p, inTeamLink: known.get(p.id) || null })) }; // eslint-disable-line no-unused-vars
}

async function bringIn(user, resdexId, { requirementId, overrideReason } = {}) {
  const rid = txt(resdexId, 80);
  if (!rid) return { status: 400, error: 'Which profile?' };
  const job = requirementId ? await prisma.requirement.findFirst({ where: { AND: [{ id: String(requirementId) }, require('../scope').requirementWhere(user)] }, select: { id: true, title: true } }) : null; // eslint-disable-line global-require
  if (!job && !C.isAdmin(user)) return { status: 400, error: 'Pick the requirement this person is for (they land in its pipeline, so your team sees them).' };
  const cfg = await config();
  if (!cfg.ready) return C.NEEDS(LABEL, cfg.hint);
  await C.ensure();
  // 1. brought in before: no new download, no credit
  let candidateId = (await knownIds([rid])).get(rid) || null;
  let duplicate = !!candidateId; let resumeSaved = false; let how = duplicate ? 'already in TeamLink (brought from Resdex before)' : null;
  const downloaded = !candidateId;
  if (!candidateId) {
    if (await usedToday() >= limitOf(cfg)) return { status: 429, error: `Today's Resdex download limit (${limitOf(cfg)}) is used up. It starts again tomorrow (Administration > Integrations > Naukri Resdex).` };
    const r = await post(cfg, `/v1/profiles/${encodeURIComponent(rid)}/download`, { reason: 'ATS import', by: C.who(user) });
    if (!r.ok) return { status: 502, error: r.error };
    const p = readProfile((r.body && (r.body.profile || r.body.data)) || r.body);
    if (!p.name) return { status: 502, error: `${LABEL} gave no profile for that id.` };
    // 2. the same person by e-mail / phone
    const found = (p.email || p.phone) ? await require('../jobPortalBridge').findCandidateByContact({ email: p.email, phone: p.phone }).catch(() => null) : null; // eslint-disable-line global-require
    if (found) { candidateId = found.id; duplicate = true; how = 'the same e-mail / phone is already in TeamLink'; } else {
      const c = await prisma.candidate.create({ data: {
        name: p.name, email: p.email, phone: p.phone, skills: p.skills || null, currentDesignation: p.title, currentCompany: p.company, experienceYears: p.experienceYears,
        location: p.location, noticePeriod: p.noticePeriod || null, currentSalary: p.ctc, expectedSalary: p.expectedCtc, education: p.education, source: 'Naukri Resdex', firstSource: 'Naukri',
      } });
      candidateId = c.id; how = 'new person';
      try { require('../candidateListCache').markCandidateDirty(c.id); } catch { /* optional */ } // eslint-disable-line global-require
    }
    const res = r.body && r.body.resume;
    if (res && res.base64) {
      const has = await prisma.candidateResume.count({ where: { candidateId, kind: 'ORIGINAL', hiddenAt: null } });
      if (!has) {
        try {
          await require('../resumeStore').saveOriginalResume({ candidateId, file: { data: Buffer.from(String(res.base64), 'base64'), filename: txt(res.fileName, 120) || `Resdex-${rid}.pdf`, contentType: res.mime || 'application/pdf' }, user, note: 'from Naukri Resdex' }); // eslint-disable-line global-require
          resumeSaved = true;
        } catch (e) { how += ` (the CV could not be saved: ${String(e.code || e.message).slice(0, 60)})`; }
      }
    }
    await x('INSERT OR IGNORE INTO "MktCandLink" ("candidateId","kind","url","createdAt","createdBy") VALUES (?,?,?,?,?)', candidateId, 'resdex', `resdex:${rid}`, nowIso(), C.who(user));
  }
  // 'download' = Naukri was asked for the CV (a credit is spent, even when the person turns out to be on file already); 'reuse' = no call
  await x('INSERT INTO "AtsYResdexLog" ("id","action","resdexId","candidateId","duplicate","userId","userName","at") VALUES (?,?,?,?,?,?,?,?)', newId(), downloaded ? 'download' : 'reuse', rid, candidateId, duplicate ? 1 : 0, user.id, C.who(user), nowIso());
  await C.logAudit({ userId: user.id, action: `Naukri Resdex profile ${downloaded ? 'downloaded' : 'reused (no new download)'}${duplicate ? ' - already on file' : ''}`, entity: 'Candidate', entityId: candidateId, toValue: `Resdex ${rid}${job ? ` -> ${job.title}` : ''}` });
  let application = null;
  if (job) {
    const a = await C.asUser(user, 'POST', '/applications', { candidateId, requirementId: job.id, comment: 'From Naukri Resdex', overrideReason: overrideReason || undefined });
    application = a.status < 300 ? { ok: true, id: (a.body && (a.body.id || (a.body.application && a.body.application.id))) || null } : { ok: false, status: a.status, error: (a.body && a.body.error) || 'Not added to the requirement.', code: a.body && a.body.code };
  }
  return { ok: true, candidateId, duplicate, how, resumeSaved, application };
}

async function log({ limit = 50 } = {}) {
  await C.ensure();
  const rows = await q('SELECT * FROM "AtsYResdexLog" ORDER BY "at" DESC LIMIT ?', Math.min(500, Number(limit) || 50));
  return rows.map((r) => ({ id: r.id, action: r.action, resdexId: r.resdexId, candidateId: r.candidateId, duplicate: !!Number(r.duplicate), query: C.json(r.query, null), results: r.results == null ? null : Number(r.results), userName: r.userName, at: r.at }));
}

module.exports = { status, search, bringIn, log, readProfile, LABEL };
