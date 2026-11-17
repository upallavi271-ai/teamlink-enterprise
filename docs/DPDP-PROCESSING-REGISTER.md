# TeamLink: personal data processing register (DPDP Act 2023)

Written 2026-11-17. The data fiduciary is TeamLink Consultants. The founder is the grievance contact. Review this register every year, and whenever a new kind of data or a new vendor is added.

| # | Whose data | What | Why (purpose) | Lawful basis | Where kept | Who can see | Kept how long | Shared with |
|---|---|---|---|---|---|---|---|---|
| 1 | Candidates | Name, phone, email, birth date, education, experience, salary, resume, documents, messages | To find jobs for them and send their profiles to clients | Consent: recorded on the profile (given / not given / withdrawn), purposes listed | TeamLink server in India (SQLite + private file folder) | Recruiters / TLs of the job, the BDE desk for client steps, Admin | Active while the person is in a process. Review consent after 24 months (Privacy → consent review). Erase on request | The client of the job (profile only, after the approval chain); the job portal |
| 2 | Candidates (AI interview) | Photo, video / audio answers, scores | To check identity and assess the interview | Consent on the photo step | Job portal server (India) | Recruiter of the job, Admin. Every viewing is logged | As item 1 | No one |
| 3 | Employees | HR record, bank (encrypted, masked), attendance, leave, payroll, monitoring (apps and sites used, never mail content) | Employment and payroll; work monitoring as told in the notice | Employment contract plus the monitoring notice | TeamLink server | HR, managers in scope, the person themself | Employment plus the statutory period | Bank (salary), statutory bodies |
| 4 | Client contacts | Name, phone, email, designation | Business relationship, invoices | Legitimate business use | TeamLink server | BDE desk, Accounts, Admin | While a client plus the statutory period for invoices | No one |
| 5 | Sales leads (CRM) | Name, phone, email, company | Selling TeamLink services | Legitimate business use, with an opt-out | TeamLink server | Sales team per the CRM rule | Until opted out or closed | No one |

## The person's rights and how we answer them

- **See their data:** Candidate profile → 🔒 Privacy → Download. Send the file to them within 7 days. Every download is audited.
- **Correct it:** edit the profile. Every change is audited with old and new values.
- **Withdraw consent:** Candidate profile → Consent → Withdrawn. They then get no messages, are left out of exports and are marked do-not-contact.
- **Erase:** Candidate profile → 🔒 Privacy → Erase. Erasure is refused while the record is on legal hold or while money is still owed on a placement, and the reason is shown.
- **Grievance:** the founder answers within 7 days. Keep each request and its answer in the audit trail by noting the reason.

## Security controls (summary)

Two-step sign-in, signed-in device control, idle sign-out, password policy, an IP allow-list (optional), role and department scope on every request, a who-viewed log, a sealed audit trail, encrypted bank fields and integration keys, daily backups with a restore test, and an encrypted off-site copy (needs the storage account). See docs/DISASTER-RECOVERY.md.

## Breach

If personal data is exposed, the founder tells the Data Protection Board and the affected people as the Act requires (within 72 hours to the Board, as currently notified). The audit trail, the who-viewed log and the sealed chain show what was accessed.
