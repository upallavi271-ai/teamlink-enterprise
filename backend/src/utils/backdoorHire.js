// ---------------------------------------------------------------------------
// BACKDOOR-HIRE DETECTION (market wave B 04.14; the report itself is builder A's - this is the shared util).
//
// A person we SENT to a client (Shared with client or any later step) who did NOT join through us, and who later shows up working at
// that same client, may have been hired around us (and without our fee). The signals, all from our own data (never scraped):
//   current company   the person's current company on file reads like the client's name
//   career history    a job at the client that starts after the day we shared them (utils/candidateProfileDepth.js employment rows)
//   own update        the person told us (profile-update link) they moved to the client
// Only shares within `months` (default 12) count. Nothing is decided here: the rows are signals for a person to look at.
//
//   detect({ clientId, since, months, candidateIds }) -> [{ candidateId, name, clientId, clientName, requirementId, requirementTitle,
//                                                        sharedAt, lastStage, signal, detail }]
// ---------------------------------------------------------------------------
const prisma = require('../db');

const SHARED = ['SHARED_WITH_CLIENT', 'CLIENT_REVIEW', 'CLIENT_SHORTLISTED', 'INTERVIEW_SCHEDULED', 'INTERVIEW_COMPLETED', 'SELECTED', 'OFFER', 'OFFER_ACCEPTED'];
const STOP = /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|company|co|india|technologies|technology|tech|solutions|services|hospitals?|group|the|and)\b/g;
const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(STOP, ' ').replace(/\s+/g, ' ').trim();
function sameCompany(a, b) {
  const x = key(a); const y = key(b);
  if (!x || !y || x.length < 3 || y.length < 3) return false;
  return x === y || (x.length >= 5 && y.includes(x)) || (y.length >= 5 && x.includes(y));
}
const monthNo = (m) => { const v = String(m || '').match(/^(\d{4})-(\d{2})/); return v ? Number(v[1]) * 12 + Number(v[2]) - 1 : null; };

async function detect({ clientId = null, since = null, months = 12, candidateIds = null } = {}) {
  const from = since ? new Date(since) : new Date(Date.now() - months * 30 * 864e5);
  const events = await prisma.applicationStageEvent.findMany({
    where: { toStage: { in: SHARED }, createdAt: { gte: from }, ...(clientId ? { application: { requirement: { clientId } } } : {}), ...(candidateIds ? { candidateId: { in: candidateIds } } : {}) },
    select: { applicationId: true, candidateId: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 20000,
  });
  const firstShare = new Map();
  events.forEach((e) => { if (!firstShare.has(e.applicationId)) firstShare.set(e.applicationId, e.createdAt); });
  if (!firstShare.size) return [];
  const apps = await prisma.application.findMany({
    where: { id: { in: [...firstShare.keys()] }, stage: { notIn: ['JOINED', 'HIRED'] }, requirement: { internal: false } },
    select: { id: true, stage: true, candidateId: true, candidate: { select: { id: true, name: true, currentCompany: true } }, requirement: { select: { id: true, title: true, clientId: true, client: { select: { name: true, legalName: true } } } } },
  });
  // a person who joined that client through us on another job is not a backdoor hire
  const joined = new Set((await prisma.application.findMany({ where: { candidateId: { in: apps.map((a) => a.candidateId) }, stage: { in: ['JOINED', 'HIRED'] } }, select: { candidateId: true, requirement: { select: { clientId: true } } } })).map((a) => `${a.candidateId}|${a.requirement.clientId}`));
  let jobs = [];
  try {
    await require('./candidateProfileDepth').ensure(); // eslint-disable-line global-require
    const ids = [...new Set(apps.map((a) => a.candidateId))];
    for (let i = 0; i < ids.length; i += 500) {
      const part = ids.slice(i, i + 500);
      // eslint-disable-next-line no-await-in-loop
      jobs = jobs.concat(await prisma.$queryRawUnsafe(`SELECT "candidateId","company","fromMonth" FROM "CandidateEmployment" WHERE "candidateId" IN (${part.map(() => '?').join(',')})`, ...part));
    }
  } catch { jobs = []; }
  let moves = [];
  try { moves = await prisma.$queryRawUnsafe('SELECT "candidateId","usedAt","changes" FROM "MktUpdateLink" WHERE "usedAt" IS NOT NULL'); } catch { moves = []; }
  const out = []; const seen = new Set();
  apps.forEach((a) => {
    const c = a.requirement.client || {};
    const k = `${a.candidateId}|${a.requirement.clientId}`;
    if (joined.has(k) || seen.has(k)) return;
    const names = [c.name, c.legalName].filter(Boolean);
    const sharedAt = firstShare.get(a.id);
    const row = { candidateId: a.candidateId, name: a.candidate.name, clientId: a.requirement.clientId, clientName: c.name, requirementId: a.requirement.id, requirementTitle: a.requirement.title, applicationId: a.id, sharedAt, lastStage: a.stage };
    const sharedM = sharedAt.getFullYear() * 12 + sharedAt.getMonth();
    if (names.some((n) => sameCompany(a.candidate.currentCompany, n))) { out.push({ ...row, signal: 'Current company', detail: `Current company on file is "${a.candidate.currentCompany}".` }); seen.add(k); return; }
    const job = jobs.find((j) => j.candidateId === a.candidateId && names.some((n) => sameCompany(j.company, n)) && (monthNo(j.fromMonth) == null || monthNo(j.fromMonth) >= sharedM));
    if (job) { out.push({ ...row, signal: 'Career history', detail: `Career history shows a job at "${job.company}" from ${job.fromMonth || 'an unknown month'}.` }); seen.add(k); return; }
    const mv = moves.find((m) => m.candidateId === a.candidateId && new Date(m.usedAt) > sharedAt && (() => { try { const ch = JSON.parse(m.changes || '{}'); return ch.currentCompany && names.some((n) => sameCompany(ch.currentCompany.to, n)); } catch { return false; } })());
    if (mv) { out.push({ ...row, signal: 'Own update', detail: 'The person told us through the update link that they now work there.' }); seen.add(k); }
  });
  return out;
}

module.exports = { detect, sameCompany, SHARED };
