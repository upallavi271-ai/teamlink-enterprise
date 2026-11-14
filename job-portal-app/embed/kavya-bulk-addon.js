/* =====================================================================
   TEAMLINK ADD-ON - the Talent Pool's bulk "Start AI Calls" says what really happened
   The calls are placed by Kavya through TeamLink (embed/kavya-campaign.mjs). The page's own toast names three fixed reasons for
   "skipped"; this add-on (added to the portal's pages by the TeamLink proxy) replaces that sentence with the real reasons the
   server returned. It changes nothing else and leaves web/index.html as it is.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tlKavyaBulk) return;
  window.__tlKavyaBulk = true;
  var last = null;

  function wrapApi() {
    var TL = window.TL;
    if (!TL || !TL.api || TL.api.__tlKavya) return !!(TL && TL.api && TL.api.__tlKavya);
    var orig = TL.api.post;
    TL.api.post = function (path) {
      var p = orig.apply(this, arguments);
      if (String(path) === '/ai-calling/campaign' && p && p.then) p.then(function (r) { last = { at: Date.now(), r: r }; }, function () {});
      return p;
    };
    TL.api.__tlKavya = true;
    return true;
  }
  function wrapToast() {
    if (typeof window.toast !== 'function' || window.toast.__tlKavya) return typeof window.toast === 'function';
    var orig = window.toast;
    var t = function (msg) {
      var a = Array.prototype.slice.call(arguments);
      if (last && Date.now() - last.at < 8000 && /^\d+ AI calls? queued/.test(String(msg))) {
        var r = last.r || {}, q = (r.queued || []).length, sk = r.skipped || [], n = {};
        sk.forEach(function (x) { n[x.reason] = (n[x.reason] || 0) + 1; });
        var why = Object.keys(n).slice(0, 3).map(function (k) { return n[k] + ' ' + k; }).join('; ');
        a[0] = q + ' sent to Kavya (AI caller)' + (sk.length ? ', ' + sk.length + ' skipped: ' + why : '') + '. Results appear in TeamLink > AI Calling > Kavya.';
        last = null;
      }
      return orig.apply(this, a);
    };
    t.__tlKavya = true;
    window.toast = t;
    return true;
  }
  var tries = 0;
  var iv = setInterval(function () {
    var a = wrapApi(), b = wrapToast();
    if ((a && b) || ++tries > 120) clearInterval(iv);
  }, 500);
})();
