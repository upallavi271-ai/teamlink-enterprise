// ---------------------------------------------------------------------------
// /api/audience — what the shared form pieces read.
//
//   GET  /options  the AudiencePicker's lists (departments + employees), held
//                  to the caller's scope, plus the honest status of each
//                  "Also deliver via" channel for DeliverVia.
//   POST /preview  resolve an audience on the server and say who it reaches —
//                  the same resolveAudience() every create route runs, so a
//                  403 here is the 403 the form would get.
//   POST /assist   "AI Assist": draft or polish a form's main free-text field
//                  with the app's one AI wrapper (utils/ai.js). It returns
//                  text for the person to edit; it never saves anything.
// ---------------------------------------------------------------------------
const express = require('express');
const { requireAuth } = require('../middleware/auth');
const ai = require('../utils/ai');
const { limitFor } = require('./assistant');
const { audienceOptions, parseAudience, resolveAudience } = require('../utils/audience');

const router = express.Router();
router.use(requireAuth);

router.get('/options', async (req, res, next) => {
  try {
    res.json(await audienceOptions(req.user));
  } catch (err) { next(err); }
});

router.post('/preview', async (req, res, next) => {
  try {
    const aud = parseAudience(req.body) || { mode: 'everyone', departments: [], employeeIds: [] };
    const out = await resolveAudience(req.user, aud);
    if (!out.ok) return res.status(out.status).json({ error: out.error });
    return res.json({ count: out.employees.length, label: out.label, sample: out.employees.slice(0, 8).map((e) => e.name) });
  } catch (err) { return next(err); }
});

const KINDS = {
  announcement: 'a company announcement to employees',
  survey: 'an employee engagement pulse survey — one short statement per line that employees rate 1 to 5',
  recognition: 'a short, warm recognition message to a colleague',
  target: 'a clear, measurable monthly goal description',
  kt: 'notes for a knowledge-transfer session',
  project: 'a short project description',
  task: 'a work task description',
  disciplinary: 'a factual, neutral description of a disciplinary matter',
  helpdesk: 'a helpdesk ticket description',
  resignation: 'a polite resignation reason',
  review: 'performance review notes',
  roster: 'shift roster notes',
  expense: 'expense claim notes',
  document: 'a short summary of a policy document',
};
const MAX = 4000;

router.post('/assist', async (req, res, next) => {
  try {
    const b = req.body || {};
    const kind = KINDS[b.kind] ? b.kind : 'announcement';
    const title = String(b.title || '').trim().slice(0, 300);
    const text = String(b.text || '').trim().slice(0, MAX);
    if (!title && !text) return res.status(400).json({ error: 'Type a title or a few words first — AI Assist works from what you have written.' });

    const limit = await limitFor(req.user);
    if (!limit.ok) return res.status(429).json({ error: limit.message, retryAfter: limit.retryAfter });

    const system = [
      `You help an HR team write ${KINDS[kind]} inside an HRMS.`,
      'Return ONLY the finished text for the field — no preamble, no quotes, no markdown headings, no sign-off placeholders like [Name].',
      'Keep it professional, plain and concise (under 120 words unless the draft is longer). Do not invent names, dates, numbers or policies that are not in the input.',
      text ? 'Polish the draft: fix grammar and clarity, keep its meaning and facts.' : 'Write a first draft from the title.',
    ].join('\n');
    const prompt = `Title: ${title || '(none)'}\n\n${text ? `Draft:\n${text}` : 'No draft yet.'}`;
    try {
      const out = await ai.chat(system, [{ role: 'user', content: prompt }]);
      const clean = String(out || '').trim().replace(/^["“]|["”]$/g, '');
      if (!clean) return res.status(502).json({ error: 'The AI did not return any text. Try again.' });
      return res.json({ text: clean, provider: ai.provider() });
    } catch (err) {
      if (err instanceof ai.AiError) return res.status(err.status).json({ error: err.message, code: err.code });
      throw err;
    }
  } catch (err) { return next(err); }
});

module.exports = router;
