// ---------------------------------------------------------------------------
// ATS HISTORY (founder 2026-11-18) - /api/ats/history
//
//   GET /search?q=                       one search: clients (name or an OLD name) and requirements (title, code, client) with headline numbers
//   GET /requirement/:id                 the requirement's history: header, funnel, candidate-by-candidate rows, timeline, drop summary
//   GET /requirement/:id/export          the same, as Excel (?format=xlsx|csv), with the filters of the screen
//   GET /client/:id                      the client's history: totals, joinings, drop reasons, agreements, one row per requirement, billing
//   GET /client/:id/export               Excel
//   filters: ?from=&to= | ?period=month|quarter|year, ?recruiter=<user id>, (table only) ?status=joined|dropped|inprocess|selected|left, ?step=<funnel key>, ?sort=&dir=
//
// READ ONLY. Every answer stays inside the login's own scope (requirementWhere / clientWhere / applicationWhere); a recruiter sees only their own
// requirements and candidates, a BDE only the clients of their desk. The Clients part needs the client desk (Client List view). Billing is cut
// for everybody except the roles that already see invoice amounts (Super Admin, Admin, Accounts). A download needs the ATS Reports export right
// and is written to the audit log like every report download. The numbers and the rules are in utils/atsHistory.js.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth, requireProduct, can } = require('../middleware/auth');
const H = require('../utils/atsHistory');
const P = require('../utils/atsHistoryPeople');
const OWN = require('../utils/ownOnly');
const { sendBook, formatOf } = require('../utils/exportKit');
const { scopeLabel } = require('../utils/scope');

const router = express.Router();
router.use(requireAuth);
router.use(requireProduct('ats'));
const wrap = (fn) => (req, res, next) => { Promise.resolve(fn(req, res, next)).catch(next); };
router.use((req, res, next) => (H.external(req.user) ? res.status(403).json({ error: 'This is for TeamLink staff.' }) : next()));

const clientDeskOf = (user) => can(user, 'ats', 'clients', 'Client List', 'view');
// a download: the ATS Reports export right; a recruiter downloads their own numbers from My results
async function exportRefusal(user) {
  if (OWN.isOwnOnly(user)) return 'Download your own numbers from My results (Download Excel or PDF).';
  if (!(await can(user, null, 'reports', 'ATS Reports', 'export'))) return "This action isn't included in your role's permissions";
  return null;
}

router.get('/search', wrap(async (req, res) => {
  const desk = !!(await clientDeskOf(req.user));
  res.json(await P.searchAll(req.user, req.query.q, { clientDesk: desk }));
}));

router.get('/requirement/:id', wrap(async (req, res) => {
  const out = await H.requirementHistory(req.user, req.params.id, req.query || {});
  if (!out) return res.status(404).json({ error: 'That requirement was not found, or it is outside your access.' });
  out.canExport = !(await exportRefusal(req.user));
  return res.json(out);
}));

router.get('/requirement/:id/export', wrap(async (req, res) => {
  const refusal = await exportRefusal(req.user);
  if (refusal) return res.status(403).json({ error: refusal });
  const format = formatOf({ format: req.query.format === 'pdf' ? 'xlsx' : req.query.format });
  if (!format) return res.status(400).json({ error: 'Choose Excel or CSV.' });
  const out = await H.requirementHistory(req.user, req.params.id, { ...(req.query || {}), _export: true });
  if (!out) return res.status(404).json({ error: 'That requirement was not found, or it is outside your access.' });
  return sendFile(req, res, format, out);
}));

// the Replacement table: dropped candidate -> replacement candidate, dates, days to replace
function replacementSheet(rp) {
  if (!rp) return null;
  return {
    name: 'Replacements',
    headers: ['Dropped candidate', 'Replaced by', 'Client', 'Requirement', 'Dropped on', 'Replacement joined on', 'Days to replace', 'Where it stands'],
    rows: (rp.table || []).map((t) => [t.droppedCandidate, t.replacementCandidate || '', t.clientName || '', t.jobTitle || '', t.droppedOn || '', t.replacementJoinedOn || '', t.daysToReplace == null ? '' : t.daysToReplace, t.words || '']),
  };
}

async function sendFile(req, res, format, out) {
  const shown = out.exportRows; // the rows of the screen: the same status / step filter and sort
  const r = out.requirement;
  const p = out.period;
  return sendBook(req, res, {
    format,
    name: `history-${r.reqCode || r.title}`,
    entity: 'AtsReport',
    what: `Requirement history - ${r.reqCode || r.title}`,
    scope: scopeLabel(req.user, 'ats'),
    period: p.from || p.to ? { from: p.from || 'start', to: p.to || 'today' } : null,
    sheets: [
      {
        name: 'Summary',
        headers: ['Item', 'Value'],
        rows: [['Requirement', `${r.reqCode ? `${r.reqCode} · ` : ''}${r.title}`], ['Client', r.client.name], ['Status', r.statusLabel], ['Openings', r.openings], ['Created', r.createdDay || ''], ['Closed', r.closedDay || ''], ['Days open', r.daysOpen === null ? '' : r.daysOpen],
          ['Dropped means', out.definitions.dropped], ['Rows', shown.length]],
      },
      H.funnelSheet(out.funnel),
      { name: 'Candidates', headers: H.ROW_HEADERS, rows: shown.map((x) => H.exportRow(x)) },
      replacementSheet(out.replacements),
    ].filter(Boolean),
  });
}

router.get('/client/:id', wrap(async (req, res) => {
  if (!(await clientDeskOf(req.user))) return res.status(403).json({ error: 'The client history is for the client desk.' });
  const out = await H.clientHistory(req.user, req.params.id, req.query || {});
  if (!out) return res.status(404).json({ error: 'That client was not found, or it is outside your access.' });
  out.canExport = !(await exportRefusal(req.user));
  return res.json(out);
}));

router.get('/client/:id/export', wrap(async (req, res) => {
  if (!(await clientDeskOf(req.user))) return res.status(403).json({ error: 'The client history is for the client desk.' });
  const refusal = await exportRefusal(req.user);
  if (refusal) return res.status(403).json({ error: refusal });
  const format = formatOf({ format: req.query.format === 'pdf' ? 'xlsx' : req.query.format });
  if (!format) return res.status(400).json({ error: 'Choose Excel or CSV.' });
  const out = await H.clientHistory(req.user, req.params.id, req.query || {});
  if (!out) return res.status(404).json({ error: 'That client was not found, or it is outside your access.' });
  const p = out.period;
  const sheets = [
    {
      name: 'Summary',
      headers: ['Item', 'Value'],
      rows: [['Client', out.client.name], ['Requirements opened', out.requirements.opened], ['Requirements closed', out.requirements.closed], ['Average days to fill', out.averages.daysToFill === null ? '' : out.averages.daysToFill],
        ['Average days from share to joining', out.averages.daysShareToJoin === null ? '' : out.averages.daysShareToJoin], ['Dropped means', out.definitions.dropped]],
    },
    H.funnelSheet(out.funnel),
    {
      name: 'Requirements',
      headers: ['Requirement', 'Status', 'Openings', 'Created', 'Closed', 'Days open', 'Sourced', 'Sent to client', 'Shortlisted', 'Interviews', 'Selected', 'Offers', 'Joined', 'Dropped', 'In process'],
      rows: out.requirementRows.map((x) => [`${x.reqCode ? `${x.reqCode} · ` : ''}${x.title}`, x.statusLabel, x.openings, x.createdDay || '', x.closedDay || '', x.daysOpen === null ? '' : x.daysOpen, x.sourced, x.shared, x.shortlisted, x.interviews, x.selected, x.offers, x.joined, x.dropped, x.inProcess]),
    },
    {
      name: 'Joinings',
      headers: ['Candidate', 'Requirement', 'Recruiter', 'Joining date', 'Guarantee ends', 'Guarantee', 'Left on', 'Left because'],
      rows: out.joinings.map((x) => [x.candidate, x.requirement, x.recruiterName || '', x.joinDay || '', x.guaranteeEnd || '', x.guarantee, x.left ? x.left.day || '' : '', x.left ? x.left.reason || '' : '']),
    },
    { name: 'Drop reasons', headers: ['Reason', 'Candidates'], rows: out.dropSummary.byReason.map((x) => [x.reason, x.count]) },
    replacementSheet(out.replacements),
  ].filter(Boolean);
  if (out.billing) {
    sheets.push({ name: 'Billing', headers: ['Candidate', 'Invoice', 'Invoice date', 'Amount', 'Status', 'Paid on'], rows: out.billing.perJoining.map((x) => [x.candidate, x.invoiceNumber || '', x.invoiceDay || '', x.amount === null ? '' : x.amount, x.status, x.paidDay || '']) });
  }
  return sendBook(req, res, {
    format, name: `history-${out.client.name}`, entity: 'AtsReport', what: `Client history - ${out.client.name}`, scope: scopeLabel(req.user, 'ats'), period: p.from || p.to ? { from: p.from || 'start', to: p.to || 'today' } : null, sheets,
  });
}));

// what this login may open (the screens link a name only when it may open it)
router.get('/access', wrap(async (req, res) => res.json(await P.accessInfo(req.user))));

// ---- people and candidates (utils/atsHistoryPeople.js). A name outside the login's scope is answered as "not found", never with a reason.
const NOT_FOUND = (what) => ({ error: `That ${what} was not found, or it is outside your access.` });
const sendPeopleFile = async (req, res, name, what, d, sheets) => {
  const refusal = await exportRefusal(req.user);
  if (refusal) return res.status(403).json({ error: refusal });
  const format = formatOf({ format: req.query.format === 'pdf' ? 'xlsx' : req.query.format });
  if (!format) return res.status(400).json({ error: 'Choose Excel or CSV.' });
  const p = d && d.period ? d.period : {};
  return sendBook(req, res, { format, name, entity: 'AtsReport', what, scope: scopeLabel(req.user, 'ats'), period: p.from || p.to ? { from: p.from || 'start', to: p.to || 'today' } : null, sheets: sheets(d) });
};
router.get('/recruiter/:id', wrap(async (req, res) => {
  const out = await P.recruiterHistory(req.user, req.params.id, req.query || {});
  if (!out) return res.status(404).json(NOT_FOUND('recruiter'));
  out.canExport = !(await exportRefusal(req.user));
  return res.json(out);
}));
router.get('/recruiter/:id/export', wrap(async (req, res) => {
  const refusal = await exportRefusal(req.user);
  if (refusal) return res.status(403).json({ error: refusal });
  const d = await P.recruiterHistory(req.user, req.params.id, req.query || {});
  if (!d) return res.status(404).json(NOT_FOUND('recruiter'));
  return sendPeopleFile(req, res, `history-${d.person.name}`, `Recruiter history - ${d.person.name}`, d, P.recruiterSheets);
}));
router.get('/tl/:id', wrap(async (req, res) => {
  const out = await P.tlHistory(req.user, req.params.id, req.query || {});
  if (!out) return res.status(404).json(NOT_FOUND('team lead'));
  out.canExport = !(await exportRefusal(req.user));
  return res.json(out);
}));
router.get('/tl/:id/export', wrap(async (req, res) => {
  const refusal = await exportRefusal(req.user);
  if (refusal) return res.status(403).json({ error: refusal });
  const d = await P.tlHistory(req.user, req.params.id, req.query || {});
  if (!d) return res.status(404).json(NOT_FOUND('team lead'));
  return sendPeopleFile(req, res, `history-team-${d.person.name}`, `Team history - ${d.person.name}`, d, P.tlSheets);
}));
router.get('/candidate/:id', wrap(async (req, res) => {
  const out = await P.candidateHistory(req.user, req.params.id);
  if (!out) return res.status(404).json(NOT_FOUND('candidate'));
  out.canExport = !(await exportRefusal(req.user));
  return res.json(out);
}));
router.get('/candidate/:id/export', wrap(async (req, res) => {
  const refusal = await exportRefusal(req.user);
  if (refusal) return res.status(403).json({ error: refusal });
  const d = await P.candidateHistory(req.user, req.params.id);
  if (!d) return res.status(404).json(NOT_FOUND('candidate'));
  return sendPeopleFile(req, res, `history-${d.candidate.name}`, `Candidate history - ${d.candidate.name}`, d, P.candidateSheets);
}));

module.exports = router;
