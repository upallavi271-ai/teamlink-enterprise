// ---------------------------------------------------------------------------
// /api/public/qoh/:token - the client's quality-of-hire rating page (no login; utils/insights/qoh.js signed token, 60 days).
// GET only SHOWS the form (a mail scanner opening the link records nothing); the POST records the answer once.
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const Q = require('../utils/insights/qoh');

const router = express.Router();
const lim = rateLimit({ bucket: 'ats-qoh', max: 300, windowMs: 10 * 60000, message: 'Too many requests. Please wait a minute and try again.' });
const limPost = rateLimit({ bucket: 'ats-qoh-post', max: 30, windowMs: 10 * 60000, message: 'Too many answers from this network. Please wait a few minutes.' });
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));
const CSS = `body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:#1b2a4a;margin:0;padding:16px;display:flex;justify-content:center}
.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:24px 20px;max-width:520px;width:100%;box-shadow:0 4px 18px rgba(20,40,80,.06);margin-top:24px}
h1{font-size:20px;margin:0 0 6px}p{color:#5b6474;line-height:1.5;margin:0 0 12px}.q{font-weight:600;margin:18px 0 8px}
.row{display:flex;flex-wrap:wrap;gap:6px}.row label{cursor:pointer}.row input{position:absolute;opacity:0}
.row span{display:inline-block;min-width:40px;text-align:center;padding:8px 6px;border:1px solid #cfd8e6;border-radius:8px;background:#fff}
.row input:checked+span{background:#2563eb;color:#fff;border-color:#2563eb}.row input:focus-visible+span{outline:2px solid #2563eb}
textarea,input[type=text]{width:100%;box-sizing:border-box;border:1px solid #cfd8e6;border-radius:8px;padding:10px;font:inherit}textarea{min-height:80px}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer;margin-top:16px;width:100%}
.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;margin:8px 0}.small{font-size:13px;color:#8a93a3}`;
const page = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><style>${CSS}</style></head><body><div class="card">${inner}</div></body></html>`;
const sendPage = (res, status, title, inner) => {
  res.status(status).set({
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer',
  });
  return res.send(page(title, inner));
};
const invalid = (res) => sendPage(res, 404, 'This link is not valid', '<h1>This link is not valid</h1><p>The link may be old or not complete. Please use the link from our message exactly as it came, or reply to the message.</p>');
const thanks = (res, extra = '') => sendPage(res, 200, 'Thank you', `<h1>Thank you</h1><p>Your rating is recorded. It helps us send you better people.</p>${extra}`);
const scale = (name, prev, required) => `<div class="row" role="radiogroup">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="${name}" value="${n}"${required ? ' required' : ''}${String(prev[name]) === String(n) ? ' checked' : ''}><span>${n}</span></label>`).join('')}</div>`;
const REHIRE = [['yes', 'Yes'], ['maybe', 'Maybe'], ['no', 'No']];
function form(s, token, error = '', prev = {}) {
  return `<h1>How is ${esc(s.personName)} doing?</h1>
<p>${esc(s.personName)} joined${s.clientName ? ` ${esc(s.clientName)}` : ''}${s.jobTitle ? ` as ${esc(s.jobTitle)}` : ''} about ${esc(s.day)} days ago. Four quick questions.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/api/public/qoh/${esc(token)}">
<div class="q">Overall, how good a hire is this person? <span class="small">(1 = poor, 5 = excellent)</span></div>${scale('rating', prev, true)}
<div class="q">Skills for the job</div>${scale('skills', prev, false)}
<div class="q">Attendance and punctuality</div>${scale('attendance', prev, false)}
<div class="q">Would you hire this person again?</div><div class="row">${REHIRE.map(([v, l]) => `<label><input type="radio" name="rehire" value="${v}"${prev.rehire === v ? ' checked' : ''}><span>${l}</span></label>`).join('')}</div>
<div class="q">Anything else? <span class="small">(optional)</span></div><textarea name="comment" maxlength="2000">${esc(prev.comment || '')}</textarea>
<div class="q">Your name <span class="small">(optional)</span></div><input type="text" name="name" maxlength="100" value="${esc(prev.name || '')}">
<button type="submit">Send</button></form><p class="small" style="margin-top:12px">Only TeamLink Consultants sees your answer.</p>`;
}
router.get('/:token', lim, async (req, res) => {
  const id = Q.idOfToken(req.params.token);
  const s = id ? await Q.forPage(id).catch(() => null) : null;
  if (!s) return invalid(res);
  if (s.answeredAt) return thanks(res, '<p class="small">This survey was already answered.</p>');
  return sendPage(res, 200, 'Quality of hire', form(s, req.params.token));
});
router.post('/:token', limPost, express.urlencoded({ extended: false, limit: '12kb' }), async (req, res) => {
  const id = Q.idOfToken(req.params.token);
  const s = id ? await Q.forPage(id).catch(() => null) : null;
  if (!s) return invalid(res);
  try {
    const out = await Q.answer(s.id, req.body || {});
    if (out.error === 'already') return thanks(res, '<p class="small">This survey was already answered, so this answer was not added again.</p>');
    if (out.error === 'gone') return invalid(res);
    if (out.error) return sendPage(res, 400, 'Quality of hire', form(s, req.params.token, out.error, req.body || {}));
    return thanks(res);
  } catch (e) {
    return sendPage(res, 500, 'Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>');
  }
});
module.exports = router;
