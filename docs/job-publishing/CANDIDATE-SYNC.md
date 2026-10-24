# Candidate sync from the portals: FUTURE architecture (nothing is built)

Goal: applicants that arrive on Naukri, Foundit, Shine, LinkedIn and the career page appear in TeamLink with their source.

## Sources and the realistic route
| Source | Realistic route today |
|---|---|
| Career page / Job Portal | already works (apply on our page, `?src=` tag) |
| Naukri, Shine | response emails the Job Portal already reads (Source = Naukri / Shine). Portal-side export (CSV / Excel the recruiter downloads from the portal) is the next step |
| Foundit | response email + recruiter-side export |
| LinkedIn | applicants on our page via the tagged link; LinkedIn's own applicant export by a person |

**Why portal-side export, not scraping:** reading applicant lists with a browser program is both against the terms and the riskiest thing for the accounts (it touches candidate personal data). A person downloads the file; TeamLink imports it.

## Design
1. **Intake**: "Import applicants" tab (Candidates & Pipeline > Sources): upload the export, pick the portal and job. The existing import engine (`utils/atsIoStore.js`) parses it.
2. **Source tracking**: `Candidate.source` normalised by `utils/candidateSource.js` (the Sources tab already groups by it); the job link carries `?src=`.
3. **Resume storage**: `CandidateResume` / `candidateDocStore.js` (existing), hash kept for duplicate detection.
4. **Candidate mapping**: portal columns to `Candidate` fields through a per-portal column map (like `PortalMapping`, reversed); the application attaches to the job whose portal job id (`PortalPosting.portalJobId`) matches.
5. **Duplicate detection**: every row passes the duplicates gate (`candidateDupes.js`, `candidateDupResolve.js`): same phone / email / resume hash is held at the first step until a person resolves it.
6. **Consent / DPDP**: record the source, the date and "applied to this job on <portal>" as the lawful basis; no marketing use without separate consent; a delete request removes the profile and its resume file; export files are deleted after import.
7. **Audit and privacy**: who imported, how many, how many duplicates; contact and salary stay hidden from roles that do not hold "Candidate Contact & Salary".
