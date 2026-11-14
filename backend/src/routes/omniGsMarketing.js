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
    limits: { aiDailyPerUser: set.aiDailyPerUser, aiMonthlyCap: set.aiMonthlyCap, selfApprove: set.selfApprove },
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
  res.json(out);
}));
// a person's own picture (PNG / JPEG / WebP, up to 10 MB) as raw bytes; the name comes in the address
router.post('/images/upload', mustWrite, express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '11mb' }), wrap(async (req, res) => send(res, await Img.saveUpload(req.user, req.body, req.headers['content-type'], req.query || {}))));
// AI Video: the slideshow made in the browser arrives as raw MP4 / WebM bytes (up to 40 MB); the details come in the address
router.post('/images/video', mustWrite, express.raw({ type: ['video/mp4', 'video/webm'], limit: '41mb' }), wrap(async (req, res) => send(res, await Img.saveVideo(req.user, req.body, req.headers['content-type'], req.query || {}))));
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
router.post('/client-reviews', mustWrite, wrap(async (req, res) => send(res, await CR.create(req.user, req.body || {}))));
router.post('/client-reviews/:id/revoke', mustWrite, wrap(async (req, res) => send(res, await CR.revoke(req.user, req.params.id))));
router.post('/client-reviews/:id/extend', mustWrite, wrap(async (req, res) => send(res, await CR.extend(req.user, req.params.id, (req.body || {}).days))));

// ---- AI clips (marketing/aiclips.js): a real-motion clip from Google Veo; paid, so the cost must be confirmed and a daily limit applies ------------------
// ---- free stock clips (marketing/stockclips.js): search Pexels, use a clip (saved as a draft clip) ---------------------------------------------------
router.get('/stock/meta', mustWrite, wrap(async (req, res) => res.json(await Stock.meta(req.user))));
router.get('/stock/search', mustWrite, wrap(async (req, res) => send(res, await Stock.search(req.user, req.query || {}))));
router.post('/stock/import', mustWrite, wrap(async (req, res) => send(res, await Stock.importClip(req.user, req.body || {}))));
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
  await logAudit({ userId: req.user.id, actorName: req.user.name, action: 'Omni-Channel AI Marketing: AI limits changed', entity: 'OmniMkSettings', entityId: 'settings', toValue: `${c.value.aiDailyPerUser} per person per day; company month limit ${c.value.aiMonthlyCap || 'none'}; Admin may approve own content: ${c.value.selfApprove ? 'yes' : 'no'}` });
  return res.json({ ok: 'Saved.', settings: await Cfg.getSettings() });
}));

module.exports = router;
