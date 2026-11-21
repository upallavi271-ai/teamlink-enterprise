// ---------------------------------------------------------------------------
// IDENTITY VERIFICATION OF CANDIDATES (market benchmark 15.14). The recruiter makes a link; the candidate opens it and proves they hold the
// phone number and / or the e-mail on their profile with a one-time code. The profile then shows "Phone verified / E-mail verified" with
// the time. PHOTO MATCH: TeamLink keeps no resume photo or interview snapshot of a candidate today, so the check is the one-time code only
// (the screen says so); when both pictures exist this is the place to compare them (utils/faceEngine.js).
//
// Sending the code is a message to a real person: OFF until an Admin switches it on (Administration -> ATS settings -> Integrations).
// In the sandbox nothing is sent; the test reads the code from the answer (testCode, sandbox only).
// Codes: 6 digits, kept as a salted SHA-256, valid 10 minutes, 5 tries, a new code after 60 seconds.
//   staff:  POST /idverify/:candidateId/start { channels }  GET /idverify/:candidateId  GET/PUT /idverify/settings (Admin)
//   public: GET /api/public/verify/:token   POST /:token/send { channel }   POST /:token/check { channel, code }
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const express = require('express');
const prisma = require('../../db');
const { candidateWhere } = require('../scope');
const { logAudit } = require('../audit');
const S = require('./store');

const KIND = 'id-verify';
const SET_KEY = 'idVerify';
const sha = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const maskPhone = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 6 ? `${d.slice(0, 2)}XXXXXX${d.slice(-2)}` : null; };
const maskMail = (e) => { const [u, d] = String(e || '').split('@'); return u && d ? `${u[0]}***@${d}` : null; };
async function settings() { return S.settings.get(SET_KEY, { sendEnabled: false }); }

const router = express.Router();
router.get('/idverify/settings', S.adminOnly, S.wrap(async (req, res) => res.json(await settings())));
router.put('/idverify/settings', S.adminOnly, S.wrap(async (req, res) => {
  const next = { sendEnabled: !!(req.body || {}).sendEnabled };
  await S.settings.set(SET_KEY, next, req.user);
  await logAudit({ userId: req.user.id, action: `Candidate identity codes ${next.sendEnabled ? 'switched ON' : 'switched OFF'}`, entity: 'AtsPlusSetting', entityId: SET_KEY });
  res.json(next);
}));
async function cand(user, id) { return prisma.candidate.findFirst({ where: { AND: [{ id: String(id) }, candidateWhere(user)] }, select: { id: true, name: true, phone: true, email: true } }); }
router.post('/idverify/:candidateId/start', S.writer, S.wrap(async (req, res) => {
  const c = await cand(req.user, req.params.candidateId); if (!c) return res.status(404).json({ error: 'Not in your list.' });
  const want = (Array.isArray((req.body || {}).channels) ? req.body.channels : ['phone', 'email']).filter((x) => (x === 'phone' && c.phone) || (x === 'email' && c.email));
  if (!want.length) return res.status(400).json({ error: 'The profile has no phone or e-mail to check.' });
  const token = crypto.randomBytes(24).toString('base64url');
  const row = await S.items.create(KIND, { refType: 'Candidate', refId: c.id, status: 'PENDING', tokenHash: sha(token), channels: want, state: {}, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }, req.user);
  await logAudit({ userId: req.user.id, action: 'Identity check link made', entity: 'Candidate', entityId: c.id, toValue: want.join(' + ') });
  const s = await settings();
  res.status(201).json({ id: row.id, link: `/verify/${token}`, sendEnabled: s.sendEnabled, message: s.sendEnabled ? 'Send the link to the person; the page sends them a code.' : 'The link is made, but sending codes is OFF (an Admin switches it on). The person can open the page; the code cannot go out yet.' });
}));
router.get('/idverify/:candidateId', S.internal, S.wrap(async (req, res) => {
  const c = await cand(req.user, req.params.candidateId); if (!c) return res.status(404).json({ error: 'Not in your list.' });
  const rows = await S.items.list(KIND, { refId: c.id });
  const verified = { phone: null, email: null };
  rows.forEach((r) => Object.entries(r.state || {}).forEach(([ch, st]) => { if (st.verifiedAt && (!verified[ch] || st.verifiedAt > verified[ch])) verified[ch] = st.verifiedAt; }));
  res.json({ verified, rows: rows.map((r) => ({ id: r.id, status: r.status, channels: r.channels, createdAt: r.createdAt, createdByName: r.createdByName, state: Object.fromEntries(Object.entries(r.state || {}).map(([k, v]) => [k, { verifiedAt: v.verifiedAt || null, tries: v.tries || 0 }])) })), photoMatch: 'Not available: TeamLink keeps no resume photo or interview snapshot of this person, so the check is the one-time code only.' });
}));

const publicRouter = express.Router();
const { rateLimit } = require('../publicRateLimit');
publicRouter.use(rateLimit({ bucket: 'id-verify', max: 60, windowMs: 10 * 60000 }));
async function byToken(req, res) {
  const t = String(req.params.token || '');
  if (!/^[A-Za-z0-9_-]{20,60}$/.test(t)) { res.status(404).json({ error: 'This link does not work.' }); return null; }
  const [r] = (await S.items.list(KIND, {}, { limit: 20000 })).filter((x) => x.tokenHash === sha(t));
  if (!r || r.expiresAt < new Date().toISOString()) { res.status(404).json({ error: 'This link does not work any more. Ask your recruiter for a new one.' }); return null; }
  return r;
}
publicRouter.get('/:token', S.wrap(async (req, res) => {
  const r = await byToken(req, res); if (!r) return;
  const c = await prisma.candidate.findUnique({ where: { id: r.refId }, select: { name: true, phone: true, email: true } });
  res.json({ firstName: String((c && c.name) || '').split(/\s+/)[0], status: r.status, channels: r.channels.map((ch) => ({ channel: ch, to: ch === 'phone' ? maskPhone(c.phone) : maskMail(c.email), verified: !!(r.state[ch] && r.state[ch].verifiedAt) })) });
}));
publicRouter.post('/:token/send', S.wrap(async (req, res) => {
  const r = await byToken(req, res); if (!r) return;
  const ch = String((req.body || {}).channel || '');
  if (!r.channels.includes(ch)) return res.status(400).json({ error: 'Pick phone or e-mail.' });
  const cur = (r.state || {})[ch] || {};
  if (cur.verifiedAt) return res.json({ ok: true, message: 'Already verified.' });
  if (cur.sentAt && Date.now() - new Date(cur.sentAt).getTime() < 60000) return res.status(429).json({ error: 'Wait a minute before asking for a new code.' });
  const s = await settings();
  if (!s.sendEnabled) return res.status(409).json({ error: 'Codes cannot be sent yet. Please tell your recruiter.' });
  const c = await prisma.candidate.findUnique({ where: { id: r.refId }, select: { id: true, name: true, phone: true, email: true } });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0'); const salt = crypto.randomBytes(8).toString('hex');
  let note = 'SANDBOX - not sent';
  if (!S.sandbox()) {
    const text = `${code} is your TeamLink verification code. It is valid for 10 minutes. Do not share it.`;
    if (ch === 'phone') { const m = await require('../messaging').send('SMS', { to: c.phone, kind: 'otp', text, vars: [code, 10], meta: { audience: 'candidate', personId: c.id, personName: c.name, purpose: 'Candidate identity check', module: 'ATS', masked: true } }).catch((e) => ({ ok: false, error: e.message })); note = m.ok ? 'sent' : `not sent: ${m.error || m.outcome}`; } // eslint-disable-line global-require
    else { const m = await require('../mailer').sendMail({ to: c.email, subject: 'Your TeamLink verification code', text }).catch((e) => ({ ok: false, error: e.message })); note = m.ok ? 'sent' : `not sent: ${m.error || 'mail is not set up'}`; } // eslint-disable-line global-require
  }
  await S.items.update(r.id, { state: { ...(r.state || {}), [ch]: { ...cur, hash: sha(`${salt}:${code}`), salt, exp: Date.now() + 10 * 60000, tries: 0, sentAt: new Date().toISOString(), note } } });
  res.json({ ok: true, message: 'A code was sent. It is valid for 10 minutes.', ...(S.sandbox() ? { testCode: code } : {}) });
}));
publicRouter.post('/:token/check', S.wrap(async (req, res) => {
  const r = await byToken(req, res); if (!r) return;
  const b = req.body || {}; const ch = String(b.channel || '');
  const cur = (r.state || {})[ch];
  if (!cur || !cur.hash) return res.status(400).json({ error: 'Ask for a code first.' });
  if (cur.verifiedAt) return res.json({ ok: true, verified: true });
  if ((cur.tries || 0) >= 5) return res.status(429).json({ error: 'Too many wrong codes. Ask for a new one.' });
  if (Date.now() > cur.exp) return res.status(400).json({ error: 'The code has expired. Ask for a new one.' });
  const ok = sha(`${cur.salt}:${String(b.code || '').trim()}`) === cur.hash;
  const next = { ...cur, tries: (cur.tries || 0) + 1, ...(ok ? { verifiedAt: new Date().toISOString(), hash: null } : {}) };
  const state = { ...(r.state || {}), [ch]: next };
  const done = r.channels.every((x) => state[x] && state[x].verifiedAt);
  await S.items.update(r.id, { state, status: done ? 'VERIFIED' : r.status });
  if (!ok) return res.status(400).json({ error: 'That code is not right.' });
  await logAudit({ action: `Candidate ${ch === 'phone' ? 'phone' : 'e-mail'} verified by one-time code`, entity: 'Candidate', entityId: r.refId });
  res.json({ ok: true, verified: true, all: done });
}));

module.exports = { router, publicRouter };
