# ATS filters audit (2026-11-18)

Founder: "recruiters hold many candidates, so every ATS list needs its filters: salary, location, specialization and so on."
This file lists, per list screen, the filters that existed before this change and what was missing. "Added" = built in this change (branch r3-filters-1118).

How lists are filtered today (so the new filters follow the same rules):
- Candidates: the server keeps a scoped in-memory row set per login (`routes/candidates.js` `pipelineRowsFor` = one row per application, `pagedRowsFor` = one row per person). `pipelineRowMatches` / `rowMatches` filter it; `utils/atsFacets.js` counts options over the same rows (each filter's own value left out).
- Requirements: Prisma `listWhere()` in `routes/requirements.js`; facets in `atsFacets.js`.
- Offers, Joining, Interview Feedback: `utils/intJoinList.js` (lean rows, own facets).
- Follow-ups: `routes/followups.js` `buildList`. Clients: the whole list is sent and filtered in the browser. Interview Calendar: the whole list is sent and filtered in the browser. Call lists: `calllist/service`. Reports: `routes/atsReports.js` FILTER_KEYS.

| Screen | Filters before | Missing (the founder's list) | Added |
|---|---|---|---|
| Candidates, pipeline view (one row per application) | Search (plain + boolean), Department, Client, Requirement, Recruiter / TL / BDE, Step, Status, Location (one value), Source (multi), Came on dates, Joined between, Applied dates, Hiring type, Follow-up status, Skills (typed, all-of), Experience min/max (pipeline only), Experience band, Specialization, Qualification, Designation, Notice (exact text, pipeline only), Expected salary max (pipeline only), Fit % min, Salary fit, Owner, Last contact bucket, Rejected before / by / reason, Not-followed-up days, Tag (one tag), quick queues | Current CTC range, Expected CTC range (min AND max), Preferred location, Native location, Skills Any/All, Notice buckets, Work mode, Employment type, last-updated / last-contacted / shared-with-client / added date ranges, Resume yes/no, Profile completeness, Duplicate suspected, multi tags; tag counts were over the whole database; Experience range missing on People view | all of these (see below) |
| Candidates, People view (one row per person) | Search, Location, Source, Came on, Joined between, Applied dates, Qualification, Specialization, Designation, Experience band, Tag, Available for matching, Salary missing, Department, Client, Requirement, Hiring type | same as above | same filters, one definition for both views |
| Requirement pipeline (board on a requirement) | The Candidates filters through the page (client, requirement, step, status) | none beyond the candidate ones | gets the new candidate filters through the same query |
| Requirements | Search, Department/Section, Client, Location, Team lead, Recruiter, BDE, Priority, Status, Display status, Deadline, Type (client/internal), Qualification, Specialization, Designation, Posted on, Created from/to, Agreement, SLA overdue, My / Needs recruiter chips | Days open range, Openings left, CTC range, Industry, Posted-or-not yes/no as a simple switch | Days open, Openings left, CTC range (lakh), Industry, Posted yes/no, Work mode |
| Clients | Search, Status, Work status, Industry, Location, Client manager (BDE), Agreement, Qualification, Specialization, Designation; cards: Has open requirements, Unpaid invoices | Priority, Requirement count range, Has joinings, Agreement status as multi-select | Priority, Requirement count range, Has joinings (all via server params) |
| Interviews (calendar / list) | Search, Status, Type, Round, Hiring type, Client, Requirement, Candidate, Date/month, Step, Specialization, Qualification, Designation, Experience | Interviewer, Mode, Recruiter, explicit date range | Interviewer, Mode, Recruiter, Date range (server params on /ats/calendar) |
| Offers | Search, Offer step tabs, Department, Client, Requirement, Recruiter, Hiring type, Spec/Qual/Desig/Experience | Offer status, Date range, CTC range, BGV status, Counter-offer pending | all of these (server params on /ats/offers) |
| Joinings | Search, Joining view tabs, Department, Client, Requirement, Recruiter, Hiring type, Spec/Qual/Desig/Experience | Joining date range, Guarantee status, Invoice status (only for roles that see invoices) | all of these (server params on /ats/joining) |
| Interview feedback | Search, Status, Department, Client, Requirement, Recruiter, Hiring type, Spec/Qual/Desig/Experience | none asked | unchanged |
| Follow-ups and tasks | Status, Due date window, Step, Method, Role, Client, "mine" | Due bucket (today / overdue / this week), Type, Priority, Owner, linked candidate / requirement | Due bucket, Owner, Priority, Candidate, Requirement (server params on /followups) |
| Call lists | Search contacts, Search recruiters | Status, Source, Date, Owner, Location | Status, Source, Date range, Owner, Location (server params on call-list rows) |
| Job Portal applications ("New from job portal" view) | The Candidates filters (it is a view of the Candidates page) | Status, Source, Date, Owner, Location | covered by the new Candidates filters (Source, Location, Added date, Owner) |
| Reports tables | Department, Client, Requirement, Recruiter, TL, STL, BDE, Location, Source, Status, Stage, Interview/AI/Joining status, Period | none asked in this round | unchanged |

## Filters on gender, age, date of birth, religion, caste, marital status
None of these has a filter in the candidate lists and none was added (fairness rule, `scripts/ai-bias-test.js`). The new filter engine refuses these parameter names.

## Privacy rules kept
- CTC, phone and e-mail filters and counts exist only for logins that may see them (`privacyFlagsFor`: a BDE and any role without "Candidate Contact & Salary" get none; the server ignores those parameters).
- A BDE also gets no location, education, specialization-text, resume or completeness filters (their record view hides those fields).
- Facet counts are over the rows the login may see (recruiter = own candidates only), including tag counts.

## Not done / waiting
- Native / hometown location: the field is not on main yet (no `nativeLocation` column); the filter and counts read it as soon as the column exists.
- "Needs verification" flag and "Waiting on me" chips: not on main yet.
- Saved filters: the existing per-browser Saved filters component is used (no server-side mechanism on main yet).
