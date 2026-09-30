// ---------------------------------------------------------------------------
// /iclock — the ADMS push endpoint the eSSL / ZKTeco device calls.
//
// NO LOGIN: the device cannot hold a TeamLink session. What it can do is send
// its serial number (SN) on every request, and only a serial registered under
// Administration -> Integrations -> Biometric with status Active is served.
// Anything else is answered with a bare "OK" (so a stray device does not
// retry in a tight loop) and stored nowhere.
//
//   GET  /iclock/cdata?SN=..&options=all   first contact -> device options
//   POST /iclock/cdata?SN=..&table=ATTLOG  punches       -> "OK: <n>"
//   POST /iclock/cdata?SN=..&table=OPERLOG users/ops     -> "OK: <n>"
//   POST /iclock/cdata?SN=..&table=USERINFO user list    -> "OK: <n>"
//   GET  /iclock/getrequest?SN=..          heartbeat     -> queued commands, or "OK"
//   POST /iclock/devicecmd?SN=..           command reply -> "OK"
//
// Some firmware adds ".aspx" to the paths; both spellings are served.
// Every request from a registered serial refreshes lastSeenAt.
// ---------------------------------------------------------------------------

const express = require('express');
const bio = require('../utils/biometricDevice');

const router = express.Router();

// The device posts tab-separated text with assorted content types.
router.use(express.text({ type: () => true, limit: '10mb' }));

function clientIp(req) {
  const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.socket.remoteAddress || null;
}

function reply(res, text) {
  res.set('Content-Type', 'text/plain');
  res.send(text);
}

// Resolve + stamp the device, or answer "OK" and stop.
async function withDevice(req, res, request, fn) {
  const serial = String(req.query.SN || req.query.sn || '').trim();
  const device = await bio.findDevice(serial);
  if (!device || device.status !== 'Active') {
    bio.noteUnknown(serial, clientIp(req), req.path);
    return reply(res, 'OK');
  }
  const info = request === 'heartbeat' ? bio.parseInfoParam(req.query.INFO) : null;
  const fresh = await bio.touch(device, { ip: clientIp(req), request, info });
  return fn(fresh);
}

const wrap = (h) => (req, res) => Promise.resolve(h(req, res)).catch((err) => {
  console.error('[iclock]', err && err.message);
  // "OK" keeps the device from hammering; the batch is re-sent on its next
  // stamp-based upload only if we did not store it, which the log dedupes.
  if (!res.headersSent) res.status(500).type('text/plain').send('ERROR');
});

// A fresh connection (device boot / reconnect) also asks for the user list.
router.get(/^\/cdata(\.aspx)?$/, wrap((req, res) => withDevice(req, res, 'handshake', (device) => {
  bio.queueUserQuery(device.serialNumber);
  return reply(res, bio.optionsReply(device));
})));

router.post(/^\/cdata(\.aspx)?$/, wrap((req, res) => {
  const table = String(req.query.table || '').toUpperCase();
  return withDevice(req, res, table ? `upload ${table}` : 'upload', async (device) => {
    const body = typeof req.body === 'string' ? req.body : '';
    if (table === 'ATTLOG') {
      const r = await bio.ingestAttlog(device, body);
      if (req.query.Stamp) {
        await require('../db').biometricDevice.update({ where: { id: device.id }, data: { attlogStamp: String(req.query.Stamp).slice(0, 32) } });
      }
      return reply(res, `OK: ${r.lines}`);
    }
    if (table === 'OPERLOG' || table === 'USERINFO') {
      const r = await bio.ingestOperlog(device, body);
      return reply(res, `OK: ${r.lines}`);
    }
    const n = body.split(/\r?\n/).filter((l) => l.trim()).length;
    return reply(res, `OK: ${n}`);
  });
}));

router.get(/^\/getrequest(\.aspx)?$/, wrap((req, res) => withDevice(req, res, 'heartbeat', async (device) => {
  await bio.queueUserQueryIfEmpty(device.serialNumber);
  return reply(res, bio.takeCommands(device.serialNumber) || 'OK');
})));
router.post(/^\/devicecmd(\.aspx)?$/, wrap((req, res) => withDevice(req, res, 'command reply', (device) => {
  bio.noteCommandReply(device.serialNumber, typeof req.body === 'string' ? req.body : '');
  return reply(res, 'OK');
})));
router.all(/^\/(ping|registry|push)(\.aspx)?$/, wrap((req, res) => withDevice(req, res, 'heartbeat', () => reply(res, 'OK'))));

module.exports = router;
