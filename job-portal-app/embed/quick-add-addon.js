/* =====================================================================
   TEAMLINK ADD-ON - Add Candidate: the email is OPTIONAL
   (founder 2026-11-10: "add candidates loo email compulsory anii unadhii adhii remove cehyuu")

   The portal's quick-add dialog (web/teamlink-add-candidate.js) refuses a save with no email. This add-on, added to the portal's
   pages by the TeamLink proxy (backend/src/utils/jobPortalEmbed.js), leaves that file as it is and:
     - marks Email "(optional)" and says where the login goes without one;
     - saves a candidate with name, phone and gender and NO email itself (the TeamLink bridge,
       embed/teamlink-integration.mjs isPhoneOnlyAdd, makes the portal accept it and sends the login to the mobile number
       by SMS / WhatsApp with the TeamLink link);
     - with an email typed, the portal's own save runs exactly as before.
   No password passes through here.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tlQuickAddOptionalEmail) return;
  window.__tlQuickAddOptionalEmail = true;

  var $ = function (id) { return document.getElementById(id); };
  var val = function (id) { var el = $(id); return el ? String(el.value || '').trim() : ''; };
  function toast(msg, icon, label, fn) { if (typeof window.toast === 'function') window.toast(msg, icon || 'ℹ️', label, fn); }
  function setErr(id, msg) {
    var e = $(id + '_err'); if (e) e.textContent = msg || '';
    var i = $(id); if (i) i.classList.toggle('acx-bad', !!msg);
  }

  /* ---- the label and hint ------------------------------------------ */
  function relabel() {
    var input = $('acx_email');
    if (!input || input.getAttribute('data-tl-optional')) return;
    input.setAttribute('data-tl-optional', '1');
    input.setAttribute('placeholder', 'Optional - name@example.com');
    var box = input.closest('.acx-f');
    if (!box) return;
    var star = box.querySelector('.acx-req');
    if (star) { star.textContent = '(optional)'; star.style.color = 'inherit'; star.style.fontStyle = 'normal'; star.style.fontWeight = '400'; star.style.opacity = '0.7'; }
    var hint = box.querySelector('.acx-hint');
    if (hint) hint.textContent = 'Their login if they have one. No email? Leave it empty: the login goes to the phone number by SMS / WhatsApp.';
  }
  new MutationObserver(relabel).observe(document.documentElement, { childList: true, subtree: true });
  relabel();

  /* ---- saving without an email --------------------------------------- */
  var saving = false;
  function check() {
    var bad = [];
    var fail = function (id, msg) { setErr(id, msg); bad.push(id); };
    ['acx_name', 'acx_phone', 'acx_gender', 'acx_email'].forEach(function (id) { setErr(id, ''); });
    var name = val('acx_name');
    var cc = val('acx_cc') || '+91';
    var digits = val('acx_phone').replace(/\D/g, '');
    if (!name) fail('acx_name', 'Enter their full name.');
    else if (name.length < 2) fail('acx_name', 'That name looks too short.');
    if (!digits) fail('acx_phone', 'Enter a phone number.');
    else if (digits.length < 7 || digits.length > 15) fail('acx_phone', 'That does not look like a phone number.');
    else if (cc === '+91' && digits.replace(/^0+/, '').length !== 10) fail('acx_phone', 'An Indian mobile number has 10 digits.');
    if (!val('acx_gender')) fail('acx_gender', 'Choose one.');
    return { bad: bad, name: name, cc: cc, digits: digits };
  }

  function saveWithoutEmail() {
    if (saving) return;
    var a = window.TL && window.TL.api;
    if (!a) { toast('The server is not reachable - the candidate was not saved.', '⚠️'); return; }
    var f = check();
    if (f.bad.length) { var first = $(f.bad[0]); if (first) { try { first.focus(); } catch (e) { /* old browsers */ } } return; }
    var parts = f.name.split(/\s+/);
    var phone = f.cc + ' ' + f.digits;
    var btn = $('acxSaveBtn');
    saving = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    var done = function () { saving = false; if (btn) { btn.disabled = false; btn.textContent = 'Save Candidate'; } };

    a.post('/candidates', { firstName: parts[0], lastName: parts.slice(1).join(' '), phone: phone, gender: val('acx_gender'), email: '', sendCredentials: true })
      .then(function (res) {
        done();
        if (typeof window.fcrCloseModal === 'function') window.fcrCloseModal();
        var cand = res.candidate;
        try { if (window.DATA && Array.isArray(window.DATA.candidates)) window.DATA.candidates.push(cand); } catch (e) { /* refetched below */ }
        var c = res.credentials || {};
        var d = c.delivery || {};
        var by = ['sms', 'whatsapp'].filter(function (k) { return d[k] === 'sent'; }).map(function (k) { return k === 'sms' ? 'SMS' : 'WhatsApp'; });
        var resend = function () { if (typeof window.acxResend === 'function') window.acxResend(cand.id); };
        if (by.length) toast('Candidate added. Login details sent to ' + phone + ' by ' + by.join(' and ') + '.', '✅');
        else if (c.queued) toast('Candidate added. Login details are on their way to ' + phone + ' by SMS / WhatsApp.', '✅', 'Resend credentials', resend);
        else toast('Candidate saved, but the login could not be sent to ' + phone + (c.reason ? ' - ' + c.reason : '') + '.', '⚠️', 'Resend credentials', resend);
        if (typeof window.navigate === 'function') window.navigate('/recruiter/candidates/' + cand.id);
      })
      .catch(function (err) {
        done();
        if (err && err.code === 'DUPLICATE_CANDIDATE') {
          setErr('acx_phone', 'A candidate with this phone already exists.');
          toast('A candidate with this phone already exists.', '⚠️');
          return;
        }
        if (err && err.details) {
          var MAP = { firstName: 'acx_name', lastName: 'acx_name', phone: 'acx_phone', gender: 'acx_gender' };
          var shown = 0;
          Object.keys(err.details).forEach(function (k) { if (MAP[k]) { setErr(MAP[k], err.details[k]); shown += 1; } });
          if (shown) return;
        }
        toast((err && err.message) || 'The candidate could not be saved', '⚠️');
      });
  }

  /* The portal defines window.acxSave when its file loads; this runs after it (defer), and waits if it is not there yet. */
  function hook() {
    var original = window.acxSave;
    if (typeof original !== 'function') { setTimeout(hook, 300); return; }
    if (original.__tlOptionalEmail) return;
    var wrapped = function () {
      if ($('acx_email') && !val('acx_email')) return saveWithoutEmail();
      return original.apply(this, arguments);
    };
    wrapped.__tlOptionalEmail = true;
    window.acxSave = wrapped;
  }
  hook();
})();
