// ---------------------------------------------------------------------------
// Small helpers every tool uses, so tools stay short and read alike.
//
// A tool's validate() answers with exactly ONE of:
//   done({ params, display, summary })   everything understood and checked
//   clarify(question, { options, need }) something is missing / ambiguous
//   refuse(message)                      cannot be done (plain words)
//   redirect(tool, { choices })          this is really another tool
// ---------------------------------------------------------------------------

const done = ({ params, display, summary, notes = [] }) => ({ ok: true, params, display, summary, notes });
const clarify = (question, { options = [], need = null } = {}) => ({ clarify: { question, options, need } });
const refuse = (message) => ({ refuse: message });
const redirect = (tool, extra = {}) => ({ redirect: { tool, ...extra } });

// One plain line per fact on the confirm card.
// display: { title, rows: [[label, value], ...], note? }
const card = (title, rows, note = null) => ({
  title,
  rows: rows.filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== '').map(([k, v]) => ({ label: k, value: String(v) })),
  note,
});

// "Which one?" with a button per row. `slot` is the choice key the pipeline
// hands back to validate() as input.choices[slot].
function which(question, rows, slot, labelOf = (r) => r.label, need = 'choice') {
  return clarify(question, {
    need,
    options: rows.slice(0, 6).map((r) => ({ label: labelOf(r), choice: { [slot]: r.id } })),
  });
}

const str = (v, max = 500) => String(v == null ? '' : v).trim().slice(0, max);
const rupees = (n) => `Rs ${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;

// First non-empty of the name spans / an answered "who?".
function nameSpans(input) {
  const out = [];
  (input.slots.names || []).forEach((n) => { if (n && !out.includes(n)) out.push(n); });
  return out;
}

// Free text the user typed after "because ..." / "reason ..." / "saying ...",
// or the answer to an earlier "why?" question.
function reasonText(input, key = 'reason') {
  const answered = input.slots.answers && input.slots.answers[key];
  if (answered) return str(answered, 400);
  if (input.slots.quoted && input.slots.quoted.length) return str(input.slots.quoted[0], 400);
  const m = String(input.text || '').match(/\b(?:because|reason(?: is| was)?|as|since|saying|due to)\s*[:\-]?\s+(.{3,300})$/i);
  return m ? str(m[1], 400) : '';
}

// Which party made a rejection decision, from the words the user wrote.
function sideSaid(text) {
  const t = String(text || '').toLowerCase();
  if (/\bclient\b/.test(t) && !/\bclient manager\b/.test(t)) return 'Client';
  if (/\bcandidate\b|\bhe declined\b|\bshe declined\b|not interested|no.?show|backed out|withdr/.test(t)) return 'Candidate';
  if (/\bteamlink\b|\binternal\b|\bwe\b|\bour\b|screen/.test(t)) return 'Internal';
  return null;
}

module.exports = {
  done, clarify, refuse, redirect, card, which, str, rupees, nameSpans, reasonText, sideSaid,
};
