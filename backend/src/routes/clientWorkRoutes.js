// ---------------------------------------------------------------------------
// CLIENT WORK — GET /api/clients/:id/work (mounted into routes/clients.js, so router.param('id')
// has already checked the client is in the caller's scope).
//
// ALL ACTIVITY of the client in one place (every record the client screens hold) and the client
// work waiting on it (utils/clientWork.js). For the client desk only: Super Admin, Admin, Manager,
// the client's BDE (and every BDE of the desk, to read) and the BDE TL. A TL, STL, recruiter,
// Accounts and the client's own login get 403: this is TeamLink's inside view.
//   ?kind=all|notes|agreement|jobs|people|interviews|followups|money|files|messages|access
// ---------------------------------------------------------------------------
const { clientLevelFor } = require('../utils/clientRedact');
const { atsViewRole } = require('../utils/scope');
const CW = require('../utils/clientWork');

module.exports = function mountClientWork(router) {
  router.get('/:id/work', async (req, res, next) => {
    try {
      if (atsViewRole(req.user) === 'client' || clientLevelFor(req.user) !== 'full') {
        return res.status(403).json({ error: 'Client work is for the client desk (BDE, BDE team lead, Manager, Admin).' });
      }
      const limit = Math.min(300, Math.max(10, Number(req.query.limit) || 150));
      return res.json(await CW.clientTimeline(req.user, req.client, { kind: String(req.query.kind || 'all'), limit }));
    } catch (err) { return next(err); }
  });
};
