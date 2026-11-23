// ---------------------------------------------------------------------------
// WHAT COUNTS AS "INFORMATION FROM A CLIENT" (utils/atsUpdates.js publishes it).
//
// A client login may write through a short allow-list only (utils/externalPortalAuth.js), so watching those few routes
// after a 2xx answer catches every client-side event, whichever screen sent it:
//   POST /api/job-portal/client/applications/:id/decision      shortlist / reject / hold (feedback) or "request interview"
//   POST /api/ats/interviews/:id/client-feedback                 the client's interview feedback (also when the BDE types it in)
//   POST /api/portal/client/requirement-requests                 the client raises a requirement
//   POST /api/portal/client/requirement-approvals/:id/decide     the client confirms / asks to change a requirement
//   POST /api/portal/client/offers|joining/:applicationId/...    offer / joining confirmations
//   POST /api/portal/client/join-drop/:id/(drop|decision)        a drop reported / answered
//   POST /api/portal/client/concerns                             the client's comment / concern
// The portal login request and the signed agreement are published where they happen (routes/portalLogins.js,
// routes/agreementSeal.js). Nothing here can change the answer the client gets: the event is built after it.
// ---------------------------------------------------------------------------
const prisma = require('../db');

const id = '([A-Za-z0-9_-]{6,})';
const ROUTES = [
  [new RegExp(`^/api/job-portal/client/applications/${id}/decision$`), 'decision'],
  [new RegExp(`^/api/ats/interviews/${id}/client-feedback$`), 'interviewFeedback'],
  [/^\/api\/portal\/client\/requirement-requests$/, 'requirementRequest'],
  [new RegExp(`^/api/portal/client/requirement-approvals/${id}/decide$`), 'requirementDecide'],
  [new RegExp(`^/api/portal/client/(offers|joining)/${id}/(release|acknowledge|joined)$`), 'offer'],
  [new RegExp(`^/api/portal/client/join-drop/${id}/(drop|decision)$`), 'joinDrop'],
  [/^\/api\/portal\/client\/concerns\/?$/, 'concern'],
];
const isClient = (u) => !!u && ([u.role, u.atsRole].includes('CLIENT'));
const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

async function appFacts(applicationId) {
  const a = await prisma.application.findUnique({
    where: { id: applicationId },
    select: { id: true, candidateId: true, requirementId: true, candidate: { select: { name: true } }, requirement: { select: { id: true, title: true, clientId: true, internal: true, client: { select: { name: true } } } } },
  });
  if (!a) return null;
  const r = a.requirement || {};
  return { a, cand: (a.candidate && a.candidate.name) || 'a candidate', job: r.title || 'a requirement', client: r.internal ? 'TeamLink' : (r.client && r.client.name) || 'The client', clientId: r.clientId };
}
const appEvent = (f, extra) => ({ applicationId: f.a.id, requirementId: f.a.requirementId, candidateId: f.a.candidateId, clientId: f.clientId, open: `/candidates/${f.a.candidateId}?app=${f.a.id}`, ...extra });

const DECISION = {
  SHORTLIST: ['client_feedback', 'shortlisted'], REJECT: ['client_feedback', 'rejected'], HOLD: ['client_feedback', 'put on hold'], REQUEST_INTERVIEW: ['client_interview', 'asked to interview'],
};
async function build(kind, m, req, body) {
  const b = req.body || {};
  if (kind === 'decision') {
    const d = DECISION[String(b.decision || '').toUpperCase()];
    const f = d && await appFacts(m[1]);
    if (!f) return null;
    return appEvent(f, { type: d[0], title: `${f.client} ${d[1]} ${f.cand} (${f.job})`, summary: [b.reasonCategory, b.reasonDetail, b.comment].filter(Boolean).map((s) => clip(s, 200)).join(' · ') });
  }
  if (kind === 'interviewFeedback') {
    const f = await appFacts(m[1]);
    if (!f) return null;
    return appEvent(f, { type: 'client_feedback', title: `${f.client}: interview feedback on ${f.cand} (${f.job}) - ${clip(b.recommendation || 'feedback', 30)}`, summary: clip(b.overall || b.comment || '', 300) });
  }
  if (kind === 'requirementRequest') {
    const rid = body && body.id;
    if (!rid) return null;
    const r = await prisma.requirement.findUnique({ where: { id: rid }, select: { id: true, title: true, clientId: true, client: { select: { name: true } } } });
    if (!r) return null;
    return { type: 'client_requirement', requirementId: r.id, clientId: r.clientId, title: `${(r.client && r.client.name) || 'A client'} raised a requirement: ${r.title}`, summary: [b.openings ? `${b.openings} opening(s)` : null, b.location, b.experience].filter(Boolean).map((s) => clip(s, 80)).join(' · '), open: `/requirements/${r.id}` };
  }
  if (kind === 'requirementDecide') {
    const r = await prisma.requirement.findUnique({ where: { id: m[1] }, select: { id: true, title: true, clientId: true, client: { select: { name: true } } } });
    if (!r) return null;
    return { type: 'client_requirement', requirementId: r.id, clientId: r.clientId, title: `${(r.client && r.client.name) || 'The client'} ${b.approve === true ? 'confirmed' : 'asked to change'} the requirement ${r.title}`, summary: clip(b.note || '', 300), open: `/requirements/${r.id}` };
  }
  if (kind === 'offer') {
    const f = await appFacts(m[2]);
    if (!f) return null;
    const what = { 'offers|release': 'released the offer letter for', 'offers|acknowledge': 'acknowledged the offer of', 'joining|release': 'released the joining letter for', 'joining|joined': 'confirmed the joining of', 'offers|joined': 'confirmed the joining of', 'joining|acknowledge': 'acknowledged the joining of' }[`${m[1]}|${m[3]}`];
    return appEvent(f, { type: 'client_offer', title: `${f.client} ${what || 'updated'} ${f.cand} (${f.job})`, summary: clip(b.note || b.comment || '', 200) });
  }
  if (kind === 'joinDrop') {
    const rows = await prisma.$queryRawUnsafe('SELECT "applicationId" FROM "JoiningRecord" WHERE "id" = ?', m[1]).catch(() => []);
    const f = rows[0] && rows[0].applicationId ? await appFacts(rows[0].applicationId) : null;
    if (!f) return null;
    return appEvent(f, { type: 'client_offer', title: m[2] === 'drop' ? `${f.client} reported a drop: ${f.cand} (${f.job})` : `${f.client} answered on the drop of ${f.cand}: ${clip(b.decision || '', 60)}`, summary: clip(b.reason || b.comment || b.note || '', 300) });
  }
  if (kind === 'concern') {
    const u = req.user;
    const c = u && u.clientId ? await prisma.client.findUnique({ where: { id: u.clientId }, select: { id: true, name: true } }) : null;
    if (!c) return null;
    return { type: 'client_message', clientId: c.id, title: `${c.name} wrote: ${clip(b.subject || 'a message', 120)}`, summary: clip(b.details || '', 400), open: `/clients/${c.id}` };
  }
  return null;
}

function middleware(req, res, next) {
  if (req.method !== 'POST') return next();
  const p = String(req.originalUrl || '').split('?')[0].replace(/\/+$/, '');
  const hit = ROUTES.find(([re]) => re.test(p));
  if (!hit) return next();
  const [re, kind] = hit;
  const orig = res.json.bind(res);
  res.json = (body) => {
    // a client login only - except the interview feedback, which is the client's word also when the BDE types it in
    if (res.statusCode < 300 && !res.__cuDone && req.user && (isClient(req.user) || kind === 'interviewFeedback')) {
      res.__cuDone = true;
      const m = re.exec(p);
      const actor = { id: req.user.id, name: isClient(req.user) ? `${req.user.name} (client)` : req.user.name };
      setImmediate(async () => {
        try {
          const ev = await build(kind, m, req, body);
          if (ev) await require('./atsUpdates').publish({ ...ev, actor }); // eslint-disable-line global-require
        } catch (err) { console.error('[client updates]', err.message); } // eslint-disable-line no-console
      });
    }
    return orig(body);
  };
  return next();
}

module.exports = { middleware, ROUTES, build };
