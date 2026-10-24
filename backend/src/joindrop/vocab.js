// ---------------------------------------------------------------------------
// JOINING & DROP - the words and the small pure helpers (no database here).
// Plain English on purpose: this is read by recruiters, clients and the founder.
// ---------------------------------------------------------------------------

// The standard reasons a joined person leaves. A person may also TYPE their own (a typed reason is kept exactly as typed, tidied).
const DROP_REASONS = [
  'Resigned',
  'Absconded / not reporting',
  'Terminated by client',
  'Performance issue',
  'Better offer elsewhere',
  'Relocation / personal',
  'Health / family',
  'Role mismatch',
  'Salary issue',
  'Client project closed',
  'Other (type it)',
];
const OTHER_REASON = 'Other (type it)';

// What the client decides after a drop.
const DECISIONS = {
  NEEDED: { label: 'We need a replacement', short: 'Replacement needed' },
  NOT_NEEDED: { label: 'No replacement needed', short: 'No replacement needed' },
  LATER: { label: 'We will decide later', short: 'Will decide later' },
};
const DECISION_KEYS = Object.keys(DECISIONS);

// Where a drop was reported from.
const FROM = ['Client login', 'Recruiter', 'TL', 'BDE', 'HR', 'Admin', 'Manager', 'Accounts'];

// Replacement status words (the stored value is the word itself, so every screen reads the same).
const REPL = {
  REQUESTED: 'Requested',
  LINKED: 'New candidate added',
  CLOSED: 'Closed',
  NOT_NEEDED: 'Not needed',
};

// The kinds of history rows.
const KINDS = {
  JOINED: 'Joined',
  REJOINED: 'Joined again',
  DETAILS_ADDED: 'Joining details added',
  JOINING_CORRECTED: 'Joining details corrected',
  DROP_REPORTED: 'Drop reported',
  DROP_CORRECTED: 'Drop details corrected',
  CLIENT_DECISION: 'Replacement decision',
  REPLACEMENT_LINKED: 'Replacement candidate linked',
  REPLACEMENT_CLOSED: 'Replacement closed',
  DROP_REOPENED: 'Drop withdrawn (wrongly reported)',
  REPLACEMENT_TASK_CANCELLED: 'Replacement task cancelled',
  REPLACEMENT_TASK_OPENED: 'Replacement task opened by hand',
  CANDIDATE_NOTICE: 'Notice sent to the candidate',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IST = 330 * 60000;
const isDay = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !Number.isNaN(new Date(`${s}T00:00:00Z`).getTime())
  && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === String(s);
const todayIst = (now = Date.now()) => new Date(new Date(now).getTime() + IST).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();
const dmy = (iso) => {
  const s = String(iso || '').slice(0, 10);
  if (!isDay(s)) return 'Not recorded';
  return `${Number(s.slice(8, 10))} ${MONTHS[Number(s.slice(5, 7)) - 1]} ${s.slice(0, 4)}`;
};
const addDays = (day, n) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 86400000);

// Free text from a person: no control characters, no markup, one line unless it may be long.
const clean = (s, n = 200) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const cleanLong = (s, n = 1500) => String(s == null ? '' : s).replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').replace(/[ \t]+/g, ' ').trim().slice(0, n);
const firstName = (n) => String(n || '').replace(/^ZZTEST\S*\s*/i, '').trim().split(/\s+/)[0] || 'there';

// A typed reason is matched to the listed one (any capitals) so the reports group them; anything else is kept as typed.
function reasonOf(raw) {
  const v = clean(raw, 80);
  if (!v) return '';
  const hit = DROP_REASONS.find((r) => r.toLowerCase() === v.toLowerCase());
  return hit && hit !== OTHER_REASON ? hit : v;
}

const bool = (v) => (v === 1 || v === true || v === '1' ? 1 : 0);

module.exports = {
  DROP_REASONS, OTHER_REASON, DECISIONS, DECISION_KEYS, FROM, REPL, KINDS, MONTHS,
  isDay, todayIst, nowIso, dmy, addDays, daysBetween, clean, cleanLong, firstName, reasonOf, bool,
};
