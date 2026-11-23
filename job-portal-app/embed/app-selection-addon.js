/* =====================================================================
   TEAMLINK ADD-ON - more actions on the Applications selection bar (2026-11-23: "select chesukuntey whatsapp, call, sms, rcs ravali")
   The bar above the Applications table (web/teamlink-app-selection.js) had only WhatsApp and Clear selection. This add-on, added to the portal's pages by
   the TeamLink proxy, puts three more buttons beside WhatsApp, using what the portal already has:
     AI Call  the selected applicants are called by Kavya (the bulk "Start AI Calls" route, embed/kavya-campaign.mjs), one request per job
     SMS      the portal's bulk message box (web/teamlink-bulk-message.js), given the selected applicants' candidates
     Email    the same box, by email
   Call     a normal (manual) call: ONE applicant selected opens TeamLink's browser calling for them (/call-start?phone=&name=, the recruiter speaks)
   RCS is not here: there is no bulk RCS sender for candidates yet (RCS exists for the login message only).
   Nothing is sent from a button; SMS / Email open the compose box, AI Call asks before it calls.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tlAppSelActions) return;
  window.__tlAppSelActions = true;

  var toast = function (m, i) { if (typeof window.toast === 'function') window.toast(m, i || 'ℹ️'); };
  var sel = function () { return window.TLAppSelection || null; };

  /* the selected applications as { app, candidate } pairs, from the data the page already holds */
  function pairs() {
    var s = sel();
    if (!s) return [];
    var D = window.DATA || {};
    var apps = D.applications || [];
    var cands = D.candidates || [];
    return s.get().map(function (id) {
      var a = apps.filter(function (x) { return x && x.id === id; })[0];
      var c = a ? cands.filter(function (x) { return x && x.id === a.candidateId; })[0] : null;
      return a && c ? { app: a, cand: c } : null;
    }).filter(Boolean);
  }

  function compose(channel) {
    var ps = pairs();
    if (!ps.length) { toast('Select at least one applicant first', '☑️'); return; }
    if (typeof window.tlBulkMessage !== 'function') { toast('The message box is not loaded on this page yet.', '⚠️'); return; }
    var seen = {};
    var rows = ps.filter(function (p) { if (seen[p.cand.id]) return false; seen[p.cand.id] = 1; return true; }).map(function (p) {
      var c = p.cand;
      return { id: c.id, name: c.name, phone: c.phone, email: c.email, title: c.title || '', doNotContact: !!c.doNotContact };
    });
    var orig = window.tpSelection;
    window.tpSelection = function () { return rows; }; // the message box reads its people from here; put back straight after it has read them
    try { window.tlBulkMessage(channel); } finally { window.tpSelection = orig; }
  }

  function aiCall() {
    var ps = pairs().filter(function (p) { return p.cand.phone && p.app.jobId; });
    if (!ps.length) { toast('None of the selected applicants has a phone number and a job.', '⚠️'); return; }
    var byJob = {};
    ps.forEach(function (p) { (byJob[p.app.jobId] = byJob[p.app.jobId] || {})[p.cand.id] = 1; });
    var jobs = Object.keys(byJob);
    if (!window.confirm('Kavya (AI caller) will phone ' + ps.length + ' applicant' + (ps.length === 1 ? '' : 's') + ' about ' + jobs.length + ' job' + (jobs.length === 1 ? '' : 's') + '. Continue?')) return;
    var api = window.TL && window.TL.api;
    if (!api) return;
    var queued = 0, skipped = 0, why = {};
    var next = function (i) {
      if (i >= jobs.length) {
        var reasons = Object.keys(why).slice(0, 3).map(function (k) { return why[k] + ' ' + k; }).join('; ');
        toast(queued + ' sent to Kavya' + (skipped ? ', ' + skipped + ' skipped' + (reasons ? ': ' + reasons : '') : ''), '📞');
        return;
      }
      api.post('/ai-calling/campaign', { jobId: jobs[i], candidateIds: Object.keys(byJob[jobs[i]]) }).then(function (r) {
        queued += (r && r.queued ? r.queued.length : 0);
        ((r && r.skipped) || []).forEach(function (x) { skipped += 1; why[x.reason] = (why[x.reason] || 0) + 1; });
      }, function (e) {
        var n = Object.keys(byJob[jobs[i]]).length; skipped += n;
        var m = (e && e.message) || 'could not be queued'; why[m] = (why[m] || 0) + n;
      }).then(function () { next(i + 1); });
    };
    next(0);
  }

  /* A manual browser call (TeamLink's softphone, /call-start): one person at a time */
  function manualCall() {
    var ps = pairs();
    if (ps.length !== 1) { toast(ps.length ? 'Select ONE applicant to call from your browser (Call). For many people use AI Call.' : 'Select an applicant first', '☑️'); return; }
    var c = ps[0].cand;
    if (!c.phone) { toast('This applicant has no phone number.', '⚠️'); return; }
    window.open('/call-start?phone=' + encodeURIComponent(String(c.phone)) + '&name=' + encodeURIComponent(String(c.name || '')), '_blank');
  }

  var BUTTONS = [
    ['tlas-mcall', 'Call', 'Call the applicant from your browser (one person at a time)', manualCall],
    ['tlas-call', 'AI Call', 'Kavya (the AI caller) phones the selected applicants', aiCall],
    ['tlas-sms', 'SMS', 'Write an SMS to the selected applicants', function () { compose('sms'); }],
    ['tlas-mail', 'Email', 'Write an email to the selected applicants', function () { compose('email'); }],
  ];

  function decorate() {
    var bar = document.getElementById('tlasBar');
    if (!bar || bar.querySelector('.tlas-mcall')) return;
    var anchor = bar.querySelector('.tlas-clear');
    BUTTONS.forEach(function (b) {
      var el = document.createElement('button');
      el.type = 'button'; el.className = 'btn btn-ghost btn-sm ' + b[0]; el.title = b[2]; el.textContent = b[1];
      el.addEventListener('click', function (e) { e.preventDefault(); b[3](); });
      if (anchor) bar.insertBefore(el, anchor); else bar.appendChild(el);
    });
  }

  /* The profile's "Call" (web/teamlink-shared-candidates.js, TLEngagement._call) opened the computer's own phone app (tel:) and then asked to "Log call". It now starts
     TeamLink's browser calling instead (the call is recorded by TeamLink itself, so there is no manual log). The same engagement check (who holds this candidate)
     runs first. */
  var tries = 0;
  var iv = setInterval(function () {
    var T = window.TLEngagement;
    if (T && typeof T._call === 'function' && typeof T.gate === 'function' && !T._call.__tlBrowserCall) {
      T._call = function (id) {
        var c = window.DATA && window.DATA.candidateById ? window.DATA.candidateById(id) : null;
        if (!c || !c.phone) { toast('No phone number on file', '⚠️'); return; }
        var tab = null;
        try { tab = window.open('about:blank', '_blank'); } catch (e) { tab = null; } // opened inside the click, so a pop-up blocker allows it
        Promise.resolve(T.gate({ candidateId: id, jobId: null, action: 'call' })).then(function (ok) {
          if (!ok) { if (tab) try { tab.close(); } catch (e) { /* gone */ } return; }
          var url = '/call-start?phone=' + encodeURIComponent(String(c.phone)) + '&name=' + encodeURIComponent(String(c.name || ''));
          if (tab && !tab.closed) tab.location.href = url; else window.open(url, '_blank');
        }, function () { if (tab) try { tab.close(); } catch (e) { /* gone */ } });
      };
      T._call.__tlBrowserCall = true;
      clearInterval(iv);
    } else if (++tries > 120) clearInterval(iv);
  }, 500);


  /* TALENT POOL: a normal "Call" (TeamLink browser calling) beside each row's "AI Call". The row already shows the name and the phone; nothing else is read. */
  function decoratePool() {
    var btns = document.querySelectorAll('td.act button[onclick^="tpCall("]');
    Array.prototype.forEach.call(btns, function (ai) {
      var td = ai.parentNode;
      if (!td || td.querySelector('.tlpool-call')) return;
      var tr = td.closest('tr');
      var phone = tr && tr.children[2] ? String(tr.children[2].textContent || '').trim() : '';
      var nm = tr && tr.querySelector('.who b') ? String(tr.querySelector('.who b').textContent || '').trim() : '';
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'btn btn-ghost btn-sm tlpool-call';
      b.title = phone ? 'Call from your browser' : 'No phone number on file';
      b.textContent = 'Call';
      if (!/\d{7,}/.test(phone)) b.disabled = true;
      b.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        window.open('/call-start?phone=' + encodeURIComponent(phone) + '&name=' + encodeURIComponent(nm), '_blank');
      });
      td.insertBefore(b, ai);
    });
  }

  var mo = new MutationObserver(function () { decorate(); decoratePool(); });
  var start = function () { decorate(); decoratePool(); mo.observe(document.body, { childList: true, subtree: true }); };
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
