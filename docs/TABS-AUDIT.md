# Tabs audit: Candidates & Pipeline, the Candidate page, the requirement page

Founder, 2026-11-20: "In Candidates & Pipeline there are many tabs. It must be clear what each tab is used for. It is very confusing. Keep only the tabs that are really necessary." Then, on seeing the whole page: "This page looks too clumsy. Please make it simple to see."

Rules used for every verdict: KEEP = necessary, a main tab. MORE = rarely used, moved under a "More" menu (nothing deleted). MERGE = shows the same kind of thing as another tab, folded into it. REMOVE = only if it shows nothing another tab does not show (none needed removing: no tab held data that another did not).
Row counts are from the sandbox copy used by the tests (3,910 people, 4,549 applications, 860 requirements, 38 notes, 3 documents, 4,753 follow-up rows); a login sees its own scope.

All old links keep working: the mapping is in `frontend/src/utils/tabMap.js`.

## A. Candidates & Pipeline (the list screen)

### Main tabs

| Before | What it shows | Who uses it | Duplicate? | Rows (sandbox, admin) | Verdict | After |
|---|---|---|---|---|---|---|
| Requirement applications | one row per person + requirement | all internal roles | the Active/All status tabs are filters of it | 4,549 | KEEP | **Requirement applications** (main tab 2) |
| (chip) Needs my action | the pipeline filtered to applications waiting on this login | Recruiter, TL, BDE (daily) | same rows as Requirement applications, filtered | per login | KEEP, made a tab: it is the work to do now | **Needs my action** (main tab 1, count scoped to the login) |
| People | one row per person, however many applications | Admin, Manager, TL, Recruiter | none (different grain) | 3,910 | KEEP | **People** (main tab 3) |
| New from job portal | pre-ATS screening, ends with "Send to ATS" | login that may see portal applications | none | portal queue | KEEP (shown only to logins that may see it) | **New from job portal** (main tab 4) |
| Duplicates | people who look like someone on file; each waits at step 1 | recruiting side, Admin | none | waiting count | MORE | More > Duplicates (waiting count on the More button) |
| Sources | how many people came from each source, by day / week / month | Admin, TL, Manager (analysis) | the "by source" panel in Insights shows the top five | n/a | MORE | More > Sources |
| Contact lists | company contact lists, WhatsApp the requirement, replies | logins allowed to broadcast | none | 0 in sandbox | MORE | More > Contact lists |

Result: 4 main tabs + More (3 items). Same order and names for every role; a login that may not use a tab does not see it (a client or candidate login has no Needs my action, Sources or Contact lists). Each tab has a `title` tooltip and the caption line under the strip changes with the open tab.

### Status strip (was the second tab row, the KPI tiles and the pipeline chart as navigation)

| Before | Verdict | After |
|---|---|---|
| Sub-tabs All, Active, Hold, Selected, Joined, Rejected (counts) | KEEP | one status strip: **All · Active · On hold · Selected · Joined · Rejected**, each with its count |
| Chips Needs my action, Late, Due today, Interviews today | Needs my action became the main tab; the others KEEP | "Show:" chips **Late · Due today · Interviews today · Interview done, no feedback** |
| 7 KPI tiles (Applications, Active, Joined, Interviews today, Interview done no feedback, Rejected, On hold) | MERGE: every number is in the strip or the chips | Insights (closed) still draws the tiles |
| "Candidate pipeline" step chart | MOVE | Insights; the step view stays as the **Progress board** toggle |
| People sub-tabs All people, Inactive, Archived | KEEP (three, each a different list; Archived only for those who may archive) | unchanged, no caption line |

### The rest of the page

| Before | Verdict | After |
|---|---|---|
| 9 header buttons (duplicates waiting, Templates & campaigns, New, Add candidate, Import, Export, Template, Approvals & history, Saved filters, Verify) | MOVE all but two | **+ Add candidate**, **Import**, and one **More** menu: Duplicates, New people (last 7 days), Verify, Templates & campaigns, Export, Template, Approvals & history, Saved filters |
| Green banner "N added in the last 7 days, not on a requirement yet" with a list of 8 | MOVE | one chip beside the search, opens the same list |
| Filter bar + "Filters (n)" panel + right-hand Filters box (same filters three times) | MERGE | one filter bar: Current location, Specialization, Current CTC, Experience, Stage; everything else (Expected CTC, Notice, Department, Recruiter / BDE, Added date, Came on, Joined between, Designation, Salary fit, Last contact, Rejected before / by, Hiring type, Team lead, Follow-up, Expected salary, Fit, Show only, ...) under **More filters**; a filter set by an old link or a saved filter is drawn there while it is on and is always a chip |
| Needs attention, Top requirements, Quick actions, Candidate insights donut, Hiring funnel, by location, by source, by client | MOVE | one **Insights** section under the table, closed by default, remembered per person |
| Table: 9 columns incl. Joining date, horizontal scroll | MERGE | Simple view (default): Name + role/client, Source + came-on, Phone, Experience, Salary, Step, Next step (7) + the Contact buttons. **Full view** (one click, remembered per person) is the old table with every column; the **Columns** menu is in both (picking a column opens the Full view). On the Joined status the Joining date takes Source's place (still 7) |

Other sidebar entries named in the brief (People, Sources, Talent pool, Track lists, Good fit): the sidebar has only "Candidates & Pipeline". People, Sources and Duplicates are its tabs. "Talent pool" is the "Available for matching" count (People view / Insights). "Good fit" is a tab on the requirement page (see C). There are no separate Track lists tabs on this screen.

## B. Candidate page and drawer

| Before | What it shows | Who uses it | Duplicate? | Verdict | After |
|---|---|---|---|---|---|
| Overview | profile, applications and their steps, interviews, offers, joining, fit | everyone | holds what used to be Applications, Pipeline, Interviews, Submissions, Offers, Joining, Fit | KEEP | **Overview** |
| Resume | the CV, versions, facts read from it | internal, client | none | KEEP | **Resume** |
| Career | education, jobs, gaps, progression, tags, custom fields | internal only | none | KEEP | **Career** |
| Notes | internal notes | internal only | same purpose as Follow-ups (what we said / what is next) | MERGE | **Follow-ups & notes** (follow-up log, then the notes). `?tab=notes` lands here |
| Follow-ups | dated follow-up log | internal only | see Notes | MERGE | same tab |
| Documents | documents on file | everyone with access | none | KEEP | **Documents** |
| Timeline | steps, interviews, messages, calls, changes | everyone with access (a client sees steps only) | overlaps Conversation's read side | KEEP, renamed | **History** (`?tab=timeline`, `?tab=activity` land here) |
| Conversation | call / mail / WhatsApp / SMS with a reply box | logins that may contact the person | History lists the same messages read-only; this tab is the one that can reply | MORE | More > **Conversation** |
| Schedule a message (added on main 2026-11-20) | write a WhatsApp / SMS / email now, send it later; the scheduled reminders | internal logins | none | MORE | More > **Schedule a message** (`?tab=scheduled`) |
| AI Calling | AI calls to this person, Call button | logins that may contact the person | none | MORE | More > **AI Calling** |

Career (education, jobs, gaps, tags) moved under More as well, so that five tabs are on screen (`?tab=career` still opens it).

Result: 5 main tabs (Overview, Resume, Follow-ups & notes, Documents, History) + More (Career, Conversation, Schedule a message, AI Calling). A client or candidate login sees Overview, Resume, Documents, History (as today). A BDE, BDE TL or Accounts login (who may not contact people) sees neither Conversation nor AI Calling; a link to them lands on Overview. Counts: Follow-ups & notes shows the note count, Documents the document count. Opens on the last tab the login used (Overview the first time).

## C. Requirement page (the requirement's pipeline)

| Before | What it shows | Who uses it | Duplicate? | Verdict | After |
|---|---|---|---|---|---|
| Overview | status, team, people nearby, next things | all | none | KEEP | **Overview** |
| Candidates | people in process (Show filter: All, Active, Shortlisted, Interview, Selected, Joined, Hold, Rejected), "Good fit" matches | recruiters, TL, BDE | none | KEEP | **Candidates** (count) |
| Team | team lead, recruiters, client manager; change team | TL, Admin | none | KEEP | **Team** |
| Interviews | client and recruitment interviews | recruiter, BDE | the global Interview calendar is the cross-requirement view | KEEP | **Interviews** (count) |
| Postings | job portal, job sites, tracked links, posting status | recruiters, Admin | none | KEEP | **Postings** |
| Client | client contact | client desk, internal | none | MORE | More > Client (hidden for a login without client-contact rights) |
| Agreement | client agreement status | client desk | none | MORE | More > Agreement (hidden when not applicable) |
| History (added on main 2026-11-20) | the people history: shared, selected, joined, dropped, with dates | TL, BDE, Admin (search and history links open it) | none | MORE | More > History (`?tab=history`, the search bar's and the history drawer's links) |
| Activity | every change to the requirement | Admin, TL | none | MORE | More > Activity |
| Inside Candidates: Good fit / Rejected before, good fit / Rejected on this requirement | three lists of different people | recruiters | none | KEEP, tooltip added to each | unchanged |

Result: 5 main tabs + More (Client, Agreement, History, Activity). `?tab=team`, `?tab=postings`, `?tab=history` and the old `#pipeline` / `#matching` anchors land on the right tab. Opens on the last tab the login used.

## D. Defaults per role (Candidates & Pipeline)

Recruiter: Needs my action. TL: Requirement applications (their team's). BDE: Requirement applications (their clients' submissions, scoped by the server). Admin / Manager: People (everyone). The last tab used wins when the address names none.

## E. Every other ATS tab strip (the same rule: at most five on screen, the rest under More, a tooltip on each, one caption line)

Every strip below is drawn by the one `components/ui/TabStrip.jsx`; `StatusTabs` (ListPageHeader.jsx) moves anything after the fifth tab under More by itself (a tab keyed `all` stays on screen). Each tab keeps its key or its address, so old links still open it.

| Screen | Visible | Under More |
|---|---|---|
| Clients & Requirements bar | Clients · Requirements · Agreements | (none) |
| Reports & Team bar | Reports (or My Results) · Team · Call lists | Handover · Data quality (only for logins that have them) |
| Interview Calendar bar | Interviews · Feedback · Offers · Joining | (none) |
| Client page | Details & Agreement · Requirements · Performance · Client work · Follow-ups | History (`?tab=history`) |
| Requirements list views | Super Admin: All · Open · Closed · Needs a TL · Needs a recruiter (five). Admin / Manager / STL (six): All · Open · Needs a TL · Needs a recruiter | Admin / Manager / STL: Closed · My Requirements. TL / BDE / Recruiter have 2-4 views, all visible |
| Requirements / Duplicate requirements / Posting | all three | (none) |
| Offers steps | Waiting for the client's letter · Ready to share · To prepare · Waiting for approval · All | Waiting for candidate · Accepted (only when they hold rows: empty steps are hidden as before) |
| Joining | Waiting to join and joined · Joined and dropped; then Waiting to join · Joined · Left / did not join · All | (none) |
| Team sections | People & Workload · Assignments · Tasks · Follow-ups | Pending work · Follow-up history · Departments & teams (when there are more than five) |
| Follow-ups | Follow-ups · Inbox · WhatsApp chats · Follow-up report | (none) |
| Job portal screening (New from job portal) | All · New · AI interview done · Check by recruiter · Sent to ATS | Resume checked · AI interview sent · Rejected (empty ones hidden as before) |
| Interview kind, Duplicates | unchanged (2-5 tabs), caption added | (none) |

The status strip on Candidates & Pipeline (All · Active · On hold · Selected · Joined · Rejected, each with its count) is the one count strip the founder asked for, not a set of screens; it keeps its six counts.
