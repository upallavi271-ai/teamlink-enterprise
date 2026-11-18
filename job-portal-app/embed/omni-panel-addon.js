/* =====================================================================
   TEAMLINK ADD-ON - the Job Portal's "Templates & Campaigns" is the Omni-Channel one (2026-11-19)
   The header button (web/teamlink-templates-campaigns.js, tcOpen) used to open the portal's own small list. This add-on, added to the
   portal's pages by the TeamLink proxy, makes the button open TeamLink's Omni-Channel "Templates & campaigns" for the Job Portal
   (/embed/app-omni/Job%20Portal - same templates, same campaigns, same format, held to what this login may see) in a window.
   The portal's own list stays one click away ("the portal's own list"). It changes nothing else.
   ===================================================================== */
(function () {
  'use strict';
  if (window.__tlOmniPanel) return;
  window.__tlOmniPanel = true;
  var SRC = '/embed/app-omni/Job%20Portal';
  var INBOX = '/omni-channel-native/inbox/whatsapp';
  var own = null, ownInbox = null;

  function close() { var m = document.getElementById('tlOmniPanel'); if (m) m.remove(); document.removeEventListener('keydown', onKey); }
  function onKey(e) { if (e.key === 'Escape') close(); }
  function open(title, src, ownFn) {
    close();
    title = typeof title === 'string' ? title : 'Templates & Campaigns'; src = src || SRC;
    var m = document.createElement('div');
    m.id = 'tlOmniPanel';
    m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', 'Templates and campaigns');
    m.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:2vh 2vw';
    m.innerHTML = '<div style="background:#fff;border-radius:12px;width:min(1100px,100%);height:min(92vh,100%);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.35)">'
      + '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e5e7eb">'
      + '<b style="flex:1">' + title.replace(/&/g, '&amp;') + '</b>'
      + '<button type="button" id="tlOmniOwn" style="border:0;background:none;color:#4f46e5;cursor:pointer;font:inherit;font-size:12px">the portal’s own list</button>'
      + '<button type="button" id="tlOmniX" aria-label="Close" style="border:1px solid #d1d5db;background:#fff;border-radius:8px;padding:4px 10px;cursor:pointer">✕</button></div>'
      + '<iframe title="Templates and campaigns" src="' + src + '" style="flex:1;border:0;width:100%"></iframe>'
      + '<div style="padding:6px 14px;font-size:11px;color:#6b7280;border-top:1px solid #e5e7eb">Asked to sign in? Open TeamLink in this browser once and sign in, then open this again.</div></div>';
    document.body.appendChild(m);
    document.getElementById('tlOmniX').onclick = close;
    document.getElementById('tlOmniOwn').onclick = function () { close(); if (ownFn) ownFn(); };
    m.addEventListener('mousedown', function (e) { if (e.target === m) close(); });
    document.addEventListener('keydown', onKey);
  }

  var tries = 0;
  var iv = setInterval(function () {
    var done = true;
    if (typeof window.tcOpen === 'function' && !window.tcOpen.__tlOmni) {
      own = window.tcOpen;
      window.tcOpen = function () { open('Templates & Campaigns', SRC, own); };
      window.tcOpen.__tlOmni = true;
    } else if (!window.tcOpen || !window.tcOpen.__tlOmni) done = false;
    /* the WhatsApp button: the chats of the Omni-Channel WhatsApp number(s), where the replies to every campaign arrive */
    if (typeof window.tlWhatsAppInbox === 'function' && !window.tlWhatsAppInbox.__tlOmni) {
      ownInbox = window.tlWhatsAppInbox;
      window.tlWhatsAppInbox = function () { open('WhatsApp (Omni-Channel inbox)', INBOX, ownInbox); };
      window.tlWhatsAppInbox.__tlOmni = true;
    } else if (!window.tlWhatsAppInbox || !window.tlWhatsAppInbox.__tlOmni) done = false;
    if (done || ++tries > 120) clearInterval(iv);
  }, 500);
})();
