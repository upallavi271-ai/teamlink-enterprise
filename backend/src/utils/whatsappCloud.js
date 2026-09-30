// ---------------------------------------------------------------------------
// WHATSAPP — Meta WhatsApp Cloud API (Graph API).
//
//   POST https://graph.facebook.com/{ver}/{PHONE_NUMBER_ID}/messages
//   Authorization: Bearer <permanent access token>
//
//   template:  { messaging_product: 'whatsapp', to, type: 'template',
//                template: { name, language: { code },
//                            components: [{ type: 'body', parameters: [...] }] } }
//   text:      { messaging_product: 'whatsapp', to, type: 'text',
//                text: { body, preview_url: true } }
//
// SESSION RULES. A business may only start a conversation with an APPROVED
// TEMPLATE. Free text is accepted only inside the 24-hour window after the
// person last wrote to the business — outside it Meta answers error 131047.
// So every kind of message here has its own template name in Administration →
// Integrations → WhatsApp Business; with no template configured the adapter
// falls back to plain text and, if Meta refuses, reports exactly that.
//
// Template parameters, in order (the placeholders in the Integrations form):
//   link   {{1}} recipient name, {{2}} agreement number, {{3}} the link
//   otp    an AUTHENTICATION template: body {{1}} = code, plus the copy-code
//          URL button parameter = code (Meta's required shape)
//   bulk   {{1}} = the whole message
//
// The access token is decrypted by utils/integrationStore.js, used in the
// Authorization header and never logged or returned.
// ---------------------------------------------------------------------------

const { readConfig } = require('./integrationStore');
const { WA_FIELDS: F } = require('./adminCatalog');
const core = require('./messagingCore');

const GRAPH = 'https://graph.facebook.com';
const VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';

async function whatsappConfig() {
  const cfg = await readConfig('whatsapp');
  const v = cfg.values || {};
  const out = {
    phoneId: String(v[F.phoneId] || '').trim(),
    wabaId: String(v[F.wabaId] || '').trim(),
    display: String(v[F.display] || '').trim(),
    token: String(v[F.token] || '').trim(),
    language: String(v[F.language] || '').trim() || 'en',
    templates: {
      link: String(v[F.linkTpl] || '').trim(),
      otp: String(v[F.otpTpl] || '').trim(),
      bulk: String(v[F.bulkTpl] || '').trim(),
    },
    base: core.providerBase(GRAPH, v),
    testMode: !!core.devOverride(v),
  };
  const problems = [];
  if (!cfg.row) problems.push('WhatsApp Business has not been configured — Administration → Integrations → WhatsApp Business.');
  else {
    if (!out.phoneId) problems.push('No Phone number ID (Meta → WhatsApp → API Setup).');
    if (cfg.missingKey) problems.push('An access token is stored but this server cannot decrypt it (INTEGRATION_SECRET_KEY missing or changed).');
    else if (!out.token) problems.push('No permanent access token.');
    if (!cfg.row.enabled) problems.push('The channel is switched off.');
    else if (!cfg.connected) problems.push('The channel is disconnected — reconnect it in Administration → Integrations.');
  }
  return { ...out, configured: problems.length === 0, problems, reason: problems.join(' ') };
}

// Template text parameters may not contain newlines, tabs or more than four
// consecutive spaces (Meta error 132018), and are capped in length.
function param(value) {
  return String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim().slice(0, 1000) || '-';
}

function failure(res) {
  const e = (res.json && res.json.error) || {};
  const code = e.code || (e.error_data && e.error_data.details) || '';
  let said = res.networkError || e.message || res.text || `HTTP ${res.status}`;
  if (Number(e.code) === 131047) said = 'Outside the 24-hour customer window — Meta only accepts an approved template here. Set the template name in Integrations.';
  if (Number(e.code) === 190) said = `Access token rejected (${e.message || 'expired or invalid'}).`;
  // Meta's throttling codes are transient even when the HTTP status is 400.
  const throttled = [4, 80007, 130429, 131048, 131056].includes(Number(e.code));
  return {
    ok: false,
    provider: 'WHATSAPP',
    status: res.status,
    code: e.code || null,
    transient: throttled || core.isTransientHttp(res.status),
    error: core.tidy(`WhatsApp${res.status ? ` HTTP ${res.status}` : ''}${code ? ` (${code})` : ''}: ${said}`),
  };
}

function templatePayload(cfg, kind, vars) {
  const name = cfg.templates[kind];
  if (!name) return null;
  const components = [{ type: 'body', parameters: (vars || []).map((x) => ({ type: 'text', text: param(x) })) }];
  if (kind === 'otp') {
    // Authentication templates: body carries the code, and the copy-code
    // button takes it again as its URL parameter.
    components[0].parameters = [{ type: 'text', text: param((vars || [])[0]) }];
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: param((vars || [])[0]) }] });
  }
  return {
    type: 'template',
    template: { name, language: { code: cfg.language }, components },
  };
}

// kind: 'link' | 'otp' | 'bulk'.
async function sendWhatsApp({ to, kind = 'bulk', text, vars }) {
  const cfg = await whatsappConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, transient: false, error: cfg.reason };
  const mobile = core.normalizeMobile(to);
  if (!mobile.ok) return { ok: false, invalid: true, transient: false, error: mobile.reason };
  const content = templatePayload(cfg, kind, vars)
    || { type: 'text', text: { body: String(text || (vars || []).join(' ')).slice(0, 4096), preview_url: true } };
  await core.acquire('WhatsApp');
  const res = await core.httpJson(`${cfg.base}/${VERSION}/${encodeURIComponent(cfg.phoneId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: mobile.e164, ...content }),
  });
  if (res.ok && res.json && Array.isArray(res.json.messages) && res.json.messages[0]) {
    return { ok: true, provider: 'WHATSAPP', providerRef: res.json.messages[0].id || null, mode: content.type };
  }
  return failure(res);
}

async function testConnection() {
  const cfg = await whatsappConfig();
  if (!cfg.configured) return { ok: false, notConfigured: true, result: `Not configured — ${cfg.reason}` };
  const res = await core.httpJson(`${cfg.base}/${VERSION}/${encodeURIComponent(cfg.phoneId)}?fields=display_phone_number,verified_name,quality_rating`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (res.ok && res.json && (res.json.display_phone_number || res.json.id)) {
    const j = res.json;
    return { ok: true, result: `Connected — ${j.verified_name || 'WhatsApp Business'} ${j.display_phone_number || ''}${j.quality_rating ? ` · quality ${j.quality_rating}` : ''}${cfg.testMode ? ' (test server)' : ''}`.replace(/\s+/g, ' ').trim() };
  }
  return { ok: false, result: `Failed — ${failure(res).error}` };
}

module.exports = { whatsappConfig, sendWhatsApp, testConnection, GRAPH, VERSION };
