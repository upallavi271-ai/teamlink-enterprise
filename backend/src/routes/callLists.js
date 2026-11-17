// ---------------------------------------------------------------------------
// CALL LISTS - the sheet of contacts split among recruiters, who call them from VICIdial (services in calllist/service.js).
//   GET    /call-lists                          the lists I may see (a recruiter: only those holding a block of theirs) + progress
//   GET    /call-lists/recruiters               managers: who a sheet can be split among
//   POST   /call-lists/import?name=&listName=&recruiters=id,id&dryRun=1     the Excel / CSV file as the body (a manager)
//   GET    /call-lists/:id                      the list + progress per recruiter
//   GET    /call-lists/:id/rows?status=&recruiter=&q=&page=      the contacts (a recruiter: only their own)
//   GET    /call-lists/:id/next                 the next contact for ME to call
//   POST   /call-lists/rows/:rowId/call {outcome, note, callbackAt}      how the call went
//   POST   /call-lists/:id/reassign {fromId, toIds}   what is left of one recruiter's block to others (a manager)
//   GET    /call-lists/:id/export               the result as CSV (a manager)
//   DELETE /call-lists/:id                      close a list (a manager)
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const CL = require('../calllist/service');

const router = express.Router();
router.use(requireAuth);

const send = (res, out) => res.status(out.status).json(out.body);
const wrap = (fn) => async (req, res, next) => { try { return send(res, await fn(req)); } catch (e) { return next(e); } };
const rawUpload = express.raw({ type: () => true, limit: '10mb' }); // the Excel / CSV file itself

router.get('/', wrap((req) => CL.lists(req.user)));
router.get('/recruiters', wrap((req) => CL.recruiterPick(req.user)));
router.post('/import', rawUpload, wrap((req) => CL.importList(req.user, Buffer.isBuffer(req.body) ? req.body : null, {
  fileName: String(req.query.name || ''), listName: String(req.query.listName || ''), dryRun: String(req.query.dryRun || '') === '1',
  recruiterIds: String(req.query.recruiters || '').split(',').map((x) => x.trim()).filter(Boolean),
})));
router.post('/rows/:rowId/call', wrap((req) => CL.logCall(req.user, req.params.rowId, req.body || {})));
router.get('/:id', wrap((req) => CL.detail(req.user, req.params.id)));
router.get('/:id/rows', wrap((req) => CL.rows(req.user, req.params.id, req.query || {})));
router.get('/:id/next', wrap((req) => CL.next(req.user, req.params.id)));
router.post('/:id/reassign', wrap((req) => CL.reassign(req.user, req.params.id, req.body || {})));
router.get('/:id/export', async (req, res, next) => {
  try {
    const out = await CL.exportCsv(req.user, req.params.id);
    if (!out.csv) return send(res, out);
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${out.name}"`);
    return res.send(out.csv);
  } catch (e) { return next(e); }
});
router.delete('/:id', wrap((req) => CL.closeList(req.user, req.params.id)));

module.exports = router;
