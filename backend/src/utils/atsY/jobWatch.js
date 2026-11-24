// ---------------------------------------------------------------------------
// SELF-UPDATING RECORDS / JOB-CHANGE ALERTS (ATS wave 2 Y, benchmark 03.13). TeamLink watches each candidate's employer and job title
// and records every change it sees, with WHERE it was seen:
//   * the person's own update (the profile-update link, utils/mktb/cands.js)              -> already on the record
//   * a new application of a person already on file (Job Portal / Naukri / Shine / foundit / LinkedIn, utils/jobPortalBridge.js) -> to apply
//   * their career history (Career tab: a "current" job that is not the profile's employer) -> to apply
//   * a connected source (the people-data provider, utils/atsY/people.js enrichOutside)    -> to apply
//   * an edit of the profile in TeamLink (the last employer / title seen differs)          -> already on the record
// A change "to apply" waits for a recruiter: Apply (the profile takes the new employer / title, a note is written) or Dismiss.
// Bells to the person's recruiters only with the Admin switch "jobChangeAlerts" (OFF by default). Nothing is looked up on the web.
// ---------------------------------------------------------------------------
const prisma = require('../../db');
const C = require('./core');

const { q, x, nowIso, newId, txt, lower } = C;
const same = (a, b) => (C.normCo(a) || lower(a).trim()) === (C.normCo(b) || lower(b).trim());

async function notifyOwners(c, text) {
  if (!(await C.switchOn('jobChangeAlerts'))) return 0;
  const apps = await prisma.application.findMany({ where: { candidateId: c.id }, select: { ownerRecruiterId: true, requirement: { select: { recruiterId: true } } }, take: 30 });
  const ids = [...new Set(apps.flatMap((a) => [a.ownerRecruiterId, a.requirement && a.requirement.recruiterId]).filter(Boolean))];
  if (!ids.length || C.isSandbox()) return ids.length;
  await require('../notify').notifyUsers(ids, { title: `Job change: ${c.name}`, message: text, open: `/candidates/${c.id}?tab=tools` }).catch(() => {}); // eslint-disable-line global-require
  return ids.length;
}

// one change seen -> a row (the same change from the same source is kept once). applied = already on the record.
async function record(c, to, source, detail, { applied = false } = {}) {
  await C.ensure();
  const toCompany = txt(to.company, 120) || null; const toTitle = txt(to.title, 120) || null;
  const companyMoved = toCompany && !same(toCompany, c.currentCompany);
  const titleMoved = toTitle && lower(toTitle) !== lower(c.currentDesignation);
  if (!applied && !companyMoved && !titleMoved) return null;
  const id = newId();
  const n = await x(`INSERT OR IGNORE INTO "AtsYJobChange" ("id","candidateId","fromCompany","toCompany","fromTitle","toTitle","source","detail","status","applied","seenAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    id, c.id, to.fromCompany !== undefined ? to.fromCompany : (c.currentCompany || null), toCompany, to.fromTitle !== undefined ? to.fromTitle : (c.currentDesignation || null), toTitle, txt(source, 80), txt(detail, 300) || null, applied ? 'Applied' : 'New', applied ? 1 : 0, nowIso());
  if (!Number(n)) return null;
  const text = `${c.name}: ${[companyMoved || applied ? `now at ${toCompany || '-'}` : null, titleMoved ? `as ${toTitle}` : null].filter(Boolean).join(' ')} (seen: ${source}).`;
  await notifyOwners(c, text);
  return { id, candidateId: c.id, toCompany, toTitle, source };
}

// the employer / title last seen: a difference means the profile was edited (or updated by the person) since
async function seen(c) {
  await C.ensure();
  const row = (await q('SELECT * FROM "AtsYJobSeen" WHERE "candidateId" = ?', c.id))[0];
  if (row && (!same(row.company, c.currentCompany) || lower(row.title) !== lower(c.currentDesignation)) && (c.currentCompany || c.currentDesignation)) {
    await record(c, { company: c.currentCompany, title: c.currentDesignation, fromCompany: row.company, fromTitle: row.title }, 'Profile edited in TeamLink', null, { applied: true });
  }
  await x('INSERT INTO "AtsYJobSeen" ("candidateId","company","title","at") VALUES (?,?,?,?) ON CONFLICT("candidateId") DO UPDATE SET "company"=excluded."company","title"=excluded."title","at"=excluded."at"', c.id, c.currentCompany || null, c.currentDesignation || null, nowIso());
}

// a pass over the sources (every 6 hours on the server; "Check now" for a lead)
async function sweep({ limit = 3000 } = {}) {
  await C.ensure();
  let found = 0;
  // 1. their own updates through the profile link
  try {
    await require('../mktb/store').ensure(); // eslint-disable-line global-require
    const links = await q('SELECT "candidateId","usedAt","changes" FROM "MktUpdateLink" WHERE "usedAt" IS NOT NULL AND "usedAt" > ? ORDER BY "usedAt" DESC LIMIT 500', new Date(Date.now() - 90 * 864e5).toISOString());
    for (const l of links) {
      const ch = C.json(l.changes, {}) || {};
      if (!ch.currentCompany && !ch.currentDesignation) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const c = await prisma.candidate.findUnique({ where: { id: l.candidateId }, select: { id: true, name: true, currentCompany: true, currentDesignation: true } });
      if (!c) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      const r = await record(c, { company: ch.currentCompany ? ch.currentCompany.to : c.currentCompany, title: ch.currentDesignation ? ch.currentDesignation.to : c.currentDesignation, fromCompany: ch.currentCompany ? ch.currentCompany.from : c.currentCompany, fromTitle: ch.currentDesignation ? ch.currentDesignation.from : c.currentDesignation }, 'Their own update (profile link)', null, { applied: true });
      if (r) found += 1;
    }
  } catch { /* the update links are optional */ }
  // 2. their career history: a "current" job that is not the profile's employer
  try {
    await require('../candidateProfileDepth').ensure(); // eslint-disable-line global-require
    const cur = await q('SELECT "candidateId","company","title","updatedAt","createdAt" FROM "CandidateEmployment" WHERE "isCurrent" = 1 ORDER BY COALESCE("updatedAt","createdAt") DESC LIMIT ?', limit);
    const ids = [...new Set(cur.map((r) => r.candidateId))];
    const cands = ids.length ? await prisma.candidate.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, currentCompany: true, currentDesignation: true } }) : [];
    const by = new Map(cands.map((c) => [c.id, c]));
    for (const r of cur) {
      const c = by.get(r.candidateId);
      if (!c || !r.company || !c.currentCompany || same(r.company, c.currentCompany)) continue; // eslint-disable-line no-continue
      // eslint-disable-next-line no-await-in-loop
      if (await record(c, { company: r.company, title: r.title }, 'Career history (Career tab)', 'The "current" job in the career history is not the profile\'s employer.')) found += 1;
    }
  } catch { /* the career tab is optional */ }
  // 3. profile edits since the last look (and the first look of everybody else)
  const recent = await prisma.candidate.findMany({ where: { OR: [{ currentCompany: { not: null } }, { currentDesignation: { not: null } }] }, select: { id: true, name: true, currentCompany: true, currentDesignation: true }, orderBy: { createdAt: 'desc' }, take: limit });
  for (const c of recent) await seen(c); // eslint-disable-line no-await-in-loop
  return { found };
}

async function list(user, { status = 'New', limit = 200 } = {}) {
  await C.ensure();
  const rows = await q(`SELECT * FROM "AtsYJobChange" ${status === 'all' ? '' : 'WHERE "status" = ?'} ORDER BY "seenAt" DESC LIMIT ?`, ...(status === 'all' ? [] : [status]), Math.min(1000, Number(limit) || 200));
  const ids = [...new Set(rows.map((r) => r.candidateId))];
  const ok = ids.length ? new Map((await prisma.candidate.findMany({ where: { AND: [require('../scope').candidateWhere(user), { id: { in: ids } }] }, select: { id: true, name: true } })).map((c) => [c.id, c.name])) : new Map(); // eslint-disable-line global-require
  return rows.filter((r) => ok.has(r.candidateId)).map((r) => ({ id: r.id, candidateId: r.candidateId, name: ok.get(r.candidateId), fromCompany: r.fromCompany, toCompany: r.toCompany, fromTitle: r.fromTitle, toTitle: r.toTitle, source: r.source, detail: r.detail, status: r.status, applied: !!Number(r.applied), seenAt: r.seenAt, decidedBy: r.decidedBy, decidedAt: r.decidedAt }));
}
async function ofCandidate(candidateId) {
  await C.ensure();
  return (await q('SELECT * FROM "AtsYJobChange" WHERE "candidateId" = ? ORDER BY "seenAt" DESC LIMIT 20', candidateId)).map((r) => ({ id: r.id, fromCompany: r.fromCompany, toCompany: r.toCompany, fromTitle: r.fromTitle, toTitle: r.toTitle, source: r.source, status: r.status, seenAt: r.seenAt }));
}
async function decide(user, id, decision) {
  await C.ensure();
  const r = (await q('SELECT * FROM "AtsYJobChange" WHERE "id" = ?', String(id || '')))[0];
  if (!r) return { status: 404, error: 'Not found.' };
  const c = await prisma.candidate.findFirst({ where: { AND: [require('../scope').candidateWhere(user), { id: r.candidateId }] }, select: { id: true, name: true, currentCompany: true, currentDesignation: true } }); // eslint-disable-line global-require
  if (!c) return { status: 404, error: 'Not found (or not in your scope).' };
  if (r.status !== 'New') return { status: 409, error: `Already ${r.status.toLowerCase()}.` };
  if (decision === 'apply') {
    const data = {};
    if (r.toCompany && !same(r.toCompany, c.currentCompany)) data.currentCompany = r.toCompany;
    if (r.toTitle && lower(r.toTitle) !== lower(c.currentDesignation)) data.currentDesignation = r.toTitle;
    if (Object.keys(data).length) {
      await prisma.candidate.update({ where: { id: c.id }, data });
      try { require('../candidateListCache').markCandidateDirty(c.id); } catch { /* optional */ } // eslint-disable-line global-require
      await prisma.candidateNote.create({ data: { candidateId: c.id, body: `Job change applied (seen: ${r.source}): ${c.currentCompany || '-'} / ${c.currentDesignation || '-'} -> ${data.currentCompany || c.currentCompany || '-'} / ${data.currentDesignation || c.currentDesignation || '-'}`.slice(0, 2000), authorUserId: user.id, authorName: user.name, authorRole: user.atsRole || user.role } }).catch(() => {});
      await x('INSERT INTO "AtsYJobSeen" ("candidateId","company","title","at") VALUES (?,?,?,?) ON CONFLICT("candidateId") DO UPDATE SET "company"=excluded."company","title"=excluded."title","at"=excluded."at"', c.id, data.currentCompany || c.currentCompany || null, data.currentDesignation || c.currentDesignation || null, nowIso());
    }
    await x('UPDATE "AtsYJobChange" SET "status" = \'Applied\', "applied" = 1, "decidedBy" = ?, "decidedAt" = ? WHERE "id" = ?', C.who(user), nowIso(), r.id);
    await C.logAudit({ userId: user.id, action: 'Job change applied to the profile', entity: 'Candidate', entityId: c.id, fromValue: `${c.currentCompany || '-'} / ${c.currentDesignation || '-'}`, toValue: `${r.toCompany || '-'} / ${r.toTitle || '-'} (${r.source})` });
    return { ok: true, updated: Object.keys(data) };
  }
  if (decision === 'dismiss') {
    await x('UPDATE "AtsYJobChange" SET "status" = \'Dismissed\', "decidedBy" = ?, "decidedAt" = ? WHERE "id" = ?', C.who(user), nowIso(), r.id);
    return { ok: true };
  }
  return { status: 400, error: 'Apply or dismiss.' };
}

let timer = null;
function start() {
  if (timer || C.isSandbox() || /^(1|true)$/i.test(String(process.env.TEST_MODE || ''))) return;
  const run = () => sweep().catch((e) => console.error('[atsY job-watch]', e.message)); // eslint-disable-line no-console
  setTimeout(run, 40 * 60e3).unref();
  timer = setInterval(run, 6 * 3600e3);
  if (timer.unref) timer.unref();
}

module.exports = { record, seen, sweep, list, ofCandidate, decide, start };
