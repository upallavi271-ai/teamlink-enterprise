// ---------------------------------------------------------------------------
// ApiPortal: the adapter pattern for a portal that is posted to through an OFFICIAL API with a token (Telegram Bot API,
// Facebook / Instagram / Threads Graph APIs, LinkedIn Posts API). No browser, no bot, no scraping.
//
// STANDARD RESULT of run() (the same shape the browser adapters give the runner):
//   { ok, portalJobId, portalUrl, verified, confirmed, dryRun, code, reason, retryable, retryAfterMs, apiStatus, note, screenshots: [] }
//
// SAFETY RULES (in the base class so no adapter can forget them):
//   1. A DRY RUN builds the message, records it in the result and sends NOTHING (no network call at all).
//   2. ONE post per job per channel: a PUBLISH for a job that is already live sends nothing ("already posted"). A changed job
//      is sent again ONLY by an explicit UPDATE ("Post update"), which edits the message that is already there.
//   3. Closing a job sends nothing, unless an Admin switched "closing note" ON for that channel (default OFF).
//   4. The token is never logged, never in an answer, never in an error text (scrub()); it is only ever in memory here.
//   5. While TL_API_STRICT_LOCAL=1 (tests) only a local address may be called: the real api.telegram.org / graph.facebook.com
//      are refused. The base address can be changed with an env variable or an Admin setting (the tests point it at a fake server).
//   6. The kill switch / shutdown stop a run at its next safe step (checkpoint).
// ---------------------------------------------------------------------------
const { PORTALS, ERRORS } = require('../../jobPublish/constants');
const { PortalError, RunAborted } = require('../base/errors');
const S = require('../../jobPublish/settings');

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
// the job-posting places that are social platforms with possibly MORE THAN ONE connected account (utils/socialAccounts.js)
const SOCIAL_PLATFORM = { facebook: 'facebook', instagram: 'instagram', threads: 'threads', linkedinpost: 'linkedin' };

class ApiPortal {
  constructor({ portal, creds = null, log, ctx = {} }) {
    this.portal = portal;
    this.meta = PORTALS[portal] || { key: portal, name: portal };
    this.creds = creds; // { username, password } plaintext, server side only
    this.log = log;
    this.ctx = ctx;
  }

  static get meta() { return { automation: true }; }
  get name() { return this.meta.name || this.portal; }
  // subclasses: defaultBase(), envBase()
  async base() {
    const set = await S.get(`jobpublish.api.${this.portal}.base`).catch(() => null);
    const v = process.env[this.envBase()] || (set && typeof set.value === 'string' ? set.value : '') || this.defaultBase();
    return String(v).replace(/\/+$/, '');
  }

  // Remove the token (and anything that looks like one) from a text before it is logged or shown.
  scrub(t) {
    let s = String(t == null ? '' : t);
    [this.creds && this.creds.password, this.creds && this.creds.username].filter((x) => x && String(x).length >= 4).forEach((x) => { s = s.split(String(x)).join('***'); });
    return s.replace(/bot\d{5,}:[A-Za-z0-9_-]{20,}/g, 'bot***').replace(/access_token=[^&\s"']+/gi, 'access_token=***').replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer ***');
  }

  async guardHost(base) {
    if (process.env.TL_API_STRICT_LOCAL !== '1') return;
    let host = '';
    try { host = new URL(base).hostname.toLowerCase(); } catch { host = ''; }
    if (!LOCAL.has(host)) throw new PortalError('HOST_BLOCKED', `${ERRORS.HOST_BLOCKED.words} (${host || 'no address'}: only a local test server is allowed while TL_API_STRICT_LOCAL=1)`, { retryable: false });
  }

  // One HTTP call. -> { status, json, retryAfterMs }. Network trouble is a PortalError (retryable), never a raw exception.
  async call(method, url, { json = null, form = null, headers = {}, timeoutMs = 15000 } = {}) {
    await this.guardHost(url);
    const h = { Accept: 'application/json', ...headers };
    let body;
    if (json) { h['Content-Type'] = 'application/json'; body = JSON.stringify(json); } else if (form) { h['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
    let res;
    try {
      res = await fetch(url, { method, headers: h, body, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new PortalError(timeout ? 'TIMEOUT' : 'NETWORK', `${timeout ? ERRORS.TIMEOUT.words : ERRORS.NETWORK.words}`, { retryable: true });
    }
    let parsed = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    const ra = Number(res.headers.get('retry-after'));
    return {
      status: res.status, json: parsed, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null, header: (n) => res.headers.get(n),
    };
  }

  async checkpoint(step) { if (this.ctx && this.ctx.checkpoint) await this.ctx.checkpoint(step); }

  // ---- EVERY CONNECTED ACCOUNT (founder 2026-10-31: "social media lo anni accounts ki post avvali") ---------------------------
  // The job-posting connection of a social place is that platform's DEFAULT account (utils/socialPosting.js). Every OTHER account
  // connected in Administration > Integrations > Social Media (more Facebook Pages, their Instagram accounts, Threads profiles,
  // LinkedIn profiles / Company Pages) gets the same post too: one post per job per account (kept in AppSetting
  // 'jobpublish.extra.<requirementId>.<portal>'), "Post update" edits each, the closing note (when on) answers each.
  // An account whose token is missing or expired is left out. Telegram and the job boards have no extra accounts.
  async otherAccounts() {
    const platform = SOCIAL_PLATFORM[this.portal];
    if (!platform) return [];
    const SA = require('../../utils/socialAccounts'); // eslint-disable-line global-require
    const all = await SA.readAll().catch(() => []);
    const mine = this.creds && this.creds.username ? String(this.creds.username) : '';
    return all
      .filter((a) => a.platform === platform && !a.isDefault && a.externalId && String(a.externalId) !== mine && !(a.expiresAt && Date.parse(a.expiresAt) < Date.now()))
      .map((a) => ({ id: a.id, name: a.name || a.username || String(a.externalId), creds: { username: String(a.externalId), password: SA.tokenOf(a) } }))
      .filter((x) => x.creds.password);
  }

  // the same adapter, posting as another account
  asAccount(creds) { return new this.constructor({ portal: this.portal, creds, log: this.log, ctx: this.ctx }); }

  async extraStore(requirementId) {
    const key = `jobpublish.extra.${requirementId}.${this.portal}`;
    const prisma = require('../../db'); // eslint-disable-line global-require
    const row = await prisma.appSetting.findUnique({ where: { key } }).catch(() => null);
    let v = {};
    try { v = row ? JSON.parse(row.value) : {}; } catch { v = {}; }
    const posts = v && typeof v.posts === 'object' && v.posts ? v.posts : {};
    const save = async () => { const value = JSON.stringify({ posts }); await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } }); };
    return { posts, save };
  }

  // action: 'post' | 'update' | 'close'. Returns { lines: [plain words], results: [{ name, ok, postId, url, error }] }.
  async fanOut(action, rid, text, ctx = {}) {
    const out = { lines: [], results: [] };
    let accounts = [];
    try { accounts = await this.otherAccounts(); } catch { accounts = []; }
    if (!accounts.length || !rid) return out;
    const store = await this.extraStore(rid);
    for (const acc of accounts) {
      const had = store.posts[acc.id];
      const a = this.asAccount(acc.creds);
      try {
        await this.checkpoint('send'); // eslint-disable-line no-await-in-loop
        if (action === 'post') {
          if (had && had.postId) { out.results.push({ name: acc.name, ok: true, postId: had.postId, url: had.url || null, already: true }); continue; } // eslint-disable-line no-continue
          const r = await a.send(text, ctx); // eslint-disable-line no-await-in-loop
          store.posts[acc.id] = { postId: String(r.id), url: r.url || null, name: acc.name, at: new Date().toISOString() };
          out.results.push({ name: acc.name, ok: true, postId: String(r.id), url: r.url || null });
        } else if (action === 'update') {
          if (!had || !had.postId) continue; // eslint-disable-line no-continue
          const r = await a.edit(String(had.postId), text, ctx); // eslint-disable-line no-await-in-loop
          if (r && r.url) store.posts[acc.id] = { ...had, url: r.url };
          out.results.push({ name: acc.name, ok: true, postId: had.postId });
        } else if (action === 'close') {
          if (!had || !had.postId) continue; // eslint-disable-line no-continue
          await a.send(text, { ...ctx, replyTo: had.postId }); // eslint-disable-line no-await-in-loop
          out.results.push({ name: acc.name, ok: true, postId: had.postId });
        }
      } catch (e) {
        if (e instanceof RunAborted) throw e;
        const words = a.scrub((e && e.message) || String(e)).split('\n')[0].slice(0, 160);
        out.results.push({ name: acc.name, ok: false, error: words });
      }
    }
    await store.save().catch(() => null);
    const ok = out.results.filter((r) => r.ok && !r.already);
    const bad = out.results.filter((r) => !r.ok);
    const verb = action === 'post' ? 'Also posted to' : action === 'update' ? 'Also updated on' : 'Closing note also on';
    if (ok.length) out.lines.push(`${verb} ${ok.length} more account${ok.length === 1 ? '' : 's'}: ${ok.map((r) => r.name).join(', ')}.`);
    if (bad.length) out.lines.push(`Not done on ${bad.map((r) => `${r.name} (${r.error})`).join('; ')}.`);
    for (const l of out.lines) await this.log.info('accounts', l); // eslint-disable-line no-await-in-loop
    return out;
  }

  // The settings: closing note on/off for this channel.
  async closingNoteOn() {
    try { return !!(await require('../../jobDist/tracker').settings()).closingNote[this.portal]; } catch { return false; } // eslint-disable-line global-require
  }

  // ---- what a subclass supplies --------------------------------------------------------------------
  // check()                        -> { ok, summary } | throws PortalError           (Test connection: sends nothing)
  // send(text, ctx)                -> { id, url }                                      (a new post)
  // edit(id, text, ctx)            -> { id, url }                                      (the explicit "Post update")
  // testPost(text)                 -> { id }                                            (the explicit "Send a test post")

  async health() { return { portal: this.portal, settingsOk: true, settingsProblems: [], browserFound: null, sessionSaved: false, note: 'API channel: no browser needed.' }; }

  fail(e) {
    if (e instanceof RunAborted) return { ok: false, aborted: true, reason: e.message, screenshots: [] };
    if (e instanceof PortalError) {
      return {
        ok: false, code: e.code, reason: this.scrub(e.message), retryable: !!e.retryable, retryAfterMs: e.retryAfterMs || null, needsHuman: !!e.needsHuman, apiStatus: e.apiStatus || null, screenshots: [],
      };
    }
    return { ok: false, code: 'UNEXPECTED', reason: this.scrub(`Something went wrong while posting (${String((e && e.message) || e).split('\n')[0].slice(0, 160)}).`), retryable: true, screenshots: [] };
  }

  // The kit text of this job for this channel (the same text the person sees on the Distribute tab).
  async kit(requirementId) {
    const T = require('../../jobDist/text'); // eslint-disable-line global-require
    const out = await T.forPlatform(requirementId, this.portal, { base: process.env.APP_BASE_URL || '' });
    if (!out) throw new PortalError('PORTAL_REJECTED', 'The job text could not be built.', { retryable: false });
    if (out.platform && !out.platform.active) throw new PortalError('SWITCHED_OFF', `${out.platform.name} is switched off in the list of places.`, { retryable: false });
    if (out.over) throw new PortalError('MESSAGE_TOO_LONG', `${ERRORS.MESSAGE_TOO_LONG.words} (${out.chars} characters, the limit is ${out.limit}). Shorten the text on the Distribute tab.`, { retryable: false });
    return out;
  }

  async closingText(requirementId) {
    const prisma = require('../../db'); // eslint-disable-line global-require
    const jt = require('../../utils/jobText'); // eslint-disable-line global-require
    const r = await prisma.requirement.findUnique({ where: { id: requirementId }, include: { client: true } });
    const f = r ? await jt.buildFacts(r, {}, '') : { title: 'This job' };
    return `This job is now closed: ${f.title}. Thank you for your interest. Watch this channel for new jobs.`;
  }

  async run(action, job = {}, ctx = {}) {
    this.ctx = ctx;
    try {
      await this.checkpoint('start');
      if (action === 'VERIFY') {
        const c = await this.check();
        return { ok: true, verified: true, note: c.summary, screenshots: [], apiStatus: c.apiStatus || null };
      }
      const rid = ctx.requirementId;
      if (action === 'PUBLISH' || action === 'REPUBLISH') {
        // ONE post per job per channel
        if (job.live && job.portalJobId) {
          await this.log.info('already', 'Already posted here. Nothing was sent. Use "Post update" to change the message.');
          // an account connected since the first post still gets the job (each account once)
          let more = { lines: [], results: [] };
          if (!ctx.dryRun) { const kitA = await this.kit(rid).catch(() => null); if (kitA) more = await this.fanOut('post', rid, kitA.text, ctx); }
          return {
            ok: true, verified: true, confirmed: true, portalJobId: job.portalJobId, portalUrl: job.portalUrl || null, note: ['Already posted: nothing was sent.', ...more.lines].join(' '), screenshots: [], alreadyPosted: true, accounts: more.results,
          };
        }
        const kit = await this.kit(rid);
        if (ctx.dryRun) {
          const d = await this.dry(kit.text, 'post');
          const others = await this.otherAccounts().catch(() => []);
          if (others.length) d.note = `${d.note}\n\nIt would also go to ${others.length} more account${others.length === 1 ? '' : 's'}: ${others.map((o) => o.name).join(', ')}.`.slice(0, 4800);
          return d;
        }
        await this.checkpoint('send');
        const r = await this.send(kit.text, ctx);
        const more = await this.fanOut('post', rid, kit.text, ctx);
        return {
          ok: true, verified: true, confirmed: true, portalJobId: String(r.id), portalUrl: r.url || null, apiStatus: r.apiStatus || null, note: [`Posted (${kit.chars} characters).`, ...more.lines].join(' '), screenshots: [], accounts: more.results,
        };
      }
      if (action === 'UPDATE') {
        if (!job.portalJobId) throw new PortalError('NO_JOB_ID', 'There is no earlier post to update. Post the job first.', { retryable: false });
        const kit = await this.kit(rid);
        if (ctx.dryRun) return this.dry(kit.text, 'update');
        await this.checkpoint('send');
        const r = await this.edit(String(job.portalJobId), kit.text, ctx);
        const more = await this.fanOut('update', rid, kit.text, ctx);
        return {
          ok: true, verified: true, confirmed: true, portalJobId: String(job.portalJobId), portalUrl: r.url || job.portalUrl || null, apiStatus: r.apiStatus || null, note: [`Updated (${kit.chars} characters).`, ...more.lines].join(' '), screenshots: [], accounts: more.results,
        };
      }
      if (action === 'UNPUBLISH') {
        const on = await this.closingNoteOn();
        if (!on) {
          await this.log.info('closing', 'Closing notes are off: nothing was sent. The post stays where it is; delete it by hand if you want it gone.');
          return { ok: true, verified: true, confirmed: true, keepStatus: true, note: 'Nothing was sent (closing notes are off). The post stays there: delete it on the site if you want it gone.', screenshots: [] };
        }
        const text = await this.closingText(rid);
        if (ctx.dryRun) return this.dry(text, 'closing note');
        await this.checkpoint('send');
        const r = await this.send(text, { ...ctx, replyTo: job.portalJobId || null });
        const more = await this.fanOut('close', rid, text, ctx);
        return { ok: true, verified: true, confirmed: true, keepStatus: true, apiStatus: r.apiStatus || null, note: ['A closing note was posted. The first post stays there.', ...more.lines].join(' '), screenshots: [], accounts: more.results };
      }
      return { ok: false, code: 'UNEXPECTED', reason: `Unknown action ${action}`, retryable: false, screenshots: [] };
    } catch (e) {
      const out = this.fail(e);
      if (!out.aborted) await this.log.error('api', `${out.code}: ${out.reason}${out.apiStatus ? ` (answer ${out.apiStatus})` : ''}`);
      return out;
    }
  }

  // DRY RUN: the message is built and recorded, nothing is sent.
  async dry(text, what) {
    await this.log.info('dry-run', `DRY RUN: the ${what} was built (${text.length} characters). Nothing was sent.`);
    return {
      ok: true, dryRun: true, note: `DRY RUN: nothing was sent. The message (${text.length} characters) would be:\n${text}`.slice(0, 4800), preview: text, screenshots: [],
    };
  }
}

module.exports = ApiPortal;
