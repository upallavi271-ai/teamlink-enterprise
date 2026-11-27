// ---------------------------------------------------------------------------
// A CLIENT'S ENQUIRY PAGE (no login; marketing/clientLeads.js). Mounted at /api/public/mk-lead (index.js):
//   GET  /:token?s=<where the link was shared>   the page: Call, WhatsApp and a short form
//   POST /:token?s=...                           the form (a hidden "website" box catches robots; a permission tick is required)
//   POST /:token/press                           { button: 'call' | 'whatsapp' } sent by the page when a person presses a button
// Safe by design: every word on the page is escaped, a limit per network, small boxes, the same plain 404 for a wrong, switched-off or ended page,
// no cookie, no IP stored, never cached, never indexed. Opening the page records nothing.
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const L = require('../marketing/clientLeads');

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: '20kb' }));
const limGet = rateLimit({ bucket: 'mk-lead-get', max: 120, windowMs: 10 * 60000 });
const limPost = rateLimit({ bucket: 'mk-lead-post', max: 10, windowMs: 10 * 60000, message: 'Too many tries from your network. Please wait a few minutes and try again.' });
const limPress = rateLimit({ bucket: 'mk-lead-press', max: 40, windowMs: 10 * 60000 });
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const quiet = (res) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); res.set('X-Robots-Tag', 'noindex'); };
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const CSS = 'body{margin:0;background:#f4f7f6;color:#12303f;font:16px/1.5 "Segoe UI",Roboto,Arial,sans-serif}.card{max-width:480px;margin:0 auto;padding:22px 16px 40px}h1{font-size:23px;margin:6px 0 16px}'
  + '.btns{display:flex;gap:10px;margin-bottom:18px}.btns a{flex:1;text-align:center;padding:14px;border-radius:10px;font-weight:700;text-decoration:none;color:#fff;background:#0f766e}.btns a.wa{background:#15803d}'
  + 'form{background:#fff;border:1px solid #dde7e4;border-radius:12px;padding:16px}label{display:block;font-weight:600;font-size:14px;margin:10px 0 4px}'
  + 'input,textarea{width:100%;box-sizing:border-box;border:1px solid #c9d6d2;border-radius:8px;padding:11px;font:inherit}.tick{display:flex;gap:10px;align-items:flex-start;font-weight:400;margin-top:14px}.tick input{width:20px;height:20px;margin-top:2px;flex:none}'
  + 'button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:10px;background:#12303f;color:#fff;font:700 16px "Segoe UI",Roboto,Arial,sans-serif;cursor:pointer}.err{background:#fdeced;color:#9b1c1c;border-radius:8px;padding:10px;margin-bottom:8px}'
  + '.ok{background:#e8f7ef;color:#0b6b3a;border-radius:10px;padding:16px;font-weight:600}.small{color:#5b6f78;font-size:12.5px;margin-top:14px}';

const shell = (title, inner) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><main class="card">${inner}</main></body></html>`;
const gone = (res) => { quiet(res); res.status(404).type('html').send(shell('Page not available', '<h1>This page is not available</h1><p>It may be switched off, or the link is incomplete.</p>')); };

function view(page, token, source, { error = '', done = false, v = {} } = {}) {
  const here = `/api/public/mk-lead/${token}?s=${source}`;
  const buttons = [
    page.phone ? `<a href="tel:+${esc(page.phone)}" data-b="call">Call now</a>` : '',
    page.whatsapp ? `<a class="wa" href="https://wa.me/${esc(page.whatsapp)}" data-b="whatsapp" rel="noopener noreferrer">WhatsApp</a>` : '',
  ].join('');
  const box = (key, words, attrs) => `<label for="${key}">${words}</label><input id="${key}" name="${key}" value="${esc(v[key] || '')}" ${attrs}>`;
  const form = done ? '<p class="ok" role="status">Thank you. We have your enquiry and will contact you.</p>' : `<form method="post" action="${esc(here)}">${error ? `<p class="err" role="alert">${esc(error)}</p>` : ''}
${box('name', 'Your name', 'required maxlength="100" autocomplete="name"')}
${box('phone', 'Phone number', 'required type="tel" maxlength="20" autocomplete="tel"')}
${box('email', 'Email (optional)', 'type="email" maxlength="150" autocomplete="email"')}
<label for="message">How can we help? (optional)</label><textarea id="message" name="message" rows="3" maxlength="600" placeholder="Please do not share medical reports or ID numbers here">${esc(v.message || '')}</textarea>
<input name="website" style="position:absolute;left:-5000px" tabindex="-1" autocomplete="off" aria-hidden="true">
<label class="tick"><input type="checkbox" name="consent" value="yes" required><span>${esc(page.consent)}</span></label>
<button type="submit">Send enquiry</button></form>`;
  const script = `<script>document.querySelectorAll('a[data-b]').forEach(function(a){a.addEventListener('click',function(){var d=new URLSearchParams({button:a.getAttribute('data-b')});var u=${JSON.stringify(`/api/public/mk-lead/${token}/press?s=${source}`)};if(!(navigator.sendBeacon&&navigator.sendBeacon(u,d))){try{fetch(u,{method:'POST',body:d,keepalive:true})}catch(e){}}})})</script>`;
  return shell(page.heading, `<h1>${esc(page.heading)}</h1>${buttons ? `<div class="btns">${buttons}</div>` : ''}${form}
<p class="small">We collect your name, phone number, email and message only to answer your enquiry. To see, correct or delete your details, or to take back your permission, contact ${esc(page.privacyContact)}.</p>${buttons ? script : ''}`);
}

router.get('/:token', limGet, wrap(async (req, res) => {
  const page = await L.publicPage(req.params.token); if (!page) return gone(res);
  quiet(res);
  return res.type('html').send(view(page, req.params.token, L.linkSource(req.query.s), { done: req.query.done === '1' }));
}));

router.post('/:token', limPost, wrap(async (req, res) => {
  const page = await L.publicPage(req.params.token); if (!page) return gone(res);
  quiet(res);
  const source = L.linkSource(req.query.s); const body = req.body && typeof req.body === 'object' ? req.body : {};
  const thanks = () => res.redirect(303, `/api/public/mk-lead/${req.params.token}?s=${source}&done=1`);
  if (String(body.website || '').trim()) return thanks(); // a person never sees this box: looks like success, nothing is saved
  const text = (k) => (typeof body[k] === 'string' ? body[k] : '');
  const clean = { name: text('name'), phone: text('phone'), email: text('email'), message: text('message'), consent: text('consent') };
  const out = await L.publicSubmit(page, source, clean);
  if (out.error) return res.status(out.status || 400).type('html').send(view(page, req.params.token, source, { error: out.error, v: clean }));
  return thanks();
}));

router.post('/:token/press', limPress, wrap(async (req, res) => {
  const page = await L.publicPage(req.params.token); if (!page) return gone(res);
  quiet(res);
  await L.press(page, L.linkSource(req.query.s), String((req.body || {}).button || ''));
  return res.status(204).end();
}));

module.exports = router;
