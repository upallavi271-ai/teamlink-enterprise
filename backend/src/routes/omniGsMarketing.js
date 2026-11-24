// /api/outreach/gs/marketing : Omni-Channel > AI Marketing (the AI Marketing OS: six modules built one phase at a time). Behind login + "may use Omni-Channel"
// (routes/outreach.js). Nothing here sends or posts anything. The server decides who may do what (outreach/access.js RULES mayAiMarketing / mayAiApprove).
// Phase 1: shared AI layer (marketing/ai.js), brand voice (marketing/settings.js), AI Content with approval (marketing/content.js), AI usage.
const express = require('express');
const A = require('../outreach/access');
const St = require('../outreach/studio');
const Reg = require('../marketing/registry');
const AI = require('../marketing/ai');
const Cfg = require('../marketing/settings');
const C = require('../marketing/content');
const Cal = require('../marketing/calendar');
const Img = require('../marketing/images');
const CR = require('../marketing/clientReview');
const Rep = require('../marketing/reports');
const Clips = require('../marketing/aiclips');
const Stock = require('../marketing/stockclips');
const Prj = require('../marketing/projects');
const Msg = require('../marketing/messaging');
const Eml = require('../marketing/emailmk');
const Lead = require('../marketing/leadgen');
const Jny = require('../marketing/journeys');
const CS = require('../marketing/clientServices');
const Site = require('../marketing/siteCheck');
const Geo = require('../marketing/geoTools');
const Rev = require('../marketing/reviewReply');
const Guard = require('../marketing/contentGuard');
const Packs = require('../marketing/industryPacks');
const Ov = require('../marketing/openverse');
const Mrep = require('../marketing/monthlyReport');
const Page = require('../marketing/pagespeed');
const Comp = require('../marketing/competitors');
const PlanRem = require('../marketing/planReminders');
const Blog = require('../marketing/blogPlanner');
const Onb = require('../marketing/onboarding');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const send = (res, out) => (out && out.error ? res.status(out.status || 400).json({ error: out.error, code: out.code || undefined }) : res.json(out));
const sees = (u) => A.pagesFor(u).includes('mkhome');
const mustSee = (req, res, next) => (sees(req.user) ? next() : res.status(403).json({ error: 'AI Marketing is for Admins, the Marketing team and approvers.' }));
const mustWrite = (req, res, next) => (A.has('mayAiMarketing')(req.user) ? next() : res.status(403).json({ error: 'Your login can look at AI Marketing but not use it to write.' }));
const mustAdmin = (req, res, next) => (A.isAdmin(req.user) ? next() : res.status(403).json({ error: 'Only an Admin can change this.' }));
router.use(wrap(async (req, res, next) => { await A.warm(); return mustSee(req, res, next); }));

router.get('/meta', wrap(async (req, res) => {
  const u = req.user;
  const pages = A.pagesFor(u);
  const set = await Cfg.getSettings();
  res.json({
    modules: Reg.MODULES.map((m) => ({ ...m, canOpen: !!m.page && pages.includes(m.page) })),
    later: Reg.LATER,
    channels: C.CHANNELS, goals: C.GOALS, tones: St.VOICES, languages: Cfg.LANGUAGES,
    ai: await AI.status(),
    canWrite: A.has('mayAiMarketing')(u), canApproveAny: A.has('mayAiApprove')(u) || A.isAdmin(u), isAdmin: A.isAdmin(u),
    limits: { aiDailyPerUser: set.aiDailyPerUser, aiMonthlyCap: set.aiMonthlyCap, selfApprove: set.selfApprove, clientRequired: set.clientRequired, clientFor: set.clientFor, autoPostAllowed: set.autoPostAllowed, clientNotify: set.clientNotify },
  });
}));

router.get('/overview', wrap(async (req, res) => {
  const u = req.user;
  const brand = await Cfg.getBrand();
  const usage = await AI.summary({ scopeUserId: A.isAdmin(u) ? null : u.id });
  const counts = await C.counts(u);
  // "needs your attention": what is waiting for THIS login right now (each part is optional: a failure in one never breaks the page)
  const attention = { words: counts.waitingForMe || 0, pictures: 0, overdue: 0, today: 0, clientWaiting: 0, clientChanges: 0 };
  const have = { pictures: false, videos: false, posts: false }; // for the "next steps" list: has this login started each part
  try {
    const all = (await Img.list(u, {})).items;
    attention.pictures = all.filter((i) => i.status === 'waiting' && i.canApprove).length;
    have.pictures = all.some((i) => i.kind === 'image'); have.videos = all.some((i) => i.kind === 'video' && i.style !== 'clip');
  } catch (e) { console.error('[omni-mk] overview pictures:', e.message); } // eslint-disable-line no-console
  try {
    const todayIst = new Date(Date.now() + 19800000).toISOString().slice(0, 10);
    const open = ['idea', 'planned', 'ready'];
    const entries = (await Cal.list(u, {})).entries || [];
    have.posts = entries.length > 0;
    entries.forEach((e) => { if (!open.includes(e.status)) return; if (e.overdue) attention.overdue += 1; else if (e.date === todayIst) attention.today += 1; });
  } catch (e) { console.error('[omni-mk] overview calendar:', e.message); } // eslint-disable-line no-console
  try {
    const since = Date.now() - 14 * 86400000;
    ((await CR.list(u, {})).reviews || []).forEach((r) => { if (r.status === 'sent') attention.clientWaiting += 1; else if (r.status === 'changes' && Date.parse(r.decidedAt) >= since) attention.clientChanges += 1; });
  } catch (e) { console.error('[omni-mk] overview client reviews:', e.message); } // eslint-disable-line no-console
  res.json({ counts, usage, attention, have, brandReady: !!brand.brandName, brandName: brand.brandName, ai: (await AI.status()).text });
}));
// the WhatsApp numbers this login can send a client message from; the default company number comes first (marketing/sender.js)
router.get('/senders', mustWrite, wrap(async (req, res) => res.json(await require('../marketing/sender').numbersFor(req.user)))); // eslint-disable-line global-require

// ---- brand voice ---------------------------------------------------------------------------------------------------------------
router.get('/brand', wrap(async (req, res) => res.json({ brand: await Cfg.getBrand(), tones: St.VOICES, languages: Cfg.LANGUAGES, emoji: Cfg.EMOJI, limits: Cfg.LIMITS, canEdit: A.has('mayAiMarketing')(req.user) })));
router.put('/brand', mustWrite, wrap(async (req, res) => {
  const c = Cfg.cleanBrand(req.body || {}, St.VOICES);
  if (c.error) return res.status(400).json({ error: c.error });
  await Cfg.saveBrand(c.value, req.user);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: brand voice changed', entity: 'OmniMkBrand', entityId: 'brand', toValue: `${c.value.brandName}; tone ${c.value.tone}; language ${c.value.language}; ${c.value.avoidWords.length} avoid word(s)` });
  return res.json({ ok: 'Brand voice saved. The AI uses it from the next request.', notes: c.notes || [], brand: await Cfg.getBrand() });
}));
// the brand logo (used by the brand kit preview and, later, by the AI image and video makers)
router.get('/brand/logo', wrap(async (req, res) => { const l = await Cfg.getLogo(); return res.json({ logo: l ? { dataUrl: l.dataUrl, name: l.name || '', at: l.at || null } : null }); }));
router.put('/brand/logo', mustWrite, wrap(async (req, res) => {
  const c = Cfg.cleanLogo(req.body || {});
  if (c.error) return res.status(400).json({ error: c.error });
  await Cfg.saveLogo(c.value);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: brand logo changed', entity: 'OmniMkBrand', entityId: 'logo', toValue: `${c.value.name || 'logo'}; ${Math.round(c.value.bytes / 1024)} KB` });
  return res.json({ ok: 'Logo saved.', logo: { dataUrl: c.value.dataUrl, name: c.value.name, at: c.value.at } });
}));
router.delete('/brand/logo', mustWrite, wrap(async (req, res) => {
  await Cfg.removeLogo();
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: brand logo removed', entity: 'OmniMkBrand', entityId: 'logo' });
  return res.json({ ok: 'Logo removed.' });
}));

// ---- AI writing ----------------------------------------------------------------------------------------------------------------
router.post('/generate', mustWrite, wrap(async (req, res) => send(res, await C.generate(req.user, req.body || {}))));
router.post('/revise', mustWrite, wrap(async (req, res) => send(res, await C.revise(req.user, req.body || {}))));

// ---- content items (drafts, approval) ---------------------------------------------------------------------------------------------
router.get('/items', wrap(async (req, res) => {
  const out = await C.list(req.user, { status: String(req.query.status || ''), q: req.query.q, mine: req.query.mine === '1' });
  out.items = await CR.attach('content', out.items); // each item carries its latest client review (marketing/clientReview.js)
  res.json(out);
}));
router.get('/items/:id', wrap(async (req, res) => {
  const g = await C.getRow(req.user, req.params.id);
  if (!g) return res.status(404).json({ error: 'This content was not found.' });
  return res.json({ item: C.view(req.user, g.r, g.set) });
}));
router.post('/items', mustWrite, wrap(async (req, res) => send(res, await C.create(req.user, req.body || {}))));
router.put('/items/:id', mustWrite, wrap(async (req, res) => send(res, await C.update(req.user, req.params.id, req.body || {}))));
router.delete('/items/:id', mustWrite, wrap(async (req, res) => send(res, await C.remove(req.user, req.params.id))));
router.post('/items/:id/submit', mustWrite, wrap(async (req, res) => send(res, await C.submit(req.user, req.params.id))));
router.post('/items/:id/approve', wrap(async (req, res) => send(res, await C.approve(req.user, req.params.id, (req.body || {}).note, (req.body || {}).edits))));
router.post('/items/:id/reject', wrap(async (req, res) => send(res, await C.reject(req.user, req.params.id, (req.body || {}).note))));

// ---- content calendar (marketing/calendar.js): planned posts per day; nothing is published from here --------------------------------------------
router.get('/calendar', wrap(async (req, res) => send(res, await Cal.list(req.user, { from: req.query.from, to: req.query.to }))));
router.get('/calendar/platforms', wrap(async (req, res) => res.json({ platforms: await Cal.platformState(), statuses: Cal.STATUSES, canWrite: Cal.mayWrite(req.user) })));
router.get('/calendar/sources', mustWrite, wrap(async (req, res) => res.json(await Cal.sources(req.user))));
router.post('/calendar/plan', mustWrite, wrap(async (req, res) => send(res, await Cal.plan(req.user, req.body || {}))));
router.post('/calendar/bulk', mustWrite, wrap(async (req, res) => send(res, await Cal.addMany(req.user, (req.body || {}).entries))));
router.post('/calendar', mustWrite, wrap(async (req, res) => send(res, await Cal.create(req.user, req.body || {}))));
router.put('/calendar/:id', mustWrite, wrap(async (req, res) => send(res, await Cal.update(req.user, req.params.id, req.body || {}))));
router.delete('/calendar/:id', mustWrite, wrap(async (req, res) => send(res, await Cal.remove(req.user, req.params.id))));
router.post('/calendar/:id/posted', mustWrite, wrap(async (req, res) => send(res, await Cal.markPosted(req.user, req.params.id, req.body || {}))));
router.post('/calendar/:id/skip', mustWrite, wrap(async (req, res) => send(res, await Cal.skip(req.user, req.params.id, req.body || {}))));

// ---- AI images (marketing/images.js): Google Gemini pictures, approved before use --------------------------------------------------------------
router.get('/images/meta', wrap(async (req, res) => res.json(await Img.meta(req.user))));
router.get('/images', wrap(async (req, res) => {
  const out = await Img.list(req.user, { status: String(req.query.status || ''), kind: ['image', 'video'].includes(req.query.kind) ? req.query.kind : '' });
  out.items = await CR.attach('image', out.items);
  const used = await require('../marketing/mediaUse').countsFor(out.items.map((x) => x.id)).catch(() => ({})); // how many campaigns carried each item and to how many people
  out.items = out.items.map((x) => ({ ...x, uses: used[x.id] || { campaigns: 0, recipients: 0 } }));
  res.json(out);
}));
// a person's own picture (PNG / JPEG / WebP, up to 10 MB) as raw bytes; the name comes in the address
router.post('/images/upload', mustWrite, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '11mb' }), wrap(async (req, res) => send(res, await Img.saveUpload(req.user, req.body, req.headers['content-type'], req.query || {}))));
// AI Video: the slideshow made in the browser arrives as raw MP4 / WebM bytes (up to 40 MB); the details come in the address
router.post('/images/video', mustWrite, express.raw({ type: ['video/mp4', 'video/webm'], limit: '41mb' }), wrap(async (req, res) => send(res, await Img.saveVideo(req.user, req.body, req.headers['content-type'], req.query || {}))));
// the video maker's voice-over: the free server voices (Piper / the AI-call voices) say the scene captions in English, Telugu or Hindi; 30 sentences a minute per person
const voiceHits = new Map();
router.get('/video/voice', mustWrite, wrap(async (req, res) => res.json(require('../marketing/meetingVoice').status())));
router.post('/video/voice', mustWrite, wrap(async (req, res) => {
  const now = Date.now(); const hits = (voiceHits.get(req.user.id) || []).filter((t) => now - t < 60000);
  if (hits.length >= 30) return res.status(429).json({ error: 'Too many voice requests in one minute. Wait a moment.' });
  hits.push(now); voiceHits.set(req.user.id, hits);
  const lang = ['en', 'te', 'hi'].includes((req.body || {}).lang) ? req.body.lang : 'en';
  const out = await require('../marketing/meetingVoice').speakAny(lang, (req.body || {}).text);
  if (out.error) return res.status(out.status || 502).json({ error: out.error });
  return res.set({ 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store' }).send(out.wav);
}));
router.get('/banners/meta', mustWrite, wrap(async (req, res) => res.json(await Img.bannerMeta())));
router.post('/banners', mustWrite, wrap(async (req, res) => send(res, await Img.createBanner(req.user, req.body || {}))));
router.post('/images', mustWrite, wrap(async (req, res) => send(res, await Img.create(req.user, req.body || {}))));
// the background job of one "Make pictures" press (marketing/images.js create): the screen asks every few seconds until it is done
router.get('/images/jobs/:id', mustWrite, wrap(async (req, res) => send(res, Img.getJob(req.user, req.params.id))));
router.get('/images/:id/file', wrap(async (req, res) => {
  const f = await Img.file(req.user, req.params.id);
  if (!f) return res.status(404).json({ error: 'This picture was not found.' });
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Cache-Control', 'private, max-age=600');
  if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(f.name)}"`);
  return res.sendFile(f.path);
}));
router.put('/images/:id', mustWrite, wrap(async (req, res) => send(res, await Img.update(req.user, req.params.id, req.body || {}))));
router.delete('/images/:id', mustWrite, wrap(async (req, res) => send(res, await Img.remove(req.user, req.params.id))));
router.post('/images/:id/submit', mustWrite, wrap(async (req, res) => send(res, await Img.submit(req.user, req.params.id))));
router.post('/images/:id/approve', wrap(async (req, res) => send(res, await Img.approve(req.user, req.params.id, (req.body || {}).note))));
router.post('/images/:id/reject', wrap(async (req, res) => send(res, await Img.reject(req.user, req.params.id, (req.body || {}).note))));

// ---- client approval (marketing/clientReview.js): after the team approves, the client approves on a private link --------------------------------------
router.get('/client-reviews', wrap(async (req, res) => send(res, await CR.list(req.user, { kind: String(req.query.kind || ''), itemId: String(req.query.itemId || '') }))));
router.get('/client-contacts', mustWrite, wrap(async (req, res) => send(res, await CR.contacts(req.user)))); // the clients already sent to, with the contact details typed last time
router.post('/images/:id/send-to-client', mustWrite, wrap(async (req, res) => send(res, await CR.sendToClient(req.user, req.params.id, req.body || {}, siteOf(req))))); // the link and WhatsApp in one step
router.get('/images/:id/posts', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/postItem').posts(req.user, req.params.id)))); // what was already posted from this picture / video
router.post('/images/:id/post', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/postItem').postItem(req.user, req.params.id, req.body || {}, siteOf(req))))); // post an APPROVED picture / video on the accounts picked (Facebook, Instagram, X)
router.post('/client-reviews', mustWrite, wrap(async (req, res) => send(res, await CR.create(req.user, req.body || {}))));
router.post('/client-reviews/:id/tell', mustWrite, wrap(async (req, res) => send(res, await CR.tell(req.user, req.params.id, req.body || {}, siteOf(req))))); // a person's click: WhatsApp / email the link (and the picture) from TeamLink
router.post('/client-reviews/:id/revoke', mustWrite, wrap(async (req, res) => send(res, await CR.revoke(req.user, req.params.id))));
router.post('/client-reviews/:id/extend', mustWrite, wrap(async (req, res) => send(res, await CR.extend(req.user, req.params.id, (req.body || {}).days))));

// ---- plans meeting (marketing/meeting.js): a link the team sends a client on WhatsApp; the client watches an automated, spoken meeting about the plans (public page /plans-meeting/<token>) ------------
// Nothing is sent until a person clicks "Send on WhatsApp" (tell). The public side is routes/mkMeetingPublic.js.
router.get('/meetings', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').list(req.user)))); // eslint-disable-line global-require
router.put('/meetings/settings', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').saveSettings(req.user, req.body || {})))); // eslint-disable-line global-require
router.put('/meetings/answers', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').saveAnswer(req.user, req.body || {})))); // eslint-disable-line global-require
router.delete('/meetings/answers/:id', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').removeAnswer(req.user, req.params.id)))); // eslint-disable-line global-require
router.put('/meetings/offer', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').saveOffer(req.user, req.body || {})))); // eslint-disable-line global-require
router.put('/meetings/alert', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').saveAlert(req.user, req.body || {})))); // eslint-disable-line global-require
router.post('/meetings', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').create(req.user, req.body || {})))); // eslint-disable-line global-require
router.post('/meetings/:id/tell', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').tell(req.user, req.params.id, req.body || {}, siteOf(req))))); // eslint-disable-line global-require
router.post('/meetings/:id/call', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').call(req.user, req.params.id, req.body || {})))); // eslint-disable-line global-require
router.delete('/meetings/:id', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/meeting').remove(req.user, req.params.id)))); // eslint-disable-line global-require

// ---- AI clips (marketing/aiclips.js): a real-motion clip from Google Veo; paid, so the cost must be confirmed and a daily limit applies ------------------
// ---- create from a prompt (marketing/autostudio.js): one sentence -> the plan of a video / picture post (pictures and the video are then made by the screen) ------------------
router.post('/studio/plan', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/autostudio').plan(req.user, req.body || {}))));
router.post('/studio/idea-assist', mustWrite, wrap(async (req, res) => send(res, await require('../marketing/ideaAssist').ideaAssist(req.user, req.body || {})))); // "✨ AI Assist" on the idea box: the AI writes the idea from the title (fills the box only)

// ---- campaign messages (marketing/messaging.js): the AI writes the WhatsApp / SMS words of a job campaign; templates and a campaign that is saved, NEVER sent from here --------------
router.get('/campaigns/options', mustWrite, wrap(async (req, res) => send(res, await Msg.options(req.user, { q: String(req.query.q || '') }))));
router.post('/campaigns/write', mustWrite, wrap(async (req, res) => send(res, await Msg.write(req.user, req.body || {}))));
router.post('/campaigns/check', mustWrite, wrap(async (req, res) => send(res, await Msg.check(req.user, req.body || {}))));
router.get('/campaigns', mustWrite, wrap(async (req, res) => send(res, await Msg.list(req.user))));
router.post('/campaigns', mustWrite, wrap(async (req, res) => send(res, await Msg.save(req.user, { ...(req.body || {}), id: undefined }))));
router.get('/campaigns/:id', mustWrite, wrap(async (req, res) => send(res, await Msg.get(req.user, req.params.id))));
router.put('/campaigns/:id', mustWrite, wrap(async (req, res) => send(res, await Msg.save(req.user, { ...(req.body || {}), id: req.params.id }))));
router.delete('/campaigns/:id', mustWrite, wrap(async (req, res) => send(res, await Msg.remove(req.user, req.params.id))));
router.post('/campaigns/:id/templates', mustWrite, wrap(async (req, res) => send(res, await Msg.makeTemplates(req.user, req.params.id))));
router.post('/campaigns/:id/sms-ids', mustWrite, wrap(async (req, res) => send(res, await Msg.setSmsIds(req.user, req.params.id, req.body || {}))));
router.post('/campaigns/:id/campaign', mustWrite, wrap(async (req, res) => send(res, await Msg.makeCampaign(req.user, req.params.id, req.body || {}))));

// ---- workflow automation = journeys for CRM leads (marketing/journeys.js): an event starts it, IF / THEN branching, and an AI-writes-a-person-approves message step. Nothing is sent without Approve ----
router.get('/journeys', mustWrite, wrap(async (req, res) => send(res, await Jny.overview(req.user))));
router.get('/journeys/drafts', mustWrite, wrap(async (req, res) => send(res, await Jny.draftList(req.user)))); // before /journeys/:id
router.post('/journeys/drafts/:id/decide', mustWrite, wrap(async (req, res) => send(res, await Jny.decide(req.user, req.params.id, req.body || {}))));
router.post('/journeys', mustWrite, wrap(async (req, res) => send(res, await Jny.save(req.user, { ...(req.body || {}), id: undefined }))));
router.put('/journeys/:id', mustWrite, wrap(async (req, res) => send(res, await Jny.save(req.user, { ...(req.body || {}), id: req.params.id }))));
router.delete('/journeys/:id', mustWrite, wrap(async (req, res) => send(res, await Jny.remove(req.user, req.params.id))));
router.post('/journeys/:id/on', mustWrite, wrap(async (req, res) => send(res, await Jny.setOn(req.user, req.params.id, true))));
router.post('/journeys/:id/off', mustWrite, wrap(async (req, res) => send(res, await Jny.setOn(req.user, req.params.id, false))));
router.get('/journeys/:id/runs', mustWrite, wrap(async (req, res) => send(res, await Jny.runs(req.user, req.params.id))));

// ---- lead generation to the CRM (marketing/leadgen.js): every new lead is scored Hot / Warm / Cold with reasons, given an owner, and the owner is told; nothing here messages anyone -----------------
router.get('/leads', mustWrite, wrap(async (req, res) => send(res, await Lead.overview(req.user))));
router.put('/leads/settings', mustWrite, wrap(async (req, res) => send(res, await Lead.saveSettings(req.user, req.body || {}))));
router.post('/leads/score', mustWrite, wrap(async (req, res) => send(res, await Lead.scoreNow(req.user, req.body || {}))));
router.post('/leads/import', mustWrite, express.raw({ type: () => true, limit: '8mb' }), wrap(async (req, res) => {
  const out = await Lead.importAds(req.user, Buffer.isBuffer(req.body) ? req.body : null, { fileName: String(req.query.name || ''), source: String(req.query.source || ''), ownerId: String(req.query.ownerId || ''), dryRun: String(req.query.dryRun || '') === '1' });
  return out.body !== undefined ? res.status(out.status).json(out.body) : send(res, out);
}));

// ---- email marketing (marketing/emailmk.js): the AI writes subject lines and the email of a job campaign; an A/B subject test; a template and a campaign that is saved, NEVER sent from here -----
router.get('/email/options', mustWrite, wrap(async (req, res) => send(res, await Eml.options(req.user, { q: String(req.query.q || '') }))));
router.post('/email/write', mustWrite, wrap(async (req, res) => send(res, await Eml.write(req.user, req.body || {}))));
router.post('/email/check', mustWrite, wrap(async (req, res) => send(res, await Eml.check(req.user, req.body || {}))));
router.get('/email', mustWrite, wrap(async (req, res) => send(res, await Eml.list(req.user))));
router.post('/email', mustWrite, wrap(async (req, res) => send(res, await Eml.save(req.user, { ...(req.body || {}), id: undefined }))));
router.get('/email/:id', mustWrite, wrap(async (req, res) => send(res, await Eml.get(req.user, req.params.id))));
router.put('/email/:id', mustWrite, wrap(async (req, res) => send(res, await Eml.save(req.user, { ...(req.body || {}), id: req.params.id }))));
router.delete('/email/:id', mustWrite, wrap(async (req, res) => send(res, await Eml.remove(req.user, req.params.id))));
router.post('/email/:id/template', mustWrite, wrap(async (req, res) => send(res, await Eml.makeTemplate(req.user, req.params.id))));
router.post('/email/:id/campaign', mustWrite, wrap(async (req, res) => send(res, await Eml.makeCampaign(req.user, req.params.id, req.body || {}))));

// ---- client projects (marketing/projects.js): a client's request -> accepted -> options shown -> the client picks one -> posted ----------------------------
router.get('/projects/meta', mustWrite, wrap(async (req, res) => res.json({ sources: Prj.SOURCES, deliverables: Prj.DELIVERABLES, platforms: Prj.PLATFORM_KEYS.map((k) => ({ key: k, label: Prj.PLATFORM_LABEL[k] })) })));
router.get('/projects', mustWrite, wrap(async (req, res) => send(res, await Prj.list(req.user, { status: String(req.query.status || ''), q: String(req.query.q || '') }))));
router.post('/projects', mustWrite, wrap(async (req, res) => send(res, await Prj.create(req.user, req.body || {}))));
router.post('/projects/invite', mustWrite, wrap(async (req, res) => send(res, await Prj.invite(req.user, req.body || {}))));
router.post('/projects/brief-assist', mustWrite, wrap(async (req, res) => send(res, await Prj.briefAssist(req.user, req.body || {})))); // AI writes THE BRIEF from the client and the topic
router.get('/projects/accounts', mustWrite, wrap(async (req, res) => send(res, await Prj.accounts(req.user)))); // before /projects/:id
router.get('/projects/notify', mustWrite, wrap(async (req, res) => send(res, await Prj.notifyStatus()))); // before /projects/:id
router.get('/projects/:id', mustWrite, wrap(async (req, res) => send(res, await Prj.get(req.user, req.params.id))));
router.put('/projects/:id', mustWrite, wrap(async (req, res) => send(res, await Prj.update(req.user, req.params.id, req.body || {}))));
router.post('/projects/:id/accept', mustWrite, wrap(async (req, res) => send(res, await Prj.accept(req.user, req.params.id, siteOf(req)))));
router.post('/projects/:id/decline', mustWrite, wrap(async (req, res) => send(res, await Prj.decline(req.user, req.params.id, (req.body || {}).note, siteOf(req)))));
router.post('/projects/:id/options', mustWrite, wrap(async (req, res) => send(res, await Prj.setOptions(req.user, req.params.id, req.body || {}))));
router.post('/projects/:id/send', mustWrite, wrap(async (req, res) => send(res, await Prj.send(req.user, req.params.id, req.body || {}, siteOf(req)))));
router.post('/projects/:id/tell', mustWrite, wrap(async (req, res) => send(res, await Prj.tell(req.user, req.params.id, req.body || {}, siteOf(req))))); // WhatsApp / email the client: a person's click
router.post('/projects/:id/cancel', mustWrite, wrap(async (req, res) => send(res, await Prj.cancelPresentation(req.user, req.params.id))));
router.post('/projects/:id/extend', mustWrite, wrap(async (req, res) => send(res, await Prj.extend(req.user, req.params.id, (req.body || {}).days))));
router.post('/projects/:id/scheduled', mustWrite, wrap(async (req, res) => send(res, await Prj.scheduled(req.user, req.params.id, req.body || {}))));
// the base address Meta fetches pictures / videos from: the site the person has open (https), as for "Connect with Facebook"
const siteOf = (req) => { const h = req.headers || {}; const o = h.origin && /^https?:\/\//.test(h.origin) ? h.origin : (() => { try { return h.referer ? new URL(h.referer).origin : ''; } catch { return ''; } })(); return String(o || '').replace(/\/+$/, ''); };
router.post('/projects/:id/autopost', mustWrite, wrap(async (req, res) => send(res, await Prj.setAutopost(req.user, req.params.id, req.body || {}, siteOf(req)))));
router.post('/projects/:id/post', mustWrite, wrap(async (req, res) => send(res, await Prj.postTo(req.user, req.params.id, req.body || {}, siteOf(req)))));
router.post('/projects/:id/post-now', mustWrite, wrap(async (req, res) => send(res, await Prj.postNow(req.user, req.params.id, req.body || {}, siteOf(req)))));
router.post('/projects/:id/showcase', mustWrite, wrap(async (req, res) => send(res, await Prj.setShowcase(req.user, req.params.id, req.body || {}))));
router.get('/portfolio', mustWrite, wrap(async (req, res) => res.json({ stats: await Prj.trackRecord(), items: await Prj.showcaseItems() })));
router.post('/projects/:id/posted', mustWrite, wrap(async (req, res) => send(res, await Prj.posted(req.user, req.params.id, req.body || {}))));

// ---- free stock clips (marketing/stockclips.js): search Pexels, use a clip (saved as a draft clip) ---------------------------------------------------
router.get('/stock/meta', mustWrite, wrap(async (req, res) => res.json(await Stock.meta(req.user))));
router.get('/stock/search', mustWrite, wrap(async (req, res) => send(res, await Stock.search(req.user, req.query || {}))));
router.post('/stock/import', mustWrite, wrap(async (req, res) => send(res, await Stock.importClip(req.user, req.body || {}))));
// one free stock photo as picture bytes (the background of a designed picture); the browser sends words and a shape, never an address
router.get('/stock/photo', mustWrite, wrap(async (req, res) => {
  const out = await Stock.photo(req.user, req.query || {});
  if (out.error) return res.status(out.status || 400).json({ error: out.error, code: out.code || undefined });
  res.set({ 'Content-Type': out.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=600', 'X-Photo-Credit': encodeURIComponent(`${out.author} · ${out.source}`) });
  return res.send(out.buf);
}));
// one free stock clip as video bytes (the moving background of an explainer scene); nothing is saved
router.get('/stock/clipfile', mustWrite, wrap(async (req, res) => {
  const out = await Stock.clipBytes(req.user, req.query || {});
  if (out.error) return res.status(out.status || 400).json({ error: out.error, code: out.code || undefined });
  res.set({ 'Content-Type': out.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=600', 'X-Clip-Credit': encodeURIComponent(out.author + ' · ' + out.source) });
  return res.send(out.buf);
}));
router.get('/clip-ai/meta', mustWrite, wrap(async (req, res) => res.json(await Clips.meta(req.user))));
router.post('/clip-ai', mustWrite, wrap(async (req, res) => send(res, await Clips.create(req.user, req.body || {}))));
router.get('/clip-ai/jobs/:id', mustWrite, wrap(async (req, res) => send(res, await Clips.getJob(req.user, req.params.id))));

// ---- reports (marketing/reports.js): plain numbers for a date range, and the same as a CSV --------------------------------------------------------
router.get('/reports', mustWrite, wrap(async (req, res) => send(res, await Rep.report(req.user, req.query || {}))));
router.get('/reports/csv', mustWrite, wrap(async (req, res) => {
  const out = await Rep.csv(req.user, req.query || {});
  if (out.error) return res.status(out.status || 400).json({ error: out.error });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${out.name}"`);
  return res.send(out.text);
}));

// ---- AI usage + limits -----------------------------------------------------------------------------------------------------------------
// the Admin's table "who sees what in AI Marketing" (outreach/access.js mkRoleTable: made from the rules, never typed by hand)
router.get('/roles', mustAdmin, wrap(async (req, res) => res.json({ roles: A.mkRoleTable() })));
router.get('/usage', mustWrite, wrap(async (req, res) => {
  const scopeUserId = A.isAdmin(req.user) ? null : req.user.id;
  const set = await Cfg.getSettings();
  res.json({ summary: await AI.summary({ scopeUserId }), recent: await AI.recent({ scopeUserId, limit: 50 }), settings: set, canEdit: A.isAdmin(req.user), scope: scopeUserId ? 'mine' : 'all', ai: await AI.status() });
}));
router.put('/settings', mustAdmin, wrap(async (req, res) => {
  const cur = await Cfg.getSettings();
  const c = Cfg.cleanSettings(req.body || {}, cur);
  if (c.error) return res.status(400).json({ error: c.error });
  await Cfg.saveSettings(c.value);
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: AI limits changed', entity: 'OmniMkSettings', entityId: 'settings', toValue: `${c.value.aiDailyPerUser} per person per day; company month limit ${c.value.aiMonthlyCap || 'none'}; Admin may approve own content: ${c.value.selfApprove ? 'yes' : 'no'}; client must approve: ${c.value.clientRequired ? `ON for ${c.value.clientFor.join(', ')}` : 'off'}` });
  if (JSON.stringify(c.value.waTemplates) !== JSON.stringify(cur.waTemplates)) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: WhatsApp templates for TeamLink messages changed', entity: 'OmniMkSettings', entityId: 'settings', toValue: Object.entries(c.value.waTemplates || {}).map(([k, t]) => `${k}: ${t.name} (${t.language})`).join('; ') || 'none (free text)' });
  }
  if (JSON.stringify(c.value.clientNotify) !== JSON.stringify(cur.clientNotify)) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: telling the client by WhatsApp / email changed', entity: 'OmniMkSettings', entityId: 'settings', toValue: `by itself: ${c.value.clientNotify.auto ? 'on' : 'off'}; WhatsApp: ${c.value.clientNotify.whatsapp ? 'on' : 'off'}; email: ${c.value.clientNotify.email ? 'on' : 'off'}; answering the client\'s WhatsApp messages by itself: ${c.value.clientNotify.chat ? 'on' : 'off'}; one reminder after 24 hours: ${c.value.clientNotify.remind ? 'on' : 'off'}` });
  }
  if (c.value.autoPostAllowed !== cur.autoPostAllowed) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: c.value.autoPostAllowed ? 'Omni-Channel AI Marketing: automatic posting to client accounts ALLOWED' : 'Omni-Channel AI Marketing: automatic posting to client accounts switched off', entity: 'OmniMkSettings', entityId: 'settings', toValue: c.value.autoPostAllowed ? 'on' : 'off' });
  }
  if (c.value.autoMake !== cur.autoMake) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: making the first picture options by itself changed', entity: 'OmniMkSettings', entityId: 'settings', toValue: c.value.autoMake === 'send' ? 'make them and send them to the client' : (c.value.autoMake === 'options' ? 'make them for the team to check' : 'off') });
  }
  if (c.value.clientRequired !== cur.clientRequired || JSON.stringify(c.value.clientFor) !== JSON.stringify(cur.clientFor)) {
    await logAudit({ userId: req.user.id, actorName: req.user.name, action: c.value.clientRequired ? 'Omni-Channel AI Marketing: rule switched ON - only a client can approve' : 'Omni-Channel AI Marketing: rule "only a client can approve" switched off', entity: 'OmniMkSettings', entityId: 'settings', toValue: c.value.clientRequired ? c.value.clientFor.join(', ') : 'off' });
  }
  return res.json({ ok: 'Saved.', settings: await Cfg.getSettings() });
}));

// ---- client plans, offers, delivery counters and the GBP Quality Audit (marketing/clientServices.js, 2026-11-24: the services document). Writers only; nothing here sends or posts anything. ----
router.get('/services/catalog', mustWrite, wrap(async (req, res) => res.json({ ...CS.catalog(), canWrite: true })));
router.get('/services/quote', mustWrite, wrap(async (req, res) => send(res, CS.quote(String(req.query.plan || ''), req.query.months))));
router.post('/services/gbp/score', mustWrite, wrap(async (req, res) => res.json(CS.scoreGbp((req.body || {}).answers))));
router.get('/services/gbp/audits', mustWrite, wrap(async (req, res) => send(res, await CS.listAudits(req.user, { planId: req.query.planId ? String(req.query.planId) : '', clientName: req.query.clientName ? String(req.query.clientName) : '' }))));
router.post('/services/gbp/audits', mustWrite, wrap(async (req, res) => send(res, await CS.saveAudit(req.user, req.body || {}))));
router.get('/services/gbp/audits/:id', mustWrite, wrap(async (req, res) => send(res, await CS.getAudit(req.user, req.params.id))));
// what needs a person today: plans ending in 30 days or already ended, monthly reports still empty near month end (marketing/planReminders.js; the same facts are sent once as bells)
router.get('/services/attention', mustWrite, wrap(async (req, res) => res.json({ items: await PlanRem.due(req.user) })));
router.get('/services/plans', mustWrite,wrap(async (req, res) => send(res, await CS.listPlans(req.user, { month: req.query.month, status: req.query.status ? String(req.query.status) : '' }))));
router.post('/services/plans', mustWrite, wrap(async (req, res) => send(res, await CS.createPlan(req.user, req.body || {}))));
router.get('/services/plans/:id', mustWrite, wrap(async (req, res) => send(res, await CS.getPlan(req.user, req.params.id, req.query.month))));
router.put('/services/plans/:id', mustWrite, wrap(async (req, res) => send(res, await CS.updatePlan(req.user, req.params.id, req.body || {}))));
router.post('/services/plans/:id/delivery', mustWrite, wrap(async (req, res) => send(res, await CS.setDelivery(req.user, req.params.id, req.body || {}))));
// onboarding of a new client (marketing/onboarding.js): the checklist of what to collect, claim and verify; the steps of the TeamLink tools tick themselves
router.get('/services/plans/:id/onboarding', mustWrite, wrap(async (req, res) => send(res, await Onb.get(req.user, req.params.id))));
router.put('/services/plans/:id/onboarding/:key', mustWrite, wrap(async (req, res) => send(res, await Onb.setStep(req.user, req.params.id, req.params.key, req.body || {}))));
// the monthly client report: the numbers the team types or imports (nothing invented), the printable page, the Search Console CSV reader
router.get('/services/plans/:id/report', mustWrite, wrap(async (req, res) => send(res, await Mrep.build(req.user, req.params.id, req.query.month))));
router.put('/services/plans/:id/report', mustWrite, wrap(async (req, res) => send(res, await Mrep.save(req.user, req.params.id, req.body || {}))));
router.post('/services/plans/:id/report/csv', mustWrite, wrap(async (req, res) => send(res, Mrep.parseSearchConsole((req.body || {}).text))));

// ---- SEO & visibility (2026-11-24: the services document): website check (SEO, AEO, GEO), schema and FAQ tools, industry packs, review reply drafts, the wording check with the medical reviewer's sign-off, free photos (Openverse). Writers only. Nothing is posted. ----
const siteHits = new Map(); // a website check calls the client's site about a dozen times: 20 an hour per person
const siteOk = (id, n = 1) => { const now = Date.now(); const list = (siteHits.get(id) || []).filter((t) => now - t < 3600000); if (list.length + n > 20) { siteHits.set(id, list); return false; } for (let i = 0; i < n; i += 1) list.push(now); siteHits.set(id, list); return true; }; // a competitor snapshot costs one check per website
router.get('/visibility/meta', mustWrite, wrap(async (req, res) => res.json({ industries: Packs.INDUSTRIES, fields: Mrep.FIELDS, pagespeed: await Page.status() })));
const speedHits = new Map(); // Google PageSpeed: two calls per run, 10 runs an hour per person
const speedOk = (id) => { const now = Date.now(); const list = (speedHits.get(id) || []).filter((t) => now - t < 3600000); if (list.length >= 10) { speedHits.set(id, list); return false; } list.push(now); speedHits.set(id, list); return true; };
router.post('/visibility/pagespeed', mustWrite, wrap(async (req, res) => {
  if (!speedOk(req.user.id)) return res.status(429).json({ error: 'That is 10 PageSpeed runs in the last hour. Try again later.' });
  const b = req.body || {}; const out = await Page.run(b.url); if (out.error) return send(res, out);
  if (b.checkId) { const a = await Site.attachPageSpeed(req.user, String(b.checkId), Page.compact(out)); out.attached = !a.error; }
  return res.json(out);
}));
// a check of several pages (b.pages 2 to 10) reads up to ten pages of the site, so it counts as 2 of the 20 an hour
router.post('/visibility/site-check', mustWrite, wrap(async (req, res) => (siteOk(req.user.id, Number((req.body || {}).pages) > 1 ? 2 : 1) ? send(res, await Site.check(req.user, req.body || {})) : res.status(429).json({ error: 'That is 20 website checks in the last hour (a check of several pages counts as 2). Try again later.' }))));
router.get('/visibility/site-checks', mustWrite, wrap(async (req, res) => send(res, await Site.list(req.user, { clientName: req.query.clientName ? String(req.query.clientName) : '' }))));
router.get('/visibility/site-checks/:id', mustWrite, wrap(async (req, res) => send(res, await Site.get(req.user, req.params.id))));
// competitor snapshot: the client's website and up to 3 competitors' websites side by side (competitors.js)
router.post('/visibility/competitors', mustWrite, wrap(async (req, res) => {
  const b = req.body || {}; const n = 1 + (Array.isArray(b.competitors) ? b.competitors.filter((c) => c && String(c.url || '').trim()).length : 0);
  if (!siteOk(req.user.id, Math.min(n, Comp.MAX_COMPETITORS + 1))) return res.status(429).json({ error: 'That would be more than 20 website checks in an hour. Try again later.' });
  return send(res, await Comp.snapshot(req.user, b));
}));
router.get('/visibility/competitor-snapshots', mustWrite, wrap(async (req, res) => send(res, await Comp.list(req.user, { clientName: req.query.clientName ? String(req.query.clientName) : '' }))));
router.get('/visibility/competitor-snapshots/:id', mustWrite, wrap(async (req, res) => send(res, await Comp.get(req.user, req.params.id))));
// blog planner: a month's plan of blog briefs for a client (blogPlanner.js); no network, nothing is posted. A post marked Published counts as an SEO blog on the client's plan.
router.post('/visibility/blog-plan', mustWrite, wrap(async (req, res) => send(res, await Blog.plan(req.user, req.body || {}))));
router.get('/visibility/blog-plans', mustWrite, wrap(async (req, res) => send(res, await Blog.list(req.user, { clientName: req.query.clientName ? String(req.query.clientName) : '' }))));
router.get('/visibility/blog-plans/:id', mustWrite, wrap(async (req, res) => send(res, await Blog.get(req.user, req.params.id))));
router.put('/visibility/blog-plans/:id/items/:n', mustWrite, wrap(async (req, res) => send(res, await Blog.setItem(req.user, req.params.id, req.params.n, req.body || {}))));
router.post('/visibility/schema/business', mustWrite, wrap(async (req, res) => send(res, Geo.businessSchema(req.body || {}))));
router.post('/visibility/schema/faq', mustWrite, wrap(async (req, res) => send(res, Geo.faqSchema((req.body || {}).faq))));
router.post('/visibility/describe', mustWrite, wrap(async (req, res) => send(res, Geo.describe(req.body || {}))));
router.post('/visibility/nap', mustWrite, wrap(async (req, res) => send(res, Geo.napCheck((req.body || {}).places))));
router.post('/visibility/pack', mustWrite, wrap(async (req, res) => send(res, Packs.buildPack((req.body || {}).industry, req.body || {}))));
router.post('/visibility/review-reply', mustWrite, wrap(async (req, res) => send(res, Rev.draft(req.body || {}))));
router.post('/visibility/wording-check', mustWrite, wrap(async (req, res) => send(res, Guard.check((req.body || {}).text, { industry: (req.body || {}).industry, healthcare: (req.body || {}).healthcare === true }))));
router.post('/visibility/signoff', mustWrite, wrap(async (req, res) => send(res, await Guard.signoff(req.user, req.body || {}))));
router.get('/visibility/signoffs', mustWrite, wrap(async (req, res) => send(res, await Guard.signoffs(req.user, { clientName: req.query.clientName ? String(req.query.clientName) : '' }))));
router.get('/visibility/photos', mustWrite, wrap(async (req, res) => send(res, await Ov.search(req.query.q, { page: req.query.page, shape: req.query.shape }))));

module.exports = router;
