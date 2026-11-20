# Filters audit, every module (2026-11-18 ATS, 2026-11-20 all modules)

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

## Founder rules of 2026-11-20 (apply to every list)
1. WHOLE HISTORY: a search or any filter looks at ALL matching records across all time. The default windows (Offers / Joining / Interview Feedback: open work + last 90 days; Follow-ups: 30 days either side) are dropped for that query, the total is shown and the screen says "Showing all time". Without a filter the default view stays. Candidate, requirement and client lists have no date window.
2. Filters live in the address bar; chips with a cross; Clear all; option counts only over what the login may see; Excel / CSV export honours the active filters (existing export right and log).
3. Salary / CTC / amount range wherever a salary exists; location wherever a location exists.
4. No gender, age, date of birth, religion, caste or marital-status filter; a BDE or a role without Candidate Contact & Salary never gets pay, phone or e-mail filters, options or counts.

## Phase plan
- Phase 1 (this change): ATS lists: Candidates (pipeline + People), Requirements, Clients, Interviews, Offers, Joinings, Follow-ups, Job Portal applications, Call lists. Details in the table above.
- Phase 2: CRM, HRMS (employees, attendance, leave, payroll lists, exit), Accounts (invoices, payments).
- Phase 3: everything else in the scan below.

## Scan of every screen that draws a table (static scan of frontend/src, 2026-11-20)
This is a mechanical scan (a file counts as having a search box or a filter when its source has one); it is the work queue for phases 2 and 3 and must be checked screen by screen before each is changed. "Shared bar" = already uses the shared FilterBar (components/ats/FilterBar.jsx).
Totals: 321 files with a table; 193 without a search box; 109 without any filter control.

### ATS and Job Portal (28 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| components/applications/CompareCandidates.jsx | **no** | **no** | yes | yes | no |
| components/ats/OfferBgv.jsx | **no** | yes | yes | - | no |
| components/Candidate360Tabs.jsx | **no** | **no** | yes | - | no |
| components/candidates-v4/CandidatesV4.jsx | **no** | **no** | yes | - | no |
| components/jobs/RequirementReach.jsx | **no** | **no** | yes | yes | no |
| components/portal/JobMatchDialog.jsx | **no** | yes | - | yes | no |
| components/portal/JobPortalCandidates.jsx | yes | yes | yes | yes | yes |
| components/rejections/RequirementMatchTabs.jsx | **no** | yes | yes | yes | no |
| pages/ats/CallLists.jsx | yes | yes | - | yes | yes |
| pages/ats/ClientJobPortal.jsx | **no** | yes | - | yes | no |
| pages/ats/DataQuality.jsx | **no** | **no** | - | - | no |
| pages/ats/FollowUps.jsx | yes | yes | - | - | yes |
| pages/ats/FormerHistory.jsx | **no** | **no** | - | - | no |
| pages/ats/InterviewCalendar.jsx | yes | yes | yes | yes | yes |
| pages/ats/InterviewFeedback.jsx | **no** | **no** | yes | yes | no |
| pages/ats/Joining.jsx | **no** | yes | yes | yes | no |
| pages/ats/Offers.jsx | **no** | yes | yes | yes | no |
| pages/ats/RecruiterHandover.jsx | yes | yes | - | - | no |
| pages/ats/Team.jsx | yes | yes | yes | yes | no |
| pages/Candidates.jsx | yes | yes | yes | yes | yes |
| pages/ClientDetail.jsx | yes | yes | yes | yes | yes |
| pages/Clients.jsx | yes | yes | yes | yes | yes |
| pages/portal/ClientConcerns.jsx | **no** | **no** | - | - | no |
| pages/portal/ClientCreative.jsx | **no** | **no** | - | - | no |
| pages/portal/ClientJoinDrop.jsx | **no** | **no** | - | yes | no |
| pages/portal/ClientPortal.jsx | yes | yes | yes | yes | no |
| pages/RequirementDetail.jsx | **no** | yes | yes | yes | no |
| pages/Requirements.jsx | yes | yes | yes | yes | yes |

### Accounts, Bank and Assets (59 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| components/accounts/BillingTools.jsx | **no** | yes | yes | - | no |
| components/accounts/BooksImport.jsx | **no** | **no** | yes | - | no |
| components/accounts/FixedAssetImport.jsx | **no** | **no** | yes | - | no |
| components/accounts/FixedAssetsTab.jsx | yes | yes | yes | - | no |
| components/accounts/JournalTabs.jsx | yes | yes | yes | - | no |
| components/accounts/SalaryVoucherPanel.jsx | yes | yes | yes | - | no |
| components/accounts/ScrollSync.jsx | **no** | **no** | - | - | no |
| pages/accounts/dash/AccountsReminderSettings.jsx | yes | **no** | - | - | no |
| pages/accounts/dash/DataTable.jsx | yes | **no** | - | - | no |
| pages/accounts/dash/MoreTools.jsx | **no** | **no** | yes | - | no |
| pages/accounts/dash/ProofReminderAuto.jsx | **no** | **no** | - | - | no |
| pages/accounts/JournalLedger.jsx | yes | yes | yes | - | yes |
| pages/admin/VendorAssetGrants.jsx | yes | **no** | - | yes | no |
| pages/admin/VendorLoginActions.jsx | **no** | **no** | - | - | no |
| pages/admin/VendorLogins.jsx | yes | yes | - | yes | no |
| pages/admin/VendorManagement.jsx | yes | yes | yes | - | no |
| pages/Bank.jsx | yes | yes | yes | yes | yes |
| pages/bank/AutoRecon.jsx | yes | yes | yes | yes | no |
| pages/bank/BankStatements.jsx | **no** | yes | - | - | no |
| pages/bank/HandLoans.jsx | yes | yes | yes | - | yes |
| pages/bank/MatchPanel.jsx | **no** | yes | yes | yes | no |
| pages/bank/StatementView.jsx | **no** | **no** | yes | - | no |
| pages/bank/TxnDetail.jsx | **no** | yes | yes | yes | no |
| pages/bank/Unallocated.jsx | yes | yes | yes | yes | no |
| pages/crm/CrmInvoices.jsx | yes | yes | yes | - | no |
| pages/InvoiceDetail.jsx | **no** | yes | yes | yes | no |
| pages/Invoices.jsx | yes | yes | yes | yes | no |
| pages/invoices/ClientAccountModal.jsx | **no** | **no** | yes | - | no |
| pages/invoices/ClientGroups.jsx | **no** | **no** | yes | - | no |
| pages/invoices/ClientInvoiceRows.jsx | **no** | yes | yes | - | no |
| pages/invoices/CreditNotesPanel.jsx | yes | yes | yes | - | no |
| pages/invoices/GstInvoiceModal.jsx | **no** | **no** | yes | yes | no |
| pages/invoices/NoteModal.jsx | **no** | yes | yes | - | no |
| pages/invoices/PartnerPayoutsPanel.jsx | yes | yes | yes | - | no |
| pages/invoices/PaymentCheckPanel.jsx | yes | **no** | yes | - | no |
| pages/vendor/AirtelBills.jsx | yes | yes | yes | - | no |
| pages/vendor/AirtelHistory.jsx | yes | yes | yes | - | no |
| pages/vendor/AirtelSims.jsx | yes | yes | - | - | no |
| pages/vendor/AssetPortalAssets.jsx | yes | yes | yes | yes | no |
| pages/vendor/AssetPortalBillUploads.jsx | yes | yes | yes | - | no |
| pages/vendor/AssetPortalDashboard.jsx | **no** | **no** | - | - | no |
| pages/vendor/AssetPortalHistory.jsx | yes | yes | - | - | no |
| pages/vendor/AssetPortalInvoices.jsx | yes | yes | yes | yes | no |
| pages/vendor/AssetPortalOrders.jsx | yes | yes | yes | - | no |
| pages/vendor/AssetPortalRepairs.jsx | yes | yes | yes | - | no |
| pages/vendor/BillLineAssets.jsx | **no** | yes | yes | - | no |
| pages/vendor/IdCardDashboard.jsx | **no** | **no** | - | - | no |
| pages/vendor/IdCardRequests.jsx | yes | yes | - | yes | no |
| pages/vendor/VendorAssets.jsx | yes | yes | yes | yes | no |
| pages/vendor/VendorBankPayments.jsx | **no** | yes | yes | - | no |
| pages/vendor/VendorDashboard.jsx | **no** | **no** | yes | - | no |
| pages/vendor/VendorDocuments.jsx | **no** | **no** | - | - | no |
| pages/vendor/VendorIdCards.jsx | **no** | **no** | yes | - | no |
| pages/vendor/VendorInvoices.jsx | yes | yes | yes | - | no |
| pages/vendor/VendorIo.jsx | **no** | **no** | yes | - | no |
| pages/vendor/VendorMoney.jsx | **no** | yes | yes | - | no |
| pages/vendor/VendorPayments.jsx | yes | yes | yes | - | no |
| pages/vendor/VendorServices.jsx | **no** | **no** | yes | - | no |
| pages/vendor/VendorSim.jsx | yes | **no** | - | - | no |

### Admin (18 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| pages/admin/AtsAlertSettings.jsx | **no** | **no** | - | - | no |
| pages/admin/AuditLogs.jsx | yes | yes | - | - | yes |
| pages/admin/BiometricPanel.jsx | **no** | yes | - | - | no |
| pages/admin/CustomRoles.jsx | yes | yes | - | - | yes |
| pages/admin/HrSuperAccess.jsx | **no** | yes | - | - | no |
| pages/admin/Integrations.jsx | yes | yes | yes | yes | yes |
| pages/admin/InterviewReminderSettings.jsx | **no** | yes | yes | - | no |
| pages/admin/JoinDropSettings.jsx | **no** | yes | - | - | no |
| pages/admin/LoginAccounts.jsx | **no** | **no** | - | - | no |
| pages/admin/MessageTemplates.jsx | yes | yes | yes | - | no |
| pages/admin/Notifications.jsx | yes | yes | - | - | yes |
| pages/admin/Partners.jsx | **no** | yes | yes | - | no |
| pages/admin/PipelineSettings.jsx | **no** | yes | - | yes | no |
| pages/admin/PortalImportsPanel.jsx | yes | **no** | - | - | no |
| pages/admin/Positions.jsx | yes | yes | - | - | yes |
| pages/admin/RoleCatalog.jsx | yes | yes | yes | - | yes |
| pages/admin/SocialMedia.jsx | **no** | yes | yes | yes | no |
| pages/admin/Users.jsx | yes | yes | - | yes | yes |

### CRM, Marketing and Omni-Channel (70 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| components/aicalling/AiCallDetail.jsx | **no** | **no** | - | yes | no |
| components/aicalling/AiCallingAdmin.jsx | **no** | yes | - | - | no |
| components/aicalling/AiCallingPage.jsx | yes | yes | - | yes | no |
| components/aicalling/KavyaTab.jsx | yes | yes | yes | yes | no |
| components/omni/admin/BillingCompany.jsx | **no** | yes | yes | - | no |
| components/omni/admin/BillingMine.jsx | **no** | **no** | - | - | no |
| components/omni/admin/SetIntegrations.jsx | **no** | **no** | - | yes | no |
| components/omni/admin/SetOrg.jsx | **no** | yes | yes | - | no |
| components/omni/admin/TeamRoles.jsx | yes | **no** | - | - | no |
| components/omni/automation/AutoModals.jsx | **no** | **no** | - | yes | no |
| components/omni/automation/ScheduledTab.jsx | **no** | yes | - | - | no |
| components/omni/campaigns/CallTasks.jsx | yes | **no** | - | yes | no |
| components/omni/campaigns/CampaignDetail.jsx | **no** | yes | - | - | no |
| components/omni/campaigns/CampaignWizard.jsx | yes | yes | - | yes | no |
| components/omni/campaigns/MessageLogsModal.jsx | yes | yes | - | - | no |
| components/omni/console/RunModal.jsx | **no** | **no** | - | - | no |
| components/omni/crm/CustomerDetail.jsx | **no** | **no** | - | yes | no |
| components/omni/crm/ImportModal.jsx | **no** | yes | - | - | no |
| components/omni/crm/ImportsHistory.jsx | **no** | **no** | - | - | no |
| components/omni/external/parts.jsx | **no** | yes | yes | yes | no |
| components/omni/library/AppCampaignList.jsx | **no** | yes | - | - | no |
| components/omni/library/TemplateLibrary.jsx | **no** | yes | - | - | no |
| components/omni/marketing/PlansMeetingPage.jsx | **no** | **no** | yes | - | no |
| components/omni/overview/CommTab.jsx | **no** | **no** | - | yes | no |
| components/omni/overview/SocialTab.jsx | **no** | **no** | - | - | no |
| components/omni/pages/AiVoicePage.jsx | yes | yes | yes | yes | no |
| components/omni/pages/BotBuilderPage.jsx | **no** | **no** | - | - | no |
| components/omni/pages/BotDataPage.jsx | **no** | **no** | - | - | no |
| components/omni/pages/ConnectionsPage.jsx | **no** | **no** | - | - | no |
| components/omni/pages/ConsolePage.jsx | **no** | yes | - | yes | no |
| components/omni/pages/CrmFieldsPage.jsx | yes | yes | - | - | no |
| components/omni/pages/CustomersPage.jsx | yes | yes | - | yes | no |
| components/omni/pages/FormsPage.jsx | yes | yes | - | yes | no |
| components/omni/pages/MkReportsPage.jsx | **no** | yes | - | - | no |
| components/omni/pages/MkUsagePage.jsx | **no** | yes | - | - | no |
| components/omni/pages/OverviewPage.jsx | **no** | yes | - | - | no |
| components/omni/RepliesPanel.jsx | **no** | **no** | - | - | no |
| components/omni/templates/TemplateList.jsx | yes | yes | - | - | no |
| components/omni/ui.jsx | yes | yes | - | yes | no |
| components/outreach/Activity.jsx | **no** | **no** | - | - | no |
| components/outreach/Automations.jsx | **no** | yes | - | yes | no |
| components/outreach/Channels.jsx | **no** | **no** | - | - | no |
| components/outreach/Communication.jsx | **no** | yes | - | yes | no |
| components/outreach/ConfigHub.jsx | **no** | yes | - | - | no |
| components/outreach/Contacts.jsx | yes | yes | - | yes | no |
| components/outreach/Dashboard.jsx | **no** | **no** | - | - | no |
| components/outreach/Distribution.jsx | yes | **no** | - | - | no |
| components/outreach/HubTemplates.jsx | yes | yes | - | - | no |
| components/outreach/ImportHistory.jsx | **no** | **no** | - | - | no |
| components/outreach/ImportWizard.jsx | **no** | **no** | - | yes | no |
| components/outreach/Insights.jsx | **no** | yes | yes | - | no |
| components/outreach/MessageLog.jsx | yes | yes | - | - | no |
| components/outreach/OverviewReports.jsx | **no** | **no** | - | - | no |
| components/outreach/ScheduledMessages.jsx | **no** | yes | - | - | no |
| components/outreach/Settings.jsx | yes | yes | - | - | no |
| pages/admin/OmniChannelIntegrations.jsx | **no** | **no** | - | - | no |
| pages/admin/OmniGsAccess.jsx | **no** | **no** | - | - | no |
| pages/admin/OmniWhatsappMap.jsx | **no** | yes | - | - | no |
| pages/crm/CrmAccounts.jsx | yes | yes | - | yes | no |
| pages/crm/CrmCampaigns.jsx | **no** | yes | - | yes | no |
| pages/crm/CrmCharts.jsx | **no** | **no** | - | - | no |
| pages/crm/CrmDashboard.jsx | yes | yes | - | yes | no |
| pages/crm/CrmDeals.jsx | yes | yes | - | - | no |
| pages/crm/CrmFollowups.jsx | **no** | yes | - | yes | no |
| pages/crm/CrmLeads.jsx | yes | yes | yes | yes | no |
| pages/crm/CrmProducts.jsx | **no** | yes | yes | yes | no |
| pages/crm/CrmProductVideo.jsx | **no** | **no** | - | yes | no |
| pages/crm/CrmReports.jsx | **no** | yes | yes | yes | no |
| pages/crm/CrmReportTables.jsx | **no** | **no** | - | - | no |
| pages/crm/CrmSupport.jsx | yes | yes | - | - | no |

### HRMS (65 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| components/accounts/EmployeeSalaryTab.jsx | yes | **no** | yes | - | no |
| components/accounts/PayrollMonthDetail.jsx | yes | yes | yes | - | no |
| components/employees/EmployeeBulkImport.jsx | **no** | **no** | - | yes | no |
| components/employees/MissingLogins.jsx | **no** | **no** | - | - | no |
| components/employees/TlWiseView.jsx | yes | **no** | - | - | no |
| components/employees/TransferCard.jsx | **no** | yes | - | - | no |
| components/employees/TransferHistory.jsx | **no** | **no** | - | - | no |
| components/LeaveCoverCard.jsx | **no** | yes | - | - | no |
| components/payroll/CompliancePanel.jsx | yes | yes | yes | - | yes |
| components/payroll/PayrollEditHistory.jsx | **no** | **no** | yes | - | no |
| components/payroll/PayrollEditor.jsx | **no** | **no** | yes | - | no |
| components/payroll/PayrollRunBoard.jsx | yes | yes | yes | - | yes |
| components/payroll/PayslipView.jsx | **no** | **no** | yes | yes | no |
| pages/Attendance.jsx | yes | yes | - | yes | yes |
| pages/attendance/DashboardLists.jsx | yes | **no** | - | yes | no |
| pages/attendance/DayReport.jsx | **no** | yes | - | - | no |
| pages/attendance/FaceReview.jsx | **no** | **no** | - | - | no |
| pages/attendance/HistoryImport.jsx | yes | yes | - | yes | no |
| pages/attendance/KpiReport.jsx | yes | yes | - | - | no |
| pages/attendance/LatePermission.jsx | **no** | yes | - | - | no |
| pages/attendance/MonthCalendar.jsx | yes | yes | - | - | no |
| pages/attendance/MyAttendance.jsx | yes | yes | yes | yes | yes |
| pages/attendance/NotifySettings.jsx | **no** | **no** | - | - | no |
| pages/attendance/TeamAttendance.jsx | yes | yes | - | - | no |
| pages/EmployeeDetail.jsx | **no** | yes | - | yes | no |
| pages/Employees.jsx | yes | yes | - | yes | no |
| pages/hrms/AssetAccountsFields.jsx | **no** | yes | yes | - | no |
| pages/hrms/AssetReplacements.jsx | **no** | yes | - | - | no |
| pages/hrms/AssetReport.jsx | yes | yes | - | yes | no |
| pages/hrms/DashboardDrill.jsx | yes | yes | - | - | no |
| pages/hrms/Disciplinary.jsx | yes | yes | - | - | yes |
| pages/hrms/Documents.jsx | **no** | yes | - | - | yes |
| pages/hrms/EmployeeProgress.jsx | **no** | **no** | - | - | no |
| pages/hrms/ExitCenter.jsx | **no** | yes | yes | - | no |
| pages/hrms/IdCardOrders.jsx | yes | yes | yes | - | no |
| pages/hrms/IdeasBox.jsx | yes | yes | yes | - | no |
| pages/hrms/KT.jsx | **no** | yes | - | - | yes |
| pages/hrms/Lms.jsx | yes | yes | - | - | yes |
| pages/hrms/MyProfile.jsx | yes | yes | - | - | yes |
| pages/hrms/Nominations.jsx | yes | yes | yes | - | yes |
| pages/hrms/Performance.jsx | **no** | yes | - | - | yes |
| pages/hrms/RecruiterJoinings.jsx | yes | yes | yes | - | no |
| pages/hrms/SimConnections.jsx | yes | yes | - | - | no |
| pages/hrms/Stationery.jsx | yes | yes | yes | - | no |
| pages/hrms/Targets.jsx | **no** | yes | yes | - | yes |
| pages/hrms/Timesheet.jsx | yes | yes | yes | - | yes |
| pages/hrms/TimesheetChecklist.jsx | yes | yes | - | - | no |
| pages/hrms/TimesheetTasks.jsx | yes | yes | yes | yes | no |
| pages/Leave.jsx | **no** | yes | - | yes | yes |
| pages/leave/HolidaysTab.jsx | **no** | yes | - | yes | no |
| pages/leave/LeaveChainScreen.jsx | **no** | **no** | - | - | no |
| pages/leave/LeaveExtras.jsx | **no** | yes | - | yes | no |
| pages/leave/LeaveMonthWise.jsx | **no** | yes | - | - | no |
| pages/leave/PulseSyncTab.jsx | **no** | yes | - | - | no |
| pages/monitoring/EmployeeMonitoring.jsx | yes | yes | yes | - | no |
| pages/office/ExpenseLedger.jsx | **no** | **no** | yes | - | no |
| pages/office/GstPortalCompare.jsx | **no** | **no** | yes | - | no |
| pages/office/GstPosition.jsx | **no** | yes | yes | - | no |
| pages/office/Reminders.jsx | yes | yes | yes | - | yes |
| pages/office/VendorBillsReview.jsx | yes | yes | yes | - | no |
| pages/office/VendorBillUploadsReview.jsx | yes | yes | yes | - | no |
| pages/office/VendorListModal.jsx | yes | **no** | - | - | no |
| pages/office/VendorModuleBillsReview.jsx | **no** | yes | yes | - | no |
| pages/Payroll.jsx | yes | yes | yes | yes | yes |
| pages/payroll/Incentives.jsx | **no** | yes | yes | - | no |

### Other (69 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| components/AccountsImport.jsx | **no** | yes | yes | - | no |
| components/ActAsHistory.jsx | **no** | **no** | - | - | no |
| components/agreements/AgreementDocView.jsx | **no** | **no** | - | - | no |
| components/AiAssistant.jsx | **no** | **no** | - | yes | no |
| components/applications/AlreadyApplied.jsx | **no** | **no** | yes | yes | no |
| components/AtsImportDialog.jsx | **no** | yes | - | - | no |
| components/AtsIoHistory.jsx | **no** | **no** | - | - | no |
| components/automsg/AutomaticMessagesTab.jsx | **no** | yes | - | - | no |
| components/broadcast/CampaignResults.jsx | **no** | yes | yes | - | no |
| components/broadcast/ContactLists.jsx | yes | **no** | - | yes | no |
| components/candidate/CandidateSources.jsx | **no** | yes | yes | - | no |
| components/candidate/CareerProfile.jsx | **no** | yes | yes | - | no |
| components/CandidateReach.jsx | **no** | **no** | - | yes | no |
| components/charts/ChartCard.jsx | **no** | **no** | - | - | no |
| components/charts/kit.jsx | **no** | **no** | - | - | no |
| components/clients/FollowUpImport.jsx | **no** | yes | yes | yes | no |
| components/clients/Renewals.jsx | **no** | yes | - | - | no |
| components/comm/CommLog.jsx | yes | yes | - | - | no |
| components/comm/SmsPlatform.jsx | yes | yes | - | - | no |
| components/comm/WaNumbers.jsx | yes | yes | - | - | no |
| components/dashboard/ats-v4/AtsV4.jsx | **no** | **no** | yes | - | no |
| components/dashboard/AtsHome.jsx | **no** | yes | yes | yes | yes |
| components/dashboard/AtsHomeV3.jsx | **no** | **no** | yes | - | no |
| components/dashboard/ControlTower.jsx | yes | yes | yes | - | no |
| components/dashboard/HomeDrill.jsx | yes | yes | yes | - | no |
| components/dashboard/HomeSections.jsx | **no** | **no** | yes | - | no |
| components/dashboard/RoleBoard.jsx | **no** | **no** | yes | - | no |
| components/dashboard/Vacancies.jsx | **no** | **no** | - | - | no |
| components/dataio/DataIoBar.jsx | **no** | yes | - | - | no |
| components/dataio/ImportRequests.jsx | **no** | **no** | - | - | no |
| components/duplicates/DupCheckPanel.jsx | **no** | **no** | - | yes | no |
| components/followups/FollowUpRules.jsx | **no** | yes | - | - | no |
| components/jobdist/PostingTracker.jsx | yes | **no** | - | - | no |
| components/jobpublish/JobPortalsAdmin.jsx | **no** | yes | yes | yes | no |
| components/jobpublish/NaukriShineMailboxes.jsx | yes | yes | - | - | no |
| components/jobpublish/PostingDashboard.jsx | **no** | yes | - | - | no |
| components/jobpublish/PostingLogs.jsx | **no** | yes | - | - | no |
| components/jobpublish/PublishDiagnostics.jsx | **no** | **no** | - | - | no |
| components/joindrop/JdParts.jsx | **no** | yes | yes | yes | no |
| components/joindrop/JoinDropList.jsx | yes | yes | - | yes | no |
| components/match/FairnessCard.jsx | **no** | **no** | - | yes | no |
| components/match/FitSettingsExtras.jsx | **no** | **no** | - | - | no |
| components/messaging/JobProgress.jsx | **no** | **no** | - | - | no |
| components/proto.jsx | **no** | **no** | - | - | no |
| components/PunchSourceChip.jsx | **no** | **no** | - | - | no |
| components/rcs/RcsAdmin.jsx | yes | yes | - | yes | no |
| components/recruiterJoinings/CategoryTargets.jsx | **no** | **no** | yes | - | no |
| components/recruiterJoinings/RjParts.jsx | **no** | **no** | yes | - | no |
| components/referrals/SourcingManager.jsx | **no** | yes | yes | yes | no |
| components/reports-v4/ReportsOverview.jsx | **no** | yes | yes | yes | yes |
| components/resume/FitSettings.jsx | **no** | **no** | yes | yes | no |
| components/resume/MatchSplit.jsx | **no** | yes | yes | yes | no |
| components/resume/ResumePanel.jsx | **no** | yes | yes | yes | no |
| components/ResumeUploadDialog.jsx | **no** | yes | yes | yes | no |
| components/SeatHistory.jsx | yes | yes | - | - | yes |
| components/SessionsCard.jsx | **no** | yes | - | - | no |
| components/SimpleRecordPage.jsx | yes | yes | yes | yes | yes |
| components/team-v4/TeamOverview.jsx | **no** | **no** | yes | - | no |
| components/team/DeptTeamsAdmin.jsx | **no** | yes | - | - | no |
| components/team/PendingWork.jsx | **no** | yes | - | yes | no |
| components/team/TeamFollowUpHistory.jsx | yes | yes | - | - | no |
| components/wa/WaQuickChatTab.jsx | **no** | yes | yes | - | no |
| components/workflow/WorkflowDiagram.jsx | **no** | **no** | yes | - | no |
| pages/Agreements.jsx | yes | yes | yes | yes | no |
| pages/CandidateDetail.jsx | **no** | yes | yes | yes | no |
| pages/CandidateDuplicates.jsx | yes | yes | yes | yes | no |
| pages/ClientDuplicates.jsx | yes | yes | yes | yes | no |
| pages/Dashboard.jsx | yes | yes | yes | - | yes |
| pages/partner/PartnerJobs.jsx | **no** | yes | yes | yes | no |

### Reports (12 files with a table)

| File | Search | Filters | Money column | Place column | Shared bar |
|---|---|---|---|---|---|
| components/reports/EodReports.jsx | **no** | yes | yes | yes | no |
| pages/reports/AccountsReports.jsx | yes | yes | yes | - | no |
| pages/reports/AtsReports.jsx | yes | yes | yes | yes | yes |
| pages/reports/CandidateExperienceReport.jsx | **no** | **no** | - | - | no |
| pages/reports/ClientHealthReport.jsx | **no** | yes | yes | - | no |
| pages/reports/DailyReport.jsx | **no** | yes | yes | yes | no |
| pages/reports/ExperienceBits.jsx | **no** | yes | - | - | no |
| pages/reports/JobPortalReports.jsx | **no** | yes | - | - | no |
| pages/reports/MyBusinessReports.jsx | yes | **no** | - | - | no |
| pages/reports/PartnersReport.jsx | **no** | yes | yes | - | no |
| pages/reports/PlacementMargin.jsx | yes | yes | yes | - | no |
| pages/reports/TeamReports.jsx | **no** | yes | yes | yes | no |
