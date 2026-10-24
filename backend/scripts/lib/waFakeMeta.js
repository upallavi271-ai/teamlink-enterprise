// ---------------------------------------------------------------------------
// A LOCAL FAKE of Meta's WhatsApp Cloud (Graph) API for tests - the same pattern as scripts/wa-multi-number-test.js, plus the media calls and
// the signed-webhook helpers, in one place. Loopback only: nothing here ever reaches a real WhatsApp / Meta server.
//
//   const { startFake, signedWebhook, inboundPayload, statusPayload } = require('./lib/waFakeMeta');
//   const fake = await startFake({ run });                    // fake.port, fake.phones, fake.received, fake.media
//   fake.phones[PHONE_ID] = { token, meta: { display_phone_number, verified_name, ... }, sendMode? }
//   fake.media[MEDIA_ID] = { mime, bytes: Buffer }             // what GET /{media-id} and the download URL give back
// ---------------------------------------------------------------------------
const http = require('http');
const crypto = require('crypto');

function startFake({ run = 'r' } = {}) {
  const phones = {}; const wabas = {}; const media = {}; const received = [];
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks); const body = bodyBuf.toString('utf8');
      const u = new URL(req.url, 'http://x');
      const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      const knownToken = Object.values(phones).some((p) => p.token === auth);
      // media download (the address Meta hands out in GET /{media-id})
      const dl = u.pathname.match(/^\/dl\/([^/]+)$/);
      if (dl) {
        received.push({ kind: 'media_download', media: dl[1], accepted: knownToken });
        if (!knownToken) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
        const m = media[dl[1]];
        if (!m) return send(404, { error: { message: 'no such media', code: 100 } });
        res.writeHead(200, { 'content-type': m.mime, 'content-length': m.bytes.length }); return res.end(m.bytes);
      }
      const m = u.pathname.match(/^\/v\d+\.\d+\/([^/]+)(?:\/(messages|phone_numbers|subscribed_apps|media|message_templates))?$/);
      if (!m) return send(404, { error: { message: 'no such path', code: 100 } });
      const id = m[1]; const sub = m[2];
      let parsed = null; try { parsed = body && /json/.test(req.headers['content-type'] || '') ? JSON.parse(body) : null; } catch { parsed = null; }
      if (sub === 'messages' && req.method === 'POST') {
        const p = phones[id];
        if (!p) { received.push({ phone: id, kind: 'messages', body: parsed, accepted: false }); return send(400, { error: { message: 'Unsupported post request', code: 100 } }); }
        if (auth !== p.token) { received.push({ phone: id, kind: 'messages', body: parsed, accepted: false }); return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } }); }
        if (p.sendMode === 'blocked') { received.push({ phone: id, kind: 'messages', body: parsed, accepted: false }); return send(400, { error: { message: 'API access blocked', code: 200 } }); }
        if (p.sendMode === 'outside24' && parsed && parsed.type !== 'template') { received.push({ phone: id, kind: 'messages', body: parsed, accepted: false }); return send(400, { error: { message: 'Re-engagement message', code: 131047 } }); }
        received.push({ phone: id, kind: 'messages', body: parsed, accepted: true });
        return send(200, { messaging_product: 'whatsapp', contacts: [{ input: parsed.to, wa_id: parsed.to }], messages: [{ id: `wamid.${run}.${received.length}` }] });
      }
      if (sub === 'media' && req.method === 'POST') {
        received.push({ phone: id, kind: 'media_upload', accepted: !!phones[id] && auth === phones[id].token });
        return send(200, { id: `up.${run}.${received.length}` });
      }
      if (sub === 'phone_numbers' && req.method === 'GET') {
        received.push({ phone: id, kind: 'waba_phone_numbers', accepted: true });
        if (!wabas[id]) return send(400, { error: { message: 'Unsupported get request', code: 100 } });
        return send(200, { data: wabas[id].map((x) => ({ id: x, display_phone_number: (phones[x] && phones[x].meta && phones[x].meta.display_phone_number) || '' })) });
      }
      if (sub === 'subscribed_apps') { received.push({ phone: id, kind: `subscribed_apps_${req.method}`, accepted: true }); return send(200, req.method === 'POST' ? { success: true } : { data: [{ whatsapp_business_api_data: { id: 'app1' } }] }); }
      if (!sub && req.method === 'GET') {
        // a phone number's status, or a media id (GET /{media-id} -> its download address)
        const p = phones[id];
        if (p) {
          received.push({ phone: id, kind: 'status', accepted: auth === p.token });
          if (auth !== p.token) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
          return send(200, { id, ...p.meta });
        }
        if (media[id]) {
          received.push({ kind: 'media_lookup', media: id, accepted: knownToken });
          if (!knownToken) return send(401, { error: { message: 'Invalid OAuth access token', code: 190 } });
          return send(200, { url: `http://127.0.0.1:${srv.address().port}/dl/${id}`, mime_type: media[id].mime, sha256: 'x', file_size: media[id].bytes.length, id, messaging_product: 'whatsapp' });
        }
        received.push({ kind: 'media_lookup', media: id, accepted: false });
        return send(400, { error: { message: 'Unsupported get request', code: 100 } });
      }
      return send(404, { error: { message: 'nope', code: 100 } });
    });
  });
  return new Promise((resolve) => { srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port, phones, wabas, media, received })); });
}

const sigOf = (secret, rawBody) => `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
// POST a signed webhook call to the app under test
async function signedWebhook(api, payload, secret, extraHeaders) {
  const rawBody = JSON.stringify(payload);
  const headers = { 'content-type': 'application/json', ...(secret ? { 'x-hub-signature-256': sigOf(secret, rawBody) } : {}), ...(extraHeaders || {}) };
  const res = await fetch(`${api}/api/webhooks/whatsapp`, { method: 'POST', headers, body: rawBody });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, body: json, text };
}
const wrap = (phoneId, display, value) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: display, phone_number_id: phoneId }, ...value } }] }] });
// message: { type:'text', text } | { type:'image'|'document'|'audio', mediaId, mime, filename?, caption?, voice? }
function inboundPayload(phoneId, display, from, message, id, at) {
  const base = { from, id, timestamp: String(Math.floor((at || Date.now()) / 1000)) };
  let m;
  if (message.type === 'text') m = { ...base, type: 'text', text: { body: message.text } };
  else m = { ...base, type: message.type, [message.type]: { id: message.mediaId, mime_type: message.mime, ...(message.filename ? { filename: message.filename } : {}), ...(message.caption ? { caption: message.caption } : {}), ...(message.voice ? { voice: true } : {}) } };
  return wrap(phoneId, display, { contacts: [{ profile: { name: 'ZZ Person' }, wa_id: from }], messages: [m] });
}
function statusPayload(phoneId, display, wamid, status, to, errors) {
  return wrap(phoneId, display, { statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: to || '919000021001', ...(errors ? { errors } : {}) }] });
}

module.exports = { startFake, signedWebhook, sigOf, inboundPayload, statusPayload };
