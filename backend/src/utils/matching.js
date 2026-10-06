// Candidate <-> requirement matching, ported from the reference prototype's
// computeMatch() (line 1464) and matchingCandidatesFor() (line 6390).
//
// The prototype scores 14 signals and combines 12 weighted components. An
// earlier version of this file used an invented 60% skills / 20% keywords /
// 20% experience formula; that has been replaced, because the prototype is the
// specification. The weights below are the prototype's W object verbatim.

const MATCH_THRESHOLD = 70; // prototype MATCH_THRESHOLD (line 6383)
// Requirement and candidate detail screens list *suggestions* down to 50%.
const SUGGESTION_THRESHOLD = 50;
// resume_: ELIGIBLE = overall >= this AND no mandatory skill missing AND the
// location matches. No per-requirement column exists for it, so it is a
// settings default (env MATCH_ELIGIBLE_THRESHOLD, default 50).
const ELIGIBLE_THRESHOLD = Number(process.env.MATCH_ELIGIBLE_THRESHOLD) || 50;
// Location % at or above this counts as a location match (same city,
// preferred city, nearby within ~100 km, remote, or no location set).
const LOCATION_MATCH_PCT = 70;
const { citiesOf } = require('./locationMatch');

// Prototype weights, verbatim (line 1592). They sum to 1.00.
// Spec D (2026-10-03): an EXACT master-specialisation match (Requirement.
// specialisationId === Candidate.specialisationId) adds this many points to
// the overall score, capped at 100. No penalty for a different one, and no
// change while either side is not mapped yet.
const SPEC_EXACT_BONUS = 10;

const WEIGHTS = {
  mand: 0.28,
  good: 0.07,
  exp: 0.12,
  relev: 0.08,
  edu: 0.07,
  loc: 0.1,
  mode: 0.05,
  emp: 0.04,
  sal: 0.09,
  notice: 0.06,
  jp: 0.02,
  avail: 0.02,
};

// fit_: the weights computeMatch() uses. Admin can change them (Fit settings,
// utils/resumeMatch.js loadFitSettings -> setActiveWeights). Any set of
// non-negative numbers is accepted and scaled so it sums to 1.
let activeWeights = { ...WEIGHTS };
function setActiveWeights(w) {
  const next = { ...WEIGHTS };
  if (w && typeof w === 'object') Object.keys(WEIGHTS).forEach((k) => { if (Number.isFinite(Number(w[k])) && Number(w[k]) >= 0) next[k] = Number(w[k]); });
  const sum = Object.values(next).reduce((a, b) => a + b, 0);
  activeWeights = sum > 0 ? Object.fromEntries(Object.entries(next).map(([k, v]) => [k, v / sum])) : { ...WEIGHTS };
  return activeWeights;
}
const getActiveWeights = () => ({ ...activeWeights });
// fit_: the specialisation bonus is an Admin setting too (default SPEC_EXACT_BONUS).
let activeSpecBonus = SPEC_EXACT_BONUS;
function setActiveSpecBonus(n) {
  const v = Number(n);
  activeSpecBonus = Number.isFinite(v) && v >= 0 && v <= 50 ? v : SPEC_EXACT_BONUS;
  return activeSpecBonus;
}

// B8 (2026-10-05): the scoring VERSION every stored Fit records. v1 = every
// score saved before versioning; the first versioned setup is v2, and every
// change of the weights / specialisation points / meaning-based part in
// Admin → Fit settings makes the next one (utils/resumeMatch.js).
let activeVersion = 2;
function setActiveVersion(n) { const v = Number(n); activeVersion = Number.isInteger(v) && v >= 2 ? v : 2; return activeVersion; }
const getActiveVersion = () => activeVersion;
const versionLabel = (n) => (n == null || n === '' || Number(n) <= 1 ? 'v1 (before versioning)' : `v${Number(n)}`);
const versionCode = (n) => `fit-v${n == null ? activeVersion : n}`;

const lc = (v) => String(v == null ? '' : v).toLowerCase();

function splitList(value) {
  return String(value || '')
    .split(/[,;|]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Straight-line distances between the cities the prototype operates in, used
// for its nearby-city fallback (locationProximity).
const CITY_DISTANCES_KM = {
  'hyderabad|bengaluru': 570,
  'hyderabad|pune': 560,
  'bengaluru|pune': 840,
  'hyderabad|warangal': 145,
  'hyderabad|vijayawada': 275,
  'bengaluru|mysuru': 145,
  'pune|mumbai': 150,
};

function locationProximity(fromCity, toCity) {
  const a = lc(fromCity).trim();
  const b = lc(toCity).trim();
  if (!a || !b) return null;
  if (a === b) return { km: 0, band: 'same city' };
  const km = CITY_DISTANCES_KM[[a, b].sort().join('|')];
  if (km == null) return null;
  const band = km <= 25 ? 'same metro' : km <= 100 ? 'nearby' : km <= 200 ? 'regional' : 'far';
  return { km, band };
}

// "₹14L - ₹20L" -> { lo: 14, hi: 20 }
function reqSalaryRange(requirement) {
  const nums = String(requirement.salary || '').match(/(\d+(?:\.\d+)?)/g);
  if (!nums || nums.length < 2) return null;
  return { lo: Number(nums[0]), hi: Number(nums[1]) };
}

function parseSalary(value) {
  const m = String(value || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : null;
}

function noticeDays(value) {
  const s = lc(value);
  if (!s) return null;
  if (s.includes('immediate')) return 0;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : null;
}

// B8 eligibility: notice in DAYS, reading months / weeks properly ("1 Month"
// = 30, "2 weeks" = 14). null when it cannot be read. (noticeDays() above is
// the Fit score's own reading and stays as it is, so no Fit number moves.)
function noticeDaysStrict(value) {
  const s = lc(value).trim();
  if (!s) return null;
  if (/immediate|serving|^0\b|^nil|^none|^no notice/.test(s)) return 0;
  const m = s.match(/(\d+(?:\.\d+)?)\s*(m|w|d)?/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || (/month/.test(s) ? 'm' : /week/.test(s) ? 'w' : 'd');
  return Math.round(n * (unit === 'm' ? 30 : unit === 'w' ? 7 : 1));
}

function joiningDays(value) {
  const s = lc(value);
  if (!s) return 30;
  if (s.includes('immediate')) return 0;
  const m = s.match(/(\d+)/);
  return m ? Number(m[1]) : 30;
}

function parseExperienceRange(value) {
  const range = String(value || '').match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/);
  if (range) return { lo: Number(range[1]), hi: Number(range[2]) };
  return null;
}

// resume_: does the resume text name this skill? Whole-word, copes with
// "c++", ".net", "node.js"; a one-letter skill only as a listed item.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function resumeHasSkill(lowerText, skill) {
  const t = String(skill || '').trim().toLowerCase();
  if (!t || !lowerText) return false;
  if (t.length === 1) return new RegExp(`(^|[,|•:;\\n]\\s*)${escapeRe(t)}\\s*([,|•;\\n]|$)`, 'im').test(lowerText);
  return new RegExp(`(^|[^a-z0-9+#])${escapeRe(t).replace(/ /g, '[\\s-]*')}(?![a-z0-9+#])`, 'i').test(lowerText);
}
const squashEdu = (v) => lc(v).replace(/[^a-z0-9]/g, '');

// computeMatch(candidate, requirement, { resume })
//   resume (optional) = { text, parsed } of the candidate's CURRENT resume
//   (utils/resumeMatch.js). When present, skills / experience / education are
//   read from the RESUME (resume text + parsed fields, plus the profile's own
//   skills); without it they come from the profile fields, as before.
// Returns the prototype's breakdown plus the three numbers every match shows:
//   overall · resumePct (skills + experience + education) · locPct.
function computeMatch(candidate, requirement, opts = {}) {
  const reasons = []; // why it matched
  const gaps = []; // what reduced the score
  const resume = opts && opts.resume && (opts.resume.text || opts.resume.parsed) ? opts.resume : null;
  const rParsed = (resume && resume.parsed) || {};
  const rLower = resume ? lc(resume.lowerText != null ? resume.lowerText : resume.text) : '';

  // fit_ (2026-10-03): most real jobs have no must-have skills typed in, but
  // they do name a specialisation ("Dermatology"). Then that specialisation is
  // the one must-have — read from the profile's skills / specialisation and
  // from the resume text.
  const typedMand = splitList(requirement.skills);
  const specAsSkill = !typedMand.length && requirement.specialisation ? splitList(requirement.specialisation).slice(0, 1) : [];
  const mandList = typedMand.length ? typedMand : specAsSkill;
  let candSkills = [...splitList(candidate.skills), ...splitList(candidate.specialization)];
  if (resume) {
    const fromResume = new Set([...candSkills, ...(Array.isArray(rParsed.skills) ? rParsed.skills.map(lc) : [])]);
    [...mandList, ...splitList(requirement.goodToHaveSkills)].forEach((s) => {
      if (resumeHasSkill(rLower, s)) fromResume.add(s);
    });
    candSkills = [...fromResume];
  }
  // B8 semantic (only when the Admin switched "Match by meaning" on): a skill
  // written another way counts — "ReactJS" for "React.js", "accounts
  // executive" for "accountant". Without opts.semantic this block does nothing.
  const sem = opts && opts.semantic ? opts.semantic : null;
  const sameMeaning = [];
  if (sem && sem.canonical) {
    let have = null; // built only when a job skill is not there word for word
    const textHas = (s) => !!rLower && (sem.variantsOf ? sem.variantsOf(s) : [s]).some((v) => resumeHasSkill(rLower, v));
    [...mandList, ...splitList(requirement.goodToHaveSkills)].forEach((s) => {
      if (candSkills.includes(s)) return;
      if (!have) have = new Set(candSkills.map((x) => sem.canonical(x)));
      if (have.has(sem.canonical(s)) || textHas(s)) { candSkills.push(s); sameMeaning.push(s); }
    });
  }

  /* 1. Mandatory skills (heaviest single signal) */
  const mand = mandList;
  const mandMatched = mand.filter((s) => candSkills.includes(s));
  const mandMissing = mand.filter((s) => !candSkills.includes(s));
  const mandPct = mand.length ? mandMatched.length / mand.length : 0.6;
  if (mandMatched.length) {
    reasons.push(`Matches ${mandMatched.length} of ${mand.length} mandatory skill(s): ${mandMatched.join(', ')}`);
  }
  if (mandMissing.length) gaps.push(`Missing mandatory skill(s): ${mandMissing.join(', ')}`);
  if (sameMeaning.length) reasons.push(`Same meaning, written differently: ${sameMeaning.join(', ')}`);

  /* 2. Good-to-have skills (lighter) */
  const good = splitList(requirement.goodToHaveSkills);
  const goodMatched = good.filter((s) => candSkills.includes(s));
  const goodPct = good.length ? goodMatched.length / good.length : 0.5;
  if (goodMatched.length) {
    reasons.push(`Also has ${goodMatched.length} good-to-have skill(s): ${goodMatched.join(', ')}`);
  } else if (good.length) {
    gaps.push(`No good-to-have skills matched (${good.join(', ')})`);
  }

  /* 3. Total experience */
  let expPct = 0.6;
  let expReason = requirement.experience ? `Required ${requirement.experience}; candidate experience not on file` : "The job does not ask for a number of years";
  const resumeYears = resume && Number(rParsed.totalExperienceYears) > 0 ? Number(rParsed.totalExperienceYears) : null;
  const totalExp = resumeYears != null ? resumeYears : (Number(candidate.experienceYears) || 0);
  const range = parseExperienceRange(requirement.experience);
  if (range) {
    const { lo, hi } = range;
    if (totalExp >= lo && totalExp <= hi) {
      expPct = 1;
      expReason = `${totalExp} yrs is inside the required ${requirement.experience}`;
      reasons.push(expReason);
    } else if (totalExp > hi) {
      expPct = 0.75;
      expReason = `${totalExp} yrs is above the required ${requirement.experience}`;
      gaps.push('Over-qualified on total experience');
    } else if (totalExp > 0) {
      expPct = Math.max(0.2, totalExp / lo);
      expReason = `${totalExp} yrs is below the required ${requirement.experience}`;
      gaps.push(expReason);
    }
  }

  /* 4. Relevant experience */
  const relev = Number(candidate.relevantExperienceYears);
  let relevPct = 0.6;
  let relevReason = 'Relevant experience not on file';
  if (Number.isFinite(relev) && range) {
    const { lo } = range;
    if (relev >= lo) {
      relevPct = 1;
      relevReason = `${relev} yrs relevant experience meets the ${lo}+ yr bar`;
      reasons.push(relevReason);
    } else {
      relevPct = Math.max(0.2, relev / lo);
      relevReason = `${relev} yrs relevant vs ${lo} yrs required`;
      gaps.push(relevReason);
    }
  }

  /* 5. Education */
  let eduPct = 0.5;
  let eduReason = 'Education not on file';
  const resumeEdu = resume && Array.isArray(rParsed.education) && rParsed.education.length ? rParsed.education.join(', ') : null;
  const candEdu = resumeEdu || candidate.education;
  if (candEdu) {
    const need = lc(requirement.education);
    const needFirst = need.split(',')[0].trim();
    if (!need || need === '—' || need === 'any degree') {
      eduPct = 0.85;
      eduReason = `Education on file: ${candEdu}`;
    } else if (lc(candEdu).includes(needFirst) || (squashEdu(needFirst) && squashEdu(candEdu).includes(squashEdu(needFirst)))) {
      eduPct = 1;
      eduReason = `Education matches (${requirement.education})`;
      reasons.push(eduReason);
    } else {
      eduPct = 0.6;
      eduReason = `Education is ${candEdu}; role asks for ${requirement.education}`;
      gaps.push(eduReason);
    }
  } else {
    gaps.push('No education on file');
  }

  /* 6/7. Current + preferred location */
  let locPct = 0.5;
  let locReason = 'Location preference not on file';
  let locKm = null;
  let locBand = null;
  // resume_: cities are compared NORMALISED (utils/locationMatch.js —
  // Secunderabad = Hyd = Kukatpally = Hyderabad). Same city 100, preferred
  // city 90, then the nearby-city distance bands. The resume's location
  // stands in when the profile has none.
  const candLocation = candidate.location || (resume && rParsed.location) || '';
  const pref = lc(candidate.preferredLocation);
  const curr = lc(candLocation);
  const reqLoc = lc(requirement.location).trim();
  const reqCities = citiesOf(requirement.location);
  const reqKeys = reqCities.map((c) => c.key);
  const currCities = citiesOf(candLocation);
  const prefCities = citiesOf(candidate.preferredLocation);
  const sameCity = reqKeys.length && currCities.some((c) => reqKeys.includes(c.key));
  const prefCity = reqKeys.length && prefCities.some((c) => reqKeys.includes(c.key));
  const nearest = (cands) => {
    let best = null;
    cands.forEach((c) => reqCities.forEach((r) => {
      const p = locationProximity(c.label, r.label);
      if (p && (!best || p.km < best.km)) best = { ...p, from: c.label };
    }));
    return best;
  };
  if (requirement.workMode === 'Remote') {
    locPct = 1;
    locReason = 'Remote role — no location constraint';
    reasons.push(locReason);
  } else if (!reqLoc) {
    locPct = 1;
    locReason = 'No location set on the requirement';
  } else if (sameCity || (curr && curr.includes(reqLoc))) {
    locPct = 1;
    locReason = `Same city — currently in ${candLocation}`;
    reasons.push(locReason);
  } else if (prefCity || (pref && pref.includes(reqLoc))) {
    locPct = 0.9;
    locReason = `Preferred location matches ${requirement.location}`;
    reasons.push(locReason);
  } else {
    const pNear = nearest(prefCities) || locationProximity(candidate.preferredLocation, requirement.location);
    const cNear = nearest(currCities) || locationProximity(candLocation, requirement.location);
    const best = [pNear, cNear].filter(Boolean).sort((x, y) => x.km - y.km)[0];
    if (best) {
      const fromCity = best.from || (pNear && best === pNear ? candidate.preferredLocation : candLocation);
      locKm = best.km;
      locBand = best.band;
      if (best.km <= 25) {
        locPct = 0.95;
        locReason = `${fromCity} is ${best.km} km from ${requirement.location} (${best.band})`;
        reasons.push(locReason);
      } else if (best.km <= 50) {
        locPct = 0.85;
        locReason = `${fromCity} is ${best.km} km from ${requirement.location} (${best.band})`;
        reasons.push(locReason);
      } else if (best.km <= 100) {
        locPct = 0.7;
        locReason = `${fromCity} is ${best.km} km from ${requirement.location} (${best.band}) — commutable with relocation`;
        reasons.push(locReason);
      } else if (best.km <= 200) {
        locPct = 0.5;
        locReason = `${fromCity} is ${best.km} km from ${requirement.location} (${best.band}) — relocation needed`;
        gaps.push(locReason);
      } else {
        locPct = 0.3;
        locReason = `${fromCity} is ${best.km} km from ${requirement.location} — outside the nearby radius`;
        gaps.push(locReason);
      }
    } else if (pref || curr) {
      locPct = 0.4;
      locReason = `Candidate in ${candLocation || '—'} (prefers ${candidate.preferredLocation || '—'}); role is in ${requirement.location}`;
      gaps.push(locReason);
    }
  }

  /* 8. Work mode */
  let modePct = 0.7;
  let modeReason = 'No work-mode preference on file';
  if (candidate.preferredWorkMode) {
    if (lc(candidate.preferredWorkMode) === lc(requirement.workMode)) {
      modePct = 1;
      modeReason = `Work mode matches (${requirement.workMode})`;
      reasons.push(modeReason);
    } else {
      modePct = 0.45;
      modeReason = `Prefers ${candidate.preferredWorkMode}; role is ${requirement.workMode}`;
      gaps.push(modeReason);
    }
  }

  /* 9. Employment type */
  let empPct = 0.7;
  let empReason = 'No employment-type preference on file';
  if (candidate.preferredEmploymentType && requirement.employmentType) {
    if (lc(candidate.preferredEmploymentType) === lc(requirement.employmentType)) {
      empPct = 1;
      empReason = `Employment type matches (${requirement.employmentType})`;
      reasons.push(empReason);
    } else {
      empPct = 0.5;
      empReason = `Prefers ${candidate.preferredEmploymentType}; role is ${requirement.employmentType}`;
      gaps.push(empReason);
    }
  }

  /* 10/11. Current + expected salary against the band */
  let salPct = 0.6;
  let salReason = 'Salary expectation not on file';
  const band = reqSalaryRange(requirement);
  const expSal = parseSalary(candidate.expectedSalary);
  const curSal = parseSalary(candidate.currentSalary);
  if (band && expSal != null) {
    if (expSal >= band.lo && expSal <= band.hi) {
      salPct = 1;
      salReason = `Expected ₹${expSal}L sits inside the ${requirement.salary} band`;
      reasons.push(salReason);
    } else if (expSal < band.lo) {
      salPct = 0.9;
      salReason = `Expected ₹${expSal}L is below the band (${requirement.salary})`;
    } else {
      salPct = Math.max(0.2, band.hi / expSal);
      salReason = `Expected ₹${expSal}L exceeds the ${requirement.salary} band`;
      gaps.push(salReason);
    }
  } else if (band && curSal != null) {
    salPct = curSal <= band.hi ? 0.8 : 0.4;
    salReason = `Current ₹${curSal}L vs band ${requirement.salary}`;
    if (curSal > band.hi) gaps.push(salReason);
  }

  /* 12. Notice period vs joining timeline */
  let notPct = 0.7;
  let notReason = 'Notice period not on file';
  const nd = noticeDays(candidate.noticePeriod);
  const jd = joiningDays(requirement.joiningTimeline);
  if (nd != null) {
    if (nd <= jd) {
      notPct = 1;
      notReason = `${candidate.noticePeriod} fits the ${requirement.joiningTimeline || 'joining'} timeline`;
      reasons.push(notReason);
    } else {
      notPct = Math.max(0.25, jd / Math.max(nd, 1));
      notReason = `${candidate.noticePeriod} is longer than the ${requirement.joiningTimeline || 'required'} timeline`;
      gaps.push(notReason);
    }
  }

  /* 13. Job preference */
  let jpPct = 0.7;
  let jpReason = 'No job preference on file';
  if (candidate.jobPreference && requirement.jobPreference) {
    const cp = splitList(candidate.jobPreference);
    const rp = splitList(requirement.jobPreference);
    const hit = cp.some((x) => rp.includes(x));
    jpPct = hit ? 1 : 0.5;
    jpReason = hit
      ? `Job preference matches (${requirement.jobPreference})`
      : `Prefers ${candidate.jobPreference}; role is ${requirement.jobPreference}`;
    (hit ? reasons : gaps).push(jpReason);
  }

  /* 14. Availability */
  let availPct = 0.8;
  let availReason = 'Availability not stated';
  if (candidate.availability) {
    const ok = !lc(candidate.availability).includes('not');
    availPct = ok ? 1 : 0.4;
    availReason = `Availability: ${candidate.availability}`;
    (ok ? reasons : gaps).push(availReason);
  }

  const W = activeWeights; // fit_: the Admin weights (setActiveWeights), else WEIGHTS
  let overall = Math.round(
    (mandPct * W.mand +
      goodPct * W.good +
      expPct * W.exp +
      relevPct * W.relev +
      eduPct * W.edu +
      locPct * W.loc +
      modePct * W.mode +
      empPct * W.emp +
      salPct * W.sal +
      notPct * W.notice +
      jpPct * W.jp +
      availPct * W.avail) *
      100
  );
  // B8 semantic part: a small extra weight (s = its points / the 12 weights'
  // points), averaged in. Only when opts.semantic carries a similarity —
  // otherwise `overall` above is untouched, to the digit.
  let semanticPct = null;
  if (sem && Number.isFinite(Number(sem.pct)) && Number(sem.share) > 0) {
    semanticPct = Math.max(0, Math.min(100, Math.round(Number(sem.pct))));
    const s = Number(sem.share);
    const base = mandPct * W.mand + goodPct * W.good + expPct * W.exp + relevPct * W.relev + eduPct * W.edu + locPct * W.loc
      + modePct * W.mode + empPct * W.emp + salPct * W.sal + notPct * W.notice + jpPct * W.jp + availPct * W.avail;
    overall = Math.round(((base + (semanticPct / 100) * s) / (1 + s)) * 100);
    if (semanticPct >= 60) reasons.push(`Profile talks about the same work (${semanticPct}% similar${sem.shared && sem.shared.length ? `: ${sem.shared.join(', ')}` : ''})`);
    else if (semanticPct < 25) gaps.push(`Profile talks about different work (${semanticPct}% similar)`);
  }

  /* 15. Specialisation (spec D): an exact master-specialisation match gets extra weight */
  let specMatch = null; // 'exact' | 'different' | null (either side not mapped)
  if (requirement.specialisationId && candidate.specialisationId) {
    if (requirement.specialisationId === candidate.specialisationId) {
      specMatch = 'exact';
      overall = Math.min(100, overall + activeSpecBonus);
      reasons.push(`Same specialisation${requirement.specialisationName ? ` (${requirement.specialisationName})` : ''}`);
    } else {
      specMatch = 'different';
      gaps.push('Different specialisation');
    }
  }

  // resume_: the RESUME number — skills, experience and education only,
  // on the same weights, renormalised to 100.
  const rW = W.mand + W.good + W.exp + W.relev + W.edu;
  const resumePct = Math.round(((mandPct * W.mand + goodPct * W.good + expPct * W.exp + relevPct * W.relev + eduPct * W.edu) / rW) * 100);
  const locationPctRounded = Math.round(locPct * 100);

  return {
    overall,
    // B8: which scoring version produced this number ("fit-v3").
    fitVersion: versionCode(),
    // B8 eligibility: the person's notice and the job's longest allowed notice, in days.
    noticeDaysNum: noticeDaysStrict(candidate.noticePeriod),
    noticeMaxDays: noticeDaysStrict(requirement.noticePeriodMax),
    noticeText: candidate.noticePeriod || null,
    noticeMaxText: requirement.noticePeriodMax || null,
    semanticPct,
    sameMeaningSkills: sameMeaning,
    specMatch,
    resumePct,
    resumeSource: resume ? 'resume' : 'profile',
    locationMatched: locationPctRounded >= LOCATION_MATCH_PCT,
    // fit_: plain numbers for the one-line reason ("3 years more experience").
    expYears: totalExp > 0 ? totalExp : null,
    expNeedMin: range ? range.lo : null,
    expShortYears: range && totalExp > 0 && totalExp < range.lo ? Math.round((range.lo - totalExp) * 10) / 10 : 0,
    mandatoryCount: mand.length,
    mandatoryFromSpecialisation: specAsSkill.length > 0,
    eduMatched: eduPct >= 0.85,
    reasons,
    gaps,
    matchedSkills: mandMatched,
    missingSkills: mandMissing,
    goodMatched,
    goodMissing: good.filter((s) => !candSkills.includes(s)),
    skillsPct: Math.round(mandPct * 100),
    goodPct: Math.round(goodPct * 100),
    expPct: Math.round(expPct * 100),
    expReason,
    relevPct: Math.round(relevPct * 100),
    relevReason,
    eduPct: Math.round(eduPct * 100),
    eduReason,
    locPct: Math.round(locPct * 100),
    locReason,
    locKm,
    locBand,
    modePct: Math.round(modePct * 100),
    modeReason,
    empPct: Math.round(empPct * 100),
    empReason,
    salPct: Math.round(salPct * 100),
    salReason,
    notPct: Math.round(notPct * 100),
    notReason,
    jpPct: Math.round(jpPct * 100),
    jpReason,
    availPct: Math.round(availPct * 100),
    availReason,
  };
}

// resume_: ELIGIBLE = overall >= threshold AND no mandatory skill missing AND
// the location matches. Returns { eligible, why[] } (why = what failed).
function eligibilityOf(match, threshold = ELIGIBLE_THRESHOLD) {
  const why = [];
  if (match.overall < threshold) why.push(`Overall ${match.overall}% is below ${threshold}%`);
  if (match.missingSkills && match.missingSkills.length) why.push(`Missing mandatory: ${match.missingSkills.join(', ')}`);
  // fit_ (2026-10-03): a job that lists NO must-have skill cannot vouch for
  // anyone — otherwise every person "fits" every such job on location alone.
  // An exact master-specialisation match stands in for the skills.
  if (match.mandatoryCount === 0 && match.specMatch !== 'exact') why.push('The job lists no must-have skills yet');
  if (!match.locationMatched) why.push('Location does not match');
  // B8: a notice period longer than the job allows.
  if (match.noticeDaysNum != null && match.noticeMaxDays != null && match.noticeDaysNum > match.noticeMaxDays) {
    why.push(`Notice ${match.noticeText} is longer than the job allows (${match.noticeMaxText})`);
  }
  return { eligible: why.length === 0, why };
}

// B8 OVERRIDE: the reasons that make adding this person to the job an
// override — fails must-have skills, the minimum Fit, notice or location.
// ("The job lists no must-have skills yet" is about the JOB, not the person,
// so it never asks for an override.)
function overrideWhy(match, threshold = ELIGIBLE_THRESHOLD) {
  return eligibilityOf(match, threshold).why.filter((w) => !/lists no must-have skills/.test(w));
}

// Ranked list of candidates not already in this requirement's pipeline.
function rankCandidates(candidates, requirement, { excludeIds = new Set(), threshold = MATCH_THRESHOLD } = {}) {
  return candidates
    .filter((c) => !excludeIds.has(c.id))
    .map((c) => ({ ...c, match: computeMatch(c, requirement) }))
    .filter((c) => c.match.overall >= threshold)
    .sort((a, b) => b.match.overall - a.match.overall);
}

module.exports = {
  MATCH_THRESHOLD, SUGGESTION_THRESHOLD, ELIGIBLE_THRESHOLD, LOCATION_MATCH_PCT, WEIGHTS, SPEC_EXACT_BONUS, computeMatch, rankCandidates, eligibilityOf,
  setActiveWeights, getActiveWeights, setActiveSpecBonus,
  // B8 versioning
  setActiveVersion, getActiveVersion, versionLabel, versionCode, getActiveSpecBonus: () => activeSpecBonus,
  overrideWhy, noticeDaysStrict,
};
