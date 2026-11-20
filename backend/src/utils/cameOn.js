// ---------------------------------------------------------------------------
// "CAME ON" — WHEN DID THIS PERSON COME TO US, AND CAN THAT DATE BE TRUSTED?
// (user, 2026-10-13: "Candidates Ye Source nunchi entha mandi vacharu, eppudu vacharu, clear ga visible avvali")
//
// ONE function decides the date, and the list, the filter, the sort, the Sources
// tab, the exports and the profile header all read its answer, so they cannot
// disagree. Nothing is invented: the date is always one the database really holds.
//
//   kind 'sheet'     an old tracker row whose own date was kept on its application
//                    (the first application is dated BEFORE the profile was loaded):
//                    the date is that sheet date.
//   kind 'fromSheet' an import carried the person's OWN date (a date column, or one date for the whole
//                    sheet, or the repair tool "Fix came-on dates from a sheet"): Candidate.createdAt IS that
//                    date. Shown as "From the sheet". (utils/candidateDates.js keeps the mark.)
//   kind 'imported'  the profile entered TeamLink on a BULK-IMPORT day (150+ profiles
//                    created that day), or an import carried NO date for it (marked 'unknown'): the date is the
//                    day it was loaded, NOT the day the person really arrived.
//                    Shown as "Imported on <date> (original date not known)".
//   kind 'applied'   the person applied through the job portal / a careers link: the date
//                    they applied.
//   kind 'entered'   everybody else: the day the profile was created in TeamLink.
//
// cameOnOf(candidate, applications, bulkDays, marks) -> { at: Date, day: 'YYYY-MM-DD' (IST), kind }
//   marks: Map candidateId -> 'sheet' | 'unknown' (await candidateDates.marksMap()); omitted = no marks.
// bulkDaysOf(candidates)                      -> Set of IST days
// ---------------------------------------------------------------------------
const { istDay } = require('./nextAction');

const BULK_DAY_MIN = 150; // the same size as utils/nextAction.js BULK_DAY_MIN (a "bulk-import day")
const DAY_MS = 86400000;

// The IST days on which BULK_DAY_MIN or more profiles were created: those were imports.
function bulkDaysOf(candidates) {
  const perDay = new Map();
  (candidates || []).forEach((c) => {
    const d = istDay(c.createdAt);
    if (d) perDay.set(d, (perDay.get(d) || 0) + 1);
  });
  const out = new Set();
  perDay.forEach((n, d) => { if (n >= BULK_DAY_MIN) out.add(d); });
  return out;
}

const PORTAL_WORDS = new Set(['teamlink job portal', 'job portal']);
const isPortal = (v) => PORTAL_WORDS.has(String(v == null ? '' : v).replace(/\s+/g, ' ').trim().toLowerCase());

function cameOnOf(candidate, applications, bulkDays, marks) {
  const entered = new Date(candidate.createdAt);
  const mark = marks && candidate.id ? marks.get(candidate.id) : null;
  // The import carried the person's own date: createdAt IS that date.
  if (mark === 'sheet') return { at: entered, day: istDay(entered), kind: 'fromSheet' };
  let first = null;
  let portal = null;
  (applications || []).forEach((a) => {
    if (!a || !a.createdAt) return;
    const t = new Date(a.createdAt);
    if (Number.isNaN(t.getTime())) return;
    if (!first || t < first) first = t;
    if (isPortal(a.source) && (!portal || t < portal)) portal = t;
  });
  // An application dated more than a day before the profile was loaded carries the old sheet's own date.
  if (first && first.getTime() < entered.getTime() - DAY_MS) return { at: first, day: istDay(first), kind: 'sheet' };
  const day = istDay(entered);
  if (portal) return { at: portal, day: istDay(portal), kind: 'applied' };
  if (bulkDays && bulkDays.has(day)) return { at: entered, day, kind: 'imported' };
  // An import carried no date for this person: createdAt is the import day, not the day they came.
  if (mark === 'unknown') return { at: entered, day, kind: 'imported' };
  return { at: entered, day, kind: 'entered' };
}

// Plain words for each kind (the screens and the exports say the same thing).
const KIND_LABEL = {
  fromSheet: 'From the sheet',
  sheet: 'Date from the old sheet',
  imported: 'Imported on this date (original date not known)',
  applied: 'Date they applied',
  entered: 'Date the profile was added',
};
// A date is the REAL arrival date for everything except an import day.
const isRealArrival = (kind) => kind !== 'imported';

module.exports = { BULK_DAY_MIN, bulkDaysOf, cameOnOf, KIND_LABEL, isRealArrival };
