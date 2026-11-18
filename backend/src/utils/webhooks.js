// ---------------------------------------------------------------------------
// OUTGOING WEBHOOKS (ATS audit 2026-11-18, Q15 / Q490): tell your own systems when something happens in the ATS.
//
// Set up in Administration > Integrations > Webhooks: the Endpoint URL (https), a Signing secret (encrypted at rest) and the events to send
// ("*" or a comma list). Events:
//   candidate.created            a candidate was added            { candidateId, name, source }
//   application.stage_changed    a candidate moved in a pipeline  { applicationId, candidateId, requirementId, fromStage, toStage }
//   candidate.joined             a candidate joined               { applicationId, candidateId, requirementId, joinedAt }
//   requirement.status_changed   a requirement was opened / put on hold / closed  { requirementId, reqCode, title, fromStatus, toStatus }
//   invoice.created              a placement invoice was raised   { invoiceId, number, clientId, total }
//   ping                         the Test button
// No phone number, e-mail or salary is ever sent (the receiver gets ids and names; it can read more through its own access).
//
// DELIVERY: POST JSON { id, event, at, data } with headers X-TeamLink-Event, X-TeamLink-Delivery and X-TeamLink-Signature
// ("sha256=" + HMAC-SHA256 of the raw body with the signing secret). Only public addresses (utils/safeFetch.js: no private / internal IPs,
// every redirect checked). 10 s per try. A failure (network, timeout, 5xx, 429) is retried after 1, 5, 15 and 60 minutes; a 4xx other than
// 429 is not. Every attempt is written to the channel's History (IntegrationEvent). The ATS never waits for a webhook.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const { readConfig, recordEvent } = require('./integrationStore');
const { fetchPublic } = require('./safeFetch');

const CHANNEL = 'webhooks';
const EVENTS = ['candidate.created', 'application.stage_changed', 'candidate.joined', 'requirement.status_changed', 'invoice.created'];
const RETRY_MIN = [1, 5, 15, 60];
let cache = null; let cachedAt = 0;

async function config() {
  if (cache && Date.now() - cachedAt < 30000) return cache;
  let c = { url: '', secret: '', events: [], enabled: false };
  try {
    const r = await readConfig(CHANNEL);
    const v = r.values || {};
    const url = String(v['Endpoint URL'] || '').trim();
    const list = String(v['Events (comma separated)'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    c = { url, secret: String(v['Signing secret'] || ''), events: list, enabled: !!url && r.enabled !== false && (r.connected || !!url) };
  } catch { /* not set up */ }
  cache = c; cachedAt = Date.now();
  return c;
}
function resetCache() { cache = null; }

const wants = (c, event) => event === 'ping' || c.events.includes('*') || c.events.includes(event) || (!c.events.length && EVENTS.includes(event));

async function deliver(c, body, event, attempt) {
  const raw = JSON.stringify(body);
  const sig = c.secret ? `sha256=${crypto.createHmac('sha256', c.secret).update(raw).digest('hex')}` : '';
  let status = 0; let error = '';
  try {
    const res = await fetchPublic(c.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'TeamLink-Webhooks/1', 'x-teamlink-event': event, 'x-teamlink-delivery': body.id, ...(sig ? { 'x-teamlink-signature': sig } : {}) },
      body: raw,
      signal: AbortSignal.timeout(10000),
    });
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String((err && (err.code === 'SSRF_PRIVATE' || err.code === 'SSRF_SCHEME' || err.code === 'SSRF_BAD_URL' || err.code === 'SSRF_DNS') ? err.message : (err && err.name === 'TimeoutError' ? 'timed out after 10 s' : (err && err.message) || err))).slice(0, 200);
  }
  const ok = status >= 200 && status < 300;
  await recordEvent(CHANNEL, { action: `Webhook ${event}`, by: 'System', result: ok ? `Delivered (HTTP ${status}), try ${attempt + 1}` : `Failed: ${error}, try ${attempt + 1}` }).catch(() => {});
  const retryable = !ok && (status === 0 || status === 429 || status >= 500);
  if (retryable && attempt < RETRY_MIN.length) {
    const t = setTimeout(() => { deliver(c, body, event, attempt + 1).catch(() => {}); }, RETRY_MIN[attempt] * 60000);
    if (t.unref) t.unref();
  }
  return { ok, status, error };
}

// emit(event, data): fire and forget. Never throws, never slows the request that caused it.
function emit(event, data = {}) {
  setImmediate(async () => {
    try {
      const c = await config();
      if (!c.enabled || !wants(c, event)) return;
      const body = { id: crypto.randomUUID(), event, at: new Date().toISOString(), data };
      await deliver(c, body, event, 0);
    } catch { /* a webhook never breaks the ATS */ }
  });
}

// Integrations > Test: one ping, answered now
async function test() {
  resetCache();
  const c = await config();
  if (!c.url) return { ok: false, message: 'Type the Endpoint URL first.' };
  const body = { id: crypto.randomUUID(), event: 'ping', at: new Date().toISOString(), data: { message: 'TeamLink webhook test' } };
  const r = await deliver(c, body, 'ping', RETRY_MIN.length); // no retries for a test
  return r.ok ? { ok: true, message: `Delivered to ${new URL(c.url).host} (HTTP ${r.status}). Events: ${c.events.length ? c.events.join(', ') : 'all'}.` } : { ok: false, message: r.error || `HTTP ${r.status}` };
}

module.exports = { emit, test, resetCache, EVENTS, CHANNEL };
