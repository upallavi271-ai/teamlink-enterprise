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
  var INBOX = '/omni-channel-native/inbox/whatsapp?bare=1';
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

  /* The WhatsApp button opens Green Start's WhatsApp page (the one Omni-Channel uses: "WhatsApp Web", chats assigned to you) in a new tab, signed in with the
     same one-click ticket TeamLink's own Omni-Channel entry uses (POST /api/omni-gs/session, /api/omni-gs/sso-ticket). Green Start is never framed. If the login
     may not open Green Start (or anything fails) the tab is closed and the bare Omni-Channel WhatsApp inbox opens in a window instead. */
  var GS_URL = 'https://greenstart.teamlinks.in';
  function tlToken() { try { return localStorage.getItem('tl_token') || ''; } catch (e) { return ''; } }
  function post(path) {
    return fetch(path, { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tlToken() }, body: '{}' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j && j.error || String(r.status)); return j; }); });
  }
  function openGreenStartWhatsApp(fallback) {
    if (!tlToken()) { fallback(); return; }
    var tab = null;
    try { tab = window.open('about:blank', '_blank'); } catch (e) { tab = null; }
    if (tab) { try { tab.document.title = 'WhatsApp'; tab.document.body.innerHTML = '<p style="font-family:system-ui,sans-serif;padding:24px">Opening WhatsApp...</p>'; } catch (e) { /* blank is fine */ } }
    var bail = function () { if (tab) { try { tab.close(); } catch (e) { /* gone */ } } fallback(); };
    post('/api/omni-gs/session').then(function () { return post('/api/omni-gs/sso-ticket'); }).then(function (t) {
      if (!t || t.blocked || !t.ticket) return bail();
      var dest = GS_URL + '/auth/teamlink#ticket=' + encodeURIComponent(t.ticket) + '&next=' + encodeURIComponent('/app/inbox');
      if (tab && !tab.closed) { try { tab.opener = null; } catch (e) { /* ignore */ } tab.location.href = dest; } else window.location.assign(dest);
      return undefined;
    }).catch(bail);
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
      window.tlWhatsAppInbox = function () { openGreenStartWhatsApp(function () { open('WhatsApp (Omni-Channel inbox)', INBOX, ownInbox); }); };
      window.tlWhatsAppInbox.__tlOmni = true;
    } else if (!window.tlWhatsAppInbox || !window.tlWhatsAppInbox.__tlOmni) done = false;
    if (done || ++tries > 120) clearInterval(iv);
  }, 500);
})();
