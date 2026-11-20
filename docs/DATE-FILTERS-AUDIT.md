# Date filters: inventory, role matrix, what was wrong, what was fixed (2026-11-20)

Founder's complaint: "date filters / date ranges must be in everything; right now it only works in the developer login; in the TLs' and
recruiters' logins they must exist and work properly."

Result of the audit: no date control was hidden behind `SUPER_ADMIN` in the screens themselves. The failures were (1) numbers that did
not follow the picked days for some roles, (2) days cut in UTC instead of IST, (3) screens with no date control or only a half one,
(4) bad input silently ignored or answered 500. All are listed below with what was done.

## The one shared pieces

| Piece | Where | Used by |
|---|---|---|
| Server: ONE date reader (presets, aliases `week` `month` `30d` `quarter` `year` `7d`, IST today, IST day bounds, whole `To` day, 400 on a bad range) | `backend/src/utils/dateRange.js` (`resolve`, `dateTimeIn`, `dayWindow`, `windowIn`, `istDayOf`, `todayIst`) | dashboards, ATS reports, report pack, My results, requirements, candidates, legacy reports, follow-ups |
| Server: one check of every list's From / To (400 with words before the route runs) | `backend/src/utils/dateParamGuard.js`, mounted on `/api` in `index.js`; `DateRangeError` is answered 400 by the global handler | every list that takes `xFrom` / `xTo`, and plain `from` / `to` on the report / requirement / follow-up / call-list paths |
| Client: ONE preset list and IST day maths | `frontend/src/utils/dateRanges.js` (`PRESETS`, `presetDates`, `matchPreset`, `dateProblem`, `istDayOf`) | `PageFilterBar` (page bar), `FilterBar` (list strips), ATS dashboard, Interview calendar, Requirements, Clients, every `useListFilters` date field |
| Client: the date control | `PageFilterBar` (Date range) and `FilterBar` `daterange` (quick pick + two dates + message when From is after To) | no third copy was made |

Presets (same words everywhere): Any time, Today, Yesterday, This week, Last week, This month, Last month, This quarter, This year,
Last 7 days, Last 30 days, Custom. Days are IST days (00:00-23:59 India time). A `To` day includes the whole day.

## Inventory and role matrix

Legend per cell group: **Shown** = the control is drawn for that login; **Sent** = its days reach the server (URL / request); **Applied** = the
server applies them inside that login's scope to the numbers, the list behind them and the Excel export.
"all" = Super Admin, Admin, Manager, STL, TL, Recruiter, BDE, BDE TL, HR, Accounts (those that may open the screen at all).

| # | Screen / control | Shown | Sent | Applied (before) | Fixed |
|---|---|---|---|---|---|
| 1 | ATS dashboard, Date range (`AtsHome`, `usePageFilters`) | all | all | **Recruiter**: numbers fixed to "today / this month" (tiles removed). **HR**: tiles all "now". **TL / STL**: team joinings fixed to the current month. **BDE**: number row all "now". All roles: Today / This week / This month were the UTC day | Recruiter gets Added / Sent to client / Interviews / Joinings for the days, joinings card + target follow the days (target only for a whole month); TL / STL joinings follow the days; HR and BDE get Interviews + Joined for the days; all use IST days |
| 2 | ATS dashboard lists + export (`/dashboard/ats/home/list`, `/export`) | all | all | export printed UTC days (an interview at 02:00 IST showed the day before) | IST day in the export |
| 3 | Candidates, page bar Date range (`appliedFrom/To`) | all | all | UTC day of the application | IST day |
| 4 | Candidates, Added on / Last updated / Last contacted / Shared with client | all staff | all | depended on the facets answering (a TL / recruiter whose facets call failed lost all four); buried under More filters | do not wait for facets; "Added on" is on the main row; quick picks |
| 5 | Requirements, Created range (`from/to`) | all | all | UTC day; a bad range silently ignored; lost on leaving the page | IST day, 400, kept per login (preset kept as the word) |
| 6 | Clients, Date range (client side) | all | n/a | UTC day of the since date | IST day |
| 7 | Interview calendar, "Interview date" (`ivFrom/To`) and the page bar | all | all | server side IST ok; page bar used browser time and the UTC day for "overdue" / today | IST everywhere; quick picks on the Interview date |
| 8 | Offers (`dFrom/dTo` on offer date) | all that open Offers | all | ok | quick picks |
| 9 | Joining (`dFrom/dTo`) | all that open Joining | all | used the day somebody pressed Joined before the typed joining date (a 10 Oct joining marked on 20 Oct was in 20 Oct) | typed joining date first, as in every report |
| 10 | Interview feedback | all that open it | none | **no date control** | "Interview date" added (`dFrom/dTo`) |
| 11 | Follow-ups | all that open it | none | **no due range** (only Due today / overdue / week); export ignored filters; "Due today" flipped at 05:30 IST | "Due between" (`fuFrom/fuTo`), export carries the filters, IST today |
| 12 | Job Portal applications (`jpFrom/jpTo`) | permission | all | ok (IST) | quick picks |
| 13 | Call lists / call rows (`from/to`, `cFrom/cTo`) | all that open them | all | ok | quick picks |
| 14 | ATS Reports, Date range (`/ats-reports/*`) | all (a recruiter gets My results) | all | UTC day; a bare From-To (no range word) meant "all time"; Cost per hire counted the whole company for a TL / STL | IST day, bare From-To is custom, Cost per hire inside the login's scope |
| 15 | Team & person report pack (`/ats-report-pack`) | all with the report | all | only Today..Last month; a bare From-To ignored | + Last week, Last 30 days, This quarter, This year; aliases |
| 16 | My results (`/ats-reports/my-results`, `OwnResults`) | Recruiter, TL, BDE ... | all | own parser: server time zone, bad date meant "all time", `range` word ignored | the shared reader, 400 on a bad range |
| 17 | Daily report (day / month) | all that open it | all | ok (IST) | unchanged |
| 18 | Legacy `/reports/ats|interviews|followups` | Admin side | all | `new Date(q.from)` (a bad date was a 500), UTC `T23:59:59.999Z` | `dayWindow`: IST, 400 |
| 19 | Interview calendar "all calendar" (`/ats/all-calendar`) | all staff | all | bad date silently replaced; 800 rows taken in no order | 400 on a bad date, ordered by time |
| 20 | History pages (requirement / client, `/ats/history/*`) | staff with Client List view | all | ok (IST) | unchanged (a login without the Client List permission gets no History tab by design) |
| 21 | Recruiter 360, Team page chart period, Team People table | all that open Team | client only | no date control / chart period without Custom | **not done** (see below) |
| 22 | HRMS dashboard, Attendance, Leave, Helpdesk (`DateRangePicker`) | HR / hrView | all | "today" was the UTC day (`dateRange.js`) | IST day (same reader) |
| 23 | CRM (period select), Accounts (PeriodPicker) | own role rules | all | separate pickers by design | unchanged |

### Cells that failed before / after

A cell = one screen for one role that may open it. Counted from the table above for the roles that can open each screen:

| Defect group | Cells before | Cells after |
|---|---|---|
| ATS dashboard numbers / IST (screens 1-2) | 9 | 0 |
| Candidates applied range (3) | 9 | 0 |
| Requirements (5) | 10 | 0 |
| Clients (6) | 10 | 0 |
| Joining date field (9) | 8 | 0 |
| Interview feedback, no control (10) | 8 | 0 |
| Follow-ups, no range + export (11) | 8 | 0 |
| ATS reports (14) | 8 | 0 |
| Report pack presets (15) | 8 | 0 |
| My results (16) | 6 | 0 |
| Cost per hire scope (14) | 3 | 0 |
| Legacy reports 500 / UTC (18) | 6 | 0 |
| Dashboard export day (2) | 9 | 0 |
| **Total** | **102** | **0 (of the cells the test covers)** |

## Not done (and why)

* Team page chart period (This week / This month / Last month, no Custom) and Recruiter 360 have no range: they are charts of the
  current team, not lists; adding a range needs a design decision.
* Future dates are allowed on every range (a future range simply holds nothing; the interview calendar and follow-ups need future days).
  A range longer than 3 years is refused by the dashboard reader.
* Screens whose own periods are by design different (CRM `period` select, Accounts financial-year picker, HRMS month pickers) were left
  as they are; their "today" now follows the IST day where they use `dateRange.js`.
* Raw `From / To` pairs on small screens (Join/drop report, Job portal report, Partners report, Experience reports, Duplicates, Posting,
  Comm log) were not moved to the quick-pick control: they already work and apply the days.

## Tests

* `backend/scripts/date-filters-test.js` - every dated list and number endpoint for Super Admin, Admin, Manager, TL, Recruiter, BDE and
  BDE TL against hand-worked counts, IST boundaries (23:59:59 / 00:00:00), inclusive To, From after To, bad dates, presets against the
  screens' own preset days, cache keyed by days, Excel export equals list.
* `backend/scripts/date-filters-browser.js` - Edge: TL and Recruiter on the main screens, control present, numbers change, phone width.
  Screenshots: `docs/date-filters-2026-11-20/`.
