// ---------------------------------------------------------------------------
// APP VERSION AND RELEASE NOTES (ATS audit 2026-11-18, Q16).
//
//   GET /api/version        { version, releasedAt, apiVersion, notes: [{ version, date, title, items[] }] }   (no sign-in needed: it names no data)
//   every API answer carries   X-TeamLink-Version: <version>   and   X-TeamLink-Api: v1
//   /api/v1/...             is the SAME API as /api/... (so an outside system can pin to v1 now; a later breaking change becomes /api/v2).
//   The browser shows the version in the footer and "What's new" lists the notes below.
//
// WHEN YOU SHIP SOMETHING PEOPLE WILL NOTICE: add one entry at the TOP of NOTES (newest first) and raise `version`. Semantic versioning:
// the first number for a change that breaks something outside, the second for a new feature, the third for a fix.
// ---------------------------------------------------------------------------
const API_VERSION = 'v1';

const NOTES = [
  {
    version: '1.7.4', date: '2026-11-20', title: 'Schedule a message, and history filters',
    items: [
      'Candidate page, new tab "Schedule a message": write any message, choose WhatsApp, SMS or Email and the time (In 1 hour, Today 5 PM, Tomorrow 10 AM or a date). Ready messages and {name} / {requirement} / {client} fill-ins; the list shows Scheduled (edit, cancel), Sent, Failed (with the reason, Send again) and Cancelled, and the automatic interview / joining reminders of the person.',
      'A message is sent only between 07:00 and 20:00 India time, never to someone who asked to stop; WhatsApp outside the 24-hour window goes through the approved general template. A message you schedule goes even while the automatic reminders are switched off.',
      'Team and recruiter history: Recruiter, Client, Requirement and Status filters (tick several), Clear all; every number and list follows.',
    ],
  },
  {
    version: '1.7.3', date: '2026-11-20', title: 'Overall report for team leads and the Super Admin',
    items: [
      'Dashboard: an "Overall report" button. A team lead sees their team, one row per recruiter (follow-ups added and done, calls and messages, overdue) and the team overall; View on a recruiter shows the candidates they added and every follow-up with what was written, for Today, Yesterday, This week, This month or any dates.',
      'The Super Admin sees the team leads first (recruiters and team numbers), a team lead opens that team, a recruiter their own report.',
      'Super Admin and developer logins no longer see "Carried over from yesterday" and "My end-of-day report".',
    ],
  },
  {
    version: '1.7.2', date: '2026-11-20', title: 'Change team lead: Education only, never an empty list',
    items: [
      'Change team lead is for the Education teams (Team A and Team B) only; other departments do not show the button.',
      'Its list always has the team leads of both Education teams, including a team lead whose seat end date has passed but who still works.',
      'A team lead on notice period is no longer shown as "(left)" on the candidate page; only someone relieved or exited is.',
    ],
  },
  {
    version: '1.7.1', date: '2026-11-20', title: 'Checkbox filters on the dashboard, reports, history and search',
    items: [
      'Department, Client, Recruiter / BDE and Team lead on the ATS dashboard, and the pickers on Candidates, Requirements, the Team page, Follow-ups, Offers / Joinings, History, Reports and Search take several values (tick boxes). Numbers, lists and the Excel download follow.',
      'Date ranges work for team lead and recruiter logins on every list.',
    ],
  },
  {
    version: '1.7.0', date: '2026-11-20', title: 'One search bar, history in a side panel, follow-up report',
    items: [
      'A search bar on every dashboard: type a recruiter, team lead, client, requirement or candidate; the complete history opens in a side panel over the page. A client, requirement, recruiter or team lead search also lists their candidates. Each login finds only what it may see. The old top-bar search box is removed.',
      'Follow-up report: a team lead reads every recruiter\'s daily, weekly and monthly follow-ups in one place (Follow-ups page and the Overall report); a recruiter only their own.',
      'Education: "Team A joinings" and "Team B joinings" cards on both team leads\' dashboards.',
      'Replacements: the drop and the replacement show who replaced whom. A person who left after joining is never counted as Joined, even for a moment.',
      'Reminders to the candidate before an offline interview or a joining (2 days, 1 day, the morning): the recruiter and team lead set the times; they show on the dashboard. Sending stays off until an Admin switches it on (Administration > Step timing).',
    ],
  },
  {
    version: '1.6.8', date: '2026-11-20', title: 'Month by month: a More months button',
    items: [
      'The Joinings, drops & replacements month-by-month box now keeps every month that has a number (up to 24). It shows the first six; "More months (N)" shows the rest and "Show fewer months" closes them.',
    ],
  },
  {
    version: '1.6.7', date: '2026-11-20', title: 'Imported candidates keep the date they really came',
    items: [
      'Import: "These people came on" - the date column of the sheet (found by name, or chosen in "Which column is which"), one date for every row, or today. Many date formats are read (12/03/2026, 12-Mar-26, Excel dates...). Future dates and dates before 2000 are refused with a reason.',
      'The date sets the added date, the first application and its first step, so lists, Sources and reports show the real month.',
      'People imported without a date show "Imported on <date> (original date not known)" instead of looking as if they came that day.',
      'Fix came-on dates from a sheet (Import, for Admin / Manager / TL): upload candidate ID, e-mail or phone with the real date, check the preview, apply. A batch can be undone.',
    ],
  },
  {
    version: '1.6.6', date: '2026-11-20', title: 'Resume reading and candidate data checks',
    items: [
      'One reader for single and bulk uploads: current and expected CTC, notice period, each job and degree, languages, address, native place, marital status, father name, RTF files, skills grouped.',
      'Every read value shows Sure / Likely / Not sure. Doubtful values (age, experience, salary, dates, two different salaries, name mismatch) go to a Verify list for the team lead; the person is still saved and marked "Needs verification".',
      'Changing a salary or experience that is already on a profile asks for a reason. Stale profile data is listed. Fit score changes keep a history. JD match compares the whole job description with the resume.',
      'ID documents (Aadhaar, PAN, passport) open only for allowed roles; every open is logged.',
      'A person who comes back is shown with their earlier applications and joinings; an Admin or team lead can confirm "reapply".',
    ],
  },
  {
    version: '1.6.5', date: '2026-11-20', title: 'Filters, search and date ranges',
    items: [
      'Candidates, Pipeline and People: current and expected CTC, experience, notice period, location, specialization, skills (any / all), education, tags, source, owner, client, requirement, and date ranges (added, updated, last contacted, shared with client). Chips, Clear all, and the filters stay in the address.',
      'Requirements, Clients, Interviews, Offers, Joinings, Follow-ups, Job Portal and Call lists have their own filters and a search box. When a filter or search is on, the list searches all time and says "Showing all time".',
      'Team page: search by name, code, seat or section; filters for department, section, team lead, status, location, performance and target; a date range ("Results for") changes the numbers to that period.',
      'The Excel download follows the filters. People without salary or contact rights get no salary or location filters.',
    ],
  },
  {
    version: '1.6.4', date: '2026-11-20', title: 'Complete history: requirement, client, recruiter, TL and candidate',
    items: [
      'One search box (ATS Search) finds recruiters, team leads, clients, requirements and candidates as you type and opens their complete history.',
      'Requirement and Client history: how many profiles were shared, shortlisted, interviewed, selected, offered, joined and dropped, with dates; every candidate with their dates, the drop reason and who dropped them; a timeline; Excel.',
      'Recruiter and TL history: department, requirements handled, the funnel, and a day / week / month table (profiles added, sent, interviews, selected, offers, joined, dropped, follow-ups); a TL page adds every member and the team total.',
      'Candidate history: all applications, how many were selected, rejected, offered, joined or dropped (with reasons), and one timeline of everything. It is also the History tab on the candidate page.',
    ],
  },
  {
    version: '1.6.3', date: '2026-11-20', title: 'Change team lead',
    items: [
      'Candidate page, "Who is on this": a Change team lead button beside Change recruiter. Choose the new team lead and a recruiter in that team, give the reason, save.',
      'The old and the new team lead (and the STL above each) get a notice; the change is in the history and the audit log. The earlier recruiter keeps no credit, as with Change recruiter.',
    ],
  },
  {
    version: '1.6.2', date: '2026-11-20', title: 'The candidate page says Dropped after a drop',
    items: [
      'After a drop the candidate page shows Dropped (with the day and the reason) in the Current step, Step, Current stage and Next step - not Joined - and no longer sends people to Raise Invoice / Track Guarantee.',
      'The Record the drop button shows only when no drop is recorded yet.',
    ],
  },
  {
    version: '1.6.1', date: '2026-11-19', title: 'Joined and Dropped: one rule everywhere',
    items: [
      'A person who left after joining leaves every Joined list and number (dashboard card and list, month table, My results, Daily report, Results vs target, the HRMS figure, client history) and shows only under Dropped. Withdrawing a drop brings them back.',
      'The Joined card says "Still working: N" and "N left after joining". An Admin switch (Joinings and drops) can count them as Joined again; it is off.',
      'Choosing Dropped in the Status / Roll status dropdown now opens the drop window (day and reason); the dropdown can no longer say Dropped without a recorded drop.',
      'The drop window starts with an empty day ("The day they actually left") and no default reason. A filter "Same day and same reason (check)" lists drops that may have been saved with defaults, for correction.',
    ],
  },
  {
    version: '1.6.0', date: '2026-11-19', title: 'Interviews, offers, clients and billing',
    items: [
      'Interviews have rounds (technical, HR, management), each with its own feedback and a suggested decision; notes, files and links per round; an average rating per interviewer; one combined calendar of interviews, joinings, follow-ups and tasks.',
      'Offers: several offer templates and a salary breakup that always adds up to the CTC. Counter-offers and background checks are recorded.',
      'Clients: unlimited contacts with roles (HR, HOD, Dean, Principal...), several positions in one requirement, credit days and credit limit, optional client approval of a requirement, agreement renewals.',
      'Billing: fixed and slab fees, overdue reminders to the BDE, payment approval (optional), client profitability, freelancer report, Tally and Zoho receipts. Everything that notifies people ships switched off (Administration > Pipeline & checks > Clients, billing and renewals).',
    ],
  },
  {
    version: '1.5.6', date: '2026-11-18', title: 'Stages, requirements, resumes and fairness',
    items: [
      'Admin can rename any stage and add sub-stages (Company Setup > Pipeline). A requirement request can be rejected with a reason and sent again. A checklist (resume, CTC, notice period, consent, contact verified) is needed before a profile goes to the client.',
      'Candidates: Career tab (several degrees and jobs, gaps, career growth, standard titles, tags, custom fields); AND / OR / NOT search; compare candidates; shared filters; interview clash warning; follow-ups handed to the team lead on leave.',
      'Scanned and photo resumes are read (English, Telugu, Hindi). One Joined number on the card, the list, the reports and the HRMS figure.',
      'Surveys, NPS, complaints, client health and retention reports (automatic sending is off until switched on); an AI fairness test; a dashboard you can rearrange (Customise).',
    ],
  },
  {
    version: '1.5.5', date: '2026-11-18', title: 'Dropped candidates no longer show as Joined',
    items: [
      'A candidate who joined and then dropped (Joining & Drop) now shows as Dropped in Candidates & Pipeline, the People list, the Progress board and the candidate page, and is counted under Rejected, not Joined. The joining record, guarantee and invoice keep reading the Joined step as before.',
      'Drops recorded earlier are picked up automatically when the server starts.',
      'The BDE Agent button now appears only while ATS is open (BDE, BDE TL, Super Admin and Developer logins only).',
    ],
  },
  {
    version: '1.5.4', date: '2026-11-18', title: 'Add Candidate: Profile received on',
    items: [
      'Add Candidate has a new "Profile received on" date (Where from section). A profile that reached you earlier, say in October, keeps that date as its added date. Leave it empty for today; a future date is not accepted.',
    ],
  },
  {
    version: '1.5.3', date: '2026-11-18', title: 'Candidate, Clients and Board lists stay fast with many people',
    items: [
      'Page 2, page 3, a refresh, or a second person opening the same view no longer re-counts every candidate: the filter, the tab counts and the sort are worked out once and reused for a few seconds.',
      'Clients, Requirements and the Progress board reuse their answer for 10 seconds, and are rebuilt at once after anyone saves a change.',
      'Load test with 100,000 candidates and 100 people at once: 14 requests a second (was 2), no errors, a typical click answers in about 2 seconds (was about 40).',
    ],
  },
  {
    version: '1.5.2', date: '2026-11-18', title: 'Bulk resume upload is much faster',
    items: [
      'Uploading resumes no longer rebuilds an index of every client, invoice and candidate for each file: with 100,000 candidates a resume took 1.8 s to check, now about 20 ms.',
    ],
  },
  {
    version: '1.5.1', date: '2026-11-18', title: 'Agents no longer time out',
    items: [
      'BDE Agent sends the model only what the question needs (exact counts always, details for the part you asked about), so answers stay inside the free AI limits and the candidate count is exact (it showed 1,500 because the list was capped).',
      'When the free AI plan is at its limit the agents wait the few seconds it asks, then try its smaller model, and always answer or explain within 40 seconds instead of ending in "TeamLink took too long".',
    ],
  },
  {
    version: '1.5.0', date: '2026-11-18', title: 'One pipeline per industry',
    items: [
      'Administration > Company Setup > Pipeline & checks > Industry pipelines: each department (Medical, Education, Manufacturing, IT ...) can switch off the steps it does not use, and a step can need a TL / STL / Manager / Admin to approve. Nothing changes until an Admin sets it.',
      'A candidate cannot be moved into a step its department does not use; the Move step list does not offer it. Anyone below the approval level who tries gets stopped and the approvers are told.',
      'The BDE Agent is now a button in the top bar (BDE, BDE TL, Super Admin and Developer logins), no longer floating over the page.',
    ],
  },
  {
    version: '1.4.0', date: '2026-11-18', title: 'Agents, audit fixes and webhooks',
    items: [
      'CRM Agent, CRM Meeting Agent (prep brief and notes to summary) and BDE Agent, answering from your own data through a free fast AI (Administration > Integrations > Fast AI).',
      'Resume reader: current CTC, expected CTC, notice period, RTF files, confidence per field, what is missing, and skills grouped as technical / soft / domain.',
      'AI Assistant finds candidates in plain words ("Find 10 Java developers in Hyderabad") and the best candidates for a requirement.',
      'A requirement put on hold or closed moves its active candidates to Hold and closes their follow-ups; reopening brings them back.',
      'Referral bonus is proposed automatically when a referred person joins (Referrals > Bonus rules).',
      'Candidate: professional registration (council, number, valid till, verification), alternate phone, native place, languages, super-specialisation, eligibility tests; hospital bed capacity on clients.',
      'Duplicate check also uses name + date of birth + qualification. Data quality lists wrong e-mails, phones and dates.',
      'Outgoing webhooks (Administration > Integrations > Webhooks): signed, retried, public https only.',
      'Every filter shows its overall count ("All departments (19)"). Filters are remembered when you leave a page and come back.',
      'Fixed: editing a candidate source no longer overwrites the first source.',
    ],
  },
];

const VERSION = NOTES[0].version;

// the response headers, for every request
function headers(req, res, next) {
  res.setHeader('X-TeamLink-Version', VERSION);
  res.setHeader('X-TeamLink-Api', API_VERSION);
  next();
}

// /api/v1/x -> /api/x (the same API under a version prefix an outside system can pin to)
function versionPrefix(req, res, next) {
  if (req.url === '/api/v1' || req.url.startsWith('/api/v1/') || req.url.startsWith('/api/v1?')) req.url = `/api${req.url.slice('/api/v1'.length)}`;
  next();
}

function info() {
  return { version: VERSION, releasedAt: NOTES[0].date, apiVersion: API_VERSION, notes: NOTES };
}

module.exports = { VERSION, API_VERSION, NOTES, headers, versionPrefix, info };
