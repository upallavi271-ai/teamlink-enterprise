// ---------------------------------------------------------------------------
// TEAM POP-UPS (founder 2026-11-27: "kothaga candidate vachina, kothaga req vachina, client add ayina, interview vunnai, join ayina, reject ayina,
// ey kind of movement ayina, ey chinnadhi ayina, display meedha popup avvali - recruiters ki, TLs ki, admin ki, super admin ki, developer ki,
// BDE ki, BDE TL ki, evaraikaina sarey").
//
// Every ATS change, whichever screen, import or sync made it, is seen ONCE here (a Prisma hook in db.js): a new application (a new candidate on a
// requirement), a step move, an interview booked or moved, a joining, a rejection, a joining dropped, a new requirement, a new client. It becomes an
// update in utils/atsUpdates.js - the same pop-up stack (top right, every page), bell row and audit as the client updates - for everyone concerned:
// the job's recruiters and TLs, its response recipients, the candidate's owner, the client's BDEs, the BDE TLs and the Admins / Super Admins
// (the Developer login is a Super Admin). Each person is checked against their OWN scope, and the person who made the change is not told.
// A burst (a bulk move, an import, a portal sync) is ONE pop-up per requirement and kind ("12 new candidates on REQ-0899") - changes are gathered for
// a few seconds first. A change a client made is already a client update: it is not told twice.
// Pop-up only by default (no mail): Administration > Step timing > Client updates switches each kind's pop-up / mail.
// Off in tests (TEST_MODE) unless TEAM_POPUPS=on.
// ---------------------------------------------------------------------------
const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();
/** Who is making this request (middleware/auth.js requireAuth). Everything the request writes is "by" them. */
function enter(user) { if (user && user.id) als.enterWith({ id: user.id, name: user.name || null }); }
const actorNow = () => als.getStore() || null;

const on = () => process.env.TEAM_POPUPS === 'on' || (process.env.TEAM_POPUPS !== 'off' && !process.env.TEST_MODE && process.env.NODE_ENV !== 'test');
const WAIT = () => Number(process.env.TEAM_POPUPS_WAIT_MS) || 6000;
const WATCH_FIELDS = ['stage', 'interviewAt', 'joiningStatus'];
const plain = (v) => (v && typeof v === 'object' && !(v instanceof Date) && 'set' in v ? v.set : v);

// ---- the gathering -----------------------------------------------------------------------------------------------------
const queue = new Map();
function add(type, { requirementId = null, clientId = null, applicationId = null, to = '' } = {}) {
  if (!on()) return;
  const a = actorNow();
  const key = `${type}|${requirementId || clientId || applicationId || ''}|${to}|${a ? a.id : ''}`;
  let g = queue.get(key);
  if (!g) {
    g = { type, requirementId, clientId, to, actor: a, apps: [] };
    queue.set(key, g);
    g.timer = setTimeout(() => { queue.delete(key); flush(g).catch((e) => console.error('[team-popups]', e.message)); }, WAIT()); // eslint-disable-line no-console
    if (g.timer.unref) g.timer.unref();
  }
  if (applicationId && !g.apps.includes(applicationId) && g.apps.length < 1000) g.apps.push(applicationId);
}

// ---- the Prisma hook (db.js) ---------------------------------------------------------------------------------------------
function watches(params) {
  if (!on()) return false;
  if (params.model === 'Application') {
    if (params.action === 'create') return true;
    if (params.action === 'update' || params.action === 'updateMany') {
      const d = (params.args && params.args.data) || {};
      return WATCH_FIELDS.some((k) => d[k] !== undefined);
    }
    return false;
  }
  return (params.model === 'Requirement' || params.model === 'Client') && params.action === 'create';
}
// what the rows were before the write (a step move is told only when the step really changed)
async function before(params) {
  if (params.model !== 'Application' || params.action === 'create') return null;
  const prisma = require('../db'); // eslint-disable-line global-require
  const select = { id: true, stage: true, interviewAt: true, joiningStatus: true, requirementId: true };
  if (params.action === 'update') { const r = await prisma.application.findUnique({ where: params.args.where, select }); return r ? [r] : []; }
  return prisma.application.findMany({ where: params.args.where || {}, select, take: 500 });
}
const sameTime = (a, b) => (a ? new Date(a).getTime() : 0) === (b ? new Date(b).getTime() : 0);
function stageType(stage) {
  if (stage === 'JOINED' || stage === 'HIRED') return 'team_joined';
  if (stage === 'REJECTED') return 'team_rejected';
  if (stage === 'INTERVIEW_SCHEDULED') return 'team_interview';
  return 'team_move';
}
function after(params, result, was) {
  if (!on()) return;
  if (params.model === 'Requirement') { if (result && result.id) add('team_requirement', { requirementId: result.id }); return; }
  if (params.model === 'Client') { if (result && result.id && !result.marketingOnly) add('team_client', { clientId: result.id }); return; }
  if (params.action === 'create') { if (result && result.id) add('team_candidate', { requirementId: result.requirementId, applicationId: result.id }); return; }
  const d = (params.args && params.args.data) || {};
  const stage = plain(d.stage); const at = plain(d.interviewAt); const js = plain(d.joiningStatus);
  for (const b of was || []) {
    const told = new Set();
    if (typeof stage === 'string' && stage !== b.stage) {
      const t = stageType(stage);
      told.add(t);
      add(t, { requirementId: b.requirementId, applicationId: b.id, to: t === 'team_move' ? stage : '' });
    }
    if (at && !sameTime(at, b.interviewAt) && !told.has('team_interview')) { told.add('team_interview'); add('team_interview', { requirementId: b.requirementId, applicationId: b.id }); }
    if (typeof js === 'string' && js !== b.joiningStatus) {
      if (js === 'Joined' && !told.has('team_joined')) add('team_joined', { requirementId: b.requirementId, applicationId: b.id });
      if (js === 'Dropped') add('team_move', { requirementId: b.requirementId, applicationId: b.id, to: 'DROPPED' });
    }
  }
}

// ---- one pop-up per gathered group ----------------------------------------------------------------------------------------
const WHEN = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
async function flush(g) {
  const prisma = require('../db'); // eslint-disable-line global-require
  const U = require('./atsUpdates'); // eslint-disable-line global-require
  const V = require('./atsVocab'); // eslint-disable-line global-require
  const actor = g.actor ? { id: g.actor.id, name: g.actor.name } : null;
  if (g.type === 'team_client') {
    const c = await prisma.client.findUnique({ where: { id: g.clientId }, select: { id: true, name: true, industry: true } }).catch(() => null);
    if (!c) return null;
    return U.publish({ type: 'team_client', title: `New client: ${c.name}`, summary: c.industry || '', open: `/clients/${c.id}`, actor, clientId: c.id });
  }
  const req = g.requirementId ? await prisma.requirement.findUnique({ where: { id: g.requirementId }, select: { id: true, reqCode: true, title: true, openings: true, location: true, client: { select: { id: true, name: true } } } }).catch(() => null) : null;
  if (!req) return null;
  const reqWords = `${req.reqCode ? `${req.reqCode} ` : ''}${req.title}${req.client ? ` (${req.client.name})` : ''}`;
  if (g.type === 'team_requirement') {
    return U.publish({ type: 'team_requirement', title: `New requirement: ${reqWords}`, summary: [req.openings ? `${req.openings} opening${req.openings === 1 ? '' : 's'}` : '', req.location].filter(Boolean).join(' · '), open: `/requirements/${req.id}`, actor, requirementId: req.id, clientId: req.client && req.client.id });
  }
  let apps = await prisma.application.findMany({ where: { id: { in: g.apps } }, select: { id: true, stage: true, interviewAt: true, interviewMode: true, candidateId: true, candidate: { select: { name: true } } } }).catch(() => []);
  // what a client did is already a client update: not told twice
  if (apps.length) {
    const since = new Date(Date.now() - 3 * 60000).toISOString();
    const done = await prisma.$queryRawUnsafe(`SELECT DISTINCT "applicationId" AS "id" FROM "AtsUpdateEvent" WHERE "type" LIKE 'client_%' AND "createdAt" >= ? AND "applicationId" IN (${apps.map(() => '?').join(',')})`, since, ...apps.map((a) => a.id)).catch(() => []);
    const skip = new Set(done.map((r) => r.id));
    apps = apps.filter((a) => !skip.has(a.id));
  }
  if (!apps.length) return null;
  const one = apps.length === 1 ? apps[0] : null;
  const name = one ? ((one.candidate && one.candidate.name) || 'A candidate') : '';
  const n = apps.length;
  const names = apps.slice(0, 4).map((a) => (a.candidate && a.candidate.name) || '?').join(', ') + (n > 4 ? ` and ${n - 4} more` : '');
  const stepWord = g.to === 'DROPPED' ? 'Joining dropped' : V.stageLabel(g.to);
  const T = {
    team_candidate: one ? [`New candidate: ${name}`, `On ${reqWords}`] : [`${n} new candidates on ${req.reqCode || req.title}`, `${names} · ${reqWords}`],
    team_move: one ? [`${name} → ${stepWord}`, reqWords] : [`${n} people → ${stepWord}`, `${names} · ${reqWords}`],
    team_interview: one ? [`Interview: ${name}`, `${one.interviewAt ? `${WHEN(one.interviewAt)}${one.interviewMode ? ` · ${one.interviewMode}` : ''} · ` : ''}${reqWords}`] : [`${n} interviews booked`, `${names} · ${reqWords}`],
    team_joined: one ? [`Joined: ${name} 🎉`, reqWords] : [`${n} joined 🎉`, `${names} · ${reqWords}`],
    team_rejected: one ? [`Rejected: ${name}`, reqWords] : [`${n} rejected`, `${names} · ${reqWords}`],
  }[g.type];
  if (!T) return null;
  return U.publish({
    type: g.type, title: T[0], summary: T[1], actor, requirementId: req.id, clientId: req.client && req.client.id,
    applicationId: one ? one.id : null, candidateId: one ? one.candidateId : null, open: one && one.candidateId ? `/candidates/${one.candidateId}` : `/requirements/${req.id}`,
  });
}
/** Tests: send what is gathered now, without waiting. */
async function flushAll() {
  const groups = [...queue.values()]; queue.clear();
  groups.forEach((g) => clearTimeout(g.timer));
  const out = [];
  for (const g of groups) out.push(await flush(g)); // eslint-disable-line no-await-in-loop
  return out;
}

module.exports = { enter, actorNow, watches, before, after, add, flushAll, on };
