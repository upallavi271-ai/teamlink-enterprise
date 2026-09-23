// ---------------------------------------------------------------------------
// NORMALISING REAL SPREADSHEET DATA.
//
// These sheets were filled in by dozens of people over four years, so the same
// value appears in every casing and punctuation anyone ever typed:
//
//   M.TECH / M.Tech / Mtech / mtech / MTECH        one qualification
//   CSE / Cse / cse                                one specialisation
//   ONLINE / Online / online                       one interview mode
//   A.Kavya / A.kavya                              one person
//   Shifa Hospital, Tamil Nadu / Shifa Hospital,Tamil Nadu   one client
//
// Measured on the education interview sheet: 488 college spellings are 299
// colleges, 282 recruiter and TL spellings are 186 people, 200 specialisation
// spellings are 134 specialisations. Import it raw and every report splits one
// person's work across three rows and one college's pipeline across two
// clients.
//
// WHAT IS AND IS NOT COLLAPSED HERE. `nkey` ignores case and every
// non-alphanumeric character, and nothing else. It never drops words, never
// stems, never does fuzzy or edit-distance matching. So "Lalitha
// Hospitals,Gajularamaram" and "Lalitha Hospital, Chevalla" stay two branches,
// and "P.Badri" and "BADRI" stay two names — probably the same person, but
// "probably" is not a thing to decide silently inside an import. The converter
// reports those so somebody can say.
// ---------------------------------------------------------------------------

// The key two values share when they are the same value typed differently.
const nkey = (s) => String(s === null || s === undefined ? '' : s)
  .toLowerCase().replace(/[^a-z0-9]/g, '');

// Which spelling to SHOW when several exist for one key.
//
// ALL CAPS is how a value arrives pasted out of a portal or typed with caps
// lock on; mixed case is how a person writes a name, and it is what should
// appear on screen. Between two of the same kind, the longer one usually
// carries more (an initial, a suffix, a branch).
function preferred(a, b) {
  if (!a) return b;
  if (!b) return a;
  const shouty = (s) => s === s.toUpperCase() && /[A-Z]/.test(s);
  if (shouty(a) !== shouty(b)) return shouty(a) ? b : a;
  return a.length >= b.length ? a : b;
}

// ALL-CAPS names read as shouting on screen. Only applied where every letter
// is upper case, so "McDonald" and "D.Kavyalahari" are left exactly as typed.
function tidyName(s) {
  const v = String(s || '').replace(/\s+/g, ' ').trim();
  if (!v) return '';
  if (v !== v.toUpperCase()) return v;
  return v.toLowerCase().replace(/(^|[\s.&/-])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

// A phone number's identity is its last ten digits: the sheets carry
// "9315600000 8505842545" (two numbers in one cell), "99486 26268" (spaced)
// and +91 prefixes. Returns '' when there is no plausible number, so a blank
// is never mistaken for a key that several rows share.
function phoneKey(s) {
  const digits = String(s || '').replace(/\D/g, '');
  if (digits.length < 10) return '';
  return digits.slice(-10);
}

// The first of several numbers crammed into one cell, formatted for display.
function firstPhone(s) {
  const parts = String(s || '').split(/[,;/]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
  for (const p of parts) {
    const k = phoneKey(p);
    if (k) return k;
  }
  return phoneKey(s);
}

// ---------------------------------------------------------------------------
// THE STATUS VOCABULARY OF THESE SHEETS -> THE PIPELINE.
//
// Every phrase below was counted in the real data before it was mapped, so
// this is the sheets' own vocabulary and not a guess at what they might say.
// The big ones on the education interview sheet: Rejected 5,300, Won't Join
// 3,032, Waiting For Feedback 1,258, Joined 852, Selected 737.
//
// TWO DISTINCTIONS WORTH KEEPING. "Won't Join" is not the same failure as
// "Rejected" — the company said yes and the candidate said no — and the
// pipeline has no OFFER_DECLINED stage, so it lands on REJECTED with the offer
// marked declined and the real phrase kept as the reason. "Not Interested" is
// a candidate who never entered a process at all, which is also REJECTED but
// for a different reason, and reports that cannot tell those apart are reports
// nobody trusts.
// ---------------------------------------------------------------------------
const STATUS_MAP = {
  // terminal — hired
  joined: { stage: 'JOINED', offerStatus: 'Offer Accepted' },
  joining: { stage: 'JOINED', offerStatus: 'Offer Accepted' },
  // offer in play
  willjoin: { stage: 'OFFER_ACCEPTED', offerStatus: 'Offer Accepted' },
  selected: { stage: 'SELECTED' },
  shortlisted: { stage: 'CLIENT_SHORTLISTED' },
  // in process
  waitingforfeedback: { stage: 'INTERVIEW_COMPLETED' },
  completed: { stage: 'INTERVIEW_COMPLETED' },
  interviewdone: { stage: 'INTERVIEW_COMPLETED' },
  rescheduled: { stage: 'INTERVIEW_SCHEDULED' },
  schedule: { stage: 'INTERVIEW_SCHEDULED' },
  scheduled: { stage: 'INTERVIEW_SCHEDULED' },
  demo: { stage: 'INTERVIEW_SCHEDULED', reason: 'Demo lecture stage' },
  conferencecall: { stage: 'INTERVIEW_SCHEDULED', reason: 'Conference call stage' },
  pending: { stage: 'RECRUITER_REVIEW' },
  submittedtoclient: { stage: 'SHARED_WITH_CLIENT' },
  submittedtotheclient: { stage: 'SHARED_WITH_CLIENT' },
  interested: { stage: 'RECRUITER_REVIEW' },
  intrested: { stage: 'RECRUITER_REVIEW' },
  // held
  hold: { stage: 'HOLD' },
  onhold: { stage: 'HOLD' },
  callback: { stage: 'HOLD', reason: 'Call back requested' },
  // terminal — not hired, and WHY differs
  rejected: { stage: 'REJECTED', reason: 'Rejected' },
  wontjoin: { stage: 'REJECTED', reason: "Won't join — offer declined by the candidate", offerStatus: 'Offer Declined' },
  wontattend: { stage: 'REJECTED', reason: "Won't attend the interview" },
  notattend: { stage: 'REJECTED', reason: 'Did not attend the interview' },
  notinterested: { stage: 'REJECTED', reason: 'Candidate not interested' },
  noteligible: { stage: 'REJECTED', reason: 'Not eligible' },
  drop: { stage: 'REJECTED', reason: 'Dropped out' },
  notselected: { stage: 'REJECTED', reason: 'Not selected' },
  notdone: { stage: 'REJECTED', reason: 'Interview not done' },

  // THE SPELLINGS THAT ACTUALLY APPEAR. Counted in the real sheets:
  // "intersted" and "intrested" for interested, "Rejecetd" for rejected,
  // "Reschedule" beside "Rescheduled". A typo is not a different outcome,
  // and leaving these unmapped left 100+ applications at the wrong stage.
  intersted: { stage: 'RECRUITER_REVIEW' },
  intrsted: { stage: 'RECRUITER_REVIEW' },
  rejecetd: { stage: 'REJECTED', reason: 'Rejected' },
  rejectd: { stage: 'REJECTED', reason: 'Rejected' },
  reschedule: { stage: 'INTERVIEW_SCHEDULED' },
  selectedforofflinedemo: { stage: 'INTERVIEW_SCHEDULED', reason: 'Selected for an offline demo' },
  offlinedemo: { stage: 'INTERVIEW_SCHEDULED', reason: 'Offline demo stage' },
  notshortlisted: { stage: 'REJECTED', reason: 'Not shortlisted by the client' },
};

// A STATUS CELL THAT IS REALLY A DATED NOTE.
//
// Plenty of cells hold a follow-up comment where a status belongs:
// "30-07-26 interview attended", "03-10-25 shortlisted for the interview",
// "28-11-25 call not answered". The outcome IS in there, so it is read by
// looking for a known phrase inside the text.
//
// ORDER MATTERS AND IS THE WHOLE TRICK. "not selected" has to be tested
// before "selected", and "won't join" before "join", or a rejection reads as
// a hire — which is the one direction this must never get wrong. Longest and
// most negative first.
const PHRASES = [
  ["won't join", { stage: 'REJECTED', reason: "Won't join — offer declined by the candidate", offerStatus: 'Offer Declined' }],
  ['wont join', { stage: 'REJECTED', reason: "Won't join — offer declined by the candidate", offerStatus: 'Offer Declined' }],
  ['not selected', { stage: 'REJECTED', reason: 'Not selected' }],
  ['not shortlisted', { stage: 'REJECTED', reason: 'Not shortlisted by the client' }],
  ['not interested', { stage: 'REJECTED', reason: 'Candidate not interested' }],
  ['not eligible', { stage: 'REJECTED', reason: 'Not eligible' }],
  ['not attend', { stage: 'REJECTED', reason: 'Did not attend the interview' }],
  ['not answer', { stage: 'HOLD', reason: 'Call not answered' }],
  ['not done', { stage: 'REJECTED', reason: 'Interview not done' }],
  ['not join', { stage: 'REJECTED', reason: 'Did not join' }],
  ['no requirement', { stage: 'REJECTED', reason: 'No requirement' }],
  ['reject', { stage: 'REJECTED', reason: 'Rejected' }],
  ['declin', { stage: 'REJECTED', reason: 'Declined' }],
  ['backout', { stage: 'REJECTED', reason: 'Backed out' }],
  ['back out', { stage: 'REJECTED', reason: 'Backed out' }],
  ['joined', { stage: 'JOINED', offerStatus: 'Offer Accepted' }],
  ['reported', { stage: 'JOINED', reason: 'Reported for joining', offerStatus: 'Offer Accepted' }],
  ['offer', { stage: 'OFFER', reason: 'Offer stage' }],
  ['salary discussion', { stage: 'SELECTED', reason: 'In salary discussion' }],
  ['selected', { stage: 'SELECTED' }],
  ['shortlist', { stage: 'CLIENT_SHORTLISTED' }],
  ['interview attended', { stage: 'INTERVIEW_COMPLETED' }],
  ['interview done', { stage: 'INTERVIEW_COMPLETED' }],
  ['interview completed', { stage: 'INTERVIEW_COMPLETED' }],
  ['waiting for the update', { stage: 'INTERVIEW_COMPLETED', reason: 'Waiting for an update' }],
  ['waiting for feedback', { stage: 'INTERVIEW_COMPLETED' }],
  ['demo', { stage: 'INTERVIEW_SCHEDULED', reason: 'Demo lecture stage' }],
  ['reschedul', { stage: 'INTERVIEW_SCHEDULED' }],
  ['interview', { stage: 'INTERVIEW_SCHEDULED' }],
  ['profile shared', { stage: 'SHARED_WITH_CLIENT' }],
  ['submitted', { stage: 'SHARED_WITH_CLIENT' }],
  ['hold', { stage: 'HOLD' }],
  ['call back', { stage: 'HOLD', reason: 'Call back requested' }],
  ['interest', { stage: 'RECRUITER_REVIEW' }],
];

// Returns { stage, reason, offerStatus } or null when nothing in the text is
// recognisable. NULL IS DELIBERATE: a phrase this cannot read becomes a
// reported unknown, not a quiet default to NEW, because a wrong stage is
// invisible once it is in and a reported one gets fixed.
function mapStatus(raw) {
  const k = nkey(raw);
  if (!k) return null;
  if (STATUS_MAP[k]) return { ...STATUS_MAP[k] };

  // Not an exact match — look for a known phrase inside the text. Compared on
  // a space-preserving fold so "not selected" cannot be found inside
  // "notselected" by accident and word order still matters.
  const soft = String(raw).toLowerCase().replace(/[^a-z0-9']+/g, ' ').trim();
  for (const [phrase, verdict] of PHRASES) {
    if (soft.includes(phrase)) return { ...verdict, matchedOn: phrase };
  }
  return null;
}

module.exports = { nkey, preferred, tidyName, phoneKey, firstPhone, mapStatus, STATUS_MAP };
