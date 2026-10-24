// ---------------------------------------------------------------------------
// BDE BUSINESS WORKSPACE ROUTES (user spec 2026-10-10) - mounted on the /api/clients router by routes/clients.js
// (so its auth, product gate, Client List view guard and the router.param('id') SCOPE CHECK apply).
//
//   REQUESTS a Manager / Admin decides (utils/clientRequests.js)
//   POST /clients/:id/request-delete      {reason}                    -> Admin approves -> soft delete (Archived)
//   POST /clients/:id/request-deactivate  {reason}                    -> Manager / Admin approves -> Inactive
//   POST /clients/:id/request-owner       {newOwner, reason}          -> Manager / Admin approves -> Owner BDE changes
//   POST /clients/:id/request-merge       {otherClientId, reason}     -> Admin approves, then merges on Duplicate clients
//   POST /clients/:id/submit-approval     {note}                      -> Manager / Admin approves
//   POST /clients/:id/deactivate          {reason}                    Manager / Admin directly (Role Catalog 'Deactivate Client' edit)
//   GET  /clients/requests                the requests I sent + the ones I may decide
//   POST /clients/requests/:rid/approve   {note}   /reject {reason}
//
//   BUSINESS ACTIVITIES
//   GET  /clients/:id/business            onboarding steps, follow-ups / meetings / feedback, my rights on this client
//   POST /clients/:id/followups           {kind: followup|meeting, title, note, dueDate, dueTime, meetingLink}
//   POST /clients/followups/:fid/done     {note}
//   POST /clients/:id/feedback            {note, kind: feedback|hiring} client feedback / hiring update (append-only history)
//   GET  /clients/my-business             the BDE workspace numbers + lists (My Business Workspace)
//
// Follow-ups / meetings / feedback are small JSON rows in AppSetting (key clientfu.<clientId>.<id>) - no schema change.
// Every action writes an AuditLog row (who, when, why).
// ---------------------------------------------------------------------------
const prisma = require('../db');
const { logAudit } = require('../utils/audit');
const { can } = require('../middleware/auth');
const CL = require('../utils/clientLifecycle');
const CR = require('../utils/clientRequests');
const biz = require('../utils/clientBusiness');

module.exports = function mountClientRequests(router, { shapeFor }) {
  const rightsOf = async (req) => CL.rightsFor(req.user, req.client, await CL.baseRights(req.user));
  const deny = (res, msg) => res.status(403).json({ error: msg });

  // ---- requests list / decide (before any /:id route) --------------------------------------------------
  router.get('/requests', async (req, res, next) => {
    try { return res.json({ requests: await CR.listFor(req.user, { onlyMine: String(req.query.mine || '') === '1' }) }); } catch (e) { return next(e); }
  });
  router.post('/requests/:rid/approve', async (req, res, next) => {
    try { const out = await CR.decide({ user: req.user, id: req.params.rid, approve: true, note: req.body && req.body.note }); return res.status(out.status).json(out.body); } catch (e) { return next(e); }
  });
  router.post('/requests/:rid/reject', async (req, res, next) => {
    try { const out = await CR.decide({ user: req.user, id: req.params.rid, approve: false, note: req.body && (req.body.reason ?? req.body.note) }); return res.status(out.status).json(out.body); } catch (e) { return next(e); }
  });

  // ---- the workspace (before /:id) ---------------------------------------------------------------------
  // The three BDE reports (ATS Reports -> My business): /clients/my-reports/clients|requirements|followups[?format=csv]
  router.get('/my-reports/:kind', async (req, res, next) => {
    try {
      const out = await biz.reportFor(req.user, req.params.kind);
      if (out.status !== 200) return res.status(out.status).json(out.body);
      if (String(req.query.format || '') === 'csv') {
        if (!out.body.canExport) return res.status(403).json({ error: 'Downloading this data is not ticked for your role (Export assigned data).' });
        const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
        const csv = [out.body.columns.map((c) => esc(c.label)).join(','), ...out.body.rows.map((r) => out.body.columns.map((c) => esc(r[c.key])).join(','))].join('\r\n');
        await require('../utils/audit').logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Report exported', entity: 'Report', entityId: req.params.kind, toValue: `${out.body.rows.length} rows`, reason: out.body.title }); // eslint-disable-line global-require
        res.set('Content-Type', 'text/csv; charset=utf-8');
        res.set('Content-Disposition', `attachment; filename="${out.body.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv"`);
        return res.send(csv);
      }
      return res.json(out.body);
    } catch (e) { return next(e); }
  });
  router.get('/my-business', async (req, res, next) => {
    try { return res.json(await biz.workspaceFor(req.user)); } catch (e) { return next(e); }
  });
  router.post('/followups/:fid/done', async (req, res, next) => {
    try {
      const out = await biz.markDone(req.user, req.params.fid, req.body && req.body.note);
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });

  // ---- requests on one client ---------------------------------------------------------------------------
  router.post('/:id/request-delete', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      if (!rights.requestDelete) return deny(res, 'You cannot ask to delete this client. Only the client\'s own BDE can ask; an Admin decides.');
      const r = CR.reasonOf(req.body && req.body.reason);
      if (r.error) return res.status(400).json({ error: r.error });
      const out = await CR.createRequest({ user: req.user, kind: 'delete', client: req.client, reason: r.reason, ask: { field: 'status', fromValue: req.client.status || 'Active', toValue: 'Deleted (kept in history)' } });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
  router.post('/:id/request-deactivate', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      if (!rights.requestDeactivate) return deny(res, rights.deactivate ? 'You can deactivate this client directly.' : 'You cannot ask to deactivate this client.');
      const r = CR.reasonOf(req.body && req.body.reason);
      if (r.error) return res.status(400).json({ error: r.error });
      const out = await CR.createRequest({ user: req.user, kind: 'deactivate', client: req.client, reason: r.reason, ask: { field: 'status', fromValue: req.client.status || 'Active', toValue: 'Inactive' } });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
  router.post('/:id/deactivate', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      if (!rights.deactivate) return deny(res, 'Deactivating a client is for Super Admin, Admin or the Manager of the client\'s department. A BDE asks (Ask to deactivate).');
      const r = CR.reasonOf(req.body && req.body.reason);
      if (r.error) return res.status(400).json({ error: r.error });
      const updated = await prisma.client.update({ where: { id: req.client.id }, data: { status: 'Inactive' } });
      await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Client deactivated', entity: 'Client', entityId: req.client.id, field: 'status', fieldLabel: 'Status', fromValue: req.client.status || 'Active', toValue: 'Inactive', reason: r.reason });
      const out = await shapeFor(req, updated);
      out.lifecycleActions = await rightsOf({ ...req, client: updated });
      return res.json({ ok: true, message: `${updated.name} is deactivated. Every record is kept.`, client: out });
    } catch (e) { return next(e); }
  });
  router.post('/:id/request-owner', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      if (!rights.requestOwner) return deny(res, 'You cannot ask to change the owner of this client.');
      const r = CR.reasonOf(req.body && req.body.reason);
      if (r.error) return res.status(400).json({ error: r.error });
      const newOwner = String((req.body && req.body.newOwner) || '').trim();
      if (!newOwner) return res.status(400).json({ error: 'Pick the BDE who should get this client.' });
      if (newOwner.toLowerCase() === String(req.client.bdeOwner || '').trim().toLowerCase()) return res.status(400).json({ error: `${newOwner} already looks after this client.` });
      const { bdeDirectory, bdeDepartmentProblem } = require('../utils/bdeSeats'); // eslint-disable-line global-require
      const dir = await bdeDirectory();
      if (!dir.infoFor(newOwner)) return res.status(400).json({ error: 'Pick a BDE from the list.' });
      const problem = bdeDepartmentProblem(dir, newOwner, req.client.ownerDepartment, 'The new owner');
      if (problem) return res.status(400).json({ error: problem });
      const out = await CR.createRequest({ user: req.user, kind: 'owner', client: req.client, reason: r.reason, ask: { field: 'bdeOwner', fieldLabel: 'Owner BDE', fromValue: req.client.bdeOwner || '—', toValue: newOwner } });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
  // DIRECT change of owner BDE (user rule 2026-10-13): the client's BDE for their own clients, the BDE TL for any, Admin for any.
  router.post('/:id/change-owner', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      const admin = !!require('../utils/scope').scopeOf(req.user).adminGlobal; // eslint-disable-line global-require
      if (!rights.changeOwner && !admin) return deny(res, 'You cannot change the owner of this client.');
      const r = CR.reasonOf(req.body && req.body.reason);
      if (r.error) return res.status(400).json({ error: r.error });
      const newOwner = String((req.body && req.body.newOwner) || '').trim();
      if (!newOwner) return res.status(400).json({ error: 'Pick the BDE who should get this client.' });
      if (newOwner.toLowerCase() === String(req.client.bdeOwner || '').trim().toLowerCase()) return res.status(400).json({ error: `${newOwner} already looks after this client.` });
      const { bdeDirectory, bdeDepartmentProblem } = require('../utils/bdeSeats'); // eslint-disable-line global-require
      const dir = await bdeDirectory();
      if (!dir.infoFor(newOwner)) return res.status(400).json({ error: 'Pick a BDE from the list.' });
      const problem = bdeDepartmentProblem(dir, newOwner, req.client.ownerDepartment, 'The new owner');
      if (problem) return res.status(400).json({ error: problem });
      const prev = req.client.bdeOwner;
      const updated = await prisma.client.update({ where: { id: req.client.id }, data: { bdeOwner: newOwner } });
      await logAudit({ userId: req.user.id, actorName: req.user.name || null, action: 'Client owner changed', entity: 'Client', entityId: req.client.id, field: 'bdeOwner', fieldLabel: 'Owner BDE', fromValue: prev || '—', toValue: newOwner, reason: r.reason });
      const people = await prisma.user.findMany({ where: { status: 'Active', atsRole: 'BDE' }, select: { id: true, name: true } });
      const names = [newOwner, prev].filter(Boolean).map((x) => x.toLowerCase());
      await require('../utils/notify').notifyUsers(people.filter((p) => names.includes(String(p.name || '').toLowerCase())).map((p) => p.id), { title: `Client owner changed — ${req.client.name}`, message: `${req.client.name} now belongs to ${newOwner}${prev ? ` (was ${prev})` : ''}.`, exceptUserId: req.user.id }).catch(() => null); // eslint-disable-line global-require
      return res.json({ ok: true, message: `${req.client.name} now belongs to ${newOwner}.`, client: await shapeFor({ ...req, client: updated }, updated) });
    } catch (e) { return next(e); }
  });
  router.post('/:id/request-merge', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      if (!rights.requestMerge) return deny(res, 'You cannot ask to merge this client.');
      const r = CR.reasonOf(req.body && req.body.reason);
      if (r.error) return res.status(400).json({ error: r.error });
      const other = await prisma.client.findUnique({ where: { id: String((req.body && req.body.otherClientId) || '') }, select: { id: true, name: true } });
      if (!other || other.id === req.client.id) return res.status(400).json({ error: 'Pick the other client that is the same company.' });
      const out = await CR.createRequest({ user: req.user, kind: 'merge', client: req.client, reason: r.reason, ask: { field: 'mergeWith', fieldLabel: 'Same company as', fromValue: other.id, toValue: other.name } });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
  router.post('/:id/submit-approval', async (req, res, next) => {
    try {
      const rights = await rightsOf(req);
      if (!rights.submitApproval) return deny(res, 'You cannot submit this client for approval.');
      const note = String((req.body && (req.body.note ?? req.body.reason)) || '').trim();
      const r = CR.reasonOf(note || 'Please check and approve this client', 'note');
      if (r.error) return res.status(400).json({ error: r.error });
      const out = await CR.createRequest({ user: req.user, kind: 'approval', client: req.client, reason: r.reason, ask: { field: 'approval', fieldLabel: 'Approval', fromValue: 'Not submitted', toValue: 'Submitted for approval' } });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });

  // ---- business activities on one client -----------------------------------------------------------------
  router.get('/:id/business', async (req, res, next) => {
    try {
      if (require('../utils/clientRedact').clientLevelFor(req.user) !== 'full') return deny(res, 'Business activities are for the client desk (BDE, Manager, Admin).'); // eslint-disable-line global-require
      return res.json(await biz.clientBusiness(req.user, req.client, await rightsOf(req))); } catch (e) { return next(e); }
  });
  router.post('/:id/followups', async (req, res, next) => {
    try {
      if (!(await can(req.user, 'ats', 'clients', 'Client Follow-ups', 'create'))) return deny(res, 'Adding follow-ups and meetings is for the client\'s BDE and Admin.');
      if (!CL.ownsClient(req.user, req.client)) return deny(res, 'This client is not yours. Ask the client\'s BDE or the BDE team lead.');
      const out = await biz.addItem(req.user, req.client, req.body || {});
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
  router.post('/:id/feedback', async (req, res, next) => {
    try {
      if (!(await can(req.user, 'ats', 'clients', 'Client Follow-ups', 'create'))) return deny(res, 'Recording client feedback is for the client\'s BDE and Admin.');
      if (!CL.ownsClient(req.user, req.client)) return deny(res, 'This client is not yours. Ask the client\'s BDE or the BDE team lead.');
      const out = await biz.addItem(req.user, req.client, { ...(req.body || {}), kind: req.body && req.body.kind === 'hiring' ? 'hiring' : 'feedback' });
      return res.status(out.status).json(out.body);
    } catch (e) { return next(e); }
  });
};

