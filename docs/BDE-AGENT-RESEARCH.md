# BDE Agent: what a BDE asks, where the answer lives, who may see it (2026-11-20)

A BDE (Business Development Executive) at an Indian recruitment / staffing firm owns a book of client accounts. Their day is:
morning agenda -> chase client feedback on shared profiles -> fix interviews -> push offers and joinings -> handle drops and
replacements inside the guarantee -> chase agreements and payments -> new business (CRM) -> report numbers to the BDE TL.
The questions below are the ones they ask all day. "Scope" is the login's own scope (`utils/scope.js`); nothing is widened.

| Question a BDE asks | Where the data lives | BDE may see |
|---|---|---|
| My clients (how many, list, by status / priority) | `Client` via `clientWhere` (owner BDE / second BDE / assigned / desk) | yes, own clients; BDE TL every client; Super Admin all |
| Client 360 ("tell me about Apollo") | `Client` + its `Requirement`s, `Application` funnel, `clientfu.*` follow-ups (`utils/clientBusiness.js`), `ClientCredit` (`utils/clientDepth.js`), `AtsComplaint` / `AtsSurvey` (`utils/atsExperience.js`) | yes (commercial terms are BDE-level per `clientRedact.js`); outstanding amount only for Super Admin / Admin / Accounts |
| Contacts and last contact | `Client.contactName/Designation/Phone/Email` (client contacts, not candidates), last done client follow-up | yes |
| Open requirements / requirement status | `Requirement` via `requirementWhere` (status OPEN, RECRUITER_ASSIGNED, SOURCING, CANDIDATES_AVAILABLE = live; DRAFT = request) | yes |
| Requirements with no profiles yet | `Requirement` x `Application` group-by inside `applicationWhere` | yes |
| Profiles shared this week / month | `ApplicationStageEvent` toStage `SHARED_WITH_CLIENT` in the period, application in scope | yes |
| Pending client feedback | `utils/clientWork.js bdePending`: sent with no reply (N days+), interview done no feedback, shortlisted with no interview | yes (names and steps only) |
| Interviews today / tomorrow / this week | `Application.interviewAt` (IST day), not cancelled | yes, candidate name + job + time only |
| Selections, offers, joinings | `ApplicationStageEvent` (Selected in period), `Application.stage/offerStatus`, joining day = `joiningDate` else `joinedAt`, stage Joined/Hired and not left (`atsVocab.leftAfterJoining`) | yes; never the offered CTC |
| Drops and replacements due within guarantee | `JoiningRecord` (`joindrop/schema.js`) status Dropped; due = `joindrop/replacement.js describe()` state DUE | yes, in `applicationWhere` |
| Invoices raised / paid / overdue | `Invoice` of the BDE's clients | number, status, due date, days late only (the `bdePending` "Invoices past due (info)" rule); amounts and pending money only for Super Admin / Admin / Accounts (`atsHistory.mayBilling`) |
| Agreement status / expiry / fee / guarantee | `Client.agreement*`, `feeType/feeAmount`, `guaranteePeriod`, `paymentTerms`; expiry windows as `clientDepth.statusOf` | yes |
| Credit days / limit | `ClientCredit` (`clientDepth.getCredit`) | days and limit yes; outstanding money no |
| Client health | last activity (stage events, client follow-ups) -> Active / No activity 30 days / Dormant (same rule as `routes/clients.js healthOf`) | yes |
| Complaints / NPS | `AtsComplaint` side client, `AtsSurvey` side client (answered), NPS = promoters - detractors | yes, own clients only |
| Today's agenda | interviews today + follow-ups due + feedback pending + joinings today + overdue invoices + agreements expiring in 7 days | yes |
| Follow-ups due | client follow-ups / meetings (`clientfu.*`, Open, due <= today), the BDE's own candidate chases (`ApplicationFollowUp.ownerUserId`), CRM follow-ups when on the sales team | yes |
| Target vs achieved | a BDE's "joining" is a NEW CLIENT whose agreement was signed in the month (`recruiterJoinings.js` BDE closings), target = the joinings target (default 4) | yes, own |
| CRM leads / deals | `CrmLead` / `CrmDeal` (`crm/service.js roleOf`) | only logins on the sales team (founder rule: BDEs are not CRM members) |
| "How do I ..." | process facts below | yes |

## Process facts the agent states
- A requirement starts in the client portal (or a BDE's "Request a requirement"): the client raises it -> it reaches the BDE -> the BDE TL ->
  the department TL ticks the response recipients and POSTS it. The TL posts, not the recruiter.
- Candidates reach a BDE only from "Check by client manager" (WITH_BDE) onward. A BDE sees a candidate in a LIMITED view: name and progress,
  never phone, e-mail, address, salary or ID documents, and never recruiter productivity pages.
- A requirement goes live only with an active agreement (or an unsigned approval). Invoices are raised by Accounts after joining.

## Accuracy and speed design (built)
1. An intent router in code (`utils/bdeAgentRouter.js`) answers the common questions instantly from exact database counts in the login's scope,
   with a link on every record. Names (client / requirement / candidate) are resolved with the one scoped search engine (`utils/atsSearch.js`:
   partial names, one-letter typos, Telugu script) and an in-memory match on the login's own client and requirement lists.
2. The fast model (`utils/fastAi.js`) is used only for open-ended questions; it gets a FACTS block built for that question (numbers computed by
   code), temperature 0.1, told to say "not in your data" instead of guessing, with a hard time limit. If it fails or is slow, the code answer
   is returned. Never a 500, never a blank.
3. Answers come in the language of the question (English, Telugu script, Telugu in English letters), numbers first, short.
4. Per-login cache 60 s, dropped early when the data stamp (applications, stage events, requirements, clients, invoices) changes.
