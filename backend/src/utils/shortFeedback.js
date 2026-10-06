// ---------------------------------------------------------------------------
// THE SHORT INTERVIEW FEEDBACK FORM (change list §11, 2026-10-03):
//   rating 1–5 · strengths · concerns · Selected / Rejected / Hold.
//
// Stored in the existing InterviewFeedback row (no schema change):
//   overall  = "Strengths: …\nConcerns: …"   (read back by readShort)
//   the four 1–5 criteria = the one rating, so every older screen and report
//   that averages them reads the same number.
// The older long form (four criteria + overall text) is still accepted.
// Never mixed with the AI interview score (Application.aiInterviewScore).
// ---------------------------------------------------------------------------
function clampRating(v) {
  if (v === '' || v == null) return null;
  const n = Math.round(Number(v));
  return Number.isNaN(n) ? null : Math.max(1, Math.min(5, n));
}

// body -> { overall, ratings } when the short form was used, else null.
function fromShortForm(body = {}) {
  // `comment` (layout v3): one plain comment box instead of strengths / concerns.
  const has = ['rating', 'strengths', 'concerns', 'comment'].some((k) => body[k] !== undefined);
  if (!has) return null;
  const strengths = String(body.strengths || '').trim().slice(0, 2000);
  const concerns = String(body.concerns || '').trim().slice(0, 2000);
  const comment = String(body.comment || '').trim().slice(0, 4000);
  const r = clampRating(body.rating);
  const parts = [];
  if (strengths) parts.push(`Strengths: ${strengths}`);
  if (concerns) parts.push(`Concerns: ${concerns}`);
  if (comment) parts.push(comment);
  return {
    rating: r,
    strengths,
    concerns,
    comment,
    overall: parts.join('\n'),
    ratings: { technical: r, communication: r, experience: r, roleFit: r },
  };
}

// The problem with a short-form body, in human words, or null.
function shortFormProblem(f) {
  if (!f) return null;
  if (!f.rating) return 'Give a rating from 1 to 5.';
  if (!f.strengths && !f.concerns && !f.comment) return 'Write a short comment.';
  return null;
}

// overall text -> { strengths, concerns } (for editing a saved form).
function readShort(overall) {
  const s = String(overall || '');
  const m1 = s.match(/^Strengths:\s*([\s\S]*?)(?:\nConcerns:|$)/);
  const m2 = s.match(/(?:^|\n)Concerns:\s*([\s\S]*)$/);
  if (!m1 && !m2) return { strengths: s, concerns: '' };
  return { strengths: m1 ? m1[1].trim() : '', concerns: m2 ? m2[1].trim() : '' };
}

module.exports = { fromShortForm, shortFormProblem, readShort, clampRating };
