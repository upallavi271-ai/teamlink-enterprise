// Meta's WhatsApp webhook signature check with SEVERAL Meta apps (founder 2026-11-14: replies on the BDE / Nonit number were refused as
// "Bad signature" because that number's own / shared app secret is for another Meta app than the one signing its calls).
//   node backend/scripts/wa-webhook-signature-test.js            (NODE_PATH may point at a backend/node_modules)
// The route is mounted on a tiny express app with the number list, the secrets and the delivery code replaced by fakes: no database, no network,
// no real secret. Signed fake Meta calls go in; the HTTP answer and what was routed where come out.
const Module = require('module');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

const S_SHARED = 'fake-shared-app-secret-1'; // the shared secret (Integrations > WhatsApp Business): Education, Nonit, BDE ... use it
const S_MEDICAL = 'fake-medical-own-app-secret-2'; // the Medical number's own secret (another Meta app)
const S_CAREERS = 'fake-careers-own-app-secret-3';
const S_STRANGER = 'fake-stranger-secret-9'; // a secret TeamLink does not hold

const BDE = '938098196056628'; const MEDICAL = '973315555868397'; const NOBODY = '555000111222333';
const ROWS = { [BDE]: { id: 'row_bde' }, [MEDICAL]: { id: 'row_med' } };
const OWN = { row_bde: S_SHARED, row_med: S_MEDICAL }; // what appSecretOf() answers: a number's own, else the shared one

const rec = { status: [], inbound: [], seen: 0, forwarded: 0, unknown: 0 };
const fakes = {
  '/utils/waNumbers': {
    hasNumbers: async () => true, rowByPhoneId: async (id) => ROWS[id] || null, appSecretOf: async (row) => OWN[row.id],
    allAppSecrets: async () => [S_SHARED, S_MEDICAL, S_CAREERS], tagOf: () => 'tag', verifyTokens: async () => [],
    noteUnknown: async () => { rec.unknown += 1; },
  },
  '/utils/whatsappCloud': { legacyConfig: async () => ({ appSecret: S_SHARED, verifyToken: 'v' }), whatsappConfig: async () => ({ appSecret: S_SHARED }) },
  '/utils/greenStartWaForward': { forwardSoon: () => { rec.forwarded += 1; } },
  '/utils/messageDelivery': {
    markSeen: async () => { rec.seen += 1; },
    applyStatus: async (a) => { rec.status.push(a); return { matched: true }; },
    applyInbound: async (a) => { rec.inbound.push(a); },
  },
};
const realLoad = Module._load;
Module._load = function load(request, ...rest) {
  const r = String(request).replace(/\\/g, '/');
  const hit = Object.keys(fakes).find((k) => r.endsWith(k));
  return hit ? fakes[hit] : realLoad.call(this, request, ...rest);
};

const FILE = process.env.WEBHOOK_FILE || path.join(__dirname, '..', 'src', 'routes', 'webhooks.js');
let pass = 0; let fail = 0;
const check = (name, ok, extra) => { if (ok) pass += 1; else fail += 1; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || extra === undefined ? '' : `  -> ${JSON.stringify(extra)}`}`); };

const payload = (phoneId, tag) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'waba', changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneId, display_phone_number: '910000000000' },
    contacts: [{ wa_id: '919999999999', profile: { name: 'Test' } }],
    statuses: [{ id: `wamid.${tag}.S`, status: 'delivered', timestamp: '1700000000', recipient_id: '919999999999' }],
    messages: [{ from: '919999999999', id: `wamid.${tag}.M`, timestamp: '1700000001', type: 'text', text: { body: 'hello' } }],
  } }] }],
});

(async () => {
  const app = express();
  app.use('/api/webhooks', require(FILE));
  const server = await new Promise((ok) => { const s = app.listen(0, '127.0.0.1', () => ok(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/webhooks/whatsapp`;
  const post = async (phoneId, secret, tag) => {
    const raw = JSON.stringify(payload(phoneId, tag));
    rec.status.length = 0; rec.inbound.length = 0; rec.seen = 0; rec.forwarded = 0; rec.unknown = 0;
    const headers = { 'content-type': 'application/json', ...(secret ? { 'x-hub-signature-256': `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` } : {}) };
    const res = await fetch(base, { method: 'POST', headers, body: raw });
    return { code: res.status, status: rec.status.map((s) => s.numberId), inbound: rec.inbound.map((s) => s.numberId), forwarded: rec.forwarded, unknown: rec.unknown };
  };
  const quiet = console.log; const warn = console.warn;
  console.warn = () => {}; // the "[wa-sig] refused" lines of the refusals below
  const out = {};
  out.bdeOwn = await post(BDE, S_SHARED, 'a1');
  out.bdeOther = await post(BDE, S_MEDICAL, 'a2');
  out.bdeThird = await post(BDE, S_CAREERS, 'a3');
  out.bdeStranger = await post(BDE, S_STRANGER, 'a4');
  out.bdeNone = await post(BDE, null, 'a5');
  out.medOwn = await post(MEDICAL, S_MEDICAL, 'a6');
  out.medStranger = await post(MEDICAL, S_STRANGER, 'a7');
  out.nobodyKnown = await post(NOBODY, S_CAREERS, 'a8');
  out.nobodyStranger = await post(NOBODY, S_STRANGER, 'a9');
  console.warn = warn; console.log = quiet;

  check('BDE call signed with the shared secret (as before): accepted, routed to BDE only', out.bdeOwn.code === 200 && out.bdeOwn.status.join() === 'row_bde' && out.bdeOwn.inbound.join() === 'row_bde', out.bdeOwn);
  check('BDE call signed with ANOTHER saved app secret (the Medical one): accepted, routed to BDE only', out.bdeOther.code === 200 && out.bdeOther.status.join() === 'row_bde' && out.bdeOther.inbound.join() === 'row_bde', out.bdeOther);
  check('BDE call signed with a third saved app secret (Careers): accepted, routed to BDE only', out.bdeThird.code === 200 && out.bdeThird.status.join() === 'row_bde', out.bdeThird);
  check('an accepted call is handed on to Omni-Channel', out.bdeOther.forwarded === 1, out.bdeOther);
  check('BDE call signed with a secret TeamLink does not hold: refused 403, nothing routed, nothing forwarded', out.bdeStranger.code === 403 && !out.bdeStranger.status.length && !out.bdeStranger.inbound.length && out.bdeStranger.forwarded === 0, out.bdeStranger);
  check('BDE call with no signature: refused 403', out.bdeNone.code === 403 && !out.bdeNone.status.length, out.bdeNone);
  check('Medical call signed with the Medical secret (as before): accepted, routed to Medical only', out.medOwn.code === 200 && out.medOwn.status.join() === 'row_med', out.medOwn);
  check('Medical call signed with a stranger secret: refused 403', out.medStranger.code === 403 && !out.medStranger.status.length, out.medStranger);
  check('a number nobody added, signed by a saved secret: accepted but kept as an unknown number, never routed', out.nobodyKnown.code === 200 && !out.nobodyKnown.status.length && out.nobodyKnown.unknown === 2, out.nobodyKnown);
  check('a number nobody added, signed by a stranger secret: refused 403', out.nobodyStranger.code === 403 && out.nobodyStranger.unknown === 0, out.nobodyStranger);

  server.close();
  console.log(`\n${pass} passed, ${fail} failed  (${path.relative(process.cwd(), FILE)})`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('TEST ERROR', e && e.stack); process.exit(2); });
