// ---------------------------------------------------------------------------
// AGREEMENTS ARE NOT FOR TLs / STLs / RECRUITERS / HR (user, 2026-10-12:
// "TLs ki, recruiters ki agreements visible avvakudadu").
//
// Who sees agreements: Super Admin, Admin, Manager (view), Assistant Manager (status), BDE (own clients / desk),
// BDE team lead, Accounts (read only), and the client on their own portal. A TL, STL, Recruiter or HR login
// must not meet an agreement ANYWHERE: its existence, status, step, dates, number, link, PDF, fee / terms,
// "unsigned" warnings.
//
// This file is the SAFETY NET behind the per-route cuts (each route already hides what it can at the source):
//   blindTo(user)        true for a TL / STL / Recruiter / HR login that is not the BDE team lead
//   cleanFor(user, body) a COPY of an API answer without any agreement key and with the job-status words
//                        rewritten ("Agreement Check" -> "Draft", "Complete the client agreement" -> "On hold ...")
//   agreementGuard       Express middleware: wraps res.json for those logins (mounted ahead of the ATS routers)
//   HOLD_MESSAGE         the one plain sentence a blocked action says instead of any agreement wording
//
// The copy matters: some answers come from shared caches (candidate lists), so they are never edited in place.
// ---------------------------------------------------------------------------
const scope = require('./scope');

const HOLD_MESSAGE = 'This requirement is on hold. Ask your Business Development manager.';
const HOLD_NEXT = 'On hold. Ask your Business Development manager.';
const BLIND_ROLES = ['tl', 'stl', 'recruiter', 'hr'];

function blindTo(user) {
  if (!user) return false;
  try {
    if (scope.isBdeTl(user)) return false;
    return BLIND_ROLES.includes(scope.atsViewRole(user));
  } catch { return false; }
}

const ABOUT = /agreement|\be-?sign/i; // (word start: "design", "resign", "assign" are not about agreements)
const SAYS_AGREEMENT_KEYS = new Set(['error', 'gateNote', 'nextAction', 'hint', 'blocked', 'blockedReason', 'why']);
const NOT_FOR_ROLE = 'This is not available for your role.';
const HIDE_STRING_KEYS = new Set(['workStatus', 'lastActivityWhat', 'lastActivityBy', 'sub', 'tip', 'help', 'note', 'detail', 'what']);
const LABEL_KEYS = ['label', 'header', 'purposeLabel', 'purpose', 'key', 'sub', 'id'];
const DROP_KEY = /^(agreement|esign|e_sign|signedcopy|client agreements)/i;
const DROP_EXACT = new Set(['gatedRequirements', 'waitingAgreement', 'signedWaiting', 'unsignedAgreements', 'agreementPending']);
// whole-string value rewrites (exact match, so free text is never touched)
const VALUE_MAP = new Map([
  ['AGREEMENT_CHECK', 'DRAFT'],
  ['WAITING_FOR_AGREEMENT', 'ON_HOLD'],
  ['Agreement Check', 'Not live yet'],
  ['Draft / Agreement Check', 'Not live yet'],
  ['Agreement Approved', 'Approved'],
  ['Agreement Pending', 'On hold'],
  ['Agreement pending', 'On hold'],
  ['Waiting for agreement', 'On hold'],
  ['Complete the client agreement', HOLD_NEXT],
  ['Complete Agreement', HOLD_NEXT],
]);

function clean(v, depth) {
  if (v === null || v === undefined || depth > 14) return v;
  if (typeof v === 'string') return VALUE_MAP.has(v) ? VALUE_MAP.get(v) : v;
  if (typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    // a list row that is ABOUT the agreement (a column "Agreement Status", the "Client agreement link" message template,
    // a dashboard line "Unsigned agreement") is left out of the list
    return v.filter((x) => !(x && typeof x === 'object' && !Array.isArray(x) && LABEL_KEYS.some((k) => typeof x[k] === 'string' && ABOUT.test(x[k])))).map((x) => clean(x, depth + 1));
  }
  if (v instanceof Date || typeof v.toJSON === 'function' || Buffer.isBuffer(v)) return v;
  const out = {};
  Object.keys(v).forEach((k) => {
    if (DROP_KEY.test(k) || DROP_EXACT.has(k)) return;
    // the row's "what to do next" button kind
    if (k === 'nextActionKind' && v[k] === 'agreement') { out[k] = 'hold'; return; }
    // a refusal / hint that explains itself with the agreement: the job is simply on hold
    if (SAYS_AGREEMENT_KEYS.has(k) && typeof v[k] === 'string' && !VALUE_MAP.has(v[k]) && ABOUT.test(v[k])) {
      // about a job / profile being held -> the one hold sentence; any other refusal -> a plain "not for your role"
      out[k] = k === 'nextAction' ? HOLD_NEXT : (/\b(job|requirement|candidate|profile|live)\b/i.test(v[k]) ? HOLD_MESSAGE : NOT_FOR_ROLE);
      return;
    }
    // a status text that only exists because of the agreement ("Agreement pending", "Agreement document uploaded")
    if (HIDE_STRING_KEYS.has(k) && typeof v[k] === 'string' && !VALUE_MAP.has(v[k]) && ABOUT.test(v[k])) return;
    out[k] = clean(v[k], depth + 1);
  });
  return out;
}
// one cell of an export / report row
const cleanCell = (v) => {
  if (typeof v !== 'string') return v;
  if (VALUE_MAP.has(v)) return VALUE_MAP.get(v);
  return v.length < 200 && ABOUT.test(v) ? '' : v;
};
// export / report COLUMNS that are about the agreement
const AGREEMENT_COLUMN = /agreement|\be-?sign|signed by|signed copy|invoice trigger/i;
const cleanFor = (user, body) => (blindTo(user) ? clean(body, 0) : body);

function agreementGuard(req, res, next) {
  const json = res.json.bind(res);
  res.json = (body) => json(req.user && blindTo(req.user) ? clean(body, 0) : body);
  next();
}

// a SQL-ish helper for notification lists: titles / messages about agreements never reach these logins
const NOTE_WORDS = ['agreement', 'e-sign'];
const notificationFilter = (user) => (blindTo(user)
  ? { NOT: NOTE_WORDS.flatMap((w) => [{ title: { contains: w } }, { message: { contains: w } }]) }
  : null);

module.exports = { blindTo, clean, cleanFor, cleanCell, AGREEMENT_COLUMN, agreementGuard, notificationFilter, HOLD_MESSAGE, HOLD_NEXT, BLIND_ROLES };
