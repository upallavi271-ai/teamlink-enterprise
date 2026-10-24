#!/usr/bin/env node
// Pure-logic test of the sidebar Omni-Channel click (frontend/src/components/outreach/greenStartLink.js): which address, and what a click does
// (in-page frame / new tab after the pass / same tab when pop-ups are blocked / a plain error and the tab closed). No browser needed.
//   cd backend && node scripts/green-start-link-test.js
/* eslint-disable no-console */
const path = require('path');
const { pathToFileURL } = require('url');
let pass = 0; let fail = 0;
const check = (n, ok, d) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${!ok && d != null ? `  -> ${JSON.stringify(d).slice(0, 300)}` : ''}`); };

(async () => {
  const L = await import(pathToFileURL(path.resolve(__dirname, '..', '..', 'frontend', 'src', 'components', 'outreach', 'greenStartLink.js')).href);
  const R = L.resolveGreenStartUrl;

  // ---- which address
  check('L1 localhost, nothing set -> "" (the in-page frame, as today)', R({ envUrl: undefined, hostname: 'localhost' }) === '' && R({ envUrl: '', hostname: '127.0.0.1' }) === '' && R({}) === '');
  check('L2 the live site teamlink.teamlinks.in, nothing set -> https://greenstart.teamlinks.in', R({ envUrl: '', hostname: 'teamlink.teamlinks.in' }) === 'https://greenstart.teamlinks.in');
  check('L2 any *.teamlinks.in host and teamlinks.in itself, any capitals', ['hrms.teamlinks.in', 'TeamLink.TeamLinks.IN', 'teamlinks.in'].every((h) => R({ hostname: h }) === 'https://greenstart.teamlinks.in'));
  check('L3 look-alike hosts do NOT count (evilteamlinks.in, teamlinks.in.evil.com, teamlinks.com)', ['evilteamlinks.in', 'teamlinks.in.evil.com', 'teamlinks.com', 'x.teamlinks.in.example'].every((h) => R({ hostname: h }) === ''));
  check('L4 VITE_GREENSTART_URL = an address overrides everything (also on localhost)', R({ envUrl: 'https://gs.example.org', hostname: 'localhost' }) === 'https://gs.example.org' && R({ envUrl: ' https://gs.example.org ', hostname: 'teamlink.teamlinks.in' }) === 'https://gs.example.org');
  check('L5 VITE_GREENSTART_URL = local (any capitals) keeps the in-page frame, even on the live host', R({ envUrl: 'local', hostname: 'teamlink.teamlinks.in' }) === '' && R({ envUrl: 'LOCAL', hostname: 'localhost' }) === '');

  // ---- the click
  const mkTab = (over = {}) => { const t = { closed: false, opener: 'TEAMLINK', document: { title: '', body: { innerHTML: '' } }, location: { href: 'about:blank' }, close() { this.closed = true; }, ...over }; return t; };
  const mk = (o = {}) => {
    const log = { opened: [], posted: 0, assigned: [], local: 0, toasts: [], order: [] };
    const tab = o.noTab ? null : (o.tab || mkTab());
    const deps = {
      url: o.url === undefined ? 'https://greenstart.teamlinks.in' : o.url,
      postSession: () => { log.posted += 1; log.order.push('post'); return o.fail ? Promise.reject(o.fail) : Promise.resolve({ data: { ok: true } }); },
      openWindow: (u, t) => { log.opened.push([u, t]); log.order.push('open'); if (o.throwOpen) throw new Error('blocked'); return tab; },
      assign: (u) => log.assigned.push(u),
      goLocal: () => { log.local += 1; },
      notify: (m) => log.toasts.push(m),
    };
    return { deps, log, tab };
  };

  {
    const { deps, log } = mk({ url: '' });
    const r = await L.openGreenStart(deps);
    check('C1 no address (localhost): goes to the in-page frame; no tab, no pass call, no message', r.mode === 'local' && log.local === 1 && log.posted === 0 && !log.opened.length && !log.toasts.length, { r, log });
  }
  {
    const { deps, log, tab } = mk();
    const p = L.openGreenStart(deps);
    check('C2 the tab is opened FIRST and synchronously (before the pass call finishes), so a pop-up blocker sees a real click', log.order[0] === 'open' && log.opened[0][1] === '_blank', log.order);
    const r = await p;
    check('C2 then the pass is requested exactly once, then the tab is sent to Green Start', r.mode === 'tab' && log.posted === 1 && log.order.join() === 'open,post' && tab.location.href === 'https://greenstart.teamlinks.in', { r, order: log.order, href: tab.location.href });
    check('C2 the new tab cannot reach back into TeamLink (opener cleared); this page is not navigated; no error', tab.opener === null && !log.assigned.length && !log.toasts.length && !tab.closed, { opener: tab.opener, assigned: log.assigned });
    check('C2 while waiting the tab shows "Opening Green Start..."', tab.document.title === 'Green Start' && /Opening Green Start/.test(tab.document.body.innerHTML), tab.document);
  }
  {
    const { deps, log, tab } = mk({ fail: { response: { status: 403, data: { error: 'Green Start is for Admin, Manager, Team Lead and HR logins.' } } } });
    const r = await L.openGreenStart(deps);
    check('C3 the pass is refused (403): the blank tab is closed, nothing opens, a plain message with the server\'s words', r.mode === 'error' && tab.closed === true && tab.location.href === 'about:blank' && log.toasts.length === 1 && log.toasts[0] === 'Could not open Green Start: Green Start is for Admin, Manager, Team Lead and HR logins.', { r, toasts: log.toasts });
  }
  {
    const cases = [
      [{ response: { status: 401, data: {} } }, /sign in again/i],
      [{ response: { status: 404, data: { error: 'Green Start is switched off on this server (GREENSTART_ENABLED).' } } }, /switched off/i],
      [{ response: { status: 500, data: '<html>' } }, /try again in a minute/i],
      [{ message: 'Network Error' }, /did not answer/i],
      [{}, /try again/i],
    ];
    let ok = true; const seen = [];
    for (const [err, rx] of cases) {
      const { deps, log } = mk({ fail: err });
      await L.openGreenStart(deps); // eslint-disable-line no-await-in-loop
      seen.push(log.toasts[0]);
      if (!(log.toasts.length === 1 && /^Could not open Green Start: /.test(log.toasts[0]) && rx.test(log.toasts[0]))) ok = false;
    }
    check('C4 plain reasons for 401, switched-off 404, server error, no network and unknown errors: "Could not open Green Start: <reason>"', ok, seen);
  }
  {
    const { deps, log } = mk({ noTab: true });
    const r = await L.openGreenStart(deps);
    check('C5 pop-ups blocked (no tab): the pass is still requested, then Green Start opens in THIS tab', r.mode === 'same-tab' && log.posted === 1 && log.assigned.join() === 'https://greenstart.teamlinks.in' && !log.toasts.length, { r, log });
    const b = mk({ throwOpen: true });
    const rb = await L.openGreenStart(b.deps);
    check('C5 window.open throwing is treated the same (this tab)', rb.mode === 'same-tab' && b.log.assigned.length === 1, rb);
    const f = mk({ noTab: true, fail: { response: { status: 403, data: { error: 'No.' } } } });
    const rf = await L.openGreenStart(f.deps);
    check('C5 pop-ups blocked AND the pass refused: no navigation away, just the message', rf.mode === 'error' && !f.log.assigned.length && f.log.toasts[0] === 'Could not open Green Start: No.', f.log);
  }
  {
    const tab = mkTab();
    const { deps, log } = mk({ tab });
    deps.postSession = () => new Promise((resolve) => { tab.closed = true; setTimeout(resolve, 5); }); // the person closes the new tab while it waits
    const r = await L.openGreenStart(deps);
    check('C6 the person closed the new tab while waiting: nothing else happens (this page is not taken over)', r.mode === 'cancelled' && !log.assigned.length && !log.toasts.length, r);
  }
  {
    const { deps } = mk(); const t = mkTab({ document: { get title() { throw new Error('cross'); }, set title(v) { throw new Error('cross'); }, body: null } });
    deps.openWindow = () => t;
    const r = await L.openGreenStart(deps);
    check('C7 a tab whose page cannot be written to still works (a blank tab is fine)', r.mode === 'tab' && t.location.href === 'https://greenstart.teamlinks.in', r);
  }
  check('C8 reasonOf: a server message wins; a nested {error:{message}} is read; nothing leaks an object', L.reasonOf({ response: { data: { error: 'A' } } }) === 'A' && L.reasonOf({ response: { data: { error: { message: 'B' } } } }) === 'B' && typeof L.reasonOf(undefined) === 'string' && !/\[object/.test(L.reasonOf({ response: { status: 418, data: { error: {} } } })));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
