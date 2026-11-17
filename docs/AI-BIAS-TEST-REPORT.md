# AI bias test of the candidate Fit score

Date: 17 Nov 2026 · Scorer tested: `backend/src/utils/matching.js` `computeMatch()` + `eligibilityOf()` (scoring version fit-v2, default weights) · Result: **PASS after one fix**

## What was tested and why

Every Fit %, "Good fit" list, Eligible badge and suggestion in the ATS comes from one scorer, `computeMatch()`. It is
deterministic code (weights, skill matching, experience bands, location, salary, notice), not an AI model, so it can be
tested exactly. Two parts that involve AI are **not** covered by this test:

- **AI interview score.** It has weight 0 by default (shown beside the Fit, not counted). The sandbox refuses AI calls
  (`TEST_ALLOW_AI`), so the interviewer itself was not re-tested here. If an Admin gives it points in Fit settings, it
  needs its own test.
- **"Match by meaning", AI engine (Ollama embeddings).** It is off by default. The text it sends already has the
  person's name, e-mail, phone, address and company removed (`semanticMatch.js textOfCandidate`). The test does cover the
  offline skill-folding part of "Match by meaning".

## Method

### 1. Paired (counterfactual) test

Made-up people who are the same in skills, experience, relevant experience, education, expected salary, notice period
and city, and differ in **one** attribute only. Each pair is scored against 4 sample requirements (Java Developer,
Hyderabad · Staff Nurse ICU, Bengaluru · Accountant, Pune · Ruby on Rails Developer, Remote) and 9 qualification
profiles (strong / partial / weak), in 3 ways:

| Mode | What the scorer reads |
|---|---|
| profile only | the profile fields (no resume on file) |
| with resume | profile + a resume text with the usual Indian "Personal details" block (name, e-mail, DOB, gender, marital status, religion, category, native place, photo, declaration) |
| resume + match by meaning | the same, with "Match by meaning" skill folding on |

The protected attribute is written into both the profile (as a field, even where the Candidate table has no such
column, to prove it is ignored) and the resume text.

**Pass rule:** for a protected attribute the Overall Fit is identical (difference 0, tolerance 0) and the Eligible
answer never flips. The **current city** is a real job criterion (the job's location): it may move the Location part
only; every other part must stay the same, and a Remote job must give the same Fit for every city.

### 2. Group outcome: four-fifths (80%) rule

A seeded batch of 40 made-up qualification profiles per requirement (160 people) is given to each of 13 groups (men,
women, Muslim, Christian, Sikh, SC/ST, North-east names, age 50+, under 30, married women, maternity break, photo on
resume, a name that is also a skill word). Shortlist = Eligible. Each group's shortlist rate must be at least 80% of the
best group's rate. Because every group gets the **same** qualifications, the strict expectation is the *same* rate for
every group, and that is checked too: the 80% rule alone is too loose (see the finding below).

## Attributes

| Attribute | Variants used |
|---|---|
| Name: male vs female | Rahul / Priya Sharma · Venkatesh / Lakshmi Reddy · Robin / Ruby Fernandes |
| Name: community / religion | Arjun Iyer · Mohammed Irfan Khan · Joseph D'Souza · Gurpreet Singh · Ravi Paswan · Suresh Valmiki · Tenzin Norbu |
| Gender field | Male · Female · Transgender · not given |
| Age / date of birth | born 2001 · 1986 · 1968 · no DOB |
| Marital status | Single · Married · Divorced · Widowed |
| Photo on resume | photo · no photo |
| Religion / caste lines | Hindu General · Muslim OBC · Christian General · Hindu SC · Hindu ST · Sikh General · Buddhist SC |
| Home state (native place) | Bihar · Andhra Pradesh · Kerala · Manipur · Uttar Pradesh |
| College tier (same degree) | IIT Bombay · Govt. Degree College Warangal · distance education |
| Career break marked maternity | none · "Jan 2019 – Dec 2020 (maternity break)", same total years |
| Current city (job criterion) | the job's city · Patna · Guwahati |

## Results

### Before the fix

| Attribute | Pairs | Max Fit difference | Eligible flips | Result |
|---|---|---|---|---|
| **Name: male vs female** | 324 | **13** | **2** | **FAIL** |
| every other protected attribute | 7,776 | 0 | 0 | Pass |
| Current city (job criterion) | 324 | 6 (Location part only; Remote 0) | 18 | Pass |
| Four-fifths rule | 13 groups × 160 | lowest ratio 0.88 | — | Pass (80% rule) but **rates not the same**: "Ruby" 83 / 160 vs 73 / 160 for every other group |

Worst case: Ruby on Rails Developer, same resume, "Robin Fernandes" 66% vs "Ruby Fernandes" 79%. The scorer looks for
each must-have skill word in the whole resume text, so the name "Ruby" (in the header, the e-mail
`ruby.fernandes@…`, the "Name:" line and the declaration) counted as the skill **Ruby**. The same happens to any name or
e-mail that is also a skill word, and it mostly favoured one female name. The 80% rule did not catch it (0.88); the
paired test and the strict same-rate check did.

### Fix (2026-11-17)

`backend/src/utils/matching.js` — new `skillTextOf()`: before a skill is looked for in the resume text, the person's own
name (in either order), e-mail addresses, web / LinkedIn / GitHub links, a first line that is only the name, and the
"Name: / Father's name: / Mother's name: / Spouse's name:" and "Declaration" lines are taken out. A skill the person
really has is still found in the skills and work lines ("Ruby Fernandes" who lists Ruby still gets it). The result is
cached per resume, so the cost is one pass per person. Effect on live numbers: only a Fit that had gained a skill from a
name, e-mail or link changes (it goes down to what the work lines support); profile-only Fits do not change at all.

The scorer was also checked line by line: it never reads `gender`, `dob`, `institute`, `passingYear`, marital status,
religion, caste or a photo. Experience is read as the stated total years, so a career break is not penalised by itself.

### After the fix (`node scripts/ai-bias-test.js`)

| Attribute | Pairs | Max Fit difference | Eligible flips | Result |
|---|---|---|---|---|
| Name: male vs female | 324 | 0 | 0 | Pass |
| Name: community / religion | 2,268 | 0 | 0 | Pass |
| Gender field | 648 | 0 | 0 | Pass |
| Age / date of birth | 648 | 0 | 0 | Pass |
| Marital status | 648 | 0 | 0 | Pass |
| Photo on resume | 108 | 0 | 0 | Pass |
| Religion / caste category lines | 2,268 | 0 | 0 | Pass |
| Home state (native place) | 1,080 | 0 | 0 | Pass |
| College tier (same degree) | 324 | 0 | 0 | Pass |
| Career break marked maternity | 108 | 0 | 0 | Pass |
| Current city (job criterion) | 324 | 6, Location part only; Remote job 0 | 18 | Pass (documented criterion) |
| Four-fifths rule, 13 groups | 2,080 | lowest ratio 1.00, every group 73 / 160 | — | Pass (same rate for all) |

Total: 8,748 paired comparisons, 18 / 18 checks pass (including 4 regression checks of the fix).

## Known limits

- The current city legitimately moves the Fit for an on-site job (up to 6 points here, and it can change Eligible
  because Eligible needs a location match). This is the job's own requirement; a recruiter can override with a reason.
- Education is compared by degree name (B.Tech, B.Com …), which is a job criterion; the college name is not used.
- Experience below the job's range lowers the Fit. A long career break that the parser turns into fewer total years
  lowers it too; that is an experience effect, not a gap penalty.
- The test uses made-up people, not live data. It proves the scorer does not *use* these attributes; it does not
  measure differences that come from real-world inequality in qualifications.

## How to re-run

- **Command line (no database, no AI, no server):** `cd backend && node scripts/ai-bias-test.js` — prints the tables,
  exits 1 on any failure. Options: `--json <file>` writes the full result, `--tolerance <n>` allows a difference of n
  points.
- **In the app (Admin):** Administration → Company Setup → Fit settings → **AI fairness** → *Run test now*. It runs the
  same test with the **live** Fit weights and keeps the result (date, pass / fail, who ran it, one row per attribute) in
  the `AiFairnessRun` table (raw SQL, self-provisioned). API: `GET / POST /api/candidate-resumes/fairness-test`
  (Admin only). Re-run it after every change of the Fit weights.
- Code: `backend/src/utils/fairnessTest.js` (shared by both).
