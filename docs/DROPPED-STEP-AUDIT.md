# Dropped step audit (2026-11-20)

Founder: "when a drop is recorded, the candidate's profile STEP must also show Dropped."

The stage code stays `JOINED` / `HIRED` in the database (billing, the guarantee, incentives and history read it). Only what a screen,
file or message SAYS changes. One fact decides it everywhere: `utils/joinedRule.js` (the Joining & Drop record says Dropped), asked through
one helper:

- backend: `atsVocab.leftAfterJoining(app)`, `atsVocab.stepShown(app, normalWord)` (returns `Dropped`), `atsVocab.dropWords(appId)` ("Dropped on 12 Nov 2026 - Resigned"), `joinedRule.dropInfo(appId)`
- frontend: `atsVocab.isLeft(row)`, `stepOf(row)`, `stepClass(row)` (rows carry `left: true` / `leftAfterJoining: true` from the server)

The state is warmed at start and refreshed in the background after every drop, correction, withdrawal and replacement link
(`joinedRule.invalidate()`), so screens that read it synchronously are never stale.

## Places checked and fixed

| Place | Where | Result |
|---|---|---|
| Candidate page header "Current step", strip, application rows | `routes/candidates.js` detail (already live) | Dropped (kept) |
| Candidate drawer: Applications tab rows | `candidates.js decorate()` shaped applications, `Candidate360Tabs` Joining tab | Fixed: every application row carries `left` and `stageLabel: Dropped`; the Joining tab says Dropped with day and reason |
| Candidate drawer: Timeline labels | `candidates.js pipelineHistoryFor` | Fixed: the older "Left within / after the guarantee" rows read Dropped; a drop copied from the sheets gets a closing Dropped row; "Currently at" says Dropped |
| Application list inside the candidate page | detail applications + `ProfileTop` | Dropped (kept) + replacement chips |
| Candidates list (paged, master and pipeline), plain list used by exports | `candidates.js` (`decorate`, `buildPagedRows`, `buildPipelineRows`, `GET /`) | Fixed: step, group, detail say Dropped; `left`, day, reason; list caches keyed on `joinedRule.stateKey()` so a drop or a withdrawal shows at once |
| Duplicate panels / duplicate groups | `candidates.js`, `utils/candidateDupResolve.js`, `utils/applicationDup.js` | Fixed (`stepShown`) |
| Requirement pipeline (candidates on the job) | `routes/requirements.js GET /:id`, `RequirementDetail.jsx` (2 tables) | Fixed: Dropped with day and reason, chips |
| Requirement "candidate search: already on this job at step ..." | `requirements.js` | Fixed |
| Progress board columns | `candidatesBoard.js` reads the list rows | Dropped card in the closed column (card label Dropped) |
| Offers, Joining, Interviews, Feedback lists and the Interview calendar detail window | `routes/interviewsJoining.js shapeRowFull` (one shared row) + `Joining.jsx`, `InterviewCalendar.jsx` | Fixed: `stageLabel` Dropped, `left`, `dropNote`; the Joining chip says Dropped (was "Left after joining") |
| Team page, Recruiter page | `utils/teamWorkload.js shapeApp`, `routes/atsTeamTools.js` (compare) | Fixed |
| My results / Joined / Left lists, ATS home drill lists, drops lists | `utils/atsHome.js appRowOf` | Fixed: `step` and `stageLabel` Dropped, `dropNote`; Excel columns "Step", "Dropped (day and reason)" |
| Accounts lists (client account, invoices list, invoice rows) | `routes/invoices.js` flag (already), `Invoices.jsx`, `ClientAccountModal.jsx`, `ClientInvoiceRows.jsx` | Fixed: the tag now reads Dropped (was "Left after joining"); the invoice stays as it is |
| Client page lists (candidates, interviews, selected, joinings) | `routes/clients.js shapeApplication`, `ClientDetail.jsx` | Fixed; the Replacements card adds days to replace |
| Global search | `routes/atsExtras.js /search` | Fixed |
| ATS dashboard pipeline queue list | `routes/dashboard.js`, `Dashboard.jsx` | Fixed |
| Role dashboards, control tower lists, pipeline view | `utils/roleDashboard.js`, `controlTowerLists.js`, `pipelineView.js` | Fixed |
| Follow-ups list and follow-up detail | `routes/followups.js` | Fixed |
| Job portal applications list | `routes/jobPortal.js` (2 lists) | Fixed |
| History pages (requirement and client) | `utils/atsHistory.js` | Fixed: step "Dropped", status "Dropped (joined, then left)"; chips and the Replacement table; export columns "Replaced by", "Replacement for" |
| Reports: Stage grouping, stage views, Stage filter | `routes/reports.js`, `routes/atsReports.js` | Fixed: a "Dropped" group (and filter `Dropped`); "Joined" leaves the dropped out |
| Exports (candidates, interviews, offers, joining, followups, job portal, history, joinings and drops, dashboard lists) | `routes/atsIo.js`, `atsHome.exportTable`, `atsHistory.exportRow`, `joindrop/report.js` | Fixed: the Step / Stage column says Dropped; new columns "Replaced by" and "Replacement for" |
| Invoices export / Tally | stored invoice facts | Not changed on purpose: an invoice is a stored fact (it keeps its stage code); the Accounts screens show the Dropped tag |
| Client portal (candidate list, hires list, joined count) | `routes/portal.js` | Fixed: status Dropped for the client's own people; the Joined count leaves them out |
| Joining & Drop screens (panel, list, report, client portal list, client history) | `joindrop/*`, `components/joindrop/*` | Fixed / built (replacement names both ways) |
| Notification / email texts that quote the current step | `joindrop/notify.js` (join, decision, task cancelled carry "Replacement: A replaces B." / "Joined as the replacement for B ..."), AI assistant tools (`aiAgentTools`, `aiAgentReadTools`, `agentActions`, `ai/lib/entities`) | Fixed |
| Messages that quote the step AT THE TIME of a move (stage moves, auto messages) | `utils/autoMessages.js`, move notices | Not changed on purpose: they describe the move that happened ("moved to Joined"), which is history |
| History of moves (Pipeline history, requirement activity, audit) | `applicationStageEvent` | Not changed on purpose: "Joined" happened; the drop is its own line (Dropped, with day and reason) |
| Stage-count tiles in the dashboards | `utils/atsHome.js`, `recruiterJoinings.js` | Already leave the dropped out of Joined (joined rule); they are in Dropped |

## Recorded drop and withdrawal update everything at once

`joindrop/core.js update()` calls `joinedRule.invalidate()` for a drop, a correction, a withdrawal, a replacement link, a decision.
That forgets the joined/dropped state, the credited joinings, the ATS home boards and the team world, and refreshes the state in the background.
The Candidates lists (`ROW_MEMO`, `APP_ROW_MEMO`) include `joinedRule.stateKey()` in their key, so they rebuild on the next read.
