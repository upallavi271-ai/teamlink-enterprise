// ---------------------------------------------------------------------------
// BasePortal: the adapter pattern for a portal that is driven through a browser.
//
// A portal adapter (NaukriAdapter, FounditAdapter, ShineAdapter) extends this class. The base class holds the WHOLE
// flow, driven by the portal's page settings (src/portals/selectors/<portal>.json):
//
//   login()  isLoggedIn()  createJob(job)  updateJob(job, id)  deleteJob(id) = unpublish / close
//   verifyPosted(result)  logout()  health()   and   run(action, job, ctx): open -> sign in -> act -> verify -> close
//
// STANDARD RESULT of run():
//   { ok, portalJobId, portalUrl, verified, dryRun, needsHuman, code, reason, retryable, submitted, screenshots[] }
//
// SAFETY RULES (these are in the base class so no adapter can forget them):
//   1. NEVER solve or bypass a CAPTCHA, OTP, 2-step check, "unusual activity" page, email check or block page. They are
//      DETECTED (selectors, wording, URL, HTTP 403 / 429) and the run STOPS with needsHuman + a screenshot + a plain
//      sentence. A person signs in once themselves (`npm run portal-session -- <portal>`); the worker reuses the cookies.
//   2. No stealth: no evasion plugin, no fingerprint change, no proxy. Only ordinary 1-3 s pauses between actions.
//   3. A wrong password stops at once (code WRONG_PASSWORD, never retried: repeated wrong logins can lock the account).
//   4. Submit is pressed at most ONCE per run, and the queue is told FIRST (ctx.onSubmitStart): a run that fails after
//      Submit is never retried by itself (it could post the job twice): it is NEEDS_HUMAN.
//   5. "Published" needs an id or a link captured AND verifyPosted() confirming it. Anything less is not Published.
//   6. A page may only navigate to the portal's own domains (the browser network guard), and nothing typed (login,
//      job text) is ever written to a log or screenshot (password inputs are masked / the page is not photographed).
//   7. DRY RUN fills the form, takes a screenshot and stops BEFORE the Submit button.
// ---------------------------------------------------------------------------
const browserLib = require('../../playwright/browser');
const sessionLib = require('../../playwright/session');
const { shot, saveText } = require('../../playwright/screenshot');
const locate = require('../../playwright/locate');
const structure = require('../../playwright/structure');
const guards = require('../../jobPublish/guards');
const { humanPause, looksTransient } = require('../../playwright/retry');
const cfgLib = require('../config');
const { PortalError, NeedsHuman, RunAborted } = require('./errors');
const { ERRORS, PORTALS } = require('../../jobPublish/constants');

const DEFAULT_BLOCKERS = {
  urlPatterns: {
    CAPTCHA: ['captcha'], OTP: ['/otp', 'verify[-_]?otp'], TWO_FACTOR: ['two[-_]?factor', '2fa', 'mfa'], UNUSUAL_ACTIVITY: ['unusual', 'suspicious'], BLOCKED: ['/blocked', 'access[-_]?denied'],
  },
  selectors: {
    CAPTCHA: ['.g-recaptcha', '.h-captcha', '#captcha', 'img[src*="captcha" i]', 'input[name*="captcha" i]', 'iframe[src*="recaptcha/api2/bframe"]', 'iframe[title*="challenge" i]'],
    OTP: ['input[name*="otp" i]', 'input[id*="otp" i]', 'input[autocomplete="one-time-code"]'],
    TWO_FACTOR: ['input[name*="totp" i]', 'input[name*="authenticator" i]'],
  },
  textPatterns: {
    CAPTCHA: ['captcha', "i'?m not a robot", "prove you'?re (a )?human", 'verify you are (a )?human'],
    OTP: ['(enter|type).{0,24}(otp|one[- ]time (password|code)|verification code)', 'otp (has been )?sent'],
    TWO_FACTOR: ['(two|2)[- ]?(step|factor)', 'authenticator app'],
    UNUSUAL_ACTIVITY: ['unusual (activity|sign[- ]?in)', 'suspicious (activity|log[- ]?in)', 'security check'],
    EMAIL_VERIFY: ['verify your e-?mail', 'confirm your e-?mail address', 'e-?mail verification'],
    BLOCKED: ['access denied', 'you have been blocked', 'temporarily blocked', 'too many (requests|attempts)', 'error 1020', 'request blocked'],
  },
  scopeSelectors: ['title', 'h1', 'h2', 'h3', '[role=alert]', '[role=dialog]', '.alert', '.error', '.modal', '.captcha-box'],
};

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const esc = (s) => String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const tmpl = (s, vars) => String(s).replace(/\{(\w+)\}/g, (m, k) => (vars && vars[k] !== undefined ? esc(vars[k]) : m));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class BasePortal {
  // meta: { key, name, automation, ... } come from the subclass (static get meta()).
  constructor({ portal, creds = null, log, ctx = {} }) {
    this.portal = portal;
    this.meta = PORTALS[portal] || { key: portal, name: portal };
    this.creds = creds; // { username, password } (plaintext, server side, never logged)
    this.log = log;
    this.ctx = ctx;
    this.cfg = null;
    this.handle = null; // { context, page, close }
    this.page = null;
    this.submitStarted = false;
    this.screenshots = [];
    this.selectorTrace = new Map(); // step key -> what was tried / which entry worked (selector self-healing report)
    this.snapshots = 0; // page-structure snapshots taken in this run (at most 3)
    this.otpUsed = false; // a person's OTP is used at most ONCE per run (a wrong code is never retried: it could lock the account)
    this.waitedMs = 0; // time spent waiting for a person (not counted in the run's deadline)
  }

  // ------------------------------------------------------------------ helpers
  static get meta() { return { automation: true }; }
  get name() { return this.meta.name || this.portal; }
  pace() { const p = (this.cfg && this.cfg.pacing) || {}; return humanPause(p.minMs || 1000, p.maxMs || 3000); }

  async checkpoint(step) {
    if (this.ctx.checkpoint) await this.ctx.checkpoint(step); // throws RunAborted when a kill switch / shutdown asks for it
  }

  async shot(step, extra = []) {
    if (!this.page) return null;
    const rel = await shot(this.page, { queueId: this.ctx.queueId, portal: this.portal, step, maskSelectors: extra, log: this.log });
    if (rel) { this.screenshots.push(rel); await this.log.info('screenshot', `Saved a screenshot (${step})`, { screenshotPath: rel }); }
    return rel;
  }

  // The first of several alternative selectors (strings or { role / label / text / ... } entries, see playwright/locate.js)
  // that is VISIBLE right now. -> { loc, index, entry } | null.  Entries are tried IN ORDER; none is ever guessed.
  async find(selectors, vars) {
    const list = arr(selectors);
    for (let i = 0; i < list.length; i += 1) {
      try {
        const loc = locate.build(this._scope || this.page, list[i], vars, esc).first();
        // eslint-disable-next-line no-await-in-loop
        if (await loc.isVisible()) return { loc, index: i, entry: list[i] };
      } catch { /* a bad selector is "not here" */ }
    }
    return null;
  }
  // A probe: is any of these visible right now? Used for "am I signed in", error boxes, blockers. Not recorded as a step.
  async visible(selectors, vars) {
    const hit = await this.find(selectors, vars);
    return hit ? hit.loc : null;
  }
  // Wait up to `ms` for any of the selectors to be visible. With a `key` the outcome is recorded (see noteSelector).
  async waitVisible(selectors, ms = 8000, vars, key = null) {
    const until = Date.now() + ms;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      const hit = await this.find(selectors, vars);
      if (hit) { if (key) await this.noteSelector(key, selectors, hit.index, vars); return hit.loc; }
      if (Date.now() >= until) { if (key) await this.noteSelector(key, selectors, -1, vars); return null; }
      // eslint-disable-next-line no-await-in-loop
      await sleep(150);
    }
  }
  async need(selectors, what, ms = 8000, vars, key = null) {
    const hit = await this.waitVisible(selectors, ms, vars, key || what);
    if (!hit) throw new PortalError('SELECTOR_MISSING', `${ERRORS.SELECTOR_MISSING.words} (not found: ${what})`, { retryable: false });
    return hit;
  }

  // ------------------------------------------------------------------ selector self-healing report
  // Called when a STEP looked for its element. index 0 = the main selector worked (state "ok"); index > 0 = the main one
  // failed and a fallback worked ("drift": the page changed, the run still worked, a person should update the page
  // settings); -1 = nothing worked ("broken": a page structure snapshot is saved to help fixing it).
  // A step that is DESTRUCTIVE (sign-in button, Submit, Close) is only clicked through a fallback when that fallback
  // matches exactly ONE visible element: an ambiguous match is refused, never guessed.
  async noteSelector(key, selectors, index, vars) {
    const list = arr(selectors);
    const main = locate.describe(list[0], vars);
    const used = index >= 0 ? locate.describe(list[index], vars) : null;
    const rec = {
      key, state: index < 0 ? 'broken' : (index === 0 ? 'ok' : 'drift'), usedIndex: index < 0 ? null : index, kind: index >= 0 ? locate.family(list[index]) : null, used, main, of: list.length,
    };
    this.selectorTrace.set(key, rec);
    if (rec.state === 'drift') {
      await this.log.warn('selector-drift', `Page changed? "${key}": the main selector (${main}) was not found; fallback ${index + 1} of ${list.length} (${used}) worked. Update the page settings.`);
    } else if (rec.state === 'broken') {
      await this.log.error('selector-broken', `"${key}": none of the ${list.length} selectors matched (main: ${main}).`);
      await this.snapshotStructure(key);
    }
  }
  async snapshotStructure(key) {
    if (!this.page || this.snapshots >= 3) return null;
    this.snapshots += 1;
    try {
      const text = await structure.capture(this.page, { portal: this.portal, step: key });
      const rel = saveText({ queueId: this.ctx.queueId, portal: this.portal, step: `structure-${key}`, text });
      if (rel) { this.screenshots.push(rel); await this.log.info('page-structure', `Saved the page structure (no personal data) to help fix "${key}"`, { screenshotPath: rel }); }
      return rel;
    } catch { return null; }
  }
  selectorReport() { return [...this.selectorTrace.values()]; }
  // A destructive step reached through a fallback must be unambiguous.
  async unique(key, hit, selectors, vars) {
    const rec = this.selectorTrace.get(key);
    if (!rec || rec.usedIndex == null || (rec.usedIndex === 0 && !this._scope && !this._forceUnique)) return; // a main selector is trusted, unless it is searched inside a row (then it must be unique too)
    const list = arr(selectors);
    let n = 0;
    try { n = await locate.build(this._scope || this.page, list[rec.usedIndex], vars, esc).count(); } catch { n = 0; }
    if (n > 1) {
      rec.state = 'broken'; rec.ambiguous = n;
      await this.log.error('selector-ambiguous', `"${key}": the fallback (${rec.used}) matches ${n} elements, so it was NOT clicked.`);
      throw new PortalError('SELECTOR_MISSING', `${ERRORS.SELECTOR_MISSING.words} (not clicked: "${key}" matched ${n} buttons, TeamLink will not guess)`, { retryable: false });
    }
  }
  // need() for a destructive step
  async needSafe(selectors, what, ms, vars, key) {
    const loc = await this.need(selectors, what, ms, vars, key);
    await this.unique(key, loc, selectors, vars);
    return loc;
  }

  // go to a page, then look for a block page (HTTP 403 / 429, CAPTCHA, ...)
  async go(url, step) {
    await this.checkpoint(step || 'open');
    const res = await this.page.goto(url, { waitUntil: 'domcontentloaded' });
    if (res && [403, 429].includes(res.status())) {
      await this.shot(`${step || 'open'}-blocked`);
      throw new NeedsHuman('BLOCKED', `${this.name} blocked the request (error ${res.status()}). Do not retry now: open the portal session yourself.`);
    }
    await this.detectBlock(step || 'open');
    return res;
  }

  // ------------------------------------------------------------------ blockers (SAFETY RULE 1)
  blockers() {
    const b = (this.cfg && this.cfg.blockers) || {};
    const merge = (k) => {
      const out = {};
      [DEFAULT_BLOCKERS[k] || {}, b[k] || {}].forEach((src) => Object.keys(src).forEach((code) => { out[code] = [...(out[code] || []), ...arr(src[code])]; }));
      return out;
    };
    return { urlPatterns: merge('urlPatterns'), selectors: merge('selectors'), textPatterns: merge('textPatterns'), scope: [...DEFAULT_BLOCKERS.scopeSelectors, ...arr(b.scopeSelectors)] };
  }
  async detectBlock(step) {
    const bl = this.blockers();
    const url = this.page.url();
    let hit = null;
    for (const [code, pats] of Object.entries(bl.urlPatterns)) {
      if (!hit && pats.some((p) => { try { return new RegExp(p, 'i').test(url); } catch { return false; } })) hit = { code, how: 'address' };
    }
    if (!hit) {
      for (const [code, sels] of Object.entries(bl.selectors)) {
        // eslint-disable-next-line no-await-in-loop
        if (!hit && await this.visible(sels)) hit = { code, how: 'page element' };
      }
    }
    if (!hit) {
      let text = '';
      try {
        text = await this.page.evaluate((scope) => scope.map((s) => Array.from(document.querySelectorAll(s)).filter((e) => e.offsetParent !== null || e.tagName === 'TITLE').map((e) => (e.innerText || e.textContent || '')).join(' ')).join(' | '), bl.scope);
      } catch { text = ''; }
      for (const [code, pats] of Object.entries(bl.textPatterns)) {
        if (!hit && pats.some((p) => { try { return new RegExp(p, 'i').test(text); } catch { return false; } })) hit = { code, how: 'wording' };
      }
    }
    if (!hit) return null;
    await this.shot(`${step}-${hit.code.toLowerCase()}`);
    const words = ERRORS[hit.code] ? ERRORS[hit.code].words : 'The site needs a person.';
    // OTP: a PERSON may type the code (it reaches their phone / e-mail). The run waits for it, once. CAPTCHA and the other
    // checks are never handled here: they stop the run (below) and a person signs in through the portal session.
    if (['OTP', 'TWO_FACTOR'].includes(hit.code) && this.ctx.requestHelp && !this.otpUsed) {
      const entered = await this.handleOtp(step, hit.code);
      if (entered) return null;
    }
    await this.log.warn('blocked', `${hit.code} detected (${hit.how}) at step ${step}. Stopping: a person must sign in.`);
    throw new NeedsHuman(hit.code, `${this.name} is asking for ${hit.code === 'CAPTCHA' ? 'a CAPTCHA' : hit.code === 'OTP' ? 'an OTP' : hit.code === 'TWO_FACTOR' ? 'a 2-step check' : 'a check'}. ${words} Open the login session once yourself (npm run portal-session -- ${this.portal}), then try again.`);
  }

  // The OTP box and its button (page settings "otp": { input, submit }, else common defaults). Neither is destructive:
  // they belong to the portal's own sign-in check.
  otpSelectors() {
    const o = (this.cfg && this.cfg.otp) || {};
    return {
      input: arr(o.input).length ? arr(o.input) : ['input[autocomplete="one-time-code"]', 'input[name*="otp" i]', 'input[id*="otp" i]', { label: 'OTP' }, { placeholder: 'OTP' }, 'input[inputmode="numeric"]'],
      submit: arr(o.submit).length ? arr(o.submit) : [{ role: 'button', name: 'Verify' }, "button:has-text('Submit')", "button:has-text('Continue')", "button[type='submit']", "input[type='submit']"],
    };
  }
  // A person types the OTP: the run stays open and waits (ctx.requestHelp). The code goes into the portal's own OTP box
  // exactly once. A wrong or missing code ends the run as "needs a person" (never retried: repeated wrong codes can lock
  // the account). The code is never logged (the logger scrubs it) and never photographed (the box is masked).
  // -> true when a code was typed in and the page moved on, false when nothing was done.
  async handleOtp(step, code) {
    this.otpUsed = true;
    const sel = this.otpSelectors();
    const box = await this.waitVisible(sel.input, 3000, undefined, 'otp.input');
    if (!box) return false; // no box to type into: the run stops as before
    await this.log.warn('needs-help', 'The site asked for an OTP. Waiting for a person to type it (the browser stays open).');
    const t0 = Date.now();
    let typed = null;
    try { typed = await this.ctx.requestHelp({ kind: 'OTP', step, code }); } finally { this.waitedMs += Date.now() - t0; }
    if (!typed) return false; // nobody typed one in time
    this.log.addSecret(typed);
    await box.fill(typed);
    typed = null; // eslint-disable-line no-param-reassign
    await this.pace();
    const btn = await this.needSafe(sel.submit, 'otp: confirm button', 6000, undefined, 'otp.submit');
    await this.checkpoint('otp');
    await btn.click();
    // did the page move on? (the OTP box is gone and no new check is showing)
    const until = Date.now() + 8000;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
      // eslint-disable-next-line no-await-in-loop
      const still = await this.visible(sel.input);
      if (!still) { await this.log.info('otp', 'The site accepted the OTP and moved on'); return true; }
      if (Date.now() > until) {
        await this.shot(`${step}-otp-not-accepted`);
        throw new NeedsHuman('OTP', `${this.name} did not accept the OTP (it may be wrong or expired). It was not tried again. Start the check again and type the new code.`);
      }
    }
  }

  // ------------------------------------------------------------------ session
  async isLoggedIn() {
    const u = this.cfg.urls.dashboard || this.cfg.urls.postJob;
    await this.go(u, 'session-check');
    if (await this.visible(this.cfg.login.loggedInProbe)) return true;
    return false;
  }

  async login() {
    if (!this.creds || !this.creds.username || !this.creds.password) throw new PortalError('NO_CREDENTIALS');
    const L = this.cfg.login;
    await this.go(this.cfg.urls.login, 'login-open');
    const user = await this.need(L.username, 'login: username box', 8000, undefined, 'login.username');
    const pass = await this.need(L.password, 'login: password box', 8000, undefined, 'login.password');
    await this.checkpoint('login');
    await user.fill(this.creds.username);
    await this.pace();
    await pass.fill(this.creds.password);
    await this.pace();
    const btn = await this.needSafe(L.submit, 'login: sign-in button', 8000, undefined, 'login.submit');
    await btn.click();
    // Wait for: signed in / an error / a challenge. (No screenshot of this page: a password was just typed on it.)
    const until = Date.now() + (L.waitMs || 15000);
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
      // eslint-disable-next-line no-await-in-loop
      await this.detectBlock('login');
      // eslint-disable-next-line no-await-in-loop
      if (await this.visible(L.loggedInProbe)) { await this.log.info('login', 'Signed in'); return true; }
      // eslint-disable-next-line no-await-in-loop
      const err = await this.visible(L.errorProbe);
      if (err) {
        // eslint-disable-next-line no-await-in-loop
        const said = String((await err.innerText().catch(() => '')) || '').toLowerCase();
        const words = arr(L.errorText);
        if (!words.length || words.some((w) => said.includes(String(w).toLowerCase()))) {
          throw new PortalError('WRONG_PASSWORD', ERRORS.WRONG_PASSWORD.words, { retryable: false, needsHuman: false });
        }
      }
      if (Date.now() > until) throw new PortalError('TIMEOUT', `${this.name} did not finish the sign-in in time.`);
    }
  }

  async ensureLoggedIn() {
    if (sessionLib.hasSession(this.portal) && await this.isLoggedIn()) { await this.log.info('login', 'Signed in already (session reused)'); return 'reused'; }
    await this.login();
    return 'login';
  }

  async logout() {
    const sel = (this.cfg.login || {}).logout;
    if (!sel) return false;
    const el = await this.visible(sel);
    if (!el) return false;
    await el.click().catch(() => {});
    await this.log.info('logout', 'Signed out');
    return true;
  }

  // ------------------------------------------------------------------ the job form
  // payload -> { fieldName: value }. A portal adapter overrides this when its form wants something different.
  fieldValues(p) {
    return {
      title: p.title,
      company: p.companyName,
      description: p.description,
      skills: p.skills,
      experience: p.experience.mapped || p.experience.text,
      experienceMin: p.experience.min,
      experienceMax: p.experience.max,
      location: p.location.mapped || p.location.text,
      employmentType: p.employmentType.mapped,
      workMode: p.workMode.mapped,
      salary: p.salary.text ? (p.salary.mapped || p.salary.text) : '',
      salaryMin: p.salary.text ? p.salary.minLakhs : null,
      salaryMax: p.salary.text ? p.salary.maxLakhs : null,
      openings: p.openings,
      industry: p.industry.mapped,
      functionalArea: p.functionalArea.mapped,
      education: p.education,
      contactEmail: p.contactEmail,
      applyUrl: p.applyUrl,
    };
  }

  async fillField(name, spec, value) {
    const type = spec.type || 'text';
    const vars = { value: Array.isArray(value) ? value.join(',') : value };
    const sels = arr(spec.selector);
    if (type === 'radio' || type === 'choice') {
      const loc = await this.waitVisible(sels, 5000, vars, `field.${name}`);
      if (!loc) throw new PortalError('SELECTOR_MISSING', `${ERRORS.SELECTOR_MISSING.words} (not found: ${name})`, { retryable: false });
      await loc.click();
      return;
    }
    const loc = await this.need(sels, name, 6000, vars, `field.${name}`);
    if (type === 'select') {
      const v = String(value);
      try { await loc.selectOption({ label: v }); } catch {
        try { await loc.selectOption(v); } catch { throw new PortalError('PORTAL_REJECTED', `${this.name} has no choice called "${v}" for ${name}. An Admin fixes the mapping.`, { retryable: false }); }
      }
    } else if (type === 'tags') {
      await loc.click();
      for (const tag of arr(value).slice(0, spec.max || 15)) {
        // eslint-disable-next-line no-await-in-loop
        await this.page.keyboard.type(String(tag), { delay: 20 });
        // eslint-disable-next-line no-await-in-loop
        await this.page.keyboard.press('Enter');
      }
    } else if (type === 'autocomplete') {
      await loc.fill(String(value));
      const opt = await this.waitVisible(spec.optionSelector, 5000, vars);
      if (opt) await opt.click(); else await this.page.keyboard.press('Enter');
    } else if (type === 'richtext') {
      await loc.click();
      await this.page.keyboard.insertText(String(value));
    } else if (type === 'checkbox') {
      if (value) await loc.check(); else await loc.uncheck();
    } else {
      await loc.fill(String(value));
    }
  }

  // Fill the whole form. -> { filled: [names], skipped: [names] }
  async fillForm(payload) {
    const P = this.cfg.postJob;
    const values = this.fieldValues(payload);
    const order = P.order || Object.keys(P.fields);
    const filled = []; const skipped = [];
    const groups = P.steps && P.steps.length ? P.steps : [{ fields: order }];
    for (let gi = 0; gi < groups.length; gi += 1) {
      const g = groups[gi];
      for (const name of g.fields) {
        const spec = P.fields[name];
        const v = values[name];
        const empty = v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
        if (!spec || empty) { skipped.push(name); continue; } // eslint-disable-line no-continue
        // eslint-disable-next-line no-await-in-loop
        await this.checkpoint(`fill-${name}`);
        // eslint-disable-next-line no-await-in-loop
        await this.fillField(name, spec, v);
        filled.push(name);
        // eslint-disable-next-line no-await-in-loop
        await this.pace();
      }
      if (g.next && gi < groups.length - 1) {
        // eslint-disable-next-line no-await-in-loop
        const nb = await this.need(g.next, `next step button (${gi + 1})`, 8000, undefined, `form.next.${gi + 1}`);
        // eslint-disable-next-line no-await-in-loop
        await nb.click();
        // eslint-disable-next-line no-await-in-loop
        await this.pace();
        // eslint-disable-next-line no-await-in-loop
        await this.detectBlock(`form-step-${gi + 1}`);
      }
    }
    await this.log.info('fill', `Filled ${filled.length} fields${skipped.length ? `; left blank: ${skipped.join(', ')}` : ''}`);
    return { filled, skipped };
  }

  // ------------------------------------------------------------------ outcome of Submit
  async waitForOutcome(ms = 20000) {
    const S = this.cfg.postJob.success;
    const P = this.cfg.postJob;
    const until = Date.now() + ms;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
      // eslint-disable-next-line no-await-in-loop
      await this.detectBlock('after-submit');
      const url = this.page.url();
      if (S.urlPattern && new RegExp(S.urlPattern, 'i').test(url)) return { kind: 'success', how: 'address' };
      // eslint-disable-next-line no-await-in-loop
      if (S.selector && await this.visible(S.selector)) return { kind: 'success', how: 'page element' };
      if (S.text) {
        // eslint-disable-next-line no-await-in-loop
        const body = String(await this.page.locator('body').innerText().catch(() => '')).toLowerCase();
        if (arr(S.text).some((t) => body.includes(String(t).toLowerCase()))) return { kind: 'success', how: 'wording' };
      }
      // eslint-disable-next-line no-await-in-loop
      const err = await this.visible(P.errorProbe);
      if (err) {
        // eslint-disable-next-line no-await-in-loop
        const said = String(await err.innerText().catch(() => '')).replace(/\s+/g, ' ').trim().slice(0, 200);
        return { kind: 'error', text: said };
      }
      if (Date.now() > until) return { kind: 'timeout' };
    }
  }

  // The id and the link of the new job from the confirmation page. Either may be missing.
  async capture() {
    const S = this.cfg.postJob.success;
    const url = this.page.url();
    let id = null; let link = null;
    try {
      if (S.urlSelector) {
        const a = await this.visible(S.urlSelector);
        if (a) link = await a.getAttribute('href').catch(() => null);
      }
      if (S.idSelector) {
        const el = await this.visible(S.idSelector);
        if (el) id = (S.idAttribute ? await el.getAttribute(S.idAttribute) : null) || String(await el.innerText().catch(() => '')).trim() || null;
      }
      if (!id && S.idPattern) {
        const body = await this.page.locator(S.successScope || 'body').first().innerText().catch(() => '');
        const m = new RegExp(S.idPattern, 'i').exec(body);
        if (m) id = m[1] || m[0];
      }
      if (!id && S.idFromUrl) {
        const m = new RegExp(S.idFromUrl, 'i').exec(url);
        if (m) id = m[1] || m[0];
      }
    } catch { /* nothing captured */ }
    if (id) id = String(id).trim().slice(0, 120);
    if (link) { try { link = new URL(link, url).toString(); } catch { link = null; } }
    if (!link && id && this.cfg.urls.listing) link = tmpl(this.cfg.urls.listing, { id });
    return { portalJobId: id || null, portalUrl: link || null };
  }

  // ------------------------------------------------------------------ the actions
  async createJob(payload, { dryRun = false } = {}) {
    const P = this.cfg.postJob;
    await this.go(this.cfg.urls.postJob, 'post-open');
    await this.need(P.fields.title.selector, 'the job title box', 10000, undefined, 'field.title');
    await this.fillForm(payload);
    await this.shot(dryRun ? 'dry-run-form' : 'form-filled');
    if (dryRun) {
      await this.log.info('dry-run', 'DRY RUN: the form is filled and photographed. Nothing was submitted.');
      return { ok: true, dryRun: true, submitted: false, note: 'DRY RUN: form filled, nothing submitted' };
    }
    if (P.preview) {
      const pv = await this.visible(P.preview);
      if (pv) { await pv.click(); await this.pace(); await this.detectBlock('preview'); await this.shot('preview'); }
    }
    const sub = await this.needSafe(P.submit, 'the Post / Submit button', 10000, undefined, 'post.submit');
    await this.checkpoint('submit');
    // From here the job may go live: the queue must never retry this run by itself (SAFETY RULE 4).
    await this.ctx.onSubmitStart();
    this.submitStarted = true;
    await sub.click();
    if (P.confirm && P.confirm.dialog) {
      const c = await this.waitVisible(P.confirm.dialog, 4000);
      if (c) await c.click();
    }
    await this.log.info('submit', 'Submit pressed');
    const out = await this.waitForOutcome(P.outcomeTimeoutMs || 20000);
    if (out.kind === 'error') {
      await this.shot('submit-error');
      throw new PortalError('PORTAL_REJECTED', `${this.name} said: ${out.text || 'the form was not accepted'}`, { retryable: false, needsHuman: false });
    }
    if (out.kind === 'timeout') {
      await this.shot('submit-unconfirmed');
      return { ok: true, submitted: true, portalJobId: null, portalUrl: null, confirmed: false, note: `${this.name} did not show a confirmation.` };
    }
    const got = await this.capture();
    await this.shot('confirmation');
    await this.log.info('capture', got.portalJobId ? `Confirmation read: job id ${got.portalJobId}` : 'The confirmation page gave no job id');
    return { ok: true, submitted: true, confirmed: true, ...got };
  }

  async updateJob(payload, portalJobId, { dryRun = false } = {}) {
    const P = this.cfg.postJob;
    if (!this.cfg.urls.edit) throw new PortalError('UNEXPECTED', `${this.name}: editing a posted job is not set up for this site.`, { retryable: false, needsHuman: true });
    await this.go(tmpl(this.cfg.urls.edit, { id: portalJobId }), 'edit-open');
    await this.need(P.fields.title.selector, 'the job title box (edit)', 10000, undefined, 'field.title');
    await this.fillForm(payload);
    await this.shot(dryRun ? 'dry-run-edit' : 'edit-filled');
    if (dryRun) return { ok: true, dryRun: true, submitted: false, portalJobId, note: 'DRY RUN: edit form filled, nothing submitted' };
    const sub = await this.needSafe(P.submitEdit || P.submit, 'the Save / Update button', 10000, undefined, 'post.submitEdit');
    await this.ctx.onSubmitStart();
    this.submitStarted = true;
    await sub.click();
    const out = await this.waitForOutcome(P.outcomeTimeoutMs || 20000);
    if (out.kind === 'error') throw new PortalError('PORTAL_REJECTED', `${this.name} said: ${out.text || 'the change was not accepted'}`, { retryable: false, needsHuman: false });
    if (out.kind === 'timeout') return { ok: true, submitted: true, confirmed: false, portalJobId, portalUrl: null, note: `${this.name} did not show a confirmation.` };
    const got = await this.capture();
    return { ok: true, submitted: true, confirmed: true, portalJobId: got.portalJobId || portalJobId, portalUrl: got.portalUrl };
  }

  // Unpublish / close. Closing twice is harmless, so this one may be retried by the queue.
  async deleteJob(portalJobId, { dryRun = false } = {}) {
    const U = this.cfg.unpublish;
    if (!U) throw new PortalError('UNEXPECTED', `${this.name}: closing a job is not set up for this site.`, { retryable: false, needsHuman: true });
    if (!portalJobId) throw new PortalError('UNEXPECTED', 'There is no portal job id to close.', { retryable: false, needsHuman: true });
    const vars = { id: portalJobId };
    if (U.directUrl) await this.go(tmpl(U.directUrl, vars), 'close-open');
    else { await this.go(tmpl(U.listUrl, vars), 'close-list'); }
    // The Close button is searched INSIDE the job's own row (never on the whole page: another job's button must not be hit),
    // and it must be exactly one button.
    let row = null;
    if (U.rowSelector) { row = await this.need(U.rowSelector, 'the job row', 8000, vars, 'close.row'); await row.scrollIntoViewIfNeeded().catch(() => {}); }
    if (dryRun) { await this.shot('dry-run-close'); return { ok: true, dryRun: true, portalJobId, note: 'DRY RUN: nothing was closed' }; }
    // 1. inside the job's row (an ambiguous match there is refused);  2. else on the page, but only if EXACTLY ONE button matches.
    let btn = null;
    if (row) {
      this._scope = row;
      try {
        const hit = await this.waitVisible(U.closeButton, 3000, vars);
        if (hit) btn = await this.needSafe(U.closeButton, 'the Close / Remove button', 3000, vars, 'close.button');
      } finally { this._scope = null; }
    }
    if (!btn) {
      this._forceUnique = true;
      try { btn = await this.needSafe(U.closeButton, 'the Close / Remove button', 8000, vars, 'close.button'); } finally { this._forceUnique = false; }
    }
    await this.checkpoint('close');
    await btn.click();
    if (U.confirm) { const c = await this.waitVisible(U.confirm, 4000, vars); if (c) await c.click(); }
    await this.pace();
    const until = Date.now() + 15000;
    for (;;) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(250);
      // eslint-disable-next-line no-await-in-loop
      await this.detectBlock('after-close');
      // eslint-disable-next-line no-await-in-loop
      const body = String(await this.page.locator('body').innerText().catch(() => '')).toLowerCase();
      if (arr(U.doneText).some((t) => body.includes(String(t).toLowerCase()))) break;
      if (Date.now() > until) { await this.shot('close-unconfirmed'); return { ok: true, confirmed: false, portalJobId, note: `${this.name} did not confirm the job was closed.` }; }
    }
    await this.log.info('close', 'The job is closed on the site');
    return { ok: true, confirmed: true, portalJobId };
  }

  // Re-open the listing and see the job there. Never submits anything.
  async verifyPosted(result, payload) {
    const V = this.cfg.verify || {};
    const target = result.portalUrl || (result.portalJobId && this.cfg.urls.listing ? tmpl(this.cfg.urls.listing, { id: result.portalJobId }) : null);
    if (!target) return { verified: false, note: 'There is no link to open.' };
    await this.go(target, 'verify-open');
    const body = String(await this.page.locator('body').innerText().catch(() => '')).toLowerCase();
    if (arr(V.notFoundText).some((t) => body.includes(String(t).toLowerCase()))) return { verified: false, note: 'The site says the job is not there.' };
    const word = String((payload && payload.title) || '').toLowerCase().slice(0, 24);
    let ok = false;
    if (V.titleSelector) {
      const el = await this.visible(V.titleSelector);
      const t = el ? String(await el.innerText().catch(() => '')).toLowerCase() : '';
      ok = !!t && (!word || t.includes(word));
    } else if (V.okSelector) ok = !!(await this.visible(V.okSelector));
    else ok = !!word && body.includes(word);
    if (ok && result.portalJobId && V.requireIdOnPage !== false && !body.includes(String(result.portalJobId).toLowerCase()) && !String(this.page.url()).toLowerCase().includes(String(result.portalJobId).toLowerCase())) ok = false;
    await this.shot(ok ? 'verified' : 'verify-failed');
    return { verified: ok, note: ok ? 'The listing opens and shows the job.' : 'The listing page did not show this job.' };
  }

  // ------------------------------------------------------------------ health (no browser)
  async health() {
    const c = await cfgLib.load(this.portal);
    const found = browserLib.findBrowser();
    return {
      portal: this.portal,
      settingsOk: c.ok, settingsProblems: c.problems, settingsFile: c.file, settingsFrom: c.origin, settingsVersion: c.version || null, settingsVerified: !!c.verified,
      browserFound: !!found, browser: found ? found.label : null, sessionSaved: sessionLib.hasSession(this.portal),
    };
  }

  // ------------------------------------------------------------------ RUN (the orchestrator)
  // action: PUBLISH | REPUBLISH | UPDATE | UNPUBLISH | VERIFY
  // job: { payload, portalJobId }   ctx: { queueId, requirementId, dryRun, headed, onSubmitStart, checkpoint, deadlineMs }
  async run(action, job = {}, ctx = {}) {
    this.ctx = { onSubmitStart: async () => {}, ...ctx };
    const loaded = await cfgLib.load(this.portal);
    if (!loaded.ok) {
      return this.fail(new PortalError('SELECTOR_MISSING', `${ERRORS.SELECTOR_MISSING.words} (${loaded.problems.join('; ')})`, { retryable: false }));
    }
    this.cfg = loaded.cfg;
    const deadline = this.ctx.deadlineMs || (this.cfg.timeouts && this.cfg.timeouts.overall) || 180000;
    const strict = browserLib.strictLocal(this.cfg);
    // REAL posting needs: TL_ALLOW_REAL_POSTING=1 on this computer AND page settings marked verified (a Dry run is always allowed).
    const gate = guards.realPostingGate({ strict, verified: !!loaded.verified, action, dryRun: !!this.ctx.dryRun });
    if (gate) return this.fail(new PortalError(gate, ERRORS[gate].words, { retryable: false, needsHuman: true }));
    let timer; let timedOut = false;
    try {
      this.handle = await browserLib.launch({
        portal: this.portal, headed: !!this.ctx.headed, allowedHosts: this.cfg.allowedHosts, strict,
        navTimeoutMs: (this.cfg.timeouts && this.cfg.timeouts.nav) || 20000, actionTimeoutMs: (this.cfg.timeouts && this.cfg.timeouts.action) || 8000,
      });
      this.page = this.handle.page;
      await this.log.info('open', `Browser started (${this.handle.browser}${strict ? ', local addresses only' : ''}, ${this.ctx.headed ? 'visible' : 'headless'})`);
      const work = this.perform(action, job);
      // The deadline does not count the time spent waiting for a person's OTP (this.waitedMs).
      const started = Date.now();
      const guard = new Promise((_, rej) => {
        timer = setInterval(() => {
          if (Date.now() - started - this.waitedMs > deadline) { timedOut = true; rej(new PortalError('TIMEOUT', `The run took longer than ${Math.round(deadline / 1000)} seconds.`)); }
        }, 500);
      });
      const res = await Promise.race([work, guard]);
      // EVERY attempt keeps a picture, success or failure: one more at the end when this run took none yet.
      if (!this.screenshots.some((p) => p.toLowerCase().endsWith('.png'))) await this.shot('final');
      return { screenshots: this.screenshots, submitted: this.submitStarted, selectors: this.selectorReport(), ...res };
    } catch (err) {
      if (timedOut) {
        // a hung step: one quick picture of where it hung, then closing the browser frees the step
        try { await this.shot('failed-timeout'); } catch { /* the picture is a bonus */ }
        try { await this.handle.close(); } catch { /* closing frees the hung step */ }
        this.closedEarly = true;
      }
      return await this.fail(err); // (awaited: the failure picture must be taken BEFORE the browser is closed in "finally")
    } finally {
      clearInterval(timer);
      if (this.handle) await this.handle.close();
      if (this.handle && this.handle.blocked && this.handle.blocked.length) {
        await this.log.warn('network-guard', `Blocked ${this.handle.blocked.length} address(es) outside the portal's own domains: ${[...new Set(this.handle.blocked.map((b) => b.host))].join(', ').slice(0, 200)}`);
      }
    }
  }

  async perform(action, job) {
    const how = await this.ensureLoggedIn();
    if (action === 'VERIFY') {
      return { ok: true, verified: true, loggedIn: true, note: `Signed in (${how === 'reused' ? 'saved session' : 'fresh sign-in'}). Nothing was posted.` };
    }
    if (action === 'UNPUBLISH') {
      const r = await this.deleteJob(job.portalJobId, { dryRun: !!this.ctx.dryRun });
      return { ...r, verified: !!r.confirmed };
    }
    let r;
    if (action === 'UPDATE' || (action === 'REPUBLISH' && job.portalJobId && job.live)) {
      r = await this.updateJob(job.payload, job.portalJobId, { dryRun: !!this.ctx.dryRun });
    } else {
      r = await this.createJob(job.payload, { dryRun: !!this.ctx.dryRun });
    }
    if (r.dryRun) return r;
    // verify: only a job with an id or a link, that the listing page really shows, counts as live (SAFETY RULE 5)
    if (!r.portalJobId && !r.portalUrl) {
      return { ...r, ok: true, verified: false, code: 'NO_JOB_ID', needsHuman: true, retryable: false, reason: ERRORS.NO_JOB_ID.words };
    }
    let v = { verified: false, note: 'Not checked' };
    try { v = await this.verifyPosted(r, job.payload); } catch (err) {
      if (err instanceof NeedsHuman || err instanceof RunAborted) throw err;
      v = { verified: false, note: `The listing could not be opened: ${String(err.message).split('\n')[0].slice(0, 100)}` };
    }
    await this.log.info('verify', v.verified ? 'Verified: the listing shows the job' : `Not verified: ${v.note}`);
    if (!v.verified) return { ...r, verified: false, code: 'UNVERIFIED', needsHuman: true, retryable: false, reason: `${ERRORS.UNVERIFIED.words} ${v.note}` };
    if (this.cfg.logoutAfterRun) await this.logout();
    return { ...r, verified: true };
  }

  // any error -> the standard result (never a raw exception)
  async fail(err) {
    let e = err;
    if (e instanceof RunAborted) {
      return { ok: false, aborted: true, abortWhy: e.why, code: e.why, reason: e.message, retryable: true, needsHuman: false, screenshots: this.screenshots, submitted: this.submitStarted, selectors: this.selectorReport() };
    }
    if (!(e instanceof PortalError)) {
      const msg = String((e && e.message) || e);
      if (e && e.code === 'NO_BROWSER') e = new PortalError('NO_BROWSER');
      else if (e && ['PROFILE_IN_USE', 'BROWSER_START'].includes(e.code)) e = new PortalError('UNEXPECTED', msg, { retryable: e.code === 'PROFILE_IN_USE', needsHuman: false });
      else if (/Timeout \d+ms exceeded|waiting for/i.test(msg) && !/net::/i.test(msg)) e = new PortalError('TIMEOUT', `${this.name} was too slow (${msg.split('\n')[0].slice(0, 120)}).`);
      else if (looksTransient(e)) e = new PortalError('NETWORK', `${ERRORS.NETWORK.words} (${msg.split('\n')[0].slice(0, 120)})`);
      else if (/blocked_?by_?client/i.test(msg)) e = new PortalError('HOST_BLOCKED', ERRORS.HOST_BLOCKED.words, { retryable: false });
      else e = new PortalError('UNEXPECTED', `${ERRORS.UNEXPECTED.words} (${msg.split('\n')[0].slice(0, 160)})`);
    }
    // SAFETY RULE 4: Submit was pressed and the outcome is unknown -> a person checks, the queue never retries.
    if (this.submitStarted && e.retryable) {
      e = new PortalError('UNVERIFIED', `${ERRORS.UNVERIFIED.words} (the run stopped after Submit: ${e.message})`, { retryable: false, needsHuman: true });
    }
    try { if (this.page && !this.closedEarly) await this.shot(`failed-${e.code.toLowerCase()}`); } catch { /* the picture is a bonus */ }
    await this.log.error('failed', `${e.code}: ${e.message}`);
    return {
      ok: false, code: e.code, reason: e.message, retryable: !!e.retryable, needsHuman: !!e.needsHuman, screenshots: this.screenshots, submitted: this.submitStarted, selectors: this.selectorReport(),
    };
  }
}

module.exports = BasePortal;
module.exports.DEFAULT_BLOCKERS = DEFAULT_BLOCKERS;
module.exports.tmpl = tmpl;
