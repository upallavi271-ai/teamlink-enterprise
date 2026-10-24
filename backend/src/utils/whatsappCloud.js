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
const VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v25.0';

// THE OLD SINGLE CONNECTION (Administration > Integrations > WhatsApp Business). With no row in the WhatsApp numbers list this is the only
// connection and every function below behaves exactly as it always did. See utils/waNumbers.js for the list of numbers.
async function legacyConfig() {
  const cfg = await readConfig('whatsapp');
  const v = cfg.values || {};
  const out = {
    phoneId: String(v[F.phoneId] || '').trim(),
    wabaId: String(v[F.wabaId] || '').trim(),
    display: String(v[F.display] || '').trim(),
    token: String(v[F.token] || '').trim(),
    appSecret: String(v[F.appSecret] || '').trim(),
    verifyToken: String(v[F.verifyToken] || '').trim(),
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

// whatsappConfig()                  the connection other screens read ("is WhatsApp set up? which templates?"): the DEFAULT number of the list,
//                                   or the old single connection while the list is empty
// whatsappConfig({ numberId })      one number's connection (backend only: it carries the token)
async function whatsappConfig(opts) {
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    if (opts && opts.numberId) {
      const c = await WN.configOf(opts.numberId);
      return c || { configured: false, problems: ['That WhatsApp number was not found.'], reason: 'That WhatsApp number was not found.', templates: {}, phoneId: '', token: '' };
    }
    if (await WN.hasNumbers()) {
      const d = await WN.defaultConfig();
      if (d) return d;
    }
  } catch { /* the list must never break the old path */ }
  return legacyConfig();
}

// TEST SANDBOX: reported as sent, never transmitted (utils/sandbox.js) - except toward a LOCAL fake Meta server when a test says so
// (TL_TEST_FAKE_GRAPH=1 and the loopback base address is set): then the real request is built and sent to that fake, nowhere else.
function simulated(cfg) {
  if (!require('./sandbox').isSandbox()) return false; // eslint-disable-line global-require
  return !(process.env.TL_TEST_FAKE_GRAPH === '1' && cfg && cfg.testMode);
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
  // Meta #200 "API access blocked": Meta itself is refusing this app/token (not a TeamLink fault). Say what to check.
  if (Number(e.code) === 200 && /api access blocked/i.test(String(e.message || ''))) {
    said = 'Meta is blocking this app from sending (API access blocked). On developers.facebook.com open the app and look for a restriction notice, check that the app is Live, and that the System user still has the app and the WhatsApp account. Then make a new permanent token and save it in Administration → Integrations → WhatsApp.';
  }
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

// own = { name, language } of a Message templates entry the admin marked Approved.
function templatePayload(cfg, kind, vars, own) {
  const name = (own && own.name) || cfg.templates[kind];
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
    template: { name, language: { code: (own && own.language) || cfg.language }, components },
  };
}

// A template belongs to a WhatsApp Business Account (WABA): a number of ANOTHER account can only send it once Meta approved it THERE (otherwise Meta answers 132001).
// The per-account answers live in WaTemplateWaba (outreach/tplWaba.js, "Send to every number's WhatsApp account"); a template without them (sent before, or approved by
// hand) behaves as it always did. No network. -> null (go ahead) | { code, state: 'none' | 'pending' | 'rejected' | 'other', reason, templateId }
async function templateAccountCheck(cfg, name) {
  try {
    if (!name || !cfg || !cfg.wabaId) return null;
    return await require('../outreach/tplWaba').guard(cfg, name); // eslint-disable-line global-require
  } catch { return null; } // no template tables: nothing to compare
}
// the same, as the plain sentence (null = fine)
async function templateAccountProblem(cfg, name) {
  const r = await templateAccountCheck(cfg, name);
  return r ? r.reason : null;
}

// What a refused routing looks like to the callers (nothing was sent to Meta).
function blockedResult(route) {
  return {
    ok: false, blocked: true, invalid: route.code !== 'NOT_CONFIGURED', notConfigured: route.code === 'NOT_CONFIGURED', transient: false,
    code: route.code, httpStatus: route.status, numberId: route.numberId || null, error: route.error,
  };
}
// Which number does this message leave from?  -> { legacy } | { ok, number, cfg } | { ok: false, ...blocked }
async function route(opts) {
  try {
    const WN = require('./waNumbers'); // eslint-disable-line global-require
    return await WN.resolveSender({
      user: opts.user, userId: opts.userId, requestedNumberId: opts.numberId, to: opts.to, department: opts.department, automatic: opts.automatic, purpose: opts.purpose,
    });
  } catch (e) {
    console.error('[whatsapp] number routing:', e && e.message); // eslint-disable-line no-console
    return { legacy: true };
  }
}

// kind: 'link' | 'otp' | 'bulk'.
// WHICH NUMBER (utils/waNumbers.js): opts.numberId (the number the sender chose) | opts.user / opts.userId (the person sending) | opts.automatic /
// opts.department / opts.purpose (system messages). With no numbers added yet none of this matters: the old single connection is used.
async function sendWhatsApp(opts = {}) {
  const { to, kind = 'bulk', text, vars, template: own } = opts;
  const r = await route(opts);
  if (!r.legacy && !r.ok) return blockedResult(r);
  const cfg = r.legacy ? await legacyConfig() : r.cfg;
  const number = r.legacy ? null : r.number;
  if (!cfg.configured) return { ok: false, notConfigured: true, transient: false, error: cfg.reason };
  const mobile = core.normalizeMobile(to);
  if (!mobile.ok) return { ok: false, invalid: true, transient: false, error: mobile.reason };
  // Someone who replied STOP is not messaged again (OTP / agreement links are not marketing and still go). STOP is company-wide: every number.
  if (kind === 'bulk' && await require('./messageDelivery').optedOut('WhatsApp', to)) { // eslint-disable-line global-require
    return { ok: false, invalid: true, transient: false, error: 'They replied STOP on WhatsApp, so nothing more is sent to them there.' };
  }
  // ONE PERSON, SEVERAL LOGINS ON ONE MOBILE (utils/shareDedupe.js): the same message to such a number goes once.
  const SD = require('./shareDedupe'); // eslint-disable-line global-require
  let dupKey = null;
  try {
    const d = await SD.checkWhatsApp({ e164: mobile.e164, text, vars, kind: number ? `${kind}@${number.id}` : kind });
    if (d.skip) return { ok: true, provider: 'DEDUPED', providerRef: null, deduped: true };
    dupKey = d.key;
  } catch { /* never blocks a message */ }
  const content = templatePayload(cfg, kind, vars, own)
    || { type: 'text', text: { body: String(text || (vars || []).join(' ')).slice(0, 4096), preview_url: true } };
  if (number && content.type === 'template') {
    const bad = await templateAccountCheck(cfg, content.template.name);
    if (bad) { SD.release(dupKey); return { ok: false, blocked: true, invalid: true, transient: false, code: 'TEMPLATE_OTHER_ACCOUNT', httpStatus: 409, numberId: number.id, templateId: bad.templateId, accountState: bad.state, error: bad.reason }; }
  }
  const TYPE_OF = { candidates: 'CANDIDATE', clients: 'CLIENT', employees: 'EMPLOYEE' };
  const person = (opts.meta && opts.meta.personId && TYPE_OF[opts.meta.audience]) ? { type: TYPE_OF[opts.meta.audience], id: opts.meta.personId, name: opts.meta.personName || null } : null;
  const through = number ? { numberId: number.id, numberLabel: number.label, fromNumber: number.displayNumber } : {};
  // TEST SANDBOX: reported as sent, never transmitted (utils/sandbox.js).
  if (simulated(cfg)) {
    const ref = `sandbox-wa-${Date.now().toString(36)}${number ? Math.random().toString(36).slice(2, 7) : ''}`;
    if (number) await require('./waNumbers').noteMessage({ numberId: number.id, to: mobile.e164, providerRef: ref, dir: 'OUT', person }); // eslint-disable-line global-require
    return { ok: true, provider: 'SANDBOX', providerRef: ref, mode: content.type, sandbox: true, ...through };
  }
  await core.acquire('WhatsApp');
  const res = await core.httpJson(`${cfg.base}/${VERSION}/${encodeURIComponent(cfg.phoneId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', recipient_type: 'individual', to: mobile.e164, ...content }),
  });
  if (res.ok && res.json && Array.isArray(res.json.messages) && res.json.messages[0]) {
    const ref = res.json.messages[0].id || null;
    if (number) await require('./waNumbers').noteMessage({ numberId: number.id, to: mobile.e164, providerRef: ref, dir: 'OUT', person }); // eslint-disable-line global-require
    if (number) await require('./waNumbers').noteSendOk(number.id); // eslint-disable-line global-require
    return { ok: true, provider: 'WHATSAPP', providerRef: ref, mode: content.type, ...through };
  }
  SD.release(dupKey);
  const f = failure(res);
  if (number) await require('./waNumbers').noteSendFailure(number.id, f).catch(() => {}); // eslint-disable-line global-require
  return { ...f, ...through };
}

async function testConnection(opts) {
  const cfg = await whatsappConfig(opts);
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

module.exports = { whatsappConfig, legacyConfig, sendWhatsApp, testConnection, failure, simulated, route, blockedResult, templateAccountProblem, templateAccountCheck, GRAPH, VERSION };
