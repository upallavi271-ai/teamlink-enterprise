# ATS list filters: audit (2026-11-18)

Founder: "recruiters hold many candidates, so every list needs filters: salary, location, specialization and so on."
This page says, for every ATS list screen, what filters it had before this change, and what was missing.
"Server" means the filter is applied by the list's API route (so it also drives counts and the Excel export);
"Browser" means the screen filters rows it already holds.

## Candidates (Candidate Master = one row per person, ATS Pipeline = one row per application)
Where: `backend/src/routes/candidates.js` (`rowMatches`, `pipelineRowMatches`, `pagedList`), facets in `backend/src/utils/atsFacets.js`
(`GET /api/ats-io/facets/candidates`), screen `frontend/src/pages/Candidates.jsx`.

Had (server): search (plain + boolean), location (exact, one), source (multi), came-on dates, joined-between dates, applied dates,
status, stage / step, follow-up status, department, hiring type, client, requirement, recruiter / TL / BDE (attribution),
qualification and specialisation (master ids), spec / qual / desig (profile words), experience bands, tag (ONE tag),
skills (every word must be present, pipeline only), min / max experience (pipeline only), notice period (exact text, pipeline only),
expected salary up to (pipeline only), fit at least, salary fit, owner, last contact, rejected before, reject side/reason,
not-followed-up days, available for matching, salary missing. Facet counts with the other filters applied, over the caller's scoped rows.

Wrong or missing:
- Tag counts (`GET /candidates/profile-tags`) were counted over the WHOLE database, not the rows the login may see.
- Tag filter took one tag only.
- No Current CTC or Expected CTC range (only "expected up to"), no CTC buckets.
- Experience min / max only in the pipeline view; People view had bands only.
- No Preferred location, no Native / hometown location (the column does not exist on main yet), current location was a single exact value.
- No Skills Any / All switch, no multi-select skills.
- Notice period was an exact text match, not buckets (Immediate, up to 15 / 30 / 60 / 90 days, Serving notice, Not specified).
- No Work mode, no Employment type.
- No Designation as standardised job title (the Career tab's title standardisation).
- No dates for Added, Last updated, Last contacted, Shared with client.
- No Resume yes / no, no Profile completeness range, no Duplicate suspected.
- Filters were not in the address bar except view / sub / source: Back from a candidate lost them; the Excel export did respect them.
- A BDE (limited view) could still use the old expected-salary and salary-fit filters, which read the pay a BDE may not see.
- Gender, age, date of birth, religion, caste, marital status: no filter exists anywhere (checked the list routes and the screen); none added.

## Requirement pipeline (the requirement's own candidate list, `RequirementDetail.jsx`)
Had: stage tabs, search, recruiter, source (client-side on the rows it holds). It is the same candidate rows as the pipeline view, so
it now gets the same filter params through the Candidates list (requirementId is fixed; the new filters work on it).
Missing: everything listed under Candidates.

## Requirements (`routes/requirements.js` `listWhere`, `Requirements.jsx`)
Had (server): search, department (multi), qualification, specialisation, title (designation), client / internal, client, location,
recruiter, TL, BDE, priority (multi), status (Open / Closed + display status), created from / to, deadline buckets, posted-on site
(any / none / site), agreement pending, closing this week, no candidates, unassigned, mine, role chips. Counts with cascading facets.
Missing: days open (range), openings left (filled < openings), CTC / salary range, industry (of the client), posted yes / no as a plain
switch, work mode.

## Clients (`routes/clients.js`, `Clients.jsx`; the whole list is loaded and filtered in the browser)
Had (browser): search, status, work status, industry, location (including places of requirements), client manager (BDE), agreement
status, agreement ending soon, has open requirements, unpaid invoices (finance roles), spec / qual / desig / experience.
Missing: priority, requirement count range, has joinings, and none of them was a server parameter (so the Excel export
could not carry them).

## Interviews (`/api/ats/calendar`, `InterviewCalendar.jsx`; rows held in the browser)
Had (browser): search, status, interview type / kind, hiring type, round, requirement, client, candidate, date (month + quick filters),
spec / qual / desig / experience.
Missing: date RANGE, interviewer, recruiter, mode (online / in person / phone); none server-side.

## Interview feedback, Offers, Joining (`utils/intJoinList.js`, paged on the server)
Had (server): search, department, client, job, recruiter, hiring type, status (feedback), spec / qual / desig / experience, tab view.
Missing:
- Offers: offer status, date range, CTC range, BGV status, counter-offer pending.
- Joining: joining date range, guarantee status, invoice status (only for roles that see invoices).
- Feedback: interview date range, interviewer, round.

## Follow-ups and tasks (`routes/followups.js`, `FollowUps.jsx`)
Had: status (Overdue, Due today, Upcoming, Completed), mine, role, client, method, step, due date (browser).
Missing: due buckets as a server param (today, overdue, this week), type, priority, owner, linked candidate / requirement.

## Call lists (`calllist/service.js`, `CallLists.jsx`)
Had: search of contacts and recruiters (browser). Missing: status, source, date, owner, location.

## Job Portal applications ("New from job portal", `Candidates.jsx` view `job-portal`, `JobPortalWorkspace`)
Had: the Candidates search only. Missing: status, source, date, owner, location. Now served by the candidate filter params
(the portal tab reads the same candidate list).

## Reports tables (`routes/atsReports.js`)
Had (server): range, department, client, requirement, recruiter / TL / STL / BDE, location, source, status, stage, interview status,
AI status, joining status, seat. Counts with cascading facets (`reportFacets`). Left as is: report tables are summaries; the
filter set covers the columns they group by.

## What was built
See the commit history of branch `r3-filters-1118`: candidate filter engine (`backend/src/utils/candidateFilters.js`), shared
`frontend/src/components/ats/FilterBar.jsx`, per-screen configs, server params on each list route, indexes, and
`backend/scripts/ats-filters-test.js`.
