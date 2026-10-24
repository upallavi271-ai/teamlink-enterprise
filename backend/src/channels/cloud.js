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
  if (!open) { // the 24 hours belong to ONE number: the one the person wrote to
    return { ok: false, transient: false, error: 'A file can be sent on the official WhatsApp only in the 24 hours after the person wrote to you. Send the approved template first, or use the QR-linked number.' };
  }
  const file = m.media[0];
  if (wa.simulated(cfg)) return { ok: true, provider: 'SANDBOX', providerRef: `sandbox-wa-${Date.now().toString(36)}`, sandbox: true, mode: 'document', ...through };
  let buf;
  try { buf = fs.readFileSync(file.path); } catch { return { ok: false, transient: false, error: 'The file could not be read.' }; }
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', file.mime || 'application/pdf');
  form.append('file', new Blob([buf], { type: file.mime || 'application/pdf' }), file.name || 'file');
  await core.acquire('WhatsApp');
  const up = await core.httpJson(`${cfg.base}/${wa.VERSION}/${encodeURIComponent(cfg.phoneId)}/media`, { method: 'POST', headers: { authorization: `Bearer ${cfg.token}` }, body: form, timeoutMs: 30000 });
  if (!up.ok || !up.json || !up.json.id) return { ok: false, provider: 'WHATSAPP', transient: core.isTransientHttp(up.status), error: core.tidy(`WhatsApp file upload failed: ${(up.json && up.json.error && up.json.error.message) || up.networkError || up.status}`) };
  const res = await core.httpJson(`${cfg.base}/${wa.VERSION}/${encodeURIComponent(cfg.phoneId)}/messages`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: mobile.e164, type: 'document', document: { id: up.json.id, filename: file.name || 'file', caption: String(m.text || '').slice(0, 1000) || undefined } }),
  });
  if (res.ok && res.json && Array.isArray(res.json.messages) && res.json.messages[0]) {
    if (number) await require('../utils/waNumbers').noteMessage({ numberId: number.id, to: mobile.e164, providerRef: res.json.messages[0].id || null, dir: 'OUT' }); // eslint-disable-line global-require
    if (number) await require('../utils/waNumbers').noteSendOk(number.id); // eslint-disable-line global-require
    return { ok: true, provider: 'WHATSAPP', providerRef: res.json.messages[0].id || null, mode: 'document', ...through };
  }
  const e = (res.json && res.json.error) || {};
  return { ok: false, provider: 'WHATSAPP', transient: core.isTransientHttp(res.status), error: core.tidy(`WhatsApp HTTP ${res.status}: ${e.message || res.networkError || res.text}`) };
}

module.exports = { sendWithMedia };
