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
//   manual    a step only a person can do (post by hand, make the video in the browser, talk to the website owner). The agent lists it, reminds, and records when the person marks it done.
// Every tool can be replaced by a stand-in in tests (ctx.svc), and nothing real is touched there.
// ---------------------------------------------------------------------------
const S = require('../outreach/store');

class ToolError extends Error {
  constructor(message, code = 'failed', opts = {}) { super(message); this.name = 'ToolError'; this.code = code; this.retryable = !!opts.retryable; this.waiting = !!opts.waiting; }
}
const svcOf = (ctx) => ({
  Sites: (ctx.svc && ctx.svc.Sites) || require('./seoSites'), Audit: (ctx.svc && ctx.svc.Audit) || require('./seoAudit'), Kw: (ctx.svc && ctx.svc.Kw) || require('./seoKeywords'), Content: (ctx.svc && ctx.svc.Content) || require('./seoContent'),
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
  'seo.keywords': {
    label: 'Research and keep keyword ideas (SEO assistant)', module: 'SEO assistant', page: 'mkseo', risk: 'internal', auto: true, cost: { kind: 'free', unit: 'list', rupees: 0, note: 'plain code, no network' },
    does: () => 'Builds keyword ideas from the saved services, city and kind of business (primary, local, secondary) and keeps the best few in the client\'s kept list. TeamLink has no free source for search volume or difficulty, so none is shown or invented.',
    build: (plan, d, biz) => ({ url: plan.seo.url, pages: plan.seo.pages, clientName: clip(biz.name, 120), industry: biz.industryKey || '', facts: seoFacts(biz) }),
    async run(ctx, input) {
      const { Kw } = svcOf(ctx);
      const site = await seoSiteOf(ctx, input);
      const r = await Kw.research(ctx.u, { siteId: site.id });
      if (!r || r.error) throw fail(r);
      const pick = []; const take = { primary: 4, local: 3, secondary: 3 };
      for (const g of ['primary', 'local', 'secondary']) ((r.groups || []).find((x) => x.key === g) || { items: [] }).items.slice(0, take[g]).forEach((i) => pick.push({ phrase: i.phrase, group: g, intent: i.intent, source: 'agent' }));
      if (!pick.length) throw new ToolError('No keyword idea could be made from the saved facts. Add the services and the city under "Business" and retry.', 'no_ideas');
      const kept = await Kw.save(ctx.u, site.id, { phrases: pick });
      if (!kept || kept.error) throw fail(kept);
      return { summary: `${kept.added} keyword idea${kept.added === 1 ? '' : 's'} kept for ${site.clientName}${kept.alreadyThere ? ` (${kept.alreadyThere} already there)` : ''}. No search volumes: TeamLink has no source for them.`, refs: [{ kind: 'keywords', id: site.id, label: 'Kept keywords', page: 'mkseo' }], data: { itemId: site.id, kept: kept.added, ideas: pick.length, top: pick.slice(0, 5).map((x) => x.phrase) } };
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
  'manual.video': { label: 'Make the video', module: 'You', page: 'mkvideos', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'video', rupees: 0, note: 'done by a person in AI Video (free slideshow video made in your browser)' },
    does: () => 'Waits for you. A video is put together in your browser on the AI Video screen: use the scenes of this plan, then mark this step done.', build: () => ({}) },
  'manual.note': { label: 'A step for a person', module: 'You', page: 'mkvisibility', risk: 'internal', auto: false, manual: true, cost: { kind: 'free', unit: 'step', rupees: 0, note: 'done by a person' }, does: (t) => (t && t.note) || 'Waits for you; mark it done when it is finished.', build: () => ({}) },
};

const COST_WORDS = { free: 'Free', 'free-tier': 'Free tier', paid: 'Paid' };
const catalog = () => Object.entries(TOOLS).map(([id, t]) => ({ id, label: t.label, module: t.module, page: t.page, risk: t.risk, manual: !!t.manual, cost: { ...t.cost, word: COST_WORDS[t.cost.kind] || t.cost.kind } }));
const isOutward = (tool) => !!TOOLS[tool] && TOOLS[tool].risk === 'outward';

module.exports = { TOOLS, ToolError, catalog, isOutward, dayOf, svcOf };
