// ---------------------------------------------------------------------------
// THE LEAVE REQUEST TEXT — reason, the employee's comments and the details
// the LeaveRequest table has no column for (half day, a Pending request's
// assigned approver, approver comments on a cancelled request).
//
// LeaveRequest has one free-text column, `reason`. Rather than run the
// employee's reason, their longer comments and the half-day session together
// into one sentence (which is what the first PulseHRM import did), the text is
// stored in clearly separated sections that read naturally if printed as-is
// and that the API splits back apart for the list, the tooltip and the
// request detail:
//
//   Family function
//   —— Employee comments ——
//   Dear Sir, I need one day…
//   —— Details ——
//   Half day: First Half
//   Approver: Vasudeva Rao Chitturi
//
// compose() writes it; parse() reads it (and reads a plain old reason as just
// a reason).
// ---------------------------------------------------------------------------
const COMMENTS = '—— Employee comments ——';
const DETAILS = '—— Details ——';
const HALF_DAYS = ['First Half', 'Second Half'];

function clean(v) {
  return String(v === null || v === undefined ? '' : v).replace(/\r/g, '').trim();
}

// details: [[label, value], …] — empty values are dropped.
function compose({ reason, comments, details = [] } = {}) {
  const parts = [];
  const r = clean(reason);
  if (r) parts.push(r);
  const c = clean(comments);
  if (c) parts.push(COMMENTS, c);
  const d = (details || []).filter(([, v]) => clean(v)).map(([k, v]) => `${k}: ${clean(v).replace(/\n+/g, ' ')}`);
  if (d.length) parts.push(DETAILS, ...d);
  return parts.join('\n') || null;
}

function parse(text) {
  const s = clean(text);
  const out = { reasonText: '', employeeComments: '', details: {}, halfDay: null };
  if (!s) return out;
  let rest = s;
  const di = rest.indexOf(DETAILS);
  if (di >= 0) {
    rest.slice(di + DETAILS.length).split('\n').map((l) => l.trim()).filter(Boolean).forEach((line) => {
      const m = /^([^:]+):\s*(.*)$/.exec(line);
      if (m) out.details[m[1].trim()] = m[2].trim();
    });
    rest = rest.slice(0, di);
  }
  const ci = rest.indexOf(COMMENTS);
  if (ci >= 0) {
    out.employeeComments = rest.slice(ci + COMMENTS.length).trim();
    rest = rest.slice(0, ci);
  }
  out.reasonText = rest.trim();
  const hd = out.details['Half day'];
  out.halfDay = HALF_DAYS.find((h) => h.toLowerCase() === String(hd || '').toLowerCase()) || null;
  return out;
}

module.exports = { compose, parse, HALF_DAYS, COMMENTS, DETAILS };
