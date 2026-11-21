// ---------------------------------------------------------------------------
// ONE FILE FOR TAB NAMES THAT MOVED (founder 2026-11-20: "too many tabs, it must
// be clear what each is for"). Every old link keeps working: an old key is
// looked up here and lands on the tab that now holds its content.
//
//   Candidates & Pipeline   main tabs: Needs my action | Requirement applications |
//                           People | New from job portal | More (Duplicates,
//                           Sources, Contact lists)
//   Candidate page          main tabs: Overview | Resume | Follow-ups & notes | Documents |
//                           History | More (Career, Conversation, Schedule a message, AI Calling)
//   Requirement page        main tabs: Overview | Candidates | Team | Interviews |
//                           Postings | More (Client, Agreement, History, Activity)
//   Client page             Details & Agreement | Requirements | Performance | Client work |
//                           Follow-ups | More (History)
//   Every StatusTabs strip  at most five on screen, the rest under More (ListPageHeader.jsx)
//   Module tab bars         Clients & Requirements, Reports & Team (More: Handover, Data quality),
//                           Interview Calendar (Interviews · Feedback · Offers · Joining)
//
// At most FIVE main tabs on any ATS strip (founder 2026-11-20 "give clear tabs").
//
// The words stay the words the app already used. Nothing is deleted: a tab that
// is rarely used sits under "More"; two tabs that showed the same kind of thing
// became one (Notes + Follow-ups).
// ---------------------------------------------------------------------------

// ---- Candidates & Pipeline (the list screen) ------------------------------
// The tab a person sees is worked out from the address (?view=&sub=&quick=).
export const LIST_TABS = ['todo', 'pipeline', 'master', 'job-portal', 'duplicates', 'sources', 'contacts'];
// Tabs under "More" on the list screen.
export const LIST_MORE = ['duplicates', 'sources', 'contacts', 'tools'];
// Old ?view= values (and spellings) -> the list screen's tab. Sub-tabs that used
// to be a view of their own (?view=hold, ?view=rejected ...) are pipeline lists.
export const LIST_VIEW_ALIAS = {
  todo: 'todo',
  'needs-action': 'todo',
  needsaction: 'todo',
  my_pending: 'todo',
  pipeline: 'pipeline',
  all: 'pipeline',
  any: 'pipeline',
  active: 'pipeline',
  hold: 'pipeline',
  selected: 'pipeline',
  joined: 'pipeline',
  rejected: 'pipeline',
  'job-portal': 'job-portal',
  jobportal: 'job-portal',
  master: 'master',
  people: 'master',
  duplicates: 'duplicates',
  sources: 'sources',
  contacts: 'contacts',
};
// Sub-tabs of the pipeline list; the first four are drawn, the rest sit under More.
export const PIPE_SUB_MORE = []; // the status strip shows all six (All, Active, On hold, Selected, Joined, Rejected)
// Sub-tabs of the People list; "All people" is drawn, the rest sit under More.
export const MASTER_SUB_MORE = [];

// The tab a login lands on when the address names none (the work it does):
//   Recruiter -> the work they must do now · TL -> their team's pipeline ·
//   BDE -> their client submissions (the pipeline, scoped to their clients) ·
//   Admin / Manager -> everyone.
export function defaultListTab(tier) {
  if (tier === 'recruiter') return 'todo';
  if (tier === 'tl' || tier === 'bde') return 'pipeline';
  return 'master';
}

// ---- Candidate page / drawer ----------------------------------------------
// Old tab keys -> the tab that holds the content now.
export const C360_TAB_ALIAS = {
  overview: 'applications',
  fit: 'applications',
  ai: 'applications',
  pipeline: 'applications',
  interviews: 'applications',
  submissions: 'applications',
  offers: 'applications',
  joining: 'applications',
  activity: 'history',
  timeline: 'history',
  // Notes and the follow-up log are one tab now ("Follow-ups & notes").
  notes: 'followups',
  followup: 'followups',
  'follow-ups': 'followups',
  'follow-ups-notes': 'followups',
  messages: 'conversation',
  calls: 'aicalling',
};
// Career is under More so that five tabs are on screen (it is opened less than the follow-ups and documents).
export const C360_MORE = ['career', 'conversation', 'scheduled', 'aicalling', 'tools'];
// Tabs only a TeamLink login sees (a client / candidate login never does).
export const C360_INTERNAL_ONLY = ['career', 'followups', 'conversation', 'scheduled', 'aicalling', 'tools'];
// Tabs that need the right to contact the person (the server decides who:
// not a BDE, BDE TL or Accounts login).
export const C360_REACH_ONLY = ['conversation', 'aicalling'];

// ---- Requirement page -----------------------------------------------------
export const REQ_TAB_ALIAS = {
  team: 'recruiter',
  recruiters: 'recruiter',
  postings: 'distribute',
  posting: 'distribute',
  distribute: 'distribute',
  pipeline: 'candidates',
  matching: 'candidates',
  interview: 'interviews',
};
// ?tab=history opens the requirement's own History tab (the people history), under More with Activity (every change)
export const REQ_MORE = ['client', 'agreement', 'history', 'activity', 'tools'];
export const reqTabKey = (k, all) => {
  const v = String(k || '').toLowerCase();
  const to = REQ_TAB_ALIAS[v] || v;
  return all.includes(to) ? to : null;
};

// ---- Remember the last tab per person (a blocked store never breaks a page) --
const keyOf = (scope, uid) => `tl.tab.${scope}.${uid || 'anon'}`;
export function lastTab(scope, uid) {
  try { return localStorage.getItem(keyOf(scope, uid)) || ''; } catch { return ''; }
}
export function rememberTab(scope, uid, tab) {
  try { if (tab) localStorage.setItem(keyOf(scope, uid), String(tab)); } catch { /* not remembered */ }
}
