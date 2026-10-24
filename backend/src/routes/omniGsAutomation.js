// ---------------------------------------------------------------------------
// OMNI-CHANNEL v3 > AUTOMATION (page "Automations" of the Green Start rebuild), mounted at /api/outreach/gs/automation.
// The engine is the existing sequences (outreach/sequences.js) and staff-side scheduled messages (outreach/scheduled.js); this file only gives the
// page its one-call overview, the people picker, the template list and the same actions behind clear paths. Nothing here sends a message: sending
// belongs to the sequences tick, and only when an Admin has switched Outreach sending ON and Test mode OFF.
//   GET    /                      overview: automations + the four numbers + the Test-mode state
//   POST   /   PUT /:id           save (new / change)           POST /:id/on  /:id/off      DELETE /:id
//   POST   /:id/enrol             add people                    GET /:id/runs               names only: who is in it, what each step did
//   GET    /people?q=             the people picker (names only)
//   GET    /templates             message templates for the "send a message" step
//   GET    /tasks   POST /tasks/:id/done      call / follow-up tasks made by automations
//   GET/POST/PUT/DELETE /scheduled...         staff-side scheduled messages (Admin and HR desk only; the engine decides)
// ---------------------------------------------------------------------------
const express = require('express');
const A = require('../outreach/access');
const S = require('../outreach/store');
const Seq = require('../outreach/sequences');
const Sched = require('../outreach/scheduled');
const K = require('../outreach/contacts');
const Quiet = require('../outreach/quiet');
const Chrome = require('../outreach/chrome');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));
const deny = (res, msg) => res.status(403).json({ error: msg || 'Automations are not for your login.' });

router.use((req, res, next) => (A.hubsFor(req.user).automation && A.kind(req.user) !== 'none' ? next() : deny(res)));

router.get('/', wrap(async (req, res) => {
  const dept = Chrome.deptOf(req.user, req.query.dept);
  const st = await S.settings();
  const state = {
    sendingOn: st.master === true, testMode: st.emailTestMode !== false, quiet: Quiet.describe(st.quietHours),
    live: st.master === true && st.emailTestMode === false,
    words: st.master === true && st.emailTestMode === false ? 'Live: automations that are On send real messages (only to people who agreed to that way).' : (st.emailTestMode !== false ? 'Test mode is on: automations only rehearse. Nothing is sent to anybody.' : 'Outreach sending is switched off: automations only rehearse. Nothing is sent to anybody.'),
  };
  if (dept === null) return res.json({ sequences: [], canManage: Seq.mayManage(req.user), kpis: { inFlow: 0, everIn: 0, sent: 0, rehearsed: 0, finished: 0, goalRate: null, replied: 0, stopped: 0 }, state, canScheduled: A.manageScheduled(req.user), kinds: [], triggers: [] });
  const ov = await Seq.overview(req.user, dept);
  return res.json({ ...ov, state, canScheduled: A.manageScheduled(req.user) });
}));

// ---- staff-side scheduled messages (before /:id so the words are not taken for an id) -----------------------------------------------
router.get('/scheduled', wrap(async (req, res) => send(res, await Sched.list(req.user))));
router.get('/scheduled/options', wrap(async (req, res) => send(res, await Sched.options(req.user))));
router.post('/scheduled', wrap(async (req, res) => send(res, await Sched.create(req.user, req.body || {}))));
router.put('/scheduled/:id', wrap(async (req, res) => send(res, await Sched.update(req.user, req.params.id, req.body || {}))));
router.post('/scheduled/:id/on', wrap(async (req, res) => send(res, await Sched.toggle(req.user, req.params.id, true))));
router.post('/scheduled/:id/off', wrap(async (req, res) => send(res, await Sched.toggle(req.user, req.params.id, false))));
router.post('/scheduled/:id/test-to-me', wrap(async (req, res) => send(res, await Sched.testToMe(req.user, req.params.id))));
router.get('/scheduled/:id/runs', wrap(async (req, res) => send(res, await Sched.runs(req.user, req.params.id))));
router.delete('/scheduled/:id', wrap(async (req, res) => send(res, await Sched.remove(req.user, req.params.id))));

// ---- tasks ------------------------------------------------------------------------------------------------------------------------------------
router.get('/tasks', wrap(async (req, res) => res.json(await Seq.tasks(req.user))));
router.post('/tasks/:id/done', wrap(async (req, res) => send(res, await Seq.doneTask(req.user, req.params.id))));

// ---- pickers --------------------------------------------------------------------------------------------------------------------------------------
router.get('/people', wrap(async (req, res) => {
  const t = String(req.query.q || '').trim();
  if (t.length < 2) return res.json({ people: [] });
  const out = await K.list(req.user, { q: t, pageSize: 30, type: 'candidate_lead' });
  // names, city and company only: never a phone or an email
  return res.json({ people: (out.contacts || []).map((c) => ({ id: c.id, name: c.name || 'No name', city: c.city || '', company: c.company || '' })) });
}));
router.get('/templates', wrap(async (req, res) => {
  const out = await require('../outreach/hub').list(req.user, {}); // eslint-disable-line global-require
  const items = (out.items || []).filter((i) => ['message', 'outreach'].includes(i.source) && ['Email', 'WhatsApp', 'SMS'].includes(i.channel)).map((i) => ({ key: i.key, name: i.name, channel: String(i.channel).toLowerCase() }));
  return res.json({ templates: items });
}));

// ---- the automations --------------------------------------------------------------------------------------------------------------------------
router.post('/', wrap(async (req, res) => send(res, await Seq.save(req.user, null, req.body || {}))));
router.put('/:id', wrap(async (req, res) => send(res, await Seq.save(req.user, req.params.id, req.body || {}))));
router.post('/:id/on', wrap(async (req, res) => send(res, await Seq.toggle(req.user, req.params.id, true))));
router.post('/:id/off', wrap(async (req, res) => send(res, await Seq.toggle(req.user, req.params.id, false))));
router.delete('/:id', wrap(async (req, res) => send(res, await Seq.remove(req.user, req.params.id))));
router.post('/:id/enrol', wrap(async (req, res) => send(res, await Seq.enrol(req.user, req.params.id, (req.body || {}).contactIds))));
router.get('/:id/runs', wrap(async (req, res) => send(res, await Seq.runs(req.user, req.params.id))));

router.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  console.error('[omni-gs-automation]', err && err.message); // eslint-disable-line no-console
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

module.exports = router;
