// ---------------------------------------------------------------------------
// CONTRACT STAFFING, the outside doors (ATS wave 2, builder X).
//   clientRouter     /api/portal/client/contract     a client login approves / rejects its contractors' weeks and sees their shifts
//                                                    (the bill side only: hours and the amount billed, never a pay rate or margin)
//   candidateRouter  /api/portal/candidate/contract  a placed contractor fills in and sends their own weeks, sees their shifts
//                                                    (their own pay rate, never the bill rate)
//   stubRouter       /api/public/stfx-stub           TEST SANDBOX ONLY: a pretend VMS (Beeline / Fieldglass / VNDLY / generic),
//                                                    a pretend webhook receiver and a pretend Zoho Books, so the connectors are
//                                                    tested end to end without any outside account. Not mounted outside the sandbox.
// The client / candidate wall (utils/externalPortalAuth.js) already lets these two logins reach /api/portal/client/* and
// /api/portal/candidate/* only; each route below is also pinned to the login's own company / own record.
// ---------------------------------------------------------------------------
const express = require('express');
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const S = require('../utils/staffingX/store');
const K = require('../utils/staffingX/contracts');
const T = require('../utils/staffingX/timesheets');
const SH = require('../utils/staffingX/shifts');

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out, ok = 200) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.status(ok).json(out));
const isClient = (u) => !!u && (u.role === 'CLIENT' || u.atsRole === 'CLIENT') && !!u.clientId;
const isCandidate = (u) => !!u && (u.role === 'CANDIDATE' || u.atsRole === 'CANDIDATE') && !!u.candidateId;
const viewOnlyAs = (req) => require('../utils/viewAs').isViewingAs && require('../utils/viewAs').isViewingAs(req); // eslint-disable-line global-require

// ---- the client ---------------------------------------------------------------------------------------------------------------
const clientRouter = express.Router();
clientRouter.use(requireAuth, (req, res, next) => {
  if (!isClient(req.user)) return res.status(403).json({ error: 'This page is for client logins.' });
  const CT = require('../utils/clientPortalTypes'); // eslint-disable-line global-require
  if (!CT.hasCap(req.user, 'VIEW') && !CT.hasCap(req.user, 'INVOICES')) return res.status(403).json({ error: 'Your login does not show contractors. Ask your TeamLink contact.' });
  return next();
});
clientRouter.get('/summary', wrap(async (req, res) => {
  const cs = await K.list(req.user);
  const waiting = cs.length ? (await T.rowsFor(cs.map((c) => c.applicationId), { status: 'Submitted' })).length : 0;
  const CT = require('../utils/clientPortalTypes'); // eslint-disable-line global-require
  const mode = await S.setting('approval.mode');
  res.json({ contractors: cs.filter((c) => !c.ended).length, waiting, mayApprove: mode !== 'tl' && (CT.hasCap(req.user, 'DECIDE') || CT.hasCap(req.user, 'INVOICES')) });
}));
clientRouter.get('/timesheets', wrap(async (req, res) => {
  const out = await T.list(req.user, { status: req.query.status || null });
  res.json({ rows: out.rows.map(({ submittedById, decidedById, ...r }) => r) }); // eslint-disable-line no-unused-vars
}));
clientRouter.post('/timesheets/:id/decision', wrap(async (req, res) => {
  if (viewOnlyAs(req)) return res.status(403).json({ error: 'View-as is read only.' });
  return send(res, await T.decide(req.user, req.params.id, { approve: !!(req.body && req.body.approve), reason: req.body && req.body.reason }));
}));
clientRouter.get('/shifts', wrap(async (req, res) => {
  const out = await SH.list(req.user, { from: req.query.from, to: req.query.to });
  res.json({ from: out.from, to: out.to, rows: out.rows.filter((s) => s.applicationId && s.status !== 'Cancelled').map((s) => ({ id: s.id, name: s.name, day: s.day, start: s.start, end: s.end, hours: s.hours, role: s.role, location: s.location, status: s.status })) });
}));

// ---- the contractor -------------------------------------------------------------------------------------------------------------
const candidateRouter = express.Router();
candidateRouter.use(requireAuth, (req, res, next) => (isCandidate(req.user) ? next() : res.status(403).json({ error: 'This page is for candidate logins.' })));
candidateRouter.get('/', wrap(async (req, res) => {
  const cs = await K.list(req.user);
  const out = [];
  for (const c of cs) {
    // eslint-disable-next-line no-await-in-loop
    const w = await T.weeksOf(req.user, c.applicationId, { weeks: 6 });
    out.push({ applicationId: c.applicationId, role: c.requirement, company: c.client, startOn: c.startOn, endOn: c.endOn, ended: c.ended, weeklyHours: c.weeklyHours, rate: c.rate, weeks: (w.weeks || []).map(({ submittedById, decidedById, ...x }) => x) }); // eslint-disable-line no-unused-vars
  }
  const sh = cs.length ? await SH.list(req.user, { from: S.mondayOf(new Date().toISOString().slice(0, 10)) }) : { rows: [] };
  res.json({ contracts: out, shifts: sh.rows.filter((s) => s.applicationId && s.status !== 'Cancelled').map((s) => ({ id: s.id, applicationId: s.applicationId, day: s.day, start: s.start, end: s.end, hours: s.hours, role: s.role, location: s.location, status: s.status })) });
}));
candidateRouter.put('/:applicationId/weeks/:week', wrap(async (req, res) => {
  if (viewOnlyAs(req)) return res.status(403).json({ error: 'View-as is read only.' });
  return send(res, await T.save(req.user, req.params.applicationId, { ...(req.body || {}), weekStart: req.params.week }));
}));
candidateRouter.get('/:applicationId/weeks/:week/from-shifts', wrap(async (req, res) => send(res, await T.fromShifts(req.user, req.params.applicationId, req.params.week))));
candidateRouter.post('/timesheets/:id/recall', wrap(async (req, res) => send(res, await T.recall(req.user, req.params.id))));

// ---- the sandbox stub (never mounted outside the sandbox) -------------------------------------------------------------------------
const stubRouter = express.Router();
const STUB = { received: [], subs: new Map(), seq: 0, jobs: null };
const defaultJobs = () => ({
  beeline: { requisitions: [{ requisitionId: 'BL-1001', jobTitle: 'Warehouse Associate', buyerName: 'STUBCLIENT', workLocation: { city: 'Chennai' }, positions: 3, maxBillRate: 450, startDate: '2026-12-01', endDate: '2027-05-31', description: 'Pick and pack, 9-hour shifts.', skills: ['forklift', 'inventory'], status: 'Open' }] },
  fieldglass: { job_postings: [{ job_posting_id: 'FG-2002', job_posting_title: 'Data Entry Operator', buyer: 'STUBCLIENT', site: 'Pune', positions: 2, bill_rate_max: 380, start_date: '2026-12-05', status: 'Open' }] },
  vndly: { results: [{ id: 'VN-3003', title: 'Lab Technician', client: { name: 'STUBCLIENT' }, location: { city: 'Hyderabad' }, openings: 1, bill_rate: { max: 520 }, start_date: '2026-12-10', status: 'open' }] },
  generic: { jobs: [{ id: 'GN-4004', title: 'Field Sales Executive', client: 'STUBCLIENT', location: 'Delhi', openings: 4, maxBillRate: 300, startDate: '2026-12-15', status: 'Open' }] },
});
const authed = (req) => /^(Bearer|Token) \S+/.test(String(req.headers.authorization || ''));
stubRouter.use(express.json({ limit: '1mb' }), express.urlencoded({ extended: false }));
stubRouter.post('/_reset', (req, res) => { STUB.received = []; STUB.subs = new Map(); STUB.jobs = defaultJobs(); if (req.body && req.body.clientName) Object.values(STUB.jobs).forEach((v) => Object.values(v)[0].forEach((j) => { ['buyerName', 'buyer'].forEach((k) => { if (k in j) j[k] = req.body.clientName; }); if (typeof j.client === 'string') j.client = req.body.clientName; else if (j.client) j.client.name = req.body.clientName; })); res.json({ ok: true }); });
stubRouter.post('/_status', (req, res) => { const s = STUB.subs.get(String(req.body.id)); if (!s) return res.status(404).json({}); s.status = String(req.body.status); return res.json({ ok: true }); });
stubRouter.get('/_log', (req, res) => res.json({ received: STUB.received, subs: [...STUB.subs.values()] }));
// OAuth (Beeline / Fieldglass)
stubRouter.post(['/beeline/oauth/token', '/fieldglass/api/oauth2/v2.0/token'], (req, res) => (req.body && req.body.client_id && req.body.client_secret === 'stub-secret' ? res.json({ access_token: `tok-${crypto.randomUUID()}`, expires_in: 3600 }) : res.status(401).json({ error: 'invalid_client' })));
const jobsOf = (sys) => { if (!STUB.jobs) STUB.jobs = defaultJobs(); return STUB.jobs[sys]; };
stubRouter.get('/beeline/api/v1/suppliers/:sup/requisitions', (req, res) => (authed(req) && req.params.sup === 'SUP-1' ? res.json(jobsOf('beeline')) : res.status(401).json({})));
stubRouter.get('/fieldglass/api/v1/job_postings', (req, res) => (authed(req) && req.headers['x-applicationkey'] ? res.json(jobsOf('fieldglass')) : res.status(401).json({})));
stubRouter.get('/vndly/api/v1/jobs/', (req, res) => (/^Token /.test(req.headers.authorization || '') ? res.json(jobsOf('vndly')) : res.status(401).json({})));
stubRouter.get('/generic/jobs', (req, res) => (authed(req) ? res.json(jobsOf('generic')) : res.status(401).json({})));
const newSub = (sys, job, body) => { STUB.seq += 1; const id = `${sys.slice(0, 2).toUpperCase()}-S${STUB.seq}`; STUB.subs.set(id, { id, sys, job, body, status: 'Submitted' }); return id; };
stubRouter.post('/beeline/api/v1/requisitions/:job/submittals', (req, res) => (authed(req) ? res.status(201).json({ submittalId: newSub('beeline', req.params.job, req.body), submittalStatus: 'Submitted' }) : res.status(401).json({})));
stubRouter.post('/fieldglass/api/v1/job_postings/:job/job_seekers', (req, res) => (authed(req) ? res.status(201).json({ job_seeker_id: newSub('fieldglass', req.params.job, req.body), status: 'Received' }) : res.status(401).json({})));
stubRouter.post('/vndly/api/v1/job_applications/', (req, res) => (authed(req) ? res.status(201).json({ id: newSub('vndly', req.body.job, req.body), status: 'new' }) : res.status(401).json({})));
stubRouter.post('/generic/jobs/:job/submissions', (req, res) => (authed(req) ? res.status(201).json({ id: newSub('generic', req.params.job, req.body), status: 'Submitted' }) : res.status(401).json({})));
const subOut = (key) => (req, res) => { const s = STUB.subs.get(req.params.sub); if (!authed(req) || !s) return res.status(404).json({}); return res.json({ [key]: s.status, id: s.id }); };
stubRouter.get('/beeline/api/v1/submittals/:sub', subOut('submittalStatus'));
stubRouter.get('/fieldglass/api/v1/job_seekers/:sub', subOut('status'));
stubRouter.get('/vndly/api/v1/job_applications/:sub/', subOut('status'));
stubRouter.get('/generic/submissions/:sub', subOut('status'));
// a webhook receiver that checks the signature with the secret "stub-signing"
stubRouter.post('/hook', express.raw({ type: '*/*' }), (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : JSON.stringify(req.body);
  const want = `sha256=${crypto.createHmac('sha256', 'stub-signing').update(raw).digest('hex')}`;
  STUB.received.push({ at: new Date().toISOString(), event: req.headers['x-teamlink-event'], signed: req.headers['x-teamlink-signature'] === want, body: (() => { try { return JSON.parse(raw); } catch { return raw; } })() });
  res.json({ ok: true });
});
// Zoho Books
stubRouter.post('/zoho/oauth/v2/token', (req, res) => (req.body && req.body.refresh_token === 'stub-refresh' ? res.json({ access_token: 'zoho-tok' }) : res.status(400).json({ error: 'invalid_code' })));
stubRouter.get('/zoho/books/v3/contacts', (req, res) => (req.headers.authorization === 'Zoho-oauthtoken zoho-tok' ? res.json({ contacts: STUB.received.filter((r) => r.zohoContact && r.zohoContact === req.query.contact_name).map(() => ({ contact_id: 'C-1' })) }) : res.status(401).json({})));
stubRouter.post('/zoho/books/v3/contacts', (req, res) => { STUB.received.push({ zohoContact: req.body.contact_name }); res.status(201).json({ contact: { contact_id: 'C-1' } }); });
stubRouter.post('/zoho/books/v3/invoices', (req, res) => { if (req.headers.authorization !== 'Zoho-oauthtoken zoho-tok' || !req.body.customer_id || !(req.body.line_items || []).length) return res.status(400).json({ message: 'bad invoice' }); STUB.received.push({ zohoInvoice: req.body }); return res.status(201).json({ invoice: { invoice_id: 'INV-Z1', invoice_number: 'INV-000001' } }); });

module.exports = { clientRouter, candidateRouter, stubRouter };
