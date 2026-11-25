// ---------------------------------------------------------------------------
// AI MARKETING > AI AGENT > THE TOOLS (2026-11-25). The agent does NOT redo anything: every tool here is a thin, checked call to a service that already exists in AI Marketing, run AS the
// person who approved the plan (their role, their limits, their audit trail). A tool takes a structured input and gives a structured output { summary, refs, data } or throws a ToolError.
//   risk      'internal' = only creates drafts / audits / requests inside TeamLink; 'outward' = reaches a real person or the public (a post, a message, a call, ad spend, a live website change).
//             THE ENGINE REFUSES TO RUN AN OUTWARD TOOL WITHOUT A SEPARATE, PER-TASK APPROVAL (agent.js), on top of the plan's approval. Phase 1 has no outward tool: posting stays by hand
//             (a 'manual' step the person confirms), so the safety rule is built and tested before the first outward tool is added (publishing, WhatsApp, calls come in later phases).
//   cost      what a call costs, honestly: kind 'free' (plain code) or 'free-tier' (a free allowance) or 'paid'; rupees per unit (0 for everything today). The dashboard adds these up.
//   manual    a step only a person can do (post by hand, make the video in the browser, talk to the website owner). The agent lists it, reminds, and records when the person marks it done.
// Every tool can be replaced by a stand-in in tests (ctx.svc), and nothing real is touched there.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

class ToolError extends Error {
  constructor(message, code = 'failed', opts = {}) { super(message); this.name = 'ToolError'; this.code = code; this.retryable = !!opts.retryable; this.waiting = !!opts.waiting; }
}
const svcOf = (ctx) => ({
  C: (ctx.svc && ctx.svc.C) || require('./content'), Img: (ctx.svc && ctx.svc.Img) || require('./images'), Site: (ctx.svc && ctx.svc.Site) || require('./siteCheck'), Blog: (ctx.svc && ctx.svc.Blog) || require('./blogPlanner'), // eslint-disable-line global-require
});
const clip = (s, n) => S.clip(s, n);
const dayOf = (plan, n) => (plan.days || []).find((d) => d.n === n) || null;
const fail = (r, d = 'It did not work.') => {
  const msg = clip((r && (r.error || r.message)) || d, 300);
  const busy = r && (r.code === 'busy' || /Too many .* requests in one minute|still being made/i.test(String(r.error || '')));
  return new ToolError(msg, (r && r.code) || (r && r.status ? `http_${r.status}` : 'failed'), { retryable: !!busy, waiting: !!(r && r.code === 'client_required') });
};

const TOOLS = {
  'content.draft': {
    label: 'Write the draft', module: 'AI Content', page: 'mkapprove', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'draft', rupees: 0, note: 'plain code, no AI model' },
    does: (t, d) => `Saves "${d ? d.title : 'the draft'}" as a draft in AI Content, one text for each platform. It is a draft: nothing is sent or posted.`,
    build: (plan, d, biz) => ({ title: d.title, brief: clip(`${plan.goalText}. ${d.objective}`, 1500), goal: plan.goalType, audience: clip(biz.audience || '', 200), cta: clip(biz.contactLine || '', 80), tone: clip(biz.tone || '', 40), language: clip(biz.language || 'English', 20), channels: d.platforms, texts: d.texts }),
    async run(ctx, input) {
      const { C } = svcOf(ctx);
      const r = await C.create(ctx.u, { ...input, ai: { provider: 'plain code', model: 'AI Agent planner', demo: false } });
      if (!r || r.error) throw fail(r);
      return { summary: `Draft "${r.item.title}" saved in AI Content.`, refs: [{ kind: 'content', id: r.item.id, label: r.item.title, page: 'mkapprove' }], data: { itemId: r.item.id } };
    },
  },
  'image.banner': {
    label: 'Design the banner', module: 'AI Images', page: 'mkimages', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'banner', rupees: 0, note: 'designed by plain code, no AI service' },
    does: (t, d) => `Designs a banner (${d ? d.bannerSize : '1:1'}) with the headline "${d ? d.headline : ''}", the brand colours and the logo, saved as a draft picture in AI Images.`,
    build: (plan, d, biz) => ({ size: d.bannerSize, headline: clip(d.headline, 90), sub: clip(d.sub, 80), cta: d.theme === 'contact' ? 'Enquire now' : 'Know more', footer: clip(biz.contactLine || biz.website || '', 100), title: clip(`${d.title} (banner)`, 80), projectId: biz.projectId || '' }),
    async run(ctx, input) {
      const { Img } = svcOf(ctx);
      const r = await Img.createBanner(ctx.u, input);
      if (!r || r.error) throw fail(r);
      return { summary: `Banner "${r.item.title}" saved in AI Images.`, refs: [{ kind: 'image', id: r.item.id, label: r.item.title, page: 'mkimages' }], data: { itemId: r.item.id } };
    },
  },
  'image.ai': {
    label: 'Make the picture with AI', module: 'AI Images', page: 'mkimages', risk: 'internal', auto: true, cost: { kind: 'free-tier', unit: 'picture', rupees: 0, note: 'uses the free daily allowance of the AI picture service an Admin set up (Cloudflare Workers AI is free; if only a Google Gemini key is set, Google\'s own price applies and is shown there)' },
    does: (t, d) => `Asks the AI picture service for one picture from the prompt, in the brand colours. It counts against your daily picture limit and is saved as a draft in AI Images.`,
    build: (plan, d, biz) => ({ prompt: d.mediaPrompt, aspect: d.bannerSize === '16:9' ? '16:9' : d.bannerSize === '9:16' ? '9:16' : '1:1', style: 'graphic', count: 1, title: clip(`${d.title} (picture)`, 80), withLogo: false, projectId: biz.projectId || '' }),
    async available(ctx) { const { Img } = svcOf(ctx); const st = await Img.status(); return st && st.ready ? { ok: true, note: st.demo ? 'test sample picture' : `via ${st.provider || 'the picture service'}` } : { ok: false, reason: (st && st.reason) || 'AI pictures are not set up.' }; },
    async run(ctx, input) {
      const { Img } = svcOf(ctx);
      const r = await Img.create(ctx.u, input, { wait: true });
      if (!r || r.error) throw fail(r);
      const it = (r.items || [])[0]; if (!it) throw new ToolError('No picture came back.', 'empty', { retryable: true });
      return { summary: `Picture "${it.title}" saved in AI Images${r.demo ? ' (test sample)' : ''}.`, refs: [{ kind: 'image', id: it.id, label: it.title, page: 'mkimages' }], data: { itemId: it.id, demo: !!r.demo } };
    },
  },
  'approval.request': {
    label: 'Ask the team to approve', module: 'Approvals', page: 'mkapprove', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'request', rupees: 0, note: 'a bell notice to the approvers inside TeamLink' },
    does: () => 'Asks the approvers to look at this day\'s draft and picture (they get a bell notice inside TeamLink). Nobody outside TeamLink is told. If your company requires the CLIENT to approve, this step waits for you to use "Ask client to approve" on the item.',
    build: () => ({}),
    async run(ctx) {
      const { C, Img } = svcOf(ctx);
      const sib = ctx.dayTasks || []; const get = (re) => sib.find((x) => re.test(x.tool) && x.status === 'done' && x.output && x.output.data && x.output.data.itemId);
      const draft = get(/^content\.draft$/); const pic = get(/^image\./);
      if (!draft) throw new ToolError('There is no draft to send for approval.', 'no_draft');
      const told = [];
      const one = async (label, fn, id) => {
        const r = await fn(ctx.u, id);
        if (r && r.error) {
          if (r.status === 409 && !r.code) { told.push(`${label}: already with the approvers or approved`); return; }
          throw fail(r);
        }
        told.push(`${label}: ${clip(r && r.ok, 120) || 'sent for approval'}`);
      };
      await one('Draft', C.submit, draft.output.data.itemId);
      if (pic) { try { await one('Picture', Img.submit, pic.output.data.itemId); } catch (e) { if (e.waiting) throw e; told.push(`Picture: could not be sent (${e.message})`); } }
      return { summary: told.join('. ') + '.', refs: [{ kind: 'content', id: draft.output.data.itemId, label: 'Draft', page: 'mkapprove' }, ...(pic ? [{ kind: 'image', id: pic.output.data.itemId, label: 'Picture', page: 'mkapprove' }] : [])], data: { contentId: draft.output.data.itemId, imageId: pic ? pic.output.data.itemId : null } };
    },
  },
  'seo.sitecheck': {
    label: 'Check the website', module: 'SEO & visibility', page: 'mkvisibility', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'check', rupees: 0, note: 'reads the website once with plain code' },
    does: (t, d, plan) => `Reads ${plan && plan.seo ? plan.seo.url : 'the website'} (up to ${plan && plan.seo ? plan.seo.pages : 5} pages, public pages only) and scores what is on the page: TeamLink's own score, not rankings or traffic. Saved for the client. Nothing on the website is changed.`,
    build: (plan, d, biz) => ({ url: plan.seo.url, pages: plan.seo.pages, save: true, clientName: clip(biz.name, 120) }),
    async run(ctx, input) {
      const { Site } = svcOf(ctx);
      const r = await Site.check(ctx.u, input, ctx.fetchFn ? { fetchFn: ctx.fetchFn } : {});
      if (!r || r.error) throw fail(r);
      const rep = r.report || {}; const acts = (rep.actions || []).slice(0, 5).map((a) => clip(typeof a === 'string' ? a : (a.text || a.fix || a.title || a.what || ''), 200)).filter(Boolean);
      return { summary: `Website check saved: ${rep.score}/100 (TeamLink's own score of what is on the page).`, refs: [{ kind: 'sitecheck', id: r.id, label: `Website check ${rep.score}/100`, page: 'mkvisibility' }], data: { itemId: r.id, score: rep.score, url: rep.url || input.url, top: acts } };
    },
  },
  'seo.blogplan': {
    label: "Plan this month's blog posts", module: 'SEO & visibility', page: 'mkvisibility', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'plan', rupees: 0, note: 'plain code, no network' },
    does: () => 'Plans up to 4 blog briefs for this month from the saved services and the latest website check. A brief is not an article: nothing is written or posted.',
    build: (plan, d, biz) => ({ name: clip(biz.name, 120), clientName: clip(biz.name, 120), services: (biz.services || []).join(', '), city: (biz.locations || [])[0] || '', website: clip(biz.website, 200), industry: biz.industryKey || '', count: 4, save: true }),
    async run(ctx, input) {
      const { Blog } = svcOf(ctx);
      if (!String(input.services || '').trim()) throw new ToolError('No services are saved for this business: the blog planner needs at least one. Add them under "Business" and retry.', 'no_services');
      const r = await Blog.plan(ctx.u, input);
      if (!r || r.error) throw fail(r);
      const n = ((r.plan && (r.plan.briefs || r.plan.items)) || []).length;
      return { summary: `Blog plan saved: ${n} brief${n === 1 ? '' : 's'} (nothing is written or posted).`, refs: [{ kind: 'blogplan', id: r.id, label: 'Blog plan', page: 'mkvisibility' }], data: { itemId: r.id, briefs: n } };
    },
  },
  // ---- steps only a person can do -----------------------------------------------------------------------------------------------------------------------
  'manual.post': { label: 'Post it (by hand)', module: 'You', page: 'mkimages', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'post', rupees: 0, note: 'done by a person' },
    does: () => 'Waits for you. When the draft and picture are approved, post them yourself (AI Images > the approved picture > Post, or by hand), then mark this step done. The agent never posts by itself in this phase.', build: () => ({}) },
  'manual.video': { label: 'Make the video', module: 'You', page: 'mkvideos', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'video', rupees: 0, note: 'done by a person in AI Video (free slideshow video made in your browser)' },
    does: () => 'Waits for you. A video is put together in your browser on the AI Video screen: use the scenes of this plan, then mark this step done.', build: () => ({}) },
  'manual.note': { label: 'A step for a person', module: 'You', page: 'mkvisibility', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'step', rupees: 0, note: 'done by a person' }, does: (t) => (t && t.note) || 'Waits for you; mark it done when it is finished.', build: () => ({}) },
};

const COST_WORDS = { free: 'Free', 'free-tier': 'Free tier', paid: 'Paid' };
const catalog = () => Object.entries(TOOLS).map(([id, t]) => ({ id, label: t.label, module: t.module, page: t.page, risk: t.risk, manual: !!t.manual, cost: { ...t.cost, word: COST_WORDS[t.cost.kind] || t.cost.kind } }));
const isOutward = (tool) => !!TOOLS[tool] && TOOLS[tool].risk === 'outward';

module.exports = { TOOLS, ToolError, catalog, isOutward, dayOf, svcOf };
