// ---------------------------------------------------------------------------
// /api/public/feedback/:token — the experience survey a candidate or a client opens from the message (no login).
// The token is the survey id signed with the server secret (utils/atsExperience.js surveyToken, 45 days): a changed letter or an
// old link answers "not valid". GET only SHOWS the form (a mail scanner opening the link records nothing); the POST records the
// answer once. Rate limited, never cached, never indexed. Plain words, no internal names.
// ---------------------------------------------------------------------------
const express = require('express');
const { rateLimit } = require('../utils/publicRateLimit');
const E = require('../utils/atsExperience');

const router = express.Router();
const lim = rateLimit({ bucket: 'ats-feedback', max: 300, windowMs: 10 * 60000, message: 'Too many requests. Please wait a minute and try again.' });
const limPost = rateLimit({ bucket: 'ats-feedback-post', max: 30, windowMs: 10 * 60000, message: 'Too many answers from this network. Please wait a few minutes.' });
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const page = (title, inner) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f5f7fb;color:#1b2a4a;margin:0;padding:16px;display:flex;justify-content:center}
.card{background:#fff;border:1px solid #e3e8f0;border-radius:14px;padding:24px 20px;max-width:520px;width:100%;box-shadow:0 4px 18px rgba(20,40,80,.06);margin-top:24px}
h1{font-size:20px;margin:0 0 6px}p{color:#5b6474;line-height:1.5;margin:0 0 12px}.q{font-weight:600;margin:18px 0 8px}
.row{display:flex;flex-wrap:wrap;gap:6px}.row label{cursor:pointer}.row input{position:absolute;opacity:0}
.row span{display:inline-block;min-width:34px;text-align:center;padding:8px 6px;border:1px solid #cfd8e6;border-radius:8px;background:#fff}
.row input:checked+span{background:#2563eb;color:#fff;border-color:#2563eb}.row input:focus-visible+span{outline:2px solid #2563eb}
.ends{display:flex;justify-content:space-between;font-size:12px;color:#8a93a3;margin-top:4px}
textarea{width:100%;box-sizing:border-box;border:1px solid #cfd8e6;border-radius:8px;padding:10px;font:inherit;min-height:80px}
button{background:#2563eb;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;cursor:pointer;margin-top:16px;width:100%}
.err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:8px 10px;margin:8px 0}.small{font-size:13px;color:#8a93a3}</style></head>
<body><div class="card">${inner}</div></body></html>`;
const sendPage = (res, status, title, inner) => {
  res.status(status).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer' });
  return res.send(page(title, inner));
};
const invalid = (res) => sendPage(res, 404, 'This link is not valid', '<h1>This link is not valid</h1><p>The link may be old or not complete. Please use the link from our message exactly as it came, or reply to the message.</p>');
const thanks = (res, s, extra = '') => sendPage(res, 200, 'Thank you', `<h1>Thank you${s.personName ? `, ${esc(String(s.personName).split(/\s+/)[0])}` : ''}</h1><p>Your answer is recorded. It helps us do better.</p>${extra}`);
const QUESTION = {
  interview: 'How was your interview experience with us?',
  offer: 'How was your experience of receiving the offer?',
  joining: 'How was your joining experience?',
  quarterly: 'How has working with TeamLink been this quarter?',
};

function form(s, token, error = '', prev = {}) {
  const cand = s.side === 'candidate';
  const intro = cand
    ? `${esc(QUESTION[s.event] || 'How was your experience?')}${s.requirementTitle ? ` <span class="small">(${esc(s.requirementTitle)})</span>` : ''}`
    : `${s.event === 'quarterly' ? esc(QUESTION.quarterly) : 'How was our work on this joining?'}${s.clientName ? ` <span class="small">${esc(s.clientName)}</span>` : ''}`;
  const checked = (name, v) => (String(prev[name]) === String(v) ? ' checked' : '');
  const stars = cand ? `<div class="q">Your rating</div><div class="row" role="radiogroup" aria-label="Stars from 1 to 5">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="stars" value="${n}" required${checked('stars', n)}><span aria-label="${n} star${n > 1 ? 's' : ''}">${'★'.repeat(n)}</span></label>`).join('')}</div>` : '';
  const nps = `<div class="q">How likely are you to recommend TeamLink to a friend or colleague?</div><div class="row" role="radiogroup" aria-label="0 to 10">${Array.from({ length: 11 }, (_, n) => `<label><input type="radio" name="nps" value="${n}" required${checked('nps', n)}><span>${n}</span></label>`).join('')}</div><div class="ends"><span>0 = not at all</span><span>10 = surely</span></div>`;
  return `<h1>${cand ? 'One minute about your experience' : 'One question for you'}</h1><p>${intro}</p>${error ? `<div class="err">${esc(error)}</div>` : ''}
<form method="post" action="/api/public/feedback/${esc(token)}">${stars}${nps}
<div class="q">Anything you would like to tell us? <span class="small">(optional)</span></div><textarea name="comment" maxlength="2000">${esc(prev.comment || '')}</textarea>
<div class="q"><label><input type="checkbox" name="complain" value="yes"${prev.complain ? ' checked' : ''}> I want to raise a complaint</label></div>
<textarea name="complaint" maxlength="4000" placeholder="What went wrong? We reply within ${cand ? '48 hours' : 'one working day'}.">${esc(prev.complaint || '')}</textarea>
<button type="submit">Send</button></form><p class="small" style="margin-top:12px">Only TeamLink Consultants sees your answer.</p>`;
}

router.get('/:token', lim, async (req, res) => {
  const id = E.surveyOfToken(req.params.token);
  const s = id ? await E.surveyForPage(id).catch(() => null) : null;
  if (!s) return invalid(res);
  if (s.answeredAt) return thanks(res, s, '<p class="small">You have already answered this survey.</p>');
  return sendPage(res, 200, 'Your feedback', form(s, req.params.token));
});
router.post('/:token', limPost, express.urlencoded({ extended: false, limit: '12kb' }), async (req, res) => {
  const id = E.surveyOfToken(req.params.token);
  const s = id ? await E.surveyForPage(id).catch(() => null) : null;
  if (!s) return invalid(res);
  try {
    const out = await E.answerSurvey(s.id, req.body || {});
    if (out.error === 'already') return thanks(res, s, '<p class="small">You have already answered this survey, so this answer was not added again.</p>');
    if (out.error) return sendPage(res, 400, 'Your feedback', form(s, req.params.token, out.error, req.body || {}));
    return thanks(res, s, out.complaint && out.complaint.id ? `<p>Your complaint is number <b>${esc(out.complaint.id)}</b>. Someone from our team will contact you soon.</p>` : '');
  } catch (e) {
    return sendPage(res, 500, 'Something went wrong', '<h1>Something went wrong</h1><p>Please try again in a minute.</p>');
  }
});

module.exports = router;
