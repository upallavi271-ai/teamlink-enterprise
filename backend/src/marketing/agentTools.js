// ---------------------------------------------------------------------------
// AI MARKETING > AI AGENT > THE TOOLS (2026-11-25). The agent does NOT redo anything: every tool here is a thin, checked call to a service that already exists in AI Marketing, run AS the
// person who approved the plan (their role, their limits, their audit trail). A tool takes a structured input and gives a structured output { summary, refs, data } or throws a ToolError.
//   risk      'internal' = only creates drafts / audits / requests inside TeamLink; 'outward' = reaches a real person or the public (a post, a message, a call, ad spend, a live website change).
//             THE ENGINE REFUSES TO RUN AN OUTWARD TOOL WITHOUT A SEPARATE, PER-TASK APPROVAL (agent.js), on top of the plan's approval. Phase 2 adds the first two outward tools: social.post (publish an
//             APPROVED picture with its caption on connected Facebook / Instagram / X accounts, at its scheduled time) and client.review (send the picture to the client's WhatsApp to approve). Each one
//             is approved by a person step by step: they pick the accounts / confirm who the client is, and see exactly what goes out. WhatsApp bulk sending, calls and ad spend are still not tools.
//   prepare   an outward tool describes what the approval dialog must show (ready, or why not, and the choices) from the LIVE state; approval(body) checks the person's choices and says in words what was approved.
//   cost      what a call costs, honestly: kind 'free' (plain code) or 'free-tier' (a free allowance) or 'paid'; rupees per unit (0 for everything today). The dashboard adds these up.
//   (Phase 3) the SEO assistant's audit, keywords and texts are tools here (seo.audit / seo.keywords / seo.content): they call marketing/seoSites, seoAudit, seoKeywords and seoContent, never copy them.
//   seo.google reads the client's real Search Console / Analytics numbers (marketing/seoGoogle.js, read only); when Google is not set up for the client it says what is missing and the plan carries on.
//   (Phase 4) video: one picture per SCENE (a person joins them in AI Video, in the browser: there is no server-side rendering), optional free stock clips; voice: a CALL SHEET for a person to call from the CRM
//             (the agent never calls and never uses AI Calling, which is built for job candidates with a recorded consent).
//   manual    a step only a person can do (post by hand, make the video in the browser, talk to the website owner). The agent lists it, reminds, and records when the person marks it done.
// Every tool can be replaced by a stand-in in tests (ctx.svc), and nothing real is touched there.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

class ToolError extends Error {
  constructor(message, code = 'failed', opts = {}) { super(message); this.name = 'ToolError'; this.code = code; this.retryable = !!opts.retryable; this.waiting = !!opts.waiting; }
}
const svcOf = (ctx) => ({
  Stock: (ctx.svc && ctx.svc.Stock) || require('./stockclips'), Lead: (ctx.svc && ctx.svc.Lead) || require('./leadgen'), WA: (ctx.svc && ctx.svc.WA) || require('../omniwa/services'),
  Sites: (ctx.svc && ctx.svc.Sites) || require('./seoSites'), Audit: (ctx.svc && ctx.svc.Audit) || require('./seoAudit'), Kw: (ctx.svc && ctx.svc.Kw) || require('./seoKeywords'), Google: (ctx.svc && ctx.svc.Google) || require('./seoGoogle'), Content: (ctx.svc && ctx.svc.Content) || require('./seoContent'),
  Post: (ctx.svc && ctx.svc.Post) || require('./postItem'), CR: (ctx.svc && ctx.svc.CR) || require('./clientReview'), C: (ctx.svc && ctx.svc.C) || require('./content'), Img: (ctx.svc && ctx.svc.Img) || require('./images'), Site: (ctx.svc && ctx.svc.Site) || require('./siteCheck'), Blog: (ctx.svc && ctx.svc.Blog) || require('./blogPlanner'), // eslint-disable-line global-require
});
const clip = (s, n) => S.clip(s, n);
// the facts the SEO assistant's copy writers take, from what is saved for the business (nothing else)
const seoFacts = (biz) => ({ name: clip(biz.name, 140), city: clip((biz.locations || [])[0] || '', 140), areas: clip((biz.locations || []).join(', '), 400), services: clip((biz.services || []).join(', '), 400), audience: clip(biz.audience || '', 140) });
// the client's SEO site (one per client): the existing one is used as it is, a missing one is started from the saved facts (audits off: nothing is scheduled by itself)
async function seoSiteOf(ctx, input) {
  const { Sites } = svcOf(ctx);
  const list = await Sites.list(ctx.u); if (!list || list.error) throw fail(list, 'The SEO sites could not be opened.');
  const found = (list.items || []).find((x) => String(x.clientName).trim().toLowerCase() === String(input.clientName || '').trim().toLowerCase());
  if (found) return found;
  const made = await Sites.save(ctx.u, { clientName: input.clientName, url: input.url, industry: input.industry, facts: input.facts || {}, schedule: 'off', pages: input.pages });
  if (!made || made.error) throw fail(made, 'The SEO site could not be started.');
  return made.site;
}
const SOCIAL = ['instagram', 'facebook', 'x'];
const WA_FIELDS = ['name', 'service', 'business', 'callback']; const WA_BANDS = ['Hot', 'Warm', 'Cold'];
// what the person chose for the WhatsApp campaign (a query string or the approval body): the template, what fills each blank, which bands, how many days between campaign messages
function waChoice(q, tpls) {
  const list = (v) => (Array.isArray(v) ? v : String(v == null ? '' : v).split(',')).map((x) => String(x).trim()).filter(Boolean);
  const tpl = tpls.find((t) => t.id === String(q.templateId || '')) || tpls[0] || null; const given = list(q.varMap);
  return { templateId: tpl ? tpl.id : '', varMap: given.length ? given : WA_FIELDS.slice(0, tpl ? tpl.blanks : 0), bands: list(q.bands).filter((b) => WA_BANDS.includes(b)), gapDays: Math.max(1, Math.min(90, Math.round(Number(q.gapDays)) || 7)) };
}
const WORD = { instagram: 'Instagram', facebook: 'Facebook', x: 'X' };
const STATUS_WORDS = { draft: 'still a draft', waiting: 'still waiting for approval', changes: 'sent back with changes', approved: 'approved' };
const listWords = (a) => (a.length <= 1 ? (a[0] || '') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const siteOk = (base) => { try { return !!require('./projects').siteFor(base); } catch { return false; } }; // eslint-disable-line global-require
// the picture the day's earlier step made (the output of image.banner / image.ai)
const picOf = (ctx) => (ctx.dayTasks || []).find((x) => /^image\./.test(x.tool) && x.status === 'done' && x.output && x.output.data && x.output.data.itemId) || null;
const imageRow = async (id) => (await S.q('SELECT id, title, status FROM "OmniMkImage" WHERE id = ? AND deletedAt IS NULL', String(id || '')))[0] || null;
const accountsOf = async (ctx) => { const sv = ctx.svc && ctx.svc.accounts; return sv ? sv(ctx.u) : require('./projects').accounts(ctx.u); }; // eslint-disable-line global-require
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
    build: (plan, d, biz, args) => { const sc = args && args.scene != null && d.scenes ? d.scenes[args.scene] : null; return { size: d.bannerSize, headline: clip(sc ? sc.headline : d.headline, 90), sub: clip(sc ? sc.sub : d.sub, 80), cta: (sc ? sc.label === 'call to action' : d.theme === 'contact') ? 'Enquire now' : 'Know more', footer: clip(biz.contactLine || biz.website || '', 100), title: clip(`${d.title} (${sc ? `scene ${sc.n}` : 'banner'})`, 80), projectId: biz.projectId || '' }; },
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
    build: (plan, d, biz, args) => { const sc = args && args.scene != null && d.scenes ? d.scenes[args.scene] : null; const col = biz.colors || {}; const prompt = sc ? clip(`A clean, modern marketing picture for ${biz.name}${biz.industry ? ` (${String(biz.industry).toLowerCase()})` : ''}. ${sc.text}.${col.primary ? ` Use the brand colours ${col.primary}${col.secondary ? ` and ${col.secondary}` : ''}.` : ''} Leave empty space for a headline. No words, no logos, no faces of real people.${plan.healthcare ? ' No patients, no medical results, no before-and-after.' : ''}`, 900) : d.mediaPrompt; return { prompt, aspect: d.bannerSize === '16:9' ? '16:9' : d.bannerSize === '9:16' ? '9:16' : '1:1', style: 'graphic', count: 1, title: clip(`${d.title} (${sc ? `scene ${sc.n}` : 'picture'})`, 80), withLogo: false, projectId: biz.projectId || '' }; },
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
      const draft = get(/^content\.draft$/); const pics = sib.filter((x) => /^image\./.test(x.tool) && x.status === 'done' && x.output && x.output.data && x.output.data.itemId); const pic = pics[0] || null;
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
      for (const [k, x] of pics.entries()) { try { await one(pics.length > 1 ? `Picture ${k + 1}` : 'Picture', Img.submit, x.output.data.itemId); } catch (e) { if (e.waiting) throw e; told.push(`Picture${pics.length > 1 ? ` ${k + 1}` : ''}: could not be sent (${e.message})`); } } // eslint-disable-line no-await-in-loop
      return { summary: told.join('. ') + '.', refs: [{ kind: 'content', id: draft.output.data.itemId, label: 'Draft', page: 'mkapprove' }, ...pics.map((x, k) => ({ kind: 'image', id: x.output.data.itemId, label: pics.length > 1 ? `Picture ${k + 1}` : 'Picture', page: 'mkapprove' }))], data: { contentId: draft.output.data.itemId, imageId: pic ? pic.output.data.itemId : null, imageIds: pics.map((x) => x.output.data.itemId) } };
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
  // ---- the SEO assistant's own services (marketing/seo*.js): the agent calls them, it does not copy them ------------------------------------------------------------------------
  'seo.audit': {
    label: 'Audit the website (SEO assistant)', module: 'SEO assistant', page: 'mkseo', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'audit', rupees: 0, note: 'reads the public pages once with plain code' },
    does: (t, d, plan) => `Reads ${plan && plan.seo ? plan.seo.url : 'the website'} (up to ${plan && plan.seo ? plan.seo.pages : 5} public pages) with the SEO assistant and scores what is on the page (TeamLink's own score, not rankings or traffic). The findings are kept as recommendation tasks for the client, and what changed since the last audit is noted. Nothing on the website is changed.`,
    build: (plan, d, biz) => ({ url: plan.seo.url, pages: plan.seo.pages, clientName: clip(biz.name, 120), industry: biz.industryKey || '', facts: seoFacts(biz) }),
    async run(ctx, input) {
      const { Audit, Sites } = svcOf(ctx);
      const site = await seoSiteOf(ctx, input); const raw = await Sites.mine(ctx.u, site.id);
      if (!raw) throw new ToolError('The SEO site of this client could not be opened.', 'no_site');
      const r = await Audit.run(ctx.u, raw, ctx.fetchFn ? { fetchFn: ctx.fetchFn } : {});
      if (!r || r.error) throw fail(r);
      const top = ((r.report && r.report.actions) || []).slice(0, 5).map((a) => clip(typeof a === 'string' ? a : (a.text || a.fix || a.title || a.what || ''), 200)).filter(Boolean);
      const open = (r.tasks && r.tasks.open) || 0;
      return { summary: `Website audit saved: ${r.score}/100${r.prev != null ? ` (was ${r.prev})` : ''}; ${open} open recommendation${open === 1 ? '' : 's'} kept for ${site.clientName}.`, refs: [{ kind: 'sitecheck', id: r.checkId, label: `Website audit ${r.score}/100`, page: 'mkseo' }], data: { itemId: r.checkId, siteId: site.id, score: r.score, previous: r.prev, url: raw.url, open, top } };
    },
  },
  'seo.google': {
    label: 'Read the Google search numbers', module: 'SEO assistant', page: 'mkseo', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'reading', rupees: 0, note: "Google's free Search Console and Analytics APIs, read only" },
    does: () => "Reads what Google reports for the website: Search Console clicks, times seen, position and the real searches, and Analytics visits when its property number is saved (the last 28 days against the 28 before). Read only: nothing changes on Google or on the website. If Google is not set up for this client, the step says what is missing and the plan carries on.",
    build: (plan, d, biz) => ({ url: plan.seo.url, pages: plan.seo.pages, clientName: clip(biz.name, 120), industry: biz.industryKey || '', facts: seoFacts(biz) }),
    async run(ctx, input) {
      const { Google, Sites, Kw } = svcOf(ctx);
      const site = await seoSiteOf(ctx, input); const raw = await Sites.mine(ctx.u, site.id);
      if (!raw) throw new ToolError('The SEO site of this client could not be opened.', 'no_site');
      const r = await Google.readForAgent(ctx.u, raw, ctx.googleOpts || {});
      if (r.retry) throw new ToolError(r.why.join(' '), 'google', { retryable: true });
      const refs = [{ kind: 'google', id: site.id, label: 'Google numbers', page: 'mkseo' }];
      if (!r.read) return { summary: `Google numbers were not read for ${site.clientName}. ${r.why.join(' ')}`, refs, data: { itemId: site.id, siteId: site.id, read: false, why: r.why } };
      const opp = await Kw.opportunities(site.id, 5);
      const top = ((opp && opp.items) || []).map((x) => `${x.query} (position ${x.position}, seen ${x.impressions} times)`);
      const words = [...Google.sentences(r), r.matched ? `The Search Console property ${r.matched} was matched to the website and saved.` : '', top.length ? `Close to the top: ${top.slice(0, 3).join('; ')}.` : '', ...r.why].filter(Boolean);
      return { summary: words.join(' '), refs, data: { itemId: site.id, siteId: site.id, read: true, why: r.why, top } };
    },
  },
  'seo.keywords': {
    label: 'Research and keep keyword ideas (SEO assistant)', module: 'SEO assistant', page: 'mkseo', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'list', rupees: 0, note: 'plain code, no network' },
    does: () => 'Builds keyword ideas from the saved services, city and kind of business (primary, local, secondary) and keeps the best few in the client\'s kept list, with up to 5 real searches from Google Search Console that are close to the top when they were read. TeamLink has no free source for search volume or difficulty, so none is shown or invented.',
    build: (plan, d, biz) => ({ url: plan.seo.url, pages: plan.seo.pages, clientName: clip(biz.name, 120), industry: biz.industryKey || '', facts: seoFacts(biz) }),
    async run(ctx, input) {
      const { Kw } = svcOf(ctx);
      const site = await seoSiteOf(ctx, input);
      const r = await Kw.research(ctx.u, { siteId: site.id });
      if (!r || r.error) throw fail(r);
      const pick = []; const take = { primary: 4, local: 3, secondary: 3 };
      for (const g of ['primary', 'local', 'secondary']) ((r.groups || []).find((x) => x.key === g) || { items: [] }).items.slice(0, take[g]).forEach((i) => pick.push({ phrase: i.phrase, group: g, intent: i.intent, source: 'agent' }));
      const real = (((r.known && r.known.items) || []).filter((x) => !x.saved).slice(0, 5)); real.forEach((x) => pick.push({ phrase: x.query, group: 'query', source: 'search console' }));
      if (!pick.length) throw new ToolError('No keyword idea could be made from the saved facts. Add the services and the city under "Business" and retry.', 'no_ideas');
      const kept = await Kw.save(ctx.u, site.id, { phrases: pick });
      if (!kept || kept.error) throw fail(kept);
      return { summary: `${kept.added} keyword idea${kept.added === 1 ? '' : 's'} kept for ${site.clientName}${kept.alreadyThere ? ` (${kept.alreadyThere} already there)` : ''}${real.length ? `, including ${real.length} real search${real.length === 1 ? '' : 'es'} from Google Search Console close to the top` : ''}. No search volumes: TeamLink has no source for them.`, refs: [{ kind: 'keywords', id: site.id, label: 'Kept keywords', page: 'mkseo' }], data: { itemId: site.id, kept: kept.added, ideas: pick.length, top: pick.slice(0, 5).map((x) => x.phrase) } };
    },
  },
  'seo.content': {
    label: 'Write the home page texts (SEO assistant)', module: 'SEO assistant', page: 'mkseo', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'text', rupees: 0, note: 'plain code, no AI model' },
    does: () => 'Writes the home page title and description and the FAQ from the client\'s saved facts only (no invented prices, results or claims) and keeps them in the SEO assistant for the person who runs the website to use. Nothing is published or changed on the website.',
    build: (plan, d, biz) => ({ url: plan.seo.url, pages: plan.seo.pages, clientName: clip(biz.name, 120), industry: biz.industryKey || '', facts: seoFacts(biz) }),
    async run(ctx, input) {
      const { Content } = svcOf(ctx);
      const site = await seoSiteOf(ctx, input);
      const saved = []; const errors = [];
      for (const [kind, title] of [['meta', 'Home page title and description'], ['faq', 'FAQ for the website']]) {
        const m = await Content.make(ctx.u, { siteId: site.id, kind, input: {} }); // eslint-disable-line no-await-in-loop
        if (!m || m.error) { errors.push(`${title}: ${clip((m && m.error) || 'it could not be written', 160)}`); continue; } // eslint-disable-line no-continue
        const k = await Content.saveItem(ctx.u, site.id, { kind, title, body: m.result }); // eslint-disable-line no-await-in-loop
        if (!k || k.error) { errors.push(`${title}: ${clip((k && k.error) || 'it could not be kept', 160)}`); continue; } // eslint-disable-line no-continue
        saved.push(title);
      }
      if (!saved.length) throw new ToolError(errors.join(' ') || 'Nothing could be written.', 'no_text');
      return { summary: `${saved.join(' and ')} kept in the SEO assistant for ${site.clientName}.${errors.length ? ` Not written: ${errors.join(' ')}` : ''}`, refs: [{ kind: 'seotext', id: site.id, label: 'SEO texts', page: 'mkseo' }], data: { itemId: site.id, saved } };
    },
  },
  // ---- PHASE 4: video and voice ---------------------------------------------------------------------------------------------------------------------------------------------
  'video.clips': {
    label: 'Find free stock clips', module: 'AI Video', page: 'mkimages', risk: 'internal', auto: true, cost: { kind: 'free-tier', unit: 'clip', rupees: 0, note: 'a free stock footage source (Pixabay or Pexels) with the key an Admin saved; each clip counts against the daily clip limit' },
    does: () => 'Searches the free stock footage source an Admin set up for clips that match this video and saves the best two in AI Images as raw footage. They are generic clips under the source\'s free licence, not footage of the business; each must be approved before AI Video can use it.',
    build: (plan, d, biz) => ({ q: clip(d.service || biz.industry || 'business team', 60), orientation: 'portrait', n: 2 }),
    async available(ctx) { const { Stock } = svcOf(ctx); const st = await Stock.status(); return st && st.ready ? { ok: true } : { ok: false, reason: (st && st.reason) || 'Stock clips are not set up.' }; },
    async run(ctx, input) {
      const { Stock } = svcOf(ctx);
      const found = await Stock.search(ctx.u, { q: input.q, orientation: input.orientation });
      if (!found || found.error) throw fail(found, 'The stock clips could not be searched.');
      const picks = (found.items || []).slice(0, input.n || 2);
      if (!picks.length) throw new ToolError(`No stock clip matched "${input.q}". Search again with other words in AI Video.`, 'no_clips');
      const saved = []; const errors = [];
      for (const x of picks) {
        const r = await Stock.importClip(ctx.u, { id: x.id, query: input.q }); // eslint-disable-line no-await-in-loop
        const it = r && !r.error ? (r.item || null) : null;
        if (it) saved.push(it); else errors.push(clip((r && r.error) || 'a clip could not be saved', 140));
      }
      if (!saved.length) throw new ToolError(errors.join(' ') || 'No clip could be saved.', 'no_clips');
      return { summary: `${saved.length} stock clip${saved.length === 1 ? '' : 's'} saved in AI Images for "${input.q}" (raw footage: approve before use).${errors.length ? ` Not saved: ${errors[0]}` : ''}`, refs: saved.map((it) => ({ kind: 'image', id: it.id, label: it.title, page: 'mkimages' })), data: { itemId: saved[0].id, clips: saved.map((it) => it.id), query: input.q } };
    },
  },
  // the leads who showed interest while the plan ran, for a PERSON to call. The agent never calls and never uses AI Calling (built for job candidates with a recorded consent) for marketing leads.
  'calling.sheet': {
    label: 'Build the call sheet', module: 'CRM', page: 'crm', risk: 'internal', auto: true, scheduled: true, cost: { kind: 'free', unit: 'sheet', rupees: 0, note: 'read from the CRM, nothing is called' },
    does: () => 'When the plan ends (or when you press "Build it now") lists the leads who showed interest while it ran, from the CRM: who, how warm and why, where they came from and, for WhatsApp leads, what they asked and when to call. It calls nobody: your team calls from the CRM. Phone numbers and emails stay masked here.',
    build: (plan, d, biz) => ({ business: clip(biz.name, 120) }),
    async run(ctx, input) {
      const { Lead, WA } = svcOf(ctx);
      const o = await Lead.overview(ctx.u);
      if (!o || o.error) throw new ToolError(`The CRM leads cannot be read for your login (${clip((o && o.error) || 'unknown reason', 160)}) Ask a Sales manager or an Admin to add you in the CRM settings, then use "Build it now".`, 'no_crm');
      const from = Number((ctx.run && ctx.run.startedAt) || 0);
      const live = (o.leads || []).filter((l) => Date.parse(l.createdAt) >= from && !/\b(lost|junk|won|converted|closed|dead)\b/i.test(`${l.status || ''} ${l.stage || ''}`));
      const rank = { Hot: 0, Warm: 1 };
      const worth = live.filter((l) => l.band === 'Hot' || l.band === 'Warm').sort((a, b) => rank[a.band] - rank[b.band] || (Number(b.score) || 0) - (Number(a.score) || 0) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
      const rows = [];
      for (const l of worth.slice(0, 25)) {
        let asked = null; let bestTime = null; let note = '';
        if (rows.length < 15) { // a WhatsApp lead has what the customer told the assistant (the WhatsApp assistant's own service): the others simply have no such detail
          const w = await WA.call(ctx.u, 'lead.summary', { crmLeadId: l.id }); // eslint-disable-line no-await-in-loop
          if (w && !w.error) { asked = clip((w.fields && (w.fields.requirement || w.fields.service)) || '', 160) || null; bestTime = clip((w.fields && w.fields.callback) || '', 80) || null; note = clip(w.next || w.nextStep || '', 160); }
        }
        rows.push({ leadId: l.id, name: clip(l.contactName || l.company || 'Lead', 80), company: clip(l.company || '', 80), band: l.band, score: l.score == null ? null : Number(l.score), why: (l.why || []).slice(0, 3).map((x) => clip(typeof x === 'string' ? x : (x.text || x.reason || ''), 120)).filter(Boolean), source: l.source || '', status: l.status || '', phone: l.phone || '', owner: l.ownerName || '', createdAt: l.createdAt, asked, bestTime, note });
      }
      const sheet = {
        from: new Date(from || Date.now()).toISOString(), total: live.length, hot: live.filter((l) => l.band === 'Hot').length, warm: live.filter((l) => l.band === 'Warm').length, rows,
        script: [
          `Say who you are: "Hello <name>, this is <your name> from ${clip(input.business, 80)}."`, 'Say why you call: they showed interest. Use only what the lead told us (the "asked" column); do not guess.',
          'Ask if it is a good time, and offer the time they asked for, if there is one.', 'Do not promise prices, results or discounts that are not in the saved facts.', 'If they say no or ask not to be called again, stop and record it on the lead.',
        ],
        rules: [
          'Call only people who gave their number to be contacted. TeamLink does not check the Do-Not-Disturb register for these leads: check it before calling.', 'Call between 9:00 and 21:00 India time.',
          'The agent does not call anyone and does not use AI Calling for these leads (AI Calling is built for job candidates with a recorded consent): your team calls from the CRM.',
        ],
      };
      return { summary: rows.length ? `Call sheet ready: ${rows.length} lead${rows.length === 1 ? '' : 's'} to call (${sheet.hot} hot, ${sheet.warm} warm of ${live.length} new since the plan started). Nobody is called by the agent.` : `Call sheet: none of the ${live.length} new lead${live.length === 1 ? '' : 's'} since the plan started is Hot or Warm yet. Nobody is called by the agent.`, refs: [{ kind: 'callsheet', id: ctx.task.id, label: 'Call sheet', page: 'crm' }], data: { sheet, rows: rows.length } };
    },
  },
  // ---- the WhatsApp assistant's campaign service: the agent PREPARES the campaign, a person still presses Send --------------------------------------------------------------------------
  // `confirm`: it reaches nobody, but it freezes WHO a message will go to and the exact words, so it waits for its own approval like an outward step (the person sees the people and the words first).
  'whatsapp.campaign': {
    label: 'Prepare the WhatsApp campaign', module: 'WhatsApp campaigns', page: 'whatsapp', risk: 'internal', confirm: true, auto: true, cost: { kind: 'free', unit: 'campaign', rupees: 0, note: 'saved as ready: sending is done by a person in WhatsApp > Campaigns, which has its own credits and rules' },
    does: () => 'Saves a WhatsApp campaign as READY through the WhatsApp assistant: only customers whose consent for promotions is recorded, only through a template Meta approved (its own wording, not this plan\'s draft), with the blanks filled from their own facts. You see every person and the exact words first. NOTHING IS SENT: a person presses Send in WhatsApp > Campaigns. It needs "WhatsApp promotions" switched on by an Admin; if not, a person sends the approved message by hand.',
    build: () => ({}),
    async prepare(ctx) {
      const { WA } = svcOf(ctx);
      const out = { ready: false, reason: '', switchOn: null, templates: [], choice: null, preview: null, name: clip((ctx.plan && ctx.plan.title) || 'AI Agent campaign', 120), fields: WA_FIELDS, bandsAll: WA_BANDS };
      try { const st = ctx.svc && ctx.svc.waSettings ? await ctx.svc.waSettings() : await require('../omniwa/assist').settings(); out.switchOn = !!(st && st.campaignsOn); } catch { out.switchOn = null; } // eslint-disable-line global-require
      const t = await WA.call(ctx.u, 'campaign.templates', {});
      if (!t || t.error) { out.reason = clip((t && t.error) || 'The WhatsApp templates could not be read.', 200); return out; }
      out.templates = (t.templates || []).map((x) => ({ id: x.id, name: x.name, metaName: x.metaName, language: x.language, body: x.body, blanks: x.blanks }));
      if (out.switchOn === false) { out.reason = 'WhatsApp promotions are switched off. An Admin switches them on in Settings > WhatsApp AI > Marketing assistant. Until then a person sends the approved message by hand.'; return out; }
      if (!out.templates.length) { out.reason = 'There is no WhatsApp template approved by Meta. Create one in Omni-Channel > Templates and wait for Meta\'s approval: a campaign can only use an approved template. Until then a person sends the approved message by hand.'; return out; }
      const ch = waChoice(ctx.query || {}, out.templates); out.choice = { templateId: ch.templateId, varMap: ch.varMap, bands: ch.bands, gapDays: ch.gapDays };
      const pv = await WA.call(ctx.u, 'campaign.preview', { templateId: ch.templateId, varMap: ch.varMap, audience: { bands: ch.bands, gapDays: ch.gapDays } });
      if (!pv || pv.error) { out.reason = clip((pv && pv.error) || 'The campaign could not be previewed.', 240); return out; }
      out.preview = { template: pv.template, total: (pv.people || []).length, people: (pv.people || []).slice(0, 20).map((p) => ({ name: p.name, phoneHint: p.phoneHint, band: p.band, text: p.text })), skipped: pv.skipped || {}, considered: pv.considered || 0 };
      if (!out.preview.total) out.reason = 'Nobody would receive this campaign: nobody in the audience has agreed to promotions on WhatsApp yet. Until then a person sends the approved message by hand.';
      out.ready = !out.reason;
      return out;
    },
    approval(body, prep) {
      const name = clip(body.campaignName || prep.name, 120); if (name.length < 3) return { error: 'Give the campaign a name.' };
      const ch = prep.choice; const tpl = ch && prep.templates.find((x) => x.id === ch.templateId);
      if (!tpl) return { error: 'Choose an approved template.' };
      return { input: { campaignName: name, templateId: ch.templateId, varMap: ch.varMap, bands: ch.bands, gapDays: ch.gapDays }, summary: `save the WhatsApp campaign "${name}" as ready with the template "${tpl.name}" for ${prep.preview.total} customer${prep.preview.total === 1 ? '' : 's'} who agreed to promotions (a person still presses Send in WhatsApp > Campaigns)` };
    },
    async run(ctx, input) {
      const { WA } = svcOf(ctx);
      const r = await WA.call(ctx.u, 'campaign.create', { name: input.campaignName, templateId: input.templateId, varMap: input.varMap, audience: { bands: input.bands, gapDays: input.gapDays } });
      if (!r || r.error) throw fail(r, 'The campaign could not be saved.');
      return { summary: `WhatsApp campaign "${input.campaignName}" saved as READY for ${r.people} customer${r.people === 1 ? '' : 's'}. Nothing was sent: open WhatsApp > Campaigns, check who it reaches and the words, and press Send.`, refs: [{ kind: 'campaign', id: r.id, label: 'WhatsApp campaign', page: 'whatsapp' }], data: { itemId: r.id, campaignId: r.id, people: r.people, skipped: r.skipped || {} } };
    },
  },
  // ---- OUTWARD steps (Phase 2): each one waits for its own approval; the engine never runs them on the plan's approval alone ----------------------------------------------------
  'social.post': {
    label: 'Post it on the social accounts', module: 'Social media', page: 'mkimages', risk: 'outward', auto: true, scheduled: true, cost: { kind: 'free', unit: 'post', rupees: 0, note: 'posting through the Facebook / Instagram / X accounts an Admin connected is free' },
    does: (t, d) => `Posts this day's APPROVED picture with its caption on the Facebook Pages, Instagram or X accounts you pick when you approve this step, at ${d ? d.label : 'its time'}. It goes public. Only an approved picture can be posted, and only while an Admin has allowed posting from TeamLink.`,
    build: (plan, d) => ({ day: d.n, platforms: d.platforms.filter((x) => SOCIAL.includes(x)) }),
    async prepare(ctx) {
      const pic = picOf(ctx); const d = ctx.day || {};
      const out = { ready: false, reason: '', media: null, scheduledLabel: d.label || '', captions: d.texts || {}, accounts: [], allowed: false };
      if (!pic) { out.reason = 'The picture has not been made yet.'; return out; }
      const row = await imageRow(pic.output.data.itemId); if (!row) { out.reason = 'The picture was not found.'; return out; }
      out.media = { id: row.id, title: row.title, status: row.status };
      const acc = await accountsOf(ctx); out.allowed = !!acc.allowed;
      out.accounts = (acc.accounts || []).filter((a) => (d.platforms || []).includes(a.platform)).map((a) => ({ id: a.id, platform: a.platform, name: a.name, username: a.username || '', parentName: a.parentName || '', status: a.status || '' }));
      if (row.status !== 'approved') out.reason = `The picture is ${STATUS_WORDS[row.status] || row.status}. It can be posted only after it is approved (by your team, or by the client).`;
      else if (!out.allowed) out.reason = 'An Admin has to allow posting from TeamLink first (AI Marketing > AI usage > Posting to client accounts).';
      else if (!out.accounts.length) out.reason = `No connected ${listWords((d.platforms || []).filter((x) => SOCIAL.includes(x)).map((x) => WORD[x]))} account was found. An Admin connects them in Administration > Integrations > Social Media.`;
      out.ready = !out.reason;
      return out;
    },
    approval(body, prep, ctx) {
      const ids = (Array.isArray(body.accountIds) ? body.accountIds : []).map(String).filter((x, i, a) => a.indexOf(x) === i).slice(0, 6);
      if (!ids.length) return { error: 'Pick at least one account to post on.' };
      const chosen = ids.map((id) => prep.accounts.find((a) => a.id === id));
      if (chosen.some((a) => !a)) return { error: 'One of those accounts is not a connected account for this post. Pick from the list.' };
      if (chosen.some((a) => a.platform !== 'x') && !siteOk(ctx.base)) return { error: 'Posting to Facebook or Instagram needs this page opened on the site\'s https address (Meta fetches the picture from it).' };
      if (chosen.some((a) => a.platform === 'x') && String((prep.captions || {}).x || '').length > 280) return { error: 'The X text is over 280 letters. Shorten it first.' };
      return { input: { accountIds: ids, base: ctx.base }, summary: `post on ${listWords(chosen.map((a) => `${WORD[a.platform]}: ${a.name}`))} at ${prep.scheduledLabel}` };
    },
    async run(ctx, input) {
      const { Post } = svcOf(ctx); const pic = picOf(ctx); const d = ctx.day || {};
      if (!pic) throw new ToolError('There is no picture to post.', 'no_picture');
      const acc = await accountsOf(ctx); const byId = new Map((acc.accounts || []).map((a) => [a.id, a]));
      const prev = await Post.posts(ctx.u, pic.output.data.itemId); // an account that already got this picture is never posted to twice (a retry after a partial failure)
      const done = new Set(((prev && prev.posts) || []).filter((x) => x.ok).map((x) => x.accountId));
      const todo = (input.accountIds || []).filter((id) => !done.has(id));
      const results = []; const errors = [];
      for (const platform of ['instagram', 'facebook', 'x']) {
        const ids = todo.filter((id) => (byId.get(id) || {}).platform === platform); if (!ids.length) continue; // eslint-disable-line no-continue
        const caption = (d.texts || {})[platform] || '';
        const r = await Post.postItem(ctx.u, pic.output.data.itemId, { accountIds: ids, caption, confirm: true }, input.base); // eslint-disable-line no-await-in-loop
        if (!r || r.error) { errors.push(`${WORD[platform]}: ${clip((r && r.error) || 'It did not work.', 200)}`); continue; } // eslint-disable-line no-continue
        (r.results || []).forEach((x) => { results.push(x); if (!x.ok) errors.push(`${x.name || WORD[platform]}: ${clip(x.error, 160)}`); });
      }
      const good = results.filter((x) => x.ok);
      const data = { posts: results.map((x) => ({ platform: x.platform, name: x.name, ok: !!x.ok, url: x.url || '' })), alreadyPosted: [...done].filter((id) => (input.accountIds || []).includes(id)).length };
      if (errors.length) throw new ToolError(`${good.length ? `Posted on ${good.map((x) => x.name).join(', ')}, but ` : ''}${errors.join(' ')}`, 'post_failed');
      return { summary: `Posted on ${good.map((x) => x.name).join(', ')}${data.alreadyPosted ? ` (${data.alreadyPosted} account(s) already had it)` : ''}.`, refs: good.filter((x) => x.url).map((x) => ({ kind: 'link', id: x.url, label: `${x.name} post`, page: '' })), data };
    },
  },
  'client.review': {
    label: 'Ask the client to approve', module: 'Client approval', page: 'mkapprove', risk: 'outward', auto: true, cost: { kind: 'free', unit: 'message', rupees: 0, note: "one WhatsApp message through the company's own connection (any conversation price is the provider's, not TeamLink's)" },
    does: () => "Sends this day's picture to the client on WhatsApp from the company's Digital Marketing number, with the caption, and the client approves it or asks for changes on a private link. Nobody is messaged until you approve this step and confirm who it goes to.",
    build: (plan, d, biz) => ({ day: d.n, clientName: biz.name }),
    async prepare(ctx) {
      const pic = picOf(ctx); const d = ctx.day || {}; const biz = (ctx.plan && ctx.plan.biz) || {};
      const out = { ready: false, reason: '', media: null, defaults: { clientName: biz.name || '', contactName: '', contactPhone: '', contactEmail: '' }, message: '' };
      if (!pic) { out.reason = 'The picture has not been made yet.'; return out; }
      const row = await imageRow(pic.output.data.itemId); if (!row) { out.reason = 'The picture was not found.'; return out; }
      out.media = { id: row.id, title: row.title, status: row.status };
      const first = (d.platforms || [])[0]; out.message = clip(`${(d.title || '').split(':')[0]} of the plan. Caption: ${(d.texts || {})[first] || ''}`, 400);
      try { const CR = svcOf(ctx).CR; const c = ((await CR.contacts(ctx.u)).contacts || []).find((x) => String(x.name).trim().toLowerCase() === String(biz.name || '').trim().toLowerCase()); if (c) out.defaults = { clientName: c.name, contactName: c.contactName || '', contactPhone: c.contactPhone || '', contactEmail: c.contactEmail || '' }; } catch { /* no earlier contact */ }
      if (row.status === 'approved') out.reason = 'The picture is already approved, so there is nothing for the client to decide.';
      else if (!['draft', 'changes', 'waiting'].includes(row.status)) out.reason = `The picture is ${row.status}.`;
      out.ready = !out.reason;
      return out;
    },
    approval(body, prep, ctx) {
      const core = require('../utils/messagingCore'); // eslint-disable-line global-require
      const clientName = clip(body.clientName, 120); if (clientName.length < 2) return { error: "Write the client's name (the company)." };
      const phone = clip(body.contactPhone, 30); const nm = core.normalizeMobile(phone);
      if (!phone || !nm.ok) return { error: "Type the client's WhatsApp number (it is where the picture is sent)." };
      const mail = clip(body.contactEmail, 160); if (mail && !core.validEmail(mail)) return { error: 'That email address does not look right.' };
      if (!siteOk(ctx.base)) return { error: "Sending the link needs this page opened on the site's https address." };
      const message = clip(body.message || prep.message, 400);
      return { input: { clientName, contactName: clip(body.contactName, 120), contactPhone: phone, contactEmail: mail, email: body.email === true && !!mail, message, base: ctx.base }, summary: `send the picture to ${clientName} on WhatsApp ${core.maskMobile(nm.e164)}${body.email === true && mail ? ' and by email' : ''}` };
    },
    async run(ctx, input) {
      const { CR } = svcOf(ctx); const pic = picOf(ctx);
      if (!pic) throw new ToolError('There is no picture to send.', 'no_picture');
      const r = await CR.sendToClient(ctx.u, pic.output.data.itemId, { clientName: input.clientName, contactName: input.contactName, contactPhone: input.contactPhone, contactEmail: input.contactEmail, email: input.email, message: input.message }, input.base);
      if (!r || r.error) throw fail(r, 'It could not be sent.');
      return { summary: clip(r.ok || 'Sent to the client.', 300), refs: [{ kind: 'review', id: (r.review || {}).id || '', label: 'Client approval', page: 'mkapprove' }], data: { reviewId: (r.review || {}).id || '', itemId: pic.output.data.itemId } };
    },
  },
  // ---- steps only a person can do -----------------------------------------------------------------------------------------------------------------------
  'manual.post': { label: 'Post it (by hand)', module: 'You', page: 'mkimages', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'post', rupees: 0, note: 'done by a person' },
    does: () => 'Waits for you. When the draft and picture are approved, post them yourself (AI Images > the approved picture > Post, or by hand), then mark this step done. The agent never posts by itself in this phase.', build: () => ({}) },
  'manual.whatsapp': { label: 'Send the WhatsApp message (by a person)', module: 'You', page: 'campaigns', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'message', rupees: 0, note: 'sent by a person from Omni-Channel > Campaigns (its own credits and rules apply)' },
    does: () => 'Waits for you. The agent never sends WhatsApp. When the message is approved, a person sends it from Omni-Channel > Campaigns (or Templates): that engine only reaches people who agreed to receive messages, applies the STOP list, quiet hours, credits and its own approval. Mark this step done once it was sent.', build: () => ({}) },
  'manual.calls': { label: 'Call the leads (by your team)', module: 'You', page: 'crm', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'call', rupees: 0, note: 'made by your team from the CRM' },
    does: () => 'Waits for you. Your team calls the leads on the sheet from the CRM (the agent does not call and does not use AI Calling for these leads). Mark this done when the calls are made and add what came of them under "Add a result".', build: () => ({}) },
  'manual.video': { label: 'Make the video', module: 'You', page: 'mkvideos', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'video', rupees: 0, note: 'done by a person in AI Video (free slideshow video made in your browser)' },
    does: () => 'Waits for you. A video is put together in your browser on the AI Video screen: join the scene pictures made for this video (and any stock clips you approve), then mark this step done.', build: () => ({}) },
  'manual.note': { label: 'A step for a person', module: 'You', page: 'mkvisibility', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'step', rupees: 0, note: 'done by a person' }, does: (t) => (t && t.note) || 'Waits for you; mark it done when it is finished.', build: () => ({}) },
};

const COST_WORDS = { free: 'Free', 'free-tier': 'Free tier', paid: 'Paid' };
const catalog = () => Object.entries(TOOLS).map(([id, t]) => ({ id, label: t.label, module: t.module, page: t.page, risk: t.risk, needsApproval: t.risk === 'outward' || t.confirm === true, manual: !!t.manual, cost: { ...t.cost, word: COST_WORDS[t.cost.kind] || t.cost.kind } }));
const isOutward = (tool) => !!TOOLS[tool] && TOOLS[tool].risk === 'outward';
// a step that waits for its OWN approval: every outward step, and a step that freezes who a message will go to (confirm)
const gated = (tool) => !!TOOLS[tool] && (TOOLS[tool].risk === 'outward' || TOOLS[tool].confirm === true);

module.exports = { TOOLS, ToolError, catalog, isOutward, gated, dayOf, svcOf };
