#!/usr/bin/env node
// ---------------------------------------------------------------------------
// WHATSAPP QR-LINK WORKER (prototype, unofficial). A SEPARATE process.
//
//   npm run whatsapp-qr-worker          or the Admin "Start" button (Integrations > WhatsApp & SMS)
//
// NEVER started by src/index.js. Refuses to run when:
//   * the Integrations switch for "WhatsApp QR-link" is off, or the Admin has not ticked "I understand", or the kill switch is on
//   * DATABASE_URL is the real dev.db and TL_ALLOW_REAL_WHATSAPP_QR=1 is not set
//   * it is the test sandbox and no fake library was injected (TL_QR_BAILEYS_MODULE) - the sandbox never reaches WhatsApp
//   * INTEGRATION_SECRET_KEY is missing (the session would have to be stored unencrypted)
// Nothing is sent unless a message is in the queue (put there by a person's action) AND the number is linked.
// ---------------------------------------------------------------------------
const path = require('path');

const BACK = path.resolve(__dirname, '..', '..');
try { require(path.join(BACK, 'node_modules/dotenv')).config({ path: path.join(BACK, '.env'), override: false }); } catch { /* optional */ }

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
function refuse(why) { console.error(`[whatsapp-qr-worker] REFUSING TO START: ${why}`); process.exit(2); }

const url = String(process.env.DATABASE_URL || '');
const file = path.basename(url.replace(/^file:/, '').replace(/[?#].*$/, '').replace(/["']/g, ''));
const sandbox = truthy(process.env.TEST_MODE) || truthy(process.env.TEAMLINK_SANDBOX);
if (sandbox && !process.env.TL_QR_BAILEYS_MODULE) refuse('this is the test sandbox; the real WhatsApp network is never contacted from here.');
if (!sandbox && (!url || /^dev\.db$/i.test(file)) && !truthy(process.env.TL_ALLOW_REAL_WHATSAPP_QR)) {
  refuse('DATABASE_URL is the real database. Set TL_ALLOW_REAL_WHATSAPP_QR=1 to link a real WhatsApp number from this machine.');
}

(async () => {
  const wq = require('../channels/whatsappQr');
  const settings = require('../channels/settings');
  const { readConfig } = require('../utils/integrationStore');
  const engineMod = require('../channels/qrEngine');
  try {
    const [cfg, s] = await Promise.all([readConfig('whatsapp-qr'), settings.load({ fresh: true })]);
    if (!cfg.row || !cfg.row.enabled) refuse('the "WhatsApp QR-link (prototype)" switch is off in Integrations.');
    if (!s.qr.ack) refuse('an Admin has not ticked "I understand" for the QR-link prototype.');
    if (s.qr.killSwitch) refuse('the company kill switch for the QR-link prototype is ON.');
    const engine = engineMod.createEngine({ log: (...a) => console.log('[whatsapp-qr-worker]', ...a) });
    ['SIGINT', 'SIGTERM'].forEach((sig) => process.on(sig, () => { engine.shutdown('Stopped.').finally(() => process.exit(0)); }));
    console.log('[whatsapp-qr-worker] starting (prototype, unofficial)');
    await engine.run();
    process.exit(0);
  } catch (e) {
    const state = e && e.code === 'NOT_INSTALLED' ? 'not-installed' : 'stopped';
    await wq.setState({ state, reason: String((e && e.message) || e).slice(0, 300), qr: null, pid: null }).catch(() => {});
    console.error('[whatsapp-qr-worker]', e && e.message);
    process.exit(1);
  }
})();
