/*
 * IMPORT RESUMES: match, or add the new person (founder 2026-11-10).
 *
 * Added to the Job Portal's pages by the TeamLink proxy (backend/src/utils/jobPortalEmbed.js), served by the TeamLink router inside the portal
 * (embed/teamlink-integration.mjs GET /tl-addon/resume-import.js). The portal's own code is NOT changed: its "Import Resumes" window
 * (TL.resumes) is kept, only its Send goes to POST /api/tl-resumes/import (embed/resume-import.mjs):
 *   somebody already in the portal -> the resume is attached to them
 *   somebody new                   -> a candidate is made from the resume, the resume attached, and a login with the TeamLink link is sent
 * Files are read a few at a time on the server, so a batch is quicker than before.
 */
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.__tlResumeImport) return;
  window.__tlResumeImport = true;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  function send() {
    var input = document.getElementById('tlResumeFiles');
    var out = document.getElementById('tlResumeOut');
    var files = input && input.files ? input.files : [];
    if (!files.length) {
      if (out) out.innerHTML = '<div class="req-note">Choose the resume files first.</div>';
      return Promise.resolve();
    }
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('resumes', files[i]);
    var btn = document.getElementById('tlResumeGo');
    if (btn) btn.disabled = true;
    if (out) out.innerHTML = '<div class="req-note">Reading ' + plural(files.length, 'file') + '… a few at a time.</div>';

    return window.TL.api.post('/tl-resumes/import', fd).then(function (r) {
      var d = r.detail || {};
      var parts = [];
      if (r.matched) parts.push(r.matched + ' attached to existing candidates');
      if (r.created) parts.push(plural(r.created, 'new candidate') + ' added');
      if (r.unmatched) parts.push(r.unmatched + ' not added');
      if (r.refused) parts.push(r.refused + ' could not be read');
      var html = '<div class="req-note" style="background:var(--ok-100);color:var(--ok-600)">'
        + esc(parts.join(', ') || 'Nothing was added') + '</div>';

      html += (d.matched || []).map(function (m) {
        return '<div style="font-size:12.5px;margin-top:6px">&#10003; <b>' + esc(m.candidateName) + '</b> &mdash; ' + esc(m.file)
          + ' <span style="color:var(--text-soft)">(matched by ' + esc(m.matchedBy) + ')</span></div>';
      }).join('');
      html += (d.created || []).map(function (c) {
        return '<div style="font-size:12.5px;margin-top:6px">&#43; <b>' + esc(c.candidateName) + '</b> &mdash; ' + esc(c.file)
          + ' <span style="color:var(--text-soft)">(new candidate; login and TeamLink link sent to their '
          + esc(c.loginTo === 'email' ? 'email' + (c.phone ? ', SMS and WhatsApp' : '') : 'phone') + ')</span></div>';
      }).join('');
      html += (d.unmatched || []).map(function (u) {
        var read = u.read || {};
        var bits = [read.name, read.email, read.phone, read.currentCompany, read.location].filter(Boolean).map(esc).join(' &middot; ');
        return '<div style="font-size:12.5px;margin-top:6px;color:var(--warn-600)">? ' + esc(u.file) + ' &mdash; ' + esc(u.reason)
          + (bits ? '<div style="color:var(--text-soft)">read: ' + bits + '</div>' : '') + '</div>';
      }).join('');
      html += (d.refused || []).map(function (x) {
        return '<div style="font-size:12.5px;margin-top:6px;color:var(--bad-600)">&times; ' + esc(x.file) + ' &mdash; ' + esc(x.reason) + '</div>';
      }).join('');
      if (out) out.innerHTML = html;
      if (btn) btn.disabled = false;
      if (typeof window.toast === 'function' && (r.matched || r.created)) {
        window.toast((r.matched ? r.matched + ' attached' : '') + (r.matched && r.created ? ', ' : '') + (r.created ? plural(r.created, 'new candidate') + ' added' : ''));
      }
      // the candidate list and the counts at the top are out of date now
      if (typeof window.TL.refresh === 'function') return window.TL.refresh();
      return null;
    }).catch(function (err) {
      if (btn) btn.disabled = false;
      if (out) {
        out.innerHTML = '<div class="req-note" style="background:var(--bad-100);color:var(--bad-600)">'
          + esc((err && err.message) || 'Those files could not be added.') + '</div>';
      }
    });
  }

  // the window's words say what it does now; the portal's own window is drawn first, then these few lines change
  function retitle() {
    var body = document.getElementById('tlResumeBody');
    if (!body) return;
    var note = body.querySelector('.req-note');
    if (note && !note.__tl) {
      note.__tl = true;
      note.innerHTML = 'Each file is matched to the candidate it belongs to by what the resume itself says &mdash; the <b>email address</b> first, '
        + 'then the <b>phone number</b>, then the <b>name together with the company or the city</b>. '
        + '<b>Somebody new is added as a candidate</b> from the resume (name and an email or phone are needed), and gets a '
        + '<b>login with the TeamLink link</b> by email, SMS and WhatsApp.';
    }
    var go = body.querySelector('button.btn-primary');
    if (go && !go.__tl) {
      go.__tl = true;
      go.id = 'tlResumeGo';
      go.textContent = 'Match, attach or add'; // its onclick calls TL.resumes.send, which is this file's send
    }
  }

  var tries = 0;
  (function install() {
    var R = window.TL && window.TL.resumes;
    if (!R || typeof R.refresh !== 'function' || !window.TL.api) { if (++tries < 120) setTimeout(install, 250); return; }
    if (R.__tlWrapped) return;
    R.__tlWrapped = true;
    var prevRefresh = R.refresh;
    R.refresh = function () {
      var p = prevRefresh.apply(this, arguments);
      retitle();
      return p;
    };
    R.send = send;
  })();
})();
