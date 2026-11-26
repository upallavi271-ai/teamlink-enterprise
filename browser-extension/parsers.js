// TeamLink extension 2.0 - PROFILE READERS for LinkedIn, Naukri (incl. Resdex), Shine and foundit.
// Each reader gets what the recruiter's own browser shows: { url, title, h1, text (the page's visible text), mailtos, tels } and returns
// the fields it can find. Job-board pages change their layout often, so the readers work from labels people see ("Notice period",
// "Current CTC", "Key skills" ...) rather than from page-specific class names, and the popup lets the recruiter correct every field
// before anything is saved. Nothing is read in the background: only when the recruiter opens the popup on that page.
// Works in the browser (window.TLParsers) and in Node (tests: backend/scripts/extension-parsers-test.js).
(function (root) {
  const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const lines = (text) => String(text || '').split(/\r?\n/).map(clean).filter(Boolean);
  // the value after a label: "Notice Period: 30 Days" on one line, or the label alone with the value on the next line
  // every label any reader looks for: a value line that is itself one of these is the next label, not a value
  const LABELS = {
    exp: ['Total Experience', 'Experience', 'Work Experience', 'Exp'],
    headline: ['Current Designation', 'Designation', 'Current Role', 'Title', 'Role'],
    company: ['Current Company', 'Current Employer', 'Company', 'Employer', 'Organization'],
    location: ['Current Location', 'Location', 'City'],
    ctc: ['Current CTC', 'Current Salary', 'CTC', 'Annual Salary'],
    ectc: ['Expected CTC', 'Expected Salary'],
    notice: ['Notice Period', 'Notice'],
    education: ['Highest Qualification', 'Education', 'Qualification', 'Degree'],
    skills: ['Key Skills', 'Skills', 'IT Skills', 'Primary Skills'],
  };
  const ALL = Object.values(LABELS).flat();
  const isLabel = (s) => ALL.some((l) => new RegExp(`^${l}(?![a-z])\\s*[:\\-–]?\\s*$`, 'i').test(s));
  function labelled(ls, labels, maxLen = 120) {
    for (let i = 0; i < ls.length; i += 1) {
      for (const lb of labels) {
        // the label must end there ("Exp" is not "Expected CTC")
        const re = new RegExp(`^${lb}(?![a-z])\\s*[:\\-–]?\\s*(.*)$`, 'i');
        const m = re.exec(ls[i]);
        if (m) {
          const same = clean(m[1]);
          if (same && same.length <= maxLen) return same;
          const next = ls[i + 1];
          if (next && next.length <= maxLen && !isLabel(next)) return next;
          break; // the longest label matched this line: a shorter one ("Notice" in "Notice Period") must not read its tail as the value
        }
      }
    }
    return '';
  }
  const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
  const PHONE = /(?:\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}\b/;
  function contact(page) {
    const email = (page.mailtos && page.mailtos[0]) || ((EMAIL.exec(page.text || '') || [])[0]) || '';
    const tel = (page.tels && page.tels[0]) || ((PHONE.exec(page.text || '') || [])[0]) || '';
    return { email: email.toLowerCase(), phone: tel.replace(/[^\d+]/g, '') };
  }
  // "5 Years 6 Months" / "5.5 yrs" / "5y 6m" -> 5.5
  function years(s) {
    const t = String(s || '').toLowerCase();
    const y = /(\d+(?:\.\d+)?)\s*(?:years?|yrs?|y)\b/.exec(t);
    const m = /(\d+)\s*(?:months?|mos?|m)\b/.exec(t);
    if (!y && !m) { const n = /^(\d+(?:\.\d+)?)$/.exec(t.trim()); return n ? Number(n[1]) : null; }
    const v = (y ? Number(y[1]) : 0) + (m ? Number(m[1]) / 12 : 0);
    return Math.round(v * 10) / 10;
  }
  const skillList = (s) => String(s || '').split(/[,|•·\n]/).map(clean).filter((x) => x && x.length <= 40).slice(0, 25);

  function common(page, extra = {}) {
    const ls = lines(page.text);
    const c = contact(page);
    const expText = labelled(ls, LABELS.exp);
    const out = {
      name: clean(page.h1 || ''),
      headline: labelled(ls, LABELS.headline),
      currentCompany: labelled(ls, LABELS.company),
      location: labelled(ls, LABELS.location),
      experienceYears: years(expText),
      currentSalary: labelled(ls, LABELS.ctc),
      expectedSalary: labelled(ls, LABELS.ectc),
      noticePeriod: labelled(ls, LABELS.notice),
      education: labelled(ls, LABELS.education, 200),
      skills: skillList(labelled(ls, LABELS.skills, 600)),
      email: c.email,
      phone: c.phone,
      ...extra,
    };
    return out;
  }

  const READERS = {
    naukri: (page) => common(page),
    shine: (page) => common(page),
    foundit: (page) => common(page),
  };
  function siteOf(url) {
    let h = '';
    try { h = new URL(url).hostname.toLowerCase(); } catch (e) { return null; }
    if (/(^|\.)linkedin\.com$/.test(h)) return 'linkedin';
    if (/(^|\.)naukri\.com$/.test(h)) return 'naukri';
    if (/(^|\.)shine\.com$/.test(h)) return 'shine';
    if (/(^|\.)(foundit\.in|monsterindia\.com)$/.test(h)) return 'foundit';
    return null;
  }
  function read(page) {
    const site = siteOf(page.url);
    if (!site || !READERS[site]) return null;
    const out = READERS[site](page);
    // a name that is really a page heading ("My Profile", "Resume") is not a name
    if (/^(my )?(profile|resume|cv|candidate details?)$/i.test(out.name)) out.name = '';
    return { site, profileUrl: String(page.url).split('#')[0], ...out };
  }
  const api = { read, siteOf, years, labelled, lines, skillList };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TLParsers = api;
}(typeof window !== 'undefined' ? window : globalThis));
