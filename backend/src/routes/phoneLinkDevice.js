// ---------------------------------------------------------------------------
// /api/phone-link/*  - what the TeamLink Phone ANDROID APP calls (browsercall/phoneLink.js). No TeamLink login here: the app pairs once with
// the Admin's 6-digit code and then sends its own device key (Authorization: Bearer <key>). Only the key's SHA-256 is stored; unpairing in
// TeamLink kills the key at once. The app never sees a candidate's name - only the number to dial and the recruiter's first name.
// ---------------------------------------------------------------------------
const express = require('express');
const PL = require('../browsercall/phoneLink');
const { logAudit } = require('../utils/audit');

const router = express.Router();
const fail = (res, code, error, extra = {}) => res.status(code).json({ error, ...extra });
const keyOf = (req) => String(req.get('authorization') || '').replace(/^Bearer\s+/i, '').trim();
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

router.post('/pair', async (req, res) => {
  try {
    const out = await PL.pair(req.body || {}, req.ip);
    if (out.error) return fail(res, out.status || 400, out.error);
    const d = out.device;
    await logAudit({ userId: d.pairedById || null, action: 'Android phone paired', entity: 'Integration', entityId: d.id, toValue: `${d.name} · ${d.number}${d.model ? ` · ${d.model}` : ''}` }).catch(() => {});
    return res.json({ token: out.token, device: { id: d.id, name: d.name, number: d.number }, pollSeconds: 25 });
  } catch (e) { console.error('[phone-link] pair:', e.message); return fail(res, 500, 'Could not pair the phone.'); }
});

async function device(req, res, next) {
  try {
    const d = await PL.deviceByToken(keyOf(req));
    if (!d) return fail(res, 401, 'This phone is not paired (or was unpaired in TeamLink). Pair it again with a new code.', { code: 'UNPAIRED' });
    req.device = d;
    return next();
  } catch (e) { return fail(res, 500, 'Could not check the phone.'); }
}

// the heartbeat and the "anything for me?" question in one: held up to 25 s when there is nothing to do
router.post('/device/poll', device, async (req, res) => {
  try {
    const wait = Math.max(0, Math.min(25, Number((req.body && req.body.wait) ?? 25) || 0)) * 1000;
    let closed = false; req.on('close', () => { closed = true; });
    const out = await PL.poll(req.device, wait, req.body && req.body.state);
    if (closed) return undefined;
    const fresh = await PL.byId(req.device.id);
    if (!fresh) return fail(res, 401, 'This phone was unpaired in TeamLink.', { code: 'UNPAIRED' });
    return res.json({ ...out, paused: !!fresh.paused, name: fresh.name, number: fresh.number, serverTime: new Date().toISOString() });
  } catch (e) { console.error('[phone-link] poll:', e.message); return fail(res, 500, 'Could not read the queue.'); }
});

router.post('/device/event', device, async (req, res) => {
  try {
    const out = await PL.event(req.device, req.body || {});
    if (out.error) return fail(res, out.status || 400, out.error);
    return res.json({ ok: true, status: out.call.status });
  } catch (e) { console.error('[phone-link] event:', e.message); return fail(res, 500, 'Could not save the event.'); }
});

// the app's own "Unpair this phone"
router.post('/device/unpair', device, async (req, res) => {
  try {
    await PL.unpair(req.device.id);
    await logAudit({ userId: null, action: 'Android phone unpaired (from the phone)', entity: 'Integration', entityId: req.device.id, toValue: `${req.device.name} · ${req.device.number}` }).catch(() => {});
    return res.json({ ok: true });
  } catch (e) { return fail(res, 500, 'Could not unpair.'); }
});

module.exports = router;
