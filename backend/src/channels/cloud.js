// ---------------------------------------------------------------------------
// whatsapp.cloud, attachments: the Meta Cloud API takes a document in two steps.
//   1. POST /{phone-number-id}/media           multipart: file + messaging_product=whatsapp + type   -> { id }
//   2. POST /{phone-number-id}/messages        { type: 'document', document: { id, filename, caption } }
// A document (like free text) is allowed only inside the 24-hour window after the person wrote to us; outside it Meta answers
// 131047 and the layer falls back to the next provider or reports it in plain words.
// ---------------------------------------------------------------------------
const fs = require('fs');
const wa = require('../utils/whatsappCloud');
const core = require('../utils/messagingCore');

// how WhatsApp shows a file: a JPEG / PNG as a picture, an MP4 / 3GP as a video, anything else as a document
const modeOf = (mime) => { const x = String(mime || 'application/pdf').toLowerCase(); return /^image\/(jpeg|png)$/.test(x) ? 'image' : (/^video\/(mp4|3gpp)$/.test(x) ? 'video' : 'document'); };

// ---- picture / video WITH reply buttons (AI Marketing: the client approves or rejects, 2026-11-21) -------------------------------------------------------------
// m.buttons = [{ id, title }] (max 3, title up to 20 characters). Inside the 24 hours it is ONE interactive message: the video / picture on top, the words, the buttons under it.
// Outside the 24 hours Meta takes only an approved TEMPLATE: m.mediaTemplate = { name, language } is a template with a picture / video header, the words as {{1}} and quick-reply buttons
// (the button ids travel as payloads). With neither, nothing is sent and the answer says why (the caller then holds the file until the person writes).
const btnTitle = (t) => String(t || '').split(/\s+/).join(' ').trim().slice(0, 20);
function interactiveBody(m, mediaId, mode, e164) {
  const buttons = (m.buttons || []).slice(0, 3).map((b) => ({ type: 'reply', reply: { id: String(b.id).slice(0, 256), title: btnTitle(b.title) } }));
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: e164, type: 'interactive', interactive: { type: 'button', header: { type: mode, [mode]: { id: mediaId } }, body: { text: String(m.text || ' ').slice(0, 1024) }, action: { buttons } } };
}
function templateBody(m, mediaId, mode, e164) {
  const t = m.mediaTemplate;
  const fname = m.media && m.media[0] && m.media[0].name;
  const components = [{ type: 'header', parameters: [{ type: mode, [mode]: { id: mediaId, ...(mode === 'document' && fname ? { filename: fname } : {}) } }] }];
  const vars = Array.isArray(m.vars) ? m.vars : [m.text || ''];
  const flat = (x) => String(x == null ? '' : x).replace(/[\r\n\t]+/g, ' ').trim().slice(0, 1000) || '-';
  if (vars.length) components.push({ type: 'body', parameters: vars.map((x) => ({ type: 'text', text: flat(x) })) });
  (m.buttons || []).slice(0, 3).forEach((b, i) => components.push({ type: 'button', sub_type: 'quick_reply', index: String(i), parameters: [{ type: 'payload', payload: String(b.id).slice(0, 256) }] }));
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to: e164, type: 'template', template: { name: t.name, language: { code: t.language || 'en' }, components } };
}

async function sendWithMedia(m) {
  // WHICH NUMBER (utils/waNumbers.js); with no numbers added yet this is the old single connection
  const r = await wa.route({ ...m, numberId: m.numberId, to: m.to });
  if (!r.legacy && !r.ok) return wa.blockedResult(r);
  const cfg = r.legacy ? await wa.legacyConfig() : r.cfg;
  const number = r.legacy ? null : r.number;
  const through = number ? { numberId: number.id, numberLabel: number.label, fromNumber: number.displayNumber } : {};
  if (!cfg.configured) return { ok: false, notConfigured: true, transient: false, error: cfg.reason };
  const mobile = core.normalizeMobile(m.to);
  if (!mobile.ok) return { ok: false, invalid: true, transient: false, error: mobile.reason };
  if (await require('../utils/messageDelivery').optedOut('WhatsApp', m.to)) { // eslint-disable-line global-require
    return { ok: false, invalid: true, transient: false, error: 'They replied STOP on WhatsApp, so nothing more is sent to them there.' };
  }
  const open = number ? await require('../utils/waNumbers').windowOpenFor(number, m.to) : await require('../utils/messageDelivery').windowOpen(m.to); // eslint-disable-line global-require
  const withButtons = Array.isArray(m.buttons) && m.buttons.length > 0;
  // a CAMPAIGN (m.forceTemplate) always goes through its approved template (Meta's rule for business-started messages); the approval flow uses the template only outside the 24 hours
  const viaTemplate = !!(m.mediaTemplate && m.mediaTemplate.name) && (!!m.forceTemplate || (withButtons && !open));
  if (!open && withButtons && !viaTemplate) return { ok: false, code: 'WINDOW_CLOSED', transient: false, error: 'WhatsApp allows a video or picture with buttons only in the 24 hours after the person wrote to you, or through an approved template with a video header (AI usage > WhatsApp templates > the approval template).' };
  if (!open && !viaTemplate) { // the 24 hours belong to ONE number: the one the person wrote to
    return { ok: false, transient: false, error: 'A file can be sent on the official WhatsApp only in the 24 hours after the person wrote to you. Send the approved template first, or use the QR-linked number.' };
  }
  const file = m.media[0];
  // a JPEG / PNG goes as a PICTURE and an MP4 / 3GP as a VIDEO (the person sees it in the chat); anything else as a document
  const mode = modeOf(file.mime);
  if (wa.simulated(cfg)) { // nothing leaves the machine; what WOULD have gone is returned so a test can read it
    const sample = viaTemplate ? templateBody(m, 'SANDBOX_MEDIA', mode, mobile.e164) : (withButtons ? interactiveBody(m, 'SANDBOX_MEDIA', mode, mobile.e164) : { messaging_product: 'whatsapp', to: mobile.e164, type: mode, [mode]: { id: 'SANDBOX_MEDIA', ...(mode === 'document' ? { filename: file.name || 'file' } : {}), ...(String(m.text || '').trim() ? { caption: String(m.text).slice(0, 1000) } : {}) } });
    return { ok: true, provider: 'SANDBOX', providerRef: `sandbox-wa-${Date.now().toString(36)}`, sandbox: true, mode, buttons: withButtons, viaTemplate, payload: sample, fileName: file.name, ...through };
  }
  // WhatsApp keeps an uploaded file's media id for 30 days: it is uploaded ONCE per number and the id reused for the next people (m.mediaCache = { get(phoneId), set(phoneId, id), clear(phoneId) })
  const cache = m.mediaCache && cfg.phoneId ? m.mediaCache : null;
  const upload = async () => {
    let buf;
    try { buf = fs.readFileSync(file.path); } catch { return { fail: { ok: false, transient: false, error: 'The file could not be read.' } }; }
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mime || 'application/pdf');
    form.append('file', new Blob([buf], { type: file.mime || 'application/pdf' }), file.name || 'file');
    await core.acquire('WhatsApp');
    const up = await core.httpJson(`${cfg.base}/${wa.VERSION}/${encodeURIComponent(cfg.phoneId)}/media`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}` }, body: form, timeoutMs: 60000 });
    if (!up.ok || !up.json || !up.json.id) return { fail: { ok: false, provider: 'WHATSAPP', transient: core.isTransientHttp(up.status), error: core.tidy(`WhatsApp file upload failed: ${(up.json && up.json.error && up.json.error.message) || up.networkError || up.status}`) } };
    if (cache) await Promise.resolve(cache.set(cfg.phoneId, up.json.id)).catch(() => {});
    return { id: up.json.id };
  };
  const post = (mediaId) => core.httpJson(`${cfg.base}/${wa.VERSION}/${encodeURIComponent(cfg.phoneId)}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify(viaTemplate ? templateBody(m, mediaId, mode, mobile.e164) : (withButtons ? interactiveBody(m, mediaId, mode, mobile.e164) : { messaging_product: 'whatsapp', recipient_type: 'individual', to: mobile.e164, type: mode, ...(mode === 'document' ? { document: { id: mediaId, filename: file.name || 'file', caption: String(m.text || '').slice(0, 1000) || undefined } } : { [mode]: { id: mediaId, caption: String(m.text || '').slice(0, 1000) || undefined } }) })),
  });
  let mediaId = cache ? await Promise.resolve(cache.get(cfg.phoneId)).catch(() => null) : null;
  let reused = !!mediaId;
  if (!mediaId) { const u = await upload(); if (u.fail) return u.fail; mediaId = u.id; }
  let res = await post(mediaId);
  // a reused id that WhatsApp no longer knows (expired / another account): forget it and send once more with a fresh upload
  if (reused && !(res.ok && res.json && Array.isArray(res.json.messages) && res.json.messages[0]) && res.json && res.json.error && /media|param|invalid/i.test(String(res.json.error.message || ''))) {
    if (cache && cache.clear) await Promise.resolve(cache.clear(cfg.phoneId)).catch(() => {});
    const u = await upload(); if (u.fail) return u.fail; mediaId = u.id; reused = false; res = await post(mediaId);
  }
  if (res.ok && res.json && Array.isArray(res.json.messages) && res.json.messages[0]) {
    if (number) await require('../utils/waNumbers').noteMessage({ numberId: number.id, to: mobile.e164, providerRef: res.json.messages[0].id || null, dir: 'OUT' }); // eslint-disable-line global-require
    if (number) await require('../utils/waNumbers').noteSendOk(number.id); // eslint-disable-line global-require
    return { ok: true, provider: 'WHATSAPP', providerRef: res.json.messages[0].id || null, mode, buttons: withButtons, viaTemplate, mediaReused: reused, ...through };
  }
  const e = (res.json && res.json.error) || {};
  return { ok: false, provider: 'WHATSAPP', transient: core.isTransientHttp(res.status), code: e.code || undefined, error: core.tidy(`WhatsApp HTTP ${res.status}: ${e.message || res.networkError || res.text}`) };

}

module.exports = { sendWithMedia, modeOf };
