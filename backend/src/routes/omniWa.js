// ---------------------------------------------------------------------------
// /api/omni-wa - Omni-Channel > Inbox & Replies > WhatsApp and Settings > WhatsApp AI. Logic: omniwa/.
//
//   GET  /conversations?filter=all|unread|ai|human&q=&owner=&requirementId=&campaign=     the list, each login within its own people
//   GET  /conversations/:key                     the strip above a chat: AI state, 24-hour window, already contacted, what the AI collected
//   POST /conversations/:key/pause | /resume     a person takes over / gives the chat back to the AI
//   GET  /conversations/:key/messages , POST .../send      a lead's chat (a candidate's chat uses /api/wa-chats as everywhere else)
//   GET  /analytics?days=7|30|90                real numbers only (messages, delivery, enquiries, response time, leads, hand-over, opt-outs, campaigns)
//   GET  /campaign-templates , GET|POST /campaigns , POST /campaigns/preview , GET /campaigns/:id , POST /campaigns/:id/send { at? } | /cancel   (campaign rights)
//   GET  /followups , POST /followups/:id/decide { approve, text?, stopAll? } ; Admin: GET|PUT /followup-settings
//   GET  /leads                                  the marketing assistant's leads (band, details); GET /assignees , POST /conversations/:key/assign { userId }
//   GET  /promotions                             the promotion log
//   POST /already-contacted { ids }              who else reached these candidates in the last 7 days
//   GET  /stream                                 Server-Sent Events: "something changed", no names and no words
//   Admin: GET|PUT /settings , GET /connection , GET|POST|PUT|DELETE /knowledge , GET /runs
//   Admin, AI WhatsApp Marketing Assistant: GET|PUT /assistant , PUT /assistant/numbers/:numberId , POST /assistant/ask (what a customer would get; nothing is sent) , POST /knowledge/import
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const A = require('../outreach/access');
const Cfg = require('../omniwa/config');
const Inbox = require('../omniwa/inbox');
const Agent = require('../omniwa/agent');
const Live = require('../omniwa/live');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);
router.use(require('../outreach/recruiterScope').guard('omniwa')); // a recruiter reaches the chats only, not the AI settings
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);
router.use((req, res, next) => (A.pagesFor(req.user).includes('whatsapp') || A.pagesFor(req.user).includes('waai') ? next() : res.status(403).json({ error: 'Not available to this login' })));
const adminOnly = (req, res, next) => (A.pagesFor(req.user).includes('waai') ? next() : res.status(403).json({ error: 'Only an Admin can change this.' }));
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error }) : res.json(out));

router.get('/conversations', wrap(async (req, res) => res.json(await Inbox.list(req.user, req.query))));
router.get('/conversations/:key', wrap(async (req, res) => {
  const out = await Inbox.detail(req.user, req.params.key);
  return out.error ? send(res, out) : res.json(out.view);
}));

async function own(req, res) {
  const out = await Inbox.detail(req.user, req.params.key);
  if (out.error) { send(res, out); return null; }
  return out;
}
router.post('/conversations/:key/pause', wrap(async (req, res) => {
  const d = await own(req, res);
  if (!d) return undefined;
  if (!d.conv) return res.status(409).json({ error: 'The AI is not in this chat.' });
  await Agent.pause(d.conv, req.user.name);
  await logAudit({ userId: req.user.id, action: 'WhatsApp AI paused', entity: 'OmniWaConv', entityId: d.conv.id }).catch(() => {});
  return res.json((await Inbox.detail(req.user, req.params.key)).view);
}));
router.post('/conversations/:key/resume', wrap(async (req, res) => {
  const d = await own(req, res);
  if (!d) return undefined;
  if (!d.conv) return res.status(409).json({ error: 'The AI is not in this chat.' });
  if (d.conv.state === 'stopped') return res.status(409).json({ error: 'This person asked us to stop. The AI cannot come back.' });
  await Agent.resume(d.conv);
  await logAudit({ userId: req.user.id, action: 'WhatsApp AI resumed', entity: 'OmniWaConv', entityId: d.conv.id }).catch(() => {});
  return res.json((await Inbox.detail(req.user, req.params.key)).view);
}));
router.get('/conversations/:key/messages', wrap(async (req, res) => {
  const d = await own(req, res);
  if (!d) return undefined;
  if (!d.conv || d.conv.personType !== 'LEAD') return res.status(409).json({ error: 'Only a lead\'s chat is read here.' });
  return res.json({ messages: await Inbox.leadMessages(d.conv.id) });
}));
router.post('/conversations/:key/send', wrap(async (req, res) => {
  const d = await own(req, res);
  if (!d) return undefined;
  if (!d.conv || d.conv.personType !== 'LEAD') return res.status(409).json({ error: 'A candidate\'s chat is answered in the chat box.' });
  const text = String((req.body || {}).text || '').trim();
  if (!text) return res.status(400).json({ error: 'Write a message first.' });
  if (text.length > 4000) return res.status(400).json({ error: 'This message is too long for WhatsApp (4000 letters at most).' });
  const out = await Agent.sendText(d.conv, text, { user: req.user, ai: false });
  if (!out.ok) return res.status(409).json({ error: out.error, code: out.code || 'NOT_SENT' });
  await Agent.pause(d.conv, req.user.name);
  return res.json({ ok: true });
}));

// the AI WhatsApp Marketing Assistant's leads, and handing a lead's chat to a team member
router.get('/leads', wrap(async (req, res) => res.json(await Inbox.assistLeads(req.user, req.query))));
router.get('/assignees', wrap(async (req, res) => res.json({ people: await require('../omniwa/assistLead').assignees() }))); // eslint-disable-line global-require
router.post('/conversations/:key/assign', wrap(async (req, res) => {
  const d = await own(req, res);
  if (!d) return undefined;
  if (!d.conv) return res.status(409).json({ error: 'The AI is not in this chat.' });
  const out = await require('../omniwa/assistLead').assign(req.user, d.conv, (req.body || {}).userId); // eslint-disable-line global-require
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: 'WhatsApp lead chat handed to a team member', entity: 'OmniWaConv', entityId: d.conv.id, toValue: out.owner.name }).catch(() => {});
  return res.json((await Inbox.detail(req.user, req.params.key)).view);
}));
// the marketing assistant's follow-ups: the drafts waiting for a person, and the Admin's settings (intervals, approval, the approved template for after 24 hours)
router.get('/followups', wrap(async (req, res) => res.json(await require('../omniwa/followup').list(req.user, req.query)))); // eslint-disable-line global-require
router.post('/followups/:id/decide', wrap(async (req, res) => {
  const out = await require('../omniwa/followup').decide(req.user, req.params.id, req.body || {}); // eslint-disable-line global-require
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: (req.body || {}).approve === false ? 'WhatsApp follow-up skipped' : 'WhatsApp follow-up approved', entity: 'OmniWaFollowUp', entityId: req.params.id, toValue: out.result }).catch(() => {});
  return res.json(out);
}));
// the marketing assistant's promotion campaigns (omniwa/campaign.js): only a login with campaign rights; nothing is saved by a preview and nothing is sent until a person approves
const Camp = () => require('../omniwa/campaign'); // eslint-disable-line global-require
router.get('/campaign-templates', wrap(async (req, res) => res.json({ templates: await Camp().templates(), canManage: Camp().mayCampaign(req.user) })));
router.get('/campaigns', wrap(async (req, res) => res.json(await Camp().list(req.user))));
router.post('/campaigns/preview', wrap(async (req, res) => send(res, await Camp().preview(req.user, req.body || {}))));
router.post('/campaigns', wrap(async (req, res) => {
  const out = await Camp().create(req.user, req.body || {});
  if (!out.error) await logAudit({ userId: req.user.id, action: 'WhatsApp promotion campaign made', entity: 'OmniWaMktCampaign', entityId: out.id, toValue: `${out.people} people` }).catch(() => {});
  return send(res, out);
}));
router.get('/campaigns/:id', wrap(async (req, res) => send(res, await Camp().get(req.user, req.params.id))));
router.post('/campaigns/:id/send', wrap(async (req, res) => {
  const out = await Camp().approve(req.user, req.params.id, { at: (req.body || {}).at || null });
  if (!out.error) await logAudit({ userId: req.user.id, action: out.status === 'scheduled' ? 'WhatsApp promotion campaign scheduled' : 'WhatsApp promotion campaign sent', entity: 'OmniWaMktCampaign', entityId: req.params.id, toValue: out.status }).catch(() => {});
  return send(res, out);
}));
router.post('/campaigns/:id/cancel', wrap(async (req, res) => {
  const out = await Camp().cancel(req.user, req.params.id);
  if (!out.error) await logAudit({ userId: req.user.id, action: 'WhatsApp promotion campaign stopped', entity: 'OmniWaMktCampaign', entityId: req.params.id }).catch(() => {});
  return send(res, out);
}));
// the marketing assistant's analytics: real numbers only, counts (no names, no numbers); an Admin, a team lead or a login with campaign rights
router.get('/analytics', wrap(async (req, res) => send(res, await require('../omniwa/analytics').compute(req.user, { days: Number(req.query.days) || 30 })))); // eslint-disable-line global-require
router.get('/promo-jobs', wrap(async (req, res) => {
  const prisma = require('../db'); // eslint-disable-line global-require
  const where = await require('../utils/scope').requirementWhere(req.user); // eslint-disable-line global-require
  const jobs = await prisma.requirement.findMany({ where: { AND: [where, { status: { in: require('../utils/atsVocab').REQUIREMENT_LIVE_STATUSES } }] }, orderBy: { createdAt: 'desc' }, take: 300, select: { id: true, title: true, reqCode: true } }).catch(() => []);
  res.json({ jobs: jobs.map((j) => ({ id: j.id, title: j.title, code: j.reqCode || null })) });
}));
router.get('/promotions', wrap(async (req, res) => res.json(await Inbox.promotions(req.user, req.query))));
router.post('/already-contacted', wrap(async (req, res) => {
  const ids = Array.isArray((req.body || {}).ids) ? req.body.ids : [];
  const found = await Inbox.recentContact(req.user, ids);
  res.json({ people: [...found.entries()].map(([id, v]) => ({ id, ...v })) });
}));

// Server-Sent Events. The screen reads this with fetch (it sends the login header); nginx must not hold it back.
router.get('/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('event: ready\ndata: {}\n\n');
  let waiting = null;
  const off = Live.subscribe(() => {
    if (waiting) return;
    waiting = setTimeout(() => { waiting = null; res.write(`event: change\ndata: ${Date.now()}\n\n`); }, 400); // many changes in a burst = one question to the server
  });
  const beat = setInterval(() => res.write(': alive\n\n'), 25000);
  req.on('close', () => { off(); clearInterval(beat); if (waiting) clearTimeout(waiting); });
});

// ---- Admin ------------------------------------------------------------------------------------------------------------------------------------------
router.get('/settings', adminOnly, wrap(async (req, res) => {
  const ai = require('../utils/ai'); // eslint-disable-line global-require
  res.json({ config: await Cfg.read(), model: await ai.checkStatus().catch(() => null) });
}));
router.put('/settings', adminOnly, wrap(async (req, res) => {
  const before = await Cfg.read();
  const out = await Cfg.save(req.user, req.body || {});
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: 'WhatsApp AI settings changed', entity: 'OmniWaAiConfig', entityId: 'main', fromValue: before.enabled ? 'On' : 'Off', toValue: out.config.enabled ? 'On' : 'Off' }).catch(() => {});
  return res.json(out.config);
}));
// the WhatsApp connection as it stands: nothing secret leaves the server, the last four of an id at most
router.get('/connection', adminOnly, wrap(async (req, res) => {
  const WN = require('../utils/waNumbers'); // eslint-disable-line global-require
  const delivery = require('../utils/messageDelivery'); // eslint-disable-line global-require
  const tail = (s) => (s ? `••••${String(s).slice(-4)}` : null);
  const rows = (await WN.listRows()).filter((r) => !r.removedAt);
  const numbers = [];
  for (const r of rows) {
    const cfg = await WN.configOf(r).catch(() => null); // eslint-disable-line no-await-in-loop
    numbers.push({ id: r.id, label: r.label, display: r.displayNumber, active: !!r.active, isDefault: !!r.isDefault, phoneNumberId: tail(r.phoneNumberId), hasToken: !!(cfg && cfg.token), hasVerifyToken: !!(cfg && cfg.verifyToken), hasAppSecret: !!(cfg && cfg.appSecret) });
  }
  res.json({ numbers, webhook: await delivery.seenOf('whatsapp') });
}));
router.get('/questions', adminOnly, wrap(async (req, res) => res.json(await Cfg.questions())));
router.put('/questions', adminOnly, wrap(async (req, res) => send(res, await Cfg.saveQuestions(req.body || {}))));
router.get('/profiles', adminOnly, wrap(async (req, res) => res.json({ profiles: await Cfg.profiles() })));
router.put('/profiles/:numberId', adminOnly, wrap(async (req, res) => {
  const out = await Cfg.saveProfile(req.user, req.params.numberId, req.body || {});
  if (!out.error) await logAudit({ userId: req.user.id, action: 'WhatsApp AI settings of a number changed', entity: 'OmniWaAiProfile', entityId: req.params.numberId, toValue: (req.body || {}).enabled === false ? 'Off' : 'On' }).catch(() => {});
  return send(res, out);
}));
router.delete('/profiles/:numberId', adminOnly, wrap(async (req, res) => send(res, await Cfg.removeProfile(req.params.numberId))));
router.get('/knowledge', adminOnly, wrap(async (req, res) => res.json({ entries: await Cfg.kbList() })));
router.post('/knowledge', adminOnly, wrap(async (req, res) => send(res, await Cfg.kbSave(req.user, null, req.body || {}))));
router.put('/knowledge/:id', adminOnly, wrap(async (req, res) => send(res, await Cfg.kbSave(req.user, req.params.id, req.body || {}))));
router.delete('/knowledge/:id', adminOnly, wrap(async (req, res) => send(res, await Cfg.kbRemove(req.params.id))));
// the AI WhatsApp Marketing Assistant (omniwa/assist.js): its switch, its words, which numbers are marketing numbers, a box to try a question, a pasted list of entries
router.get('/assistant', adminOnly, wrap(async (req, res) => res.json(await require('../omniwa/assist').overview()))); // eslint-disable-line global-require
router.put('/assistant', adminOnly, wrap(async (req, res) => {
  const out = await require('../omniwa/assist').saveSettings(req.user, req.body || {}); // eslint-disable-line global-require
  await logAudit({ userId: req.user.id, action: 'WhatsApp marketing assistant settings changed', entity: 'AppSetting', entityId: 'omni.wa.assist', fromValue: out.was.enabled ? 'On' : 'Off', toValue: out.settings.enabled ? 'On' : 'Off' }).catch(() => {});
  return res.json({ settings: out.settings });
}));
router.put('/assistant/numbers/:numberId', adminOnly, wrap(async (req, res) => {
  const row = await require('../utils/waNumbers').getRow(req.params.numberId).catch(() => null); // eslint-disable-line global-require
  if (!row) return res.status(404).json({ error: 'This WhatsApp number is gone.' });
  const on = (req.body || {}).on === true;
  const out = await Cfg.setMarketingNumber(row.id, on);
  await logAudit({ userId: req.user.id, action: on ? 'WhatsApp number marked as a marketing number' : 'WhatsApp number is no longer a marketing number', entity: 'WaNumber', entityId: row.id }).catch(() => {});
  return res.json(out);
}));
router.post('/assistant/ask', adminOnly, wrap(async (req, res) => {
  const q = String((req.body || {}).question || '').trim();
  if (!q) return res.status(400).json({ error: 'Type a question first.' });
  return res.json(await require('../omniwa/assist').testQuestion(q.slice(0, 500), (req.body || {}).numberId || null)); // eslint-disable-line global-require
}));
router.get('/followup-settings', adminOnly, wrap(async (req, res) => res.json({ settings: await require('../omniwa/followup').settings() }))); // eslint-disable-line global-require
router.put('/followup-settings', adminOnly, wrap(async (req, res) => {
  const out = await require('../omniwa/followup').saveSettings(req.user, req.body || {}); // eslint-disable-line global-require
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: 'WhatsApp follow-up settings changed', entity: 'AppSetting', entityId: 'omni.wa.followup', fromValue: out.was.enabled ? 'On' : 'Off', toValue: out.settings.enabled ? 'On' : 'Off' }).catch(() => {});
  return res.json({ settings: out.settings });
}));
// the business's own website read into the knowledge base (omniwa/webKb.js): the entries read from the same site before are replaced
router.post('/knowledge/website', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await Cfg.kbImportWebsite(req.user, { urls: String(b.url || '').slice(0, 300), numberId: b.numberId || null });
  if (!out.error) await logAudit({ userId: req.user.id, action: 'WhatsApp knowledge read from a website', entity: 'OmniWaKnowledge', entityId: 'website', toValue: `${String(b.url || '').slice(0, 200)}: ${out.saved} entries from ${out.pages} pages` }).catch(() => {});
  return send(res, out);
}));
router.post('/knowledge/import', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const out = await Cfg.kbImportRows(req.user, String(b.text || '').slice(0, 200000), { numberId: b.numberId || null });
  if (!out.error) await logAudit({ userId: req.user.id, action: 'WhatsApp knowledge entries imported', entity: 'OmniWaKnowledge', entityId: 'import', toValue: `${out.added} added, ${out.updated} updated` }).catch(() => {});
  return out.error ? res.status(out.status || 400).json({ error: out.error, errors: out.errors || [] }) : res.json(out);
}));
const e164Of = (raw) => { const d = require('../utils/messageDelivery').digitsOf(raw); return d.length === 10 ? `91${d}` : d; }; // eslint-disable-line global-require
router.get('/blocked', adminOnly, wrap(async (req, res) => {
  const e164 = e164Of(req.query.number);
  if (e164.length < 12) return res.status(400).json({ error: 'Type the full mobile number.' });
  return res.json({ number: e164, ...(await Agent.blockState(e164)) });
}));
router.post('/unblock', adminOnly, wrap(async (req, res) => {
  const b = req.body || {};
  const e164 = e164Of(b.number);
  if (e164.length < 12) return res.status(400).json({ error: 'Type the full mobile number.' });
  const out = await Agent.unblock(e164, req.user, b.reason);
  if (out.error) return send(res, out);
  await logAudit({ userId: req.user.id, action: 'WhatsApp number unblocked', entity: 'OmniWaOptOut', entityId: `...${e164.slice(-4)}`, toValue: String(b.reason).slice(0, 300) }).catch(() => {});
  return res.json({ number: e164, ...(await Agent.blockState(e164)) });
}));
router.get('/runs', adminOnly, wrap(async (req, res) => res.json({ runs: await Inbox.runs(req.query) })));

module.exports = router;
